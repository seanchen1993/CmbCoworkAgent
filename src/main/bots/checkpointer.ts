import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type PendingWrite
} from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { BaseMessage } from "@langchain/core/messages"
import type { BotRunLease } from "../../shared/bot-types"
import { BotDomainError } from "../../shared/bot-types"
import { BotStore } from "./store"
import { z } from "zod"
import {
  BOT_CHECKPOINT_BYTES,
  BotCheckpointMessages,
  BotMessageParentUnavailable
} from "./checkpoint-messages"
import {
  acquireBotCheckpointWrite,
  pendingBotCheckpointResults,
  pinBotCheckpointResults
} from "./checkpoint-queue"

const CHECKPOINT_BYTES = BOT_CHECKPOINT_BYTES
const CHECKPOINT_WRITE_COUNT = 4096
const RECENT_CHECKPOINTS = 4
const CHECKPOINT_CLEANUP_BATCH = 64
const CHECKPOINT_CLEANUP_BYTES = 32 * 1024 * 1024

const checkpointRow = z.object({
  id: z.string(),
  type: z.string(),
  data: z.instanceof(Uint8Array),
  metadata_type: z.string(),
  metadata: z.instanceof(Uint8Array),
  parent_id: z.string().nullable()
})
const writeRow = z.object({
  task_id: z.string(),
  channel: z.string(),
  type: z.string(),
  data: z.instanceof(Uint8Array)
})

/** Serialized outside the transaction; graph checkpoint, run pointer and event committed together. */
export class BotCheckpointSaver extends BaseCheckpointSaver {
  private readonly messages: BotCheckpointMessages
  constructor(
    private readonly store: BotStore,
    private readonly lease: BotRunLease,
    private readonly threadId: string
  ) {
    super()
    this.messages = new BotCheckpointMessages(store, this.serde)
  }
  private scope(config: RunnableConfig): { thread: string; ns: string; id?: string } {
    const thread = config.configurable?.thread_id
    const ns = config.configurable?.checkpoint_ns ?? ""
    const id = config.configurable?.checkpoint_id
    if (
      thread !== this.threadId ||
      typeof ns !== "string" ||
      ns.length > 4096 ||
      (id !== undefined && typeof id !== "string")
    ) {
      throw new BotDomainError("checkpoint_scope", "检查点不属于当前 Bot 对话")
    }
    return { thread, ns, id }
  }
  private rows(sql: string, params: unknown[]): Record<string, unknown>[] {
    const statement = this.store.db.prepare(sql, params),
      rows: Record<string, unknown>[] = []
    try {
      while (statement.step()) rows.push(statement.getAsObject())
    } finally {
      statement.free()
    }
    return rows
  }

