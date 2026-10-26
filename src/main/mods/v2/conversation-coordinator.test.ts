import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, StateGraph, START, END } from "@langchain/langgraph"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../../db"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionConversationCoordinator, type FunctionConversationCurrentCheckpoint,
  type FunctionConversationSharedNativeRegistrationView } from
  "./conversation-coordinator"
import type { FunctionConversationCallContext, FunctionSessionAppendSource } from
  "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"
import { readFunctionConversationTranscriptStamp } from
  "../../../shared/mods/v2/conversation-transcript"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import { captureLocalThreadRunLease, claimLocalThreadRunLease,
  releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"
import { functionConversationNoteMessage } from "../../agent/mods-conversation"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { FunctionConversationSharedCheckpointScope, readFunctionConversationSharedNativeRead } from
  "./conversation-shared-checkpointer"
import type { FunctionConversationGraphBinding } from "../../agent/mods-conversation"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-conversation-coordinator-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(candidate = false) {
  const threadId = randomUUID()
  appDb.createThread(threadId)
  const store = new FunctionConversationStore(appDb.getDb())
  const authorities = new ModRuntimeAuthorities()
  let live = true, protectedCalls = 0, changed = 0, checkpointReads = 0, notificationFails = false
  let checkpoint: FunctionConversationCurrentCheckpoint | null = null
  const notifications: Array<{ threadId: string; uuid?: string }> = []
  const assertCurrent = () => { if (!live) throw new Error("ORIGINAL_SOURCE_RETIRED") }
  const plugin = { name: "actual-installed-plugin" } as FunctionPlugin
  const context: FunctionConversationCallContext = { owner: {}, plugin,
    workspace: "C:/coordinator-workspace", threadId, readOnly: candidate,
    signal: new AbortController().signal, assertCurrent }
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities, assertScope: assertCurrent,
    readCurrentCheckpoint: async (_thread, signal, guard) => {
      checkpointReads++
      signal.throwIfAborted()
      guard()
      return checkpoint // Null until a guarded native checkpoint is supplied by the fixture.
    },
    protect: async (_context, value, signal, guard) => {
      protectedCalls++
      signal.throwIfAborted()
      guard()
      return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: (threadId, uuid) => {
      if (notificationFails) throw Error("ACTUAL_UI_LISTENER_CLOSED")
      changed++
      notifications.push({ threadId, uuid })
    }
  })
  const close = coordinator.openConversationOwner(context)
  const source: FunctionSessionAppendSource = { identity: {}, signal: context.signal, assertCurrent }
  const append = (text: string, options: { system?: boolean; agentId?: string } = {}) =>
    coordinator.appendSession(context, {
      message: { type: options.system ? "system" : "user", content: [{ type: "text", text }] },
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {})
    }, source, ticket => ticket.core(ticket.input))
  const savedCount = () => Number(appDb.getDb().exec(
    "SELECT COUNT(*) FROM function_conversation_rows"
  )[0].values[0][0])
  return { coordinator, context, source, threadId, close, append, savedCount, authorities, notifications,
    setCheckpoint: (value: FunctionConversationCurrentCheckpoint) => { checkpoint = value },
    retire: () => { live = false }, failNotifications: () => { notificationFails = true },
    protectedCalls: () => protectedCalls, changed: () => changed, checkpointReads: () => checkpointReads }
}

