import type { Message, ToolCall, ToolResult } from "@/types"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"
import { botTaskOutputState, botToolResultStatus } from "./bot-tool-result-status"
import { botScheduleReceipt } from "./bot-schedule-view"

// Only ordinary built-in execution records are folded. Unknown tools may own interactive UI.
const executionTools = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "ls",
  "glob",
  "grep",
  "execute",
  "write_todos",
  "bot_browser",
  "bot_list_peers",
  "bot_memory_search",
  "bot_memory_list",
  "bot_memory_get",
  "bot_remember",
  "bot_forget"
])

export function isBotExecutionTool(
  tool: ToolCall,
  result?: Pick<ToolResult, "content" | "is_error">
): boolean {
  if (tool.name === "task_output")
    return !!result && (!!botToolResultStatus(tool, result) || !!botTaskOutputState(result.content))
  return (
    executionTools.has(tool.name) &&
    !(tool.name === "bot_browser" && tool.args?.action === "request_help")
  )
}

/** View projection only: preserve approvals, failures, deliveries, collaboration and Mod cards. */
export function projectBotExecution(
  messages: readonly Message[],
  keepActiveTurn: boolean,
  cardCallIds: ReadonlySet<string>,
  pendingQuestionCallId: string | null = null
): { hiddenMessages: Set<string>; foldedTools: Set<string> } {
  const hidden = new Set<string>()
  const foldedTools = new Set<string>()
  const results = buildToolResultAssociations(messages)
  const activeStart = Math.max(
    0,
    messages.findLastIndex((message) => message.role === "user")
  )
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return
    const calls = message.tool_calls ?? []
    // Keep a live text/reasoning reply available as its body grows. Confirmed tool-only
    // records may fold immediately; the displayed tool projection revisits enriched results.
    if (keepActiveTurn && index >= activeStart && !calls.length) return
    for (const [toolIndex, tool] of calls.entries()) {
      if (cardCallIds.has(tool.id)) continue
      const key = getWorkerToolUiKey(message.id, tool.id, toolIndex)
      const result = results.get(key)
      if (!result && tool.name === "request_user_input" && tool.id === pendingQuestionCallId) {
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
