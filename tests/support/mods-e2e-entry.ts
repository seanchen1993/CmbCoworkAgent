// Compiled only by CMB_MODS_E2E=1. No IPC handler or production test backdoor.
import { LocalSandbox } from "../../src/main/agent/local-sandbox"
import { getCheckpointer } from "../../src/main/agent/runtime"
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { getModsManager, setModsManager, ModsManager } from "../../src/main/mods/manager"
import { DEFAULT_MOD_POLICY } from "../../src/main/mods/policy"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../src/main/agent/thread-run-lease"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import type { FunctionSessionActivity } from "../../src/main/mods/v2/session-activity"
import { withModToolCall, withScopedModMcp } from "../../src/main/mods/adapters"
import { upsertMcpConnector, deleteMcpConnector } from "../../src/main/storage"
import { getGlobalMcpCapabilityService } from "../../src/main/mcp/capability-service"
import { createEagerMcpTool } from "../../src/main/mcp/langchain-tool"
import { ModRuntimeClient } from "../../src/main/mods/runtime-client"
import { ModControlStore } from "../../src/main/mods/control-store"
import { ModEngine, type ModDispatchRequest } from "../../src/main/mods/engine"
import { join } from "node:path"
import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from "electron"
import { resolveAgentStreamRequestChannel } from "../../src/shared/agent-stream-channel"
import { types } from "node:util"
import { FunctionConversationNativeKeeper } from "../../src/main/agent/function-conversation-native-keeper"
import { FunctionConversationNativeRetainer } from "../../src/main/agent/function-conversation-native-retainer"
import { FunctionSessionAppendTicket } from "../../src/main/mods/v2/session-append-ticket"

type NativeLifecycleStage =
  | "keeper.run"
  | "keeper.guard"
  | "keeper.whenDrained"
  | "retainer.run"
  | "retainer.protectedNative"
  | "retainer.prepare"
  | "retainer.verified"
  | "ticket.commit"
  | "ticket.acceptResult"
  | "manager.appendConversation-operation"
interface NativeLifecycleEvent {
  stage: NativeLifecycleStage
  instance: number
  call: number
  phase: "begin" | "return" | "throw" | "fulfilled" | "rejected"
  atMs: number
  elapsedMs?: number
  saved?: boolean | null
  commitStarted?: boolean | null
}
let nativeLifecycleObserver:
  | {
      read(): unknown
      dispose(): void
    }
  | undefined

