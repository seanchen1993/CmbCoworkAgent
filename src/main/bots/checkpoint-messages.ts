import { randomUUID } from "node:crypto"
import type { Checkpoint, SerializerProtocol } from "@langchain/langgraph-checkpoint"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import {
  buildExternalMessagesReference,
  exactMessageReferencePrefix,
  isExternalMessagesReference,
  materializeCheckpointMessageChunks,
  truncateCheckpointMessageChunks,
  MAX_CHECKPOINT_MESSAGE_DELTA_BYTES,
  MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH,
  type CheckpointMessageChunk
} from "../checkpointer/message-snapshot-codec"
import type { BotStore } from "./store"

export const BOT_CHECKPOINT_BYTES = 16 * 1024 * 1024
const MAX_MESSAGES = 1_000_000
const snapshotRow = z.object({
  id: z.string().uuid(),
  parent_id: z.string().uuid().nullable(),
  prefix_length: z.number().int().min(0).max(MAX_MESSAGES),
  message_count: z.number().int().min(0).max(MAX_MESSAGES),
  depth: z.number().int().min(1).max(MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH),
  total_bytes: z.number().int().min(0).max(BOT_CHECKPOINT_BYTES),
  delta_bytes: z.number().int().min(0).max(MAX_CHECKPOINT_MESSAGE_DELTA_BYTES),
  type: z.string(),
  data: z.instanceof(Uint8Array)
})
type Snapshot = Omit<z.infer<typeof snapshotRow>, "data"> & { data: Uint8Array }
const messageIndexRow = snapshotRow.omit({ data: true }).extend({
  bytes: z.number().int().min(0).max(BOT_CHECKPOINT_BYTES),
  suffix_length: z.number().int().min(0).max(MAX_MESSAGES),
  suffix_kind: z.literal("array")
})

export interface CapturedBotMessage {
  totalMessages: number
  /** JSONPlus encoding of exactly one message, captured before serde yields. */
  json?: string
}
export interface PreparedBotMessages {
  checkpoint: Checkpoint
  messages: unknown[]
  snapshot: Snapshot
}
interface WriteState {
  checkpointId: string
  messages: unknown[]
  snapshot: Pick<Snapshot, "id" | "depth" | "total_bytes" | "delta_bytes">
}
export class BotMessageParentUnavailable extends Error {}
const corrupt = () =>
  new BotDomainError(
    "checkpoint_messages_unavailable",
    "检查点消息记录不完整，已停止恢复；请保留数据并检查后台日志"
  )

/** The codec is shared with Cmb's SqlJsSaver. Bot's immutable snapshot identities
 * decouple retained graph checkpoints from delta ancestors. All publication and
 * collection happen in the caller's existing fenced SQLite transaction. */
export class BotCheckpointMessages {
  private readonly previous = new Map<string, WriteState>()
  constructor(
    private readonly store: BotStore,
    private readonly serde: SerializerProtocol
  ) {}

  private rows(sql: string, args: unknown[]): Record<string, unknown>[] {
    const statement = this.store.db.prepare(sql, args)
    const result: Record<string, unknown>[] = []
    try {
      while (statement.step()) result.push(statement.getAsObject())
    } finally {
      statement.free()
    }
    return result
  }

  async prepare(
    ns: string,
    parentCheckpointId: string | undefined,
    checkpoint: Checkpoint,
    base = false
  ): Promise<PreparedBotMessages | null> {
    const source = checkpoint.channel_values.messages
    if (!Array.isArray(source)) return null
    if (source.length > MAX_MESSAGES)
      throw new BotDomainError("checkpoint_size", "检查点消息数量超出限制")
    // Pin the reference sequence before serde yields; callers may reuse their array.
    const messages = source.slice()
    const previous = this.previous.get(ns)
    let prefix =
      !base &&
      previous &&
      previous.checkpointId === parentCheckpointId &&
      previous.snapshot.depth < MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH
        ? exactMessageReferencePrefix(previous.messages, messages)
        : 0
    let [type, data] = await this.serde.dumpsTyped(messages.slice(prefix))
    if (
      prefix &&
      previous &&
      (previous.snapshot.delta_bytes + data.length > MAX_CHECKPOINT_MESSAGE_DELTA_BYTES ||
        previous.snapshot.total_bytes + data.length > BOT_CHECKPOINT_BYTES)
    ) {
      prefix = 0
      ;[type, data] = await this.serde.dumpsTyped(messages)
    }
    if (data.length > BOT_CHECKPOINT_BYTES)
      throw new BotDomainError("checkpoint_size", "检查点消息超出大小限制")
    const parent = prefix && previous ? previous.snapshot : null
    return {
      checkpoint: {
        ...checkpoint,
        channel_values: {
          ...checkpoint.channel_values,
          messages: buildExternalMessagesReference(messages.length)
        }
      },
      messages,
      snapshot: {
        id: randomUUID(),
        parent_id: parent?.id ?? null,
        prefix_length: prefix,
        message_count: messages.length,
        depth: parent ? parent.depth + 1 : 1,
        total_bytes: (parent?.total_bytes ?? 0) + data.length,
        delta_bytes: parent ? parent.delta_bytes + data.length : 0,
        type,
        data
      }
    }
  }

