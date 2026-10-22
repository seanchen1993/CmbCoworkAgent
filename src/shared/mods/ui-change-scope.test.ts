import { expect, it } from "vitest"
import { isModSiteChangeScope } from "./types"

it("classifies exact projection changes separately from legacy global refreshes", () => {
  for (const value of [
    "site:owner",
    "site-invalidated:owner",
    "site-redraw:owner",
    "site-projection:hash"
  ])
    expect(isModSiteChangeScope(value)).toBe(true)
  for (const value of [
    undefined,
    null,
    12,
    "site-projection:",
    "site:",
    "site-presentations:AssistantMessage",
    "source-replaced:1",
    "future"
  ])
    expect(isModSiteChangeScope(value)).toBe(false)
})
