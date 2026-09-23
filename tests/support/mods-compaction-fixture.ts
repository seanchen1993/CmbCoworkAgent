/** Shared local-provider contract; this text is deterministic test output, not an acceptance result. */
export const COMPACTION_SUMMARY_SENTINEL = "COMPACTION_SUMMARY_SENTINEL"
export const COMPACTION_SUMMARY = [
  "Goal",
  "Constraints",
  "Completed",
  "Current State",
  "Blockers",
  "Key Decisions",
  "Next Step",
  "Critical Evidence"
]
  .map(
    (heading) =>
      `## ${heading}\n- COMPACTION_PROBE ${COMPACTION_SUMMARY_SENTINEL}: preserve the requested work, source paths and verified evidence; continue the next concrete step.`
  )
  .join("\n")

export function isCompactionSummaryRequest(request: { messages?: unknown }): boolean {
  if (!Array.isArray(request.messages)) return false
  const first = request.messages[0] as { role?: unknown; content?: unknown } | undefined
  return (
    first?.role === "system" &&
    String(first.content).includes(
      "Return only the continuation handoff as text in the final content field."
    ) &&
    JSON.stringify(request.messages).includes("COMPACTION_PROBE")
  )
}
