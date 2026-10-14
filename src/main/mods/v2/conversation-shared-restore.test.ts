import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, Command, interrupt, StateGraph, START, END } from "@langchain/langgraph"
import { tool } from "@langchain/core/tools"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { z } from "zod"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { currentFunctionExecution } from "./execution-context"
import { FunctionConversationCoordinator, readFunctionConversationSharedNativeRegistration,
  type FunctionConversationSharedNativeRegistration } from "./conversation-coordinator"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import type { FunctionConversationCallContext } from "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { createFunctionConversationMiddleware } from "../../agent/mods-conversation"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"
import { captureFunctionConversationNativeTaskConfig, createFunctionConversationSharedAgent } from
  "../../agent/mods-conversation-shared-invocation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import type { FunctionConversationSharedCheckpointScope } from "./conversation-shared-checkpointer"
import * as sharedRestore from "./conversation-shared-restore"
import { ModRuntimeAuthorities, type ModRuntimeAuthority } from "../runtime-instance"
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
}) {
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
  const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`), undefined,
    { maxRootCheckpoints: 3, maxRootForkBoundaryCheckpoints: 30,
      maxRootForkBoundaryBytes: 48 * 1024 * 1024 })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(parent.authority, signal)
  const bindings: FunctionConversationGraphBinding[] = [], requests: BaseMessage[][] = []
  const notes: string[] = [], agents: string[] = [], turns: string[] = []
  const scopes: FunctionConversationSharedCheckpointScope[] = []
  let toolEffects = 0
  let checkpointBeforeTools = ""
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
      turns.push(authority.turnId)
      bindings.push(scope.captureNode(runtime))
      const result = await coordinator.appendSession(context,
        { agentId: authority.agentId, message: { type: "user",
          content: [{ type: "text", text: `note from actual current run ${notes.length + 1}` }] } },
        { identity: {}, signal, assertCurrent: guard }, ticket => ticket.core(ticket.input))
      if (typeof result.uuid !== "string") throw Error("ACTUAL_NOTE_UUID_REQUIRED")
      notes.push(result.uuid)
      return undefined
    },
    wrapModelCall: async (request, handler) => {
      const scope = capture()
      if (!scope) throw Error("ACTUAL_NATIVE_SCOPE_REQUIRED")
      scopes.push(scope)
      requests.push([...request.messages])
      if (requests.length === 1) await holdModel
      return handler(request)
    },
    afterModel: () => {
      if (requests.length === 1) interrupt("actual shared task pause before its original ToolNode")
      return undefined
    }
  })
  const child = createFunctionConversationSharedAgent({
    model: new FakeToolCallingModel({ toolCalls: [[{ id: "actual-resumed-tool-call",
      name: "actual_restore_tool", args: {} }], [], []] }),
    tools: [tool(() => { toolEffects++; return "Actual original tool result" },
      { name: "actual_restore_tool", description: "Real fixture ToolNode action", schema: z.object({}) })],
    systemPrompt: "Actual shared task", middleware: [record,
      createFunctionConversationMiddleware({ store, capture: runtime => capture()?.captureNode(runtime) })]
  }, capture)
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
    return { messages: result.messages.slice(-1) }
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
    await saver.close()
  }
  return { manager, store, saver, graph, parent, workspace, signal, runId,
    threadId, bindings, requests, notes, agents, turns, scopes,
    start, restore, replayPending, close, toolEffects: () => toolEffects }
}

describe("actual shared child checkpoint restore admission", () => {
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
