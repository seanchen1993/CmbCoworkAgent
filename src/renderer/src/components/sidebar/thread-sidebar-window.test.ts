import { describe, expect, it } from "vitest"
import { selectBoundedSidebarWindow } from "./thread-sidebar-window"

describe("thread sidebar bounded window", () => {
  it("keeps a far selected task visible without mounting its entire prefix", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => index)
    const window = selectBoundedSidebarWindow(items, 5, 9_999)

    expect(window.items).toEqual([0, 1, 2, 3, 4, 9_999])
    expect(window.items).toHaveLength(6)
    expect(window.hiddenCount).toBe(9_994)
    expect(window.selectedOutsideWindow).toBe(true)
  })

  it("caps workspace headers while keeping an off-window selected workspace", () => {
    const projects = Array.from({ length: 10_000 }, (_, index) => `project-${index}`)
    const window = selectBoundedSidebarWindow(projects, 60, 8_000)

    expect(window.items).toHaveLength(61)
    expect(window.items.at(-1)).toBe("project-8000")
  })
})