/** Test-only method observations. A fulfilled Keeper.run is not a business-success or drain ACK. */
export function observeNativeAppendLifecycle(): void {
  if (nativeLifecycleObserver) throw Error("Native lifecycle observer already installed")
  const then = Promise.prototype.then
  const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!
  const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!
  const mapForEach = Map.prototype.forEach
  const started = performance.now()
  const events: NativeLifecycleEvent[] = []
  const pending = new Map<number, { stage: NativeLifecycleStage; instance: number; atMs: number }>()
  const managers = new Set<object>()
  let identities = new WeakMap<object, number>()
  let nextInstance = 0,
    nextCall = 0,
    overflow = 0,
    failed = false,
    active = true
  const guards = { count: 0, throws: 0, totalMs: 0, maxMs: 0 }
  const restores: Array<() => void> = []
  const data = (value: object, key: string): unknown => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && "value" in field ? field.value : undefined
  }
  const size = (value: unknown, kind: "set" | "map"): number | null => {
    if (kind === "set" ? !types.isSet(value) : !types.isMap(value)) return null
    return Reflect.apply(kind === "set" ? setSize : mapSize, value, []) as number
  }
  const observe = (operation: () => void): void => {
    if (!active) return
    try {
      operation()
    } catch {
      failed = true
    }
  }
  const push = (event: NativeLifecycleEvent): void => {
    if (events.length < 512) events.push(event)
    else overflow++
  }
  const settled = (
    stage: NativeLifecycleStage,
    instance: number,
    call: number,
    atMs: number,
    phase: "fulfilled" | "rejected"
  ): void => {
    observe(() => {
      const now = performance.now() - started
      pending.delete(call)
      push({ stage, instance, call, phase, atMs: now, elapsedMs: now - atMs })
    })
  }
  // These callbacks retain only numeric observation facts, never the method's receiver or args.
  const watch = (
    promise: Promise<unknown>,
    stage: NativeLifecycleStage,
    instance: number,
    call: number,
    atMs: number
  ): void => {
    try {
      Reflect.apply(then, promise, [
        () => settled(stage, instance, call, atMs, "fulfilled"),
        () => settled(stage, instance, call, atMs, "rejected")
      ])
    } catch {
      observe(() => {
        failed = true
      })
    }
  }
  const install = (target: object, key: string, stage: NativeLifecycleStage): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
      throw Error("Native lifecycle method is unavailable")
    const original = descriptor.value
    const wrapper = function (this: object, ...args: unknown[]): unknown {
      if (
        !active ||
        (stage === "manager.appendConversation-operation" && args[2] !== "appendConversation")
      )
        return Reflect.apply(original, this, args)
      const atMs = performance.now() - started
      let instance = 0,
        call = 0
      observe(() => {
        instance = identities.get(this) ?? ++nextInstance
        identities.set(this, instance)
        call = ++nextCall
        if (stage === "manager.appendConversation-operation") {
          if (managers.size < 16 || managers.has(this)) managers.add(this)
          else overflow++
        }
        if (stage !== "keeper.guard") {
          if (pending.size < 512) pending.set(call, { stage, instance, atMs })
          else overflow++
          const saved = data(this, "saved"),
            commitStarted = data(this, "commitStarted")
          push({
            stage,
            instance,
            call,
            phase: "begin",
            atMs,
            ...(stage === "ticket.acceptResult"
              ? {
                  saved: saved === undefined ? false : saved !== null && typeof saved === "object",
                  commitStarted: typeof commitStarted === "boolean" ? commitStarted : null
                }
              : {})
          })
        }
      })
      const finish = (phase: "return" | "throw"): void =>
        observe(() => {
          const now = performance.now() - started,
            elapsedMs = now - atMs
          if (stage === "keeper.guard") {
            guards.count++
            if (phase === "throw") guards.throws++
            guards.totalMs += elapsedMs
            guards.maxMs = Math.max(guards.maxMs, elapsedMs)
          } else {
            pending.delete(call)
            push({ stage, instance, call, phase, atMs: now, elapsedMs })
          }
        })
      let returned: unknown
      try {
        returned = Reflect.apply(original, this, args)
      } catch (reason) {
        finish("throw")
        throw reason
      }
      if (types.isPromise(returned) && stage !== "keeper.guard")
        watch(returned, stage, instance, call, atMs)
      else finish("return")
      return returned
    }
    Object.defineProperty(target, key, { ...descriptor, value: wrapper })
    restores.push(() => Object.defineProperty(target, key, descriptor))
  }
  const restore = (): void => {
    active = false
    const errors: unknown[] = []
    for (const undo of restores.splice(0).reverse()) {
      try {
        undo()
      } catch (error) {
        errors.push(error)
      }
    }
    managers.clear()
    pending.clear()
    identities = new WeakMap()
    nativeLifecycleObserver = undefined
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Native lifecycle restore failed")
  }
  try {
    install(FunctionConversationNativeKeeper.prototype, "run", "keeper.run")
    install(FunctionConversationNativeKeeper.prototype, "guard", "keeper.guard")
    install(FunctionConversationNativeKeeper.prototype, "whenDrained", "keeper.whenDrained")
    install(FunctionConversationNativeRetainer.prototype, "run", "retainer.run")
    install(
      FunctionConversationNativeRetainer.prototype,
      "protectedNative",
      "retainer.protectedNative"
    )
    install(FunctionConversationNativeRetainer.prototype, "prepare", "retainer.prepare")
    install(FunctionConversationNativeRetainer.prototype, "verified", "retainer.verified")
    install(FunctionSessionAppendTicket.prototype, "commit", "ticket.commit")
    install(FunctionSessionAppendTicket.prototype, "acceptResult", "ticket.acceptResult")
    // Existing instances captured appendConversation itself, but invoke this boundary dynamically.
    install(FunctionModsManager.prototype, "withOperation", "manager.appendConversation-operation")
  } catch (reason) {
    try {
      restore()
    } catch (cleanup) {
      throw new AggregateError([reason, cleanup], "Native lifecycle install failed", {
        cause: reason
      })
    }
    throw reason
  }
  nativeLifecycleObserver = {
    read() {
      const activities: Array<{
        instance: number
        sessions: number | null
        paused: boolean | null
        closed: boolean | null
        tokens: number | null
        waiters: number | null
      }> = []
      observe(() => {
        for (const manager of managers) {
          const sessions = data(manager, "sessions"),
            count = size(sessions, "map")
          if (count === null) continue
          Reflect.apply(mapForEach, sessions, [
            (entry: object) => {
              if (activities.length >= 16) return
              const activity = data(entry, "activity")
              if (!activity || typeof activity !== "object") return
              const paused = data(activity, "paused"),
                closed = data(activity, "closed")
              activities.push({
                instance: identities.get(manager) ?? 0,
                sessions: count,
                paused: typeof paused === "boolean" ? paused : null,
                closed: typeof closed === "boolean" ? closed : null,
                tokens: size(data(activity, "tokens"), "set"),
                waiters: size(data(activity, "waiters"), "set")
              })
            }
          ])
        }
      })
      return {
        events: events.map((event) => ({ ...event })),
        pending: [...pending.entries()].map(([call, value]) => ({ call, ...value })),
        guards: { ...guards },
        activities,
        overflow,
        observationFailed: failed
      }
    },
    dispose: restore
  }
}

