import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as immediate } from "node:timers/promises"
import { performance } from "node:perf_hooks"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FunctionConversationStore, isFunctionConversationNativeCheckpointStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { ModsManager } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { isFunctionConversationNativeMainRuntime } from "../mods/native-conversation-policy-source"
import { functionConversationCanonicalStamp, readFunctionConversationCheckpointMembership }
  from "../checkpointer/function-conversation-checkpoint-membership"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL } from "../checkpointer/function-conversation-delivery"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { functionConversationState, captureFunctionConversationTaskBinding,
  createFunctionConversationMiddleware } from "./mods-conversation"
import { wrapFunctionConversationInvocation } from "./mods-conversation-invocation"
import { wrapFunctionConversationNativeInvocation } from "./function-conversation-native-invocation"
import { createFunctionConversationNativeHost } from "./function-conversation-native-host"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"
import { createFunctionConversationNativeAgent } from "./native-agent-factory"
import { serializeFunctionConversationNativeMessage, deserializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createNativeConversationStreamProjection, isPrivateNativeConversationStreamMessage }
  from "./native-conversation-stream-projection"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const originalStackTraceLimit = Error.stackTraceLimit
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  Error.stackTraceLimit = 100
  directory = mkdtempSync(join(tmpdir(), "cmb-native-stream-batch-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
afterAll(async () => {
  Error.stackTraceLimit = originalStackTraceLimit
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Genuine manager/coordinator/native runtime; do not replace SQL or read methods to count calls. */
async function actualMainHistory(count = 4, register = true, unmarkedGaps = false) {
  const root = mkdtempSync(join(directory, "main-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, true)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), runId = randomUUID()
  appDb.createThread(threadId, { workspacePath: workspace })
  const controller = new AbortController()
  let checks = 0, action: (() => void) | undefined
  const guard = () => { checks++; controller.signal.throwIfAborted(); action?.() }
  const lease = claimLocalThreadRunLease({ threadId, runId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_MAIN_LEASE_REQUIRED")
  const physical = { workspace, threadId, turnId: randomUUID(), signal: controller.signal,
    assertLive: guard }
  const instance = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard,
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    },
    apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, runId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_MAIN_RUNTIME_REQUIRED")
  runtime.capturePolicy()
  const ref = runtime.target.ref
  const commit = (content: string) => {
    const uuid = randomUUID(), native = new AIMessage({ id: uuid, content })
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
      role: "assistant", content, created_at: new Date(row.createdAt) }))
    const row = store.commit(ref, { uuid, inputDigest: uuid, door: "response",
      origin: { kind: "model", model: "ActualModel" }, message: { type: "assistant",
        role: "assistant", content: [{ type: "text", text: content }] },
      nativePayload: serializeFunctionConversationNativeMessage(native),
      orderAnchor: { kind: "actual-response" }, sdk: false, inbox: false },
    runtime.assertCurrent, access.write, access.verify)
    const message = deserializeFunctionConversationNativeMessage(row.nativePayload)
    message.additional_kwargs = { ...message.additional_kwargs,
      function_row: functionConversationCanonicalStamp(ref, row) }
    return { row, message }
  }
  const originals = Array.from({ length: count }, (_, index) => commit("historical " + index))
  const messages: BaseMessage[] = originals.map(item => item.message)
  if (unmarkedGaps) {
    for (let index = messages.length; index >= 0; index--)
      messages.splice(index, 0, new HumanMessage({ id: randomUUID(), content: "ordinary " + index }))
  }
  const projection = createNativeConversationStreamProjection({ runtime, store })
  const saver = new SqlJsSaver(join(directory, randomUUID() + ".sqlite"))
  cleanups.push(async () => {
    action = undefined
    projection.close(); runtime.close(); closeOwner(); coordinator.registry.close()
    unbind(); instance.release(); releaseLocalThreadRunLease(threadId, "desktop", runId)
    manager.close(); await saver.close()
  })
  const capture = async (values: BaseMessage[]) => {
    const binding = { target: ref, checkpointThreadId: threadId,
      checkpointIncarnation: runtime.destination.incarnation,
      signal: controller.signal, assertCurrent: runtime.assertCurrent.bind(runtime) }
    const bridge = new FunctionConversationDeliveryBridge(store, () => binding)
    const checkpoint: Checkpoint = { v: 1, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { messages: values, [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(ref) },
      channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
    const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } }
    await bridge.wrap(saver).put(config, checkpoint, { source: "loop", step: 1, parents: {} })
    return bridge.bindSaver(saver).captureRecovery({ configurable: { ...config.configurable,
      checkpoint_id: checkpoint.id } }, binding)
  }
  const proof = await capture(messages)
  if (register) projection.registerHistorical(messages, proof)
  const append = () => {
    const next = commit("current response")
    projection.register(next.message, next.row)
    return next.message
  }
  return { runtime, store, ref, messages, projection, controller, append, capture, proof, commit, saver, runId,
    checks: () => checks, act: (next?: () => void) => { action = next } }
}

describe("first native historical registration scheduling", () => {
  it("uses and awaits async history through native retainInput and both real invocation layers", async () => {
    const f = await actualMainHistory(4, false)
    const original = new HumanMessage({ id: randomUUID(), content: "current native input" })
    appDb.upsertThreadMessages(f.runtime.destination.threadId, [{ id: original.id!, role: "user",
      content: String(original.content), created_at: new Date() }])
    const receipt = captureFunctionConversationNativeInput({ message: original,
      workspace: f.ref.workspace, threadId: f.runtime.destination.threadId, physicalRunId: f.runId,
      signal: f.controller.signal, origin: { kind: "composer" }, assertCurrent: f.runtime.assertCurrent })
    const host = createFunctionConversationNativeHost({ runtime: f.runtime, store: f.store,
      agentId: "main", model: "actual-history-scheduling", nativeInput: receipt,
      flush: () => f.runtime.assertCurrent() })
    let inputRetained = false, returnedPromise = false, historyComplete = false, modelCalls = 0
    class HistoryModel extends BaseChatModel {
      _llmType(): string { return "actual-history-scheduling" }
      bindTools(): this { return this }
      async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
        void _messages
        expect(inputRetained && returnedPromise && historyComplete).toBe(true)
        modelCalls++
        const message = new AIMessage({ id: randomUUID(), content: "native history completed" })
        return { generations: [{ message, text: String(message.content) }] }
      }
    }
    const binding = Object.freeze({ ...f.runtime.binding, target: f.ref,
      assertCurrent: f.runtime.assertCurrent })
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => binding)
    const agent = createFunctionConversationNativeAgent({ model: new HistoryModel({}), tools: [],
      checkpointer: bridge.wrap(f.saver), middleware: [host.middleware,
        createFunctionConversationMiddleware({ store: f.store,
          capture: task => captureFunctionConversationTaskBinding(task, binding),
          onIntakeNotes: host.registerIntake })] })
    host.install(agent.graph)
    const inner = wrapFunctionConversationInvocation(agent, { store: f.store, binding,
      history: { saver: f.saver, assertCurrent: f.runtime.assertCurrent, register: host.registerHistorical,
        registerAsync: (messages, proof, signal) => {
          inputRetained = !!f.store.readReceipt(f.ref, original.id!)
          expect(messages.some(message => message.id === original.id)).toBe(false)
          const pending = host.registerHistoricalAsync(messages, proof, signal)
          returnedPromise = pending instanceof Promise
          return pending?.then(() => { historyComplete = true })
        } }, onIntakeNotes: host.registerIntake })
    const wrapped = wrapFunctionConversationNativeInvocation(inner, host, f.runtime)
    try {
      await wrapped.invoke({ messages: [original] }, { configurable: {
        thread_id: f.runtime.target.checkpointThreadId, checkpoint_ns: f.ref.checkpointNamespace } })
      expect(inputRetained && returnedPromise && historyComplete).toBe(true)
      expect(modelCalls).toBe(1)
    } finally { host.close(); await host.whenDrained() }
  })

  it("releases pending ownership if fairness clock startup fails", async () => {
    const f = await actualMainHistory(3, false)
    const clock = vi.spyOn(performance, "now").mockImplementationOnce(() => {
      throw Error("FAIRNESS_CLOCK_STARTUP_FAILED")
    })
    try {
      await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal))
        .rejects.toThrow("FAIRNESS_CLOCK_STARTUP_FAILED")
      await expect(f.projection.whenDrained()).resolves.toBeUndefined()
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    } finally { clock.mockRestore() }
    await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).resolves.toBeUndefined()
  })

  it("awaits the native history entry before invoking the graph", async () => {
    const f = await actualMainHistory(3, false)
    const membership = readFunctionConversationCheckpointMembership(f.proof, f.store, f.ref)
    const config = { configurable: { thread_id: f.runtime.target.checkpointThreadId,
      checkpoint_ns: f.ref.checkpointNamespace, checkpoint_id: membership.checkpointId } }
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const called = new Promise<void>(resolve => { reached = resolve })
    const order: string[] = []
    const graph = { getState: async () => ({ config, values: { messages: f.messages,
      [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.ref) } }),
    invoke: vi.fn(async (_input: unknown, _config: unknown) => {
      void _input
      void _config
      order.push("invoke")
      return "completed"
    }) }
    const wrapped = wrapFunctionConversationInvocation(graph, { store: f.store,
      binding: { target: f.ref, checkpointThreadId: f.runtime.target.checkpointThreadId,
        checkpointIncarnation: f.runtime.destination.incarnation,
        runtimeCheckpointNamespace: f.ref.checkpointNamespace, signal: f.controller.signal,
        initialState: functionConversationState(f.ref), assertCurrent: f.runtime.assertCurrent },
      history: { saver: f.saver, assertCurrent: f.runtime.assertCurrent,
        register: f.projection.registerHistorical,
        registerAsync: async (messages, proof, signal) => {
          order.push("register-start")
          reached()
          await gate
          await f.projection.registerHistoricalAsync(messages, proof, signal)
          order.push("register-done")
        } } })
    const pending = wrapped.invoke(null, config)
    try {
      await Promise.race([called, pending.then(() => { throw Error("HISTORY_NOT_AWAITED") })])
      expect(graph.invoke).not.toHaveBeenCalled()
      release()
      await expect(pending).resolves.toBe("completed")
      expect(order).toEqual(["register-start", "register-done", "invoke"])
    } finally { release() }
  })

  it("services real immediate callbacks only outside complete read scopes and publishes atomically", async () => {
    const f = await actualMainHistory(8, false)
    const originalScope = appDb.withCanonicalThreadMessageReadScope
    let depth = 0, serviced = 0, insideScope = false, earlyPublication = false, settled = false
    const scoped = <T>(threadId: string, run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
      depth++
      try { return originalScope(threadId, run) } finally { depth-- }
    }
    const spy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope").mockImplementation(scoped)
    const tick = () => {
      if (settled) return
      serviced++
      insideScope ||= depth !== 0
      earlyPublication ||= f.messages.some(isPrivateNativeConversationStreamMessage)
      setImmediate(tick)
    }
    setImmediate(tick)
    try {
      const pending = f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)
      expect(pending).toBeInstanceOf(Promise)
      const drained = f.projection.whenDrained()
      await pending
      settled = true
      await drained
      expect(serviced).toBeGreaterThan(0)
      expect(insideScope).toBe(false)
      expect(earlyPublication).toBe(false)
      expect(f.messages.every(isPrivateNativeConversationStreamMessage)).toBe(true)
      f.projection.validate("values", { messages: f.messages })
      expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).toBeUndefined()
    } finally { settled = true; spy.mockRestore() }
  })

  it.each(["abort", "close"])("drains a registration interrupted by %s without publication", async kind => {
    const f = await actualMainHistory(5, false)
    let interrupted = false
    setImmediate(() => {
      interrupted = true
      if (kind === "abort") f.controller.abort()
      else f.projection.close()
    })
    const pending = f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)
    const drained = f.projection.whenDrained()
    await expect(pending).rejects.toThrow()
    await expect(drained).resolves.toBeUndefined()
    expect(interrupted).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it.each(["message", "array", "unmarked", "canonical", "store", "proof"])(
    "rejects %s changes while yielded without publishing a subset", async change => {
      const f = await actualMainHistory(4, false, change === "unmarked")
      const original = f.store.readCheckpointMember
      let changed = false, closing: Promise<void> | undefined
      setImmediate(() => {
        changed = true
        if (change === "message" || change === "unmarked") f.messages[0].content = "changed while yielded"
        else if (change === "array") f.messages.reverse()
        else if (change === "canonical") appDb.getDb().run(
          "UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
          [JSON.stringify("changed"), f.runtime.destination.threadId, f.messages[0].id!])
        else if (change === "store") Object.defineProperty(f.store, "readCheckpointMember", {
          configurable: true, value: original.bind(f.store) })
        else closing = f.saver.close()
      })
      try {
        const pending = f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)
        const drained = f.projection.whenDrained()
        await expect(pending).rejects.toThrow()
        await drained
        expect(changed).toBe(true)
        expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
      } finally {
        if (change === "store") Reflect.deleteProperty(f.store, "readCheckpointMember")
        await closing
      }
    })

  it.each(["register", "omit"])("latches a caught pending %s call before its ordinary early return", async entry => {
    const f = await actualMainHistory(4, false)
    let rejected = false
    setImmediate(() => {
      try {
        if (entry === "register") f.projection.registerHistorical(f.messages, f.proof)
        else f.projection.omitMessage(null)
      } catch { rejected = true }
    })
    await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).rejects.toThrow()
    await f.projection.whenDrained()
    expect(rejected).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).resolves.toBeUndefined()
  })

  it("retains synchronous custom fallback and the permanent registered-history fallback", async () => {
    const f = await actualMainHistory(3, false)
    const original = f.store.readCheckpointMember
    const order: string[] = []
    Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
      value: (...args: Parameters<typeof original>) => {
        order.push("read")
        return Reflect.apply(original, f.store, args)
      } })
    try {
      order.push("before")
      expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).toBeUndefined()
      order.push("after")
      expect(order[0]).toBe("before")
      expect(order[1]).toBe("read")
      expect(order[order.length - 1]).toBe("after")
      expect(f.messages.every(isPrivateNativeConversationStreamMessage)).toBe(true)
    } finally { Reflect.deleteProperty(f.store, "readCheckpointMember") }
    expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).toBeUndefined()
    await immediate()
    f.projection.validate("values", { messages: f.messages })
  })

  it("slices the first history after a current-turn entry has already been registered", async () => {
    const f = await actualMainHistory(5, false)
    const currentInput = f.append()
    expect(isPrivateNativeConversationStreamMessage(currentInput)).toBe(true)
    let serviced = false
    setImmediate(() => { serviced = true })
    const pending = f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(serviced).toBe(true)
    expect(f.messages.every(isPrivateNativeConversationStreamMessage)).toBe(true)
    f.projection.validate("values", { messages: [...f.messages, currentInput] })
    expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).toBeUndefined()
  })

  it("keeps the original synchronous path when the history includes a same-owner entry", async () => {
    const f = await actualMainHistory(3, false)
    const currentInput = f.append(), messages = [...f.messages, currentInput]
    const proof = await f.capture(messages)
    expect(f.projection.registerHistoricalAsync(messages, proof, f.controller.signal)).toBeUndefined()
    expect(messages.every(isPrivateNativeConversationStreamMessage)).toBe(true)
    f.projection.validate("values", { messages })
  })

  it("accepts cached messages from a closed owner through the original ownership checks", async () => {
    const f = await actualMainHistory(4)
    f.projection.close()
    const next = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    try {
      await expect(next.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).resolves.toBeUndefined()
      next.validate("values", { messages: f.messages })
    } finally { next.close() }
  })

  it("rejects unmarked input changed after the final canonical scope before adoption", async () => {
    const f = await actualMainHistory(3, false, true)
    const originalScope = appDb.withCanonicalThreadMessageReadScope
    let finalBatch = false, changed = false
    f.act(() => { if (new Error().stack?.includes("validateHistoricalBatch")) finalBatch = true })
    const scoped = <T>(threadId: string, run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
      const result = originalScope(threadId, run)
      if (finalBatch && !changed && threadId === f.runtime.destination.threadId) {
        changed = true
        f.messages[0].content = "unmarked changed after fresh B"
      }
      return result
    }
    const spy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope").mockImplementation(scoped)
    try { await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).rejects.toThrow() }
    finally { spy.mockRestore(); f.act() }
    expect(changed).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it("does not invoke a serializer after the final source guard", async () => {
    const f = await actualMainHistory(3, false, true)
    const original = HumanMessage.prototype.toDict
    let finalBatch = false, finalGuard = false, afterGuardCalls = 0
    const spy = vi.spyOn(HumanMessage.prototype, "toDict").mockImplementation(function(this: HumanMessage) {
      if (finalGuard) afterGuardCalls++
      return Reflect.apply(original, this, [])
    })
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("validateHistoricalBatch")) finalBatch = true
      else if (finalBatch) finalGuard = true
    })
    try {
      await expect(f.projection.registerHistoricalAsync(f.messages, f.proof, f.controller.signal)).resolves.toBeUndefined()
      expect(finalGuard).toBe(true)
      expect(afterGuardCalls).toBe(0)
    } finally { spy.mockRestore(); f.act() }
  })
})

