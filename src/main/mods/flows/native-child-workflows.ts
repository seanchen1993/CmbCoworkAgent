import { workflowRunManager } from "../../agent/workflow/run-manager"
import {
  listWorkflowRunsPage,
  loadWorkflowRunAsync,
  toRunSummary
} from "../../agent/workflow/run-store"

/** An original Flow child owns its own thread, never all workflows sharing a package token. */
export async function captureNativeChildWorkflows(
  workspace: string,
  threadId: string,
  assertIdentity: () => void,
  signal: AbortSignal
): Promise<{ settle(cancel?: boolean): Promise<void> }> {
  const summaries = async () => {
    assertIdentity()
    const fallback = await workflowRunManager.observationFallbacks(workspace, threadId)
    const result = await listWorkflowRunsPage(workspace, threadId, {
      limit: 32, overlays: fallback.map(toRunSummary), requireCompletePage: true
    })
    assertIdentity()
    return result
  }
  // The runtime has not started yet. Existing history is never claimed by this new child owner.
  const baseline = await summaries()
  if (baseline.nextCursor) throw Error("FLOW_CHILD_WORKFLOW_HISTORY_UNCONFIRMED")
  const prior = new Set(baseline.runs.map(run => run.runId))
  let captured: string[] | undefined
  const settle = async (cancel = false) => {
    assertIdentity()
    if (!captured) {
      const active = workflowRunManager.activeRunId(threadId)
      const page = await summaries()
      if (page.nextCursor) throw Error("FLOW_CHILD_WORKFLOW_HISTORY_UNCONFIRMED")
      captured = [...new Set([
        ...page.runs.filter(run => !prior.has(run.runId)).map(run => run.runId),
        ...(active && !prior.has(active) ? [active] : [])
      ])]
    }
    for (const runId of captured) {
      assertIdentity()
      const abort = () => { workflowRunManager.cancel(threadId, runId, false) }
      signal.addEventListener("abort", abort, { once: true })
      try {
        // Capture the exact original entry before cancellation can remove it. The native
        // cancelAndWait API intentionally swallows its error for UI deletion callers.
        const settled = workflowRunManager.waitForRunLifecycle(threadId, runId)
          .then(() => ({ error: undefined as unknown }), error => ({ error }))
        if (workflowRunManager.activeRunId(threadId) === runId && (cancel || signal.aborted)) {
          // The existing bounded cancellation must confirm retirement before identity is deleted.
          await workflowRunManager.cancelAndWait(threadId)
          if (workflowRunManager.activeRunId(threadId) === runId)
            throw Error("FLOW_CHILD_WORKFLOW_CLEANUP_UNCONFIRMED")
        }
        const outcome = await settled
        if (outcome.error) throw outcome.error
      } finally { signal.removeEventListener("abort", abort) }
      assertIdentity()
      const fallbacks = await workflowRunManager.observationFallbacks(workspace, threadId)
      if (fallbacks.some(run => run.runId === runId))
        throw Error("FLOW_CHILD_WORKFLOW_PERSIST_UNCONFIRMED")
      const run = await loadWorkflowRunAsync(workspace, threadId, runId)
      assertIdentity()
      if (!run || run.threadId !== threadId || run.status === "running" ||
        run.worktrees?.some(tree => tree.cleanupPending))
        throw Error("FLOW_CHILD_WORKFLOW_CLEANUP_UNCONFIRMED")
      if (!cancel && (run.status !== "completed" || run.stats.agentsFailed > 0))
        throw Error("FLOW_CHILD_WORKFLOW_NOT_SUCCEEDED")
    }
    const active = workflowRunManager.activeRunId(threadId)
    if (active) throw Error("FLOW_CHILD_WORKFLOW_OWNER_CHANGED")
    assertIdentity()
  }
  return { settle }
}
