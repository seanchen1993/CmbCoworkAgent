import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import { constrainToolPermission } from "../../shared/tool-permission"
import {
  BOT_LOCAL_TOOL_ASK_TTL_MS,
  botLocalToolAction,
  botLocalToolAnswer,
  botLocalToolCard,
  botLocalToolPermission,
  botLocalToolPolicyChange,
  type BotLocalToolAction,
  type BotLocalToolCard,
  type BotLocalToolPolicy,
  type BotLocalToolPermission
} from "../../shared/bot-local-tool-permission"
import type { BotStore } from "./store"
import type { BotLocalToolAuthority } from "./local-tool-authority"
import { canonicalJson, identifier } from "./validation"
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const storedPolicy = z
  .object({ targetId: z.string(), dataEpoch: z.string(), choice: botLocalToolPermission })
  .strict()
const record = z
  .object({
    card: botLocalToolCard,
    actionHash: z.string(),
    invocation: z.string(),
    expiresAt: z.number(),
    status: z.enum(["pending", "allowed", "denied", "retired"]),
    // Older explicit answers stay one-shot when this provenance is absent.
    standing: z.boolean().optional(),
    standingUpgradeFromRevision: z.number().int().nonnegative().optional()
  })
  .strict()
export interface BotLocalToolPermit {
  id: string
  interactionId: string | null
  decision: "allow" | "ask" | "deny"
}
const decisions = { always: "allow", ask: "ask", never: "deny" } as const
const permissions = { allow: "always", ask: "ask", deny: "never" } as const

/** Device admission is additional to action approvals. All decisions live in the
 * same SQLite transaction/receipts as the existing lease and interaction machinery. */
