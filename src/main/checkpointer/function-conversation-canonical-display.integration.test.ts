import { HumanMessage, AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointTuple } from "@langchain/langgraph-checkpoint"
import { Send, messagesStateReducer } from "@langchain/langgraph"
import { createPatchToolCallsMiddleware } from "deepagents"
import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { build, type Metafile } from "esbuild"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, getLocalThreadRunLease,
  releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore, type FunctionConversationRow } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationRawProjection,
  readFunctionConversationProjectionReceipt } from "../db/function-conversation-projection-receipt"
import { captureFunctionConversationNativeInput } from "../agent/function-conversation-native-input"
import { FunctionNativeMessageProtector, type FunctionProtectedNativeMessage } from "../agent/native-message-protector"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { captureNativeMessage } from "../agent/native-message-capture"
import { FunctionConversationNativeKeeper } from "../agent/function-conversation-native-keeper"
import { createFunctionConversationNativeAdoption } from "../agent/function-conversation-native-adoption"
import type { FunctionSessionAppendOrigin } from "../../shared/mods/v2/session-append"
import { captureFunctionConversationNativeInputPresentation,
  functionConversationNativeHumanProjection,
  registerFunctionConversationNativeHumanProtection } from
  "../agent/function-conversation-native-human-presentation"
import { SqlJsSaver } from "./sqljs-saver"
import { readOrdinaryToolDisplayCoverage } from "./function-conversation-ordinary-display"
import { FunctionConversationDeliveryBridge, FUNCTION_CONVERSATION_CHANNEL } from
  "./function-conversation-delivery"
import { prepareFunctionConversationCanonicalDisplay, withFunctionConversationCanonicalDisplay,
  verifyCanonicalThreadDisplayWitnesses, verifyCanonicalCheckpointWorkerDisplay,
  selectFunctionConversationCanonicalExportMessages,
  readFunctionConversationCanonicalThreadMessages } from
  "./function-conversation-canonical-display"
import { functionConversationCanonicalStamp } from "./function-conversation-checkpoint-membership"
import { CheckpointRuntimeProjectionClient } from "./runtime-projection-client"
import { ThreadMessageHydrationClient } from "../thread-message-hydration/client"
import { canonicalDisplayColumnsDigest, canonicalDisplayValueDigest,
  copyCanonicalCheckpointDisplayJson, canonicalCheckpointDisplayMembershipFingerprint } from
  "./function-conversation-canonical-display-worker"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
let runtimeWorkerPath = "", pageWorkerPath = ""
const workerBuilds = new Map<string, Metafile>()
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-canonical-human-display-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
  runtimeWorkerPath = join(directory, "runtime-worker.cjs")
  pageWorkerPath = join(directory, "page-worker.cjs")
  for (const [entry, outfile] of [["./runtime-projection-worker.ts", runtimeWorkerPath],
    ["../thread-message-hydration/thread-message-hydration-worker.ts", pageWorkerPath]]) {
    const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], outfile,
      bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true })
    workerBuilds.set(entry, result.metafile)
  }
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Real AppDB/physical lease/Manager policy; no public stamp or JSON mints the source. */
async function fixture(options: { enhanced?: boolean; protected?: boolean; fresh?: boolean;
  large?: boolean; plugin?: boolean; integrity?: "verified" | "unverified";
  intent?: "blank" | "plumbing" } = {}) {
  const root = realpathSync(mkdtempSync(join(directory, "workspace-")))
  const workspace = process.platform === "win32" ? root.toLowerCase() : root
  const threadId = randomUUID(), physicalRunId = randomUUID(), uuid = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_HUMAN_LEASE_REQUIRED")
  let onGuard: (() => void) | undefined
  const guard = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_HUMAN_SOURCE_RETIRED")
    onGuard?.()
  }
  cleanups.push(() => {
    onGuard = undefined
    const current = getLocalThreadRunLease(threadId)
    if (current) releaseLocalThreadRunLease(threadId, current.owner, current.runId)
    rmSync(root, { recursive: true, force: true })
  })
  const original = options.large ? "safe long body ".repeat(90_000) : "original sk-abcdefghijklmnopqrstuv"
  const visible = "visible sk-abcdefghijklmnopqrstuv"
  const message = new HumanMessage({ id: uuid,
    content: options.enhanced ? `${visible}\nprivate engine context` : original,
    additional_kwargs: options.enhanced ? { cmb_coordinator_augmented_user_message: true,
      cmb_visible_user_message: visible } : { actualInput: true } })
  const origin: FunctionSessionAppendOrigin = options.plugin
    ? { kind: "plugin", name: "ActualOriginalPlugin" } : { kind: "composer" }
  const transcript = { id: uuid, role: "user" as const,
    content: options.intent === "blank" ? "" : "plumbing", created_at: new Date(100),
    start_at: new Date(90), end_at: new Date(110), goal_id: "original-goal",
    active_window_id: "original-window", content_priority: 2,
    recovery_integrity: "verified" as const }
  const source = captureFunctionConversationNativeInput({ message, threadId, physicalRunId,
    workspace, signal: controller.signal, origin, assertCurrent: guard,
    ...(options.intent ? { transcript: { write: transcript, disposition: options.intent } } : {}),
    ...(options.enhanced ? { visible } : {}) })
  const manager = new ModsManager(join(root, "mods.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(workspace, false, options.protected ?? true)
  const binding: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
    signal: controller.signal, assertLive: guard }
  const authority = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: authority.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId) throw Error("WRONG_SCOPE")
    },
    readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    },
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(authority.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(authority.authority)
  if (!runtime) throw Error("ACTUAL_HUMAN_RUNTIME_REQUIRED")
  const policy = runtime.capturePolicy(), protector = new FunctionNativeMessageProtector()
  cleanups.push(() => {
    onGuard = undefined
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); authority.release()
    manager.close()
  })
  cleanups.push(async () => { onGuard = undefined; protector.close(); await protector.whenDrained() })
  const producer = {}, occurrence = {}
  const input = { source, runtime, policy, producer, occurrence, protector }
  const presentation = captureFunctionConversationNativeInputPresentation(input)
  const current = () => { functionConversationNativeHumanProjection(presentation) }
  const protect = async (native: BaseMessage = message, actualProducer = producer,
    actualPolicy = policy.value): Promise<FunctionProtectedNativeMessage> => {
    const capture = protector.capture({ message: native, producer: actualProducer,
      policy: actualPolicy, signal: controller.signal, assertCurrent: current,
      retainActualWork: () => () => undefined,
      assertExecutionFacts: (raw, safe) => {
        expect(captureNativeMessage(safe).data.id).toBe(captureNativeMessage(raw).data.id)
      }, inheritPresentation: () => undefined })
    return protector.protect(capture)
  }
  // Unit candidate metadata only. Keeper tests below obtain the row from actual Store COMMIT.
  const row = (native: BaseMessage): FunctionConversationRow => {
    const payload = serializeFunctionConversationNativeMessage(native)
    return { uuid, sequence: 1, receiptId: randomUUID(), branchId: runtime.target.ref.branchId,
      inputDigest: uuid, door: "prompt", origin, message: { type: "user", role: "user",
        content: [{ type: "text", text: "protected public note" }] }, nativePayload: payload,
      orderAnchor: { kind: "native-input" }, createdAt: 123, inbox: false, bytes: payload.length }
  }
  if (!options.fresh) appDb.upsertThreadMessages(threadId, [{ id: uuid, role: "user",
    content: options.enhanced ? visible : original, created_at: new Date(100),
    start_at: new Date(90), end_at: new Date(110), goal_id: "original-goal",
    active_window_id: "original-window", content_priority: 2,
    recovery_integrity: options.integrity ?? "verified" }], options.plugin ? {
      hostPromptOrigin: { messageId: uuid, text: options.enhanced ? visible : original,
        origin: { kind: "plugin", name: "ActualOriginalPlugin" } }
    } : {})
  const before = readFunctionConversationRawProjection(database, threadId, uuid)
  const retain = async () => {
    const adoption = createFunctionConversationNativeAdoption({ runtime, store, producer, occurrence,
      facts: { uuid, role: "user", providerSourceId: uuid, providerOccurrence: 1 },
      nativeHumanPresentation: presentation, assertCurrent: current, seal: () => undefined,
      flush: () => undefined })
    const keeper = new FunctionConversationNativeKeeper(runtime, protector)
    cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
    const result = await keeper.retain({ producer, occurrence, message, door: "prompt", origin,
      signal: controller.signal, policy: policy.value, assertCurrent: current,
      seal: () => undefined, captureProjection: adoption.captureProjection, prepare: adoption.prepare,
      retainActualWork: () => () => undefined,
      assertExecutionFacts: (raw, safe) => { expect(safe.id).toBe(raw.id) },
      inheritPresentation: () => undefined,
      onProtected: result => registerFunctionConversationNativeHumanProtection(presentation, result) })
    await keeper.whenDrained()
    const columns = readFunctionConversationProjectionReceipt(database, {
      target: runtime.target.ref, row: result.row, threadId, incarnation, assertCurrent: guard })
    return { result, columns }
  }
  return { source, runtime, policy, protector, producer, occurrence, input, presentation, protect,
    row, retain, message, uuid, database, threadId, store, before, controller, manager,
    onGuard: (action: (() => void) | undefined) => { onGuard = action } }
}

