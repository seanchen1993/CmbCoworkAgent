import {
  resolveAgentModeFromMetadata,
  resolveThreadExecutionModeFromMetadata
} from "../../../shared/agent-mode-metadata"
import { hasBotWorkflowCapability } from "../../../shared/bots/workflow-capability"

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

/** Bot conversations can own background workflows without switching execution modes. */
export function hasWorkflowPanelCapability(metadata: unknown): boolean {
  return isWorkflowModeMetadata(metadata) || hasBotWorkflowCapability(metadata)
}
