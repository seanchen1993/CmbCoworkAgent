import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { LLMResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { describe, expect, it } from "vitest"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw Error("ACTUAL_SDK_RECORD_REQUIRED")
  return value as Record<string, unknown>
}
function own(value: object, key: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field || !("value" in field)) throw Error("ACTUAL_SDK_DATA_FIELD_REQUIRED")
  return field.value
}
function nativeMessages(value: unknown): BaseMessage[] {
  const result = own(record(value), "messages")
  if (!Array.isArray(result) || !result.every(BaseMessage.isInstance))
    throw Error("ACTUAL_SDK_MESSAGES_REQUIRED")
  return result
}
function codec(message: BaseMessage): string { return JSON.stringify(message.toDict()) }
function names(message: BaseMessage) {
  return { root: Object.getOwnPropertyDescriptor(message, "name")?.value as unknown,
    kwargs: Object.getOwnPropertyDescriptor(message.lc_kwargs, "name")?.value as unknown }
}
class OriginalNameCallbacks extends BaseCallbackHandler {
  name = "original-sdk-completion-name"
  starts = 0
  readonly chunks: BaseMessage[] = []
  readonly earlyNames: Array<ReturnType<typeof names>> = []
  returned: BaseMessage | undefined
  returnedNames: ReturnType<typeof names> | undefined
  returnedCodec: string | undefined

  constructor() { super({ raiseError: true, _awaitHandler: true }) }
  handleChatModelStart() { this.starts++ }
  handleLLMNewToken(...args: Parameters<NonNullable<BaseCallbackHandler["handleLLMNewToken"]>>) {
    const chunk = args[5]?.chunk
    if (!chunk || !("message" in chunk) || !AIMessageChunk.isInstance(chunk.message))
      throw Error("ACTUAL_SDK_TOKEN_CHUNK_REQUIRED")
    this.chunks[this.chunks.length] = chunk.message
    this.earlyNames[this.earlyNames.length] = names(chunk.message)
  }
  handleLLMEnd(output: LLMResult) {
    if (output.generations.length !== 1 || output.generations[0].length !== 1)
      throw Error("ACTUAL_SDK_SINGLE_RETURN_REQUIRED")
    const generation = output.generations[0][0]
    if (!("message" in generation) || !AIMessageChunk.isInstance(generation.message))
      throw Error("ACTUAL_SDK_RETURN_CHUNK_REQUIRED")
    this.returned = generation.message
    this.returnedNames = names(generation.message)
    this.returnedCodec = codec(generation.message)
  }
}

