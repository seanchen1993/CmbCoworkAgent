import type { Message } from "../types"
import { resolveToolResultOwnership } from "../../../shared/tool-result-ownership"

export { getWorkerToolResultKey, getWorkerToolUiKey } from "../../../shared/tool-result-ownership"

export interface ToolResultAssociation {
  content: unknown
  is_error?: boolean
}

export function buildToolResultAssociations(
  messages: readonly Message[]
): Map<string, ToolResultAssociation> {
  const results = new Map<string, ToolResultAssociation>()
  for (const [owner, message] of resolveToolResultOwnership(messages)) {
    results.set(owner, {
      content: message.content,
      is_error: message.is_error ?? message.status === "error"
    })
  }
  return results
}
