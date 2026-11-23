import type { DatabaseSync } from "node:sqlite"
import { LEGACY_WRITER_BATCH_BYTES, LEGACY_WRITER_BATCH_MS } from "./legacy-write-budget"

const ORDINAL_BATCH_ROWS = 64
const ROW_BYTES = `1024 + octet_length(content_json)
  + COALESCE(octet_length(tool_calls_json), 0) + COALESCE(octet_length(reasoning), 0)`

export interface LegacyOrdinalMove {
  messageId: string
  before: number
  after: number
  graphBoundary?: boolean
}

export interface LegacyOrdinalRange {
  after: number | null
  through: number
  shift: number
  cursor: { ordinal: number; messageId: string; graphBoundary?: boolean } | null
}

export interface LegacyOrdinalReservation {
  range: LegacyOrdinalRange | null
  remainingRanges?: LegacyOrdinalRange[]
  anchors: LegacyOrdinalMove[]
  nextAnchor: number
  epoch: number
  continuesPublishedHistory?: boolean
  protectedPrefixCount?: number
  adoptedAnchors?: string[]
}

export function reserveLegacyOrdinalRanges(
  database: DatabaseSync, threadId: string, ranges: readonly LegacyOrdinalRange[]
): LegacyOrdinalReservation | null {
  const [range, ...remainingRanges] = ranges
  return range ? { range, remainingRanges, anchors: [], nextAnchor: 0,
    epoch: createOrdinalReaders(database, threadId).epoch(), continuesPublishedHistory: true } : null
}

function createOrdinalReaders(database: DatabaseSync, threadId: string) {
  const epochTable = database.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'thread_search_structure_versions'`).get()
  const readEpoch = epochTable
    ? database.prepare("SELECT epoch FROM thread_search_structure_versions WHERE thread_id = ?") : null
  const byId = database.prepare(`SELECT ${ROW_BYTES} AS bytes FROM thread_messages
    WHERE thread_id = ? AND message_id = ? AND ordinal = ?`)
  const rangeQuery = (table: string, id: string, bytes: string, graph: number) => `
    SELECT ${id} AS row_id, ordinal, ${bytes} AS bytes, ${graph} AS graph FROM ${table}
    WHERE thread_id = $threadId AND ordinal <= $through AND ($after IS NULL OR ordinal > $after)
      AND ($ordinal IS NULL OR ordinal < $ordinal OR (ordinal = $ordinal AND
        (${graph} < $graph OR (${graph} = $graph AND ${id} < $messageId))))
    ORDER BY ordinal DESC, ${id} DESC LIMIT ${ORDINAL_BATCH_ROWS + 1}`
  const inRange = database.prepare(`
    SELECT * FROM (${rangeQuery("thread_messages", "message_id", ROW_BYTES, 0)})
    UNION ALL
    SELECT * FROM (${rangeQuery("thread_graph_transcript_boundaries", "graph_user_id", "128", 1)})
    ORDER BY ordinal DESC, graph DESC, row_id DESC LIMIT ${ORDINAL_BATCH_ROWS + 1}`)
  return {
    epoch: () => Number(readEpoch?.get(threadId)?.epoch ?? 0),
    anchorBytes: ({ messageId, before }: LegacyOrdinalMove) => Number(byId.get(threadId, messageId, before)?.bytes ?? 0),
    rangeRows: ({ through, after, cursor }: NonNullable<LegacyOrdinalReservation["range"]>) => inRange.all({
      threadId, through, after, ordinal: cursor?.ordinal ?? null, messageId: cursor?.messageId ?? null,
      graph: Number(cursor?.graphBoundary ?? false)
    }).map((row) => ({ messageId: String(row.row_id), ordinal: Number(row.ordinal),
      bytes: Number(row.bytes), graphBoundary: row.graph === 1 }))
  }
}

export function planLegacyOrdinalReservation(
  database: DatabaseSync, threadId: string, range: LegacyOrdinalReservation["range"],
  anchors: LegacyOrdinalMove[], protectedPrefixCount?: number
): LegacyOrdinalReservation | null {
  if (!range && !anchors.length) return null
  const readers = createOrdinalReaders(database, threadId)
  const rows = range ? readers.rangeRows(range) : []
  const bytes = rows.reduce((size, row) => size + row.bytes, 0)
  if (protectedPrefixCount === undefined && rows.length + anchors.length <= ORDINAL_BATCH_ROWS &&
      bytes + anchors.reduce((size, row) => size + readers.anchorBytes(row), 0) <= LEGACY_WRITER_BATCH_BYTES) return null

  // Move upward from the newest anchor, then downward from the oldest. An
  // interrupted reservation keeps the chronological order of every saved row.
  const upward = anchors.filter((row) => row.after > row.before).reverse()
  const downward = anchors.filter((row) => row.after < row.before)
  return { range, anchors: [...upward, ...downward], nextAnchor: 0, epoch: readers.epoch(), protectedPrefixCount }
}

export function applyLegacyOrdinalReservationBatch(
  database: DatabaseSync, threadId: string, reservation: LegacyOrdinalReservation
): "more" | "complete" | "changed" {
  const readers = createOrdinalReaders(database, threadId)
  if (readers.epoch() !== reservation.epoch) return "changed"
  const update = database.prepare(`UPDATE thread_messages SET ordinal = ?
    WHERE thread_id = ? AND message_id = ? AND ordinal = ?`)
  const updateBoundary = database.prepare(`UPDATE thread_graph_transcript_boundaries SET ordinal = ?
    WHERE thread_id = ? AND graph_user_id = ? AND ordinal = ?`)
  const started = performance.now()
  let bytes = 0
  let count = 0
  const canMove = (estimate: number) => count === 0 || (count < ORDINAL_BATCH_ROWS &&
    bytes + estimate <= LEGACY_WRITER_BATCH_BYTES && performance.now() - started < LEGACY_WRITER_BATCH_MS)
  const move = ({ messageId, before, after, graphBoundary }: LegacyOrdinalMove, estimate: number) => {
    if (Number((graphBoundary ? updateBoundary : update).run(after, threadId, messageId, before).changes) !== 1)
      throw new Error("Legacy ordinal reservation row changed while writing")
    bytes += estimate
    count += 1
  }
  if (reservation.range) {
    const range = reservation.range
    const rows = readers.rangeRows(range)
    for (const { messageId, ordinal, bytes, graphBoundary } of rows) {
      if (!canMove(bytes)) break
      move({ messageId, before: ordinal, after: ordinal + range.shift, graphBoundary }, bytes)
      range.cursor = { messageId, ordinal, graphBoundary }
    }
    if (count === rows.length) reservation.range = reservation.remainingRanges?.shift() ?? null
  }
  if (!reservation.range) {
    while (reservation.nextAnchor < reservation.anchors.length) {
      const anchor = reservation.anchors[reservation.nextAnchor]
      const size = readers.anchorBytes(anchor)
      if (!size) return "changed"
      if (!canMove(size)) break
      move(anchor, size)
      reservation.nextAnchor += 1
    }
  }
  reservation.epoch = readers.epoch()
  return !reservation.range && reservation.nextAnchor === reservation.anchors.length ? "complete" : "more"
}
