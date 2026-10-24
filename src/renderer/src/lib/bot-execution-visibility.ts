import type { Message, ToolCall, ToolCallState, ToolResult } from "@/types"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"
import { botToolResultStatus } from "./bot-tool-result-status"
import { botScheduleReceipt } from "./bot-schedule-view"
import { botProfileEvent } from "./bot-profile-event"
import { botQuestionHistory } from "./bot-question-history"
import { botBrowserHelpHistory } from "./bot-browser-help-history"
import { delegatedTaskReceipt } from "./bot-exchange-view"
import { parseBotWorkReceipt } from "./bot-work-receipt"
import { parseBotFileDelivery } from "../../../shared/bots/file-delivery"

/** Default Bot chat shows product presentations, never a generic tool transcript. */
export function isBotExecutionTool(
  tool: ToolCall,
  result?: Pick<ToolResult, "content" | "is_error">
): boolean {
  // Questions and handoff controls have a live presentation. Approvals and Mod
  // cards are protected separately by the caller, independently of the tool name.
  if (!result)
    return !(
      tool.name === "request_user_input" ||
      tool.name === "bot_request_browser_help" ||
      (tool.name === "bot_browser" && tool.args?.action === "request_help")
    )
  if (botToolResultStatus(tool, result)) return true
  const schedule = botScheduleReceipt(tool, result)
  return !(
    botQuestionHistory(tool, result) ||
    botBrowserHelpHistory(tool, result) ||
    botProfileEvent(tool, result) ||
    parseBotWorkReceipt(tool, result) ||
    (schedule && schedule.action !== "list") ||
    (tool.name === "bot_deliver_files" && parseBotFileDelivery(result.content)) ||
    delegatedTaskReceipt(tool, result)
  )
}

/** View projection only: preserve approvals, failures, deliveries, collaboration and Mod cards. */
export function projectBotExecution(
  messages: readonly Message[],
  keepActiveTurn: boolean,
  cardCallIds: ReadonlySet<string>,
  pendingQuestionCallId: string | null = null,
  liveToolStates?: ReadonlyMap<string, Pick<ToolCallState, "status">>
): { hiddenMessages: Set<string>; foldedTools: Set<string> } {
  const hidden = new Set<string>()
  const foldedTools = new Set<string>()
  const results = buildToolResultAssociations(messages)
  messages.forEach((message) => {
    if (message.role !== "assistant") return
    const calls = message.tool_calls ?? []
    for (const [toolIndex, tool] of calls.entries()) {
      if (cardCallIds.has(tool.id)) continue
      const key = getWorkerToolUiKey(message.id, tool.id, toolIndex)
      const result = results.get(key)
      if (!result && tool.name === "request_user_input" && tool.id === pendingQuestionCallId) {
        foldedTools.add(key)
        continue
      }
      // MessageBubble suppresses ordinary running tools too. Exclude their empty virtual
      // rows, but retain approval/failed/interrupted states and interactive or Mod cards.
      const status = liveToolStates?.get(key)?.status
      if (
        !result &&
        keepActiveTurn &&
        (status === "running" || status === "queued") &&
        isBotExecutionTool(tool)
      ) {
        foldedTools.add(key)
        continue
      }
      if (
        result &&
        !botToolResultStatus(tool, result) &&
        (isBotExecutionTool(tool, result) || botScheduleReceipt(tool, result)?.action === "list")
      )
        foldedTools.add(key)
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content
    if (
      blocks?.some(
        (block) => block.type !== "text" || splitBotInlineReasoning(block.text ?? "").body.trim()
      )
    )
      return
    if (
      calls.every((tool, toolIndex) =>
        foldedTools.has(getWorkerToolUiKey(message.id, tool.id, toolIndex))
      )
    )
      hidden.add(message.id)
  })
  return { hiddenMessages: hidden, foldedTools }
}
