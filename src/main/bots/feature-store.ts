import { createHash, randomUUID } from "node:crypto"
import type { BotFeatureFollow, BotFeatureTarget, BotFeatureTask } from "../../shared/bots/feature"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"

export interface FeatureScope {
  botId: string
  audience: string
}
export interface FeatureTaskQuery {
  query?: string
  before?: number
  limit?: number
  followId?: string
}
export interface FeatureOwner extends FeatureScope, BotFeatureFollow {}
export type FeatureOperation = "session" | "continue" | "manage" | "stop" | "interrupt"
export interface FeatureReceipt {
  id: string
  followId: string
  taskId: string
  action: FeatureOperation
  state: "starting" | "active" | "finished" | "failed"
  threadId?: string
  runId?: string
  error?: string
  decisionId?: string
}
type Rows = (sql: string, args?: readonly unknown[]) => Record<string, unknown>[]
interface SessionClaim {
  followId: string
  incarnation: string
  nodeId?: string
}
const followColumns =
  "id, bot_id AS botId, audience, project_id AS projectId, slug, project_name AS projectName, title"
const operationColumns =
  "id, follow_id AS followId, task_id AS taskId, action, state, thread_id AS threadId, run_id AS runId, error, decision_id AS decisionId"

export class BotFeatureStore {
  constructor(
    private db: NativeSqliteAdapter,
    private rows: Rows,
    private transaction: <T>(body: () => T) => T,
    private changed: () => void,
    private now = Date.now
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS bot_feature_follows (
      id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,audience TEXT NOT NULL,project_id TEXT NOT NULL,
      slug TEXT NOT NULL,project_name TEXT NOT NULL,title TEXT NOT NULL,
      UNIQUE(bot_id,audience,project_id,slug));
      CREATE INDEX IF NOT EXISTS bot_feature_follows_project ON bot_feature_follows(project_id,slug);
      CREATE TABLE IF NOT EXISTS bot_feature_sessions (
      thread_id TEXT PRIMARY KEY,follow_id TEXT NOT NULL,incarnation TEXT NOT NULL,node_id TEXT);
      CREATE INDEX IF NOT EXISTS bot_feature_sessions_owner ON bot_feature_sessions(follow_id);
      CREATE TABLE IF NOT EXISTS bot_feature_ops (
      id TEXT PRIMARY KEY,follow_id TEXT NOT NULL,task_id TEXT NOT NULL,action TEXT NOT NULL,
      fingerprint TEXT NOT NULL,state TEXT NOT NULL,thread_id TEXT,run_id TEXT UNIQUE,error TEXT);
      CREATE INDEX IF NOT EXISTS bot_feature_ops_owner ON bot_feature_ops(follow_id);
      CREATE INDEX IF NOT EXISTS bot_feature_ops_retention ON bot_feature_ops(task_id,state);`)
    // Profiles from the first project-mode preview already contain these three tables.
    const extend = (table: string, columns: Record<string, string>) => {
      const existing = new Set(this.rows(`PRAGMA table_info(${table})`).map((r) => r.name))
      for (const [name, definition] of Object.entries(columns))
        if (!existing.has(name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    }
    extend("bot_feature_follows", {
      state: "TEXT NOT NULL DEFAULT 'active'",
      version: "INTEGER NOT NULL DEFAULT 1",
      updated_at: "INTEGER NOT NULL DEFAULT 0"
    })
    extend("bot_feature_ops", {
      decision_id: "TEXT",
      decision_thread: "TEXT",
      terminal_phase: "TEXT"
    })
  }
  follow(scope: FeatureScope, feature: Omit<BotFeatureFollow, "id">): FeatureOwner {
    this.db.run(
      `INSERT INTO bot_feature_follows(id,bot_id,audience,project_id,slug,project_name,title,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,audience,project_id,slug) DO UPDATE SET title=excluded.title,project_name=excluded.project_name
      WHERE title<>excluded.title OR project_name<>excluded.project_name`,
      [
        randomUUID(),
        scope.botId,
        scope.audience,
        feature.projectId,
        feature.slug,
        feature.projectName,
        feature.title,
        this.now()
      ]
    )
    if (this.db.getRowsModified()) this.changed()
    return this.find(scope, feature.projectId, feature.slug)!
  }
  find(scope: FeatureScope, projectId: string, slug: string): FeatureOwner | undefined {
    return this.rows(
      `SELECT ${followColumns} FROM bot_feature_follows WHERE bot_id=? AND audience=? AND project_id=? AND slug=?`,
      [scope.botId, scope.audience, projectId, slug]
    )[0] as unknown as FeatureOwner | undefined
  }
  list(scope: FeatureScope): BotFeatureFollow[] {
    return this.rows(
      "SELECT id,project_id AS projectId,slug,project_name AS projectName,title FROM bot_feature_follows WHERE bot_id=? AND audience=? ORDER BY title,id",
      [scope.botId, scope.audience]
    ) as unknown as BotFeatureFollow[]
  }
  targets(feature?: Pick<BotFeatureFollow, "projectId" | "slug">): BotFeatureTarget[] {
    // Look up each conversation's follow by the existing (bot, audience, project, slug)
    // unique key. The project picker needs neither transcripts nor a full Bot snapshot.
    const rows = this.rows(
      `WITH conversations(bot_id, audience, group_id, group_name) AS (
        SELECT id, 'desktop', NULL, NULL FROM bots
        UNION ALL
        SELECT r.bot_id, 'im:' || r.id, r.id,
          COALESCE(NULLIF(json_extract(r.binding_json,'$.peerLabel'), ''), '招乎群聊')
        FROM bot_im_routes r JOIN bot_im_bindings b ON b.id=r.id AND b.bot_id=r.bot_id
        WHERE b.kind='group' AND b.revoked=0 AND json_extract(r.binding_json,'$.state')='active'
      )
      SELECT bot.id AS botId, bot.name AS botName, bot.color, bot.shape, c.group_id AS groupId,
        COALESCE(c.group_name, bot.name) AS label, f.id IS NOT NULL AS linked,
        CASE WHEN bot.archived THEN 'archived' END AS unavailable
      FROM conversations c JOIN bots bot ON bot.id=c.bot_id
      LEFT JOIN bot_feature_follows f ON f.bot_id=c.bot_id AND f.audience=c.audience
        AND f.project_id=? AND f.slug=?
      WHERE bot.deleting=0 AND (f.id IS NOT NULL OR bot.archived=0)
      ORDER BY f.rowid DESC, label COLLATE NOCASE, bot.id, c.audience`,
      [feature?.projectId ?? null, feature?.slug ?? null]
    )
    return rows.map((row) => ({
      botId: String(row.botId),
      botName: String(row.botName),
      color: String(row.color),
      shape: row.shape as BotFeatureTarget["shape"],
      ...(row.groupId ? { groupId: String(row.groupId) } : {}),
      label: String(row.label),
      linked: Boolean(row.linked),
      ...(row.unavailable
        ? { unavailable: row.unavailable as BotFeatureTarget["unavailable"] }
        : {})
    }))
  }
  owner(id: string, scope?: FeatureScope): FeatureOwner {
    const row = this.rows(`SELECT ${followColumns} FROM bot_feature_follows WHERE id=?`, [
      id
    ])[0] as unknown as FeatureOwner | undefined
    if (!row || (scope && (row.botId !== scope.botId || row.audience !== scope.audience)))
      throw new Error("当前对话未跟进此 Feature")
    return row
  }
  /** Only small indexed Bot records: listing tasks never reads project files, messages or run logs. */
  taskRows(
    scope: FeatureScope,
    { query = "", before = Number.MAX_SAFE_INTEGER, limit = -1, followId }: FeatureTaskQuery = {}
  ) {
    return this.rows(
      `SELECT f.rowid AS ordinal,f.id,f.project_id AS projectId,f.slug,f.project_name AS projectName,f.title,
      f.state,f.version,f.updated_at AS updatedAt,o.decision_thread AS attentionThreadId,
      CASE WHEN f.state='completed' THEN 'completed' WHEN o.decision_id IS NOT NULL THEN 'decision'
        WHEN o.state IN ('starting','active') THEN CASE WHEN o.action='manage' THEN 'managed' ELSE 'running' END
        WHEN o.terminal_phase IS NOT NULL THEN o.terminal_phase WHEN o.state='failed' THEN 'failed'
        WHEN o.state='finished' THEN 'replied' WHEN EXISTS(SELECT 1 FROM bot_feature_sessions s WHERE s.follow_id=f.id) THEN 'linked'
        ELSE 'following' END AS phase
      FROM bot_feature_follows f LEFT JOIN bot_feature_ops o ON o.id=(
        SELECT id FROM bot_feature_ops WHERE follow_id=f.id AND action IN ('manage','session','continue')
        ORDER BY (decision_id IS NOT NULL) DESC,(state IN ('starting','active')) DESC,rowid DESC LIMIT 1)
      WHERE f.bot_id=? AND f.audience=? ${followId ? "AND f.id=?" : ""} AND f.rowid<? AND (?='' OR instr(lower(f.title||' '||f.project_name||' '||f.slug),lower(?))>0)
      ORDER BY f.rowid DESC LIMIT ?`,
      [scope.botId, scope.audience, ...(followId ? [followId] : []), before, query, query, limit]
    ) as unknown as (Omit<BotFeatureTask, "kind"> & { ordinal: number })[]
  }
  private touch(id: string) {
    this.db.run("UPDATE bot_feature_follows SET updated_at=? WHERE id=?", [this.now(), id])
    this.changed()
  }
  setDecision(op: FeatureReceipt, id: string, threadId: string, pending: boolean) {
    if (pending)
      this.db.run(
        "UPDATE bot_feature_ops SET decision_id=?,decision_thread=? WHERE id=? AND state='active'",
        [id, threadId, op.id]
      )
    else
      this.db.run(
        "UPDATE bot_feature_ops SET decision_id=NULL,decision_thread=NULL WHERE id=? AND decision_id=?",
        [op.id, id]
      )
    if (this.db.getRowsModified()) this.touch(op.followId)
  }
  lifecycle(owner: FeatureOwner, action: "complete" | "reopen", version: number) {
    const next = action === "complete" ? "completed" : "active"
    const current = this.rows("SELECT state,version FROM bot_feature_follows WHERE id=?", [
      owner.id
    ])[0]
    if (current.state === next && Number(current.version) === version + 1) return
    if (current.version !== version || current.state === next)
      throw new Error("任务状态已变化，请刷新后重试")
    if (
      action === "complete" &&
      this.rows(
        "SELECT 1 FROM bot_feature_ops WHERE follow_id=? AND state IN ('starting','active') LIMIT 1",
        [owner.id]
      ).length
    )
      throw new Error("任务仍在执行，请先处理当前会话或停止托管")
    this.db.run("UPDATE bot_feature_follows SET state=?,version=version+1 WHERE id=?", [
      next,
      owner.id
    ])
    this.touch(owner.id)
  }
  private followState(id: string) {
    const follow = this.rows("SELECT state FROM bot_feature_follows WHERE id=?", [id])[0]
    if (!follow) throw new Error("当前对话未跟进此 Feature")
    return follow.state
  }
  addSession(owner: FeatureOwner, threadId: string, incarnation: string, nodeId?: string) {
    if (this.followState(owner.id) === "completed")
      throw new Error("这项任务已确认完成，请先选择继续处理")
    this.db.run(
      `INSERT INTO bot_feature_sessions VALUES(?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET node_id=COALESCE(excluded.node_id,node_id)
      WHERE follow_id=excluded.follow_id AND incarnation=excluded.incarnation`,
      [threadId, owner.id, incarnation, nodeId ?? null]
    )
    if (!this.db.getRowsModified()) throw new Error("会话已属于其他对话或已被替换")
    this.touch(owner.id)
  }
  sessions(id: string) {
    return this.rows(
      "SELECT thread_id AS threadId,incarnation,node_id AS nodeId FROM bot_feature_sessions WHERE follow_id=? ORDER BY rowid DESC",
      [id]
    ) as unknown as { threadId: string; incarnation: string; nodeId?: string }[]
  }
  sessionClaims(threadIds: string[]) {
    const result = new Map<string, SessionClaim>()
    for (let i = 0; i < threadIds.length; i += 400) {
      const batch = threadIds.slice(i, i + 400)
      for (const row of this.rows(
        `SELECT thread_id,follow_id,incarnation,node_id FROM bot_feature_sessions
         WHERE thread_id IN (${batch.map(() => "?").join(",")})`,
        batch
      )) {
        result.set(String(row.thread_id), {
          followId: String(row.follow_id),
          incarnation: String(row.incarnation),
          nodeId: typeof row.node_id === "string" ? row.node_id : undefined
        })
      }
    }
    return result
  }
  begin(
    owner: FeatureOwner,
    taskId: string,
    key: string,
    action: FeatureOperation,
    input: unknown
  ) {
    const id = createHash("sha256")
      .update(JSON.stringify([taskId, key]))
      .digest("hex")
    const hash = createHash("sha256")
      .update(JSON.stringify([owner.id, action, input]))
      .digest("hex")
    if (
      this.followState(owner.id) === "completed" &&
      action !== "stop" &&
      action !== "interrupt" &&
      !this.rows("SELECT 1 FROM bot_feature_ops WHERE id=?", [id]).length
    )
      throw new Error("这项任务已确认完成，请先选择继续处理")
    this.db.run(
      "INSERT OR IGNORE INTO bot_feature_ops(id,follow_id,task_id,action,fingerprint,state) VALUES(?,?,?,?,?,'starting')",
      [id, owner.id, taskId, action, hash]
    )
    const fresh = !!this.db.getRowsModified()
    const { fingerprint, ...record } = this.rows(
      `SELECT ${operationColumns},fingerprint FROM bot_feature_ops WHERE id=?`,
      [id]
    )[0]
    if (fingerprint !== hash) throw new Error("此请求标识已用于其他 Feature 操作")
    return { fresh, receipt: record as unknown as FeatureReceipt }
  }
  findReceipt(id: string): FeatureReceipt | undefined {
    return this.rows(`SELECT ${operationColumns} FROM bot_feature_ops WHERE id=?`, [
      id
    ])[0] as unknown as FeatureReceipt | undefined
  }
  receipt(id: string): FeatureReceipt {
    const row = this.findReceipt(id)
    if (!row) throw new Error("Feature 操作记录不存在")
    return row
  }
  active(id: string, threadId?: string, runId?: string) {
    this.db.run(
      "UPDATE bot_feature_ops SET state='active',thread_id=?,run_id=? WHERE id=? AND state='starting'",
      [threadId ?? null, runId ?? null, id]
    )
    if (!this.db.getRowsModified()) throw new Error("Feature 操作已结束")
    this.touch(this.receipt(id).followId)
  }
  finish(id: string, error?: string, terminalPhase?: "stopped") {
    this.db.run(
      "UPDATE bot_feature_ops SET state=?,error=?,terminal_phase=?,decision_id=NULL,decision_thread=NULL WHERE id=? AND state IN ('starting','active')",
      [error ? "failed" : "finished", error?.slice(0, 500) ?? null, terminalPhase ?? null, id]
    )
    if (this.db.getRowsModified()) this.touch(this.receipt(id).followId)
  }
  latestRun(id: string) {
    const row = this.rows(
      "SELECT run_id FROM bot_feature_ops WHERE follow_id=? AND run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      [id]
    )[0]
    return row ? String(row.run_id) : undefined
  }
  operationForRun(runId: string) {
    const row = this.rows(`SELECT ${operationColumns} FROM bot_feature_ops WHERE run_id=?`, [
      runId
    ])[0]
    return row as unknown as FeatureReceipt | undefined
  }
  unfinished() {
    return this.rows(
      `SELECT ${operationColumns} FROM bot_feature_ops WHERE state IN ('starting','active')`
    ) as unknown as FeatureReceipt[]
  }
  followedProjects(): string[] {
    return this.rows("SELECT DISTINCT project_id FROM bot_feature_follows").map((row) =>
      String(row.project_id)
    )
  }
  removeMissingFeatures(projectId: string, retained: ReadonlySet<string>): FeatureOwner[] {
    const follows = this.rows(
      `SELECT ${followColumns} FROM bot_feature_follows WHERE project_id=?`,
      [projectId]
    ) as unknown as FeatureOwner[]
    const removed = follows.filter((f) => !retained.has(f.slug))
    if (removed.length)
      this.transaction(() => {
        this.deleteFollows("SELECT value FROM json_each(?)", [
          JSON.stringify(removed.map((f) => f.id))
        ])
        this.changed()
      })
    return removed
  }
  deleteScope(botId: string, audience?: string) {
    const where =
      "SELECT id FROM bot_feature_follows WHERE bot_id=?" +
      (audience === undefined ? "" : " AND audience=?")
    const args = audience === undefined ? [botId] : [botId, audience]
    this.deleteFollows(where, args)
  }
  private deleteFollows(where: string, args: string[]) {
    // The native project thread outlives the Bot. Keep its exclusive claim so its
    // history cannot become an ordinary Feature session for another conversation.
    this.db.run(`DELETE FROM bot_feature_ops WHERE follow_id IN (${where})`, args)
    this.db.run("DELETE FROM bot_feature_follows WHERE id IN (" + where + ")", args)
  }
}
