import {
  getSerializedMessageRole,
  persistedMessageFromStreamPayload
} from "./stream-transcript-payload"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY
} from "../../shared/stream-message-wire-mode"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageProviderTupleFromMetadata,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds,
  type RoleCollisionMessage
} from "../../shared/message-role-collision"
import type { Message } from "../types"

type ValuesSnapshotKind = "full" | "append" | "tail"
type TranscriptValueSnapshot = [Record<string, unknown>, Record<string, unknown>]
const selectedSnapshots = new WeakMap<object, readonly TranscriptValueSnapshot[]>()
const localOccurrences = new WeakMap<object, number>()

/** Collector-local position, independent of the durable history occurrence offset. */
export function getStreamTranscriptValueLocalOccurrence(
  tuple: readonly unknown[]
): number | undefined {
  return localOccurrences.get(tuple)
}

/** Share the persistence route with downstream consumers of this wire frame. */
export function rememberSelectedStreamTranscriptValueSnapshots(
  payload: unknown,
  snapshots: readonly TranscriptValueSnapshot[]
): void {
  if (payload && typeof payload === "object") selectedSnapshots.set(payload, snapshots)
}

export function getSelectedStreamTranscriptValueSnapshots(
  payload: unknown
): readonly TranscriptValueSnapshot[] | undefined {
  return payload && typeof payload === "object" ? selectedSnapshots.get(payload) : undefined
}

