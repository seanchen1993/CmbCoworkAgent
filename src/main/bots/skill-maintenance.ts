import { BotDomainError } from "../../shared/bot-types"
import {
  botSkillMaintenanceAddress,
  botSkillMaintenanceChange,
  botSkillMaintenancePolicyInput,
  botSkillMaintenanceRun,
  type BotSkillMaintenanceEntry,
  type BotSkillMaintenancePolicy,
  type BotSkillMaintenanceResult,
  type BotSkillMaintenanceView
} from "../../shared/bot-skill-maintenance"
import type { NativeSqliteBindings } from "../db/native-sqlite-adapter"
import type { BotStore } from "./store"

const DAY = 86_400_000
const INTERVAL = 7 * DAY
const MIN_IDLE = 2 * 3_600_000
const ACTIVE_WORK = `EXISTS(SELECT 1 FROM bot_runs r WHERE r.bot_id=b.id AND r.status IN ('queued','running','waiting_input','cancelling','needs_review'))
  OR EXISTS(SELECT 1 FROM bot_teach_sessions t WHERE t.bot_id=b.id AND t.phase IN ('recording','paused','finalizing'))
  OR EXISTS(SELECT 1 FROM bot_runs r JOIN bot_shell_jobs j ON j.run_id=r.id
    JOIN bot_shell_services s ON s.job_id=j.id WHERE r.bot_id=b.id AND j.status IN ('queued','running','cancelling'))`
const DEFAULT_POLICY: BotSkillMaintenancePolicy = {
  revision: 0,
  enabled: false,
  staleAfterDays: 14,
  archiveAfterDays: 30,
  lastRunAt: null
}
type Row = Record<string, unknown>
type Receipt = <T>(nonce: string, request: unknown, operation: () => T) => T

/** Adapted from Hermes' curator: explicit managed scope, pinned protection,
 * inactivity-based maintenance and reversible archive. Uses the existing Host's
 * transaction/receipt boundary; no second agent, timer, database or file writer.
 * Historical/imported skills receive no automatic-management permission.
 */
