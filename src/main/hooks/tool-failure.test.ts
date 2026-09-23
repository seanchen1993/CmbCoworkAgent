import { expect, it } from "vitest"
import { toolFailureSignalFromThrow } from "./tool-failure"

it("recognizes native AbortError without depending on an outer signal snapshot", () => {
  expect(
    toolFailureSignalFromThrow(new DOMException("user cancelled", "AbortError"))
  ).toMatchObject({ kind: "abort", isInterrupt: true, isTimeout: false })
})
it("recognizes native TimeoutError independently of localized error text", () => {
  expect(toolFailureSignalFromThrow(new DOMException("期限已到", "TimeoutError"))).toMatchObject({
    kind: "timeout",
    isInterrupt: false,
    isTimeout: true
  })
})
it("preserves original failures and explicit cancellation precedence", () => {
  expect(toolFailureSignalFromThrow(new Error("native failure"))).toMatchObject({
    kind: "throw",
    message: "native failure",
    isInterrupt: false
  })
  expect(toolFailureSignalFromThrow(new Error("timeout"), { aborted: true })).toMatchObject({
    kind: "abort",
    isInterrupt: true
  })
})
