// Draft regression: not executed. Import after applying the draft overlay, not against old source.
import { expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "./manifest"
import type { ProjectRuntimeManifest } from "./types"

function fixture(): ProjectRuntimeManifest {
  return {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "supplier-workflow-example", version: "1.0.0" },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "review",
        title: "Review",
        skill: "skills/review/SKILL.md",
        actionIds: [],
        artifactIds: ["report"],
        checkIds: ["exists"],
        approval: "human"
      }
    ],
    actions: [],
    artifacts: [{ id: "report", path: "REPORT.json", required: true }],
    checks: [{ id: "exists", kind: "file-exists", artifactId: "report", sideEffect: "read" }],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: true,
      cancellation: true
    }
  }
}

it("preserves omitted mode exactly for existing declaration digests", () => {
  const input = fixture()
  expect(parseProjectRuntimeManifest(input)).toEqual(input)
  expect(parseProjectRuntimeManifest(input).stages[0]).not.toHaveProperty("executionMode")
})

it.each(["normal", "workflow"] as const)("preserves explicit Host mode %s", (executionMode) => {
  const input = fixture()
  input.stages[0].executionMode = executionMode
  expect(parseProjectRuntimeManifest(input).stages[0]).toMatchObject({
    executionMode,
    approval: "human",
    actionIds: []
  })
})

it.each([true, null, "coordinator", "yolo", { mode: "workflow" }])(
  "rejects unsupported stage modes %j",
  (executionMode) => {
    const input = fixture()
    expect(() =>
      parseProjectRuntimeManifest({ ...input, stages: [{ ...input.stages[0], executionMode }] })
    ).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
  }
)

it("does not enable a workflow in legacy ownership or an action-only Host stage", () => {
  const input = fixture()
  input.stages[0].executionMode = "workflow"
  expect(() =>
    parseProjectRuntimeManifest({ ...input, mode: "legacy", stateOwner: "plugin" })
  ).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
  delete input.stages[0].skill
  expect(() => parseProjectRuntimeManifest(input)).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
})
