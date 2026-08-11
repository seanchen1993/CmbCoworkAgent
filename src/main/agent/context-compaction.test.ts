import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CONTEXT_COMPACTION_MODEL_TAG,
  CONTEXT_COMPACTION_NO_STREAM_TAG,
  type ContextCompactionLifecycleEvent
} from "../../shared/context-compaction-events"
import {
  configureContextCompactionModel,
  ContextCompactionCallbackHandler
} from "./context-compaction"
import { createCmbSummarizationMiddleware } from "./context-summarization-middleware"
import {
  calculateSummarizationTriggerTokens,
  calculateSummaryOverflowRetryTargetTokens,
  CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
  getModelInstance
} from "./runtime"

class FakeConfigurableModel {
  withConfig(config: RunnableConfig): { config: RunnableConfig } {
    return { config }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("context compaction model binding", () => {
  it("reserves configured model output space when calculating the compaction trigger", () => {
    expect(calculateSummarizationTriggerTokens(128_000, 8_192)).toBe(96_000)
    expect(calculateSummarizationTriggerTokens(32_000, 8_192)).toBe(22_808)
    expect(calculateSummarizationTriggerTokens(128_000, 100_000)).toBe(27_000)
    expect(() => calculateSummarizationTriggerTokens(32_000, 31_000)).toThrow(
      "must leave more than 1000 tokens"
    )
    expect(() => calculateSummarizationTriggerTokens(32_000, 28_000)).toThrow(
      "compaction trigger 3000 must exceed retained context 3200"
    )
  })

  it("reserves compaction output space in the summary-overflow retry target", () => {
    expect(calculateSummaryOverflowRetryTargetTokens(128_000, 20_000)).toBe(83_200)
    expect(calculateSummaryOverflowRetryTargetTokens(32_000, 8_192)).toBe(20_800)
    expect(calculateSummaryOverflowRetryTargetTokens(32_000, 20_000)).toBe(11_000)
  })

  it("keeps agent thinking/streaming while compaction invoke() requests non-thinking", async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const requestUrls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        requestUrls.push(requestUrl)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requestBodies.push(body)

        if (body.stream === true) {
          const chunks = [
            {
              id: "chatcmpl-summary",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "streamed summary" },
                  finish_reason: null
                }
              ]
            },
            {
              id: "chatcmpl-summary",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            },
            {
              id: "chatcmpl-summary",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [],
              usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
            }
          ]
          const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
          return new Response(payload, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl-agent",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "normal response" },
                finish_reason: "stop"
              }
            ],
            usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      })
    )

    const config = {
      id: "test",
      model: "gpt-4",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      maxOutputTokens: 100_000,
      enableThinking: true,
      interleavedThinking: true
    }
    const agentModel = getModelInstance(config, undefined, 1)
    const compactionModel = getModelInstance(config, undefined, 1, "context-compaction")
    const configuredCompactionModel = configureContextCompactionModel(
      compactionModel
    ) as typeof compactionModel
    const plainCompactionModel = getModelInstance(
      { ...config, enableThinking: false, interleavedThinking: false },
      undefined,
      1,
      "context-compaction"
    )
    const configuredPlainCompactionModel = configureContextCompactionModel(
      plainCompactionModel
    ) as typeof plainCompactionModel
    const agentCompletions = agentModel as unknown as {
      completions: { getNumTokens: (content: unknown) => Promise<number> }
    }
    const testableCompactionModel = configuredCompactionModel as unknown as {
      completions: { getNumTokens: (content: unknown) => Promise<number> }
    }
    const testablePlainCompactionModel = configuredPlainCompactionModel as unknown as {
      completions: { getNumTokens: (content: unknown) => Promise<number> }
    }

    expect(testableCompactionModel.completions.getNumTokens).not.toBe(
      agentCompletions.completions.getNumTokens
    )
    expect(await testableCompactionModel.completions.getNumTokens("12345")).toBe(2)
    expect((plainCompactionModel as unknown as { completions: unknown }).completions).toBe(
      testablePlainCompactionModel.completions
    )
    expect(await testablePlainCompactionModel.completions.getNumTokens("12345")).toBe(2)

    const agentResponse = await agentModel.invoke([new HumanMessage("normal request")])
    const agentStreamChunks: string[] = []
    for await (const chunk of await agentModel.stream([new HumanMessage("streaming request")])) {
      if (typeof chunk.content === "string" && chunk.content) {
        agentStreamChunks.push(chunk.content)
      }
    }
    const compactionResponse = await configuredCompactionModel.invoke([
      new HumanMessage("summarize")
    ])
    const plainCompactionResponse = await configuredPlainCompactionModel.invoke([
      new HumanMessage("summarize without thinking")
    ])

    expect(agentResponse.content).toBe("normal response")
    expect(agentStreamChunks).toEqual(["streamed summary"])
    expect(compactionResponse.content).toBe("streamed summary")
    expect(plainCompactionResponse.content).toBe("streamed summary")
    expect(requestBodies).toHaveLength(4)
    expect(requestBodies[0].stream).toBe(false)
    expect(requestBodies[0].max_tokens).toBe(100_000)
    expect(requestBodies[0].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(requestBodies[0].thinking).toEqual({ type: "enabled" })
    expect(requestBodies[1].stream).toBe(true)
    expect(requestBodies[1].max_tokens).toBe(100_000)
    expect(requestBodies[1].stream_options).toEqual({ include_usage: true })
    expect(requestBodies[1].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(requestBodies[1].thinking).toEqual({ type: "enabled" })
    expect(requestBodies[2].stream).toBe(true)
    expect(requestBodies[2].max_tokens).toBe(CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS)
    expect(requestBodies[2].stream_options).toEqual({ include_usage: true })
    expect(requestBodies[2].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(requestBodies[2].thinking).toBeUndefined()
    expect(requestBodies[2].tools).toBeUndefined()
    expect(requestBodies[3].stream).toBe(true)
    expect(requestBodies[3].max_tokens).toBe(CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS)
    expect(requestBodies[3].stream_options).toEqual({ include_usage: true })
    expect(requestBodies[3].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(requestBodies[3].thinking).toBeUndefined()
    expect(requestBodies[3].tools).toBeUndefined()
    expect(requestUrls).toHaveLength(4)
    expect(requestUrls.every((url) => url.startsWith("https://example.test/v1/"))).toBe(true)
    expect((agentModel as unknown as { completions: unknown }).completions).not.toBe(
      testableCompactionModel.completions
    )
  })

  it("sends round-local tool-call parity in the real compaction HTTP body", async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        const chunks = [
          {
            id: "chatcmpl-round-local",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "wire summary" },
                finish_reason: null
              }
            ]
          },
          {
            id: "chatcmpl-round-local",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          }
        ]
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      })
    )

    const compactionModel = configureContextCompactionModel(
      getModelInstance(
        {
          id: "round-local",
          model: "gpt-4",
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
          enableThinking: false
        },
        undefined,
        1,
        "context-compaction"
      )
    )
    const middleware = createCmbSummarizationMiddleware({
      model: compactionModel as never,
      backend: { write: async (path: string) => ({ path }) } as never,
      trigger: { type: "tokens", value: 1 },
      keep: { type: "tokens", value: 1 },
      maxInputTokens: 32_000
    }) as unknown as {
      wrapModelCall: (
        request: {
          messages: Array<HumanMessage | AIMessage | ToolMessage>
          state: Record<string, unknown>
          tools: unknown[]
        },
        handler: () => Promise<AIMessage>
      ) => Promise<unknown>
    }

    await middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`ORIGINAL_REQUEST ${"x".repeat(4_000)}`),
          new AIMessage({
            content: "FIRST_CALL_INTERRUPTED",
            tool_calls: [
              {
                id: "call_0",
                name: "read_file",
                args: { file_path: "first.ts" },
                type: "tool_call"
              }
            ]
          }),
          new HumanMessage(`INTERRUPTING_REQUEST ${"y".repeat(2_000)}`),
          new AIMessage({
            content: "SECOND_CALL_COMPLETED",
            tool_calls: [
              {
                id: "call_0",
                name: "read_file",
                args: { file_path: "second.ts" },
                type: "tool_call"
              }
            ]
          }),
          new ToolMessage({
            content: "SECOND_RESULT_ONLY",
            tool_call_id: "call_0",
            name: "read_file"
          }),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        tools: []
      },
      async () => new AIMessage("handled")
    )

    expect(requestBodies).toHaveLength(1)
    const body = requestBodies[0]!
    const wireMessages = body.messages as Array<{
      role: string
      content?: string
      tool_call_id?: string
      tool_calls?: Array<{ id: string; function: { arguments: string } }>
    }>
    expect(body.stream).toBe(true)
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(wireMessages[0]?.content).toContain("Do not call, request, or imitate any tool")
    expect(wireMessages[0]?.content).toContain(
      "Return only the continuation handoff as text in the final content field"
    )
    expect(wireMessages.map((message) => message.role)).toEqual(["system", "user"])
    const transcript = wireMessages[1]?.content ?? ""
    expect(transcript).toContain('<message type="ai">')
    expect(transcript).toContain('<tool_call id="call_0" name="read_file">')
    expect(transcript).toContain("first.ts")
    expect(transcript).toContain('<message type="tool" name="read_file" tool_call_id="call_0">')
    expect(transcript).toContain("was cancelled")
    expect(transcript).toContain("second.ts")
    expect(transcript).toContain("SECOND_RESULT_ONLY")
    expect(wireMessages[1]?.tool_calls).toBeUndefined()
  })

  it("propagates compaction cancellation through ChatOpenAI to the active fetch", async () => {
    const controller = new AbortController()
    const write = vi.fn(async (path: string) => ({ path }))
    const handler = vi.fn(async () => new AIMessage("handled"))
    let fetchSignal: AbortSignal | undefined
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal as AbortSignal | undefined
          if (!fetchSignal) {
            reject(new Error("missing fetch abort signal"))
            return
          }
          if (fetchSignal.aborted) {
            reject(fetchSignal.reason)
            return
          }
          fetchSignal.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true })
        })
    )
    vi.stubGlobal("fetch", fetchMock)

    const compactionModel = configureContextCompactionModel(
      getModelInstance(
        {
          id: "abort-summary",
          model: "gpt-4",
          baseUrl: "https://example.test/v1",
          apiKey: "test-key",
          enableThinking: false
        },
        undefined,
        3,
        "context-compaction"
      )
    )
    const middleware = createCmbSummarizationMiddleware({
      model: compactionModel as never,
      backend: { write } as never,
      trigger: { type: "tokens", value: 1 },
      keep: { type: "tokens", value: 1 },
      maxInputTokens: 32_000
    }) as unknown as {
      wrapModelCall: (
        request: {
          messages: HumanMessage[]
          state: Record<string, unknown>
          runtime: { signal: AbortSignal }
          tools: unknown[]
        },
        handler: () => Promise<AIMessage>
      ) => Promise<unknown>
    }

    const run = middleware.wrapModelCall(
      {
        messages: [
          new HumanMessage(`OLD_CONTEXT ${"x".repeat(4_000)}`),
          new HumanMessage("RECENT_MESSAGE_TO_KEEP")
        ],
        state: {},
        runtime: { signal: controller.signal },
        tools: []
      },
      handler
    )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchSignal?.aborted).toBe(false)
    controller.abort()

    await expect(run).rejects.toBeDefined()
    expect(fetchSignal?.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("hides summary output and emits a complete lifecycle", () => {
    const events: ContextCompactionLifecycleEvent[] = []
    const configured = configureContextCompactionModel(new FakeConfigurableModel(), (event) =>
      events.push(event)
    ) as { config: RunnableConfig }

    expect(configured.config.tags).toEqual([
      CONTEXT_COMPACTION_NO_STREAM_TAG,
      CONTEXT_COMPACTION_MODEL_TAG
    ])
    const callbacks = configured.config.callbacks
    expect(Array.isArray(callbacks)).toBe(true)
    const handler = (callbacks as ContextCompactionCallbackHandler[])[0]

    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(240)
    handler.handleChatModelStart({}, [], "summary-run")
    handler.handleLLMEnd({}, "summary-run")

    expect(events).toEqual([
      { id: "summary-run", phase: "started", startedAt: 100 },
      {
        id: "summary-run",
        phase: "completed",
        startedAt: 100,
        finishedAt: 240
      }
    ])
  })

  it("emits a failed terminal event and ignores duplicate finishes", () => {
    const events: ContextCompactionLifecycleEvent[] = []
    const handler = new ContextCompactionCallbackHandler((event) => events.push(event))
    vi.spyOn(Date, "now").mockReturnValueOnce(10).mockReturnValueOnce(20)

    handler.handleChatModelStart({}, [], "failed-run")
    handler.handleLLMError(new Error("summary failed"), "failed-run")
    handler.handleLLMEnd({}, "failed-run")

    expect(events).toEqual([
      { id: "failed-run", phase: "started", startedAt: 10 },
      { id: "failed-run", phase: "failed", startedAt: 10, finishedAt: 20 }
    ])
  })

  it("keeps background summarization silent without adding a UI callback", () => {
    const configured = configureContextCompactionModel(new FakeConfigurableModel()) as {
      config: RunnableConfig
    }
    expect(configured.config.tags).toContain(CONTEXT_COMPACTION_NO_STREAM_TAG)
    expect(configured.config.callbacks).toBeUndefined()
  })
})
