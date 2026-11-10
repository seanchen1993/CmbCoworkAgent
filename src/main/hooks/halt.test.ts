import { describe, expect, it } from "vitest"
import { getHookHaltError, HookHaltError, isHookHaltError } from "./halt"

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
    expect(getHookHaltError(error)).toBeUndefined()
    expect(getHookHaltError(null)).toBeUndefined()
  })
})
