import { describe, it, expect, vi } from "vitest"
import { AIMessageChunk } from "@langchain/core/messages"
const fixtures = vi.hoisted(() => ({ create: vi.fn(), lookup: vi.fn(), stream: vi.fn() }))
vi.mock("../../agent/runtime", () => ({ getModelInstance: fixtures.create }))
vi.mock("../../models/registry", () => ({
  getAvailableModelConfigOrDefault: fixtures.lookup,
  getModelConfigByRef: fixtures.lookup
}))
import { invokeBuiltinAdvisor } from "./advisor-model"
describe("advisor provider adapter", () => {
  it("uses configured protocol without tools or retries and caps output", async () => {
    fixtures.lookup.mockReturnValue({ id: "fixture", model: "local-test", maxOutputTokens: 4000 })
    fixtures.create.mockReturnValue({ stream: fixtures.stream })
    fixtures.stream.mockImplementation(async function* () {
      yield new AIMessageChunk({
        content: "先核对未确认结果。",
        usage_metadata: { input_tokens: 50, output_tokens: 8, total_tokens: 58 }
      })
    })
    const controller = new AbortController()
    expect(await invokeBuiltinAdvisor('{"unknown":1}', controller.signal)).toEqual({
      text: "先核对未确认结果。",
      inputTokens: 50,
      outputTokens: 8
    })
    expect(fixtures.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maxOutputTokens: 512,
        enableThinking: false,
        enableThinkingEffort: false
      }),
      undefined,
      1,
      "function-completion"
    )
    const [messages, options] = fixtures.stream.mock.calls.at(-1)!
    expect(messages).toHaveLength(2)
    expect(messages[1].content).toBe('{"unknown":1}')
    expect(options.signal).toBe(controller.signal)
    expect(options.tools).toBeUndefined()
    expect(options.callbacks).toEqual([])
  })
  it("rejects tool calls, oversized output and interrupted streams", async () => {
    fixtures.create.mockReturnValue({ stream: fixtures.stream })
    fixtures.lookup.mockReturnValue({ id: "fixture", model: "local-test" })
    fixtures.stream.mockImplementation(async function* () {
      yield new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ name: "write_file", args: "{}", id: "call", index: 0 }]
      })
    })
    await expect(invokeBuiltinAdvisor("{}", new AbortController().signal)).rejects.toThrow(
      "TOOL_CALL_REJECTED"
    )
    fixtures.stream.mockImplementation(async function* () {
      yield new AIMessageChunk("x".repeat(6001))
    })
    await expect(invokeBuiltinAdvisor("{}", new AbortController().signal)).rejects.toThrow(
      "OUTPUT_LIMIT"
    )
    const abort = new AbortController()
    fixtures.stream.mockImplementation(async function* () {
      abort.abort(Error("fixture stopped"))
      yield new AIMessageChunk("late")
    })
    await expect(invokeBuiltinAdvisor("{}", abort.signal)).rejects.toThrow("fixture stopped")
  })
})
