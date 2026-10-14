import { randomUUID } from "node:crypto"
import * as projectionModule from "./native-conversation-stream-projection"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { ModsManager } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { isFunctionConversationNativeMainRuntime } from "../mods/native-conversation-policy-source"
import { functionConversationCanonicalStamp } from
  "../checkpointer/function-conversation-checkpoint-membership"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL } from
  "../checkpointer/function-conversation-delivery"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { prepareFunctionConversationIntake, functionConversationState } from "./mods-conversation"
import { serializeFunctionConversationNativeMessage, deserializeFunctionConversationNativeMessage }
  from "./function-conversation-native-message"
import { createNativeConversationStreamProjection, projectNativeConversationMessageForStream,
  readNativeConversationStreamProjection, transferNativeConversationStreamProjection,
  serializeNativeConversationStreamData, isPrivateNativeConversationStreamMessage,
  privateNativeConversationStreamMessageRole,
  type NativeConversationStreamProjectionRuntime }
  from "./native-conversation-stream-projection"
import { createStreamDataSerializer, serializeStreamData,
  createSerializedValuesMessageAccumulator } from "../ipc/stream-data-serialization"
import { persistedMessageFromStreamPayload, streamPayloadContentMode } from
  "../ipc/stream-transcript-payload"
import { selectStreamTranscriptValueSnapshots } from "../ipc/stream-transcript-values"
import { StandardTurnStreamConsumer } from "./standard-turn-stream"
import { setCurrentRunMessageQueueOwner, clearCurrentRunMessageQueue,
  isCurrentRunMessageQueueOwner, captureCurrentRunMessageQueueOwner } from
  "./current-run-message-queue"
import type { QueuedStreamTranscriptMessage } from "../ipc/stream-transcript-flush"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"
import * as projectionColumns from "../db/function-conversation-projection-receipt"

