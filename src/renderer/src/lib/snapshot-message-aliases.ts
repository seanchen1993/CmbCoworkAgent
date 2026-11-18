import type { Message } from "../types"
import { normalizeCompleteMessageIds } from "../../../shared/message-role-collision"

const WORKFLOW_PROVIDER_ID_PREFIX = "workflow-provider:"

function hasExplicitProviderTuple(message: Message): boolean {
  return !!message.provider_source_id && !!message.provider_occurrence
}

/**
 * Complete snapshots can contain different wire IDs for one explicitly
 * identified message. Run this before normalizing IDs, since the normalizer
 * also assigns occurrences to legacy messages that must remain distinct.
 */
export function coalesceSnapshotMessageAliases(
  messages: readonly Message[],
  workflow?: { scope: string; precedingPromptIndex?: number }
): Message[] {
  const result: Message[] = []
  const indexByIdentity = new Map<string, number>()
  let workflowTurn = workflow?.precedingPromptIndex
  for (const message of messages) {
    if (workflow && message.role === "user") {
      // The initial prompt and replies before any later prompt share the first turn.
      workflowTurn = message.worker_snapshot_index || undefined
    }
    if (!hasExplicitProviderTuple(message)) {
      result.push(message)
      continue
    }
    const identity = JSON.stringify([
      message.role,
      message.provider_source_id,
      message.provider_occurrence,
      message.role === "tool" ? message.tool_call_id : undefined,
      workflowTurn
    ])
    const previousIndex = indexByIdentity.get(identity)
    if (previousIndex !== undefined) {
      const previous = result[previousIndex]
      result[previousIndex] = {
        ...message,
        id: previous.id,
        worker_snapshot_index: previous.worker_snapshot_index
      }
      continue
    }
    indexByIdentity.set(identity, result.length)
    result.push(
      workflow
        ? {
            ...message,
            id: `${WORKFLOW_PROVIDER_ID_PREFIX}${JSON.stringify([workflow.scope, identity])}`
          }
        : message
    )
  }
  return result
}

export function normalizeWorkflowSnapshotMessageIds(messages: readonly Message[]): Message[] {
  // Legacy occurrences can be inferred independently. Explicit, scoped IDs
  // have already been reconciled and do not share slots with legacy inference.
  const legacy = normalizeCompleteMessageIds(
    messages
      .filter((message) => !hasExplicitProviderTuple(message))
      .map((message) =>
        message.id.startsWith(WORKFLOW_PROVIDER_ID_PREFIX)
          ? { ...message, id: `workflow-legacy:${message.id}` }
          : message
      )
  )
  let nextLegacyIndex = 0
  return messages.map((message) =>
    hasExplicitProviderTuple(message) ? message : legacy[nextLegacyIndex++]
  )
}