export function readNativeAppendLifecycle(): unknown {
  if (!nativeLifecycleObserver) throw Error("Native lifecycle observer is not installed")
  return nativeLifecycleObserver.read()
}

export function stopNativeAppendLifecycle(): void {
  nativeLifecycleObserver?.dispose()
}

interface NativeAppendTerminalObservation {
  requestId: string
  channel: string
  operation: "agent:invoke" | "agent:resume" | "agent:interrupt"
  terminals: Array<"done" | "error">
}
let nativeAppendTerminalObserver: {
  read(): NativeAppendTerminalObservation[]
  dispose(): void
} | undefined

/** Observes only the current window's real requests and successfully sent terminal events. */
export function observeNativeAppendTerminals(window: BrowserWindow, threadId: string): void {
  if (nativeAppendTerminalObserver) throw Error("Native append observer already installed")
  const contents = window.webContents
  const originalSend = contents.send
  const originalDescriptor = Object.getOwnPropertyDescriptor(contents, "send")
  const requests: NativeAppendTerminalObservation[] = []
  const byChannel = new Map<string, NativeAppendTerminalObservation>()
  let observationFailed = false
  const listeners = (["agent:invoke", "agent:resume", "agent:interrupt"] as const).map(
    operation => {
      const listener = (event: IpcMainEvent, value: unknown) => {
        try {
          if (event.sender !== contents || !value || typeof value !== "object") return
          const request = value as Record<string, unknown>
          if (request.threadId !== threadId || typeof request.streamRequestId !== "string" ||
            !request.streamRequestId.trim()) return
          const ambient = `agent:stream:${threadId}${request.coordinatorInternalNotification === true
            ? ":coordinator-internal" : ""}`
          const channel = resolveAgentStreamRequestChannel(ambient, request.streamRequestId)
          if (byChannel.has(channel)) { observationFailed = true; return }
          const row: NativeAppendTerminalObservation = {
            requestId: request.streamRequestId, channel, operation, terminals: []
          }
          requests.push(row)
          byChannel.set(channel, row)
        } catch { observationFailed = true }
      }
      ipcMain.prependListener(operation, listener)
      return { operation, listener }
    }
  )
  const observedSend = function (this: WebContents, channel: string, ...args: unknown[]): void {
    const result = Reflect.apply(originalSend, this, [channel, ...args])
    try {
      if (this === contents) {
        const row = byChannel.get(channel), event = args[0]
        if (row && event && typeof event === "object") {
          const type = (event as { type?: unknown }).type
          if (type === "done" || type === "error") row.terminals.push(type)
        }
      }
    } catch { observationFailed = true }
    return result
  }
  try {
    Object.defineProperty(contents, "send", {
      configurable: true, writable: true, value: observedSend
    })
  } catch (error) {
    for (const { operation, listener } of listeners) ipcMain.removeListener(operation, listener)
    if (originalDescriptor) Object.defineProperty(contents, "send", originalDescriptor)
    else Reflect.deleteProperty(contents, "send")
    throw error
  }
  nativeAppendTerminalObserver = {
    read: () => {
      if (observationFailed) throw Error("Native append terminal observation failed")
      return requests.map(row => ({ ...row, terminals: [...row.terminals] }))
    },
    dispose: () => {
      for (const { operation, listener } of listeners) ipcMain.removeListener(operation, listener)
      try {
        if (originalDescriptor) Object.defineProperty(contents, "send", originalDescriptor)
        else Reflect.deleteProperty(contents, "send")
      } finally { nativeAppendTerminalObserver = undefined }
    }
  }
}

