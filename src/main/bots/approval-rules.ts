import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { derivePermanentApprovalPattern } from "../agent/exec-policy"
import { botExecutionConfigSchema } from "./shell-contract"
import { botShellDefinition } from "../../shared/bot-shell-definition"
import { parseBotShellReviewCandidate } from "./shell-review-candidate"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import {
  botApprovalRuleChange,
  type BotApprovalReview,
  type BotApprovalRules
} from "../../shared/bot-approval-rules"
import type { BotStore } from "./store"
import { canonicalJson, identifier } from "./validation"

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const shellAction = z
  .object({
    shell: z
      .object({
        command: z.string().min(1).max(4000),
        cwd: z.string().min(1).max(4000),
        timeoutSeconds: z.number().int().min(1).max(600),
        sandbox: z.union([
          botExecutionConfigSchema.shape.windowsSandbox,
          z.literal("macos-seatbelt"),
          // Approval remembers exact intent, not a native probe verdict.
          z.literal("pending-verification")
        ]),
        definition: botShellDefinition.optional()
      })
      .strict()
  })
  .strict()
const reviewRecord = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string(),
    prompt: z.string(),
    policyRevision: z.number().int().nonnegative(),
    source: z.enum(["user", "rule"]),
    remembered: z.boolean(),
    ruleId: z.string().nullable(),
    canRemember: z.boolean(),
    canDeny: z.boolean().optional()
  })
  .strict()

/** Durable, exact-action grants. Reuses Cmb's command eligibility, while never
 * broadening an approval into a prefix or a different project's command. */
