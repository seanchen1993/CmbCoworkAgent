import { describe, expect, it } from "vitest"
import { parseClawProfile } from "./claw"
import { parseClawActionExports } from "./claw-actions"
import {
  parseClawComponentExports,
  parseClawComponentSelection,
  resolveClawComponents
} from "./claw-components"

const base = { id: "base", name: "Base", kind: "module", entry: "base.ts" }
const review = {
  id: "review",
  name: "Review",
  kind: "module",
  entry: "review.ts",
  dependsOn: ["base"],
  actionIds: ["review"]
}
const manifest = { componentsVersion: 1, components: [base, review] }

describe("explicit component selection", () => {
  it("filters implicit defaults but rejects incompatible explicit all and selected", () => {
    const entries = parseClawComponentExports({
      componentsVersion: 1,
      components: [base, { ...review, usage: "project" }]
    })
    expect(resolveClawComponents(entries, undefined, "chat").map((item) => item.id)).toEqual([
      "base"
    ])
    expect(resolveClawComponents(entries, undefined, "project")).toHaveLength(2)
    expect(resolveClawComponents(entries)).toHaveLength(2)
    for (const mode of ["all", "selected"] as const)
      expect(() =>
        resolveClawComponents(
          entries,
          {
            mode,
            ids: ["base", "review"],
            config: {}
          },
          "chat"
        )
      ).toThrow("USAGE_UNAVAILABLE: review")
  })
  it("rejects cross-mode implicit dependencies and unknown declarations", () => {
    for (const [usage, dependencyUsage] of [
      ["project", "chat"],
      ["chat", "project"],
      ["universal", "project"],
      ["universal", "chat"],
      [undefined, "project"]
    ])
      expect(() =>
        parseClawComponentExports({
          componentsVersion: 1,
          components: [
            { ...base, usage: dependencyUsage },
            { ...review, ...(usage === undefined ? {} : { usage }) }
          ]
        })
      ).toThrow("DEPENDENCY_USAGE_INVALID")
    expect(() =>
      parseClawComponentExports({
        componentsVersion: 1,
        components: [{ ...base, usage: "unknown" }]
      })
    ).toThrow("USAGE_INVALID")
    const entries = parseClawComponentExports({
      componentsVersion: 1,
      components: [{ ...base, usage: "chat" }]
    })
    expect(resolveClawComponents(entries, undefined, "project")).toEqual([])
  })
  it("preserves legacy whole-package profiles without inventing a new selection", () => {
    const profile = {
      id: "p",
      name: "P",
      capabilities: [{ pluginId: "p", name: "p", digest: "a".repeat(64) }]
    }
    expect(parseClawProfile(profile)).toEqual(profile)
    expect(parseClawComponentExports({ actions: [] })).toEqual([])
    expect(resolveClawComponents([], undefined)).toEqual([])
    expect(() => resolveClawComponents([], { mode: "all", ids: [], config: {} })).toThrow()
  })
  it("requires opt-in version and defaults only declared dependency/action arrays", () => {
    expect(parseClawComponentExports(manifest)[0]).toEqual({
      ...base,
      dependsOn: [],
      actionIds: []
    })
    expect(parseClawActionExports(manifest)).toEqual([])
    expect(() => parseClawComponentExports({ components: [base] })).toThrow()
    expect(() => parseClawComponentExports({ componentsVersion: 2, components: [base] })).toThrow()
    expect(() => parseClawActionExports({})).toThrow()
  })
  it.each(["../escape.ts", "/absolute.ts", "C:/absolute.ts", "dir\\entry.ts", "bad\n.ts"])(
    "rejects unsafe entry %s",
    (entry) => {
      expect(() =>
        parseClawComponentExports({ ...manifest, components: [{ ...base, entry }] })
      ).toThrow()
    }
  )
  it("rejects duplicate IDs, missing dependencies, cycles and unknown kinds", () => {
    for (const components of [
      [base, base],
      [review],
      [{ ...base, dependsOn: ["review"] }, review],
      [{ ...base, kind: "authority" }]
    ])
      expect(() => parseClawComponentExports({ ...manifest, components })).toThrow()
  })
  it("requires dependencies to be visibly selected rather than adding execution implicitly", () => {
    const entries = parseClawComponentExports(manifest)
    expect(() =>
      resolveClawComponents(entries, { mode: "selected", ids: ["review"], config: {} })
    ).toThrow("DEPENDENCY_REQUIRED")
    expect(
      resolveClawComponents(entries, { mode: "selected", ids: ["review", "base"], config: {} }).map(
        (item) => item.id
      )
    ).toEqual(["base", "review"])
  })
  it("preserves false, zero, empty string and objects without injecting schema defaults", () => {
    const config = { review: { strict: false, retries: 0, note: "", nested: { value: 1 } } }
    expect(parseClawComponentSelection({ mode: "all", ids: ["ignored"], config })).toEqual({
      mode: "all",
      ids: [],
      config
    })
    expect(parseClawComponentSelection({ mode: "selected", ids: ["base"] }).config).toEqual({})
  })
  it("rejects empty, unknown, duplicate selection and excluded component configuration", () => {
    const entries = parseClawComponentExports(manifest)
    for (const selection of [
      { mode: "selected", ids: [], config: {} },
      { mode: "selected", ids: ["unknown"], config: {} },
      { mode: "selected", ids: ["base", "base"], config: {} },
      { mode: "selected", ids: ["base"], config: { review: {} } },
      { mode: "all", ids: [], config: { unknown: {} } }
    ])
      expect(() => resolveClawComponents(entries, selection as never)).toThrow()
  })
  it("round-trips component selection through profile parsing and rejects malformed config", () => {
    const profile = {
      id: "p",
      name: "P",
      capabilities: [
        {
          pluginId: "p",
          name: "p",
          digest: "a".repeat(64),
          components: { mode: "selected", ids: ["base"], config: { base: { n: 0 } } }
        }
      ]
    }
    expect(parseClawProfile(profile)).toEqual(profile)
    expect(() => parseClawComponentSelection({ mode: "all", config: { base: null } })).toThrow()
    expect(() =>
      parseClawComponentSelection({ mode: "all", config: JSON.parse('{"__proto__":{}}') })
    ).toThrow()
  })
})
