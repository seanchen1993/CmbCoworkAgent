import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import type { HarnessRunDetailViewModel } from "../../../shared/harness-board-types"
import type { ProjectRuntimeBinding } from "../../../shared/project-runtime"
import { prepareLegacyRuntimeAction, projectLegacyRuntimeSnapshot } from "./legacy-adapter"

const workspace = resolve("project-runtime-test-workspace")
const binding: ProjectRuntimeBinding = {
  projectId: "project",
  featureId: "feature",
  workspace,
  pluginId: "docs",
  pluginDigest: null
}
function fixture(): HarnessRunDetailViewModel {
  return {
    project: {
      projectId: "project",
      name: "Project",
      projectCode: "p",
      projectDir: "p",
      systemId: "s",
      workspacePath: workspace,
      projectRootPath: workspace
    },
    adapterSnapshot: { mode: "run", mock: false },
    workflow: {
      display: { mode: "ordered_nodes" },
      nodes: [
        {
          id: "draft",
          label: "Draft",
          states: [
            {
              nodeStatus: "in_progress",
              nextAction: { slashSkill: "/draft", preferredPlugin: { id: "docs" } }
            }
          ]
        }
      ]
    },
    run: {
      id: "run",
      kind: "feature",
      slug: "feature",
      title: "Feature",
      hookLogRefs: [],
      watchRefs: [],
      skipNodeAvailable: false,
      selectedDeployUnits: [],
      resolvedSessionWorkspacePath: workspace,
      currentNodeId: "draft",
      unmatchedHooks: [],
      nodes: [
        {
          id: "draft",
          label: "Draft",
          nodeStatus: "in_progress",
          status: { label: "进行中", uiKind: "active" },
          artifacts: [],
          hooks: [
            {
              ts: "2026-10-12",
              source: "hook",
              sessionId: "session",
              pluginId: "docs",
              featureId: "feature",
              eventId: "event",
              eventStatus: "success",
              message: "complete",
              nodeId: "draft"
            }
          ]
        }
      ]
    },
    sessions: []
  }
}
describe("legacy runtime projection", () => {
  it.each([
    ["39b92d86d26167ac0a8b9eb6a6d5e8903ac66d4a", 7],
    ["4bf3690e53a86f8b5aa2a94f3f7d620b39b2d58c", 11]
  ] as const)(
    "projects the real heterogeneous upstream board at %s without inventing a uniform route",
    (commit, count) => {
      // These are two immutable upstream variants, not a claimed second data-development plugin.
      const config = JSON.parse(
        execFileSync(
          "git",
          [
            "--no-replace-objects",
            "-C",
            process.env.CMB_AUTOBIZ_SOURCE || "C:/ai/autobiz_kanban",
            "show",
            `${commit}:board_core/board_config.json`
          ],
          { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }
        )
      )
      const detail = fixture()
      const nodes = config.workflow.nodes as Array<{ id: string; label: string }>
      detail.workflow = { ...config.workflow, display: { mode: "ordered_nodes" } }
      detail.run.nodes = nodes.map((node) => ({
        ...structuredClone(detail.run.nodes[0]),
        id: node.id,
        label: node.label,
        hooks: []
      }))
      detail.run.currentNodeId = nodes[0].id
      const result = projectLegacyRuntimeSnapshot(detail, binding)
      expect(result.stages.map((stage) => stage.id)).toEqual(nodes.map((node) => node.id))
      expect(result.stages).toHaveLength(count)
      expect(result.support.requestTransition).toBe(false)
      expect(result).not.toHaveProperty("stateVersion")
    }
  )
  it("marks historical success as unknown validity and never offers state writes", () => {
    const detail = fixture()
    const before = structuredClone(detail)
    const result = projectLegacyRuntimeSnapshot(detail, binding)
    expect(result.evidence[0]).toMatchObject({ validity: "unknown", historicalStatus: "success" })
    expect(result.support.requestTransition).toBe(false)
    expect(result).not.toHaveProperty("stateVersion")
    expect(detail).toEqual(before)
  })
  it("rejects wrong host identity, workspace, plugin digest and mock state", () => {
    for (const override of [
      { featureId: "other" },
      { projectId: "other" },
      { workspace: resolve("other") },
      { pluginDigest: "latest" }
    ])
      expect(() => projectLegacyRuntimeSnapshot(fixture(), { ...binding, ...override })).toThrow()
    const detail = fixture()
    detail.adapterSnapshot.mock = true
    expect(() => projectLegacyRuntimeSnapshot(detail, binding)).toThrow()
  })
  it("invalidates observations when stage facts change and only prepares original instructions", () => {
    const detail = fixture()
    const original = projectLegacyRuntimeSnapshot(detail, binding)
    expect(
      prepareLegacyRuntimeAction(detail, binding, original.observationFingerprint)
    ).toMatchObject({
      status: "prepared",
      slashSkill: "/draft",
      preferredPlugin: { id: "docs" },
      execution: "existing-session-entry"
    })
    detail.run.nodes[0].nodeStatus = "done"
    expect(
      prepareLegacyRuntimeAction(detail, binding, original.observationFingerprint).status
    ).toBe("blocked")
  })
  it("drops evidence from another feature and blocks missing current stage", () => {
    const detail = fixture()
    detail.run.nodes[0].hooks[0].featureId = "other"
    expect(projectLegacyRuntimeSnapshot(detail, binding).evidence).toEqual([])
    detail.run.currentNodeId = "missing"
    expect(prepareLegacyRuntimeAction(detail, binding).status).toBe("blocked")
  })
})
