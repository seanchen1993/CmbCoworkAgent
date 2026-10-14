import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { types } from "node:util"
import type { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { previewAuthoringSource } from "../mods/devtools/authoring-preview"
import { createAuthoringPreviewBackend } from "../mods/devtools/authoring-preview-backend"
import type {
  AuthoringPreviewAction,
  AuthoringPreviewView
} from "../../shared/mods/authoring-preview"

type Report = Awaited<ReturnType<typeof previewAuthoringSource>>
function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw Error("AUTHORING_PREVIEW_INPUT")
  const properties = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some(
      (key) => !properties[key] || !("value" in properties[key]) || !properties[key].enumerable
    )
  )
    throw Error("AUTHORING_PREVIEW_INPUT")
  return Object.fromEntries(keys.map((key) => [key, properties[key].value]))
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0"))
    throw Error("AUTHORING_PREVIEW_INPUT")
  return value
}
function requestId(value: unknown): string {
  const id = text(value, 128)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error("AUTHORING_PREVIEW_INPUT")
  return id
}
function publicError(error: unknown): Error {
  const code = error instanceof Error ? error.message : ""
  return Error(
    [
      "AUTHORING_PREVIEW_BUSY",
      "AUTHORING_PREVIEW_INPUT",
      "AUTHORING_PREVIEW_SOURCE_CHANGED",
      "AUTHORING_PREVIEW_SCOPE_CHANGED",
      "AUTHORING_PREVIEW_CANCELLED",
      "AUTHORING_PREVIEW_EXPIRED",
      "AUTHORING_PREVIEW_TOOL_MISSING",
      "AUTHORING_PREVIEW_RESULT_LIMIT"
    ].includes(code)
      ? code
      : "AUTHORING_PREVIEW_FAILED"
  )
}

/** Strip live pane identifiers/callbacks. Renderer receives inert bounded text only. */
function project(report: Report): Omit<AuthoringPreviewView, "id" | "revision" | "requestId"> {
  let nodes = 0,
    remaining = 64 * 1024,
    paneTextTruncated = false
  const plain = (value: unknown, depth = 0): string => {
    if (++nodes > 2048 || depth > 32 || remaining <= 0) {
      paneTextTruncated = true
      return ""
    }
    if (typeof value === "string") {
      const accepted = value.slice(0, remaining)
      remaining -= accepted.length
      if (accepted.length !== value.length) paneTextTruncated = true
      return accepted
    }
    if (!value || typeof value !== "object") return ""
    if (Array.isArray(value))
      return value
        .map((item) => plain(item, depth + 1))
        .filter(Boolean)
        .join("\n")
    const row = value as Record<string, unknown>
    const props = row.props as Record<string, unknown> | undefined
    const parts: unknown[] = [row.children]
    if (props && typeof props === "object")
      for (const key of ["text", "content", "value", "placeholder", "code", "markdown"])
        if (typeof props[key] === "string") parts.push(props[key])
    return parts
      .map((item) => plain(item, depth + 1))
      .filter(Boolean)
      .join("\n")
  }
  const all = [
    ...report.typecheck.diagnostics.map((item) => ({
      source: "types" as const,
      message: item.message
    })),
    ...report.compatibility.diagnostics.map((item) => ({
      source: "events" as const,
      message: item.impact
    })),
    ...report.sdkCompatibility.diagnostics.map((item) => ({
      source: "sdk" as const,
      message: item.message
    }))
  ]
  return {
    sourceDigest: report.sourceDigest,
    compiledDigest: report.compiledDigest,
    action: report.action,
    failures: report.failures,
    commands: report.commands.map(({ name, description }) => ({ name, description })),
    tools: report.tools.map(({ name, description }) => ({ name, description })),
    checks: {
      types: report.typecheck.valid,
      events: report.compatibility.strictCompatible,
      sdk: report.sdkCompatibility.strictCompatible
    },
    diagnostics: all
      .slice(0, 64)
      .map((item) => ({ ...item, message: item.message.slice(0, 2000) })),
    omittedDiagnostics: Math.max(0, all.length - 64),
    result: report.result,
    panes: report.panes
      .slice(0, 32)
      .map((pane) => ({ title: pane.title.slice(0, 200), text: plain(pane.tree) })),
    paneTextTruncated
  }
}

