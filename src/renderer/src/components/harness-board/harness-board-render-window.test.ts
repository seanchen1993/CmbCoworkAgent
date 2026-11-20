import { describe, expect, it } from "vitest"
import {
  getHarnessViewportWindow,
  windowHarnessProjectGroups
} from "./harness-board-render-window"

describe("harness board render window", () => {
  it("enforces one global project-card budget across a large catalog", () => {
    const groups = Array.from({ length: 1_000 }, (_, groupIndex) => ({
      id: `system-${groupIndex}`,
      projects: Array.from({ length: 10 }, (_, projectIndex) =>
        `project-${groupIndex}-${projectIndex}`
      )
    }))

    const visible = windowHarnessProjectGroups(groups, 96)
    expect(visible.flatMap((entry) => entry.projects)).toHaveLength(96)
    expect(visible).toHaveLength(10)
    expect(visible.at(-1)?.projects).toHaveLength(6)
  })

  it("preserves source order and advances when the user requests another batch", () => {
    const groups = [
      { id: "a", projects: ["a1", "a2"] },
      { id: "b", projects: ["b1", "b2", "b3"] }
    ]

    expect(
      windowHarnessProjectGroups(groups, 3).flatMap((entry) => entry.projects)
    ).toEqual(["a1", "a2", "b1"])
    expect(
      windowHarnessProjectGroups(groups, 6).flatMap((entry) => entry.projects)
    ).toEqual(["a1", "a2", "b1", "b2", "b3"])
  })

  it("keeps a 10k-card horizontal viewport bounded", () => {
    const window = getHarnessViewportWindow(10_000, 376 * 5_000, 1_200, 376, 2)
    expect(window.start).toBe(4_998)
    expect(window.end - window.start).toBeLessThanOrEqual(8)
    expect(window.beforePx + window.afterPx).toBeGreaterThan(3_000_000)
  })
})
