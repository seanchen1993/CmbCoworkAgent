import { AsyncLocalStorage } from "node:async_hooks"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage } from
  "@langchain/core/messages"
import { ChatGenerationChunk, type ChatResult, type LLMResult } from "@langchain/core/outputs"
import { mergeConfigs } from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { createAgent, createMiddleware } from "langchain"
import { describe, expect, it } from "vitest"
import { z } from "zod"

type ProviderMode = "generate" | "stream"
type ProviderIdentity = "missing" | "reused"
type NativeCall = {
  namespace: string
  taskId: string
  read: object
  messages: BaseMessage[]
  result?: AIMessage
}
type IssuedMessage = { message: BaseMessage; originalId: string | undefined }
type ActualAttempt = {
  readonly call: NativeCall
  readonly runId: string
  readonly chunks: BaseMessage[]
  result?: BaseMessage
  failed: boolean
}

/** The handler is attached to this actual graph invocation, and can only mint inside its ALS. */
class PrivateModelCallbacks extends BaseCallbackHandler {
  name = "actual-private-model-attempt-proof"
  readonly calls = new AsyncLocalStorage<NativeCall>()
  readonly attempts = new Map<string, ActualAttempt>()
  readonly chunks = new WeakMap<BaseMessage, ActualAttempt>()
  readonly results = new WeakMap<BaseMessage, ActualAttempt>()

  constructor() { super({ raiseError: true, _awaitHandler: true }) }

  handleChatModelStart(...args: Parameters<NonNullable<BaseCallbackHandler["handleChatModelStart"]>>): void {
    const call = this.calls.getStore(), runId = args[2], metadata = args[6]
    if (!call) throw Error("Actual callback was not inside the original model call")
    if (metadata?.langgraph_checkpoint_ns !== call.namespace || this.attempts.has(runId))
      throw Error("Actual native callback identity changed")
    this.attempts.set(runId, { call, runId, chunks: [], failed: false })
  }

  handleLLMNewToken(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMNewToken"]>>): void {
    const attempt = this.attempts.get(args[2]), chunk = args[5]?.chunk
    if (!attempt || attempt.failed || attempt.call !== this.calls.getStore() ||
      !chunk || !("message" in chunk) || !BaseMessage.isInstance(chunk.message))
      throw Error("Actual native token object proof required")
    attempt.chunks.push(chunk.message)
    this.chunks.set(chunk.message, attempt)
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const attempt = this.attempts.get(runId)
    if (!attempt || attempt.failed || attempt.call !== this.calls.getStore())
      throw Error("Actual completed attempt proof required")
    const generations = output.generations.flat()
    if (generations.length !== 1 || !("message" in generations[0]) ||
      !BaseMessage.isInstance(generations[0].message))
      throw Error("Actual single generation object required")
    attempt.result = generations[0].message
    this.results.set(generations[0].message, attempt)
  }

  handleLLMError(_error: unknown, runId: string): void {
    const attempt = this.attempts.get(runId)
    if (!attempt || attempt.call !== this.calls.getStore())
      throw Error("Actual failed attempt proof required")
    attempt.failed = true
  }
}

class OriginalCallbacks extends BaseCallbackHandler {
  name = "actual-original-graph-callbacks"
  starts = 0
  ends = 0
  handleChatModelStart(): void { this.starts++ }
  handleLLMEnd(): void { this.ends++ }
}

/** Actual provider objects, before BaseChatModel/StreamMessagesHandler can assign an ID. */
class ProvenanceProvider extends BaseChatModel {
  readonly issued: IssuedMessage[][] = []
  readonly requests: BaseMessage[][] = []

  constructor(mode: ProviderMode, private readonly identity: ProviderIdentity) {
    super({ outputVersion: "v0" })
    this.disableStreaming = mode === "generate"
  }

  _llmType(): string { return "actual-provenance-fixture" }
  bindTools(): this { return this }

  private next(messages: BaseMessage[]): number {
    this.requests.push([...messages])
    if (this.requests.length > 2) throw Error("Unexpected third actual model invocation")
    this.issued.push([])
    return this.requests.length - 1
  }

  private remember(index: number, message: BaseMessage): void {
    this.issued[index].push({ message, originalId: message.id })
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const index = this.next(messages)
    const message = new AIMessage({
      content: index === 0 ? "first model" : "second model",
      ...(this.identity === "reused" ? { id: "same-provider-message" } : {}),
      tool_calls: index === 0
        ? [{ id: "original-tool-call", name: "actual_probe_tool", args: {}, type: "tool_call" }]
        : []
    })
    this.remember(index, message)
    return { generations: [{ message, text: String(message.content) }] }
  }

