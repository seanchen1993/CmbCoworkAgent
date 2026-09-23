import { expect, it } from "vitest"
import { startRealModelRelay } from "../support/mods-real-model-relay"

it("forwards real responses while keeping credentials out of caller data and diagnostics", async () => {
  const calls: Array<{ url: string; body: unknown; authorization: string | null }> = []
  const relay = await startRealModelRelay({
    baseUrl: "https://provider.example/v1",
    model: "configured-model",
    apiKey: "private-key",
    requestLimit: 1,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization")
      })
      return new Response(
        'data: {"choices":[{"delta":{"content":"real output"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } }
      )
    }
  })
  try {
    expect((await fetch(relay.url + "/unexpected", { method: "POST" })).status).toBe(404)
    const response = await fetch(relay.url + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "dummy", messages: [], stream: true })
    })
    expect(await response.text()).toContain("real output")
    expect(calls).toEqual([
      {
        url: "https://provider.example/v1/chat/completions",
        body: { model: "configured-model", messages: [], stream: true },
        authorization: "Bearer private-key"
      }
    ])
    expect(JSON.stringify(relay.metrics)).not.toContain("private-key")
    expect(JSON.stringify(relay.metrics)).not.toContain("provider.example")
    expect(
      (await fetch(relay.url + "/chat/completions", { method: "POST", body: "{}" })).status
    ).toBe(429)
    expect(calls).toHaveLength(1)
  } finally {
    await relay.close()
  }
})

it("rejects insecure upstreams and redacts upstream errors", async () => {
  await expect(
    startRealModelRelay({ baseUrl: "http://provider.example", model: "model", apiKey: "secret" })
  ).rejects.toThrow("DEMO_HTTPS_REQUIRED")
  const relay = await startRealModelRelay({
    baseUrl: "https://provider.example",
    model: "model",
    apiKey: "secret",
    fetch: async () => new Response("secret provider diagnostics", { status: 401 })
  })
  try {
    const response = await fetch(relay.url + "/chat/completions", { method: "POST", body: "{}" })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("secret")
    expect(relay.metrics[0].status).toBe(401)
  } finally {
    await relay.close()
  }
})
