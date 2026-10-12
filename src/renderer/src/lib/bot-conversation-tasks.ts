import type { BotRun, BotRunStatus } from "../../../shared/bot-types"
import type { BotRunAddress } from "../../../shared/bot-run-history"

export const BOT_CONVERSATION_INLINE_TASKS = 4
export const BOT_CONVERSATION_TASK_PAGE_SIZE = 20

export interface BotConversationTaskScope {
  conversationId: string
  threadRootId?: string
  dataEpoch?: string
}

export interface BotConversationTaskSummary {
  /** Stable chronological order for pagination; progress updates do not reorder rows. */
  items: BotRun[]
  inline: BotRun[]
  total: number
  attention: number
  running: number
  queued: number
  cancelling: number
}

export const botConversationTaskLabels: Record<BotRunStatus, string> = {
  queued: "排队中",
  running: "工作中",
  waiting_input: "等待你处理",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  needs_review: "需要核对现场"
}

export function botConversationTaskScopeKey(scope: BotConversationTaskScope): string {
  return JSON.stringify([scope.conversationId, scope.threadRootId ?? null, scope.dataEpoch ?? null])
}

export function botConversationTaskAddress(
  run: BotRun,
  scope: BotConversationTaskScope
): BotRunAddress | null {
  if (run.conversationId !== scope.conversationId || run.threadRootId !== scope.threadRootId)
    return null
  return {
    conversationId: scope.conversationId,
    runId: run.id,
    ...(scope.threadRootId ? { threadRootId: scope.threadRootId } : {})
  }
}

export function canCancelBotConversationTask(run: Pick<BotRun, "status">): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_input"
}

function priority(run: BotRun): number {
  if (run.status === "needs_review") return 0
  if (run.status === "waiting_input" || (run.status === "running" && run.waitingForComputer))
    return 1
  if (run.status === "running") return 2
  if (run.status === "cancelling") return 3
  return 4
}

/** Only presentation is bounded. Every unfinished task remains reachable in the paged dialog. */
export function selectBotConversationTasks(
  runs: readonly BotRun[],
  scope: BotConversationTaskScope
): BotConversationTaskSummary {
  const identities = new Map<string, BotRun>()
  for (const run of runs) {
    if (run.conversationId !== scope.conversationId || run.threadRootId !== scope.threadRootId)
      continue
    const previous = identities.get(run.id)
    if (
      !previous ||
      run.revision > previous.revision ||
      (run.revision === previous.revision && run.updatedAt > previous.updatedAt)
    )
      identities.set(run.id, run)
  }
  const items = [...identities.values()]
    .filter((run) => !["succeeded", "failed", "cancelled"].includes(run.status))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  const summary: BotConversationTaskSummary = {
    items,
    inline: [],
    total: items.length,
    attention: 0,
    running: 0,
    queued: 0,
    cancelling: 0
  }
  const buckets: BotRun[][] = [[], [], [], [], []]
  for (const run of items) {
    const rank = priority(run)
    buckets[rank].push(run)
    if (rank <= 1) summary.attention++
    else if (run.status === "running") summary.running++
    else if (run.status === "queued") summary.queued++
    else if (run.status === "cancelling") summary.cancelling++
  }
  for (let rank = 0; rank < buckets.length; rank++) {
    // A queue is represented once in the transcript, regardless of its length.
    const candidates = rank === 4 ? buckets[rank].slice(0, 1) : buckets[rank]
    for (const run of candidates) {
      if (summary.inline.length === BOT_CONVERSATION_INLINE_TASKS) break
      summary.inline.push(run)
    }
    if (summary.inline.length === BOT_CONVERSATION_INLINE_TASKS) break
  }
  return summary
}

export function botConversationTaskPage(items: readonly BotRun[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / BOT_CONVERSATION_TASK_PAGE_SIZE))
  const page = Number.isFinite(requestedPage)
    ? Math.min(pageCount - 1, Math.max(0, Math.floor(requestedPage)))
    : 0
  const start = page * BOT_CONVERSATION_TASK_PAGE_SIZE
  return {
    page,
    pageCount,
    total: items.length,
    items: items.slice(start, start + BOT_CONVERSATION_TASK_PAGE_SIZE)
  }
}
