import { MiddlewareError } from "langchain"
import { expect, it } from "vitest"
import { getHookHaltError, HookHaltError } from "./halt"

it("recovers the original hook reason and event from actual LangChain wrappers", () => {
  const original = new HookHaltError({
    hookEvent: "PostToolBatch",
    fallbackReason: "block next model",
    result: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: true,
      reason: "review incomplete",
      systemMessage: "Review tools"
    }
  })
  const wrapped = MiddlewareError.wrap(MiddlewareError.wrap(original, "functionToolBatch"), "outer")
  expect(wrapped.name).toBe("HookHaltError")
  expect(getHookHaltError(wrapped)).toBe(original)
  expect(getHookHaltError(original)).toBe(original)
})
it("handles cycles and normal errors without inventing a hook decision", () => {
  const ordinary = new Error("network")
  ordinary.cause = ordinary
  expect(getHookHaltError(ordinary)).toBeNull()
  expect(getHookHaltError({ name: "HookHaltError" })).toBeNull()
})
