/** Absolute index of a workflow prompt omitted from the start of a bounded snapshot. */
export const WORKFLOW_PRECEDING_PROMPT_INDEX_KEY = "cmb_workflow_preceding_prompt_index"

export const WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP = 24_000

/** Old sidecars shortened IDs with the same formatter they used for prose. */
export function isLegacyTruncatedWorkflowIdentity(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP &&
    /^\n…\[truncated [1-9]\d* chars\](?![\s\S])/.test(
      value.slice(WORKFLOW_AGENT_SNAPSHOT_CONTENT_CAP)
    )
  )
}