  async *_streamResponseChunks(messages: BaseMessage[], _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    const index = this.next(messages)
    for (const part of [0, 1]) {
      const text = part === 0 ? `${index === 0 ? "first" : "second"} ` : "model"
      const message = new AIMessageChunk({
        content: text,
        ...(this.identity === "reused" ? { id: "same-provider-message" } : {}),
        tool_call_chunks: index === 0 && part === 0
          ? [{ index: 0, id: "original-tool-call", name: "actual_probe_tool", args: "{}",
            type: "tool_call_chunk" }] : []
      })
      this.remember(index, message)
      const chunk = new ChatGenerationChunk({ text, message })
      // Use the provider's real callback path, rather than constructing stream metadata.
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined,
        { chunk })
      yield chunk
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Actual native metadata object required")
  return value as Record<string, unknown>
}

function messages(value: unknown): BaseMessage[] {
  if (!Array.isArray(value) || !value.every(BaseMessage.isInstance))
    throw Error("Actual graph BaseMessage array required")
  return value
}

describe("actual model task address and original stream object provenance", () => {
  it.each([
    ["generate", "missing"], ["generate", "reused"],
    ["stream", "missing"], ["stream", "reused"]
  ] as const)("observes %s / %s IDs through two natural ToolNode model calls", async (mode, identity) => {
    const provider = new ProvenanceProvider(mode, identity)
    const callbacks = new PrivateModelCallbacks(), originalCallbacks = new OriginalCallbacks()
    const calls: NativeCall[] = []
    let toolEffects = 0
    const native = createMiddleware({ name: "actual-model-provenance",
      wrapModelCall: async (request, handler) => {
        const configurable = request.runtime.configurable
        if (!configurable || typeof configurable.checkpoint_ns !== "string" ||
          !configurable.checkpoint_ns || typeof configurable.__pregel_task_id !== "string" ||
          !configurable.__pregel_task_id || typeof configurable.__pregel_read !== "function")
          throw Error("Actual model runtime task facts required")
        const call: NativeCall = {
          namespace: configurable.checkpoint_ns, taskId: configurable.__pregel_task_id,
          read: configurable.__pregel_read, messages: [...request.messages]
        }
        calls.push(call)
        const response = await callbacks.calls.run(call, () => handler(request))
        if (!AIMessage.isInstance(response)) throw Error("Actual provider AI result required")
        const receipt = callbacks.results.get(response)
        if (!receipt || receipt.call !== call || receipt.failed)
          throw Error("Returned message lacked its actual completed callback receipt")
        call.result = response
        return response
      }
    })
    const graph = createAgent({ model: provider, middleware: [native], tools: [
      tool(() => { toolEffects++; return "original tool result" }, {
        name: "actual_probe_tool", description: "Actual natural ToolNode continuation",
        schema: z.object({})
      })
    ] })
    const emitted: Array<{ message: AIMessage; namespace: string }> = []
    const values: BaseMessage[][] = []
    const originalConfig = {
      configurable: { thread_id: "actual-provenance-thread" },
      callbacks: [originalCallbacks], streamMode: ["messages", "values"] as ("messages" | "values")[],
      recursionLimit: 20
    }
    const stream = await graph.stream({ messages: [new HumanMessage("actual seed")] },
      mergeConfigs(originalConfig, { callbacks: [callbacks] }))
    for await (const event of stream) {
      if (!Array.isArray(event) || event.length !== 2) throw Error("Actual two-mode stream required")
      const [streamMode, data] = event
      if (streamMode === "messages") {
        if (!Array.isArray(data) || data.length !== 2) throw Error("Actual message event required")
        if (!AIMessage.isInstance(data[0])) continue
        const metadata = object(data[1])
        if (typeof metadata.langgraph_checkpoint_ns !== "string")
          throw Error("Actual callback checkpoint namespace required")
        emitted.push({ message: data[0], namespace: metadata.langgraph_checkpoint_ns })
      } else if (streamMode === "values") values.push(messages(object(data).messages))
      else throw Error("Unexpected graph stream mode")
    }

    expect(calls).toHaveLength(2)
    expect(provider.requests).toHaveLength(2)
    expect(callbacks.attempts.size).toBe(2)
    expect(originalCallbacks.starts).toBe(2)
    expect(originalCallbacks.ends).toBe(2)
    expect(originalConfig.callbacks).toEqual([originalCallbacks])
    expect(toolEffects).toBe(1)
    expect(new Set(calls.map(call => call.namespace)).size).toBe(2)
    expect(new Set(calls.map(call => call.taskId)).size).toBe(2)
    expect(calls[1].read).not.toBe(calls[0].read)
    const toolResult = calls[1].messages.filter(ToolMessage.isInstance)
    expect(toolResult).toHaveLength(1)
    expect(toolResult[0].tool_call_id).toBe("original-tool-call")
    expect(calls[1].messages.some(message => message === calls[0].result)).toBe(true)
    expect(emitted.every(event => calls.some(call => call.namespace === event.namespace))).toBe(true)

    for (const [index, call] of calls.entries()) {
      const issued = provider.issued[index]
      const events = emitted.filter(event => event.namespace === call.namespace)
      const attempt = call.result && callbacks.results.get(call.result)
      expect(attempt?.call).toBe(call)
      expect(attempt?.result).toBe(call.result)
      expect(issued.every(row => row.originalId ===
        (identity === "missing" ? undefined : "same-provider-message"))).toBe(true)
      if (mode === "stream") {
        expect(events).toHaveLength(2)
        expect(events[0].message).toBe(issued[0].message)
        expect(events[1].message).toBe(issued[1].message)
        expect(callbacks.chunks.get(events[0].message)).toBe(attempt)
        expect(callbacks.chunks.get(events[1].message)).toBe(attempt)
        expect(call.result).not.toBe(issued[0].message)
        expect(call.result).not.toBe(issued[1].message)
      } else {
        // The real global stream dedupe suppresses the second non-streamed reused ID.
        expect(events).toHaveLength(identity === "reused" && index === 1 ? 0 : 1)
        if (events.length) expect(events[0].message).toBe(issued[0].message)
        expect(call.result).toBe(issued[0].message)
      }
      expect(typeof call.result?.id).toBe("string")
      expect(call.result?.id).not.toBe("")
    }

    const final = values.at(-1)
    expect(final).toBeDefined()
    expect(final?.some(message => message === calls[1].result)).toBe(true)
    // IDs are reducer keys, not model occurrence identities: reuse replaces the first AI.
    expect(final?.some(message => message === calls[0].result)).toBe(identity === "missing")
    expect(calls[0].result?.id === calls[1].result?.id).toBe(identity === "reused")
  })

  it("separates two real inner retry attempts with the same task and provider ID", async () => {
    const callbacks = new PrivateModelCallbacks(), originalCallbacks = new OriginalCallbacks()
    const calls: NativeCall[] = []
    let attempts = 0
    class RetryingProvider extends BaseChatModel {
      _llmType(): string { return "actual-inner-retry-provenance" }
      bindTools(): this { return this }
      async _generate(): Promise<ChatResult> { throw Error("Actual streaming path required") }
      async *_streamResponseChunks(_messages: BaseMessage[], _options: this["ParsedCallOptions"],
        manager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
        attempts++
        const message = new AIMessageChunk({ content: attempts === 1 ? "failed partial" : "accepted",
          id: "reused-across-actual-retry" })
        const chunk = new ChatGenerationChunk({ text: String(message.content), message })
        await manager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined,
          { chunk })
        yield chunk
        if (attempts === 1) throw Error("ACTUAL_PROVIDER_RETRY")
      }
    }
    const native = createMiddleware({ name: "actual-retry-outer-source",
      wrapModelCall: async (request, handler) => {
        const config = request.runtime.configurable
        if (!config || typeof config.checkpoint_ns !== "string" ||
          typeof config.__pregel_task_id !== "string" || typeof config.__pregel_read !== "function")
          throw Error("Actual native model task required")
        const call: NativeCall = { namespace: config.checkpoint_ns,
          taskId: config.__pregel_task_id, read: config.__pregel_read,
          messages: [...request.messages] }
        calls.push(call)
        const response = await callbacks.calls.run(call, () => handler(request))
        if (!AIMessage.isInstance(response)) throw Error("Actual returned AI required")
        const receipt = callbacks.results.get(response)
        if (!receipt || receipt.call !== call || receipt.failed)
          throw Error("Actual successful attempt required")
        call.result = response
        return response
      }
    })
    const retry = createMiddleware({ name: "actual-inner-retry",
      wrapModelCall: async (request, handler) => {
        try { return await handler(request) }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "ACTUAL_PROVIDER_RETRY") throw error
          return handler(request)
        }
      }
    })
    const graph = createAgent({ model: new RetryingProvider({}), middleware: [native, retry] })
    const emitted: BaseMessage[] = []
    const stream = await graph.stream({ messages: [new HumanMessage("actual retry seed")] },
      mergeConfigs({ configurable: { thread_id: "actual-inner-retry-thread" },
        callbacks: [originalCallbacks], streamMode: ["messages", "values"] as ("messages" | "values")[] },
      { callbacks: [callbacks] }))
    for await (const event of stream) {
      if (Array.isArray(event) && event[0] === "messages" && Array.isArray(event[1]) &&
        AIMessage.isInstance(event[1][0])) emitted.push(event[1][0])
    }
    expect(calls).toHaveLength(1)
    expect(callbacks.attempts.size).toBe(2)
    const actual = [...callbacks.attempts.values()]
    expect(actual[0].call).toBe(calls[0])
    expect(actual[1].call).toBe(calls[0])
    expect(actual[0].runId).not.toBe(actual[1].runId)
    expect(actual[0].failed).toBe(true)
    expect(actual[0].result).toBeUndefined()
    expect(actual[1].failed).toBe(false)
    expect(actual[1].result).toBe(calls[0].result)
    expect(emitted).toHaveLength(2)
    expect(emitted[0].id).toBe(emitted[1].id)
    expect(callbacks.chunks.get(emitted[0])).toBe(actual[0])
    expect(callbacks.chunks.get(emitted[1])).toBe(actual[1])
    expect(callbacks.results.get(calls[0].result!)).toBe(actual[1])
    expect(originalCallbacks.starts).toBe(2)
    expect(originalCallbacks.ends).toBe(1)
  })
})
