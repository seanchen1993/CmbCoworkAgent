import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EvolutionCandidate } from "@/api/evolution"
import {
  canPresentReviewCandidateNotification,
  markReviewCandidatesNotified,
  reviewableCandidates,
  unnotifiedReviewCandidates
} from "./evolution-notices"

function candidate(
  candidateId: string,
  skillName: string,
  status = "awaiting_review"
): EvolutionCandidate {
  return {
    candidate_id: candidateId,
    run_id: `run-${candidateId}`,
    status,
    recommendation: null,
    base_skill_id: skillName,
    full_bundle_path: "",
    files_changed: [],
    source_trace_ids: [],
    source_thread_ids: [],
    skill_name: skillName,
    evolution_status: status,
    auto_optimized: true
  }
}

describe("skill evolution review notifications", () => {
  let values: Map<string, string>

  beforeEach(() => {
    values = new Map()
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("only treats a visible and focused renderer as a delivered notification surface", () => {
    expect(
      canPresentReviewCandidateNotification({ visibilityState: "visible", hasFocus: true })
    ).toBe(true)
    expect(
      canPresentReviewCandidateNotification({ visibilityState: "hidden", hasFocus: true })
    ).toBe(false)
    expect(
      canPresentReviewCandidateNotification({ visibilityState: "visible", hasFocus: false })
    ).toBe(false)
  })

  it("matches only awaiting-review candidates owned by the current creator", () => {
    const ownedSkillKeys = new Set(["my-skill"])
    const candidates = [
      candidate("owned", "$my-skill-v1.2.3"),
      candidate("other", "other-skill"),
      candidate("published", "my-skill", "published")
    ]

    expect(
      reviewableCandidates(candidates, ownedSkillKeys).map((item) => item.candidate_id)
    ).toEqual(["owned"])
  })

  it("deduplicates only after candidates are explicitly marked as notified", () => {
    const first = candidate("first", "my-skill")
    const second = candidate("second", "my-skill")

    expect(unnotifiedReviewCandidates([first, second])).toEqual([first, second])
    markReviewCandidatesNotified([first])
    expect(unnotifiedReviewCandidates([first, second])).toEqual([second])
  })

  it("does not trust legacy receipts that may have been recorded while the app was hidden", () => {
    const pending = candidate("legacy-hidden", "my-skill")
    values.set(
      "trace-evolver-review-notified-candidate-ids",
      JSON.stringify([pending.candidate_id])
    )

    expect(unnotifiedReviewCandidates([pending])).toEqual([pending])
  })
})
