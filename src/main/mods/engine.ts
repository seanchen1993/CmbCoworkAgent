import { randomUUID } from "node:crypto"
import type {
  ModCard,
  ModEffect,
  ModIdentity,
  ModJson,
  ModObject,
  ModProjection,
  ModRegistration,
  ModToolResult
} from "../../shared/mods/types"
import { encodeModJson, parseModUi } from "../../shared/mods/validation"
import type { CompiledMod } from "./loader"
import type { ModControlStore, ModGrant } from "./control-store"
import type { ModHostCall } from "./guest-runtime"
import { ModError, modErrorCode } from "./errors"
import { validateModRegistrations } from "./registrations"
import {
  filterModData,
  filterModResult,
  projectModResult,
  replaceModProjection
} from "./publication"
import { modCallContext, type ModCallContext } from "./context"
import { modToolHasNotStarted } from "./execution-error"

export interface ModRuntime {
  load(id: string, code: string): Promise<ModRegistration[]>
  invoke(
    id: string,
    handler: string,
    event: ModObject,
    call: ModHostCall,
    signal?: AbortSignal
  ): Promise<ModJson>
  unload(id: string): Promise<void>
}

export interface ApprovedMod {
  compiled: CompiledMod
  grant: ModGrant
}

interface LoadedMod extends ApprovedMod {
  runtimeId: string
  registrations: ModRegistration[]
}

export interface ModDispatchRequest {
  identity: ModIdentity
  toolId: string
  effect: ModEffect
  args: Record<string, unknown>
  protectedOutput: boolean
  readOnly?: boolean
  signal?: AbortSignal
  activePluginIds?: ReadonlySet<string>
  invokeTool?: (
    id: string,
    args: ModObject,
    grant: ModGrant,
    userInitiated: boolean
  ) => Promise<unknown>
  authorize?: (toolId: string, args: Record<string, unknown>) => Promise<void>
  userInitiated?: boolean
  assertScope?: () => void
  assertMcpTool?: ModCallContext["assertMcpTool"]
  context?: Record<string, ModJson>
  onCard?: (card: ModCard) => void
  policyDigest?: string
  publish?: <T>(value: T, stage: "before-observers" | "final") => Promise<T>
  protectData?: <T>(value: T) => T
  admit?: (args: Record<string, unknown>) => Promise<void>
}

const readTools = new Set([
  "host:read_file",
  "host:ls",
  "host:glob",
  "host:grep",
  "host:task_output"
])
export function classifyModTool(id: string): ModEffect {
  return readTools.has(id) ? "read" : id.startsWith("host:") ? "write" : "unknown"
}

function record(value: unknown): ModObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModError("MODS_OBJECT_REQUIRED")
  encodeModJson(value)
  return value as ModObject
}

function projection(value: unknown): ModProjection {
  const input = record(value)
  if (typeof input.text !== "string") throw new ModError("MODS_PROJECTION_INVALID")
  return { text: input.text, ...(input.data !== undefined ? { data: input.data } : {}) }
}

export class ModEngine {
  private readonly mods: LoadedMod[] = []
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private waiting = 0

  constructor(
    private readonly store: ModControlStore,
    private readonly runtime: ModRuntime,
    private readonly diagnostic: (modId: string, code: string) => void
  ) {}

  private async invokeGuest(
    id: string,
    handler: string,
    event: ModObject,
    call: ModHostCall,
    signal?: AbortSignal
  ): Promise<ModJson> {
    const pending = new Set<Promise<ModJson>>()
    try {
      return await this.runtime.invoke(
        id,
        handler,
        event,
        (method, input) => {
          const operation = Promise.resolve().then(() => call(method, input))
          pending.add(operation)
          void operation.finally(() => pending.delete(operation)).catch(() => {})
          return operation
        },
        signal
      )
    } finally {
      // A guest can drop an SDK promise. The host still owns and settles that operation.
      await Promise.allSettled([...pending])
    }
  }

