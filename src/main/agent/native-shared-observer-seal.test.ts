import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import * as factory from "./native-agent-factory"
import { createFunctionConversationNativeSourceLifetimeFromInstallation,
  installFunctionConversationNativeSourceObserver,
  readFunctionConversationNativeSourceObserverInstallation,
  readFunctionConversationNativeSourceObserverOrigin,
  sealFunctionConversationNativeSourceObserverInstallation,
  type FunctionConversationNativeSourceObserverInstallation } from
  "./function-conversation-native-lifetime"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const rejected = results.find(result => result.status === "rejected")
  if (rejected?.status === "rejected") throw rejected.reason
})
class ActualModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly toolName: string) { super({}) }
  _llmType() { return "actual-shared-observer-seal" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = new AIMessage({ id: randomUUID(), content: "complete actual observer output",
      ...(this.requests.length === 1 ? { tool_calls: [
        { name: this.toolName, id: "actual-observer-tool-call", args: {} }
      ] } : {}) })
    return { generations: [{ message, text: "complete actual observer output" }] }
  }
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-known-observer-seal-"))
  const saver = new SqlJsSaver(join(directory, "actual.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const effect = vi.fn(() => "actual complete tool result")
  const actualTool = tool(effect, { name: "actual_observer_seal_tool", schema: z.object({}) })
  const model = new ActualModel(actualTool.name)
  const agent = factory.createFunctionConversationNativeAgent({ model, tools: [actualTool],
    checkpointer: saver })
  const source = factory.readFunctionConversationNativeAgentDerivation(agent)
  if (!source) throw Error("ACTUAL_NATIVE_FACTORY_REQUIRED")
  const graph = agent.graph
  const installation = installFunctionConversationNativeSourceObserver(graph)
  const controller = new AbortController(), runs: Promise<unknown>[] = []
  const lifetimes: Array<ReturnType<typeof createFunctionConversationNativeSourceLifetimeFromInstallation>> = []
  cleanup.push(async () => {
    controller.abort(Error("ACTUAL_OBSERVER_FIXTURE_FINISHED"))
    for (const lifetime of lifetimes) lifetime.finishOpening()
    const pending: Promise<unknown>[] = [...runs]
    for (const lifetime of lifetimes) {
      pending[pending.length] = lifetime.drain()
      pending[pending.length] = lifetime.whenSettled()
    }
    const results = await Promise.allSettled(pending)
    await saver.close()
    rmSync(directory, { recursive: true, force: true })
    const rejected = results.find(result => result.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
  })
  const run = (id: string) => {
    const actual = Promise.resolve().then(async () => {
      const guard = vi.fn()
      const lifetime = createFunctionConversationNativeSourceLifetimeFromInstallation(installation, guard)
      lifetimes.push(lifetime)
      const config: RunnableConfig = { configurable: { thread_id: id, checkpoint_ns: "" },
        signal: controller.signal, streamMode: "values" } as RunnableConfig
      const stream = await lifetime.run(() => agent.stream({ messages: [
        new HumanMessage({ id: randomUUID(), content: "complete actual observer input" })
      ] }, config))
      lifetime.finishOpening()
      const frames: unknown[] = []
      for await (const frame of stream) frames.push(frame)
      await lifetime.whenSettled()
      const tuple = await saver.getTuple(config)
      if (!tuple) throw Error("ACTUAL_OBSERVER_CHECKPOINT_REQUIRED")
      const exact = await saver.getTuple(tuple.config)
      expect(exact?.checkpoint.id).toBe(tuple.checkpoint.id)
      expect(Array.isArray(exact?.checkpoint.channel_values.messages)).toBe(true)
      expect(frames.length).toBeGreaterThan(0)
      expect(guard).toHaveBeenCalled()
      return tuple
    })
    runs[runs.length] = actual
    void actual.catch(() => undefined)
    return actual
  }
  return { agent, graph, source, installation, model, effect, saver, run }
}

/** Method provenance only: this suite does not certify a Shared Producer or output frame. */
describe("genuine Factory and Lifetime once observer seal", () => {
  it("seals the same actual observed methods and reuses them for two complete native calls", async () => {
    const f = fixture(), stream = Object.getOwnPropertyDescriptor(f.graph, "stream")!
    const iterator = Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")!
    const origin = readFunctionConversationNativeSourceObserverOrigin(f.installation, f.graph)
    factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation)
    expect(Object.getOwnPropertyDescriptor(f.graph, "stream")).toEqual({ ...stream,
      writable: false, configurable: false })
    expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")).toEqual({ ...iterator,
      writable: false, configurable: false })
    expect(readFunctionConversationNativeSourceObserverOrigin(f.installation, f.graph)).toBe(origin)
    expect(installFunctionConversationNativeSourceObserver(f.graph)).toBe(f.installation)
    f.source.assertStructure()
    const first = await f.run(randomUUID()), second = await f.run(randomUUID())
    const messages: unknown = first.checkpoint.channel_values.messages
    if (!Array.isArray(messages)) throw Error("ACTUAL_NATIVE_MESSAGES_REQUIRED")
    expect(messages.filter(message => message instanceof ToolMessage)).toHaveLength(1)
    expect(first.checkpoint.id).not.toBe(second.checkpoint.id)
    expect(f.model.requests).toHaveLength(3)
    expect(f.effect).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(f.graph, "stream")?.value).toBe(stream.value)
    expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")?.value).toBe(iterator.value)
  })

  it("rejects unknown, cloned and foreign requests before define without poisoning another graph", () => {
    const f = fixture(), foreign = fixture(), trap = vi.fn()
    const originalClaim = factory.claimFunctionConversationSharedNativeObserverSeal
    const originalDefine = Reflect.defineProperty
    let defines = 0, checked = false
    const define = vi.spyOn(Reflect, "defineProperty").mockImplementation((value, key, field) => {
      if (value === f.graph || value === foreign.graph) defines++
      return originalDefine(value, key, field)
    })
    const claim = vi.spyOn(factory, "claimFunctionConversationSharedNativeObserverSeal")
      .mockImplementation((request, installation, graph) => {
        if (!checked) {
          checked = true
          for (const token of [Object.freeze({}), Object.freeze({ ...request }),
            new Proxy(request, { get: trap, getPrototypeOf: trap })]) {
            expect(() => sealFunctionConversationNativeSourceObserverInstallation(installation,
              token as factory.SharedNativeObserverSealRequest)).toThrow()
          }
          expect(() => sealFunctionConversationNativeSourceObserverInstallation(
            foreign.installation, request)).toThrow()
          expect(defines).toBe(0)
        }
        return originalClaim(request, installation, graph)
      })
    try { factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation) }
    finally { define.mockRestore(); claim.mockRestore() }
    expect(checked).toBe(true)
    expect(trap).not.toHaveBeenCalled()
    expect(defines).toBe(2)
    expect(() => readFunctionConversationNativeSourceObserverInstallation(foreign.installation,
      foreign.graph)).not.toThrow()
    expect(Object.getOwnPropertyDescriptor(foreign.graph, "stream")?.configurable).toBe(true)
    expect(f.model.requests).toEqual([])
    expect(foreign.model.requests).toEqual([])
  })

  it.each(["stream", "_streamIterator"] as const)(
    "keeps an actual failed %s define permanently failed rather than repairing a half seal", key => {
      const f = fixture(), originalDefine = Reflect.defineProperty
      let attacked = false
      const fault = vi.spyOn(Reflect, "defineProperty").mockImplementation((value, name, field) => {
        if (value === f.graph && name === key && !attacked) { attacked = true; return false }
        return originalDefine(value, name, field)
      })
      try { expect(() => factory.sealFunctionConversationSharedNativeAgentDispatch(
        f.agent, f.installation)).toThrow() }
      finally { fault.mockRestore() }
      expect(attacked).toBe(true)
      expect(() => f.source.assertStructure()).toThrow()
      expect(() => readFunctionConversationNativeSourceObserverInstallation(f.installation,
        f.graph)).toThrow()
      expect(() => installFunctionConversationNativeSourceObserver(f.graph)).toThrow()
      expect(() => factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent,
        f.installation)).toThrow()
      expect(f.model.requests).toEqual([])
      expect(f.effect).not.toHaveBeenCalled()
      if (key === "_streamIterator") {
        expect(Object.getOwnPropertyDescriptor(f.graph, "stream")?.configurable).toBe(false)
        expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")?.configurable).toBe(true)
      }
    })

  it("retires both private records when the Factory's final dispatch publication fails", () => {
    const f = fixture(), originalDefine = Object.defineProperty
    let attacked = false
    const fault = vi.spyOn(Object, "defineProperty").mockImplementation((value, key, field) => {
      if (value === f.graph && key === "invoke" && !attacked) {
        attacked = true
        throw Error("ACTUAL_DISPATCH_PUBLICATION_FAILURE")
      }
      return originalDefine(value, key, field)
    })
    try { expect(() => factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent,
      f.installation)).toThrow("ACTUAL_DISPATCH_PUBLICATION_FAILURE") }
    finally { fault.mockRestore() }
    expect(attacked).toBe(true)
    expect(() => f.source.assertStructure()).toThrow()
    expect(() => readFunctionConversationNativeSourceObserverInstallation(f.installation,
      f.graph)).toThrow()
    expect(Object.getOwnPropertyDescriptor(f.graph, "stream")?.configurable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")?.configurable).toBe(false)
    expect(f.model.requests).toEqual([])
  })

  it("keeps caught same-request reentry failed in both records before the first define", () => {
    const f = fixture(), originalClaim = factory.claimFunctionConversationSharedNativeObserverSeal
    let entered = false, nestedRejected = false
    const claim = vi.spyOn(factory, "claimFunctionConversationSharedNativeObserverSeal")
      .mockImplementation((request, installation, graph) => {
        if (!entered) {
          entered = true
          try { factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation) }
          catch { nestedRejected = true }
        }
        return originalClaim(request, installation, graph)
      })
    let rejected = false
    try { factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation) }
    catch { rejected = true }
    finally { claim.mockRestore() }
    expect(entered).toBe(true)
    expect(nestedRejected).toBe(true)
    expect(rejected).toBe(true)
    expect(Object.getOwnPropertyDescriptor(f.graph, "stream")?.configurable).toBe(true)
    expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")?.configurable).toBe(true)
    expect(() => f.source.assertStructure()).toThrow()
    expect(() => readFunctionConversationNativeSourceObserverInstallation(f.installation,
      f.graph)).toThrow()
    expect(() => factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent,
      f.installation)).toThrow()
    expect(f.model.requests).toEqual([])
    expect(f.effect).not.toHaveBeenCalled()
  })

  it("keeps the first claim and derivation on private own initial fields", () => {
    const f = fixture(), originalClaim = factory.claimFunctionConversationSharedNativeObserverSeal
    const dispatch = Object.getOwnPropertyDescriptor(Object.prototype, "dispatch")
    const deriving = Object.getOwnPropertyDescriptor(Object.prototype, "deriving")
    let calls = 0, checked = false
    const patch = () => {
      Object.defineProperty(Object.prototype, "dispatch", { configurable: true,
        get() { calls++; return undefined } })
      Object.defineProperty(Object.prototype, "deriving", { configurable: true,
        get() { calls++; return undefined } })
    }
    const restore = () => {
      if (dispatch) Object.defineProperty(Object.prototype, "dispatch", dispatch)
      else Reflect.deleteProperty(Object.prototype, "dispatch")
      if (deriving) Object.defineProperty(Object.prototype, "deriving", deriving)
      else Reflect.deleteProperty(Object.prototype, "deriving")
    }
    const claim = vi.spyOn(factory, "claimFunctionConversationSharedNativeObserverSeal")
      .mockImplementation((...args) => {
        checked = true
        patch()
        try { return originalClaim(...args) }
        finally { restore() }
      })
    try { factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation) }
    finally { restore(); claim.mockRestore() }
    let child: object | undefined
    try {
      patch()
      child = f.source.derive({ tags: ["actual-private-initial-fields"] })
    } finally { restore() }
    expect(checked).toBe(true)
    expect(calls).toBe(0)
    expect(child).toBeDefined()
    expect(() => f.source.assertStructure()).not.toThrow()
    expect(() => readFunctionConversationNativeSourceObserverInstallation(f.installation,
      f.graph)).not.toThrow()
    expect(f.model.requests).toEqual([])
  })

  it("gives each actual derived graph its own installation and keeps the sealed base usable", async () => {
    const f = fixture()
    factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation)
    const child = f.source.derive({ tags: ["actual-derived-observer"] }) as typeof f.agent
    const childOrigin = factory.readFunctionConversationNativeAgentDerivation(child)!
    const installation = installFunctionConversationNativeSourceObserver(child.graph)
    expect(installation).not.toBe(f.installation)
    expect(childOrigin.graph).not.toBe(f.graph)
    factory.sealFunctionConversationSharedNativeAgentDispatch(child, installation)
    expect(() => childOrigin.assertStructure()).not.toThrow()
    expect(() => f.source.assertStructure()).not.toThrow()
    await f.run(randomUUID())
    expect(f.model.requests).toHaveLength(2)
    expect(f.effect).toHaveBeenCalledTimes(1)
  })

  it("rejects a polluted inherited method before constructing a derived graph", async () => {
    const f = fixture()
    const origin = readFunctionConversationNativeSourceObserverOrigin(f.installation, f.graph)
    factory.sealFunctionConversationSharedNativeAgentDispatch(f.agent, f.installation)
    const method = origin.stream, owner = method.path[method.path.length - 1]
    const descriptor = Object.getOwnPropertyDescriptor(owner, "stream")!
    const fake = vi.fn()
    let rejected = false
    try {
      Object.defineProperty(owner, "stream", { ...descriptor, value: fake })
      try { f.source.derive({ tags: ["actual-polluted-observer"] }) }
      catch { rejected = true }
    } finally { Object.defineProperty(owner, "stream", descriptor) }
    expect(rejected).toBe(true)
    expect(fake).not.toHaveBeenCalled()
    expect(f.model.requests).toEqual([])
    expect(() => f.source.assertStructure()).not.toThrow()
    await f.run(randomUUID())
    expect(f.model.requests).toHaveLength(2)
    expect(f.effect).toHaveBeenCalledTimes(1)
  })

  it("leaves Main observer flags and the original no-installation Shared dispatch unchanged", () => {
    const f = fixture(), second = factory.createFunctionConversationNativeAgent({ model: f.model })
    factory.sealFunctionConversationSharedNativeAgentDispatch(second)
    const graph = second.graph
    for (const key of ["invoke", "stream", "_streamIterator"])
      expect(Object.getOwnPropertyDescriptor(graph, key)?.configurable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(f.graph, "stream")?.configurable).toBe(true)
    expect(Object.getOwnPropertyDescriptor(f.graph, "_streamIterator")?.writable).toBe(true)
    const clone = Object.freeze({ ...f.installation }) as FunctionConversationNativeSourceObserverInstallation
    expect(() => readFunctionConversationNativeSourceObserverInstallation(clone, f.graph)).toThrow()
    expect(() => readFunctionConversationNativeSourceObserverInstallation(f.installation,
      f.graph)).not.toThrow()
    expect(f.model.requests).toEqual([])
  })
})