export class BotLocalToolPermissions {
  private authority?: BotLocalToolAuthority
  private ceiling: BotLocalToolPermission = "always"
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, request: unknown, operation: () => T) => T,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly compose: <T>(operation: () => T) => T
  ) {}
  bind(authority: BotLocalToolAuthority, ceiling: BotLocalToolPermission = "always"): void {
    authority.assertCurrent()
    if (this.authority) throw new Error("Local computer authority is already bound")
    this.authority = authority
    this.ceiling = botLocalToolPermission.parse(ceiling)
  }
  read(): BotLocalToolPolicy {
    if (!this.authority)
      throw new BotDomainError("local_computer_unavailable", "本机项目访问服务未配置")
    this.authority.assertCurrent()
    const row = this.store.db.exec(
      "SELECT revision,record FROM bot_local_tool_policy WHERE id=1"
    )[0]?.values[0]
    const saved = row ? storedPolicy.parse(JSON.parse(String(row[1]))) : null
    const dataEpoch = this.store.dataEpoch(),
      target = this.authority.target
    // Backups and installation copies cannot re-activate a historical allow.
    const choice =
      saved?.choice === "never"
        ? "never"
        : saved?.targetId === target.id && saved.dataEpoch === dataEpoch
          ? saved.choice
          : "ask"
    const effective =
      permissions[
        constrainToolPermission(
          { decision: decisions[choice] },
          { decision: decisions[this.ceiling] }
        ).decision
      ]
    return {
      target,
      dataEpoch,
      revision: row ? Number(row[0]) : 0,
      choice,
      ceiling: this.ceiling,
      effective
    }
  }
  private save(choice: BotLocalToolPermission, except?: string): BotLocalToolPolicy {
    const current = this.read()
    this.store.db.run(
      "INSERT INTO bot_local_tool_policy VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record=excluded.record",
      [
        current.revision + 1,
        JSON.stringify({ targetId: current.target.id, dataEpoch: current.dataEpoch, choice })
      ]
    )
    // Use the existing run status index plus the active-permit index. Completed
    // history is immutable; policyRevision/lease/fence still reject every stale
    // grant if the task is later recovered. Never revive a queued old request.
    this.store.db.run(
      `UPDATE bot_interactions SET status='expired',revision=revision+1
      WHERE id IN (SELECT interaction_id FROM bot_local_tool_requests
        WHERE run_id IN (SELECT id FROM bot_runs WHERE status IN ('queued','running','waiting_input','cancelling','needs_review'))
        AND json_extract(record,'$.status') IN ('pending','allowed')
        AND interaction_id IS NOT NULL AND id<>?)
      AND status='pending'`,
      [except ?? ""]
    )
    this.store.db.run(
      `UPDATE bot_local_tool_requests SET record=json_set(record,'$.status','retired')
      WHERE run_id IN (SELECT id FROM bot_runs WHERE status IN ('queued','running','waiting_input','cancelling','needs_review'))
      AND id<>? AND json_extract(record,'$.status') IN ('pending','allowed')`,
      [except ?? ""]
    )
    this.event("local_tool.policy_changed", current.target.id, {
      choice,
      revision: current.revision + 1
    })
    return this.read()
  }
  change(raw: unknown): BotLocalToolPolicy {
    const parsed = botLocalToolPolicyChange.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "本机项目访问设置格式不正确")
    const input = parsed.data
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "local-tool.policy", ...input }, () => {
        this.assertScope(input.targetId, input.dataEpoch)
        if (this.read().revision !== input.revision)
          throw new BotDomainError("revision_conflict", "本机许可已变化，请刷新后重试")
        return this.save(input.choice)
      })
    )
  }
  /** RPC admission/ACK fence. Historical Store receipts remain readable directly. */
  assertPublicTarget(raw: unknown): void {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as { targetId?: unknown }).targetId !== "string"
    )
      throw new BotDomainError("invalid_input", "缺少本机执行目标")
    if (this.read().target.id !== (raw as { targetId: string }).targetId)
      throw new BotDomainError("local_computer_changed", "目标电脑已变化，请重新打开并核对原请求")
  }
  private assertScope(targetId: string, dataEpoch: string): BotLocalToolPolicy {
    this.store.assertMutationEpoch(dataEpoch)
    const current = this.read()
    if (current.target.id !== targetId)
      throw new BotDomainError("local_computer_changed", "目标电脑已变化，请重新读取本机许可")
    return current
  }
  private readRecord(id: string): {
    interactionId: string | null
    value: z.infer<typeof record>
    runId: string
  } {
    const row = this.store.db.exec(
      "SELECT interaction_id,record,run_id FROM bot_local_tool_requests WHERE id=?",
      [identifier(id)]
    )[0]?.values[0]
    if (!row) throw new BotDomainError("local_permission_missing", "本机许可请求已不存在")
    return {
      interactionId: row[0] === null ? null : String(row[0]),
      value: record.parse(JSON.parse(String(row[1]))),
      runId: String(row[2])
    }
  }
  view(interactionId: string): BotLocalToolCard | undefined {
    const row = this.store.db.exec(
      "SELECT record FROM bot_local_tool_requests WHERE interaction_id=?",
      [interactionId]
    )[0]?.values[0]
    return row ? record.parse(JSON.parse(String(row[0]))).card : undefined
  }
  isLocalInteraction(id: string): boolean {
    return Boolean(this.view(id))
  }
  request(lease: BotRunLease, invocation: string, action: BotLocalToolAction): BotLocalToolPermit {
    const parsed = botLocalToolAction.parse(action),
      call = identifier(invocation),
      actionHash = digest(parsed)
    this.store.assertDispatch(lease)
    const existing = this.store.db.exec(
      "SELECT id,record,interaction_id,attempt FROM bot_local_tool_requests WHERE run_id=? AND invocation=? ORDER BY attempt DESC LIMIT 1",
      [lease.runId, call]
    )[0]?.values[0]
    let attempt = 0,
      requireFreshAnswer = false,
      renewal: z.infer<typeof record> | undefined
    if (existing) {
      const previous = record.parse(JSON.parse(String(existing[1])))
      if (previous.actionHash !== actionHash)
        throw new BotDomainError("nonce_conflict", "相同调用标识不能改写本机操作")
      const interactionExpired =
        existing[2] !== null &&
        this.store.getInteraction(String(existing[2])).expiresAt <= this.store.now()
      if (
        previous.status === "denied" ||
        ((previous.status === "pending" || previous.status === "allowed") &&
          previous.expiresAt > this.store.now() &&
          !interactionExpired)
      )
        return {
          id: String(existing[0]),
          interactionId: existing[2] === null ? null : String(existing[2]),
          decision:
            previous.status === "allowed" ? "allow" : previous.status === "pending" ? "ask" : "deny"
        }
      // A revoked or expired explicit grant must be answered again, even if a
      // later setting says Always. Unchanged standing Always may refresh its lease.
      requireFreshAnswer = previous.status === "retired" || existing[2] !== null
      renewal = previous
      attempt = Number(existing[3]) + 1
      if (attempt > 50)
        throw new BotDomainError(
          "local_permission_capacity",
          "本次任务的本机许可请求已达上限，请重新交办"
        )
    }
    const id = this.store.toolOnce(
      lease,
      `local-permit:${digest({ call, attempt })}`,
      parsed,
      () => {
        const policy = this.read(),
          id = randomUUID()
        const standingRenewal =
          renewal?.status === "allowed" &&
          renewal.standing === true &&
          renewal.card.target.id === policy.target.id &&
          renewal.card.dataEpoch === policy.dataEpoch &&
          renewal.card.policyRevision === policy.revision &&
          policy.effective === "always"
        const effective =
          requireFreshAnswer && !standingRenewal && policy.effective !== "never"
            ? "ask"
            : policy.effective
        const card: BotLocalToolCard = {
          version: 1,
          target: policy.target,
          dataEpoch: policy.dataEpoch,
          policyRevision: policy.revision,
          action: parsed
        }
        if (existing && existing[2] !== null)
          this.store.db.run(
            "UPDATE bot_interactions SET status='expired',revision=revision+1 WHERE id=? AND status='pending'",
            [String(existing[2])]
          )
        const localApproval = { localProjectAccess: card }
        if (effective === "ask") this.store.hookNotifications.registerLocalApproval(lease, id, card)
        const interaction =
          effective === "ask"
            ? this.store.requestInteraction(lease, {
                kind: "approval",
                prompt: JSON.stringify({ localProjectAccess: card }),
                action: localApproval,
                expiresInMs: BOT_LOCAL_TOOL_ASK_TTL_MS
              })
            : undefined
        const value: z.infer<typeof record> = {
          card,
          actionHash,
          invocation: call,
          expiresAt: this.store.now() + BOT_LOCAL_TOOL_ASK_TTL_MS,
          status: effective === "always" ? "allowed" : effective === "never" ? "denied" : "pending",
          standing: effective === "always"
        }
        this.store.db.run("INSERT INTO bot_local_tool_requests VALUES(?,?,?,?,?,?)", [
          id,
          lease.runId,
          call,
          interaction?.id ?? null,
          JSON.stringify(value),
          attempt
        ])
        this.event("local_tool.requested", id, {
          runId: lease.runId,
          action: parsed.kind,
          decision: decisions[effective]
        })
        return id
      }
    )
    const entry = this.readRecord(id)
    return {
      id,
      interactionId: entry.interactionId,
      decision:
        entry.value.status === "allowed"
          ? "allow"
          : entry.value.status === "pending"
            ? "ask"
            : "deny"
    }
  }
  /** Natural expiry may ask again before dispatch; revocation, denial and a
   * changed device/policy never become a waiting task's implicit renewal. */
  canRenewExpired(lease: BotRunLease, id: string): boolean {
    this.store.assertLease(lease, true)
    const { value, runId, interactionId } = this.readRecord(id),
      policy = this.read()
    if (runId !== lease.runId)
      throw new BotDomainError("local_permission_scope", "本机许可不属于此任务")
    if (
      (value.status !== "pending" && value.status !== "allowed") ||
      value.card.dataEpoch !== policy.dataEpoch ||
      value.card.target.id !== policy.target.id ||
      value.card.policyRevision !== policy.revision ||
      policy.effective === "never"
    )
      return false
    if (!interactionId)
      return (
        value.expiresAt <= this.store.now() &&
        value.standing === true &&
        policy.effective === "always"
      )
    const item = this.store.getInteraction(interactionId)
    return (
      (value.expiresAt <= this.store.now() || item.expiresAt <= this.store.now()) &&
      (item.status === "pending" || (item.status === "answered" && item.answer === "approve"))
    )
  }
  /** Retire only this naturally expired card before requesting its replacement.
   * Both steps share one transaction; unrelated waiting work still blocks dispatch. */
  renewExpired(lease: BotRunLease, id: string): BotLocalToolPermit | undefined {
    if (!this.canRenewExpired(lease, id)) return undefined
    return this.store.transaction(() =>
      this.compose(() => {
        if (!this.canRenewExpired(lease, id)) return undefined
        const { value, interactionId } = this.readRecord(id)
        if (interactionId) {
          this.store.db.run(
            "UPDATE bot_interactions SET status='expired',revision=revision+1 WHERE id=? AND status='pending'",
            [interactionId]
          )
          this.store.hookNotifications.refreshRun(lease.runId)
        }
        return this.request(lease, value.invocation, value.card.action)
      })
    )
  }
  /** Cancel one abandoned waiting admission, without revoking a shared answer. */
  retirePending(lease: BotRunLease, id: string): void {
    this.store.transaction(() => {
      this.store.assertLease(lease, true)
      const entry = this.readRecord(id)
      if (entry.runId !== lease.runId)
        throw new BotDomainError("local_permission_scope", "本机许可不属于此任务")
      if (entry.value.status !== "pending" || !entry.interactionId) return
      const item = this.store.getInteraction(entry.interactionId)
      if (item.status !== "pending") return
      this.store.db.run("UPDATE bot_local_tool_requests SET record=? WHERE id=?", [
        JSON.stringify({ ...entry.value, status: "retired" }),
        id
      ])
      this.store.db.run(
        "UPDATE bot_interactions SET status='expired',revision=revision+1 WHERE id=? AND status='pending'",
        [item.id]
      )
      this.store.hookNotifications.refreshRun(lease.runId)
      this.event("local_tool.retired", id, {
        runId: lease.runId,
        reason: "cancelled-read"
      })
    })
  }
  resolve(raw: unknown): import("../../shared/bot-types").BotInteraction {
    const parsed = botLocalToolAnswer.safeParse(raw)
    if (!parsed.success) throw new BotDomainError("invalid_input", "本机许可回答格式不正确")
    const input = parsed.data
    return this.store.transaction(() =>
      this.receipt(input.nonce, { op: "local-tool.answer", ...input }, () => {
        const policy = this.assertScope(input.targetId, input.dataEpoch)
        const row = this.store.db.exec(
          "SELECT id FROM bot_local_tool_requests WHERE interaction_id=?",
          [input.id]
        )[0]?.values[0]
        if (!row) throw new BotDomainError("local_permission_missing", "此卡片不是本机许可请求")
        const id = String(row[0]),
          entry = this.readRecord(id),
          item = this.store.getInteraction(input.id)
        const run = this.store.getRun(entry.runId)
        if (
          item.status !== "pending" ||
          item.revision !== input.revision ||
          item.expiresAt <= this.store.now() ||
          run.status !== "waiting_input" ||
          (run.leaseUntil ?? 0) <= this.store.now() ||
          entry.value.status !== "pending" ||
          entry.value.card.policyRevision !== policy.revision
        )
          throw new BotDomainError("stale_interaction", "本机许可请求已处理、过期或权限已变化")
        const allowed = input.resolution === "allow-once" || input.resolution === "always"
        if (allowed && policy.effective === "never")
          throw new BotDomainError("local_permission_denied", "本机项目访问已禁用")
        const nextPolicy =
          input.resolution === "always" || input.resolution === "never"
            ? this.save(input.resolution, id)
            : policy
        this.store.db.run("UPDATE bot_local_tool_requests SET record=? WHERE id=?", [
          JSON.stringify({
            ...entry.value,
            card: { ...entry.value.card, policyRevision: nextPolicy.revision },
            status: allowed ? "allowed" : "denied",
            standing: input.resolution === "always" && nextPolicy.effective === "always",
            ...(input.resolution === "always" && nextPolicy.effective === "always"
              ? { standingUpgradeFromRevision: policy.revision }
              : {})
          }),
          id
        ])
        this.store.db.run(
          "UPDATE bot_interactions SET status='answered',answer=?,revision=revision+1 WHERE id=?",
          [allowed ? "approve" : "reject", item.id]
        )
        this.store.hookNotifications.refreshRun(run.id)
        this.event("interaction.answered", item.id, {
          runId: run.id,
          kind: "approval",
          decision: allowed ? "approve" : "reject",
          source: "local-computer"
        })
        return this.store.getInteraction(item.id)
      })
    )
  }
  /** Only this mutation's explicit Always answer can establish a fresh read
   * invocation after it retired its previously admitted read. Old handles stay
   * revoked, and neither ordinary settings changes nor other calls qualify. */
  readUpgradeInvocation(
    lease: BotRunLease,
    readId: string,
    mutationId: string
  ): string | undefined {
    this.assertGranted(lease, mutationId)
    const read = this.readRecord(readId),
      mutation = this.readRecord(mutationId),
      policy = this.read()
    const originalReadApproved = read.interactionId
      ? (() => {
          const answer = this.store.getInteraction(read.interactionId!)
          return answer.status === "answered" && answer.answer === "approve"
        })()
      : read.value.standing === true
    if (
      read.runId !== lease.runId ||
      mutation.runId !== lease.runId ||
      read.value.status !== "retired" ||
      !originalReadApproved ||
      read.value.card.action.kind !== "read-file" ||
      !["write-file", "run-command"].includes(mutation.value.card.action.kind) ||
      read.value.card.action.workspace !== mutation.value.card.action.workspace ||
      read.value.card.target.id !== policy.target.id ||
      read.value.card.dataEpoch !== policy.dataEpoch ||
      !mutation.interactionId ||
      mutation.value.standing !== true ||
      mutation.value.standingUpgradeFromRevision !== read.value.card.policyRevision ||
      policy.revision !== read.value.card.policyRevision + 1 ||
      policy.effective !== "always"
    )
      return undefined
    return `project-read:always:${mutationId}`
  }
  assertGranted(
    lease: BotRunLease,
    id: string,
    action?: BotLocalToolAction,
    ignoreExpiry = false
  ): void {
    this.store.assertLease(lease, true)
    const { value, runId, interactionId } = this.readRecord(id),
      policy = this.read()
    if (
      runId !== lease.runId ||
      (action && digest(botLocalToolAction.parse(action)) !== value.actionHash)
    )
      throw new BotDomainError("local_permission_scope", "本机许可不属于此任务或操作")
    if (
      value.status !== "allowed" ||
      (!ignoreExpiry && value.expiresAt <= this.store.now()) ||
      value.card.dataEpoch !== policy.dataEpoch ||
      value.card.target.id !== policy.target.id ||
      value.card.policyRevision !== policy.revision ||
      policy.effective === "never"
    )
      throw new BotDomainError(
        "local_permission_retired",
        "本机许可已拒绝、过期或撤销；此操作未获准，不能自动重试"
      )
    if (interactionId) {
      const item = this.store.getInteraction(interactionId)
      if (
        item.status !== "answered" ||
        item.answer !== "approve" ||
        (!ignoreExpiry && item.expiresAt <= this.store.now())
      )
        throw new BotDomainError("local_permission_retired", "本机许可已失效，此操作不能执行")
    } else if (policy.effective !== "always")
      throw new BotDomainError("local_permission_retired", "原始自动许可已失效")
  }
  bindEffect(
    lease: BotRunLease,
    approvalId: string,
    readId: string,
    mutationId: string,
    expectedActionHash?: string
  ): void {
    this.store.transaction(() => {
      this.assertGranted(lease, readId)
      this.assertGranted(lease, mutationId)
      const item = this.store.getInteraction(approvalId)
      if (
        item.runId !== lease.runId ||
        item.kind !== "approval" ||
        (expectedActionHash !== undefined && item.actionHash !== expectedActionHash)
      )
        throw new BotDomainError("local_permission_scope", "原动作审批不属于本次任务")
      const current = this.store.db.exec(
        "SELECT read_id,mutation_id FROM bot_local_tool_effect_permits WHERE approval_id=?",
        [approvalId]
      )[0]?.values[0]
      if (current && (current[0] !== readId || current[1] !== mutationId)) {
        // Re-answering an expired card may renew admission before dispatch. It
        // must never replace a permit for an already reserved physical effect.
        const used = this.store.db.exec(
          "SELECT 1 FROM bot_effect_approvals WHERE approval_id=? LIMIT 1",
          [approvalId]
        )[0]?.values.length
        const previous = this.readRecord(String(current[1])),
          next = this.readRecord(mutationId)
        if (
          used ||
          previous.runId !== lease.runId ||
          previous.value.actionHash !== next.value.actionHash
        )
          throw new BotDomainError(
            "local_permission_scope",
            "原动作审批已开始执行或绑定其他本机操作"
          )
        this.store.db.run(
          "UPDATE bot_local_tool_effect_permits SET read_id=?,mutation_id=? WHERE approval_id=?",
          [readId, mutationId, approvalId]
        )
      } else
        this.store.db.run("INSERT OR IGNORE INTO bot_local_tool_effect_permits VALUES(?,?,?)", [
          approvalId,
          readId,
          mutationId
        ])
    })
  }
  assertEffect(lease: BotRunLease, approvalId: string): void {
    const row = this.store.db.exec(
      "SELECT read_id,mutation_id FROM bot_local_tool_effect_permits WHERE approval_id=?",
      [approvalId]
    )[0]?.values[0]
    if (row) {
      this.assertGranted(lease, String(row[0]))
      this.assertGranted(lease, String(row[1]))
    }
  }
  assertStartedEffect(lease: BotRunLease, effectId: string): void {
    const row = this.store.db.exec(
      "SELECT approval_id FROM bot_effect_approvals WHERE effect_id=?",
      [effectId]
    )[0]?.values[0]
    if (row) this.assertEffect(lease, String(row[0]))
  }
  assertInteraction(id: string): void {
    if (this.isLocalInteraction(id))
      throw new BotDomainError("local_permission_resolution", "请使用本机许可卡片的明确选项")
  }
}