interface ValuesIdentityContext {
  /** The run's existing values accumulator, including tool/user boundaries. */
  completeMessages?: readonly unknown[]
  loadBaselineMessages?: (selectors: readonly RoleCollisionMessage[]) => readonly Message[]
  loadPreviousTurnOccurrences?: (
    userMessageId: string,
    providerSourceIds: readonly string[]
  ) =>
    | readonly { provider_source_id: string; role: string; provider_occurrence: number }[]
    | undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function identity(message: unknown): RoleCollisionMessage | undefined {
  const source = record(message)
  const kwargs = record(source?.kwargs) ?? source
  const role = getSerializedMessageRole(message)
  if (!kwargs || !role || typeof kwargs.id !== "string" || !kwargs.id.trim()) return undefined
  return {
    id: kwargs.id,
    role,
    ...getMessageProviderTupleFromMetadata(record(kwargs.additional_kwargs)),
    ...(typeof kwargs.tool_call_id === "string" ? { tool_call_id: kwargs.tool_call_id } : {})
  }
}

const sourceKey = (message: RoleCollisionMessage) =>
  JSON.stringify([message.role, getMessageProviderSourceId(message)])
const occurrenceKey = (message: RoleCollisionMessage) =>
  JSON.stringify([sourceKey(message), getMessageProviderOccurrence(message) ?? 1])

/** Values contain complete fields, even when their envelope is an append/tail.
 * Keep field presence intact: the message parser distinguishes a missing field
 * from an explicit empty replacement. A full frame starts at its latest user;
 * a frame without a user can be the only final update produced by this run.
 */
export function selectStreamTranscriptValueSnapshots(
  payload: unknown,
  valuesSnapshotKind: ValuesSnapshotKind = "full",
  context: ValuesIdentityContext = {}
): TranscriptValueSnapshot[] {
  if (!["full", "append", "tail"].includes(valuesSnapshotKind)) return []
  if (!payload || typeof payload !== "object" || !("messages" in payload)) return []
  if (!Array.isArray(payload.messages)) return []
  if (payload.messages.length === 0) return []
  const changed = new Set(payload.messages as unknown[])
  const messages = context.completeMessages ?? (payload.messages as unknown[])
  let start = 0
  // Append/tail envelopes already contain changed messages, but an appended
  // batch can cross a user boundary too. In every kind keep only the last turn.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getSerializedMessageRole(messages[index]) === "user") {
      start = index + 1
      break
    }
  }
  // Assign identities while tool boundaries and complete occurrence order are
  // still available. Filtering AI first would collapse every reused provider ID.
  const entries = messages.slice(start).flatMap((message) => {
    const parsed = identity(message)
    return parsed ? [{ message, identity: parsed }] : []
  })
  const changedEntries = entries.filter((entry) => changed.has(entry.message))
  const changedSelectors = [
    ...new Map(
      changedEntries.map((entry) => [
        JSON.stringify([entry.identity.id, occurrenceKey(entry.identity)]),
        entry.identity
      ])
    ).values()
  ]
  let baseline = context.loadBaselineMessages?.(changedSelectors) ?? []
  const user = start > 0 ? identity(messages[start - 1]) : undefined
  const baselineBoundary = user
    ? baseline.findLastIndex((message) => message.role === "user" && message.id === user.id)
    : baseline.findLastIndex((message) => message.role === "user")
  const previousTurn =
    user && baselineBoundary < 0 ? baseline : baseline.slice(0, Math.max(0, baselineBoundary))
  const offsets = new Map<string, number>()
  for (const message of previousTurn) {
    const key = sourceKey(message)
    offsets.set(key, Math.max(offsets.get(key) ?? 0, getMessageProviderOccurrence(message) ?? 1))
  }
  const userMessageId =
    user?.id ?? (baselineBoundary >= 0 ? baseline[baselineBoundary].id : undefined)
  if (userMessageId && context.loadPreviousTurnOccurrences) {
    const previous = context.loadPreviousTurnOccurrences(userMessageId, [
      ...new Set(changedEntries.map((entry) => getMessageProviderSourceId(entry.identity)))
    ])
    for (const message of previous ?? []) {
      offsets.set(
        JSON.stringify([message.role, message.provider_source_id]),
        message.provider_occurrence
      )
    }
  }
  const counts = new Map(offsets)
  const localCounts = new Map<string, number>()
  const localPositions: number[] = []
  const declared = entries.map((entry) => {
    const message = entry.identity
    const key = sourceKey(message)
    const localOccurrence = (localCounts.get(key) ?? 0) + 1
    localCounts.set(key, localOccurrence)
    localPositions.push(localOccurrence)
    const occurrence = getMessageProviderOccurrence(message) ?? (counts.get(key) ?? 0) + 1
    counts.set(key, Math.max(counts.get(key) ?? 0, occurrence))
    return {
      ...message,
      provider_source_id: getMessageProviderSourceId(message),
      provider_occurrence: occurrence
    }
  })
  baseline =
    context.loadBaselineMessages?.(
      declared.filter((_message, index) => changed.has(entries[index].message))
    ) ?? baseline
  const baselineIds = new Map(baseline.map((message) => [occurrenceKey(message), message.id]))
  const normalized = normalizeCompleteMessageIds(
    normalizeMessageRoleCollisionIds(baseline, declared)
  )
  const result: TranscriptValueSnapshot[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const { message } = entries[index]
    const resolved = normalized[index]
    if ((resolved.role !== "assistant" && resolved.role !== "tool") || !changed.has(message))
      continue
    const source = message as Record<string, unknown>
    const kwargs = record(source.kwargs) ?? source
    const stableId = baselineIds.get(occurrenceKey(resolved)) ?? resolved.id
    const tuple: TranscriptValueSnapshot = [
      {
        ...source,
        ...(typeof source.id === "string" ? { id: stableId } : {}),
        kwargs: {
          ...kwargs,
          id: stableId,
          additional_kwargs: {
            ...record(kwargs.additional_kwargs),
            [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: resolved.provider_source_id,
            [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: resolved.provider_occurrence
          }
        }
      },
      {
        [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot",
        [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot"
      }
    ]
    if (persistedMessageFromStreamPayload(tuple)) {
      localOccurrences.set(tuple, localPositions[index])
      result.push(tuple)
    }
  }
  return result
}
