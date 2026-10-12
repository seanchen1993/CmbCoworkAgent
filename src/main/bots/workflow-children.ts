import { isBotBrowserTaskProfile } from "./browser-task-profile"
import { isBotComputerTaskProfile, isBotComputerTaskInput } from "./computer-task-profile"
import { BOT_BACKGROUND_TASK_SCRIPT, backgroundTaskArguments } from "./background-task-input"
import { assertNativeTaskAvailable } from "./native-task-scope"
import { resolveProfileFromList } from "../agent/agent-registry"
import type { BotErrorDiagnostic } from "../../shared/bot-error-diagnostic"
import { runStatus } from "./stored-types"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { BotDomainError, type BotRunLease } from "../../shared/bot-types"
import type { BotStore } from "./store"
import type { BotWorkflowStore } from "./workflow-store"
import { workflowAgentRequest, workflowAgentResult, workflowEncode } from "./workflow-contract"
import { canonicalJson } from "./validation"

export const BOT_WORKFLOW_CHILD_SOURCE = "workflow-child"
export type BotWorkflowChildInput = z.infer<typeof workflowAgentRequest>
export type BotWorkflowChildResult = z.infer<typeof workflowAgentResult>
const identity = (input: BotWorkflowChildInput) => {
  // Display order can change on replay; all execution-affecting fields remain bound.
  const content = { ...input }
  for (const field of ["agentIndex", "toolStreamKey", "label", "phase"] as const)
    Reflect.deleteProperty(content, field)
  return createHash("sha256")
    .update(canonicalJson(JSON.parse(workflowEncode(content))))
    .digest("hex")
}

function matchesStoredIdentity(
  fingerprint: unknown,
  stored: unknown,
  input: BotWorkflowChildInput
): boolean {
  if (fingerprint === identity(input)) return true
  // Older Hosts resolved role instructions/permissions but did not persist the role name.
  // Keep their frozen input: learning a name must not activate new role-matched hooks on replay.
  // The workflow's durable call key already binds the original agent profile selection.
  const previous = workflowAgentRequest.parse(JSON.parse(z.string().parse(stored)))
  if (previous.agentType !== undefined || input.agentType === undefined) return false
  const legacy = { ...input }
  delete legacy.agentType
  return fingerprint === identity(previous) && fingerprint === identity(legacy)
}

/** Internal child runs share the existing lease/checkpoint/approval machinery.
 * Only a live owning workflow can dispatch them; the ordinary queue never can. */
export class BotWorkflowChildren {
  constructor(
    private readonly store: BotStore,
    private readonly event: (kind: string, id: string, payload: unknown) => void,
    private readonly finish: BotStore["finish"],
    private readonly cancel: BotStore["cancel"]
  ) {}

  summary(runId: string) {
    const row = this.store.db.exec(
      "SELECT workflow_id,json_extract(input,'$.label'),json_extract(input,'$.phase') FROM bot_workflow_children WHERE run_id=?",
      [runId]
    )[0]?.values[0]
    return row
      ? {
          workflowId: String(row[0]),
          label: String(row[1]),
          phase: z.string().nullable().parse(row[2])
        }
      : undefined
  }

  list(parentId: string, workflowId?: string) {
    return (
      this.store.db.exec(
        `SELECT r.id,json_extract(c.input,'$.label'),json_extract(c.input,'$.phase'),r.status FROM bot_runs r JOIN bot_workflow_children c ON c.run_id=r.id WHERE r.parent_run_id=? ${workflowId ? "AND c.workflow_id=?" : ""} ORDER BY r.created_at,r.rowid LIMIT 1000`,
        [parentId, ...(workflowId ? [workflowId] : [])]
      )[0]?.values ?? []
    ).map((row) => ({
      id: String(row[0]),
      label: String(row[1]),
      phase: z.string().nullable().parse(row[2]),
      status: runStatus.parse(row[3])
    }))
  }

  metadata(runId: string) {
    const row = this.store.db.exec(
      "SELECT workflow_id,call_key,input,parent_owner,parent_fence,workflow_generation,result FROM bot_workflow_children WHERE run_id=?",
      [runId]
    )[0]?.values[0]
    if (!row) return null
    return {
      workflowId: z.string().parse(row[0]),
      key: z.string().parse(row[1]),
      input: workflowAgentRequest.parse(JSON.parse(z.string().parse(row[2]))),
      parentLease: {
        runId: this.store.getRun(runId).parentRunId!,
        owner: z.string().parse(row[3]),
        fence: z.number().parse(row[4])
      },
      generation: z.number().parse(row[5]),
      result:
        row[6] === null ? null : workflowAgentResult.parse(JSON.parse(z.string().parse(row[6])))
    }
  }

