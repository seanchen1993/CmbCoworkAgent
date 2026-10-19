import { expect, it } from "vitest"
import type { HarnessProjectMetadata } from "../../shared/harness-board-types"
import { normalizeHarnessAdapterRun } from "./adapter-run-normalizer"
it("preserves explicit original validator evidence without promoting generated artifacts to valid", () => {
  const raw = {
    workflow: {
      nodes: [
        { id: "review", name: "Review", artifactDefinitions: [{ id: "report", required: true }] }
      ]
    },
    run: {
      featureId: "work",
      currentNodeId: "review",
      featureStatus: "done",
      nodes: [
        {
          id: "review",
          nodeStatus: "done",
          artifacts: [
            {
              id: "report",
              path: "report.md",
              artifactStatus: "generated",
              exists: true,
              validation: { status: "valid", message: "Original check passed" }
            },
            { id: "unchecked", path: "unchecked.md", artifactStatus: "generated" }
          ]
        }
      ]
    }
  }
  const project = {
    workspacePath: process.cwd(),
    projectDir: "fixture",
    projectCode: "fixture"
  } as HarnessProjectMetadata
  const result = normalizeHarnessAdapterRun(
    Buffer.from(JSON.stringify(raw)),
    project,
    "work"
  ).result
  expect(result.run.nodes[0].artifacts[0]).toMatchObject({
    exists: true,
    validation: { status: "valid", message: "Original check passed" }
  })
  expect(result.run.nodes[0].artifacts[1].validation).toBeUndefined()
})
