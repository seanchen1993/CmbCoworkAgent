import { serviceConversationInput } from "./service-conversation-boundary"
import type { Group } from "../../../shared/bot/contracts.generated"
import type {
  ServiceConversationOverview,
  ServicePage,
  ServiceRequestView,
  ServiceTaskView
} from "../../../shared/bot/service-conversation"
import type { PartnerLocalClient } from "./partner-local-client"
import { PartnerLocalFault, partnerId } from "./partner-local-boundary"
import type { PartnerRequirementRun } from "./requirement-execution-types"
import type { ServiceModelBinding } from "./service-model-binding"
import {
  SERVICE_PAGE_SIZE,
  ServiceConversationStore,
  serviceScopeKey,
  type ServiceScope,
  type ServiceRequestRecord
} from "./service-conversation-store"

export interface ServiceConversationContext {
  scope: ServiceScope
  client: PartnerLocalClient
  group: Group
  botVersionId: string
  expertName: string
  nodeEnabled: boolean
}
export interface ServiceConversationDependencies {
  store: ServiceConversationStore
  /** Must validate CURRENT transport identities, business group access and
   * membership/version bindings; no journal value grants read/write access. */
  context(): Promise<ServiceConversationContext>
  overview(): Promise<{ connected: boolean; nodeEnabled: boolean; expertName: string | null }>
  models(): Promise<Array<{ ref: string; name: string }>>
  model(ref: string): Promise<ServiceModelBinding>
  cancelOwned(runId: string): boolean
  cadenceMs?: number
}
const terminal = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"])
const uncertain = new Set([
  "DEPENDENCY_UNAVAILABLE",
  "NODE_OFFLINE",
  "STORAGE_FAILURE",
  "OUTCOME_UNKNOWN"
])
function view(r: ServiceRequestRecord): ServiceRequestView {
  return {
    requestId: r.requestId,
    taskRef: r.taskRef,
    text: r.text,
    status: r.status,
    notice: r.notice,
    runId: r.runId,
    result: r.result,
    createdAt: r.createdAt
  }
}
function cursor(scopeKey: string, kind: string, seq: number): string {
  return Buffer.from(JSON.stringify([scopeKey, kind, seq])).toString("base64url")
}
function after(raw: unknown, scopeKey: string, kind: string): number {
  if (raw === null) return 0
  if (typeof raw !== "string" || raw.length > 512) throw new PartnerLocalFault("INVALID_PAYLOAD")
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      v[0] !== scopeKey ||
      v[1] !== kind ||
      !Number.isSafeInteger(v[2]) ||
      v[2] < 1
    )
      throw Error()
    return v[2]
  } catch {
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  }
}
function textInput(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !raw.trim() ||
    raw.length > 16384 ||
    /[\u0000\uD800-\uDFFF]/u.test(raw)
  )
    throw new PartnerLocalFault("INVALID_PAYLOAD")
  return raw
}
function safeCode(error: unknown): string {
  return error instanceof PartnerLocalFault ? error.code : "DEPENDENCY_UNAVAILABLE"
}
/** A durable outbox, independent from the development panel's singleton receipt.
 * One recovery pump, serial writes and <=8 pending requests per turn. */
