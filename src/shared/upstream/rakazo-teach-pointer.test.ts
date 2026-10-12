import { describe, expect, it } from "vitest"
import { mapTeachPointer } from "./rakazo-teach-pointer"
describe("mapTeachPointer", () => {
  it("scales overlay clicks onto the remote screen size", () => {
    const rect = { left: 0, top: 0, width: 640, height: 400 }
    expect(mapTeachPointer(320, 200, rect, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 400
    })
    expect(mapTeachPointer(320, 200, rect, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540
    })
  })

  it("maps through the letterbox when the viewer is wider than the screen", () => {
    // 1600x800 viewer, 1280x800 screen: scale 1, 160px bars left and right.
    const rect = { left: 0, top: 0, width: 1600, height: 800 }
    const screen = { width: 1280, height: 800 }
    expect(mapTeachPointer(160, 0, rect, screen)).toEqual({ x: 0, y: 0 })
    expect(mapTeachPointer(800, 400, rect, screen)).toEqual({ x: 640, y: 400 })
    expect(mapTeachPointer(1440, 799, rect, screen)).toEqual({ x: 1279, y: 799 })
  })

  it("clamps clicks that land on the letterbox bars", () => {
    const rect = { left: 0, top: 0, width: 1600, height: 800 }
    const screen = { width: 1280, height: 800 }
    expect(mapTeachPointer(0, 400, rect, screen)).toEqual({ x: 0, y: 400 })
    expect(mapTeachPointer(1600, 400, rect, screen)).toEqual({ x: 1279, y: 400 })
  })

  it("accounts for the rect offset", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 }
    expect(mapTeachPointer(420, 250, rect, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 400
    })
  })
})
