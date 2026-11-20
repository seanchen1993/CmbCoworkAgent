import { describe, expect, it } from "vitest"
import { countTextLines } from "./browser-script-text"

describe("countTextLines", () => {
  it.each([
    ["", 0],
    ["   ", 0],
    ["const value = 1", 1],
    ["first\nsecond", 2],
    ["first\r\nsecond\r\nthird", 3],
    ["first\n", 2]
  ])("counts lines without splitting the script", (value, expected) => {
    expect(countTextLines(value)).toBe(expected)
  })
})
