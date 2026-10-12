import { createHash } from "node:crypto"
import {
  BOT_SKILL_DEPENDENCY_SOURCE,
  botCheckSkillDependencies,
  botSkillDependencyOrigin,
  botSkillDependencyPinned,
  botSkillDependencyReceipt,
  botSkillDependencyReport,
  type BotCheckSkillDependencies,
  type BotSkillDependencyEnvironment,
  type BotSkillDependencyOrigin,
  type BotSkillDependencyView,
  type BotSkillDependencyReceipt
} from "../../shared/bot-skill-dependencies"
import { botSkillSelection, type BotSkillSelection } from "../../shared/bot-skill-references"
import { BotDomainError, type BotRunLease, type BotSkill } from "../../shared/bot-types"
import { parseSkillDependencies } from "../skills/dependencies"
import type { BotStore } from "./store"
import { canonicalJson } from "./validation"

/** Normal inbox work and existing receipts own both admission and evidence. No
 * dependency result can mark a skill trial passed or grant execution permission. */
export class BotSkillDependencies {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly enqueue: (
      input: BotCheckSkillDependencies,
      origin: BotSkillDependencyOrigin
    ) => { runId: string; messageId: string }
  ) {}

  origin(raw: BotSkillSelection) {
    const input = botSkillSelection.parse(raw)
    const skill = this.store.skillLibrary.current(input.botId, input.id, input.version)
    return this.pin(input, skill)
  }

  private pin(input: BotSkillSelection, skill: BotSkill) {
    const external =
      skill.scope === "desktop"
        ? this.store.externalSkills.source(input.botId, input.id, input.version)
        : undefined
    const declaration =
      external?.dependencies ??
      parseSkillDependencies(
        external
          ? `---\ncompatibility: ${JSON.stringify(external.compatibility)}\n---\n${external.instructions}`
          : skill.instructions
      )
    return botSkillDependencyPinned.parse({
      skill: botSkillDependencyOrigin.parse({
        ...input,
        name: skill.name,
        scope: skill.scope ?? "bot",
        sha256:
          external?.sha256 ?? createHash("sha256").update(skill.instructions, "utf8").digest("hex")
      }),
      declaration
    })
  }

  /** A disabled private skill remains inspectable, but never executable or
   * current evidence. Deleted, old, shared and installed identities keep their
   * existing ownership/version/availability guards. */
  private viewOrigin(raw: BotSkillSelection) {
    const input = botSkillSelection.parse(raw)
    const row = this.store.db.exec(
      "SELECT version,enabled FROM bot_skills WHERE bot_id=? AND id=? ORDER BY version DESC LIMIT 1",
      [input.botId, input.id]
    )[0]?.values[0]
    if (!row || row[1]) return { pin: this.origin(input), disabled: false }
    this.store.getBot(input.botId)
    this.store.skillDeletion.assertPresent(input.botId, input.id)
    if (Number(row[0]) !== input.version)
      throw new BotDomainError("skill_changed", "技能已有新版本，请确认后重新选择")
    const skill = this.store.skillVersion(input.botId, input.id, input.version)
    return { pin: this.pin(input, skill), disabled: true }
  }

  submit(raw: unknown): BotSkillDependencyReceipt {
    const input = botCheckSkillDependencies.parse(raw)
    return this.store.transaction(() =>
      this.receipt(
        input.nonce,
        {
          operation: "checkSkillDependencies",
          ...input
        },
        () => {
          this.store.assertMutationEpoch(input.expectedDataEpoch)
          const pin = this.origin(input.skill)
          const count = this.store.db.exec(
            "SELECT count(*) FROM bot_runs WHERE bot_id=? AND source=? AND status IN ('queued','running','waiting_input','cancelling','needs_review')",
            [input.skill.botId, BOT_SKILL_DEPENDENCY_SOURCE]
          )[0]?.values[0]?.[0]
          if (Number(count) >= 16)
            throw new BotDomainError(
              "skill_dependency_busy",
              "尚有依赖检查未结束，请先处理或停止原任务"
            )
          const created = this.enqueue(input, pin.skill)
          this.receipt(`skill-dependency:${created.runId}`, { runId: created.runId }, () => pin)
          return botSkillDependencyReceipt.parse({
            ...created,
            skill: pin.skill
          })
        }
      )
    )
  }

  pinned(runId: string) {
    const run = this.store.getRun(runId)
    if (run.source !== BOT_SKILL_DEPENDENCY_SOURCE) return undefined
    const row = this.store.db.exec(
      "SELECT substr(response,1,32769) FROM bot_receipts WHERE nonce=?",
      [`skill-dependency:${runId}`]
    )[0]?.values[0]
    if (!row || String(row[0]).length > 32768)
      throw new BotDomainError("skill_dependency_scope", "依赖检查缺少原固定版本记录")
    const pin = botSkillDependencyPinned.parse(JSON.parse(String(row[0])))
    const references = this.store.skillReferences.forMessage(run.messageId)
    if (
      run.botId !== pin.skill.botId ||
      references.length !== 1 ||
      references[0].botId !== pin.skill.botId ||
      references[0].id !== pin.skill.id ||
      references[0].version !== pin.skill.version
    )
      throw new BotDomainError("skill_dependency_scope", "依赖检查与原任务的技能选择不一致")
    return pin
  }

  assertCurrent(lease: BotRunLease): void {
    this.store.assertDispatch(lease)
    const pin = this.pinned(lease.runId)
    if (
      !pin ||
      canonicalJson(
        this.origin({
          botId: pin.skill.botId,
          id: pin.skill.id,
          version: pin.skill.version
        })
      ) !== canonicalJson(pin)
    )
      throw new BotDomainError("skill_changed", "技能来源或依赖声明已变化，请重新选择版本后检查")
  }

  report(runId: string) {
    const saved = this.pinned(runId)
    if (!saved) return null
    const value = this.store.db.exec(
      "SELECT substr(response,1,32769) FROM bot_receipts WHERE nonce=?",
      [`tool:${runId}:skill-dependencies:report`]
    )[0]?.values[0]?.[0]
    if (typeof value !== "string" || value.length > 32768) return null
    try {
      const report = botSkillDependencyReport.parse(JSON.parse(value))
      return report.runId === runId &&
        canonicalJson(report.skill) === canonicalJson(saved.skill) &&
        canonicalJson(report.checks.map((item) => item.id)) ===
          canonicalJson(saved.declaration.checks.map((item) => item.id))
        ? report
        : null
    } catch {
      return null
    }
  }

  /** Examine at most 128 recent dependency runs, using the existing queue-history
   * index. A missing old report is unverified; it never broadens authority. */
  view(
    raw: BotSkillSelection,
    environment?: BotSkillDependencyEnvironment
  ): BotSkillDependencyView {
    const { pin, disabled } = this.viewOrigin(raw)
    const rows =
      this.store.db.exec(
        `WITH recent AS (
        SELECT id,message_id,status,created_at FROM bot_runs
        WHERE bot_id=? AND source=? ORDER BY created_at DESC,id DESC LIMIT 128
      ) SELECT r.id,r.message_id,r.status,r.created_at FROM recent r
      JOIN bot_run_skills s ON s.run_id=r.id AND s.skill_id=?
      ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,
        [pin.skill.botId, BOT_SKILL_DEPENDENCY_SOURCE, pin.skill.id]
      )[0]?.values ?? []
    return {
      ...pin,
      history: rows.map((row, index) => {
        const saved = this.pinned(String(row[0]))!
        let report = this.report(String(row[0]))
        let reason: BotSkillDependencyView["history"][number]["reason"]
        if (
          !report ||
          report.runId !== row[0] ||
          canonicalJson(report.skill) !== canonicalJson(saved.skill)
        ) {
          report = null
          reason = "not_checked"
        } else if (row[2] !== "succeeded") reason = "interrupted"
        else if (disabled || canonicalJson(saved) !== canonicalJson(pin)) reason = "stale_skill"
        else if (!environment || canonicalJson(report.environment) !== canonicalJson(environment))
          reason = "stale_environment"
        else if (this.store.now() >= report.expiresAt) reason = "expired"
        else if (index > 0) reason = "superseded"
        return {
          receipt: {
            runId: String(row[0]),
            messageId: String(row[1]),
            skill: saved.skill
          },
          status: this.store.getRun(String(row[0])).status,
          createdAt: Number(row[3]),
          report,
          current: reason === undefined,
          ...(reason ? { reason } : {})
        }
      })
    }
  }
}
