import { matchesOrdinaryThreadScope } from "../../shared/thread-search-scope"
import type { ThreadGroupSelector } from "../types"

function readNestedMetadataObject(
  metadata: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = metadata[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Mirror the renderer's project-session-first classification and the worker selector SQL. */
export function threadMetadataMatchesGroupSelector(
  metadata: Record<string, unknown>,
  selector: ThreadGroupSelector
): boolean {
  if (selector.type === "workspace") {
    return matchesOrdinaryThreadScope({ metadata }, selector.workspacePath)
  }

  const feature = readNestedMetadataObject(metadata, "harnessFeature")
  const projectSession = readNestedMetadataObject(metadata, "harnessProjectSession")
  const featureProject = typeof feature?.projectId === "string" ? feature.projectId.trim() : ""
  const featureSlug = typeof feature?.slug === "string" ? feature.slug.trim() : ""
  const projectSessionProject =
    typeof projectSession?.projectId === "string" ? projectSession.projectId.trim() : ""
  const projectSessionKind =
    typeof projectSession?.kind === "string" ? projectSession.kind.trim() : ""
  const isValidFeature = Boolean(featureProject && featureSlug)
  const isValidProjectSession = Boolean(projectSessionProject && projectSessionKind)

  if (selector.type === "harness-feature") {
    return (
      !isValidProjectSession &&
      isValidFeature &&
      featureProject === selector.projectId &&
      featureSlug === selector.slug
    )
  }
  return isValidProjectSession
    ? projectSessionProject === selector.projectId
    : isValidFeature && featureProject === selector.projectId
}
