import { readFunctionConversationState } from "../../checkpointer/function-conversation-state"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, Command, interrupt, StateGraph, START, END } from "@langchain/langgraph"
import { tool } from "@langchain/core/tools"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"
import { ModsManager } from "../manager"
import { currentFunctionExecution } from "./execution-context"
import { FunctionConversationCoordinator, readFunctionConversationSharedNativeRegistration,
  type FunctionConversationSharedNativeRegistration } from "./conversation-coordinator"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { FunctionConversationChildFamilies } from "./conversation-child-family"
import type { FunctionConversationCallContext } from "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import type { SqlJsSaverPreparedCheckpointDescriptor } from "../../checkpointer/sqljs-saver"
import { FunctionConversationDeliveryBridge } from "../../checkpointer/function-conversation-delivery"
import { functionConversationCanonicalStamp, functionConversationRowDigest,
  functionConversationMembershipDigest } from "../../checkpointer/function-conversation-checkpoint-membership"
import { captureDefaultCheckpointMetadataCodec } from "../../checkpointer/checkpoint-metadata-codec"
import { serializeFunctionConversationNativeMessage, deserializeFunctionConversationNativeMessage } from
  "../../agent/function-conversation-native-message"
import { currentSharedNativeDomainRecord } from "../../agent/function-conversation-shared-native-domain"
import { createFunctionConversationMiddleware } from "../../agent/mods-conversation"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import * as conversationIntake from "../../agent/mods-conversation"
import * as sharedInvocation from "../../agent/mods-conversation-shared-invocation"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent } from
  "../../agent/mods-conversation-shared-invocation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import type { FunctionConversationSharedCheckpointScope } from "./conversation-shared-checkpointer"
import * as sharedCheckpoint from "./conversation-shared-checkpointer"
import * as sharedRestore from "./conversation-shared-restore"
import * as sharedSource from "./conversation-shared-source-current"
import * as nativeDestination from "../../db/function-conversation-native-destination"
import { types as nativeDestinationTypes } from "node:util"
import { ModRuntimeAuthorities, isModRuntimeAuthorityDataCurrent,
  type ModRuntimeAuthority } from "../runtime-instance"
import { createNativeConversationStreamProjection } from
  "../../agent/native-conversation-stream-projection"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../../db"

function settleTestWork(work: Promise<void>): Promise<void> {
  onTestFinished(() => work)
  return work
}

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-cold-restore-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Actual createAgent/Manager/router/SQLite. Fake model is not a production HTTP claim. */
async function fixture(holdModel?: Promise<void>, checks?: {
  guard?(): void
  physicalGuard?(): void
  beforeModel?(authority: ModRuntimeAuthority): void
  beforeNativeGenerate?(): void
}, options?: { native?: boolean; noNotes?: boolean; afterCutNote?: boolean
  noticeCount?: number; splitNotes?: boolean; extraNoteCount?: number
  isRestoring?(): boolean; terminalEnd?: boolean }) {
  const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
    () => [], async () => true, () => {})
  manager.configure(directory, true, false)
  const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
  const signal = new AbortController().signal
  appDb.createThread(threadId, { workspacePath: workspace })
  expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId, signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId, signal,
    runtimeAuthority: parent.authority,
    ...(checks?.physicalGuard ? { assertLive: checks.physicalGuard } : {}) })
  const originalGuard = manager.captureFunctionRuntimeGuard(parent.authority)
  const guard = () => { originalGuard(); checks?.guard?.() }
  const store = new FunctionConversationStore(appDb.getDb())
  const context: FunctionConversationCallContext = { owner: {},
    plugin: { name: "actual-cold-fixture-plugin" } as FunctionPlugin,
    workspace, threadId, readOnly: false, signal, assertCurrent: guard }
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, protectionSignal, check) => {
      protectionSignal.throwIfAborted(); check(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => {}
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner(context)
  const checkpointPath = join(directory, `${randomUUID()}.graph.sqlite`)
  const saver = new SqlJsSaver(checkpointPath, undefined,
    { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 30,
      maxRootForkBoundaryBytes: 48 * 1024 * 1024 })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(parent.authority, signal)
  const bindings: FunctionConversationGraphBinding[] = [], requests: BaseMessage[][] = []
  const notes: string[] = [], agents: string[] = [], turns: string[] = []
  const scopes: FunctionConversationSharedCheckpointScope[] = []
  const beforeModelSources: Array<{ scope: FunctionConversationSharedCheckpointScope
    authority: ModRuntimeAuthority; messages: BaseMessage[] }> = []
  const coldRequests: Array<{ scope: FunctionConversationSharedCheckpointScope
    authority: ModRuntimeAuthority; messages: BaseMessage[] }> = []
  const nativeRuntimes: Array<{ authority: ModRuntimeAuthority
    runtime: NonNullable<ReturnType<ModsManager["captureFunctionNativeConversationRuntime"]>> }> = []
  const providerAuthorities: Array<ModRuntimeAuthority | undefined> = []
  const afterCutNotes: string[] = [], afterCutAppends: Promise<string>[] = []
  let toolEffects = 0, providerCalls = 0
  const originalGenerate = FakeToolCallingModel.prototype._generate
  const provider = options?.native ? vi.spyOn(FakeToolCallingModel.prototype, "_generate")
    .mockImplementation(function (this: FakeToolCallingModel, ...args) {
      // Observe the actual provider without adding a new authorization/throw boundary.
      providerAuthorities.push(currentFunctionExecution()?.runtimeAuthority)
      providerCalls++
      checks?.beforeNativeGenerate?.()
      return Reflect.apply(originalGenerate, this, args)
    }) : undefined
  const appendNote = async (authority: ModRuntimeAuthority): Promise<string> => {
    const result = await coordinator.appendSession(context,
      { agentId: authority.agentId, message: { type: "user",
        content: [{ type: "text", text: `note from actual current run ${notes.length + 1}` }] } },
      { identity: {}, signal, assertCurrent: guard }, ticket => ticket.core(ticket.input))
    if (typeof result.uuid !== "string") throw Error("ACTUAL_NOTE_UUID_REQUIRED")
    notes.push(result.uuid)
    return result.uuid
  }
  const appendNotice = async (authority: ModRuntimeAuthority) => {
    const result = await coordinator.appendSession(context,
      { agentId: authority.agentId, message: { type: "system",
        content: [{ type: "text", text: "Actual non-intake notice between global note sequences" }] } },
      { identity: {}, signal, assertCurrent: guard }, ticket => ticket.core(ticket.input))
    if (typeof result.uuid !== "string") throw Error("ACTUAL_NOTICE_UUID_REQUIRED")
    return result.uuid
  }
  let checkpointBeforeTools = "", terminalIntakeCalls = 0
  const capture = () => {
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
    return manager.captureFunctionConversationSharedScope(authority)
  }
  const record = createMiddleware({ name: "actual-cold-child-producer",
    beforeModel: async (_state, runtime) => {
      const authority = currentFunctionExecution()?.runtimeAuthority, scope = capture()
      if (!authority || !scope) throw Error("ACTUAL_NATIVE_SCOPE_REQUIRED")
      checks?.beforeModel?.(authority)
      if (options?.isRestoring) beforeModelSources.push({ scope, authority, messages: [..._state.messages] })
      turns.push(authority.turnId)
      bindings.push(scope.captureNode(runtime))
      if (!options?.noNotes) await appendNote(authority)
      if (turns.length === 1) {
        for (let index = 0; index < (options?.noticeCount ?? 0); index++) await appendNotice(authority)
        if (options?.splitNotes) await appendNote(authority)
        for (let index = 0; index < (options?.extraNoteCount ?? 0); index++) await appendNote(authority)
      }
      return undefined
    },
    wrapModelCall: async (request, handler) => {
      const scope = capture()
      if (!scope) throw Error("ACTUAL_NATIVE_SCOPE_REQUIRED")
      scopes.push(scope)
      requests.push([...request.messages])
      const restoring = options?.isRestoring?.() === true
      if (restoring) {
        const authority = currentFunctionExecution()?.runtimeAuthority, hot = beforeModelSources[0]
        if (!authority || !hot || scope === hot.scope || authority === hot.authority || !hot.scope.isClosed())
          throw Error("NOT_MET: actual fresh pending invocation required")
        coldRequests.push({ scope, authority, messages: [...request.messages] })
      }
      const firstAfterCutRequest = options?.isRestoring
        ? restoring && coldRequests.length === 1 : requests.length === 2
      if (options?.afterCutNote && firstAfterCutRequest) {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (!authority) throw Error("ACTUAL_AFTER_CUT_AUTHORITY_REQUIRED")
        // This real arrival is after the model request captured its admitted input cut.
        // It does not claim there was already a future note at restore admission.
        const appending = appendNote(authority)
        afterCutAppends.push(appending)
        afterCutNotes.push(await appending)
      }
      if (!restoring && requests.length === 1) await holdModel
      return handler(request)
    },
    afterModel: () => {
      if (requests.length === 1) interrupt("actual shared task pause before its original ToolNode")
      return undefined
    }
  })
  const conversation = createFunctionConversationMiddleware({ store,
    capture: runtime => capture()?.captureNode(runtime) })
  const originalIntake = conversation.beforeModel
  const intake = options?.terminalEnd ? createMiddleware({ ...conversation, beforeModel: {
    canJumpTo: ["end"], hook: async (state, runtime) => {
      if (typeof originalIntake !== "function") throw Error("ACTUAL_INTAKE_HOOK_REQUIRED")
      const update = await Reflect.apply(originalIntake, conversation, [state, runtime])
      terminalIntakeCalls++
      return { ...update, jumpTo: "end" }
    }
  } }) : conversation
  const child = createFunctionConversationSharedAgent({
    model: new FakeToolCallingModel({ toolCalls: [[{ id: "actual-resumed-tool-call",
      name: "actual_restore_tool", args: {} }], [], []] }),
    tools: [tool(() => { toolEffects++; return "Actual original tool result" },
      { name: "actual_restore_tool", description: "Real fixture ToolNode action", schema: z.object({}) })],
    systemPrompt: "Actual shared task", middleware: [record, intake]
  }, capture, options?.native ? { store, agentId: "actual-cold-native",
    model: "actual-cold-native-model",
    captureRuntime: authority => {
      const runtime = manager.captureFunctionNativeConversationRuntime(authority)
      if (runtime) nativeRuntimes.push({ authority, runtime })
      return runtime
    }, flush: runtime => runtime.assertCurrent() } : undefined)
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
    reducer: (_old, incoming) => incoming, default: () => [] }) })
  const graph = new StateGraph(state).addNode("native-tools", async (_state, config) => {
    const actual = config.configurable?.checkpoint_map?.[""]
    if (typeof actual !== "string" || !actual) throw Error("ACTUAL_PARENT_CHECKPOINT_REQUIRED")
    if (!checkpointBeforeTools) checkpointBeforeTools = actual
    const agentId = `mod-task:${randomUUID()}`
    agents.push(agentId)
    const result = await manager.withSharedAgent(parent.authority, agentId, signal,
      { blockedToolNames: new Set(), readOnly: false },
      () => child.invoke({ messages: [new HumanMessage("actual task seed")] }, config),
      runId, { type: "same-role", description: "actual task seed" },
      { invocation: Object.freeze({}), saver, config: captureFunctionConversationNativeTaskConfig(config) })
    expect(result).not.toHaveProperty("cmbFunctionConversation")
    return { messages: options?.terminalEnd ? result.messages : result.messages.slice(-1) }
  }).addEdge(START, "native-tools").addEdge("native-tools", END).compile({ checkpointer: saver })
  const start = () => graph.invoke({ messages: [new HumanMessage("actual parent seed")] },
    { configurable: { thread_id: threadId }, durability: "async" })
  // Resume the actual interrupted native task, not a completed graph or a guessed child namespace.
  const restore = () => graph.invoke(new Command({ resume: "continue actual original tool" }),
    { configurable: { thread_id: threadId,
    checkpoint_id: checkpointBeforeTools }, durability: "async" })
  const replayPending = () => graph.invoke(null, { configurable: { thread_id: threadId,
    checkpoint_id: checkpointBeforeTools }, durability: "async" })
  const close = async () => {
    closeOwner(); unbind(); parent.release(); manager.close()
    releaseLocalThreadRunLease(threadId, "desktop", runId)
    try { await saver.close() }
    finally { provider?.mockRestore() }
  }
  return { manager, store, saver, graph, parent, workspace, signal, runId,
    checkpointPath, threadId, bindings, requests, notes, agents, turns, scopes,
    beforeModelSources, coldRequests,
    start, restore, replayPending, close, toolEffects: () => toolEffects,
    providerCalls: () => providerCalls, nativeRuntimes, providerAuthorities,
    afterCutNotes, afterCutAppends, terminalIntakeCalls: () => terminalIntakeCalls }
}

