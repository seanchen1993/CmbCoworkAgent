import { describe, expect, it } from "vitest"
import { botSidebarUnreadJumps } from "./bot-sidebar-unreads"

describe("Bot sidebar unread jumps", () => {
  const viewport = { top: 100, bottom: 500 }
  it("finds the nearest unread in each direction and counts collapsed-section conversations", () => {
    expect(
      botSidebarUnreadJumps(
        [
          { key: "old", top: -50, bottom: 0, count: 1 },
          { key: "above", top: 40, bottom: 100, count: 1 },
          { key: "visible", top: 120, bottom: 180, count: 1 },
          { key: "below", top: 500, bottom: 560, count: 1 },
          { key: "section", top: 620, bottom: 650, count: 3 }
        ],
        viewport
      )
    ).toEqual({ above: { key: "above", count: 2 }, below: { key: "below", count: 4 } })
  })
  it("does not jump to partly visible, read or unrendered rows", () => {
    expect(
      botSidebarUnreadJumps(
        [
          { key: "partial-top", top: 99, bottom: 150, count: 1 },
          { key: "partial-bottom", top: 450, bottom: 501, count: 1 },
          { key: "read", top: 650, bottom: 700, count: 0 },
          { key: "hidden", top: 0, bottom: 0, count: 1 }
        ],
        viewport
      )
    ).toEqual({ above: null, below: null })
  })
  it("updates after scrolling or acknowledging without mutating unread state", () => {
    const rows = [{ key: "one", top: 500, bottom: 560, count: 1 }]
    expect(botSidebarUnreadJumps(rows, viewport).below?.key).toBe("one")
    expect(botSidebarUnreadJumps(rows, { top: 400, bottom: 800 }).below).toBeNull()
    expect(rows[0].count).toBe(1)
    expect(botSidebarUnreadJumps([{ ...rows[0], count: 0 }], viewport).below).toBeNull()
  })
})
