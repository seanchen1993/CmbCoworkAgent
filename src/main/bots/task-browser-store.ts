import { z } from "zod"
import type { BotBrowserSession } from "../../shared/bot-computer"
import type { BotRunAddress } from "../../shared/bot-run-history"
import { BotDomainError } from "../../shared/bot-types"
import type { BotStore } from "./store"
import * as v from "./validation"

const manifest = z
  .object({
    urls: z.array(z.string().max(8192)).max(30),
    active: z.number().int().min(0).max(29),
    humanHeld: z.literal(true).optional()
  })
  .strict()
const retiredManifest = '{"urls":[],"active":0}'
export const BOT_TASK_BROWSER_COMPACT_BATCH = 16
const terminal = new Set(["succeeded", "failed", "cancelled"])
export const BOT_TASK_BROWSER_RETAIN_MS = 5 * 60_000

/** Relation to the original child: no queue, task status, graph or new lease. */
export class BotTaskBrowsers {
  // One bounded maintenance continuation, never a second task queue or timer.
  private compactAfter?: { expiry: number; runId: string }
  constructor(private readonly store: BotStore) {}

  resolve(address: BotRunAddress) {
    const run = this.store.assertRunAddress(address)
    this.assertOwner(run.botId, run.id)
    if (terminal.has(run.status) && !this.available(run.id))
      throw new BotDomainError("workflow_browser_released", "任务浏览器已释放，执行记录仍可查看")
    return { botId: run.botId, taskRunId: run.id }
  }

  assertOwner(botId: string, runId: string, mutate = false): void {
    v.identifier(botId)
    v.identifier(runId)
    const run = this.store.getRun(runId)
    const child = this.store.workflowChildren.metadata(run.id)
    this.store.getBot(botId)
    if (
      run.botId !== botId ||
      run.source !== "workflow-child" ||
      child?.input.browserAccess !== "page"
    )
      throw new BotDomainError("workflow_browser_scope", "画面不属于此浏览器子任务")
    if (!this.store.getConversation(run.conversationId).members.includes(botId))
      throw new BotDomainError("invalid_recipient", "Bot 已离开任务对话")
    if (run.threadRootId) this.store.threads.root(run.conversationId, run.threadRootId)
    if (mutate) {
      if (!run.leaseOwner || !["running", "waiting_input"].includes(run.status))
        throw new BotDomainError("workflow_browser_inactive", "任务已停止，画面仅供查看")
      this.store.assertDispatch({ runId, owner: run.leaseOwner, fence: run.fence }, true)
    }
  }

  load(botId: string, runId: string): BotBrowserSession | null {
    this.assertOwner(botId, runId, true)
    const row = this.store.db.exec(
      "SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?",
      [runId]
    )[0]?.values[0]
    return row ? manifest.parse(JSON.parse(String(row[0]))) : null
  }

  save(botId: string, runId: string, value: BotBrowserSession): void {
    const data = manifest.parse(value)
    this.store.transaction(() => {
      this.assertOwner(botId, runId)
      const run = this.store.getRun(runId)
      const prior = this.store.db.exec(
        "SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?",
        [runId]
      )[0]?.values[0]
      // Closed terminal manifests are tombstones. Late observations cannot grow
      // them again or resurrect a discarded session as expires_at=NULL.
      if (
        terminal.has(run.status) &&
        !this.needsReview(botId, runId) &&
        (!prior || (prior[0] !== null && Number(prior[0]) <= this.store.now()))
      )
        return
      // A late navigation callback may preserve the final URL, never extend retention.
      this.store.db.run(
        `INSERT INTO bot_task_browser_sessions(run_id,manifest,updated_at,expires_at) VALUES(?,?,?,NULL)
        ON CONFLICT(run_id) DO UPDATE SET manifest=excluded.manifest,updated_at=excluded.updated_at`,
        [runId, JSON.stringify(data), this.store.now()]
      )
    })
  }

  retire(botId: string, runId: string, pendingPage = false): number | null {
    return this.store.transaction(() => {
      this.assertOwner(botId, runId)
      const run = this.store.getRun(runId)
      if (
        !terminal.has(run.status) ||
        this.store
          .effects(runId)
          .some((effect) => effect.status === "started" || effect.status === "unknown")
      )
        return null
      const existing = this.store.db.exec(
        "SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?",
        [runId]
      )[0]?.values[0]
      if (!existing && !pendingPage) return null
      const until = this.store.now() + BOT_TASK_BROWSER_RETAIN_MS
      this.store.db.run(
        `INSERT INTO bot_task_browser_sessions(run_id,manifest,updated_at,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET expires_at=COALESCE(expires_at,excluded.expires_at),updated_at=excluded.updated_at`,
        [runId, retiredManifest, this.store.now(), until]
      )
      const expiry = this.store.db.exec(
        "SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?",
        [runId]
      )[0]?.values[0]
      return expiry ? z.number().int().nonnegative().parse(expiry[0]) : null
    })
  }

