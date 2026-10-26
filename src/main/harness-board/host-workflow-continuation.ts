import type { AgentRunDetachedResultSignal } from "../agent/agent-run-service"
import { workflowRunManager } from "../agent/workflow/run-manager"
import type { RuntimePluginSourceToken } from "../plugins/runtime-source-scope"

/** Ephemeral handles to original run-manager owners, not a second workflow/result store. */
export function createHostWorkflowContinuation(input: {
  token: RuntimePluginSourceToken
  workspace: string
  threadId: string
  assertCurrent(): void
}) {
  const pending: ReturnType<typeof workflowRunManager.captureHostRun>[] = []
  const seen = new Set<string>()
  let invalid: unknown
  return {
    onDetachedResultAvailable(notice: AgentRunDetachedResultSignal): void {
      try {
        input.assertCurrent()
        if (notice.kind !== "workflow" || notice.threadId !== input.threadId || !notice.runId)
          throw Error("HOST_WORKFLOW_NOTIFICATION_SCOPE_CHANGED")
        const original = workflowRunManager.captureHostRun(
          input.token,
          input.threadId,
          notice.runId
        )
        const key = JSON.stringify([original.runId, original.startedAt])
        if (seen.has(key)) return
        if (seen.size >= 16) throw Error("HOST_WORKFLOW_NOTIFICATION_LIMIT")
        seen.add(key)
        pending.push(original)
      } catch (error) {
        // The original notification callback is observational and catches thrown errors.
        // Keep a failed admission here so that the Host cannot silently enter checks.
        invalid = error
      }
    },
    async consume(
      run: (notice: { runId: string; startedAt: string; assertCurrent(): void }) => Promise<void>
    ): Promise<void> {
      if (invalid) throw invalid
      while (pending.length) {
        input.assertCurrent()
        const original = pending.shift()!
        // Wait outside the foreground tool lock, before closing MCP/source custody.
        await original.wait()
        input.assertCurrent()
        const before = await original.read()
        input.assertCurrent()
        if (
          before.notificationOwner !== "managed" ||
          before.notificationDelivered ||
          before.status !== "completed"
        )
          throw Error("HOST_WORKFLOW_NOTIFICATION_UNCONFIRMED")
        await run({
          runId: original.runId,
          startedAt: original.startedAt,
          assertCurrent: () => {
            input.assertCurrent()
            original.assertCurrent()
          }
        })
        input.assertCurrent()
        const after = await original.read()
        input.assertCurrent()
        if (!after.notificationDelivered || after.notificationOwner !== "managed")
          throw Error("HOST_WORKFLOW_NOTIFICATION_NOT_CONSUMED")
        if (invalid) throw invalid
      }
    }
  }
}