export function readNativeAppendTerminals(): NativeAppendTerminalObservation[] {
  if (!nativeAppendTerminalObserver) throw Error("Native append observer is not installed")
  return nativeAppendTerminalObserver.read()
}

/** Read-only physical occupancy, from the same lease map as the application. */
export function readNativeAppendThreadBusy(threadId: string): boolean {
  return getLocalThreadRunLease(threadId) !== undefined
}

/** Actual stored engine data for E2E assertions; public history is a protected display copy. */
export async function readNativeAppendCheckpoints(threadId: string): Promise<CheckpointTuple[]> {
  const saver = await getCheckpointer(threadId)
  const checkpoints: CheckpointTuple[] = []
  for await (const checkpoint of saver.list(
    { configurable: { thread_id: threadId, checkpoint_ns: "" } },
    { limit: 50 }
  )) {
    checkpoints.push(checkpoint)
  }
  return checkpoints
}

export function stopNativeAppendTerminalObserver(): void {
  nativeAppendTerminalObserver?.dispose()
}

interface Scope {
  workspace: string
  threadId: string
  turnId: string
}
const backends = new Map<string, LocalSandbox>()
const executionScopes = new Map<string, () => void>()

interface UiResolveConfigurationProbeManager {
  sessions: Map<string, {
    threadId: string
    workspace: string
    activity: FunctionSessionActivity
    session?: { uiResolve?: {
      closed: boolean
      preparing: boolean
      calls: Map<string, unknown>
      scopes: Map<string, {
        pending: number
        quiescent: boolean
        drained: boolean
        releaseAttempted: boolean
        controller: AbortController
        drawing: { drawing: { signal: AbortSignal } }
      }>
    } }
  }>
  applying: Map<string, unknown>
  host: { configurationBusy?(threadId: string): boolean }
}

let observedFunctionManager: FunctionModsManager | undefined
let restoreUiResolveConfigurationObserver: (() => void) | undefined

function recordObservedFunctionManager(manager: FunctionModsManager): void {
  observedFunctionManager = manager
}

/** Read-only observation of the real instance; does not enter a scope or change a promise. */
export function observeUiResolveConfiguration(): void {
  if (restoreUiResolveConfigurationObserver) throw Error("Configuration observer already installed")
  // installOperationGuards captures userConfig at construction, but dynamically looks up
  // this.withOperation. Observe that actual entry without replacing its guarded method.
  type Operation = (this: FunctionModsManager, workspace: string, threadId: string,
    method: PropertyKey, applyBefore: boolean, run: () => Promise<unknown>) => Promise<unknown>
  const prototype = FunctionModsManager.prototype as unknown as { withOperation: Operation }
  const original = prototype.withOperation
  if (typeof original !== "function") throw Error("Actual operation entry unavailable")
  function observed(
    this: FunctionModsManager,
    ...args: Parameters<Operation>
  ): ReturnType<Operation> {
    if (!(this instanceof FunctionModsManager)) throw Error("Expected actual FunctionModsManager")
    if (args[2] === "userConfig") recordObservedFunctionManager(this)
    return original.apply(this, args)
  }
  prototype.withOperation = observed
  restoreUiResolveConfigurationObserver = () => {
    const replaced = prototype.withOperation !== observed
    prototype.withOperation = original
    observedFunctionManager = undefined
    restoreUiResolveConfigurationObserver = undefined
    if (replaced) throw Error("Configuration observer was replaced")
  }
}

