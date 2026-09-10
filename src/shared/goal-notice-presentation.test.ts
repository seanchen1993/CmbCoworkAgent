import { describe, expect, it } from "vitest"
import { parseGoalNoticeText, projectGoalNoticeVisibleText } from "./goal-notice-presentation"

describe("Goal notice presentation", () => {
  it("projects paused, completed, and configured notices in mounted DOM order", () => {
    expect(projectGoalNoticeVisibleText("Ⅱ Goal 已暂停：等待用户")).toBe(
      "Goal 已暂停\n等待用户"
    )
    expect(projectGoalNoticeVisibleText("✓ Goal 已完成 (42s)：已交付")).toBe(
      "Goal 已完成\n42s\n已交付"
    )
    expect(projectGoalNoticeVisibleText("Goal 已设置（manual）。完成修复；可用 /goal pause"))
      .toBe("Goal 已设置\nmanual\n完成修复\n/goal pause")
  })

  it("returns null for an ordinary system notice", () => {
    expect(parseGoalNoticeText("ordinary notice")).toBeNull()
    expect(projectGoalNoticeVisibleText("ordinary notice")).toBeNull()
  })
})
