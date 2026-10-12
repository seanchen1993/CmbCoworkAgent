import { createHash } from "node:crypto"
import { BotDomainError, type BotRoutine } from "../../shared/bot-types"
import {
  botEventVersion,
  type BotEventVersion,
  type BotEventReceipt
} from "../../shared/bot-event-state"
import type { BotStore } from "./store"

const active = "('queued','running','waiting_input','cancelling','needs_review')"
/** The root binding covers peer and workflow descendants, including other Bots.
 * A newer entity version cannot overtake an unfinished/unknown earlier effect. */
export const BOT_EVENT_CLAIM_FENCE = `NOT EXISTS(
 SELECT 1 FROM bot_event_versions current
 WHERE current.run_id=r.root_run_id AND (
  EXISTS(SELECT 1 FROM bot_runs old INDEXED BY bot_event_active_runs
   CROSS JOIN bot_event_versions previous ON previous.run_id=old.root_run_id
   WHERE old.status IN ${active} AND previous.routine_id=current.routine_id
    AND previous.entity_key=current.entity_key AND previous.run_id<>current.run_id)
  OR EXISTS(SELECT 1 FROM bot_effects e INDEXED BY bot_event_unresolved_effects
   CROSS JOIN bot_runs old ON old.id=e.run_id
   CROSS JOIN bot_event_versions previous ON previous.run_id=old.root_run_id
   WHERE e.status IN ('started','unknown') AND previous.routine_id=current.routine_id
    AND previous.entity_key=current.entity_key AND previous.run_id<>current.run_id)))`

/** The caller owns the existing acceptance transaction and request receipt.
 * This fence stops new dispatch, not receipt settlement or external reconciliation. */
