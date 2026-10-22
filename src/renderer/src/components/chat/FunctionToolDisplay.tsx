import type { ReactNode } from "react"
import type { ToolCall, ToolCallStatus } from "@/types"
import type { ModObject } from "../../../../shared/mods/types"
import { functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"
import { functionSiteRowIdentity } from "../../lib/function-site-identity"

/** Only non-approval detail presentation; execution, headers and raw evidence remain host-owned. */
export function FunctionToolDisplay({
  threadId,
  component,
  toolCall,
  result,
  status,
  isError,
  needsApproval,
  fallback,
  presentation,
  renderDetails
}: {
  threadId: string
  component: "ToolUse" | "ToolResult"
  toolCall: ToolCall
  result?: unknown
  status: ToolCallStatus
  isError?: boolean
  needsApproval?: boolean
  fallback: ReactNode
  presentation?: { input: unknown; output?: unknown }
  renderDetails(safe: ModObject): ReactNode
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
            input: presentation ? presentation.input : toolCall.args,
            isRunning: status === "running",
            isInterrupted: status === "interrupted"
          }
        : {}),
      ...((presentation ? presentation.output : result) === undefined
        ? {}
        : { output: presentation ? presentation.output : result })
    })
  } catch {
    return fallback
  }
  return (
    <FunctionSite
      key={`${threadId}:${toolCall.id}:${component}`}
      threadId={threadId}
      component={component}
      presentationId={functionSiteRowIdentity(component, [toolCall.id])}
      facts={facts}
      className="contents"
      fallback={fallback}
      renderNative={renderDetails}
    />
  )
}
