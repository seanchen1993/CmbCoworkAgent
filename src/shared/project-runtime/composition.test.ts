import { describe, expect, it } from "vitest"
import { parseCompositionCompletion, parseProjectComposition } from "./composition"

const unit = {
  id: "first",
  kind: "flow",
  source: { pluginId: "installed", capabilityId: "delivery", packageDigest: "a".repeat(64) },
  inputs: [],
  outputs: [{ id: "report", path: "reports/result.json" }]
}
const definition = {
  apiVersion: "devclaw.project-composition/v1",
  parentProjectId: "parent",
  workspace: "/workspace",
  units: [unit]
}
describe("project composition contracts", () => {
  it("retains only bounded workflow identity and node selection, never executable config", () => {
    const workflow = { templateId: "custom", nodeIds: ["dev.code", "ops.archive"] }
    expect(parseProjectComposition({ ...definition, units: [{ ...unit, workflow }] })
      .units[0].workflow).toEqual(workflow)
    for (const invalid of [{ ...workflow, config: {} }, { ...workflow, nodeIds: [] },
      { ...workflow, nodeIds: ["dev.code", "dev.code"] }, { ...workflow, nodeIds: ["../run"] }])
      expect(() => parseProjectComposition({ ...definition,
        units: [{ ...unit, workflow: invalid }] })).toThrow()
  })
  it("validates ordered explicit artifact mappings and clones caller data", () => {
    const second = {
      ...unit,
      id: "second",
      inputs: [{ inputId: "source", fromUnitId: "first", artifactId: "report" }]
    }
    const parsed = parseProjectComposition({ ...definition, units: [unit, second] })
    expect(parsed.units[1].inputs[0].fromUnitId).toBe("first")
    parsed.units[0].source.pluginId = "different"
    expect(unit.source.pluginId).toBe("installed")
  })
  it("rejects unknown keys, duplicate identity, unsafe paths, cycles and missing artifact mappings", () => {
    for (const value of [
      { ...definition, extra: true },
      { ...definition, workspace: "relative" },
      { ...definition, units: [unit, unit] },
      { ...definition, units: Array.from({ length: 17 }, (_, i) => ({ ...unit, id: `unit${i}` })) },
      {
        ...definition,
        units: [{ ...unit, inputs: [{ inputId: "x", fromUnitId: "first", artifactId: "report" }] }]
      },
      { ...definition, units: [{ ...unit, outputs: [{ id: "report", path: "../outside" }] }] },
      { ...definition, units: [{ ...unit, source: { ...unit.source, packageDigest: "latest" } }] }
    ])
      expect(() => parseProjectComposition(value)).toThrow()
  })
  it("requires exact full completion proof and declared output provenance", () => {
    const parsed = parseProjectComposition(definition).units[0]
    const proof = {
      kind: "flow-completed",
      engineRunId: "engine",
      evidenceDigest: "b".repeat(64),
      artifacts: [{ id: "report", path: "reports/result.json", digest: "c".repeat(64) }]
    }
    expect(parseCompositionCompletion(proof, parsed)).toEqual(proof)
    for (const invalid of [
      { ...proof, kind: "agent-success" },
      { ...proof, kind: "stage-transitioned" },
      { ...proof, artifacts: [] },
      { ...proof, artifacts: [{ ...proof.artifacts[0], path: "other" }] }
    ])
      expect(() => parseCompositionCompletion(invalid, parsed)).toThrow()
  })
})

it("retains user goals without granting additional execution fields", () => {
  expect(parseProjectComposition({ ...definition, goal: "Write a report\nThen review it." }).goal).toBe("Write a report\nThen review it.")
  expect(parseProjectComposition(definition).goal).toBeUndefined()
  for (const goal of ["", " ", null, 1, "x".repeat(16001), "bad\u0000goal"])
    expect(() => parseProjectComposition({ ...definition, goal })).toThrow("GOAL_INVALID")
})