describe("native historical registration initial rows", () => {
  it("batches initial rows while retaining independent prepareEntry fresh reads", async () => {
    const f = await actualMainHistory(4, false)
    // Count genuine native source guards without replacing Store methods and disabling
    // eligibility. One direct call supplies the guard count for each method's boundaries.
    let oneBatchChecks = 0, oneMemberChecks = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readCheckpointMembers")) oneBatchChecks++
      else if (stack.includes("readCheckpointMember")) oneMemberChecks++
    })
    f.store.readCheckpointMembers(f.ref, f.proof, f.messages.map(message => message.id!),
      f.runtime.assertCurrent.bind(f.runtime))
    f.store.readCheckpointMember(f.ref, f.proof, f.messages[0].id!,
      f.runtime.assertCurrent.bind(f.runtime))
    expect(oneBatchChecks).toBeGreaterThan(0)
    expect(oneMemberChecks).toBeGreaterThan(0)
    let initialGuards = 0, prepareGuards = 0, finalGuards = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readCheckpointMembers") && stack.includes("readInitialHistoricalRows")) initialGuards++
      if (stack.includes("readCheckpointMember") && stack.includes("prepareEntry")) prepareGuards++
      if (stack.includes("readCheckpointMembers") && stack.includes("finishEntryGuards")) finalGuards++
    })
    f.projection.registerHistorical(f.messages, f.proof)
    expect(initialGuards).toBe(oneBatchChecks)
    expect(prepareGuards).toBe(oneMemberChecks * f.messages.length)
    expect(finalGuards).toBe(oneBatchChecks)
    f.act()
    f.projection.validate("values", { messages: f.messages })
  })

  it("preserves checkpoint ordinals with unmarked messages before, between and after members", async () => {
    const f = await actualMainHistory(2, false, true)
    let initialGuards = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readInitialHistoricalRows") && stack.includes("readCheckpointMembers")) initialGuards++
    })
    f.projection.registerHistorical(f.messages, f.proof)
    expect(initialGuards).toBeGreaterThan(0)
    expect(f.messages.map(isPrivateNativeConversationStreamMessage)).toEqual([false, true, false, true, false])
    expect(f.messages.map(message => message.content)).toEqual([
      "ordinary 0", "historical 0", "ordinary 1", "historical 1", "ordinary 2"
    ])
    f.act()
    expect(() => f.projection.validate("values", { messages: f.messages })).not.toThrow()
  })

  it("keeps custom Store initial reads on their original per-row path", async () => {
    const f = await actualMainHistory(3, false)
    const original = f.store.readCheckpointMember
    let initialReads = 0, initialBatches = 0
    Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
      value: (...args: Parameters<typeof original>) => {
        const stack = new Error().stack ?? ""
        if (!stack.includes("prepareEntry") && !stack.includes("finishEntryGuards")) initialReads++
        return Reflect.apply(original, f.store, args)
      } })
    f.act(() => { if (new Error().stack?.includes("readInitialHistoricalRows")) initialBatches++ })
    try {
      f.projection.registerHistorical(f.messages, f.proof)
      expect(initialReads).toBe(f.messages.length)
      expect(initialBatches).toBe(0)
    } finally { Reflect.deleteProperty(f.store, "readCheckpointMember") }
  })

  it("rejects a Store override installed during the initial batch and releases its latch", async () => {
    const f = await actualMainHistory(3, false)
    const original = f.store.readCheckpointMember
    let changed = false
    f.act(() => {
      if (changed || !new Error().stack?.includes("readInitialHistoricalRows")) return
      changed = true
      Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
        value: original.bind(f.store) })
    })
    try {
      expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
      expect(changed).toBe(true)
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    } finally {
      f.act()
      Reflect.deleteProperty(f.store, "readCheckpointMember")
    }
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).not.toThrow()
  })

  it.each([false, true])("latches caught initial-batch registration reentry, custom fallback=%s", async custom => {
    const f = await actualMainHistory(3, false)
    const original = f.store.readCheckpointMember
    let entered = false, rejected = false
    f.act(() => {
      if (entered || !new Error().stack?.includes("readInitialHistoricalRows")) return
      entered = true
      if (custom) Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
        value: original.bind(f.store) })
      try { f.projection.registerHistorical(f.messages, f.proof) } catch { rejected = true }
    })
    try {
      expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
      expect(entered && rejected).toBe(true)
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    } finally {
      f.act()
      if (custom) Reflect.deleteProperty(f.store, "readCheckpointMember")
    }
    // The latch belongs to this synchronous batch, not the lifetime of the projection.
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).not.toThrow()
  })

  it("rejects a proof whose saver lifetime ends during the initial batch", async () => {
    const f = await actualMainHistory(3, false)
    let closing: Promise<void> | undefined
    f.act(() => {
      if (closing || !new Error().stack?.includes("readInitialHistoricalRows")) return
      closing = f.saver.close()
    })
    try {
      expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
      expect(closing).toBeDefined()
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    } finally { f.act(); await closing }
  })

  it.each(["membership", "native-message"])(
    "rejects %s changed by the initial batch's second guard before adoption", async change => {
      const f = await actualMainHistory(3, false)
      let firstGuardSite: string | undefined, changed = false, preparedFresh = false
      f.act(() => {
        const stack = new Error().stack ?? ""
        if (changed && stack.includes("prepareEntry") && stack.includes("readCheckpointMember"))
          preparedFresh = true
        if (changed || !stack.includes("readInitialHistoricalRows")) return
        const frames = stack.split("\n")
        // Membership proof checks also invoke source guards from other Store call sites.
        // Select only the explicit guard supplied by the projection at the batch boundaries.
        if (!frames.some(line => line.includes("at guard (") &&
          line.includes("native-conversation-stream-projection.ts"))) return
        const site = frames.find(line =>
          line.includes("FunctionConversationStore.readCheckpointMembers"))
        if (!site) return
        if (firstGuardSite === undefined) { firstGuardSite = site; return }
        if (site === firstGuardSite) return
        changed = true
        const last = f.messages[f.messages.length - 1]
        if (change === "membership") appDb.getDb().run(
          "UPDATE function_conversation_checkpoint_members SET member_json=? WHERE uuid=?", ["{}", last.id!])
        else last.content = "changed after initial rows were read"
      })
      expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
      expect(changed).toBe(true)
      expect(preparedFresh).toBe(true)
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    })

  it("rejects cancellation during the initial batch before publishing any entry", async () => {
    const f = await actualMainHistory(3, false)
    let reached = false
    f.act(() => {
      if (reached || !new Error().stack?.includes("readInitialHistoricalRows")) return
      reached = true
      f.controller.abort()
    })
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
    expect(reached).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })
})

