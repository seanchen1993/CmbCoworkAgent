import { cleanUserAttachmentContentForDisplay } from "../../../shared/user-attachment-display"
import { parseBotMessageReply } from "../../../shared/bots/message-reply"
import { botTaskGroupId, type BotDefinition, type BotTask } from "../../../shared/bots/contracts"
import { projectVisibleChatSearchContent } from "../../../shared/chat-search-visible-content"
import { projectMarkdownVisibleText } from "../../../shared/markdown-visible-text"
import type { ThreadStateSummary } from "./thread-context"
import { BOT_REPLY_FILES_PREFIX } from "../../../shared/bots/file-delivery"
import { stripSkillUseBlockForDisplay } from "../../../shared/skill-use-block"

/** Background work outlives the launching Bot turn; reuse the Runtime's sidebar summary. */
export function botConversationState(
  tasks: readonly BotTask[],
  summary?: Pick<
    ThreadStateSummary,
    "hasPendingApproval" | "hasPendingUserInput" | "workflowRunning" | "hasRunningCoordinatorWorker"
  >,
  nativeCommandRunning = false
): "waiting_user" | "running" | "queued" | null {
  if (
    summary?.hasPendingApproval ||
    summary?.hasPendingUserInput ||
    tasks.some((task) => task.state === "waiting_user")
  )
    return "waiting_user"
  if (
    nativeCommandRunning ||
    summary?.workflowRunning ||
    summary?.hasRunningCoordinatorWorker ||
    tasks.some((task) => task.state === "running")
  )
    return "running"
  return tasks.some((task) => task.state === "queued") ? "queued" : null
}

/** File scans follow settled turns, not token updates or unrelated Bot activity. */
export function botFileRefreshKey(tasks: readonly BotTask[]): string {
  return tasks
    .filter((task) => !["queued", "running", "waiting_user"].includes(task.state))
    .map((task) => `${task.id}:${task.state}:${task.updatedAt}`)
    .join("|")
}

export function botTaskPreview(task: BotTask): string {
  let text = task.message
  if (task.origin.kind === "user" && task.origin.replyTo)
    text = parseBotMessageReply(text)?.message ?? text
  if (task.origin.kind === "user") {
    text = stripSkillUseBlockForDisplay(text)?.rest ?? text
    // Snapshots are bounded before reaching the UI: their final attachment may be partial.
    const opening = text.lastIndexOf("<attachment ")
    if (opening > text.lastIndexOf("</attachment>")) {
      const name = /^<attachment\s+filename="([^"]*)"/.exec(text.slice(opening))?.[1]
      text = text.slice(0, opening) + (name ? `<attachment filename="${name}"></attachment>` : "")
    }
    return projectMarkdownVisibleText(
      projectVisibleChatSearchContent("user", cleanUserAttachmentContentForDisplay(text))
    )
      .replace(/\s+/g, " ")
      .trim()
  }
  if (task.origin.kind === "bot" && !task.origin.expectsReply) {
    const prefix = `${task.origin.fromBotName ?? "其他 Bot"} 的协作任务已结束（`
    if (text.startsWith(prefix)) {
      const end = text.indexOf("）。\n", prefix.length)
      if (end >= 0) text = text.slice(end + 3)
    }
    const appendix = text.indexOf(BOT_REPLY_FILES_PREFIX)
    if (appendix >= 0) text = text.slice(0, appendix)
    text = `${task.origin.fromBotName ?? "其他 Bot"}：${text}`
  }
  return projectMarkdownVisibleText(text)
}

/** Private conversation controls must never display or cancel a member's group work. */
export function privateBotTasksByBot(
  bots: readonly BotDefinition[],
  tasks: readonly BotTask[]
): Map<string, BotTask[]> {
  const threads = new Map(bots.map((bot) => [bot.id, bot.threadId]))
  const result = new Map<string, BotTask[]>()
  for (const task of tasks) {
    if (botTaskGroupId(task) || threads.get(task.botId) !== task.threadId) continue
    const entries = result.get(task.botId) ?? []
    entries.push(task)
    result.set(task.botId, entries)
  }
  return result
}
