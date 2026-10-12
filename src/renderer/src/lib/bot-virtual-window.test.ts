import { expect, it } from "vitest"
import { reconcileBotVirtualWindow } from "./bot-virtual-window"

const page = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `m-${start + index}` }))

it("preserves virtual item identities through older and newer page eviction", () => {
  const first = reconcileBotVirtualWindow(null, "main", page(100, 100))
  const older = reconcileBotVirtualWindow(first, "main", page(50, 100))
  expect(older.generation).toBe(first.generation)
  expect(older.firstItemIndex + 50).toBe(first.firstItemIndex)
  const newer = reconcileBotVirtualWindow(older, "main", page(100, 100))
  expect(newer.firstItemIndex).toBe(first.firstItemIndex)
  expect(newer.generation).toBe(first.generation)
})

it("starts fresh measurements for a non-overlapping message jump or another view", () => {
  const first = reconcileBotVirtualWindow(null, "main", page(0, 100))
  const jump = reconcileBotVirtualWindow(first, "main", page(500, 100))
  expect(jump.generation).toBe(first.generation + 1)
  expect(reconcileBotVirtualWindow(jump, "branch", page(500, 100)).generation).toBe(0)
})

it("keeps measured indexes when only metadata or appended content changes", () => {
  const first = reconcileBotVirtualWindow(null, "main", page(0, 100))
  const appended = reconcileBotVirtualWindow(first, "main", page(0, 110))
  expect(appended.firstItemIndex).toBe(first.firstItemIndex)
  expect(appended.generation).toBe(first.generation)
})