  async load(approved: ApprovedMod[]): Promise<void> {
    try {
      for (const mod of approved) {
        this.store.assertGrant(mod.grant)
        const runtimeId = randomUUID()
        const registrations = await this.runtime.load(runtimeId, mod.compiled.code)
        this.mods.push({ ...mod, runtimeId, registrations })
        validateModRegistrations(mod.compiled.manifest, registrations)
      }
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private selected(request: ModDispatchRequest): LoadedMod[] {
    return this.mods.filter(
      (mod) =>
        mod.compiled.manifest.activation === "project" ||
        request.activePluginIds?.has(mod.compiled.pluginId)
    )
  }

  private assertLive(request: ModDispatchRequest, selected: LoadedMod[]): void {
    request.assertScope?.()
    if (this.disposed) throw new ModError("MODS_SESSION_ENDED")
    if (request.signal?.aborted) throw new ModError("MODS_CANCELLED")
    for (const mod of selected) this.store.assertGrant(mod.grant)
  }

  private async exclusive<T>(request: ModDispatchRequest, fn: () => Promise<T>): Promise<T> {
    // Nested calls may not wait for an engine currently held by their parent.
    if (request.identity.origin === "mod") throw new ModError("MODS_REENTRY_DENIED")
    if (this.waiting >= 32) throw new ModError("MODS_QUEUE_LIMIT")
    this.waiting++
    const prior = this.queue
    let unlock: () => void = () => {}
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await prior
    try {
      this.assertLive(request, this.selected(request))
      return await fn()
    } finally {
      this.waiting--
      unlock()
    }
  }

  async dispatch<T>(
    request: ModDispatchRequest,
    core: (args: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    const toolCallId = request.identity.toolCallId ?? request.identity.callId
    // Capability calls never re-enter middleware or render while their parent owns the VM.
    const selected = request.identity.origin === "mod" ? [] : this.selected(request)
    const chain = selected.flatMap((mod) =>
      mod.registrations
        .filter((reg) => reg.event === "tool.call" && reg.tools?.includes(request.toolId))
        .map((registration) => ({ mod, registration }))
    )
    const run = async (): Promise<T> => {
      this.assertLive(request, selected)
      let actual: T | undefined
      let executed = false
      let coreFailure: unknown
      let receipt = ""
      let corePromise: Promise<ModToolResult> | undefined
      const invokeCore = (args: ModObject): Promise<ModToolResult> => {
        if (corePromise) throw new ModError("MODS_CORE_ALREADY_STARTED")
        corePromise = (async () => {
          this.assertLive(request, selected)
          this.store.claim(
            request.identity.callId,
            request.toolId,
            request.args,
            request.identity,
            args
          )
          try {
            await request.admit?.(args)
            executed = true
            const context = {
              identity: request.identity,
              toolId: request.toolId,
              signal: request.signal,
              routeClaimed: true,
              effectiveArgs: args,
              protectedOutput: request.protectedOutput,
              readOnly: request.readOnly ?? false,
              originMod: request.identity.modId,
              authorize: request.authorize,
              policyDigest: request.policyDigest,
              publish: request.publish,
              protectData: request.protectData,
              userInitiated: request.userInitiated,
              assertLive: () => this.assertLive(request, selected),
              assertMcpTool: request.assertMcpTool,
              approvalFingerprint:
                `${request.identity.threadId}:${request.identity.turnId}:${request.identity.agentId}:${request.identity.modId ?? "model"}:${request.identity.grantEpoch}:${request.policyDigest ?? "none"}|` +
                selected
                  .map((mod) => `${mod.grant.modId}:${mod.grant.digest}:${mod.grant.epoch}`)
                  .join("|")
            }
            actual = await modCallContext.run(context, () => core(args))
            const failed = this.failed(actual)
            this.store.settle(request.identity.callId, failed ? "failed" : "succeeded")
            this.assertLive(request, selected)
            actual = request.publish
              ? await request.publish(actual, "before-observers")
              : filterModResult(actual, request.protectedOutput, toolCallId)
            receipt = randomUUID()
            return {
              receipt,
              execution: failed ? "failed" : "succeeded",
              projection: projectModResult(actual, toolCallId)
            }
          } catch (error) {
            coreFailure = error
            this.store.settle(
              request.identity.callId,
              executed && !modToolHasNotStarted(error, request.identity.callId)
                ? "unknown"
                : "not_started"
            )
            throw error
          }
        })()
        // The outer invocation always joins this operation, even if a guest abandons next.
        void corePromise.catch(() => {})
        return corePromise
      }
      const layer = async (index: number, args: ModObject): Promise<ModToolResult> => {
        const current = chain[index]
        if (!current) return invokeCore(args)
        const { mod, registration } = current
        let nextPromise: Promise<ModToolResult> | undefined
        let nextUsed = false
        const event = {
          identity: request.identity,
          tool: { id: request.toolId, effect: request.effect },
          args
        } as unknown as ModObject
        try {
          const reply = record(
            await this.invokeGuest(
              mod.runtimeId,
              registration.id,
              event,
              async (method, input) => {
                this.assertLive(request, selected)
                if (method !== "next")
                  return this.capability(mod, request, registration.event, method, input)
                if (nextUsed) throw new ModError("MODS_NEXT_ALREADY_USED")
                nextUsed = true
                const nextArgs = record(record(input).args)
                nextPromise = layer(index + 1, nextArgs)
                void nextPromise.catch(() => {})
                return (await nextPromise) as unknown as ModJson
              },
              request.signal
            )
          )
          if (reply.kind === "deny" && !nextUsed) throw new ModError("MODS_TOOL_DENIED")
          if (!nextPromise) throw new ModError("MODS_RESULT_WITHOUT_EXECUTION")
          const downstream = await nextPromise
          if (reply.kind !== "result" || reply.receipt !== downstream.receipt || !receipt) {
            throw new ModError("MODS_RESULT_RECEIPT_INVALID")
          }
          return { ...downstream, projection: projection(reply.projection) }
        } catch (error) {
          this.diagnostic(mod.compiled.manifest.id, modErrorCode(error))
          if (nextPromise) {
            // Failure after next falls back to the checked result, never another execution.
            return await nextPromise
          }
          throw error
        }
      }
      try {
        const result = await layer(0, record(request.args))
        this.assertLive(request, selected)
        if (!executed || actual === undefined) throw new ModError("MODS_RESULT_MISSING")
        const originalProjection = projectModResult(actual, toolCallId)
        const same = encodeModJson(originalProjection) === encodeModJson(result.projection)
        const transformed = same
          ? actual
          : replaceModProjection(actual, result.projection, toolCallId)
        const published = request.publish
          ? await request.publish(transformed, "final")
          : filterModResult(transformed, request.protectedOutput, toolCallId)
        const render = () => this.render(request, selected, projectModResult(published, toolCallId))
        if (chain.length === 0 && selected.length > 0) await this.exclusive(request, render)
        else await render()
        this.assertLive(request, selected)
        return published
      } catch (error) {
        if (!corePromise && this.store.status(request.identity.callId) === undefined) {
          this.store.claim(request.identity.callId, request.toolId, request.args, request.identity)
          this.store.settle(request.identity.callId, "not_started")
        }
        if (corePromise) {
          try {
            await corePromise
          } catch {
            /* Preserve the original host control-flow error below. */
          }
        }
        if (coreFailure) throw coreFailure
        throw error
      }
    }
    return chain.length > 0 ? this.exclusive(request, run) : run()
  }

  private failed(value: unknown): boolean {
    if (!value || typeof value !== "object") return false
    const result = value as Record<string, unknown>
    return (
      result.status === "error" ||
      result.isError === true ||
      (typeof result.exitCode === "number" && result.exitCode !== 0) ||
      typeof result.error === "string"
    )
  }

  private async capability(
    mod: LoadedMod,
    request: ModDispatchRequest,
    event: string,
    method: string,
    input: ModJson
  ): Promise<ModJson> {
    this.store.assertGrant(mod.grant)
    if (request.signal?.aborted) throw new ModError("MODS_CANCELLED")
    if (event === "ui.render") throw new ModError("MODS_RENDER_IO_DENIED")
    const args = record(input)
    const permissions = mod.compiled.manifest.permissions
    if (method === "tools.invoke") {
      if (typeof args.toolId !== "string" || !request.invokeTool)
        throw new ModError("MODS_TOOL_UNAVAILABLE")
      const effect = classifyModTool(args.toolId)
      const read = effect === "read"
      if (!(read ? permissions.readTools : permissions.writeTools).includes(args.toolId)) {
        throw new ModError("MODS_TOOL_NOT_GRANTED")
      }
      if (
        !read &&
        (event !== "command.run" || request.readOnly || request.identity.origin !== "user-action")
      ) {
        throw new ModError("MODS_WRITE_REQUIRES_USER_ACTION")
      }
      const value = await request.invokeTool(
        args.toolId,
        record(args.args),
        mod.grant,
        request.identity.origin === "user-action"
      )
      this.store.assertGrant(mod.grant)
      const safe = request.publish
        ? await request.publish(value, "final")
        : filterModResult(value, request.protectedOutput)
      return {
        receipt: randomUUID(),
        execution: this.failed(value) ? "failed" : "succeeded",
        projection: projectModResult(safe)
      } as unknown as ModJson
    }
    if (method === "context.get") {
      if (typeof args.field !== "string" || !permissions.context.includes(args.field))
        throw new ModError("MODS_CONTEXT_DENIED")
      const value = request.context?.[args.field] ?? null
      return request.publish
        ? await request.publish(value, "final")
        : filterModData(value, request.protectedOutput)
    }
    const namespace = `${mod.grant.workspace}\u001f${mod.compiled.manifest.id}\u001f${mod.compiled.digest}`
    if (method === "artifacts.create") {
      if (
        !permissions.artifacts ||
        typeof args.label !== "string" ||
        !args.label.length ||
        args.label.length > 200 ||
        typeof args.text !== "string" ||
        args.text.length > 240_000
      )
        throw new ModError("MODS_ARTIFACT_DENIED")
      const content = request.publish
        ? await request.publish({ label: args.label, text: args.text }, "final")
        : (filterModData(
            { label: args.label, text: args.text },
            request.protectedOutput
          ) as unknown as { label: string; text: string })
      this.assertLive(request, [mod])
      const id = randomUUID()
      this.store.saveArtifact({
        id,
        workspace: request.identity.workspace,
        threadId: request.identity.threadId,
        modId: mod.grant.modId,
        digest: mod.grant.digest,
        label: content.label,
        text: content.text,
        createdAt: Date.now()
      })
      return { id, label: content.label }
    }
    if (method.startsWith("store.")) {
      if (!permissions.store || typeof args.key !== "string")
        throw new ModError("MODS_STORE_DENIED")
      if (method === "store.get") {
        const value = this.store.read(namespace, args.key)
        return request.publish
          ? await request.publish(value, "final")
          : filterModData(value, request.protectedOutput)
      }
      if (method === "store.set")
        this.store.write(
          namespace,
          args.key,
          request.publish
            ? await request.publish(args.value, "final")
            : filterModData(args.value, request.protectedOutput)
        )
      else if (method === "store.delete") this.store.delete(namespace, args.key)
      else throw new ModError("MODS_CAPABILITY_UNKNOWN")
      return null
    }
    if (method === "log") {
      const code =
        typeof args.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(args.code)
          ? args.code
          : "MOD_EVENT"
      this.diagnostic(mod.compiled.manifest.id, code)
      return null
    }
    throw new ModError("MODS_CAPABILITY_UNKNOWN")
  }

  async context(request: ModDispatchRequest): Promise<string[]> {
    return this.exclusive(request, async () => {
      const blocks: string[] = []
      for (const mod of this.selected(request)) {
        for (const registration of mod.registrations.filter((r) => r.event === "prompt.context")) {
          try {
            const value = await this.invokeGuest(
              mod.runtimeId,
              registration.id,
              { identity: request.identity, blocks: [] } as unknown as ModObject,
              (method, input) =>
                method === "next"
                  ? Promise.resolve([])
                  : this.capability(mod, request, registration.event, method, input),
              request.signal
            )
            if (!Array.isArray(value) || value.length > 8) throw new ModError("MODS_CONTEXT_LIMIT")
            for (const item of value) {
              const block = record(item)
              if (typeof block.text !== "string" || block.text.length > 4000)
                throw new ModError("MODS_CONTEXT_LIMIT")
              const text = `[Mod: ${mod.compiled.manifest.name}]\n${block.text}`
              blocks.push(
                String(
                  request.publish
                    ? await request.publish(text, "final")
                    : filterModData(text, request.protectedOutput)
                )
              )
            }
          } catch (error) {
            this.diagnostic(mod.compiled.manifest.id, modErrorCode(error))
          }
        }
      }
      this.assertLive(request, this.selected(request))
      return blocks.slice(0, 8)
    })
  }

  async command(
    request: ModDispatchRequest,
    modId: string,
    command: string,
    args: ModObject
  ): Promise<ModProjection> {
    return this.exclusive(request, async () => {
      const mod = this.selected(request).find((item) => item.compiled.manifest.id === modId)
      const registration = mod?.registrations.find(
        (item) => item.event === "command.run" && item.command === command
      )
      if (!mod || !registration || request.identity.origin !== "user-action")
        throw new ModError("MODS_COMMAND_UNAVAILABLE")
      this.assertLive(request, [mod])
      const value = await this.invokeGuest(
        mod.runtimeId,
        registration.id,
        { identity: request.identity, command, args } as unknown as ModObject,
        (method, input) =>
          method === "next"
            ? Promise.resolve({ text: "" })
            : this.capability(mod, request, registration.event, method, input),
        request.signal
      )
      this.assertLive(request, [mod])
      const published = request.publish
        ? await request.publish(projection(value), "final")
        : (filterModData(projection(value), request.protectedOutput) as unknown as ModProjection)
      await this.render(request, [mod], published, "turn.summary")
      return published
    })
  }

  commands(
    request: ModDispatchRequest
  ): Array<{ modId: string; name: string; command: string; grant: ModGrant }> {
    return this.selected(request).flatMap((mod) =>
      mod.registrations
        .filter((r) => r.event === "command.run")
        .map((r) => ({
          modId: mod.compiled.manifest.id,
          name: mod.compiled.manifest.name,
          command: r.command!,
          grant: mod.grant
        }))
    )
  }

  async summary(request: ModDispatchRequest, model: ModProjection): Promise<void> {
    await this.exclusive(request, () =>
      this.render(request, this.selected(request), model, "turn.summary")
    )
  }

  private async render(
    request: ModDispatchRequest,
    selected: LoadedMod[],
    projection: ModProjection,
    slot: "tool.result.after" | "turn.summary" = "tool.result.after"
  ): Promise<void> {
    if (!request.onCard) return
    for (const mod of selected) {
      for (const registration of mod.registrations.filter(
        (r) => r.event === "ui.render" && r.slot === slot
      )) {
        try {
          this.assertLive(request, [mod])
          const nodes = await this.invokeGuest(
            mod.runtimeId,
            registration.id,
            {
              identity: request.identity,
              slot,
              model: { ...projection, outputProtected: request.protectedOutput },
              nodes: []
            } as unknown as ModObject,
            async (method) => {
              if (method === "next") return []
              throw new ModError("MODS_RENDER_IO_DENIED")
            },
            request.signal
          )
          const safeNodes = parseModUi(
            request.publish
              ? await request.publish(nodes, "final")
              : filterModData(nodes, request.protectedOutput)
          )
          this.assertLive(request, [mod])
          request.onCard({
            id: randomUUID(),
            agentId: request.identity.agentId,
            modId: mod.compiled.manifest.id,
            name: mod.compiled.manifest.name,
            threadId: request.identity.threadId,
            callId: request.identity.toolCallId ?? request.identity.callId,
            slot,
            nodes: safeNodes
          })
        } catch (error) {
          this.diagnostic(mod.compiled.manifest.id, modErrorCode(error))
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled(this.mods.splice(0).map((mod) => this.runtime.unload(mod.runtimeId)))
  }
}