async function checkpointFixture(intent?: "blank" | "plumbing", withOlderRow = false,
  nativeControls = false, ordinaryAlias = false, completeCanonical = false, legacyMetadata = false,
  ordinaryTool?: ToolMessage) {
  const f = await fixture(intent ? { fresh: true, protected: false, intent } : { enhanced: true })
  if (withOlderRow) appDb.upsertThreadMessages(f.threadId, [{ id: "ordinary-before", role: "assistant",
    content: "ordinary older reply", created_at: new Date(50) }])
  const saved = await f.retain()
  const saverPath = join(directory, `${randomUUID()}.sqlite`), saver = new SqlJsSaver(saverPath)
  cleanups.push(() => saver.close())
  const originalThread = appDb.getThreadCore(f.threadId)
  if (!originalThread) throw Error("ACTUAL_DISPLAY_THREAD_REQUIRED")
  const incarnation = captureThreadIncarnation(originalThread)
  const current = () => {
    f.controller.signal.throwIfAborted()
    if (appDb.getDb() !== f.database || !matchesThreadIncarnation(appDb.getThreadCore(f.threadId), incarnation))
      throw Error("ACTUAL_DISPLAY_SOURCE_RETIRED")
  }
  const target = f.runtime.target.ref
  const checkpoint: Checkpoint = { v: 1, id: randomUUID(), ts: new Date().toISOString(),
    channel_values: { messages: [new HumanMessage({
      content: ordinaryAlias ? "ordinary visible request\nprivate ordinary engine context" : "legacy plain history",
      id: randomUUID(), ...(ordinaryAlias ? {
        additional_kwargs: { cmb_visible_user_message: "ordinary visible request" }
      } : {}) }),
      saved.result.message, new AIMessage({ content: "ordinary answer", id: randomUUID(),
        ...(legacyMetadata ? { response_metadata: { system_fingerprint: undefined,
          service_tier: undefined, nested: { absent: undefined, retained: "metadata" },
          values: [undefined, { absent: undefined }] } } : {}) })],
      [FUNCTION_CONVERSATION_CHANNEL]: { version: 1, logicalSessionId: target.logicalSessionId,
        conversationId: target.conversationId, branchId: target.branchId, frontier: 0 } },
    channel_versions: { messages: 1, [FUNCTION_CONVERSATION_CHANNEL]: 1 }, versions_seen: {} }
  if (completeCanonical) checkpoint.channel_values.messages = [saved.result.message]
  if (ordinaryTool) {
    if (typeof ordinaryTool.content !== "string") throw Error("PLAIN_TOOL_TEXT_REQUIRED")
    checkpoint.channel_values.messages = [saved.result.message, ordinaryTool]
    appDb.upsertThreadMessages(f.threadId, [{ id: ordinaryTool.id!, role: "tool",
      content: ordinaryTool.content, name: ordinaryTool.name, tool_call_id: ordinaryTool.tool_call_id,
      provider_source_id: ordinaryTool.id, provider_occurrence: 1, content_mode: "snapshot",
      recovery_integrity: "verified", created_at: new Date(100),
      start_at: new Date(90), end_at: new Date(110) }])
  }
  if (nativeControls) {
    checkpoint.channel_values.__pregel_tasks = [[], [new Send("model_request", {
      messages: checkpoint.channel_values.messages, jumpTo: undefined,
      controlMetadata: { first: "complete native control", second: ["preserved", "in order"] }
    })]]
    checkpoint.channel_values.__start__ = { messages: [new HumanMessage({
      id: randomUUID(), content: "complete initial native input",
      additional_kwargs: { initial: "original metadata" }
    })] }
  }
  const config = { configurable: { thread_id: f.threadId, checkpoint_ns: "" } }
  const bridge = new FunctionConversationDeliveryBridge(f.store, () => ({ target,
    checkpointThreadId: f.threadId, checkpointIncarnation: incarnation,
    signal: f.controller.signal, assertCurrent: current }))
  await bridge.wrap(saver).put(config, checkpoint, { source: "loop", step: 1, parents: {} })
  const prepare = async (guard = current) => {
    const row = appDb.getThreadCore(f.threadId)
    if (!row) throw Error("ACTUAL_DISPLAY_THREAD_REQUIRED")
    const source = await prepareFunctionConversationCanonicalDisplay({ database: f.database,
      store: f.store, saver, threadId: f.threadId, workspace: target.workspace, originalThread: row,
      checkpointId: checkpoint.id, signal: f.controller.signal, assertCurrent: guard })
    if (!source) throw Error("ACTUAL_DISPLAY_SOURCE_REQUIRED")
    return source
  }
  const verify = (witnesses: Parameters<typeof verifyCanonicalThreadDisplayWitnesses>[1]) =>
    verifyCanonicalThreadDisplayWitnesses(f.threadId, witnesses, current)
  return { ...f, saved, saver, saverPath, current, incarnation, checkpoint, config, prepare, verify }
}

async function actualRepairFixture() {
  const patch = createPatchToolCallsMiddleware(), before = patch.beforeAgent
  if (typeof before !== "function") throw Error("ACTUAL_NATIVE_REPAIR_HOOK_REQUIRED")
  const dangling = new AIMessage({ id: randomUUID(), content: "", tool_calls: [{
    name: "actual_native_task", id: randomUUID(), args: {} }] })
  const update: unknown = await Reflect.apply(before, patch, [{ messages: [dangling] }, {}])
  if (!update || typeof update !== "object" || !("messages" in update) ||
    !Array.isArray(update.messages)) throw Error("ACTUAL_NATIVE_REPAIR_UPDATE_REQUIRED")
  const messages = messagesStateReducer([], update.messages)
  const repair = messages.find(ToolMessage.isInstance)
  if (!repair?.id) throw Error("ACTUAL_NATIVE_REPAIR_MESSAGE_REQUIRED")
  const f = await checkpointFixture(undefined, false, false, false, false, false, repair)
  return { ...f, repair }
}

function readActualRepair(f: Awaited<ReturnType<typeof actualRepairFixture>>,
  admitted = vi.fn(), guard = f.current, changeResponse?: (value: unknown) => void) {
  const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
  cleanups.push(() => client.close())
  return client.readLatestTuple(f.saverPath, f.threadId, "", {
    messageLimit: 1, messageByteBudget: 64 * 1024,
    nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
      workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
      checkpointId: f.checkpoint.id }, assertSource: f.current,
    verifyDisplay: value => {
      changeResponse?.(value)
      return verifyCanonicalCheckpointWorkerDisplay(value, f.threadId, f.checkpoint.id, guard, admitted)
    } })
}

function nativeControlMessages(checkpoint: Checkpoint) {
  const tasks = checkpoint.channel_values.__pregel_tasks
  if (!Array.isArray(tasks) || !Array.isArray(tasks[1]))
    throw Error("ACTUAL_NATIVE_CONTROL_TASKS_REQUIRED")
  const packet: unknown = tasks[1][0]
  if (!packet || typeof packet !== "object" || !("node" in packet) ||
    packet.node !== "model_request" || !("args" in packet))
    throw Error("ACTUAL_NATIVE_CONTROL_PACKET_REQUIRED")
  const args = packet.args
  if (!args || typeof args !== "object" || !("messages" in args) ||
    !Array.isArray(args.messages)) throw Error("ACTUAL_NATIVE_CONTROL_MESSAGES_REQUIRED")
  return args.messages.map((message: unknown) => {
    if (!(message instanceof HumanMessage) && !(message instanceof AIMessage))
      throw Error("ACTUAL_NATIVE_CONTROL_MESSAGE_REQUIRED")
    return message
  })
}

