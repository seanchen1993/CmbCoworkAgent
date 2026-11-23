import { describe, expect, it } from "vitest"
import { botLibraryGroups } from "./bot-library-view"

describe("Bot library page presentation", () => {
  it("uses local calendar boundaries, excludes directories and keeps undated files accessible", () => {
    const now = new Date(2026, 9, 14, 0, 20)
    const entry = (path: string, date: Date) => ({
      path,
      is_dir: false,
      modified_at: date.toISOString()
    })
    const files = [
      entry("/older.md", new Date(2026, 8, 30)),
      entry("/last-night.md", new Date(2026, 9, 13, 23, 50)),
      entry("/morning.md", new Date(2026, 9, 14, 0, 1)),
      entry("/newest.md", new Date(2026, 9, 14, 0, 19)),
      entry("/month.md", new Date(2026, 9, 1)),
      { path: "/unknown.md", is_dir: false, modified_at: "invalid" },
      { path: "/folder", is_dir: true }
    ]
    const groups = botLibraryGroups(files, now)
    expect(groups.map((g) => [g.label, g.files.map((item) => item.file.path)])).toEqual([
      ["今天", ["/newest.md", "/morning.md"]],
      ["本周", ["/last-night.md"]],
      ["本月", ["/month.md"]],
      ["更早", ["/older.md"]],
      ["日期未知", ["/unknown.md"]]
    ])
    expect(groups[0].files[0].timeLabel).toBe("1分钟前")
    expect(groups[4].files[0].timeLabel).toBe("")
    expect(files[0].path).toBe("/older.md")
  })
})
