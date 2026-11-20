import { describe, expect, it } from "vitest"

import type { HarnessArtifact, HarnessRunDetailViewModel } from "./harness-board-types"
import {
  HARNESS_PLUGIN_RUN_ARTIFACT_LIMIT,
  HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT,
  projectHarnessPluginRunArtifacts
} from "./harness-plugin-run-artifacts"

function detailWithArtifacts(artifacts: HarnessArtifact[]): HarnessRunDetailViewModel {
  return {
    run: {
      nodes: [{ artifacts }]
    }
  } as unknown as HarnessRunDetailViewModel
}

function artifact(
  path: string | null,
  options: Partial<HarnessArtifact> = {}
): HarnessArtifact {
  return {
    id: path ?? "artifact",
    artifactLabel: path ?? "artifact",
    artifactType: "file",
    path,
    required: false,
    artifactStatus: "generated",
    status: { label: "已生成", uiKind: "done" },
    ...options
  }
}

describe("Harness plugin run artifact projection", () => {
  it("keeps generated paths only and deduplicates repeated entries", () => {
    const projection = projectHarnessPluginRunArtifacts(
      detailWithArtifacts([
        artifact(" output/a.txt "),
        artifact("output/a.txt"),
        artifact("missing.txt", { artifactStatus: "missing" }),
        artifact(null, { paths: ["output/b.json", "output/b.json"] })
      ])
    )

    expect(projection).toEqual({
      files: [
        { path: "output/a.txt", artifactType: "file" },
        { path: "output/b.json", artifactType: "file" }
      ],
      truncated: false
    })
  })

  it("bounds a single artifact with tens of thousands of paths", () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `output/${index}.txt`)
    const projection = projectHarnessPluginRunArtifacts(
      detailWithArtifacts([artifact(null, { paths })])
    )

    expect(projection.files).toHaveLength(HARNESS_PLUGIN_RUN_ARTIFACT_LIMIT)
    expect(projection.files.at(-1)?.path).toBe(
      `output/${HARNESS_PLUGIN_RUN_ARTIFACT_LIMIT - 1}.txt`
    )
    expect(projection.truncated).toBe(true)
  })

  it("bounds empty and duplicate path scans even when no unique-file limit is reached", () => {
    const emptyProjection = projectHarnessPluginRunArtifacts(
      detailWithArtifacts([
        artifact(null, {
          paths: Array.from(
            { length: HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT * 4 },
            () => "   "
          )
        })
      ])
    )
    expect(emptyProjection).toEqual({ files: [], truncated: true })

    const duplicateProjection = projectHarnessPluginRunArtifacts(
      detailWithArtifacts([
        artifact(null, {
          paths: Array.from(
            { length: HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT * 4 },
            () => "output/same.txt"
          )
        })
      ])
    )
    expect(duplicateProjection).toEqual({
      files: [{ path: "output/same.txt", artifactType: "file" }],
      truncated: true
    })
  })
})
