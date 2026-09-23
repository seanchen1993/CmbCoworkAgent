import type { ReactNode } from "react"
import type { ToolCall, ToolCallStatus } from "@/types"
import { functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"

/** Only non-approval detail presentation; execution, headers and raw evidence remain host-owned. */
export function FunctionToolDisplay({
  threadId,
  component,
  toolCall,
  result,
  status,
  isError,
  needsApproval,
  fallback
}: {
  threadId: string
  component: "ToolUse" | "ToolResult"
  toolCall: ToolCall
  result?: unknown
  status: ToolCallStatus
  isError?: boolean
  needsApproval?: boolean
  fallback: ReactNode
}): ReactNode {
  if (needsApproval || (component === "ToolResult" && result === undefined)) return fallback
  let facts
  try {
    facts = functionSiteProps(component, {
      tool_use_id: toolCall.id,
      tool: toolCall.name,
      isErrored: Boolean(isError || status === "failed" || status === "rejected"),
      ...(component === "ToolUse"
        ? {
            input: toolCall.args,
            isRunning: status === "running",
            isInterrupted: status === "interrupted"
          }
        : {}),
      ...(result === undefined ? {} : { output: result })
    })
  } catch {
    return fallback
  }
  return (
    <FunctionSite
      key={`${threadId}:${toolCall.id}:${component}`}
      threadId={threadId}
      component={component}
      facts={facts}
      className="contents"
      fallback={fallback}
    />
  )
}