  reserve(workflow: BotWorkflowStore, parent: BotRunLease, raw: BotWorkflowChildInput) {
    return this.acquire(workflow, parent, raw, true).run
  }

  claim(workflow: BotWorkflowStore, parent: BotRunLease, raw: BotWorkflowChildInput) {
    return this.acquire(workflow, parent, raw, false)
  }

  private acquire(
    workflow: BotWorkflowStore,
    parent: BotRunLease,
    raw: BotWorkflowChildInput,
    reserveOnly: boolean
  ) {
    const input = workflowAgentRequest.parse(raw)
    if (input.browserAccess) {
      const profile = resolveProfileFromList(workflow.input.agentProfiles, input.agentType)
      if (
        !isBotBrowserTaskProfile(profile) ||
        input.roleSystemPrompt !== profile?.systemPrompt ||
        input.shellAccess !== profile?.shellAccess ||
        input.disallowedTools?.length !== 0 ||
        input.isolation
      )
        throw new BotDomainError("workflow_browser_scope", "浏览器子任务缺少可信内置能力")
    }
    if (input.desktopAccess) {
      const profile = resolveProfileFromList(workflow.input.agentProfiles, input.agentType)
      const args = backgroundTaskArguments.safeParse(workflow.state.args)
      if (
        workflow.state.script !== BOT_BACKGROUND_TASK_SCRIPT ||
        !args.success ||
        args.data.taskType !== "computer" ||
        !isBotComputerTaskProfile(profile) ||
        !isBotComputerTaskInput(input)
      )
        throw new BotDomainError("workflow_desktop_scope", "工作应用子任务缺少可信内置授权")
    }
    const fingerprint = identity(input)
    return this.store.transaction(() => {
      workflow.assertOwner(parent)
      const owner = this.store.assertDispatch(parent, true)
      if (!this.isBackground(workflow.id)) this.store.steering.assertNoPending(owner.id)
      if (owner.source === BOT_WORKFLOW_CHILD_SOURCE)
        throw new BotDomainError("workflow_depth", "子任务不能递归派发工作流")
      const previous = this.store.db.exec(
        "SELECT run_id,fingerprint,input FROM bot_workflow_children WHERE workflow_id=? AND call_key=?",
        [workflow.id, input.durableCallKey]
      )[0]?.values[0]
      if (
        input.desktopAccess &&
        (!previous || this.store.getRun(z.string().parse(previous[0])).status !== "succeeded")
      )
        assertNativeTaskAvailable(
          this.store,
          owner.botId,
          previous ? z.string().parse(previous[0]) : undefined
        )
      let runId: string
      if (previous) {
        if (!matchesStoredIdentity(previous[1], previous[2], input))
          throw new BotDomainError(
            "workflow_child_identity",
            "子任务输入或权限已变化，不能复用旧执行记录"
          )
        runId = z.string().parse(previous[0])
        const run = this.store.getRun(runId)
        if (reserveOnly) return { run, result: null, lease: null }
        if (run.status === "succeeded") {
          const result = this.metadata(runId)!.result
          if (!result) throw new BotDomainError("workflow_child_result", "子任务缺少完整结果收据")
          return { run, result, lease: null }
        }
        if (run.status !== "queued")
          throw new BotDomainError(
            "workflow_child_unavailable",
            `子任务“${input.label}”状态为 ${run.status}：${run.error ?? "请先核对或结束原执行"}`
          )
      } else {
        const count = Number(
          this.store.db.exec(
            "SELECT COUNT(*) FROM bot_workflow_children c JOIN bot_runs r ON r.id=c.run_id WHERE r.root_run_id=?",
            [owner.rootRunId]
          )[0]?.values[0]?.[0] ?? 0
        )
        if (count >= 1000)
          throw new BotDomainError("workflow_child_limit", "当前任务的子任务数量已达上限")
        runId = randomUUID()
        this.store.db.run(
          `INSERT INTO bot_runs(id,bot_id,conversation_id,message_id,parent_run_id,root_run_id,depth,lane,source,status,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,'agent',?,'queued',?,?)`,
          [
            runId,
            owner.botId,
            owner.conversationId,
            owner.messageId,
            owner.id,
            owner.rootRunId,
            owner.depth + 1,
            BOT_WORKFLOW_CHILD_SOURCE,
            this.store.now(),
            this.store.now()
          ]
        )
        this.store.db.run("INSERT INTO bot_workflow_children VALUES(?,?,?,?,?,?,?,?,NULL)", [
          runId,
          workflow.id,
          input.durableCallKey,
          fingerprint,
          workflowEncode(input),
          parent.owner,
          parent.fence,
          0
        ])
        this.event("run.queued", runId, {
          botId: owner.botId,
          conversationId: owner.conversationId,
          parentRunId: owner.id,
          label: input.label
        })
      }
      if (reserveOnly) return { run: this.store.getRun(runId), result: null, lease: null }
      const generation = this.store.db.exec("SELECT generation FROM bot_workflows WHERE id=?", [
        workflow.id
      ])[0].values[0][0]
      this.store.db.run(
        "UPDATE bot_workflow_children SET parent_owner=?,parent_fence=?,workflow_generation=? WHERE run_id=?",
        [parent.owner, parent.fence, generation, runId]
      )
      this.store.db.run(
        "UPDATE bot_runs SET status='running',lease_owner=?,lease_until=?,fence=fence+1,revision=revision+1,updated_at=? WHERE id=?",
        [parent.owner, owner.leaseUntil!, this.store.now(), runId]
      )
      const run = this.store.getRun(runId)
      const lease = { runId, owner: parent.owner, fence: run.fence }
      this.event("run.started", runId, {
        botId: run.botId,
        fence: run.fence,
        parentRunId: owner.id,
        label: input.label
      })
      return { run, lease, result: null }
    })
  }

