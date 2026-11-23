import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import { configureContextCompactionModel } from "./context-compaction"
import { contextWindowFromError } from "./context-compaction-recovery"
import * as storage from "../storage"
import { getModelInstance } from "./runtime"
import { createCmbSummarizationMiddleware } from "./context-summarization-middleware"

const OVERFLOW_MESSAGE = "模型服务内部异常或当前任务上下文超过最大限度"
const config = {
  id: "idle-ultra",
  model: "pro",
  apiKey: "gateway-test-key",
  baseUrl: "http://gateway.example.test/pattern/llm/v1",
  transport: "idle-gateway" as const
}

function gatewayError(status: number, errorMsg = OVERFLOW_MESSAGE): Response {
  return new Response(JSON.stringify({ returnCode: `XCDZB${status}`, errorMsg }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": `gateway-${status}` }
  })
}

function summaryResponse(): Response {
  const summary =
    "## Goal\nContinue the user's task.\n## Current State\nThe old conversation was summarized.\n## Next Step\nAnswer the latest request."
  const events = [
    {
      choices: [{ index: 0, delta: { role: "assistant", content: summary }, finish_reason: null }]
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
  ]
  return new Response(
    events
      .map(
        (event) =>
          `data: ${JSON.stringify({ id: "summary-1", object: "chat.completion.chunk", model: "actual-model", created: 1, ...event })}\n\n`
      )
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "content-type": "text/event-stream" }
    }
  )
}

const modelError = {
  message:
    "This model's maximum context length is 1048576 tokens. However, you requested " +
    "1 output tokens and your prompt contains at least 1048576 input tokens, " +
    "for a total of at least 1048577 tokens. (parameter=input_tokens, value=1048576)",
  type: "BadRequestError",
  param: "input_tokens",
  code: 400
}
const lailasEnvelope = {
  returnCode: "LAILAS1485",
  errorMsg: "输入参数异常. " + JSON.stringify({ error: modelError })
}
const customConfig = {
  id: "custom",
  model: "deepseek-v4-flash",
  apiKey: "test",
  baseUrl: "https://example.test/v1"
}

