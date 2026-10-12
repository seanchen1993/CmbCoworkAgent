import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  botWebhookAddress,
  botWebhookChange,
  type BotWebhookState,
  type BotWebhookChanged
} from "../../shared/bot-webhooks"
import { BotDomainError, type BotRoutine } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { identifier, text } from "./validation"
import { inboundDeliveryClientNonce } from "./upstream/rakazo-webhook"
import { BotEventStates } from "./event-state"
import type { BotEventReceipt, BotEventVersion } from "../../shared/bot-event-state"

export interface BotWebhookCredential {
  routineId: string
  revision: number
  digest: string
}
type Receipt = <T>(nonce: string, input: unknown, operation: () => T) => T
const active = "('queued','running','waiting_input','cancelling','needs_review')"
const hash = (key: string) => createHash("sha256").update(key).digest("hex")

/** Webhook grants only start their own saved routine. Raw keys never enter SQLite,
 * event logs, task messages, model context or retry receipts. */
export class BotWebhooks {
  readonly states: BotEventStates
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly event: (kind: string, id: string, value: unknown) => void,
    private readonly dispatch: (routine: BotRoutine, payload: string) => string,
    cancelRun: (id: string) => unknown
  ) {
    this.states = new BotEventStates(store, cancelRun, event)
  }

  private routine(routineId: string, botId?: string): BotRoutine {
    const row = this.store.db.exec("SELECT bot_id FROM bot_routines WHERE id=?", [routineId])[0]
      ?.values[0]
    if (!row || (botId && row[0] !== botId)) throw new BotDomainError("not_found", "事件例程不存在")
    const routine = this.store.routine(String(row[0]), routineId)
    if (routine.schedule.kind !== "event")
      throw new BotDomainError("webhook_schedule", "只有事件例程可接收 Webhook")
    return routine
  }

  requiresVersion(routineId: string): boolean {
    const schedule = this.routine(routineId).schedule
    return schedule.kind === "event" && schedule.eventPolicy?.mode === "latest-state"
  }

  describe(raw: unknown): BotWebhookState {
    const parsed = botWebhookAddress.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "Webhook 目标无效")
    const { botId, routineId } = parsed.data
    const routine = this.routine(routineId, botId)
    const row = this.store.db.exec(
      "SELECT revision,enabled,updated_at,last_accepted_at,last_run_id FROM bot_webhooks WHERE routine_id=?",
      [routineId]
    )[0]?.values[0]
    return {
      botId,
      routineId,
      revision: row ? Number(row[0]) : 0,
      enabled: !!row?.[1],
      routineEnabled: routine.enabled,
      ...(routine.schedule.kind === "event" && routine.schedule.eventPolicy
        ? { eventPolicy: routine.schedule.eventPolicy }
        : {}),
      updatedAt: row ? Number(row[2]) : null,
      lastAcceptedAt: row?.[3] == null ? null : Number(row[3]),
      lastRunId: row?.[4] == null ? null : String(row[4])
    }
  }

  change(raw: unknown): BotWebhookChanged {
    const parsed = botWebhookChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "Webhook 修改参数无效")
    const input = parsed.data
    let key: string | null = null
    const state = this.store.transaction(() =>
      this.receipt(input.nonce, { op: "webhook.change", ...input }, () => {
        this.store.assertMutationEpoch(input.expectedDataEpoch)
        const current = this.describe({ botId: input.botId, routineId: input.routineId })
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "Webhook 已变化，请读取最新状态后重试")
        key = input.operation === "rotate" ? randomBytes(32).toString("hex") : null
        this.store.db.run(
          `INSERT INTO bot_webhooks(routine_id,revision,enabled,key_hash,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(routine_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,key_hash=excluded.key_hash,updated_at=excluded.updated_at`,
          [
            input.routineId,
            current.revision + 1,
            key ? 1 : 0,
            key ? hash(key) : null,
            this.store.now()
          ]
        )
        this.event(
          input.operation === "rotate" ? "routine.webhook_rotated" : "routine.webhook_revoked",
          input.routineId,
          { botId: input.botId, revision: current.revision + 1 }
        )
        return this.describe({ botId: input.botId, routineId: input.routineId })
      })
    )
    return { state, key }
  }

  authorize(routineId: string, authorization: string | undefined): BotWebhookCredential | null {
    if (!/^[\w:.-]{1,160}$/.test(routineId) || !/^Bearer [a-f0-9]{64}$/.test(authorization ?? ""))
      return null
    const row = this.store.db.exec(
      `SELECT w.revision,w.key_hash FROM bot_webhooks w
      JOIN bot_routines r ON r.id=w.routine_id JOIN bots b ON b.id=r.bot_id
      WHERE w.routine_id=? AND w.enabled=1 AND b.deleted_at IS NULL AND json_extract(r.schedule,'$.kind')='event'`,
      [routineId]
    )[0]?.values[0]
    if (!row || typeof row[1] !== "string" || !/^[a-f0-9]{64}$/.test(row[1])) return null
    const actual = hash(authorization!.slice(7))
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(row[1], "hex"))
      ? { routineId, revision: Number(row[0]), digest: actual }
      : null
  }

  accept(
    credential: BotWebhookCredential,
    eventId: string,
    payload: string,
    version?: BotEventVersion
  ): BotEventReceipt {
    identifier(eventId)
    text(payload, "事件数据", 32_000, true)
    return this.store.transaction(() => {
      // Recheck after the HTTP body was read: a revoked key cannot submit a late request.
      const row = this.store.db.exec(
        "SELECT revision,key_hash,enabled FROM bot_webhooks WHERE routine_id=?",
        [credential.routineId]
      )[0]?.values[0]
      if (!row || row[0] !== credential.revision || row[1] !== credential.digest || row[2] !== 1)
        throw new BotDomainError("webhook_unauthorized", "Webhook 密钥已失效")
      const routine = this.routine(credential.routineId)
      const nonce = inboundDeliveryClientNonce("webhook", routine.id, eventId)
      return this.receipt(
        nonce,
        { op: "webhook.delivery", routineId: routine.id, payload, ...(version ? { version } : {}) },
        () => {
          if (!routine.enabled) throw new BotDomainError("webhook_paused", "例程已暂停，事件未接收")
          this.store.routineSkills.assert(routine.skillReferences ?? [])
          const now = this.store.now()
          const counts = this.store.db.exec(
            `SELECT
          (SELECT COUNT(*) FROM bot_webhook_deliveries WHERE routine_id=? AND created_at>?) +
           (SELECT COUNT(*) FROM bot_versioned_event_receipts WHERE routine_id=? AND created_at>?),
          (SELECT COUNT(*) FROM bot_webhook_deliveries WHERE created_at>?) +
           (SELECT COUNT(*) FROM bot_versioned_event_receipts WHERE created_at>?),
          (SELECT COUNT(*) FROM bot_runs WHERE source=? AND status IN ${active}),
          (SELECT COUNT(*) FROM bot_runs WHERE source LIKE 'event:%' AND status IN ${active})`,
            [
              routine.id,
              now - 60_000,
              routine.id,
              now - 60_000,
              now - 60_000,
              now - 60_000,
              `event:${routine.id}`
            ]
          )[0].values[0]
          if (
            Number(counts[0]) >= 60 ||
            Number(counts[1]) >= 600 ||
            Number(counts[2]) >= 20 ||
            Number(counts[3]) >= 200
          )
            throw new BotDomainError("webhook_rate_limit", "事件接收繁忙，请稍后使用原事件标识重试")
          const result = this.states.accept(routine, version, payload, () =>
            this.dispatch(routine, payload)
          )
          const runId = result.runIds[0] ?? null
          if (result.disposition) {
            this.store.db.run("INSERT INTO bot_versioned_event_receipts VALUES(?,?,?)", [
              nonce,
              routine.id,
              now
            ])
          } else {
            this.store.db.run("INSERT INTO bot_webhook_deliveries VALUES(?,?,?,?)", [
              nonce,
              routine.id,
              now,
              runId
            ])
          }
          this.store.db.run(
            "UPDATE bot_webhooks SET last_accepted_at=?,last_run_id=? WHERE routine_id=?",
            [now, runId, routine.id]
          )
          this.event("webhook.accepted", routine.id, {
            botId: routine.botId,
            runId,
            deliveryId: nonce
          })
          return result
        }
      )
    })
  }
}