export class BotApprovalRulesStore {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void
  ) {}

  private revision(botId: string): number {
    return Number(
      this.store.db.exec("SELECT revision FROM bot_approval_policy WHERE bot_id=?", [botId])[0]
        ?.values[0]?.[0] ?? 0
    )
  }
  private bump(botId: string): void {
    this.store.db.run(
      "INSERT INTO bot_approval_policy VALUES(?,1) ON CONFLICT(bot_id) DO UPDATE SET revision=revision+1",
      [botId]
    )
  }
  private record(id: string): z.infer<typeof reviewRecord> | null {
    const raw = this.store.db.exec(
      "SELECT record FROM bot_approval_reviews WHERE interaction_id=?",
      [id]
    )[0]?.values[0]?.[0]
    return raw == null ? null : reviewRecord.parse(JSON.parse(String(raw)))
  }
  view(id: string): BotApprovalReview | undefined {
    const value = this.record(id)
    return value
      ? {
          canRemember: value.canRemember,
          canDeny: value.canDeny ?? value.canRemember,
          ruleTitle: value.title,
          source: value.source,
          remembered: value.remembered
        }
      : undefined
  }
  read(botId: string): BotApprovalRules {
    this.store.getBot(identifier(botId))
    const rows =
      this.store.db.exec(
        "SELECT id,title,prompt,behavior,created_at FROM bot_approval_rules WHERE bot_id=? ORDER BY created_at,id",
        [botId]
      )[0]?.values ?? []
    return {
      botId,
      revision: this.revision(botId),
      dataEpoch: this.store.backupSchedule.epoch(),
      rules: rows.map(([id, title, prompt, behavior, createdAt]) => ({
        id: String(id),
        title: String(title),
        prompt: String(prompt),
        behavior: z.enum(["ask", "allow", "deny"]).parse(behavior),
        createdAt: Number(createdAt)
      }))
    }
  }
  change(raw: unknown): BotApprovalRules {
    const parsed = botApprovalRuleChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "审批规则修改格式不正确")
    const input = parsed.data
    return this.store.transaction(() => {
      this.store.getBot(input.botId)
      if (input.dataEpoch !== this.store.backupSchedule.epoch())
        throw new BotDomainError("data_epoch", "数据已恢复，请重新读取审批规则")
      return this.receipt(input.nonce, { op: "approval.rule", ...input }, () => {
        if (this.revision(input.botId) !== input.revision)
          throw new BotDomainError("revision_conflict", "审批规则已变化，请刷新后重试")
        if (
          !this.store.db.exec("SELECT id FROM bot_approval_rules WHERE id=? AND bot_id=?", [
            input.ruleId,
            input.botId
          ])[0]?.values.length
        )
          throw new BotDomainError("not_found", "审批规则已不存在")
        if (input.behavior === null)
          this.store.db.run("DELETE FROM bot_approval_rules WHERE id=? AND bot_id=?", [
            input.ruleId,
            input.botId
          ])
        else
          this.store.db.run("UPDATE bot_approval_rules SET behavior=? WHERE id=? AND bot_id=?", [
            input.behavior,
            input.ruleId,
            input.botId
          ])
        this.bump(input.botId)
        this.event("approval.rules_changed", input.botId, {
          ruleId: input.ruleId,
          behavior: input.behavior
        })
        return this.read(input.botId)
      })
    })
  }

  /** Called only inside requestInteraction's transaction, with Host-owned scope.
   * Unknown actions, compound shells, plugin operations and background services
   * stay manual. A missing scope (including older callers) stays manual. */
  prepare(
    lease: BotRunLease,
    interactionId: string,
    action: unknown,
    scope?: string,
    forceManual = false
  ): "allow" | "deny" | null {
    const parsed = shellAction.safeParse(action)
    if (
      !scope ||
      !/^[a-f0-9]{64}$/.test(scope) ||
      !parsed.success ||
      !derivePermanentApprovalPattern(parsed.data.shell.command)
    )
      return null
    const shell = parsed.data.shell
    if (
      shell.definition?.kind === "unavailable" ||
      (parseBotShellReviewCandidate(shell.command, shell.cwd) && !shell.definition)
    )
      return null
    const run = this.store.getRun(lease.runId)
    const actionHash = digest(action)
    const row = this.store.db.exec(
      "SELECT id,behavior FROM bot_approval_rules WHERE bot_id=? AND scope=? AND action_hash=?",
      [run.botId, scope, actionHash]
    )[0]?.values[0]
    // Refusals dominate independent review and ask-first approval settings.
    const automatic =
      row?.[1] === "deny" ? "deny" : !forceManual && row?.[1] === "allow" ? "allow" : null
    const value: z.infer<typeof reviewRecord> = {
      scope,
      actionHash,
      title: `${parsed.data.shell.cwd}\n${parsed.data.shell.command}`,
      prompt: JSON.stringify(action, null, 2),
      policyRevision: this.revision(run.botId),
      source: automatic ? "rule" : "user",
      remembered: false,
      ruleId: row ? String(row[0]) : null,
      canRemember: !forceManual && row?.[1] !== "ask",
      canDeny: true
    }
    this.store.db.run("INSERT INTO bot_approval_reviews VALUES(?,?)", [
      interactionId,
      JSON.stringify(value)
    ])
    return automatic
  }

  behavior(botId: string, action: unknown, scope: string): "allow" | "ask" | "deny" | null {
    const row = this.store.db.exec(
      "SELECT behavior FROM bot_approval_rules WHERE bot_id=? AND scope=? AND action_hash=?",
      [botId, scope, digest(action)]
    )[0]?.values[0]
    return row ? z.enum(["allow", "ask", "deny"]).parse(row[0]) : null
  }

  /** Same transaction as the human answer: never save a rule for a stale request. */
  remember(interactionId: string, behavior: "allow" | "deny"): void {
    const value = this.record(interactionId)
    if (
      !value ||
      value.source !== "user" ||
      !(behavior === "deny" ? (value.canDeny ?? value.canRemember) : value.canRemember)
    )
      throw new BotDomainError("approval_rule_unavailable", "此操作不能保存为长期审批规则")
    const interaction = this.store.getInteraction(interactionId)
    const run = this.store.getRun(interaction.runId)
    if (
      interaction.actionHash !== value.actionHash ||
      value.policyRevision !== this.revision(run.botId)
    )
      throw new BotDomainError("revision_conflict", "审批规则已变化，请重新确认操作")
    const count = Number(
      this.store.db.exec("SELECT COUNT(*) FROM bot_approval_rules WHERE bot_id=?", [run.botId])[0]
        .values[0][0]
    )
    if (!value.ruleId && count >= 50)
      throw new BotDomainError("capacity", "每个 Bot 最多保存 50 条审批规则")
    const id = value.ruleId ?? randomUUID()
    this.store.db.run(
      `INSERT INTO bot_approval_rules VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,scope,action_hash) DO UPDATE SET behavior=excluded.behavior`,
      [
        id,
        run.botId,
        value.scope,
        value.actionHash,
        value.title,
        value.prompt,
        behavior,
        this.store.now()
      ]
    )
    this.bump(run.botId)
    this.store.db.run("UPDATE bot_approval_reviews SET record=? WHERE interaction_id=?", [
      JSON.stringify({ ...value, remembered: true, ruleId: id }),
      interactionId
    ])
    this.event("approval.rules_changed", run.botId, { ruleId: id, behavior })
  }

  /** A settings change revokes automatic decisions which have not dispatched. */
  assertCurrent(interactionId: string): void {
    const value = this.record(interactionId)
    if (!value) return
    const run = this.store.getRun(this.store.getInteraction(interactionId).runId)
    const row = this.store.db.exec(
      "SELECT id,behavior FROM bot_approval_rules WHERE bot_id=? AND scope=? AND action_hash=?",
      [run.botId, value.scope, value.actionHash]
    )[0]?.values[0]
    if (row?.[1] === "deny")
      throw new BotDomainError("approval_required", "此操作已设为从不允许，原批准失效")
    if (value.source !== "rule") return
    if (
      value.policyRevision !== this.revision(run.botId) ||
      row?.[0] !== value.ruleId ||
      row?.[1] !== "allow"
    )
      throw new BotDomainError("approval_required", "审批规则已变化，原自动批准失效")
  }
}
