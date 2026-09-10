import { afterEach, describe, expect, it, vi } from "vitest"
import { getModelInstance } from "./runtime"

/**
 * Protocol-level guard for the temporary deepseek/minimax sampling-param filter:
 * asserts on the JSON actually put on the wire, not just on the constructor
 * fields, so a LangChain change that started substituting defaults for omitted
 * fields would fail here.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.CMB_STRIP_SAMPLING_PARAMS
})

function stubFetchCapturingBody(bodies: Array<Record<string, unknown>>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    })
  )
}

const baseConfig = {
  id: "test",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  temperature: 0.1,
  topP: 0.95,
  topK: 40
}

async function requestBodyFor(model: string): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  stubFetchCapturingBody(bodies)
  await getModelInstance({ ...baseConfig, model }, undefined, 1).invoke("hi")
  expect(bodies).toHaveLength(1)
  return bodies[0]
}

describe("deepseek / minimax sampling params", () => {
  it("sends no temperature, top_p or top_k for deepseek", async () => {
    const body = await requestBodyFor("deepseek-v4-flash")
    expect(body).not.toHaveProperty("temperature")
    expect(body).not.toHaveProperty("top_p")
    expect(body).not.toHaveProperty("top_k")
  })

  it("sends no temperature, top_p or top_k for minimax", async () => {
    const body = await requestBodyFor("MiniMax-M2.7")
    expect(body).not.toHaveProperty("temperature")
    expect(body).not.toHaveProperty("top_p")
    expect(body).not.toHaveProperty("top_k")
  })

  it("leaves the rest of the request protocol untouched", async () => {
    // Only the three sampling params are dropped — model, token budget and the
    // thinking/tool-call kwargs must still go out exactly as before.
    const body = await requestBodyFor("deepseek-v4-flash")
    expect(body.model).toBe("deepseek-v4-flash")
    expect(body.max_tokens).toBeTypeOf("number")
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it("still sends all three for an unaffected model", async () => {
    const body = await requestBodyFor("qwen3.5-35b-a3b")
    expect(body.temperature).toBe(0.1)
    expect(body.top_p).toBe(0.95)
    expect(body.top_k).toBe(40)
  })

  it("restores the params for deepseek when the env switch is off", async () => {
    process.env.CMB_STRIP_SAMPLING_PARAMS = "0"
    const body = await requestBodyFor("deepseek-v4-flash")
    expect(body.temperature).toBe(0.1)
    expect(body.top_p).toBe(0.95)
    expect(body.top_k).toBe(40)
  })
})
