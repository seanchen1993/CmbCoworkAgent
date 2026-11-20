import { resolveHarnessFeatureBindingContext } from "../../agent/standard-thread-turn"
import { getHarnessProjectDetail, readHarnessFeatureMetadata } from "../../harness-board/service"
import type { ImTargetSnapshot } from "./conversation-state"

export interface ImProjectModeReplyContext {
  projectName: string
  featureName: string
  nodeName: string | null
  nodeStatus: string | null
}

/**
 * Resolves display-only context for an IM reply. Execution already resolves the
 * same project binding; failures here must only degrade labels to stable ids or
 * "未知" and must never affect the turn or its delivery.
 */
export async function resolveImProjectModeReplyContext(input: {
  metadata: Record<string, unknown>
  target?: ImTargetSnapshot
}): Promise<ImProjectModeReplyContext | null> {
  const feature = readHarnessFeatureMetadata(input.metadata)
  if (!feature) return null

  const target =
    input.target?.kind === "feature" &&
    input.target.projectId === feature.projectId &&
    input.target.featureSlug === feature.slug
      ? input.target
      : undefined
  let projectName = target?.projectName?.trim() || ""
  let featureName = target?.featureTitle?.trim() || ""

  const [binding, detail] = await Promise.all([
    resolveHarnessFeatureBindingContext(input.metadata),
    projectName && featureName
      ? Promise.resolve(null)
      : getHarnessProjectDetail(feature.projectId, {
          scope: `im-reply-context:${feature.projectId}:${feature.slug}`
        }).catch(() => null)
  ])

  if (detail) {
    projectName ||= detail.project.name.trim()
    featureName ||= detail.runs.find((run) => run.slug === feature.slug)?.title.trim() || ""
  }

  return {
    projectName: projectName || feature.projectId,
    featureName: featureName || feature.slug,
    nodeName: binding?.nodeName?.trim() || null,
    nodeStatus: binding?.nodeStatus?.trim() || null
  }
}
