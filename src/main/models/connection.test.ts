import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { getModelConnection, getModelClientOptions } from "./connection"

const state = vi.hoisted(() => ({ sapId: "12345678" as string | undefined }))
vi.mock("../storage", () => ({ getUserInfo: () => ({ sapId: state.sapId }) }))

const config = {
  baseUrl: "http://idle.example.test/pattern/llm/v1",
  apiKey: "gateway-test-key",
  transport: "idle-gateway" as const
}

function jsonReply() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "actual-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }),
    { headers: { "content-type": "application/json" } }
  )
}

beforeEach(() => {
  state.sapId = "12345678"
})

describe("idle gateway OpenAI transport", () => {
  it("sends the UAT path, employee identity and gateway key with stable per-thread sessions", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body))
      })
      return jsonReply()
    })
    const make = (sessionId: string) =>
      new ChatOpenAI({
        model: "pro",
        apiKey: config.apiKey,
        ...getModelClientOptions(config, { sessionId, fetch: send })
      })
    await make("thread-a").invoke("hello")
    await make("thread-a").invoke("compaction")
    await make("thread-b").invoke("hello")
    expect(requests.map((item) => item.url)).toEqual(
      Array(3).fill(config.baseUrl + "/chat/completions")
    )
    expect(requests.map((item) => item.body.model)).toEqual(["ultra", "ultra", "ultra"])
    expect(requests.map((item) => item.headers.get("x-session-id"))).toEqual([
      "thread-a",
      "thread-a",
      "thread-b"
    ])
    expect(new Set(requests.map((item) => item.headers.get("x-request-id"))).size).toBe(3)
    for (const { headers } of requests) {
      expect(headers.get("x-spaid")).toBe("12345678")
      expect(headers.get("x-gateway-key")).toBe(config.apiKey)
      expect(headers.has("authorization")).toBe(false)
    }
  })

  it.each([undefined, "", "123456", "abcdefgh"])(
    "blocks missing or invalid SAP identity %s before sending",
    (sapId) => {
      state.sapId = sapId
      const send = vi.fn()
      expect(() => getModelConnection(config, { fetch: send })).toThrow("八位 SAP")
      expect(send).not.toHaveBeenCalled()
    }
  )

  it("revalidates identity after an account change", async () => {
    const send = vi.fn(async () => jsonReply())
    const model = new ChatOpenAI({
      model: "ultra",
      apiKey: config.apiKey,
      maxRetries: 0,
      ...getModelClientOptions(config, { fetch: send })
    })
    state.sapId = undefined
    await expect(model.invoke("hello")).rejects.toThrow("八位 SAP")
    expect(send).not.toHaveBeenCalled()
  })

  it("preserves streamed tool-call fragments and accepts the tool result on the next request", async () => {
    const bodies: Array<{
      messages: Array<{ role: string; tool_call_id?: string }>
      tools: unknown[]
    }> = []
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const afterTool = body.messages.at(-1)?.role === "tool"
      const deltas = afterTool
        ? [{ content: "README read" }]
        : [
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":' }
                }
              ]
            },
            { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }
          ]
      const events: Array<Record<string, unknown>> = deltas.map((delta) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gateway-selected-model",
        choices: [{ index: 0, delta, finish_reason: null }]
      }))
      events.push({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gateway-selected-model",
        choices: [{ index: 0, delta: {}, finish_reason: afterTool ? "stop" : "tool_calls" }]
      })
      const usage = {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gateway-selected-model",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
      return new Response(
        [...events, usage].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    const model = new ChatOpenAI({
      model: "ultra",
      apiKey: config.apiKey,
      streaming: true,
      ...getModelClientOptions(config, { sessionId: "tool-thread", fetch: send })
    }).bindTools([
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"]
          }
        }
      }
    ])
    const human = new HumanMessage("read README")
    const call = await model.invoke([human])
    expect(call.tool_calls).toEqual([
      expect.objectContaining({ id: "call-1", name: "read_file", args: { path: "README.md" } })
    ])
    const answer = await model.invoke([
      human,
      call,
      new ToolMessage({ content: "README contents", tool_call_id: "call-1" })
    ])
    expect(answer.content).toBe("README read")
    expect(bodies[0].tools).toHaveLength(1)
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" })
  })

  it("returns the gateway balance error without SDK retries", async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            returnCode: "XCDZB434",
            errorMsg: "当前用户账号的码豆余额已不足，请充值后重试"
          }),
          {
            status: 434,
            headers: { "content-type": "application/json", "x-request-id": "gw-balance" }
          }
        )
    )
    const model = new ChatOpenAI({
      model: "ultra",
      apiKey: config.apiKey,
      ...getModelClientOptions(config, { fetch: send })
    })
    await expect(model.invoke("hello")).rejects.toMatchObject({
      status: 434,
      message: expect.stringContaining("码豆余额已不足")
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("keeps existing custom model connections unchanged", () => {
    state.sapId = undefined
    const send = vi.fn()
    expect(
      getModelConnection({ baseUrl: "https://custom.example.test/v1" }, { fetch: send })
    ).toEqual({ baseURL: "https://custom.example.test/v1", fetch: send })
  })
})