describe("native historical registration final guards", () => {
  it("batches unpublished entries and reduces final source checks without skipping initial authentication", async () => {
    const f = await actualMainHistory(6, false)
    let batchGuards = 0, memberGuards = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readCheckpointMembers")) batchGuards++
      else if (stack.includes("readCheckpointMember")) memberGuards++
    })
    const before = f.checks()
    f.projection.registerHistorical(f.messages, f.proof)
    const fastChecks = f.checks() - before
    expect(batchGuards).toBeGreaterThan(0)
    expect(memberGuards).toBeGreaterThan(0)
    expect(f.messages.every(isPrivateNativeConversationStreamMessage)).toBe(true)
    f.act()
    f.projection.validate("values", { messages: f.messages })

    const fallback = await actualMainHistory(6, false)
    const original = fallback.store.readCheckpointMembers
    Object.defineProperty(fallback.store, "readCheckpointMembers", { configurable: true,
      value: original.bind(fallback.store) })
    let fallbackBatches = 0
    fallback.act(() => {
      if (new Error().stack?.includes("readCheckpointMembers")) fallbackBatches++
    })
    const fallbackBefore = fallback.checks()
    try {
      fallback.projection.registerHistorical(fallback.messages, fallback.proof)
      expect(fallbackBatches).toBe(0)
      expect(fallback.checks() - fallbackBefore).toBeGreaterThan(fastChecks)
    } finally { Reflect.deleteProperty(fallback.store, "readCheckpointMembers") }
  })

  it("keeps one historical member on its original per-row final check", async () => {
    const f = await actualMainHistory(1, false)
    let batches = 0, finalMemberChecks = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readCheckpointMembers")) batches++
      if (stack.includes("finishEntryGuards") && stack.includes("readCheckpointMember"))
        finalMemberChecks++
    })
    f.projection.registerHistorical(f.messages, f.proof)
    expect(batches).toBe(0)
    expect(finalMemberChecks).toBeGreaterThan(0)
  })

  it("preserves observable per-row overrides", async () => {
    const f = await actualMainHistory(3, false)
    const original = f.store.readCheckpointMember
    let finalReads = 0, batches = 0
    Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
      value: (...args: Parameters<typeof original>) => {
        if (new Error().stack?.includes("finishEntryGuards")) finalReads++
        return Reflect.apply(original, f.store, args)
      } })
    f.act(() => { if (new Error().stack?.includes("readCheckpointMembers")) batches++ })
    try {
      f.projection.registerHistorical(f.messages, f.proof)
      expect(finalReads).toBe(f.messages.length)
      expect(batches).toBe(0)
    } finally { Reflect.deleteProperty(f.store, "readCheckpointMember") }
  })

  it("falls back for a mixture of reused and newly authenticated membership proofs", async () => {
    const f = await actualMainHistory(2)
    const next = f.commit("new checkpoint member")
    const messages = [...f.messages, next.message]
    const proof = await f.capture(messages)
    let batches = 0, finalChecks = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("finishEntryGuards") && stack.includes("readCheckpointMembers")) batches++
      if (stack.includes("finishEntryGuards") && stack.includes("readCheckpointMember")) finalChecks++
    })
    f.projection.registerHistorical(messages, proof)
    expect(batches).toBe(0)
    expect(finalChecks).toBeGreaterThan(0)
    f.act()
    f.projection.validate("values", { messages })
  })

  it("retains a sticky failure when a batch guard catches reentrant validation of reused entries", async () => {
    const f = await actualMainHistory()
    let entered = false, rejected = false
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (entered || !stack.includes("finishEntryGuards") || !stack.includes("readCheckpointMembers")) return
      entered = true
      try { f.projection.validate("values", { messages: f.messages }) } catch { rejected = true }
    })
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
    expect(entered && rejected).toBe(true)
    f.act()
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
  })

  it("only transfers previous entries after their projection owner has closed", async () => {
    const f = await actualMainHistory(3)
    const next = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    let batchGuards = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("finishEntryGuards") && stack.includes("readCheckpointMembers")) batchGuards++
    })
    try {
      expect(() => next.registerHistorical(f.messages, f.proof)).toThrow()
      expect(batchGuards).toBe(0)
      f.projection.close()
      next.registerHistorical(f.messages, f.proof)
      expect(batchGuards).toBeGreaterThan(0)
      f.act()
      next.validate("values", { messages: f.messages })
    } finally { next.close() }
  })

  it.each([0, 2])("checks the persisted membership of batch row %s", async index => {
    const f = await actualMainHistory(3, false)
    let changed = false
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (changed || !stack.includes("finishEntryGuards") || !stack.includes("readCheckpointMembers")) return
      changed = true
      appDb.getDb().run("UPDATE function_conversation_checkpoint_members SET member_json=? WHERE uuid=?",
        ["{}", f.messages[index].id!])
    })
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
    expect(changed).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it.each(["content_json", "provider_source_id"])(
    "retains the final fresh-B check when the batch guard changes earlier canonical %s", async column => {
      const f = await actualMainHistory(3, false)
      let changed = false
      f.act(() => {
        const stack = new Error().stack ?? ""
        if (changed || !stack.includes("finishEntryGuards") || !stack.includes("readCheckpointMembers")) return
        changed = true
        appDb.getDb().run("UPDATE thread_messages SET " + column +
          "=? WHERE thread_id=? AND message_id=?",
        [column === "content_json" ? JSON.stringify("changed") : "changed",
          f.runtime.destination.threadId, f.messages[0].id!])
      })
      expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
      expect(changed).toBe(true)
      expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
    })

  it("rejects cancellation during registration's final batch without publishing entries", async () => {
    const f = await actualMainHistory(3, false)
    let batched = false
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (!stack.includes("finishEntryGuards") || !stack.includes("readCheckpointMembers")) return
      batched = true
      f.controller.abort()
    })
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
    expect(batched).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it.each(["before-batch", "inside-batch"])(
    "rechecks a Store override installed by the final guard %s", async boundary => {
      const f = await actualMainHistory(3, false)
      const original = f.store.readCheckpointMember
      let installed = false, overrideReads = 0, batchGuards = 0
      f.act(() => {
        const stack = new Error().stack ?? ""
        const inBatch = stack.includes("readCheckpointMembers")
        if (inBatch && stack.includes("finishEntryGuards")) batchGuards++
        if (installed || !stack.includes("finishEntryGuards") ||
          (boundary === "inside-batch") !== inBatch) return
        installed = true
        Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
          value: (...args: Parameters<typeof original>) => {
            overrideReads++
            return Reflect.apply(original, f.store, args)
          } })
      })
      try {
        const register = () => f.projection.registerHistorical(f.messages, f.proof)
        if (boundary === "before-batch") {
          expect(register).not.toThrow()
          expect(overrideReads).toBe(f.messages.length)
          expect(batchGuards).toBe(0)
        } else {
          expect(register).toThrow()
          expect(batchGuards).toBeGreaterThan(0)
          expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
        }
        expect(installed).toBe(true)
      } finally { Reflect.deleteProperty(f.store, "readCheckpointMember") }
    })

  it("rejects a receipt changed only by the batch's second source guard", async () => {
    const f = await actualMainHistory(3, false)
    let firstGuardSite: string | undefined, changed = false
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (!stack.includes("finishEntryGuards")) return
      const frames = stack.split("\n")
      if (!frames.some(line => line.includes("at guard (") &&
        line.includes("native-conversation-stream-projection.ts"))) return
      const site = frames.find(line =>
        line.includes("FunctionConversationStore.readCheckpointMembers"))
      if (!site || changed) return
      // The runtime can check several authorities per invocation. Distinguish the two
      // Store call sites instead of mistaking a second authority check for the end guard.
      if (firstGuardSite === undefined) { firstGuardSite = site; return }
      if (site === firstGuardSite) return
      changed = true
      appDb.getDb().run("UPDATE function_conversation_checkpoint_receipts SET snapshot_digest=? " +
        "WHERE conversation_id=? AND branch_id=?", ["changed", f.ref.conversationId, f.ref.branchId])
    })
    expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow()
    expect(firstGuardSite).toBeDefined()
    expect(changed).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it("rejects a native message changed after fresh B before publishing any prepared entry", async () => {
    const f = await actualMainHistory(3, false)
    const originalScope = appDb.withCanonicalThreadMessageReadScope
    let changed = false
    const scoped = <T>(threadId: string, run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
      const result = originalScope(threadId, run)
      if (!changed && threadId === f.runtime.destination.threadId) {
        changed = true
        // Mutate the last entry: adoption must inspect the entire set before publishing
        // even the first valid entry, not publish and then inspect the next entry.
        f.messages[f.messages.length - 1].content = "changed after final canonical seal"
      }
      return result
    }
    const spy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope").mockImplementation(scoped)
    try { expect(() => f.projection.registerHistorical(f.messages, f.proof)).toThrow() }
    finally { spy.mockRestore() }
    expect(changed).toBe(true)
    expect(f.messages.some(isPrivateNativeConversationStreamMessage)).toBe(false)
  })

  it("releases registration latches without calling a replaced iterator after fresh B", async () => {
    const f = await actualMainHistory(3, false)
    const originalScope = appDb.withCanonicalThreadMessageReadScope
    const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
    let installed = false, calls = 0, error: unknown
    const scoped = <T>(threadId: string, run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
      const result = originalScope(threadId, run)
      if (!installed && threadId === f.runtime.destination.threadId) {
        installed = true
        Object.defineProperty(Array.prototype, Symbol.iterator, { ...originalIterator,
          value: function(this: unknown[]) {
            calls++
            return Reflect.apply(originalIterator.value, this, [])
          } })
      }
      return result
    }
    const spy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope").mockImplementation(scoped)
    try { f.projection.registerHistorical(f.messages, f.proof) }
    catch (caught) { error = caught }
    finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator)
      spy.mockRestore()
    }
    expect(installed).toBe(true)
    expect(error).toBeUndefined()
    expect(calls).toBe(0)
    f.projection.validate("values", { messages: f.messages })
  })
})

