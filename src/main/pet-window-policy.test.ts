import { describe, expect, it } from "vitest"
import { getPetWindowPlatformPolicy, resizeWindowAroundPetBody } from "./pet-window-policy"

describe("pet window platform policy", () => {
  it("reduces Windows compositor and mouse-forwarding work", () => {
    expect(getPetWindowPlatformPolicy("win32")).toEqual({
      alwaysOnTopLevel: "floating",
      backgroundThrottling: true,
      compactWhenBubbleHidden: true,
      forwardIgnoredMouseMoves: false,
      idleFpsCap: 2,
      visibleOnAllWorkspaces: false
    })
  })

  it("preserves the existing non-Windows behavior", () => {
    expect(getPetWindowPlatformPolicy("darwin")).toEqual({
      alwaysOnTopLevel: "screen-saver",
      backgroundThrottling: false,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: true,
      idleFpsCap: null,
      visibleOnAllWorkspaces: true
    })
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
