import { createHash } from "node:crypto"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { CoworkEvent, EventReportResult } from "../services/event-reporter"
import { BOT_EVENTS, BOT_METRICS_VERSION } from "../../shared/bots/telemetry"

export type BotTelemetryContext = Omit<
  CoworkEvent,
  "eventId" | "eventName" | "eventCategory" | "eventTime" | "properties"
>

/** Committed control-state facts, including bulk recovery and injected turns. TEMP triggers
 * disappear on close, so opening the same local database with an older App remains safe. */
export class BotTelemetryStore {
  constructor(
    private readonly db: NativeSqliteAdapter,
    context: () => BotTelemetryContext
  ) {
    db.registerFunction("bot_telemetry_context", () => {
      try {
        return JSON.stringify(context())
      } catch {
        return JSON.stringify({ userName: "unknown", userIp: "" })
      }
    })
    db.run(`CREATE TABLE IF NOT EXISTS bot_telemetry_outbox (
      id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_time INTEGER NOT NULL,
      context_json TEXT, properties_json TEXT, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS bot_telemetry_due ON bot_telemetry_outbox(state,next_attempt_at,event_time,id);`)
    const source = "json_extract(NEW.mock_source_json,'$.transport')"
    const origin = "json_extract(NEW.origin_json,'$.kind')"
    const channel = `CASE WHEN NEW.mock_source_json IS NOT NULL AND COALESCE(${source},'')!='im' THEN 'simulation'
      WHEN ${source}='im' THEN CASE WHEN json_extract(NEW.mock_source_json,'$.personal')=1 THEN 'zhaohu_private' ELSE 'zhaohu_group' END
      WHEN json_extract(NEW.origin_json,'$.groupId') IS NOT NULL THEN 'app_group' ELSE 'app_private' END`
    const runKind = `CASE WHEN ${origin} IN ('notification','work_result') THEN 'notification'
      WHEN ${origin}='bot' THEN 'collaboration' WHEN ${origin}='introduction' THEN 'introduction'
      WHEN ${origin}='schedule' THEN 'schedule' WHEN NEW.work_id IS NOT NULL THEN 'work' ELSE 'chat' END`
    const taskProps = `'botId',NEW.bot_id,'botTaskId',NEW.id,'botWorkId',NEW.work_id,
      'botChannel',${channel},'botRunKind',${runKind}`
    this.trigger(
      "created",
      "INSERT",
      "bots",
      "1",
      BOT_EVENTS.created,
      "NEW.id",
      "NEW.created_at",
      "'botId',NEW.id"
    )
    this.trigger(
      "started",
      "UPDATE OF state",
      "bot_tasks",
      "OLD.state='queued' AND NEW.state='running'",
      BOT_EVENTS.started,
      "NEW.id",
      "NEW.updated_at",
      taskProps
    )
    this.trigger(
      "ended",
      "UPDATE OF state",
      "bot_tasks",
      "OLD.state IN ('queued','running','waiting_user') AND NEW.state IN ('completed','failed','cancelled','interrupted','superseded','outcome_unknown')",
      BOT_EVENTS.ended,
      "NEW.id",
      "NEW.updated_at",
      `${taskProps},'botOutcome',NEW.state,'botDurationMs',MAX(0,NEW.updated_at-NEW.created_at)`
    )
    const workProps =
      "'botId',NEW.bot_id,'botWorkId',NEW.id,'botSimulation',CASE WHEN NEW.source_json IS NOT NULL AND COALESCE(json_extract(NEW.source_json,'$.transport'),'')!='im' THEN 1 ELSE 0 END"
    this.trigger(
      "work_created",
      "INSERT",
      "bot_work_items",
      "1",
      BOT_EVENTS.workCreated,
      "NEW.id",
      "NEW.created_at",
      workProps
    )
    for (const [suffix, state, event] of [
      ["work_completed", "completed", BOT_EVENTS.workCompleted],
      ["work_reopened", "active", BOT_EVENTS.workReopened]
    ])
      this.trigger(
        suffix,
        "UPDATE OF state",
        "bot_work_items",
        `OLD.state!=NEW.state AND NEW.state='${state}'`,
        event,
        "NEW.id||':'||NEW.version",
        "NEW.updated_at",
        workProps
      )
    const bindingProps =
      "'botId',NEW.bot_id,'botBindingId',NEW.id,'botChannel',CASE WHEN json_extract(NEW.binding_json,'$.kind')='group' THEN 'zhaohu_group' ELSE 'zhaohu_private' END"
    const time = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)"
    this.trigger(
      "connected_insert",
      "INSERT",
      "bot_im_routes",
      "json_extract(NEW.binding_json,'$.state')='active'",
      BOT_EVENTS.connected,
      "NEW.id",
      time,
      bindingProps
    )
    for (const [suffix, state, event] of [
      ["connected_update", "active", BOT_EVENTS.connected],
      ["revoked", "revoked", BOT_EVENTS.revoked]
    ])
      this.trigger(
        suffix,
        "UPDATE OF binding_json",
        "bot_im_routes",
        `json_extract(OLD.binding_json,'$.state')!=json_extract(NEW.binding_json,'$.state') AND json_extract(NEW.binding_json,'$.state')='${state}'`,
        event,
        "NEW.id",
        time,
        bindingProps
      )
    // IM batches are split into one durable delivery per file before sending. Observe
    // only the platform's final receipt, never upload acceptance or local card creation.
    // The stable wire identity deduplicates retries, reconnects and legacy batch splitting.
    this.trigger(
      "attachment_sent",
      "UPDATE OF state",
      "bot_im_outbox",
      "OLD.state!='sent' AND NEW.state='sent' AND NEW.file_delivery_id IS NOT NULL",
      BOT_EVENTS.attachmentSent,
      "NEW.file_delivery_id",
      time,
      "'botId',NEW.bot_id,'botTaskId',NEW.source_task_id,'botWorkId',NEW.work_id," +
        "'botChannel',(SELECT CASE WHEN kind='group' THEN 'zhaohu_group' ELSE 'zhaohu_private' END FROM bot_im_bindings WHERE id=NEW.binding_id)"
    )
  }

  private trigger(
    name: string,
    action: string,
    table: string,
    when: string,
    event: string,
    id: string,
    time: string,
    properties: string
  ) {
    this.db
      .run(`CREATE TEMP TRIGGER IF NOT EXISTS bot_metrics_v1_${name} AFTER ${action} ON ${table} WHEN ${when}
      BEGIN INSERT OR IGNORE INTO bot_telemetry_outbox(id,event_name,event_time,context_json,properties_json)
      VALUES('${event}:'||${id},'${event}',${time},bot_telemetry_context(),json_object('botMetricsVersion',${BOT_METRICS_VERSION},${properties})); END;`)
  }

  due(now: number, limit = 20): { id: string; event: CoworkEvent; attempts: number }[] {
    const query = this.db.prepare(
      "SELECT * FROM bot_telemetry_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,event_time,id LIMIT ?",
      [now, Math.min(20, Math.max(1, limit))]
    )
    const rows: { id: string; event: CoworkEvent; attempts: number }[] = []
    try {
      while (query.step()) {
        const row = query.getAsObject(),
          id = String(row.id)
        rows.push({
          id,
          attempts: Number(row.attempts),
          event: {
            ...JSON.parse(String(row.context_json)),
            eventId: createHash("sha256").update(id).digest("hex"),
            eventName: String(row.event_name),
            eventCategory: "bot",
            eventTime: new Date(Number(row.event_time)).toISOString(),
            properties: JSON.parse(String(row.properties_json))
          }
        })
      }
      return rows
    } finally {
      query.free()
    }
  }

  settle(id: string, result: EventReportResult, attempts: number, now: number): number {
    if (result.ok || !result.retryable) {
      // Keep the small receipt for idempotency; erase user metadata after delivery.
      this.db.run(
        "UPDATE bot_telemetry_outbox SET state=?,context_json=NULL,properties_json=NULL WHERE id=?",
        [result.ok ? "sent" : "rejected", id]
      )
      return 0
    } else {
      const delay = Math.max(
        result.retryAfterMs ?? 0,
        Math.min(300000, 1000 * 2 ** Math.min(attempts, 8))
      )
      this.db.run(
        "UPDATE bot_telemetry_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?",
        [now + delay, id]
      )
      return delay
    }
  }
}
