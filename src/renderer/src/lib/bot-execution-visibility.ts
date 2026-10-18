import type { Message, ToolCall, ToolCallState, ToolResult } from "@/types"
import { buildToolResultAssociations, getWorkerToolUiKey } from "./worker-tool-result-key"
import { splitBotInlineReasoning } from "./bot-inline-reasoning"
import {
  botMcpBridgeState,
  botTaskOutputState,
  botToolResultStatus,
  isBotMcpBridgeTool
} from "./bot-tool-result-status"
import { botScheduleReceipt } from "./bot-schedule-view"

// Fold native execution and MCP data records. Unknown tool families may own interactive UI.
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
  if (tool.name === "workflow") {
    if (!result) return false // Keep the live launch/approval available.
    if (botToolResultStatus(tool, result)) return true
    if (typeof result.content !== "string") return false
    try {
      // The original workflow tool's launch receipt is not the background outcome.
      // Its live state already has a separate Bot presentation; keep warnings and
      // unrecognized/post-hook receipts inspectable rather than hiding them.
      const value = JSON.parse(result.content)
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.status === "launched" &&
        typeof value.runId === "string" &&
        /^wf_[a-z0-9]{6,32}$/.test(value.runId) &&
        typeof value.name === "string" &&
        typeof value.scriptPath === "string" &&
        Array.isArray(value.phases) &&
        value.phases.every((phase: unknown) => typeof phase === "string") &&
        typeof value.note === "string" &&
        (value.resumeNote === undefined || typeof value.resumeNote === "string") &&
        Object.keys(value).every((key) =>
          ["status", "runId", "name", "scriptPath", "phases", "note", "resumeNote"].includes(key)
        )
      )
    } catch {
      return false
    }
  }
  if (isBotMcpBridgeTool(tool.name))
    return (
      !result || !!botToolResultStatus(tool, result) || !!botMcpBridgeState(tool, result.content)
    )
  if (tool.name === "task_output")
    return !!result && (!!botToolResultStatus(tool, result) || !!botTaskOutputState(result.content))
  if (
    tool.name === "bot_request_browser_help" ||
    (tool.name === "bot_browser" && tool.args?.action === "request_help")
  )
    return !!result // Keep the live handoff card; settle its history like other native tools.
  if (executionTools.has(tool.name)) return true
  if (!tool.name.startsWith("mcp__")) return false
  const separator = tool.name.indexOf("__", 5)
  return separator > 5 && separator + 2 < tool.name.length
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
