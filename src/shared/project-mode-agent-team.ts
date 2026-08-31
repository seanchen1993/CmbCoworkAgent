import { resolveAgentModeFromMetadata } from "./agent-mode-metadata"

function readNestedMetadataRecord(
  metadata: Record<string, unknown>,
  key: "harnessFeature" | "harnessProjectSession"
): Record<string, unknown> | null {
  const value = metadata[key]
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasNonEmptyString(record: Record<string, unknown> | null, key: string): boolean {
  return typeof record?.[key] === "string" && record[key].trim().length > 0
}

export function isProjectModeAgentTeamEnabled(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "1"
}

/**
 * The gate blocks selecting/forcing Team for a normal project task, but an
 * already-persisted coordinator task must remain visible as coordinator. This
 * keeps renderer state aligned with the authoritative main-process runtime and
 * preserves plugin-created `agent_team` tasks across upgrades.
 */
export function isProjectModeAgentTeamSelectionDisabled(
  metadata: unknown,
  isProjectModeContext: boolean,
  projectModeAgentTeamEnabled: boolean
): boolean {
  return (
    isProjectModeContext &&
    !projectModeAgentTeamEnabled &&
    resolveAgentModeFromMetadata(metadata) !== "coordinator"
  )
}

/** Match the durable metadata forms used by Harness feature and project-session threads. */
export function isHarnessProjectModeMetadata(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const record = metadata as Record<string, unknown>
  const feature = readNestedMetadataRecord(record, "harnessFeature")
  const projectSession = readNestedMetadataRecord(record, "harnessProjectSession")
  return (
    (hasNonEmptyString(feature, "projectId") && hasNonEmptyString(feature, "slug")) ||
    (hasNonEmptyString(projectSession, "projectId") &&
      hasNonEmptyString(projectSession, "kind"))
  )
}

/**
 * Prefix and environment-variable requests are user/global overrides. They must not bypass the
 * project-mode feature gate. A plugin's already-persisted agent_team policy remains authoritative.
 */
export function areForcedCoordinatorRequestsAllowed(
  metadata: unknown,
  projectModeAgentTeamEnabled: boolean
): boolean {
  return projectModeAgentTeamEnabled || !isHarnessProjectModeMetadata(metadata)
}

/** Scope the process-wide override to the task policy that will actually run it. */
export function isCoordinatorModeForcedForMetadata(
  metadata: unknown,
  projectModeAgentTeamEnabled: boolean,
  environmentForced: boolean
): boolean {
  return (
    environmentForced &&
    areForcedCoordinatorRequestsAllowed(metadata, projectModeAgentTeamEnabled)
  )
}
