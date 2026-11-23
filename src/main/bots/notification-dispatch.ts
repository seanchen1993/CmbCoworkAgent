import {
  COORDINATOR_NOTIFICATION_PROMPT,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../shared/internal-notification-turn"
import type { ManagedNotificationDispatch, ManagedNotificationResult } from "../agent/pending-notification-scheduler"
import type { LocalBotHost } from "./host"

/** Reuses the original scheduler's discovery/claim/ack pipeline; Bots own only durable dispatch. */
export function createBotNotificationDispatcher(
  readThread: (id: string) => { metadata: string | null } | null | undefined,
  getHost: () => Pick<LocalBotHost, "enqueueNotification" | "waitForNotification" | "acknowledgeNotification">
): (notice: ManagedNotificationDispatch) => Promise<ManagedNotificationResult> {
  return async ({ threadId, kind, key, runStartedAt, notBefore }) => {
    const thread = readThread(threadId)
    if (!thread) return false
    let metadata: Record<string, unknown>
    try {
      const parsed = JSON.parse(thread.metadata || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
      metadata = parsed
    } catch {
      return false
    }
    if (typeof metadata.botId !== "string") return false
    // A foreign Bot thread must never fall through to the local desktop runtime.
    if (metadata.botHostId !== "local") return true
    if (metadata.botGroupId != null && typeof metadata.botGroupId !== "string") return true
    if (notBefore && notBefore > Date.now()) return true
    const host = getHost()
    const task = host.enqueueNotification(
      metadata.botId,
      threadId,
      kind,
      key,
      kind === "workflow" ? WORKFLOW_NOTIFICATION_TURN_PROMPT : COORDINATOR_NOTIFICATION_PROMPT,
      typeof metadata.botGroupId === "string" ? metadata.botGroupId : undefined,
      runStartedAt
    )
    if (!task) return true
    if (kind === "coordinator") {
      const terminal = await host.waitForNotification(task.id)
      // The original Runtime owns the coordinator claim/ack. Only its durable
      // input-commit signal proves consumption; a Stop is not an acknowledgement.
      return terminal ? {
        notificationRunId: task.id, terminal,
        acknowledged: terminal.coordinatorNotificationDelivered === true
      } : true
    }
    if (!["queued", "running", "waiting_user"].includes(task.state)) {
      if (!await host.acknowledgeNotification(task.id)) return true
      const terminal = await host.waitForNotification(task.id)
      return terminal ? { notificationRunId: task.id, terminal, acknowledged: true } : true
    }
    const terminal = await host.waitForNotification(task.id)
    if (!terminal) return true
    const acknowledged = await host.acknowledgeNotification(task.id)
    return { notificationRunId: task.id, terminal, acknowledged }
  }
}
