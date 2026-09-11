import { HumanMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions,
  ToolCallAwareChatOpenAICompletions
} from "../agent/interleaved-thinking-completions"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  readTurnCompletionGateReport
} from "../agent/turn-completion-integrity"
import { getCurrentTurnAssistantResponse } from "../agent/goals/evaluator"
import {
  createSerializedValuesMessageAccumulator,
  createStreamDataSerializer,
  serializeStreamData
} from "./stream-data-serialization"
import { createStreamMessageSideEffectBuffer } from "./stream-message-side-effect-buffer"

// Only HTTP is replaced. LangChain's SSE parser, model chunks, actual graph,
// tool execution and completion middleware feed the production serializer.
const models = [
  ToolCallAwareChatOpenAICompletions,
  InterleavedThinkingChatOpenAICompletions,
  ReasoningDisplayChatOpenAICompletions
]

describe("provider stream through the agent harness", () => {
  it.each(models.map((Model) => [Model.name, Model] as const))(
    "preserves tool arguments, repeated output and completion with %s",
    async (_name, Model) => {
      const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
      const executed: string[] = []
      const threadId = `stream-integrity-${Model.name}`
      const runToken = "integrity-run"
      const encoder = new TextEncoder()
      const model = new Model({
        model: "test-model",
        apiKey: "test-key",
        maxRetries: 0,
        configuration: {
          baseURL: "https://example.test/v1",
          fetch: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)))
            const requestIndex = requests.length - 1
            const deltas =
              requestIndex === 0
                ? [
                    {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "echo-call",
                          type: "function",
                          function: { name: "echo", arguments: '{"text":"' }
                        }
                      ]
                    },
                    { tool_calls: [{ index: 0, function: { arguments: "ha" } }] },
                    { tool_calls: [{ index: 0, function: { arguments: "ha" } }] },
                    { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }
                  ]
                : requestIndex === 1
                  ? [{ role: "assistant", content: "" }]
                  : [
                      { role: "assistant", content: "哈" },
                      { content: "哈" },
                      { content: "，你好。" }
                    ]
            const frame = (delta: unknown, finishReason: string | null = null) =>
              `data: ${JSON.stringify({
                id: `response-${requestIndex}`,
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{ index: 0, delta, finish_reason: finishReason }]
              })}\n\n`
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const delta of deltas) controller.enqueue(encoder.encode(frame(delta)))
                  controller.enqueue(
                    encoder.encode(frame({}, requestIndex === 0 ? "tool_calls" : "stop"))
                  )
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"))
                  controller.close()
                }
              }),
              { headers: { "content-type": "text/event-stream" } }
            )
          }
        }
      })
      const echo = tool(
        async ({ text }) => {
          executed.push(text)
          return `echo:${text}`
        },
        { name: "echo", description: "Echo text", schema: z.object({ text: z.string() }) }
      )
      const agent = createAgent({
        model,
        tools: [echo],
        middleware: [createTurnCompletionGateMiddleware({ ownerRunToken: runToken })]
      })
      const serialize = createStreamDataSerializer()
      const values = createSerializedValuesMessageAccumulator()
      const effects = createStreamMessageSideEffectBuffer()
      const streamedText: string[] = []
      let lastFinalText = ""
      let valueFrames = 0
      try {
        const stream = await agent.stream(
          { messages: [new HumanMessage("Echo haha, then greet me")] },
          {
            streamMode: ["messages", "values"],
            configurable: { thread_id: threadId }
          }
        )
        for await (const [mode, data] of stream) {
          const before = JSON.stringify(data)
          const projected = serialize(mode, data)
          expect(JSON.stringify(data)).toBe(before)
          if (mode === "messages") {
            const [message] = projected.data as [{ id: string[]; kwargs: { content: string } }]
            if (message.id.at(-1)?.startsWith("AIMessage")) {
              effects.push(projected.data)
              if (typeof message.kwargs.content === "string")
                streamedText.push(message.kwargs.content)
            }
          } else if (mode === "values") {
            const actual = values.update(projected)
            const oracle = serializeStreamData(mode, data)
            expect(actual).toEqual({
              messages: (oracle.data as { messages: unknown[] }).messages,
              valuesMessageIndexOffset: oracle.valuesMessageIndexOffset
            })
            const final = actual.messages.at(-1) as { kwargs?: { content?: string } }
            lastFinalText = final?.kwargs?.content ?? ""
            valueFrames += 1
          }
        }
        expect(executed).toEqual(["haha"])
        expect(requests).toHaveLength(3)
        expect(requests[1].messages).toContainEqual(
          expect.objectContaining({ role: "tool", content: "echo:haha" })
        )
        expect(JSON.stringify(requests[2].messages)).toContain("CMB_TURN_COMPLETION_GATE_V1")
        expect(streamedText.join("")).toBe("哈哈，你好。")
        const bufferedText = (effects.drain() as Array<[{ kwargs: { content: string } }]>)
          .map(([msg]) => msg.kwargs.content)
          .join("")
        expect(bufferedText).toBe("哈哈，你好。")
        expect(
          getCurrentTurnAssistantResponse({
            assistantText: bufferedText,
            currentTurnAssistantStart: 0
          })
        ).toBe("哈哈，你好。")
        expect(lastFinalText).toBe("哈哈，你好。")
        expect(valueFrames).toBeGreaterThan(3)
        // A successful final answer refunds the recovery budget for the next subturn.
        expect(readTurnCompletionGateReport(threadId, runToken)).toMatchObject({
          retriesUsed: 0,
          unresolved: null
        })
      } finally {
        clearTurnCompletionGateState(threadId, runToken)
      }
    }
  )
})
