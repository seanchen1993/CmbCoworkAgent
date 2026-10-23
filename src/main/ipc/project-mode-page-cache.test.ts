import { afterEach, expect, it, vi } from "vitest"
import { ProjectModePageCache } from "./project-mode-page-cache"
afterEach(() => vi.restoreAllMocks())

it("reuses completed pages, expires after 30 seconds and separates scoped keys", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100)
  const cache = new ProjectModePageCache<{ count: number }>()
  cache.set("own-room/active", { count: 10 })
  expect(cache.get("own-room/active")).toEqual({ count: 10 })
  expect(cache.get("other-room/active")).toBeUndefined()
  expect(cache.get("own-room/archived")).toBeUndefined()
  now.mockReturnValue(30_100)
  expect(cache.get("own-room/active")).toBeUndefined()
})

it("does not repopulate old data when a request finishes after refresh", () => {
  const cache = new ProjectModePageCache<string>()
  const generation = cache.generation
  cache.set("page", "old")
  cache.clear()
  cache.set("page", "late-old", generation)
  expect(cache.get("page")).toBeUndefined()
  cache.set("page", "fresh")
  expect(cache.get("page")).toBe("fresh")
})

it("bounds entries and memory instead of retaining every historic page", () => {
  const cache = new ProjectModePageCache<string>()
  for (let i = 0; i < 7; i++) cache.set(String(i), "page")
  expect(cache.get("0")).toBeUndefined()
  expect(cache.get("6")).toBe("page")
  cache.clear()
  for (let i = 0; i < 6; i++) cache.set(String(i), "x".repeat(900 * 1024))
  expect(cache.get("0")).toBeUndefined()
  expect(cache.get("5")).toHaveLength(900 * 1024)
  cache.set("huge", "x".repeat(1024 * 1024))
  expect(cache.get("huge")).toBeUndefined()
})
