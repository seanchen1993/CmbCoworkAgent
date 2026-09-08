export type AgentMode = "normal" | "coordinator" | "workflow"

export type ThreadExecutionMode = AgentMode | "multi"

function readMetadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null
}

function isTruthyLegacyCoordinatorFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return false
  return ["1", "true", "yes", "on", "coordinator"].includes(value.toLowerCase())
}

/**
 * Resolve both the current agentMode field and the legacy coordinatorMode flag.
 * An explicit current mode always wins over the legacy compatibility flag.
 */
export function resolveAgentModeFromMetadata(metadata: unknown): AgentMode {
  const record = readMetadataRecord(metadata)
  if (!record) return "normal"
  if (record.agentMode === "normal") return "normal"
  if (record.agentMode === "workflow") return "workflow"
  if (
    record.agentMode === "coordinator" ||
    isTruthyLegacyCoordinatorFlag(record.coordinatorMode)
  ) {
    return "coordinator"
  }
  return "normal"
}

/** Resolve the complete execution profile used by transcript and active-run guards. */
export function resolveThreadExecutionModeFromMetadata(metadata: unknown): ThreadExecutionMode {
  const record = readMetadataRecord(metadata)
  const mode = resolveAgentModeFromMetadata(record)
  if (mode === "coordinator" || mode === "workflow") return mode
  return record?.subagentsEnabled === false ? "normal" : "multi"
}