describe("actual owner conversation coordinator", () => {
  it.each(["recreate", "malformed", "source"] as const)(
    "rechecks the live owner through the small scope projection and rejects %s", async mode => {
      const f = fixture()
      const raw = appDb.getThreadCore(f.threadId)!
      const metadata = JSON.stringify({ ...JSON.parse(raw.metadata!),
        llmFileHistory: { content: "中文😀".repeat(40_000) }, keep: { unchanged: true } })
      appDb.updateThread(f.threadId, { metadata })
      const original = appDb.getThreadCore(f.threadId)!.metadata
      const prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
      const full = vi.spyOn(appDb, "getThreadCore")
      const scope = vi.spyOn(appDb, "getThreadRuntimeScope")
      try {
        for (let index = 0; index < 3; index++) prepared.target.assertCurrent()
        expect(full).not.toHaveBeenCalled()
        expect(scope.mock.results.length).toBeGreaterThanOrEqual(3)
        for (const result of scope.mock.results) {
          expect(result.type).toBe("return")
          expect(result.value?.metadata).not.toContain("llmFileHistory")
        }
        if (mode === "recreate") {
          appDb.deleteThread(f.threadId)
          appDb.createThread(f.threadId)
          appDb.getDb().run("UPDATE threads SET created_at=? WHERE thread_id=?",
            [raw.created_at, f.threadId])
        } else if (mode === "malformed") {
          appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", ["{broken", f.threadId])
        } else f.retire()
        expect(() => prepared.target.assertCurrent()).toThrow()
      } finally {
        full.mockRestore()
        scope.mockRestore()
        f.close()
      }
      if (mode === "source") expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(original)
    }
  )

  it.each([false, true])(
    "admits a fresh child parent across turns when preparing inside the first lease is %s",
    async (prepareInsideLease) => {
      const f = fixture()
      const firstRun = randomUUID(), secondRun = randomUUID()
      if (prepareInsideLease)
        expect(claimLocalThreadRunLease({ threadId: f.threadId, runId: firstRun, owner: "desktop" })
          .acquired).toBe(true)
      const prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
      const capture = (runId: string, target = prepared.target.ref) => {
        expect(claimLocalThreadRunLease({ threadId: f.threadId, runId, owner: "desktop" }).acquired)
          .toBe(true)
        const lease = captureLocalThreadRunLease(f.threadId)!
        const current = () => { if (!lease()) throw Error("ACTUAL_PHYSICAL_TURN_ENDED") }
        return f.coordinator.captureChildParent(f.context.workspace, f.threadId, {
          target, checkpointThreadId: f.threadId,
          runtimeCheckpointNamespace: "", signal: f.context.signal,
          initialState: prepared.state, assertCurrent: current
        }, current)
      }
      try {
        const first = capture(firstRun)!
        const families = Reflect.get(f.coordinator, "families") as {
          readParent(proof: typeof first): { assertFactory(): void }
        }
        const firstParent = families.readParent(first)
        releaseLocalThreadRunLease(f.threadId, "desktop", firstRun)
        const second = capture(secondRun)!
        expect(second).not.toBe(first)
        expect(() => firstParent.assertFactory()).toThrow("ACTUAL_PHYSICAL_TURN_ENDED")
        expect(() => families.readParent(second).assertFactory()).not.toThrow()
        expect(() => capture(secondRun, { ...prepared.target.ref, conversationId: randomUUID() }))
          .toThrow("MODS_CONVERSATION_TARGET_CHANGED")
        f.retire()
        expect(() => capture(secondRun)).toThrow("ORIGINAL_SOURCE_RETIRED")
      } finally {
        releaseLocalThreadRunLease(f.threadId, "desktop", firstRun)
        releaseLocalThreadRunLease(f.threadId, "desktop", secondRun)
        f.close()
      }
    }
  )

  it("uses the real shared graph admission with an independent UI bucket and fixed native reader", async () => {
    const f = fixture(), prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    const runId = randomUUID()
    expect(claimLocalThreadRunLease({ threadId: f.threadId, runId, owner: "desktop" }).acquired).toBe(true)
    const parent = f.authorities.create({ workspace: f.context.workspace, threadId: f.threadId,
      turnId: runId }, f.context.signal)
    const parentProof = f.coordinator.captureChildParent(f.context.workspace, f.threadId,
      { target: prepared.target.ref, checkpointThreadId: f.threadId, runtimeCheckpointNamespace: "",
        signal: f.context.signal, initialState: prepared.state,
        assertCurrent: () => parent.authority.assertLive() }, () => parent.authority.assertLive())
    if (!parentProof) throw Error("ACTUAL_PARENT_REQUIRED")
    const child = f.authorities.create({ workspace: f.context.workspace, threadId: f.threadId,
      agentId: `mod-task:${randomUUID()}`, turnId: randomUUID() }, f.context.signal, parent.authority)
    const bucket = appDb.createThread(randomUUID(), { workspacePath: f.context.workspace,
      parentThreadId: f.threadId, isInternalFlowRuntime: true,
      isFunctionConversationProjection: true, modsAgentRunId: child.authority.turnId })
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`))
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, incoming) => incoming, default: () => [] }) })
    let scope: FunctionConversationSharedCheckpointScope | undefined
    let binding: FunctionConversationGraphBinding | undefined
    let closeRegistration: (() => void) | undefined
    const shared: { view: FunctionConversationSharedNativeRegistrationView | undefined } = {
      view: undefined
    }
    let savedChildUuid: unknown, savedParentUuid: unknown
    const parentGraph = new StateGraph(state).addNode("native-tools", async (_state, config) => {
      const current = new FunctionConversationSharedCheckpointScope({ saver,
        authority: child.authority, parentConfig: config, parentGraphNamespace: "",
        signal: f.context.signal, assertCurrent: () => child.authority.assertLive(),
        admit: async proof => {
          const read = readFunctionConversationSharedNativeRead(proof, saver, child.authority)
          const registered = f.coordinator.registerSharedChild(parentProof, { invocation: {},
            authority: child.authority, checkpointThreadId: f.threadId,
            checkpointIncarnation: captureThreadIncarnation(appDb.getThreadCore(f.threadId)!),
            checkpointNamespace: read.namespace, signal: f.context.signal,
            assertCurrent: read.assertCurrent, destination: { threadId: bucket.thread_id,
              incarnation: captureThreadIncarnation(bucket), assertCurrent: () => {} },
            saver, nativeRead: proof, readCheckpoint: async (signal, guard) => {
              const tuple = await current.readCurrent(signal, guard)
              const messages: unknown = tuple?.checkpoint.channel_values.messages
              if (tuple && !Array.isArray(messages)) throw Error("ACTUAL_NATIVE_MESSAGES_REQUIRED")
              return tuple ? { checkpointId: tuple.checkpoint.id,
                messages: Array.isArray(messages) ? messages : [] } : null
            } })
          closeRegistration = registered.close
          shared.view = f.coordinator.readSharedNativeRegistration(
            registered.registration, child.authority)
          return registered.binding
        },
        // This graph proves native selection/projection, not the separate delivery ACK observer.
        delivery: actual => actual
      })
      scope = current
      const childGraph = new StateGraph(state).addNode("native-model", async (_input, runtime) => {
        binding = current.captureNode({ configurable: runtime.configurable })
        const append = (text: string, agentId?: string) => f.coordinator.appendSession(f.context,
          { message: { type: "user", content: [{ type: "text", text }] },
            ...(agentId ? { agentId } : {}) },
          { identity: {}, signal: f.context.signal,
            assertCurrent: () => child.authority.assertLive() }, ticket => ticket.core(ticket.input))
        savedChildUuid = (await append("only actual shared child", child.authority.agentId)).uuid
        savedParentUuid = (await append("original main selected by omission")).uuid
        return { messages: [new AIMessage({ id: randomUUID(), content: "shared native answer" })] }
      }).addEdge(START, "native-model").addEdge("native-model", END).compile()
      return current.run(() => childGraph.invoke({ messages: [new HumanMessage("shared seed")] },
        { ...config, configurable: { ...config.configurable, __pregel_checkpointer: current.checkpointer },
          durability: "async" }))
    }).addEdge(START, "native-tools").addEdge("native-tools", END).compile({ checkpointer: saver })
    try {
      await parentGraph.invoke({ messages: [new HumanMessage("original parent seed")] },
        { configurable: { thread_id: f.threadId }, durability: "async" })
      if (!binding || !scope) throw Error("ACTUAL_SHARED_BINDING_REQUIRED")
      expect(binding.checkpointThreadId).toBe(f.threadId)
      expect(binding.target.conversationId).not.toBe(prepared.target.ref.conversationId)
      expect(appDb.getThreadMessages(bucket.thread_id).map(row => row.id)).toEqual([savedChildUuid])
      expect(appDb.getThreadMessages(f.threadId).map(row => row.id)).toEqual([savedParentUuid])
      const before = f.checkpointReads()
      expect(await f.coordinator.readConversation(f.context,
        { as: "api", agentId: child.authority.agentId })).toEqual([
        { role: "assistant", content: [{ type: "text", text: "shared native answer" }] },
        { role: "user", content: [{ type: "text", text: "only actual shared child" }] }
      ])
      expect(f.checkpointReads()).toBe(before)
      expect(f.coordinator.captureSharedRuntime(child.authority)?.target.conversationId)
        .toBe(binding.target.conversationId)
      const view = shared.view
      if (!view) throw Error("ACTUAL_SHARED_REGISTRATION_REQUIRED")
      const originalCurrent = f.coordinator.store.assertCurrent
      let retireAfterTargetRead = false
      const storeCurrent = vi.spyOn(f.coordinator.store, "assertCurrent")
        .mockImplementation(function (this: FunctionConversationStore, ref) {
          Reflect.apply(originalCurrent, this, [ref])
          if (retireAfterTargetRead && ref.conversationId === view.target.ref.conversationId)
            child.release()
        })
      const childChecks = () => storeCurrent.mock.calls.filter(([ref]) =>
        ref.conversationId === view.target.ref.conversationId).length
      try {
        view.assertDataCurrent()
        const dataChecks = childChecks()
        storeCurrent.mockClear()
        view.target.assertCurrent()
        const targetChecks = childChecks()
        expect(targetChecks).toBe(1)
        storeCurrent.mockClear()
        view.assertCurrent()
        expect(childChecks()).toBe(dataChecks + targetChecks)
        storeCurrent.mockClear()
        retireAfterTargetRead = true
        expect(() => view.assertCurrent()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
        expect(childChecks()).toBe(1)
      } finally {
        storeCurrent.mockRestore()
      }
      closeRegistration?.()
      expect(() => view.assertCurrent()).toThrow("MODS_CONVERSATION_TARGET_CLOSED")
      await expect(f.coordinator.readConversation(f.context,
        { as: "api", agentId: child.authority.agentId }))
        .resolves.toEqual({ deny: "MODS_CONVERSATION_UNAVAILABLE" })
      expect(await f.append("parent survives shared retirement")).toHaveProperty("uuid")
    } finally {
      scope?.close()
      closeRegistration?.()
      if (scope) await scope.whenDrained()
      child.release(); parent.release(); f.close()
      releaseLocalThreadRunLease(f.threadId, "desktop", runId)
      await saver.close()
    }
  })

  it("joins exactly one canonical note from the actual checkpoint without adding a duplicate", async () => {
    const f = fixture()
    try {
      const saved = await f.append("canonical checkpoint note")
      if (typeof saved.uuid !== "string" || !saved.uuid) throw Error("ACTUAL_SAVED_UUID_REQUIRED")
      const binding = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
      const row = f.coordinator.store.readReceipt(binding.target.ref, saved.uuid)
      if (!row) throw Error("ACTUAL_SAVED_NOTE_REQUIRED")
      f.setCheckpoint({ checkpointId: randomUUID(), state: binding.state,
        messages: [functionConversationNoteMessage(row, binding.target.ref)] })
      expect(await f.coordinator.readConversation(f.context, { as: "api" }))
        .toEqual([{ role: "user", content: [{ type: "text", text: "canonical checkpoint note" }] }])
      expect(f.coordinator.store.readRows(binding.target.ref)).toHaveLength(1)
    } finally { f.close() }
  })

  it.each(["origin", "door", "messageType", "isMeta", "conversationId", "branchId",
    "sequence", "actual-id", "missing-stamp", "duplicate", "content", "native-role",
    "response-metadata", "additional-metadata", "provider-name"])(
    "rejects a current checkpoint note whose %s differs from the actual saved occurrence",
    async changedField => {
      const f = fixture()
      try {
        const saved = await f.append("original canonical note")
        if (typeof saved.uuid !== "string" || !saved.uuid) throw Error("ACTUAL_SAVED_UUID_REQUIRED")
        const binding = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
        const row = f.coordinator.store.readReceipt(binding.target.ref, saved.uuid)
        if (!row) throw Error("ACTUAL_SAVED_NOTE_REQUIRED")
        const canonical = functionConversationNoteMessage(row, binding.target.ref)
        const stamp = readFunctionConversationTranscriptStamp(canonical)
        if (!stamp) throw Error("ACTUAL_NOTE_STAMP_REQUIRED")
        const altered = { ...stamp }
        if (changedField === "origin") altered.origin = { kind: "plugin", name: "foreign-plugin" }
        if (changedField === "door") altered.door = "delivery"
        if (changedField === "messageType") altered.messageType = "system"
        if (changedField === "isMeta") delete altered.isMeta
        if (changedField === "conversationId") altered.conversationId = randomUUID()
        if (changedField === "branchId") altered.branchId = randomUUID()
        if (changedField === "sequence") altered.sequence++
        const kwargs = { isMeta: true,
          ...(changedField !== "missing-stamp" ? { function_row: altered } : {}) }
        const fields = { id: changedField === "actual-id" ? randomUUID() : row.uuid,
          content: changedField === "content" ? "changed checkpoint content" : canonical.content,
          additional_kwargs: kwargs }
        const candidate = changedField === "native-role" ? new SystemMessage(fields) :
          new HumanMessage(fields)
        if (changedField === "response-metadata") candidate.response_metadata = { provider: "forged" }
        if (changedField === "additional-metadata") candidate.additional_kwargs.provider_occurrence = 2
        if (changedField === "provider-name") candidate.name = "different-native-provider"
        f.setCheckpoint({ checkpointId: randomUUID(), state: binding.state,
          messages: changedField === "duplicate" ? [candidate, canonical] : [candidate] })
        await expect(f.coordinator.readConversation(f.context, { as: "api" }))
          .rejects.toThrow("MODS_CONVERSATION_CHECKPOINT_CHANGED")
        expect(f.coordinator.store.readRows(binding.target.ref)).toHaveLength(1)
      } finally { f.close() }
    })

  it.each(["{broken", "null", "[]"])(
    "keeps ordinary native chat and owner registration available with legacy metadata %s",
    async metadata => {
      const f = fixture()
      try {
        f.close()
        appDb.getDb().run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [metadata, f.threadId])
        const before = appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")
        expect(await f.coordinator.prepareNativeRuntime(f.context.workspace, f.threadId,
          f.context.signal, () => {})).toBeUndefined()
        expect(f.checkpointReads()).toBe(0)
        const close = f.coordinator.openConversationOwner({ ...f.context, owner: {} })
        close()
        expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")).toEqual(before)
      } finally { f.close() }
    })

  it("does not change a real saved ACK when its UI notification fails", async () => {
    const f = fixture()
    f.failNotifications()
    const saved = await f.append("real saved notification", { system: true })
    expect(appDb.getThreadMessages(f.threadId)[0].id).toBe(saved.uuid)
    expect(f.changed()).toBe(0)
    f.close()
  })

  it("binds two real independent physical children to one captured family without changing tool authority", async () => {
    const f = fixture(), prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    const parentAuthority = f.authorities.create({ workspace: f.context.workspace, threadId: f.threadId,
      turnId: randomUUID() }, f.context.signal)
    const parent = f.coordinator.captureChildParent(f.context.workspace, f.threadId,
      { target: prepared.target.ref, checkpointThreadId: f.threadId, runtimeCheckpointNamespace: "",
        signal: f.context.signal, initialState: prepared.state,
        assertCurrent: () => parentAuthority.authority.assertLive() },
      () => parentAuthority.authority.assertLive())
    if (!parent) throw Error("ACTUAL_PARENT_FAMILY_REQUIRED")
    const create = () => {
      const physical = randomUUID(), runId = randomUUID(), agentId = randomUUID()
      const row = appDb.createThread(physical, { workspacePath: f.context.workspace,
        parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
      expect(claimLocalThreadRunLease({ threadId: physical, runId, owner: "mods" }).acquired).toBe(true)
      const closeFactory = f.coordinator.registerIndependentChild(parent, { invocation: {},
        physicalThreadId: physical, agentId, runId, checkpointIncarnation: captureThreadIncarnation(row),
        signal: f.context.signal, assertCurrent: () => {} })
      const instance = f.authorities.create({ workspace: f.context.workspace,
        threadId: physical, agentId, turnId: runId }, f.context.signal)
      const context: FunctionConversationCallContext = { ...f.context, owner: {}, threadId: physical,
        assertCurrent: () => instance.authority.assertLive() }
      const closeOwner = f.coordinator.openConversationOwner(context)
      const graph = f.coordinator.prepareIndependentRuntime(instance.authority, context.signal,
        () => instance.authority.assertLive())
      if (!graph) throw Error("ACTUAL_CHILD_GRAPH_REQUIRED")
      const append = (text: string, explicit?: string) => f.coordinator.appendSession(context,
        { message: { type: "user", content: [{ type: "text", text }] },
          ...(explicit ? { agentId: explicit } : {}) },
        { identity: {}, signal: context.signal, assertCurrent: context.assertCurrent },
        ticket => ticket.core(ticket.input))
      return { physical, runId, agentId, graph, context, instance, append,
        close: () => { closeFactory(); closeOwner(); instance.release()
          releaseLocalThreadRunLease(physical, "mods", runId) } }
    }
    const a = create(), b = create()
    try {
      const main = await a.append("default goes to original family main")
      const first = await a.append("first actual child only", a.agentId)
      const second = await b.append("second actual child only", b.agentId)
      expect(appDb.getThreadMessages(f.threadId).map(row => row.id)).toEqual([main.uuid])
      expect(appDb.getThreadMessages(a.physical).map(row => row.id)).toEqual([first.uuid])
      expect(appDb.getThreadMessages(b.physical).map(row => row.id)).toEqual([second.uuid])
      expect(a.graph.ref.conversationId).not.toBe(b.graph.ref.conversationId)
      expect(a.graph.ref.logicalSessionId).toBe(prepared.target.ref.logicalSessionId)
      expect(a.graph.checkpointIncarnation).toEqual(captureThreadIncarnation(appDb.getThreadCore(a.physical)!))
      expect(a.instance.authority.threadId).toBe(a.physical)
      expect(f.notifications.slice(-3)).toEqual([{ threadId: f.threadId, uuid: main.uuid },
        { threadId: a.physical, uuid: first.uuid }, { threadId: b.physical, uuid: second.uuid }])
      const api = await f.coordinator.readConversation(a.context, { as: "api", agentId: a.agentId })
      expect(api).toEqual([{ role: "user", content: [{ type: "text", text: "first actual child only" }] }])
      parentAuthority.release()
      expect(await a.append("family stays pinned after original parent turn ends"))
        .toHaveProperty("uuid")
      a.close()
      expect(await f.append("closing child does not close parent resident")).toHaveProperty("uuid")
      await expect(a.append("closed child cannot borrow sibling", b.agentId)).rejects.toThrow()
    } finally { a.close(); b.close(); parentAuthority.release(); f.close() }
  })

  it("keeps child candidate and missing real factory paths at zero persistent conversation writes", async () => {
    const f = fixture(), prepared = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    const parent = f.coordinator.captureChildParent(f.context.workspace, f.threadId,
      { target: prepared.target.ref, checkpointThreadId: f.threadId, runtimeCheckpointNamespace: "",
        signal: f.context.signal, assertCurrent: () => {} }, () => {})
    if (!parent) throw Error("ACTUAL_PARENT_FAMILY_REQUIRED")
    const count = () => appDb.getDb().exec("SELECT COUNT(*) FROM function_conversations")
    const physical = randomUUID(), runId = randomUUID(), agentId = randomUUID()
    const row = appDb.createThread(physical, { workspacePath: f.context.workspace,
      parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId })
    const context = { ...f.context, owner: {}, threadId: physical, readOnly: true }
    const before = count()
    const unboundClose = f.coordinator.openConversationOwner(context)
    await expect(f.coordinator.appendSession({ ...context, readOnly: false },
      { message: { type: "user", content: [{ type: "text", text: "unbound must not alias main" }] } },
      f.source, ticket => ticket.core(ticket.input))).rejects.toThrow("UNAVAILABLE")
    expect(await f.coordinator.prepareNativeRuntime(f.context.workspace, physical,
      context.signal, () => {})).toBeUndefined()
    expect(count()).toEqual(before)
    unboundClose()
    claimLocalThreadRunLease({ threadId: physical, owner: "mods", runId })
    const closeFactory = f.coordinator.registerIndependentChild(parent, { invocation: {},
      physicalThreadId: physical, agentId, runId, checkpointIncarnation: captureThreadIncarnation(row),
      signal: context.signal, assertCurrent: () => {} })
    const instance = f.authorities.create({ workspace: f.context.workspace, threadId: physical,
      turnId: runId, agentId }, context.signal)
    const candidate = { ...context, owner: {} }, closeCandidate = f.coordinator.openConversationOwner(candidate)
    try {
      await expect(f.coordinator.appendSession(candidate,
        { message: { type: "user", content: [{ type: "text", text: "candidate" }] } },
        f.source, ticket => ticket.core(ticket.input))).rejects.toThrow("UNAVAILABLE")
      expect(count()).toEqual(before)
      f.coordinator.activateConversationOwner({ ...candidate, readOnly: false })
      await expect(f.coordinator.appendSession(candidate,
        { message: { type: "user", content: [{ type: "text", text: "old candidate receipt" }] } },
        f.source, ticket => ticket.core(ticket.input))).rejects.toThrow("UNAVAILABLE")
      expect(appDb.getThreadMessages(physical)).toEqual([])
    } finally { closeFactory(); closeCandidate(); instance.release()
      releaseLocalThreadRunLease(physical, "mods", runId); f.close() }
  })

  it("leaves ordinary native chat available with no loaded SDK owner or saved main", async () => {
    const f = fixture()
    f.close()
    const before = appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")
    expect(await f.coordinator.prepareNativeRuntime(f.context.workspace, f.threadId,
      new AbortController().signal, () => {})).toBeUndefined()
    expect(f.checkpointReads()).toBe(0)
    expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")).toEqual(before)
  })

  it("keeps saved notes available to the actual native graph after the SDK owner retires", async () => {
    const f = fixture()
    const note = await f.append("saved before revoke")
    const original = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    f.close()
    expect(() => original.target.assertCurrent()).toThrow()
    let nativeLive = true
    const assertNative = () => { if (!nativeLive) throw new Error("ORIGINAL_NATIVE_RUN_RETIRED") }
    const reads = f.checkpointReads()
    const current = await f.coordinator.prepareNativeRuntime(f.context.workspace, f.threadId,
      new AbortController().signal, assertNative)
    expect(current?.ref.conversationId).toBe(original.target.ref.conversationId)
    expect(current?.state.frontier).toBe(0)
    expect(f.checkpointReads()).toBe(reads + 1)
    expect(f.coordinator.store.captureInbox(current!.ref, 0).rows[0].uuid).toBe(note.uuid)
    expect(() => current!.assertCurrent()).not.toThrow()
    nativeLive = false
    expect(() => current!.assertCurrent()).toThrow("ORIGINAL_NATIVE_RUN_RETIRED")
  })

  it("does not strand an owner when registration or late activation fails", async () => {
    const f = fixture(true)
    let calls = 0
    const rejected = { ...f.context, owner: {}, readOnly: false,
      assertCurrent: () => { throw new Error("INITIAL_NATIVE_GUARD_REJECTED") } }
    expect(() => f.coordinator.openConversationOwner(rejected))
      .toThrow("INITIAL_NATIVE_GUARD_REJECTED")
    const candidate = { ...f.context, owner: {}, readOnly: true,
      assertCurrent: () => {
        if (++calls === 2) throw new Error("LATE_ACTIVATION_REJECTED")
      } }
    const close = f.coordinator.openConversationOwner(candidate)
    expect(() => f.coordinator.activateConversationOwner({ ...candidate, readOnly: false }))
      .toThrow("LATE_ACTIVATION_REJECTED")
    const fresh = { ...f.context, owner: {}, readOnly: false, assertCurrent: () => {} }
    const closeFresh = f.coordinator.openConversationOwner(fresh)
    expect(await f.coordinator.appendSession(fresh,
      { message: { type: "user", content: [{ type: "text", text: "fresh owner works" }] } },
      { ...f.source, assertCurrent: () => {} }, ticket => ticket.core(ticket.input)))
      .toHaveProperty("uuid")
    closeFresh()
    close()
    f.close()
  })
  it("saves an idle note atomically without a runtime and immediately exposes its full row", async () => {
    const f = fixture(), before = f.savedCount()
    const result = await f.append("Use my project review checklist")
    expect(result).toMatchObject({ message: { type: "user", role: "user", isMeta: true } })
    expect(f.savedCount()).toBe(before + 1)
    const displayed = appDb.getThreadMessages(f.threadId)
    expect(displayed).toHaveLength(1)
    expect(readFunctionConversationTranscriptStamp(displayed[0])?.door).toBe("note")
    const binding = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    expect(binding.state.frontier).toBe(0)
    const rows = f.coordinator.store.readRows(binding.target.ref)
    expect(rows[0].uuid).toBe(result.uuid)
    expect(rows[0].message.content).toEqual([{ type: "text", text: "Use my project review checklist" }])
    expect(f.coordinator.store.captureInbox(binding.target.ref, 0).rows).toHaveLength(1)
    expect(f.protectedCalls()).toBe(1)
    expect(f.changed()).toBe(1)
    f.close()
  })

  it("keeps a system notification out of the provider inbox with no invented user role", async () => {
    const f = fixture()
    const result = await f.append("Review was saved", { system: true })
    expect(result.message).toMatchObject({ type: "system" })
    expect(result.message).not.toHaveProperty("role")
    const binding = await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    expect(f.coordinator.store.captureInbox(binding.target.ref, 0).rows).toEqual([])
    expect(appDb.getThreadMessages(f.threadId)[0].role).toBe("system")
    f.close()
  })

  it("does not create candidate metadata and cannot activate an old candidate call receipt", async () => {
    const f = fixture(true)
    const before = appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")
    await expect(f.append("candidate may not write")).rejects.toThrow("MODS_CONVERSATION_UNAVAILABLE")
    expect(appDb.getDb().exec("SELECT COUNT(*) FROM function_logical_sessions")).toEqual(before)
    const active = { ...f.context, readOnly: false }
    f.coordinator.activateConversationOwner(active)
    await f.coordinator.appendSession(active,
      { message: { type: "user", content: [{ type: "text", text: "adopted" }] } },
      f.source, ticket => ticket.core(ticket.input))
    await expect(f.append("old candidate receipt")).rejects.toThrow("MODS_CONVERSATION_UNAVAILABLE")
    expect(appDb.getThreadMessages(f.threadId)).toHaveLength(1)
    f.close()
  })

  it.each(["main", "unknown-child", ""])("does not alias explicit %s to main", async agentId => {
    const f = fixture(), before = f.savedCount()
    await expect(f.append("wrong target", { agentId })).rejects.toThrow()
    expect(f.savedCount()).toBe(before)
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    f.close()
  })

  it("rejects a shape-only ACK with no actual saved row", async () => {
    const f = fixture(), before = f.savedCount()
    await expect(f.coordinator.appendSession(f.context,
      { message: { type: "user", content: [{ type: "text", text: "fake" }] } }, f.source,
      async ticket => ({ uuid: ticket.input.uuid, message: ticket.input.message })))
      .rejects.toThrow("MODS_SESSION_APPEND_RESULT")
    expect(f.savedCount()).toBe(before)
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    f.close()
  })

  it("keeps a committed row when the original owner closes before the public ACK", async () => {
    const f = fixture(), before = f.savedCount()
    await expect(f.coordinator.appendSession(f.context,
      { message: { type: "user", content: [{ type: "text", text: "real committed note" }] } },
      f.source, async ticket => {
        const result = await ticket.core(ticket.input)
        f.close()
        return result
      })).rejects.toThrow()
    expect(f.savedCount()).toBe(before + 1)
    expect(appDb.getThreadMessages(f.threadId)).toHaveLength(1)
    expect(f.changed()).toBe(0)
  })

  it("cannot use a new thread incarnation or retired source to finish admission", async () => {
    const f = fixture(), before = f.savedCount()
    await f.coordinator.prepareRuntime(f.context.workspace, f.threadId)
    appDb.deleteThread(f.threadId)
    appDb.createThread(f.threadId)
    await expect(f.append("replacement thread")).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.savedCount()).toBe(before)
    f.close()
    const second = fixture()
    second.retire()
    await expect(second.append("retired source")).rejects.toThrow("ORIGINAL_SOURCE_RETIRED")
    expect(appDb.getThreadMessages(second.threadId)).toEqual([])
    second.close()
  })
})
