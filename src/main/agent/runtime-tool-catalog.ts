/** A transport-bound tool belongs to the parent turn, never its temporary task agents. */
export const MAIN_TURN_ONLY_TOOL_METADATA_KEY = "cmb_main_turn_only"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function filterTaskSubagentTools<T>(tools: readonly T[]): T[] {
  return tools.filter(
    (entry) => record(record(entry)?.metadata)?.[MAIN_TURN_ONLY_TOOL_METADATA_KEY] !== true
  )
}
