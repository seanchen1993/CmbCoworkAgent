import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { types as utilTypes } from "node:util"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { Annotation, StateGraph, START, END } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { ModsManager } from "../manager"
import { ModGuestRuntime, type ModHostCall } from "../guest-runtime"
import type { ModObject } from "../../../shared/mods/types"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { currentFunctionExecution } from "./execution-context"
import { FunctionConversationCoordinator } from "./conversation-coordinator"
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
import * as sharedRestore from "./conversation-shared-restore"
import { readFunctionConversationSharedNativeRead } from "./conversation-shared-checkpointer"
import { readFunctionConversationNativePolicySource } from "../native-conversation-policy-source"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../../services/thread-incarnation"
import { captureConversationCheckpointRead, functionConversationCanonicalStamp,
  readFunctionConversationCheckpointMembership } from
  "../../checkpointer/function-conversation-checkpoint-membership"
import { serializeFunctionConversationNativeMessage } from
  "../../agent/function-conversation-native-message"
import { FunctionNativeMessageProtector } from "../../agent/native-message-protector"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
// Replace only the utility-process transport. The original managed policy runs in real QuickJS.
vi.mock("../runtime-client", () => ({ ModRuntimeClient: class {
  version = 0
  readonly guests = new Map<string, ModGuestRuntime>()
  async load(id: string, code: string) {
    const guest = await ModGuestRuntime.create(code)
    this.guests.set(id, guest)
    return guest.registrations
  }
  invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
    const guest = this.guests.get(id)
    if (!guest) throw Error("ACTUAL_MANAGED_POLICY_GUEST_REQUIRED")
    return guest.invoke(handler, event, call)
  }
  stop() {
    for (const guest of this.guests.values()) guest.dispose()
    this.guests.clear(); this.version++
  }
} }))
import * as appDb from "../../db"

let directory = ""
interface FixtureWork {
  cancel(): void
  readonly completion: Promise<void>
}
const residentFixtures = new Set<FixtureWork>()
const diagnosticTables = new Set([
  "sqlite_master", "function_conversation_fork_imports", "function_logical_sessions",
  "function_conversations", "threads", "function_conversation_native_destinations",
  "function_conversation_rows", "function_conversation_inbox", "thread_messages",
  "thread_message_fragments", "thread_message_fragment_states",
  "function_conversation_projection_receipts", "function_conversation_presentation_dispositions",
  "function_conversation_branches", "function_conversation_checkpoint_receipts",
  "function_conversation_checkpoint_members", "function_conversation_deliveries",
  "thread_message_buckets"
])
function diagnosticQueryCategory(sql: string): string {
  const table = /\bFROM\s+(\w+)/i.exec(sql)?.[1]
  return table && diagnosticTables.has(table) ? table : "other"
}

function trackFixture(
  run: (bindCancellation: (cancel: () => void) => void) => Promise<void>,
  registry = residentFixtures
): Promise<void> {
  let requested = false, cancellation: (() => void) | undefined
  const completion = Promise.resolve().then(() => run(cancel => {
    cancellation = cancel
    if (requested) cancellation()
  }))
  const work: FixtureWork = { completion, cancel() {
    requested = true
    cancellation?.()
  } }
  // The body cannot start until this exact work and its early-cancellation latch are retained.
  registry.add(work)
  residentFixtures.add(work)
  const settled = () => { registry.delete(work); residentFixtures.delete(work) }
  void completion.then(settled, settled)
  return completion
}

async function cancelFixtures(registry = residentFixtures): Promise<PromiseSettledResult<void>[]> {
  const works = [...registry]
  for (const work of works) work.cancel()
  return Promise.allSettled(works.map(work => work.completion))
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-native-host-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { await cancelFixtures() })

