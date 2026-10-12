import { z } from "zod"
import {
  BOT_WORK_PAGE_SIZE,
  botWorkPageRequest,
  botPendingCardRequest,
  botTrackedWorkRequest,
  botWorkScopeKey,
  botTrackedWorkKey,
  emptyBotWorkCounts,
  type BotWorkScope,
  type BotWorkCounts,
  type BotWorkView,
  type BotPendingWork,
  type BotOpenRunsPage,
  type BotPendingWorkPage,
  type BotPendingCard,
  type BotTrackedWorkStates,
  type BotWorkspaceWorkState,
  type BotWorkAttention
} from "../../shared/bot-work-pages"
import { BotDomainError, type BotRun } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { storedActivity, runStatus } from "./stored-types"

const OPEN = "r.status NOT IN ('succeeded','failed','cancelled')"
const JOIN_THREAD = "LEFT JOIN bot_message_threads t ON t.message_id=r.message_id"
/** The same projection is used by A's whole identity list and B's bounded lists. */
export const BOT_RUN_SUMMARY_COLUMNS = `r.id,r.bot_id,r.conversation_id,r.message_id,r.parent_run_id,r.root_run_id,r.depth,r.lane,r.source,r.status,r.revision,r.fence,r.lease_owner,r.lease_until,NULL AS checkpoint,NULL AS result,substr(r.error,1,1000) AS error,r.created_at,r.updated_at,
 COALESCE((SELECT json_extract(e.payload,'$.characters') FROM bot_events e WHERE e.entity_id=r.id AND e.kind='run.output' ORDER BY e.cursor DESC LIMIT 1),0) AS output_length,
 COALESCE((SELECT e.cursor FROM bot_events e WHERE e.entity_id=r.id AND e.kind='run.output' ORDER BY e.cursor DESC LIMIT 1),0) AS output_cursor`
type Row = Record<string, unknown>
const n = (value: unknown) => z.number().int().nonnegative().safe().parse(value)
const countSelect = `COUNT(*) AS total,
 COALESCE(SUM(r.status='queued'),0) AS queued,COALESCE(SUM(r.status='running'),0) AS running,
 COALESCE(SUM(r.status='waiting_input'),0) AS waiting_input,COALESCE(SUM(r.status='cancelling'),0) AS cancelling,
 COALESCE(SUM(r.status='needs_review'),0) AS needs_review`
const priority = `CASE r.status WHEN 'needs_review' THEN 0 WHEN 'waiting_input' THEN 1 WHEN 'running' THEN 2 WHEN 'cancelling' THEN 3 ELSE 4 END`
function counts(row?: Row): BotWorkCounts {
  return row
    ? {
        total: n(row.total),
        queued: n(row.queued),
        running: n(row.running),
        waitingInput: n(row.waiting_input),
        cancelling: n(row.cancelling),
        needsReview: n(row.needs_review),
        pending: 0,
        actionablePending: 0
      }
    : emptyBotWorkCounts()
}

/** Bounded read projections, never execution or approval authority. All SQL
 * capture remains synchronous under the owner's normal data-generation read. */
