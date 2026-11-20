import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatGenerationChunk } from "@langchain/core/outputs"
import { describe, expect, it, vi } from "vitest"
import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"

import {
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions,
  ToolCallAwareChatOpenAICompletions
} from "./interleaved-thinking-completions"

const encoder = new TextEncoder()

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
}

function chunk(id: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }
}

async function flushStreamWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const completionClasses = [
  ToolCallAwareChatOpenAICompletions,
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions
]

it("preserves actual provider model and usage through graph-triggered streaming invoke", async () => {
  const fields = {
    model: "configured-alias",
    apiKey: "test-key",
    maxRetries: 0,
    configuration: {
      baseURL: "https://example.test/v1",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                sse(chunk("actual-response", { role: "assistant", content: "ok" }))
              )
              controller.enqueue(sse(chunk("actual-response", {}, "stop")))
              controller.enqueue(
                sse({
                  ...chunk("actual-response", {}),
                  choices: [],
                  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
                })
              )
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    }
  }
  const agent = createAgent({
    model: new ChatOpenAI({
      ...fields,
      completions: new ToolCallAwareChatOpenAICompletions(fields)
    } as never),
    tools: []
  })
  let final: AIMessage | undefined
  for await (const [mode, state] of await agent.stream(
    { messages: [new HumanMessage("hello")] },
    { streamMode: ["messages", "values"] }
  )) {
    if (mode === "values") final = state.messages.at(-1) as AIMessage
  }
  expect(final?.content).toBe("ok")
  expect(final?.response_metadata).toMatchObject({
    model_name: "test-model",
    finish_reason: "stop"
  })
  expect(final?.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 3 })
})

async function collectSse(
  Model: (typeof completionClasses)[number],
  deltas: Record<string, unknown>[]
): Promise<ChatGenerationChunk> {
  const completions = new Model({
    model: "test-model",
    apiKey: "test-key",
    maxRetries: 0,
    configuration: {
      baseURL: "https://example.test/v1",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const delta of deltas) controller.enqueue(sse(chunk("tools", delta)))
              controller.enqueue(sse(chunk("tools", {}, "tool_calls")))
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            }
          }),
          {
            headers: { "content-type": "text/event-stream" }
          }
        )
    }
  })
  let combined: ChatGenerationChunk | undefined
  for await (const generation of completions._streamResponseChunks(
    [new HumanMessage("Run the cleanup command")],
    {}
  )) {
    combined = combined ? combined.concat(generation) : generation
  }
  if (!combined) throw new Error("Expected at least one streamed chunk")
  return combined
}

function toolDeltas(): Record<string, unknown>[] {
  return [
    {
      tool_calls: [
        {
          index: 0,
          id: "call_cleanup",
          type: "function",
          function: { name: "execute", arguments: '{"command":' }
        }
      ]
    },
    {
      tool_calls: [{ index: 0, function: { arguments: '"echo cleanup"}' } }]
    }
  ]
}

function expectCleanupCall(generation: ChatGenerationChunk): void {
  const message = generation.message
  expect(AIMessage.isInstance(message)).toBe(true)
  if (!AIMessage.isInstance(message)) throw new Error("Expected an assistant message")
  expect(message.tool_calls).toEqual([
    {
      name: "execute",
      args: { command: "echo cleanup" },
      id: "call_cleanup",
      type: "tool_call"
    }
  ])
  expect(message.invalid_tool_calls).toEqual([])
  expect(generation.generationInfo?.finish_reason).toBe("tool_calls")
}

describe("tool calls in provider SSE streams", () => {
  it.each(completionClasses)("preserves role-less tool deltas with %s", async (Model) => {
    expectCleanupCall(await collectSse(Model, toolDeltas()))
  })

  it.each(completionClasses)("preserves normal assistant tool deltas with %s", async (Model) => {
    expectCleanupCall(await collectSse(Model, [{ role: "assistant" }, ...toolDeltas()]))
  })

  it.each(completionClasses)("preserves tools after role-less text with %s", async (Model) => {
    const generation = await collectSse(Model, [
      { content: "I will execute cleanup." },
      ...toolDeltas()
    ])
    expectCleanupCall(generation)
    expect(generation.message.content).toBe("I will execute cleanup.")
  })

  it("preserves tools after an empty leading delta", async () => {
    expectCleanupCall(await collectSse(ToolCallAwareChatOpenAICompletions, [{}, ...toolDeltas()]))
  })

  it.each(completionClasses)(
    "preserves tool calls after role-less reasoning with %s",
    async (Model) => {
      const generation = await collectSse(Model, [
        { reasoning_content: "I will execute cleanup." },
        ...toolDeltas()
      ])
      expectCleanupCall(generation)
      if (Model === InterleavedThinkingChatOpenAICompletions) {
        expect(generation.message.content).toBe("<think>I will execute cleanup.</think>")
      } else if (Model === ReasoningDisplayChatOpenAICompletions) {
        expect(generation.message.additional_kwargs.reasoning).toBe("I will execute cleanup.")
      } else {
        expect(generation.message.content).toBe("")
      }
    }
  )

  it.each([true, false])("preserves an explicit or inherited role (inline=%s)", async (inline) => {
    const deltas = toolDeltas()
    const generation = await collectSse(
      ToolCallAwareChatOpenAICompletions,
      inline ? [{ ...deltas[0], role: "user" }, deltas[1]] : [{ role: "user" }, ...deltas]
    )
    expect(generation.message.type).toBe("human")
    expect(AIMessage.isInstance(generation.message)).toBe(false)
  })
})

describe("InterleavedThinkingChatOpenAICompletions", () => {
  it("isolates thinking state across concurrent streams", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    let resolveConnected: (() => void) | undefined
    const bothConnected = new Promise<void>((resolve) => {
      resolveConnected = resolve
    })
    const controlledFetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller)
          if (controllers.length === 2) resolveConnected?.()
        }
      })
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    })
    const completions = new InterleavedThinkingChatOpenAICompletions({
      model: "test-model",
      apiKey: "test-key",
      maxRetries: 0,
      configuration: {
        baseURL: "https://example.test/v1",
        fetch: controlledFetch as unknown as typeof fetch
      }
    }) as unknown as {
      _streamResponseChunks(
        messages: BaseMessage[],
        options: Record<string, never>
      ): AsyncGenerator<ChatGenerationChunk>
    }
    const collect = async (label: string): Promise<string> => {
      let content = ""
      for await (const generation of completions._streamResponseChunks(
        [new HumanMessage(label)],
        {}
      )) {
        content += generation.text
      }
      return content
    }

    const outputA = collect("A")
    const outputB = collect("B")
    await bothConnected

    controllers[0].enqueue(sse(chunk("A", { role: "assistant", reasoning_content: "reason-A" })))
    await flushStreamWork()
    controllers[1].enqueue(sse(chunk("B", { role: "assistant", reasoning_content: "reason-B" })))
    await flushStreamWork()
    controllers[0].enqueue(sse(chunk("A", { content: "answer-A" }, "stop")))
    await flushStreamWork()
    controllers[1].enqueue(sse(chunk("B", { content: "answer-B" }, "stop")))
    await flushStreamWork()

    for (const controller of controllers) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    }

    await expect(outputA).resolves.toBe("<think>reason-A</think>\n\nanswer-A")
    await expect(outputB).resolves.toBe("<think>reason-B</think>\n\nanswer-B")
    expect(controlledFetch).toHaveBeenCalledTimes(2)
  })
})
