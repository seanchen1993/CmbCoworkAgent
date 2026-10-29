import type { AgentRunDetachedResultSignal } from "../agent/agent-run-service"
import { workflowRunManager } from "../agent/workflow/run-manager"
import type { RuntimePluginSourceToken } from "../plugins/runtime-source-scope"

/** Ephemeral handles to original run-manager owners, not a second workflow/result store. */
export function createHostWorkflowContinuation(input: {
  token: RuntimePluginSourceToken
  workspace: string
  threadId: string
  assertCurrent(): void
  /** Original owner only; content is still checked at each consume/capture boundary. */
  assertNotificationCurrent?(): void
}) {
  const assertSourceCurrent = input.assertCurrent.bind(input)
  const assertNotificationCurrent = input.assertNotificationCurrent?.bind(input) ?? assertSourceCurrent
  const pending: ReturnType<typeof workflowRunManager.captureHostRun>[] = []
  const seen = new Set<string>()
  let invalid: unknown
  return {
    onDetachedResultAvailable(notice: AgentRunDetachedResultSignal): void {
      try {
        assertSourceCurrent()
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
      run: (notice: {
        runId: string
        startedAt: string
        assertCurrent(): void
        assertSourceCurrent(): void
      }) => Promise<void>
    ): Promise<void> {
      if (invalid) throw invalid
      while (pending.length) {
        assertSourceCurrent()
        const original = pending.shift()!
        // Wait outside the foreground tool lock, before closing MCP/source custody.
        await original.wait()
        assertSourceCurrent()
        const before = await original.read()
        assertSourceCurrent()
        // A settled engine error still owes its original result notification. Reporting
        // that failure does not turn it into success or permit a retry/Host advance.
        if (
          before.notificationOwner !== "managed" ||
          before.notificationDelivered ||
          (before.status !== "completed" && before.status !== "error")
        )
          throw Error("HOST_WORKFLOW_NOTIFICATION_UNCONFIRMED")
        await run({
          runId: original.runId,
          startedAt: original.startedAt,
          assertCurrent: () => {
            assertNotificationCurrent()
            original.assertCurrent()
          },
          assertSourceCurrent: () => {
            assertSourceCurrent()
            original.assertCurrent()
          }
        })
        assertSourceCurrent()
        const after = await original.read()
        assertSourceCurrent()
        if (!after.notificationDelivered || after.notificationOwner !== "managed")
          throw Error("HOST_WORKFLOW_NOTIFICATION_NOT_CONSUMED")
        if (invalid) throw invalid
      }
    }
  }
}
