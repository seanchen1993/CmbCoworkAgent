import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { botLocalToolCard, type BotLocalToolCard } from "../../shared/bot-local-tool-permission"
import { canonicalJson, identifier } from "./validation"

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
const stageRow = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
  z.string()
])
const hookAction = z.object({
  hook: z.object({ event: z.literal("Notification"), invocation: z.string() })
})
type Grant = {
  id: string
  lease: BotRunLease
  invocation: string
  active: boolean
  actions: Map<string, string>
  localActions: Map<string, string>
}
type LocalAdmission = {
  grant: Grant
  actionId: string
  actionHash: string
  workspace: string
  command: string | null
  active: boolean
}

/** Only Host-owned Notification Hook execution may run while its original
 * approval is pending. The capability is process-local, bounded to one durable
 * stage and lease, and expires even in inherited asynchronous callbacks. */
export class BotHookNotifications {
  private readonly scope = new AsyncLocalStorage<Grant>()
  private readonly localAdmission = new AsyncLocalStorage<LocalAdmission>()
  constructor(private readonly store: BotStore) {}

  private row(id: string) {
    const raw = this.store.db.exec(
      "SELECT id,run_id,invocation,action_hash,status,fence,owner FROM bot_hook_notifications WHERE id=?",
      [id]
    )[0]?.values[0]
    return raw ? stageRow.parse(raw) : undefined
  }

  private grant(lease: BotRunLease): Grant | undefined {
    const grant = this.scope.getStore()
    if (!grant) return undefined
    const row = this.row(grant.id)
    if (
      !grant.active ||
      grant.lease.runId !== lease.runId ||
      grant.lease.owner !== lease.owner ||
      grant.lease.fence !== lease.fence ||
      !row ||
      row[1] !== lease.runId ||
      row[5] !== lease.fence ||
      row[6] !== lease.owner ||
      !["running", "waiting_input"].includes(row[4])
    )
      throw new BotDomainError("notification_scope_expired", "审批通知执行权已失效")
    return grant
  }

  allowsWaiting(lease: BotRunLease): boolean {
    return Boolean(this.grant(lease))
  }

  current(lease: BotRunLease): boolean {
    return Boolean(this.grant(lease))
  }

  assertDispatch(lease: BotRunLease): void {
    if (this.grant(lease)) return
    if (this.active(lease.runId))
      throw new BotDomainError("notification_pending", "请等待当前审批通知处理完成")
  }

  active(runId: string): boolean {
    return Boolean(
      this.store.db.exec(
        "SELECT 1 FROM bot_hook_notifications WHERE run_id=? AND status IN ('running','waiting_input') LIMIT 1",
        [runId]
      )[0]?.values.length
    )
  }

  executing(runId: string): boolean {
    return Boolean(
      this.store.db.exec(
        "SELECT 1 FROM bot_hook_notifications WHERE run_id=? AND status='running' LIMIT 1",
        [runId]
      )[0]?.values.length
    )
  }

  /** Register the exact action built by the trusted Hook runner. Ordinary tools
   * cannot consume a Notification approval or use its waiting-state capability. */
  registerAction(lease: BotRunLease, id: string, action: unknown): void {
    const grant = this.grant(lease)
    if (!grant) {
      if (hookAction.safeParse(action).success)
        throw new BotDomainError("notification_scope", "审批通知必须由原审批请求触发")
      return
    }
    const parsed = hookAction.safeParse(action)
    if (
      !parsed.success ||
      parsed.data.hook.invocation !== grant.invocation ||
      !id.startsWith("hook:")
    )
      throw new BotDomainError("notification_scope", "审批通知不能发起其他任务操作")
    const hash = digest(action)
    const previous = grant.actions.get(id)
    if (previous && previous !== hash)
      throw new BotDomainError("nonce_conflict", "审批通知操作内容已改变")
    grant.actions.set(id, hash)
  }

  /** The trusted local gate can ask for admission only as a child of an exact
   * registered Hook. This context never authorizes the Hook's physical effect. */
  async withLocalAdmission<T>(
    lease: BotRunLease,
    id: string,
    action: unknown,
    workspace: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const grant = this.grant(lease)
    if (!grant) return operation()
    const actionHash = digest(action)
    if (grant.actions.get(id) !== actionHash)
      throw new BotDomainError("notification_scope", "本机许可必须属于已绑定的审批通知操作")
    const hook = z
      .object({ hook: z.object({ command: z.string().nullable().optional() }) })
      .parse(action).hook
    const admission: LocalAdmission = {
      grant,
      actionId: id,
      actionHash,
      workspace,
      command: hook.command ?? null,
      active: true
    }
    try {
      return await this.localAdmission.run(admission, operation)
    } finally {
      admission.active = false
    }
  }

  /** Register only the exact Host-built card, after device/policy admission has
   * been captured. Other projects, commands, effects and late callbacks fail. */
  registerLocalApproval(lease: BotRunLease, id: string, raw: BotLocalToolCard): void {
    const grant = this.grant(lease)
    if (!grant) return
    const card = botLocalToolCard.parse(raw),
      action = card.action
    const admission = this.localAdmission.getStore()
    if (
      !admission?.active ||
      admission.grant !== grant ||
      grant.actions.get(admission.actionId) !== admission.actionHash ||
      action.workspace !== admission.workspace ||
      !(
        (action.kind === "read-file" &&
          action.target === "本项目的说明、配置和文件（含目录检索）") ||
        (action.kind === "run-command" && action.target === admission.command)
      )
    )
      throw new BotDomainError("notification_scope", "本机许可不能用于其他审批通知操作")
    const hash = digest({ localProjectAccess: card }),
      previous = grant.localActions.get(id)
    if (previous && previous !== hash)
      throw new BotDomainError("nonce_conflict", "审批通知的本机许可内容已改变")
    grant.localActions.set(id, hash)
  }

