import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ModsManager } from "../mods/manager"
import { currentFunctionExecution } from "../mods/v2/execution-context"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { createFunctionConversationSharedAgent,
  captureFunctionConversationNativeTaskConfig } from "./mods-conversation-shared-invocation"
import { runFunctionConversationSharedNativeStreamPreflight } from
  "./function-conversation-shared-native-stream-state"
import * as sharedDomain from "./function-conversation-shared-native-domain"
import * as nativeFactory from "./native-agent-factory"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => "", getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-shared-stream-preflight-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  vi.restoreAllMocks()
  const failure = results.find(result => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Actual Manager, lease, parent Pregel task, shared Saver and known Shared factory. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-")), controller = new AbortController()
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined)
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), runId = randomUUID()
  appDb.createThread(threadId, { workspacePath: workspace })
  if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_PREFLIGHT_LEASE_REQUIRED")
  const parent = manager.createRuntimeAuthority({ workspace, threadId, turnId: runId,
    signal: controller.signal })
  const unbind = manager.bindThread({ workspace, threadId, turnId: runId,
    signal: controller.signal, runtimeAuthority: parent.authority })
  const guard = manager.captureFunctionRuntimeGuard(parent.authority)
  const store = new FunctionConversationStore(appDb.getDb())
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: guard, readCurrentCheckpoint: async () => null,
    protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const owner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    readOnly: false, signal: controller.signal, assertCurrent: guard })
  const saver = new SqlJsSaver(join(root, "shared-checkpoint.sqlite"))
  const runs: Promise<unknown>[] = [], children: Promise<unknown>[] = []
  const provider = vi.spyOn(FakeToolCallingModel.prototype, "_generate")
  let captures = 0, runtimeCaptures = 0
  let captureEffect: (() => void) | undefined, initializeEffect: (() => void) | undefined
  let armed = false
  function capture(this: undefined) {
    expect(this).toBeUndefined()
    captures++
    captureEffect?.()
    const authority = currentFunctionExecution()?.runtimeAuthority
    if (!authority) throw Error("ACTUAL_PREFLIGHT_CHILD_AUTHORITY_REQUIRED")
    return manager.captureFunctionConversationSharedScope(authority)
  }
  const middleware = createMiddleware({ name: "actual-preflight-schema",
    stateSchema: z.object({ preflightValue: z.string().default(() => {
      if (armed) initializeEffect?.()
      return "actual initialized state"
    }) }) })
  const agent = createFunctionConversationSharedAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }), middleware: [middleware]
  }, capture, { store, agentId: "actual-preflight-child", model: "actual-preflight-model",
    captureRuntime: authority => {
      runtimeCaptures++
      return manager.captureFunctionNativeConversationRuntime(authority)
    }, flush: runtime => runtime.assertCurrent() })
  const invoke = <T>(action: (config: RunnableConfig) => Promise<T>): Promise<T> => {
    let value!: T, settled = false
    const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
      reducer: (_old, next) => next, default: () => [] }) })
    const graph = new StateGraph(state).addNode("actual-parent-task", (_input, config) => {
      const child = manager.withSharedAgent(parent.authority, `mod-task:${randomUUID()}`,
        controller.signal, { blockedToolNames: new Set(), readOnly: false }, async () => {
          value = await action(config)
          settled = true
          return { messages: [] }
        }, runId, { type: "preflight-foundation", description: "true lexical preflight" },
        { invocation: Object.freeze({}), saver,
          config: captureFunctionConversationNativeTaskConfig(config) })
      children[children.length] = child
      return child
    }).addEdge(START, "actual-parent-task").addEdge("actual-parent-task", END)
      .compile({ checkpointer: saver })
    const work = Promise.resolve().then(() => graph.invoke({ messages: [
      new HumanMessage({ id: randomUUID(), content: "actual parent seed" })
    ] }, { configurable: { thread_id: threadId }, signal: controller.signal,
      durability: "async" })).then(() => {
      if (!settled) throw Error("ACTUAL_PARENT_TASK_SETTLEMENT_REQUIRED")
      return value
    })
    runs[runs.length] = work
    return work
  }
  cleanup.push(async () => {
    controller.abort(Error("ACTUAL_PREFLIGHT_FIXTURE_FINISHED"))
    const settled = await Promise.allSettled([...runs, ...children])
    const resources = await Promise.allSettled([
      // The Coordinator returns this exact owner retirement; it has no global close method.
      Promise.resolve().then(() => owner()),
      Promise.resolve().then(() => unbind()),
      Promise.resolve().then(() => parent.release()),
      Promise.resolve().then(() => manager.close()),
      Promise.resolve().then(() => saver.close())
    ])
    const released = releaseLocalThreadRunLease(threadId, "desktop", runId)
    rmSync(root, { recursive: true, force: true })
    const failure = [...settled, ...resources].find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
    if (!released) throw Error("ACTUAL_PREFLIGHT_LEASE_RELEASE_REQUIRED")
  })
  // Match the actual native parent setup before withSharedAgent can create its private Scope.
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(parent.authority, controller.signal)
  return { agent, saver, invoke, controller, provider,
    arm(effect?: () => void) { initializeEffect = effect; armed = true },
    captureEffect(effect?: () => void) { captureEffect = effect },
    counts: () => ({ captures, runtimeCaptures }) }
}
const seed = () => ({ messages: [new HumanMessage({ id: randomUUID(),
  content: "complete actual preflight input" })] })

