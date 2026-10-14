import { expect, it } from "vitest"
import { projectModeMetricTimeFilters } from "./project-mode-query-scope"
import {
  projectModeSnapshotFilters,
  projectModeSnapshotFilterArgs
} from "./project-mode-snapshot-filters"

it("omits metric dates for lifetime while preserving the selected overview range", () => {
  const range = { from: "2026-10-01", to: "2026-10-14" }
  for (const field of ["startedAt", "eventTime", "properties.generatedAt"]) {
    expect(projectModeMetricTimeFilters(field, null)).toEqual([])
    expect(projectModeMetricTimeFilters(field, range)).toEqual([
      { range: { [field]: { gte: range.from, lte: range.to } } }
    ])
  }
})

it("uses dates for newly-created membership only, with permissions and Lean filters intact", () => {
  const org = { term: { upperOrgLv1: "本室" } }
  const range = { from: "2026-10-01", to: "2026-10-14" }
  const selected = projectModeSnapshotFilters(
    org,
    ...projectModeSnapshotFilterArgs({ createdInRangeOnly: true, fromLeanOnly: true }, range)
  )
  expect(selected).toContainEqual(org)
  expect(JSON.stringify(selected)).toContain("lifecycleCreatedAt")
  expect(JSON.stringify(selected)).toContain("projectFromLean")
  expect(projectModeSnapshotFilters(org, false, false, range)).toEqual(
    projectModeSnapshotFilters(org, false, false, null)
  )
})
