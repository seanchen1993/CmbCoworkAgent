import { describe, expect, it } from "vitest"
import type {
  DevelopmentBusinessStatus,
  DevelopmentProjectTrialRequest
} from "../../../../shared/mods/development"
import { isHostBusinessCreatorReview } from "./creator-project-route"

const review: NonNullable<DevelopmentBusinessStatus["review"]> = {
  planId: "plan",
  copyId: "copy",
  digest: "a".repeat(64),
  name: "candidate",
  version: "1.0.0",
  phase: "needs-approval",
  steps: [],
  diagnostics: [],
  canConfirm: true
}
const request: DevelopmentProjectTrialRequest = {
  id: "request",
  draftId: "draft",
  name: "candidate",
  revision: 1,
  digest: "b".repeat(64),
  goal: "check",
  origin: {
    kind: "business-assembly",
    planId: review.planId,
    copyId: review.copyId,
    digest: review.digest
  }
}
describe("Host creator route identity", () => {
  it("matches immutable assembly origin rather than the imported project source digest", () => {
    expect(isHostBusinessCreatorReview(request, review)).toBe(true)
    expect(request.digest).not.toBe(review.digest)
  })
  it("keeps unrelated review identities on their existing route", () => {
    for (const origin of [
      { ...request.origin!, planId: "other-plan" },
      { ...request.origin!, copyId: "other-copy" },
      { ...request.origin!, digest: "c".repeat(64) }
    ])
      expect(isHostBusinessCreatorReview({ ...request, origin }, review)).toBe(false)
  })
  it("does not infer a Host association from a title or missing provenance", () => {
    expect(isHostBusinessCreatorReview({ ...request, origin: undefined }, review)).toBe(false)
    expect(isHostBusinessCreatorReview(undefined, review)).toBe(false)
    expect(isHostBusinessCreatorReview(request, undefined)).toBe(false)
    expect(
      isHostBusinessCreatorReview(
        { ...request, origin: { ...request.origin!, planId: "" } },
        { ...review, planId: "" }
      )
    ).toBe(false)
  })
})
