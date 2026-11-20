import { describe, expect, it } from "vitest"
import { stripThinkBlocksForDisplay } from "./think-block-display"

describe("think block display projection", () => {
  it("strips completed and partial legacy think blocks", () => {
    expect(stripThinkBlocksForDisplay("<think>secret</think>visible")).toBe("visible")
    expect(stripThinkBlocksForDisplay("<think>streaming secret")).toBe("")
  })

  it("keeps ordinary content on the fast path", () => {
    expect(stripThinkBlocksForDisplay("visible <think-like> literal")).toBe(
      "visible <think-like> literal"
    )
  })
})
