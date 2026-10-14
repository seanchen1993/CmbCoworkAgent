import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { CallbackManager } from "@langchain/core/callbacks/manager"
import { HumanMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { createAgent, FakeToolCallingModel } from "langchain"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createFunctionConversationNativeAgent,
  readFunctionConversationNativeAgentDerivation
} from "./native-agent-factory"

const invalid = "MODS_CONVERSATION_NATIVE_GRAPH_DERIVATION_INVALID"
afterEach(() => {
  vi.restoreAllMocks()
})
function fixture() {
  const agent = createFunctionConversationNativeAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] })
  })
  const source = readFunctionConversationNativeAgentDerivation(agent)
  if (!source) throw Error("ACTUAL_FACTORY_REQUIRED")
  return { agent, source }
}

describe("original native Agent factory derivation", () => {
  it("qualifies only its actual Agent, without consulting foreign or Proxy getters", () => {
    const f = fixture(),
      getter = vi.fn(() => f.agent.graph)
    const foreign = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }) })
    const shape = { withConfig: f.agent.withConfig }
    Object.defineProperty(shape, "graph", { get: getter })
    expect(f.source.graph).toBe(f.agent.graph)
    expect(readFunctionConversationNativeAgentDerivation(f.agent)).toBe(f.source)
    for (const value of [foreign, shape, { ...f.agent }, new Proxy(f.agent, { get: getter })])
      expect(readFunctionConversationNativeAgentDerivation(value)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it("keeps only effective graph preparation defaults and preserves invocation overrides", () => {
    const f = fixture()
    const first = f.source.derive({
      configurable: { thread_id: "actual", checkpoint_ns: "" },
      tags: ["first"],
      metadata: { inherited: true },
      recursionLimit: 42,
      streamMode: "messages",
      subgraphs: true
    } as RunnableConfig)
    const firstSource = readFunctionConversationNativeAgentDerivation(first)!
    const second = firstSource.derive({
      configurable: { checkpoint_id: "real-point" },
      tags: ["second"],
      streamMode: "updates"
    } as RunnableConfig)
    const resolved = readFunctionConversationNativeAgentDerivation(second)!.resolve({
      configurable: { checkpoint_id: "override" },
      tags: ["call"],
      metadata: { call: true },
      recursionLimit: 19
    })
    expect(resolved).toEqual({
      configurable: { thread_id: "actual", checkpoint_ns: "", checkpoint_id: "override" },
      streamMode: "updates",
      subgraphs: true,
      tags: ["call"],
      metadata: { call: true },
      recursionLimit: 19
    })
    expect(f.source.resolve({})).toEqual({})
    expect(firstSource.graph).not.toBe(f.source.graph)
    expect(readFunctionConversationNativeAgentDerivation(second)!.graph).not.toBe(firstSource.graph)
  })

  it("lets the actual framework merge callbacks and tags once, as in the unwrapped baseline", async () => {
    class Observer extends BaseCallbackHandler {
      name = "actual-factory-callback"
      readonly starts: Array<{ tags: string[]; metadata: Record<string, unknown> }> = []
      handleChatModelStart(
        ...args: Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>
      ) {
        this.starts.push({ tags: args[5] ?? [], metadata: args[6] ?? {} })
      }
    }
    const run = async (wrapped: boolean) => {
      const defaults = new Observer(),
        called = new Observer()
      const options = { model: new FakeToolCallingModel({ toolCalls: [[]] }) }
      const agent = wrapped ? createFunctionConversationNativeAgent(options) : createAgent(options)
      const source = readFunctionConversationNativeAgentDerivation(agent)
      const configured = {
        tags: ["default-tag"],
        callbacks: [defaults],
        metadata: { inherited: "original" }
      }
      const derived = (
        source ? source.derive(configured) : agent.withConfig(configured)
      ) as typeof agent
      const config = { tags: ["call-tag"], callbacks: [called], metadata: { explicit: "call" } }
      const resolved =
        readFunctionConversationNativeAgentDerivation(derived)?.resolve(config) ?? config
      const result = await derived.invoke(
        { messages: [new HumanMessage("actual input")] },
        resolved
      )
      expect(result.messages).toHaveLength(2)
      expect(defaults.starts).toHaveLength(1)
      expect(called.starts).toHaveLength(1)
      return defaults.starts[0]
    }
    const baseline = await run(false),
      actual = await run(true)
    expect(actual.tags).toEqual(baseline.tags)
    expect(actual.metadata.inherited).toBe(baseline.metadata.inherited)
    expect(actual.metadata.explicit).toBe(baseline.metadata.explicit)
  })

  it.each(["withConfig", "graph", "options"])(
    "refuses an own %s accessor before its getter or original method can run",
    (key) => {
      const f = fixture(),
        getter = vi.fn()
      Object.defineProperty(f.agent, key, { configurable: true, get: getter })
      expect(() => f.source.derive({})).toThrow(invalid)
      expect(() => f.source.resolve({})).toThrow(invalid)
      expect(getter).not.toHaveBeenCalled()
    }
  )

  it.each(["withConfig", "graph"])(
    "refuses a replaced prototype %s descriptor without executing it",
    (key) => {
      const f = fixture(),
        prototype = Object.getPrototypeOf(f.agent) as object
      const original = Object.getOwnPropertyDescriptor(prototype, key)!
      const getter = vi.fn()
      try {
        Object.defineProperty(prototype, key, { configurable: true, get: getter })
        expect(() => f.source.derive({})).toThrow(invalid)
        expect(getter).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(prototype, key, original)
      }
      expect(() => f.source.assertStructure()).not.toThrow()
    }
  )

  it.each(["config", "configurable"])("refuses a %s accessor before reading it", (kind) => {
    const f = fixture(),
      getter = vi.fn()
    const value = Object.create(Object.prototype) as RunnableConfig
    Object.defineProperty(value, "thread_id", { enumerable: true, get: getter })
    const config = kind === "config" ? value : { configurable: value }
    expect(() => f.source.derive(config)).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it("refuses unsupported default signals while retaining ordinary invocation signals", () => {
    const f = fixture(),
      controller = new AbortController()
    expect(() => f.source.derive({ signal: controller.signal })).toThrow(invalid)
    expect(f.source.resolve({ signal: controller.signal }).signal).toBe(controller.signal)
    expect(() => f.source.assertStructure()).not.toThrow()
  })

  it.each(["missing", "undefined", "nonenumerable"] as const)(
    "keeps the already selected default reason across a %s derive", kind => {
      const f = fixture(), first = new AbortController(), second = new AbortController()
      const reason = Error("ACTUAL_ALREADY_SELECTED_DEFAULT_REASON")
      const parent = f.source.deriveCancellation({ signal: first.signal })
      second.abort(reason)
      const secondSource = readFunctionConversationNativeAgentDerivation(parent)!
      const child = secondSource.deriveCancellation({ signal: second.signal })
      first.abort(Error("ACTUAL_LATER_FIRST_REASON"))
      const config: RunnableConfig = kind === "undefined" ? { signal: undefined } : {}
      if (kind === "nonenumerable") Object.defineProperty(config, "signal", {
        value: new AbortController().signal, enumerable: false })
      const derived = readFunctionConversationNativeAgentDerivation(child)!.deriveCancellation(config)
      const source = readFunctionConversationNativeAgentDerivation(derived)!
      const called = new AbortController()
      const effective = source.resolveCancellation(called.signal)
      expect(effective.aborted).toBe(true)
      expect(effective.reason).toBe(reason)
      expect(source.resolve({ signal: called.signal }).signal).toBe(called.signal)
      expect(f.source.resolveCancellation(called.signal)).toBe(called.signal)
    })

  it.each(["getter", "Proxy"] as const)("does not consult a caller's %s signal properties", kind => {
    const f = fixture(), getter = vi.fn(), controller = new AbortController()
    const signal = kind === "Proxy" ? new Proxy(controller.signal, { get: getter }) : controller.signal
    Object.defineProperty(controller.signal, "aborted", { configurable: true, get: getter })
    expect(() => f.source.deriveCancellation({ signal })).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it("refuses an own default reason getter without reading it", () => {
    const f = fixture(), controller = new AbortController(), getter = vi.fn()
    Object.defineProperty(controller.signal, "reason", { configurable: true, get: getter })
    expect(() => f.source.deriveCancellation({ signal: controller.signal })).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it("refuses a nonstandard genuine Signal prototype without reading it", () => {
    const f = fixture(), controller = new AbortController(), getter = vi.fn()
    Object.setPrototypeOf(controller.signal, Object.create(AbortSignal.prototype, {
      aborted: { configurable: true, get: getter }
    }))
    expect(() => f.source.deriveCancellation({ signal: controller.signal })).toThrow(invalid)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    { key: "aborted", kind: "getter" }, { key: "aborted", kind: "replacement" },
    { key: "reason", kind: "getter" }, { key: "reason", kind: "replacement" }
  ] as const)("refuses a late standard Signal property %j before original any", attack => {
    const f = fixture(), controller = new AbortController(), call = new AbortController()
    const child = f.source.deriveCancellation({ signal: controller.signal })
    const source = readFunctionConversationNativeAgentDerivation(child)!
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, attack.key)!
    let reads = 0, failed = false, failure: unknown
    try {
      Object.defineProperty(AbortSignal.prototype, attack.key, attack.kind === "getter"
        ? { ...descriptor, get() { reads++; throw Error("LATE_SIGNAL_GETTER") } }
        : { ...descriptor, get() { reads++; return undefined } })
      source.resolveCancellation(call.signal)
    } catch (error) { failed = true; failure = error }
    finally { Object.defineProperty(AbortSignal.prototype, attack.key, descriptor) }
    expect(failed).toBe(true)
    expect(failure).toMatchObject({ code: invalid })
    expect(reads).toBe(0)
    const reason = Error("ACTUAL_STANDARD_DEFAULT_ABORT")
    controller.abort(reason)
    expect(source.resolveCancellation(call.signal).reason).toBe(reason)
  })

  it("ignores a nonenumerable Proxy default exactly as the original framework", () => {
    const f = fixture(), defaults = new AbortController(), getter = vi.fn()
    const parent = f.source.deriveCancellation({ signal: defaults.signal })
    const config: RunnableConfig = {}
    Object.defineProperty(config, "signal", { enumerable: false,
      value: new Proxy(new AbortController().signal, { get: getter }) })
    const baseline = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }) })
      .withConfig({ signal: defaults.signal })
    expect(() => baseline.withConfig(config)).not.toThrow()
    const child = readFunctionConversationNativeAgentDerivation(parent)!.deriveCancellation(config)
    const source = readFunctionConversationNativeAgentDerivation(child)!
    const reason = Error("ACTUAL_NONENUMERABLE_DEFAULT_PRESERVED")
    defaults.abort(reason)
    expect(source.resolveCancellation(new AbortController().signal).reason).toBe(reason)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(["missing", "duplicate"] as const)(
    "refuses a trusted signal getter's %s framework read without publishing a child", kind => {
      const f = fixture(), controller = new AbortController(), originalKeys = Object.keys
      let attacked = 0
      const keys = vi.spyOn(Object, "keys").mockImplementation(value => {
        const field = Object.getOwnPropertyDescriptor(value, "signal")
        if (field?.get) {
          attacked++
          if (kind === "missing") return originalKeys(value).filter(key => key !== "signal")
          try { Reflect.apply(field.get, value, []) } catch { /* The real merge must still fail. */ }
        }
        return originalKeys(value)
      })
      let failure: unknown
      try { f.source.deriveCancellation({ signal: controller.signal }) }
      catch (error) { failure = error }
      finally { keys.mockRestore() }
      expect(attacked).toBeGreaterThan(0)
      expect(failure).toHaveProperty("code", invalid)
      expect(() => f.source.assertStructure()).not.toThrow()
      expect(() => f.source.deriveCancellation({ signal: controller.signal })).not.toThrow()
    })

  it("poisons caught same-parent cancellation derivation from the original callback copy", () => {
    const f = fixture(), callbacks = new CallbackManager(), signal = new AbortController().signal
    const parent = f.source.deriveCancellation({ callbacks, signal })
    const source = readFunctionConversationNativeAgentDerivation(parent)!
    const originalCopy = callbacks.copy
    const copy = vi.spyOn(callbacks, "copy").mockImplementation(() => {
      try { source.deriveCancellation({ signal }) } catch { /* Caught reentry remains sticky. */ }
      return Reflect.apply(originalCopy, callbacks, [])
    })
    expect(() => source.deriveCancellation({ signal, callbacks: [] })).toThrow(invalid)
    expect(copy).toHaveBeenCalledTimes(1)
    copy.mockRestore()
    expect(() => source.deriveCancellation({ signal })).not.toThrow()
  })

  it("preserves the original callback copy exception and calls it once", () => {
    const f = fixture(), callbacks = new CallbackManager(), signal = new AbortController().signal
    const parent = f.source.deriveCancellation({ callbacks, signal })
    const source = readFunctionConversationNativeAgentDerivation(parent)!
    const reason = Error("ACTUAL_ORIGINAL_CALLBACK_COPY_FAILED")
    const copy = vi.spyOn(callbacks, "copy").mockImplementation(() => { throw reason })
    expect(() => source.deriveCancellation({ signal, callbacks: [] })).toThrow(reason)
    expect(copy).toHaveBeenCalledTimes(1)
    copy.mockRestore()
    expect(() => source.assertStructure()).not.toThrow()
  })
})
