import { createHash } from "node:crypto"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type {
  BotImBinding,
  BotImEvent,
  BotImConversation,
  BotImReplacement
} from "../../shared/bots/im-channel"
import { BotError } from "../../shared/bots/contracts"

export interface StoredBotImEvent {
  id: string
  bindingId: string
  payload: BotImEvent
  state: "received" | "active" | "completed" | "failed" | "unknown"
  leaseId: string
  expiresAt: number
  taskId: string | null
}
export interface StoredBotImBinding {
  id: string
  realm: string
  principal: string
  binding: BotImBinding
}
export const botImScopeId = (...parts: string[]): string =>
  `im-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`

/** Routing receipts only. Bot content and tasks still belong to the existing BotStore. */
export class BotImGatewayStore {
  constructor(private readonly db: NativeSqliteAdapter) {
    db.run(`CREATE TABLE IF NOT EXISTS bot_im_routes (
      id TEXT PRIMARY KEY,realm TEXT NOT NULL,principal TEXT NOT NULL,bot_id TEXT NOT NULL,binding_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_im_routes_owner ON bot_im_routes(realm,principal,bot_id);
      CREATE TABLE IF NOT EXISTS bot_im_replacements (binding_id TEXT PRIMARY KEY,target_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_im_removed_bindings (binding_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bot_im_ingress (
      id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,payload_json TEXT NOT NULL,fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,lease_id TEXT NOT NULL,expires_at INTEGER NOT NULL,task_id TEXT);
      CREATE INDEX IF NOT EXISTS bot_im_ingress_state ON bot_im_ingress(state,id);
      CREATE INDEX IF NOT EXISTS bot_im_ingress_binding ON bot_im_ingress(binding_id,id);
      CREATE TABLE IF NOT EXISTS bot_im_local_execution(task_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bot_im_personal_owners (
        bot_id TEXT PRIMARY KEY,realm TEXT NOT NULL,principal TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_im_personal_links (
        binding_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,activated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_im_personal_links_bot ON bot_im_personal_links(bot_id,activated_at);
      CREATE INDEX IF NOT EXISTS bot_im_task_event ON bot_tasks(json_extract(mock_source_json,'$.eventId'),state)
        WHERE json_extract(mock_source_json,'$.transport')='im';`)
    if (!this.rows("PRAGMA table_info(bot_im_ingress)").some((row) => row.name === "needs_ack"))
      db.run("ALTER TABLE bot_im_ingress ADD COLUMN needs_ack INTEGER NOT NULL DEFAULT 0")
    // The host independently interrupts old tasks. A process restart is never a new execution grant.
    db.run(
      "UPDATE bot_im_ingress SET state='unknown',expires_at=0,needs_ack=1 WHERE state IN ('received','active')"
    )
  }
  private rows(sql: string, args: readonly unknown[] = []): Record<string, unknown>[] {
    const query = this.db.prepare(sql, args),
      rows: Record<string, unknown>[] = []
    try {
      while (query.step()) rows.push(query.getAsObject())
      return rows
    } finally {
      query.free()
    }
  }
  register(realm: string, principal: string, binding: BotImBinding): StoredBotImBinding {
    const id = botImScopeId(realm, principal, binding.id)
    const old = this.binding(id)
    // A delayed create/list response must not downgrade a consumed proof or a revocation.
    if (
      old &&
      (old.binding.version > binding.version ||
        (old.binding.version === binding.version &&
          old.binding.state !== "pending" &&
          binding.state === "pending"))
    )
      return old
    if (
      old &&
      (old.binding.botId !== binding.botId ||
        old.binding.kind !== binding.kind ||
        (old.binding.conversationKey && old.binding.conversationKey !== binding.conversationKey) ||
        (old.binding.state === "revoked" && binding.state !== "revoked"))
    )
      throw new BotError("CONFLICT", "IM 绑定与本地记录不一致")
    if (binding.kind === "dm" && binding.state === "active") {
      const owner = this.rows("SELECT realm,principal FROM bot_im_personal_owners WHERE bot_id=?", [
        binding.botId
      ])[0]
      // A locally created binding proves that the user chose this Bot in the new
      // environment. Listing an unknown remote binding alone cannot migrate it.
      if (owner && (owner.realm === realm ? owner.principal !== principal : !old))
        throw new BotError("CONFLICT", "此 Bot 的个人主会话已关联另一登录身份，请使用该身份连接。")
      this.db.run(
        `INSERT INTO bot_im_personal_owners VALUES(?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET realm=excluded.realm,principal=excluded.principal`,
        [binding.botId, realm, principal]
      )
      this.db.run("INSERT OR IGNORE INTO bot_im_personal_links VALUES(?,?,?)", [
        id,
        binding.botId,
        Date.now()
      ])
    }
    this.db.run(
      "INSERT INTO bot_im_routes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET binding_json=excluded.binding_json",
      [id, realm, principal, binding.botId, JSON.stringify(binding)]
    )
    return { id, realm, principal, binding }
  }
  /** Remove only the local configuration entry; retain routing proofs and conversation history. */
  removeBinding(botId: string, id: string): void {
    const route = this.binding(id)
    if (!route || route.binding.botId !== botId)
      throw new BotError("NOT_FOUND", "绑定不属于当前 Bot")
    if (!["revoked", "expired"].includes(route.binding.state))
      throw new BotError("CONFLICT", "只能删除已撤销或已过期的接入记录")
    this.db.run("INSERT OR IGNORE INTO bot_im_removed_bindings(binding_id) VALUES(?)", [id])
  }
  visibleBindings(realm: string, principal: string, bindings: BotImBinding[]): BotImBinding[] {
    if (!bindings.length) return bindings
    const ids = bindings.map((binding) => botImScopeId(realm, principal, binding.id))
    const removed = new Set(
      this.rows(
        `SELECT binding_id FROM bot_im_removed_bindings WHERE binding_id IN (${ids.map(() => "?").join(",")})`,
        ids
      ).map((row) => String(row.binding_id))
    )
    // A newer live binding must remain visible even if an earlier expired snapshot was removed.
    return bindings.filter(
      (binding, index) =>
        !["revoked", "expired"].includes(binding.state) || !removed.has(ids[index])
    )
  }
  // Historical proofs remain valid across environments; outbound delivery still
  // requires the current owner below and the original binding's active grant.
  isPersonalBinding(id: string): boolean {
    return (
      this.rows(
        `SELECT 1 FROM bot_im_personal_links l JOIN bot_im_routes r ON r.id=l.binding_id
      WHERE l.binding_id=? AND json_extract(r.binding_json,'$.kind')='dm'`,
        [id]
      ).length > 0
    )
  }
  /** Capture only a binding already linked when this local turn was accepted. No history backfill. */
  personalBinding(botId: string, acceptedAt: number): StoredBotImBinding | null {
    const rows = this.rows(
      `SELECT r.id FROM bot_im_personal_links l JOIN bot_im_routes r ON r.id=l.binding_id
      JOIN bot_im_bindings b ON b.id=r.id AND b.revoked=0
      JOIN bot_im_personal_owners o ON o.bot_id=r.bot_id AND o.realm=r.realm AND o.principal=r.principal
      WHERE l.bot_id=? AND l.activated_at<=? AND json_extract(r.binding_json,'$.kind')='dm'
      AND json_extract(r.binding_json,'$.state')='active'
      AND b.grant_version=json_extract(r.binding_json,'$.version') LIMIT 2`,
      [botId, acceptedAt]
    )
    // A transient conflicting route must never fan private messages out to multiple destinations.
    return rows.length === 1 ? this.binding(String(rows[0].id)) : null
  }
  personalStatuses(): Array<{ botId: string; connected: boolean }> {
    return this.rows(
      `SELECT r.bot_id,MIN(b.online) AS online FROM bot_im_personal_links l
      JOIN bot_im_routes r ON r.id=l.binding_id JOIN bot_im_bindings b ON b.id=r.id
      JOIN bot_im_personal_owners o ON o.bot_id=r.bot_id AND o.realm=r.realm AND o.principal=r.principal
      WHERE b.revoked=0 AND json_extract(r.binding_json,'$.state')='active'
      GROUP BY r.bot_id HAVING COUNT(*)=1`
    ).map((row) => ({ botId: String(row.bot_id), connected: Boolean(row.online) }))
  }
  groupConversations(): BotImConversation[] {
    // One local metadata query; no network calls or transcript scans per sidebar row.
    return this.rows(
      `SELECT r.id,r.bot_id,json_extract(r.binding_json,'$.id') AS binding_id,
        json_extract(r.binding_json,'$.peerLabel') AS title,b.revoked,b.online,b.created_at,
        a.version,a.updated_at,a.preview,a.attention_version,a.seen_version,c.thread_id
       FROM bot_im_routes r JOIN bot_im_bindings b ON b.id=r.id
       JOIN bots bot ON bot.id=r.bot_id
       LEFT JOIN bot_activity a ON a.kind='im' AND a.id=r.id
       LEFT JOIN bot_im_conversations c ON c.binding_id=r.id AND c.bot_id=r.bot_id
       WHERE b.kind='group'
       ORDER BY COALESCE(a.updated_at,b.created_at) DESC,r.id`
    ).map((row) => ({
      id: String(row.id),
      botId: String(row.bot_id),
      bindingId: String(row.binding_id),
      ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
      title: String(row.title || "招乎群聊"),
      state: row.revoked ? "revoked" : "active",
      connected: !row.revoked && Boolean(row.online),
      activity: {
        kind: "im",
        id: String(row.id),
        version: Number(row.version ?? 0),
        updatedAt: Number(row.updated_at ?? row.created_at),
        preview: String(row.preview ?? ""),
        unread: Number(row.attention_version ?? 0) > Number(row.seen_version ?? 0)
      }
    }))
  }
  binding(id: string): StoredBotImBinding | null {
    const row = this.rows("SELECT * FROM bot_im_routes WHERE id=?", [id])[0]
    return row
      ? {
          id,
          realm: String(row.realm),
          principal: String(row.principal),
          binding: JSON.parse(String(row.binding_json))
        }
      : null
  }
  botIds(realm: string, principal: string): string[] {
    return this.rows(
      "SELECT DISTINCT bot_id FROM bot_im_routes WHERE realm=? AND principal=? ORDER BY bot_id",
      [realm, principal]
    ).map((row) => String(row.bot_id))
  }
  replacement(bindingId: string): BotImReplacement | undefined {
    const row = this.rows("SELECT target_json FROM bot_im_replacements WHERE binding_id=?", [
      bindingId
    ])[0]
    return row ? JSON.parse(String(row.target_json)) : undefined
  }
  rememberReplacement(bindingId: string, target: BotImReplacement): void {
    const value = JSON.stringify({
      botId: target.botId,
      bindingId: target.bindingId,
      version: target.version
    })
    this.db.run("INSERT OR IGNORE INTO bot_im_replacements VALUES(?,?)", [bindingId, value])
    const saved = this.replacement(bindingId)!
    if (
      saved.botId !== target.botId ||
      saved.bindingId !== target.bindingId ||
      saved.version !== target.version
    )
      throw new BotError("CONFLICT", "同一绑定指令的替换目标已确定，请重新生成指令。")
  }
  hasRoute(realm: string, principal: string, conversation: string): boolean {
    return (
      this.rows(
        "SELECT id FROM bot_im_routes WHERE realm=? AND principal=? AND json_extract(binding_json,'$.state')='active' AND json_extract(binding_json,'$.conversationKey')=? LIMIT 1",
        [realm, principal, conversation]
      ).length > 0
    )
  }
  receive(realm: string, principal: string, payload: BotImEvent): StoredBotImEvent {
    const bindingId = botImScopeId(realm, principal, payload.route.bindingId),
      route = this.binding(bindingId)
    if (
      !route ||
      payload.event.principalId !== principal ||
      route.binding.botId !== payload.route.botId ||
      route.binding.kind !== payload.route.kind ||
      route.binding.version !== payload.route.version ||
      !["pending", "active"].includes(route.binding.state) ||
      (route.binding.conversationKey &&
        route.binding.conversationKey !== payload.event.conversationKey)
    )
      throw new BotError("CONFLICT", "此 IM 绑定未在本机授权，或授权已变化")
    const id = botImScopeId(realm, principal, payload.event.eventId)
    const { lease: _lease, redelivered: _redelivered, ...event } = payload.event
    const fingerprint = botImScopeId(JSON.stringify({ event, route: payload.route }))
    const old = this.rows("SELECT * FROM bot_im_ingress WHERE id=?", [id])[0]
    if (old && old.fingerprint !== fingerprint)
      throw new BotError("CONFLICT", "IM 事件标识对应不同内容")
    this.db.run(
      "INSERT OR IGNORE INTO bot_im_ingress(id,binding_id,payload_json,fingerprint,state,lease_id,expires_at,task_id) VALUES(?,?,?,?,'received',?,0,NULL)",
      [id, bindingId, JSON.stringify(payload), fingerprint, payload.event.lease.id]
    )
    this.db.run("UPDATE bot_im_ingress SET lease_id=? WHERE id=?", [payload.event.lease.id, id])
    return this.event(id)!
  }
  event(id: string): StoredBotImEvent | null {
    const row = this.rows("SELECT * FROM bot_im_ingress WHERE id=?", [id])[0]
    return row
      ? {
          id,
          bindingId: String(row.binding_id),
          payload: JSON.parse(String(row.payload_json)),
          state: row.state as StoredBotImEvent["state"],
          leaseId: String(row.lease_id),
          expiresAt: Number(row.expires_at),
          taskId: row.task_id == null ? null : String(row.task_id)
        }
      : null
  }
  active(): StoredBotImEvent[] {
    return this.rows("SELECT id FROM bot_im_ingress WHERE state='active' ORDER BY id LIMIT 40").map(
      (row) => this.event(String(row.id))!
    )
  }
  settle(id: string, state: StoredBotImEvent["state"], taskId?: string, expiresAt?: number): void {
    this.db.run(
      "UPDATE bot_im_ingress SET state=?,task_id=COALESCE(?,task_id),expires_at=COALESCE(?,expires_at),needs_ack=? WHERE id=?",
      [
        state,
        taskId ?? null,
        expiresAt ?? null,
        ["completed", "failed", "unknown"].includes(state) ? 1 : 0,
        id
      ]
    )
  }
  pendingAcknowledgements(realm: string, principal: string): StoredBotImEvent[] {
    return this.rows(
      "SELECT e.id FROM bot_im_ingress e JOIN bot_im_routes r ON r.id=e.binding_id WHERE e.needs_ack=1 AND r.realm=? AND r.principal=? ORDER BY e.id LIMIT 40",
      [realm, principal]
    ).map((row) => this.event(String(row.id))!)
  }
  acknowledged(id: string): void {
    this.db.run("UPDATE bot_im_ingress SET needs_ack=0 WHERE id=?", [id])
  }
  pendingTasks(eventId: string): string[] {
    return this.rows(
      "SELECT id FROM bot_tasks WHERE json_extract(mock_source_json,'$.transport')='im' AND json_extract(mock_source_json,'$.eventId')=? AND state IN ('queued','running','waiting_user') AND NOT EXISTS(SELECT 1 FROM bot_im_local_execution l WHERE l.task_id=bot_tasks.id) ORDER BY created_at LIMIT 40",
      [eventId]
    ).map((row) => String(row.id))
  }
  settledTaskOutcome(eventId: string): "completed" | "failed" | "unknown" {
    const row = this.rows(
      "SELECT state FROM bot_tasks WHERE json_extract(mock_source_json,'$.transport')='im' AND json_extract(mock_source_json,'$.eventId')=? AND state IN ('failed','cancelled','interrupted','outcome_unknown') AND NOT EXISTS(SELECT 1 FROM bot_im_local_execution l WHERE l.task_id=bot_tasks.id) ORDER BY (state='outcome_unknown') DESC LIMIT 1",
      [eventId]
    )[0]
    return row?.state === "outcome_unknown" ? "unknown" : row ? "failed" : "completed"
  }
  hasLiveBindings(botId: string): boolean {
    return (
      this.rows(
        "SELECT 1 FROM bot_im_routes WHERE bot_id=? AND (json_extract(binding_json,'$.state')='active' OR (json_extract(binding_json,'$.state')='pending' AND julianday(json_extract(binding_json,'$.expiresAt'))>julianday(?))) LIMIT 1",
        [botId, new Date().toISOString()]
      ).length > 0
    )
  }
  removeBot(botId: string): void {
    this.db.run(
      "DELETE FROM bot_im_replacements WHERE binding_id IN (SELECT id FROM bot_im_routes WHERE bot_id=?)",
      [botId]
    )
    this.db.run(
      "DELETE FROM bot_im_continuations WHERE owner_bot_id=? OR task_id IN (SELECT id FROM bot_tasks WHERE bot_id=?)",
      [botId, botId]
    )
    this.db.run("DELETE FROM bot_im_personal_links WHERE bot_id=?", [botId])
    this.db.run("DELETE FROM bot_im_personal_owners WHERE bot_id=?", [botId])
    this.db.run(
      "DELETE FROM bot_im_local_execution WHERE task_id IN (SELECT id FROM bot_tasks WHERE bot_id=?)",
      [botId]
    )
    this.db.run(
      "DELETE FROM bot_im_ingress WHERE binding_id IN (SELECT id FROM bot_im_routes WHERE bot_id=?)",
      [botId]
    )
    this.db.run(
      "DELETE FROM bot_im_removed_bindings WHERE binding_id IN (SELECT id FROM bot_im_routes WHERE bot_id=?)",
      [botId]
    )
    this.db.run("DELETE FROM bot_im_routes WHERE bot_id=?", [botId])
  }
}