  /** Parent identities are immutable, but a cancelled/replaced saver may have
   * collected an unreferenced parent while serialization yielded. Rebase outside
   * the transaction in that case; never publish a dangling dependency. */
  commit(
    thread: string,
    ns: string,
    checkpointId: string,
    prepared: PreparedBotMessages | null
  ): void {
    if (prepared) {
      const row = prepared.snapshot
      if (row.parent_id) {
        const parent = this.rows(
          "SELECT message_count,depth,total_bytes,delta_bytes FROM bot_graph_message_snapshots WHERE thread_id=? AND ns=? AND id=?",
          [thread, ns, row.parent_id]
        )[0]
        if (
          !parent ||
          Number(parent.message_count) < row.prefix_length ||
          Number(parent.depth) + 1 !== row.depth ||
          Number(parent.total_bytes) + row.data.length !== row.total_bytes ||
          Number(parent.delta_bytes) + row.data.length !== row.delta_bytes
        )
          throw new BotMessageParentUnavailable()
      }
      this.store.db.run("INSERT INTO bot_graph_message_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)", [
        thread,
        ns,
        row.id,
        row.parent_id,
        row.prefix_length,
        row.message_count,
        row.depth,
        row.total_bytes,
        row.delta_bytes,
        row.type,
        row.data
      ])
      this.store.db.run("INSERT OR REPLACE INTO bot_graph_message_heads VALUES(?,?,?,?)", [
        thread,
        ns,
        checkpointId,
        row.id
      ])
    } else {
      this.store.db.run(
        "DELETE FROM bot_graph_message_heads WHERE thread_id=? AND ns=? AND checkpoint_id=?",
        [thread, ns, checkpointId]
      )
    }
  }

  remember(ns: string, checkpointId: string, prepared: PreparedBotMessages | null): void {
    this.previous.delete(ns)
    if (!prepared || prepared.messages.length > 100_000) return
    // Copy references, not contents; in-place changes to the message array then
    // take the exact changed suffix path. LangGraph replaces message values.
    const { id, depth, total_bytes, delta_bytes } = prepared.snapshot
    const snapshot = { id, depth, total_bytes, delta_bytes }
    this.previous.set(ns, { checkpointId, messages: prepared.messages, snapshot })
    let references = [...this.previous.values()].reduce(
      (sum, state) => sum + state.messages.length,
      0
    )
    while (this.previous.size > 8 || references > 100_000) {
      const oldest = this.previous.keys().next().value!
      references -= this.previous.get(oldest)!.messages.length
      this.previous.delete(oldest)
    }
  }

  /** Capture every required row synchronously, before any asynchronous serde.
   * A concurrent put may prune DB rows later, but cannot alter this read's bytes. */
  capture(thread: string, ns: string, checkpointId: string): Snapshot[] | null {
    const head = this.rows(
      "SELECT snapshot_id FROM bot_graph_message_heads WHERE thread_id=? AND ns=? AND checkpoint_id=?",
      [thread, ns, checkpointId]
    )[0]
    if (!head) return null
    const result: Snapshot[] = [],
      visited = new Set<string>()
    let cursor: string | null = String(head.snapshot_id),
      bytes = 0
    while (cursor) {
      if (visited.has(cursor) || result.length >= MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH)
        throw corrupt()
      visited.add(cursor)
      const parsed = snapshotRow.safeParse(
        this.rows("SELECT * FROM bot_graph_message_snapshots WHERE thread_id=? AND ns=? AND id=?", [
          thread,
          ns,
          cursor
        ])[0]
      )
      if (!parsed.success) throw corrupt()
      const row = parsed.data
      bytes += row.data.length
      if (bytes > BOT_CHECKPOINT_BYTES) throw corrupt()
      result.push(row)
      cursor = row.parent_id
    }
    return result
  }