export class BotWorkPages {
  constructor(
    private readonly store: BotStore,
    private readonly project: (row: Row) => BotRun
  ) {}
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
  private cursor(): number {
    return n(this.rows("SELECT COALESCE(MAX(cursor),0) AS n FROM bot_events")[0].n)
  }
  private scope(scope: BotWorkScope): { where: string; args: unknown[] } {
    if (scope.kind === "workspace") return { where: "1", args: [] }
    if (scope.kind === "bot") {
      this.store.getBot(scope.botId)
      return {
        where: `r.bot_id=?${scope.source ? " AND r.source=?" : ""}`,
        args: [scope.botId, ...(scope.source ? [scope.source] : [])]
      }
    }
    this.store.getConversation(scope.conversationId)
    if (scope.threadRootId) this.store.threads.root(scope.conversationId, scope.threadRootId)
    return {
      where: `r.conversation_id=? AND ${scope.threadRootId ? "t.root_id=?" : "t.root_id IS NULL"}`,
      args: [scope.conversationId, ...(scope.threadRootId ? [scope.threadRootId] : [])]
    }
  }
  private owned(hostId: string, input: { hostId: string; dataEpoch: string }): void {
    if (input.hostId !== hostId)
      throw new BotDomainError("stale_host", "Bot 后台已变化，请重新读取")
    this.store.assertMutationEpoch(input.dataEpoch)
  }
  private pageRequest(raw: unknown, hostId: string) {
    const parsed = botWorkPageRequest.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "任务分页参数无效")
    const input = parsed.data
    this.owned(hostId, input)
    if (
      input.before &&
      (input.before.hostId !== hostId ||
        input.before.dataEpoch !== input.dataEpoch ||
        input.before.scopeKey !== botWorkScopeKey(input.scope))
    )
      throw new BotDomainError("work_cursor_scope", "分页位置不属于当前后台、数据或任务范围")
    return input
  }
  private open(scope: BotWorkScope): string {
    // The equivalent positive predicate reuses the existing per-Bot partial
    // index without changing pending-card scope or global ordered reads.
    return scope.kind === "bot"
      ? `${OPEN} AND r.status IN ('queued','running','waiting_input','cancelling','needs_review')`
      : OPEN
  }
  private scopedCounts(scope: BotWorkScope): BotWorkCounts {
    const s = this.scope(scope),
      now = this.store.now()
    const value = counts(
      this.rows(
        `SELECT ${countSelect} FROM bot_runs r ${JOIN_THREAD} WHERE ${this.open(scope)} AND ${s.where}`,
        s.args
      )[0]
    )
    const pending = this.rows(
      `SELECT COUNT(*) AS n,COALESCE(SUM(i.expires_at>? AND r.status='waiting_input' AND r.lease_until>?),0) AS actionable FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id ${JOIN_THREAD} WHERE i.status='pending' AND ${s.where}`,
      [now, now, ...s.args]
    )[0]
    value.pending = n(pending.n)
    value.actionablePending = n(pending.actionable)
    return value
  }
  private pendingRow(row: Row): BotPendingWork {
    return {
      id: String(row.id),
      revision: n(row.revision),
      kind: z.enum(["approval", "question"]).parse(row.kind),
      status:
        Number(row.expires_at) > this.store.now() &&
        row.run_status === "waiting_input" &&
        Number(row.run_lease_until) > this.store.now()
          ? "pending"
          : "expired",
      createdAt: n(row.created_at),
      expiresAt: n(row.expires_at),
      botId: String(row.bot_id),
      address: {
        runId: String(row.run_id),
        conversationId: String(row.conversation_id),
        ...(row.root_id ? { threadRootId: String(row.root_id) } : {})
      },
      runRevision: n(row.run_revision),
      runFence: n(row.run_fence)
    }
  }
  private pendingSelect = `i.id,i.run_id,i.revision,i.kind,i.created_at,i.expires_at,r.bot_id,r.conversation_id,r.revision AS run_revision,r.fence AS run_fence,r.status AS run_status,r.lease_until AS run_lease_until,t.root_id`
  openRuns(raw: unknown, hostId: string): BotOpenRunsPage {
    return this.store.readTransaction(() => {
      const input = this.pageRequest(raw, hostId),
        s = this.scope(input.scope),
        limit = input.limit ?? BOT_WORK_PAGE_SIZE
      const rows = this.rows(
        `SELECT ${BOT_RUN_SUMMARY_COLUMNS} FROM bot_runs r ${JOIN_THREAD} WHERE ${this.open(input.scope)} AND ${s.where}
       ${input.before ? "AND (r.created_at,r.id)>(?,?)" : ""} ORDER BY r.created_at,r.id LIMIT ?`,
        [...s.args, ...(input.before ? [input.before.at, input.before.id] : []), limit + 1]
      )
      const items = rows.slice(0, limit).map(this.project),
        last = items.at(-1)
      this.owned(hostId, input)
      return {
        hostId,
        dataEpoch: input.dataEpoch,
        cursor: this.cursor(),
        scope: input.scope,
        counts: this.scopedCounts(input.scope),
        items,
        next:
          rows.length > limit && last
            ? {
                hostId,
                dataEpoch: input.dataEpoch,
                scopeKey: botWorkScopeKey(input.scope),
                at: last.createdAt,
                id: last.id
              }
            : null
      }
    })
  }
  pendingInteractions(raw: unknown, hostId: string): BotPendingWorkPage {
    return this.store.readTransaction(() => {
      const input = this.pageRequest(raw, hostId),
        s = this.scope(input.scope),
        limit = input.limit ?? BOT_WORK_PAGE_SIZE
      const rows = this.rows(
        `SELECT ${this.pendingSelect} FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id ${JOIN_THREAD} WHERE i.status='pending' AND ${s.where}
       ${input.before ? "AND (i.created_at,i.id)>(?,?)" : ""} ORDER BY i.created_at,i.id LIMIT ?`,
        [...s.args, ...(input.before ? [input.before.at, input.before.id] : []), limit + 1]
      )
      const items = rows.slice(0, limit).map((row) => this.pendingRow(row)),
        last = items.at(-1)
      this.owned(hostId, input)
      return {
        hostId,
        dataEpoch: input.dataEpoch,
        cursor: this.cursor(),
        scope: input.scope,
        counts: this.scopedCounts(input.scope),
        items,
        next:
          rows.length > limit && last
            ? {
                hostId,
                dataEpoch: input.dataEpoch,
                scopeKey: botWorkScopeKey(input.scope),
                at: last.createdAt,
                id: last.id
              }
            : null
      }
    })
  }
  private run(id: string): BotRun | null {
    const row = this.rows(`SELECT ${BOT_RUN_SUMMARY_COLUMNS} FROM bot_runs r WHERE r.id=?`, [id])[0]
    return row ? this.project(row) : null
  }
  private assertAddress(input: {
    runId: string
    conversationId: string
    threadRootId?: string
  }): BotRun {
    const run = this.run(input.runId)
    this.store.getConversation(input.conversationId)
    if (
      !run ||
      run.conversationId !== input.conversationId ||
      run.threadRootId !== input.threadRootId
    )
      throw new BotDomainError("run_scope", "任务不属于当前对话或分支")
    return run
  }
  pendingCard(raw: unknown, hostId: string): BotPendingCard {
    const parsed = botPendingCardRequest.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "待处理内容地址无效")
    return this.store.readTransaction(() => {
      const input = parsed.data
      this.owned(hostId, input)
      const run = this.assertAddress(input),
        item = this.store.getInteraction(input.interactionId)
      if (item.runId !== run.id) throw new BotDomainError("interaction_scope", "请求不属于当前任务")
      if (item.revision !== input.revision)
        throw new BotDomainError("revision_conflict", "待处理内容已变化，请刷新")
      if (
        item.status !== "pending" ||
        item.expiresAt <= this.store.now() ||
        run.status !== "waiting_input" ||
        (run.leaseUntil ?? 0) <= this.store.now()
      )
        throw new BotDomainError("interaction_expired", "此请求已结束，请刷新任务状态")
      this.owned(hostId, input)
      return {
        hostId,
        dataEpoch: input.dataEpoch,
        cursor: this.cursor(),
        run,
        interaction: item
      }
    })
  }
  trackedWork(raw: unknown, hostId: string): BotTrackedWorkStates {
    const parsed = botTrackedWorkRequest.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "任务状态地址无效")
    return this.store.readTransaction(() => {
      const input = parsed.data
      this.owned(hostId, input)
      const items = input.targets.map((target) => {
        if (target.kind === "interaction") {
          const run = this.assertAddress(target)
          const row = this.rows(
            `SELECT ${this.pendingSelect} FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id ${JOIN_THREAD} WHERE i.id=? AND i.run_id=? AND i.status='pending'`,
            [target.interactionId, run.id]
          )[0]
          return {
            key: botTrackedWorkKey(target),
            run,
            interaction: row ? this.pendingRow(row) : null
          }
        }
        this.store.getBot(target.botId)
        if (target.kind === "routine") {
          // Deleted routines may still own a stopping or reviewable run.
          const row = this.rows(
            `SELECT ${BOT_RUN_SUMMARY_COLUMNS} FROM bot_runs r WHERE ${OPEN} AND r.bot_id=? AND r.source=? ORDER BY r.created_at,r.id LIMIT 1`,
            [target.botId, `routine-manual:${target.routineId}`]
          )[0]
          return {
            key: botTrackedWorkKey(target),
            run: row ? this.project(row) : null
          }
        }
        const run = this.run(target.runId)
        if (run && run.botId !== target.botId)
          throw new BotDomainError("run_scope", "任务不属于当前 Bot")
        return { key: botTrackedWorkKey(target), run }
      })
      this.owned(hostId, input)
      return {
        hostId,
        dataEpoch: input.dataEpoch,
        cursor: this.cursor(),
        items
      }
    })
  }
  /** Called only inside snapshot's synchronous transaction. Roster is separate. */
  snapshot(view?: BotWorkView): {
    work: BotWorkspaceWorkState
    runs: BotRun[]
  } {
    const work: BotWorkspaceWorkState = {
      projection: "paged",
      counts: this.scopedCounts({ kind: "workspace" }),
      byBot: {},
      byConversation: {},
      personas: {},
      attention: [],
      noticeStates: []
    }
    for (const [group, key] of [
      ["r.bot_id", "byBot"],
      ["r.conversation_id", "byConversation"]
    ] as const) {
      const map = work[key]
      for (const row of this.rows(
        `SELECT ${group} AS owner,${countSelect} FROM bot_runs r WHERE ${OPEN} GROUP BY ${group}`
      ))
        map[String(row.owner)] = counts(row)
      for (const row of this.rows(
        `SELECT ${group} AS owner,COUNT(*) AS n,COALESCE(SUM(i.expires_at>? AND r.status='waiting_input' AND r.lease_until>?),0) AS actionable FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id WHERE i.status='pending' GROUP BY ${group}`,
        [this.store.now(), this.store.now()]
      )) {
        const value = map[String(row.owner)] ?? emptyBotWorkCounts()
        value.pending = n(row.n)
        value.actionablePending = n(row.actionable)
        map[String(row.owner)] = value
      }
    }
    // Rank only narrow identities. Correlated metadata is evaluated after the
    // representative is chosen, so no task body or per-run model state is read.
    const representatives = this.rows(`WITH ranked AS (
      SELECT r.id,ROW_NUMBER() OVER(PARTITION BY r.conversation_id ORDER BY ${priority},r.created_at,r.id) AS position
      FROM bot_runs r WHERE ${OPEN}
    ) SELECT r.conversation_id,r.status,
      (SELECT e.payload FROM bot_events e WHERE e.entity_id=r.id AND e.kind='run.activity' ORDER BY e.cursor DESC LIMIT 1) AS activity,
      (SELECT child.bot_id FROM bot_peer_waits w JOIN bot_runs child ON child.id=w.child_run_id WHERE w.run_id=r.id) AS waiting_for_bot,
      COALESCE((SELECT json_extract(e.payload,'$.characters') FROM bot_events e WHERE e.entity_id=r.id AND e.kind='run.output' ORDER BY e.cursor DESC LIMIT 1),0) AS output_length
      FROM ranked picked JOIN bot_runs r ON r.id=picked.id WHERE picked.position=1`)
    for (const row of representatives) {
      work.personas[String(row.conversation_id)] = {
        status: runStatus.parse(row.status),
        ...(row.activity
          ? { activity: storedActivity.parse(JSON.parse(z.string().parse(row.activity))) }
          : {}),
        waitingForBot: z
          .string()
          .nullable()
          .parse(row.waiting_for_bot ?? null),
        hasOutput: Number(row.output_length) > 0
      }
    }
    const inputs = this.rows(
      `WITH ranked AS (SELECT i.id,i.kind,i.revision,r.bot_id,r.id AS run_id,r.fence,r.conversation_id,r.message_id,t.root_id,
      ROW_NUMBER() OVER(PARTITION BY r.bot_id ORDER BY i.created_at,i.id) AS position
      FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id ${JOIN_THREAD} WHERE i.status='pending' AND i.expires_at>? AND r.status='waiting_input' AND r.lease_until>?) SELECT * FROM ranked WHERE position=1`,
      [this.store.now(), this.store.now()]
    )
    for (const row of inputs)
      work.attention.push({
        botId: String(row.bot_id),
        id: String(row.id),
        kind: z.enum(["approval", "question"]).parse(row.kind),
        runId: String(row.run_id),
        fence: n(row.fence),
        revision: n(row.revision),
        conversationId: String(row.conversation_id),
        messageId: String(row.message_id),
        ...(row.root_id ? { threadRootId: String(row.root_id) } : {})
      })
    const awaiting = new Set(work.attention.map((item) => item.botId))
    const interrupted = this
      .rows(`WITH ranked AS (SELECT r.id,r.bot_id,r.fence,r.revision,r.conversation_id,r.message_id,t.root_id,
      ROW_NUMBER() OVER(PARTITION BY r.bot_id ORDER BY r.created_at,r.id) AS position FROM bot_runs r ${JOIN_THREAD} WHERE r.status='needs_review') SELECT * FROM ranked WHERE position=1`)
    for (const row of interrupted)
      if (!awaiting.has(String(row.bot_id)))
        work.attention.push({
          botId: String(row.bot_id),
          id: `recovery:${String(row.id)}:${String(row.fence)}`,
          kind: "recovery",
          runId: String(row.id),
          fence: n(row.fence),
          revision: n(row.revision),
          conversationId: String(row.conversation_id),
          messageId: String(row.message_id),
          ...(row.root_id ? { threadRootId: String(row.root_id) } : {})
        } satisfies BotWorkAttention)
    if (!view) return { work, runs: [] }
    const scope: BotWorkScope = { kind: "conversation", ...view },
      s = this.scope(scope)
    const runs = this.rows(
      `SELECT ${BOT_RUN_SUMMARY_COLUMNS} FROM bot_runs r ${JOIN_THREAD} WHERE ${OPEN} AND ${s.where} ORDER BY ${priority},r.created_at,r.id LIMIT 4`,
      s.args
    ).map(this.project)
    const pending = this.rows(
      `SELECT ${this.pendingSelect} FROM bot_interactions i JOIN bot_runs r ON r.id=i.run_id ${JOIN_THREAD} WHERE i.status='pending' AND ${s.where} ORDER BY i.created_at,i.id LIMIT 4`,
      s.args
    ).map((row) => this.pendingRow(row))
    const steering = this.rows(
      `SELECT r.id FROM bot_runs r ${JOIN_THREAD} JOIN bot_conversations c ON c.id=r.conversation_id WHERE ${s.where} AND c.kind='direct' AND (r.source='user' OR (r.source='skill-trial' AND EXISTS(SELECT 1 FROM bot_skill_trials t WHERE t.run_id=r.id AND t.bot_id=r.bot_id))) AND r.status IN ('running','waiting_input') ORDER BY r.created_at,r.id LIMIT 1`,
      s.args
    )[0]
    work.selected = {
      view,
      counts: this.scopedCounts(scope),
      pending,
      ...(steering ? { steeringRunId: String(steering.id) } : {})
    }
    return { work, runs }
  }
}
