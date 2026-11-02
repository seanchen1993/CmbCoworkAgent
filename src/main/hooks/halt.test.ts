import { MiddlewareError } from "langchain"
import { describe, expect, it } from "vitest"
import { getHookHaltError, HookHaltError, isHookHaltError } from "./halt"

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


describe("wrapped hook halt", () => {
  it("recovers event and reason through model middleware wrappers", () => {
    const halt = new HookHaltError({ hookEvent: "SubagentStop", fallbackReason: "stop child" })
    const wrapped = new Error(halt.message, { cause: new Error("middle", { cause: halt }) })
    wrapped.name = halt.name
    expect(isHookHaltError(wrapped)).toBe(true)
    expect(getHookHaltError(wrapped)).toBe(halt)
    expect(getHookHaltError(wrapped)?.hookEvent).toBe("SubagentStop")
    expect(getHookHaltError(wrapped)?.reason).toBe("stop child")
  })

  it("ignores unrelated failures and terminates on cyclic causes", () => {
    const error = new Error("unrelated")
    error.cause = error
    expect(getHookHaltError(error)).toBeNull()
    expect(getHookHaltError(null)).toBeNull()
  })
})
