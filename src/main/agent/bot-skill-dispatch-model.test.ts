import { afterEach, expect, it, vi } from "vitest"
import { getModelInstance } from "./runtime"

afterEach(() => vi.unstubAllGlobals())
it("uses non-thinking single-tool routing without changing executor or ordinary model settings", async () => {
  const bodies: any[] = []
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({
      id: "fixture", object: "chat.completion", created: 1, model: "deepseek-fixture",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { "content-type": "application/json" } })
  }))
  const config = { id: "fixture", model: "deepseek-fixture", baseUrl: "https://example.test/v1",
    apiKey: "synthetic-key", enableThinking: true, interleavedThinking: true }
  const dispatch = getModelInstance(config, undefined, 1, "bot-skill-dispatch")
  expect(dispatch.disableStreaming).toBe(true)
  await dispatch.invoke("route", { tool_choice: { type: "function", function: { name: "bot_skill_dispatch" } } })
  await getModelInstance(config).invoke("execute")
  expect(bodies[0]).toMatchObject({ thinking: { type: "disabled" }, parallel_tool_calls: false,
    tool_choice: { type: "function", function: { name: "bot_skill_dispatch" } } })
  expect(bodies[1]).toMatchObject({ thinking: { type: "enabled" }, parallel_tool_calls: true })
  expect(config.enableThinking).toBe(true)
})
