import type { ToolCall, ToolCallStatus, ToolResult } from "@/types"
import { hasFailedCommandResult } from "../../../shared/command-result"

const mcpBridgeTools = new Set(["search_tool", "inspect_tool", "invoke_deferred_tool"])
export const isBotMcpBridgeTool = (name: string): boolean => mcpBridgeTools.has(name)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Original tool-search-tool receipts; MCP business data inside data/schema is not a status. */
export function botMcpBridgeState(
  tool: Pick<ToolCall, "name">,
  content: unknown
): "succeeded" | "failed" | undefined {
  if (!isBotMcpBridgeTool(tool.name) || typeof content !== "string") return undefined
  try {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value)) return undefined
    const keys = Object.keys(value)
    if (tool.name === "invoke_deferred_tool") {
      if (
        value.ok === false &&
        typeof value.error === "string" &&
        keys.every((key) => key === "ok" || key === "error")
      )
        return "failed"
      if (
        value.ok === true &&
        "data" in value &&
        (value._projection === undefined || isRecord(value._projection)) &&
        keys.every((key) => key === "ok" || key === "data" || key === "_projection")
      )
        return "succeeded"
    } else if (tool.name === "search_tool") {
      if (
        keys.length === 1 &&
        Array.isArray(value.tools) &&
        value.tools.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.tool_id === "string" &&
            typeof entry.source === "string" &&
            Array.isArray(entry.allow_callers) &&
            !("error" in entry)
        )
      )
        return "succeeded"
    } else if (keys.length === 1 && Array.isArray(value.loaded_tools)) {
      const entries: unknown[] = value.loaded_tools
      if (!entries.every(isRecord)) return undefined
      if (!entries.every((entry) => typeof entry.tool_id === "string")) return undefined
      if (entries.some((entry) => typeof entry.error === "string")) return "failed"
      if (entries.every((entry) => isRecord(entry.schema) && !("error" in entry)))
        return "succeeded"
    }
  } catch {
    // Post-hook and unrecognized receipts keep their original inspectable tool UI.
  }
  return undefined
}

/** Only recognize CMB's native task_output receipts; post-hook/unknown text stays visible. */
export function botTaskOutputState(
  content: unknown
): "succeeded" | "pending" | "failed" | "interrupted" | undefined {
  if (typeof content !== "string") return undefined
  if (content === "Task polling aborted: conversation was cancelled by user.") return "interrupted"
  if (
    content === "Error: Invalid task id." ||
    /^Error: No background task found with id "[\s\S]*"\.$/.test(content) ||
    content.startsWith("[Hook blocked] ")
  )
    return "failed"
  // Anchor to the final receipt: stdout may itself contain command-status text.
  const terminal =
    /(?:^|\n)\[Command (succeeded|failed) with exit code (-?\d+|null|undefined), elapsed: (\d+(?:\.\d+)?|undefined)s\]$/.exec(
      content
    )
  if (terminal) return terminal[1] === "succeeded" && terminal[2] === "0" ? "succeeded" : "failed"
  try {
    const value = JSON.parse(content)
    const nonnegative = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && n >= 0
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value.retrieval_status === "not_ready" || value.retrieval_status === "timeout") &&
      nonnegative(value.elapsed) &&
      typeof value.command === "string" &&
      (value.partialOutput === undefined || typeof value.partialOutput === "string") &&
      (value.partialTruncated === undefined || typeof value.partialTruncated === "boolean") &&
      (value.idleSeconds === undefined || nonnegative(value.idleSeconds)) &&
      Object.keys(value).every((key) =>
        [
          "retrieval_status",
          "elapsed",
          "command",
          "partialOutput",
          "partialTruncated",
          "idleSeconds"
        ].includes(key)
      )
    )
      return "pending"
  } catch {
    // Unrecognized receipts retain their original tool UI.
  }
  return undefined
}

/** DeepAgents repairs an interrupted call with a cancellation result, not a successful execution. */
export function botToolResultStatus(
  tool: ToolCall,
  result?: Pick<ToolResult, "content" | "is_error">
): ToolCallStatus | undefined {
  if (!result) return undefined
  if (
    result.content ===
    `Tool call ${tool.name} with id ${tool.id} was cancelled - another message came in before it could be completed.`
  )
    return "interrupted"
  const outputState = tool.name === "task_output" ? botTaskOutputState(result.content) : undefined
  if (outputState === "interrupted") return "interrupted"
  return result.is_error ||
    botMcpBridgeState(tool, result.content) === "failed" ||
    outputState === "failed" ||
    (tool.name === "execute" && hasFailedCommandResult(result.content))
    ? "failed"
    : undefined
}
