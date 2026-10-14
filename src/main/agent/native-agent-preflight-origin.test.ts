import { randomUUID } from "node:crypto"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { HumanMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent, FakeToolCallingModel } from "langchain"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFunctionConversationNativeAgent,
  readFunctionConversationNativeAgentDerivation,
  readFunctionConversationNativeAgentPreflightOrigin
} from "./native-agent-factory"

const invalid = "MODS_CONVERSATION_NATIVE_GRAPH_DERIVATION_INVALID"
const fixtures: Array<{ controller: AbortController; runs: Promise<unknown>[] }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  const runs: Promise<unknown>[] = []
  for (const fixture of fixtures.splice(0)) {
    fixture.controller.abort(Error("ACTUAL_PREFLIGHT_FIXTURE_FINISHED"))
    runs.push(...fixture.runs)
  }
  const results = await Promise.allSettled(runs)
  const rejected = results.find(result => result.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason
})

class Observer extends BaseCallbackHandler {
  name = "actual-preflight-origin-provider"
  calls = 0
  handleChatModelStart() { this.calls++ }
}
function fixture() {
  const saver = new MemorySaver(), observer = new Observer(), controller = new AbortController()
  const options = { model: new FakeToolCallingModel({ toolCalls: [[]] }), checkpointer: saver }
  const agent = createFunctionConversationNativeAgent(options)
  const source = readFunctionConversationNativeAgentDerivation(agent)!
  const origin = readFunctionConversationNativeAgentPreflightOrigin(agent)!
  const runs: Promise<unknown>[] = []
  fixtures.push({ controller, runs })
  const run = (actual: typeof agent = agent) => {
    const config = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
      signal: controller.signal, callbacks: [observer] }
    const input = new HumanMessage({ id: randomUUID(), content: "complete original preflight input" })
    const pending = Promise.resolve().then(async () => {
      const output = await actual.invoke({ messages: [input] }, config)
      const tuple = await saver.getTuple(config)
      expect(tuple?.checkpoint.channel_values.messages).toEqual(output.messages)
      expect(output.messages).toHaveLength(2)
      expect(output.messages[0]).toBe(input)
      expect(output.messages[1].getType()).toBe("ai")
      expect(observer.calls).toBeGreaterThan(0)
      return output
    })
    runs.push(pending)
    void pending.catch(() => undefined)
    return pending
  }
  return { agent, source, origin, options, saver, observer, run }
}

