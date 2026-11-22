/** Capability discovery only; authorization and run ownership remain with the Bot host. */
export function hasBotWorkflowCapability(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false
  const record = metadata as Record<string, unknown>
  return (
    record.botHostId === "local" &&
    typeof record.botId === "string" &&
    record.botId.length > 0 &&
    (record.agentMode === undefined ||
      record.agentMode === "normal" ||
      record.agentMode === "workflow")
  )
}