export function readUiResolveConfigurationFacts(threadId: string) {
  if (typeof threadId !== "string" || !threadId || threadId.length > 200)
    throw Error("Expected actual configuration thread ID")
  if (!restoreUiResolveConfigurationObserver || !observedFunctionManager)
    throw Error("Actual configuration manager has not been observed")
  const actual = observedFunctionManager as unknown as UiResolveConfigurationProbeManager
  const rows = [...actual.sessions.entries()].filter(([, entry]) => entry.threadId === threadId)
  if (rows.length !== 1) throw Error(`Expected one actual thread entry, got ${rows.length}`)
  const [key, entry] = rows[0]
  const assembly = entry.session?.uiResolve
  if (!assembly) throw Error("Expected actual native UI resolver assembly")
  const scopes = [...assembly.scopes.values()].map((scope) => ({
    pending: scope.pending,
    quiescent: scope.quiescent,
    drained: scope.drained,
    releaseAttempted: scope.releaseAttempted,
    aborted: scope.controller.signal.aborted,
    drawingClosed: scope.drawing.drawing.signal.aborted
  }))
  return {
    size: entry.activity.size,
    foregroundSize: entry.activity.foregroundSize,
    applying: actual.applying.has(key),
    configurationBusy: actual.host.configurationBusy?.(threadId) === true,
    physicalThreadBusy: getLocalThreadRunLease(threadId) !== undefined,
    logicalThreadBusy: getModsManager()!.functionTurns.hasUnsettled(threadId),
    assemblyClosed: assembly.closed,
    assemblyPreparing: assembly.preparing,
    calls: assembly.calls.size,
    scopes
  }
}

export function stopUiResolveConfigurationObserver(): void {
  restoreUiResolveConfigurationObserver?.()
}
export function bindExecutionScope(scope: Scope, executionWorkspace: string): void {
  releaseExecutionScope(scope.threadId)
  const controller = new AbortController()
  const instance = getModsManager()!.createRuntimeAuthority({ ...scope, signal: controller.signal })
  let release = () => {}
  new LocalSandbox({
    rootDir: executionWorkspace,
    modRuntimeAuthority: instance.authority,
    modWorkspace: scope.workspace,
    modBlockedToolNames: new Set(["execute"]),
    runId: scope.threadId,
    hookTurnId: scope.turnId,
    windowsSandbox: "none",
    abortSignal: controller.signal,
    onModBinding: (dispose) => {
      release = dispose
    },
    worktreeIsolation: {
      workspaceRoot: executionWorkspace,
      worktreeRoot: executionWorkspace
    } as import("../../src/main/agent/workflow/types").WorkflowWorktreeIsolationBoundary
  })
  executionScopes.set(scope.threadId, () => {
    controller.abort()
    release()
  })
}
export function releaseExecutionScope(threadId: string): void {
  executionScopes.get(threadId)?.()
  executionScopes.delete(threadId)
}
export async function startFunctionMcpFixture(
  workspace: string,
  node: string,
  server: string
): Promise<string> {
  const id = upsertMcpConnector({
    name: "Mods SDK fixture",
    kind: "stdio",
    command: node,
    args: [server, join(workspace, "mcp-sdk-counter.txt")],
    enabled: true
  })
  await getGlobalMcpCapabilityService().invalidate("function-mcp-fixture")
  return id
}
export async function stopFunctionMcpFixture(id: string): Promise<void> {
  deleteMcpConnector(id)
  await getGlobalMcpCapabilityService().invalidate("function-mcp-fixture-done")
}
export function removeFunctionMcpConfiguration(id: string): void {
  // Deliberately retain the cached transport to test the post-approval configuration check.
  deleteMcpConnector(id)
}

