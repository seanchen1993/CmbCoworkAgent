import { botDeleteSkillInput, type BotDeleteSkillReceipt } from "../../shared/bot-skill-deletion"
import { BotDomainError, type BotRun } from "../../shared/bot-types"
import type { BotStore } from "./store"

type Receipt = <T>(nonce: string, request: unknown, operation: () => T) => T

/** Private workflow removal follows Grok's removeAgentWorkflow. Immutable versions
 * and trial evidence survive; only the active identity is revoked. The shared
 * library is an independently published snapshot with its own withdrawal API. */
export class BotSkillDeletion {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: Receipt,
    private readonly cancel: (runId: string) => BotRun,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  deletedAt(botId: string, id: string): number | null {
    const row = this.store.db.exec(
      "SELECT deleted_at FROM bot_skill_tombstones WHERE skill_id=? AND bot_id=?",
      [id, botId]
    )[0]?.values[0]
    return row ? Number(row[0]) : null
  }

  assertPresent(botId: string, id: string): void {
    if (this.deletedAt(botId, id) !== null)
      throw new BotDomainError("skill_unavailable", "技能已删除，请选择其他技能")
  }

  /** Resume and direct tool dispatch cannot reinterpret a retained audit version
   * as current authority. All lookups start at indexed run/message identities. */
  assertRunPresent(runId: string): void {
    const deleted = this.store.db.exec(
      `SELECT t.skill_id FROM bot_run_skills s
      JOIN bot_runs r ON r.id=s.run_id JOIN bot_skill_tombstones t ON t.skill_id=s.skill_id AND t.bot_id=r.bot_id
      WHERE s.run_id=? UNION ALL
      SELECT t.skill_id FROM bot_skill_trials s JOIN bot_skill_tombstones t ON t.skill_id=s.skill_id AND t.bot_id=s.bot_id
      WHERE s.run_id=? UNION ALL
      SELECT t.skill_id FROM bot_runs r JOIN bot_message_skills s
        ON s.message_id IN(SELECT r.message_id UNION ALL SELECT message_id FROM bot_steering WHERE run_id=r.id)
        JOIN json_each(s.refs) ref JOIN bot_skill_tombstones t
        ON t.skill_id=json_extract(ref.value,'$.id') AND t.bot_id=json_extract(ref.value,'$.botId')
      WHERE r.id=? AND t.bot_id=r.bot_id LIMIT 1`,
      [runId, runId, runId]
    )[0]?.values.length
    if (deleted)
      throw new BotDomainError(
        "skill_unavailable",
        "此任务使用的私有技能已删除，请结束旧任务后重新选择技能"
      )
  }

