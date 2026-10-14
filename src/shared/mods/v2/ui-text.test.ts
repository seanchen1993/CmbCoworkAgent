import { describe, expect, it } from "vitest"
import { functionUiTextProjection } from "./ui-text"

describe("function UI display text", () => {
  it("bounds desktop and remote text without changing the full input", () => {
    const text = "界".repeat(30000)
    expect(functionUiTextProjection(text, 2000)).toBe(text.slice(0, 2000))
    expect(functionUiTextProjection(text, 10000)).toBe(text.slice(0, 10000))
    expect(text).toHaveLength(30000)
  })

  it.each([2000, 10000, 100000] as const)(
    "repairs surrogate halves at the %i boundary",
    (limit) => {
      const prefix = "x".repeat(limit - 1)
      expect(functionUiTextProjection(`${prefix}🙂tail`, limit)).toBe(`${prefix}\uFFFD`)
      expect(functionUiTextProjection(`${prefix.slice(1)}🙂tail`, limit)).toBe(
        `${prefix.slice(1)}🙂`
      )
      expect(functionUiTextProjection("\uD800a\uDC00🙂", limit)).toBe("\uFFFDa\uFFFD🙂")
    }
  )
})
