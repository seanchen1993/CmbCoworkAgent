import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { getMessageProviderOccurrence, getMessageProviderSourceId } from "../../shared/message-role-collision"
import type { LegacyTranscriptOrder, LegacyTranscriptOrderIdentity } from "./legacy-transcript-write-protocol"

function select(database: NativeSqliteAdapter, sql: string, bindings: readonly unknown[] = []) {
  const table = database.exec(sql, bindings)[0]
  return table?.values.map(row => Object.fromEntries(table.columns.map((column, i) => [column, row[i]]))) ?? []
}

interface LegacyDurableIdentity {
  message_id: string
  ordinal: number
}

export function createLegacyDurableIdentityLookup(database: NativeSqliteAdapter, threadId: string) {
  const query = (sql: string) => (...bindings: unknown[]) => select(database, sql, bindings)
  const byId = query(
    `SELECT message_id, ordinal, provider_source_id, provider_occurrence
     FROM thread_messages
     WHERE thread_id = ? AND message_id = ? AND role = ?
       AND (? != 'tool' OR tool_call_id IS ?)`
  )
  const byProvider = query(
    `SELECT message_id, ordinal FROM thread_messages
     WHERE thread_id = ? AND provider_source_id = ? AND role = ? AND provider_occurrence IS ?
       AND (? != 'tool' OR tool_call_id = ?)
     LIMIT 2`
  )

  return (message: LegacyTranscriptOrderIdentity): LegacyDurableIdentity | undefined => {
    const [exact] = byId(
      threadId,
      message.messageId,
      message.role,
      message.role,
      message.toolCallId
    )
    const declared = message.declaredProviderIdentity
    if (!declared) return exact as unknown as LegacyDurableIdentity | undefined
    if (exact) {
      const identity = {
        id: String(exact.message_id),
        role: message.role,
        provider_source_id: typeof exact.provider_source_id === "string"
          ? exact.provider_source_id
          : undefined,
        provider_occurrence: typeof exact.provider_occurrence === "number"
          ? exact.provider_occurrence
          : undefined
      }
      if (
        getMessageProviderSourceId(identity) === declared.provider_source_id &&
        (getMessageProviderOccurrence(identity) ?? 1) === declared.provider_occurrence
      ) {
        return exact as unknown as LegacyDurableIdentity
      }
    }
    if (message.role === "tool" && !message.toolCallId) return undefined
    const candidates = byProvider(
      threadId,
      declared.provider_source_id,
      message.role,
      declared.provider_occurrence,
      message.role,
      message.toolCallId
    )
    if (declared.provider_occurrence === 1 && candidates.length < 2) {
      candidates.push(...byProvider(
        threadId,
        declared.provider_source_id,
        message.role,
        null,
        message.role,
        message.toolCallId
      ))
    }
    return candidates.length === 1
      ? (candidates[0] as unknown as LegacyDurableIdentity)
      : undefined
  }
}

export function reserveLegacyTranscriptOrdinals(
  database: NativeSqliteAdapter,
  input: LegacyTranscriptOrder & { threadId: string },
  findDurableIdentity: ReturnType<typeof createLegacyDurableIdentityLookup>,
  assertCurrent: () => void = () => {}
): { ordinals?: Array<number | null>; reservedCount: number } {
  const existing = input.messages.map((message, index) => {
    if (index % 64 === 0) assertCurrent()
    return findDurableIdentity(message)
  })
  const hasGraphBoundaries = select(database,
    "SELECT 1 FROM sqlite_master WHERE name = 'thread_graph_transcript_boundaries' AND type = 'table'"
  ).length > 0
  const preserveScopedOrder =
    input.graphBoundaries.length > 0 ||
    existing.some((row, index) => row && row.message_id !== input.messages[index].messageId) ||
    (hasGraphBoundaries && select(database,
      "SELECT 1 FROM thread_graph_transcript_boundaries WHERE thread_id = ? LIMIT 1", [input.threadId]
    ).length > 0)
  if (!preserveScopedOrder) {
    return { reservedCount: existing.every(Boolean) ? 0 : input.messages.length }
  }

  const ordinals = input.messages.map<number | null>(() => null)
  if (existing.every(Boolean)) return { ordinals, reservedCount: 0 }
  const anchors = input.messages.flatMap((message, index) => {
    const row = existing[index]
    return row ? [{ checkpointIndex: message.checkpointIndex, ordinal: row.ordinal }] : []
  })
  if (hasGraphBoundaries && input.graphBoundaries.length > 0) {
    const boundary = `SELECT ordinal FROM thread_graph_transcript_boundaries
       WHERE thread_id = ? AND graph_user_id = ?`
    for (const message of input.graphBoundaries) {
      const [row] = select(database, boundary, [input.threadId, message.messageId])
      if (typeof row?.ordinal === "number") {
        anchors.push({ checkpointIndex: message.checkpointIndex, ordinal: row.ordinal })
      }
    }
    anchors.sort((left, right) => left.checkpointIndex - right.checkpointIndex)
  }

  const gaps = new Map<number, number[]>()
  let rightIndex = 0
  for (const [index, message] of input.messages.entries()) {
    if (existing[index]) continue
    while (
      rightIndex < anchors.length &&
      anchors[rightIndex].checkpointIndex < message.checkpointIndex
    ) {
      rightIndex += 1
    }
    const left = anchors[rightIndex - 1]?.ordinal
    const right = anchors[rightIndex]?.ordinal
    // Preserve the order already trusted by durable history. A hidden graph
    // boundary is also an anchor, even though it has no visible message row.
    const target = right !== undefined && (left === undefined || right > left)
      ? right
      : left === undefined ? 0 : left + 1
    const gap = gaps.get(target) ?? []
    gap.push(index)
    gaps.set(target, gap)
  }

  const groups = [...gaps].sort(([left], [right]) => left - right)
  database.exec("CREATE TEMP TABLE legacy_transcript_shifts (ordinal INTEGER PRIMARY KEY, shift INTEGER NOT NULL)")
  try {
    let reservedCount = 0
    for (const [target, indexes] of groups) {
      for (const index of indexes) {
        ordinals[index] = target + reservedCount
        reservedCount += 1
      }
      database.run("INSERT INTO legacy_transcript_shifts (ordinal, shift) VALUES (?, ?)",
        [target, reservedCount])
    }
    for (const table of [
      "thread_messages",
      ...(hasGraphBoundaries ? ["thread_graph_transcript_boundaries"] : [])
    ]) {
      database.run(
        `UPDATE ${table}
         SET ordinal = ordinal + (
           SELECT shift FROM legacy_transcript_shifts WHERE ordinal <= ${table}.ordinal
           ORDER BY ordinal DESC LIMIT 1
         )
         WHERE thread_id = ? AND ordinal >= ?`, [input.threadId, groups[0][0]])
    }
    return { ordinals, reservedCount }
  } finally { database.exec("DROP TABLE legacy_transcript_shifts") }
}

export function getLegacyTranscriptSlotIdentity(message: Pick<LegacyTranscriptOrderIdentity,
  "messageId" | "role" | "providerSourceId" | "providerOccurrence">) {
  const identity = {
    id: message.messageId,
    role: message.role,
    provider_source_id: message.providerSourceId ?? undefined,
    provider_occurrence: message.providerOccurrence ?? undefined
  }
  return {
    source: getMessageProviderSourceId(identity),
    role: message.role,
    occurrence: getMessageProviderOccurrence(identity) ?? 1
  }
}