describe("native historical stream validation batches", () => {
  it("keeps batch cleanup callback-free after the final fresh read", async () => {
    const f = await actualMainHistory()
    const originalScope = appDb.withCanonicalThreadMessageReadScope
    const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
    let installed = false, calls = 0, error: unknown
    const scoped = <T>(threadId: string, run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
      const result = originalScope(threadId, run)
      if (!installed && threadId === f.runtime.destination.threadId) {
        installed = true
        Object.defineProperty(Array.prototype, Symbol.iterator, { ...originalIterator,
          value: function(this: unknown[]) {
            calls++
            f.messages[0].content = "mutated after final seal"
            return Reflect.apply(originalIterator.value, this, [])
          } })
      }
      return result
    }
    const spy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope").mockImplementation(scoped)
    try { f.projection.validate("values", { messages: f.messages }) }
    catch (caught) { error = caught }
    finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator)
      spy.mockRestore()
    }
    expect(installed).toBe(true)
    expect(error).toBeUndefined()
    expect(calls).toBe(0)
    expect(f.messages[0].content).toBe("historical 0")
  })

  it("uses the original batch for same-proof history alongside a current response and reduces source reads", async () => {
    const f = await actualMainHistory(6)
    expect(isFunctionConversationNativeMainRuntime(f.runtime)).toBe(true)
    expect(isFunctionConversationNativeCheckpointStore(f.store, f.ref)).toBe(true)
    const values = [...f.messages, f.append()]
    let batchGuards = 0
    f.act(() => { if (new Error().stack?.includes("readCheckpointMembers")) batchGuards++ })
    f.projection.validate("values", { messages: values })
    const before = f.checks()
    f.projection.validate("values", { messages: values })
    const fastChecks = f.checks() - before
    expect(batchGuards).toBeGreaterThan(0)
    const actual = f.store.readCheckpointMembers
    Object.defineProperty(f.store, "readCheckpointMembers", { configurable: true,
      value: actual.bind(f.store) })
    try {
      expect(isFunctionConversationNativeCheckpointStore(f.store, f.ref)).toBe(false)
      batchGuards = 0
      const fallbackStart = f.checks()
      f.projection.validate("values", { messages: values })
      expect(batchGuards).toBe(0)
      expect(f.checks() - fallbackStart).toBeGreaterThan(fastChecks)
    } finally { Reflect.deleteProperty(f.store, "readCheckpointMembers") }
  })

  it("rechecks an earlier message changed by the final native callback and latches failure", async () => {
    const f = await actualMainHistory()
    const before = f.messages[0].content
    let batched = false, changed = false
    f.act(() => {
      if (new Error().stack?.includes("readCheckpointMembers")) batched = true
      else if (batched && !changed) { changed = true; f.messages[0].content = "changed after batch" }
    })
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
    expect(batched && changed).toBe(true)
    f.act()
    f.messages[0].content = before
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
  })

  it("falls back when validating the current response installs a historical read override", async () => {
    const f = await actualMainHistory()
    const values = [...f.messages, f.append()]
    const originalRead = f.store.readCheckpointMember
    let installed = false, singleReads = 0, batchGuards = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (stack.includes("readCheckpointMembers")) batchGuards++
      if (installed || !stack.includes("validateMessage")) return
      installed = true
      Object.defineProperty(f.store, "readCheckpointMember", { configurable: true,
        value: (...args: Parameters<typeof originalRead>) => {
          singleReads++
          return Reflect.apply(originalRead, f.store, args)
        } })
    })
    try {
      f.projection.validate("values", { messages: values })
      expect(installed).toBe(true)
      expect(singleReads).toBe(f.messages.length)
      expect(batchGuards).toBe(0)
    } finally {
      f.act()
      Reflect.deleteProperty(f.store, "readCheckpointMember")
    }
  })

  it("does not recover a batch after a caught reentrant validation", async () => {
    const f = await actualMainHistory()
    let entered = false, rejected = false
    f.act(() => {
      if (entered || !new Error().stack?.includes("readCheckpointMembers")) return
      entered = true
      try { f.projection.validate("values", { messages: f.messages }) } catch { rejected = true }
    })
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
    expect(entered && rejected).toBe(true)
    f.act()
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
  })

  it("rejects cancellation during the original batch guard", async () => {
    const f = await actualMainHistory()
    let batched = false
    f.act(() => {
      if (!new Error().stack?.includes("readCheckpointMembers")) return
      batched = true
      f.controller.abort()
    })
    expect(() => f.projection.validate("values", { messages: f.messages })).toThrow()
    expect(batched).toBe(true)
  })
})
