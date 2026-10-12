import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  BOT_SKILL_LIBRARY_LIMIT,
  BOT_SKILL_LIBRARY_BYTES,
  botPublishSkill,
  botWithdrawSkill,
  botSkillEnablement,
  type BotSkillEnablementReceipt,
  type BotLibrarySkill
} from "../../shared/bot-skill-library"
import { BotDomainError, type BotSkill, type BotSkillSummary } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotSaveSkillInput } from "../../shared/bot-skill-save"

const record = z.object({
  id: z.string(),
  source_bot_id: z.string(),
  source_skill_id: z.string(),
  source_version: z.number().int(),
  name: z.string(),
  instructions: z.string(),
  revision: z.number().int(),
  enabled: z.number(),
  updated_at: z.number()
})
type Receipt = <T>(nonce: string, request: unknown, operation: () => T) => T

export const BOT_USER_SKILL_HISTORY_VERSIONS = 16_384
export const BOT_USER_SKILL_HISTORY_BYTES = 32 * 1024 * 1024

/** User-owned library, following Grok's GlobalWorkflowLibrary/sourceRef separation.
 * Authored definitions are shared once; legacy private publications remain snapshots.
 * Reuses the Host's transactions/receipts instead of a second filesystem writer.
 * Runs, Teach recordings, credentials and approvals remain separate from definitions.
 */
