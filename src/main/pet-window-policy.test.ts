import { describe, expect, it } from "vitest"
import {
  getPetWindowPlatformPolicy,
  getPetWindowRefreshAction,
  resizeWindowAroundPetBody,
  shouldIgnorePetWindowMouseEvents
} from "./pet-window-policy"

describe("pet window platform policy", () => {
  it("reduces Windows compositor and mouse-forwarding work", () => {
    expect(getPetWindowPlatformPolicy("win32")).toEqual({
      alwaysOnTopLevel: "floating",
      backgroundThrottling: true,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: false,
      hoverPollIntervalMs: 100,
      idleFpsCap: 2,
      raiseOnBubbleShow: false,
      visibleOnAllWorkspaces: false
    })
  })

  it("preserves the existing non-Windows behavior", () => {
    expect(getPetWindowPlatformPolicy("darwin")).toEqual({
      alwaysOnTopLevel: "screen-saver",
      backgroundThrottling: false,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: true,
      hoverPollIntervalMs: 250,
      idleFpsCap: null,
      raiseOnBubbleShow: true,
      visibleOnAllWorkspaces: true
    })
  })
})

describe("pet window settings refresh", () => {
  it("does nothing for unchanged settings or selection changes while disabled", () => {
    expect(
      getPetWindowRefreshAction(
        { enabled: false, selectedPetKey: null },
        { enabled: false, selectedPetKey: null }
      )
    ).toBe("none")
    expect(
      getPetWindowRefreshAction(
        { enabled: false, selectedPetKey: null },
        { enabled: false, selectedPetKey: "builtin:pipi" }
      )
    ).toBe("none")
  })

  it("creates, closes, or recreates only when the visible window must change", () => {
    expect(
      getPetWindowRefreshAction(
        { enabled: false, selectedPetKey: "builtin:pipi" },
        { enabled: true, selectedPetKey: "builtin:pipi" }
      )
    ).toBe("create")
    expect(
      getPetWindowRefreshAction(
        { enabled: true, selectedPetKey: "builtin:pipi" },
        { enabled: false, selectedPetKey: "builtin:pipi" }
      )
    ).toBe("close")
    expect(
      getPetWindowRefreshAction(
        { enabled: true, selectedPetKey: "builtin:pipi" },
        { enabled: true, selectedPetKey: "builtin:qie" }
      )
    ).toBe("recreate")
  })
})

describe("pet window mouse hit testing", () => {
  it("ignores transparent space only while the pet is idle", () => {
    expect(
      shouldIgnorePetWindowMouseEvents({
        dragging: false,
        hoveringPet: false,
        hoveringBubble: false
      })
    ).toBe(true)
    expect(
      shouldIgnorePetWindowMouseEvents({
        dragging: false,
        hoveringPet: true,
        hoveringBubble: false
      })
    ).toBe(false)
  })

  it("keeps mouse input enabled for the bubble and throughout a drag", () => {
    expect(
      shouldIgnorePetWindowMouseEvents({
        dragging: false,
        hoveringPet: false,
        hoveringBubble: true
      })
    ).toBe(false)
    expect(
      shouldIgnorePetWindowMouseEvents({
        dragging: true,
        hoveringPet: false,
        hoveringBubble: false
      })
    ).toBe(false)
  })
})

describe("resizeWindowAroundPetBody", () => {
  it("keeps the pet anchored while switching between bubble and compact bounds", () => {
    const compact = resizeWindowAroundPetBody(
      { x: 500, y: 300, width: 250, height: 164 },
      { petLeft: 69, petTop: 40 },
      { petLeft: 0, petTop: 0 },
      { width: 112, height: 124 }
    )

    expect(compact).toEqual({ x: 569, y: 340, width: 112, height: 124 })

    expect(
      resizeWindowAroundPetBody(
        compact,
        { petLeft: 0, petTop: 0 },
        { petLeft: 69, petTop: 40 },
        { width: 250, height: 164 }
      )
    ).toEqual({ x: 500, y: 300, width: 250, height: 164 })
  })
})
