import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import type { HarnessFeatureDeployUnitBinding } from "../../shared/harness-board-types"
import {
  harnessDeployUnitTelemetry,
  parseStoredDeployUnitIds,
  resolveCodeDeployUnit,
  snapshotHarnessDeployUnits
} from "./harness-deploy-unit-attribution"

const root = resolve("/repo")
const binding = (pairs: Array<[string, string]>): HarnessFeatureDeployUnitBinding => ({
  projectId: "p",
  featureId: "f",
  sessionContextInjectionSource: "cmbdevclaw",
  selectedDeployUnitMappings: pairs.map(([deployUnitId, localRepoPath]) => ({
    deployUnitIdMapping: deployUnitId,
    deployUnitId,
    localRepoPath
  }))
})

describe("generation-time deploy-unit attribution", () => {
  it("takes a detached binding snapshot and only serializes unit IDs", () => {
    const source = binding([
      ["outer", root],
      ["inner", resolve(root, "nested")]
    ])
    source.sessionWorkspace = { source: "deployUnit", deployUnitId: "inner" }
    const snapshot = snapshotHarnessDeployUnits(source)!
    source.selectedDeployUnitMappings[0].deployUnitId = "changed"
    const telemetry = harnessDeployUnitTelemetry(snapshot)
    expect(telemetry).toEqual({
      harnessDeployUnitIds: ["inner", "outer"],
      harnessSessionDeployUnitId: "inner"
    })
    expect(JSON.stringify(telemetry)).not.toContain(root)
    telemetry.harnessDeployUnitIds?.push("mutated")
    expect(snapshot.ids).toEqual(["inner", "outer"])
  })
  it("uses the nearest repository and never assigns siblings, relative paths or ambiguous mappings", () => {
    const snapshot = snapshotHarnessDeployUnits(
      binding([
        ["outer", root],
        ["inner", resolve(root, "nested")],
        ["a", resolve(root, "ambiguous")],
        ["b", resolve(root, "ambiguous")]
      ])
    )
    expect(resolveCodeDeployUnit(snapshot, resolve(root, "index.ts"))).toBe("outer")
    expect(resolveCodeDeployUnit(snapshot, resolve(root, "nested/index.ts"))).toBe("inner")
    expect(resolveCodeDeployUnit(snapshot, resolve(root, "ambiguous/index.ts"))).toBeUndefined()
    expect(resolveCodeDeployUnit(snapshot, resolve(root, "../repo-other/index.ts"))).toBeUndefined()
    expect(resolveCodeDeployUnit(snapshot, "relative.ts")).toBeUndefined()
    expect(resolveCodeDeployUnit(snapshot, root)).toBeUndefined()
  })
  it("keeps unavailable historical attribution distinct from an explicitly empty binding", () => {
    expect(snapshotHarnessDeployUnits(null)).toBeNull()
    expect(harnessDeployUnitTelemetry(null)).toEqual({})
    expect(harnessDeployUnitTelemetry(snapshotHarnessDeployUnits(binding([])))).toEqual({
      harnessDeployUnitIds: []
    })
    expect(parseStoredDeployUnitIds(null)).toBeUndefined()
    expect(parseStoredDeployUnitIds("broken")).toBeUndefined()
    expect(parseStoredDeployUnitIds('["a", 2]')).toBeUndefined()
    expect(parseStoredDeployUnitIds('[" b ", "a", "b"]')).toEqual(["a", "b"])
    expect(parseStoredDeployUnitIds("[]")).toEqual([])
    const unresolvedPath = snapshotHarnessDeployUnits(binding([["bound", "relative/repo"]]))
    expect(harnessDeployUnitTelemetry(unresolvedPath)).toEqual({ harnessDeployUnitIds: ["bound"] })
    expect(resolveCodeDeployUnit(unresolvedPath, resolve(root, "file.ts"))).toBeUndefined()
  })
})
