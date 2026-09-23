import { createServer, type ServerResponse } from "node:http"
import { once } from "node:events"
import { HumanMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { afterEach, expect, it } from "vitest"
import { getModelInstance } from "./runtime"
import { CompletionBudget, withCompletionBudget } from "../mods/v2/completion-budget"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function events(input = 100, output = 20, delta: unknown = { content: "ok" }, usage = true) {
  const chunks = [
    {
      id: "budget",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }]
    },
    {
      id: "budget",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    }
  ]
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    (usage
      ? `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            total_tokens: input + output,
            prompt_tokens_details: { cached_tokens: 50 }
          }
        })}\n\n`
      : "") +
    "data: [DONE]\n\n"
  )
}

async function server(
  reply: (body: Record<string, unknown>, response: ServerResponse, index: number) => void
) {
  const requests: Record<string, unknown>[] = []
  const http = createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk.toString()
    const body = JSON.parse(text)
    requests.push(body)
    reply(body, response, requests.length - 1)
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanups.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const address = http.address() as { port: number }
  const config = {
    id: "budget",
    model: "budget-fixture",
    apiKey: "test-only",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxOutputTokens: 32000
  }
  return { requests, config }
}

async function consume(model: ReturnType<typeof getModelInstance>, signal?: AbortSignal) {
  let text = ""
  for await (const chunk of await model.stream([new HumanMessage("repair")], { signal }))
    text += chunk.content
  return text
}

it("caps the actual HTTP output limit and accounts raw input/output without double-counting cache", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(events())
  })
  const budget = new CompletionBudget(4000, 10000)
  await withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  expect(f.requests[0].max_tokens).toBeLessThan(4000)
  expect(budget.inputTokens).toBe(100)
  expect(budget.outputTokens).toBe(20)
})

it("includes serialized tool schema in admission and makes no HTTP call when it exceeds the total", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(events())
  })
  const budget = new CompletionBudget(1000, 10000)
  const inspect = tool(async () => "ok", {
    name: "inspect",
    description: "large tool ".repeat(300),
    schema: z.object({ query: z.string() })
  })
  const agent = createAgent({ model: getModelInstance(f.config, undefined, 1), tools: [inspect] })
  await expect(
    withCompletionBudget(budget, async () => {
      for await (const _chunk of await agent.stream(
        { messages: [new HumanMessage("repair")] },
        { streamMode: "messages" }
      )) {
        void _chunk
      }
    })
  ).rejects.toThrow()
  expect(() => budget.assert()).toThrow("MODS_COMPLETION_MODEL_BUDGET")
  expect(f.requests).toHaveLength(0)
})

it("cannot approve a provider stream whose real usage is absent", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(events(0, 0, undefined, false))
  })
  const budget = new CompletionBudget(4000, 10000)
  await expect(
    withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  ).rejects.toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
})

it("keeps the existing unbudgeted model request unchanged", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(events())
  })
  expect(await consume(getModelInstance(f.config, undefined, 1))).toBe("ok")
  expect(f.requests[0].max_tokens).toBe(32000)
})

it("charges summary and a real tool child Agent to the parent's repair scope", async () => {
  const f = await server((_body, response, index) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(
      events(
        100,
        20,
        index === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "child",
                  type: "function",
                  function: { name: "inspect", arguments: "{}" }
                }
              ]
            }
          : { content: "ok" }
      )
    )
  })
  const budget = new CompletionBudget(16000, 20000)
  const inspect = tool(
    async () => {
      await consume(getModelInstance(f.config, undefined, 1, "context-compaction"))
      const child = createAgent({ model: getModelInstance(f.config, undefined, 1), tools: [] })
      for await (const _chunk of await child.stream(
        { messages: [new HumanMessage("child repair")] },
        { streamMode: "messages" }
      )) {
        void _chunk
      }
      return "reviewed"
    },
    { name: "inspect", description: "inspect", schema: z.object({}) }
  )
  const agent = createAgent({ model: getModelInstance(f.config, undefined, 1), tools: [inspect] })
  await withCompletionBudget(budget, async () => {
    for await (const _chunk of await agent.stream(
      { messages: [new HumanMessage("repair")] },
      { streamMode: "messages" }
    )) {
      void _chunk
    }
  })
  expect(f.requests).toHaveLength(4)
  expect(budget.inputTokens).toBe(400)
  expect(budget.outputTokens).toBe(80)
})

it("settles fragmented and duplicate cumulative SSE usage once", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    const duplicate = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`
    const data = events().replace("data: [DONE]", `${duplicate}data: [DONE]`)
    for (let index = 0; index < data.length; index += 7)
      response.write(data.slice(index, index + 7))
    response.end()
  })
  const budget = new CompletionBudget(4000, 10000)
  await withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  expect(budget.inputTokens).toBe(100)
  expect(budget.outputTokens).toBe(20)
})

it("reserves each real retry and keeps known zero-usage failures separate", async () => {
  const f = await server((_body, response, index) => {
    if (!index) {
      response.writeHead(429, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          error: { message: "retry", type: "rate_limit" },
          usage: { prompt_tokens: 0, completion_tokens: 0 }
        })
      )
    } else {
      response.setHeader("content-type", "text/event-stream")
      response.end(events())
    }
  })
  const budget = new CompletionBudget(4000, 15000)
  await withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 2)))
  expect(f.requests).toHaveLength(2)
  expect(budget.inputTokens).toBe(100)
  expect(budget.outputTokens).toBe(20)
  expect(budget.outputReserved).toBeGreaterThan(Number(f.requests[0].max_tokens))
})

it("does not hide unknown failed-attempt usage behind a successful retry", async () => {
  const f = await server((_body, response) => {
    response.writeHead(502, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "unavailable" } }))
  })
  const budget = new CompletionBudget(4000, 15000)
  await expect(
    withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 3)))
  ).rejects.toThrow()
  expect(f.requests).toHaveLength(1)
  expect(() => budget.assert()).toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
})

it("actively aborts a real response body when the repair deadline expires", async () => {
  let closed = false
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.write('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n')
    response.on("close", () => {
      closed = true
    })
  })
  const budget = new CompletionBudget(4000, 300)
  await expect(
    withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  ).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(closed).toBe(true)
  expect(() => budget.assert()).toThrow(/MODS_COMPLETION_(TIMEOUT|USAGE_UNAVAILABLE)/)
})

it("leaves SDK function-completion settlement to its existing host accounting boundary", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(events())
  })
  const budget = new CompletionBudget(4000, 10000)
  await withCompletionBudget(budget, () =>
    consume(getModelInstance(f.config, undefined, 1, "function-completion"))
  )
  expect(budget.inputTokens).toBe(0)
  expect(budget.outputTokens).toBe(0)
  expect(f.requests[0].max_tokens).toBe(32000)
})

it("bounds multi-line SSE events even when the provider never sends a blank delimiter", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.write(("data: " + " ".repeat(1024) + "\n").repeat(1100))
  })
  const budget = new CompletionBudget(4000, 1500)
  await expect(
    withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  ).rejects.toThrow("MODS_COMPLETION_USAGE_LIMIT")
})

it("rejects new usage after the provider's terminal marker", async () => {
  const f = await server((_body, response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(
      events() +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10000, completion_tokens: 20000 } })}\n\n`
    )
  })
  const budget = new CompletionBudget(4000, 10000)
  await expect(
    withCompletionBudget(budget, () => consume(getModelInstance(f.config, undefined, 1)))
  ).rejects.toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
})