/** One owner per sender/thread; cancellation tears down only that owner's resources. */
export function registerModsAuthoringPreviewHandlers(
  ipc: IpcMain,
  store: AuthoringDraftStore,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    threadScope(threadId: string): string
    captureThreadFence(threadId: string): () => void
  },
  dependencies = { run: previewAuthoringSource, backend: createAuthoringPreviewBackend }
): void {
  interface Active {
    requestId: string
    workspace: string
    controller: AbortController
    settled: Promise<void>
  }
  const active = new Map<WebContents, Map<string, Active>>()
  ipc.handle("mods:authoring-preview-start", async (event, input: unknown) => {
    try {
      access.trusted(event)
      const row = record(input, [
        "threadId",
        "expectedWorkspace",
        "id",
        "revision",
        "sourceDigest",
        "requestId",
        "action"
      ])
      const threadId = text(row.threadId, 200),
        workspace = text(row.expectedWorkspace, 4096),
        id = text(row.id, 64),
        token = requestId(row.requestId)
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(id) ||
        !Number.isSafeInteger(row.revision) ||
        Number(row.revision) < 1 ||
        typeof row.sourceDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.sourceDigest)
      )
        throw Error("AUTHORING_PREVIEW_INPUT")
      const revision = Number(row.revision),
        digest = row.sourceDigest
      const action = record(row.action, ["kind", "target", "input"])
      if (
        !["inspect", "command", "tool", "rule"].includes(action.kind as string) ||
        typeof action.target !== "string" ||
        action.target.length > 256 ||
        typeof action.input !== "string" ||
        action.input.length > 16000 ||
        Buffer.byteLength(action.input) > 32000
      )
        throw Error("AUTHORING_PREVIEW_INPUT")
      const sender = event.sender,
        frame = sender.mainFrame
      const assertThread = access.captureThreadFence(threadId)
      const controller = new AbortController()
      const assertCurrent = () => {
        controller.signal.throwIfAborted()
        access.trusted(event)
        assertThread()
        if (
          sender.isDestroyed() ||
          sender.mainFrame !== frame ||
          access.threadScope(threadId) !== workspace
        )
          throw Error("AUTHORING_PREVIEW_SCOPE_CHANGED")
        controller.signal.throwIfAborted()
      }
      const source = () => {
        assertCurrent()
        const draft = store.list(workspace).find((item) => item.id === id)
        const version = draft?.versions.at(-1)
        if (!version || draft?.currentRevision !== revision || version.source.digest !== digest)
          throw Error("AUTHORING_PREVIEW_SOURCE_CHANGED")
        assertCurrent()
        return version.source
      }
      const snapshot = source()
      const owners = active.get(sender) ?? new Map<string, Active>()
      if (
        owners.has(threadId) ||
        [...active.values()].reduce((count, entries) => count + entries.size, 0) >= 2
      )
        throw Error("AUTHORING_PREVIEW_BUSY")
      let done!: () => void
      const entry: Active = {
        requestId: token,
        workspace,
        controller,
        settled: new Promise((resolve) => {
          done = resolve
        })
      }
      owners.set(threadId, entry)
      active.set(sender, owners)
      const cancel = () => controller.abort(Error("AUTHORING_PREVIEW_CANCELLED"))
      const navigate = (details: { isMainFrame: boolean }) => {
        if (details.isMainFrame) cancel()
      }
      sender.once("destroyed", cancel)
      sender.on("did-start-navigation", navigate)
      const timer = setInterval(() => {
        try {
          assertCurrent()
        } catch {
          cancel()
        }
      }, 250)
      timer.unref?.()
      try {
        const result = await dependencies.run(
          snapshot,
          action as unknown as AuthoringPreviewAction,
          { backend: dependencies.backend, assertCurrent, signal: controller.signal }
        )
        source()
        if (result.sourceDigest !== digest) throw Error("AUTHORING_PREVIEW_SOURCE_CHANGED")
        return { ...project(result), id, revision, requestId: token }
      } finally {
        clearInterval(timer)
        sender.removeListener("destroyed", cancel)
        sender.removeListener("did-start-navigation", navigate)
        if (owners.get(threadId) === entry) owners.delete(threadId)
        if (!owners.size) active.delete(sender)
        done()
      }
    } catch (error) {
      throw publicError(error)
    }
  })
  ipc.handle("mods:authoring-preview-cancel", async (event, input: unknown) => {
    try {
      access.trusted(event)
      const row = record(input, ["threadId", "expectedWorkspace", "requestId"])
      const threadId = text(row.threadId, 200),
        workspace = text(row.expectedWorkspace, 4096),
        token = requestId(row.requestId)
      const owned = active.get(event.sender)?.get(threadId)
      if (!owned || owned.requestId !== token || owned.workspace !== workspace) return
      owned.controller.abort(Error("AUTHORING_PREVIEW_CANCELLED"))
      // Cancellation remains allowed after scope changes; it returns no report/data.
      await owned.settled
    } catch (error) {
      throw publicError(error)
    }
  })
}