export class BotSkillMaintenance {
  private nextCheckAt = 0
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private rows(sql: string, params: NativeSqliteBindings = []): Row[] {
    const result = this.store.db.exec(sql, params)[0]
    return (result?.values ?? []).map((values) =>
      Object.fromEntries(result!.columns.map((key, i) => [key, values[i]]))
    )
  }
  private policy(botId: string): BotSkillMaintenancePolicy {
    const row = this.rows("SELECT * FROM bot_skill_maintenance_policy WHERE bot_id=?", [botId])[0]
    return row
      ? {
          revision: Number(row.revision),
          enabled: Boolean(row.enabled),
          staleAfterDays: Number(row.stale_days),
          archiveAfterDays: Number(row.archive_days),
          lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at)
        }
      : { ...DEFAULT_POLICY }
  }
  private check(botId: string, dataEpoch: string): void {
    this.store.assertMutationEpoch(dataEpoch)
    this.store.getBot(botId)
  }
  private state(skillId: string): Row | undefined {
    return this.rows("SELECT * FROM bot_skill_maintenance WHERE skill_id=?", [skillId])[0]
  }
  private busy(botId: string): boolean {
    return this.rows(`SELECT 1 FROM bots b WHERE b.id=? AND (${ACTIVE_WORK})`, [botId]).length > 0
  }
  private protections(botId: string): { busy: boolean; bound: Set<string> } {
    const bound = this.rows(
      `SELECT DISTINCT json_extract(ref.value,'$.id') AS skill_id FROM bot_routines r
      JOIN bot_routine_skills s ON s.routine_id=r.id JOIN json_each(s.refs) ref
      WHERE r.bot_id=? AND (r.enabled=1 OR r.desired_enabled=1)
      `,
      [botId]
    )
    return { busy: this.busy(botId), bound: new Set(bound.map((row) => String(row.skill_id))) }
  }
  private privateSkills(
    botId: string,
    query: { id?: string; after?: string; limit?: number } = {}
  ): Row[] {
    return this.rows(
      `SELECT s.id,s.name,s.version,s.enabled,s.created_at,
      m.revision,m.managed,m.pinned,m.managed_since,m.archived_version,m.use_count,m.last_used_at
      FROM bot_skills s LEFT JOIN bot_skill_maintenance m ON m.skill_id=s.id
      WHERE s.bot_id=? AND s.version=(SELECT MAX(v.version) FROM bot_skills v WHERE v.id=s.id)
      AND NOT EXISTS(SELECT 1 FROM bot_skill_tombstones t WHERE t.skill_id=s.id)
      ${query.id === undefined ? "" : "AND s.id=?"}
      ${query.after === undefined ? "" : "AND s.id>?"}
      ORDER BY s.id LIMIT ?`,
      [
        botId,
        ...(query.id === undefined ? [] : [query.id]),
        ...(query.after === undefined ? [] : [query.after]),
        query.limit ?? 101
      ]
    )
  }
  private entry(
    row: Row,
    policy: BotSkillMaintenancePolicy,
    protection: ReturnType<BotSkillMaintenance["protections"]>
  ): BotSkillMaintenanceEntry {
    const baseline = Math.max(
      Number(row.created_at),
      Number(row.managed_since ?? 0),
      Number(row.last_used_at ?? 0)
    )
    return {
      skillId: String(row.id),
      name: String(row.name),
      version: Number(row.version),
      revision: Number(row.revision ?? 0),
      managed: Boolean(row.managed),
      pinned: Boolean(row.pinned),
      archived: row.archived_version === row.version,
      stale: Boolean(row.managed) && this.store.now() - baseline >= policy.staleAfterDays * DAY,
      useCount: Number(row.use_count ?? 0),
      lastUsedAt:
        row.last_used_at === null || row.last_used_at === undefined
          ? null
          : Number(row.last_used_at),
      protectedReason: row.pinned
        ? "已固定保留"
        : protection.busy
          ? "此 Bot 仍有未完成任务"
          : protection.bound.has(String(row.id))
            ? "例程正在引用此技能"
            : null
    }
  }
  view(raw: unknown): BotSkillMaintenanceView {
    const input = botSkillMaintenanceAddress.parse(raw)
    this.check(input.botId, input.expectedDataEpoch)
    const policy = this.policy(input.botId)
    const protection = this.protections(input.botId)
    if (
      input.after !== undefined &&
      !this.privateSkills(input.botId, { id: input.after, limit: 1 }).length
    )
      throw new BotDomainError("history_cursor", "技能分页位置已变化，请刷新列表")
    const rows = this.privateSkills(input.botId, { after: input.after, limit: input.limit + 1 })
    return {
      policy,
      entries: rows.slice(0, input.limit).map((row) => this.entry(row, policy, protection)),
      next: rows.length > input.limit ? String(rows[input.limit - 1].id) : null
    }
  }
  configure(raw: unknown): BotSkillMaintenancePolicy {
    const input = botSkillMaintenancePolicyInput.parse(raw)
    this.check(input.botId, input.expectedDataEpoch)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "skill.maintenance.policy", ...input }, () => {
        const current = this.policy(input.botId)
        if (current.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "技能维护设置已变化，请刷新后重试")
        // Enabling starts a new observation window rather than retroactively retiring old skills.
        const now = this.store.now()
        this.store.db.run(
          `INSERT INTO bot_skill_maintenance_policy VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,
        stale_days=excluded.stale_days,archive_days=excluded.archive_days,
        configured_at=excluded.configured_at,last_run_at=excluded.last_run_at`,
          [
            input.botId,
            current.revision + 1,
            input.enabled,
            input.staleAfterDays,
            input.archiveAfterDays,
            now,
            current.lastRunAt
          ]
        )
        this.event("skill.maintenance_policy", input.botId, { enabled: input.enabled })
        return this.policy(input.botId)
      })
    )
  }
  change(raw: unknown): BotSkillMaintenanceEntry {
    const input = botSkillMaintenanceChange.parse(raw)
    this.check(input.botId, input.expectedDataEpoch)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "skill.maintenance.change", ...input }, () => {
        const row = this.privateSkills(input.botId, { id: input.skillId, limit: 1 })[0]
        if (!row) throw new BotDomainError("skill_scope", "只能维护此 Bot 的私有技能")
        if (row.version !== input.version || Number(row.revision ?? 0) !== input.revision)
          throw new BotDomainError("revision_conflict", "技能或维护状态已变化，请刷新后重试")
        if (input.action === "archive") {
          const reason = this.entry(
            row,
            this.policy(input.botId),
            this.protections(input.botId)
          ).protectedReason
          if (reason) throw new BotDomainError("skill_protected", reason)
        }
        const now = this.store.now()
        this.store.db.run(
          `INSERT INTO bot_skill_maintenance VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,managed=excluded.managed,
        pinned=excluded.pinned,managed_since=excluded.managed_since,archived_version=excluded.archived_version`,
          [
            input.skillId,
            input.botId,
            input.revision + 1,
            input.action === "manage"
              ? 1
              : input.action === "unmanage"
                ? 0
                : Number(row.managed ?? 0),
            input.action === "pin" ? 1 : input.action === "unpin" ? 0 : Number(row.pinned ?? 0),
            input.action === "manage" || input.action === "restore"
              ? now
              : Number(row.managed_since ?? now),
            input.action === "archive"
              ? input.version
              : input.action === "restore"
                ? null
                : (row.archived_version ?? null),
            Number(row.use_count ?? 0),
            row.last_used_at ?? null
          ]
        )
        this.event(`skill.${input.action}`, input.skillId, {
          botId: input.botId,
          version: input.version
        })
        return this.entry(
          this.privateSkills(input.botId, { id: input.skillId, limit: 1 })[0],
          this.policy(input.botId),
          this.protections(input.botId)
        )
      })
    )
  }
  isArchived(skillId: string, version: number): boolean {
    return this.state(skillId)?.archived_version === version
  }
  /** Count a skill once per task, refresh activity on every actual read.
   * Queue admission can
   * pre-bind run skills before execution; those references are not usage receipts.
   * Receipts share the original transaction and cascade with run retention.
   */
  recordUse(runId: string, skillId: string): void {
    const run = this.store.getRun(runId)
    const skill = this.rows("SELECT 1 FROM bot_skills WHERE id=? AND bot_id=? LIMIT 1", [
      skillId,
      run.botId
    ])
    if (!skill.length) return
    const now = this.store.now()
    this.store.db.run("INSERT OR IGNORE INTO bot_skill_use_receipts VALUES(?,?)", [runId, skillId])
    if (!Number(this.store.db.exec("SELECT changes()")[0].values[0][0])) {
      // Long-running tasks may revisit a skill much later. Deduplicate counts,
      // not activity; equal timestamps do not cause extra durable row writes.
      this.store.db.run(
        "UPDATE bot_skill_maintenance SET last_used_at=? WHERE skill_id=? AND COALESCE(last_used_at,0)<?",
        [now, skillId, now]
      )
      return
    }
    this.store.db.run(
      `INSERT INTO bot_skill_maintenance VALUES(?,?,0,0,0,?,NULL,1,?)
      ON CONFLICT(skill_id) DO UPDATE SET use_count=MIN(use_count+1,9007199254740991),
      last_used_at=MAX(COALESCE(last_used_at,0),excluded.last_used_at)`,
      [skillId, run.botId, now, now]
    )
  }
  private maintain(botId: string): BotSkillMaintenanceResult {
    const policy = this.policy(botId),
      now = this.store.now()
    const result: BotSkillMaintenanceResult = {
      archivedIds: [],
      protectedIds: [],
      checkedAt: now,
      hasMore: false
    }
    const busy = this.busy(botId)
    const configuredAt = Number(
      this.rows("SELECT configured_at FROM bot_skill_maintenance_policy WHERE bot_id=?", [botId])[0]
        ?.configured_at ?? 0
    )
    const cutoff = now - policy.archiveAfterDays * DAY
    if (configuredAt <= cutoff) {
      const eligible = `FROM bot_skill_maintenance m JOIN bot_skills s ON s.id=m.skill_id
        WHERE m.bot_id=? AND m.managed=1 AND s.enabled=1
        AND s.version=(SELECT MAX(v.version) FROM bot_skills v WHERE v.id=s.id)
        AND (m.archived_version IS NULL OR m.archived_version<>s.version)
        AND MAX(s.created_at,m.managed_since,COALESCE(m.last_used_at,0))<=?
        AND NOT EXISTS(SELECT 1 FROM bot_skill_tombstones t WHERE t.skill_id=s.id)`
      // Correlate in SQLite instead of expanding every routine reference into
      // a JS array/IN list; both memory and the SQL binding count stay bounded.
      const boundSql = `EXISTS(SELECT 1 FROM bot_routines r
        JOIN bot_routine_skills rs ON rs.routine_id=r.id JOIN json_each(rs.refs) ref
        WHERE r.bot_id=m.bot_id AND (r.enabled=1 OR r.desired_enabled=1)
        AND json_extract(ref.value,'$.id')=s.id)`
      result.protectedIds = this.rows(
        `SELECT s.id ${eligible} AND (m.pinned=1 OR ? OR ${boundSql}) ORDER BY s.id LIMIT 200`,
        [botId, cutoff, busy]
      ).map((row) => String(row.id))
      const candidates = busy
        ? []
        : this.rows(
            `SELECT s.id,s.version ${eligible} AND m.pinned=0 AND NOT (${boundSql}) ORDER BY s.id LIMIT 201`,
            [botId, cutoff]
          )
      result.hasMore = candidates.length > 200
      for (const row of candidates.slice(0, 200)) {
        this.store.db.run(
          "UPDATE bot_skill_maintenance SET archived_version=?,revision=revision+1 WHERE skill_id=?",
          [row.version, row.id]
        )
        result.archivedIds.push(String(row.id))
        this.event("skill.archived", String(row.id), {
          botId,
          version: row.version,
          source: "maintenance"
        })
      }
    }
    // A partial automatic pass remains due; the next bounded heartbeat drains
    // remaining eligible skills. Protected skills cannot starve later candidates.
    if (!result.hasMore)
      this.store.db.run("UPDATE bot_skill_maintenance_policy SET last_run_at=? WHERE bot_id=?", [
        now,
        botId
      ])
    return result
  }
  run(raw: unknown): BotSkillMaintenanceResult {
    const input = botSkillMaintenanceRun.parse(raw)
    this.check(input.botId, input.expectedDataEpoch)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "skill.maintenance.run", ...input }, () => {
        this.store.db.run(
          "INSERT OR IGNORE INTO bot_skill_maintenance_policy VALUES(?,0,0,14,30,0,NULL)",
          [input.botId]
        )
        return this.maintain(input.botId)
      })
    )
  }
  /** Host-owned idle sweep. At most five profiles per minute; disabled profiles
   * receive no writes or model calls. The weekly schedule survives restarts.
   */
  tick(): void {
    const now = this.store.now()
    if (now < this.nextCheckAt && this.nextCheckAt - now <= 60_000) return
    this.nextCheckAt = now + 60_000
    const due = this.rows(
      `SELECT p.* FROM bot_skill_maintenance_policy p JOIN bots b ON b.id=p.bot_id
      WHERE p.enabled=1 AND b.deleted_at IS NULL
      AND MAX(p.configured_at,COALESCE(p.last_run_at,p.configured_at))<=?
      AND NOT (${ACTIVE_WORK})
      AND MAX(p.configured_at,COALESCE((SELECT r.updated_at FROM bot_runs r WHERE r.bot_id=p.bot_id ORDER BY r.updated_at DESC LIMIT 1),0))<=?
      ORDER BY p.last_run_at,p.bot_id LIMIT 5`,
      [now - INTERVAL, now - MIN_IDLE]
    )
    for (const row of due) {
      const botId = String(row.bot_id)
      if (this.busy(botId)) continue
      const activity = this.rows(
        "SELECT updated_at FROM bot_runs WHERE bot_id=? ORDER BY updated_at DESC LIMIT 1",
        [botId]
      )[0]
      if (now - Math.max(Number(row.configured_at), Number(activity?.updated_at ?? 0)) < MIN_IDLE)
        continue
      this.store.transaction(() => this.maintain(botId))
    }
  }
}
