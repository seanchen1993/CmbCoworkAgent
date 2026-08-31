import { describe, expect, it } from "vitest"
import type { SkillMetadata } from "@/types"
import { isSkillDisabled } from "./skill-ids"

function skill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    id: "review",
    name: "review",
    description: "",
    path: "C:/skills/review/SKILL.md",
    source: "user",
    version: "1.0.0",
    ...overrides
  }
}

describe("skill disabled identity", () => {
  it("keeps a same-name plugin skill enabled when the standalone skill is disabled", () => {
    const disabled = new Set(["review"])
    const standalone = skill()
    const plugin = skill({
      id: "plugin:plugin-a/review",
      path: "C:/plugins/plugin-a/skills/review/SKILL.md",
      pluginId: "plugin-a",
      pluginName: "Plugin A"
    })

    expect(isSkillDisabled(standalone, disabled)).toBe(true)
    expect(isSkillDisabled(plugin, disabled)).toBe(false)
    expect(isSkillDisabled(plugin, new Set(["plugin:plugin-a/review"]))).toBe(false)
  })

  it("matches standalone ancestors without iterating the entire disabled set", () => {
    const disabled = new Set(Array.from({ length: 20_000 }, (_, index) => `unrelated-${index}`))
    disabled.add("office")
    Object.defineProperty(disabled, Symbol.iterator, {
      value: (): never => {
        throw new Error("disabled set must not be scanned")
      }
    })

    expect(
      isSkillDisabled(
        skill({ id: "office/pdf", name: "pdf", relativePath: "office/pdf" }),
        disabled
      )
    ).toBe(true)
  })

  it("preserves legacy standalone name matching when id and name differ", () => {
    expect(
      isSkillDisabled(
        skill({ id: "nested/review-v2", relativePath: "nested/review-v2", name: "review" }),
        new Set(["review"])
      )
    ).toBe(true)
  })
})
