import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { Command } from "@langchain/langgraph"
import * as storage from "../storage"
import { getModelInstance } from "./runtime"
import { createCmbSummarizationMiddleware } from "./context-summarization-middleware"

const OVERFLOW_MESSAGE = "模型服务内部异常或当前任务上下文超过最大限度"
const config = {
  id: "idle-ultra",
  model: "ultra",
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
