import { HumanMessage } from "@langchain/core/messages"
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
import { getModelInstance } from "./runtime"

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
  it("keeps agent stream() on SSE and uses SSE for compaction invoke()", async () => {
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
    expect(requestBodies[1].stream).toBe(true)
    expect(requestBodies[1].stream_options).toEqual({ include_usage: true })
    expect(requestBodies[2].stream).toBe(true)
    expect(requestBodies[2].stream_options).toEqual({ include_usage: true })
    expect(requestBodies[3].stream).toBe(true)
    expect(requestBodies[3].stream_options).toEqual({ include_usage: true })
    expect(requestUrls).toHaveLength(4)
    expect(requestUrls.every((url) => url.startsWith("https://example.test/v1/"))).toBe(true)
    expect((agentModel as unknown as { completions: unknown }).completions).not.toBe(
      testableCompactionModel.completions
    )
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
