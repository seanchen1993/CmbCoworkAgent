/** Plugin policy consumes the original compiler's effective graph, never a second fixed route. */
export function decide(
  record: Record<string, unknown>,
  requested: string,
  workflow: {
    apiVersion?: string
    nodes?: unknown
    digest?: string
    allowedNext?: Record<string, unknown>
  }
) {
  if (!record || typeof record.checkpoint !== "string") throw Error("AUTOBIZ_MOD_STATE_INVALID")
  if (
    !workflow ||
    workflow.apiVersion !== "devclaw.compiled-workflow/v1" ||
    !Array.isArray(workflow.nodes) ||
    !workflow.nodes.length ||
    workflow.nodes.length > 64 ||
    !/^[0-9a-f]{64}$/.test(workflow.digest || "") ||
    !workflow.allowedNext ||
    typeof workflow.allowedNext !== "object"
  )
    throw Error("AUTOBIZ_MOD_WORKFLOW_CONTRACT_REQUIRED")
  const allowed = workflow.allowedNext[record.checkpoint]
  if (!Array.isArray(allowed) || !allowed.includes(requested))
    throw Error("AUTOBIZ_MOD_TRANSITION_REJECTED")
  return { from: record.checkpoint, to: requested, expectedWorkflowDigest: workflow.digest }
}
