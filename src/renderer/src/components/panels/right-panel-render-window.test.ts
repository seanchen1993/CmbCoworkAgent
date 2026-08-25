import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  RIGHT_PANEL_INITIAL_RENDER_ITEMS,
  selectRightPanelPrioritizedWindow,
  selectRightPanelWindow
} from "./right-panel-render-window"

describe("right panel render windows", () => {
  it("never exposes an unbounded catalog on the first render", () => {
    const items = Array.from({ length: 20_000 }, (_, index) => ({
      index,
      enabled: index % 3 !== 0
    }))

    const window = selectRightPanelPrioritizedWindow(
      items,
      RIGHT_PANEL_INITIAL_RENDER_ITEMS,
      (item) => item.enabled
    )

    expect(window.enabled.length + window.disabled.length).toBe(RIGHT_PANEL_INITIAL_RENDER_ITEMS)
    expect(window.enabled.every((item) => item.enabled)).toBe(true)
    expect(window.disabled.every((item) => !item.enabled)).toBe(true)
    expect(window.enabledCount + window.disabledCount).toBe(20_000)
    expect(window.remainingCount).toBe(20_000 - RIGHT_PANEL_INITIAL_RENDER_ITEMS)
  })

  it("bounds each skill-tree level independently", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => index)
    expect(selectRightPanelWindow(nodes, RIGHT_PANEL_INITIAL_RENDER_ITEMS)).toHaveLength(
      RIGHT_PANEL_INITIAL_RENDER_ITEMS
    )
  })

  it("does not refresh collapsed Skills or Plugins sections", () => {
    const source = readFileSync(new URL("./RightPanel.tsx", import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n"
    )
    expect(source).toContain("if (!skillsOpen) return undefined\n    void loadSkillCatalog()")
    expect(source).toContain("if (!pluginsOpen) return undefined\n    const requestId")
    expect(source).not.toContain("badge={hooks.filter((h) => h.enabled).length}")
  })
})