describe("actual Shared App preflight foundation without frames", () => {
  it("rejects a late published factory graph getter before reading it and remains retired", async () => {
    // These observers preserve the actual constructor calls and retain their genuine results.
    const observedFactory = vi.spyOn(sharedDomain, "createSharedNativeFactoryRecord")
    const observedAgent = vi.spyOn(nativeFactory, "createFunctionConversationNativeAgent")
    let f: Awaited<ReturnType<typeof fixture>>
    let factory: ReturnType<typeof sharedDomain.createSharedNativeFactoryRecord>
    let agent: ReturnType<typeof nativeFactory.createFunctionConversationNativeAgent>
    try {
      f = await fixture()
      const factoryResult = observedFactory.mock.results[0], agentResult = observedAgent.mock.results[0]
      if (factoryResult?.type !== "return" || agentResult?.type !== "return")
        throw Error("ACTUAL_SHARED_CONSTRUCTOR_RESULTS_REQUIRED")
      factory = factoryResult.value as typeof factory
      agent = agentResult.value as typeof agent
      expect(sharedDomain.readSharedNativeFactoryOriginalCapture(factory.token, agent, agent.graph))
        .toBe(observedFactory.mock.calls[0][1])
    } finally { observedFactory.mockRestore(); observedAgent.mockRestore() }
    const original = Object.getOwnPropertyDescriptor(factory!, "graph")!
    let getters = 0, error: unknown
    Object.defineProperty(factory!, "graph", { configurable: true,
      get() { getters++; throw Error("LATE_FACTORY_GRAPH") } })
    try {
      sharedDomain.readSharedNativeFactoryOriginalCapture(factory!.token, agent!, agent!.graph)
    } catch (caught) { error = caught }
    finally { Object.defineProperty(factory!, "graph", original) }
    expect(getters).toBe(0)
    expect(error).toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
    expect(() => sharedDomain.readSharedNativeFactoryOriginalCapture(factory!.token, agent!,
      agent!.graph)).toThrow("SOURCE_INVALID")
    expect(f!.counts().captures).toBe(0)
    expect(f!.counts().runtimeCaptures).toBe(0)
    expect(f!.provider).not.toHaveBeenCalled()
  })

  it("joins the genuine installed graph, actual SDK config and settled Scope receipt", async () => {
    const f = await fixture(), reads = vi.spyOn(SqlJsSaver.prototype, "getTuple")
    await f.invoke(async config => {
      f.arm()
      const before = f.counts().captures, queried = reads.mock.calls.length
      const input = seed()
      const facts = await runFunctionConversationSharedNativeStreamPreflight(f.agent.graph,
        input, config)
      expect(f.counts().captures).toBe(before + 1)
      expect(facts.value).toMatchObject({ values: {}, next: [], tasks: [] })
      expect(facts.actualConfig).not.toBe(config)
      expect(facts.scope.checkpointer).toBe(
        (facts.actualConfig as RunnableConfig).configurable?.__pregel_checkpointer)
      expect(reads.mock.calls.length).toBe(queried)
      const after = f.counts().captures
      facts.assertDataCurrent()
      expect(f.counts().captures).toBe(after)
      expect(f.provider).not.toHaveBeenCalled()
      expect(f.counts().runtimeCaptures).toBe(0)
      for (const method of ["getState", "stream", "_streamIterator"]) {
        const field = Object.getOwnPropertyDescriptor(f.agent.graph, method)
        expect(field?.writable).toBe(false)
        expect(field?.configurable).toBe(false)
      }
      return undefined
    })
  })

  it("rejects unknown and proxy graph identities without capture or traps", async () => {
    const f = await fixture(), trap = vi.fn()
    await f.invoke(async config => {
      const before = f.counts().captures
      for (const graph of [{ ...f.agent.graph }, new Proxy(f.agent.graph,
        { get: trap, getPrototypeOf: trap })]) {
        await expect(runFunctionConversationSharedNativeStreamPreflight(graph, seed(), config))
          .rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
      }
      expect(f.counts().captures).toBe(before)
      expect(trap).not.toHaveBeenCalled()
      await runFunctionConversationSharedNativeStreamPreflight(f.agent.graph, seed(), config)
      expect(f.provider).not.toHaveBeenCalled()
    })
  })

  it("preserves the original input baseline across the actual capture callback", async () => {
    const f = await fixture()
    await f.invoke(async config => {
      const input = seed()
      f.captureEffect(() => { input.messages[0].content = "changed before SDK initialization" })
      await expect(runFunctionConversationSharedNativeStreamPreflight(f.agent.graph, input, config))
        .rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
      expect(f.provider).not.toHaveBeenCalled()
      expect(f.counts().runtimeCaptures).toBe(0)
    })
  })

  it.each(["getState", "stream"] as const)(
    "rejects initialization's caught direct %s before any actual model or admission", async method => {
      const f = await fixture()
      await f.invoke(async config => {
        let attempted = 0, captured: unknown
        f.arm(() => {
          if (attempted++) return
          try {
            const original = Object.getOwnPropertyDescriptor(f.agent.graph, method)!.value as
              (...args: unknown[]) => unknown
            const result = Reflect.apply(original, f.agent.graph, method === "getState"
              ? [{ ...config }] : [seed(), { ...config }])
            if (result instanceof Promise) void result.catch(() => undefined)
          } catch (error) { captured = error }
        })
        await expect(runFunctionConversationSharedNativeStreamPreflight(f.agent.graph, seed(), config))
          .rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
        expect(attempted).toBeGreaterThan(0)
        expect(captured).toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
        expect(f.provider).not.toHaveBeenCalled()
        expect(f.counts().runtimeCaptures).toBe(0)
      })
    })

  it("makes caught nested controlled execution fail the same original operation", async () => {
    const f = await fixture(), nested: Promise<unknown>[] = []
    await f.invoke(async config => {
      let attempted = false
      f.arm(() => {
        if (attempted) return
        attempted = true
        const work = runFunctionConversationSharedNativeStreamPreflight(f.agent.graph, seed(), config)
        nested[nested.length] = work
        void work.catch(() => undefined)
      })
      await expect(runFunctionConversationSharedNativeStreamPreflight(f.agent.graph, seed(), config))
        .rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" })
      const actual = await Promise.allSettled(nested)
      expect(actual).toHaveLength(1)
      expect(actual[0]).toMatchObject({ status: "rejected",
        reason: { code: "MODS_CONVERSATION_NATIVE_SOURCE_INVALID" } })
      expect(f.provider).not.toHaveBeenCalled()
    })
  })
})
