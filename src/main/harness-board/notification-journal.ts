import type { ManagedRunEvent } from "../../shared/harness-board-types"
import type { HarnessNotification } from "../../shared/harness-notifications"
import { projectHarnessNotification } from "../../shared/harness-notifications"
import { onNotificationChanged } from "../services/notification-service"
import { managedRunStore } from "./managed-run-store"

// This index belongs exclusively to the ManagedRun events.ndjson projection.
const MAX_CACHED_RUNS = 128
const journalKeys = new Map<string, Set<string>>()
function writeJournal(value: HarnessNotification): void {
  if (!value.runId || value.kind !== "decision") return
  try {
    const runKey = JSON.stringify([value.projectId, value.featureId, value.runId])
    let keys = journalKeys.get(runKey)
    if (!keys) {
      keys = new Set<string>()
      let cursor: string | undefined
      do {
        const page = managedRunStore.listEvents(
          { projectId: value.projectId, featureId: value.featureId, runId: value.runId },
          cursor,
          200
        )
        for (const event of page.events) {
          if (event.notificationId) keys.add(`${event.type}:${event.notificationId}`)
        }
        cursor = page.hasMore ? page.nextCursor : undefined
      } while (cursor)
      if (journalKeys.size >= MAX_CACHED_RUNS) {
        const oldest = journalKeys.keys().next().value
        if (oldest !== undefined) journalKeys.delete(oldest)
      }
      journalKeys.set(runKey, keys)
    }
    // Refresh insertion order on hits so eviction follows least recent access.
    journalKeys.delete(runKey)
    journalKeys.set(runKey, keys)
    const entries = [
      {
        ...value,
        status: "pending" as const,
        action: undefined,
        channel: undefined,
        reasonCode: undefined,
        result: undefined
      },
      ...(value.status === "pending" ? [] : [value])
    ].filter(
      (entry) =>
        !keys.has(
          `${entry.status === "pending" ? "decision_notification_created" : "decision_notification_ended"}:${entry.notificationId}`
        )
    )
    if (entries.length === 0) return
    const record = managedRunStore.getRun({
      projectId: value.projectId,
      featureId: value.featureId,
      runId: value.runId
    })
    if (!record.snapshot || record.corrupt) return
    for (const entry of entries) {
      const type =
        entry.status === "pending" ? "decision_notification_created" : "decision_notification_ended"
      const key = `${type}:${entry.notificationId}`
      managedRunStore.appendEvent(
        record.snapshot,
        {
          type,
          notificationId: entry.notificationId,
          gateId: entry.type === "human_gate" ? entry.notificationId : undefined,
          notificationStatus: entry.status,
          notificationAction: entry.action as ManagedRunEvent["notificationAction"],
          nodeId: entry.nodeId,
          sourceThreadId: entry.sourceThreadId,
          policyResult: entry.policyResult,
          decisionChannel: entry.channel,
          reasonCode: entry.reasonCode,
          summary: entry.result ?? entry.message
        },
        entry.status === "pending" ? entry.createdAt : entry.completedAt
      )
      keys.add(key)
    }
  } catch (error) {
    console.warn("[Notifications] Display journal write failed:", error)
  }
}

let initialized = false
export function initializeNotificationJournal(): void {
  if (initialized) return
  initialized = true
  onNotificationChanged((message, change) => {
    if (change === "channel_disabled") return
    const value = projectHarnessNotification(message)
    if (!value) return
    writeJournal(value)
  })
}
