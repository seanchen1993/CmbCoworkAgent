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
  runFunctionConversationSharedCheckpointPreflight } from "./conversation-shared-checkpointer"

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
        value = await current.scope.run(() => action(current, () => create(config)))
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

describe("actual Shared Scope preflight settlement foundation", () => {
  it("keeps original full checks and real getState result while selecting no child namespace", async () => {
    const f = fixture(), reads = vi.spyOn(SqlJsSaver.prototype, "getTuple")
    try {
      await f.run(async (current, createSibling) => {
        const baseline = f.counts().fullCalls, queried = reads.mock.calls.length
        const operation = Object.freeze({})
        const outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope,
          operation, current.actual, current.read)
        expect(outcome.value).toMatchObject({ values: {}, next: [], tasks: [] })
        expect(f.counts().fullCalls).toBe(baseline + 3)
        expect(reads.mock.calls.length).toBe(queried)
        const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
          current.scope, operation, current.actual)
        expect(receipt?.originalRead).toBe(current.read)
        const pureBefore = f.counts().fullCalls
        receipt?.assertDataCurrent()
        expect(f.counts().fullCalls).toBe(pureBefore)
        const sibling = createSibling()
        try {
          const before = f.counts().fullCalls
          const original = await sibling.scope.run(async () => {
            const afterRun = f.counts().fullCalls
            expect(afterRun).toBe(before + 1)
            const value = await sibling.scope.preflight(sibling.actual, sibling.read)
            expect(f.counts().fullCalls).toBe(afterRun + 3)
            return value
          })
          expect(original).toMatchObject({ values: {}, next: [], tasks: [] })
          expect(f.counts().fullCalls).toBe(before + 4)
          expect(reads.mock.calls.length).toBe(queried)
        } finally { sibling.scope.close(); await sibling.scope.whenDrained() }
        expect(f.counts().admissions).toBe(0)
        expect(f.counts().childNodes).toBe(0)
      })
    } finally { reads.mockRestore() }
  })

  it("rejects foreign receipts and config copies without callbacks or proxy traps", async () => {
    const f = fixture()
    await f.run(async (current, createSibling) => {
      const operation = Object.freeze({})
      const outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope,
        operation, current.actual, current.read)
      const sibling = createSibling(), before = f.counts().fullCalls
      let traps = 0
      const foreign = new Proxy(outcome.receipt, { get() { traps++; throw Error("NO_RECEIPT_GET") },
        getPrototypeOf() { traps++; throw Error("NO_RECEIPT_PROTO") } })
      try {
        expect(readFunctionConversationSharedCheckpointPreflightReceipt(foreign, current.scope,
          operation, current.actual)).toBeUndefined()
        expect(readFunctionConversationSharedCheckpointPreflightReceipt({ ...outcome.receipt },
          current.scope, operation, current.actual)).toBeUndefined()
        expect(readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
          sibling.scope, operation, current.actual)).toBeUndefined()
        expect(readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
          current.scope, {}, current.actual)).toBeUndefined()
        expect(readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
          current.scope, operation, { ...current.actual })).toBeUndefined()
        expect(f.counts().fullCalls).toBe(before)
        expect(traps).toBe(0)
        expect(readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
          current.scope, operation, current.actual)?.originalRead).toBe(current.read)
      } finally { sibling.scope.close(); await sibling.scope.whenDrained() }
    })
  })

  it("preserves undefined delegate failure and never mints a successful receipt", async () => {
    const f = fixture()
    await f.run(async current => {
      const operation = Object.freeze({})
      const result = await runFunctionConversationSharedCheckpointPreflight(current.scope,
        operation, current.actual, () => Promise.reject(undefined))
        .then(value => ({ failed: false, value }), (reason: unknown) => ({ failed: true, reason }))
      expect(result.failed).toBe(true)
      expect(result).toHaveProperty("reason", undefined)
      await expect(runFunctionConversationSharedCheckpointPreflight(current.scope, operation,
        current.actual, current.read)).rejects.toThrow("CHECKPOINT_SCOPE")
      expect(f.counts().admissions).toBe(0)
      expect(f.counts().childNodes).toBe(0)
    })
  })

  it("misses unknown Scope copies and proxies before any full callback or actual read", async () => {
    const f = fixture()
    await f.run(async current => {
      const before = f.counts().fullCalls
      let traps = 0, reads = 0
      const foreign = new Proxy(current.scope, { get() { traps++; throw Error("NO_SCOPE_GET") },
        getPrototypeOf() { traps++; throw Error("NO_SCOPE_PROTO") } })
      const read = async () => { reads++; return current.read() }
      await expect(runFunctionConversationSharedCheckpointPreflight(foreign, {}, current.actual,
        read)).rejects.toThrow("CHECKPOINT_SCOPE")
      await expect(runFunctionConversationSharedCheckpointPreflight(
        Object.create(FunctionConversationSharedCheckpointScope.prototype), {}, current.actual,
        read)).rejects.toThrow("CHECKPOINT_SCOPE")
      expect(traps).toBe(0)
      expect(reads).toBe(0)
      expect(f.counts().fullCalls).toBe(before)
      const outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope, {},
        current.actual, current.read)
      expect(outcome.value).toMatchObject({ values: {}, next: [], tasks: [] })
      expect(f.counts().admissions).toBe(0)
    })
  })

  it("poisons caught same-operation source reentry before the original read", async () => {
    const f = fixture()
    await f.run(async current => {
      let armed = true, nested = 0, read = 0
      const operation = Object.freeze({})
      f.setCurrent(() => {
        if (!armed) return
        armed = false
        nested++
        void runFunctionConversationSharedCheckpointPreflight(current.scope, operation,
          current.actual, current.read).catch(() => { /* The actual source catches its nested rejection. */ })
      })
      try {
        await expect(runFunctionConversationSharedCheckpointPreflight(current.scope, operation,
          current.actual, async () => { read++; return current.read() }))
          .rejects.toThrow("CHECKPOINT_SCOPE")
        expect(nested).toBe(1)
        expect(read).toBe(0)
        await expect(runFunctionConversationSharedCheckpointPreflight(current.scope, operation,
          current.actual, current.read)).rejects.toThrow("CHECKPOINT_SCOPE")
      } finally { f.setCurrent() }
      expect(f.counts().admissions).toBe(0)
    })
  })

  it.each(["entered", "validatePreflight", "preflightTuple", "tracked", "finishDrain"])(
    "keeps the captured execution graph when the source installs a late %s getter", async key => {
      const f = fixture()
      await f.run(async current => {
        const prototype = FunctionConversationSharedCheckpointScope.prototype
        const original = Object.getOwnPropertyDescriptor(prototype, key)
        if (!original) throw Error("ACTUAL_SCOPE_METHOD_REQUIRED")
        let armed = true, getters = 0
        f.setCurrent(() => {
          if (!armed) return
          armed = false
          Object.defineProperty(prototype, key, { configurable: true,
            get() { getters++; throw Error("LATE_SCOPE_METHOD") } })
        })
        let outcome: Awaited<ReturnType<typeof runFunctionConversationSharedCheckpointPreflight>> | undefined
        try {
          outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope, {},
            current.actual, current.read)
        } finally {
          f.setCurrent()
          Object.defineProperty(prototype, key, original)
        }
        expect(getters).toBe(0)
        expect(outcome?.value).toMatchObject({ values: {}, next: [], tasks: [] })
        expect(f.counts().admissions).toBe(0)
      })
    })

  it("rejects a late owned execution-field getter without reading it or granting again", async () => {
    const f = fixture()
    await f.run(async current => {
      const original = Object.getOwnPropertyDescriptor(current.scope, "context")
      if (!original) throw Error("ACTUAL_SCOPE_CONTEXT_REQUIRED")
      let getters = 0
      const operation = Object.freeze({})
      const outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope,
        operation, current.actual, current.read)
      const receipt = readFunctionConversationSharedCheckpointPreflightReceipt(outcome.receipt,
        current.scope, operation, current.actual)
      if (!receipt) throw Error("ACTUAL_PREFLIGHT_RECEIPT_REQUIRED")
      const before = f.counts().fullCalls
      Object.defineProperty(current.scope, "context", { configurable: true,
        get() { getters++; throw Error("LATE_SCOPE_CONTEXT") } })
      try {
        expect(() => receipt.assertDataCurrent()).toThrow("CHECKPOINT_SCOPE")
      } finally { Object.defineProperty(current.scope, "context", original) }
      expect(getters).toBe(0)
      expect(f.counts().fullCalls).toBe(before)
      expect(() => receipt.assertDataCurrent()).toThrow("CHECKPOINT_SCOPE")
      expect(f.counts().admissions).toBe(0)
    })
  })

  it("keeps held actual preflight pending through close and drains its real finally", async () => {
    const f = fixture(), held = deferred(), entered = deferred()
    f.releases.push(held.resolve)
    let active: FunctionConversationSharedCheckpointScope | undefined, settled = false
    const work = f.run(async current => {
      active = current.scope
      const outcome = await runFunctionConversationSharedCheckpointPreflight(current.scope, {},
        current.actual, async () => {
          const value = await current.read()
          entered.resolve()
          try { await held.promise; return value }
          finally { settled = true }
        }).then(value => ({ failed: false, value }), (reason: unknown) => ({ failed: true, reason }))
      expect(outcome.failed).toBe(true)
      expect(outcome).toHaveProperty("reason")
    })
    try {
      await Promise.race([entered.promise, work.then(() => { throw Error("HELD_PREFLIGHT_REQUIRED") })])
      if (!active) throw Error("ACTUAL_SCOPE_REQUIRED")
      let drained = false
      void active.whenDrained().then(() => { drained = true })
      active.close()
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(settled).toBe(false)
      held.resolve()
      await work
      await active.whenDrained()
      expect(settled).toBe(true)
      expect(drained).toBe(true)
      expect(f.counts().admissions).toBe(0)
      expect(f.counts().childNodes).toBe(0)
    } finally { held.resolve(); await work }
  })
})
