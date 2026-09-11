import type { HarnessArtifactType, HarnessRunDetailViewModel } from "./harness-board-types"

// The adapter response is bounded by IPC bytes, but one artifact can still
// expose tens of thousands of paths. Keep both projection CPU and renderer DOM
// work deterministic regardless of plugin output size.
export const HARNESS_PLUGIN_RUN_ARTIFACT_LIMIT = 256
export const HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT = 4_096

export interface HarnessPluginRunArtifactFile {
  path: string
  artifactType: HarnessArtifactType
}

export interface HarnessPluginRunArtifactProjection {
  files: HarnessPluginRunArtifactFile[]
  truncated: boolean
}

export function projectHarnessPluginRunArtifacts(
  detail: HarnessRunDetailViewModel
): HarnessPluginRunArtifactProjection {
  const seenPaths = new Set<string>()
  const files: HarnessPluginRunArtifactFile[] = []
  let inspectedEntries = 0
  let truncated = false

  scan: for (const node of detail.run.nodes) {
    for (const artifact of node.artifacts) {
      inspectedEntries += 1
      if (inspectedEntries > HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT) {
        truncated = true
        break scan
      }
      if (artifact.artifactStatus !== "generated") continue
      const paths = artifact.paths?.length ? artifact.paths : artifact.path ? [artifact.path] : []

      for (const rawPath of paths) {
        inspectedEntries += 1
        if (inspectedEntries > HARNESS_PLUGIN_RUN_ARTIFACT_SCAN_LIMIT) {
          truncated = true
          break scan
        }
        const path = rawPath.trim()
        if (!path || seenPaths.has(path)) continue
        if (files.length >= HARNESS_PLUGIN_RUN_ARTIFACT_LIMIT) {
          truncated = true
          break scan
        }
        seenPaths.add(path)
        files.push({ path, artifactType: artifact.artifactType })
      }
    }
  }

  return { files, truncated }
}
