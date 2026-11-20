import type { Message, ToolCall } from "../types"
import { normalizeCompleteMessageIds } from "../../../shared/message-role-collision"
import { getWorkerToolResultKey } from "./worker-tool-result-key"

const WORKFLOW_PROVIDER_ID_PREFIX = "workflow-provider:"
const MAX_WORKER_PROVIDER_WIRE_IDS = 16

export function mergeWorkerProviderWireIds(
  previous: Message["worker_provider_wire_ids"],
  incoming: Message["worker_provider_wire_ids"]
): Message["worker_provider_wire_ids"] {
  if (!previous || !incoming) return incoming ?? previous
  if (incoming.length === 1 && previous.at(-1) === incoming[0]) return previous
  const recent = new Set(previous)
  for (const id of incoming) {
    recent.delete(id)
    recent.add(id)
  }
  return [...recent].slice(-MAX_WORKER_PROVIDER_WIRE_IDS)
}

function hasExplicitProviderTuple(message: Message): boolean {
  return !!message.provider_source_id && !!message.provider_occurrence
}

// A complete list defines membership. A retained call can still carry sparse args.
export function mergeWorkerToolCallSnapshot(
  previous: Message["tool_calls"],
  snapshot: Message["tool_calls"]
): Message["tool_calls"] {
  if (!previous?.length || !snapshot?.length) return snapshot

  const priorById = new Map(previous.map((call) => [call.id, call]))
  return snapshot.map((call) => {
    const prior = call.id ? priorById.get(call.id) : undefined
    if (!prior || (call.name && prior.name && call.name !== prior.name)) return call

    const name = call.name || prior.name
    const args =
      call.args && Object.keys(call.args).length > 0 ? call.args : (prior.args ?? call.args)
    return name === call.name && args === call.args ? call : { ...call, name, args }
  })
}

export function applyWorkerToolCallSnapshot(
  previous: Message,
  incoming: Message,
  merged: Message,
  earlierCallsByMessage: Map<Message, readonly ToolCall[]>
): Message {
  const earlierCalls = earlierCallsByMessage.get(previous)
  earlierCallsByMessage.delete(previous)
  const isSnapshot = incoming.worker_tool_calls_source === "snapshot"
  const replacement = isSnapshot
    ? {
        ...merged,
        tool_calls: mergeWorkerToolCallSnapshot(previous.tool_calls, incoming.tool_calls)
      }
    : merged
  const removedCalls = isSnapshot ? previous.tool_calls : undefined
  if (removedCalls?.length) {
    earlierCallsByMessage.set(
      replacement,
      earlierCalls ? [...earlierCalls, ...removedCalls] : removedCalls
    )
  } else if (earlierCalls) {
    earlierCallsByMessage.set(replacement, earlierCalls)
  }
  return replacement
}

export function restoreSnapshotAliasCallsWithResults(
  messages: Message[],
  earlierCallsByMessage: ReadonlyMap<Message, readonly ToolCall[]>
): Message[] {
  if (earlierCallsByMessage.size === 0) return messages

  const trailingResults = new Map<string, number>()
  const takeResult = (key: string): boolean => {
    const count = trailingResults.get(key) ?? 0
    if (count === 0) return false
    if (count === 1) trailingResults.delete(key)
    else trailingResults.set(key, count - 1)
    return true
  }

  // The nearest preceding call owns the evidence. A later independent call
  // reusing an ID must not restore a cleared call or cross a prompt boundary.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "user") trailingResults.clear()
    if (message.role === "tool") {
      const key = getWorkerToolResultKey(message.id, message.tool_call_id)
      if (key) trailingResults.set(key, (trailingResults.get(key) ?? 0) + 1)
    }
    if (message.role !== "assistant") continue

    const currentKeys = new Set<string>()
    for (const call of message.tool_calls ?? []) {
      const key = getWorkerToolResultKey(message.id, call.id)
      if (!key) continue
      takeResult(key)
      currentKeys.add(key)
    }
    const earlierCalls = earlierCallsByMessage.get(message)
    if (!earlierCalls) continue

    const restored: ToolCall[] = []
    for (let callIndex = earlierCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = earlierCalls[callIndex]
      const key = getWorkerToolResultKey(message.id, call.id)
      if (!key || currentKeys.has(key) || !takeResult(key)) continue
      restored.push(call)
      currentKeys.add(key)
    }
    if (restored.length > 0) {
      messages[index] = {
        ...message,
        tool_calls: [...(message.tool_calls ?? []), ...restored.reverse()]
      }
    }
  }
  return messages
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
  const earlierCallsByMessage = new Map<Message, readonly ToolCall[]>()
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
      const merged: Message = {
        ...message,
        id: previous.id,
        worker_snapshot_index: previous.worker_snapshot_index,
        ...(message.role === "assistant" && {
          tool_calls: message.tool_calls ?? previous.tool_calls,
          worker_tool_calls_source:
            message.worker_tool_calls_source ?? previous.worker_tool_calls_source
        }),
        ...(!workflow && {
          worker_provider_wire_ids: mergeWorkerProviderWireIds(
            previous.worker_provider_wire_ids,
            message.worker_provider_wire_ids
          )
        })
      }
      result[previousIndex] = applyWorkerToolCallSnapshot(
        previous,
        message,
        merged,
        earlierCallsByMessage
      )
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
  return restoreSnapshotAliasCallsWithResults(result, earlierCallsByMessage)
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
