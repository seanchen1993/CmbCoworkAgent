import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatOpenAICompletions } from "@langchain/openai"
import * as storage from "../storage"
import { getModelInstance } from "./runtime"
import { isRetryableApiError, isRetryableManagedProviderError } from "./failover"

const config = {
  id: "maodou-ultra",
  model: "ultra",
  apiKey: "test-key",
  baseUrl: "http://idle.example.test/pattern/llm/v1",
  transport: "idle-gateway" as const
}

function reply(streaming = false): Response {
  if (streaming) {
    const chunk = {
      id: "reply",
      object: "chat.completion.chunk",
      created: 1,
      model: "pro",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" }
    })
  }
  return new Response(
    JSON.stringify({
      id: "reply",
      object: "chat.completion",
      created: 1,
      model: "pro",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    { headers: { "content-type": "application/json" } }
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-04T06:59:59.990+08:00"))
  vi.spyOn(storage, "getUserInfo").mockReturnValue({ sapId: "12345678" })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Maodou model runtime availability", () => {
  it.each(["HTTP", "network"])(
    "blocks a %s retry when backoff crosses 07:00",
    async (failure) => {
      const send = vi.fn(async () => {
        if (failure === "network") throw new TypeError("fetch failed")
        return new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      })
      vi.stubGlobal("fetch", send)
      vi.spyOn(Math, "random").mockReturnValue(0)
      const onRetry = vi.fn(() => vi.setSystemTime(new Date("2026-11-04T07:00:00+08:00")))
      const onRetrySuccess = vi.fn()
      const model = getModelInstance(config, { onRetry, onRetrySuccess }, 2, "agent", "thread")
      const error = await model.invoke("hello").catch((error) => error)
      expect(error).toMatchObject({ status: 400, code: "idle_model_outside_service_hours" })
      expect(isRetryableApiError(error)).toBe(false)
      expect(isRetryableManagedProviderError(error)).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetrySuccess).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    ["pro", "production", "agent"],
    ["pro", "production", "context-compaction"],
    ["ultra", "uat", "agent"],
    ["ultra", "uat", "context-compaction"]
  ] as const)(
    "sends %s %s %s requests during the day",
    async (mode, environment, purpose) => {
      vi.spyOn(ChatOpenAICompletions.prototype, "getNumTokens").mockResolvedValue(1)
      vi.setSystemTime(new Date("2026-11-04T12:00:00+08:00"))
      const send = vi.fn<typeof fetch>(async () => reply(purpose === "context-compaction"))
      vi.stubGlobal("fetch", send)
      const thinkingConfig = {
        ...config,
        model: mode,
        idleModelEnvironment: environment,
        enableThinking: true,
        enableThinkingEffort: true,
        thinkingEffort: "high" as const
      }
      const model = getModelInstance(thinkingConfig, undefined, 2, purpose, "thread")
      expect((await model.invoke("daytime request")).content).toBe("ok")
      expect(send).toHaveBeenCalledTimes(1)
      const payload = JSON.parse(String(send.mock.calls[0][1]?.body))
      expect(payload.model).toBe(mode)
      expect(payload.chat_template_kwargs).toEqual(
        purpose === "agent"
          ? { enable_thinking: true, reasoning_effort: "high" }
          : { enable_thinking: false }
      )
    }
  )

  it("lets an existing SSE stream finish after 07:00 and blocks its next round", async () => {
    vi.spyOn(ChatOpenAICompletions.prototype, "getNumTokens").mockResolvedValue(1)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let requestSignal: AbortSignal | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
      }
    })
    const send = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      markStarted()
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    })
    vi.stubGlobal("fetch", send)
    const model = getModelInstance(config, undefined, 2, "context-compaction", "thread")
    const result = model.invoke("already sent")
    await started
    vi.setSystemTime(new Date("2026-11-04T07:00:01+08:00"))
    const chunk = {
      id: "stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "pro",
      choices: [
        { index: 0, delta: { role: "assistant", content: "finished" }, finish_reason: "stop" }
      ]
    }
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
    stream.close()
    expect((await result).content).toBe("finished")
    expect(requestSignal?.aborted).toBe(false)
    await expect(model.invoke("next tool round")).rejects.toMatchObject({
      status: 400,
      code: "idle_model_outside_service_hours"
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
