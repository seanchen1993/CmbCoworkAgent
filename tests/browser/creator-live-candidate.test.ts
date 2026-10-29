import { expect, it } from "vitest"
import { hasLiveCreatorCandidate } from "../support/creator-live-candidate"

it("cannot mistake a retained source trial or unrelated dependency for a new project candidate", () => {
  const original = { projectTrial: { digest: "original" }, trials: [] }
  expect(hasLiveCreatorCandidate(original, "project", "original")).toBe(false)
  expect(
    hasLiveCreatorCandidate(
      { projectTrial: null, trials: [{ phase: "needs-approval" }] },
      "project",
      "original"
    )
  ).toBe(false)
  expect(
    hasLiveCreatorCandidate(
      { projectTrial: { digest: "edited" }, trials: [] },
      "project",
      "original"
    )
  ).toBe(true)
  expect(hasLiveCreatorCandidate({ projectTrial: null, trials: [] }, "project", "original")).toBe(
    false
  )
  expect(hasLiveCreatorCandidate({ trials: [{ phase: "needs-approval" }] }, "function")).toBe(true)
})