export class ServiceConversationService {
  private timer?: ReturnType<typeof setTimeout>
  private pumping?: Promise<void>
  private stopped = false
  private afterSeq = 0
  constructor(private readonly deps: ServiceConversationDependencies) {}
  async open(): Promise<ServiceConversationOverview> {
    const overview = await this.deps.overview()
    if (!overview.connected)
      return { ...overview, conversationId: null, selectedModel: null, models: [] }
    let c: ServiceConversationContext
    try {
      c = await this.deps.context()
    } catch (error) {
      if (error instanceof PartnerLocalFault && error.code === "NOT_CONFIGURED")
        return { ...overview, conversationId: null, selectedModel: null, models: [] }
      throw error
    }
    const conversation = this.deps.store.conversation(c.scope)
    let selectedModel: ServiceConversationOverview["selectedModel"] = null
    if (conversation.model) {
      try {
        const current = await this.deps.model(conversation.model.ref)
        if (current.hash === conversation.model.hash)
          selectedModel = { ref: current.ref, name: current.name }
      } catch {
        /* deleted/drifted model requires explicit selection */
      }
    }
    this.wake()
    return {
      conversationId: conversation.id,
      expertName: c.expertName,
      connected: true,
      nodeEnabled: c.nodeEnabled,
      selectedModel,
      models: await this.deps.models()
    }
  }
  async selectModel(raw: unknown): Promise<ServiceConversationOverview> {
    const v = serviceConversationInput("selectModel", raw)
    const c = await this.deps.context()
    if (
      !c.group.members.some((m) => m.principalId === c.scope.ownerPrincipalId && m.role === "admin")
    )
      throw new PartnerLocalFault("FORBIDDEN")
    this.deps.store.setModel(
      c.scope,
      partnerId(v.conversationId),
      await this.deps.model(partnerId(v.modelRef))
    )
    return this.open()
  }
  private async authorized(conversationId: unknown) {
    const c = await this.deps.context()
    const conversation = this.deps.store.requireConversation(c.scope, partnerId(conversationId))
    return { c, conversation, key: serviceScopeKey(c.scope) }
  }
  private async assertCurrent(key: string): Promise<void> {
    if (serviceScopeKey((await this.deps.context()).scope) !== key)
      throw new PartnerLocalFault("FORBIDDEN")
  }
  async tasks(raw: unknown): Promise<ServicePage<ServiceTaskView>> {
    const v = serviceConversationInput("tasks", raw),
      { c, key, conversation } = await this.authorized(v.conversationId)
    const records = this.deps.store.taskPage(key, conversation.id, after(v.cursor, key, "tasks")),
      page = records.slice(0, SERVICE_PAGE_SIZE)
    // Scope permission was revalidated above, including on terminal-only pages.
    return {
      items: page.map(({ task }) => ({
        taskRef: task.ref,
        taskNumber: task.task?.taskNumber ?? null,
        title: task.title,
        status: this.deps.store.latest(key, task.ref)?.status ?? "saved"
      })),
      nextCursor:
        records.length > SERVICE_PAGE_SIZE
          ? cursor(serviceScopeKey(c.scope), "tasks", page.at(-1)!.seq)
          : null
    }
  }
  async read(raw: unknown): Promise<ServicePage<ServiceRequestView>> {
    const v = serviceConversationInput("read", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef)
    if (this.deps.store.task(key, ref).conversationId !== conversation.id)
      throw new PartnerLocalFault("FORBIDDEN")
    const records = this.deps.store.requestPage(key, ref, after(v.cursor, key, ref)),
      page = records.slice(0, SERVICE_PAGE_SIZE)
    // Never disclose cached results solely on local possession. Inspect every
    // displayed Run with the current business credential, in bounded pairs.
    for (let i = 0; i < page.length; i += 2)
      await Promise.all(
        page.slice(i, i + 2).map(async (r) => {
          if (r.runId) await this.inspect(c, r)
        })
      )
    await this.assertCurrent(key)
    this.wake()
    return {
      items: [...page].reverse().map((r) => view(this.deps.store.request(key, r.requestId))),
      nextCursor: records.length > SERVICE_PAGE_SIZE ? cursor(key, ref, page.at(-1)!.seq) : null
    }
  }
  async updates(raw: unknown): Promise<ServiceRequestView[]> {
    const v = serviceConversationInput("updates", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef)
    if (this.deps.store.task(key, ref).conversationId !== conversation.id)
      throw new PartnerLocalFault("FORBIDDEN")
    const records = (v.requestIds as string[]).map((id) => this.deps.store.request(key, id))
    if (records.some((r) => r.taskRef !== ref || r.conversationId !== conversation.id))
      throw new PartnerLocalFault("FORBIDDEN")
    for (let i = 0; i < records.length; i += 2)
      await Promise.all(
        records.slice(i, i + 2).map(async (r) => {
          if (r.runId) await this.inspect(c, r)
        })
      )
    await this.assertCurrent(key)
    return records.map((r) => view(this.deps.store.request(key, r.requestId)))
  }
  async send(raw: unknown): Promise<ServiceRequestView> {
    const v = serviceConversationInput("send", raw),
      { c, key, conversation } = await this.authorized(v.conversationId)
    const ref = v.taskRef === null ? null : partnerId(v.taskRef),
      requestId = partnerId(v.requestId),
      text = textInput(v.text)
    // Replay an already accepted input independently of a later model selection.
    const old = this.deps.store.findRequest(key, requestId)
    if (old) {
      this.deps.store.accept(c.scope, conversation.id, ref, requestId, text)
      if (old.runId) await this.inspect(c, old)
      await this.assertCurrent(key)
      this.wake()
      return view(this.deps.store.request(key, requestId))
    }
    if (!conversation.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const selected = await this.deps.model(conversation.model.ref)
    if (selected.hash !== conversation.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    const accepted = this.deps.store.accept(
      c.scope,
      conversation.id,
      ref,
      requestId,
      text,
      selected
    )
    // Model is frozen for EACH accepted intent, before its first remote write.
    this.wake()
    return view(accepted)
  }
  async cancel(raw: unknown): Promise<void> {
    const v = serviceConversationInput("cancel", raw),
      { key, conversation } = await this.authorized(v.conversationId),
      requestId = partnerId(v.requestId)
    const r = this.deps.store.request(key, requestId)
    if (r.conversationId !== conversation.id) throw new PartnerLocalFault("FORBIDDEN")
    if (r.phase === "terminal") return
    this.deps.store.update(key, requestId, (value) => {
      value.cancelRequested = true
    })
    if (r.runId) this.deps.cancelOwned(r.runId)
    this.wake()
  }
  /** Worker/router only. HTTP enqueue responses never grant model execution. */
  claimed(scope: ServiceScope, run: PartnerRequirementRun): void {
    const key = serviceScopeKey(scope),
      r = this.deps.store.requestByCommand(key, run.commandId ?? "")
    if (!r) return
    this.deps.store.update(key, r.requestId, (value) => {
      if (value.runId && value.runId !== run.id)
        throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
      value.runId = run.id
      value.phase = "run"
      value.status = run.status as "starting" | "running"
    })
  }
  markRefused(scope: ServiceScope, run: PartnerRequirementRun, code: string): void {
    const key = serviceScopeKey(scope),
      r = this.deps.store.requestByCommand(key, run.commandId ?? "")
    if (r)
      this.deps.store.update(key, r.requestId, (v) => {
        v.notice = code
      })
  }
  markUnknown(scope: ServiceScope, run: PartnerRequirementRun): void {
    const key = serviceScopeKey(scope),
      r = this.deps.store.requestByCommand(key, run.commandId ?? "")
    if (r)
      this.deps.store.update(key, r.requestId, (v) => {
        v.status = "outcome_unknown"
        v.phase = "terminal"
        v.notice = "本机执行无法重放，需要核对服务结果；不会自动重新分析"
      })
  }
  cancelledBeforeStart(scope: ServiceScope, run: PartnerRequirementRun): boolean {
    return (
      this.deps.store.requestByCommand(serviceScopeKey(scope), run.commandId ?? "")
        ?.cancelRequested ?? false
    )
  }
  wake(): void {
    if (this.stopped || this.timer || this.pumping) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pump()
    }, 0)
  }
  async drain(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.pump()
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.pumping
  }
  private async pump(): Promise<void> {
    if (this.stopped) return
    if (this.pumping) return this.pumping
    this.pumping = this.performPump().finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  }
  private async performPump(): Promise<void> {
    let pending = false
    try {
      const c = await this.deps.context(),
        key = serviceScopeKey(c.scope)
      let batch = this.deps.store.pending(key, this.afterSeq)
      if (!batch.length) {
        this.afterSeq = 0
        batch = this.deps.store.pending(key, 0)
      }
      for (const original of batch) {
        if (this.stopped) break
        this.afterSeq = original.seq
        // Revalidate between requests so connection/role changes cannot replay
        // another scope while a prior HTTP call was in flight.
        const current = await this.deps.context()
        if (serviceScopeKey(current.scope) !== key) break
        try {
          await this.advance(current, original)
        } catch (error) {
          const code = safeCode(error)
          if (
            !uncertain.has(code) ||
            (original.deadline !== null && Date.now() >= Date.parse(original.deadline))
          )
            this.deps.store.update(key, original.requestId, (r) => {
              r.status = uncertain.has(code) ? "outcome_unknown" : "blocked"
              r.phase = "terminal"
              r.notice = code
            })
        }
      }
      pending = this.deps.store.hasPending(key)
    } catch {
      /* No cached disclosure/replay when current authorization fails. */
    }
    if (pending && !this.stopped)
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.pump()
      }, this.deps.cadenceMs ?? 2000)
  }
  private async inspect(c: ServiceConversationContext, r: ServiceRequestRecord): Promise<void> {
    const remote = await c.client.inspect(r.runId!)
    const run = remote.run
    if (
      run.taskId !== this.deps.store.task(r.scopeKey, r.taskRef).task?.id ||
      run.groupId !== c.scope.groupId ||
      run.botId !== c.scope.botId ||
      run.requesterPrincipalId !== c.scope.businessPrincipalId ||
      run.commandId !== r.enqueueCommand
    )
      throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
    const binding = this.deps.store.binding(r.scopeKey, r.enqueueCommand)
    if (
      !binding ||
      ![
        "taskId",
        "taskVersion",
        "stageId",
        "groupId",
        "groupVersion",
        "botId",
        "botVersionId",
        "nodeId",
        "ownerPrincipalId",
        "workspaceRef"
      ].every((k) => (binding as unknown as Record<string, unknown>)[k] === run[k]) ||
      Date.parse(binding.deadline) !== Date.parse(String(run.deadline)) ||
      (binding.runId !== null && binding.runId !== r.runId) ||
      (binding.attemptId !== null && binding.attemptId !== run.attemptId)
    )
      throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
    const status = String(run.status)
    if (!["queued", "waiting_node", "starting", "running", ...terminal].includes(status))
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    if (
      ["succeeded", "failed"].includes(status) !== (remote.result !== null) ||
      (remote.result && remote.result.outcome !== status)
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    if (r.result && remote.result && JSON.stringify(r.result) !== JSON.stringify(remote.result))
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (
      remote.result &&
      (remote.result.runId !== r.runId || remote.result.attemptId !== run.attemptId)
    )
      throw new PartnerLocalFault("INVALID_PAYLOAD")
    this.deps.store.update(r.scopeKey, r.requestId, (value) => {
      value.runVersion = Number(run.version)
      if (
        value.status === "outcome_unknown" &&
        ["starting", "running"].includes(status) &&
        !remote.result
      )
        return
      value.status = status as ServiceRequestRecord["status"]
      value.result = remote.result
      value.notice =
        status === "failed" && ["MODEL_CHANGED", "MODEL_UNAVAILABLE"].includes(value.notice ?? "")
          ? value.notice
          : status === "outcome_unknown"
            ? "需要核对执行结果；不会自动重新分析"
            : null
      value.phase = terminal.has(status) ? "terminal" : "run"
    })
  }
  private async advance(
    c: ServiceConversationContext,
    original: ServiceRequestRecord
  ): Promise<void> {
    const { store } = this.deps,
      key = original.scopeKey,
      id = original.requestId
    let r = store.request(key, id)
    if (r.phase === "terminal") return
    if (r.runId) {
      await this.inspect(c, r)
      r = store.request(key, id)
      if (r.cancelRequested && r.phase !== "terminal") {
        if (["queued", "waiting_node"].includes(r.status)) {
          try {
            await c.client.cancelPending(r.runId!, r.runVersion!)
          } catch (error) {
            if (
              !["COMMAND_CONFLICT", "VERSION_CONFLICT", "OUTCOME_UNKNOWN"].includes(safeCode(error))
            )
              throw error
          }
          await this.inspect(c, r)
        } else this.deps.cancelOwned(r.runId!)
      }
      return
    }
    if (r.cancelRequested && ["saved", "bind"].includes(r.phase)) {
      store.update(key, id, (v) => {
        v.phase = "terminal"
        v.status = "cancelled"
        v.notice = "请求已取消"
      })
      return
    }
    const previous = store.previousPending(r)
    if (previous) {
      store.update(key, id, (v) => {
        v.status = ["outcome_unknown", "blocked"].includes(previous.status)
          ? "blocked"
          : "next_round"
        v.notice = ["outcome_unknown", "blocked"].includes(previous.status)
          ? "前一轮需要核对或处理，未继续分析"
          : "已保存，将在前一轮结束后分析"
        if (["outcome_unknown", "blocked"].includes(previous.status)) v.phase = "terminal"
      })
      return
    }
    const model = r.model
    if (!model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const current = await this.deps.model(model.ref)
    if (current.hash !== model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    let record = store.task(key, r.taskRef)
    if (r.phase === "saved") {
      if (!record.task)
        r = store.update(key, id, (v) => {
          v.phase = "create"
          v.status = "submitting"
        })
      else {
        const task = await c.client.lookupTask(c.scope.groupId, record.task.taskNumber)
        if (task.id !== record.task.id || task.currentStageId !== record.task.currentStageId)
          throw new PartnerLocalFault("INPUT_CHANGED")
        r = store.update(key, id, (v) => {
          v.phase = "message"
          v.status = "submitting"
          v.expectedVersion = task.version
        })
      }
    }
    if (r.phase === "create") {
      const task = await c.client.createTask(c.scope.groupId, r.text, r.createCommand)
      if (task.spaceId !== c.scope.spaceId || task.groupId !== c.scope.groupId)
        throw new PartnerLocalFault("FORBIDDEN")
      store.saveTask(key, { ...record, task })
      record = store.task(key, r.taskRef)
      r = store.update(key, id, (v) => {
        v.phase = "bind"
        v.taskVersion = task.version
      })
    }
    if (r.phase === "message") {
      const result = await c.client.createMessage(
        { ...record.task!, version: r.expectedVersion! },
        r.text,
        r.messageCommand
      )
      if (
        result.message.taskId !== record.task!.id ||
        result.message.authorPrincipalId !== c.scope.businessPrincipalId ||
        result.taskVersion !== r.expectedVersion! + 1
      )
        throw new PartnerLocalFault("INVALID_PAYLOAD")
      store.saveTask(key, { ...record, task: { ...record.task!, version: result.taskVersion } })
      record = store.task(key, r.taskRef)
      r = store.update(key, id, (v) => {
        v.phase = "bind"
        v.taskVersion = result.taskVersion
      })
    }
    if (r.cancelRequested && r.phase === "bind") {
      store.update(key, id, (v) => {
        v.phase = "terminal"
        v.status = "cancelled"
        v.notice = "内容已保存，已取消分析"
      })
      return
    }
    if (r.phase === "bind") {
      if (!r.deadline)
        r = store.update(key, id, (v) => {
          v.deadline = new Date(Date.now() + 600000).toISOString()
        })
      const task = record.task!
      store.bind(key, {
        ...c.scope,
        commandId: r.enqueueCommand,
        taskId: task.id,
        taskVersion: r.taskVersion!,
        stageId: task.currentStageId,
        groupVersion: c.group.version,
        botVersionId: c.botVersionId,
        deadline: r.deadline!,
        model,
        kind: "service",
        runId: null,
        attemptId: null
      })
      r = store.update(key, id, (v) => {
        v.phase = "enqueue"
      })
    }
    if (r.phase === "enqueue") {
      // The persisted binding exists even if the node polls before this returns.
      const b = store.binding(key, r.enqueueCommand)!
      if (!b || b.groupVersion !== c.group.version || b.botVersionId !== c.botVersionId)
        throw new PartnerLocalFault("INPUT_CHANGED")
      const receipt = await c.client.enqueue(
        { ...record.task!, version: r.taskVersion! },
        c.scope.botId,
        r.enqueueCommand,
        r.deadline!
      )
      store.update(key, id, (v) => {
        if (v.runId && v.runId !== receipt.runId)
          throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
        v.runId = receipt.runId
        // This receipt only acknowledges admission. Claim/inspection may have
        // already advanced the request while the enqueue response was delayed.
        if (v.phase === "enqueue") {
          v.phase = "run"
          v.status = receipt.status as "queued" | "waiting_node"
        }
      })
    }
  }
}
