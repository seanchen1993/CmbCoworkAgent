import type { BotTaskState } from "./contracts"
import { botWorkHref } from "./work-history"

export const BOT_WORK_MONITOR_MODES = [
  "report",
  "change",
  "new_result",
  "until_work_completed"
] as const

export interface BotWorkScheduleMonitorInput {
  workId: string
  mode: (typeof BOT_WORK_MONITOR_MODES)[number]
  expiresAt?: string
}

/** Host facts about one exact task. No raw prompts, arbitrary files or tool output. */
export interface BotScheduledWorkSnapshot {
  workId: string
  title: string
  workState: "active" | "completed"
  executionState: BotTaskState | null
  dispatchStopped: boolean
  backgroundBusy: boolean
  pendingPeers: number
  resultDependencyUnavailable?: true
  result?: {
    taskId: string
    /** Exact acknowledged publication whose current service dependencies can be observed. */
    publicationId?: string
    /** Physical turn status. A completed report can describe a failed command. */
    state: BotTaskState
    commandOutcome?: "failed" | "outcome_unknown" | "failed_and_unknown"
    review?: "ready" | "blocked" | "needs_user"
  }
}

export interface BotWorkScheduleMonitor extends BotWorkScheduleMonitorInput {
  generation: number
  lastSuccessful?: BotScheduledWorkSnapshot
  ended?: "condition" | "expired" | "unavailable"
}

export interface BotScheduledWorkObservation extends BotWorkScheduleMonitor {
  scheduledAt: string
}

export interface BotFixedReminderInput {
  kind: "fixed_reminder"
  expiresAt?: string
}

export interface BotFixedReminder extends BotFixedReminderInput {
  ended?: "expired"
}

export interface BotScheduledFixedReminder extends BotFixedReminderInput {
  scheduledAt: string
}

export interface BotScheduledWorkObservationReceipt {
  taskId: string
  scheduleId: string
  botId: string
  threadId: string
  workId: string
  scheduledAt: string
  observedAt: string
  kind: "silent" | "notify" | "failed"
  snapshot?: BotScheduledWorkSnapshot
  error?: string
}

export interface BotScheduledWorkPublication {
  id: string
  taskId: string
  botId: string
  threadId: string
  text: string
  createdAt: number
  sourceCreatedAt: number
  failed: boolean
  reminder?: true
  reminderExpiresAt?: string
  observedWorkId?: string
}

export const BOT_FIXED_REMINDER_DELAY_MS = 1_000
const FIXED_REMINDER_DELAY_NOTICE = "\n\n这是一条延迟送达的提醒。"

export function delayedBotReminderText(text: string): string {
  return text.endsWith(FIXED_REMINDER_DELAY_NOTICE) ? text : text + FIXED_REMINDER_DELAY_NOTICE
}

/** Internal navigation belongs only to the desktop transcript. */
export function scheduledDesktopMessage(publication: BotScheduledWorkPublication): string {
  const { text, observedWorkId } = publication
  return observedWorkId ? text + `\n\n[查看原任务](${botWorkHref(observedWorkId)})` : text
}

function inFlightState(state: BotTaskState | null): BotTaskState | null {
  return state === "queued" || state === "running" || state === "waiting_user" ? state : null
}

export function shouldNotifyScheduledWork(
  monitor: BotWorkScheduleMonitor,
  snapshot: BotScheduledWorkSnapshot
): boolean {
  if (monitor.mode === "report") return true
  if (monitor.mode === "until_work_completed") return snapshot.workState === "completed"
  const before = monitor.lastSuccessful
  const newResult = Boolean(snapshot.result && snapshot.result.taskId !== before?.result?.taskId)
  if (monitor.mode === "new_result") return newResult
  return Boolean(
    before &&
    (newResult ||
      before.workState !== snapshot.workState ||
      // Terminal evidence is compared by result identity. A pruned cancellation
      // or another ineligible old turn is not progress in the observed work.
      inFlightState(before.executionState) !== inFlightState(snapshot.executionState) ||
      // A current interrupted execution is new progress even when the last
      // published result is unchanged. Losing an old status to retention is not.
      ((snapshot.executionState === "interrupted" || snapshot.executionState === "outcome_unknown") &&
        snapshot.executionState !== before.executionState) ||
      before.dispatchStopped !== snapshot.dispatchStopped ||
      before.backgroundBusy !== snapshot.backgroundBusy ||
      before.resultDependencyUnavailable !== snapshot.resultDependencyUnavailable ||
      before.pendingPeers !== snapshot.pendingPeers)
  )
}
