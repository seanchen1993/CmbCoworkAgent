import { describe, expect, it } from "vitest"
import { shouldBlockEmbeddedNavigation } from "./html-preview-navigation"

describe("embedded HTML navigation", () => {
  const main = {}
  const preview = {}

  it("lets the app open an embedded document and reload its own main frame", () => {
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: false, initiator: main }, main)).toBe(false)
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: true, initiator: main }, main)).toBe(false)
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: true, initiator: null }, main)).toBe(false)
  })

  it("blocks scripts navigating their own frame, other frames, or the app", () => {
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: false, initiator: preview }, main)).toBe(
      true
    )
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: true, initiator: preview }, main)).toBe(
      true
    )
  })

  it("fails closed for subframe navigations and redirects with missing initiators", () => {
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: false, initiator: null }, main)).toBe(true)
    expect(shouldBlockEmbeddedNavigation({ isMainFrame: false }, main)).toBe(true)
  })
})
