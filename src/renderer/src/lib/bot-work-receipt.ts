import type { Message, ToolCall, ToolResult } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"
import type { BotWorkClient } from "../../../shared/bots/work"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"

/** Only work links in the loaded message window need current titles. */
export function botWorkCardIds(
  messages: readonly Message[], origins: ReadonlyMap<string, Pick<BotMessageOrigin, "origin">>, botId: string
): string[] {
  const ids = new Set<string>()
  const results = buildToolResultAssociations(messages)
  for (const message of messages) {
    if (message.role === "user") {
      const origin = origins.get(message.id)?.origin
      if (origin?.kind === "work_result") ids.add(origin.workId)
    }
    if (message.role !== "assistant") continue
    for (const [index, tool] of (message.tool_calls ?? []).entries()) {
      const result = results.get(getWorkerToolUiKey(message.id, tool.id, index))
      const receipt = result && botWorkReceipt(tool, result, botId)
      if (receipt) ids.add(receipt.id)
    }
  }
  return [...ids]
}

export async function loadBotWorkCardTitles(
  works: Pick<BotWorkClient, "summaries">, botId: string, ids: readonly string[], isCurrent: () => boolean
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (let offset = 0; offset < ids.length && isCurrent(); offset += 40) {
    const batch = ids.slice(offset, offset + 40)
    const summaries = await works.summaries(botId, batch, true)
    for (const summary of summaries) {
      if (summary.botId === botId && batch.includes(summary.id)) titles.set(summary.id, summary.title)
    }
  }
  return titles
}

/** Only verified Runtime tool results produce a work navigation card, never assistant prose. */
export function botWorkReceipt(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">,
  botId: string
): { id: string; title: string; label: string } | null {
  const receipt = parseBotWorkReceipt(tool, result)
  return receipt?.botId === botId ? receipt : null
}

/** Recognize the product card before beta folds generic tool activity. Navigation
 * still checks the current Bot with botWorkReceipt and the main-process Host. */
export function parseBotWorkReceipt(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): { botId: string; id: string; title: string; label: string } | null {
  if (
    result.is_error ||
    typeof result.content !== "string" ||
    result.content.length > 100000 ||
    !["bot_work_create", "bot_work_send", "bot_work_complete", "bot_work_continue", "bot_work_rename", "bot_work_stop"].includes(
      tool.name
    )
  )
    return null
  try {
    const value = JSON.parse(result.content)
    if (value?.kind !== "bot-work-receipt" || value.operation !== tool.name || !value.receipt)
      return null
    const work = tool.name === "bot_work_create" ? value.receipt.work : value.receipt
    const id = tool.name === "bot_work_send" ? work.workId : work.id
    if (
      typeof work.botId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(work.botId) ||
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    )
      return null
    if (
      tool.name === "bot_work_create" &&
      (value.receipt.task?.workId !== id || value.receipt.task.threadId !== work.threadId)
    )
      return null
    const reviewPaused: unknown = tool.name === "bot_work_stop" && work.scope === "review"
      ? work.reviewPaused : undefined
    const label = typeof reviewPaused === "boolean"
      ? reviewPaused ? "已停止自动核查" : "没有待停止的自动核查"
      : {
          bot_work_create: "已交办任务",
          bot_work_send: "已接纳任务补充",
          bot_work_complete: "任务已完成",
          bot_work_continue: work.continued === true ? "已继续原任务"
            : work.continued === false ? "任务未变更" : "查看原任务",
          bot_work_stop: "已请求停止任务",
          bot_work_rename: "已修改任务名称"
        }[tool.name]!
    return {
      botId: work.botId,
      id,
      title: typeof work.title === "string" ? work.title : "查看任务会话",
      label
    }
  } catch {
    return null
  }
}
