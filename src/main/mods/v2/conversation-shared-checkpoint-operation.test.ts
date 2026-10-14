import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SqlJsSaver } from "../../checkpointer/sqljs-saver"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionConversationSharedCheckpointScope,
  readFunctionConversationSharedCheckpointPreflightReceipt,
  runFunctionConversationSharedCheckpointPreflight,
  runFunctionConversationSharedCheckpointPreflightOperation } from "./conversation-shared-checkpointer"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-shared-preflight-"))
  const saver = new SqlJsSaver(join(directory, "actual.sqlite"))
  const controller = new AbortController(), authorities = new ModRuntimeAuthorities()
  const threadId = randomUUID()
  const parent = authorities.create({ workspace: directory, threadId, turnId: randomUUID() },
    controller.signal)
  const state = Annotation.Root({ messages: Annotation<BaseMessage[]>({
    reducer: (_old, next) => next, default: () => [] }) })
  const work: Promise<unknown>[] = [], releases: Array<() => void> = []
  const scopes: FunctionConversationSharedCheckpointScope[] = []
  const children: ReturnType<ModRuntimeAuthorities["create"]>[] = []
  let fullCalls = 0, admissions = 0, childNodes = 0
  let onCurrent: (() => void) | undefined
  const create = (config: RunnableConfig) => {
    const child = authorities.create({ workspace: directory, threadId,
      agentId: `mod-task:${randomUUID()}`, turnId: randomUUID() }, controller.signal, parent.authority)
    children.push(child)
    const scope = new FunctionConversationSharedCheckpointScope({ saver,
      authority: child.authority, parentConfig: config, parentGraphNamespace: "",
      signal: controller.signal, assertCurrent: () => {
        fullCalls++
        child.authority.assertLive()
        onCurrent?.()
      }, admit: async () => { admissions++; throw Error("PREFLIGHT_MUST_NOT_ADMIT") },
      delivery: actual => actual })
    scopes.push(scope)
    const graph = new StateGraph(state).addNode("unexpected-model", () => {
      childNodes++
      return { messages: [] }
    }).addEdge(START, "unexpected-model").addEdge("unexpected-model", END).compile()
    const actual = { ...config,
      configurable: { ...config.configurable, __pregel_checkpointer: scope.checkpointer },
      durability: "async" as const }
    const original = graph.getState
    const read = () => Reflect.apply(original, graph, [actual]) as ReturnType<typeof original>
    return { scope, actual, read }
  }
  const run = <T>(action: (current: ReturnType<typeof create>,
    sibling: () => ReturnType<typeof create>) => Promise<T>): Promise<T> => {
    let value!: T, completed = false
    const graph = new StateGraph(state).addNode("actual-parent-task", async (_state, config) => {
      const current = create(config)
      try {
        value = await action(current, () => create(config))
        completed = true
        return { messages: [] }
      } finally {
        current.scope.close()
        await current.scope.whenDrained()
      }
    }).addEdge(START, "actual-parent-task").addEdge("actual-parent-task", END)
      .compile({ checkpointer: saver })
    const actualWork = Promise.resolve().then(() => graph.invoke({
      messages: [new HumanMessage("actual parent preflight seed")]
    }, { configurable: { thread_id: threadId }, durability: "async" }))
      .then(() => {
        if (!completed) throw Error("ACTUAL_PARENT_TASK_REQUIRED")
        return value
      })
    work.push(actualWork)
    return actualWork
  }
  cleanups.push(async () => {
    controller.abort()
    for (const release of releases) release()
    for (const scope of scopes) scope.close()
    const drained = await Promise.allSettled([...work,
      ...scopes.map(scope => scope.whenDrained())])
    for (const child of children) child.release()
    const resources = await Promise.allSettled([
      Promise.resolve().then(() => authorities.close()),
      Promise.resolve().then(() => saver.close())
    ])
    rmSync(directory, { recursive: true, force: true })
    const failure = resources.find(result => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
    // Expected preflight rejection is observed inside the actual task, before its retirement.
    const workFailure = drained.find(result => result.status === "rejected")
    if (workFailure?.status === "rejected") throw workFailure.reason
  })
  return { run, saver, releases, scopes, setCurrent(callback?: () => void) { onCurrent = callback },
    counts: () => ({ fullCalls, admissions, childNodes }) }
}

