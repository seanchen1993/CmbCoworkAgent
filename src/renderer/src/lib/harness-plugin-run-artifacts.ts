import type { HarnessArtifactType, HarnessRunDetailViewModel } from "@/types"

export interface HarnessPluginRunArtifactFile {
  path: string
  artifactType: HarnessArtifactType
}

export interface HarnessPluginRunArtifactsContext {
  projectId: string
  slug: string
  projectRootPath: string
  threadIds: string[]
  files: HarnessPluginRunArtifactFile[]
}

export function buildHarnessPluginRunArtifactsContext(
  detail: HarnessRunDetailViewModel,
  threadIds: string[] = detail.sessions.map((session) => session.threadId)
): HarnessPluginRunArtifactsContext {
  const seenPaths = new Set<string>()
  const files: HarnessPluginRunArtifactFile[] = []

  for (const node of detail.run.nodes) {
    for (const artifact of node.artifacts) {
      if (artifact.artifactStatus !== "generated") continue
      const paths = artifact.paths?.length ? artifact.paths : artifact.path ? [artifact.path] : []

      for (const rawPath of paths) {
        const path = rawPath.trim()
        if (!path || seenPaths.has(path)) continue
        seenPaths.add(path)
        files.push({
          path,
          artifactType: artifact.artifactType
        })
      }
    }
  }

  return {
    projectId: detail.project.projectId,
    slug: detail.run.slug,
    projectRootPath: detail.project.projectRootPath,
    threadIds,
    files
  }
}

export function resolveHarnessPluginRunArtifactPath(
  projectRootPath: string,
  artifactPath: string
): string {
  const normalizedArtifactPath = artifactPath.trim().replace(/\\/g, "/")
  if (/^(?:[a-zA-Z]:\/|\/)/.test(normalizedArtifactPath)) return normalizedArtifactPath

  const normalizedRoot = projectRootPath.replace(/\\/g, "/").replace(/\/+$/, "")
  return `${normalizedRoot}/${normalizedArtifactPath.replace(/^\/+/, "")}`
}
