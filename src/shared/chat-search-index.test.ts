import { describe, expect, it } from "vitest"
import { createChatSearchPlan, appendChatSearchToolSummaries } from "./chat-search-plan"
import {
  findChatSearchLocations,
  findChatTextRanges,
  projectChatSearchPlan,
  validateChatSearchLocation
} from "./chat-search-index"

describe("search fragment coordinates", () => {
  it("caps presentation text as well as raw input and marks incomplete coverage", () => {
    const plan = createChatSearchPlan("user", "x".repeat(256 * 1024))
    plan.segments[0].raw = `/goal ${"x".repeat(256 * 1024 - 6)}`
    const projected = projectChatSearchPlan(plan)
    expect(projected.reduce((sum, segment) => sum + segment.text.length, 0)).toBeLessThanOrEqual(
      256 * 1024
    )
    expect(plan.truncated).toBe(true)
  })
  it("revalidates unchanged prefixes but rejects an edited or hidden snapshot", () => {
    const initial = projectChatSearchPlan(createChatSearchPlan("assistant", "first needle"))
    const [location] = findChatSearchLocations(initial, "needle")
    expect(
      validateChatSearchLocation(
        projectChatSearchPlan(createChatSearchPlan("assistant", "first needle and more")),
        location
      )
    ).toBe(true)
    expect(
      validateChatSearchLocation(
        projectChatSearchPlan(createChatSearchPlan("assistant", "other needle")),
        location
      )
    ).toBe(false)
    expect(validateChatSearchLocation([], location)).toBe(false)
  })
  it("distinguishes repeated head/middle/tail occurrences using their actual fragments", () => {
    const text = `needle\n\n${"x".repeat(20_000)}\n\nneedle\n\n${"y".repeat(80_000)}\n\nneedle`
    const locations = findChatSearchLocations(
      projectChatSearchPlan(createChatSearchPlan("assistant", text)),
      "needle"
    )
    expect(locations).toHaveLength(3)
    expect(locations.map((location) => location.sourceStart)).toEqual(
      [...locations.map((location) => location.sourceStart)].sort((a, b) => a - b)
    )
    expect(new Set(locations.map((location) => location.start)).size).toBe(3)
    for (const location of locations) {
      expect(location.context.slice(location.contextStart, location.contextEnd)).toBe("needle")
    }
  })

  it("never creates a phrase across omitted content", () => {
    const plan = createChatSearchPlan("assistant", "x".repeat(400_000))
    plan.segments = [
      { kind: "body", blockIndex: 0, start: 0, end: 5, sourceLength: 400_000, raw: "alpha" },
      {
        kind: "body",
        blockIndex: 0,
        start: 399_995,
        end: 400_000,
        sourceLength: 400_000,
        raw: "omega"
      }
    ]
    expect(findChatSearchLocations(projectChatSearchPlan(plan), "alpha\nomega")).toEqual([])
  })

  it("preserves phrases and Markdown syntax across continuous preview boundaries", () => {
    const plan = createChatSearchPlan("assistant", "unused")
    plan.segments = [
      { kind: "body", blockIndex: 0, start: 0, end: 8, sourceLength: 14, raw: "alpha **" },
      { kind: "body", blockIndex: 0, start: 8, end: 15, sourceLength: 15, raw: "omega**" }
    ]
    const result = findChatSearchLocations(projectChatSearchPlan(plan), "alpha omega")
    expect(result).toHaveLength(1)
    expect(result[0].context).toBe("alpha omega")
  })

  it("keeps multi-block Goal labels identical to their presentation", () => {
    const plan = createChatSearchPlan("user", [
      { type: "text", text: "/goal ship release" },
      { type: "text", text: "启动附件：report.md" }
    ])
    expect(projectChatSearchPlan(plan)[0].text).toBe("设为 Goal\nship release\n附件：report.md")
  })

  it("maps case-expanded Unicode offsets back to the original text", () => {
    const text = "İ before needle 😀 NEEDLE"
    const ranges = findChatTextRanges(text, "needle", 10)
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual(["needle", "NEEDLE"])
  })

  it("strips admitted reasoning and attachment transport without exposing severed wrappers", () => {
    const hidden = createChatSearchPlan("assistant", "<think>secret</think>visible", {
      stripThink: true
    })
    expect(
      projectChatSearchPlan(hidden)
        .map((part) => part.text)
        .join("")
    ).toBe("visible")
    const large = createChatSearchPlan(
      "assistant",
      `<think>${"secret".repeat(50_000)}</think>visible`,
      { stripThink: true }
    )
    expect(large.truncated).toBe(true)
    expect(projectChatSearchPlan(large)).toEqual([])
    const attachment = createChatSearchPlan(
      "user",
      '<attachment filename="report.txt">secret</attachment>visible'
    )
    const text = projectChatSearchPlan(attachment)
      .map((part) => part.text)
      .join("")
    expect(text).toContain("report.txt")
    expect(text).toContain("visible")
    expect(text).not.toContain("secret")
  })

  it("bounds tool parameters before constructing their collapsed summaries", () => {
    const plan = createChatSearchPlan("assistant", "answer")
    appendChatSearchToolSummaries(plan, [
      { name: "execute", args: { command: "x".repeat(1_000_000) } }
    ])
    expect(plan.truncated).toBe(true)
    expect(plan.segments.reduce((sum, part) => sum + part.raw.length + 1, 0)).toBeLessThanOrEqual(
      256 * 1024
    )
  })
})
