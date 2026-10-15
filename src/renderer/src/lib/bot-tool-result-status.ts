import type { ToolCall, ToolCallStatus, ToolResult } from "@/types"
import { hasFailedCommandResult } from "../../../shared/command-result"

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
  return result.is_error || (tool.name === "execute" && hasFailedCommandResult(result.content))
    ? "failed"
    : undefined
}
