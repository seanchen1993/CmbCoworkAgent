import { z } from "zod"
import {
  BOT_NOTIFICATION_EVENT_PAGE_SIZE,
  botNotificationEventsRequest,
  botNotificationTargets,
  botNotificationTargetKey,
  type BotNotificationCurrentState,
  type BotNotificationEventPage,
  type BotNotificationRoute,
  type BotNotificationTarget
} from "../../shared/bot-work-notifications"
import type { BotWorkAttention } from "../../shared/bot-work-pages"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"

type Row = Record<string, unknown>
const counter = (value: unknown) => z.number().int().nonnegative().safe().parse(value)
/** Content-free native-notification projections. No task, approval or model
 * contents are loaded. Snapshot callers share their synchronous read transaction. */
export class BotWorkNotifications {
  constructor(private readonly store: BotStore) {}
  private rows(sql: string, args: unknown[] = []): Row[] {
    const statement = this.store.db.prepare(sql, args),
      result: Row[] = []
    try {
      while (statement.step()) result.push(statement.getAsObject())
    } finally {
      statement.free()
    }
    return result
  }
  private owned(hostId: string, input: { hostId: string; dataEpoch: string }): void {
    if (input.hostId !== hostId)
      throw new BotDomainError("stale_host", "Bot 后台已变化，请重新读取")
    this.store.assertMutationEpoch(input.dataEpoch)
  }
  private run(id: string): Row | undefined {
    return this.rows(
      `SELECT r.id,r.bot_id,r.conversation_id,r.message_id,r.source,r.parent_run_id,
      r.status,r.revision,r.fence,t.root_id FROM bot_runs r JOIN bots b ON b.id=r.bot_id
      LEFT JOIN bot_message_threads t ON t.message_id=r.message_id
      WHERE r.id=? AND b.deleted_at IS NULL`,
      [id]
    )[0]
  }
  private matches(run: Row, target: BotNotificationTarget): boolean {
    return (
      run.bot_id === target.botId &&
      run.conversation_id === target.conversationId &&
      (run.root_id ?? undefined) === target.threadRootId &&
      run.fence === target.fence
    )
  }
  private link(run: Row): BotNotificationRoute["link"] | null {
    let current = run
    const visited = new Set<string>()
    for (let depth = 0; current.source === "workflow-child"; depth++) {
      if (
        depth >= 8 ||
        typeof current.parent_run_id !== "string" ||
        visited.has(String(current.id))
      )
        return null
      visited.add(String(current.id))
      const parent = this.run(current.parent_run_id)
      if (!parent || parent.bot_id !== run.bot_id) return null
      current = parent
    }
    const message = this.rows("SELECT id FROM bot_messages WHERE id=? AND conversation_id=?", [
      current.message_id,
      current.conversation_id
    ])[0]
    return message
      ? {
          conversationId: String(current.conversation_id),
          messageId: String(current.message_id)
        }
      : null
  }
  /** Owner attaches this safe route to each already bounded per-Bot attention. */
  attention(item: BotWorkAttention): BotNotificationRoute | null {
    const target: BotNotificationTarget = {
      kind: item.kind === "recovery" ? "recovery" : "interaction",
      botId: item.botId,
      runId: item.runId,
      conversationId: item.conversationId,
      ...(item.threadRootId ? { threadRootId: item.threadRootId } : {}),
      fence: item.fence,
      revision: item.revision,
      ...(item.kind === "recovery" ? {} : { interactionId: item.id })
    } as BotNotificationTarget
    const run = this.run(item.runId)
    if (!run || !this.matches(run, target) || !this.current(target, run)) return null
    const link = this.link(run)
    return link ? { target, link } : null
  }
  private current(target: BotNotificationTarget, run = this.run(target.runId)): boolean {
    if (!run || !this.matches(run, target)) return false
    if (target.kind === "recovery")
      return run.status === "needs_review" && run.revision === target.revision
    if (target.kind === "interaction")
      return (
        ["running", "waiting_input"].includes(String(run.status)) &&
        !!this.rows(
          `SELECT id FROM bot_interactions WHERE id=? AND run_id=? AND revision=? AND status='pending' AND expires_at>?`,
          [target.interactionId, target.runId, target.revision, this.store.now()]
        )[0]
      )
    return (
      ["succeeded", "failed"].includes(String(run.status)) &&
      run.source !== "workflow-child" &&
      !!this.rows(
        "SELECT id FROM bot_messages WHERE id=? AND conversation_id=? AND run_id=? AND sender IN ('bot','system')",
        [target.messageId, target.conversationId, target.runId]
      )[0]
    )
  }
  states(raw: unknown, hostId: string, dataEpoch: string): BotNotificationCurrentState[] {
    const parsed = botNotificationTargets.safeParse(raw ?? [])
    if (!parsed.success) throw new BotDomainError("invalid_input", "通知状态地址无效")
    this.owned(hostId, { hostId, dataEpoch })
    return parsed.data.map((target) => ({
      key: botNotificationTargetKey(target),
      current: this.current(target)
    }))
  }
  events(raw: unknown, hostId: string): BotNotificationEventPage {
    const parsed = botNotificationEventsRequest.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "通知事件范围无效")
    return this.store.readTransaction(() => {
      const input = parsed.data
      this.owned(hostId, input)
      const cursor = counter(this.rows("SELECT COALESCE(MAX(cursor),0) AS n FROM bot_events")[0].n)
      if (input.through > cursor)
        throw new BotDomainError("event_cursor_scope", "通知事件范围已变化，请重新读取")
      const events = this.rows(
        `SELECT cursor,kind,entity_id,created_at,
        CASE WHEN kind='run.settled' THEN json_extract(payload,'$.status') ELSE NULL END AS status
        FROM bot_events WHERE cursor>? AND cursor<=? ORDER BY cursor LIMIT ?`,
        [input.after, input.through, input.limit ?? BOT_NOTIFICATION_EVENT_PAGE_SIZE]
      ).map((row) => {
        const event: BotNotificationEventPage["events"][number] = {
          cursor: counter(row.cursor),
          kind: String(row.kind),
          entityId: String(row.entity_id),
          createdAt: counter(row.created_at)
        }
        if (row.kind === "run.settled" && ["succeeded", "failed"].includes(String(row.status))) {
          const run = this.run(String(row.entity_id))
          if (
            run &&
            run.source !== "workflow-child" &&
            run.status === row.status &&
            this.rows(
              "SELECT MAX(cursor) AS cursor FROM bot_events WHERE entity_id=? AND kind='run.settled'",
              [run.id]
            )[0].cursor === row.cursor
          ) {
            const message = this.rows(
              `SELECT m.id FROM bot_messages m JOIN bot_events e ON e.entity_id=m.id AND e.kind='message.created'
                WHERE m.run_id=? AND m.conversation_id=? AND m.sender IN ('bot','system') AND e.cursor<=?
                ORDER BY e.cursor DESC LIMIT 1`,
              [run.id, run.conversation_id, row.cursor]
            )[0]
            if (message)
              event.completion = {
                target: {
                  kind: "completion",
                  botId: String(run.bot_id),
                  runId: String(run.id),
                  conversationId: String(run.conversation_id),
                  ...(run.root_id ? { threadRootId: String(run.root_id) } : {}),
                  fence: counter(run.fence),
                  messageId: String(message.id)
                },
                link: {
                  conversationId: String(run.conversation_id),
                  messageId: String(message.id)
                },
                status: row.status as "succeeded" | "failed"
              }
          }
        }
        return event
      })
      this.owned(hostId, input)
      return {
        hostId,
        dataEpoch: input.dataEpoch,
        through: input.through,
        events
      }
    })
  }
}
