import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
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
import { functionConversationCanonicalStamp } from "../checkpointer/function-conversation-checkpoint-membership"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL } from "../checkpointer/function-conversation-delivery"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { functionConversationState } from "./mods-conversation"
import { serializeFunctionConversationNativeMessage, deserializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { createNativeConversationStreamProjection }
  from "./native-conversation-stream-projection"
import * as fairness from "../utils/native-conversation-fairness"

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
  return { runtime, store, ref, messages, projection, controller, append, capture, proof, commit, saver,
    checks: () => checks, act: (next?: () => void) => { action = next } }
}

import * as committedCapture from "../checkpointer/committed-checkpoint-native-capture"

// Observe the original native source guard; replacing a Store method would disable batching.
describe("actual native committed checkpoint batching", () => {
  it.each(["native", "generic", "copied-binding"])("preserves the committed checkpoint through %s provenance", async mode => {
    const f = await actualMainHistory(3, false, true)
    expect(isFunctionConversationNativeMainRuntime(f.runtime)).toBe(true)
    expect(isFunctionConversationNativeCheckpointStore(f.store, f.ref)).toBe(true)
    let batchChecks = 0, rowChecks = 0
    f.act(() => {
      const stack = new Error().stack ?? ""
      if (!stack.includes("captureTuple")) return
      if (stack.includes("readRowsAtCut")) batchChecks++
      else if (stack.includes("readRowAtCut")) rowChecks++
    })
    const capture = vi.spyOn(committedCapture, "prepareNativeCommittedCheckpointCapture")
    const binding = mode === "copied-binding" ? { ...f.runtime.binding } : f.runtime.binding
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => binding,
      mode === "generic" ? undefined : f.runtime)
    const checkpoint: Checkpoint = { v: 1, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { messages: f.messages, [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.ref) },
      channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
    const config = { configurable: { thread_id: binding.checkpointThreadId, checkpoint_ns: "" } }
    const result = await bridge.wrap(f.saver).put(config, checkpoint,
      { source: "loop", step: 2, parents: {} })
    f.act()
    expect(result.configurable?.checkpoint_id).toBe(checkpoint.id)
    const saved = await f.saver.getTuple(result)
    expect(saved?.checkpoint.channel_values.messages).toHaveLength(f.messages.length)
    if (mode === "native") {
      expect(capture.mock.results.some(value => value.type === "return" && value.value !== undefined)).toBe(true)
      expect(batchChecks).toBeGreaterThan(0)
      expect(rowChecks).toBe(0)
    } else {
      expect(capture).not.toHaveBeenCalled()
      expect(batchChecks).toBe(0)
      expect(rowChecks).toBeGreaterThan(0)
    }
  })

  it("rejects a real checkpoint message changed by a native batch source guard", async () => {
    const f = await actualMainHistory(2, false)
    const capture = vi.spyOn(committedCapture, "prepareNativeCommittedCheckpointCapture")
    let changed = false
    f.act(() => {
      if (changed || !(new Error().stack ?? "").includes("readRowsAtCut")) return
      const tuple = capture.mock.calls[0]?.[2]
      if (!tuple) return
      changed = true
      const messages = tuple.checkpoint.channel_values.messages as BaseMessage[]
      messages[0].content = "changed after private copy"
    })
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding, f.runtime)
    const checkpoint: Checkpoint = { v: 1, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { messages: f.messages, [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.ref) },
      channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
    await expect(bridge.wrap(f.saver).put({ configurable: {
      thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }, checkpoint,
    { source: "loop", step: 2, parents: {} })).rejects.toThrow()
    expect(changed).toBe(true)
  })
})

describe("native post-COMMIT observer cooperation", () => {
  function checkpointFor(f: Awaited<ReturnType<typeof actualMainHistory>>): Checkpoint {
    return { v: 1, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { messages: f.messages,
        [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.ref) },
      channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
  }
  function duringForcedPause(run: () => void) {
    const original = fairness.nativeConversationFairness
    let forced = 0
    vi.spyOn(fairness, "nativeConversationFairness").mockImplementation((signal, current) => {
      const wait = original(signal, current)
      // Saver also cooperates after COMMIT, before receipt/mint. This suite targets the
      // distinct observer boundary after mint and before ACK, not that earlier pause.
      const observerPause = (new Error().stack ?? "").includes("at settle (")
      return force => {
        if (force && observerPause) { forced++; setImmediate(run) }
        return wait(force)
      }
    })
    return () => forced
  }
  const metadata = { source: "loop" as const, step: 2, parents: {} }

  it("yields after native mint and retains the namespace gate until the original ACK finishes", async () => {
    const f = await actualMainHistory(2, false), events: string[] = []
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding, f.runtime)
    const checkpoint = checkpointFor(f), next = checkpointFor(f)
    const config = { configurable: { thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }
    const originalAck = bridge.acknowledge.bind(bridge)
    vi.spyOn(bridge, "acknowledge").mockImplementation(proof => { events.push("ack"); originalAck(proof) })
    let queued: Promise<unknown> | undefined, queuedId: unknown
    const forced = duringForcedPause(() => {
      events.push("pause")
      queued = f.saver.put(config, next, metadata).then(result => {
        queuedId = result.configurable?.checkpoint_id
        events.push("queued-writer")
      })
      events.push("writer-queued")
    })
    const result = await bridge.wrap(f.saver).put(config, checkpoint, metadata)
    await queued
    expect(forced()).toBe(1)
    expect(events).toEqual(["pause", "writer-queued", "ack", "queued-writer"])
    expect(result.configurable?.checkpoint_id).toBe(checkpoint.id)
    expect(queuedId).toBe(next.id)
  })

  it.each(["tuple", "cancel", "close", "prototype"] as const)(
    "rejects %s changed during the actual immediate, skips ACK and removes the minted receipt", async change => {
      const f = await actualMainHistory(2, false)
      const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding, f.runtime)
      const capture = vi.spyOn(committedCapture, "prepareNativeCommittedCheckpointCapture")
      const ack = vi.spyOn(bridge, "acknowledge")
      // Observe the private receipt allocation without replacing a Store/Saver method or its guards.
      const receipts = Object.getOwnPropertyDescriptor(bridge, "receipts")!.value as WeakMap<object, unknown>
      const insert = receipts.set.bind(receipts)
      let proof: object | undefined, closing: Promise<void> | undefined
      vi.spyOn(receipts, "set").mockImplementation((key, value) => { proof = key; return insert(key, value) })
      let paused = false
      const forced = duringForcedPause(() => {
        paused = true
        if (change === "tuple") {
          const tuple = capture.mock.calls[0][2]
          const messages = tuple.checkpoint.channel_values.messages as BaseMessage[]
          messages[0].content = "changed while paused"
        } else if (change === "cancel") f.controller.abort(Error("OBSERVER_CANCELLED"))
        else if (change === "close") closing = f.saver.close()
        else vi.spyOn(AIMessage.prototype, "toDict").mockImplementation(() => { throw Error("CUSTOM_SERIALIZER") })
      })
      const checkpoint = checkpointFor(f)
      const config = { configurable: { thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }
      await expect(bridge.wrap(f.saver).put(config, checkpoint, metadata)).rejects.toThrow()
      expect(paused).toBe(true)
      expect(forced()).toBe(1)
      expect(ack).not.toHaveBeenCalled()
      expect(proof).toBeDefined()
      expect(receipts.has(proof!)).toBe(false)
      if (closing) await closing
      else {
        // No failed observer may strand the held namespace gate. Restore the test's prototype
        // override before asking the original Saver to serialize the following checkpoint.
        vi.restoreAllMocks()
        const next = checkpointFor(f)
        expect((await f.saver.put(config, next, metadata)).configurable?.checkpoint_id).toBe(next.id)
      }
    })

  it.each(["native", "generic"] as const)("keeps public observed void and synchronous for %s", async mode => {
    const f = await actualMainHistory(2, false)
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding,
      mode === "native" ? f.runtime : undefined)
    const observer = bridge.bindSaver(f.saver), checkpoint = checkpointFor(f)
    const config = { configurable: { thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }
    const prepared = observer.prepare(config, checkpoint)!
    const forced = duringForcedPause(() => undefined)
    let returned = false
    const original = bridge.acknowledge.bind(bridge), ack = vi.spyOn(bridge, "acknowledge")
      .mockImplementation(proof => { expect(returned).toBe(false); original(proof) })
    await f.saver.putWithCommitObserver(config, checkpoint, metadata, receipt => {
      expect(observer.observed(prepared, receipt)).toBeUndefined()
      returned = true
      expect(ack).toHaveBeenCalledOnce()
    })
    expect(forced()).toBe(0)
  })

  it("keeps a customized bound observer in its original synchronous call path", async () => {
    const f = await actualMainHistory(2, false)
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding, f.runtime)
    const bind = bridge.bindSaver.bind(bridge)
    let reads = 0, calls = 0
    vi.spyOn(bridge, "bindSaver").mockImplementation(saver => {
      const observer = bind(saver), observed = observer.observed
      Object.defineProperty(observer, "observed", { configurable: true, get: () => {
        reads++
        return (...args: Parameters<typeof observed>) => { calls++; return observed(...args) }
      } })
      return observer
    })
    const forced = duringForcedPause(() => undefined)
    await bridge.wrap(f.saver).put({ configurable: {
      thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }, checkpointFor(f), metadata)
    expect(reads).toBe(1)
    expect(calls).toBe(1)
    expect(forced()).toBe(0)
  })

  it("does not pause when a real native admission used the unsupported-data fallback", async () => {
    const f = await actualMainHistory(2, false)
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => f.runtime.binding, f.runtime)
    const checkpoint = checkpointFor(f)
    checkpoint.channel_values.customBinary = new Uint8Array([1, 2, 3])
    const capture = vi.spyOn(committedCapture, "prepareNativeCommittedCheckpointCapture")
    const forced = duringForcedPause(() => undefined)
    await bridge.wrap(f.saver).put({ configurable: {
      thread_id: f.runtime.binding.checkpointThreadId, checkpoint_ns: "" } }, checkpoint, metadata)
    expect(capture).toHaveBeenCalledOnce()
    expect(capture.mock.results[0]).toMatchObject({ type: "return", value: undefined })
    expect(forced()).toBe(0)
  })
})