export class BotEventStates {
  constructor(
    private readonly store: BotStore,
    private readonly cancelRun: (id: string) => unknown,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  accept(
    routine: BotRoutine,
    rawVersion: BotEventVersion | undefined,
    payload: string,
    dispatch: () => string
  ): BotEventReceipt {
    const policy = routine.schedule.kind === "event" ? routine.schedule.eventPolicy : undefined
    if (!policy) {
      return { runIds: [dispatch()] }
    }
    const parsed = botEventVersion.safeParse(rawVersion)
    if (!parsed.success)
      throw new BotDomainError("invalid_input", "最新状态事件缺少有效对象、序号或来源批次")
    const version = parsed.data
    if (version.sourceEpoch !== policy.sourceEpoch)
      throw new BotDomainError("event_epoch", "事件来源批次与例程配置不一致")
    const identity = [routine.id, version.sourceEpoch, version.entityKey, version.sequence]
    const contentHash = createHash("sha256").update(payload).digest("hex")
    const prior = this.store.db.exec(
      "SELECT content_hash,run_id FROM bot_event_versions WHERE routine_id=? AND source_epoch=? AND entity_key=? AND sequence=?",
      identity
    )[0]?.values[0]
    if (prior) {
      if (prior[0] !== contentHash)
        throw new BotDomainError("event_version_conflict", "相同来源版本包含不同内容，事件未接收")
      return {
        runIds: prior[1] ? [String(prior[1])] : [],
        disposition: prior[1] ? "duplicate" : "stale",
        sourceVersion: version
      }
    }
    // Bound durable version identities without deleting a fence or silently
    // forgetting a previously acknowledged conflict. Existing replays still work.
    const count = this.store.db.exec("SELECT COUNT(*) FROM bot_event_versions WHERE routine_id=?", [
      routine.id
    ])[0]?.values[0]?.[0]
    if (Number(count) >= 100_000)
      throw new BotDomainError("event_capacity", "此例程的事件版本记录已达上限，请建立新的事件例程")
    const head = this.store.db.exec(
      "SELECT sequence FROM bot_event_heads WHERE routine_id=? AND source_epoch=? AND entity_key=?",
      identity.slice(0, 3)
    )[0]?.values[0]?.[0]
    const stale = head !== undefined && version.sequence < Number(head)
    const runId = stale ? null : dispatch()
    this.store.db.run("INSERT INTO bot_event_versions VALUES(?,?,?,?,?,?)", [
      ...identity,
      contentHash,
      runId
    ])
    if (!stale) {
      this.store.db.run(
        `INSERT INTO bot_event_heads VALUES(?,?,?,?) ON CONFLICT(routine_id,source_epoch,entity_key)
         DO UPDATE SET sequence=excluded.sequence`,
        identity
      )
      this.drain(routine.id, version.entityKey, runId!)
    }
    this.event(stale ? "webhook.stale" : "webhook.version_accepted", routine.id, {
      botId: routine.botId,
      runId,
      sourceVersion: version
    })
    return {
      runIds: runId ? [runId] : [],
      disposition: stale ? "stale" : "queued",
      sourceVersion: version
    }
  }

  /** Configuration changes cannot revive previously admitted source versions. */
  beforeRoutineMutation(
    previous: BotRoutine,
    next?: BotRoutine["schedule"],
    enabled = false
  ): void {
    if (previous.schedule.kind !== "event" || !previous.schedule.eventPolicy) return
    if (enabled && JSON.stringify(previous.schedule) === JSON.stringify(next)) return
    if (enabled && (next?.kind !== "event" || !next.eventPolicy)) {
      const unresolved = this.store.db.exec(
        `SELECT 1 FROM bot_effects e INDEXED BY bot_event_unresolved_effects
         CROSS JOIN bot_runs r ON r.id=e.run_id
         CROSS JOIN bot_event_versions v ON v.run_id=r.root_run_id
         WHERE e.status IN ('started','unknown') AND v.routine_id=? LIMIT 1`,
        [previous.id]
      )[0]?.values.length
      if (unresolved)
        throw new BotDomainError(
          "invalid_input",
          "旧状态仍有进行中或结果未知的操作，请核对后再退出最新状态模式"
        )
    }
    this.drain(previous.id)
  }

  private drain(routineId: string, entityKey?: string, exceptRunId?: string): void {
    const rows =
      this.store.db.exec(
        `SELECT r.id,r.status FROM bot_runs r INDEXED BY bot_event_active_runs
       CROSS JOIN bot_event_versions v ON v.run_id=r.root_run_id
       WHERE v.routine_id=? ${entityKey === undefined ? "" : "AND v.entity_key=?"}
       ${exceptRunId ? "AND v.run_id<>?" : ""} AND r.status IN ${active}
       ORDER BY r.depth,r.id`,
        [
          routineId,
          ...(entityKey === undefined ? [] : [entityKey]),
          ...(exceptRunId ? [exceptRunId] : [])
        ]
      )[0]?.values ?? []
    for (const [rawId, status] of rows) {
      const id = String(rawId)
      const reason = "事件状态已有更新，停止旧版本的新操作；已开始的操作仍须核对结果"
      this.store.db.run("INSERT OR IGNORE INTO bot_run_drains VALUES(?,?,?)", [
        id,
        reason,
        this.store.now()
      ])
      if (status !== "needs_review") this.cancelRun(id)
      this.event("run.draining", id, { reason })
    }
  }

  assertCurrent(runId: string): void {
    const row = this.store.db.exec(
      `SELECT v.source_epoch,v.entity_key,v.sequence AS run_sequence,h.sequence AS head_sequence,r.schedule,r.enabled
       FROM bot_runs origin JOIN bot_event_versions v ON v.run_id=origin.root_run_id
       LEFT JOIN bot_event_heads h ON h.routine_id=v.routine_id AND h.source_epoch=v.source_epoch AND h.entity_key=v.entity_key
       LEFT JOIN bot_routines r ON r.id=v.routine_id WHERE origin.id=?`,
      [runId]
    )[0]?.values[0]
    if (!row) return
    const schedule = row[4] === null ? null : JSON.parse(String(row[4]))
    if (
      !row[5] ||
      schedule?.kind !== "event" ||
      schedule.eventPolicy?.mode !== "latest-state" ||
      schedule.eventPolicy.sourceEpoch !== row[0] ||
      row[2] !== row[3]
    )
      throw new BotDomainError(
        "run_superseded",
        "事件来源版本已过期，禁止继续操作；已发出的操作仍须核对"
      )
    if (
      !this.store.db.exec(`SELECT 1 FROM bot_runs r WHERE r.id=? AND ${BOT_EVENT_CLAIM_FENCE}`, [
        runId
      ])[0]?.values.length
    )
      throw new BotDomainError("effect_requires_review", "同一对象的先前事件仍在执行或结果待核对")
  }

  /** For version-aware target adapters. This durable identity is inherited by
   * owned descendants; callers must still check authority at final dispatch. */
  versionForRun(runId: string): BotEventVersion | null {
    const row = this.store.db.exec(
      `SELECT v.entity_key,v.source_epoch,v.sequence FROM bot_runs r
       JOIN bot_event_versions v ON v.run_id=r.root_run_id WHERE r.id=?`,
      [runId]
    )[0]?.values[0]
    return row
      ? botEventVersion.parse({ entityKey: row[0], sourceEpoch: row[1], sequence: row[2] })
      : null
  }
}
