import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { types } from "node:util"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionGuest, FunctionHostCall } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { assessFunctionCompatibility } from "../../../shared/mods/v2/compatibility"
import { FunctionSession } from "../v2/session"
import { withFreshFunctionTransport } from "../v2/execution-context"
import { readAuthoringSourceBundle } from "./authoring-bundle"
import type { AuthoringPreviewAnalysis } from "./authoring-preflight"

const capabilities = ["command.register", "tool.register", "ui.open", "ui.resolve"]
export type AuthoringPreviewAction = {
  kind: "inspect" | "command" | "tool" | "rule"
  target: string
  input: string
}

/** Owned by one preview, never shared with installed plugins. Production supplies a utility process. */
export interface AuthoringPreviewBackend {
  preflight(directory: string, signal: AbortSignal): Promise<AuthoringPreviewAnalysis>
  load(code: string, options: ModObject): Promise<FunctionGuest>
  stop(): Promise<void>
}

function actionSnapshot(value: unknown): AuthoringPreviewAction {
  if (!value || typeof value !== "object" || types.isProxy(value))
    throw Error("AUTHORING_PREVIEW_INPUT")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(value).length !== 3 ||
    !["kind", "target", "input"].every(
      (key) =>
        descriptors[key] &&
        "value" in descriptors[key] &&
        typeof descriptors[key].value === "string"
    )
  )
    throw Error("AUTHORING_PREVIEW_INPUT")
  const { kind, target, input } = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  ) as AuthoringPreviewAction
  if (
    !["inspect", "command", "tool", "rule"].includes(kind) ||
    target.length > 256 ||
    input.length > 16000 ||
    Buffer.byteLength(input, "utf8") > 32000
  )
    throw Error("AUTHORING_PREVIEW_INPUT")
  return { kind, target, input }
}

