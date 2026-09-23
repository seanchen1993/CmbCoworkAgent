import { expect, it } from "vitest"
import { functionSpinnerFacts } from "./function-status-site"

it("adapts the current live message/tool state and keeps the actual host loading text", () => {
  expect(functionSpinnerFacts("Thinking...", undefined, false)).toEqual({
    word: "Thinking...",
    message: null,
    suffix: "",
    mode: "requesting"
  })
  expect(
    functionSpinnerFacts("Working", { role: "assistant", reasoning: "trace" }, false).mode
  ).toBe("thinking")
  expect(
    functionSpinnerFacts("Working", { role: "assistant", content: "answer" }, false).mode
  ).toBe("responding")
  expect(functionSpinnerFacts("Working", { role: "assistant", tool_calls: [{}] }, false).mode).toBe(
    "tool-input"
  )
  expect(functionSpinnerFacts("Working", { role: "tool" }, true).mode).toBe("tool-use")
  expect(functionSpinnerFacts("Working", { role: "tool" }, false).mode).toBe("requesting")
  expect(functionSpinnerFacts("Working", { role: "user", content: "prompt" }, false).mode).toBe(
    "requesting"
  )
})
