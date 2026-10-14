import { describe, expect, it } from "vitest"
import { clawSourceIssues, parseClawProfile, parseClawSourceSelection } from "./claw"

const item = { id: "source", name: "Same name", digest: "a".repeat(64) }
const profile = { id: "p", name: "Profile", capabilities: [] }

describe("Claw source selection contract", () => {
  it("keeps legacy inheritance distinct from explicit empty selection", () => {
    expect(parseClawProfile(profile).skills).toBeUndefined()
    expect(
      parseClawProfile({ ...profile, skills: { mode: "selected", items: [] } }).skills
    ).toEqual({ mode: "selected", items: [] })
    expect(parseClawSourceSelection({ mode: "all", items: [item] })).toEqual({
      mode: "all",
      items: []
    })
  })

  it("copies only source references, preserves independent groups and allows duplicate labels", () => {
    const parsed = parseClawProfile({
      ...profile,
      skills: { mode: "selected", items: [{ ...item, path: "secret" }] },
      mcp: { mode: "selected", items: [item, { ...item, id: "other" }] }
    })
    expect(parsed.skills?.items).toEqual([item])
    expect(parsed.mcp?.items).toHaveLength(2)
    expect(JSON.stringify(parsed)).not.toContain("secret")
  })

  it.each([
    null,
    { mode: "unknown", items: [] },
    { mode: "selected" },
    { mode: "selected", items: [item, item] },
    { mode: "selected", items: [{ ...item, digest: "bad" }] },
    { mode: "selected", items: [{ ...item, id: "a\u0000b" }] },
    {
      mode: "selected",
      items: Array.from({ length: 513 }, (_, id) => ({ ...item, id: String(id) }))
    }
  ])("rejects malformed or ambiguous selection %#", (input) => {
    expect(() => parseClawSourceSelection(input)).toThrow()
  })

  it("rejects missing and changed identities without substituting a same-name source", () => {
    const selection = { mode: "selected" as const, items: [item] }
    expect(clawSourceIssues(selection, [{ ...item, id: "other" }], "Skill")).toHaveLength(1)
    expect(clawSourceIssues(selection, [{ ...item, digest: "b".repeat(64) }], "MCP")).toHaveLength(
      1
    )
    expect(clawSourceIssues(selection, [{ ...item, name: "Renamed" }], "Skill")).toHaveLength(1)
    expect(clawSourceIssues(undefined, [], "Skill")).toEqual([])
  })
})