/** One real invocation in an ephemeral, capability-limited session. No install or user scope. */
export async function previewAuthoringSource(
  source: unknown,
  requestedAction: unknown,
  options: {
    backend(): AuthoringPreviewBackend
    assertCurrent(): void
    signal: AbortSignal
  }
) {
  const bundle = readAuthoringSourceBundle(source)
  const action = actionSnapshot(requestedAction)
  const assertCurrent = options.assertCurrent
  const signal = options.signal
  const createBackend = options.backend
  const controller = new AbortController()
  let backend: AuthoringPreviewBackend | undefined
  let session: FunctionSession | undefined
  let guest: FunctionGuest | undefined
  let directory: string | undefined
  let closed = false
  let failures = 0
  const deadline = performance.now() + 15000
  const cancel = () => {
    controller.abort(Error("AUTHORING_PREVIEW_CANCELLED"))
    void backend?.stop().catch(() => {})
  }
  const timer = setTimeout(cancel, 15000)
  signal.addEventListener("abort", cancel, { once: true })
  const assertPublication = () => {
    if (performance.now() >= deadline) throw Error("AUTHORING_PREVIEW_EXPIRED")
    signal.throwIfAborted()
    controller.signal.throwIfAborted()
    assertCurrent()
    signal.throwIfAborted()
    controller.signal.throwIfAborted()
    if (performance.now() >= deadline) throw Error("AUTHORING_PREVIEW_EXPIRED")
  }
  const assertLive = () => {
    if (closed) throw Error("AUTHORING_PREVIEW_EXPIRED")
    assertPublication()
  }
  const watchHost =
    (host: FunctionHostCall): FunctionHostCall =>
    async (...args) => {
      assertLive()
      try {
        return await host(...args)
      } catch (error) {
        failures++
        throw error
      }
    }
  const execute = async () => {
    try {
      assertLive()
      directory = await mkdtemp(join(tmpdir(), "cmb-mods-preview-"))
      for (const file of bundle.files) {
        assertLive()
        const target = join(directory, file.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.text, { encoding: "utf8", flag: "wx" })
      }
      backend = createBackend()
      const { compiled, sdk, typecheck } = await backend.preflight(directory, controller.signal)
      assertLive()
      guest = await backend.load(compiled.code, compiled.options)
      assertLive()
      const actualGuest = guest
      // Optional hooks can recover internally. Keep failures visible rather than calling fallback PASS.
      const observedGuest: FunctionGuest = {
        registrations: actualGuest.registrations,
        get stats() {
          return actualGuest.stats
        },
        matches: (...args) => actualGuest.matches(...args),
        invoke: async (id, event, host, invocation) => {
          assertLive()
          try {
            return await actualGuest.invoke(id, event, watchHost(host), {
              ...invocation,
              timeoutMs: Math.max(1, Math.min(5000, deadline - performance.now()))
            })
          } catch (error) {
            failures++
            throw error
          }
        },
        dispose: () => actualGuest.dispose(),
        releaseUi: (...args) => actualGuest.releaseUi(...args),
        ...(actualGuest.bindModuleHost
          ? {
              bindModuleHost: (host: FunctionHostCall, onDispose?: () => void) =>
                actualGuest.bindModuleHost!(watchHost(host), onDispose)
            }
          : {}),
        ...(actualGuest.releaseResource
          ? {
              releaseResource: (handle: number) => actualGuest.releaseResource!(handle)
            }
          : {}),
        ...(actualGuest.releaseStreamCursor
          ? {
              releaseStreamCursor: (handle: number) => actualGuest.releaseStreamCursor!(handle)
            }
          : {})
      }
      const previewThread = `preview-${randomUUID()}`
      session = new FunctionSession(
        [
          {
            name: compiled.name,
            root: directory,
            tier: "user",
            guest: observedGuest,
            modelProtocol: compiled.modelProtocol,
            capabilities: [...capabilities]
          }
        ],
        {
          workspace: directory,
          threadId: previewThread,
          assertLive,
          publish: async (value) => {
            assertLive()
            return value
          },
          debugLog: () => {},
          capability: async () => {
            throw Error("AUTHORING_PREVIEW_CAPABILITY_DENIED")
          }
        }
      )
      const previewSession = session
      return await withFreshFunctionTransport(
        {
          workspace: directory,
          threadId: previewThread,
          userInitiated: false,
          leased: false,
          immediate: true
        },
        async () => {
          const commands = await previewSession.commands(controller.signal)
          const tools = await previewSession.registeredTools()
          assertLive()
          let result: ModJson = null
          if (action.kind === "command")
            result = await previewSession.run(action.target, action.input, controller.signal)
          else if (action.kind === "tool") {
            if (!tools.some((tool) => tool.name === action.target))
              throw Error("AUTHORING_PREVIEW_TOOL_MISSING")
            const input = parseModJson(action.input)
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              ["tool", "tool_use_id", "agentId"].some((key) => Object.hasOwn(input, key))
            )
              throw Error("AUTHORING_PREVIEW_INPUT")
            result = await previewSession.interceptTool(
              { ...input, tool: action.target, tool_use_id: randomUUID() },
              controller.signal,
              async () => {
                throw Error("AUTHORING_PREVIEW_EXTERNAL_TOOL_DENIED")
              }
            )
          } else if (action.kind === "rule") {
            result = await previewSession.promptComposition(
              "prompt.compose",
              {
                model: "preview",
                promptModel: "preview",
                surfaces: ["desktop"],
                tools: [],
                traits: [],
                outputStyle: null
              },
              controller.signal,
              async () => ({
                sections: [{ id: "preview-input", text: action.input, scope: "shared" }]
              })
            )
          }
          const panes = await previewSession.panes.snapshot()
          assertLive()
          const compatibility = assessFunctionCompatibility(actualGuest.registrations)
          const report = {
            sourceDigest: bundle.digest,
            compiledDigest: compiled.digest,
            scope: "isolated-invocation" as const,
            authorized: false as const,
            action: action.kind,
            failures,
            commands,
            tools,
            result,
            panes,
            compatibility,
            typecheck,
            sdkCompatibility: sdk,
            limitations: [
              "no-project-data",
              "no-external-capabilities",
              "no-installed-state",
              "static-pane-snapshot"
            ]
          }
          if (Buffer.byteLength(JSON.stringify(report), "utf8") > 256 * 1024)
            throw Error("AUTHORING_PREVIEW_RESULT_LIMIT")
          // Publication waits for real session cleanup; serialized UI callbacks are never live handles.
          await previewSession.close(true)
          session = undefined
          guest = undefined
          assertLive()
          return JSON.parse(encodeModJson(report as unknown as ModJson)) as typeof report
        }
      )
    } finally {
      closed = true
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      try {
        if (session) await session.close(true)
        else if (guest) await guest.dispose()
      } finally {
        await backend?.stop()
        if (directory) {
          const owned = resolve(directory)
          assert(
            dirname(owned) === resolve(tmpdir()) && basename(owned).startsWith("cmb-mods-preview-"),
            "AUTHORING_PREVIEW_CLEANUP_SCOPE"
          )
          await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        }
      }
    }
  }
  const result = await execute()
  assertPublication()
  return result
}