  approvalStage(lease: BotRunLease, kind: string, action: unknown): string | null {
    const grant = this.grant(lease)
    if (!grant) return null
    if (
      kind !== "approval" ||
      ![...grant.actions.values(), ...grant.localActions.values()].includes(digest(action))
    )
      throw new BotDomainError("notification_scope", "审批通知只能申请已绑定的 Hook 操作")
    return grant.id
  }

  assertEffect(lease: BotRunLease, id: string, action: unknown, approvalId: string): void {
    const stage = this.store.db.exec("SELECT notification_stage FROM bot_interactions WHERE id=?", [
      approvalId
    ])[0]?.values[0]?.[0]
    const grant = this.grant(lease)
    if (!stage && !grant) return
    if (!grant || stage !== grant.id || grant.actions.get(id) !== digest(action))
      throw new BotDomainError("notification_scope", "审批通知授权不能用于其他操作")
  }

  /** Called inside the interaction transaction; never changes the original gate. */
  waiting(stageId: string | null, waiting: boolean): void {
    if (!stageId) return
    this.store.db.run(
      "UPDATE bot_hook_notifications SET status=?,updated_at=? WHERE id=? AND status IN ('running','waiting_input')",
      [waiting ? "waiting_input" : "running", this.store.now(), stageId]
    )
  }

  /** Called inside the owner's transaction after an answer or stage settlement. */
  refreshRun(runId: string): void {
    const pending = this.store.db.exec(
      "SELECT 1 FROM bot_interactions WHERE run_id=? AND status='pending' LIMIT 1",
      [runId]
    )[0]?.values.length
    this.store.db.run(
      "UPDATE bot_runs SET status=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('running','waiting_input')",
      [pending || this.active(runId) ? "waiting_input" : "running", this.store.now(), runId]
    )
  }

  interrupt(runId: string): void {
    this.store.db.run(
      "UPDATE bot_hook_notifications SET status='interrupted',updated_at=? WHERE run_id=? AND status IN ('running','waiting_input')",
      [this.store.now(), runId]
    )
  }

  async run(
    lease: BotRunLease,
    trigger: { key: string; interactionId: string; action: unknown },
    operation: (invocation: string) => Promise<void>
  ): Promise<void> {
    identifier(trigger.key)
    if (this.scope.getStore())
      throw new BotDomainError("notification_recursive", "审批通知不能递归触发自身")
    const id = digest([lease.runId, trigger.key]),
      invocation = `notification:${id}`
    const actionHash = digest(trigger.action)
    const run = this.store.transaction(() => {
      this.store.assertLease(lease, true)
      this.store.steering.assertNoPending(lease.runId)
      const approval = this.store.getInteraction(trigger.interactionId)
      if (
        approval.runId !== lease.runId ||
        approval.kind !== "approval" ||
        approval.actionHash !== actionHash
      )
        throw new BotDomainError("notification_scope", "审批通知不属于当前操作")
      const prior = this.row(id)
      if (prior && (prior[1] !== lease.runId || prior[2] !== invocation || prior[3] !== actionHash))
        throw new BotDomainError("nonce_conflict", "原审批通知的内容已改变")
      if (prior && ["completed", "failed"].includes(prior[4])) return false
      // Rule/automatic approvals and already resolved prompts do not create new notifications.
      if (approval.status !== "pending") return false
      if (approval.expiresAt <= this.store.now())
        throw new BotDomainError("stale_interaction", "原审批请求已过期")
      if (this.active(lease.runId))
        throw new BotDomainError("notification_pending", "当前任务已有审批通知正在处理")
      this.store.db.run(
        `INSERT INTO bot_hook_notifications(id,run_id,invocation,action_hash,interaction_id,status,fence,owner,updated_at)
         VALUES(?,?,?,?,?,'running',?,?,?) ON CONFLICT(id) DO UPDATE SET interaction_id=excluded.interaction_id,
         status='running',fence=excluded.fence,owner=excluded.owner,updated_at=excluded.updated_at`,
        [
          id,
          lease.runId,
          invocation,
          actionHash,
          approval.id,
          lease.fence,
          lease.owner,
          this.store.now()
        ]
      )
      return true
    })
    if (!run) return
    const grant: Grant = {
      id,
      lease: { ...lease },
      invocation,
      active: true,
      actions: new Map(),
      localActions: new Map()
    }
    let succeeded = false
    try {
      await this.scope.run(grant, () => operation(invocation))
      succeeded = true
    } finally {
      grant.active = false
      this.store.transaction(() => {
        const current = this.store.getRun(lease.runId),
          row = this.row(id)
        if (
          !row ||
          !["running", "waiting_input"].includes(row[4]) ||
          row[5] !== lease.fence ||
          row[6] !== lease.owner ||
          current.fence !== lease.fence ||
          current.leaseOwner !== lease.owner ||
          (current.leaseUntil ?? 0) <= this.store.now()
        )
          return
        const live = ["running", "waiting_input"].includes(current.status)
        this.store.db.run("UPDATE bot_hook_notifications SET status=?,updated_at=? WHERE id=?", [
          live ? (succeeded ? "completed" : "failed") : "interrupted",
          this.store.now(),
          id
        ])
        this.store.db.run(
          "UPDATE bot_interactions SET status='cancelled',revision=revision+1 WHERE notification_stage=? AND status='pending'",
          [id]
        )
        this.refreshRun(lease.runId)
      })
    }
  }
}
