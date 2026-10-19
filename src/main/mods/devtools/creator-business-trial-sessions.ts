import type { ManagedRunEventsPage, ManagedRunIdentity } from "../../../shared/harness-board-types"
import type { DevelopmentBusinessTrialSession } from "../../../shared/mods/development"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnationRow
} from "../../services/thread-incarnation"

/** Native history membership only. Never load a guest, reconstruct a token or authorize an action. */
export function projectCreatorBusinessTrialSessions(
  owner: ManagedRunIdentity & { workspacePath: string },
  page: ManagedRunEventsPage,
  readThread: (id: string) => ThreadIncarnationRow | null | undefined
) {
  const starts = page.events.filter(
    (event) =>
      event.runId === owner.runId &&
      event.type === "session_started" &&
      typeof event.targetThreadId === "string"
  )
  const allIds = [...new Set(starts.map((event) => event.targetThreadId!))]
  const ids = allIds.slice(-32)
  const sessions: DevelopmentBusinessTrialSession[] = []
  let unavailable = false
  for (const threadId of ids) {
    const row = readThread(threadId)
    if (!row) {
      unavailable = true
      continue
    }
    const incarnation = captureThreadIncarnation(row)
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(row.metadata ?? "null")
    } catch {
      unavailable = true
      continue
    }
    const feature = metadata?.harnessFeature as Record<string, unknown> | undefined
    if (
      !feature ||
      feature.projectId !== owner.projectId ||
      feature.slug !== owner.featureId ||
      feature.runId !== owner.runId ||
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, owner.workspacePath)
    ) {
      unavailable = true
      continue
    }
    const start = starts.find((event) => event.targetThreadId === threadId)!
    // A real native continuation can resume the same thread after a previous turn ended.
    // Only a terminal event after the latest activation describes its current presentation.
    let ended: ManagedRunEventsPage["events"][number] | undefined
    for (const event of page.events) {
      if (event.runId !== owner.runId) continue
      if (
        ["session_started", "session_continued"].includes(event.type) &&
        event.targetThreadId === threadId
      )
        ended = undefined
      if (event.type === "managed_agent_turn_ended" && event.threadId === threadId) ended = event
    }
    const current = readThread(threadId)
    if (!matchesThreadIncarnation(current, incarnation) || current?.metadata !== row.metadata) {
      unavailable = true
      continue
    }
    sessions.push({
      threadId,
      nodeId: start.nodeId,
      startedAt: start.createTime,
      ...(ended
        ? { endedAt: ended.createTime, outcome: ended.outcome, endReason: ended.endReason?.code }
        : {}),
      incarnation
    })
  }
  return {
    sessions,
    sessionsTruncated: page.hasMore || allIds.length > 32,
    sessionsUnavailable: unavailable
  }
}
