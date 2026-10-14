import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, StateGraph, START, END } from "@langchain/langgraph"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../../db/native-sqlite-adapter"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { functionConversationState } from "../../agent/mods-conversation"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionConversationSharedCheckpointScope, readFunctionConversationSharedNativeRead,
  readFunctionConversationSharedCheckpointOpeningCurrent,
  type FunctionConversationSharedCheckpointOpeningCurrent } from
  "./conversation-shared-checkpointer"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-shared-real-graph-"))
  const database = openNativeSqliteDatabase(join(directory, "actual.sqlite")).database
  const token = randomUUID(), threadId = randomUUID()
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  database.run("INSERT INTO threads VALUES (?,1000,?)", [threadId,
    JSON.stringify({ cmb_thread_incarnation: token })])
  const store = new FunctionConversationStore(database)
  const main = store.ensureMain({ threadId, workspace: directory, checkpointNamespace: "",
    incarnation: { token, legacyCreatedAt: 1000 } }, () => {})
  const saver = new SqlJsSaver(join(directory, "graph.sqlite"))
  const authorities = new ModRuntimeAuthorities(), signal = new AbortController().signal
  const parent = authorities.create({ workspace: directory, threadId, turnId: randomUUID() }, signal)
  cleanups.push(async () => { authorities.close(); await saver.close(); database.close()
    rmSync(directory, { recursive: true, force: true }) })
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
    reducer: (_old, incoming) => incoming, default: () => [] }) })
  const scopes: FunctionConversationSharedCheckpointScope[] = [], namespaces: string[] = []
  const current = (config: RunnableConfig, onNode: () => void = () => {}, hold?: Promise<void>,
    preflight?: (scope: FunctionConversationSharedCheckpointScope,
      graph: { getState(config: RunnableConfig): Promise<unknown> }, config: RunnableConfig) => Promise<void>,
    onCurrent: () => void = () => {}) => {
    const child = authorities.create({ workspace: directory, threadId,
      agentId: `mod-task:${randomUUID()}`, turnId: randomUUID() }, signal, parent.authority)
    let scope!: FunctionConversationSharedCheckpointScope
    let admittedNamespace: string | undefined
    scope = new FunctionConversationSharedCheckpointScope({ saver, authority: child.authority,
      parentConfig: config, parentGraphNamespace: "", signal,
      assertCurrent: () => { onCurrent(); child.authority.assertLive() },
      admit: async proof => {
        expect(() => readFunctionConversationSharedNativeRead({ ...proof }, saver, child.authority))
          .toThrow("CHECKPOINT_SCOPE")
        const actual = readFunctionConversationSharedNativeRead(proof, saver, child.authority)
        expect(actual.tuple).toBeUndefined()
        admittedNamespace = actual.namespace
        namespaces.push(actual.namespace)
        const target = store.createChild(main, { invocationId: child.authority.turnId,
          checkpointNamespace: actual.namespace }, () => child.authority.assertLive())
        return { target, checkpointThreadId: threadId, checkpointIncarnation: main.incarnation,
          runtimeCheckpointNamespace: actual.namespace, signal,
          initialState: functionConversationState(target), assertCurrent: () => child.authority.assertLive() }
      },
      // These fixtures prove actual namespace/query/VM lifecycle, not conversation delivery ACK.
      delivery: actual => hold ? new Proxy(actual, { get(target, key) {
        if (key === "put") return async (...args: Parameters<SqlJsSaver["put"]>) => {
          await hold
          return SqlJsSaver.prototype.put.apply(target, args)
        }
        const value = Reflect.get(target, key, target)
        return typeof value === "function" ? value.bind(target) : value
      } }) : actual
    })
    scopes.push(scope)
    const graph = new StateGraph(state).addNode("native-model", (_input, runtime) => {
      const binding = scope.captureNode({ configurable: runtime.configurable, signal })
      expect(binding.target.checkpointNamespace).toBe(admittedNamespace)
      expect(() => scope.checkpointer.deleteThread(threadId)).toThrow("CHECKPOINT_SCOPE")
      expect(() => scope.checkpointer.close()).toThrow("CHECKPOINT_SCOPE")
      onNode()
      return { messages: [new AIMessage({ id: randomUUID(), content: "actual child answer" })] }
    }).addEdge(START, "native-model").addEdge("native-model", END).compile()
    const invoke = () => scope.run(async () => {
      const nativeConfig = { ...config,
        configurable: { ...config.configurable, __pregel_checkpointer: scope.checkpointer },
        durability: "async" as const }
      await preflight?.(scope, graph, nativeConfig)
      return graph.invoke({ messages: [new HumanMessage("native seed")] }, nativeConfig)
    })
    return { scope, invoke, child }
  }
  return { directory, state, saver, threadId, scopes, namespaces, current }
}

