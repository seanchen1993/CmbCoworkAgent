import { describe, expect, it } from "vitest"

import { parseUnifiedDiffRows } from "./diff-utils"
import { buildBundleUnifiedDiff } from "./skill-bundle-diff"

describe("buildBundleUnifiedDiff", () => {
  it("emits localized hunks for edits spread across a large file", () => {
    const oldLines = Array.from({ length: 320 }, (_, index) => `line ${index + 1}`)
    const newLines = [...oldLines]
    newLines[1] = "line 2 changed"
    newLines[159] = "line 160 changed"
    newLines[318] = "line 319 changed"

    const diff = buildBundleUnifiedDiff(
      [{ path: "SKILL.md", content: `${oldLines.join("\n")}\n` }],
      [{ path: "SKILL.md", content: `${newLines.join("\n")}\n` }]
    )
    const rows = parseUnifiedDiffRows(diff)

    expect(rows.filter((row) => row.type === "del")).toHaveLength(3)
    expect(rows.filter((row) => row.type === "add")).toHaveLength(3)
    expect(rows.filter((row) => row.type === "hunk")).toHaveLength(3)
    expect(rows.filter((row) => row.type === "context").length).toBeLessThan(320)
  })

  it("keeps new and deleted file headers valid", () => {
    const added = buildBundleUnifiedDiff([], [{ path: "new.md", content: "one\ntwo\n" }])
    expect(added).toContain("new file mode 100644")
    expect(added).toContain("--- /dev/null")
    expect(added).toContain("@@ -0,0 +1,2 @@")

    const deleted = buildBundleUnifiedDiff([{ path: "old.md", content: "one\ntwo\n" }], [])
    expect(deleted).toContain("deleted file mode 100644")
    expect(deleted).toContain("+++ /dev/null")
    expect(deleted).toContain("@@ -1,2 +0,0 @@")
  })
})