export class BotSkillLibrary {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly cancel: (runId: string) => unknown
  ) {}

  list(): BotLibrarySkill[] {
    const result = this.store.db.exec(
      "SELECT s.*,u.skill_id AS authored FROM bot_skill_library s LEFT JOIN bot_user_skills u ON u.skill_id=s.id WHERE s.enabled=1 ORDER BY updated_at,id"
    )[0]
    return (result?.values ?? []).map((values) => {
      const row = record.parse(
        Object.fromEntries(result!.columns.map((key, i) => [key, values[i]]))
      )
      return {
        id: row.id,
        sourceBotId: row.source_bot_id,
        sourceSkillId: row.source_skill_id,
        sourceVersion: row.source_version,
        name: row.name,
        instructions: row.instructions,
        revision: row.revision,
        enabled: Boolean(row.enabled),
        updatedAt: row.updated_at,
        ...(values[result!.columns.indexOf("authored")] ? { kind: "authored" as const } : {})
      }
    })
  }

  /** One immutable definition per local user; Bot identity is provenance, not ownership. */
  saveUser(input: BotSaveSkillInput): BotSkill {
    this.store.getBot(input.botId)
    const old = input.id ? this.list().find((item) => item.id === input.id) : undefined
    if (input.id && (!old?.enabled || old.kind !== "authored" || old.revision !== input.version))
      throw new BotDomainError("revision_conflict", "共享技能已更新、删除或不可编辑，请重新查看")
    const id = old?.id ?? `library:${randomUUID()}`
    const enabled = this.enablement(input.botId, id)
    if (old && input.enabled !== enabled.enabled)
      throw new BotDomainError("revision_conflict", "此 Bot 的启用状态已变化，请重新查看")
    const item: BotLibrarySkill = {
      id,
      sourceBotId: old?.sourceBotId ?? input.botId,
      sourceSkillId: old?.sourceSkillId ?? id,
      sourceVersion: (old?.revision ?? 0) + 1,
      name: input.name,
      instructions: input.instructions,
      revision: (old?.revision ?? 0) + 1,
      enabled: true,
      updatedAt: this.store.now(),
      kind: "authored"
    }
    const active = this.list().filter((value) => value.enabled && value.id !== id)
    if (
      active.length >= BOT_SKILL_LIBRARY_LIMIT ||
      Buffer.byteLength(JSON.stringify([...active, item]), "utf8") > BOT_SKILL_LIBRARY_BYTES
    )
      throw new BotDomainError("skill_library_limit", "我的技能库已达到数量或 4 MiB 容量上限")
    // Updated by SQLite triggers in this transaction, including rollback/replay.
    // Charge every immutable field; a separate row cap bounds index/row overhead.
    const usage = this.store.db.exec(
      "SELECT versions,payload_bytes FROM bot_user_skill_history_usage WHERE id=1"
    )[0]?.values[0]
    const versionBytes = [id, input.name, input.instructions].reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      16
    )
    if (
      !usage ||
      Number(usage[0]) >= BOT_USER_SKILL_HISTORY_VERSIONS ||
      Number(usage[1]) + versionBytes > BOT_USER_SKILL_HISTORY_BYTES
    )
      throw new BotDomainError(
        "skill_library_limit",
        "技能历史已达到 16,384 版或 32 MiB 定义数据上限，无法继续保存新版本"
      )
    this.store.db.run(
      `INSERT INTO bot_skill_library VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,name=excluded.name,
      instructions=excluded.instructions,revision=excluded.revision,updated_at=excluded.updated_at`,
      [
        id,
        item.sourceBotId,
        item.sourceSkillId,
        item.sourceVersion,
        item.name,
        item.instructions,
        item.revision,
        1,
        item.updatedAt,
        old?.updatedAt ?? item.updatedAt
      ]
    )
    this.store.db.run("INSERT OR IGNORE INTO bot_user_skills VALUES(?,?)", [id, item.updatedAt])
    this.store.db.run("INSERT INTO bot_user_skill_versions VALUES(?,?,?,?,?)", [
      id,
      item.revision,
      item.name,
      item.instructions,
      item.updatedAt
    ])
    if (!old && !input.enabled)
      this.store.db.run("INSERT INTO bot_skill_enablement VALUES(?,?,0,1)", [input.botId, id])
    if (old) this.revokeReferences(id)
    this.event("skill.user_saved", id, { botId: input.botId, version: item.revision })
    return this.project(input.botId, item)
  }

  private enablement(botId: string, id: string): { enabled: boolean; revision: number } {
    const value = this.store.db.exec(
      "SELECT enabled,revision FROM bot_skill_enablement WHERE bot_id=? AND skill_id=?",
      [botId, id]
    )[0]?.values[0]
    return { enabled: value ? Boolean(value[0]) : true, revision: value ? Number(value[1]) : 0 }
  }

  private project(botId: string, item: BotLibrarySkill): BotSkill {
    const state = this.enablement(botId, item.id)
    return {
      id: item.id,
      botId,
      name: item.name,
      instructions: item.instructions,
      version: item.revision,
      enabled: item.enabled && state.enabled,
      verified: this.verified(botId, item.id, item.revision),
      createdAt: item.updatedAt,
      scope: "user",
      userEditable: item.kind === "authored",
      enablementRevision: state.revision
    }
  }

  setEnabled(raw: unknown): BotSkillEnablementReceipt {
    const input = botSkillEnablement.parse(raw)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "skill.enablement", ...input }, () => {
        this.store.assertMutationEpoch(input.expectedDataEpoch)
        this.store.getBot(input.botId)
        const item = this.list().find((value) => value.id === input.id)
        const state = this.enablement(input.botId, input.id)
        if (!item?.enabled || item.revision !== input.version || state.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "技能或启用状态已变化，请重新查看")
        const revision = state.revision + 1
        this.store.db.run(
          `INSERT INTO bot_skill_enablement VALUES(?,?,?,?)
        ON CONFLICT(bot_id,skill_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision`,
          [input.botId, input.id, Number(input.enabled), revision]
        )
        if (!input.enabled) this.revokeReferences(input.id, input.botId)
        this.event("skill.enablement_changed", input.id, {
          botId: input.botId,
          enabled: input.enabled,
          revision
        })
        return {
          botId: input.botId,
          id: input.id,
          version: input.version,
          revision,
          enabled: input.enabled
        }
      })
    )
  }

  private revokeReferences(id: string, botId?: string): void {
    this.store.db.run(
      `UPDATE bot_routines SET enabled=0,next_at=NULL,activation_required=1,revision=revision+1
      WHERE (? IS NULL OR bot_id=?) AND (enabled<>0 OR next_at IS NOT NULL OR activation_required<>1)
      AND id IN (SELECT routine_id FROM bot_routine_skills s,json_each(s.refs) ref WHERE json_extract(ref.value,'$.id')=?)`,
      [botId ?? null, botId ?? null, id]
    )
    // Preserve started/unknown effects while revoking each original run identity.
    // A subsequent re-enable must never restore an earlier run's authority (ABA).
    // Delegates inherit workflow authority without copying the parent's skill pins.
    // Include completed ancestors of live work, then revoke their exact owned
    // descendant identities across Bots and workflow children; unrelated work stays live.
    const runs =
      this.store.db.exec(
        `WITH RECURSIVE candidates AS (
        SELECT id FROM bot_runs WHERE status NOT IN ('succeeded','failed','cancelled')
        UNION SELECT j.run_id FROM bot_shell_jobs j JOIN bot_shell_services service ON service.job_id=j.id
          WHERE j.status IN ('queued','running','cancelling')),
      ancestors(id,parent_run_id,root_run_id,depth) AS (
        SELECT r.id,r.parent_run_id,r.root_run_id,r.depth FROM candidates c JOIN bot_runs r ON r.id=c.id
        UNION SELECT parent.id,parent.parent_run_id,parent.root_run_id,parent.depth
          FROM bot_runs parent JOIN ancestors child ON child.parent_run_id=parent.id
          WHERE child.root_run_id=parent.root_run_id AND child.depth=parent.depth+1),
      selected(id,root_run_id,depth) AS (
        SELECT r.id,r.root_run_id,r.depth FROM ancestors a JOIN bot_runs r ON r.id=a.id
        WHERE (? IS NULL OR r.bot_id=?) AND (
          EXISTS(SELECT 1 FROM bot_run_skills s WHERE s.run_id=r.id AND s.skill_id=?) OR
          EXISTS(SELECT 1 FROM bot_skill_trials t WHERE t.run_id=r.id AND t.skill_id=?) OR
          EXISTS(SELECT 1 FROM bot_message_skills s,json_each(s.refs) ref WHERE
            s.message_id IN(SELECT r.message_id UNION ALL SELECT message_id FROM bot_steering WHERE run_id=r.id)
            AND json_extract(ref.value,'$.id')=? AND json_extract(ref.value,'$.botId')=r.bot_id))),
      owned(id,root_run_id,depth) AS (
        SELECT id,root_run_id,depth FROM selected
        UNION SELECT child.id,child.root_run_id,child.depth FROM bot_runs child JOIN owned parent
          ON child.parent_run_id=parent.id AND child.root_run_id=parent.root_run_id
          WHERE child.depth=parent.depth+1)
      SELECT r.id,r.status FROM owned d JOIN bot_runs r ON r.id=d.id
      ORDER BY r.depth,r.created_at,r.id`,
        [botId ?? null, botId ?? null, id, id, id]
      )[0]?.values ?? []
    for (const [value, status] of runs) {
      const runId = String(value)
      this.store.db.run("INSERT OR IGNORE INTO bot_run_skill_revocations VALUES(?,?,?)", [
        runId,
        id,
        this.store.now()
      ])
      if (!["needs_review", "succeeded", "failed", "cancelled"].includes(String(status)))
        this.cancel(runId)
      const jobs =
        this.store.db.exec(
          `SELECT j.id FROM bot_shell_jobs j JOIN bot_shell_services service ON service.job_id=j.id
        WHERE j.run_id=? AND j.status IN ('queued','running','cancelling')`,
          [runId]
        )[0]?.values ?? []
      for (const [jobId] of jobs)
        this.store.shellJobs.requestStopInTransaction(runId, String(jobId))
    }
  }

  publish(raw: unknown): BotLibrarySkill {
    const input = botPublishSkill.parse(raw)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { operation: "publishSkill", ...input }, () => {
        const skill = this.store.skills(input.botId).find((item) => item.id === input.skillId)
        if (!skill?.enabled || skill.version !== input.version)
          throw new BotDomainError("skill_changed", "技能已修改或停用，请重新查看后共享")
        const items = this.list(),
          old = items.find((item) => item.sourceSkillId === skill.id)
        if ((old?.revision ?? 0) !== input.libraryRevision)
          throw new BotDomainError("revision_conflict", "共享版本已变化，请刷新后重试")
        if (!old?.enabled && items.filter((item) => item.enabled).length >= BOT_SKILL_LIBRARY_LIMIT)
          throw new BotDomainError("skill_library_limit", "共享技能库已达到数量上限")
        const saved: BotLibrarySkill = {
          id: old?.id ?? `library:${randomUUID()}`,
          sourceBotId: input.botId,
          sourceSkillId: skill.id,
          sourceVersion: skill.version,
          name: skill.name,
          instructions: skill.instructions,
          revision: (old?.revision ?? 0) + 1,
          enabled: true,
          updatedAt: this.store.now()
        }
        if (
          Buffer.byteLength(
            JSON.stringify([...items.filter((item) => item.id !== saved.id), saved]),
            "utf8"
          ) > BOT_SKILL_LIBRARY_BYTES
        )
          throw new BotDomainError(
            "skill_library_limit",
            "共享技能内容已达到 4 MiB 上限，请精简步骤或撤回不再使用的技能"
          )
        this.store.db.run(
          `INSERT INTO bot_skill_library VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,name=excluded.name,
        instructions=excluded.instructions,revision=excluded.revision,enabled=1,updated_at=excluded.updated_at`,
          [
            saved.id,
            saved.sourceBotId,
            saved.sourceSkillId,
            saved.sourceVersion,
            saved.name,
            saved.instructions,
            saved.revision,
            1,
            saved.updatedAt,
            saved.updatedAt
          ]
        )
        this.event("skill.published", saved.id, { revision: saved.revision })
        return saved
      })
    )
  }

  withdraw(raw: unknown): { id: string } {
    const input = botWithdrawSkill.parse(raw)
    return this.store.transaction(() =>
      this.receipt(input.nonce, { operation: "withdrawSkill", ...input }, () => {
        this.store.assertMutationEpoch(input.expectedDataEpoch)
        const old = this.list().find((item) => item.id === input.id)
        if (!old?.enabled || old.revision !== input.revision)
          throw new BotDomainError("revision_conflict", "共享版本已变化或已撤回，请刷新后重试")
        // References/receipts retain the old immutable identity. Republishing allocates a
        // new identity, so an old task cannot regain access even to identical instructions.
        if (old.kind === "authored")
          this.store.db.run("UPDATE bot_skill_library SET enabled=0 WHERE id=?", [input.id])
        else this.store.db.run("DELETE FROM bot_skill_library WHERE id=?", [input.id])
        if (old.kind === "authored") this.revokeReferences(input.id)
        this.event("skill.withdrawn", input.id, { revision: old.revision + 1 })
        return { id: input.id }
      })
    )
  }

  /** Evidence belongs to this Bot and exact version, not the shared source owner. */
  verified(botId: string, id: string, version: number): boolean {
    return !!this.store.db.exec(
      "SELECT 1 FROM bot_skill_trials WHERE bot_id=? AND skill_id=? AND version=? AND verdict='passed' LIMIT 1",
      [botId, id, version]
    )[0]?.values.length
  }

  verifiedVersions(botId: string): Set<string> {
    return new Set(
      (
        this.store.db.exec(
          "SELECT DISTINCT skill_id,version FROM bot_skill_trials WHERE bot_id=? AND verdict='passed'",
          [botId]
        )[0]?.values ?? []
      ).map(([id, version]) => `${id}@${version}`)
    )
  }

  available(botId: string): BotSkillSummary[] {
    this.store.getBot(botId)
    const verified = this.verifiedVersions(botId)
    const enabled = new Map(
      (
        this.store.db.exec(
          "SELECT skill_id,enabled,revision FROM bot_skill_enablement WHERE bot_id=?",
          [botId]
        )[0]?.values ?? []
      ).map(([id, value, revision]) => [
        String(id),
        { enabled: Boolean(value), revision: Number(revision) }
      ])
    )
    return [
      ...this.store.skills(botId),
      ...this.store.externalSkills.list(botId),
      ...this.list()
        .filter((item) => item.enabled)
        .map((item) => ({
          id: item.id,
          botId,
          name: item.name,
          instructions: item.instructions,
          version: item.revision,
          enabled: enabled.get(item.id)?.enabled ?? true,
          verified: verified.has(`${item.id}@${item.revision}`),
          createdAt: item.updatedAt,
          scope: "user" as const,
          userEditable: item.kind === "authored",
          enablementRevision: enabled.get(item.id)?.revision ?? 0
        }))
    ]
  }

  current(botId: string, id: string, version?: number): BotSkill {
    if (id.startsWith("desktop:")) return this.store.externalSkills.current(botId, id, version)
    this.store.getBot(botId)
    this.store.skillDeletion.assertPresent(botId, id)
    // Execution fences inspect one skill, not every instruction body in the library.
    const privateRow = this.store.db.exec(
      "SELECT version,enabled FROM bot_skills WHERE bot_id=? AND id=? ORDER BY version DESC LIMIT 1",
      [botId, id]
    )[0]?.values[0]
    let skill: BotSkill | undefined
    if (privateRow && this.store.skillMaintenance.isArchived(id, Number(privateRow[0])))
      // Archive is a reversible form of unavailability. Preserve the existing
      // classification used by routine readiness, pending writes and adapters.
      throw new BotDomainError("skill_unavailable", "技能已归档，请先在技能维护中恢复后使用")
    if (privateRow && privateRow[1])
      skill = this.store.skillVersion(botId, id, Number(privateRow[0]))
    else {
      const result = this.store.db.exec(
        "SELECT * FROM bot_skill_library WHERE id=? AND enabled=1",
        [id]
      )[0]
      if (result?.values[0]) {
        const item = record.parse(
          Object.fromEntries(result.columns.map((key, i) => [key, result.values[0][i]]))
        )
        skill = {
          id: item.id,
          botId,
          name: item.name,
          instructions: item.instructions,
          version: item.revision,
          enabled: true,
          verified: this.verified(botId, item.id, item.revision),
          createdAt: item.updated_at,
          scope: "user"
        }
      }
    }
    if (!skill) throw new BotDomainError("skill_unavailable", "技能已停用、撤回或不属于此 Bot")
    if (skill.scope === "user" && !this.enablement(botId, id).enabled)
      throw new BotDomainError("skill_unavailable", "此 Bot 已停用该技能")
    if (version !== undefined && skill.version !== version)
      throw new BotDomainError("skill_changed", "技能已有新版本，请确认后重新选择")
    return skill
  }

  readForRun(runId: string, id: string): BotSkill {
    const run = this.store.getRun(runId)
    return this.store.transaction(() => {
      const skill = this.current(run.botId, id)
      this.assertRun(runId)
      this.store.skillMaintenance.recordUse(runId, id)
      this.store.db.run("INSERT OR IGNORE INTO bot_run_skills VALUES(?,?,?)", [
        runId,
        id,
        skill.version
      ])
      return skill
    })
  }

  assertNotRevoked(runId: string): void {
    if (
      this.store.db.exec("SELECT 1 FROM bot_run_skill_revocations WHERE run_id=? LIMIT 1", [
        runId
      ])[0]?.values.length
    )
      throw new BotDomainError(
        "skill_unavailable",
        "此任务使用的技能已停用、修改或删除，请重新发起任务"
      )
  }

  assertRun(runId: string): void {
    this.assertNotRevoked(runId)
    const run = this.store.getRun(runId)
    const result = this.store.db.exec(
      "SELECT skill_id,version FROM bot_run_skills WHERE run_id=?",
      [runId]
    )[0]
    for (const [id, version] of result?.values ?? [])
      this.current(run.botId, String(id), Number(version))
  }

  referencesForRun(runId: string): { id: string; version: number }[] {
    this.store.getRun(runId)
    return (
      this.store.db.exec("SELECT skill_id,version FROM bot_run_skills WHERE run_id=?", [runId])[0]
        ?.values ?? []
    ).map(([id, version]) => ({ id: String(id), version: Number(version) }))
  }
}
