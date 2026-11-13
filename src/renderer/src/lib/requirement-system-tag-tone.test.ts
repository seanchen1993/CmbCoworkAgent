import { describe, expect, it } from "vitest"
import { systemTagToneClass } from "./requirement-system-tag-tone"

describe("requirement system tag colors", () => {
  it("keeps a stable color for the same system", () => {
    expect(systemTagToneClass("system-a")).toBe(systemTagToneClass("system-a"))
  })

  it("uses different colors for different systems", () => {
    expect(systemTagToneClass("system-a")).not.toBe(systemTagToneClass("system-b"))
  })
})
