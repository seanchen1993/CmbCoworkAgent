import { afterEach, expect, it, vi } from "vitest"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { publicFlowProgress, flowProgressReporter } from "./progress"

afterEach(() => vi.useRealTimers())
it("projects only new public assistant text and tool names, never reasoning, input or tool output", () => {
  const human = new HumanMessage("private task input")
  expect(publicFlowProgress({ messages: [new AIMessage("prior context"), human] })).toBeUndefined()
  expect(publicFlowProgress({ messages: [new AIMessage("unbound history")] })).toBeUndefined()
  const message = new AIMessage({
    content: [
      { type: "reasoning", text: "hidden reasoning" },
      { type: "text", text: "public update" }
    ]
  })
  expect(publicFlowProgress({ messages: [human, message] })).toEqual({
    phase: "model",
    text: "public update"
  })
  expect(
    publicFlowProgress({
      messages: [
        human,
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call", name: "read_file", args: { secret: "private arguments" } }]
        })
      ]
    })
  ).toEqual({ phase: "tool", toolName: "read_file" })
  expect(
    publicFlowProgress({
      messages: [human, new ToolMessage({ content: "private result", tool_call_id: "call" })]
    })
  ).toEqual({ phase: "model" })
  expect(
    publicFlowProgress({ messages: [human, new AIMessage("<think>private</think>public")] })
  ).toEqual({ phase: "model", text: "public" })
  expect(
    publicFlowProgress({ messages: [human, new AIMessage("a".repeat(50000))] })?.text?.length
  ).toBe(2000)
})

it("coalesces notifications, flushes completion and ignores late updates without affecting execution", () => {
  vi.useFakeTimers()
  const write = vi.fn(),
    notify = vi.fn()
  let current = true
  const reporter = flowProgressReporter(() => current, write, notify)
  for (let i = 0; i < 100; i++) reporter.report({ phase: "model", text: String(i) })
  expect(notify).not.toHaveBeenCalled()
  vi.advanceTimersByTime(500)
  expect(notify).toHaveBeenCalledOnce()
  reporter.report({ phase: "tool", toolName: "read_file" })
  reporter.close()
  expect(notify).toHaveBeenCalledTimes(2)
  const count = write.mock.calls.length
  reporter.report({ phase: "model", text: "late" })
  vi.advanceTimersByTime(1000)
  expect(write).toHaveBeenCalledTimes(count)
  expect(notify).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  const stale = flowProgressReporter(() => current, write, notify)
  stale.report({ phase: "model", text: "pending" })
  current = false
  stale.close()
  expect(notify).toHaveBeenCalledTimes(2)
  const broken = flowProgressReporter(
    () => true,
    () => {
      throw Error("display failed")
    },
    notify
  )
  expect(() => broken.report({ phase: "model", text: "update" })).not.toThrow()
  broken.close()
})