/** Unwrapped localhost SDK only. No native Slot, Attempt, writer or projection is minted. */
describe("original SDK streaming completion name", () => {
  it.each([
    { agentName: undefined, chunks: 1 },
    { agentName: undefined, chunks: 2 },
    { agentName: "actual_custom_completed_agent", chunks: 1 },
    { agentName: "actual_custom_completed_agent", chunks: 2 }
  ])("assigns actual AgentNode name after $chunks chunks ($agentName)", async scenario => {
    const controller = new AbortController(), saver = new MemorySaver()
    const callbacks = new OriginalNameCallbacks(), runs: Promise<unknown>[] = []
    const parts = scenario.chunks === 1 ? ["actual complete"] : ["actual ", "complete"]
    let requests = 0, serverFailed = false, serverFailure: unknown
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks[chunks.length] = Buffer.from(chunk)
        const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        if (body.stream !== true) throw Error("ACTUAL_SDK_STREAM_REQUEST_REQUIRED")
        requests++
        response.writeHead(200, { "content-type": "text/event-stream" })
        for (let index = 0; index < parts.length; index++) {
          response.write(`data: ${JSON.stringify({ id: "actual-sdk-stream-provider",
            object: "chat.completion.chunk", created: 1, model: "actual-sdk-name-model",
            choices: [{ index: 0, delta: { ...(index === 0 ? { role: "assistant" } : {}),
              content: parts[index] }, finish_reason: index === parts.length - 1 ? "stop" : null }] })}\n\n`)
        }
        response.end("data: [DONE]\n\n")
      } catch (error) {
        serverFailed = true
        serverFailure = error
        response.writeHead(500)
        response.end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw Error("ACTUAL_SDK_HTTP_PORT_REQUIRED")
      const model = new ChatOpenAI({ apiKey: "local-test-key", model: "actual-sdk-name-model",
        maxRetries: 0, streamUsage: false,
        configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` } })
      const agent = createAgent({ model, tools: [], checkpointer: saver, name: scenario.agentName })
      const builder = record(own(agent.graph, "builder"))
      const builderNodes = record(own(builder, "nodes"))
      const originalNode = record(own(record(own(builderNodes, "model_request")), "runnable"))
      const compiledNode = record(own(record(own(agent.graph, "nodes")), "model_request"))
      const originalName = own(originalNode, "name")
      const input = new HumanMessage("original unnamed SDK input")
      const config = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
        signal: controller.signal, callbacks: [callbacks], streamMode: ["messages", "values"] as
          ["messages", "values"] }
      let completed: BaseMessage[] | undefined
      const emitted: BaseMessage[] = []
      const actual = (async () => {
        const stream = await agent.stream({ messages: [input] }, config)
        for await (const frame of stream) {
          const event: unknown = frame
          if (!Array.isArray(event) || event.length !== 2)
            throw Error("ACTUAL_SDK_MULTI_MODE_REQUIRED")
          if (event[0] === "messages") {
            if (!Array.isArray(event[1]) || !BaseMessage.isInstance(event[1][0]))
              throw Error("ACTUAL_SDK_MESSAGE_FRAME_REQUIRED")
            emitted[emitted.length] = event[1][0]
          } else if (event[0] === "values") completed = nativeMessages(event[1])
          else throw Error("ACTUAL_SDK_KNOWN_MODE_REQUIRED")
        }
      })()
      runs[runs.length] = actual
      void actual.catch(() => undefined)
      await actual
      if (serverFailed) throw serverFailure
      expect(own(compiledNode, "bound")).toBe(originalNode)
      expect(originalName).toBe(scenario.agentName ?? "model")
      expect(callbacks.starts).toBe(1)
      expect(requests).toBe(1)
      expect(callbacks.chunks).toHaveLength(scenario.chunks)
      expect(callbacks.earlyNames).toEqual(parts.map(() => ({ root: undefined, kwargs: undefined })))
      expect(callbacks.returnedNames).toEqual({ root: undefined, kwargs: undefined })
      expect(emitted).toHaveLength(scenario.chunks)
      expect(emitted).toEqual(callbacks.chunks)
      for (let index = 0; index < emitted.length; index++)
        expect(emitted[index]).toBe(callbacks.chunks[index])
      expect(completed).toHaveLength(2)
      const final = completed![1]
      expect(AIMessage.isInstance(final)).toBe(true)
      expect(final).toBe(callbacks.returned)
      expect(final === callbacks.chunks[0]).toBe(scenario.chunks === 1)
      expect(names(final)).toEqual({ root: originalName, kwargs: originalName })
      expect(own(originalNode, "name")).toBe(originalName)
      expect(final.content).toBe(parts.join(""))
      expect(final.id).toBe("actual-sdk-stream-provider")
      const completedCodec = record(JSON.parse(codec(final)))
      const completedData = record(completedCodec.data)
      delete completedData.name
      expect(record(JSON.parse(callbacks.returnedCodec!))).toEqual(completedCodec)
      expect(completed![0]).toBe(input)
      expect(typeof input.id).toBe("string")
      expect(input.lc_kwargs.id).toBe(input.id)
      const tuple = await saver.getTuple(config)
      const saved = nativeMessages(tuple?.checkpoint.channel_values)
      expect(saved.map(codec)).toEqual(completed!.map(codec))
      expect(saved).toHaveLength(2)
      expect(saved.filter(message => message.getType() === "tool")).toHaveLength(0)
    } finally {
      controller.abort(Error("ACTUAL_SDK_NAME_REFERENCE_FINISHED"))
      await Promise.allSettled(runs)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