/** Reproduce a real terminal COMMIT/ACK gap without inventing an SDK task or checkpoint. */
async function terminalRestoreCase(attack?: "admitted" | "close-during-read") {
  const held = Promise.withResolvers<NonNullable<Awaited<ReturnType<SqlJsSaver["getTuple"]>>>>()
  const release = Promise.withResolvers<void>()
  const marker = Error("ACTUAL_TERMINAL_ADMISSION_FAILED")
  let restoring = false, claimed = false, admittedCalls = 0, readEntries = 0
  let hotScope: FunctionConversationSharedCheckpointScope | undefined
  let coldScope: FunctionConversationSharedCheckpointScope | undefined
  const f = await fixture(undefined, undefined,
    { native: true, terminalEnd: true, isRestoring: () => restoring })
  const originalWrap = FunctionConversationDeliveryBridge.prototype.wrap
  const wrapSpy = vi.spyOn(FunctionConversationDeliveryBridge.prototype, "wrap")
    .mockImplementation(function (this: FunctionConversationDeliveryBridge,
      saver, assertCurrent, onCommitted, hooks) {
      if (saver !== f.saver || restoring || claimed)
        return originalWrap.call(this, saver, assertCurrent, onCommitted, hooks)
      return originalWrap.call(this, saver, assertCurrent, onCommitted, { ...hooks,
        observed: async receipt => {
          await hooks?.observed?.(receipt)
          const tuple = SqlJsSaver.prototype.readCommittedCheckpoint.call(saver, receipt)
          const raw = tuple.checkpoint.channel_values.cmbFunctionConversation
          if (!raw || readFunctionConversationState(raw).frontier !== 1 || claimed) return
          const target = f.bindings[0]?.target
          if (!target || tuple.config.configurable?.thread_id !== f.threadId ||
            tuple.config.configurable.checkpoint_ns !== target.checkpointNamespace)
            throw Error("ACTUAL_TERMINAL_COMMIT_TARGET_REQUIRED")
          claimed = true
          hotScope = f.beforeModelSources[0]?.scope
          if (!hotScope) throw Error("ACTUAL_TERMINAL_SCOPE_REQUIRED")
          held.resolve(tuple)
          await release.promise
        }
      })
    })
  const originalAdmit = sharedInvocation.admitFunctionConversationSharedNativeInvocation
  const admitSpy = vi.spyOn(sharedInvocation, "admitFunctionConversationSharedNativeInvocation")
    .mockImplementation((scope, producer, authority) => {
      originalAdmit(scope, producer, authority)
      if (!restoring || authority.threadId !== f.threadId) return
      const domain = currentSharedNativeDomainRecord()
      expect(domain?.scope).toBe(scope)
      expect(domain?.phase).toBe("ready")
      expect(domain?.view).toBeDefined()
      coldScope = scope
      admittedCalls++
      if (attack === "admitted") throw marker
    })
  const originalGetTuple = SqlJsSaver.prototype.getTuple
  let selectedPoint = "", namespace = "", childPuts = 0
  const getSpy = vi.spyOn(SqlJsSaver.prototype, "getTuple").mockImplementation(
    function (this: SqlJsSaver, config) {
      const domain = currentSharedNativeDomainRecord()
      if (attack === "close-during-read" && restoring && this === f.saver &&
        domain?.phase === "ready" && config.configurable?.thread_id === f.threadId &&
        config.configurable.checkpoint_ns === namespace &&
        config.configurable.checkpoint_id === selectedPoint) {
        expect(readEntries).toBe(0)
        expect(domain.scope).toBe(coldScope)
        expect(domain.original?.scope).toBe(coldScope)
        readEntries++
        domain.scope.close()
      }
      // Preserve the actual second native read and its original post-await guards.
      return Reflect.apply(originalGetTuple, this, [config])
    })
  const originalPut = SqlJsSaver.prototype.put
  const putSpy = vi.spyOn(SqlJsSaver.prototype, "put").mockImplementation(
    function (this: SqlJsSaver, config, ...args) {
      if (restoring && this === f.saver && config.configurable?.checkpoint_ns === namespace)
        childPuts++
      return Reflect.apply(originalPut, this, [config, ...args])
    })
  const originalObservedPut = SqlJsSaver.prototype.putWithCommitObserver
  const observedPutSpy = vi.spyOn(SqlJsSaver.prototype, "putWithCommitObserver").mockImplementation(
    function (this: SqlJsSaver, config, ...args) {
      if (restoring && this === f.saver && config.configurable?.checkpoint_ns === namespace)
        childPuts++
      return Reflect.apply(originalObservedPut, this, [config, ...args])
    })
  let running: Promise<unknown> | undefined
  try {
    running = f.start()
    void running.catch(() => undefined)
    const tuple = await Promise.race([held.promise, running.then(() => {
      throw Error("NOT_MET: terminal observed COMMIT was not held")
    })])
    selectedPoint = tuple.checkpoint.id
    const target = f.bindings[0].target, binding = f.bindings[0]
    namespace = target.checkpointNamespace
    expect(namespace).not.toBe("")
    expect(claimed).toBe(true)
    expect(f.terminalIntakeCalls()).toBe(1)
    expect(f.requests).toEqual([])
    expect(f.providerCalls()).toBe(0)
    expect(f.toolEffects()).toBe(0)
    expect(f.notes).toHaveLength(1)
    const messages = tuple.checkpoint.channel_values.messages as BaseMessage[]
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe("actual task seed")
    expect(messages[1].id).toBe(f.notes[0])
    const payloads = messages.map(serializeFunctionConversationNativeMessage)
    const stamps = messages.map(message => message.additional_kwargs.function_row)
    const database = appDb.getDb()
    const point = { checkpointThreadId: f.threadId,
      checkpointIncarnation: binding.checkpointIncarnation!, checkpointId: selectedPoint }
    const snapshot = f.store.readCheckpointRecoverySnapshot(target, point,
      () => binding.assertCurrent()).snapshot
    expect(snapshot.checkpointId).toBe(selectedPoint)
    expect(snapshot.frontier).toBe(1)
    expect(snapshot.nativeMessageCount).toBe(2)
    expect(snapshot.members).toHaveLength(1)
    expect(snapshot.members[0].uuid).toBe(f.notes[0])
    expect(snapshot.members[0].ordinal).toBe(1)
    expect(snapshot.members[0].sequence).toBe(1)
    const canonical = f.store.readRows(target)
    expect(canonical).toHaveLength(1)
    expect(canonical[0].nativePayload).toBe(payloads[1])
    expect(stamps[1]).toEqual(functionConversationCanonicalStamp(target, canonical[0]))
    expect(snapshot.members[0]).toEqual({ ordinal: 1, uuid: canonical[0].uuid,
      sequence: canonical[0].sequence, branchId: canonical[0].branchId,
      rowReceiptId: canonical[0].receiptId, rowDigest: functionConversationRowDigest(canonical[0]),
      stampDigest: functionConversationMembershipDigest(stamps[1]),
      nativeDigest: functionConversationMembershipDigest(canonical[0].nativePayload),
      createdAt: canonical[0].createdAt })
    expect(snapshot.cut.highWater).toBe(1)
    expect(snapshot.cut.lineage.some(entry => entry.branchId === canonical[0].branchId &&
      canonical[0].sequence <= entry.cut)).toBe(true)
    const inbox = () => database.exec(`SELECT uuid FROM function_conversation_inbox
      WHERE conversation_id=? ORDER BY uuid`, [target.conversationId])[0].values
    const deliveries = () => database.exec(`SELECT checkpoint_id,frontier
      FROM function_conversation_deliveries WHERE conversation_id=? ORDER BY checkpoint_id`,
      [target.conversationId])[0].values
    expect(inbox()).toEqual([[f.notes[0]]])
    expect(deliveries()).toEqual([])
    const rawData = () => ({
      receipt: database.exec(`SELECT * FROM function_conversation_checkpoint_receipts
        WHERE conversation_id=? AND checkpoint_thread_id=? AND checkpoint_namespace=?
        AND checkpoint_id=?`, [target.conversationId, f.threadId, namespace, selectedPoint]),
      members: database.exec(`SELECT m.* FROM function_conversation_checkpoint_members m
        JOIN function_conversation_checkpoint_receipts r ON r.receipt_id=m.receipt_id
        WHERE r.conversation_id=? AND r.checkpoint_thread_id=? AND r.checkpoint_namespace=?
        AND r.checkpoint_id=? ORDER BY m.ordinal`,
        [target.conversationId, f.threadId, namespace, selectedPoint]),
      rows: database.exec(`SELECT * FROM function_conversation_rows WHERE conversation_id=?
        ORDER BY sequence,uuid`, [target.conversationId])
    })
    const beforeData = rawData()
    expect(beforeData.receipt[0].values).toHaveLength(1)
    expect(beforeData.members[0].values).toHaveLength(1)
    expect(beforeData.rows[0].values).toHaveLength(1)
    const checkpointDb = Reflect.get(f.saver, "db") as
      import("../../db/native-sqlite-adapter").NativeSqliteAdapter
    const childPoints = () => checkpointDb.exec(`SELECT checkpoint_id,parent_checkpoint_id,type,
      checkpoint,metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=?
      ORDER BY checkpoint_id`, [f.threadId, namespace])
    const beforePoints = childPoints()
    expect(beforePoints[0].values.some(row => row[0] === selectedPoint)).toBe(true)
    hotScope!.close()
    release.resolve()
    await expect(running).rejects.toThrow()
    await hotScope!.whenDrained()
    expect(hotScope!.isClosed()).toBe(true)
    expect(inbox()).toEqual([[f.notes[0]]])
    expect(deliveries()).toEqual([])
    expect(childPoints()).toEqual(beforePoints)
    restoring = true
    const replay = f.replayPending()
    if (attack) {
      if (attack === "admitted") await expect(replay).rejects.toBe(marker)
      else await expect(replay).rejects.toThrow()
      expect(admittedCalls).toBe(1)
      expect(readEntries).toBe(attack === "close-during-read" ? 1 : 0)
      expect(coldScope?.isClosed()).toBe(true)
      await coldScope!.whenDrained()
    } else {
      const result = await replay
      expect(admittedCalls).toBe(1)
      const actual = result.messages as BaseMessage[]
      expect(actual.map(serializeFunctionConversationNativeMessage)).toEqual(payloads)
      expect(actual.map(message => message.additional_kwargs.function_row)).toEqual(stamps)
      expect(actual.map(message => message.id)).toEqual(messages.map(message => message.id))
    }
    // Qualify the original terminal replay before checking the missing ACK regression.
    expect(childPuts).toBe(0)
    expect(childPoints()).toEqual(beforePoints)
    expect(f.terminalIntakeCalls()).toBe(1)
    expect(f.requests).toEqual([])
    expect(f.providerCalls()).toBe(0)
    expect(f.toolEffects()).toBe(0)
    expect(f.store.readRows(target)).toEqual(canonical)
    expect(rawData()).toEqual(beforeData)
    expect(f.agents).toHaveLength(2)
    expect(new Set(f.agents).size).toBe(2)
    f.parent.authority.assertLive()
    if (attack) {
      expect(inbox()).toEqual([[f.notes[0]]])
      expect(deliveries()).toEqual([])
    } else {
      expect(inbox()).toEqual([])
      expect(deliveries()).toEqual([[selectedPoint, 1]])
      expect(f.store.readCheckpointRecoverySnapshot(target, point,
        () => f.parent.authority.assertLive()).snapshot).toEqual(snapshot)
    }
    expect(rawData()).toEqual(beforeData)
  } finally {
    release.resolve()
    hotScope?.close()
    coldScope?.close()
    await running?.catch(() => undefined)
    await hotScope?.whenDrained()
    await coldScope?.whenDrained()
    admitSpy.mockRestore()
    getSpy.mockRestore()
    putSpy.mockRestore()
    observedPutSpy.mockRestore()
    wrapSpy.mockRestore()
    await f.close()
  }
}