afterAll(async () => {
  // Vitest timeout does not stop an async body. Its real finally owns the Saver and callbacks.
  await cancelFixtures()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

describe("actual shared task native factory", () => {
  it("retains cancellation before a fixture body binds and observes an undefined rejection", async () => {
    const registry = new Set<FixtureWork>()
    let cancelled = false
    const completion = trackFixture(async bindCancellation => {
      bindCancellation(() => { cancelled = true })
      expect(cancelled).toBe(true)
      throw undefined
    }, registry)
    const stopped = await cancelFixtures(registry)
    const original = await Promise.allSettled([completion])
    expect(stopped).toEqual([{ status: "rejected", reason: undefined }])
    expect(original).toEqual(stopped)
    expect(registry.size).toBe(0)
  })

  it("keeps the real Saver and AppDB alive until a cancelled node's physical finally", async () => {
    const registry = new Set<FixtureWork>(), controller = new AbortController()
    const database = appDb.getDb(), threadId = randomUUID()
    const thread = appDb.createThread(threadId, { workspacePath: directory })
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.held-checkpoint.sqlite`))
    let release!: () => void, enter!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { enter = resolve })
    let nodeRun: Promise<unknown> | undefined, exited = false, closed = 0
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, incoming) => incoming, default: () => [] }) })
    const config = { configurable: { thread_id: threadId }, signal: controller.signal }
    const graph = new StateGraph(state).addNode("physical-work", (_state, originalConfig) => {
      const actual = (async () => {
        try {
          enter()
          await held
          originalConfig.signal?.throwIfAborted()
          return { messages: [] as BaseMessage[] }
        } finally { exited = true }
      })()
      nodeRun = actual
      return actual
    }).addEdge(START, "physical-work").addEdge("physical-work", END)
      .compile({ checkpointer: saver })
    const completion = trackFixture(async bindCancellation => {
      bindCancellation(() => controller.abort(Error("ACTUAL_HELD_NODE_CANCELLED")))
      const run = graph.invoke({ messages: [new HumanMessage("actual held input")] }, config)
      try { await run }
      finally {
        await Promise.allSettled([run])
        if (nodeRun) await Promise.allSettled([nodeRun])
        await saver.close()
        closed++
        if (nodeRun) expect(exited).toBe(true)
      }
    }, registry)
    try {
      await Promise.race([entered, completion.then(() => {
        throw Error("ACTUAL_HELD_NODE_DID_NOT_START")
      })])
      const stopping = cancelFixtures(registry)
      expect(controller.signal.aborted).toBe(true)
      expect(exited).toBe(false)
      expect(closed).toBe(0)
      expect(registry.size).toBe(1)
      expect(appDb.getDb() === database).toBe(true)
      expect(matchesThreadIncarnation(appDb.getThreadCore(threadId),
        captureThreadIncarnation(thread))).toBe(true)
      expect(await saver.getTuple(config)).toBeDefined()
      expect(closed).toBe(0)
      release()
      const stopped = await stopping, original = await Promise.allSettled([completion])
      expect(stopped[0].status).toBe("rejected")
      expect(original).toEqual(stopped)
      expect(exited).toBe(true)
      expect(closed).toBe(1)
      expect(registry.size).toBe(0)
    } finally {
      release()
      await cancelFixtures(registry)
      await Promise.allSettled([completion])
    }
  })

  it.each([false, true])(
    "keeps parallel same-role child inboxes and native outputs distinct with native %s", native =>
    trackFixture(async bindCancellation => {
    const controller = new AbortController()
    bindCancellation(() => controller.abort(Error("ACTUAL_SHARED_NATIVE_FIXTURE_CANCELLED")))
    controller.signal.throwIfAborted()
    const manager = new ModsManager(join(directory, `${randomUUID()}.control.sqlite`),
      () => [], async () => true, () => {})
    manager.configure(directory, true, false)
    const diagnostics = process.env.CMB_CHILD_NATIVE_DIAGNOSTICS === "1"
      ? { prepare: 0, exec: 0, readOne: 0, get: 0, queryMs: 0,
        categories: {} as Record<string, number>,
        getCategories: {} as Record<string, number>,
        getCategoryMs: {} as Record<string, number> } : undefined
    const database = appDb.getDb()
    const originalPrepare = database.prepare.bind(database)
    const originalExec = database.exec.bind(database)
    const originalReadOne = database.prepareReadOne.bind(database)
    if (diagnostics) {
      database.prepare = (...args) => {
        diagnostics.prepare++
        const start = performance.now(), value = originalPrepare(...args)
        diagnostics.queryMs += performance.now() - start
        return value
      }
      database.exec = (...args) => {
        diagnostics.exec++
        const category = diagnosticQueryCategory(args[0])
        diagnostics.categories[category] = (diagnostics.categories[category] ?? 0) + 1
        const start = performance.now(), value = originalExec(...args)
        diagnostics.queryMs += performance.now() - start
        return value
      }
      database.prepareReadOne = (...args) => {
        diagnostics.readOne++
        const start = performance.now(), read = originalReadOne(...args)
        diagnostics.queryMs += performance.now() - start
        const category = diagnosticQueryCategory(args[0])
        return (...bindings) => {
          diagnostics.get++
          diagnostics.getCategories[category] = (diagnostics.getCategories[category] ?? 0) + 1
          const start = performance.now()
          try { return read(...bindings) }
          finally {
            const elapsed = performance.now() - start
            diagnostics.queryMs += elapsed
            diagnostics.getCategoryMs[category] = (diagnostics.getCategoryMs[category] ?? 0) + elapsed
          }
        }
      }
    }
    const workspace = manager.workspaceKey(directory), threadId = randomUUID(), runId = randomUUID()
    const signal = controller.signal
    appDb.createThread(threadId, { workspacePath: workspace })
    expect(claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired).toBe(true)
    const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId, signal })
    const unbind = manager.bindThread({ workspace, threadId, turnId: runId, signal,
      runtimeAuthority: parent.authority })
    const guard = manager.captureFunctionRuntimeGuard(parent.authority)
    const store = new FunctionConversationStore(appDb.getDb())
    const context: FunctionConversationCallContext = { owner: {},
      plugin: { name: "actual-installed-plugin" } as FunctionPlugin,
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
    const saver = new SqlJsSaver(join(directory, `${randomUUID()}.graph.sqlite`))
    const bindings: FunctionConversationGraphBinding[] = [], requests: BaseMessage[][] = []
    const childIds: string[] = [], saved: Array<{ agentId: string; uuid: string }> = []
    const producers: Array<{ proof: sharedRestore.FunctionConversationSharedProducer;
      view: sharedRestore.FunctionConversationSharedProducerView }> = []
    const originalComplete = sharedRestore.completeFunctionConversationSharedActive
    const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
      .mockImplementation((...args) => {
        const proof = originalComplete(...args)
        if (proof) producers.push({ proof,
          view: sharedRestore.readFunctionConversationSharedProducer(proof, args[1].authority) })
        return proof
      })
    let parentRun: Promise<unknown> | undefined, cleanup: Promise<void> | undefined
    const parentNodeRuns: Promise<unknown>[] = [], childRuns: Promise<unknown>[] = []
    const close = () => cleanup ??= (async () => {
      controller.abort(Error("ACTUAL_SHARED_NATIVE_FIXTURE_CANCELLED"))
      if (parentRun) await Promise.allSettled([parentRun])
      await Promise.allSettled(parentNodeRuns)
      await Promise.allSettled(childRuns)
      if (diagnostics) {
        database.prepare = originalPrepare
        database.exec = originalExec
        database.prepareReadOne = originalReadOne
        console.info("[actual-child-query-count]", { native, ...diagnostics })
      }
      completeSpy.mockRestore()
      const results = await Promise.allSettled([
        Promise.resolve().then(closeOwner),
        Promise.resolve().then(unbind),
        Promise.resolve().then(() => parent.release()),
        Promise.resolve().then(() => manager.close()),
        Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
        Promise.resolve().then(() => saver.close())
      ])
      const rejected = results.find(result => result.status === "rejected")
      if (rejected?.status === "rejected") throw rejected.reason
    })()
    try {
      await coordinator.prepareRuntime(workspace, threadId)
      await manager.prepareFunctionConversationRuntime(parent.authority, signal)
      const capture = () => {
        const authority = currentFunctionExecution()?.runtimeAuthority
        if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
        return manager.captureFunctionConversationSharedScope(authority)
      }
      const record = createMiddleware({ name: "actual-child-producer",
        beforeModel: async (_state, runtime) => {
          const authority = currentFunctionExecution()?.runtimeAuthority
          const scope = capture()
          if (!authority || !scope) throw Error("ACTUAL_NATIVE_SCOPE_REQUIRED")
          const original = producers.find(value => value.view.authority === authority)
          if (!original) throw Error("ACTUAL_CHILD_PRODUCER_REQUIRED")
          expect(original.view.scope).toBe(scope)
          expect(original.view.saver).toBe(saver)
          expect(original.view.invocation).not.toBe(parent.authority)
          // The original one-use admission read has expired. The genuine upgrade retains its
          // original data and full guards, rather than extending that read token's lifetime.
          expect(() => readFunctionConversationSharedNativeRead(original.view.nativeRead,
            saver, authority)).toThrow("CHECKPOINT_SCOPE")
          expect(sharedRestore.readFunctionConversationSharedProducer(original.proof, authority))
            .toBe(original.view)
          expect(() => sharedRestore.readFunctionConversationSharedProducer(
            { ...original.proof }, authority)).toThrow()
          expect(() => sharedRestore.readFunctionConversationSharedProducer(
            original.proof, parent.authority)).toThrow()
          expect(() => original.view.assertDataCurrent()).not.toThrow()
          const native = manager.captureFunctionNativeConversationRuntime(authority)
          if (!native) throw Error("ACTUAL_SHARED_NATIVE_RUNTIME_REQUIRED")
          expect(native.target).toBe(original.view.target)
          expect(native.binding).toBe(original.view.binding)
          expect(native.run).toBe(original.view.invocation)
          expect(native.owner).toBe(original.view.owner)
          expect(native.database).toBe(appDb.getDb())
          expect(native.destination.threadId).toBe(original.view.destination.destinationThreadId)
          expect(native.destination.threadId).not.toBe(threadId)
          expect(manager.captureFunctionNativeConversationRuntime(authority)).toBe(native)
          const policy = native.capturePolicy()
          const certificate = readFunctionConversationNativePolicySource(policy, native)
          if (!certificate) throw Error("ACTUAL_SHARED_NATIVE_POLICY_REQUIRED")
          expect(() => certificate.assertCurrent()).not.toThrow()
          expect(() => certificate.assertTail()).not.toThrow()
          expect(readFunctionConversationNativePolicySource({ ...policy }, native)).toBeUndefined()
          expect(readFunctionConversationNativePolicySource(policy, { ...native })).toBeUndefined()
          bindings.push(scope.captureNode(runtime))
          const result = await coordinator.appendSession(context,
            { agentId: authority.agentId, message: { type: "user",
              content: [{ type: "text", text: `only ${authority.agentId}` }] } },
            { identity: {}, signal, assertCurrent: guard }, ticket => ticket.core(ticket.input))
          if (typeof result.uuid !== "string" || !result.uuid) throw Error("ACTUAL_SAVED_UUID_REQUIRED")
          saved.push({ agentId: authority.agentId, uuid: result.uuid })
          return undefined
        },
        wrapModelCall: (request, handler) => {
          requests.push([...request.messages])
          return handler(request)
        }
      })
      const childGraph = createFunctionConversationSharedAgent({
        model: new FakeToolCallingModel({ toolCalls: [[], []] }), tools: [],
        systemPrompt: "Answer the actual task", middleware: [record,
          createFunctionConversationMiddleware({ store,
            capture: runtime => capture()?.captureNode(runtime) })]
      }, capture, native ? { store, agentId: "actual-shared-recipe", model: "actual-child-provider",
        captureRuntime: authority => manager.captureFunctionNativeConversationRuntime(authority),
        flush: runtime => runtime.assertCurrent() } : undefined)
      const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
        reducer: (_old, incoming) => incoming, default: () => [] }) })
      const graph = new StateGraph(state).addNode("native-tools", (_state, config) => {
        const nodeRun = (async () => {
          const invoke = () => {
            const agentId = `mod-task:${randomUUID()}`
            childIds.push(agentId)
            const childRun = manager.withSharedAgent(parent.authority, agentId, signal,
              { blockedToolNames: new Set(), readOnly: false },
              () => childGraph.invoke({ messages: [new HumanMessage("actual task seed")] }, config),
              runId, { type: "same-role", description: "actual task seed" },
              { invocation: Object.freeze({}), saver,
                config: captureFunctionConversationNativeTaskConfig(config) })
            childRuns.push(childRun)
            return childRun
          }
          const results = await Promise.all([invoke(), invoke()])
          for (const result of results) expect(result).not.toHaveProperty("cmbFunctionConversation")
          return { messages: results.flatMap(result => result.messages.slice(-1)) }
        })()
        parentNodeRuns.push(nodeRun)
        return nodeRun
      }).addEdge(START, "native-tools").addEdge("native-tools", END).compile({ checkpointer: saver })
      const running = graph.invoke({ messages: [new HumanMessage("actual parent seed")] },
        { configurable: { thread_id: threadId }, durability: "async", signal })
      parentRun = running
      await running
      expect(childIds).toHaveLength(2)
      expect(new Set(bindings.map(binding => binding.target.conversationId)).size).toBe(2)
      expect(new Set(bindings.map(binding => binding.target.checkpointNamespace)).size).toBe(2)
      expect(requests).toHaveLength(2)
      expect(producers).toHaveLength(2)
      expect(new Set(producers.map(value => value.view.target)).size).toBe(2)
      expect(new Set(producers.map(value => value.view.invocation)).size).toBe(2)
      expect(new Set(producers.map(value => value.view.destination.destinationThreadId)).size).toBe(2)
      for (const original of producers) {
        expect(() => original.view.assertDataCurrent()).toThrow()
        expect(() => sharedRestore.readFunctionConversationSharedProducer(
          original.proof, original.view.authority)).toThrow()
      }
      for (const request of requests) {
        expect(saved.filter(row => request.some(message => message.id === row.uuid))).toHaveLength(1)
      }
      for (const binding of bindings) {
        expect(store.captureInbox(binding.target, 0).rows).toHaveLength(1)
        expect(store.captureInbox(binding.target, 1).rows).toEqual([])
        expect(appDb.getDb().exec(
          "SELECT COUNT(*) FROM function_conversation_inbox WHERE conversation_id = ?",
          [binding.target.conversationId])[0].values[0][0]).toBe(0)
        const tuple = await saver.getTuple({ configurable: { thread_id: threadId,
          checkpoint_ns: binding.target.checkpointNamespace } })
        expect(tuple?.checkpoint.channel_values.cmbFunctionConversation).toMatchObject({
          conversationId: binding.target.conversationId, frontier: 1 })
        expect(() => binding.assertCurrent()).toThrow()
        const rows = store.readRows(binding.target)
        expect(rows).toHaveLength(native ? 2 : 1)
        if (native) {
          const noteRow = rows.find(row => row.inbox && row.door === "note") ??
            rows.find(row => row.message.type === "user")
          if (!noteRow) throw Error("ACTUAL_CHILD_INTAKE_REQUIRED")
          const checkpointNote = (tuple!.checkpoint.channel_values.messages as BaseMessage[])
            .find(value => value.id === noteRow.uuid)
          expect(checkpointNote).toBeInstanceOf(HumanMessage)
          expect(serializeFunctionConversationNativeMessage(checkpointNote!))
            .toBe(noteRow.nativePayload)
          expect(appDb.getThreadMessages(producers.find(value =>
            value.view.target.ref.conversationId === binding.target.conversationId)!
            .view.destination.destinationThreadId)).toEqual(expect.arrayContaining([
              expect.objectContaining({ id: noteRow.uuid, role: "user",
                content: noteRow.message.content })
            ]))
          expect(appDb.getDb().exec(
            "SELECT content_json FROM thread_messages WHERE message_id = ?", [noteRow.uuid])
            [0].values).toEqual([[JSON.stringify(noteRow.message.content)]])
          const modelRow = rows.find(row => row.door === "response")
          if (!modelRow) throw Error("ACTUAL_CHILD_MODEL_ACK_REQUIRED")
          expect(modelRow.origin).toMatchObject({ kind: "model" })
          expect(tuple?.checkpoint.channel_values.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: modelRow.uuid })
          ]))
          expect(appDb.getThreadMessages(producers.find(value =>
            value.view.target.ref.conversationId === binding.target.conversationId)!
            .view.destination.destinationThreadId)).toEqual(expect.arrayContaining([
              expect.objectContaining({ id: modelRow.uuid, role: "assistant" })
            ]))
          const message = (tuple!.checkpoint.channel_values.messages as BaseMessage[])
            .find(value => value.id === modelRow.uuid)
          expect(message).toBeInstanceOf(AIMessage)
        }
      }
      const destinations = saved.map(row => appDb.getDb().exec(
        "SELECT thread_id FROM thread_messages WHERE message_id = ?", [row.uuid])[0].values[0][0])
      expect(new Set(destinations).size).toBe(2)
      expect(destinations).not.toContain(threadId)
      expect(appDb.getThreadMessages(threadId)).toEqual([])
      expect(await saver.getTuple({ configurable: { thread_id: threadId } })).toBeDefined()
      expect(() => guard()).not.toThrow()
    } finally {
      await close()
    }
  }))

  // Two child tool turns verify complete HTTP and saved results, not a latency improvement.
  it("keeps a resident Hook's two real child tool continuations in HTTP, Saver and separate UI buckets",
    () => trackFixture(async bindCancellation => {
      const controller = new AbortController()
      bindCancellation(() => controller.abort(Error("ACTUAL_RESIDENT_HTTP_FIXTURE_CANCELLED")))
      controller.signal.throwIfAborted()
      const diagnosticStart = process.hrtime.bigint()
      const diagnostics = process.env.CMB_CHILD_NATIVE_DIAGNOSTICS === "1"
      let physicalGuardCount = 0, modelReturns = 0, captures = 0, protections = 0
      const originalPromiseThen = Promise.prototype.then
      const stage = (name: string, index?: number, count?: number, durationMs?: number) => {
        if (diagnostics) console.info("[actual-resident-child-stage]", {
          stage: name, ...(index === undefined ? {} : { index }),
          ...(count === undefined ? {} : { count }),
          ...(durationMs === undefined ? {} : { durationMs }),
          elapsedMs: Number(process.hrtime.bigint() - diagnosticStart) / 1_000_000
        })
      }
      const root = mkdtempSync(join(directory, "resident-http-"))
      const manager = new ModsManager(join(root, "control.sqlite"), () => [],
        async () => true, () => {})
      manager.configure(root, true, false)
      const workspace = manager.workspaceKey(root), threadId = randomUUID(), runId = randomUUID()
      const database = appDb.getDb()
      const thread = appDb.createThread(threadId, { workspacePath: workspace })
      const incarnation = captureThreadIncarnation(thread)
      const physicalGuard = () => {
        if (diagnostics) physicalGuardCount++
        controller.signal.throwIfAborted()
        if (appDb.getDb() !== database ||
          !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
          throw Error("ACTUAL_PARENT_PHYSICAL_RUN_REQUIRED")
      }
      if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
        throw Error("ACTUAL_PARENT_LEASE_REQUIRED")
      const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
        signal: controller.signal, assertLive: physicalGuard })
      const checkpointGuard = () => { physicalGuard(); parent.authority.assertLive() }
      const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
        signal: controller.signal, assertLive: physicalGuard, runtimeAuthority: parent.authority })
      const store = new FunctionConversationStore(database)
      const coordinator = new FunctionConversationCoordinator(store, {
        authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
        assertScope: context => {
          physicalGuard()
          if (context.workspace !== workspace || context.threadId !== threadId)
            throw Error("ACTUAL_RESIDENT_OWNER_SCOPE_REQUIRED")
        }, readCurrentCheckpoint: async (_thread, signal, current) => {
          signal.throwIfAborted(); current(); return null
        }, protect: async (_context, value, signal, current) => {
          signal.throwIfAborted(); current(); return value
        }, apiMessages: projectFunctionSessionApiMessages, changed: () => {}
      })
      manager.setFunctionConversations(coordinator)
      const plugin = join(root, "actual-shared-hook")
      mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
      mkdirSync(join(plugin, "hooks"))
      writeFileSync(join(plugin, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: "shared-native-hook", version: "1.0.0" }))
      writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
      writeFileSync(join(plugin, "hooks/register.ts"), `export function register(on) {
        on("session.append", async ($, e, next) => {
          const content = e.message.content.map(block => block.type === "text"
            ? {...block,text:"HOOK "+block.text}
            : block.type === "tool_result" ? {...block,content:
              typeof block.content === "string" ? "HOOK "+block.content
                : block.content.map(item => item.type === "text"
                  ? {...item,text:"HOOK "+item.text} : item)} : block)
          return next({...e,message:{...e.message,content}})
        })
      }`)
      let loads = 0, appends = 0
      const appendDoors: string[] = []
      const functions = new FunctionModsManager(manager.store, {
        plugins: () => [{ id: "actual-shared-hook", name: "shared-native-hook",
          path: plugin, enabled: true }], enabled: key => manager.isEnabled(key),
        publish: (key, value, signal) => manager.publish(key, value, undefined, signal),
        changed: () => {}, openConversationOwner: coordinator.openConversationOwner,
        activateConversationOwner: coordinator.activateConversationOwner,
        appendSession: coordinator.appendSession, readConversation: coordinator.readConversation
      }, () => {
        const guests = new Set<FunctionGuestRuntime>()
        return { async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          return guest
        }, stop() { for (const guest of guests) guest.dispose() } }
      })
      manager.attachFunctions({ invalidate: key => functions.invalidate(key),
        closeThread: id => functions.closeThread(id), close: () => functions.close(),
        appendConversation: async (key, id, ticket) => {
          expect(key).toBe(workspace); expect(id).toBe(threadId)
          appends++; appendDoors.push(ticket.input.door)
          const index = appends
          stage("append-start", undefined, index)
          try { return await functions.appendConversation(key, id, ticket) }
          finally { stage("append-settled", undefined, index) }
        } })
      const saver = new SqlJsSaver(join(root, "actual-shared-checkpoint.sqlite"), undefined,
        { maxRootCheckpoints: 3 })
      const seeds = ["child-alpha", "child-beta"]
      const requests = new Map<string, Array<Record<string, unknown>>>()
      const effects = new Map<string, number>()
      const producers: Array<{ proof: sharedRestore.FunctionConversationSharedProducer;
        view: sharedRestore.FunctionConversationSharedProducerView }> = []
      const originalComplete = sharedRestore.completeFunctionConversationSharedActive
      const completeSpy = vi.spyOn(sharedRestore, "completeFunctionConversationSharedActive")
        .mockImplementation((...args) => {
          const proof = originalComplete(...args)
          if (proof) producers.push({ proof,
            view: sharedRestore.readFunctionConversationSharedProducer(proof, args[1].authority) })
          return proof
        })
      const record = (value: unknown): Record<string, unknown> => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("ACTUAL_HTTP_JSON_OBJECT_REQUIRED")
        return value as Record<string, unknown>
      }
      const httpErrors: unknown[] = []
      const server = createServer(async (request, response) => {
        try {
          const parts: Buffer[] = []
          for await (const part of request) parts.push(Buffer.from(part))
          const body = record(JSON.parse(Buffer.concat(parts).toString("utf8")))
          if (!Array.isArray(body.messages)) throw Error("ACTUAL_HTTP_MESSAGES_REQUIRED")
          const incoming = body.messages.map(record)
          const seed = incoming.find(message => message.role === "user")?.content
          if (typeof seed !== "string" || !seeds.includes(seed))
            throw Error("ACTUAL_CHILD_HTTP_SEED_REQUIRED")
          let history = requests.get(seed)
          if (!history) { history = []; requests.set(seed, history) }
          history.push(body)
          if (history.length > 2) throw Error("ACTUAL_TOOL_CONTINUATION_MUST_NOT_RERUN")
          const first = history.length === 1
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ id: "reused-shared-http-provider", object: "chat.completion",
            created: 1, model: "actual-shared-http", choices: [{ index: 0,
              finish_reason: first ? "tool_calls" : "stop", message: { role: "assistant",
                content: `HTTP ${first ? "first" : "final"} ${seed}`,
                ...(first ? { tool_calls: [{ id: "reused-shared-call", type: "function",
                  function: { name: "actual_shared_http_tool",
                    arguments: JSON.stringify({ seed }) } }] } : {}) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
          stage(first ? "http-first-response" : "http-final-response", seeds.indexOf(seed))
        } catch (error) {
          httpErrors.push(error)
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: { message: "ACTUAL_HTTP_FIXTURE_FAILED" } }))
        }
      })
      let listening = false
      let parentRun: Promise<unknown> | undefined, cleanup: Promise<void> | undefined
      const parentNodeRuns: Promise<unknown>[] = [], childRuns: Promise<unknown>[] = []
      const restoreProtectionObservers: Array<() => void> = []
      const close = () => cleanup ??= (async () => {
        controller.abort(Error("ACTUAL_RESIDENT_HTTP_FIXTURE_CANCELLED"))
        // Parent Promise.all can reject while another actual child still owns physical work.
        if (parentRun) await Promise.allSettled([parentRun])
        await Promise.allSettled(parentNodeRuns)
        await Promise.allSettled(childRuns)
        stage("cleanup-drained", undefined, childRuns.length)
        stage("physical-guard-count", undefined, physicalGuardCount)
        const restored = await Promise.allSettled([
          ...restoreProtectionObservers, () => completeSpy.mockRestore()
        ].map(restore => Promise.resolve().then(restore)))
        const results = await Promise.allSettled([
          Promise.resolve().then(async () => {
            if (!listening) return
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
              server.close(error => error ? reject(error) : resolve()))
          }),
          Promise.resolve().then(() => functions.close()),
          Promise.resolve().then(unbind),
          Promise.resolve().then(() => parent.release()),
          Promise.resolve().then(() => manager.close()),
          Promise.resolve().then(() => releaseLocalThreadRunLease(threadId, "desktop", runId)),
          Promise.resolve().then(() => saver.close())
        ])
        stage("cleanup-closed", undefined, results.length)
        const rejected = [...restored, ...results].find(result => result.status === "rejected")
        if (rejected?.status === "rejected") throw rejected.reason
      })()
      const observed = new Set<sharedRestore.FunctionConversationSharedProducer>()
      try {
        if (diagnostics) {
          const originalCapture = FunctionNativeMessageProtector.prototype.capture
          const originalProtect = FunctionNativeMessageProtector.prototype.protect
          const captureSpy = vi.spyOn(FunctionNativeMessageProtector.prototype, "capture")
            .mockImplementation(function (this: FunctionNativeMessageProtector, admission) {
              const started = process.hrtime.bigint(), count = ++captures
              stage("protector-capture-start", undefined, count)
              try {
                const captured: ReturnType<typeof originalCapture> =
                  Reflect.apply(originalCapture, this, [admission])
                stage("protector-capture-returned", undefined, count,
                  Number(process.hrtime.bigint() - started) / 1_000_000)
                return captured
              } catch (error) {
                stage("protector-capture-rejected", undefined, count,
                  Number(process.hrtime.bigint() - started) / 1_000_000)
                throw error
              }
            })
          restoreProtectionObservers.push(() => captureSpy.mockRestore())
          const protectSpy = vi.spyOn(FunctionNativeMessageProtector.prototype, "protect")
            .mockImplementation(function (this: FunctionNativeMessageProtector, capture) {
              const started = process.hrtime.bigint(), count = ++protections
              stage("protector-protect-start", undefined, count)
              try {
                const result: ReturnType<typeof originalProtect> =
                  Reflect.apply(originalProtect, this, [capture])
                // Observe the original Promise without reading or replacing its then method.
                void Reflect.apply(originalPromiseThen, result, [() => {
                  stage("protector-protect-returned", undefined, count,
                    Number(process.hrtime.bigint() - started) / 1_000_000)
                }, () => {
                  stage("protector-protect-rejected", undefined, count,
                    Number(process.hrtime.bigint() - started) / 1_000_000)
                }])
                return result
              } catch (error) {
                stage("protector-protect-rejected", undefined, count,
                  Number(process.hrtime.bigint() - started) / 1_000_000)
                throw error
              }
            })
          restoreProtectionObservers.push(() => protectSpy.mockRestore())
        }
        const [status] = await functions.status(workspace)
        if (!status?.digest) throw Error("ACTUAL_APPROVAL_DIGEST_REQUIRED")
        expect(status.state).toBe("needs-approval")
        await functions.approve(workspace, "actual-shared-hook", status.digest)
        expect((await functions.status(workspace))[0]).toMatchObject({
          digest: status.digest, state: "ready" })
        await functions.commands(workspace, threadId)
        expect(loads).toBeGreaterThan(0)
        stage("resident-ready", undefined, loads)
        const residentLoads = loads
        // The real SessionEntry owns the family. No fixture-created owner or domain is registered.
        const main = await coordinator.prepareRuntime(workspace, threadId)
        await manager.prepareFunctionConversationRuntime(parent.authority, controller.signal, runId)
        stage("main-prepared")
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
        listening = true
        const address = server.address()
        if (!address || typeof address === "string") throw Error("ACTUAL_HTTP_PORT_REQUIRED")
        const capture = () => {
          const authority = currentFunctionExecution()?.runtimeAuthority
          if (!authority) throw Error("ACTUAL_CHILD_AUTHORITY_REQUIRED")
          return manager.captureFunctionConversationSharedScope(authority)
        }
        const observe = createMiddleware({ name: "actual-resident-child-proof",
          wrapModelCall: (request, handler) => {
            const result = handler(request)
            if (diagnostics) {
              const returned = () => {
                stage("model-handler-returned", undefined, ++modelReturns)
                stage("physical-guard-count", undefined, physicalGuardCount)
              }
              if (utilTypes.isPromise(result)) void Reflect.apply(originalPromiseThen, result,
                [returned, () => {
                  stage("model-handler-rejected", undefined, ++modelReturns)
                  stage("physical-guard-count", undefined, physicalGuardCount)
                }])
              else returned()
            }
            return result
          },
          beforeModel: (_state, runtime) => {
            const authority = currentFunctionExecution()?.runtimeAuthority
            const scope = capture()
            if (!authority || !scope) throw Error("ACTUAL_CHILD_SCOPE_REQUIRED")
            const original = producers.find(value => value.view.authority === authority)
            if (!original) throw Error("ACTUAL_PRIVATE_PRODUCER_REQUIRED")
            const native = manager.captureFunctionNativeConversationRuntime(authority)
            if (!native || native.target !== original.view.target ||
              native.run !== original.view.invocation || native.owner !== original.view.owner)
              throw Error("ACTUAL_NATIVE_CHILD_RUNTIME_REQUIRED")
            if (!observed.has(original.proof)) {
              expect(original.view.scope).toBe(scope)
              expect(original.view.saver).toBe(saver)
              expect(scope.captureNode(runtime).target).toBe(original.view.binding.target)
              expect(readFunctionConversationNativePolicySource(native.capturePolicy(), native))
                .toBeDefined()
              observed.add(original.proof)
            }
            return undefined
          } })
        const childGraph = createFunctionConversationSharedAgent({
          model: new ChatOpenAI({ apiKey: "local-test-key", model: "actual-shared-http",
            disableStreaming: true, maxRetries: 0,
            configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` } }),
          systemPrompt: "Complete the actual child tool task",
          tools: [tool(({ seed }: { seed: string }) => {
            if (!seeds.includes(seed)) throw Error("ACTUAL_CHILD_TOOL_ARGUMENT_REQUIRED")
            effects.set(seed, (effects.get(seed) ?? 0) + 1)
            return `tool ${seed}`
          }, { name: "actual_shared_http_tool", description: "Actual shared child HTTP effect",
            schema: z.object({ seed: z.string() }) })],
          middleware: [observe, createFunctionConversationMiddleware({ store,
            capture: runtime => capture()?.captureNode(runtime) })]
        }, capture, { store, agentId: "same-resident-recipe", model: "actual-shared-http",
          captureRuntime: authority => manager.captureFunctionNativeConversationRuntime(authority),
          flush: runtime => runtime.assertCurrent() })
        stage("graph-installed")
        const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
          reducer: (_old, incoming) => incoming, default: () => [] }) })
        const graph = new StateGraph(state).addNode("native-tools", (_state, config) => {
          const nodeRun = (async () => {
            const results = await Promise.all(seeds.map((seed, index) => {
              stage("child-domain-start", index)
              const childRun = manager.withSharedAgent(parent.authority,
                `mod-task:${randomUUID()}`, controller.signal,
                { blockedToolNames: new Set(), readOnly: false },
                () => childGraph.invoke({ messages: [new HumanMessage(seed)] }, config), runId,
                { type: "same-role", description: "same child recipe" },
                { invocation: Object.freeze({}), saver,
                  config: captureFunctionConversationNativeTaskConfig(config) })
              childRuns.push(childRun)
              void childRun.then(() => stage("child-domain-settled", index),
                () => stage("child-domain-settled", index))
              return childRun
            }))
            for (const result of results) expect(result).not.toHaveProperty("cmbFunctionConversation")
            return { messages: results.flatMap(result => result.messages.slice(-1)) }
          })()
          parentNodeRuns.push(nodeRun)
          return nodeRun
        }).addEdge(START, "native-tools").addEdge("native-tools", END)
          .compile({ checkpointer: saver })
        stage("parent-start")
        const running = graph.invoke({ messages: [new HumanMessage("actual parent HTTP task")] },
          { configurable: { thread_id: threadId }, durability: "async", signal: controller.signal })
        parentRun = running
        void running.then(() => stage("parent-settled"), () => stage("parent-settled"))
        const parentResult = await running
        expect(httpErrors).toEqual([])
        expect(parentResult.messages).toHaveLength(2)
        expect(observed.size).toBe(2); expect(producers).toHaveLength(2)
        expect(new Set(producers.map(value => value.view.target)).size).toBe(2)
        expect(new Set(producers.map(value => value.view.invocation)).size).toBe(2)
        expect(new Set(producers.map(value => value.view.namespace)).size).toBe(2)
        expect(new Set(producers.map(value => value.view.destination.destinationThreadId)).size).toBe(2)
        expect(appends).toBe(6)
        expect(appendDoors.filter(door => door === "response")).toHaveLength(4)
        expect(appendDoors.filter(door => door === "tool-result")).toHaveLength(2)
        for (const seed of seeds) {
          expect(effects.get(seed)).toBe(1)
          const actualRequests = requests.get(seed)
          if (!actualRequests || actualRequests.length !== 2) throw Error("ACTUAL_TWO_HTTP_REQUESTS_REQUIRED")
          const history = actualRequests[1].messages
          if (!Array.isArray(history)) throw Error("ACTUAL_NEXT_HTTP_HISTORY_REQUIRED")
          const next = history.map(record)
          expect(next).toContainEqual(expect.objectContaining({ role: "assistant",
            content: `HOOK HTTP first ${seed}`, tool_calls: [{ id: "reused-shared-call", type: "function",
              function: { name: "actual_shared_http_tool", arguments: JSON.stringify({ seed }) } }] }))
          expect(next).toContainEqual(expect.objectContaining({ role: "tool",
            content: `HOOK tool ${seed}`, tool_call_id: "reused-shared-call" }))
          const sibling = seeds.find(value => value !== seed)
          if (!sibling) throw Error("ACTUAL_DISTINCT_SIBLING_SEED_REQUIRED")
          expect(JSON.stringify(next)).not.toContain(sibling)
        }
        for (const original of producers) {
          const target = original.view.target.ref, rows = store.readRows(target)
          expect(rows).toHaveLength(3)
          expect(rows.map(row => row.door)).toEqual(["response", "tool-result", "response"])
          expect(rows.map(row => row.sequence)).toEqual([1, 2, 3])
          expect(rows.every(row => row.inbox === false)).toBe(true)
          expect(new Set(rows.map(row => row.uuid)).size).toBe(3)
          const toolRow = rows[1]
          expect(toolRow.origin).toEqual({ kind: "tool", tool: "actual_shared_http_tool" })
          const nativeTool = JSON.parse(toolRow.nativePayload).message.data
          expect(nativeTool.tool_call_id).toBe("reused-shared-call")
          expect(nativeTool.status).toBe("success")
          const tuple = await saver.getTuple({ configurable: { thread_id: threadId,
            checkpoint_ns: target.checkpointNamespace } })
          if (!tuple) throw Error("ACTUAL_CHILD_CHECKPOINT_REQUIRED")
          const native = tuple.checkpoint.channel_values.messages
          if (!Array.isArray(native) || !native.every(BaseMessage.isInstance))
            throw Error("ACTUAL_CHILD_NATIVE_ARRAY_REQUIRED")
          const initial = native.find(HumanMessage.isInstance)
          if (!initial || typeof initial.content !== "string" || !seeds.includes(initial.content))
            throw Error("ACTUAL_ORIGINAL_CHILD_SEED_REQUIRED")
          const seed = initial.content
          // The second model boundary scans the first response and Tool, including non-inbox rows.
          const expectedFrontier = rows[1].sequence
          expect(tuple.checkpoint.channel_values.cmbFunctionConversation).toMatchObject({
            conversationId: target.conversationId, frontier: expectedFrontier })
          expect(store.captureInbox(target, 0).rows).toEqual([])
          const kept = store.readCheckpointRecoverySnapshot(target, { checkpointThreadId: threadId,
            checkpointIncarnation: incarnation, checkpointId: tuple.checkpoint.id }, checkpointGuard).snapshot
          const read = await captureConversationCheckpointRead(store, saver, tuple.config, () => ({
            target, checkpointThreadId: threadId, checkpointIncarnation: incarnation,
            cut: kept.cut, frontier: kept.frontier, stateDigest: kept.stateDigest,
            assertCurrent: checkpointGuard }), checkpointGuard)
          if (!read.proof) throw Error("ACTUAL_CHILD_MEMBERSHIP_PROOF_REQUIRED")
          const membership = readFunctionConversationCheckpointMembership(read.proof, store, target)
          expect(membership.frontier).toBe(expectedFrontier)
          expect(membership.members.map(member => member.uuid)).toEqual(rows.map(row => row.uuid))
          for (const row of rows) {
            const actual = native.find(message => message.id === row.uuid)
            if (!actual) throw Error("ACTUAL_STAMPED_CHILD_MESSAGE_REQUIRED")
            expect(actual).toBeInstanceOf(row.door === "tool-result" ? ToolMessage : AIMessage)
            expect(actual.additional_kwargs.function_row).toEqual(functionConversationCanonicalStamp(target, row))
            expect(serializeFunctionConversationNativeMessage(actual)).toBe(row.nativePayload)
            if (AIMessage.isInstance(actual) && row === rows[0]) expect(actual.tool_calls).toEqual([
              { id: "reused-shared-call", type: "tool_call", name: "actual_shared_http_tool", args: { seed } }
            ])
          }
          const ui = appDb.withCanonicalThreadMessageReadScope(original.view.destination.destinationThreadId,
            reader => rows.map(row => {
              const columns = reader.readColumns(row.uuid), snapshot = reader.readSnapshot(row.uuid)
              if (!columns || !snapshot) throw Error("ACTUAL_FULL_SEALED_CHILD_UI_REQUIRED")
              return { columns, snapshot }
            }))
          expect(ui.map(value => value.columns.role)).toEqual(["assistant", "tool", "assistant"])
          expect(ui.map(value => value.snapshot.id)).toEqual(rows.map(row => row.uuid))
          expect(ui[0].snapshot.content).toBe(`HOOK HTTP first ${seed}`)
          expect(ui[1].snapshot.content).toBe(`HOOK tool ${seed}`)
          expect(ui[2].snapshot.content).toBe(`HOOK HTTP final ${seed}`)
          // UI calls use the original three-field protocol; the native checkpoint above also
          // retains LangChain's type field and full execution facts.
          expect(ui[0].snapshot.tool_calls).toEqual([{ id: "reused-shared-call",
            name: "actual_shared_http_tool", args: { seed } }])
          expect(ui[1].snapshot.tool_call_id).toBe("reused-shared-call")
          expect(ui[1].snapshot.status).toBe("success")
          expect(ui[1].snapshot.is_error).toBe(false)
          expect(ui.every(value => value.columns.thread_id === original.view.destination.destinationThreadId))
            .toBe(true)
          expect(() => original.view.assertDataCurrent()).toThrow()
          expect(() => sharedRestore.readFunctionConversationSharedProducer(original.proof,
            original.view.authority)).toThrow()
          expect(() => original.view.authority.assertLive()).toThrow()
        }
        expect(store.readRows(main.target.ref)).toEqual([])
        expect(appDb.getThreadMessages(threadId)).toEqual([])
        expect(await saver.getTuple({ configurable: { thread_id: threadId } })).toBeDefined()
        expect(() => parent.authority.assertLive()).not.toThrow()
        expect(() => physicalGuard()).not.toThrow()
        await functions.commands(workspace, threadId)
        expect(loads).toBe(residentLoads)
        expect(appends).toBe(6)
      } finally {
        await close()
      }
    }), 30_000)
})
