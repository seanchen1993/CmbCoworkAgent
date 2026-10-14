import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { mergeConfigs, RunnableLambda, type RunnableConfig } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FUNCTION_STREAM_TERMINAL } from "../mods/v2/host-stream-lifetime"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot } from
  "./function-conversation-native-node"
import type { FunctionConversationNativeNodeSlotView } from "./function-conversation-native-node"
import { createFunctionConversationNativeSourceLifetime } from
  "./function-conversation-native-lifetime"
import { wrapFunctionConversationNativeInvocation,
  type FunctionConversationNativeInvocationHost } from "./function-conversation-native-invocation"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

/** Actual native graph/model/saver. Host callbacks below test the wrapper, not Keeper authority. */
class LocalModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  constructor(private readonly produce: (
    messages: BaseMessage[], call: number
  ) => AIMessage | Promise<AIMessage>) { super({}) }
  _llmType(): string { return "native-invocation-local" }
  bindTools(): this { return this }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = await this.produce(messages, this.requests.length)
    return { generations: [{ message, text: typeof message.content === "string"
      ? message.content : "actual native blocks" }] }
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-invocation-"))
  const saver = new SqlJsSaver(join(directory, "graph.sqlite"), undefined,
    { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" } }
  const controller = new AbortController()
  const runtime = { signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted() } }
  cleanups.push(async () => {
    await saver.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { saver, config, runtime }
}

function input(content = "actual input") {
  return { messages: [new HumanMessage({ id: randomUUID(), content })] }
}

/** Observe the real graph iterator's delivery, without replacing its computation or lifetime. */
function observeActualNext(agent: ReturnType<typeof createAgent>,
  observe: (value: unknown) => void): void {
  const original = agent.stream
  Object.defineProperty(agent, "stream", { configurable: true,
    value: async (...args: Parameters<typeof agent.stream>) => {
      const stream = await Reflect.apply(original, agent, args)
      const iterator = stream[Symbol.asyncIterator]()
      return {
        [Symbol.asyncIterator]() { return this },
        async next() {
          const item = await iterator.next()
          if (!item.done) observe(item.value)
          return item
        },
        return: () => iterator.return ? iterator.return() : Promise.resolve({ done: true, value: undefined })
      }
    } })
}

function hostFor(agent: ReturnType<typeof createAgent>,
  beforeFinalize?: (view: FunctionConversationNativeNodeSlotView) => void | Promise<void>) {
  const safe = new Set<BaseMessage>()
  const routed: Array<{ mode: string; value: unknown }> = []
  const controls = ["model_request", "tools"].filter(node => agent.graph.nodes[node]).map(node =>
    installFunctionConversationNativeNode({ graph: agent.graph,
      node: node as "model_request" | "tools", assertCurrent: () => undefined,
      async finalize(slot) {
        const view = readFunctionConversationNativeNodeSlot(slot), message = view.message
        if (beforeFinalize) await beforeFinalize(view)
        const result = AIMessage.isInstance(message)
          ? new AIMessage({ id: message.id, content: "safe completed assistant",
            tool_calls: message.tool_calls, name: message.name })
          : ToolMessage.isInstance(message)
            ? new ToolMessage({ id: randomUUID(), content: "safe completed tool",
              tool_call_id: message.tool_call_id, status: message.status, name: message.name })
            : undefined
        if (!result) throw Error("ACTUAL_NATIVE_COMPLETION_REQUIRED")
        safe.add(result)
        return result
      } }))
  cleanups.push(async () => {
    for (const control of controls) control.close()
    await Promise.all(controls.map(control => control.whenDrained()))
  })
  const host: FunctionConversationNativeInvocationHost = {
    configure: config => config,
    message(value) {
      if (!Array.isArray(value)) throw Error("ACTUAL_MESSAGE_TUPLE_REQUIRED")
      return safe.has(value[0]) ? value : undefined
    },
    validate(mode, value) { routed.push({ mode, value }) },
    async whenDrained() { await Promise.all(controls.map(control => control.whenDrained())) }
  }
  return { host, routed, safe }
}

describe("actual native invocation and source terminal", () => {
  it.each(["values", "updates"] as const)(
    "services a timer after actual %s graph delivery before routing", async mode => {
      const f = fixture(), provider = new LocalModel(() => new AIMessage("actual response"))
      const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
      let scheduled = false, serviced = false
      observeActualNext(agent, () => {
        if (!scheduled) { scheduled = true; setTimeout(() => { serviced = true }, 0) }
      })
      const validate = h.host.validate
      h.host.validate = (selected, payload) => {
        expect(serviced).toBe(true)
        validate(selected, payload)
      }
      const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
      const frames: unknown[] = []
      for await (const frame of await wrapped.stream(input(), { ...f.config, streamMode: mode }))
        frames.push(frame)
      expect(frames.length).toBeGreaterThan(0)
      expect(provider.requests).toHaveLength(1)
    })

  it.each(["values", "updates"] as const)(
    "rechecks cancellation and revocation across actual %s post-computation scheduling", async mode => {
      for (const change of ["cancel", "revoke"] as const) {
        const f = fixture(), cut = new AbortController()
        let revoked = false, scheduled = false
        const reason = Error(`ACTUAL_POST_NEXT_${change}`)
        const runtime = { signal: cut.signal, assertCurrent() {
          cut.signal.throwIfAborted()
          if (revoked) throw reason
        } }
        const provider = new LocalModel(() => new AIMessage("actual response"))
        const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
        observeActualNext(agent, () => {
          if (!scheduled) {
            scheduled = true
            setTimeout(() => { if (change === "cancel") cut.abort(reason); else revoked = true }, 0)
          }
        })
        const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, runtime)
        const stream = await wrapped.stream(input(), { ...f.config, streamMode: mode })
        try {
          await expect(stream.next()).rejects.toThrow(reason.message)
          expect(scheduled).toBe(true)
          expect(h.routed).toHaveLength(0)
        } finally { await stream.return().catch(() => undefined) }
      }
    })

  it("captures real message tokens before the next timer and retains them when the provider fails", async () => {
    const f = fixture(), release = Promise.withResolvers<void>()
    class TokenModel extends LocalModel {
      override async *_streamResponseChunks(_messages: BaseMessage[], _options: this["ParsedCallOptions"],
        manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
        for (const text of ["first token", "second token"]) {
          const chunk = new ChatGenerationChunk({ text,
            message: new AIMessageChunk({ id: "actual-tokens", content: text }) })
          await manager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })
          yield chunk
        }
        await release.promise
        throw Error("ACTUAL_TOKEN_PROVIDER_FAILED")
      }
    }
    const provider = new TokenModel(() => { throw Error("ACTUAL_STREAM_REQUIRED") })
    const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
    let delivered = 0, timerObserved = false
    observeActualNext(agent, () => {
      if (!delivered++) setTimeout(() => { timerObserved = true }, 0)
    })
    const captured: string[] = []
    h.host.message = value => {
      if (!Array.isArray(value) || !AIMessageChunk.isInstance(value[0]))
        throw Error("ACTUAL_TOKEN_REQUIRED")
      if (!captured.length) expect(timerObserved).toBe(false)
      captured.push(String(value[0].content))
      return value
    }
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: "messages" })
    const published: string[] = []
    try {
      await expect((async () => {
        for await (const frame of stream) {
          if (!Array.isArray(frame)) throw Error("ACTUAL_TOKEN_FRAME_REQUIRED")
          published.push(String(frame[0].content))
          if (published.length === 2) release.resolve()
        }
      })()).rejects.toThrow("ACTUAL_TOKEN_PROVIDER_FAILED")
      expect(captured).toEqual(["first token", "second token"])
      expect(published).toEqual(captured)
    } finally { release.resolve(); await stream.return().catch(() => undefined) }
  })

  it("does not prevalidate another graph frame while its consumer is paused", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw body" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: ["values", "updates"] })
    try {
      const first = await stream.next()
      expect(first.done).toBe(false)
      const checks = h.routed.length
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(h.routed).toHaveLength(checks)
      const output = [first.value]
      for await (const frame of stream) output.push(frame)
      expect(output.length).toBeGreaterThanOrEqual(3)
      expect(output.some(frame => Array.isArray(frame) && frame[0] === "updates")).toBe(true)
      expect(provider.requests).toHaveLength(1)
      expect(h.safe.size).toBe(1)
    } finally { await stream.return() }
  })

  it("cancels and drains a paused consumer without requesting another frame", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw body" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: ["values", "updates"] })
    expect((await stream.next()).done).toBe(false)
    const checks = h.routed.length
    await stream.return()
    await h.host.whenDrained()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.routed).toHaveLength(checks)
  })

  it("surfaces a producer failure after a paused consumer resumes", async () => {
    const released = Promise.withResolvers<void>()
    const f = fixture(), provider = new LocalModel(async () => {
      await released.promise
      throw Error("ACTUAL_BACKPRESSURE_FAILURE")
    })
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: ["values", "updates"] })
    try {
      expect((await stream.next()).done).toBe(false)
      const checks = h.routed.length
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(h.routed).toHaveLength(checks)
      released.resolve()
      await expect((async () => { for await (const frame of stream) { expect(frame).toBeDefined() } })())
        .rejects.toThrow("ACTUAL_BACKPRESSURE_FAILURE")
      await h.host.whenDrained()
    } finally {
      released.resolve()
      await expect(stream.return()).resolves.toMatchObject({ done: true })
    }
  })

  it("lets the event loop service pending input between buffered native state frames", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw body" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    let pendingInputServiced = false, frames = 0
    let scheduled: NodeJS.Immediate | undefined
    try {
      for await (const frame of await wrapped.stream(input(), { ...f.config,
        streamMode: ["values", "updates"] })) {
        expect(frame).toBeDefined()
        frames++
        if (frames === 1) scheduled = setImmediate(() => { pendingInputServiced = true })
        if (frames >= 3) expect(pendingInputServiced).toBe(true)
      }
      expect(frames).toBeGreaterThanOrEqual(3)
    } finally { if (scheduled) clearImmediate(scheduled) }
  })

  it("publishes the first routed frame before a timer can retire its source", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), validate = h.host.validate
    let retired = false, scheduled: NodeJS.Timeout | undefined
    h.host.validate = (mode, value) => {
      validate(mode, value)
      if (!scheduled) scheduled = setTimeout(() => { retired = true }, 0)
    }
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: "messages" })
    try {
      const frame = await stream.next()
      expect(frame.done).toBe(false)
      expect(retired).toBe(false)
      expect(h.routed).toHaveLength(1)
      expect(Array.isArray(frame.value) && h.safe.has(frame.value[0])).toBe(true)
      const terminal = await stream.next()
      expect(terminal.done).toBe(true)
    } finally { if (scheduled) clearTimeout(scheduled) }
  })

  it("publishes each routed model/tool occurrence once and in original order", async () => {
    const f = fixture()
    let effects = 0, accepted = 0
    const actualTool = tool(() => { effects++; return "raw tool" }, {
      name: "actual_ordered_tool", description: "actual ordered tool", schema: z.object({}) })
    const provider = new LocalModel((_messages, call) => call === 1
      ? new AIMessage({ id: randomUUID(), content: "request", tool_calls: [{
        id: "ordered-call", name: "actual_ordered_tool", args: {}, type: "tool_call" as const }] })
      : new AIMessage({ id: randomUUID(), content: "done" }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const h = hostFor(agent), message = h.host.message
    h.host.message = value => {
      const result = message(value)
      if (result !== undefined) accepted++
      return result
    }
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const frames: BaseMessage[] = []
    for await (const frame of await wrapped.stream(input(), { ...f.config, streamMode: "messages" })) {
      if (!Array.isArray(frame) || !(frame[0] instanceof BaseMessage))
        throw Error("ACTUAL_MESSAGE_FRAME_REQUIRED")
      frames.push(frame[0])
    }
    expect(frames).toEqual([...h.safe])
    expect(frames.map(message => message.getType())).toEqual(["ai", "tool", "ai"])
    expect(new Set(frames).size).toBe(3)
    expect(accepted).toBe(3)
    expect(effects).toBe(1)
    expect(provider.requests).toHaveLength(2)
  })

  it.each([
    { multiple: false, subgraphs: false }, { multiple: true, subgraphs: false },
    { multiple: false, subgraphs: true }, { multiple: true, subgraphs: true }
  ])("routes actual messages output with multiple=$multiple subgraphs=$subgraphs", async shape => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw completed assistant" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, subgraphs: shape.subgraphs,
      streamMode: shape.multiple ? ["messages"] : "messages" })
    const frames: unknown[] = []
    for await (const frame of stream) frames.push(frame)
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    if (!Array.isArray(frame)) throw Error("ACTUAL_MESSAGE_FRAME_REQUIRED")
    const payload = shape.multiple ? frame[shape.subgraphs ? 2 : 1]
      : shape.subgraphs ? frame[1] : frame
    if (!Array.isArray(payload) || !BaseMessage.isInstance(payload[0]))
      throw Error("ACTUAL_SAFE_NATIVE_TUPLE_REQUIRED")
    expect(h.safe.has(payload[0])).toBe(true)
    expect(payload[0].content).toBe("safe completed assistant")
    if (shape.multiple) expect(frame[shape.subgraphs ? 1 : 0]).toBe("messages")
    if (shape.subgraphs) {
      const metadata: unknown = payload[1]
      if (!metadata || typeof metadata !== "object") throw Error("ACTUAL_TASK_METADATA_REQUIRED")
      const namespace: unknown = Reflect.get(metadata, "langgraph_checkpoint_ns")
      if (typeof namespace !== "string") throw Error("ACTUAL_TASK_NAMESPACE_REQUIRED")
      expect(frame[0]).toEqual(namespace.split("|"))
      expect(namespace).toMatch(/^model_request:/)
    }
    expect(h.routed).toHaveLength(1)
    expect(provider.requests).toHaveLength(1)
    const exact = await f.saver.getTuple(f.config)
    if (!exact) throw Error("ACTUAL_CHECKPOINT_REQUIRED")
    const saved = exact.checkpoint.channel_values.messages
    if (!Array.isArray(saved) || !BaseMessage.isInstance(saved.at(-1)))
      throw Error("ACTUAL_NATIVE_CHECKPOINT_MESSAGES_REQUIRED")
    expect(saved.at(-1).content).toBe("safe completed assistant")
  })

  it("preserves actual values/updates/other state and invokes the real private receiver", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw body" }))
    const agent = createAgent({ model: provider, name: "actual-agent", checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const frames: unknown[] = []
    for await (const frame of await wrapped.stream(input(), { ...f.config,
      streamMode: ["values", "updates"] })) frames.push(frame)
    expect(h.routed.some(frame => frame.mode === "values")).toBe(true)
    expect(h.routed.some(frame => frame.mode === "updates")).toBe(true)
    expect(h.routed).toHaveLength(frames.length)
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index]
      if (!Array.isArray(frame)) throw Error("ACTUAL_MULTIPLE_MODE_FRAME_REQUIRED")
      expect(h.routed[index]).toEqual({ mode: frame[0], value: frame[1] })
    }
    for (const entry of h.routed) {
      if (entry.mode !== "values" || !entry.value || typeof entry.value !== "object") continue
      const messages = Reflect.get(entry.value, "messages") as unknown
      if (Array.isArray(messages)) expect(messages.every(BaseMessage.isInstance)).toBe(true)
    }
    expect(wrapped.graph).toBe(agent.graph)
    // ReactAgent's declaration currently says never, while its native method delegates to
    // this exact compiled graph. Keep exercising the proxy's bound original receiver.
    const getState = wrapped.getState as typeof wrapped.graph.getState
    const state = await getState(f.config)
    expect(state.values.messages.at(-1)?.name).toBe("actual-agent")
    expect(state.values.messages.at(-1)?.content).toBe("safe completed assistant")
  })

  it("publishes an actual tool only after its finalizer and deduplicates its natural safe frame", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let effects = 0
    const actualTool = tool(() => { effects++; return "raw tool body" }, {
      name: "actual_completed_tool", description: "actual completed tool", schema: z.object({}) })
    const provider = new LocalModel((_messages, call) => new AIMessage({ id: "reused-provider-id",
      content: call === 1 ? "request" : "finished", ...(call === 1 ? {
        tool_calls: [{ id: "actual-call", name: "actual_completed_tool", args: {},
          type: "tool_call" as const }] } : {}) }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const h = hostFor(agent, async view => {
      if (view.node === "tools") { entered.resolve(); await gate.promise }
    })
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const frames: BaseMessage[] = []
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: "messages" })
    const reading = (async () => {
      for await (const frame of stream) {
        if (!Array.isArray(frame) || !BaseMessage.isInstance(frame[0]))
          throw Error("ACTUAL_NATIVE_MESSAGE_REQUIRED")
        frames.push(frame[0])
      }
    })()
    void reading.catch(() => undefined)
    try {
      await entered.promise
      expect(effects).toBe(1)
      expect(frames.filter(ToolMessage.isInstance)).toEqual([])
      gate.resolve()
      await reading
      expect(frames.filter(ToolMessage.isInstance)).toHaveLength(1)
      expect(frames.filter(AIMessage.isInstance)).toHaveLength(2)
      expect(frames.every(message => h.safe.has(message))).toBe(true)
      expect(new Set(frames).size).toBe(3)
      expect(provider.requests).toHaveLength(2)
      const exact = await f.saver.getTuple(f.config)
      const messages: unknown = exact?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CHECKPOINT_MESSAGES_REQUIRED")
      const tools = messages.filter(ToolMessage.isInstance)
      expect(tools).toHaveLength(1)
      expect(tools[0].content).toBe("safe completed tool")
    } finally { gate.resolve(); await reading.catch(() => undefined) }
  })

  it("cannot mint completion from equal clones, historical objects, SDK marks or the wrong node", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: "same-id", content: "raw completed" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
    const source = createFunctionConversationNativeSourceLifetime(agent.graph, f.runtime.assertCurrent)
    const historical = new AIMessage({ id: "same-id", content: "safe completed assistant" })
    const stream = await source.run(() => agent.stream({ messages: [historical,
      new HumanMessage({ id: randomUUID(), content: "actual next input" })] }, {
      ...f.config, streamMode: "messages" }))
    source.finishOpening()
    for await (const frame of stream) expect(frame).not.toBeUndefined()
    await source.whenSettled()
    await h.host.whenDrained()
    const safe = [...h.safe][0]
    if (!safe) throw Error("ACTUAL_SAFE_COMPLETION_REQUIRED")
    const clone = new AIMessage({ id: safe.id, content: safe.content })
    const markedNote = new HumanMessage({ id: safe.id, content: safe.content,
      additional_kwargs: { function_row: { uuid: safe.id } } })
    expect(source.completions({ model_request: { messages: [clone, historical, markedNote] } }))
      .toEqual([])
    expect(source.completions({ tools: { messages: [safe] } })).toEqual([])
    const completed = source.completions({ model_request: { messages: [safe] } })
    expect(completed).toHaveLength(1)
    expect(completed[0].message).toBe(safe)
    expect(source.acceptMessage([safe, completed[0].metadata])).toBe(true)
    expect(source.completions({ model_request: { messages: [safe] } })).toEqual([])
  })

  it("preserves both native model nostream tags while keeping the protected checkpoint", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw private completion" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    for (const tag of ["nostream", "langsmith:nostream"]) {
      const config = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" } }
      const options: RunnableConfig & { streamMode: "messages" } = {
        ...config, streamMode: "messages", tags: [tag] }
      const frames: unknown[] = []
      for await (const frame of await wrapped.stream(input(), options)) frames.push(frame)
      expect(frames).toEqual([])
      const actual = await f.saver.getTuple(config)
      const messages: unknown = actual?.checkpoint.channel_values.messages
      if (!Array.isArray(messages) || !AIMessage.isInstance(messages.at(-1)))
        throw Error("ACTUAL_PROTECTED_CHECKPOINT_REQUIRED")
      expect(messages.at(-1).content).toBe("safe completed assistant")
    }
    expect(provider.requests).toHaveLength(2)
    expect(h.safe.size).toBe(2)
  })

  it("keeps same-ID completed objects private to their two actual source invocations", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let arrivals = 0
    const provider = new LocalModel(async () => {
      if (++arrivals === 2) entered.resolve()
      await gate.promise
      return new AIMessage({ id: "same-provider-id", content: "raw shared provider id" })
    })
    const agent = createAgent({ model: provider, checkpointer: f.saver }), h = hostFor(agent)
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const consume = async (config: RunnableConfig) => {
      const values: BaseMessage[] = []
      for await (const frame of await wrapped.stream(input(), { ...config, streamMode: "messages" })) {
        if (!Array.isArray(frame) || !BaseMessage.isInstance(frame[0]))
          throw Error("ACTUAL_SAFE_FRAME_REQUIRED")
        values.push(frame[0])
      }
      return values
    }
    const first = consume(f.config), second = consume({ configurable: {
      thread_id: randomUUID(), checkpoint_ns: "" } })
    void first.catch(() => undefined); void second.catch(() => undefined)
    try {
      await entered.promise
      gate.resolve()
      const [a, b] = await Promise.all([first, second])
      expect(a).toHaveLength(1); expect(b).toHaveLength(1)
      expect(a[0].id).toBe(b[0].id)
      expect(Object.is(a[0], b[0])).toBe(false)
      expect(h.safe.has(a[0])).toBe(true); expect(h.safe.has(b[0])).toBe(true)
      expect(provider.requests).toHaveLength(2)
    } finally { gate.resolve(); await Promise.allSettled([first, second]) }
  })

  it("does not manufacture completion when the actual original writer fails", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "raw completed" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    // Deliberate failure in an actual channel-writer sequence, installed before NativeNode seals it.
    agent.graph.nodes.model_request.writers.push(RunnableLambda.from(() => {
      throw Error("ACTUAL_ORIGINAL_WRITER_FAILED")
    }))
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const frames: unknown[] = []
    const reading = (async () => {
      for await (const frame of await wrapped.stream(input(), {
        ...f.config, streamMode: "messages" })) frames.push(frame)
    })()
    await expect(reading).rejects.toThrow("ACTUAL_ORIGINAL_WRITER_FAILED")
    expect(h.safe.size).toBe(1)
    expect(frames).toEqual([])
    expect(provider.requests).toHaveLength(1)
  })

  it("cannot publish a late completed tool after cancellation closes its original source", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let effects = 0
    const actualTool = tool(() => { effects++; return "raw held completion" }, {
      name: "actual_late_tool", description: "actual late tool", schema: z.object({}) })
    const provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "request",
      tool_calls: [{ id: "held-call", name: "actual_late_tool", args: {},
        type: "tool_call" as const }] }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const h = hostFor(agent, async view => {
      if (view.node === "tools") { entered.resolve(); await gate.promise }
    })
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const frames: unknown[] = []
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: "messages" })
    const reading = (async () => { for await (const frame of stream) frames.push(frame) })()
    void reading.catch(() => undefined)
    try {
      await entered.promise
      const closing = stream.cancel("actual source closed")
      void closing.catch(() => undefined)
      gate.resolve()
      await closing.catch(() => undefined)
      await reading.catch(() => undefined)
      expect(frames.some(frame => Array.isArray(frame) && ToolMessage.isInstance(frame[0])))
        .toBe(false)
      expect(effects).toBe(1)
      expect(provider.requests).toHaveLength(1)
    } finally { gate.resolve(); await reading.catch(() => undefined) }
  })

  it("keeps original callbacks/default initialization and validates invoke without serializing state", async () => {
    const f = fixture(), provider = new LocalModel(() =>
      new AIMessage({ id: randomUUID(), content: "original provider" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent)
    const calls: string[] = []
    class Callback extends BaseCallbackHandler {
      name = "actual-callback"
      constructor(private readonly marker: string) { super() }
      handleChatModelStart(): void { calls.push(this.marker) }
    }
    h.host.configure = config => mergeConfigs(
      config, { callbacks: [new Callback("private")] }
    ) as typeof config
    const wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const result = await wrapped.invoke(input(), { ...f.config, callbacks: [new Callback("original")] })
    const last = result.messages.at(-1)
    if (!last) throw Error("ACTUAL_SAFE_INVOKE_REQUIRED")
    expect(h.safe.has(last)).toBe(true)
    expect(result.messages[0]).toBeInstanceOf(HumanMessage)
    expect(calls).toEqual(expect.arrayContaining(["original", "private"]))
    expect(h.routed.at(-1)?.mode).toBe("values")
    expect(h.routed.at(-1)?.value).toBe(result)
    expect(provider.requests).toHaveLength(1)
  })

  it("rejects unsupported events/encoded output before any actual model or checkpoint work", async () => {
    const f = fixture(), provider = new LocalModel(() => new AIMessage("never run"))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    expect(() => wrapped.streamEvents(input(), { ...f.config, version: "v2" }))
      .toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
    const unsupported = { ...f.config, encoding: "unsupported-native-encoding" } as unknown as
      NonNullable<Parameters<typeof wrapped.stream>[1]>
    await expect(wrapped.stream(input(), unsupported))
      .rejects.toThrow("MODS_CONVERSATION_NATIVE_STREAM_UNAVAILABLE")
    expect(provider.requests).toEqual([])
    expect(await f.saver.getTuple(f.config)).toBeUndefined()
  })

  it("waits for an ignored-cancel actual tool and original source finally before cancel settles", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let effects = 0, finalized = false, cancelled = false
    const actualTool = tool(async () => {
      effects++
      entered.resolve()
      try { await gate.promise; return "actual tool output" }
      finally { finalized = true }
    }, { name: "actual_held_tool", description: "actual held tool", schema: z.object({}) })
    const provider = new LocalModel((_messages, call) => new AIMessage({ id: randomUUID(),
      content: call === 1 ? "calling actual tool" : "finished",
      ...(call === 1 ? { tool_calls: [{ id: randomUUID(), name: "actual_held_tool", args: {},
        type: "tool_call" as const }] } : {}) }))
    const agent = createAgent({ model: provider, tools: [actualTool], checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const parent = new AbortController()
    const stream = await wrapped.stream(input(), { ...f.config, signal: parent.signal,
      streamMode: ["messages", "values"] })
    try {
      await entered.promise
      const stopping = stream.cancel("actual caller stopped")
        .then(() => { cancelled = true }, () => { cancelled = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(finalized).toBe(false)
      expect(cancelled).toBe(false)
      expect(parent.signal.aborted).toBe(false)
      expect(f.runtime.signal.aborted).toBe(false)
      gate.resolve()
      await stopping
      await (stream as typeof stream & { [FUNCTION_STREAM_TERMINAL]: Promise<void> })
        [FUNCTION_STREAM_TERMINAL]
      expect(finalized).toBe(true)
      expect(effects).toBe(1)
      expect(provider.requests).toHaveLength(1)
    } finally { gate.resolve() }
  })

  it("keeps two actual graph source receipts independent across parallel invocations", async () => {
    const f = fixture(), gateA = Promise.withResolvers<void>(), gateB = Promise.withResolvers<void>()
    const enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>()
    const provider = new LocalModel(async messages => {
      const name = messages.at(-1)?.content
      if (name === "A") { enteredA.resolve(); await gateA.promise }
      else { enteredB.resolve(); await gateB.promise }
      return new AIMessage({ id: randomUUID(), content: `actual ${String(name)}` })
    })
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const cutA = new AbortController(), cutB = new AbortController()
    const a = createFunctionConversationNativeSourceLifetime(agent.graph, () =>
      cutA.signal.throwIfAborted())
    const b = createFunctionConversationNativeSourceLifetime(agent.graph, () =>
      cutB.signal.throwIfAborted())
    const openingA = a.run(() => agent.stream(input("A"), { ...f.config,
      signal: cutA.signal, streamMode: "values" }))
    const openingB = b.run(() => agent.stream(input("B"), { ...f.config,
      configurable: { ...f.config.configurable, thread_id: randomUUID() },
      signal: cutB.signal, streamMode: "values" }))
    void openingA.catch(() => undefined)
    void openingB.catch(() => undefined)
    try {
      const streams = await Promise.all([openingA, openingB])
      a.finishOpening(); b.finishOpening()
      await Promise.all([enteredA.promise, enteredB.promise])
      let aDone = false, bDone = false
      void a.whenSettled().then(() => { aDone = true })
      void b.whenSettled().then(() => { bDone = true })
      gateA.resolve()
      await a.whenSettled()
      await Promise.resolve()
      expect(aDone).toBe(true)
      expect(bDone).toBe(false)
      gateB.resolve()
      await b.whenSettled()
      expect(bDone).toBe(true)
      for (const stream of streams) for await (const frame of stream)
        expect(frame).not.toBeUndefined()
      expect(provider.requests).toHaveLength(2)
    } finally { gateA.resolve(); gateB.resolve(); a.finishOpening(); b.finishOpening() }
  })

  it("directly closes a true original iterator paused at a native yield after abort", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let finalized = false, drained = false
    const provider = new LocalModel(async () => {
      entered.resolve()
      try { await gate.promise; return new AIMessage({ id: randomUUID(), content: "actual held" }) }
      finally { finalized = true }
    })
    const agent = createAgent({ model: provider, checkpointer: f.saver }), cut = new AbortController()
    const h = hostFor(agent)
    const source = createFunctionConversationNativeSourceLifetime(agent.graph, () =>
      cut.signal.throwIfAborted())
    const iterator = source.run(() => agent.graph._streamIterator(input(), {
      ...f.config, signal: cut.signal, streamMode: "values"
    }))
    try {
      expect((await iterator.next()).done).toBe(false)
      source.finishOpening()
      await entered.promise
      // No next() follows this yield: the original iterator itself must be retired.
      cut.abort(new DOMException("Actual paused source stopped", "AbortError"))
      const closing = source.drain().catch(() => undefined)
        .then(() => source.whenSettled()).then(() => h.host.whenDrained())
        .then(() => { drained = true })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(finalized).toBe(false)
      gate.resolve()
      await closing
      await source.whenSettled()
      expect(finalized).toBe(true)
      expect((await iterator.next()).done).toBe(true)
      expect(provider.requests).toHaveLength(1)
    } finally { gate.resolve(); source.finishOpening(); await source.drain().catch(() => undefined) }
  })

  it("retains a real checkpoint put after cancellation before the first public next", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const originalPut = f.saver.put.bind(f.saver)
    let held = false, finalized = false, stopped = false
    f.saver.put = async (...args: Parameters<SqlJsSaver["put"]>) => {
      const result = await originalPut(...args)
      if (!held && args[2].step >= 0) {
        held = true
        entered.resolve()
        try { await gate.promise } finally { finalized = true }
      }
      return result
    }
    const provider = new LocalModel(() => new AIMessage({ id: randomUUID(), content: "actual body" }))
    const agent = createAgent({ model: provider, checkpointer: f.saver })
    const h = hostFor(agent), wrapped = wrapFunctionConversationNativeInvocation(agent, h.host, f.runtime)
    const stream = await wrapped.stream(input(), { ...f.config, streamMode: "values" })
    try {
      await entered.promise
      // A real persisted put has succeeded, but its actual host callback has not returned.
      const closing = stream.return().then(() => { stopped = true }, () => { stopped = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(stopped).toBe(false)
      expect(finalized).toBe(false)
      gate.resolve()
      await closing
      await (stream as typeof stream & { [FUNCTION_STREAM_TERMINAL]: Promise<void> })
        [FUNCTION_STREAM_TERMINAL]
      expect(finalized).toBe(true)
      const tuple = await f.saver.getTuple(f.config)
      expect(tuple?.config.configurable?.checkpoint_id).toBeTypeOf("string")
    } finally { gate.resolve() }
  })
})
