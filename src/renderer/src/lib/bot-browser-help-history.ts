import type { ToolCall, ToolResult } from "@/types"
import { botToolResultStatus } from "./bot-tool-result-status"

export interface BotBrowserHelpHistory {
  status: "skipped" | "ended"
  instruction: string
}

const freshHumanReturn =
  "Human control ended. You now have control again. The pending action was replaced with this fresh observation; it was not replayed."

/** Product history comes from the exact persisted help call/result, never the current lease. */
export function botBrowserHelpHistory(
  tool: ToolCall,
  result: Pick<ToolResult, "content" | "is_error">
): BotBrowserHelpHistory | null {
  if (
    !(
      tool.name === "bot_request_browser_help" ||
      (tool.name === "bot_browser" && tool.args?.action === "request_help")
    ) ||
    botToolResultStatus(tool, result) ||
    typeof tool.args?.instruction !== "string"
  )
    return null
  const instruction = tool.args.instruction.trim()
  if (!instruction || instruction.length > 500 || instruction.includes("\0")) return null
  try {
    // Match the existing product-receipt parsers: compatibility transports may
    // persist text blocks, but mixed media and non-JSON results are not receipts.
    let content = result.content
    if (
      Array.isArray(content) &&
      content.length &&
      content.every((part) => part?.type === "text" && typeof part.text === "string")
    )
      content = content.map((part) => part.text).join("")
    if (typeof content !== "string" || content.length > 100_000) return null
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const receipt = value as Record<string, unknown>
    if (
      receipt.ok === false ||
      typeof receipt.error === "string" ||
      (receipt.helpSkipped !== undefined && typeof receipt.helpSkipped !== "boolean") ||
      (receipt.control !== undefined && receipt.control !== "bot")
    )
      return null
    if (receipt.helpSkipped === true) return { status: "skipped", instruction }
    if (
      receipt.control === "bot" &&
      typeof receipt.note === "string" &&
      receipt.note.includes(freshHumanReturn)
    )
      return { status: "ended", instruction }
  } catch {
    // Keep malformed/unknown results on their existing execution presentation.
  }
  return null
}