export function reserveFunctionMcpNamespace(name: string): string {
  // A name reservation must be detected without trying to launch this nonexistent transport.
  return upsertMcpConnector({
    name,
    kind: "stdio",
    command: "mods-e2e-must-not-spawn",
    args: [],
    enabled: true
  })
}
export async function mcpProbe(scope: Scope, node: string, server: string): Promise<unknown> {
  const service = getGlobalMcpCapabilityService()
  const id = upsertMcpConnector({
    name: "Mods local fixture",
    kind: "stdio",
    command: node,
    args: [server, join(scope.workspace, "mcp-counter.txt")],
    enabled: true
  })
  const callbacks: unknown[] = []
  try {
    const tools = await service.listTools()
    const echo = tools.find((tool) => tool.toolName === "mods_echo")!
    const disconnect = tools.find((tool) => tool.toolName === "mods_disconnect")!
    if (!echo || !disconnect) throw Error("Local MCP fixture discovery failed")
    const direct = await withScopedModMcp(scope, echo, {}, (args) =>
      service.invoke(echo.capabilityId, args)
    )
    const eager = await withModToolCall(
      scope,
      { toolCall: { id: "mcp-eager", name: echo.toolId, args: {} } },
      new Set([echo.toolId]),
      () =>
        createEagerMcpTool(service, echo).invoke(
          { type: "tool_call", id: "mcp-eager", name: echo.toolId, args: {} },
          {
            callbacks: [
              {
                handleToolEnd: (output) => {
                  callbacks.push(output)
                }
              }
            ]
          }
        )
    )
    let lostReply = false
    try {
      await withScopedModMcp(scope, disconnect, {}, (args) =>
        service.invoke(disconnect.capabilityId, args)
      )
    } catch {
      lostReply = true
    }
    const audit = getModsManager()!
      .store.audit(getModsManager()!.workspaceKey(scope.workspace))
      .filter((row) => row.toolId.startsWith("mcp:"))
    return { direct, eager, callbacks, lostReply, audit }
  } finally {
    deleteMcpConnector(id)
    // This is the application singleton. Retire the fixture transport, not the service.
    await service.invalidate("mods-e2e-probe-finished")
    await service.listTools() // Subsequent UI/command preparation must still be admitted.
  }
}
export function setThreadBusy(threadId: string, busy: boolean): void {
  if (busy) {
    if (!claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "mods-e2e-model" }).acquired)
      throw Error("Thread unexpectedly busy")
  } else releaseLocalThreadRunLease(threadId, "desktop", "mods-e2e-model")
}
export async function finishTurn(threadId: string): Promise<void> {
  await getModsManager()!.finishTurn(threadId)
}
export async function managedPolicyProbe(scope: Scope): Promise<unknown> {
  const manager = new ModsManager(
    join(scope.workspace, "managed-policy.sqlite"),
    () => [],
    async () => true,
    () => {},
    join(__dirname, "mod-host.js"),
    {
      ...DEFAULT_MOD_POLICY,
      required: true,
      denyTools: ["host:write_file"],
      redactLiterals: ["corporate-sensitive-fixture"]
    }
  )
  let executions = 0
  let blocked = false
  let required = false
  try {
    try {
      manager.configure(scope.workspace, false, false)
    } catch {
      required = true
    }
    try {
      await manager.dispatch(scope, "host:write_file", {}, async () => ++executions)
    } catch {
      blocked = true
    }
    const result = await manager.dispatch(scope, "host:read_file", {}, async () => ({
      text: "corporate-sensitive-fixture",
      raw: { value: "corporate-sensitive-fixture" },
      metadata: { password: "do-not-publish" }
    }))
    manager.policy.stop()
    const rebuilt = await manager.dispatch(
      scope,
      "host:read_file",
      {},
      async () => "corporate-sensitive-fixture"
    )
    return {
      required,
      blocked,
      executions,
      result,
      rebuilt,
      audit: manager.store.audit(manager.workspaceKey(scope.workspace))
    }
  } finally {
    manager.close()
  }
}
export async function runTool(
  scope: Scope,
  callId: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  let backend = backends.get(scope.threadId)
  if (!backend) {
    backend = new LocalSandbox({
      rootDir: scope.workspace,
      runId: scope.threadId,
      hookTurnId: scope.turnId,
      windowsSandbox: "none",
      timeout: 30_000
    })
    backends.set(scope.threadId, backend)
  }
  return withModToolCall(
    scope,
    { toolCall: { id: callId, name, args } },
    new Set(),
    async (request) => {
      const input = request.toolCall.args
      if (name === "write_file")
        return backend!.write(String(input.file_path), String(input.content))
      if (name === "read_file") return backend!.read(String(input.file_path))
      if (name === "execute") return backend!.execute(String(input.command))
      throw new Error("Unknown fixture tool")
    }
  )
}
export async function context(scope: Scope): Promise<string[]> {
  return getModsManager()!.context(scope)
}
export async function benchmark(scope: Scope, iterations = 100): Promise<Record<string, number>> {
  const times: number[] = []
  const startRss = process.memoryUsage().rss
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await getModsManager()!.dispatch(
      scope,
      "host:fixture_read",
      { index: i },
      async () => "benchmark"
    )
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return {
    iterations,
    medianMs: times[Math.floor(iterations * 0.5)],
    p95Ms: times[Math.floor(iterations * 0.95)],
    maxMs: times.at(-1)!,
    rssDeltaBytes: process.memoryUsage().rss - startRss
  }
}
export function stopRuntime(): void {
  const manager = getModsManager() as unknown as { clients: Map<string, ModRuntimeClient> }
  for (const client of manager.clients.values()) client.stop("MODS_TEST_CRASH")
}