  active(runId: string): boolean {
    const run = this.store.getRun(runId)
    return ["running", "waiting_input"].includes(run.status)
  }

  release(botId: string, runId: string): void {
    this.store.transaction(() => {
      this.assertOwner(botId, runId)
      if (!terminal.has(this.store.getRun(runId).status) || this.needsReview(botId, runId))
        throw new BotDomainError("workflow_browser_review", "任务现场仍需保留")
      const row = this.store.db.exec(
        "SELECT manifest FROM bot_task_browser_sessions WHERE run_id=?",
        [runId]
      )[0]?.values[0]
      let compact = false
      if (row) {
        try {
          const saved = manifest.safeParse(JSON.parse(String(row[0])))
          compact = saved.success && !saved.data.humanHeld
        } catch {
          /* Invalid evidence is retained. */
        }
      }
      this.store.db.run(
        `UPDATE bot_task_browser_sessions SET manifest=CASE WHEN ? THEN ? ELSE manifest END,
        expires_at=MIN(COALESCE(expires_at,?),?),updated_at=? WHERE run_id=?`,
        [
          compact ? 1 : 0,
          retiredManifest,
          this.store.now(),
          this.store.now(),
          this.store.now(),
          runId
        ]
      )
    })
    this.compactExpired()
  }

  /** Bootstrap/retirement only; no per-frame sweep or background polling. Keep
   * original expiry/receipts, and skip human, uncertain or invalid evidence. */
  compactExpired(): number {
    let next = this.compactAfter
    const compacted = this.store.transaction(() => {
      const after = next
      const rows =
        this.store.db.exec(
          `SELECT s.run_id,s.expires_at,s.manifest,r.source,r.status,
        EXISTS(SELECT 1 FROM bot_effects e WHERE e.run_id=s.run_id AND e.status IN ('started','unknown'))
        FROM bot_task_browser_sessions s INDEXED BY bot_task_browser_expiry
        CROSS JOIN bot_runs r ON r.id=s.run_id
        WHERE s.expires_at IS NOT NULL AND s.manifest<>'{"urls":[],"active":0}' AND s.expires_at<=?
        ${after ? "AND (s.expires_at,s.run_id)>(?,?)" : ""}
        ORDER BY s.expires_at,s.run_id LIMIT ${BOT_TASK_BROWSER_COMPACT_BATCH}`,
          after ? [this.store.now(), after.expiry, after.runId] : [this.store.now()]
        )[0]?.values ?? []
      let compacted = 0
      for (const [id, expiry, text, source, status, uncertain] of rows) {
        const runId = String(id)
        next = { expiry: Number(expiry), runId }
        // Bound examined rows too, including uncertain/invalid evidence. They
        // stay intact and do not force every maintenance pass to rescan them.
        if (source !== "workflow-child" || !terminal.has(String(status)) || uncertain !== 0)
          continue
        let saved: BotBrowserSession | undefined
        try {
          const parsed = manifest.safeParse(JSON.parse(String(text)))
          if (parsed.success) saved = parsed.data
          if (
            !saved ||
            saved.humanHeld ||
            this.store.workflowChildren.metadata(runId)?.input.browserAccess !== "page"
          )
            continue
        } catch {
          continue /* Invalid/unknown records remain available for review. */
        }
        this.store.db.run(
          "UPDATE bot_task_browser_sessions SET manifest=?,updated_at=? WHERE run_id=?",
          [retiredManifest, this.store.now(), runId]
        )
        compacted++
      }
      if (rows.length < BOT_TASK_BROWSER_COMPACT_BATCH) next = undefined
      return compacted
    })
    this.compactAfter = next
    return compacted
  }

  needsReview(botId: string, runId: string): boolean {
    try {
      this.assertOwner(botId, runId)
      return (
        this.store.getRun(runId).status === "needs_review" ||
        this.store
          .effects(runId)
          .some((effect) => effect.status === "started" || effect.status === "unknown")
      )
    } catch {
      return true // An unknown lifetime cannot authorize automatic disposal.
    }
  }

  available(runId: string): boolean {
    const row = this.store.db.exec(
      "SELECT expires_at FROM bot_task_browser_sessions WHERE run_id=?",
      [runId]
    )[0]?.values[0]
    return Boolean(row && (row[0] === null || Number(row[0]) > this.store.now()))
  }
}
