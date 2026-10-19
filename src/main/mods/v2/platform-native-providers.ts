import { workflowRunManager } from "../../agent/workflow/run-manager"
import {
  listWorkflowRunsPage,
  loadWorkflowRunAsync,
  toRunSummary
} from "../../agent/workflow/run-store"
import { observeWorkflowRun } from "../../agent/workflow/observation"
import { onWorkflowObservationChange } from "../../agent/workflow/observation-events"
import { createWorkflowPlatformProvider } from "./platform-workflow-provider"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

/** Original services are shared by native UI and Mods; this factory owns no task state. */
export function nativePlatformProviders(
  confirmCancel: (context: NativePlatformCallContext, runId: string) => Promise<boolean>
) {
  return [
    createWorkflowPlatformProvider({
      active: (workspace, threadId) => workflowRunManager.observeActiveRun(workspace, threadId),
      latest: async (workspace, threadId) => {
        const fallbacks = await workflowRunManager.observationFallbacks(workspace, threadId)
        const page = await listWorkflowRunsPage(workspace, threadId, {
          limit: 1,
          overlays: fallbacks.map(toRunSummary),
          requireCompletePage: true
        })
        const summary = page.runs[0]
        if (!summary) return null
        const run =
          fallbacks.find((run) => run.runId === summary.runId) ??
          (await loadWorkflowRunAsync(workspace, threadId, summary.runId))
        if (!run) throw Error("WORKFLOW_OBSERVATION_UNAVAILABLE")
        if (run.threadId !== threadId) throw Error("WORKFLOW_OBSERVATION_SCOPE_CHANGED")
        return observeWorkflowRun(run)
      },
      inspect: async (workspace, threadId, runId, page) => {
        const active = await workflowRunManager.observeActiveRun(workspace, threadId, page)
        if (active?.runId === runId) return active
        const fallbacks = await workflowRunManager.observationFallbacks(workspace, threadId)
        const run =
          fallbacks.find((run) => run.runId === runId) ??
          (await loadWorkflowRunAsync(workspace, threadId, runId))
        if (!run) return null
        if (run.threadId !== threadId) throw Error("WORKFLOW_OBSERVATION_SCOPE_CHANGED")
        return observeWorkflowRun(run, page)
      },
      changed: onWorkflowObservationChange,
      confirmCancel,
      cancel: (threadId, runId) => workflowRunManager.cancel(threadId, runId, true),
      settled: (threadId, runId) => workflowRunManager.waitForRunLifecycle(threadId, runId)
    })
  ]
}
