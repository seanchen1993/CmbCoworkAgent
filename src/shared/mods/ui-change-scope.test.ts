import { expect, it } from "vitest"
import { isModSiteChangeScope, modUiChangeAffects, type ModUiChangeScope } from "./types"

it("keeps surface redraws out of unrelated catalog, log and feedback queries", () => {
  const surfaces = ["panes", "placed", "records", "cards", "feedback"] as const
  for (const source of surfaces) {
    for (const target of surfaces)
      expect(modUiChangeAffects(source, target)).toBe(source === target)
    expect(modUiChangeAffects(source)).toBe(false)
  }
  for (const scope of ["site-presentations:AssistantMessage", "site-projection:one"] as const)
    for (const target of surfaces) expect(modUiChangeAffects(scope, target)).toBe(false)
  for (const scope of [undefined, "future", "source-replaced:1", "source-retiring:1"])
    for (const target of surfaces) expect(modUiChangeAffects(scope as ModUiChangeScope, target)).toBe(true)
})

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
