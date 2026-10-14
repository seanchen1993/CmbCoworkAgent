import { expect, it } from "vitest"
import { compareProjectVersions } from "./version-report"
import { hostProjectFixture } from "../../main/harness-board/project-runtime/host-fixtures.test-helper"
import type { HostProjectState } from "./host-types"

it("keeps the running version and identifies approval, artifact, check and dependency changes", () => {
  const current = hostProjectFixture("C:/fixture") as HostProjectState
  const candidate = structuredClone(current.manifest)
  candidate.plugin.version = "2.0.0"
  candidate.stages[0].approval = "human"
  candidate.artifacts[0].path = "other.md"
  candidate.checks = []
  candidate.actions = [
    {
      id: "new",
      ref: {
        pluginId: "installed",
        plugin: "provider",
        digest: "a".repeat(64),
        actionId: "exported"
      }
    }
  ]
  const report = compareProjectVersions(current, candidate)
  expect(report.status).toBe("review-required")
  expect(report.differences).toHaveLength(5)
  expect(current.manifest.plugin.version).toBe("1.0.0")
  expect(report.guidance).toContain("不会撤销")
  expect(compareProjectVersions(current, current.manifest).status).toBe("unchanged-declaration")
  expect(compareProjectVersions(current, undefined).status).toBe("unavailable")
})
