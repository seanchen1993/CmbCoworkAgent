function truthyCoordinatorFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return false
  return ["1", "true", "yes", "on", "coordinator"].includes(value.toLowerCase())
}

export function isExplicitNormalModeMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false
  }
  const record = metadata as Record<string, unknown>
  return record.agentMode === "normal"
}

export function isCoordinatorModeMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false
  }
  const record = metadata as Record<string, unknown>
  if (isExplicitNormalModeMetadata(record)) {
    return false
  }
  return record.agentMode === "coordinator" || truthyCoordinatorFlag(record.coordinatorMode)
}
