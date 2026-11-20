import { afterEach, describe, expect, it } from "vitest"
import {
  clearAdoptionContext,
  patchAdoptionContextForTrace,
  setAdoptionContext
} from "./adoption-tracker"

const threads = new Set<string>()
function start(threadId: string, traceId = threadId): void {
  threads.add(threadId)
  setAdoptionContext(threadId, { traceId, usedSkills: ["autodev-code-v1.0.0"] })
}
afterEach(() => {
  for (const threadId of threads) clearAdoptionContext(threadId)
  threads.clear()
})

describe("running code-attribution contexts", () => {
  it("keeps early and late child traces through more than 256 retained contexts", () => {
    start("early-child")
    for (let i = 0; i < 600; i++) start(`other-child-${i}`)
    start("late-child")
    // This guarded enrichment succeeds only if the original trace context
    // (which carries its startup Skill snapshot) still belongs to the thread.
    expect(patchAdoptionContextForTrace("early-child", "early-child", {})).toBe(true)
    expect(patchAdoptionContextForTrace("late-child", "late-child", {})).toBe(true)
  })

  it("snapshots code attribution from the owning turn, distinguishing empty from unknown", () => {
    for (const [id, skills, expected] of [
      ["inherited", ["prior-skill"], true],
      ["empty", [], false],
      ["not-initialized", undefined, undefined]
    ] as const) {
      setAdoptionContext(id, { traceId: id, usedSkills: skills ? [...skills] : undefined })
      expect(clearAdoptionContext(id, "other")).toBeUndefined()
      expect(clearAdoptionContext(id, id)).toBe(expected)
    }
  })

  it("does not let untraced metadata evict a running child", () => {
    start("running-child")
    for (let i = 0; i < 600; i++) {
      const id = `untraced-${i}`
      threads.add(id)
      setAdoptionContext(id, { modelId: "model" })
    }
    expect(patchAdoptionContextForTrace("running-child", "running-child", {})).toBe(true)
  })

  it("releases completed traces and protects a continuation from older cleanup", () => {
    start("continued", "old-trace")
    clearAdoptionContext("continued")
    start("continued", "new-trace")
    clearAdoptionContext("continued", "old-trace")
    expect(patchAdoptionContextForTrace("continued", "new-trace", {})).toBe(true)
    clearAdoptionContext("continued", "new-trace")
    expect(patchAdoptionContextForTrace("continued", "new-trace", {})).toBe(false)
  })
})
