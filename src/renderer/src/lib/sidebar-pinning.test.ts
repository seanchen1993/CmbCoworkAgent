import { describe, expect, it, vi } from "vitest"
import { readStoredStringSet, sortPinnedFirst, toggleStoredStringSet } from "./sidebar-pinning"

function storageWith(value: string | null): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn()
  }
}

describe("sidebar pinning", () => {
  it("reads only string values from the persisted JSON array", () => {
    const storage = storageWith('["alpha", 1, null, "beta"]')

    expect([...readStoredStringSet("pins", storage)]).toEqual(["alpha", "beta"])
  })

  it("falls back to an empty set when persisted state is invalid or unavailable", () => {
    expect(readStoredStringSet("pins", storageWith("not-json"))).toEqual(new Set())

    const unavailableStorage = storageWith(null)
    vi.mocked(unavailableStorage.getItem).mockImplementation(() => {
      throw new Error("storage unavailable")
    })
    expect(readStoredStringSet("pins", unavailableStorage)).toEqual(new Set())
  })

  it("toggles a pin without mutating the current set and persists the same JSON-array format", () => {
    const storage = storageWith(null)
    const current = new Set(["alpha"])

    const added = toggleStoredStringSet(current, "beta", "pins", storage)
    expect(added).toEqual(new Set(["alpha", "beta"]))
    expect(current).toEqual(new Set(["alpha"]))
    expect(storage.setItem).toHaveBeenLastCalledWith("pins", '["alpha","beta"]')

    const removed = toggleStoredStringSet(added, "alpha", "pins", storage)
    expect(removed).toEqual(new Set(["beta"]))
    expect(storage.setItem).toHaveBeenLastCalledWith("pins", '["beta"]')
  })

  it("moves pinned items first while preserving both partitions' original order", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

    expect(sortPinnedFirst(items, (item) => item.id === "b" || item.id === "d")).toEqual([
      { id: "b" },
      { id: "d" },
      { id: "a" },
      { id: "c" }
    ])
  })
})
