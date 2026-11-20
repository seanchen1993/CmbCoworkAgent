import { describe, expect, it } from "vitest"
import { resolveFeatureWorkspace } from "./harness-feature-workspace"
const units = [
  { deployUnitIdMapping: "id", deployUnitId: "backend", localRepoPath: "/feature/backend" }
]
describe("feature workspace selection", () => {
  it("resolves only the selected feature snapshot", () => {
    expect(resolveFeatureWorkspace({ source: "deployUnit", deployUnitId: "backend" }, units)).toBe(
      "/feature/backend"
    )
    expect(
      resolveFeatureWorkspace({ source: "deployUnit", deployUnitId: "removed" }, units)
    ).toBeUndefined()
  })
  it("does not infer a historical workspace from selected units", () => {
    expect(resolveFeatureWorkspace(undefined, units)).toBeUndefined()
    expect(resolveFeatureWorkspace({ source: "directory", path: " " }, units)).toBeUndefined()
    expect(resolveFeatureWorkspace({ source: "directory", path: "/manual" }, units)).toBe("/manual")
  })
})
