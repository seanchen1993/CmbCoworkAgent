import { describe, expect, it } from "vitest"
import type { CreatorProjectTrialJourney } from "../../../../shared/mods/creator-trial-journey"
import { creatorJourneyView } from "./creator-journey-view"

function fixture(): CreatorProjectTrialJourney {
  return {
    projectId: "project",
    creatorThreadId: "creator",
    candidateDigest: "digest",
    workspace: "workspace",
    phase: "passed",
    canDeliver: true,
    operationsTruncated: false,
    diagnostics: [],
    stages: [
      {
        id: "stage",
        title: "Stage",
        status: "passed",
        artifacts: [],
        sessions: [],
        checks: [{ id: "check", artifactId: "artifact", result: "passed" }]
      }
    ]
  }
}
const scope = { threadId: "creator", digest: "digest" }
describe("creator journey verdict", () => {
  it("requires native evidence for the current creator and candidate", () => {
    expect(creatorJourneyView(fixture(), scope).passed).toBe(true)
    expect(creatorJourneyView(fixture(), { ...scope, digest: "changed" }).passed).toBe(false)
    expect(creatorJourneyView(fixture(), { ...scope, threadId: "other" }).current).toBe(false)
    expect(creatorJourneyView(undefined, scope).passed).toBe(false)
  })
  it("never treats completed sessions as stage acceptance", () => {
    const journey = fixture()
    journey.phase = "needs-transition"
    journey.stages[0].status = "checks-passed"
    journey.stages[0].sessions = [
      { threadId: "stage-chat", operationId: "op", status: "completed", terminalOutcome: "success" }
    ]
    expect(creatorJourneyView(journey, scope).passed).toBe(false)
    expect(creatorJourneyView(journey, scope).nextStep).toContain("下一步")
  })
  it("keeps an invalidated source's historical pass from becoming the current verdict", () => {
    const journey = fixture()
    journey.candidateCurrent = false
    journey.canDeliver = false
    const view = creatorJourneyView(journey, scope)
    expect(view.current).toBe(false)
    expect(view.passed).toBe(false)
    expect(view.label).toContain("待重新核对")
    expect(journey.phase).toBe("passed")
    expect(journey.stages[0].checks[0].result).toBe("passed")
  })
  it("does not label incomplete or failed evidence as passed", () => {
    for (const change of [
      (value: CreatorProjectTrialJourney) => {
        value.operationsTruncated = true
      },
      (value: CreatorProjectTrialJourney) => {
        value.canDeliver = false
      },
      (value: CreatorProjectTrialJourney) => {
        value.stages = []
      },
      (value: CreatorProjectTrialJourney) => {
        value.stages[0].checks[0].result = "unknown"
      },
      (value: CreatorProjectTrialJourney) => {
        value.stages[0].checks[0].result = "failed"
      }
    ]) {
      const journey = fixture()
      change(journey)
      expect(creatorJourneyView(journey, scope).passed).toBe(false)
    }
  })
})