export async function disabledReadBenchmark(scope: Scope, iterations = 500): Promise<unknown> {
  if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 10000)
    throw new Error("Invalid disabled-read benchmark size")
  const manager = getModsManager()!
  if (manager.isActive(scope.workspace)) throw new Error("Expected disabled Mods")
  const samples = { baseline: [] as number[], disabled: [] as number[] }
  try {
    // Interleave order to reduce cache, GC and temperature bias on the same real read path.
    for (let index = 0; index < iterations + 100; index++) {
      const arms =
        index % 2 ? (["disabled", "baseline"] as const) : (["baseline", "disabled"] as const)
      for (const arm of arms) {
        setModsManager(arm === "baseline" ? undefined : manager)
        const start = performance.now()
        await runTool(scope, `disabled-${index}-${arm}`, "read_file", {
          file_path: join(scope.workspace, "secret.txt")
        })
        if (index >= 100) samples[arm].push(performance.now() - start)
      }
    }
    const result = Object.fromEntries(
      Object.entries(samples).map(([arm, times]) => {
        times.sort((a, b) => a - b)
        return [
          arm,
          {
            iterations: times.length,
            medianMs: times[Math.floor(iterations / 2)],
            p95Ms: times[Math.floor(iterations * 0.95)]
          }
        ]
      })
    )
    return {
      ...result,
      p95ChangePercent: (result.disabled.p95Ms / result.baseline.p95Ms - 1) * 100,
      comparison: "same production read path, manager absent versus disabled; 100 warmups per arm"
    }
  } finally {
    setModsManager(manager)
    // Refresh the execution binding after the baseline temporarily omitted the manager.
    backends.delete(scope.threadId)
  }
}

export async function noopBenchmark(scope: Scope): Promise<unknown> {
  const store = new ModControlStore(join(scope.workspace, "benchmark.sqlite"))
  const client = new ModRuntimeClient(join(__dirname, "mod-host.js"))
  const engine = new ModEngine(store, client, () => {})
  const coldStart = performance.now()
  try {
    const grant = store.grant(scope.workspace, "benchmark", "controlled-fixture", true)
    await engine.load([
      {
        grant,
        compiled: {
          pluginId: "benchmark",
          digest: grant.digest,
          manifest: {
            apiVersion: "cmb.mods/v1",
            id: "benchmark",
            name: "Benchmark",
            entry: "index.ts",
            activation: "project",
            events: ["tool.call"],
            tools: ["host:fixture_read"],
            permissions: { readTools: [], writeTools: [], context: [], store: false }
          },
          code: 'var __cmbMod={default:{register(on){on.tool({id:"noop",tools:["host:fixture_read"]},async($,e,next)=>{const r=await next({args:e.args});return {kind:"result",receipt:r.receipt,projection:r.projection}})}}}'
        }
      }
    ])
    const coldMs = performance.now() - coldStart
    const times: number[] = []
    let initialRss = 0
    for (let i = 0; i < 1100; i++) {
      const request: ModDispatchRequest = {
        identity: {
          callId: `bench-${Date.now()}-${i}`,
          ...scope,
          agentId: "main",
          origin: "model",
          grantEpoch: grant.epoch
        },
        toolId: "host:fixture_read",
        effect: "read",
        args: { index: i },
        protectedOutput: false
      }
      const start = performance.now()
      await engine.dispatch(request, async () => "ok")
      if (i >= 100) times.push(performance.now() - start)
      if (i === 99) initialRss = client.stats.rssBytes
    }
    times.sort((a, b) => a - b)
    return {
      iterations: times.length,
      coldMs,
      medianMs: times[500],
      p95Ms: times[950],
      maxMs: times.at(-1),
      initialChildRss: initialRss,
      finalChildRss: client.stats.rssBytes,
      pendingRequests: client.stats.pending
    }
  } finally {
    await engine.dispose()
    client.stop()
    store.close()
  }
}
