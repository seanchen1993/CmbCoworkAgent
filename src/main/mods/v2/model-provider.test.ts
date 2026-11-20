import { createServer } from "node:http"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { RunnableLambda } from "@langchain/core/runnables"
import { invokeFunctionModel } from "./model-provider"
import type { ResolvedModelConfig } from "../../models/registry"

const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  // Vitest transforms the large shared agent module on first import. The request tests below
  // measure the protocol path; production cold loading is also covered by Electron E2E.
  await import("../../agent/runtime")
}, 60000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function endpoint(mode: "text" | "stall" | "error" | "tool" = "text") {
  const bodies: Array<Record<string, unknown>> = []
  let closed = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    response.on("close", () => {
      closed = true
    })
    if (mode === "error") {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "local fixture failure" } }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.flushHeaders()
    const event = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`)
    event({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: "first " }, finish_reason: null }]
    })
    if (mode === "stall") return
    event({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          delta:
            mode === "tool"
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "forbidden",
                      type: "function",
                      function: { name: "execute", arguments: "{}" }
                    }
                  ]
                }
              : { content: "answer" },
          finish_reason: "stop"
        }
      ]
    })
    event({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
    })
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  })
  const address = server.address()
  if (!address || typeof address === "string") throw Error("Missing fixture endpoint")
  return {
    bodies,
    closed: () => closed,
    config: {
      id: "fixture",
      name: "Fixture",
      ref: "custom:fixture",
      source: "custom",
      model: "gpt-4",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-key",
      maxOutputTokens: 4096,
      enableThinking: true
    } as ResolvedModelConfig
  }
}

it("uses the real configured client with one prompt, identity, token cap, text SSE and usage", async () => {
  const f = await endpoint()
  const result = await invokeFunctionModel(
    f.config,
    { model: "fixture", prompt: "one prompt", system: "custom system", maxTokens: 32 },
    new AbortController().signal
  )
  expect(result).toEqual({ text: "first answer", inputTokens: 12, outputTokens: 3 })
  expect(f.bodies).toHaveLength(1)
  expect(f.bodies[0]).toMatchObject({
    model: "gpt-4",
    stream: true,
    max_tokens: 32,
    messages: [
      { role: "system", content: "You are CMBDevClaw, a coding assistant.\n\ncustom system" },
      { role: "user", content: "one prompt" }
    ],
    chat_template_kwargs: { enable_thinking: false }
  })
  expect(f.bodies[0]).not.toHaveProperty("tools")
}, 20000)

it("aborts a stalled response after headers without waiting for another provider chunk", async () => {
  const f = await endpoint("stall"),
    controller = new AbortController()
  const pending = invokeFunctionModel(
    f.config,
    { model: "fixture", prompt: "hi" },
    controller.signal
  )
  const rejected = expect(pending).rejects.toThrow()
  await expect.poll(() => f.bodies.length).toBe(1)
  controller.abort()
  await rejected
  await expect.poll(f.closed).toBe(true)
}, 10000)

it("does not retry a failed provider request or accept a tool call in a text completion", async () => {
  const failed = await endpoint("error")
  await expect(
    invokeFunctionModel(
      failed.config,
      { model: "fixture", prompt: "hi" },
      new AbortController().signal
    )
  ).rejects.toThrow()
  expect(failed.bodies).toHaveLength(1)
  const tools = await endpoint("tool")
  await expect(
    invokeFunctionModel(
      tools.config,
      { model: "fixture", prompt: "hi" },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_MODEL_UNEXPECTED_TOOL")
})

it("keeps nested provider events out of the caller's stream and callback observers", async () => {
  const f = await endpoint()
  const observed = vi.fn()
  const caller = RunnableLambda.from(async () => {
    const result = await invokeFunctionModel(
      f.config,
      { model: "fixture", prompt: "private nested prompt" },
      new AbortController().signal
    )
    expect(result.text).toBe("first answer")
    return "protected result"
  })
  const events: unknown[] = []
  for await (const event of caller.streamEvents("public input", {
    version: "v2",
    callbacks: [
      {
        name: "outer-observer",
        handleChatModelStart: observed,
        handleLLMNewToken: observed,
        handleLLMEnd: observed,
        handleLLMError: observed
      }
    ]
  }))
    events.push(event)
  expect(observed).not.toHaveBeenCalled()
  expect(JSON.stringify(events)).not.toMatch(/on_chat_model|private nested prompt|first |answer/)
  expect(JSON.stringify(events)).toContain("protected result")
}, 20000)