describe("actual Shared Scope fixed run operation foundation", () => {
  it("keeps one run full and three nested true getState preflight full checks", async () => {
    const f = fixture(), reads = vi.spyOn(SqlJsSaver.prototype, "getTuple")
    try {
      await f.run(async current => {
        const before = f.counts().fullCalls, queried = reads.mock.calls.length
        const operation = Object.freeze({})
        const result = await runFunctionConversationSharedCheckpointPreflightOperation(
          current.scope, operation, async () => {
            expect(f.counts().fullCalls).toBe(before + 1)
            return runFunctionConversationSharedCheckpointPreflight(current.scope, operation,
              current.actual, current.read)
          })
        expect(f.counts().fullCalls).toBe(before + 4)
        expect(result.value).toMatchObject({ values: {}, next: [], tasks: [] })
        const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(result.receipt,
          current.scope, operation, current.actual)
        expect(receipt?.originalRead).toBe(current.read)
        receipt?.assertDataCurrent()
        expect(f.counts().fullCalls).toBe(before + 4)
        expect(reads.mock.calls.length).toBe(queried)
        expect(f.counts().admissions).toBe(0)
        expect(f.counts().childNodes).toBe(0)
      })
    } finally { reads.mockRestore() }
  })

  it("rejects unknown, clone and Proxy scopes before any full or delegate", async () => {
    const f = fixture()
    await f.run(async current => {
      const before = f.counts().fullCalls
      let traps = 0, delegates = 0
      const proxy = new Proxy(current.scope, { get() { traps++; throw Error("PROXY_SCOPE") },
        getPrototypeOf() { traps++; throw Error("PROXY_SCOPE") } })
      const copies = [Object.create(current.scope) as typeof current.scope,
        {} as typeof current.scope, proxy]
      for (const copy of copies)
        await expect(runFunctionConversationSharedCheckpointPreflightOperation(copy, {},
          async () => { delegates++; return 1 })).rejects.toThrow("CHECKPOINT_SCOPE")
      expect(traps).toBe(0)
      expect(delegates).toBe(0)
      expect(f.counts().fullCalls).toBe(before)
      expect(await runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
        async () => 2)).toBe(2)
      expect(f.counts().fullCalls).toBe(before + 1)
    })
  })

  it.each(["same", "foreign"])("makes caught %s operation run reentry sticky", async variant => {
    const f = fixture()
    await f.run(async current => {
      const operation = Object.freeze({})
      let armed = true, delegates = 0, nested: Promise<unknown> | undefined
      f.setCurrent(() => {
        if (!armed) return
        armed = false
        nested = runFunctionConversationSharedCheckpointPreflightOperation(current.scope,
          variant === "same" ? operation : {}, async () => { delegates++; return 99 })
          .catch(error => error)
      })
      try {
        await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope,
          operation, async () => { delegates++; return 1 })).rejects.toThrow("CHECKPOINT_SCOPE")
        await nested
        expect(delegates).toBe(0)
        await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope,
          operation, async () => { delegates++; return 2 })).rejects.toThrow("CHECKPOINT_SCOPE")
        expect(delegates).toBe(0)
      } finally { f.setCurrent() }
    })
  })

  it("rejects a late started accessor without reading it or reviving restored data", async () => {
    const f = fixture()
    await f.run(async current => {
      const original = Object.getOwnPropertyDescriptor(current.scope, "started")!
      let armed = true, getters = 0, delegates = 0
      f.setCurrent(() => {
        if (!armed) return
        armed = false
        Object.defineProperty(current.scope, "started", { configurable: true,
          get() { getters++; throw Error("LATE_STARTED") } })
      })
      try {
        await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
          async () => { delegates++; return 1 })).rejects.toThrow("CHECKPOINT_SCOPE")
      } finally {
        f.setCurrent()
        Object.defineProperty(current.scope, "started", original)
      }
      expect(getters).toBe(0)
      expect(delegates).toBe(0)
      await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
        async () => { delegates++; return 2 })).rejects.toThrow("CHECKPOINT_SCOPE")
      expect(delegates).toBe(0)
    })
  })

  it("uses captured context and methods after a full callback installs late getters", async () => {
    const f = fixture()
    await f.run(async current => {
      const prototype = FunctionConversationSharedCheckpointScope.prototype
      const original = ["guard", "tracked"].map(key =>
        [key, Object.getOwnPropertyDescriptor(prototype, key)!] as const)
      const context = Object.getOwnPropertyDescriptor(current.scope, "context")!.value as object
      const originalRun = Object.getOwnPropertyDescriptor(context, "run")
      let armed = true, getters = 0, delegates = 0
      f.setCurrent(() => {
        if (!armed) return
        armed = false
        for (const [key] of original) Object.defineProperty(prototype, key,
          { configurable: true, get() { getters++; throw Error("LATE_METHOD") } })
        Object.defineProperty(context, "run", { configurable: true,
          get() { getters++; throw Error("LATE_CONTEXT") } })
      })
      try {
        expect(await runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
          async () => { delegates++; return 1 })).toBe(1)
      } finally {
        f.setCurrent()
        if (originalRun) Object.defineProperty(context, "run", originalRun)
        else Reflect.deleteProperty(context, "run")
        for (const [key, descriptor] of original) Object.defineProperty(prototype, key, descriptor)
      }
      expect(getters).toBe(0)
      expect(delegates).toBe(1)
    })
  })

  it("preserves an undefined delegate rejection after its actual finally without a receipt", async () => {
    const f = fixture()
    await f.run(async current => {
      let finalized = false, rejected = false, reason: unknown = "not rejected"
      try {
        await runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
          async () => { try { throw undefined } finally { finalized = true } })
      } catch (error) { rejected = true; reason = error }
      expect(rejected).toBe(true)
      expect(reason).toBeUndefined()
      expect(finalized).toBe(true)
      expect(f.counts().admissions).toBe(0)
      current.scope.close()
      await current.scope.whenDrained()
      await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
        async () => 1)).rejects.toThrow("CHECKPOINT_SCOPE")
    })
  })

  it("keeps held execution pending through close until its real finally and rejects late run", async () => {
    const f = fixture()
    await f.run(async current => {
      const entered = deferred(), held = deferred()
      f.releases.push(held.resolve)
      let finalized = false, drained = false, rejected = false
      const work = runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
        async () => { entered.resolve(); try { await held.promise; return 1 }
          finally { finalized = true } }).catch(error => { rejected = true; return error })
      await entered.promise
      current.scope.close()
      const drain = current.scope.whenDrained().then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(finalized).toBe(false)
      held.resolve()
      await work
      await drain
      expect(finalized).toBe(true)
      expect(drained).toBe(true)
      expect(rejected).toBe(true)
      await expect(runFunctionConversationSharedCheckpointPreflightOperation(current.scope, {},
        async () => 2)).rejects.toThrow("CHECKPOINT_SCOPE")
    })
  })
})
