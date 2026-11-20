import {
  resolveAgentModeFromMetadata,
  resolveThreadExecutionModeFromMetadata
} from "../../../shared/agent-mode-metadata"

function isMetadataRecord(metadata: unknown): boolean {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
}

export function isExplicitNormalModeMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false
  }
  const record = metadata as Record<string, unknown>
  return record.agentMode === "normal"
}

export function isMultiModeMetadata(metadata: unknown): boolean {
  return isMetadataRecord(metadata) && resolveThreadExecutionModeFromMetadata(metadata) === "multi"
}

export function isCoordinatorModeMetadata(metadata: unknown): boolean {
  return isMetadataRecord(metadata) && resolveAgentModeFromMetadata(metadata) === "coordinator"
}

export function isWorkflowModeMetadata(metadata: unknown): boolean {
  return isMetadataRecord(metadata) && resolveAgentModeFromMetadata(metadata) === "workflow"
}