  remove(raw: unknown): BotDeleteSkillReceipt {
    const parsed = botDeleteSkillInput.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "删除技能参数无效")
    const input = parsed.data
    if (input.skillId.startsWith("desktop:") || input.skillId.startsWith("library:"))
      throw new BotDomainError(
        "skill_scope",
        "只能删除此 Bot 的私有技能；共享和安装技能使用各自管理入口"
      )
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "skill.delete", ...input }, () => {
        this.store.getBot(input.botId)
        const old = this.store.db.exec(
          "SELECT bot_id,version FROM bot_skills WHERE id=? ORDER BY version DESC LIMIT 1",
          [input.skillId]
        )[0]?.values[0]
        if (!old || old[0] !== input.botId)
          throw new BotDomainError("not_found", "技能不存在或不属于此 Bot")
        this.assertPresent(input.botId, input.skillId)
        if (Number(old[1]) !== input.version)
          throw new BotDomainError("revision_conflict", "技能版本已改变，请查看当前步骤后确认删除")

        const deletedAt = this.store.now()
        this.store.db.run("INSERT INTO bot_skill_tombstones VALUES(?,?,?,?)", [
          input.skillId,
          input.botId,
          input.version,
          deletedAt
        ])
        const affectedRoutineIds = (
          this.store.db.exec(
            `SELECT r.id FROM bot_routines r
        JOIN bot_routine_skills s ON s.routine_id=r.id
        WHERE r.bot_id=? AND EXISTS(SELECT 1 FROM json_each(s.refs) ref
          WHERE json_extract(ref.value,'$.id')=? AND json_extract(ref.value,'$.botId')=?)
        ORDER BY r.created_at,r.id`,
            [input.botId, input.skillId, input.botId]
          )[0]?.values ?? []
        ).map(([id]) => String(id))
        for (const id of affectedRoutineIds)
          this.store.db.run(
            "UPDATE bot_routines SET enabled=0,next_at=NULL,activation_required=1,revision=revision+1 WHERE id=? AND (enabled<>0 OR next_at IS NOT NULL OR activation_required<>1)",
            [id]
          )

        // Initiating and steering selections, actual read_skill uses and private
        // trials all retain stable references. Inspect only the owning Bot's work;
        // another Bot using a published snapshot is outside this deletion's scope.
        const runs =
          this.store.db.exec(
            `SELECT r.id,r.status FROM bot_runs r
        WHERE r.bot_id=? AND (r.status IN ('queued','running','waiting_input','cancelling','needs_review') OR
          EXISTS(SELECT 1 FROM bot_shell_jobs j JOIN bot_shell_services service ON service.job_id=j.id
            WHERE j.run_id=r.id AND j.status IN ('queued','running','cancelling'))) AND (
          EXISTS(SELECT 1 FROM bot_run_skills s WHERE s.run_id=r.id AND s.skill_id=?) OR
          EXISTS(SELECT 1 FROM bot_skill_trials t WHERE t.run_id=r.id AND t.skill_id=?) OR
          EXISTS(SELECT 1 FROM bot_message_skills s,json_each(s.refs) ref WHERE
            s.message_id IN(SELECT r.message_id UNION ALL SELECT message_id FROM bot_steering WHERE run_id=r.id)
            AND json_extract(ref.value,'$.id')=? AND json_extract(ref.value,'$.botId')=?))
        ORDER BY r.created_at,r.id`,
            [input.botId, input.skillId, input.skillId, input.skillId, input.botId]
          )[0]?.values ?? []
        const cancelledRunIds: string[] = [],
          cancellingRunIds: string[] = [],
          reviewRunIds: string[] = [],
          stoppingServiceJobIds: string[] = []
        for (const [id, status] of runs) {
          const runId = String(id)
          if (status === "needs_review") reviewRunIds.push(runId)
          else if (!["succeeded", "failed", "cancelled"].includes(String(status))) {
            const stopped = this.cancel(runId)
            ;(stopped.status === "cancelled" ? cancelledRunIds : cancellingRunIds).push(runId)
          }
          const jobs =
            this.store.db.exec(
              `SELECT j.id FROM bot_shell_jobs j
            JOIN bot_shell_services service ON service.job_id=j.id
            WHERE j.run_id=? AND j.status IN ('queued','running','cancelling') ORDER BY j.created_at,j.id`,
              [runId]
            )[0]?.values ?? []
          for (const [jobId] of jobs) {
            this.store.shellJobs.requestStopInTransaction(runId, String(jobId))
            stoppingServiceJobIds.push(String(jobId))
          }
        }
        const retainedLibraryIds = (
          this.store.db.exec(
            "SELECT id FROM bot_skill_library WHERE source_bot_id=? AND source_skill_id=? ORDER BY id",
            [input.botId, input.skillId]
          )[0]?.values ?? []
        ).map(([id]) => String(id))
        const result = {
          id: input.skillId,
          version: input.version,
          deletedAt,
          affectedRoutineIds,
          cancelledRunIds,
          cancellingRunIds,
          reviewRunIds,
          stoppingServiceJobIds,
          retainedLibraryIds
        }
        this.event("skill.deleted", input.skillId, { botId: input.botId, ...result })
        return result
      })
    )
  }
}
