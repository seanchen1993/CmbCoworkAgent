import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatGenerationChunk } from "@langchain/core/outputs"
import { describe, expect, it, vi } from "vitest"

import { InterleavedThinkingChatOpenAICompletions } from "./interleaved-thinking-completions"

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