  /** Like Cmb's SqlJsSaver retention, select and delete under the same writer
   * transaction. Message ancestors are retained through their surviving heads;
   * chat/effect history is separate from graph retention.
   * Keep recent states, the new head/parent, and any result still being serialized.
   * Batch legacy cleanup so a long existing task does not monopolize the Host. */
  private prune(thread: string, ns: string, id: string, parent?: string): void {
    const recent = this.rows(
      "SELECT id FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? ORDER BY id DESC LIMIT ?",
      [thread, ns, RECENT_CHECKPOINTS]
    ).map((row) => String(row.id))
    const keep = new Set(recent)
    keep.add(id)
    if (parent) keep.add(parent)
    for (const pending of pendingBotCheckpointResults(this.store, thread, ns)) keep.add(pending)
    const protectedIds = [...keep],
      protectedParameters = protectedIds.map(() => "?").join(",")
    // A result may commit before its asynchronous graph put. If the process
    // stops in that gap, no graph row exists to drive the usual retention.
    // Match assertWriteTarget: an unpublished ID is retired only when a higher
    // graph identity exists. Future IDs, the original parent and in-flight
    // serializers remain protected. Bound write identities before the existence
    // check so legacy non-orphan history cannot make that check scan every write.
    // Both candidate sets share one cleanup budget.
    const candidates = this.rows(
      `WITH retired_graphs AS (
       SELECT c.id, LENGTH(c.data) + LENGTH(c.metadata) + COALESCE((
         SELECT SUM(LENGTH(w.data) + LENGTH(CAST(w.channel AS BLOB))) FROM bot_graph_writes w
         WHERE w.thread_id=c.thread_id AND w.ns=c.ns AND w.checkpoint_id=c.id
       ), 0) AS bytes FROM bot_graph_checkpoints c WHERE c.thread_id=? AND c.ns=?
       AND c.id NOT IN (${protectedParameters}) ORDER BY c.id LIMIT ?
      ), write_ids AS (
       SELECT DISTINCT w.checkpoint_id AS id FROM bot_graph_writes w
       WHERE w.thread_id=? AND w.ns=? AND w.checkpoint_id<?
       AND w.checkpoint_id NOT IN (${protectedParameters})
       ORDER BY w.checkpoint_id LIMIT ?
      ), orphan_ids AS (
       SELECT w.id FROM write_ids w WHERE NOT EXISTS(SELECT 1 FROM bot_graph_checkpoints c
         WHERE c.thread_id=? AND c.ns=? AND c.id=w.id)
      ) SELECT id,bytes FROM retired_graphs
      UNION ALL SELECT o.id,COALESCE((
       SELECT SUM(LENGTH(w.data) + LENGTH(CAST(w.channel AS BLOB))) FROM bot_graph_writes w
       WHERE w.thread_id=? AND w.ns=? AND w.checkpoint_id=o.id
      ),0) AS bytes FROM orphan_ids o ORDER BY id LIMIT ?`,
      [
        thread,
        ns,
        ...protectedIds,
        CHECKPOINT_CLEANUP_BATCH,
        thread,
        ns,
        recent[0],
        ...protectedIds,
        CHECKPOINT_CLEANUP_BATCH,
        thread,
        ns,
        thread,
        ns,
        CHECKPOINT_CLEANUP_BATCH
      ]
    )
    const obsolete: string[] = []
    let bytes = 0
    for (const row of candidates) {
      const size = Number(row.bytes)
      // Count blobs in SQLite without copying them into the Host. A single old
      // checkpoint can exceed the batch budget; allow one so cleanup progresses.
      if (obsolete.length && bytes + size > CHECKPOINT_CLEANUP_BYTES) break
      obsolete.push(String(row.id))
      bytes += size
    }
    if (obsolete.length) {
      const placeholders = obsolete.map(() => "?").join(",")
      const parameters = [thread, ns, ...obsolete]
      this.store.db.run(
        `DELETE FROM bot_graph_message_heads WHERE thread_id=? AND ns=? AND checkpoint_id IN (${placeholders})`,
        parameters
      )
      this.store.db.run(
        `DELETE FROM bot_graph_writes WHERE thread_id=? AND ns=? AND checkpoint_id IN (${placeholders})`,
        parameters
      )
      this.store.db.run(
        `DELETE FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? AND id IN (${placeholders})`,
        parameters
      )
    }
    this.messages.prune(thread, ns)
  }

