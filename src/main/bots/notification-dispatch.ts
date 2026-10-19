import {
  COORDINATOR_NOTIFICATION_PROMPT,
  WORKFLOW_NOTIFICATION_TURN_PROMPT
} from "../../shared/internal-notification-turn"
import type { ManagedNotificationDispatch } from "../agent/pending-notification-scheduler"
import type { LocalBotHost } from "./host"

/** Reuses the original scheduler's discovery/claim/ack pipeline; Bots own only durable dispatch. */
export function createBotNotificationDispatcher(
  readThread: (id: string) => { metadata: string | null } | null | undefined,
  getHost: () => Pick<LocalBotHost, "enqueueNotification">
): (notice: ManagedNotificationDispatch) => Promise<boolean> {
  return async ({ threadId, kind, key, runStartedAt }) => {
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
    getHost().enqueueNotification(
      metadata.botId,
      threadId,
      kind,
      key,
      kind === "workflow" ? WORKFLOW_NOTIFICATION_TURN_PROMPT : COORDINATOR_NOTIFICATION_PROMPT,
      typeof metadata.botGroupId === "string" ? metadata.botGroupId : undefined,
      runStartedAt
    )
    return true
  }
}