describe("actual shared child checkpoint restore admission", () => {
  it("acknowledges the retained terminal checkpoint without running a new child task", () =>
    settleTestWork(terminalRestoreCase()))
  it.each(["admitted", "close-during-read"] as const)(
    "does not acknowledge terminal history after %s fails", attack =>
      settleTestWork(terminalRestoreCase(attack)))
  it.each(["unknown-token", "cloned-token", "cloned-target", "foreign-target"] as const)(
    "rejects a historical %s before the projection's first source callback", async attack => {
      let checking = false, sourceCalls = 0, checked = false
      const f = await fixture(undefined, { guard() { if (checking) sourceCalls++ } })
      const complete = sharedRestore.completeFunctionConversationSharedActive
      const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
        .mockImplementation((...args) => {
          const producer = complete(...args)
          if (!producer || checked || !args[1].restore) return producer
          const view = sharedRestore.readFunctionConversationSharedProducer(producer, args[1].authority)
          const history = view.history
          if (!history) return producer
          const originalToken = history.historicalTarget
          if (!originalToken) throw Error("ACTUAL_HISTORY_TARGET_REQUIRED")
          const token = attack === "unknown-token" ? Object.freeze({}) :
            attack === "cloned-token" ? Object.freeze({ ...originalToken }) : originalToken
          const target = attack === "cloned-target"
            ? Object.freeze({ ...view.target.ref, incarnation: Object.freeze({ ...view.target.ref.incarnation }) })
            : attack === "foreign-target" ? f.bindings[0].target : view.target.ref
          const projection = createNativeConversationStreamProjection({ store: f.store,
            runtime: { owner: view.owner, run: view.invocation, database: view.database,
              target: Object.freeze({ ...view.target, ref: target }),
              destination: { conversation: view.target.ref,
                threadId: view.destination.destinationThreadId,
                incarnation: view.destination.destinationIncarnation, assertCurrent: view.assertCurrent },
              signal: view.signal, assertCurrent: view.assertCurrent } })
          try {
            checking = true
            expect(() => projection.registerHistorical(history.messages, history.membership,
              token as sharedRestore.FunctionConversationSharedHistoricalTarget)).toThrow()
            expect(sourceCalls).toBe(0)
            const original = sharedRestore.readFunctionConversationSharedHistoricalTarget(
              originalToken, history.messages, history.membership, f.store, view.target.ref)
            expect(original.target).not.toBe(view.target.ref)
            original.assertDataCurrent()
            expect(sourceCalls).toBe(0)
            checked = true
          } finally { checking = false; projection.close() }
          return producer
        })
      try {
        await f.start()
        await f.restore()
        expect(checked).toBe(true)
        expect(f.requests.length).toBeGreaterThan(1)
        expect(f.toolEffects()).toBe(1)
      } finally { checking = false; completeSpy.mockRestore(); await f.close() }
    })

  it("keeps a historical target bridge failed after the last original source retires its parent", async () => {
    let phase: "idle" | "count" | "attack" = "idle", calls = 0, lastCall = 0
    let attacked = false, checked = false
    let spyFailed = false, spyFailure: unknown, stage = "complete"
    const f = await fixture(undefined, { physicalGuard() {
      if (phase === "idle") return
      calls++
      if (phase === "attack" && calls === lastCall) { attacked = true; f.parent.release() }
    } })
    const complete = sharedRestore.completeFunctionConversationSharedActive
    const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
      .mockImplementation((...args) => {
        try {
          const producer = complete(...args)
          if (!producer || checked || !args[1].restore) return producer
          const view = sharedRestore.readFunctionConversationSharedProducer(producer, args[1].authority)
          const history = view.history
          if (!history?.historicalTarget) return producer
          const bridge = sharedRestore.readFunctionConversationSharedHistoricalTarget(
            history.historicalTarget, history.messages, history.membership, f.store, view.target.ref)
          stage = "baseline-full"
          phase = "count"
          bridge.assertCurrent()
          lastCall = calls
          expect(lastCall).toBeGreaterThan(0)
          calls = 0
          phase = "attack"
          stage = "last-source-retirement"
          expect(() => bridge.assertCurrent()).toThrow()
          expect(attacked).toBe(true)
          expect(calls).toBe(lastCall)
          phase = "idle"
          stage = "sticky-data"
          expect(() => bridge.assertDataCurrent()).toThrow()
          stage = "sticky-full"
          expect(() => bridge.assertCurrent()).toThrow()
          checked = true
          return producer
        } catch (error) {
          if (!spyFailed) { spyFailed = true; spyFailure = error }
          throw error
        }
      })
    try {
      await f.start()
      await expect(f.restore()).rejects.toThrow()
      if (spyFailed) {
        console.error("ACTUAL_HISTORY_RETIRE_FIRST_FAILURE", { stage, attacked, calls, lastCall })
        throw spyFailure
      }
      expect(checked).toBe(true)
      expect(f.requests).toHaveLength(1)
      expect(f.toolEffects()).toBe(0)
    } finally { phase = "idle"; completeSpy.mockRestore(); await f.close() }
  })

  it("rejects caught same-token projection reentry before its outer historical scope can publish", async () => {
    let enter: (() => void) | undefined, checked = false, reentered = false, nestedRejected = false
    let observing = false, calls = 0
    const f = await fixture(undefined, { guard() {
      if (observing) calls++
      if (!enter || reentered) return
      reentered = true
      try { enter() } catch { nestedRejected = true }
    } })
    const complete = sharedRestore.completeFunctionConversationSharedActive
    const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
      .mockImplementation((...args) => {
        const producer = complete(...args)
        if (!producer || checked || !args[1].restore) return producer
        const view = sharedRestore.readFunctionConversationSharedProducer(producer, args[1].authority)
        const history = view.history
        if (!history?.historicalTarget) throw Error("ACTUAL_HISTORY_TARGET_REQUIRED")
        const projection = createNativeConversationStreamProjection({ store: f.store,
          runtime: { owner: view.owner, run: view.invocation, database: view.database,
            target: view.target, destination: { conversation: view.target.ref,
              threadId: view.destination.destinationThreadId,
              incarnation: view.destination.destinationIncarnation, assertCurrent: view.assertCurrent },
            signal: view.signal, assertCurrent: view.assertCurrent } })
        const read = () => projection.registerHistorical(history.messages, history.membership,
          history.historicalTarget)
        try {
          enter = read
          expect(read).toThrow()
          expect(reentered).toBe(true)
          expect(nestedRejected).toBe(true)
          enter = undefined
          observing = true
          expect(read).toThrow()
          expect(calls).toBe(0)
          checked = true
        } finally { enter = undefined; observing = false; projection.close() }
        return producer
      })
    try {
      await f.start()
      await f.restore()
      expect(checked).toBe(true)
      expect(f.toolEffects()).toBe(1)
    } finally { enter = undefined; completeSpy.mockRestore(); await f.close() }
  })

  it("keeps the actual namespace reserved when native drain cannot prove its terminal work", async () => {
    let quarantined: FunctionConversationSharedCheckpointScope | undefined
    const f = await fixture(undefined, { beforeModel(authority) {
      quarantined = f.manager.captureFunctionConversationSharedScope(authority)
      if (!quarantined) throw Error("ACTUAL_SHARED_SCOPE_REQUIRED")
      quarantined.quarantineNativeWork()
      throw Error("ACTUAL_UNKNOWN_NATIVE_DRAIN")
    } })
    try {
      await expect(f.start()).rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
      if (!quarantined) throw Error("ACTUAL_QUARANTINED_SCOPE_REQUIRED")
      expect(quarantined.isClosed()).toBe(true)
      await expect(quarantined.whenDrained()).rejects.toThrow("MODS_CONVERSATION_NATIVE_NODE_DRAIN_UNKNOWN")
      expect(f.manager.captureFunctionConversationSharedScope(f.parent.authority)).toBeUndefined()
      expect(() => f.parent.authority.assertLive()).not.toThrow()
      await expect(f.replayPending()).rejects.toThrow("MODS_CONVERSATION_REGISTRATION_CONFLICT")
      expect(f.requests).toEqual([])
      expect(f.notes).toEqual([])
      expect(f.toolEffects()).toBe(0)
    } finally { await f.close() }
  })
  it.each([
    ["producer", "release-child"], ["producer", "replace-child"], ["producer", "release-parent"],
    ["registration", "release-child"], ["registration", "replace-child"],
    ["registration", "release-parent"]
  ] as const)(
    "rejects %s %s at the final original source callback", async (consumer, attack) => {
      const originals = new Map<ModRuntimeAuthority, ReturnType<ModRuntimeAuthorities["create"]>>()
      const create = ModRuntimeAuthorities.prototype.create
      const createSpy = vi.spyOn(ModRuntimeAuthorities.prototype, "create").mockImplementation(
        function (this: ModRuntimeAuthorities, ...args) {
          const value = Reflect.apply(create, this, args)
          originals.set(value.authority, value)
          return value
        })
      const producers = new Map<ModRuntimeAuthority, sharedRestore.FunctionConversationSharedProducer>()
      const registrations = new Map<ModRuntimeAuthority, {
        coordinator: FunctionConversationCoordinator
        registration: FunctionConversationSharedNativeRegistration
      }>()
      const complete = sharedRestore.completeFunctionConversationSharedActive
      const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
        .mockImplementation((...args) => {
          const proof = complete(...args)
          if (proof) producers.set(args[1].authority, proof)
          if (args[1].producer) registrations.set(args[1].authority, args[1].producer)
          return proof
        })
      let state: "idle" | "count" | "attack" = "idle", calls = 0, finalCall = 0
      let current: ModRuntimeAuthority | undefined, attacked = false, readRejected = false
      let dataRejected = false, observedCalls = 0
      let replacement: ReturnType<ModsManager["createRuntimeAuthority"]> | undefined
      const f = await fixture(undefined, {
        guard() {
          if (state === "idle") return
          calls++
          if (state !== "attack" || calls !== finalCall || !current) return
          attacked = true
          if (attack === "release-parent") f.parent.release()
          else if (attack === "release-child") originals.get(current)!.release()
          else replacement = f.manager.createRuntimeAuthority({ workspace: f.workspace,
            threadId: f.threadId, turnId: current.turnId, agentId: current.agentId })
        },
        beforeModel(authority) {
          current = authority
          const proof = producers.get(authority)
          const registration = registrations.get(authority)
          if (!proof || !registration) throw Error("ACTUAL_PRODUCER_REQUIRED")
          const read = () => consumer === "producer"
            ? sharedRestore.readFunctionConversationSharedProducer(proof, authority)
            : readFunctionConversationSharedNativeRegistration(registration.registration,
              registration.coordinator, authority)
          state = "count"
          const original = read()
          finalCall = calls
          expect(finalCall).toBeGreaterThan(0)
          calls = 0
          state = "attack"
          // This callback is the last genuine source callback of the same full read. The
          // child has no native runtime resource installed yet; cached family maps remain.
          try { read() }
          catch { readRejected = true }
          try { original.assertDataCurrent() }
          catch { dataRejected = true }
          observedCalls = calls
          state = "idle"
          throw Error("ACTUAL_PRODUCER_REVOKED")
        }
      })
      try {
        // The framework's final scope guard also observes the revoked authority; it may
        // replace the middleware error with its original expiration code during cleanup.
        await expect(f.start()).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
        expect(attacked).toBe(true)
        expect(observedCalls).toBe(finalCall)
        expect(readRejected).toBe(true)
        expect(dataRejected).toBe(true)
        expect(f.requests).toEqual([])
        expect(f.notes).toEqual([])
        expect(f.toolEffects()).toBe(0)
      } finally {
        state = "idle"
        replacement?.release()
        completeSpy.mockRestore()
        createSpy.mockRestore()
        await f.close()
      }
    })
  it("reuses original child and UI bucket with a new actual authority and complete canonical history", async () => {
    const f = await fixture()
    try {
      await f.start()
      expect(f.toolEffects()).toBe(0)
      const original = f.bindings[0].target
      const mapping = appDb.getDb().exec("SELECT * FROM function_conversation_native_destinations WHERE conversation_id=?",
        [original.conversationId])[0]
      const destination = mapping.values[0][mapping.columns.indexOf("destination_thread_id")]
      const originalMetadata = mapping.values[0][mapping.columns.indexOf("metadata_json")]
      expect(() => f.bindings[0].assertCurrent()).toThrow()
      await f.restore()
      expect(f.bindings).toHaveLength(2)
      expect(f.bindings[1].target).toEqual(original)
      expect(new Set(f.agents).size).toBe(2)
      expect(new Set(f.turns).size).toBe(2)
      expect(f.requests).toHaveLength(2)
      expect(f.toolEffects()).toBe(1)
      expect(f.requests[1].filter(message => message.getType() === "tool")).toHaveLength(1)
      expect(f.requests[0].filter(message => message.id === f.notes[0])).toHaveLength(1)
      for (const note of f.notes)
        expect(f.requests[1].filter(message => message.id === note)).toHaveLength(1)
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_native_destinations WHERE conversation_id=?",
        [original.conversationId])[0].values[0][0]).toBe(1)
      expect(appDb.getDb().exec("SELECT metadata FROM threads WHERE thread_id=?", [destination])[0].values[0][0])
        .toBe(originalMetadata)
      expect(appDb.getDb().exec("SELECT DISTINCT thread_id FROM thread_messages WHERE message_id IN (?,?)",
        f.notes)[0].values).toEqual([[destination]])
      expect(appDb.getThreadMessages(f.threadId)).toEqual([])
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_inbox WHERE conversation_id=?",
        [original.conversationId])[0].values[0][0]).toBe(0)
      expect(() => f.bindings[1].assertCurrent()).toThrow()
    } finally { await f.close() }
  })

  it.each(["mapping", "membership", "metadata"])("refuses damaged %s without creating a replacement bucket or child", async damage => {
    const f = await fixture()
    try {
      await f.start()
      const target = f.bindings[0].target, database = appDb.getDb()
      const beforeThreads = database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]
      const beforeChildren = database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]
      if (damage === "mapping") database.run("DELETE FROM function_conversation_native_destinations WHERE conversation_id=?",
        [target.conversationId])
      else if (damage === "membership") database.run("DELETE FROM function_conversation_checkpoint_members WHERE receipt_id IN (SELECT receipt_id FROM function_conversation_checkpoint_receipts WHERE conversation_id=?)",
        [target.conversationId])
      else {
        const destination = database.exec("SELECT destination_thread_id,metadata_json FROM function_conversation_native_destinations WHERE conversation_id=?",
          [target.conversationId])[0].values[0]
        if (typeof destination[1] !== "string") throw Error("ACTUAL_METADATA_REQUIRED")
        database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
          JSON.stringify({ ...JSON.parse(destination[1]), modsAgentRunId: randomUUID() }), destination[0]])
      }
      await expect(f.restore()).rejects.toThrow(/MODS_CONVERSATION_/)
      expect(f.requests).toHaveLength(1)
      expect(database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]).toBe(beforeThreads)
      expect(database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
        .toBe(beforeChildren)
    } finally { await f.close() }
  })

  it("keeps fresh namespace reserved after close until its actual held model finally settles", async () => {
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(hold), running = f.start()
    void running.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(1))
      const database = appDb.getDb()
      const beforeThreads = database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]
      const beforeChildren = database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]
      await expect(f.replayPending()).rejects.toThrow("REGISTRATION_CONFLICT")
      let drained = false
      const scope = f.scopes[0]
      void scope.whenDrained().then(() => { drained = true })
      scope.close()
      await expect(f.replayPending()).rejects.toThrow("REGISTRATION_CONFLICT")
      expect(drained).toBe(false)
      expect(database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]).toBe(beforeThreads)
      expect(database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
        .toBe(beforeChildren)
      release()
      await expect(running).rejects.toThrow()
      await scope.whenDrained()
      expect(drained).toBe(true)
      // The native row/mapping is retained. A later fresh authority must pass the exact restore
      // proof again; no cached parent result or publicly named namespace releases the old owner.
      await f.replayPending()
      expect(f.requests.length).toBeGreaterThan(1)
      expect(database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
        .toBe(beforeChildren)
    } finally {
      release()
      await running.catch(() => undefined)
      await f.close()
    }
  })

  async function zeroNoteRestoreCase(mutation?: "seed-mismatch" | "seed-content", noticeCount = 0) {
    const model = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<SqlJsSaverPreparedCheckpointDescriptor>()
    const serialization = Promise.withResolvers<void>()
    let claimed = false, restoring = false, mutated = false
    const f = await fixture(model.promise, undefined, { native: true, noNotes: true, noticeCount,
      isRestoring: () => restoring })
    const codec = captureDefaultCheckpointMetadataCodec(f.saver.serde)
    const originalWrap = FunctionConversationDeliveryBridge.prototype.wrap
    let pendingIncoming: BaseMessage[] | undefined
    const originalRead = sharedCheckpoint.readFunctionConversationSharedNativeRead
    const readSpy = mutation ? vi.spyOn(sharedCheckpoint, "readFunctionConversationSharedNativeRead")
      .mockImplementation((proof, saver, authority) => {
        const read = originalRead(proof, saver, authority)
        if (restoring && saver === f.saver && read.pendingNamespace && read.tuple) {
          const actual = read.pendingNamespace.writes.find(write =>
            write.checkpointId === read.tuple!.checkpoint.id && write.channel === "messages")?.value
          if (!Array.isArray(actual) || !actual.every(HumanMessage.isInstance) || actual.length !== 1)
            throw Error("NOT_MET: actual zero-note pending ordinary seed absent")
          pendingIncoming = actual
          if (mutation === "seed-mismatch" && !mutated) {
            actual[0].content = "changed actual pending seed before restore preparation"
            mutated = true
          }
        }
        return read
      }) : undefined
    const wrap = vi.spyOn(FunctionConversationDeliveryBridge.prototype, "wrap")
      .mockImplementation(function (this: FunctionConversationDeliveryBridge,
        saver, assertCurrent, onCommitted, hooks) {
        if (saver !== f.saver) return originalWrap.call(this, saver, assertCurrent, onCommitted, hooks)
        const delegated = originalWrap.call(this, saver, assertCurrent, onCommitted,
          (restoring || claimed) ? hooks : { ...hooks,
          prepared: async receipt => {
            await hooks?.prepared?.(receipt)
            const descriptor = SqlJsSaver.prototype.readPreparedCheckpoint.call(saver, receipt)
            const target = f.bindings[0]?.target
            if (claimed || !target || descriptor.threadId !== f.threadId ||
              descriptor.namespace !== target.checkpointNamespace) return
            claimed = true
            prepared.resolve(descriptor)
            await serialization.promise
          }
        })
        if (restoring && mutation === "seed-content" && !mutated) {
          if (!pendingIncoming || pendingIncoming.length !== 1)
            throw Error("NOT_MET: captured zero-note pending seed absent at last factory")
          pendingIncoming[0].content = "changed actual pending seed in last delivery factory"
          mutated = true
        }
        return delegated
      })
    const running = f.start()
    void running.catch(() => undefined)
    try {
      expect(codec()).toBe(true)
      const point = await Promise.race([prepared.promise, running.then(() => {
        throw Error("NOT_MET: native zero-note prepared gate absent")
      }, error => { throw new Error("NOT_MET: native zero-note failed before gate", { cause: error }) })])
      // The genuine native SDK barrier must keep this next effect node unentered.
      expect(f.requests).toHaveLength(0)
      expect(f.providerCalls()).toBe(0)
      expect(f.toolEffects()).toBe(0)
      expect(f.beforeModelSources).toHaveLength(1)
      expect(f.bindings).toHaveLength(1)
      expect(f.notes).toHaveLength(0)
      const target = f.bindings[0].target, scope = f.beforeModelSources[0].scope
      const native = f.nativeRuntimes.at(-1)
      expect(native).toBeDefined()
      expect(native!.runtime.target.ref).toBe(target)
      native!.runtime.assertCurrent()
      const database = appDb.getDb()
      const beforeThreads = database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]
      const beforeChildren = database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]
      for (const table of ["function_conversation_rows", "function_conversation_inbox",
        "function_conversation_deliveries"])
        expect(database.exec(`SELECT COUNT(*) FROM ${table} WHERE conversation_id=?`,
          [target.conversationId])[0].values).toEqual([[table === "function_conversation_rows" ? noticeCount : 0]])
      // The original prepared hook now follows genuine data persistence, without native COMMIT or ACK.
      expect(database.exec(`SELECT checkpoint_id FROM function_conversation_checkpoint_receipts
        WHERE conversation_id=?`, [target.conversationId])[0].values).toEqual([[point.checkpointId]])
      expect(database.exec(`SELECT COUNT(*) FROM function_conversation_checkpoint_members
        WHERE receipt_id IN (SELECT receipt_id FROM function_conversation_checkpoint_receipts
          WHERE conversation_id=?)`, [target.conversationId])[0].values).toEqual([[0]])
      const decode = async (type: unknown, value: unknown): Promise<unknown> => {
        if (typeof type !== "string" || !(typeof value === "string" || value instanceof Uint8Array))
          throw Error("NOT_MET: actual zero-note typed bytes unavailable")
        return f.saver.serde.loadsTyped(type, value)
      }
      const rawDatabase = new DatabaseSync(f.checkpointPath, { readOnly: true })
      let raw: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
      let selected: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>
      let messageSnapshot: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
      let parentMessageSnapshot: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
      try {
        rawDatabase.exec("BEGIN")
        const count = rawDatabase.prepare("SELECT COUNT(*) AS count FROM writes WHERE thread_id=? AND checkpoint_ns=?")
          .get(f.threadId, point.namespace)?.count
        expect(Number(count)).toBeLessThanOrEqual(64)
        const metadata = rawDatabase.prepare(`SELECT w.checkpoint_id,w.task_id,w.idx,w.channel,w.type,
          EXISTS(SELECT 1 FROM checkpoints c WHERE c.thread_id=w.thread_id
            AND c.checkpoint_ns=w.checkpoint_ns AND c.checkpoint_id=w.checkpoint_id) AS checkpoint_exists
          FROM writes w WHERE w.thread_id=? AND w.checkpoint_ns=?
          ORDER BY w.checkpoint_id,w.task_id,w.idx LIMIT 64`).all(f.threadId, point.namespace)
        expect(metadata).toHaveLength(Number(count))
        console.info("SHARED_ZERO_NOTE_PENDING_METADATA", JSON.stringify({
          parentPoint: point.parentCheckpointId, destinationPoint: point.checkpointId, writes: metadata }))
        expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id=? AND checkpoint_ns=?")
          .get(f.threadId, point.namespace)?.count).toBe(1)
        raw = rawDatabase.prepare("SELECT type,checkpoint,metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.parentCheckpointId!)
        expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.checkpointId)?.count).toBe(0)
        expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.checkpointId)?.count).toBe(0)
        selected = rawDatabase.prepare("SELECT task_id,idx,channel,type,value FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY idx LIMIT 64")
          .all(f.threadId, point.namespace, point.parentCheckpointId!)
        messageSnapshot = rawDatabase.prepare(`SELECT checkpoint_id,parent_checkpoint_id,prefix_length,
          message_count,generation,type,suffix FROM checkpoint_message_snapshots
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
          .get(f.threadId, point.namespace, point.parentCheckpointId!)
        if (typeof messageSnapshot?.parent_checkpoint_id === "string")
          parentMessageSnapshot = rawDatabase.prepare(`SELECT checkpoint_id,parent_checkpoint_id,prefix_length,
            message_count,generation,type,suffix FROM checkpoint_message_snapshots
            WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`)
            .get(f.threadId, point.namespace, messageSnapshot.parent_checkpoint_id)
        rawDatabase.exec("ROLLBACK")
      } finally { rawDatabase.close() }
      if (!raw) throw Error("NOT_MET: actual zero-note parent missing")
      const checkpoint = await decode(raw.type, raw.checkpoint) as { channel_values: Record<string, unknown> }
      const metadata = await decode(raw.type, raw.metadata) as { step: number }
      expect(metadata.step).toBe(1)
      expect(checkpoint.channel_values.cmbFunctionConversation).toBeUndefined()
      const reference = checkpoint.channel_values.messages as Record<string, unknown> | undefined
      expect(reference?.__cmb_sqljs_external_messages_v1).toBe(true)
      expect(Object.keys(reference ?? {}).sort()).toEqual(["__cmb_sqljs_external_messages_v1", "messageCount"])
      expect(Number.isSafeInteger(reference?.messageCount)).toBe(true)
      expect(Number(reference?.messageCount)).toBeGreaterThan(0)
      expect(messageSnapshot).toBeDefined()
      console.info("SHARED_ZERO_NOTE_EXTERNAL_INPUT", JSON.stringify({
        checkpointId: messageSnapshot?.checkpoint_id, parentCheckpointId: messageSnapshot?.parent_checkpoint_id,
        prefixLength: messageSnapshot?.prefix_length, messageCount: messageSnapshot?.message_count,
        generation: messageSnapshot?.generation, type: messageSnapshot?.type }))
      console.info("SHARED_ZERO_NOTE_PARENT_INPUT", JSON.stringify({
        checkpointId: parentMessageSnapshot?.checkpoint_id,
        parentCheckpointId: parentMessageSnapshot?.parent_checkpoint_id,
        prefixLength: parentMessageSnapshot?.prefix_length,
        messageCount: parentMessageSnapshot?.message_count,
        generation: parentMessageSnapshot?.generation, type: parentMessageSnapshot?.type }))
      // This fixture only qualifies the observed two-point, one-message prefix shape.
      // An ancestor checkpoint may be pruned; its actual persisted snapshot is the input.
      expect(parentMessageSnapshot).toBeDefined()
      expect(reference!.messageCount).toBe(1)
      expect(messageSnapshot!.checkpoint_id).toBe(point.parentCheckpointId)
      expect(messageSnapshot!.parent_checkpoint_id).toBe(parentMessageSnapshot!.checkpoint_id)
      expect(messageSnapshot!.prefix_length).toBe(1)
      expect(messageSnapshot!.message_count).toBe(1)
      expect(parentMessageSnapshot!.parent_checkpoint_id).toBeNull()
      expect(parentMessageSnapshot!.prefix_length).toBe(0)
      expect(parentMessageSnapshot!.message_count).toBe(1)
      const base = await decode(parentMessageSnapshot!.type, parentMessageSnapshot!.suffix)
      const suffix = await decode(messageSnapshot!.type, messageSnapshot!.suffix)
      expect(Array.isArray(base)).toBe(true)
      expect(base as unknown[]).toHaveLength(1)
      expect(suffix).toEqual([])
      const rawMessages = (base as unknown[]).slice(0, Number(messageSnapshot!.prefix_length))
        .concat(suffix as unknown[])
      expect(Array.isArray(rawMessages)).toBe(true)
      expect((rawMessages as BaseMessage[])).toHaveLength(Number(reference!.messageCount))
      expect((rawMessages as BaseMessage[]).every(message => HumanMessage.isInstance(message) &&
        message.additional_kwargs.function_row === undefined)).toBe(true)
      const rawPayloads = (rawMessages as BaseMessage[]).map(serializeFunctionConversationNativeMessage)
      for (const payload of rawPayloads)
        expect(f.beforeModelSources[0].messages.filter(message =>
          serializeFunctionConversationNativeMessage(message) === payload)).toHaveLength(1)
      expect(selected!).toHaveLength(3)
      expect(typeof selected![0].task_id).toBe("string")
      expect(String(selected![0].task_id).length).toBeGreaterThan(0)
      expect(new Set(selected!.map(write => write.task_id)).size).toBe(1)
      expect(selected!.every(write => write.type === "json" &&
        ["cmbFunctionConversation", "branch:to:model_request", "messages"].includes(String(write.channel))))
        .toBe(true)
      const states = selected!.filter(write => write.channel === "cmbFunctionConversation")
      const branches = selected!.filter(write => write.channel === "branch:to:model_request")
      expect(states).toHaveLength(1)
      expect(branches).toHaveLength(1)
      const state = readFunctionConversationState(await decode(states[0].type, states[0].value))
      expect(state).toMatchObject({ logicalSessionId: target.logicalSessionId,
        conversationId: target.conversationId, branchId: target.branchId, frontier: noticeCount })
      expect(await decode(branches[0].type, branches[0].value)).toBeNull()
      for (const write of selected!.filter(write => write.channel === "messages")) {
        const value = await decode(write.type, write.value)
        expect(Array.isArray(value)).toBe(true)
        expect((value as BaseMessage[]).every(message => HumanMessage.isInstance(message) &&
          message.additional_kwargs.function_row === undefined)).toBe(true)
        const pendingPayloads = (value as BaseMessage[]).map(serializeFunctionConversationNativeMessage)
        expect(pendingPayloads).toEqual(rawPayloads)
        expect((value as BaseMessage[]).map(message => message.id))
          .toEqual((rawMessages as BaseMessage[]).map(message => message.id))
        console.info("SHARED_ZERO_NOTE_PENDING_MESSAGES", JSON.stringify({
          count: pendingPayloads.length, equalsRawOrdinarySeed: pendingPayloads.length === rawPayloads.length &&
            pendingPayloads.every((payload, index) => payload === rawPayloads[index]) }))
      }
      console.info("SHARED_ZERO_NOTE_QUALIFIED", JSON.stringify({
        frontier: state.frontier, selectedCount: selected!.length,
        channels: selected!.map(write => write.channel), rawMessageCount: rawPayloads.length }))
      expect(f.requests).toHaveLength(0)
      expect(f.providerCalls()).toBe(0)
      expect(f.toolEffects()).toBe(0)
      scope.close(); serialization.resolve(); model.resolve()
      await expect(running).rejects.toThrow()
      await scope.whenDrained()
      expect(f.store.captureInbox(target, 0).rows).toHaveLength(0)
      // The qualified old rejection remains in the r3 RED proof; this is still a desired positive.
      // A prepared index is not an ACK: the SDK must replay the original ordinary seed itself.
      restoring = true
      if (mutation) {
        await expect(f.replayPending()).rejects.toThrow(/MODS_CONVERSATION_/)
        expect(mutated).toBe(true)
        expect(f.requests).toHaveLength(0)
        expect(f.coldRequests).toHaveLength(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.toolEffects()).toBe(0)
        expect(f.notes).toHaveLength(0)
        expect(f.store.captureInbox(target, 0).rows).toHaveLength(0)
        expect(database.exec("SELECT COUNT(*) FROM function_conversation_deliveries WHERE conversation_id=?",
          [target.conversationId])[0].values).toEqual([[0]])
        return
      }
      await f.replayPending()
      expect(f.coldRequests.length).toBeGreaterThan(0)
      expect(f.requests).toHaveLength(f.coldRequests.length)
      expect(f.coldRequests[0].scope).not.toBe(scope)
      expect(f.coldRequests[0].authority).toBeDefined()
      expect(f.nativeRuntimes.some(value => value.authority === f.coldRequests[0].authority &&
        value.runtime.target.ref.conversationId === target.conversationId)).toBe(true)
      expect(f.providerCalls()).toBeGreaterThan(0)
      expect(f.notes).toHaveLength(0)
      for (const payload of rawPayloads)
        expect(f.coldRequests.at(-1)!.messages.filter(message =>
          serializeFunctionConversationNativeMessage(message) === payload)).toHaveLength(1)
      expect(f.coldRequests.at(-1)!.messages.some(message => {
        const stamp = message.additional_kwargs.function_row
        return stamp !== null && typeof stamp === "object" && "door" in stamp && stamp.door === "note"
      })).toBe(false)
      expect(f.bindings.at(-1)!.target.conversationId).toBe(target.conversationId)
      expect(database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]).toBe(beforeThreads)
      expect(database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
        .toBe(beforeChildren)
      expect(database.exec("SELECT COUNT(*) FROM function_conversation_inbox WHERE conversation_id=?",
        [target.conversationId])[0].values).toEqual([[0]])
    } finally {
      serialization.resolve(); model.resolve()
      await running.catch(() => undefined)
      try { await f.close() } finally { wrap.mockRestore(); readSpy?.mockRestore() }
    }
  }
  it("restores a zero-note pending intake through the actual native factory and original ordinary input", () =>
    settleTestWork(zeroNoteRestoreCase()))
  it.each(["seed-mismatch", "seed-content"] as const)(
    "rejects zero-note %s without replacing the admitted ordinary input", mutation =>
      settleTestWork(zeroNoteRestoreCase(mutation)))

  async function pendingRestoreCase(options: { native?: boolean
    noticeCount?: number; splitNotes?: boolean
    beforeReplay?(): Promise<void>
    ledgerMutation?: "missing" | "replaced" | "payload" | "late-payload" | "inbox" | "inbox-number"
      | "role" | "role-null" | "meta" | "meta-number"
    mutation?: "delivery-ack" | "array-append" | "array-replace" | "checkpoint-getter" | "receipt-selected"
      | "json-extract-udf" | "temp-delivery-shadow"
    family?: { wrapped: boolean; calls: number; measuring: boolean; samples: number[]; hits: number }
    receiptOrphan?: boolean
    containment?: { clonedParent: boolean; calls: number; measuring: boolean; samples: number[]
      wrappedDestination?: boolean; attackDestinationFreeze?: boolean
      freezeExposures?: number; destinationQualified?: boolean }
    restoreInputAttack?: "getter" | "prototype" | "value"
    returnInputAttack?: "clone" | "raw-mutation" | "captured-mutation"
    familyDeferral?: "original" | "wrapped" | "late" | "late-mutation"
    lateScopeReader?: boolean } = {}) {
    const model = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<SqlJsSaverPreparedCheckpointDescriptor>()
    const serialization = Promise.withResolvers<void>()
    type RestoreInput = Parameters<typeof sharedRestore.prepareFunctionConversationSharedRestore>[0]
    let attackInput: RestoreInput | undefined, attackArmed = false, inputMutated = false
    let inputGetterCalls = 0, lateScopeCalls = 0
    let actualReadCurrent: (() => void) | undefined
    let returnInputChecks = 0, unknownReturnGetterCalls = 0, cloneReturnRejected = false
    let returnInputGuardError: unknown
    let restoring = false
    let deferralMeasuring = false, deferralArmed = false, deferralChecked = false
    let deferralCalls = 0, deferralSourceCount = 0, deferralEntries = 0, deferralWrapperCalls = 0
    let deferralError: unknown, restoreDeferralExport: (() => void) | undefined
    const originalDeferralReader = sharedRestore.readFunctionConversationSharedRestore
    const installDeferralReader = () => {
      if (restoreDeferralExport) throw Error("NOT_MET: pending Restore reader already observed")
      const spy = vi.spyOn(sharedRestore, "readFunctionConversationSharedRestore")
        .mockImplementation(function (this: unknown, ...args) {
          deferralWrapperCalls++
          return Reflect.apply(originalDeferralReader, this, args)
        })
      restoreDeferralExport = () => spy.mockRestore()
    }
    const f = await fixture(model.promise, options.returnInputAttack || options.familyDeferral ? {
      ...(options.familyDeferral ? { guard() {
        if (!deferralArmed) return
        deferralArmed = false
        deferralEntries++
        expect(deferralCalls).toBe(0)
        installDeferralReader()
        if (options.familyDeferral === "late-mutation") {
          const messages = pendingRead!.tuple!.checkpoint.channel_values.messages as BaseMessage[]
          expect(HumanMessage.isInstance(messages[0])).toBe(true)
          messages[0].content = "changed the actual raw seed in the parent callback"
        }
      } } : {}),
      ...(options.returnInputAttack ? { beforeNativeGenerate() {
      if (!options.returnInputAttack || !restoring || returnInputChecks) return
      expect(f.coldRequests).toHaveLength(1)
      expect(f.coldRequests[0].scope).not.toBe(f.beforeModelSources[0].scope)
      expect(f.coldRequests[0].authority).toBe(currentFunctionExecution()?.runtimeAuthority)
      const domain = currentSharedNativeDomainRecord(), view = domain?.view
      expect(domain?.phase).toBe("ready")
      expect(view).toBeDefined()
      expect(domain?.original?.scope).toBe(f.scopes.at(-1))
      expect(view!.runtime.target.ref).toBe(domain!.original!.target.ref)
      expect(view!.runtime.target.ref.conversationId).toBe(f.bindings[0].target.conversationId)
      expect(domain!.original!.namespace).toBe(pendingRead!.tuple!.config.configurable?.checkpoint_ns)
      const raw = (pendingRead!.tuple!.checkpoint.channel_values.messages as BaseMessage[])[0]
      expect(HumanMessage.isInstance(raw)).toBe(true)
      expect(typeof view!.captureReturnRestoredSource).toBe("function")
      expect(typeof view!.assertReturnRestoredData).toBe("function")
      const capture = view!.captureReturnRestoredSource!
      returnInputChecks++
      if (options.returnInputAttack === "clone") {
        const payload = serializeFunctionConversationNativeMessage(raw)
        const clone = deserializeFunctionConversationNativeMessage(payload)
        expect(clone).not.toBe(raw)
        expect(clone.id).toBe(raw.id)
        expect(serializeFunctionConversationNativeMessage(clone)).toBe(payload)
        const id = clone.id
        Object.defineProperty(clone, "id", { configurable: true,
          get() { unknownReturnGetterCalls++; return id } })
        cloneReturnRejected = capture(clone) === undefined
        expect(cloneReturnRejected).toBe(true)
        expect(unknownReturnGetterCalls).toBe(0)
        const proof = capture(raw)
        expect(proof).toBeDefined()
        proof!.assertDataCurrent()
      } else {
        const proof = options.returnInputAttack === "captured-mutation" ? capture(raw) : undefined
        if (options.returnInputAttack === "captured-mutation") expect(proof).toBeDefined()
        raw.content = "changed the actual ordinary return source after admission"
        try {
          if (proof) proof.assertDataCurrent()
          else view!.assertReturnRestoredData!()
        } catch (error) { returnInputGuardError = error }
      }
    } } : {}) } : undefined, { native: options.native,
      noticeCount: options.noticeCount, splitNotes: options.splitNotes,
      afterCutNote: !options.mutation && !options.restoreInputAttack && !options.ledgerMutation,
      ...(options.native ? { isRestoring: () => restoring } : {}) })
    const sourceRestores: Array<() => void> = []
    const originalSourceFactory = sharedSource.createFunctionConversationSharedSourceCurrent
    const sourceSpy = options.containment || options.restoreInputAttack || options.family || options.familyDeferral
      ? vi.spyOn(sharedSource, "createFunctionConversationSharedSourceCurrent")
        .mockImplementation(input => {
          if (input.task.saver !== f.saver || input.authority.threadId !== f.threadId)
            return originalSourceFactory(input)
          const descriptor = Object.getOwnPropertyDescriptor(input, "assertCurrent")
          if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
            throw Error("NOT_MET: original source callback is not an own data function")
          const originalCurrent = descriptor.value as typeof input.assertCurrent
          const observed = function (this: typeof input, ...args: Parameters<typeof originalCurrent>) {
            if (options.containment?.measuring) options.containment.calls++
            if (options.family?.measuring) options.family.calls++
            if (deferralMeasuring) deferralCalls++
            if (attackArmed && attackInput && !inputMutated) {
              inputMutated = true
              if (options.restoreInputAttack === "getter") {
                const parent = attackInput.parentBinding
                Object.defineProperty(attackInput, "parentBinding", { configurable: true,
                  get() { inputGetterCalls++; return parent } })
              } else if (options.restoreInputAttack === "prototype") Object.setPrototypeOf(attackInput, null)
              else Object.defineProperty(attackInput, "signal", { value: new AbortController().signal })
            }
            return Reflect.apply(originalCurrent, this, args)
          }
          Object.defineProperty(input, "assertCurrent", { ...descriptor, value: observed })
          sourceRestores.push(() => Object.defineProperty(input, "assertCurrent", descriptor))
          // The actual module constructs its private records and returns its original guard.
          return originalSourceFactory(input)
        }) : undefined
    const serde = f.saver.serde, nativeCodec = captureDefaultCheckpointMetadataCodec(serde)
    const originalWrap = FunctionConversationDeliveryBridge.prototype.wrap
    let claimed = false, mutated = false, getterCalls = 0
    let sqlCallbacks = 0, udfRegistered = false, tempDeliveryCreated = false
    let primaryFailed = false, primaryError: unknown
    const closeAdversarialNativeFixture = async () => {
      const cleanupErrors: unknown[] = []
      let physicallyClosed = false
      try {
        await f.close()
        expect(Reflect.get(f.saver, "db")).toBeNull()
        physicallyClosed = true
        if (udfRegistered) expect(sqlCallbacks).toBe(0)
      } catch (error) { cleanupErrors.push(error) }
      if (physicallyClosed && tempDeliveryCreated) {
        try { appDb.getDb().run("DROP TABLE temp.function_conversation_deliveries") }
        catch (error) { cleanupErrors.push(error) }
      }
      if (physicallyClosed && udfRegistered) {
        let appClosed = false
        try { await appDb.closeDatabase(); appClosed = true }
        catch (error) { cleanupErrors.push(error) }
        if (appClosed) {
          try { await appDb.initializeDatabase() }
          catch (error) { cleanupErrors.push(error) }
        }
      }
      if (cleanupErrors.length) {
        if (primaryFailed) cleanupErrors.unshift(primaryError)
        throw new AggregateError(cleanupErrors, "ACTUAL_PENDING_NATIVE_NEGATIVE_CLEANUP")
      }
    }
    let completedData: ReturnType<typeof sharedRestore.readFunctionConversationSharedCompletedActiveData>
    type ActualFamily = ReturnType<FunctionConversationChildFamilies<object>["readShared"]>
    let actualDeferralFamily: ActualFamily | undefined
    const originalFamilyRead = FunctionConversationChildFamilies.prototype.readShared
    const familyReadSpy = options.familyDeferral
      ? vi.spyOn(FunctionConversationChildFamilies.prototype, "readShared")
        .mockImplementation(function (this: FunctionConversationChildFamilies<object>, proof) {
          const actual = Reflect.apply(originalFamilyRead, this, [proof]) as ActualFamily
          if (restoring && actual.input.checkpointThreadId === f.threadId && actual.input.restore)
            actualDeferralFamily = actual
          return actual
        }) : undefined
    const originalFamilyPlan = sharedSource.captureFunctionConversationSharedFamilySourcePlan
    const familyPlanSpy = options.family
      ? vi.spyOn(sharedSource, "captureFunctionConversationSharedFamilySourcePlan")
        .mockImplementation((...args) => {
          const result = originalFamilyPlan(...args)
          if (restoring && result) options.family!.hits++
          return result
        }) : undefined
    const originalRegister = FunctionConversationCoordinator.prototype.registerSharedChild
    const familyRegisterSpy = options.family?.wrapped
      ? vi.spyOn(FunctionConversationCoordinator.prototype, "registerSharedChild")
        .mockImplementation(function (this: FunctionConversationCoordinator, parent, input) {
          if (!restoring || input.saver !== f.saver)
            return Reflect.apply(originalRegister, this, [parent, input])
          const original = input.assertCurrent
          // A real full callback wrapper loses only the private original Family pair.
          return Reflect.apply(originalRegister, this, [parent, { ...input,
            assertCurrent: () => Reflect.apply(original, input, []) }])
        }) : undefined
    const originalComplete = sharedRestore.completeFunctionConversationSharedActive
    const completeSpy = options.family || options.familyDeferral
      ? vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
        .mockImplementation((active, input) => {
          const producer = originalComplete(active, input)
          if (!restoring || input.saver !== f.saver || !producer || !input.restore) return producer
           if (options.familyDeferral) {
             expect(actualDeferralFamily).toBeDefined()
             const family = actualDeferralFamily!
             expect(family.input.restore).toBe(input.restore)
             expect(family.input.authority).toBe(input.authority)
             expect(family.input.checkpointNamespace).toBe(pendingRead!.tuple!.config.configurable?.checkpoint_ns)
             if (options.familyDeferral === "wrapped") installDeferralReader()
             const before = deferralCalls
             deferralMeasuring = true
             deferralArmed = options.familyDeferral === "late" || options.familyDeferral === "late-mutation"
             try { family.assertCurrent() }
             catch (error) { deferralError = error; throw error }
             finally {
               deferralArmed = false; deferralMeasuring = false; deferralChecked = true
               deferralSourceCount = deferralCalls - before
               restoreDeferralExport?.(); restoreDeferralExport = undefined
             }
             expect(deferralSourceCount).toBe(options.familyDeferral === "wrapped" ? 3 : 2)
             return producer
           }
          const view = sharedRestore.readFunctionConversationSharedProducer(producer, input.authority)
          expect(view.history).toBeUndefined()
          expect(sharedRestore.readFunctionConversationSharedCompletedActiveData(
            Object.freeze({ ...active }), input.authority, view.destination)).toBeUndefined()
          expect(sharedRestore.readFunctionConversationSharedCompletedActiveData(
            active, f.parent.authority, view.destination)).toBeUndefined()
          expect(sharedRestore.readFunctionConversationSharedCompletedActiveData(
            active, input.authority, Object.freeze({ ...view.destination }))).toBeUndefined()
          completedData = sharedRestore.readFunctionConversationSharedCompletedActiveData(
            active, input.authority, view.destination)
          expect(completedData).toBeDefined()
          expect(completedData!.target).toBe(input.target)
          const probe = options.family!, before = probe.calls
          probe.measuring = true
          try { completedData!.assertDataCurrent(); expect(probe.calls).toBe(before)
            view.assertCurrent() }
          finally { probe.measuring = false; probe.samples.push(probe.calls - before) }
          return producer
        }) : undefined
    const originalPrepare = sharedRestore.prepareFunctionConversationSharedRestore
    const prepareSpy = options.containment || options.restoreInputAttack
      ? vi.spyOn(sharedRestore, "prepareFunctionConversationSharedRestore")
        .mockImplementation(async input => {
          const actual = options.containment?.clonedParent
            ? { ...input, parentBinding: { ...input.parentBinding } } : input
          const probing = restoring && input.saver === f.saver ? options.containment : undefined
          const originalDestination = nativeDestination.readFunctionConversationNativeDestination
          const own = Object.getOwnPropertyDescriptor, define = Object.defineProperty, freeze = Object.freeze
          const freezeDescriptor = own(Object, "freeze")!
          const isOwnedDestination = (value: unknown): value is Record<string, unknown> => {
            if (!value || typeof value !== "object" || nativeDestinationTypes.isProxy(value)) return false
            const keys = ["parent", "invocationId", "checkpointThreadId", "checkpointIncarnation",
              "destinationThreadId", "destinationIncarnation", "originalMetadata", "assertCurrent"]
            for (const key of keys) {
              const field = own(value, key)
              if (!field || !("value" in field)) return false
            }
            return own(value, "checkpointThreadId")!.value === f.threadId &&
              typeof own(value, "assertCurrent")!.value === "function"
          }
          const readerSpy = probing?.wrappedDestination
            ? vi.spyOn(nativeDestination, "readFunctionConversationNativeDestination")
              .mockImplementation((...args) => Reflect.apply(originalDestination, undefined, args)) : undefined
          if (probing?.attackDestinationFreeze) define(Object, "freeze", { ...freezeDescriptor,
            value: (value: unknown) => {
              if (isOwnedDestination(value)) {
                probing.freezeExposures = (probing.freezeExposures ?? 0) + 1
                return freeze({ ...value, assertCurrent() {
                  throw Error("HOST_REPLACED_DESTINATION_CURRENT")
                } })
              }
              return freeze(value)
            } })
          let proof: Awaited<ReturnType<typeof originalPrepare>>
          try { proof = await originalPrepare(actual) }
          finally {
            if (probing?.attackDestinationFreeze) define(Object, "freeze", freezeDescriptor)
            readerSpy?.mockRestore()
          }
          if (restoring && input.saver === f.saver) {
            if (!actualReadCurrent) throw Error("NOT_MET: actual pending read current not observed")
            const scopeFacts = sharedCheckpoint.readFunctionConversationSharedNativeReadCurrent(
              actualReadCurrent, actual.scope, actual.saver, actual.authority)
            const sourceFacts = sharedSource.readFunctionConversationSharedSourceCurrent(
              actualReadCurrent, actual.scope, actual.saver, actual.authority,
              actual.invocation, appDb.getDb())
            console.info("SHARED_CONTAINMENT_ELIGIBILITY", JSON.stringify({
              authorityDataCurrent: isModRuntimeAuthorityDataCurrent(actual.authority),
              scopeRecord: !!scopeFacts, sourceRecord: !!sourceFacts,
              sameSource: sourceFacts?.source === actual.assertCurrent,
              sameParent: sourceFacts?.parentBinding === actual.parentBinding,
              sameSignal: sourceFacts?.signal === actual.signal,
              sameIncarnation: sourceFacts?.checkpointIncarnation === actual.checkpointIncarnation }))
            const probe = options.containment
            const before = probe?.calls ?? 0
            if (probe) probe.measuring = true
            if (options.restoreInputAttack) { attackInput = actual; attackArmed = true }
            try {
              const restored = sharedRestore.readFunctionConversationSharedRestore(proof, {
                nativeRead: actual.nativeRead, saver: actual.saver, authority: actual.authority,
                invocation: actual.invocation, parent: actual.parentBinding.target })
              if (probe?.attackDestinationFreeze) probe.destinationQualified =
                isOwnedDestination(restored.destination) && Object.isFrozen(restored.destination)
            } finally {
              if (probe) {
                probe.measuring = false; probe.samples.push(probe.calls - before)
                console.info("SHARED_CONTAINMENT_CALLBACK_COUNT", JSON.stringify({
                  clonedParent: probe.clonedParent, calls: probe.calls - before }))
              }
              attackArmed = false
            }
          }
          return proof
        }) : undefined
    const lateScopeSpy = options.lateScopeReader
      ? vi.spyOn(sharedCheckpoint, "readFunctionConversationSharedNativeReadCurrent")
        .mockImplementation(() => { lateScopeCalls++; return undefined }) : undefined
    let pendingRead: Awaited<ReturnType<SqlJsSaver["getTupleForSharedConversation"]>> | undefined
    const originalRead = sharedCheckpoint.readFunctionConversationSharedNativeRead
    const readSpy = options.mutation || options.native || options.containment || options.restoreInputAttack || options.familyDeferral
      ? vi.spyOn(sharedCheckpoint, "readFunctionConversationSharedNativeRead")
      .mockImplementation((proof, saver, authority) => {
        const read = originalRead(proof, saver, authority)
        if (saver === f.saver && read.pendingNamespace) {
          actualReadCurrent = read.assertCurrent
          pendingRead = { tuple: read.tuple, pendingNamespace: read.pendingNamespace }
          if (restoring && options.ledgerMutation === "late-payload") {
            const actual = read.pendingNamespace
            return { ...read, pendingNamespace: { ...actual, assertAdmissionCurrent() {
              lateAdmissionCalls++
              actual.assertAdmissionCurrent()
              lateAdmissionReturned++
              if (!mutated) {
                const target = f.bindings[0].target, uuid = f.notes[0], database = appDb.getDb()
                const original = database.exec("SELECT payload_json FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
                  [target.conversationId, uuid])[0].values[0][0]
                mutateLedgerNote()
                const changed = database.exec("SELECT payload_json,payload_digest,bytes FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
                  [target.conversationId, uuid])[0].values[0]
                if (typeof original !== "string" || typeof changed[0] !== "string" || changed[0] === original ||
                  changed[1] !== createHash("sha256").update(changed[0]).digest("hex") ||
                  changed[2] !== Buffer.byteLength(changed[0]))
                  throw Error("NOT_MET: late callback did not change valid original note bytes")
                lateRowChanged = true
              }
            } } }
          }
        }
        return read
      }) : undefined
    let lateAdmissionCalls = 0, lateAdmissionReturned = 0, lateRowChanged = false
    const mutateLedgerNote = () => {
      const database = appDb.getDb(), target = f.bindings[0].target, uuid = f.notes[0]
      mutated = true
      if (options.ledgerMutation === "missing") database.run(
        "DELETE FROM function_conversation_inbox WHERE conversation_id=? AND uuid=?", [target.conversationId, uuid])
      else if (options.ledgerMutation === "replaced") database.run(
        "UPDATE function_conversation_inbox SET uuid=? WHERE conversation_id=? AND uuid=?",
        [randomUUID(), target.conversationId, uuid])
      else {
        const raw = database.exec("SELECT payload_json FROM function_conversation_rows WHERE conversation_id=? AND uuid=?",
          [target.conversationId, uuid])[0].values[0][0]
        if (typeof raw !== "string") throw Error("NOT_MET: original canonical note bytes absent")
        const payload = JSON.parse(raw) as { inbox: boolean | number; nativePayload: string
          message: { role?: string | null; isMeta?: boolean | number } }
        if (options.ledgerMutation === "payload" || options.ledgerMutation === "late-payload") {
          const changed = deserializeFunctionConversationNativeMessage(payload.nativePayload)
          changed.content = "changed actual canonical note bytes"
          payload.nativePayload = serializeFunctionConversationNativeMessage(changed)
        } else if (options.ledgerMutation === "inbox") payload.inbox = false
        else if (options.ledgerMutation === "inbox-number") payload.inbox = 1
        else if (options.ledgerMutation === "role") payload.message.role = "assistant"
        else if (options.ledgerMutation === "role-null") payload.message.role = null
        else if (options.ledgerMutation === "meta-number") payload.message.isMeta = 1
        else payload.message.isMeta = false
        const encoded = JSON.stringify(payload)
        database.run(`UPDATE function_conversation_rows SET payload_json=?,payload_digest=?,bytes=?
          WHERE conversation_id=? AND uuid=?`, [encoded, createHash("sha256").update(encoded).digest("hex"),
          Buffer.byteLength(encoded), target.conversationId, uuid])
      }
    }
    let pendingPublicationMatches = 0
    const originalIntake = conversationIntake.readFunctionConversationIntakePublication
    const intakeSpy = options.native ? vi.spyOn(conversationIntake, "readFunctionConversationIntakePublication")
      .mockImplementation((publication, store, target) => {
        const read = originalIntake(publication, store, target)
        const point = pendingRead?.tuple?.checkpoint.id
        const actual = pendingRead?.pendingNamespace?.writes.find(write =>
          write.checkpointId === point && write.channel === "messages")?.value
        if (Array.isArray(actual) && read.notes.length === actual.length &&
          read.notes.every((note, index) => note === actual[index])) pendingPublicationMatches++
        return read
      }) : undefined
    const wrap = vi.spyOn(FunctionConversationDeliveryBridge.prototype, "wrap")
      .mockImplementation(function (this: FunctionConversationDeliveryBridge,
        saver, assertCurrent, onCommitted, hooks) {
        if (saver !== f.saver)
          return originalWrap.call(this, saver, assertCurrent, onCommitted, hooks)
        const delegated = originalWrap.call(this, saver, assertCurrent, onCommitted,
          (restoring || claimed) ? hooks : { ...hooks,
          prepared: async receipt => {
            await hooks?.prepared?.(receipt)
            const descriptor = SqlJsSaver.prototype.readPreparedCheckpoint.call(saver, receipt)
            const target = f.bindings[0]?.target
            if (claimed || !target || descriptor.threadId !== f.threadId ||
              descriptor.namespace !== target.checkpointNamespace) return
            claimed = true
            prepared.resolve(descriptor)
            await serialization.promise
          }
        })
        if (restoring && options.ledgerMutation && options.ledgerMutation !== "late-payload" && !mutated)
          mutateLedgerNote()
        if (restoring && options.mutation && !mutated) {
          mutated = true
          if (options.mutation === "delivery-ack") {
            const target = f.bindings[0].target
            appDb.getDb().run("INSERT INTO function_conversation_deliveries VALUES (?,?,?,?,?)",
              [target.conversationId, target.branchId, "forbidden-during-delivery-factory", "adversarial", 1])
          } else if (options.mutation === "json-extract-udf") {
            const native = Reflect.get(appDb.getDb(), "native") as DatabaseSync
            native.function("json_extract", { varargs: true }, () => { sqlCallbacks++; return 1 })
            udfRegistered = true
          } else if (options.mutation === "temp-delivery-shadow") {
            const target = f.bindings[0].target, database = appDb.getDb()
            database.run(`CREATE TEMP TABLE function_conversation_deliveries AS
              SELECT * FROM main.function_conversation_deliveries WHERE 0`)
            tempDeliveryCreated = true
            database.run("INSERT INTO main.function_conversation_deliveries VALUES (?,?,?,?,?)",
              [target.conversationId, target.branchId, "forbidden-behind-temp-shadow", "adversarial", 1])
          } else if (options.mutation === "receipt-selected") {
            if (!pendingRead?.tuple) throw Error("NOT_MET: actual pending read not captured")
            const target = f.bindings[0].target, database = appDb.getDb()
            const count = database.exec(`SELECT COUNT(*) FROM function_conversation_checkpoint_receipts
              WHERE conversation_id=?`, [target.conversationId])[0].values[0][0]
            expect(count).toBe(1)
            database.run(`UPDATE function_conversation_checkpoint_receipts SET checkpoint_id=?
              WHERE conversation_id=?`, [pendingRead.tuple.checkpoint.id, target.conversationId])
          } else {
            if (!pendingRead?.tuple) throw Error("NOT_MET: actual pending read not captured")
            const checkpoint = pendingRead.tuple.checkpoint
            const messages = checkpoint.channel_values.messages as BaseMessage[]
            if (options.mutation === "array-append") messages.push(new HumanMessage("late foreign seed"))
            else if (options.mutation === "array-replace")
              messages[0] = new HumanMessage({ id: messages[0].id, content: messages[0].content })
            else Object.defineProperty(pendingRead.tuple, "checkpoint", { configurable: true,
              get() { getterCalls++; return checkpoint } })
          }
        }
        return delegated
      })
    const running = f.start()
    void running.catch(() => undefined)
    try {
      expect(nativeCodec()).toBe(true)
      const point = await Promise.race([prepared.promise, running.then(() => {
        throw Error("NOT_MET: native prepared gate did not enter")
      }, error => { throw new Error("NOT_MET: native run failed before prepared gate", { cause: error }) })])
      if (options.native) {
        expect(f.requests).toHaveLength(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.toolEffects()).toBe(0)
        expect(f.beforeModelSources).toHaveLength(1)
      } else await vi.waitFor(() => expect(f.requests).toHaveLength(1))
      expect(f.bindings).toHaveLength(1)
      expect(f.notes).toHaveLength(options.splitNotes ? 2 : 1)
      const admittedNoteIds = [...f.notes]
      const target = f.bindings[0].target,
        scope = options.native ? f.beforeModelSources[0].scope : f.scopes[0], noteId = f.notes[0]
      expect(point.namespace).toBe(target.checkpointNamespace)
      expect(typeof point.parentCheckpointId).toBe("string")
      if (options.native) {
        const captured = f.nativeRuntimes.at(-1)
        expect(captured).toBeDefined()
        expect(captured!.runtime.target.ref.kind).toBe("child")
        expect(captured!.runtime.target.ref).toBe(target)
        captured!.runtime.assertCurrent()
      }
      expect(f.saver.serde).toBe(serde)
      expect(nativeCodec()).toBe(true)
      const beforeThreads = appDb.getDb().exec("SELECT COUNT(*) FROM threads")[0].values[0][0]
      const beforeChildren = appDb.getDb().exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]
      const inbox = f.store.captureInbox(target, 0)
      expect(inbox.rows.map(row => row.uuid)).toEqual(admittedNoteIds)
      expect(inbox.rows.every(row => row.inbox)).toBe(true)
      expect(inbox.rows.map(row => row.sequence)).toEqual(options.splitNotes ? [1, 3] : [1])
      expect(f.store.highWater(target)).toBe(admittedNoteIds.length + (options.noticeCount ?? 0))
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_deliveries WHERE conversation_id=?",
        [target.conversationId])[0].values).toEqual([[0]])

      // The existing prepared hook adds its original fresh-destination checks. Qualify
      // that exact legal window, without calling getTuple while its namespace is held.
      const database = new DatabaseSync(f.checkpointPath, { readOnly: true })
      let raw: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
      let pendingNote: ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
      try {
        database.exec("BEGIN")
        expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id=? AND checkpoint_ns=?")
          .get(f.threadId, point.namespace)?.count).toBe(1)
        raw = database.prepare("SELECT type,checkpoint,metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.parentCheckpointId!)
        expect(database.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.checkpointId)?.count).toBe(0)
        expect(database.prepare("SELECT COUNT(*) AS count FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.checkpointId)?.count).toBe(0)
        const namespaceCount = database.prepare("SELECT COUNT(*) AS count FROM writes WHERE thread_id=? AND checkpoint_ns=?")
          .get(f.threadId, point.namespace)?.count
        expect(Number(namespaceCount)).toBeLessThanOrEqual(64)
        const namespaceWrites = database.prepare(`SELECT w.checkpoint_id,w.task_id,w.channel,w.type,
          EXISTS(SELECT 1 FROM checkpoints c WHERE c.thread_id=w.thread_id
            AND c.checkpoint_ns=w.checkpoint_ns AND c.checkpoint_id=w.checkpoint_id) AS checkpoint_exists
          FROM writes w WHERE w.thread_id=? AND w.checkpoint_ns=?
          ORDER BY w.checkpoint_id,w.task_id,w.channel LIMIT 64`).all(f.threadId, point.namespace)
        expect(namespaceWrites).toHaveLength(Number(namespaceCount))
        console.info("SHARED_PREPARED_GATE_NAMESPACE_METADATA", JSON.stringify({
          parentPoint: point.parentCheckpointId, destinationPoint: point.checkpointId, writes: namespaceWrites
        }))
        const writes = namespaceWrites.filter(row => row.checkpoint_id === point.parentCheckpointId)
        expect(writes.map(row => row.channel)).toEqual([
          "branch:to:model_request", "cmbFunctionConversation", "messages"
        ])
        expect(typeof writes[0].task_id).toBe("string")
        expect(String(writes[0].task_id).length).toBeGreaterThan(0)
        expect(new Set(writes.map(row => row.task_id)).size).toBe(1)
        expect(writes.every(row => row.checkpoint_id === point.parentCheckpointId && row.type === "json"))
          .toBe(true)
        if (options.native) pendingNote = database.prepare(`SELECT type,value FROM writes
          WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND task_id=? AND channel='messages'`)
          .get(f.threadId, point.namespace, point.parentCheckpointId!, writes[0].task_id!)
        database.exec("ROLLBACK")
      } finally { database.close() }
      if (!raw || typeof raw.type !== "string" ||
        !(typeof raw.checkpoint === "string" || raw.checkpoint instanceof Uint8Array) ||
        !(typeof raw.metadata === "string" || raw.metadata instanceof Uint8Array))
        throw Error("NOT_MET: actual initial checkpoint serialization missing")
      const checkpoint = await serde.loadsTyped(raw.type, raw.checkpoint) as {
        channel_values: Record<string, unknown>
      }
      const metadata = await serde.loadsTyped(raw.type, raw.metadata) as { step: number }
      expect(metadata.step).toBe(1)
      expect(checkpoint.channel_values.cmbFunctionConversation).toBeUndefined()
      let originalNotes: BaseMessage[]
      if (options.native) {
        if (!pendingNote || typeof pendingNote.type !== "string" ||
          !(typeof pendingNote.value === "string" || pendingNote.value instanceof Uint8Array))
          throw Error("NOT_MET: actual pending note typed bytes absent")
        const value = await serde.loadsTyped(pendingNote.type, pendingNote.value)
        expect(Array.isArray(value)).toBe(true)
        expect(value as BaseMessage[]).toHaveLength(admittedNoteIds.length)
        expect((value as BaseMessage[]).every(HumanMessage.isInstance)).toBe(true)
        originalNotes = value as BaseMessage[]
        expect(originalNotes[0].id).toBe(noteId)
        expect(serializeFunctionConversationNativeMessage(originalNotes[0])).toBe(inbox.rows[0].nativePayload)
        expect(originalNotes[0].additional_kwargs.function_row)
          .toEqual(functionConversationCanonicalStamp(target, inbox.rows[0]))
        expect(f.requests).toHaveLength(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.toolEffects()).toBe(0)
      } else originalNotes = f.requests[0].filter(message => admittedNoteIds.includes(String(message.id)))
      expect(originalNotes).toHaveLength(admittedNoteIds.length)
      expect(originalNotes.map(message => message.id)).toEqual(admittedNoteIds)
      const admittedPayloads = originalNotes.map(serializeFunctionConversationNativeMessage)
      const originalPayload = serializeFunctionConversationNativeMessage(originalNotes[0])
      const originalStamp = structuredClone(originalNotes[0].additional_kwargs.function_row)
      expect(originalStamp).toMatchObject({ conversationId: target.conversationId,
        branchId: target.branchId, uuid: noteId, sequence: 1, door: "note" })
      scope.close()
      serialization.resolve()
      model.resolve()
      await expect(running).rejects.toThrow()
      await scope.whenDrained()
      expect(f.store.captureInbox(target, 0).rows.map(row => row.uuid)).toEqual(admittedNoteIds)
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_deliveries WHERE conversation_id=?",
        [target.conversationId])[0].values).toEqual([[0]])
      const afterDrain = new DatabaseSync(f.checkpointPath, { readOnly: true })
      try {
        expect(afterDrain.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.checkpointId)?.count).toBe(0)
        expect(afterDrain.prepare("SELECT COUNT(*) AS count FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?")
          .get(f.threadId, point.namespace, point.parentCheckpointId!)?.count).toBe(3)
      } finally { afterDrain.close() }

      if (options.receiptOrphan || options.mutation === "receipt-selected") {
        const receipt = appDb.getDb().exec(`SELECT checkpoint_id FROM
          function_conversation_checkpoint_receipts WHERE conversation_id=?`, [target.conversationId])
        expect(receipt[0].values).toEqual([[point.checkpointId]])
        expect(appDb.getDb().exec(`SELECT COUNT(*) FROM function_conversation_checkpoint_members
          WHERE receipt_id IN (SELECT receipt_id FROM function_conversation_checkpoint_receipts
            WHERE conversation_id=?)`, [target.conversationId])[0].values).toEqual([[1]])
        // This index is data about an absent point; the original CP and ACK checks above stay zero.
      }
      // A persisted task update is not an ACK. A fresh invocation must recover the
      // same child and let the SDK reach its real new checkpoint before delivery.
      if (options.beforeReplay) {
        expect(f.coldRequests).toHaveLength(0)
        expect(f.providerCalls()).toBe(0)
        expect(scope.isClosed()).toBe(true)
        await options.beforeReplay()
      }
      restoring = true
      if (options.ledgerMutation) {
        await expect(f.replayPending()).rejects.toThrow(/MODS_CONVERSATION_/)
        if (options.ledgerMutation === "late-payload") {
          if (lateAdmissionReturned === 0 || !lateRowChanged)
            throw Error("NOT_MET: original late admission callback and changed note boundary not reached")
          expect(lateAdmissionCalls).toBe(lateAdmissionReturned)
          expect(lateRowChanged).toBe(true)
        }
        expect(mutated).toBe(true)
        expect(f.coldRequests).toHaveLength(0)
        expect(f.providerCalls()).toBe(0)
        expect(f.toolEffects()).toBe(0)
        expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_deliveries WHERE conversation_id=?",
          [target.conversationId])[0].values).toEqual([[0]])
        return
      }
      if (options.familyDeferral === "late-mutation") {
        await expect(f.replayPending()).rejects.toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
        expect(deferralChecked).toBe(true)
        expect(deferralEntries).toBe(1)
        expect(deferralWrapperCalls).toBe(0)
        expect(deferralSourceCount).toBeGreaterThan(0)
        expect(deferralError).toMatchObject({ message: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
        expect(f.store.readReceipt(target, noteId)?.nativePayload).toBe(originalPayload)
        return
      }
      if (options.returnInputAttack && options.returnInputAttack !== "clone") {
        await expect(f.replayPending()).rejects.toThrow("MODS_CONVERSATION_NATIVE_SOURCE_INVALID")
        expect(returnInputChecks).toBe(1)
        expect(returnInputGuardError).toMatchObject({ message: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
        expect(f.coldRequests).toHaveLength(1)
        expect(f.requests).toHaveLength(f.coldRequests.length)
        expect(f.store.readReceipt(target, noteId)?.nativePayload).toBe(originalPayload)
        return
      }
      if (options.mutation || options.restoreInputAttack) {
        await expect(f.replayPending()).rejects.toThrow()
        expect(mutated || inputMutated).toBe(true)
        expect(getterCalls).toBe(0)
        expect(inputGetterCalls).toBe(0)
        expect(f.requests).toHaveLength(options.native ? 0 : 1)
        if (options.native) {
          expect(f.coldRequests).toHaveLength(0)
          expect(f.providerCalls()).toBe(0)
          expect(f.toolEffects()).toBe(0)
        }
        expect(f.notes).toHaveLength(1)
        if (options.mutation === "json-extract-udf") {
          const retained = appDb.getDb().exec(`SELECT r.uuid,r.payload_json
            FROM main.function_conversation_rows r JOIN main.function_conversation_inbox i
              ON i.conversation_id=r.conversation_id AND i.uuid=r.uuid
                AND i.branch_id=r.branch_id AND i.sequence=r.sequence
            WHERE r.conversation_id=? AND r.branch_id=? ORDER BY r.sequence`,
          [target.conversationId, target.branchId])[0]
          expect(retained?.values.map(row => row[0])).toEqual([noteId])
          for (const row of retained!.values) {
            expect(typeof row[1]).toBe("string")
            const payload: unknown = JSON.parse(row[1] as string)
            expect(payload).toMatchObject({ inbox: true, nativePayload: originalPayload })
          }
        } else expect(f.store.captureInbox(target, 0).rows.map(row => row.uuid)).toEqual([noteId])
        if (options.mutation === "json-extract-udf") {
          expect(udfRegistered).toBe(true)
          expect(sqlCallbacks).toBe(0)
          expect(appDb.getDb().exec(`SELECT COUNT(*) FROM main.function_conversation_deliveries
            WHERE conversation_id=?`, [target.conversationId])[0].values).toEqual([[0]])
        } else if (options.mutation === "temp-delivery-shadow") {
          expect(tempDeliveryCreated).toBe(true)
          expect(appDb.getDb().exec(`SELECT checkpoint_id FROM main.function_conversation_deliveries
            WHERE conversation_id=?`, [target.conversationId])[0].values)
            .toEqual([["forbidden-behind-temp-shadow"]])
          expect(appDb.getDb().exec("SELECT COUNT(*) FROM temp.function_conversation_deliveries")[0].values)
            .toEqual([[0]])
        }
        return
      }
      await f.replayPending()
      if (options.familyDeferral) {
        expect(deferralChecked).toBe(true)
        expect(deferralEntries).toBe(options.familyDeferral === "late" ? 1 : 0)
        expect(deferralWrapperCalls).toBe(options.familyDeferral === "wrapped" ? 1 : 0)
      }
      if (options.returnInputAttack === "clone") {
        expect(returnInputChecks).toBe(1)
        expect(cloneReturnRejected).toBe(true)
        expect(unknownReturnGetterCalls).toBe(0)
      }
      if (options.family) {
        expect(completedData).toBeDefined()
        expect(() => completedData!.assertDataCurrent()).toThrow()
      }
      if (options.lateScopeReader) expect(lateScopeCalls).toBe(0)
      if (options.native) {
        expect(f.coldRequests.length).toBeGreaterThan(0)
        expect(f.requests).toHaveLength(f.coldRequests.length)
        expect(f.coldRequests[0].scope).not.toBe(scope)
        expect(f.coldRequests[0].authority).toBeDefined()
        expect(f.nativeRuntimes.some(value => value.authority === f.coldRequests[0].authority &&
          value.runtime.target.ref.conversationId === target.conversationId)).toBe(true)
      } else expect(f.requests.length).toBeGreaterThan(1)
      const replayedRequest = options.native ? f.coldRequests.at(-1)!.messages : f.requests.at(-1)!
      const replayedNotes = replayedRequest.filter(message => message.id === noteId)
      expect(replayedNotes).toHaveLength(1)
      expect(serializeFunctionConversationNativeMessage(replayedNotes[0])).toBe(originalPayload)
      expect(replayedNotes[0].additional_kwargs.function_row).toEqual(originalStamp)
      for (let index = 0; index < admittedNoteIds.length; index++) {
        const actual = replayedRequest.filter(message => message.id === admittedNoteIds[index])
        expect(actual).toHaveLength(1)
        expect(serializeFunctionConversationNativeMessage(actual[0])).toBe(admittedPayloads[index])
      }
      if (options.native) {
        expect(f.providerCalls()).toBeGreaterThan(0)
        expect(pendingPublicationMatches).toBeGreaterThan(0)
        expect(f.providerAuthorities.every(authority => authority !== undefined &&
          f.nativeRuntimes.some(captured => captured.authority === authority &&
            captured.runtime.target.ref.conversationId === target.conversationId))).toBe(true)
      }
      await Promise.all(f.afterCutAppends)
      const future = f.notes.slice(admittedNoteIds.length)
      expect(f.afterCutAppends).toHaveLength(1)
      expect(f.afterCutNotes).toHaveLength(1)
      expect(future).toContain(f.afterCutNotes[0])
      const afterCutRow = f.store.readReceipt(target, f.afterCutNotes[0])
      expect(afterCutRow?.inbox).toBe(true)
      expect(afterCutRow!.sequence).toBeGreaterThan(inbox.rows.at(-1)!.sequence)
      expect(future.length).toBeGreaterThan(0)
      expect(replayedRequest.some(message => future.includes(String(message.id)))).toBe(false)
      expect(appDb.getDb().exec("SELECT uuid FROM function_conversation_inbox WHERE conversation_id=? ORDER BY sequence",
        [target.conversationId])[0].values.map(row => row[0])).toEqual(future)
      expect(f.bindings.at(-1)!.target.conversationId).toBe(target.conversationId)
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM threads")[0].values[0][0]).toBe(beforeThreads)
      expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
        .toBe(beforeChildren)
    } catch (error) {
      primaryFailed = true
      primaryError = error
      throw error
    } finally {
      serialization.resolve()
      model.resolve()
      await running.catch(() => undefined)
      try {
        if (options.mutation === "json-extract-udf" || options.mutation === "temp-delivery-shadow") {
          await closeAdversarialNativeFixture()
        } else await f.close()
      } finally {
        wrap.mockRestore(); readSpy?.mockRestore(); intakeSpy?.mockRestore()
        prepareSpy?.mockRestore(); lateScopeSpy?.mockRestore(); sourceSpy?.mockRestore()
        completeSpy?.mockRestore(); familyPlanSpy?.mockRestore(); familyRegisterSpy?.mockRestore()
        familyReadSpy?.mockRestore(); restoreDeferralExport?.()
        for (const restore of sourceRestores) restore()
      }
    }
  }

  it("defers only the original pending Restore reader and retains wrapped full checks", () =>
    settleTestWork((async () => {
      await pendingRestoreCase({ familyDeferral: "original" })
      await pendingRestoreCase({ familyDeferral: "wrapped" })
    })()))
  it("calls the original full Restore reader after a parent callback replaces its export", () =>
    settleTestWork(pendingRestoreCase({ familyDeferral: "late" })))
  it("rejects an actual raw seed mutation after a parent callback replaces the Restore export", () =>
    settleTestWork(pendingRestoreCase({ familyDeferral: "late-mutation" })))

  it("joins only genuine pending completed data and retains wrapped Family full fallback", async () => {
    const direct = { wrapped: false, calls: 0, measuring: false, samples: [] as number[], hits: 0 }
    const fallback = { wrapped: true, calls: 0, measuring: false, samples: [] as number[], hits: 0 }
    await pendingRestoreCase({ family: direct })
    await pendingRestoreCase({ family: fallback })
    expect(direct.hits).toBe(1)
    expect(fallback.hits).toBe(0)
    expect(direct.samples).toHaveLength(1)
    expect(fallback.samples).toHaveLength(1)
    expect(direct.samples[0]).toBeGreaterThan(0)
    expect(fallback.samples[0]).toBeGreaterThan(direct.samples[0])
  })
  it("keeps historical completed Active data on the original full fallback", async () => {
    const f = await fixture()
    const original = sharedRestore.completeFunctionConversationSharedActive
    let checked = 0
    const spy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
      .mockImplementation((active, input) => {
        const producer = original(active, input)
        if (producer && input.saver === f.saver && input.restore) {
          const view = sharedRestore.readFunctionConversationSharedProducer(producer, input.authority)
          if (view.history) {
            expect(sharedRestore.readFunctionConversationSharedCompletedActiveData(
              active, input.authority, view.destination)).toBeUndefined()
            checked++
          }
        }
        return producer
      })
    try { await f.start(); await f.restore(); expect(checked).toBe(1) }
    finally { try { await f.close() } finally { spy.mockRestore() } }
  })
  it("restores from genuine prepared absent-point data without acknowledging that absent point", () =>
    pendingRestoreCase({ receiptOrphan: true }))
  it("rejects a receipt moved onto the selected ordinary point by the last delivery factory", () =>
    pendingRestoreCase({ mutation: "receipt-selected" }))

  it("runs the same complete pending source chain once and preserves cloned-parent fallback", async () => {
    const contained = { clonedParent: false, calls: 0, measuring: false, samples: [] as number[] }
    const fallback = { clonedParent: true, calls: 0, measuring: false, samples: [] as number[] }
    await pendingRestoreCase({ containment: contained })
    await pendingRestoreCase({ containment: fallback })
    expect(contained.samples).toHaveLength(1)
    expect(fallback.samples).toHaveLength(1)
    expect(contained.samples[0]).toBeGreaterThan(0)
    expect(fallback.samples[0]).toBeGreaterThan(contained.samples[0])
  })
  it("runs the exact destination reader base twice and keeps a wrapped-reader full fallback", async () => {
    const original = { clonedParent: false, calls: 0, measuring: false, samples: [] as number[] }
    const wrapped = { clonedParent: false, wrappedDestination: true,
      calls: 0, measuring: false, samples: [] as number[] }
    await pendingRestoreCase({ containment: original })
    await pendingRestoreCase({ containment: wrapped })
    expect(original.samples).toEqual([2])
    expect(wrapped.samples).toEqual([3])
  })
  it("keeps the original destination current private from a late global freeze replacement", async () => {
    const probe = { clonedParent: false, attackDestinationFreeze: true, freezeExposures: 0,
      destinationQualified: false, calls: 0, measuring: false, samples: [] as number[] }
    await pendingRestoreCase({ containment: probe })
    expect(probe.destinationQualified).toBe(true)
    expect(probe.freezeExposures).toBe(0)
    expect(probe.samples).toEqual([2])
  })
  it.each(["getter", "prototype", "value"] as const)(
    "rejects a Restore input %s change made by the original full source callback", attack =>
      pendingRestoreCase({ restoreInputAttack: attack }))
  it("does not substitute a late exported Scope reader for its original private source proof", () =>
    pendingRestoreCase({ lateScopeReader: true }))

  it("restores the same child and original inbox once when close precedes its first native checkpoint",
    () => pendingRestoreCase())
  it("restores pending inbox through the actual native factory without consuming an after-cut arrival",
    () => settleTestWork(pendingRestoreCase({ native: true })))
  it("restores global note sequences 1 and 3 around a real system notice without admitting after-cut notes", () =>
    settleTestWork(pendingRestoreCase({ native: true, noticeCount: 1, splitNotes: true })))
  describe("a prepared global frontier above the note count bound", () => {
    let capFixture: { work: Promise<void>; start(): void; finish(): Promise<void> } | undefined
    beforeEach(async () => {
      const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
      const cancelled = new Error("OWNED_CAP66_FIXTURE_TEST_NOT_STARTED")
      const startedAt = performance.now()
      let testStarted = false
      const work = pendingRestoreCase({ native: true, noticeCount: 65, beforeReplay: async () => {
        ready.resolve()
        await release.promise
        if (!testStarted) throw cancelled
      } })
      const finish = async () => {
        release.resolve()
        try { await work } catch (error) { if (error !== cancelled) throw error }
      }
      capFixture = { work, start() { testStarted = true; release.resolve() }, finish }
      onTestFinished(finish)
      await Promise.race([ready.promise, work.then(() => {
        throw Error("NOT_MET: cap66 work completed before its cold-replay gate")
      })])
      console.info("SHARED_CAP66_HISTORY_SETUP_QUALIFIED", JSON.stringify({
        setupMs: performance.now() - startedAt, testStarted, coldReplayReleased: false,
        noticeCount: 65, admittedNoteCount: 1 }))
    })
    afterEach(async () => {
      const current = capFixture
      capFixture = undefined
      await current?.finish()
    })
    it("restores a global frontier above 64 when its real pending note count is one", () => {
      const current = capFixture
      if (!current) throw Error("NOT_MET: cap66 prepared fixture absent")
      current.start()
      return settleTestWork(current.work)
    })
  })
  it("restores the original ordinary seed with no notes and a nonzero global frontier", () =>
    settleTestWork(zeroNoteRestoreCase(undefined, 1)))
  it("keeps the real 64-note bound when a sixty-fifth SDK append is attempted", () =>
    settleTestWork((async () => {
      const f = await fixture(undefined, undefined, { native: true, extraNoteCount: 64 })
      try {
        await expect(f.start()).rejects.toThrow("MODS_CONVERSATION_INBOX_LIMIT")
        expect(f.notes).toHaveLength(64)
        const target = f.bindings[0].target
        expect(f.store.captureInbox(target, 0).rows.map(row => row.uuid)).toEqual(f.notes)
        expect(f.providerCalls()).toBe(0)
        expect(f.toolEffects()).toBe(0)
        expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_conversation_deliveries WHERE conversation_id=?",
          [target.conversationId])[0].values).toEqual([[0]])
      } finally { await f.close() }
    })()))
  it.each(["missing", "replaced", "payload", "late-payload", "inbox", "inbox-number",
    "role", "role-null", "meta", "meta-number"] as const)(
    "rejects %s changes to the real pending note ledger without acknowledging it", ledgerMutation =>
      settleTestWork(pendingRestoreCase({ native: true, ledgerMutation })))
  it.each(["clone", "raw-mutation", "captured-mutation"] as const)(
    "keeps the genuine cold-native ordinary return source boundary for %s", returnInputAttack =>
      settleTestWork(pendingRestoreCase({ native: true, returnInputAttack })))
  it.each(["delivery-ack", "array-append", "array-replace", "checkpoint-getter"] as const)(
    "rejects %s in the last actual delivery factory before pending publication",
    mutation => pendingRestoreCase({ mutation }))

  it.each(["json-extract-udf", "temp-delivery-shadow"] as const)(
    "rejects %s at the last real factory before pending publication",
    mutation => pendingRestoreCase({ mutation }))

  it.each(["reversed-key-order", "unused-token-fallback"] as const)(
    "reserves one actual namespace for an equivalent incarnation with %s", async variant => {
      const original = sharedRestore.captureFunctionConversationSharedActive
      let captures = 0
      const spy = vi.spyOn(sharedRestore, "captureFunctionConversationSharedActive")
        .mockImplementation(input => {
          captures++
          const incarnation = input.checkpointIncarnation
          if (captures === 1) return original(input)
          expect(typeof incarnation.token).toBe("string")
          const equivalent = variant === "reversed-key-order"
            ? { legacyCreatedAt: incarnation.legacyCreatedAt, token: incarnation.token }
            : { token: incarnation.token, legacyCreatedAt: incarnation.legacyCreatedAt + 1 }
          // Keep the actual native read, scope, authority and source guard. Only a valid
          // copied incarnation's representation changes; it cannot acquire a second slot.
          return original({ ...input, checkpointIncarnation: equivalent })
        })
      let release!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      let current: Awaited<ReturnType<typeof fixture>> | undefined
      let running: Promise<unknown> | undefined
      try {
        const f = await fixture(hold)
        current = f
        running = f.start()
        void running.catch(() => undefined)
        await vi.waitFor(() => expect(f.requests).toHaveLength(1))
        const database = appDb.getDb()
        const threads = database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]
        const children = database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]
        await expect(f.replayPending()).rejects.toThrow("REGISTRATION_CONFLICT")
        expect(captures).toBe(2)
        expect(f.requests).toHaveLength(1)
        expect(database.exec("SELECT COUNT(*) FROM threads")[0].values[0][0]).toBe(threads)
        expect(database.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0])
          .toBe(children)
      } finally {
        release()
        await running?.catch(() => undefined)
        await current?.close()
        spy.mockRestore()
      }
    })
})
