import type { Message, ToolCall } from "@/types"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"
import { botToolResultStatus } from "./bot-tool-result-status"

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
  "bot_memory_search",
  "bot_memory_list",
  "bot_memory_get",
  "bot_remember",
  "bot_forget"
])

export function isBotExecutionTool(tool: ToolCall): boolean {
  return (
    executionTools.has(tool.name) &&
    !(tool.name === "bot_browser" && tool.args?.action === "request_help")
  )
}

/** View projection only: preserve approvals, failures, deliveries, collaboration and Mod cards. */
export function projectBotExecution(
  messages: readonly Message[],
  keepActiveTurn: boolean,
  cardCallIds: ReadonlySet<string>
): { hiddenMessages: Set<string>; foldedTools: Set<string> } {
  const hidden = new Set<string>()
  const foldedTools = new Set<string>()
  const results = buildToolResultAssociations(messages)
  const activeStart = Math.max(
    0,
    messages.findLastIndex((message) => message.role === "user")
  )
  messages.forEach((message, index) => {
    // Live tool results can be enriched or fail without changing their ID. Wait for settlement.
    if (message.role !== "assistant" || (keepActiveTurn && index >= activeStart)) return
    const calls = message.tool_calls ?? []
    for (const [toolIndex, tool] of calls.entries()) {
      if (!isBotExecutionTool(tool) || cardCallIds.has(tool.id)) continue
      const key = getWorkerToolUiKey(message.id, tool.id, toolIndex)
      const result = results.get(key)
      if (result && !botToolResultStatus(tool, result)) foldedTools.add(key)
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
