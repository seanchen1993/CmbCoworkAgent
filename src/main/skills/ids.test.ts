import { describe, expect, it } from "vitest"
import { isDiscoveredSkillDisabled } from "./ids"

describe("discovered skill disabled identity", () => {
  it("matches an ancestor with indexed lookups instead of scanning the disabled set", () => {
    const disabled = new Set(
      Array.from({ length: 20_000 }, (_, index) => `unrelated-${index}`)
    )
    disabled.add("office")
    Object.defineProperty(disabled, Symbol.iterator, {
      value: (): never => {
        throw new Error("disabled set must not be scanned")
      }
    })

    expect(
      isDiscoveredSkillDisabled(
        { name: "pdf", relativePath: "office/pdf", rootDir: "C:/skills/office/pdf" },
        disabled
      )
    ).toBe(true)
  })

  it("does not match unrelated canonical ids", () => {
    expect(
      isDiscoveredSkillDisabled(
        { name: "review", relativePath: "team/review", rootDir: "C:/skills/team/review" },
        new Set(["other/review"])
      )
    ).toBe(false)
  })
})
