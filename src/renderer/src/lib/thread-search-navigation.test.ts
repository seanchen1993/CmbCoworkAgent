import { describe, expect, it } from "vitest"
import { openThreadSearch, useThreadSearch } from "./thread-search-navigation"

describe("cross-conversation search panel", () => {
  it("uses a new query scope each time the panel reopens", () => {
    const before = useThreadSearch.getState().openingVersion
    try {
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 1)
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 1)

      useThreadSearch.setState({ open: false })
      openThreadSearch()
      expect(useThreadSearch.getState().openingVersion).toBe(before + 2)
    } finally {
      useThreadSearch.setState({ open: false, openingVersion: before })
    }
  })
})
