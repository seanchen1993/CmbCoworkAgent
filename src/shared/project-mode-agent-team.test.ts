import { describe, expect, it } from "vitest"
import {
  areForcedCoordinatorRequestsAllowed,
  isCoordinatorModeForcedForMetadata,
  isHarnessProjectModeMetadata,
  isProjectModeAgentTeamEnabled,
  isProjectModeAgentTeamSelectionDisabled
} from "./project-mode-agent-team"

describe("project mode Agent Team policy", () => {
  it("recognizes only complete durable Harness bindings", () => {
    expect(
      isHarnessProjectModeMetadata({ harnessFeature: { projectId: "project", slug: "feature" } })
    ).toBe(true)
    expect(
      isHarnessProjectModeMetadata({
        harnessProjectSession: { projectId: "project", kind: "chat" }
      })
    ).toBe(true)
    expect(isHarnessProjectModeMetadata({ harnessFeature: { projectId: "project" } })).toBe(false)
  })

  it("blocks forced requests in project mode unless the feature gate is enabled", () => {
    const metadata = { harnessFeature: { projectId: "project", slug: "feature" } }
    expect(areForcedCoordinatorRequestsAllowed(metadata, false)).toBe(false)
    expect(areForcedCoordinatorRequestsAllowed(metadata, true)).toBe(true)
    expect(areForcedCoordinatorRequestsAllowed({}, false)).toBe(true)
    expect(isProjectModeAgentTeamEnabled(" 1 ")).toBe(true)
    expect(isProjectModeAgentTeamEnabled("true")).toBe(false)
  })

  it("keeps a persisted plugin Team task visible while disabling new Team selection", () => {
    expect(isProjectModeAgentTeamSelectionDisabled({ agentMode: "normal" }, true, false)).toBe(
      true
    )
    expect(
      isProjectModeAgentTeamSelectionDisabled({ agentMode: "coordinator" }, true, false)
    ).toBe(false)
    expect(
      isProjectModeAgentTeamSelectionDisabled({ coordinatorMode: true }, true, false)
    ).toBe(false)
    expect(isProjectModeAgentTeamSelectionDisabled({ agentMode: "normal" }, true, true)).toBe(
      false
    )
  })

  it.each(["normal", "multi", "workflow"] as const)(
    "lets a persisted project Team task leave for %s even when the global override is set",
    (targetMode) => {
      const metadata = {
        agentMode: "coordinator",
        harnessFeature: { projectId: "project", slug: "feature" }
      }
      const scopedForced = isCoordinatorModeForcedForMetadata(metadata, false, true)
      expect(isProjectModeAgentTeamSelectionDisabled(metadata, true, false)).toBe(false)
      expect(scopedForced, `${targetMode} must not be blocked by the global override`).toBe(false)
    }
  )

  it("keeps the environment override for an ordinary conversation", () => {
    expect(isCoordinatorModeForcedForMetadata({ agentMode: "normal" }, false, true)).toBe(true)
    expect(isCoordinatorModeForcedForMetadata({ agentMode: "normal" }, false, false)).toBe(false)
  })
})