describe("LAILAS gateway errors on ordinary model connections", () => {
  it.each([
    { scenario: "automatic compaction", trigger: 4, expectedStreams: [true, true, false] },
    { scenario: "main request overflow", trigger: 100, expectedStreams: [false, true, true, false] }
  ])(
    "shortens a rejected summary after $scenario and continues the latest task",
    async ({ trigger, expectedStreams }) => {
      const requests: Array<{ stream?: boolean; messages: unknown[] }> = []
      let rejectedSummary = false
      vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        requests.push(body)
        if (requests.length === 1 || (body.stream && !rejectedSummary)) {
          if (body.stream) rejectedSummary = true
          return new Response(JSON.stringify(lailasEnvelope), { status: 485 })
        }
        return body.stream ? summaryResponse() : finalResponse()
      })
      const phases: string[] = []
      const model = getModelInstance(customConfig, undefined, 1, "context-compaction")
      const middleware = createCmbSummarizationMiddleware({
        model: configureContextCompactionModel(model, (event) =>
          phases.push(event.phase)
        ) as typeof model,
        backend: {
          write: async (path: string) => ({ path }),
          downloadFiles: async () => []
        } as never,
        trigger: { type: "messages", value: trigger },
        keep: { type: "messages", value: 1 },
        trimTokensToSummarize: 650_000,
        maxInputTokens: 1_000_000
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          next: (request: { messages: BaseMessage[] }) => Promise<unknown>
        ) => Promise<Command>
      }
      const history = Array.from(
        { length: 10 },
        (_, i) =>
          new HumanMessage("Historical request " + i + " " + "historical information ".repeat(120))
      )
      const agent = getModelInstance(customConfig, undefined, 1, "agent")
      const result = await middleware.wrapModelCall(
        {
          messages: [...history, new HumanMessage("LATEST_TASK")],
          state: {},
          tools: []
        },
        (request) => agent.invoke(request.messages)
      )
      expect(result).toBeInstanceOf(Command)
      expect(phases).toEqual(["started", "failed", "started", "completed"])
      expect(requests.map((body) => Boolean(body.stream))).toEqual(expectedStreams)
      const [firstSummary, shorterSummary, finalRequest] = requests.slice(-3)
      expect(Buffer.byteLength(JSON.stringify(shorterSummary.messages))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(firstSummary.messages))
      )
      expect(JSON.stringify(finalRequest.messages)).toContain("LATEST_TASK")
    }
  )

  it.each([
    { body: lailasEnvelope, expected: modelError.message, limit: 1048576 },
    {
      body: { ...lailasEnvelope, errorMsg: "输入参数异常. invalid input" },
      expected: "no body",
      limit: undefined
    },
    { body: { ...lailasEnvelope, returnCode: "OTHER485" }, expected: "no body", limit: undefined },
    {
      body: { ...lailasEnvelope, errorMsg: "输入参数异常. {invalid json" },
      expected: "no body",
      limit: undefined
    },
    {
      body: {
        ...lailasEnvelope,
        errorMsg: JSON.stringify({
          error: {
            ...modelError,
            message: "Invalid input_tokens value. Maximum context length is 1048576 tokens."
          }
        })
      },
      expected: "no body",
      limit: undefined
    },
    {
      body: { ...lailasEnvelope, error: { message: "another provider error" } },
      expected: "another provider error",
      limit: undefined
    }
  ])(
    "preserves the raw diagnostics and SDK status for $expected",
    async ({ body, expected, limit }) => {
      const rawBody = JSON.stringify(body)
      const response = new Response(rawBody, {
        status: 485,
        headers: {
          "content-type": "application/json",
          "x-request-id": "original-request"
        }
      })
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response)
      )
      const clone = vi.spyOn(response, "clone")
      const onFetchError = vi.fn()
      const model = getModelInstance(customConfig, { onFetchError }, 1, "agent")
      const error = await model.invoke("hello").catch((err: unknown) => err)
      expect(error).toMatchObject({ message: expect.stringContaining(expected) })
      const sdkError = error instanceof Error ? (error.cause ?? error) : error
      expect(sdkError).toMatchObject({ status: 485, requestID: "original-request" })
      expect(contextWindowFromError(error)).toBe(limit)
      expect(clone).toHaveBeenCalledTimes(1)
      expect(onFetchError).toHaveBeenCalledExactlyOnceWith({
        status: 485,
        requestId: "original-request",
        rawBody
      })
    }
  )

  it("keeps a successful non-streaming response on the zero-clone path", async () => {
    const response = finalResponse()
    const clone = vi.spyOn(response, "clone")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    )
    const onFetchError = vi.fn()
    const model = getModelInstance(customConfig, { onFetchError }, 1, "agent")
    expect((await model.invoke("hello")).content).toBe("RECOVERED")
    expect(clone).not.toHaveBeenCalled()
    expect(onFetchError).not.toHaveBeenCalled()
  })

  it.each(["cancel", "timeout"])("aborts a stalled 485 body on %s", async (action) => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    const caller = new AbortController()
    let transportSignal: AbortSignal | undefined
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let reading!: () => void
    const startedReading = new Promise<void>((resolve) => {
      reading = resolve
    })
    const send = vi.fn(async (_url: unknown, init: RequestInit) => {
      transportSignal = init.signal!
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller
          init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), {
            once: true
          })
        }
      })
      const response = new Response(stream, { status: 485 })
      const clone = response.clone.bind(response)
      vi.spyOn(response, "clone").mockImplementation(() => {
        reading()
        return clone()
      })
      return response
    })
    vi.stubGlobal("fetch", send)
    // Leave one retry available to catch an accidental resend of the same 485 request.
    const model = getModelInstance(customConfig, undefined, 2, "context-compaction")
    const result = model
      .invoke("summary", { signal: caller.signal })
      .catch((error: unknown) => error)
    try {
      await startedReading
      if (action === "cancel") caller.abort()
      else await vi.advanceTimersByTimeAsync(60_000)
      expect(transportSignal?.aborted).toBe(true)
    } finally {
      if (!transportSignal?.aborted) body?.close()
    }
    const error = await result
    expect(error).toBeInstanceOf(Error)
    if (action === "cancel")
      expect(error).toMatchObject({ message: expect.stringMatching(/abort/i) })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

function finalResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "recovered-1",
      object: "chat.completion",
      model: "actual-model",
      created: 1,
      choices: [
        { index: 0, message: { role: "assistant", content: "RECOVERED" }, finish_reason: "stop" }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    }),
    { headers: { "content-type": "application/json" } }
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-03T22:30:00+08:00"))
  vi.spyOn(storage, "getUserInfo").mockReturnValue({ sapId: "12345678" })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("gateway context overflow through the real agent transport", () => {
  it.each([
    { status: 485, environment: "production" as const },
    { status: 580, environment: "production" as const },
    { status: 485, environment: "uat" as const },
    { status: 580, environment: "uat" as const }
  ])(
    "compacts and resends $environment status $status without an unchanged HTTP retry",
    async ({ status, environment }) => {
      if (environment === "uat") {
        vi.setSystemTime(new Date("2026-11-03T12:00:00+08:00"))
      }
      const environmentConfig = { ...config, idleModelEnvironment: environment }
      const requests: Array<{
        headers: Headers
        body: { stream?: boolean; messages: Array<{ role: string; content?: unknown }> }
      }> = []
      const send = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        requests.push({ headers: new Headers(init?.headers), body })
        if (requests.length === 1) return gatewayError(status)
        if (body.stream) return summaryResponse()
        return finalResponse()
      })
      vi.stubGlobal("fetch", send)
      const onRetry = vi.fn()
      const onFetchError = vi.fn()
      const hooks = { onRetry, onFetchError }
      const threadId = "12345678-1234-1234-1234-123456789012__wf_run12345_a0"
      const agentModel = getModelInstance(environmentConfig, hooks, 6, "agent", threadId)
      const summaryModel = getModelInstance(
        environmentConfig,
        hooks,
        6,
        "context-compaction",
        threadId
      )
      const middleware = createCmbSummarizationMiddleware({
        model: summaryModel,
        backend: {
          write: async (path: string) => ({ path }),
          downloadFiles: async () => []
        } as never,
        trigger: { type: "messages", value: 100 },
        keep: { type: "messages", value: 1 },
        maxInputTokens: 128_000
      }) as unknown as {
        wrapModelCall: (
          request: unknown,
          handler: (request: { messages: BaseMessage[] }) => Promise<unknown>
        ) => Promise<Command>
      }
      const result = await middleware.wrapModelCall(
        {
          messages: [
            new HumanMessage(`OLD_CONTEXT ${"x".repeat(4_000)}`),
            new HumanMessage("LATEST_TASK")
          ],
          state: {},
          tools: []
        },
        (request) => agentModel.invoke(request.messages)
      )

      expect(result).toBeInstanceOf(Command)
      expect(send).toHaveBeenCalledTimes(3)
      expect(requests.map((request) => Boolean(request.body.stream))).toEqual([false, true, false])
      const sessionIds = requests.map((request) => request.headers.get("x-session-id"))
      expect(sessionIds[0]).toMatch(/^[a-f0-9]{36}$/)
      expect(sessionIds).toEqual(Array(3).fill(sessionIds[0]))
      expect(JSON.stringify(requests[2].body.messages)).toContain("LATEST_TASK")
      // The initial request remains as a bounded anchor; its full oversized body is removed.
      expect(JSON.stringify(requests[2].body.messages)).not.toContain("x".repeat(4_000))
      expect(JSON.stringify(requests[2].body.messages).length).toBeLessThan(
        JSON.stringify(requests[0].body.messages).length
      )
      expect(onRetry).not.toHaveBeenCalled()
      expect(onFetchError).toHaveBeenCalledWith(
        expect.objectContaining({ status, requestId: `gateway-${status}` })
      )
    }
  )

  it.each([580, 500])(
    "keeps normal retry behavior for an unrelated status %s failure",
    async (status) => {
      const send = vi.fn(async () =>
        gatewayError(status, status === 580 ? "模型服务内部异常" : OVERFLOW_MESSAGE)
      )
      vi.stubGlobal("fetch", send)
      const controller = new AbortController()
      const onRetry = vi.fn(() => controller.abort())
      const model = getModelInstance(config, { onRetry }, 2, "agent", "retry-thread")

      // Cancel at the retry notification to verify the path without waiting for backoff.
      await expect(model.invoke("hello", { signal: controller.signal })).rejects.toThrow()
      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ reason: `HTTP ${status}` }))
      expect(send).toHaveBeenCalledTimes(1)
    }
  )
})