  private isBackground(workflowId: string): boolean {
    return Boolean(
      this.store.db.exec("SELECT 1 FROM bot_background_workflows WHERE workflow_id=?", [
        workflowId
      ])[0]?.values.length
    )
  }

  assertParent(runId: string): void {
    const child = this.metadata(runId)
    if (!child) throw new BotDomainError("workflow_child_scope", "子任务缺少所属工作流")
    const parent = this.store.assertDispatch(child.parentLease, true)
    if (!this.isBackground(child.workflowId)) this.store.steering.assertNoPending(parent.id)
    const row = this.store.db.exec("SELECT run_id,generation FROM bot_workflows WHERE id=?", [
      child.workflowId
    ])[0]?.values[0]
    if (row?.[0] !== parent.id || row?.[1] !== child.generation)
      throw new BotDomainError("workflow_stale_writer", "子任务所属工作流已被接替")
  }

  private state(runId: string) {
    const row = this.store.db.exec(
      "SELECT structured,usage,repairs FROM bot_workflow_child_state WHERE run_id=?",
      [runId]
    )[0]?.values[0]
    return {
      structured: row?.[0] ? JSON.parse(String(row[0])) : undefined,
      usage: z
        .record(z.string(), z.number().nonnegative())
        .parse(JSON.parse(String(row?.[1] ?? "{}"))),
      repairs: z.array(z.string()).parse(JSON.parse(String(row?.[2] ?? "[]")))
    }
  }

  readStructured(runId: string): unknown {
    return this.state(runId).structured
  }

  saveStructured(lease: BotRunLease, value: unknown): void {
    const payload = workflowEncode(value)
    if (Buffer.byteLength(payload, "utf8") > 256 * 1024)
      throw new BotDomainError("workflow_child_result", "结构化结果超过 256 KiB")
    this.store.transaction(() => {
      this.store.assertDispatch(lease)
      this.store.db.run(
        "INSERT INTO bot_workflow_child_state(run_id,structured) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET structured=excluded.structured",
        [lease.runId, payload]
      )
    })
  }

  clearStructured(lease: BotRunLease): void {
    this.store.transaction(() => {
      this.store.assertDispatch(lease)
      this.store.db.run("UPDATE bot_workflow_child_state SET structured=NULL WHERE run_id=?", [
        lease.runId
      ])
    })
  }

  requestStructuredRepair(lease: BotRunLease, invocation: string): number {
    return this.store.transaction(() => {
      this.store.assertDispatch(lease)
      const repairs = this.state(lease.runId).repairs
      if (!repairs.includes(invocation)) repairs.push(invocation)
      if (repairs.length > 2)
        throw new BotDomainError("workflow_child_schema", "结构化结果修复次数已用尽")
      this.store.db.run(
        "INSERT INTO bot_workflow_child_state(run_id,repairs) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET repairs=excluded.repairs",
        [lease.runId, JSON.stringify(repairs)]
      )
      return repairs.indexOf(invocation) + 1
    })
  }

  recordUsage(lease: BotRunLease, latest: Record<string, number>): void {
    const validated = z.record(z.string().max(512), z.number().nonnegative().finite()).parse(latest)
    this.store.transaction(() => {
      this.store.assertLease(lease, true)
      const usage = this.state(lease.runId).usage
      for (const [id, count] of Object.entries(validated))
        usage[id] = Math.max(usage[id] ?? 0, count)
      if (Object.keys(usage).length > 2000)
        throw new BotDomainError("workflow_child_usage", "子任务模型调用次数已达上限")
      this.store.db.run(
        "INSERT INTO bot_workflow_child_state(run_id,usage) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET usage=excluded.usage",
        [lease.runId, JSON.stringify(usage)]
      )
    })
  }

