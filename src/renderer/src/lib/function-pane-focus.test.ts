import { expect, it } from "vitest"
import { canRequestPaneFocus } from "./function-pane-focus"

it("accepts only the active empty composer or the transient empty body focus", () => {
  const ready = {
    visible: true,
    active: true,
    emptyComposer: true,
    composerReady: true,
    dialog: false,
    current: "composer" as const
  }
  expect(canRequestPaneFocus(ready)).toBe(true)
  expect(canRequestPaneFocus({ ...ready, current: "body" })).toBe(true)
  for (const state of [
    { ...ready, visible: false },
    { ...ready, active: false },
    { ...ready, emptyComposer: false },
    { ...ready, composerReady: false },
    { ...ready, dialog: true },
    { ...ready, current: "other" as const }
  ])
    expect(canRequestPaneFocus(state)).toBe(false)
})