let directory = ""
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-stream-projection-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(options: { long?: boolean; tool?: boolean; register?: boolean; calls?: boolean;
  additional?: Record<string, unknown>;
  onPhase?: (phase: string) => void } = {}) {
  const threadId = randomUUID(), uuid = randomUUID(), thread = appDb.createThread(threadId,
    { workspacePath: directory })
  const database = appDb.getDb(), store = new FunctionConversationStore(database)
  const controller = new AbortController(), owner = {}, run = {}
  let live = true
  const guard = () => { controller.signal.throwIfAborted(); if (!live) throw Error("ACTUAL_RUN_CLOSED") }
  const incarnation = captureThreadIncarnation(thread)
  const initialRef = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, guard)
  const authorities = new ModRuntimeAuthorities(), registry = new FunctionConversationRegistry(store, authorities)
  const authority = authorities.create({ workspace: directory, threadId, turnId: randomUUID() },
    controller.signal)
  const target = registry.registerMain(owner, { identity: {}, ref: initialRef, checkpointThreadId: threadId,
    signal: controller.signal, authority: authority.authority, assertCurrent: guard })
  const ref = target.ref
  const content = options.long ? "真实完整保护后的正文".repeat(100_000) : "SAFE complete final body"
  const native: BaseMessage = options.tool ? new ToolMessage({ id: uuid, content,
    tool_call_id: "actual-call", name: "ActualTool", status: "error", artifact: { safe: "artifact" } }) :
    new AIMessage({ id: uuid, content, tool_calls: options.calls === false ? [] : [
      { id: "actual-call", name: "ActualTool",
        args: { full: options.long ? "x".repeat(100_000) : "complete" }, type: "tool_call" }],
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
  if (options.additional) native.additional_kwargs = options.additional
  const toolCalls = native instanceof AIMessage ? (() => {
    const calls = native.tool_calls
    if (!Array.isArray(calls)) throw Error("ACTUAL_TOOL_CALLS_MISSING")
    return calls.map(call => {
      if (typeof call.id !== "string" || !call.id) throw Error("ACTUAL_TOOL_CALL_ID_MISSING")
      return { ...call, id: call.id }
    })
  })() : undefined
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
    role: options.tool ? "tool" : "assistant", content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
    ...(native instanceof ToolMessage ? { tool_call_id: native.tool_call_id,
      status: native.status, name: native.name, is_error: false } : {}),
    provider_source_id: "actual-provider", provider_occurrence: 2,
    reasoning: "SAFE thought", content_mode: "snapshot", tool_calls_mode: "snapshot",
    reasoning_mode: "snapshot", content_priority: 1, created_at: new Date(row.createdAt),
    start_at: new Date(10), end_at: new Date(20) }), undefined,
  native instanceof ToolMessage ? native : undefined)
  options.onPhase?.("before-store-commit")
  const row = store.commit(ref, { uuid, inputDigest: uuid,
    door: options.tool ? "tool-result" : "response",
    origin: options.tool ? { kind: "tool", tool: "ActualTool" } : { kind: "model", model: "ActualModel" },
    message: options.tool ? { type: "user", role: "user", content: [{ type: "tool_result",
      tool_use_id: "actual-call", content, is_error: false }] } : { type: "assistant",
      role: "assistant", content: [{ type: "text", text: content }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-response" }, sdk: false, inbox: false }, guard, access.write, access.verify)
  options.onPhase?.("after-store-commit")
  const message = deserializeFunctionConversationNativeMessage(row.nativePayload)
  message.additional_kwargs = { ...message.additional_kwargs,
    function_row: functionConversationCanonicalStamp(ref, row) }
  const runtime: NativeConversationStreamProjectionRuntime = { owner, run, database, target,
    destination: { conversation: ref, threadId, incarnation, assertCurrent: guard },
    signal: controller.signal, assertCurrent: () => { guard(); target.assertCurrent() } }
  const projection = createNativeConversationStreamProjection({ runtime, store })
  if (options.register !== false) projection.register(message, row)
  options.onPhase?.("after-private-register")
  const snapshot = appDb.readCanonicalThreadMessageSnapshot(threadId, uuid)
  if (!snapshot) throw Error("ACTUAL_CANONICAL_SNAPSHOT_MISSING")
  cleanups.push(() => { projection.close(); registry.close(); authority.release(); authorities.close() })
  return { threadId, uuid, row, message, projection, runtime, controller, snapshot, store, ref,
    retire: () => { live = false } }
}

async function history(f: Pick<ReturnType<typeof fixture>, "ref" | "threadId" | "runtime" |
  "controller" | "store" | "message">, messages: BaseMessage[] = [f.message]) {
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.sqlite`))
  cleanups.push(() => saver.close())
  const binding = { target: f.ref, checkpointThreadId: f.threadId,
    checkpointIncarnation: f.runtime.destination.incarnation,
    signal: f.controller.signal, assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }
  const bridge = new FunctionConversationDeliveryBridge(f.store, () => binding)
  const checkpoint: Checkpoint = { v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages, [FUNCTION_CONVERSATION_CHANNEL]: functionConversationState(f.ref) },
    channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
  const config = { configurable: { thread_id: f.threadId, checkpoint_ns: "" } }
  await bridge.wrap(saver).put(config, checkpoint, { source: "loop", step: 1, parents: {} })
  const exact = { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } }
  const capture = () => bridge.bindSaver(saver).captureRecovery(exact, binding)
  const proof = await capture()
  const read = async (): Promise<BaseMessage[]> => {
    const tuple = await saver.getTuple(exact)
    const actual = tuple?.checkpoint.channel_values.messages
    if (!Array.isArray(actual)) throw Error("ACTUAL_CHECKPOINT_MESSAGES_MISSING")
    return actual as BaseMessage[]
  }
  return { proof, saver, messages, capture, read }
}

async function actualMainHistory() {
  const root = mkdtempSync(join(directory, "physical-main-"))
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
  const ref = runtime.target.ref, uuid = randomUUID(), content = "actual historical main response"
  const native = new AIMessage({ id: uuid, content })
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
  const projection = createNativeConversationStreamProjection({ runtime, store })
  cleanups.push(() => {
    action = undefined
    projection.close(); runtime.close(); closeOwner(); coordinator.registry.close()
    unbind(); instance.release(); releaseLocalThreadRunLease(threadId, "desktop", runId)
    manager.close()
  })
  const f = { ref, threadId, runtime, controller, store, message }
  const h = await history(f)
  projection.registerHistorical(h.messages, h.proof)
  return { ...f, h, projection, uuid, checks: () => checks,
    act: (value?: () => void) => { action = value } }
}

function note(f: ReturnType<typeof fixture>, providerOccurrence?: number) {
  const uuid = randomUUID(), content = [{ type: "text" as const, text: "actual pending SDK note" }]
  const native = new HumanMessage({ id: uuid, content, additional_kwargs: { isMeta: true } })
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
    role: "user", content, created_at: new Date(row.createdAt),
    ...(providerOccurrence === undefined ? {} : { provider_source_id: "shared-note-provider",
      provider_occurrence: providerOccurrence }) }))
  return f.store.commit(f.ref, { uuid, inputDigest: uuid, door: "note",
    origin: { kind: "plugin", name: "ActualPlugin" }, message: { type: "user", role: "user",
      isMeta: true, content }, nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { batch: uuid }, sdk: true, inbox: true }, f.runtime.assertCurrent.bind(f.runtime),
  access.write, access.verify)
}
function tuple(data: unknown): [Record<string, unknown>, Record<string, unknown>] {
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") throw Error("ACTUAL_TUPLE_MISSING")
  return data as [Record<string, unknown>, Record<string, unknown>]
}

function actualAliasMap(f: ReturnType<typeof fixture>, uuid: string = f.uuid) {
  appDb.captureFunctionConversationMessageAliasAccess({ threadId: f.threadId,
    incarnation: f.ref.incarnation, uuid, providerSourceId: "actual-provider",
    assertCurrent: () => undefined })
  let aliases: Map<string, { toId: string }> | undefined
  const get = Map.prototype.get
  const lookup = vi.spyOn(Map.prototype, "get").mockImplementation(function(this: Map<unknown, unknown>, key) {
    const value = Reflect.apply(get, this, [key])
    if (key === f.threadId && value instanceof Map) aliases = value
    return value
  })
  try { appDb.getThreadMessageCanonicalId(f.threadId, uuid) }
  finally { lookup.mockRestore() }
  if (!aliases) throw Error("ACTUAL_ALIAS_MAP_MISSING")
  return aliases
}

describe("private native stream projection (real SQLite, foundation scope)", () => {
  it("merges one initial guard only after the actual Main factory classifies the runtime", async () => {
    const f = await actualMainHistory()
    const validate = () => {
      const before = f.checks()
      f.projection.validate("values", { messages: f.h.messages })
      return f.checks() - before
    }
    expect(isFunctionConversationNativeMainRuntime(f.runtime)).toBe(false)
    const original = validate()
    f.runtime.capturePolicy()
    expect(isFunctionConversationNativeMainRuntime(f.runtime)).toBe(true)
    expect(isFunctionConversationNativeMainRuntime({ ...f.runtime })).toBe(false)
    expect(validate()).toBe(original - 1)
    expect(validate()).toBe(original - 1)
    f.controller.abort(Error("ACTUAL_MAIN_REVOKED"))
    expect(() => validate()).toThrow()
  })

  it.each(["own", "prototype", "getter", "store-prototype"] as const)(
    "retains the complete initial guard after a %s Store override", async kind => {
      const f = await actualMainHistory()
      const validate = () => {
        const before = f.checks()
        f.projection.validate("values", { messages: f.h.messages })
        return f.checks() - before
      }
      const original = validate()
      f.runtime.capturePolicy()
      expect(validate()).toBe(original - 1)
      const prototype = FunctionConversationStore.prototype
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "readCheckpointMember")!
      let getterChecks = -1, start = 0
      if (kind === "own") Object.defineProperty(f.store, "readCheckpointMember", {
        ...descriptor, value: descriptor.value })
      if (kind === "prototype") Object.defineProperty(prototype, "readCheckpointMember", {
        ...descriptor, value: function (this: FunctionConversationStore, ...args: unknown[]) {
          return Reflect.apply(descriptor.value, this, args)
        } })
      if (kind === "getter") Object.defineProperty(f.store, "readCheckpointMember", {
        configurable: true, get: () => { getterChecks = f.checks() - start; return descriptor.value } })
      if (kind === "store-prototype") Object.setPrototypeOf(f.store, Object.create(prototype))
      try {
        start = f.checks()
        expect(validate()).toBe(original)
        if (kind === "getter") expect(getterChecks).toBeGreaterThan(0)
      } finally {
        if (kind === "own" || kind === "getter") Reflect.deleteProperty(f.store, "readCheckpointMember")
        if (kind === "prototype") Object.defineProperty(prototype, "readCheckpointMember", descriptor)
        if (kind === "store-prototype") Object.setPrototypeOf(f.store, prototype)
      }
    })

  it.each(["native", "database", "revoke"] as const)(
    "rejects a late %s change and never reuses a failed historical fast read", async kind => {
      const f = await actualMainHistory()
      f.runtime.capturePolicy()
      const before = f.checks()
      f.projection.validate("values", { messages: f.h.messages })
      const total = f.checks() - before
      let calls = 0
      f.act(() => {
        if (++calls !== total) return
        if (kind === "native") f.message.content = "late changed native"
        if (kind === "database") appDb.getDb().run(
          "UPDATE thread_messages SET content_json=? WHERE message_id=?", [JSON.stringify("late changed canonical"), f.uuid])
        if (kind === "revoke") f.controller.abort(Error("LATE_MAIN_REVOKED"))
      })
      expect(() => f.projection.validate("values", { messages: f.h.messages })).toThrow()
      expect(calls).toBe(total)
      f.act()
      expect(() => f.projection.validate("values", { messages: f.h.messages })).toThrow()
    })

  it("latches a caught reentrant Main historical check before publication", async () => {
    const f = await actualMainHistory()
    f.runtime.capturePolicy()
    let attempted = false, checks = 0
    f.act(() => {
      if (++checks !== 2 || attempted) return
      attempted = true
      expect(() => f.projection.validate("values", { messages: f.h.messages })).toThrow()
    })
    expect(() => f.projection.validate("values", { messages: f.h.messages })).toThrow()
    expect(attempted).toBe(true)
    f.act()
    expect(() => f.projection.validate("values", { messages: f.h.messages })).toThrow()
  })

  it("keeps unknown runtimes on the original historical guard path", async () => {
    const f = fixture({ register: false }), h = await history(f)
    f.projection.registerHistorical(h.messages, h.proof)
    const source = vi.spyOn(f.runtime, "assertCurrent")
    f.projection.validate("values", { messages: h.messages })
    const original = source.mock.calls.length
    source.mockClear()
    Object.defineProperty(f.store, "readCheckpointMember", {
      configurable: true, value: FunctionConversationStore.prototype.readCheckpointMember })
    try {
      f.projection.validate("values", { messages: h.messages })
      expect(source.mock.calls.length).toBe(original)
    } finally { Reflect.deleteProperty(f.store, "readCheckpointMember") }
  })

  it("reuses checkpoint SELECT compilation without caching rows or source guards", async () => {
    const f = fixture({ register: false }), h = await history(f), messages = await h.read()
    f.projection.registerHistorical(messages, h.proof)
    f.projection.validate("values", { messages })
    const prepare = vi.spyOn(f.runtime.database, "prepareReadOne")
    const source = vi.spyOn(f.runtime, "assertCurrent")
    for (let index = 0; index < 8; index++) f.projection.validate("values", { messages })
    expect(source.mock.calls.length).toBeGreaterThan(8)
    expect(prepare.mock.calls.filter(([sql]) => /function_conversation_(rows|branches|checkpoint_members|checkpoint_receipts)\b/.test(sql))).toHaveLength(0)
    f.runtime.database.run("UPDATE function_conversation_checkpoint_members SET member_json=? WHERE uuid=?",
      ["{}", f.row.uuid])
    expect(() => f.projection.validate("values", { messages })).toThrow()
  })

  it.each(["provider_source_id", "function_row_json", "content_json"])(
    "rejects a later entry guard changing the earlier canonical %s", async column => {
      const f = fixture()
      note(f)
      const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
        state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
        assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
      if (!intake.publication || intake.notes.length !== 1) throw Error("ACTUAL_INTAKE_REQUIRED")
      f.projection.registerIntake(intake.publication)
      const original = f.runtime.assertCurrent.bind(f.runtime)
      let checks = 0
      f.runtime.assertCurrent = () => {
        original()
        if (++checks === 4) appDb.getDb().run(
          "UPDATE thread_messages SET " + column + "=? WHERE thread_id=? AND message_id=?",
          [column === "content_json" ? JSON.stringify("changed") : "changed", f.threadId, f.uuid])
      }
      expect(() => f.projection.validate("values", { messages: [f.message, ...intake.notes] }))
        .toThrow()
      expect(checks).toBeGreaterThanOrEqual(4)
    })

  it("batches discovery across distinct canonical UUIDs sharing a provider", async () => {
    const f = fixture()
    for (let occurrence = 1; occurrence <= 3; occurrence++) note(f, occurrence)
    const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
      state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
      assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
    if (!intake.publication || intake.notes.length !== 3) throw Error("ACTUAL_INTAKE_REQUIRED")
    f.projection.registerIntake(intake.publication)
    expect(new Set(intake.notes.map(message => message.id)).size).toBe(3)
    const prepare = vi.spyOn(appDb.getDb(), "prepare")
    const scans = () => prepare.mock.calls.filter(([sql]) =>
      /WHERE thread_id = \? AND provider_source_id = \? AND role = \?\s+AND provider_occurrence = \?/.test(sql)).length
    f.projection.validate("values", { messages: [intake.notes[0]] })
    const single = scans()
    prepare.mockClear()
    f.projection.validate("updates", { first: { messages: intake.notes.slice(0, 1) },
      second: { messages: intake.notes.slice(1) } })
    expect(single).toBeGreaterThan(0)
    expect(scans()).toBe(single)
  })

  it("batches provider discovery for repeated native occurrences in one synchronous validation", () => {
    const f = fixture()
    const prepare = vi.spyOn(appDb.getDb(), "prepare")
    const scans = () => prepare.mock.calls.filter(([sql]) =>
      /WHERE thread_id = \? AND provider_source_id = \? AND role = \?\s+AND provider_occurrence = \?/.test(sql)).length
    f.projection.validate("values", { messages: [f.message] })
    const single = scans()
    prepare.mockClear()
    f.projection.validate("values", { messages: [f.message, f.message, f.message] })
    expect(single).toBeGreaterThan(0)
    expect(scans()).toBe(single)
  })

  it("batches serialization discovery without deduplicating repeated source guards", () => {
    const f = fixture(), guard = vi.spyOn(f.runtime, "assertCurrent")
    const prepare = vi.spyOn(appDb.getDb(), "prepare")
    const scans = () => prepare.mock.calls.filter(([sql]) =>
      /WHERE thread_id = \? AND provider_source_id = \? AND role = \?\s+AND provider_occurrence = \?/.test(sql)).length
    serializeNativeConversationStreamData("values", { messages: [f.message] })
    const single = scans(), singleGuards = guard.mock.calls.length
    prepare.mockClear()
    guard.mockClear()
    const serialized = serializeNativeConversationStreamData("values",
      { messages: [f.message, f.message, f.message] }) as { messages: unknown[] }
    expect(serialized.messages).toHaveLength(3)
    expect(single).toBeGreaterThan(0)
    expect(scans()).toBe(single)
    expect(singleGuards).toBeGreaterThan(0)
    expect(guard.mock.calls.length).toBe(singleGuards * 3)
  })

  it.each(["alias", "provider", "marker"])(
    "refuses serialization when a later entry source changes the first entry's %s", async kind => {
      const f = fixture()
      note(f)
      const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
        state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
        assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
      if (!intake.publication || intake.notes.length !== 1) throw Error("ACTUAL_INTAKE_REQUIRED")
      f.projection.registerIntake(intake.publication)
      let aliases: Map<string, { toId: string }> | undefined
      if (kind === "alias") {
        // Observe the actual map through its existing native dispatch, without exposing a
        // production test hook. The later callback mutates only this thread's alias facts.
        aliases = actualAliasMap(f)
      }
      const original = f.runtime.assertCurrent.bind(f.runtime)
      let checks = 0, published = false
      f.runtime.assertCurrent = () => {
        original()
        if (++checks !== 3) return
        if (kind === "alias") aliases!.set(f.uuid, { toId: randomUUID() })
        else appDb.getDb().run(kind === "provider"
          ? "UPDATE thread_messages SET provider_source_id='late-other-provider' WHERE thread_id=? AND message_id=?"
          : "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
        [f.threadId, f.uuid])
      }
      expect(() => {
        serializeNativeConversationStreamData("updates", {
          first: { messages: [f.message] }, second: { messages: intake.notes }
        })
        published = true
      }).toThrow()
      expect(checks).toBeGreaterThanOrEqual(3)
      expect(published).toBe(false)
    })

  it("checks an entry introduced by a payload getter against its own alias discovery", async () => {
    const f = fixture()
    note(f)
    const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
      state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
      assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
    if (!intake.publication || intake.notes.length !== 1) throw Error("ACTUAL_INTAKE_REQUIRED")
    f.projection.registerIntake(intake.publication)
    const introduced = intake.notes[0], aliases = actualAliasMap(f, introduced.id!)
    const messages = [f.message]
    let getterRan = false
    const payload = { messages, get ordinaryMetadata() {
      getterRan = true
      messages[0] = introduced
      aliases.set(introduced.id!, { toId: randomUUID() })
      return "ordinary metadata"
    } }
    expect(() => serializeNativeConversationStreamData("values", payload)).toThrow()
    expect(getterRan).toBe(true)
  })

  it("classifies an exact owned return without replacing the batch's actual full validation", () => {
    const f = fixture(), guard = vi.spyOn(f.runtime, "assertCurrent")
    const source = f.projection.captureReturnMessageSource(f.message)
    if (!source) throw Error("ACTUAL_RETURN_SOURCE_MISSING")
    expect(guard).not.toHaveBeenCalled()
    source.assertDataCurrent()
    expect(guard).not.toHaveBeenCalled()
    f.projection.validate("values", { messages: [f.message] })
    expect(guard).toHaveBeenCalled()
    source.assertDataCurrent()
    expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
  })

  it("does not turn generic ordinary validation or the same ID into a return source", () => {
    const f = fixture(), unknown = new AIMessage({ id: f.uuid, content: "unowned output" })
    expect(() => f.projection.validate("values", { messages: [unknown] })).not.toThrow()
    expect(f.projection.captureReturnMessageSource(unknown)).toBeUndefined()
  })

  it("refuses a foreign owner, a private wire and an unregistered marked return", () => {
    const f = fixture(), other = fixture()
    const wire = projectNativeConversationMessageForStream(f.message)
    if (!wire) throw Error("ACTUAL_RETURN_WIRE_MISSING")
    expect(() => other.projection.captureReturnMessageSource(f.message)).toThrow()
    expect(() => f.projection.captureReturnMessageSource(wire as unknown as BaseMessage)).toThrow()
    const unregistered = deserializeFunctionConversationNativeMessage(f.row.nativePayload)
    unregistered.additional_kwargs = { ...unregistered.additional_kwargs,
      function_row: functionConversationCanonicalStamp(f.ref, f.row) }
    expect(() => f.projection.captureReturnMessageSource(unregistered)).toThrow()
  })

  it("keeps a selected owned return failed after its complete body changes", () => {
    const f = fixture(), source = f.projection.captureReturnMessageSource(f.message)
    if (!source) throw Error("ACTUAL_RETURN_SOURCE_MISSING")
    const original = f.message.content
    f.message.content = "late unprotected output"
    expect(() => source.assertDataCurrent()).toThrow()
    f.message.content = original
    expect(() => source.assertDataCurrent()).toThrow()
    expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
  })
  const setIteratorPrototype = Object.getPrototypeOf(new Set().values()) as object
  const tailCollections: ReadonlyArray<readonly [object, PropertyKey, string]> = [
    [WeakMap.prototype, "get", "private lookup"],
    [WeakMap.prototype, "set", "private wire publication"],
    [Set.prototype, "has", "wire ancestor membership"],
    [Set.prototype, "add", "wire ancestor insertion"],
    [Set.prototype, "delete", "wire ancestor retirement"],
    [Set.prototype, "values", "checked entry traversal"],
    [setIteratorPrototype, "next", "checked entry iterator"]
  ]
  it.each(tailCollections.flatMap(([prototype, key, label]) =>
    (["getter", "replacement"] as const).map(attack => ({ prototype, key, label, attack }))))(
    "keeps $label pure after actual fresh B and a late $attack", ({ prototype, key, attack }) => {
      const f = fixture(), source = projectNativeConversationMessageForStream(f.message)
      if (!source) throw Error("ACTUAL_WIRE_MISSING")
      const copied: unknown = JSON.parse(JSON.stringify(source))
      if (!copied || typeof copied !== "object") throw Error("ACTUAL_WIRE_COPY_MISSING")
      const owned = f.projection.captureOwnedMessage(f.message)
      const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, key)
      if (!originalDescriptor) throw Error("ACTUAL_COLLECTION_METHOD_MISSING")
      const originalScope = appDb.withCanonicalThreadMessageReadScope
      let installed = false, freshReads = 0, calls = 0, error: unknown
      let read: ReturnType<typeof readNativeConversationStreamProjection> | undefined
      const unexpected = () => {
        calls += 1
        appDb.getDb().run("DELETE FROM function_conversation_projection_receipts WHERE uuid=?",
          [f.uuid])
        throw Error("LATE_PROJECTION_COLLECTION_MUST_NOT_RUN")
      }
      const scopedRead = <T>(threadId: string,
        run: (reader: appDb.CanonicalThreadMessageReadScope) => T): T => {
        const result = originalScope(threadId, run)
        if (threadId === f.threadId) {
          freshReads += 1
          if (!installed) {
            installed = true
            Object.defineProperty(prototype, key, attack === "getter"
              ? { configurable: true, get: unexpected }
              : { ...originalDescriptor, value: unexpected })
          }
        }
        return result
      }
      const scopeSpy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope")
        .mockImplementation(scopedRead)
      try {
        if (key === "set") transferNativeConversationStreamProjection(source, copied)
        else if (key === "values" || key === "next")
          f.projection.validate("messages", [source, {}])
        else read = readNativeConversationStreamProjection(source, f.threadId)
        // These are the same original owned message and stored row, checked without a source
        // callback after the genuine reader has finished B. No replacement proof is minted.
        owned.assertDataCurrent()
      } catch (caught) { error = caught }
      finally {
        Object.defineProperty(prototype, key, originalDescriptor)
        scopeSpy.mockRestore()
      }
      expect(error).toBeUndefined()
      expect(installed).toBe(true)
      expect(freshReads).toBeGreaterThan(0)
      expect(calls).toBe(0)
      if (key === "set") expect(readNativeConversationStreamProjection(copied)).toEqual(f.snapshot)
      else if (key !== "values" && key !== "next") expect(read).toEqual(f.snapshot)
      expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
      expect(() => f.projection.assertFinalizedData(f.message)).not.toThrow()
      f.message.content = "genuine late raw mutation"
      expect(() => owned.assertDataCurrent()).toThrow()
      expect(() => f.projection.assertFinalizedData(f.message)).toThrow()
      expect(() => readNativeConversationStreamProjection(source)).toThrow()
    })

  it("serializes a kept message before its actual toJSON and parses the exact original snapshot", () => {
    const f = fixture(), wire = tuple(createStreamDataSerializer()("messages", [f.message, {}]).data)
    expect(readNativeConversationStreamProjection(wire[0], f.threadId)).toEqual(f.snapshot)
    expect(persistedMessageFromStreamPayload(wire)).toEqual({ ...f.snapshot,
      streamContentMode: "snapshot", streamToolCallChunks: [] })
    expect(streamPayloadContentMode(wire)).toBe("snapshot")
    expect(appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot]).canonicalCount).toBe(1)
  })

  it("never executes an injected raw toJSON or getter before rejecting a changed actual reference", () => {
    const f = fixture()
    let calls = 0
    Object.defineProperty(f.message, "toJSON", { get() { calls++; throw Error("RAW_SECRET") } })
    expect(() => createStreamDataSerializer()("messages", [f.message, {}])).toThrow()
    expect(calls).toBe(0)
  })

  it("publishes no native entry when the last registration guard changes the actual projection", () => {
    const f = fixture({ register: false })
    const original = f.runtime.assertCurrent.bind(f.runtime)
    let reachedSeal = false, changed = false
    const validate = projectionColumns.validateFunctionConversationRawProjection
    vi.spyOn(projectionColumns, "validateFunctionConversationRawProjection").mockImplementation(
      (...args) => { const result = validate(...args); reachedSeal = true; return result })
    f.runtime.assertCurrent = () => {
      original()
      if (reachedSeal && !changed) {
        changed = true
        appDb.getDb().run("UPDATE thread_messages SET reasoning='late native guard' WHERE message_id=?",
          [f.uuid])
      }
    }
    expect(() => f.projection.register(f.message, f.row)).toThrow()
    expect(changed).toBe(true)
    expect(projectNativeConversationMessageForStream(f.message)).toBeNull()
  })

  it("rejects a real serializer callback changing canonical storage before any wire publication", () => {
    const f = fixture()
    let calls = 0, reentryDenied = false
    const metadata = { toJSON() {
      calls += 1
      appDb.getDb().run("UPDATE thread_messages SET reasoning='serializer callback' WHERE message_id=?",
        [f.uuid])
      try { appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid) }
      catch { reentryDenied = true }
      return {}
    } }
    expect(() => serializeStreamData("messages", [f.message, metadata])).toThrow()
    expect(calls).toBe(1)
    expect(reentryDenied).toBe(true)
    expect(() => projectNativeConversationMessageForStream(f.message)).toThrow()
  })

  it.each([false, true])("checks native values before raw shape getters (previous frame: %s)", prior => {
    const f = fixture(), serialize = createStreamDataSerializer()
    const user = new HumanMessage({ id: "actual-values-user", content: "user boundary" })
    if (prior) serialize("values", { messages: [user, f.message] })
    let calls = 0
    Object.defineProperty(f.message, "content", {
      get() { calls++; throw Error("RAW_VALUES_GETTER_MUST_NOT_RUN") }
    })
    expect(() => serialize("values", { messages: [user, f.message] })).toThrow()
    expect(calls).toBe(0)
  })

  it.each(["messages", "values", "updates"])("uses private proof at each %s serialization address", mode => {
    const f = fixture(), raw = mode === "messages" ? [f.message, {}] :
      mode === "values" ? { messages: [f.message] } : { model_request: { messages: [f.message] } }
    const wire = serializeStreamData(mode, raw).data
    const value = mode === "messages" ? tuple(wire)[0] :
      mode === "values" ? (wire as { messages: unknown[] }).messages[0] :
        (wire as { model_request: { messages: unknown[] } }).model_request.messages[0]
    expect(readNativeConversationStreamProjection(value)).toEqual(f.snapshot)
  })

  it("keeps long full native payloads and raw already bounded display without reclamping", () => {
    const diagnostic = process.env.CMB_NATIVE_STREAM_PROJECTION_TRACE === "1"
    const start = diagnostic ? process.hrtime.bigint() : 0n
    let prior = start
    const trace = (phase: string) => {
      if (!diagnostic) return
      const now = process.hrtime.bigint()
      process.stdout.write(`${JSON.stringify({ phase, milliseconds: Number(now - prior) / 1e6,
        totalMilliseconds: Number(now - start) / 1e6 })}\n`)
      prior = now
    }
    const f = fixture({ long: true, onPhase: trace })
    expect(Buffer.byteLength(f.row.nativePayload)).toBeGreaterThan(1024 * 1024)
    const wire = tuple(createStreamDataSerializer()("messages", [f.message, {}]).data)
    trace("serialize-private-wire")
    expect((wire[0].kwargs as { content: unknown }).content).toEqual(f.snapshot.content)
    expect(persistedMessageFromStreamPayload(wire)?.tool_calls).toEqual(f.snapshot.tool_calls)
    trace("parse-private-wire")
    expect(readNativeConversationStreamProjection(wire[0])).toEqual(f.snapshot)
    trace("read-private-wire")
  })

  it("preserves execution status while returning the separate public tool error presentation", () => {
    const f = fixture({ tool: true }), wire = tuple(serializeStreamData("messages", [f.message, {}]).data)
    expect(wire[0].kwargs).toMatchObject({ status: "error", is_error: false, tool_call_id: "actual-call" })
    expect(persistedMessageFromStreamPayload(wire)).toMatchObject({ status: "error", is_error: false,
      created_at: f.snapshot.created_at, ordinal: f.snapshot.ordinal })
  })

  it("preserves explicit tool presentation false on ordinary copies without minting canonical ACK", () => {
    const f = fixture({ tool: true })
    const wire = serializeStreamData("messages", [f.message, {}]).data
    const ordinary: unknown = JSON.parse(JSON.stringify(wire))
    const message = tuple(ordinary)[0]
    expect(readNativeConversationStreamProjection(message)).toBeNull()
    expect(persistedMessageFromStreamPayload(ordinary)).toMatchObject({
      status: "error", is_error: false, tool_call_id: "actual-call"
    })
    expect(() => f.projection.validate("messages", ordinary)).toThrow()
  })

  it("allows only an explicit exact known wire transfer and never a JSON clone by itself", () => {
    const f = fixture(), source = projectNativeConversationMessageForStream(f.message)
    if (!source) throw Error("ACTUAL_WIRE_MISSING")
    const copy: unknown = JSON.parse(JSON.stringify(source))
    expect(readNativeConversationStreamProjection(copy)).toBeNull()
    transferNativeConversationStreamProjection(source, copy)
    expect(readNativeConversationStreamProjection(copy)).toEqual(f.snapshot)
    const changed = JSON.parse(JSON.stringify(source)) as { kwargs: { content: string } }
    changed.kwargs.content = "unprotected wrong body"
    expect(() => transferNativeConversationStreamProjection(source, changed)).toThrow()
  })

  it("rejects mutated wire getters without running them", () => {
    const f = fixture(), source = projectNativeConversationMessageForStream(f.message)
    if (!source) throw Error("ACTUAL_WIRE_MISSING")
    let calls = 0
    Object.defineProperty(source, "kwargs", { get() { calls++; return {} } })
    expect(() => readNativeConversationStreamProjection(source)).toThrow()
    expect(calls).toBe(0)
  })

  it.each(["getter", "replacement"] as const)(
    "keeps the finalized data tail pure after a signal method %s override", attack => {
      const f = fixture(), signal = f.runtime.signal
      const original = Object.getOwnPropertyDescriptor(signal, "throwIfAborted")
      const forbidden = vi.fn(() => {
        appDb.getDb().run("DELETE FROM function_conversation_projection_receipts WHERE uuid=?",
          [f.uuid])
        throw Error("LATE_SIGNAL_METHOD")
      })
      try {
        Object.defineProperty(signal, "throwIfAborted", attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, value: forbidden })
        expect(() => f.projection.assertFinalizedData(f.message)).not.toThrow()
        expect(forbidden).not.toHaveBeenCalled()
        expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
        f.controller.abort(Error("ACTUAL_FINALIZED_CANCEL"))
        expect(() => f.projection.assertFinalizedData(f.message)).toThrow("ACTUAL_FINALIZED_CANCEL")
        expect(forbidden).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(signal, "throwIfAborted", original)
        else Reflect.deleteProperty(signal, "throwIfAborted")
      }
    }
  )

  it.each((["signal-method", "array-iterator", "signal-field", "prepared-previous"] as const)
    .flatMap(kind => (["getter", "replacement"] as const).map(attack => ({ kind, attack }))))(
    "keeps the actual post-B entry adoption pure after $kind $attack", ({ kind, attack }) => {
      const f = fixture({ register: false }), signal = f.runtime.signal
      const receiver = kind === "array-iterator" ? Array.prototype :
        kind === "signal-field" ? f.runtime :
          kind === "prepared-previous" ? Object.prototype : signal
      const key = kind === "array-iterator" ? Symbol.iterator :
        kind === "signal-field" ? "signal" :
          kind === "prepared-previous" ? "previous" : "throwIfAborted"
      const originalField = Object.getOwnPropertyDescriptor(receiver, key)
      const originalScope = appDb.withCanonicalThreadMessageReadScope
      let installed = false, calls = 0, failed = false, failure: unknown
      const forbidden = () => {
        calls++
        appDb.getDb().run("DELETE FROM function_conversation_projection_receipts WHERE uuid=?", [f.uuid])
        throw Error("LATE_ADOPTION_CALLBACK")
      }
      const actualRead = <T>(threadId: string,
        read: (scope: appDb.CanonicalThreadMessageReadScope) => T): T => {
        const result = originalScope(threadId, read)
        if (threadId === f.threadId && !installed) {
          installed = true
          Object.defineProperty(receiver, key, attack === "getter"
            ? { configurable: true, get: forbidden }
            : { configurable: true, value: forbidden })
        }
        return result
      }
      const scopeSpy = vi.spyOn(appDb, "withCanonicalThreadMessageReadScope")
        .mockImplementation(actualRead)
      try { f.projection.register(f.message, f.row) }
      catch (error) { failed = true; failure = error }
      finally {
        if (originalField) Object.defineProperty(receiver, key, originalField)
        else Reflect.deleteProperty(receiver, key)
        scopeSpy.mockRestore()
      }
      expect(installed).toBe(true)
      expect(calls).toBe(0)
      expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
      expect(f.store.readReceipt(f.ref, f.uuid)).toEqual(f.row)
      if (kind === "signal-field") {
        expect(failed).toBe(true)
        expect(failure).toBeDefined()
        expect(projectNativeConversationMessageForStream(f.message)).toBeNull()
      } else {
        expect(failed).toBe(false)
        expect(failure).toBeUndefined()
        expect(() => f.projection.assertFinalizedData(f.message)).not.toThrow()
        const wire = projectNativeConversationMessageForStream(f.message)
        expect(readNativeConversationStreamProjection(wire)).toEqual(f.snapshot)
        f.message.content = "actual original data changed after adoption"
        expect(() => f.projection.assertFinalizedData(f.message)).toThrow()
      }
    })

  it("rejects a wire body changed synchronously by the final original source guard", () => {
    const f = fixture(), wire = tuple(serializeStreamData("messages", [f.message, {}]).data)[0]
    const original = f.runtime.assertCurrent.bind(f.runtime)
    let calls = 0
    f.runtime.assertCurrent = () => {
      original()
      if (++calls === 2) {
        const kwargs = wire.kwargs
        if (!kwargs || typeof kwargs !== "object") throw Error("ACTUAL_WIRE_KWARGS_MISSING")
        Reflect.set(kwargs, "content", "late original source callback")
      }
    }
    expect(() => readNativeConversationStreamProjection(wire)).toThrow()
    expect(calls).toBe(2)
  })

  it("does not publish a transfer changed synchronously by the final original source guard", () => {
    const f = fixture(), wire = projectNativeConversationMessageForStream(f.message)
    if (!wire) throw Error("ACTUAL_WIRE_MISSING")
    const copy: unknown = JSON.parse(JSON.stringify(wire))
    if (!copy || typeof copy !== "object") throw Error("ACTUAL_WIRE_COPY_MISSING")
    const original = f.runtime.assertCurrent.bind(f.runtime)
    let calls = 0
    f.runtime.assertCurrent = () => {
      original()
      if (++calls === 2) {
        const kwargs: unknown = Reflect.get(copy, "kwargs")
        if (!kwargs || typeof kwargs !== "object") throw Error("ACTUAL_WIRE_KWARGS_MISSING")
        Reflect.set(kwargs, "content", "late transfer callback")
      }
    }
    expect(() => transferNativeConversationStreamProjection(wire, copy)).toThrow()
    expect(calls).toBe(2)
    expect(readNativeConversationStreamProjection(copy)).toBeNull()
  })

  it.each(["content", "source", "signal", "close", "database"])("rechecks %s after serialization", field => {
    const f = fixture(), wire = tuple(serializeStreamData("messages", [f.message, {}]).data)
    if (field === "content") f.message.content = "raw mutation"
    else if (field === "source") f.retire()
    else if (field === "signal") f.controller.abort(Error("ACTUAL_CANCEL"))
    else if (field === "close") f.projection.close()
    else appDb.getDb().run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("raw changed column"), f.threadId, f.uuid])
    expect(() => persistedMessageFromStreamPayload(wire)).toThrow()
  })

  it("rejects cross-thread and cross-run use of a private receipt", () => {
    const f = fixture(), other = fixture(), wire = tuple(serializeStreamData("messages", [f.message, {}]).data)
    expect(() => readNativeConversationStreamProjection(wire[0], other.threadId)).toThrow()
    expect(() => other.projection.validate("values", { messages: [f.message] })).toThrow()
  })

  it("rejects a raw change made synchronously by the final physical guard", () => {
    const f = fixture(), wire = tuple(serializeStreamData("messages", [f.message, {}]).data)
    const actualGuard = f.runtime.assertCurrent.bind(f.runtime)
    let checks = 0
    f.runtime.assertCurrent = () => {
      actualGuard()
      if (++checks === 2) f.message.content = "changed inside final actual guard"
    }
    expect(() => readNativeConversationStreamProjection(wire[0])).toThrow()
    expect(checks).toBe(2)
  })

  it("requires private historical provenance even for an exact stored marked native echo", () => {
    const f = fixture({ register: false })
    expect(() => f.projection.validate("values", { messages: [f.message] })).toThrow()
    expect(projectNativeConversationMessageForStream(f.message)).toBeNull()
    expect(readNativeConversationStreamProjection(f.message)).toBeNull()
    f.message.content = "wrong historical body"
    expect(() => f.projection.validate("values", { messages: [f.message] })).toThrow()
  })

  it("registers only actual saved checkpoint membership including the complete unmarked history digest", async () => {
    const f = fixture({ register: false }), unmarked = new HumanMessage("old ID-less native user")
    const h = await history(f, [unmarked, f.message])
    f.projection.registerHistorical(h.messages, h.proof)
    expect(() => f.projection.validate("values", { messages: h.messages })).not.toThrow()
    expect(projectNativeConversationMessageForStream(unmarked)).toBeNull()
    const wire = tuple(serializeStreamData("messages", [f.message, {}]).data)
    expect(readNativeConversationStreamProjection(wire[0])).toEqual(f.snapshot)
    await h.saver.close()
    expect(() => readNativeConversationStreamProjection(wire[0])).toThrow()
  })

  it("rejects copied checkpoint proof and a future pending row outside the actual checkpoint", async () => {
    const f = fixture({ register: false }), h = await history(f), future = note(f)
    expect(() => f.projection.registerHistorical(h.messages, { ...h.proof })).toThrow()
    const futureNative = deserializeFunctionConversationNativeMessage(future.nativePayload)
    futureNative.additional_kwargs = { ...futureNative.additional_kwargs,
      function_row: functionConversationCanonicalStamp(f.ref, future) }
    expect(() => f.projection.registerHistorical([futureNative], h.proof)).toThrow()
    expect(projectNativeConversationMessageForStream(f.message)).toBeNull()
    expect(projectNativeConversationMessageForStream(futureNative)).toBeNull()
  })

  it("rebinds the actual sameSaver cached object after a closed owner without reviving old wire", async () => {
    const f = fixture({ register: false }), h = await history(f), first = await h.read()
    f.projection.registerHistorical(first, h.proof)
    const oldWire = projectNativeConversationMessageForStream(first[0])
    if (!oldWire) throw Error("ACTUAL_OLD_WIRE_MISSING")
    f.projection.close()
    const next = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    cleanups.push(() => next.close())
    const repeated = await h.read(), proof = await h.capture()
    expect(repeated[0] === first[0]).toBe(true)
    next.registerHistorical(repeated, proof)
    expect(() => readNativeConversationStreamProjection(oldWire)).toThrow()
    const newWire = projectNativeConversationMessageForStream(repeated[0])
    expect(readNativeConversationStreamProjection(newWire)).toEqual(f.snapshot)
  })

  it("keeps same-owner repeated membership idempotent but refuses an active foreign owner", async () => {
    const f = fixture({ register: false }), h = await history(f), messages = await h.read()
    f.projection.registerHistorical(messages, h.proof)
    const wire = projectNativeConversationMessageForStream(messages[0])
    const proof = await h.capture()
    expect(() => f.projection.registerHistorical(messages, proof)).not.toThrow()
    expect(readNativeConversationStreamProjection(wire)).toEqual(f.snapshot)
    const other = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    cleanups.push(() => other.close())
    expect(() => other.registerHistorical(messages, proof)).toThrow()
    expect(() => f.projection.register(messages[0], f.row)).toThrow()
    expect(readNativeConversationStreamProjection(wire)).toEqual(f.snapshot)
  })

  it("does not overwrite a synchronous competing historical admission during the final source guard", async () => {
    const f = fixture({ register: false }), h = await history(f), messages = await h.read()
    const other = createNativeConversationStreamProjection({ runtime: f.runtime, store: f.store })
    cleanups.push(() => other.close())
    const guard = f.runtime.assertCurrent.bind(f.runtime)
    const validate = projectionColumns.validateFunctionConversationRawProjection
    let reachedSeal = false, completedNested = false
    vi.spyOn(projectionColumns, "validateFunctionConversationRawProjection").mockImplementation((row, thread, uuid) => {
      const result = validate(row, thread, uuid)
      reachedSeal = true
      return result
    })
    f.runtime.assertCurrent = () => {
      guard()
      if (!reachedSeal || completedNested) return
      completedNested = true
      other.registerHistorical(messages, h.proof)
    }
    expect(() => f.projection.registerHistorical(messages, h.proof)).toThrow()
    expect(completedNested).toBe(true)
    expect(() => other.validate("values", { messages })).not.toThrow()
    expect(() => f.projection.validate("values", { messages })).toThrow()
  })

  it("rejects changed unmarked history even when all marked rows and visible text match", async () => {
    const f = fixture({ register: false }), unmarked = new HumanMessage({ id: "prior-user",
      content: "same visible user", additional_kwargs: { actual: "metadata" } })
    const h = await history(f, [unmarked, f.message])
    unmarked.additional_kwargs = { actual: "changed metadata" }
    expect(() => f.projection.registerHistorical(h.messages, h.proof)).toThrow()
    expect(projectNativeConversationMessageForStream(f.message)).toBeNull()
  })

  it("admits new SDK notes only from the actual private intake publication", async () => {
    const f = fixture(), saved = note(f)
    const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
      state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
      assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
    if (!intake.publication || intake.notes.length !== 1) throw Error("ACTUAL_INTAKE_REQUIRED")
    const publication = intake.publication
    expect(() => f.projection.registerIntake(Object.assign({}, publication))).toThrow()
    f.projection.registerIntake(publication)
    const wire = tuple(serializeStreamData("messages", [intake.notes[0], {}]).data)
    expect(readNativeConversationStreamProjection(wire[0])).toMatchObject({ id: saved.uuid,
      function_row: functionConversationCanonicalStamp(f.ref, saved) })
    f.controller.abort(Error("ACTUAL_INTAKE_CLOSED"))
    expect(() => readNativeConversationStreamProjection(wire[0])).toThrow()
  })

  it("publishes no part of an intake batch if its last native guard changes the first row", async () => {
    const f = fixture(), first = note(f)
    note(f)
    const intake = await prepareFunctionConversationIntake({ store: f.store, target: f.ref,
      state: functionConversationState(f.ref), signal: f.controller.signal, publish: true,
      assertCurrent: f.runtime.assertCurrent.bind(f.runtime) }, [])
    if (!intake.publication || intake.notes.length !== 2) throw Error("ACTUAL_BATCH_REQUIRED")
    const publication = intake.publication
    const original = f.runtime.assertCurrent.bind(f.runtime)
    const validate = projectionColumns.validateFunctionConversationRawProjection
    const sealed = new Set<string>()
    let changed = false
    vi.spyOn(projectionColumns, "validateFunctionConversationRawProjection").mockImplementation(
      (...args) => { const result = validate(...args); sealed.add(args[2]); return result })
    f.runtime.assertCurrent = () => {
      original()
      if (sealed.size === 2 && !changed) {
        changed = true
        appDb.getDb().run("UPDATE thread_messages SET reasoning='late batch guard' WHERE message_id=?",
          [first.uuid])
      }
    }
    expect(() => f.projection.registerIntake(publication)).toThrow()
    expect(changed).toBe(true)
    for (const message of intake.notes) expect(projectNativeConversationMessageForStream(message)).toBeNull()
  })

  it("keeps canonical IDs/provider tuples through full, append and tail value selection", () => {
    const f = fixture({ calls: false }), serialize = createStreamDataSerializer()
    const accumulator = createSerializedValuesMessageAccumulator()
    const user = new HumanMessage({ id: randomUUID(), content: "actual user boundary" })
    let frame = 0
    for (const messages of [[user, f.message], [user, f.message],
      [user, f.message, new AIMessage({ id: "ordinary-next", content: "ordinary suffix" })]]) {
      const serialized = serialize("values", { messages })
      expect(serialized.valuesSnapshotKind).toBe(["full", "tail", "append"][frame])
      const complete = accumulator.update(serialized)
      const selected = selectStreamTranscriptValueSnapshots(serialized.data, serialized.valuesSnapshotKind,
        { completeMessages: complete.messages, loadBaselineMessages: () => [] })
      expect(selected.filter(selectedTuple => readNativeConversationStreamProjection(selectedTuple[0]))
        .length).toBe(frame++ < 2 ? 1 : 0)
      for (const selectedTuple of selected) {
        const snapshot = readNativeConversationStreamProjection(selectedTuple[0])
        if (!snapshot) continue
        expect(persistedMessageFromStreamPayload(selectedTuple)).toMatchObject({ id: f.uuid,
          provider_source_id: "actual-provider", provider_occurrence: 2,
          created_at: f.snapshot.created_at, function_row: f.snapshot.function_row })
      }
    }
  })

  it("keeps ordinary serialization and transcript parsing available", () => {
    const message = new AIMessage({ id: "ordinary", content: "ordinary body" })
    const wire = tuple(serializeStreamData("messages", [message, {}]).data)
    expect(readNativeConversationStreamProjection(wire[0])).toBeNull()
    expect(persistedMessageFromStreamPayload(wire)).toMatchObject({ id: "ordinary", content: "ordinary body" })
  })

  it("Standard consumer certifies original canonical rows without writing converter summaries", async () => {
    const f = fixture(), upsert = vi.spyOn(appDb, "upsertThreadMessages")
    const consumer = new StandardTurnStreamConsumer(f.threadId)
    await consumer.consume((async function* () {
      yield ["values", { messages: [new HumanMessage({ id: "user", content: "actual user" }), f.message] }]
    })())
    expect(upsert).not.toHaveBeenCalled()
    expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toEqual(f.snapshot)
    expect(consumer.getToolNames()).toEqual([])
  })

  it("actual IPC early branch consumes the private canonical snapshot before old route/queue/hydration", () => {
    const f = fixture(), runToken = randomUUID()
    setCurrentRunMessageQueueOwner(f.threadId, runToken)
    cleanups.push(() => clearCurrentRunMessageQueue(f.threadId))
    const source = ts.createSourceFile("agent.ts", readFileSync(resolve("src/main/ipc/agent.ts"), "utf8"),
      ts.ScriptTarget.Latest, true)
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) &&
      node.name?.text === "persistStreamTranscriptChunk")
    if (!declaration) throw Error("ACTUAL_IPC_SOURCE_MISSING")
    const code = ts.transpileModule(`${declaration.getText(source)}\npersistStreamTranscriptChunk`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const route = vi.fn(() => { throw Error("OLD_COMPLETED_ROUTE_MUST_NOT_RUN") })
    const queue = vi.fn((_thread: string, _token: string, _message: QueuedStreamTranscriptMessage) => {
      void _thread
      void _token
      void _message
      throw Error("OLD_QUEUE_MUST_NOT_RUN")
    })
    const call: (thread: string, token: string, mode: string, payload: unknown) => string | null =
      runInNewContext(code, { exports: {}, isCurrentRunMessageQueueOwner,
        shouldSkipMainTranscriptStreamPayload: () => false, readNativeConversationStreamProjection,
        captureCurrentRunMessageQueueOwner,
        partitionCanonicalThreadMessageEchoes: appDb.partitionCanonicalThreadMessageEchoes,
        persistedMessageFromStreamPayload, routeCurrentRunCompletedAssistantMessage: route,
        queueStreamTranscriptMessage: queue,
        hydrateStreamTranscriptToolCalls: () => { throw Error("OLD_HYDRATE_MUST_NOT_RUN") } })
    const wire = serializeStreamData("messages", [f.message, {}]).data
    expect(call(f.threadId, runToken, "messages", wire)).toBe(f.uuid)
    expect(route).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
  })
})


describe("direct canonical message serialization", () => {
  it.each([false, true])("preserves canonical tool layout=%s while removing intermediate source checks", tool => {
    const f = fixture({ tool }), original = f.runtime.assertCurrent.bind(f.runtime)
    let calls = 0
    f.runtime.assertCurrent = () => { calls++; original() }
    const messages = [new HumanMessage("current"), f.message]
    const lookup = vi.spyOn(projectionModule, "privateNativeConversationStreamLayout")
      .mockReturnValue(undefined)
    let expected: ReturnType<ReturnType<typeof createStreamDataSerializer>>
    try { expected = createStreamDataSerializer()("values", { messages }) }
    finally { lookup.mockRestore() }
    const previousCalls = calls
    calls = 0
    const actual = createStreamDataSerializer()("values", { messages })
    expect(actual).toEqual(expected)
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThan(previousCalls)
  })

  it.each([
    {}, { reasoning: "alias one" }, { reasoning_content: "alias two" },
    { reasoning_text: "alias three" }, { reasoning: null, reasoning_content: "fallback" },
    { reasoning: { text: "non-string" } }, { reasoning_text: null }
  ])("matches the complete wire layout for aliases %j", additional => {
    const f = fixture({ calls: false, additional })
    const user = new HumanMessage("current"), suffix = new AIMessage("ordinary suffix")
    const frames = [
      [user], [user, f.message], [user, f.message],
      [user, f.message, suffix], [user, f.message, new AIMessage("changed suffix")],
      [user, f.message, new HumanMessage("next turn"), new AIMessage("new answer")]
    ]
    const legacy = createStreamDataSerializer()
    const lookup = vi.spyOn(projectionModule, "privateNativeConversationStreamLayout")
      .mockReturnValue(undefined)
    let expected: ReturnType<typeof legacy>[]
    try { expected = frames.map(messages => legacy("values", { messages })) }
    finally { lookup.mockRestore() }
    const optimized = createStreamDataSerializer()
    const actual = frames.map(messages => optimized("values", { messages }))
    expect(actual).toEqual(expected)
    expect(actual[1].valuesSnapshotKind).toBe("append")
    expect(actual[1].valuesMessageIndexOffset).toBe(1)
    const layout = projectionModule.privateNativeConversationStreamLayout(f.message)
    expect(Object.isFrozen(layout)).toBe(true)
    expect(Object.isFrozen(layout?.kwargs)).toBe(true)
    expect(isPrivateNativeConversationStreamMessage(layout)).toBe(false)
    expect(projectionModule.privateNativeConversationStreamLayout({ ...f.message })).toBeUndefined()
    expect(projectionModule.privateNativeConversationStreamLayout(new Proxy(f.message, {}))).toBeUndefined()
  })

  it.each(["cancel", "revoke", "database", "native"] as const)(
    "rejects late %s after cached values layout selection", change => {
      const f = fixture({ calls: false }), serialize = createStreamDataSerializer()
      const user = new HumanMessage("current"), messages = [user, f.message]
      serialize("values", { messages })
      const extra = { toJSON() {
        if (change === "cancel") f.controller.abort(Error("ACTUAL_CANCEL"))
        else if (change === "revoke") f.retire()
        else if (change === "database") appDb.getDb().run(
          "UPDATE thread_messages SET reasoning='late layout' WHERE message_id=?", [f.uuid])
        else f.message.content = "late layout changed native"
        return 1
      } }
      expect(() => serialize("values", { messages, extra })).toThrow()
    })

  it("does not advance the values baseline when a final callback rejects publication", () => {
    const f = fixture({ calls: false }), serialize = createStreamDataSerializer()
    const user = new HumanMessage("current")
    serialize("values", { messages: [user] })
    expect(() => serialize("values", { messages: [user, f.message],
      extra: { toJSON() { throw Error("FINAL_PUBLICATION_FAILED") } } })).toThrow("FINAL_PUBLICATION_FAILED")
    const retry = serialize("values", { messages: [user, f.message] })
    expect(retry.valuesSnapshotKind).toBe("append")
    expect(retry.valuesMessageIndexOffset).toBe(1)
    expect((retry.data as { messages: unknown[] }).messages).toHaveLength(1)
  })

  it.each([false, true])("matches the intermediate-wire path for native tool=%s with fewer full source checks", tool => {
    const f = fixture({ tool }), original = f.runtime.assertCurrent.bind(f.runtime)
    let calls = 0
    f.runtime.assertCurrent = () => { calls++; original() }
    const metadata = { langgraph_node: "actual", cmb_stream_message_content_mode: "delta",
      cmb_stream_message_reasoning_mode: "delta", cmb_stream_message_tool_calls_mode: "delta" }
    const intermediate = projectNativeConversationMessageForStream(f.message)
    const expected = serializeNativeConversationStreamData("messages", [intermediate, metadata])
    const intermediateCalls = calls
    calls = 0
    const actual = createStreamDataSerializer()("messages", [f.message, metadata]).data
    const directCalls = calls
    expect(actual).toEqual(expected)
    expect(directCalls).toBeGreaterThan(0)
    expect(directCalls).toBeLessThan(intermediateCalls)
    const wire = tuple(actual)
    expect(wire[1]).toMatchObject({ cmb_stream_message_content_mode: "snapshot",
      cmb_stream_message_reasoning_mode: "snapshot", cmb_stream_message_tool_calls_mode: "snapshot" })
    expect(wire[0].kwargs).not.toHaveProperty("tool_call_chunks")
    expect(persistedMessageFromStreamPayload(wire)?.tool_calls).toEqual(f.snapshot.tool_calls)
    expect(readNativeConversationStreamProjection(wire[0])).toEqual(f.snapshot)
  })

  it("classifies only private identities and never grants a clone or public stamp publication proof", () => {
    const f = fixture(), clone = deserializeFunctionConversationNativeMessage(f.row.nativePayload)
    clone.additional_kwargs = { ...clone.additional_kwargs, function_row: f.message.additional_kwargs.function_row }
    const guard = vi.spyOn(f.runtime, "assertCurrent")
    expect(isPrivateNativeConversationStreamMessage(f.message)).toBe(true)
    expect(privateNativeConversationStreamMessageRole(f.message)).toBe("assistant")
    expect(privateNativeConversationStreamMessageRole(clone)).toBeUndefined()
    expect(privateNativeConversationStreamMessageRole({ ...f.message })).toBeUndefined()
    expect(isPrivateNativeConversationStreamMessage(clone)).toBe(false)
    expect(isPrivateNativeConversationStreamMessage({ ...f.message })).toBe(false)
    expect(isPrivateNativeConversationStreamMessage(new Proxy(f.message, {}))).toBe(false)
    expect(guard).not.toHaveBeenCalled()
    expect(() => f.projection.validate("messages", [clone, {}])).toThrow()
    const wire = tuple(createStreamDataSerializer()("messages", [f.message, {}]).data)
    expect(isPrivateNativeConversationStreamMessage(wire[0])).toBe(true)
    const copy = JSON.parse(JSON.stringify(wire[0]))
    expect(isPrivateNativeConversationStreamMessage(copy)).toBe(false)
    expect(readNativeConversationStreamProjection(copy)).toBeNull()
  })

  it.each(["cancel", "revoke", "database", "native"] as const)(
    "rejects %s changed by the final message serialization callback", change => {
      const f = fixture()
      let callbacks = 0
      const metadata = { toJSON() {
        callbacks++
        if (change === "cancel") f.controller.abort(Error("ACTUAL_CANCEL"))
        else if (change === "revoke") f.retire()
        else if (change === "database") appDb.getDb().run(
          "UPDATE thread_messages SET reasoning='late direct callback' WHERE message_id=?", [f.uuid])
        else f.message.content = "late changed native"
        return {}
      } }
      expect(() => createStreamDataSerializer()("messages", [f.message, metadata])).toThrow()
      expect(callbacks).toBe(1)
    })

  it("rejects a canonical raw getter before ordinary message projection can invoke it", () => {
    const f = fixture(), getter = vi.fn(() => { throw Error("RAW_CANONICAL_GETTER") })
    Object.defineProperty(f.message, "content", { configurable: true, get: getter })
    expect(() => createStreamDataSerializer()("messages", [f.message, {}])).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
})


it("retains current-turn originals and rejects a late values layout getter changing their native data", () => {
  const f = fixture(), serialize = createStreamDataSerializer()
  const older = new HumanMessage("older"), current = new HumanMessage("current")
  const messages = [older, new AIMessage("old answer"), current, f.message]
  const first = serialize("values", { messages })
  expect(first.valuesMessageIndexOffset).toBe(2)
  const output = first.data as { messages: unknown[] }
  expect(output.messages).toHaveLength(2)
  expect(readNativeConversationStreamProjection(output.messages[1])).toEqual(f.snapshot)
  let callbacks = 0
  const changed = { messages, get extra() { callbacks++; f.message.content = "changed during layout"; return 1 } }
  expect(() => serialize("values", changed)).toThrow()
  expect(callbacks).toBeGreaterThan(0)
})