describe("canonical Human display from actual Saver and native Worker sources", () => {
  it.each(["./runtime-projection-worker.ts",
    "../thread-message-hydration/thread-message-hydration-worker.ts"])(
    "bundles %s with typed display data and without Main capability dependencies", entry => {
      const metafile = workerBuilds.get(entry)
      expect(metafile).toBeDefined()
      const inputs = Object.keys(metafile!.inputs).map(path => path.replaceAll("\\", "/"))
      expect(inputs.some(path => path.endsWith("/native-message-capture-data.ts"))).toBe(true)
      for (const suffix of ["/native-message-capture.ts", "/function-conversation-native-calls.ts",
        "/function-conversation-native-node.ts", "/native-conversation-policy-source.ts",
        "/conversation-shared-restore.ts", "src/main/db/index.ts", "src/main/storage.ts"])
        expect(inputs.some(path => path.endsWith(suffix)), suffix).toBe(false)
      expect(inputs.some(path => path.includes("node_modules/electron/") ||
        path.includes("node_modules/electron-store/"))).toBe(false)
      const imports = Object.values(metafile!.outputs).flatMap(output =>
        output.imports.map(imported => imported.path))
      expect(imports).not.toContain("electron")
      expect(imports).not.toContain("electron-store")
    })

  it("uses an ordinary Human's visible alias while keeping the full native Saver payload", async () => {
    const f = await checkpointFixture(undefined, false, false, true)
    const config = { configurable: { ...f.config.configurable, checkpoint_id: f.checkpoint.id } }
    const raw = await f.saver.getTuple(config)
    if (!raw) throw Error("ACTUAL_ORDINARY_ALIAS_CHECKPOINT_REQUIRED")
    const original = JSON.stringify(raw.checkpoint)
    const rawMessages = raw.checkpoint.channel_values.messages
    if (!Array.isArray(rawMessages) || !(rawMessages[0] instanceof HumanMessage) ||
      !(rawMessages[1] instanceof HumanMessage) || !(rawMessages[2] instanceof AIMessage))
      throw Error("ACTUAL_ORDINARY_ALIAS_MESSAGES_REQUIRED")
    expect(rawMessages).toHaveLength(3)
    const originalIds = rawMessages.map(message => message.id)
    const ordinaryPayload = JSON.stringify(rawMessages[0].toDict())
    expect(rawMessages[0].content).toBe("ordinary visible request\nprivate ordinary engine context")
    expect(rawMessages[0].lc_kwargs.content).toBe(rawMessages[0].content)
    expect(ordinaryPayload).toContain("private ordinary engine context")
    expect(serializeFunctionConversationNativeMessage(rawMessages[1]))
      .toBe(f.saved.result.row.nativePayload)
    const source = await f.prepare()
    withFunctionConversationCanonicalDisplay(source, view => {
      const messages = view.checkpoint.channel_values.messages
      if (!Array.isArray(messages) || !(messages[0] instanceof HumanMessage))
        throw Error("ACTUAL_ORDINARY_ALIAS_DISPLAY_REQUIRED")
      expect(messages).toHaveLength(3)
      expect(messages.map(message => message.id)).toStrictEqual(originalIds)
      expect(messages[0].content).toBe("ordinary visible request")
      expect(messages[0].lc_kwargs.content).toBe("ordinary visible request")
      expect(messages[0].additional_kwargs.cmb_visible_user_message).toBe("ordinary visible request")
      expect(view.read(0)).toBeUndefined()
      expect(view.read(1)?.id).toBe(f.uuid)
      expect(view.read(1)?.content).toBe("visible [REDACTED]")
      expect(view.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
        .toStrictEqual(raw.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
      const displayed = JSON.stringify(view.checkpoint)
      expect(displayed).not.toContain("private ordinary engine context")
      expect(displayed).not.toContain("private engine context")
      expect(displayed).not.toContain("original sk-")
    })
    const unchanged = await f.saver.getTuple(config)
    expect(JSON.stringify(unchanged?.checkpoint)).toBe(original)
    expect(JSON.stringify(rawMessages[0].toDict())).toBe(ordinaryPayload)
    expect(f.saved.result.row.nativePayload).toContain("private engine context")
    expect(f.database.inTransaction).toBe(false)
  })

  it("reads native routing and initial messages after a real Saver roundtrip without changing raw checkpoints", async () => {
    const f = await checkpointFixture(undefined, false, true)
    const raw = await f.saver.getTuple({ configurable: { ...f.config.configurable,
      checkpoint_id: f.checkpoint.id } })
    if (!raw) throw Error("ACTUAL_NATIVE_CONTROL_CHECKPOINT_REQUIRED")
    const original = JSON.stringify(raw.checkpoint)
    const controls = nativeControlMessages(raw.checkpoint)
    expect(controls).toHaveLength(3)
    expect(Object.getPrototypeOf(controls[0])).toBe(HumanMessage.prototype)
    expect(Object.getPrototypeOf(controls[1])).toBe(HumanMessage.prototype)
    expect(Object.getPrototypeOf(controls[2])).toBe(AIMessage.prototype)
    expect(() => canonicalDisplayValueDigest(raw.checkpoint.channel_values.__pregel_tasks))
      .toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
    const source = await f.prepare()
    withFunctionConversationCanonicalDisplay(source, view => {
      expect(Object.hasOwn(view.checkpoint.channel_values, "__pregel_tasks")).toBe(false)
      expect(Object.hasOwn(view.checkpoint.channel_values, "__start__")).toBe(false)
      expect(view.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
        .toStrictEqual(raw.checkpoint.channel_values[FUNCTION_CONVERSATION_CHANNEL])
      expect(view.read(1)?.content).toBe("visible [REDACTED]")
      expect(JSON.stringify(view.checkpoint)).not.toContain("private engine context")
      expect(JSON.stringify(view.checkpoint)).not.toContain("original sk-")
    })
    const unchanged = await f.saver.getTuple({ configurable: { ...f.config.configurable,
      checkpoint_id: f.checkpoint.id } })
    expect(JSON.stringify(unchanged?.checkpoint)).toBe(original)
    expect(f.database.inTransaction).toBe(false)
  })

  it.each(["content", "metadata", "getter"] as const)(
    "rejects the actual source's nested native %s change after a real Saver roundtrip", async change => {
      const f = await checkpointFixture(undefined, false, true)
      const raw = await f.saver.getTuple({ configurable: { ...f.config.configurable,
        checkpoint_id: f.checkpoint.id } })
      if (!raw) throw Error("ACTUAL_NATIVE_CONTROL_CHECKPOINT_REQUIRED")
      const original = JSON.stringify(raw.checkpoint)
      const retained: { tuple: CheckpointTuple | undefined } = { tuple: undefined }
      const originalGetTuple = SqlJsSaver.prototype.getTuple
      const observer = vi.spyOn(SqlJsSaver.prototype, "getTuple").mockImplementation(function(
        this: SqlJsSaver, ...args: Parameters<typeof originalGetTuple>) {
        const operation: ReturnType<typeof originalGetTuple> = Reflect.apply(originalGetTuple, this, args)
        // Retain the real tuple while its original Promise still carries success or failure.
        void operation.then(tuple => {
          if (this === f.saver) retained.tuple = tuple
        }, () => undefined)
        return operation
      })
      cleanups.push(() => { observer.mockRestore() })
      let armed = false, mutations = 0, getters = 0
      const source = await f.prepare(() => {
        f.current()
        if (!armed) return
        armed = false
        if (!retained.tuple) throw Error("ACTUAL_SOURCE_CONTROL_CHECKPOINT_REQUIRED")
        const message = nativeControlMessages(retained.tuple.checkpoint)[2]
        mutations++
        if (change === "content") message.content = "changed control body"
        else if (change === "metadata") message.response_metadata = { changed: "control metadata" }
        else Object.defineProperty(message, "content", { enumerable: true, configurable: true,
          get() { getters++; return "unread executable control" } })
      })
      if (!retained.tuple) throw Error("ACTUAL_SOURCE_CONTROL_CHECKPOINT_REQUIRED")
      const sourceMessages = retained.tuple.checkpoint.channel_values.messages
      if (!Array.isArray(sourceMessages)) throw Error("ACTUAL_SOURCE_MESSAGES_REQUIRED")
      expect(nativeControlMessages(retained.tuple.checkpoint)[2]).not.toBe(sourceMessages[2])
      expect(() => withFunctionConversationCanonicalDisplay(source, view => {
        expect(Object.hasOwn(view.checkpoint.channel_values, "__pregel_tasks")).toBe(false)
        expect(Object.hasOwn(view.checkpoint.channel_values, "__start__")).toBe(false)
        armed = true
      })).toThrow(change === "getter" ? "MODS_NATIVE_CAPTURE_ACCESSOR" :
        "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
      expect(mutations).toBe(1)
      expect(getters).toBe(0)
      observer.mockRestore()
      const unchanged = await f.saver.getTuple({ configurable: { ...f.config.configurable,
        checkpoint_id: f.checkpoint.id } })
      expect(JSON.stringify(unchanged?.checkpoint)).toBe(original)
      expect(f.database.inTransaction).toBe(false)
    })

  it.each(["blank", "plumbing"] as const)(
    "keeps full %s native input and its ordinal while omitting the private display view", async intent => {
      const f = await checkpointFixture(intent), source = await f.prepare()
      const original = JSON.stringify(f.checkpoint.channel_values.messages)
      const display = withFunctionConversationCanonicalDisplay(source, view => {
        expect(view.read(1)).toBeUndefined()
        const messages = view.checkpoint.channel_values.messages
        if (!Array.isArray(messages)) throw Error("ACTUAL_DISPLAY_MESSAGES_REQUIRED")
        expect(messages).toHaveLength(3)
        expect(messages[1]).toBeNull()
        return JSON.stringify(view.checkpoint)
      })
      expect(display).not.toContain("original sk-")
      expect(readFunctionConversationCanonicalThreadMessages(f.threadId, f.current)).toEqual([])
      expect(JSON.stringify(f.checkpoint.channel_values.messages)).toBe(original)
      expect(f.saved.result.row.nativePayload).toContain("original sk-")
      expect(f.database.inTransaction).toBe(false)
    })

  it("keeps ordinary empty rows instead of interpreting their body as an omitted capability", async () => {
    const f = await checkpointFixture()
    appDb.upsertThreadMessages(f.threadId, [{ id: "ordinary-empty", role: "user",
      content: "", created_at: new Date(80) }])
    const messages = readFunctionConversationCanonicalThreadMessages(f.threadId, f.current)
    expect(messages.some(message => message.id === "ordinary-empty")).toBe(true)
    expect(messages.some(message => message.id === f.uuid)).toBe(true)
  })

  it.each(["blank", "plumbing"] as const)(
    "advances the actual page Worker cursor over an omitted %s row", async intent => {
      const f = await checkpointFixture(intent, true)
      const client = new ThreadMessageHydrationClient(async () => new Worker(pageWorkerPath), () => paths.database)
      cleanups.push(() => client.close())
      const first = await client.readPage(f.threadId, { targetMessageId: f.uuid, limit: 1 }, undefined,
        { assertCurrent: f.current, verify: f.verify })
      expect(first.messages).toEqual([])
      expect(first.beforeMessageId).toBe(f.uuid)
      expect(first.beforeOrdinal).toBe(Number(f.saved.columns.ordinal))
      if (first.beforeMessageId === null || first.beforeOrdinal === null)
        throw Error("ACTUAL_OMITTED_CURSOR_REQUIRED")
      const second = await client.readPage(f.threadId, { limit: 1,
        beforeMessageId: first.beforeMessageId, beforeOrdinal: first.beforeOrdinal }, undefined,
      { assertCurrent: f.current, verify: f.verify })
      expect(second.messages.map(message => message.id)).toEqual(["ordinary-before"])
      expect(Object.hasOwn(first, "canonicalWitnesses")).toBe(false)
      expect(f.saved.result.row.nativePayload).toContain("original sk-")
    })

  it("rejects a ledger removed by the original source instead of publishing an omitted page", async () => {
    const f = await checkpointFixture("blank")
    const client = new ThreadMessageHydrationClient(async () => new Worker(pageWorkerPath), () => paths.database)
    cleanups.push(() => client.close())
    await expect(client.readPage(f.threadId, { limit: 1 }, undefined, {
      assertCurrent: f.current,
      verify(witnesses) {
        expect(witnesses[0].presentation?.kind).toBe("blank")
        f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
          [f.threadId])
        f.verify(witnesses)
      }
    })).rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })

  it("detects a synchronous ledger mutation after the display callback in fresh B", async () => {
    const f = await checkpointFixture("plumbing"), source = await f.prepare()
    expect(() => withFunctionConversationCanonicalDisplay(source, view => {
      expect(view.read(1)).toBeUndefined()
      f.database.run(`UPDATE function_conversation_presentation_dispositions SET intent_digest=?
        WHERE thread_id=?`, ["b".repeat(64), f.threadId])
    })).toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
  })

  it("exports a real committed system notice while omitting its hidden SDK note", async () => {
    const f = await checkpointFixture(), target = f.runtime.target.ref
    const messages = ["user", "system"].map(type => {
      const uuid = randomUUID(), content = [{ type: "text" as const,
        text: type === "user" ? "hidden SDK note" : "visible committed notice" }]
      const native = type === "user" ? new HumanMessage({ id: uuid, content,
        additional_kwargs: { isMeta: true } }) : new SystemMessage({ id: uuid, content })
      const access = createFunctionConversationTranscriptAccess((_target, row) => ({
        id: row.uuid, role: type === "user" ? "user" : "system", content,
        created_at: new Date(row.createdAt)
      }))
      const row = f.store.commit(target, { uuid, inputDigest: uuid, door: "note",
        origin: { kind: "plugin", name: "ActualExportPlugin" }, message: { type, content,
          ...(type === "user" ? { role: "user", isMeta: true } : {}) },
        nativePayload: serializeFunctionConversationNativeMessage(native),
        orderAnchor: { kind: "sdk-note" }, inbox: type === "user", sdk: true },
      f.current, access.write, access.verify)
      native.additional_kwargs = { ...native.additional_kwargs,
        function_row: functionConversationCanonicalStamp(target, row) }
      expect(serializeFunctionConversationNativeMessage(native)).toBe(row.nativePayload)
      return native
    })
    const original = f.checkpoint.channel_values.messages
    if (!Array.isArray(original)) throw Error("ACTUAL_DISPLAY_MESSAGES_REQUIRED")
    const checkpoint: Checkpoint = { ...f.checkpoint, id: randomUUID(),
      ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(),
      channel_values: { ...f.checkpoint.channel_values, messages: [...original, ...messages] } }
    const bridge = new FunctionConversationDeliveryBridge(f.store, () => ({ target,
      checkpointThreadId: f.threadId, checkpointIncarnation: f.incarnation,
      signal: f.controller.signal, assertCurrent: f.current }))
    await bridge.wrap(f.saver).put(f.config, checkpoint, { source: "loop", step: 2, parents: {} })
    const originalThread = appDb.getThreadCore(f.threadId)
    if (!originalThread) throw Error("ACTUAL_DISPLAY_THREAD_REQUIRED")
    const source = await prepareFunctionConversationCanonicalDisplay({ database: f.database,
      store: f.store, saver: f.saver, threadId: f.threadId, workspace: target.workspace,
      originalThread, checkpointId: checkpoint.id, signal: f.controller.signal,
      assertCurrent: f.current })
    if (!source) throw Error("ACTUAL_DISPLAY_SOURCE_REQUIRED")
    withFunctionConversationCanonicalDisplay(source, view => {
      const note = view.read(3), notice = view.read(4), human = view.read(1)
      if (!note || !notice || !human) throw Error("ACTUAL_SEALED_EXPORT_MESSAGES_REQUIRED")
      const exported = selectFunctionConversationCanonicalExportMessages([human, note, notice])
      expect(exported.map(message => message.id)).toEqual([f.uuid, messages[1].id])
      expect(JSON.stringify(exported)).toContain("visible committed notice")
      expect(JSON.stringify(exported)).not.toContain("hidden SDK note")
      expect(note.function_row?.isMeta).toBe(true)
      expect(notice.role).toBe("system")
      expect(selectFunctionConversationCanonicalExportMessages([
        { id: randomUUID(), role: "user", content: "unmarked note text", created_at: new Date(100) }
      ])).toHaveLength(1)
    })
    const tuple = await f.saver.getTuple({ configurable: { ...f.config.configurable,
      checkpoint_id: checkpoint.id } })
    expect(JSON.stringify(tuple?.checkpoint.channel_values.messages)).toContain("hidden SDK note")
    expect(f.store.captureInbox(target, 0).rows.some(row => row.uuid === messages[0].id)).toBe(true)
  })

  it("reads the protected visible projection with original times while native context stays complete", async () => {
    const f = await checkpointFixture(), source = await f.prepare()
    const before = f.store.readReceipt(f.runtime.target.ref, f.uuid)
    const display = withFunctionConversationCanonicalDisplay(source, view => {
      const message = view.read(1)
      expect(message?.content).toBe("visible [REDACTED]")
      expect(message?.created_at.getTime()).toBe(100)
      expect(message?.start_at?.getTime()).toBe(90)
      expect(message?.goal_id).toBe("original-goal")
      expect(view.read(0)).toBeUndefined()
      expect(JSON.stringify(view.checkpoint.channel_values.messages)).not.toContain("private engine context")
      return message
    })
    expect(display?.function_row?.uuid).toBe(f.uuid)
    expect(f.saved.result.message.content).toContain("private engine context")
    expect(f.store.readReceipt(f.runtime.target.ref, f.uuid)).toEqual(before)
    expect(f.store.captureInbox(f.runtime.target.ref, 0).rows).toHaveLength(0)
  })

  it("keeps UI-only copies separate from full canonical provider payload during cold reads", async () => {
    const f = await checkpointFixture()
    f.runtime.close()
    const source = await f.prepare()
    withFunctionConversationCanonicalDisplay(source, view => {
      expect(view.read(1)?.content).toBe("visible [REDACTED]")
    })
    const native = await f.saver.getTuple({ configurable: { ...f.config.configurable,
      checkpoint_id: f.checkpoint.id } })
    expect(JSON.stringify(native?.checkpoint.channel_values.messages)).toContain("private engine context")
    expect(f.saved.result.row.nativePayload).toContain("private engine context")
  })

  it("rejects copied display capabilities and retired views", async () => {
    const f = await checkpointFixture(), source = await f.prepare()
    expect(() => withFunctionConversationCanonicalDisplay({ ...source }, () => undefined)).toThrow()
    const view = withFunctionConversationCanonicalDisplay(source, actual => actual)
    expect(() => view.read(1)).toThrow()
    expect(() => view.assertCheckpoint(view.checkpoint)).toThrow()
  })

  it("rejects an actual Saver closing between source capture and display without changing native rows", async () => {
    const f = await checkpointFixture(), source = await f.prepare()
    await f.saver.close()
    expect(() => withFunctionConversationCanonicalDisplay(source, view => view.read(1))).toThrow()
    expect(appDb.getThreadMessages(f.threadId)[0].content).toBe("visible [REDACTED]")
  })

  it("rejects source callbacks changing a sealed UI row after the consumer read", async () => {
    const f = await checkpointFixture()
    let afterRead = false
    const source = await f.prepare(() => {
      f.current()
      if (afterRead) f.database.run("UPDATE thread_messages SET created_at=created_at+1 WHERE thread_id=? AND message_id=?",
        [f.threadId, f.uuid])
    })
    expect(() => withFunctionConversationCanonicalDisplay(source, view => {
      expect(view.read(1)?.content).toBe("visible [REDACTED]")
      afterRead = true
    })).toThrow()
  })

  it("rejects a last source callback changing the display copy without invoking its getter", async () => {
    const f = await checkpointFixture()
    let display: unknown, getters = 0
    const source = await f.prepare(() => {
      f.current()
      if (display && typeof display === "object") Object.defineProperty(display, "content", {
        enumerable: true, configurable: true, get() { getters++; return "private replacement" }
      })
    })
    expect(() => withFunctionConversationCanonicalDisplay(source, view => {
      const values = view.checkpoint.channel_values.messages
      if (!Array.isArray(values)) throw Error("ACTUAL_DISPLAY_MESSAGES_REQUIRED")
      display = values[1]
    })).toThrow()
    expect(getters).toBe(0)
  })

  it.each(FUNCTION_CONVERSATION_PROJECTION_COLUMNS)("rejects a modified actual %s column", async key => {
    const f = await checkpointFixture(), source = await f.prepare(), old = f.saved.columns[key]
    const next = key === "role" ? "assistant" :
      typeof old === "number" ? old + 1 : old === null ? "changed" : `${old}-changed`
    f.database.run(`UPDATE thread_messages SET ${key}=? WHERE thread_id=? AND message_id=?`,
      [next, f.threadId, f.uuid])
    expect(() => withFunctionConversationCanonicalDisplay(source, view => view.read(1))).toThrow()
  })

  it("hashes unmarked members too and rejects rewritten history against the original membership", async () => {
    const f = await checkpointFixture()
    const changed = { ...f.checkpoint, channel_values: { ...f.checkpoint.channel_values,
      messages: [new HumanMessage({ content: "different unmarked history", id: randomUUID() }),
        f.saved.result.message, new AIMessage({ content: "ordinary answer", id: randomUUID() })] } }
    await f.saver.put(f.config, changed, { source: "loop", step: 1, parents: {} })
    await expect(f.prepare()).rejects.toThrow()
  })

  it.each(["rewritten", { lc: 2, type: "undefined", extra: true }])(
    "verifies JsonPlus undefined mixed history and rejects metadata rewrite: %j", async changed => {
      const f = await checkpointFixture(undefined, false, false, false, false, true)
      const exact = { configurable: { ...f.config.configurable, checkpoint_id: f.checkpoint.id } }
      const raw = await f.saver.getTuple(exact)
      const messages = raw?.checkpoint.channel_values.messages
      if (!Array.isArray(messages) || !(messages[2] instanceof AIMessage))
        throw Error("ACTUAL_LEGACY_METADATA_REQUIRED")
      expect(Object.hasOwn(messages[2].response_metadata, "system_fingerprint")).toBe(true)
      expect(messages[2].response_metadata.system_fingerprint).toBeUndefined()
      expect(messages[2].response_metadata.values).toEqual([undefined, { absent: undefined }])
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
      cleanups.push(() => client.close())
      const read = () => client.readLatestTuple(f.saverPath, f.threadId, "", {
        messageLimit: 3, messageByteBudget: 64 * 1024,
        nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
          checkpointId: f.checkpoint.id }, assertSource: f.current,
        verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
          f.checkpoint.id, f.current) })
      const displayed = await read()
      expect(JSON.stringify(displayed)).toContain("visible [REDACTED]")
      expect(JSON.stringify(displayed)).not.toContain("private engine context")
      // A same-address rewrite is still compared against the original full membership digest.
      messages[2].response_metadata.service_tier = changed
      await f.saver.put(f.config, { ...f.checkpoint, channel_values: {
        ...f.checkpoint.channel_values, messages } }, { source: "loop", step: 1, parents: {} })
      await expect(read()).rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    })

  it("does not borrow a UUID collection when actual checkpoint membership was deleted", async () => {
    const f = await checkpointFixture()
    f.database.run("DELETE FROM function_conversation_checkpoint_members WHERE uuid=?", [f.uuid])
    await expect(f.prepare()).rejects.toThrow()
  })

  it.each([false, true])("admits a native bootstrap only for complete canonical membership: %s", async complete => {
    const f = await checkpointFixture(undefined, false, false, false, complete)
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const admitted = vi.fn()
    await client.readLatestTuple(f.saverPath, f.threadId, "", {
      messageLimit: 1, messageByteBudget: 64 * 1024,
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, f.current, admitted) })
    expect(admitted).toHaveBeenCalledTimes(complete ? 1 : 0)
    expect(f.database.exec("SELECT 1 FROM legacy_checkpoint_transcript_migrations WHERE thread_id=?",
      [f.threadId])[0]?.values ?? []).toEqual([])
  })

  it("bootstraps a durable ordinary native repair beside canonical messages after Saver reopen", async () => {
    const f = await actualRepairFixture()
    await f.saver.close()
    const reopened = new SqlJsSaver(f.saverPath)
    cleanups.push(() => reopened.close())
    const tuple = await reopened.getTuple(f.config)
    const messages = tuple?.checkpoint.channel_values.messages
    if (!Array.isArray(messages)) throw Error("ACTUAL_REOPENED_REPAIR_REQUIRED")
    expect(messages).toHaveLength(2)
    expect(messages[1]).toBeInstanceOf(ToolMessage)
    const before = JSON.stringify(appDb.getThreadMessages(f.threadId))
    const admitted = vi.fn()
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    await client.readLatestTuple(f.saverPath, f.threadId, "", {
      messageLimit: 1, messageByteBudget: 64 * 1024,
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, f.current, admitted) })
    expect(admitted).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(appDb.getThreadMessages(f.threadId))).toBe(before)
    expect(f.database.exec("SELECT 1 FROM legacy_checkpoint_transcript_migrations WHERE thread_id=?",
      [f.threadId])[0]?.values ?? []).toEqual([])
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
  })

  it.each(["role", "content_json", "name", "tool_call_id", "status", "recovery_integrity",
    "missing", "fragment", "native-metadata"])(
    "does not bootstrap an uncovered ordinary repair: %s", async change => {
      const f = await actualRepairFixture(), admitted = vi.fn()
      if (change === "missing") f.database.run(
        "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.repair.id!])
      else if (change === "fragment") f.database.run(
        "INSERT INTO thread_message_fragments(thread_id,message_id,content_text,created_at) VALUES(?,?,?,?)",
        [f.threadId, f.repair.id!, "unproven fragment", 123])
      else if (change === "native-metadata") {
        const changed = new ToolMessage({ id: f.repair.id, content: f.repair.content,
          name: f.repair.name, tool_call_id: f.repair.tool_call_id,
          response_metadata: { unrepresented: "not durable" } })
        await f.saver.put(f.config, { ...f.checkpoint, channel_values: {
          ...f.checkpoint.channel_values, messages: [f.saved.result.message, changed] } },
        { source: "loop", step: 1, parents: {} })
        await expect(readActualRepair(f, admitted)).rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
        expect(admitted).not.toHaveBeenCalled()
        return
      } else f.database.run(`UPDATE thread_messages SET ${change}=? WHERE thread_id=? AND message_id=?`,
        [change === "content_json" ? JSON.stringify("changed") :
          change === "recovery_integrity" ? 0 : change === "role" ? "assistant" : "changed",
          f.threadId, f.repair.id!])
      await readActualRepair(f, admitted)
      expect(admitted).not.toHaveBeenCalled()
    })

  it("rejects forged ordinary coverage even when its SQL row matches the forged payload", async () => {
    const f = await actualRepairFixture(), admitted = vi.fn()
    await expect(readActualRepair(f, admitted, f.current, value => {
      if (!value || typeof value !== "object" || !("__cmb_ordinary_display_coverage" in value) ||
        !Array.isArray(value.__cmb_ordinary_display_coverage)) throw Error("ACTUAL_COVERAGE_REQUIRED")
      const entry: unknown = value.__cmb_ordinary_display_coverage[0]
      if (!entry || typeof entry !== "object" || !("payload" in entry) ||
        typeof entry.payload !== "string" || !("columnsDigest" in entry)) throw Error("ACTUAL_PAYLOAD_REQUIRED")
      const data: unknown = JSON.parse(entry.payload)
      if (!data || typeof data !== "object" || !("data" in data) || !data.data ||
        typeof data.data !== "object" || !("content" in data.data)) throw Error("ACTUAL_DATA_REQUIRED")
      data.data.content = "forged worker body"
      const forgedPayload = JSON.stringify(data)
      entry.payload = forgedPayload
      f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
        [JSON.stringify(data.data.content), f.threadId, f.repair.id!])
      const forged = readOrdinaryToolDisplayCoverage(f.database, f.threadId, forgedPayload)
      if (!forged) throw Error("ACTUAL_FORGED_COLUMNS_REQUIRED")
      entry.columnsDigest = forged.columnsDigest
    })).rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_MEMBERSHIP")
    expect(admitted).not.toHaveBeenCalled()
  })

  it("rechecks every ordinary SQL column after the last source callback", async () => {
    const f = await actualRepairFixture(), admitted = vi.fn()
    let guards = 0
    await expect(readActualRepair(f, admitted, () => {
      f.current()
      if (++guards === 2) f.database.run(
        "UPDATE thread_messages SET created_at=created_at+1 WHERE thread_id=? AND message_id=?",
        [f.threadId, f.repair.id!])
    })).rejects.toThrow()
    expect(guards).toBeGreaterThanOrEqual(2)
    expect(admitted).not.toHaveBeenCalled()
  })

  it("verifies the canonical workspace behind an equivalent metadata path", async () => {
    const f = await checkpointFixture(undefined, false, false, false, true)
    const physical = appDb.getThreadCore(f.threadId)!
    const workspace = f.runtime.target.ref.workspace
    const displayedPath = (process.platform === "win32" ? workspace.toUpperCase() : workspace) + "/."
    appDb.updateThread(f.threadId, { metadata: JSON.stringify({
      ...JSON.parse(physical.metadata ?? "{}"), workspacePath: displayedPath
    }) })
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const admitted = vi.fn()
    await client.readLatestTuple(f.saverPath, f.threadId, "", {
      messageLimit: 1, messageByteBudget: 64 * 1024,
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace, incarnation: f.incarnation, checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, f.current, admitted) })
    expect(admitted).toHaveBeenCalledTimes(1)
  })

  it("does not admit complete native bootstrap after a projection seal is damaged", async () => {
    const f = await checkpointFixture(undefined, false, false, false, true)
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("changed outside native projection"), f.threadId, f.uuid])
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const admitted = vi.fn()
    await expect(client.readLatestTuple(f.saverPath, f.threadId, "", {
      messageLimit: 1, messageByteBudget: 64 * 1024,
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, f.current, admitted) })).rejects.toThrow()
    expect(admitted).not.toHaveBeenCalled()
  })

  it("reads the complete native snapshot in a real Worker and emits only bounded sealed display", async () => {
    const f = await checkpointFixture()
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const tuple = await client.readLatestTuple(f.saverPath, f.threadId, "", {
      messageLimit: 2, messageByteBudget: 1024 * 1024,
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, f.current) })
    const json = JSON.stringify(tuple)
    expect(json).toContain("visible [REDACTED]")
    expect(json).not.toContain("private engine context")
    expect(json).not.toContain("__cmb_canonical_display_witnesses")
    expect(json).toContain('"__cmb_checkpoint_raw_index":1')
    expect(json).toContain('"created_at":"1970-01-01T00:00:00.100Z"')
  })

  it.each(["blank", "plumbing"] as const)(
    "authenticates the full Worker %s omission aggregate while retaining physical indices", async intent => {
      const f = await checkpointFixture(intent), original = JSON.stringify(f.checkpoint.channel_values.messages)
      const actualMessageIds = (messages: unknown): string[] => {
        if (!Array.isArray(messages)) throw Error("ACTUAL_DISPLAY_MESSAGES_REQUIRED")
        return messages.map(message => {
          if (!message || typeof message !== "object") throw Error("ACTUAL_DISPLAY_MESSAGE_REQUIRED")
          const direct = "id" in message ? message.id : undefined
          const kwargs = "kwargs" in message ? message.kwargs : undefined
          const id = typeof direct === "string" ? direct :
            kwargs && typeof kwargs === "object" && "id" in kwargs ? kwargs.id : undefined
          if (typeof id !== "string" || !id) throw Error("ACTUAL_DISPLAY_MESSAGE_ID_REQUIRED")
          return id
        })
      }
      const beforeTuple = await f.saver.getTuple({ configurable: { ...f.config.configurable,
        checkpoint_id: f.checkpoint.id } })
      const originalIds = actualMessageIds(beforeTuple?.checkpoint.channel_values.messages)
      expect(originalIds).toHaveLength(3)
      expect(new Set(originalIds).size).toBe(3)
      expect(originalIds[1]).toBe(f.uuid)
      expect(JSON.stringify(beforeTuple?.checkpoint.channel_values.messages)).toBe(original)
      let actualCount = -1, actualDigest = "", payloadFields: string[] = [], selectedIds: string[] = []
      const client = new CheckpointRuntimeProjectionClient(async () => {
        const worker = new Worker(runtimeWorkerPath)
        worker.on("message", response => {
          if (response.type !== "read-latest-tuple-result" || !response.ok) return
          actualCount = response.tuple.__cmb_canonical_display_omissions.count
          actualDigest = response.tuple.__cmb_canonical_display_omissions.digest
          payloadFields = Object.keys(response.tuple.__cmb_canonical_display_omissions)
          selectedIds = actualMessageIds(response.tuple.checkpoint.channel_values.messages)
        })
        return worker
      })
      cleanups.push(() => client.close())
      const tuple = await client.readLatestTuple(f.saverPath, f.threadId, "", {
        messageLimit: 2, messageByteBudget: 1024 * 1024,
        nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
          checkpointId: f.checkpoint.id }, assertSource: f.current,
        verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
          f.checkpoint.id, f.current) })
      expect(actualCount).toBe(1)
      expect(actualDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(payloadFields).toEqual(["count", "digest"])
      const json = JSON.stringify(tuple)
      expect(json).toContain('"__cmb_original_message_count":3')
      expect(new Set(selectedIds).size).toBe(2)
      expect(selectedIds.map(id => originalIds.indexOf(id))).toEqual([0, 2])
      if (!tuple || typeof tuple !== "object" || !("checkpoint" in tuple))
        throw Error("ACTUAL_DISPLAY_TUPLE_REQUIRED")
      const displayCheckpoint = tuple.checkpoint
      if (!displayCheckpoint || typeof displayCheckpoint !== "object" ||
        !("channel_values" in displayCheckpoint)) throw Error("ACTUAL_DISPLAY_CHECKPOINT_REQUIRED")
      const displayValues = displayCheckpoint.channel_values
      if (!displayValues || typeof displayValues !== "object" || !("messages" in displayValues))
        throw Error("ACTUAL_DISPLAY_CHANNEL_REQUIRED")
      expect(actualMessageIds(displayValues.messages)).toEqual(selectedIds)
      expect(json).not.toContain(f.uuid)
      expect(json).not.toContain("original sk-")
      expect(json).not.toContain("__cmb_canonical_display_omissions")
      const originalTuple = await f.saver.getTuple({ configurable: { ...f.config.configurable,
        checkpoint_id: f.checkpoint.id } })
      expect(JSON.stringify(originalTuple?.checkpoint.channel_values.messages)).toBe(original)
      expect(f.store.readRowAtCut(f.runtime.target.ref, f.uuid, {
        frontier: f.saved.result.row.sequence }, f.current).nativePayload).toBe(f.saved.result.row.nativePayload)
    }
  )

  it.each(["missing", "count", "digest", "shown"] as const)(
    "rejects the real Worker response with a changed %s omission proof", async change => {
      const f = await checkpointFixture("blank")
      let changed = 0
      const client = new CheckpointRuntimeProjectionClient(async () => {
        const worker = new Worker(runtimeWorkerPath)
        worker.on("message", response => {
          if (response.type !== "read-latest-tuple-result" || !response.ok) return
          expect(response.tuple.__cmb_canonical_display_omissions.count).toBe(1)
          if (change === "missing") delete response.tuple.__cmb_canonical_display_omissions
          else if (change === "count") response.tuple.__cmb_canonical_display_omissions.count = 0
          else if (change === "digest") response.tuple.__cmb_canonical_display_omissions.digest = "0".repeat(64)
          else response.tuple.checkpoint.channel_values.messages.push({
            id: f.uuid, role: "user", content: "illegally shown hidden canonical input",
            function_row: functionConversationCanonicalStamp(f.runtime.target.ref, f.saved.result.row),
            __cmb_checkpoint_raw_index: 1
          })
          changed++
        })
        return worker
      })
      cleanups.push(() => client.close())
      await expect(client.readLatestTuple(f.saverPath, f.threadId, "", {
        messageLimit: 1, nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
          checkpointId: f.checkpoint.id }, assertSource: f.current,
        verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
          f.checkpoint.id, f.current) })).rejects.toThrow()
      expect(changed).toBe(1)
      expect(f.saved.result.row.nativePayload).toBe(serializeFunctionConversationNativeMessage(f.saved.result.message))
    }
  )

  it.each(["ledger", "member"] as const)(
    "rejects a %s changed by the last source guard after full omission summary A", async change => {
      const f = await checkpointFixture("plumbing")
      let guards = 0, changed = 0
      const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
      cleanups.push(() => client.close())
      await expect(client.readLatestTuple(f.saverPath, f.threadId, "", {
        messageLimit: 1, nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
          checkpointId: f.checkpoint.id }, assertSource: f.current,
        verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
          f.checkpoint.id, () => {
            f.current()
            if (++guards !== 2) return
            if (change === "ledger") f.database.run(`DELETE FROM
              function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=?`, [f.threadId, f.uuid])
            else f.database.run("DELETE FROM function_conversation_checkpoint_members WHERE uuid=?", [f.uuid])
            changed += f.database.getRowsModified()
          }) })).rejects.toThrow()
      expect(guards).toBe(2)
      expect(changed).toBe(1)
    }
  )

  it("keeps the paged membership fingerprint byte equal to the original complete LEFT JOIN", async () => {
    const f = await checkpointFixture()
    const result = f.database.exec(`SELECT receipt.receipt_id,receipt.target_json,receipt.snapshot_digest,
      receipt.snapshot_json,member.ordinal,member.uuid,member.member_json
      FROM function_conversation_checkpoint_receipts receipt
      LEFT JOIN function_conversation_checkpoint_members member ON member.receipt_id=receipt.receipt_id
      WHERE receipt.conversation_id=? AND receipt.branch_id=? AND receipt.checkpoint_thread_id=?
      AND receipt.checkpoint_incarnation=? AND receipt.checkpoint_namespace=? AND receipt.checkpoint_id=?
      ORDER BY member.ordinal`, [f.runtime.target.ref.conversationId, f.runtime.target.ref.branchId,
      f.threadId, JSON.stringify(["token", f.incarnation.token]), "", f.checkpoint.id])[0]
    const rows = result.values.map(values => Object.fromEntries(result.columns.map((key, index) =>
      [key, values[index]])))
    expect(canonicalCheckpointDisplayMembershipFingerprint(f.database, {
      conversationId: f.runtime.target.ref.conversationId, branchId: f.runtime.target.ref.branchId,
      threadId: f.threadId, incarnation: JSON.stringify(["token", f.incarnation.token]),
      namespace: "", checkpointId: f.checkpoint.id
    })).toBe(createHash("sha256").update(JSON.stringify(rows)).digest("hex"))
  })

  it("binds real page Worker evidence to fresh Main columns and does not expose the witness", async () => {
    const f = await checkpointFixture()
    const client = new ThreadMessageHydrationClient(async () => new Worker(pageWorkerPath), () => paths.database)
    cleanups.push(() => client.close())
    const page = await client.readPage(f.threadId, { limit: 1 }, undefined,
      { assertCurrent: f.current, verify: f.verify })
    expect(page.messages[0].content).toBe("visible [REDACTED]")
    expect(page.messages[0].created_at.getTime()).toBe(100)
    expect(JSON.stringify(page)).not.toContain("private engine context")
    expect(Object.hasOwn(page, "canonicalWitnesses")).toBe(false)
  })

  it("rejects incorrect display bytes from the exact real page Worker response", async () => {
    const f = await checkpointFixture()
    const client = new ThreadMessageHydrationClient(async () => {
      const worker = new Worker(pageWorkerPath)
      worker.on("message", response => {
        if (response.type === "read-page-result" && response.ok)
          response.page.messages[0].content = "incorrect Worker display"
      })
      return worker
    }, () => paths.database)
    cleanups.push(() => client.close())
    await expect(client.readPage(f.threadId, { limit: 1 }, undefined,
      { assertCurrent: f.current, verify: f.verify })).rejects.toThrow()
  })

  it("rejects a membership removed by the source after an actual checkpoint Worker read", async () => {
    const f = await checkpointFixture()
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    await expect(client.readLatestTuple(f.saverPath, f.threadId, "", {
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: f.checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        f.checkpoint.id, () => {
          f.current()
          f.database.run("DELETE FROM function_conversation_checkpoint_members WHERE uuid=?", [f.uuid])
        }) })).rejects.toThrow()
  })

  it("keeps a genuine unmarked and ID-less checkpoint on the original bounded Worker path", async () => {
    const f = await checkpointFixture()
    const checkpoint = { ...f.checkpoint, id: randomUUID(),
      ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(), channel_values: {
      messages: [new HumanMessage("unmarked ID-less history"), new AIMessage("ordinary legacy reply")]
    } }
    await f.saver.put(f.config, checkpoint, { source: "loop", step: 2, parents: {} })
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const tuple = await client.readLatestTuple(f.saverPath, f.threadId, "", {
      nativeDisplay: { messageDatabasePath: paths.database, threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace, incarnation: f.incarnation,
        checkpointId: checkpoint.id }, assertSource: f.current,
      verifyDisplay: value => verifyCanonicalCheckpointWorkerDisplay(value, f.threadId,
        checkpoint.id, f.current) })
    expect(JSON.stringify(tuple)).toContain("unmarked ID-less history")
    expect(JSON.stringify(tuple)).toContain("ordinary legacy reply")
  })

  it("decodes a real Saver undefined channel without rewriting the ordinary checkpoint", async () => {
    const f = await checkpointFixture()
    const checkpoint = {
      ...f.checkpoint,
      id: randomUUID(),
      ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(),
      channel_values: {
        messages: [
          new HumanMessage("ordinary undefined-state request"),
          new AIMessage("ordinary undefined-state reply")
        ],
        [FUNCTION_CONVERSATION_CHANNEL]: undefined
      }
    }
    expect(Object.hasOwn(checkpoint.channel_values, FUNCTION_CONVERSATION_CHANNEL)).toBe(true)
    await f.saver.put(f.config, checkpoint, { source: "loop", step: 2, parents: {} })
    const before = createHash("sha256").update(readFileSync(f.saverPath)).digest("hex")
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    const tuple = await client.readLatestTuple(f.saverPath, f.threadId, "", {
      nativeDisplay: {
        messageDatabasePath: paths.database,
        threadId: f.threadId,
        workspace: f.runtime.target.ref.workspace,
        incarnation: f.incarnation,
        checkpointId: checkpoint.id
      },
      assertSource: f.current,
      verifyDisplay: (value) =>
        verifyCanonicalCheckpointWorkerDisplay(value, f.threadId, checkpoint.id, f.current)
    })
    expect(JSON.stringify(tuple)).toContain("ordinary undefined-state request")
    expect(JSON.stringify(tuple)).toContain("ordinary undefined-state reply")
    expect(createHash("sha256").update(readFileSync(f.saverPath)).digest("hex")).toBe(before)
  })

  it.each([
    { lc: 1, type: "undefined" },
    { lc: 2, type: "null" },
    { lc: 2, type: "undefined", extra: true },
    JSON.parse('{"lc":2,"type":"undefined","__proto__":{}}') as Record<string, unknown>
  ])("rejects a malformed serialized state instead of treating it as absent: %j", async (state) => {
    const f = await checkpointFixture()
    const checkpoint = {
      ...f.checkpoint,
      id: randomUUID(),
      ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(),
      channel_values: {
        messages: [new HumanMessage("ordinary malformed-state request")],
        [FUNCTION_CONVERSATION_CHANNEL]: state
      }
    }
    await f.saver.put(f.config, checkpoint, { source: "loop", step: 2, parents: {} })
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    await expect(
      client.readLatestTuple(f.saverPath, f.threadId, "", {
        nativeDisplay: {
          messageDatabasePath: paths.database,
          threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace,
          incarnation: f.incarnation,
          checkpointId: checkpoint.id
        },
        assertSource: f.current,
        verifyDisplay: (value) =>
          verifyCanonicalCheckpointWorkerDisplay(value, f.threadId, checkpoint.id, f.current)
      })
    ).rejects.toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
  })

  it("rejects a genuine function stamp without membership even with a serialized undefined state", async () => {
    const f = await checkpointFixture()
    const checkpoint = {
      ...f.checkpoint,
      id: randomUUID(),
      ts: new Date(Date.parse(f.checkpoint.ts) + 1).toISOString(),
      channel_values: {
        messages: [f.saved.result.message],
        [FUNCTION_CONVERSATION_CHANNEL]: undefined
      }
    }
    await f.saver.put(f.config, checkpoint, { source: "loop", step: 2, parents: {} })
    const client = new CheckpointRuntimeProjectionClient(async () => new Worker(runtimeWorkerPath))
    cleanups.push(() => client.close())
    await expect(
      client.readLatestTuple(f.saverPath, f.threadId, "", {
        nativeDisplay: {
          messageDatabasePath: paths.database,
          threadId: f.threadId,
          workspace: f.runtime.target.ref.workspace,
          incarnation: f.incarnation,
          checkpointId: checkpoint.id
        },
        assertSource: f.current,
        verifyDisplay: (value) =>
          verifyCanonicalCheckpointWorkerDisplay(value, f.threadId, checkpoint.id, f.current)
      })
    ).rejects.toThrow()
  })
  it("rejects a real Worker response after the source changes a sealed column", async () => {
    const f = await checkpointFixture()
    const client = new ThreadMessageHydrationClient(async () => new Worker(pageWorkerPath), () => paths.database)
    cleanups.push(() => client.close())
    await expect(client.readPage(f.threadId, { limit: 1 }, undefined, { assertCurrent: f.current,
      verify(witnesses) {
        expect(witnesses).toHaveLength(1)
        f.database.run("UPDATE thread_messages SET created_at=created_at+1 WHERE thread_id=? AND message_id=?",
          [f.threadId, f.uuid])
        f.verify(witnesses)
      } })).rejects.toThrow()
  })

  it("rejects a deleted marker instead of classifying an actual sealed row as legacy", async () => {
    const f = await checkpointFixture()
    f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
      [f.threadId, f.uuid])
    const client = new ThreadMessageHydrationClient(async () => new Worker(pageWorkerPath), () => paths.database)
    cleanups.push(() => client.close())
    await expect(client.readPage(f.threadId, { limit: 1 }, undefined,
      { assertCurrent: f.current, verify: f.verify })).rejects.toThrow()
  })

  it("never executes accessors or Proxy traps to form a stored constructor or wire digest", () => {
    let getters = 0, traps = 0
    const object = Object.defineProperty({}, "content", { enumerable: true,
      get() { getters++; return "secret" } })
    expect(() => copyCanonicalCheckpointDisplayJson(object, () => undefined)).toThrow()
    expect(() => canonicalDisplayValueDigest(object)).toThrow()
    const proxy = new Proxy({}, { ownKeys() { traps++; return [] },
      getPrototypeOf() { traps++; return null } })
    expect(() => copyCanonicalCheckpointDisplayJson(proxy, () => undefined)).toThrow()
    expect(() => canonicalDisplayValueDigest(proxy)).toThrow()
    expect(getters).toBe(0)
    expect(traps).toBe(0)
  })

  it("preserves original JSON bytes for nested fields and real native serialized metadata", () => {
    const native = new HumanMessage({ id: randomUUID(), content: [{ type: "text", text: "visible" }],
      additional_kwargs: { first: { alpha: 1, beta: { left: true, right: ["one", "two"] } },
        second: "original metadata order" },
      response_metadata: { provider: "actual", index: 1 } })
    const bytes = [
      '{"first":{"alpha":1,"beta":{"left":true,"right":["one","two"]}},"second":2}',
      '{"literal":{"lc":2,"type":"undefined"},"array":[{"lc":2,"type":"undefined"}]}',
      JSON.stringify(native.toDict()), serializeFunctionConversationNativeMessage(native)
    ]
    for (const original of bytes) {
      const copied = copyCanonicalCheckpointDisplayJson(JSON.parse(original), () => undefined)
      expect(JSON.stringify(copied)).toBe(original)
    }
  })

  it("fully fingerprints a shared canonical stamp just like its independently copied values", async () => {
    const f = await checkpointFixture(), source = await f.prepare()
    withFunctionConversationCanonicalDisplay(source, view => {
      const message = view.read(1), stamp = message?.function_row
      if (!message || !stamp) throw Error("ACTUAL_CANONICAL_STAMP_REQUIRED")
      const display = { ...message, additional_kwargs: { function_row: stamp } }
      const copied = structuredClone(display)
      copied.additional_kwargs.function_row = structuredClone(stamp)
      expect(canonicalDisplayValueDigest(display)).toBe(canonicalDisplayValueDigest(copied))
      expect(canonicalDisplayValueDigest({ date: message.created_at, repeated: message.created_at }))
        .toBe(canonicalDisplayValueDigest({ date: new Date(message.created_at.getTime()),
          repeated: new Date(message.created_at.getTime()) }))
    })
  })

  it("rejects a true cycle without mistaking raw task-shaped data for its private exit task", () => {
    const value: Record<string, unknown> = { kind: "exit", object: { visible: true } }
    expect(canonicalDisplayValueDigest(value)).toBe(canonicalDisplayValueDigest(structuredClone(value)))
    value.self = value
    expect(() => canonicalDisplayValueDigest(value)).toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
  })

  it("counts every repeated subtree against the original total expanded-node budget", () => {
    let value: unknown = { original: "complete repeated value" }
    for (let depth = 0; depth < 20; depth++) value = { left: value, right: value }
    expect(() => canonicalDisplayValueDigest(value)).toThrow("MODS_CONVERSATION_DISPLAY_SOURCE_INVALID")
  })

  it("checks exact column witnesses without changing any canonical Keeper or full native payload", async () => {
    const f = await checkpointFixture()
    const witness = { messageId: f.uuid, columnsDigest: canonicalDisplayColumnsDigest(f.saved.columns) }
    f.verify([witness])
    expect(() => f.verify([{ ...witness, columnsDigest: "copied" }])).toThrow()
    expect(f.saved.result.row.nativePayload).toContain("private engine context")
  })
})
