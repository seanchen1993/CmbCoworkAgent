import { ToolMessage } from "@langchain/core/messages"
import type { BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"

const effectPrefixes: Readonly<Record<string, string>> = {
  browser: "browser",
  download_file: "download",
  upload_file: "browser-upload",
  native_computer: "native-computer",
  project_publish: "project-publish",
  project_edit: "project",
  execute: "shell",
  call_connector_tool: "mcp",
  read_connector_resource: "mcp-resource",
  delete_routine: "routine-delete"
}

export function botReviewedToolCallFeedback(
  store: BotStore,
  lease: BotRunLease,
  toolName: string,
  callId: string
): ToolMessage | null {
  const prefix = Object.hasOwn(effectPrefixes, toolName) ? effectPrefixes[toolName] : undefined
  return prefix
    ? botReviewedEffectFeedback(store, lease, `${prefix}:${lease.runId}:${callId}`, callId)
    : null
}

/** Consume the original call as a reviewed failure, never redispatch it or
 * create approval authority for a replacement operation. */
export function botReviewedEffectFeedback(
  store: BotStore,
  lease: BotRunLease,
  effectId: string,
  callId: string
): ToolMessage | null {
  const review = store.reviewedEffectFailure(lease, effectId)
  if (!review) return null
  return new ToolMessage({
    tool_call_id: callId,
    status: "error",
    content: `Human review confirmed that this earlier operation did not complete. The original call has NOT been repeated. Operation review: ${review.operationNote}\nTask recovery note: ${review.taskNote}\nObserve the current state before planning any further operation. This feedback grants no new permission; a replacement operation requires a new tool call and the normal approval checks.`
  })
}
