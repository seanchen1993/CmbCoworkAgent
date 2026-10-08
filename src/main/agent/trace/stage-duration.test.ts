import { describe, expect, it } from "vitest"
import { TraceStageDuration } from "./stage-duration"

describe("root turn stage duration", () => {
  it("counts a revisited stage once and conserves the turn duration", () => {
    const timeline = new TraceStageDuration(1000, "plan")
    timeline.observe(2000, "dev")
    timeline.observe(4000, "plan")
    expect(timeline.snapshot(5000)).toEqual({
      stageDurationSchemaVersion: 1,
      stageDurationComplete: true,
      stageDuration: [
        { nodeName: "plan", durationMs: 2000 },
        { nodeName: "dev", durationMs: 2000 }
      ]
    })
  })

  it("marks an unresolved stage incomplete so the dashboard uses the legacy turn", () => {
    const timeline = new TraceStageDuration(1000, "plan")
    timeline.observe(2000, null)
    timeline.observe(3000, "dev")
    expect(timeline.snapshot(4000).stageDurationComplete).toBe(false)
  })
})
