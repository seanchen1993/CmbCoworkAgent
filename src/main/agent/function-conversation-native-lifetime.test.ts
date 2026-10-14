import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { createFunctionConversationNativeSourceLifetime,
  createFunctionConversationNativeSourceLifetimeFromInstallation,
  installFunctionConversationNativeSourceObserver,
  readFunctionConversationNativeSourceObserverInstallation }
  from "./function-conversation-native-lifetime"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly toolName: string, private readonly callId: string) { super({}) }
  _llmType() { return "actual-native-mode-boundary" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = new AIMessage({ id: randomUUID(), content: "original actual model output",
      ...(this.requests.length === 1 ? { tool_calls: [
        { name: this.toolName, id: this.callId, args: {} }
      ] } : {}) })
    return { generations: [{ message, text: "original actual model output" }] }
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-mode-boundary-"))
  const saver = new SqlJsSaver(join(directory, "actual-graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const effect = vi.fn(() => "original actual tool output")
  const actualTool = tool(effect, { name: "actual_native_mode_tool", schema: z.object({}) })
  const provider = new LocalModel(actualTool.name, randomUUID())
  const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: saver })
  const controller = new AbortController()
  const config: RunnableConfig = { signal: controller.signal,
    configurable: { thread_id: randomUUID(), checkpoint_ns: "" } }
  const lifetime = createFunctionConversationNativeSourceLifetime(agent.graph,
    () => controller.signal.throwIfAborted())
  cleanups.push(async () => {
    lifetime.finishOpening()
    await lifetime.drain()
    await lifetime.whenSettled()
    await saver.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { agent, provider, effect, saver, config, lifetime,
    input: { messages: [new HumanMessage({ id: randomUUID(), content: "actual user input" })] } }
}

/** Actual iterator/source only; this suite does not claim a Keeper/Store authority factory. */
describe("native source mode admission before the original generator", () => {
  const unsupported = ["tools", "custom", "debug", "tasks", "checkpoints"] as const
  it.each(unsupported)("rejects explicit %s before model/tool/checkpoint work", async mode => {
    const f = fixture()
    await expect(f.lifetime.run(() => f.agent.stream(f.input, {
      ...f.config, streamMode: mode
    }))).rejects.toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
    f.lifetime.finishOpening()
    await f.lifetime.whenSettled()
    expect(f.provider.requests).toEqual([])
    expect(f.effect).not.toHaveBeenCalled()
    expect(await f.saver.getTuple(f.config)).toBeUndefined()
  })

  it.each(unsupported)("rejects actual default %s without starting the original generator", async mode => {
    const f = fixture()
    f.agent.graph.streamMode = [mode]
    await expect(f.lifetime.run(() => f.agent.stream(f.input, f.config)))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
    f.lifetime.finishOpening()
    await f.lifetime.whenSettled()
    expect(f.provider.requests).toEqual([])
    expect(f.effect).not.toHaveBeenCalled()
    expect(await f.saver.getTuple(f.config)).toBeUndefined()
  })

  it.each(["messages", "values", "updates"] as const)(
    "keeps the actual supported %s source and exact committed checkpoint", async mode => {
      const f = fixture()
      const stream = await f.lifetime.run(() => f.agent.stream(f.input, {
        ...f.config, streamMode: mode
      }))
      f.lifetime.finishOpening()
      const frames: unknown[] = []
      for await (const frame of stream) frames.push(frame)
      await f.lifetime.whenSettled()
      expect(frames.length).toBeGreaterThan(0)
      expect(f.provider.requests).toHaveLength(2)
      expect(f.effect).toHaveBeenCalledTimes(1)
      const tuple = await f.saver.getTuple(f.config)
      if (!tuple) throw Error("ACTUAL_NATIVE_MODE_CHECKPOINT_REQUIRED")
      const exact = await f.saver.getTuple(tuple.config)
      expect(exact?.checkpoint.id).toBe(tuple.checkpoint.id)
      const messages: unknown = exact?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_NATIVE_MODE_MESSAGES_REQUIRED")
      expect(messages.filter(message => message instanceof ToolMessage)).toHaveLength(1)
    })

  it("keeps the installed graph's ordinary tools mode outside any native source", async () => {
    const f = fixture()
    f.lifetime.finishOpening()
    const frames: unknown[] = []
    for await (const frame of await f.agent.stream(f.input, {
      ...f.config, streamMode: "tools"
    })) frames.push(frame)
    expect(frames.length).toBeGreaterThan(0)
    expect(f.effect).toHaveBeenCalledTimes(1)
    expect(f.provider.requests).toHaveLength(2)
    expect(await f.saver.getTuple(f.config)).toBeDefined()
  })
})

describe("original native observer installation without per-call mutation", () => {
  it("reuses both actual observed methods for two independent calls and exact checkpoints", async () => {
    const f = fixture(), graph = f.agent.graph
    const installation = installFunctionConversationNativeSourceObserver(graph)
    const stream = Object.getOwnPropertyDescriptor(graph, "stream")
    const iterator = Object.getOwnPropertyDescriptor(graph, "_streamIterator")
    const firstGuard = vi.fn(), secondGuard = vi.fn()
    const first = createFunctionConversationNativeSourceLifetimeFromInstallation(installation, firstGuard)
    const second = createFunctionConversationNativeSourceLifetimeFromInstallation(installation, secondGuard)
    cleanups.push(async () => {
      first.finishOpening(); second.finishOpening()
      const results = await Promise.allSettled([first.drain(), second.drain()])
      await Promise.allSettled([first.whenSettled(), second.whenSettled()])
      const failed = results.find(result => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })
    expect(installFunctionConversationNativeSourceObserver(graph)).toBe(installation)
    expect(readFunctionConversationNativeSourceObserverInstallation(installation, graph).graph).toBe(graph)
    const configs = [f.config, { ...f.config,
      configurable: { thread_id: randomUUID(), checkpoint_ns: "" } }]
    for (const [index, source] of [first, second].entries()) {
      const actual = await source.run(() => f.agent.stream({
        messages: [new HumanMessage({ id: randomUUID(), content: `actual observer call ${index}` })]
      }, { ...configs[index], streamMode: "values" }))
      source.finishOpening()
      const frames: unknown[] = []
      for await (const frame of actual) frames.push(frame)
      await source.whenSettled()
      expect(frames.length).toBeGreaterThan(0)
      const tuple = await f.saver.getTuple(configs[index])
      expect(tuple).toBeDefined()
      if (!tuple) throw Error("ACTUAL_OBSERVER_CHECKPOINT_REQUIRED")
      const exact = await f.saver.getTuple(tuple.config)
      expect(exact?.checkpoint.id).toBe(tuple.checkpoint.id)
      expect(Array.isArray(exact?.checkpoint.channel_values.messages)).toBe(true)
    }
    expect(firstGuard).toHaveBeenCalled()
    expect(secondGuard).toHaveBeenCalled()
    expect(f.provider.requests).toHaveLength(3)
    expect(f.effect).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(graph, "stream")).toEqual(stream)
    expect(Object.getOwnPropertyDescriptor(graph, "_streamIterator")).toEqual(iterator)
    expect(stream?.writable).toBe(true)
    expect(stream?.configurable).toBe(true)
    expect(iterator?.writable).toBe(true)
    expect(iterator?.configurable).toBe(true)
  })

  it("rejects cloned and Proxy tokens or graphs without invoking a caller or creating a Source", () => {
    const f = fixture(), graph = f.agent.graph
    const installation = installFunctionConversationNativeSourceObserver(graph)
    const guard = vi.fn(), trap = vi.fn()
    const cloned = { ...installation }
    const proxy = new Proxy(installation, { get: trap, getPrototypeOf: trap })
    expect(() => createFunctionConversationNativeSourceLifetimeFromInstallation(cloned, guard))
      .toThrow("STREAM_UNAVAILABLE")
    expect(() => createFunctionConversationNativeSourceLifetimeFromInstallation(proxy, guard))
      .toThrow("STREAM_UNAVAILABLE")
    expect(() => readFunctionConversationNativeSourceObserverInstallation(installation,
      new Proxy(graph, { get: trap, getPrototypeOf: trap }))).toThrow("STREAM_UNAVAILABLE")
    expect(guard).not.toHaveBeenCalled()
    expect(trap).not.toHaveBeenCalled()
    expect(f.provider.requests).toEqual([])
    expect(f.effect).not.toHaveBeenCalled()
  })

  it.each((["stream", "_streamIterator"] as const).flatMap(key =>
    (["getter", "replacement"] as const).map(kind => ({ key, kind }))))(
    "refuses a late $key $kind and keeps the original installation failed", attack => {
      const f = fixture(), graph = f.agent.graph
      const installation = installFunctionConversationNativeSourceObserver(graph)
      const descriptor = Object.getOwnPropertyDescriptor(graph, attack.key)
      if (!descriptor) throw Error("ACTUAL_OBSERVER_METHOD_REQUIRED")
      const guard = vi.fn(), getter = vi.fn()
      try {
        Object.defineProperty(graph, attack.key, attack.kind === "getter"
          ? { configurable: true, get: getter }
          : { ...descriptor, value: getter })
        expect(() => createFunctionConversationNativeSourceLifetimeFromInstallation(installation, guard))
          .toThrow("STREAM_UNAVAILABLE")
      } finally { Object.defineProperty(graph, attack.key, descriptor) }
      expect(() => installFunctionConversationNativeSourceObserver(graph)).toThrow("STREAM_UNAVAILABLE")
      expect(() => readFunctionConversationNativeSourceObserverInstallation(installation, graph))
        .toThrow("STREAM_UNAVAILABLE")
      expect(guard).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
      expect(f.provider.requests).toEqual([])
      expect(f.effect).not.toHaveBeenCalled()
    })

  it("requires the Main's original observed flags rather than accepting an unknown seal", () => {
    const f = fixture(), graph = f.agent.graph
    const installation = installFunctionConversationNativeSourceObserver(graph)
    const descriptor = Object.getOwnPropertyDescriptor(graph, "stream")
    if (!descriptor) throw Error("ACTUAL_OBSERVER_FLAGS_REQUIRED")
    Object.defineProperty(graph, "stream", { ...descriptor, writable: false, configurable: false })
    expect(() => createFunctionConversationNativeSourceLifetimeFromInstallation(installation, vi.fn()))
      .toThrow("STREAM_UNAVAILABLE")
    expect(f.provider.requests).toEqual([])
  })
})