describe("actual shared graph native checkpointer router", () => {
  it("checks original opening facts before a namespace or native read exists", async () => {
    const f = fixture(), reads = vi.spyOn(SqlJsSaver.prototype, "getTuple")
    let callbacks = 0, nodes = 0
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      const child = f.current(config, () => { nodes++ }, undefined, undefined,
        () => { callbacks++ })
      try {
        const opening = readFunctionConversationSharedCheckpointOpeningCurrent(child.scope)
        if (!opening) throw Error("ACTUAL_SCOPE_OPENING_REQUIRED")
        const baseline = callbacks, queried = reads.mock.calls.length
        expect(opening.saver).toBe(f.saver)
        expect(opening.authority).toBe(child.child.authority)
        expect(opening.signal).toBeInstanceOf(AbortSignal)
        expect(opening.controllerSignal).toBeInstanceOf(AbortSignal)
        expect(f.namespaces).toEqual([])
        opening.assertDataCurrent()
        expect(callbacks).toBe(baseline)
        opening.assertCurrent()
        expect(callbacks).toBe(baseline + 1)
        expect(reads.mock.calls).toHaveLength(queried)
        expect(nodes).toBe(0)
        expect(f.namespaces).toEqual([])
        return await child.invoke()
      } finally { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    try {
      const result = await parent.invoke({ messages: [new HumanMessage("original opening seed")] },
        { configurable: { thread_id: f.threadId }, durability: "async" })
      expect(result.messages).toHaveLength(1)
      expect(nodes).toBe(1)
      expect(f.namespaces).toHaveLength(1)
    } finally { reads.mockRestore() }
  })

  it.each(["host", "controller", "parent", "ancestors", "checkpointer", "quarantined"] as const)(
    "rejects a late opening %s accessor without executing it or reviving the record", async key => {
      const f = fixture()
      const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
        const child = f.current(config)
        const opening = readFunctionConversationSharedCheckpointOpeningCurrent(child.scope)
        const original = Object.getOwnPropertyDescriptor(child.scope, key)
        if (!opening || !original || !("value" in original)) throw Error("ACTUAL_OPENING_FIELD_REQUIRED")
        let getters = 0, rejected = false
        try {
          Object.defineProperty(child.scope, key, { configurable: true, get() {
            getters++
            return original.value
          } })
          try { opening.assertDataCurrent() } catch { rejected = true }
        } finally { Object.defineProperty(child.scope, key, original) }
        try {
          expect(rejected).toBe(true)
          expect(getters).toBe(0)
          expect(() => opening.assertDataCurrent()).toThrow("CHECKPOINT_SCOPE")
          expect(f.namespaces).toEqual([])
          return { messages: [] }
        } finally { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
      }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
      await parent.invoke({ messages: [new HumanMessage("actual late opening seed")] },
        { configurable: { thread_id: f.threadId }, durability: "async" })
    })

  it("keeps a caught opening source reentry failed without acquiring a read", async () => {
    const f = fixture()
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      let armed = false, attacked = 0
      let opening: FunctionConversationSharedCheckpointOpeningCurrent | undefined
      const child = f.current(config, () => {}, undefined, undefined, () => {
        if (!armed || !opening) return
        armed = false
        attacked++
        try { opening.assertCurrent() } catch { /* The real source deliberately catches reentry. */ }
      })
      try {
        opening = readFunctionConversationSharedCheckpointOpeningCurrent(child.scope)
        if (!opening) throw Error("ACTUAL_SCOPE_OPENING_REQUIRED")
        armed = true
        expect(() => opening!.assertCurrent()).toThrow("CHECKPOINT_SCOPE")
        expect(attacked).toBe(1)
        expect(() => opening!.assertDataCurrent()).toThrow("CHECKPOINT_SCOPE")
        expect(f.namespaces).toEqual([])
        return { messages: [] }
      } finally { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    await parent.invoke({ messages: [new HumanMessage("actual opening reentry seed")] },
      { configurable: { thread_id: f.threadId }, durability: "async" })
  })

  it("rejects unknown opening clones and observes real retirement and controller cancellation", async () => {
    const f = fixture()
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      const child = f.current(config)
      const opening = readFunctionConversationSharedCheckpointOpeningCurrent(child.scope)
      if (!opening) throw Error("ACTUAL_SCOPE_OPENING_REQUIRED")
      let traps = 0
      const foreign = new Proxy(child.scope, { get() { traps++; throw Error("NO_SCOPE_TRAP") },
        getPrototypeOf() { traps++; throw Error("NO_SCOPE_TRAP") } })
      try {
        expect(readFunctionConversationSharedCheckpointOpeningCurrent(foreign)).toBeUndefined()
        expect(readFunctionConversationSharedCheckpointOpeningCurrent(
          Object.create(FunctionConversationSharedCheckpointScope.prototype))).toBeUndefined()
        expect(traps).toBe(0)
        expect(opening.controllerSignal.aborted).toBe(false)
        child.scope.close()
        expect(opening.controllerSignal.aborted).toBe(true)
        expect(() => opening.assertDataCurrent()).toThrow("CHECKPOINT_SCOPE")
        expect(f.namespaces).toEqual([])
        return { messages: [] }
      } finally { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    await parent.invoke({ messages: [new HumanMessage("actual closed opening seed")] },
      { configurable: { thread_id: f.threadId }, durability: "async" })
  })

  it("keeps native preflight data separate from real initialization and rejects changed source facts", async () => {
    const f = fixture(), reads = vi.spyOn(SqlJsSaver.prototype, "getTuple")
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      const child = f.current(config, () => {}, undefined, async (scope, graph, actual) => {
        const before = reads.mock.calls.length
        const snapshot = await scope.preflight(actual, () => graph.getState(actual))
        expect(snapshot).toMatchObject({ values: {}, next: [], tasks: [] })
        expect(reads.mock.calls).toHaveLength(before)
        expect(f.namespaces).toEqual([])
        const originals = actual.configurable
        if (!originals) throw Error("ACTUAL_NATIVE_CONFIG_REQUIRED")
        for (const changes of [
          { thread_id: randomUUID() }, { checkpoint_ns: "foreign-native-namespace" },
          { checkpoint_id: randomUUID() }, { __pregel_read: () => ({}) },
          { __pregel_scratchpad: {} }, { __pregel_checkpointer: f.saver },
          { checkpoint_map: { "": randomUUID() } }
        ]) {
          const changed = { ...actual, configurable: { ...originals, ...changes } }
          expect(() => scope.preflight(changed, () => graph.getState(changed)))
            .toThrow("CHECKPOINT_SCOPE")
        }
        expect(reads.mock.calls).toHaveLength(before)
        expect(f.namespaces).toEqual([])
      })
      expect(() => child.scope.preflight(config, () => Promise.resolve())).toThrow("CHECKPOINT_SCOPE")
      try { return await child.invoke() }
      finally { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    try {
      expect(await parent.invoke({ messages: [new HumanMessage("parent preflight seed")] },
        { configurable: { thread_id: f.threadId }, durability: "async" }))
        .toHaveProperty("messages")
      expect(f.namespaces).toHaveLength(1)
    } finally { reads.mockRestore() }
  })

  it("discovers distinct effective namespaces from two real child initializations in one parent node", async () => {
    const f = fixture()
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      const a = f.current(config), b = f.current(config)
      const results = await Promise.all([a.invoke(), b.invoke()])
      for (const child of [a, b]) { child.scope.close(); await child.scope.whenDrained(); child.child.release() }
      return { messages: results.flatMap(result => result.messages) }
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    const result = await parent.invoke({ messages: [new HumanMessage("parent seed")] },
      { configurable: { thread_id: f.threadId }, durability: "async" })
    expect(result.messages).toHaveLength(2)
    expect(new Set(f.namespaces).size).toBe(2)
    for (const namespace of f.namespaces) {
      expect(namespace).not.toBe("")
      expect(await f.saver.getTuple({ configurable: { thread_id: f.threadId, checkpoint_ns: namespace } }))
        .toHaveProperty("checkpoint")
    }
  })

  it("admits a real planned node before a held async native put and drains actual work after close", async () => {
    const f = fixture(), held = deferred(), entered = deferred()
    let child: ReturnType<typeof f.current> | undefined
    const parent = new StateGraph(f.state).addNode("tools", async (_state, config) => {
      child = f.current(config, entered.resolve, held.promise)
      return child.invoke()
    }).addEdge(START, "tools").addEdge("tools", END).compile({ checkpointer: f.saver })
    const outcome = parent.invoke({ messages: [new HumanMessage("held parent seed")] },
      { configurable: { thread_id: f.threadId }, durability: "async" })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([entered.promise, outcome.then(result => {
        if ("error" in result) throw result.error
        throw Error("Actual native node was not reached")
      })])
      if (!child) throw Error("ACTUAL_NATIVE_CHILD_REQUIRED")
      let drained = false
      void child.scope.whenDrained().then(() => { drained = true })
      child.scope.close()
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(() => child!.scope.captureNode({ configurable: {} })).toThrow("TARGET_CLOSED")
      held.resolve()
      expect(await outcome).toHaveProperty("error")
      await child.scope.whenDrained()
      expect(drained).toBe(true)
    } finally { held.resolve(); await outcome }
  })
})
