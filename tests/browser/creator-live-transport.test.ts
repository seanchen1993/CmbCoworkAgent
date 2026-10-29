import { createServer, type ServerResponse } from "node:http"
import { ChatOpenAI } from "@langchain/openai"
import { expect, it, vi } from "vitest"
import { rejectCreatorLiveRelay } from "../support/creator-live-transport"

it("lets the original model client retry one transient relay failure within its own limit", async () => {
  let requests = 0
  const terminal = vi.fn()
  const relay = createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk
    }
    requests++
    if (requests === 1)
      return rejectCreatorLiveRelay(response, "UPSTREAM_NETWORK_ERROR", 502, terminal)
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "local-retry-result",
        object: "chat.completion",
        created: 1,
        model: "local-only",
        choices: [
          { index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  try {
    const address = relay.address()
    if (!address || typeof address === "string") throw Error("LOCAL_RELAY_ADDRESS")
    const model = new ChatOpenAI({
      model: "local-only",
      apiKey: "localhost-dummy-only",
      maxRetries: 1,
      timeout: 5000,
      configuration: { baseURL: `http://127.0.0.1:${address.port}/v1` }
    })
    expect((await model.invoke("transport regression")).content).toBe("recovered")
    expect(requests).toBe(2)
    expect(terminal).not.toHaveBeenCalled()
  } finally {
    relay.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

it("keeps authentication, payment and acceptance limits terminal", () => {
  for (const code of [
    "UPSTREAM_HTTP_401",
    "UPSTREAM_HTTP_402",
    "UPSTREAM_HTTP_403",
    "LIVE_CHAT_REQUEST_LIMIT",
    "LIVE_TOTAL_TIME_LIMIT",
    "LIVE_RUNTIME_FILE_SCOPE_REJECTED"
  ]) {
    const terminal = vi.fn()
    const response = { headersSent: false, writeHead: vi.fn(), end: vi.fn() }
    rejectCreatorLiveRelay(response as unknown as ServerResponse, code, 502, terminal)
    expect(terminal).toHaveBeenCalledExactlyOnceWith(code)
    const value = JSON.parse(response.end.mock.calls[0][0])
    expect(value.error).toEqual({
      code,
      message: code,
      origin: code.startsWith("UPSTREAM_") ? "provider" : "acceptance-harness"
    })
  }
})

it("leaves retryable errors nonterminal and never appends JSON to an interrupted stream", () => {
  for (const code of [
    "UPSTREAM_HTTP_408",
    "UPSTREAM_HTTP_429",
    "UPSTREAM_HTTP_503",
    "UPSTREAM_NETWORK_ERROR"
  ]) {
    const terminal = vi.fn()
    const response = { headersSent: true, destroy: vi.fn(), writeHead: vi.fn(), end: vi.fn() }
    rejectCreatorLiveRelay(response as unknown as ServerResponse, code, 502, terminal)
    expect(terminal).not.toHaveBeenCalled()
    expect(response.destroy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: code })
    )
    expect(response.writeHead).not.toHaveBeenCalled()
    expect(response.end).not.toHaveBeenCalled()
  }
})