  outputTokens(runId: string): number {
    return Object.values(this.state(runId).usage).reduce((a, b) => a + b, 0)
  }

  renew(lease: BotRunLease): void {
    this.store.transaction(() => {
      if (this.isCollectingReceipt(lease.runId))
        this.store.assertLease(this.metadata(lease.runId)!.parentLease, true)
      else this.assertParent(lease.runId)
      const child = this.store.assertLease(lease, true, true)
      const parent = this.store.getRun(this.metadata(lease.runId)!.parentLease.runId)
      // Check parent/generation/child authority on every callback, but persist
      // only a changed deadline. The child must also inherit a shorter lease.
      if (child.leaseUntil === parent.leaseUntil) return
      this.store.db.run("UPDATE bot_runs SET lease_until=? WHERE id=?", [
        parent.leaseUntil!,
        lease.runId
      ])
    })
  }

  /** Superseded group work may collect a started external receipt. This does
   * not authorize a new tool/model call or an explicit user cancellation. */
  isCollectingReceipt(runId: string): boolean {
    return Boolean(
      this.store.db.exec(
        `SELECT 1 FROM bot_workflow_children c JOIN bot_runs child ON child.id=c.run_id
       JOIN bot_runs parent ON parent.id=child.parent_run_id JOIN bot_workflows w ON w.id=c.workflow_id
       WHERE c.run_id=? AND child.status='running' AND parent.status='running'
       AND child.lease_until>? AND parent.lease_until>? AND parent.lease_owner=c.parent_owner
       AND parent.fence=c.parent_fence AND w.generation=c.workflow_generation
       AND EXISTS(SELECT 1 FROM bot_run_drains d WHERE d.run_id=parent.id)
       AND EXISTS(SELECT 1 FROM bot_effects e WHERE e.run_id=child.id AND e.status='started')`,
        [runId, this.store.now(), this.store.now()]
      )[0]?.values.length
    )
  }

  settle(
    lease: BotRunLease,
    outcome: "succeeded" | "failed" | "cancelled",
    value: BotWorkflowChildResult | string,
    diagnostic?: BotErrorDiagnostic
  ) {
    return this.store.transaction(() => {
      this.store.assertLease(lease, outcome !== "succeeded", true)
      if (!this.metadata(lease.runId))
        throw new BotDomainError("workflow_child_scope", "不是工作流子任务")
      let content: string
      if (outcome === "succeeded") {
        const result = workflowAgentResult.parse(value)
        const serialized = workflowEncode(result)
        if (Buffer.byteLength(serialized, "utf8") > 512 * 1024)
          throw new BotDomainError("workflow_child_result", "子任务结构化结果超出保存上限")
        this.store.db.run("UPDATE bot_workflow_children SET result=? WHERE run_id=?", [
          serialized,
          lease.runId
        ])
        content = result.text
      } else content = z.string().max(128_000).parse(value)
      const run = this.finish(lease, outcome, content, diagnostic)
      if (run.status !== "succeeded")
        this.store.db.run("UPDATE bot_workflow_children SET result=NULL WHERE run_id=?", [
          lease.runId
        ])
      return run
    })
  }

  /** Live or unreviewed children must not disappear behind a successful parent. */
  outstanding(parentId: string) {
    return (
      this.store.db.exec(
        `SELECT r.id FROM bot_runs r JOIN bot_workflow_children c ON c.run_id=r.id
       WHERE r.parent_run_id=? AND r.status IN ('queued','running','waiting_input','cancelling','needs_review')`,
        [parentId]
      )[0]?.values ?? []
    ).map(([id]) => this.store.getRun(String(id)))
  }

  cancelChildren(parentId: string): void {
    for (const child of this.outstanding(parentId)) {
      if (child.status !== "needs_review") this.cancel(child.id)
    }
  }

  assertRecovery(runId: string, decision: "resume" | "cancel"): void {
    const children = this.outstanding(runId)
    if (children.some((child) => child.status !== "queued"))
      throw new BotDomainError(
        "workflow_child_review",
        "请先核对子任务中的未确认操作，再恢复父任务"
      )
    const child = this.metadata(runId)
    if (child && decision === "resume") {
      const parent = this.store.getRun(child.parentLease.runId)
      if (
        !["needs_review", "queued", "running", "waiting_input"].includes(parent.status) ||
        !this.store.groups.isCurrent(parent.id)
      )
        throw new BotDomainError("workflow_child_scope", "父任务已结束，不能单独恢复子任务")
    }
    if (decision === "cancel") this.cancelChildren(runId)
  }
}
