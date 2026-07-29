import { describe, expect, it } from "vitest"
import {
  getPetWindowPlatformPolicy,
  getPetWindowShapeRects,
  resizeWindowAroundPetBody
} from "./pet-window-policy"

describe("pet window platform policy", () => {
  it("reduces Windows compositor and mouse-forwarding work", () => {
    expect(getPetWindowPlatformPolicy("win32")).toEqual({
      alwaysOnTopLevel: "floating",
      backgroundThrottling: true,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: false,
      idleFpsCap: 2,
      useWindowShapeForHitTesting: true,
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
      useWindowShapeForHitTesting: false,
      visibleOnAllWorkspaces: true
    })
  })
})

describe("pet window shape", () => {
  const petRect = { x: 69, y: 40, width: 112, height: 124 }
  const bubbleRect = { x: 0, y: 0, width: 250, height: 48 }

  it("only accepts input over the pet while the bubble is hidden", () => {
    expect(getPetWindowShapeRects(petRect, bubbleRect, false)).toEqual([petRect])
  })

  it("accepts input over both the pet and visible bubble", () => {
    expect(getPetWindowShapeRects(petRect, bubbleRect, true)).toEqual([petRect, bubbleRect])
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
