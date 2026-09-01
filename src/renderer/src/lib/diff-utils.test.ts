import { describe, expect, it } from "vitest"

import { buildLineDiffRows, parseUnifiedDiffRows } from "./diff-utils"

function countRows(
  rows: ReturnType<typeof buildLineDiffRows>,
  type: "add" | "del" | "context"
): number {
  return rows.filter((row) => row.type === type).length
}

describe("buildLineDiffRows", () => {
  it("keeps common lines when a coarse hunk contains scattered edits", () => {
    const oldLines = Array.from({ length: 320 }, (_, index) => `line ${index + 1}`)
    const newLines = [...oldLines]
    newLines[1] = "line 2 changed"
    newLines[159] = "line 160 changed"
    newLines[318] = "line 319 changed"

    // This is the shape emitted by the legacy bundle patch builder: one early
    // change makes the whole middle section look deleted and then re-added.
    const coarsePatch = [
      "diff --git a/SKILL.md b/SKILL.md",
      "--- a/SKILL.md",
      "+++ b/SKILL.md",
      "@@ -1,320 +1,320 @@",
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`)
    ].join("\n")

    const rawRows = parseUnifiedDiffRows(coarsePatch)
    expect(countRows(rawRows, "del")).toBe(320)
    expect(countRows(rawRows, "add")).toBe(320)

    const rows = buildLineDiffRows(oldLines.join("\n"), newLines.join("\n"), "SKILL.md")
    expect(rows[0]).toEqual({ type: "file", text: "SKILL.md" })
    expect(countRows(rows, "del")).toBe(3)
    expect(countRows(rows, "add")).toBe(3)
    expect(countRows(rows, "context")).toBe(317)
  })

  it("does not create an extra row for a trailing newline", () => {
    const rows = buildLineDiffRows("one\ntwo\n", "one\nTWO\n")
    expect(rows).toEqual([
      { type: "context", text: "one" },
      { type: "del", text: "two" },
      { type: "add", text: "TWO" }
    ])
  })
})
