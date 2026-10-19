import { expect, it } from "vitest"
import { BOT_AVATAR_SHAPES } from "../../../shared/bots/contracts"
import { botAppearanceColor, botChatAccent } from "./bot-chat-accent"
import {
  grokAvatarBody,
  grokAvatarGaze,
  grokAvatarState
} from "../components/bots/animation/grok-avatar-adapter"
import {
  avatarPaint,
  createMotion,
  createStateDriver,
  renderFrame
} from "../components/bots/animation/vendor/grok-avatar-kernel"

it("maps the original palette without changing custom colours or persisted shape identities", () => {
  expect(grokAvatarBody("circle")).toBe("sphere")
  expect(grokAvatarBody("squircle")).toBe("square")
  expect(botAppearanceColor("#ED2040")).toBe("#ff263c")
  expect(botChatAccent("#ed2040")).toEqual({
    "--bot-user-bubble-light": "#c82532",
    "--bot-user-bubble-dark": "#cf2b35",
    "--bot-user-text-light": "#ffffff",
    "--bot-user-text-dark": "#f5f5f5"
  })
  expect(botChatAccent("#777777")).toEqual({})
  expect(botChatAccent("#ffffff")["--bot-user-text"]).toBe("#000")
  expect(botAppearanceColor("#123456")).toBe("#123456")
})

it("renders every persisted shape through the real geometry and keeps active state transitions finite", () => {
  for (const shape of BOT_AVATAR_SHAPES) {
    const motion = createMotion({ body: grokAvatarBody(shape) })
    const director = createStateDriver(motion, "idle", { seed: 17, isCompact: true })
    for (const mood of [
      "think",
      "read",
      "write",
      "run",
      "search",
      "send",
      "orbit",
      "stream",
      "blocked",
      "idle"
    ] as const) {
      director.setState(grokAvatarState(mood))
      for (let frame = 0; frame < 12; frame++) {
        director.advance(1 / 30)
        motion.advance(1 / 30)
      }
      const tree = renderFrame(motion.frame(), avatarPaint("#ed2040", "#111111"), 62, "probe", {
        displaySize: 40,
        extent: 62
      })
      const json = JSON.stringify(tree)
      expect(tree.tag).toBe("svg")
      expect(json).not.toMatch(/NaN|Infinity|undefined/)
      expect(json).toContain('"path"')
    }
  }
})

it("uses authored Working clips, runs terminal clips once, and returns to idle", () => {
  const motion = createMotion({ body: "teardrop" })
  const director = createStateDriver(motion, "running", { seed: 5 })
  expect(director.clip).toMatch(/^Working_[A-F]$/)
  for (const terminal of ["finished", "failed"] as const) {
    director.setState(terminal)
    expect(director.clip).toBe(terminal === "finished" ? "Done_B" : "Blocked_B")
    for (let frame = 0; frame < 600; frame++) {
      director.advance(1 / 60)
      motion.advance(1 / 60)
    }
    expect(director.state).toBe("idle")
  }
})

it("settles a resting avatar and preserves a continuous shape change and pointer return", () => {
  const motion = createMotion({ body: "teardrop" })
  const director = createStateDriver(motion, "running", { seed: 5 })
  motion.setGazeAlways(true)
  motion.setGaze([0.5, -0.5])
  for (let frame = 0; frame < 30; frame++) motion.advance(1 / 60)
  motion.setBody("clover")
  motion.setGaze(null)
  director.setResting(true)
  for (let frame = 0; frame < 600; frame++) motion.advance(1 / 60)
  expect(motion.isSettled).toBe(true)
  expect(motion.frame()).toMatchObject({ body: "clover", offset: [0, 0], squash: [1, 1] })
  const rect = { left: 100, top: 100, width: 40, height: 40 }
  expect(grokAvatarGaze(rect, { x: 120, y: 120 })).toEqual([0, -0])
  expect(grokAvatarGaze(rect, { x: 130, y: 110 })).toEqual([0.5, 0.5])
  expect(grokAvatarGaze(rect, { x: 100, y: 140 })).toEqual([-1, -1])
  expect(grokAvatarGaze(rect, { x: 200, y: 40 })).toEqual([1, 1])
  expect(grokAvatarGaze({ ...rect, width: 0, height: 0 }, { x: 100, y: 100 })).toEqual([0, -0])
})

it("advances pointer gaze by elapsed time consistently at 30, 60 and 120 fps", () => {
  const frames = [30, 60, 120].map((fps) => {
    const motion = createMotion({ body: "teardrop" })
    motion.setGazeAlways(true)
    motion.setGaze([0.7, -0.4])
    const before = motion.frame()
    motion.advance(0)
    expect(motion.frame()).toEqual(before)
    for (let frame = 0; frame < fps / 10; frame++) motion.advance(1 / fps)
    return motion.frame() as { offset: number[]; quat: number[] }
  })
  for (const frame of frames) {
    frame.offset.forEach((value, index) => expect(value).toBeCloseTo(frames[1].offset[index], 12))
    frame.quat.forEach((value, index) => expect(value).toBeCloseTo(frames[1].quat[index], 12))
  }
  expect(Math.abs(frames[1].offset[0])).toBeGreaterThan(0.01)
})
