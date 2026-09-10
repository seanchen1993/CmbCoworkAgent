import { describe, expect, it, vi } from "vitest"

import type { HarnessRunDetailViewModel } from "@/types"
import {
  areHarnessPluginRunArtifactsContextsEqual,
  buildHarnessPluginRunArtifactsContext,
  ensureHarnessPluginRunArtifactPreviewAuthorization,
  getHarnessPluginRunArtifactsSnapshot,
  isHarnessPluginRunArtifactGrantFresh,
  publishHarnessPluginRunArtifacts,
  resolveHarnessPluginRunArtifactPath,
  subscribeHarnessPluginRunArtifacts,
  type HarnessPluginRunArtifactsContext
} from "./harness-plugin-run-artifacts"

function detail(): HarnessRunDetailViewModel {
  return {
    artifactPreviewGrant: "main-issued-grant",
    artifactPreviewGrantExpiresAt: 1_800_000,
    project: {
      projectId: "project-a",
      projectRootPath: "C:/workspace/project-a"
    },
    run: {
      slug: "feature-a",
      nodes: [
        {
          artifacts: [
            {
              artifactStatus: "generated",
              artifactType: "file",
              path: "output/report.md"
            }
          ]
        }
      ]
    }
  } as unknown as HarnessRunDetailViewModel
}

describe("Harness plugin run artifact context", () => {
  it("carries the main-issued preview capability with the bounded projection", () => {
    expect(buildHarnessPluginRunArtifactsContext(detail(), ["thread-a"])).toMatchObject({
      projectId: "project-a",
      slug: "feature-a",
      projectRootPath: "C:/workspace/project-a",
      threadIds: ["thread-a"],
      previewGrant: "main-issued-grant",
      previewGrantExpiresAt: 1_800_000,
      truncated: false,
      files: [{ path: "output/report.md", artifactType: "file" }]
    })
  })

  it("renews lazily when the five-minute capability is near or past expiry", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"))
      const expiresAt = Date.now() + 5 * 60 * 1000

      expect(isHarnessPluginRunArtifactGrantFresh("grant", expiresAt)).toBe(true)
      vi.advanceTimersByTime(4 * 60 * 1000 + 46 * 1000)
      expect(isHarnessPluginRunArtifactGrantFresh("grant", expiresAt)).toBe(false)
      vi.advanceTimersByTime(30 * 1000)
      expect(isHarnessPluginRunArtifactGrantFresh("grant", expiresAt)).toBe(false)
      expect(isHarnessPluginRunArtifactGrantFresh(undefined, expiresAt)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("renews an already-open preview before a read after the five-minute expiry", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"))
      const authorization = {
        grant: "initial-grant",
        expiresAt: Date.now() + 5 * 60 * 1000,
        projectId: "project-a",
        slug: "feature-a",
        filePath: "C:/workspace/project-a/output/report.md"
      }
      const renewedExpiresAt = Date.now() + 10 * 60 * 1000
      const refresh = vi.fn().mockResolvedValue({
        success: true as const,
        grant: "renewed-grant",
        expiresAt: renewedExpiresAt
      })

      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const renewed = await ensureHarnessPluginRunArtifactPreviewAuthorization(
        authorization,
        refresh
      )

      expect(refresh).toHaveBeenCalledOnce()
      expect(refresh).toHaveBeenCalledWith({
        projectId: "project-a",
        slug: "feature-a",
        filePath: "C:/workspace/project-a/output/report.md"
      })
      expect(renewed).toMatchObject({
        grant: "renewed-grant",
        expiresAt: renewedExpiresAt
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("resolves only normalized descendants of the trusted project root", () => {
    expect(
      resolveHarnessPluginRunArtifactPath("C:\\workspace\\project", "output/../report.md")
    ).toBe("C:/workspace/project/report.md")
    expect(
      resolveHarnessPluginRunArtifactPath(
        "C:/workspace/project",
        "C:/workspace/project/output/report.md"
      )
    ).toBe("C:/workspace/project/output/report.md")
    expect(
      resolveHarnessPluginRunArtifactPath("C:/workspace/project", "../secret.txt")
    ).toBeNull()
    expect(
      resolveHarnessPluginRunArtifactPath(
        "C:/workspace/project",
        "C:/workspace/project-other/report.md"
      )
    ).toBeNull()
    expect(resolveHarnessPluginRunArtifactPath("C:/", "output/report.md")).toBe(
      "C:/output/report.md"
    )
    expect(
      resolveHarnessPluginRunArtifactPath(
        "\\\\server\\share\\project",
        "output/report.md"
      )
    ).toBe("//server/share/project/output/report.md")
  })

  it("compares semantic snapshots so the external store can skip unchanged updates", () => {
    const first = buildHarnessPluginRunArtifactsContext(detail(), ["thread-a"])
    const same = {
      ...first,
      threadIds: [...first.threadIds],
      files: first.files.map((file) => ({ ...file }))
    }
    const changed: HarnessPluginRunArtifactsContext = {
      ...same,
      files: [{ path: "output/other.md", artifactType: "file" }]
    }

    expect(areHarnessPluginRunArtifactsContextsEqual(first, same)).toBe(true)
    expect(areHarnessPluginRunArtifactsContextsEqual(first, changed)).toBe(false)
    expect(
      areHarnessPluginRunArtifactsContextsEqual(first, {
        ...same,
        previewGrantExpiresAt: same.previewGrantExpiresAt! + 1
      })
    ).toBe(false)
  })

  it("notifies only right-panel subscribers when the semantic snapshot changes", () => {
    publishHarnessPluginRunArtifacts(null)
    const first = buildHarnessPluginRunArtifactsContext(detail(), ["thread-a"])
    let notifications = 0
    const unsubscribe = subscribeHarnessPluginRunArtifacts(() => {
      notifications += 1
    })

    try {
      publishHarnessPluginRunArtifacts(first)
      publishHarnessPluginRunArtifacts({
        ...first,
        threadIds: [...first.threadIds],
        files: first.files.map((file) => ({ ...file }))
      })

      expect(getHarnessPluginRunArtifactsSnapshot()).toBe(first)
      expect(notifications).toBe(1)

      publishHarnessPluginRunArtifacts(null)
      expect(getHarnessPluginRunArtifactsSnapshot()).toBeNull()
      expect(notifications).toBe(2)
    } finally {
      unsubscribe()
      publishHarnessPluginRunArtifacts(null)
    }
  })
})