/** Origin data only. These tests do not certify a getState caller, Scope or stream output. */
describe("actual native Agent preflight origin foundation", () => {
  it("preserves the exact inherited method and full descriptor without executing preflight", async () => {
    const f = fixture(), owner = f.origin.path[f.origin.path.length - 1]
    expect(f.origin.graph).toBe(f.agent.graph)
    expect(f.origin.path[0]).toBe(f.agent.graph)
    expect(f.origin.original).toBe(Object.getOwnPropertyDescriptor(owner, "getState")!.value)
    expect(f.origin.descriptor).toEqual(Object.getOwnPropertyDescriptor(owner, "getState"))
    expect(Object.isFrozen(f.origin)).toBe(true)
    expect(Object.isFrozen(f.origin.path)).toBe(true)
    expect(Object.isFrozen(f.origin.descriptor)).toBe(true)
    f.origin.assertOriginalDataCurrent()
    expect(f.observer.calls).toBe(0)
    expect(readFunctionConversationNativeAgentPreflightOrigin(f.agent)).toBe(f.origin)
    await f.run()
  })

  it("pins actual child roots to the same module and original parent inheritance", async () => {
    const f = fixture(), first = f.source.derive({ tags: ["actual-preflight-first"] })
    const firstSource = readFunctionConversationNativeAgentDerivation(first)!
    const second = firstSource.derive({ metadata: { actual: "second" } })
    const childOrigin = readFunctionConversationNativeAgentPreflightOrigin(second)!
    expect(childOrigin.graph).not.toBe(f.origin.graph)
    expect(childOrigin.original).toBe(f.origin.original)
    expect(childOrigin.descriptor).toEqual(f.origin.descriptor)
    expect(childOrigin.path.slice(1)).toEqual(f.origin.path.slice(1))
    childOrigin.assertOriginalDataCurrent()
    await f.run(second as typeof f.agent)
  })

  it("does not consult unknown, cloned, foreign or Proxy methods", () => {
    const f = fixture(), get = vi.fn(), trap = vi.fn(() => { throw Error("UNKNOWN_TRAP") })
    const foreign = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }) })
    const shape = {}
    Object.defineProperty(shape, "graph", { get })
    Object.defineProperty(shape, "getState", { get })
    for (const value of [foreign, shape, { ...f.agent }, new Proxy(f.agent, {
      get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap
    })]) expect(readFunctionConversationNativeAgentPreflightOrigin(value)).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
    expect(trap).not.toHaveBeenCalled()
  })

  it("does not certify or read a later own getState adapter", () => {
    const f = fixture(), getter = vi.fn(() => { throw Error("OWN_ADAPTER_READ") })
    Object.defineProperty(f.agent.graph, "getState", { get: getter, configurable: true })
    try {
      expect(readFunctionConversationNativeAgentPreflightOrigin(f.agent)).toBe(f.origin)
      f.origin.assertOriginalDataCurrent()
      expect(f.origin.original).not.toBe(getter)
      expect(getter).not.toHaveBeenCalled()
    } finally { Reflect.deleteProperty(f.agent.graph, "getState") }
  })

  it.each(["getter", "replacement", "flags"] as const)(
    "rejects late inherited %s and keeps only the new origin failed after restoration", async attack => {
      const f = fixture(), owner = f.origin.path[f.origin.path.length - 1]
      const descriptor = Object.getOwnPropertyDescriptor(owner, "getState")!
      let callbacks = 0, rejected = false, sticky = false
      try {
        Object.defineProperty(owner, "getState", attack === "getter"
          ? { get() { callbacks++; return descriptor.value }, configurable: true }
          : attack === "replacement"
            ? { ...descriptor, value() { callbacks++; return undefined } }
            : { ...descriptor, enumerable: !descriptor.enumerable })
        try { f.origin.assertOriginalDataCurrent() } catch { rejected = true }
      } finally { Object.defineProperty(owner, "getState", descriptor) }
      try { readFunctionConversationNativeAgentPreflightOrigin(f.agent) } catch { sticky = true }
      expect(callbacks).toBe(0)
      expect(rejected).toBe(true)
      expect(sticky).toBe(true)
      expect(() => f.source.assertStructure()).not.toThrow()
      await f.run()
    }
  )

  it("rejects a changed root prototype path without recapturing it", async () => {
    const f = fixture(), prototype = Object.getPrototypeOf(f.agent.graph)
    let rejected = false
    try {
      Object.setPrototypeOf(f.agent.graph, Object.create(prototype))
      try { f.origin.assertOriginalDataCurrent() } catch { rejected = true }
    } finally { Object.setPrototypeOf(f.agent.graph, prototype) }
    expect(rejected).toBe(true)
    expect(() => f.origin.assertOriginalDataCurrent()).toThrow(invalid)
    await f.run()
  })

  it("refuses a child captured during a true constructor callback pollution after restore", async () => {
    const f = fixture(), owner = f.origin.path[f.origin.path.length - 1]
    const descriptor = Object.getOwnPropertyDescriptor(owner, "getState")!
    let callbacks = 0, methodCalls = 0, child: object | undefined
    Object.defineProperty(f.options, "name", { configurable: true, get() {
      callbacks++
      Object.defineProperty(owner, "getState", { ...descriptor,
        value() { methodCalls++; return undefined } })
      return undefined
    } })
    try { child = f.source.derive({ tags: ["actual-constructor-preflight"] }) }
    finally {
      Object.defineProperty(owner, "getState", descriptor)
      Reflect.deleteProperty(f.options, "name")
    }
    expect(callbacks).toBeGreaterThan(0)
    expect(methodCalls).toBe(0)
    expect(child).toBeDefined()
    expect(() => readFunctionConversationNativeAgentPreflightOrigin(child!)).toThrow(invalid)
    f.origin.assertOriginalDataCurrent()
    await f.run()
  })

  it("does not bless a first Factory constructor's polluted method as the module original", async () => {
    const clean = fixture(), owner = clean.origin.path[clean.origin.path.length - 1]
    const descriptor = Object.getOwnPropertyDescriptor(owner, "getState")!
    let callbacks = 0, methodCalls = 0
    const options = { model: new FakeToolCallingModel({ toolCalls: [[]] }), checkpointer: clean.saver }
    Object.defineProperty(options, "name", { configurable: true, get() {
      callbacks++
      Object.defineProperty(owner, "getState", { ...descriptor,
        value() { methodCalls++; return undefined } })
      return undefined
    } })
    let agent: typeof clean.agent | undefined
    try { agent = createFunctionConversationNativeAgent(options) }
    finally {
      Object.defineProperty(owner, "getState", descriptor)
      Reflect.deleteProperty(options, "name")
    }
    expect(callbacks).toBeGreaterThan(0)
    expect(methodCalls).toBe(0)
    expect(() => readFunctionConversationNativeAgentPreflightOrigin(agent!)).toThrow(invalid)
    await clean.run(agent as typeof clean.agent)
  })

  it.each(["getter", "replacement"] as const)(
    "uses its original WeakMap read through a late prototype %s", attack => {
      const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
      let callbacks = 0, result: unknown, failure: unknown
      try {
        Object.defineProperty(WeakMap.prototype, "get", attack === "getter"
          ? { configurable: true, get() { callbacks++; return descriptor.value } }
          : { ...descriptor, value() { callbacks++; return undefined } })
        try {
          result = readFunctionConversationNativeAgentPreflightOrigin(f.agent)
          f.origin.assertOriginalDataCurrent()
        } catch (error) { failure = error }
      } finally { Object.defineProperty(WeakMap.prototype, "get", descriptor) }
      expect(failure).toBeUndefined()
      expect(result).toBe(f.origin)
      expect(callbacks).toBe(0)
    }
  )
})