  /** JSONPlus stores suffix arrays as JSON. SQLite checks the complete delta
   * structure without copying or reviving the unrequested message bodies in JS.
   * JSON1 still scans each JSON block; this is not constant-byte random access.
   * The owner calls this synchronously inside its read/epoch transaction. */
  captureMessage(
    thread: string,
    ns: string,
    checkpointId: string,
    index: number
  ): CapturedBotMessage {
    const checkpoint = this.rows(
      `SELECT type, LENGTH(data) AS bytes,
       CASE WHEN type='json' AND json_valid(CAST(data AS TEXT))
        THEN json_type(CAST(data AS TEXT),'$.channel_values.messages') END AS kind,
       CASE WHEN type='json' AND json_valid(CAST(data AS TEXT))
        AND json_type(CAST(data AS TEXT),'$.channel_values.messages')='object'
        THEN substr(json_extract(CAST(data AS TEXT),'$.channel_values.messages'),1,1025) END AS reference
       FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? AND id=?`,
      [thread, ns, checkpointId]
    )[0]
    const head = this.rows(
      "SELECT snapshot_id FROM bot_graph_message_heads WHERE thread_id=? AND ns=? AND checkpoint_id=?",
      [thread, ns, checkpointId]
    )[0]
    if (
      checkpoint?.type !== "json" ||
      !z.number().int().min(0).max(BOT_CHECKPOINT_BYTES).safeParse(checkpoint.bytes).success
    )
      throw corrupt()
    if (checkpoint.kind === "array") {
      if (head) throw corrupt()
      const row = this.rows(
        `SELECT json_array_length(CAST(data AS TEXT),'$.channel_values.messages') AS total,
         json_type(CAST(data AS TEXT),?) AS kind,
         json_extract(CAST(data AS TEXT),?) AS message
         FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? AND id=?`,
        [
          `$.channel_values.messages[${index}]`,
          `$.channel_values.messages[${index}]`,
          thread,
          ns,
          checkpointId
        ]
      )[0]
      const total = z.number().int().min(0).max(MAX_MESSAGES).safeParse(row?.total)
      if (!total.success) throw corrupt()
      const totalMessages = total.data
      if (index >= totalMessages) return { totalMessages }
      if (row.kind !== "object" || typeof row.message !== "string") throw corrupt()
      return { totalMessages, json: row.message }
    }
    if (
      checkpoint.kind !== "object" ||
      typeof checkpoint.reference !== "string" ||
      checkpoint.reference.length > 1024
    )
      throw corrupt()
    let reference: unknown
    try {
      reference = JSON.parse(checkpoint.reference)
    } catch {
      throw corrupt()
    }
    if (!isExternalMessagesReference(reference) || !head) throw corrupt()
    const rows: z.infer<typeof messageIndexRow>[] = [],
      visited = new Set<string>()
    let cursor: string | null = String(head.snapshot_id),
      bytes = 0
    while (cursor) {
      if (visited.has(cursor) || rows.length >= MAX_CHECKPOINT_MESSAGE_SNAPSHOT_DEPTH)
        throw corrupt()
      visited.add(cursor)
      const parsed = messageIndexRow.safeParse(
        this.rows(
          `SELECT id,parent_id,prefix_length,message_count,depth,total_bytes,delta_bytes,type,
         LENGTH(data) AS bytes,
         CASE WHEN type='json' AND json_valid(CAST(data AS TEXT))
          THEN json_type(CAST(data AS TEXT)) END AS suffix_kind,
         CASE WHEN type='json' AND json_valid(CAST(data AS TEXT))
          THEN json_array_length(CAST(data AS TEXT)) END AS suffix_length
         FROM bot_graph_message_snapshots WHERE thread_id=? AND ns=? AND id=?`,
          [thread, ns, cursor]
        )[0]
      )
      if (!parsed.success) throw corrupt()
      bytes += parsed.data.bytes
      if (bytes > BOT_CHECKPOINT_BYTES) throw corrupt()
      rows.push(parsed.data)
      cursor = parsed.data.parent_id
    }
    let count = 0,
      totalBytes = 0,
      delta = 0,
      depth = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      totalBytes += row.bytes
      if (row.parent_id) delta += row.bytes
      depth++
      if (
        row.prefix_length > count ||
        (!row.parent_id && row.prefix_length !== 0) ||
        row.prefix_length + row.suffix_length !== row.message_count ||
        row.depth !== depth ||
        row.total_bytes !== totalBytes ||
        row.delta_bytes !== delta
      )
        throw corrupt()
      count = row.message_count
    }
    if (count !== reference.messageCount) throw corrupt()
    if (index >= count) return { totalMessages: count }
    const owner = rows.find((row) => index >= row.prefix_length)
    if (!owner || index >= owner.message_count) throw corrupt()
    const position = `$[${index - owner.prefix_length}]`
    const selected = this.rows(
      `SELECT json_type(CAST(data AS TEXT),?) AS kind,
       json_extract(CAST(data AS TEXT),?) AS message FROM bot_graph_message_snapshots
       WHERE thread_id=? AND ns=? AND id=?`,
      [position, position, thread, ns, owner.id]
    )[0]
    if (selected?.kind !== "object" || typeof selected.message !== "string") throw corrupt()
    return { totalMessages: count, json: selected.message }
  }

  async hydrate(checkpoint: Checkpoint, rows: Snapshot[] | null): Promise<Checkpoint> {
    const reference = checkpoint.channel_values.messages
    if (!isExternalMessagesReference(reference)) {
      if (rows) throw corrupt()
      return checkpoint // Existing inline checkpoints remain readable without migration.
    }
    if (!rows?.length) throw corrupt()
    const chunks: CheckpointMessageChunk[] = []
    let count = 0,
      bytes = 0,
      delta = 0,
      depth = 0
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      const suffix = await this.serde.loadsTyped(row.type, row.data)
      depth++
      bytes += row.data.length
      if (row.parent_id) delta += row.data.length
      if (
        !Array.isArray(suffix) ||
        row.prefix_length > count ||
        (!row.parent_id && row.prefix_length !== 0) ||
        row.prefix_length + suffix.length !== row.message_count ||
        row.depth !== depth ||
        row.total_bytes !== bytes ||
        row.delta_bytes !== delta
      )
        throw corrupt()
      truncateCheckpointMessageChunks(chunks, count, row.prefix_length)
      if (suffix.length) chunks.push({ messages: suffix, start: 0, end: suffix.length })
      count = row.message_count
    }
    if (count !== reference.messageCount) throw corrupt()
    return {
      ...checkpoint,
      channel_values: {
        ...checkpoint.channel_values,
        messages: materializeCheckpointMessageChunks(chunks, count)
      }
    }
  }

  prune(thread: string, ns: string): void {
    // Graph pruning removes heads, never ancestors directly. Reachability uses
    // immutable message IDs; rebasing/replacing a head cannot mutate older deltas.
    const candidates = this.rows(
      `WITH RECURSIVE reachable(id) AS (
      SELECT snapshot_id FROM bot_graph_message_heads WHERE thread_id=? AND ns=?
      UNION SELECT s.parent_id FROM bot_graph_message_snapshots s JOIN reachable r ON s.id=r.id
        WHERE s.thread_id=? AND s.ns=? AND s.parent_id IS NOT NULL
    ) SELECT id,LENGTH(data) AS bytes FROM bot_graph_message_snapshots
      WHERE thread_id=? AND ns=? AND id NOT IN (SELECT id FROM reachable)
      ORDER BY rowid LIMIT 64`,
      [thread, ns, thread, ns, thread, ns]
    )
    const obsolete: string[] = []
    let bytes = 0
    for (const row of candidates) {
      if (obsolete.length && bytes + Number(row.bytes) > 16 * 1024 * 1024) break
      obsolete.push(String(row.id))
      bytes += Number(row.bytes)
    }
    if (obsolete.length)
      this.store.db.run(
        `DELETE FROM bot_graph_message_snapshots WHERE thread_id=? AND ns=? AND id IN (${obsolete.map(() => "?").join(",")})`,
        [thread, ns, ...obsolete]
      )
  }
}