  private assertWriteTarget(thread: string, ns: string, id: string): void {
    // LangGraph can dispatch writes before its corresponding asynchronous put.
    // Such a new, monotonically ordered identity is allowed. A retired older
    // identity must not recreate orphan results after retention has removed it.
    const next = this.rows(
      "SELECT id FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? AND id>=? ORDER BY id LIMIT 1",
      [thread, ns, id]
    )[0]
    if (next && next.id !== id)
      throw new BotDomainError("checkpoint_unavailable", "检查点已过期，不能继续写入旧任务结果")
  }
  /** Task-history-only projection. Full graph restoration still uses getTuple.
   * Pin the last committed head/bytes before async serde and never decode state,
   * metadata, pending writes or the other message instances. No read cache. */
  async getMessage(
    config: RunnableConfig,
    index: number
  ): Promise<
    | {
        totalMessages: number
        source?: BaseMessage
      }
    | undefined
  > {
    const { thread, ns, id } = this.scope(config)
    z.number().int().min(0).max(1_000_000).parse(index)
    const captured = this.store.transaction(() => {
      const run = this.store.assertDispatch(this.lease)
      if (run.id !== thread) throw new BotDomainError("checkpoint_scope", "消息记录不属于当前任务")
      const epoch = this.store.dataEpoch()
      const head = this.rows(
        `SELECT id FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? ${id ? "AND id=?" : ""} ORDER BY id DESC LIMIT 1`,
        id ? [thread, ns, id] : [thread, ns]
      )[0]
      const value = head ? this.messages.captureMessage(thread, ns, String(head.id), index) : null
      this.store.assertDispatch(this.lease)
      this.store.assertMutationEpoch(epoch)
      return { epoch, value }
    })
    const source =
      captured.value?.json === undefined
        ? undefined
        : await this.serde.loadsTyped("json", captured.value.json)
    return this.store.transaction(() => {
      this.store.assertDispatch(this.lease)
      this.store.assertMutationEpoch(captured.epoch)
      if (!captured.value) return undefined
      if (captured.value.json !== undefined && !BaseMessage.isInstance(source))
        throw new BotDomainError("task_history_unavailable", "当前任务消息尚不可读，请稍后重试")
      return {
        totalMessages: captured.value.totalMessages,
        ...(source === undefined ? {} : { source: source as BaseMessage })
      }
    })
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread, ns, id } = this.scope(config)
    const raw = this.rows(
      `SELECT * FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? ${id ? "AND id=?" : ""} ORDER BY id DESC LIMIT 1`,
      id ? [thread, ns, id] : [thread, ns]
    )[0]
    if (!raw) return undefined
    const row = checkpointRow.parse(raw)
    const writes = this.rows(
      "SELECT * FROM bot_graph_writes WHERE thread_id=? AND ns=? AND checkpoint_id=? ORDER BY task_id,idx",
      [thread, ns, row.id]
    ).map((row) => writeRow.parse(row))
    const messageSnapshot = this.messages.capture(thread, ns, row.id)
    return {
      config: { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: row.id } },
      checkpoint: await this.messages.hydrate(
        (await this.serde.loadsTyped(row.type, row.data)) as Checkpoint,
        messageSnapshot
      ),
      metadata: (await this.serde.loadsTyped(
        row.metadata_type,
        row.metadata
      )) as CheckpointMetadata,
      ...(row.parent_id
        ? {
            parentConfig: {
              configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: row.parent_id }
            }
          }
        : {}),
      pendingWrites: await Promise.all(
        writes.map(
          async (write) =>
            [write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.data)] as [
              string,
              string,
              unknown
            ]
        )
      )
    }
  }
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { thread, ns } = this.scope(config)
    const before = options?.before?.configurable?.checkpoint_id ?? "\uffff"
    const limit = Math.min(Math.max(options?.limit ?? 100, 0), 1000)
    const rows = this.rows(
      "SELECT id FROM bot_graph_checkpoints WHERE thread_id=? AND ns=? AND id<? ORDER BY id DESC LIMIT ?",
      [thread, ns, before, limit]
    )
    for (const row of rows) {
      const tuple = await this.getTuple({
        configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: row.id }
      })
      if (
        tuple &&
        (!options?.filter ||
          Object.entries(options.filter).every(
            ([key, value]) => JSON.stringify(tuple.metadata?.[key]) === JSON.stringify(value)
          ))
      )
        yield tuple
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const { thread, ns } = this.scope(config)
    const release = await acquireBotCheckpointWrite(this.store, thread, ns)
    try {
      return await this.putUnlocked(config, checkpoint, metadata)
    } finally {
      release()
    }
  }

  private async putUnlocked(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const { thread, ns, id } = this.scope(config)
    this.store.assertLease(this.lease, true)
    let prepared = await this.messages.prepare(ns, id, checkpoint)
    // Every retry must use the same captured message sequence as the graph's
    // external-message marker, even if the caller reuses its array while serde yields.
    const captured = prepared
      ? {
          ...prepared.checkpoint,
          channel_values: { ...prepared.checkpoint.channel_values, messages: prepared.messages }
        }
      : checkpoint
    this.store.assertLease(this.lease, true)
    const [type, data] = await this.serde.dumpsTyped(prepared?.checkpoint ?? checkpoint)
    this.store.assertLease(this.lease, true)
    if (
      prepared?.snapshot.parent_id &&
      data.length + prepared.snapshot.total_bytes > CHECKPOINT_BYTES
    ) {
      prepared = await this.messages.prepare(ns, id, captured, true)
      this.store.assertLease(this.lease, true)
    }
    const checkSize = () => {
      if (data.length + (prepared?.snapshot.total_bytes ?? 0) > CHECKPOINT_BYTES)
        throw new BotDomainError("checkpoint_size", "检查点超出大小限制")
    }
    checkSize()
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata)
    if (metadataBytes.length > CHECKPOINT_BYTES)
      throw new BotDomainError("checkpoint_size", "检查点超出大小限制")
    for (;;) {
      try {
        this.store.transaction(() => {
          this.store.assertLease(this.lease, true)
          this.messages.commit(thread, ns, checkpoint.id, prepared)
          this.store.db.run(
            "INSERT OR REPLACE INTO bot_graph_checkpoints VALUES(?,?,?,?,?,?,?,?)",
            [thread, ns, checkpoint.id, id ?? null, type, data, metadataType, metadataBytes]
          )
          this.store.db.run(
            "UPDATE bot_runs SET checkpoint=?,revision=revision+1,updated_at=? WHERE id=?",
            [JSON.stringify({ thread, ns, id: checkpoint.id }), this.store.now(), this.lease.runId]
          )
          this.store.db.run(
            "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('run.checkpoint',?,?,?)",
            [this.lease.runId, JSON.stringify({ checkpointId: checkpoint.id }), this.store.now()]
          )
          this.prune(thread, ns, checkpoint.id, id)
        })
        break
      } catch (error) {
        if (!(error instanceof BotMessageParentUnavailable)) throw error
        prepared = await this.messages.prepare(ns, id, captured, true)
        this.store.assertLease(this.lease, true)
        checkSize()
      }
    }
    this.messages.remember(ns, checkpoint.id, prepared)
    return { configurable: { thread_id: thread, checkpoint_ns: ns, checkpoint_id: checkpoint.id } }
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread, ns, id } = this.scope(config)
    if (!id) throw new BotDomainError("checkpoint_scope", "缺少检查点 ID")
    this.store.assertLease(this.lease, true)
    this.assertWriteTarget(thread, ns, id)
    if (writes.length > CHECKPOINT_WRITE_COUNT)
      throw new BotDomainError("checkpoint_size", "检查点工具结果超出大小限制")
    const release = pinBotCheckpointResults(this.store, thread, ns, id)
    try {
      const encoded: { index: number; channel: string; type: string; data: Uint8Array }[] = []
      let bytes = 0
      // Do not allocate every serialized tool result concurrently. Stop at the
      // first excess or cancellation, before any part of this batch is persisted.
      for (const [index, [channel, value]] of writes.entries()) {
        const [type, data] = await this.serde.dumpsTyped(value)
        this.store.assertLease(this.lease, true)
        bytes += data.length + Buffer.byteLength(channel)
        if (bytes > CHECKPOINT_BYTES)
          throw new BotDomainError("checkpoint_size", "检查点工具结果超出大小限制")
        encoded.push({ index: WRITES_IDX_MAP[channel] ?? index, channel, type, data })
      }
      this.store.transaction(() => {
        this.store.assertLease(this.lease, true)
        this.assertWriteTarget(thread, ns, id)
        for (const write of encoded)
          this.store.db.run(
            `INSERT ${write.index < 0 ? "OR REPLACE" : "OR IGNORE"} INTO bot_graph_writes VALUES(?,?,?,?,?,?,?,?)`,
            [thread, ns, id, taskId, write.index, write.channel, write.type, write.data]
          )
        // Different tool tasks can contribute to the same checkpoint. Measure
        // the stored result inside the transaction so retries retain LangGraph's
        // IGNORE/REPLACE semantics and an excess rolls back the entire batch.
        const total = this.rows(
          `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(data) + LENGTH(CAST(channel AS BLOB))),0) AS bytes
         FROM bot_graph_writes WHERE thread_id=? AND ns=? AND checkpoint_id=?`,
          [thread, ns, id]
        )[0]
        if (Number(total.count) > CHECKPOINT_WRITE_COUNT || Number(total.bytes) > CHECKPOINT_BYTES)
          throw new BotDomainError("checkpoint_size", "检查点工具结果超出大小限制")
      })
    } finally {
      release()
    }
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.threadId)
      throw new BotDomainError("checkpoint_scope", "检查点不属于当前 Bot 对话")
    throw new BotDomainError("checkpoint_delete_denied", "运行中的 Agent 不能删除持久检查点")
  }
}
