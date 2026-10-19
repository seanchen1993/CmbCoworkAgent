import { randomUUID } from "node:crypto"
import { parseCoordination } from "./expert-conversation-validation"
import type { ExpertAction } from "./service-expert-store"
import type { ServiceDeliveryView, TextDeliverySummary } from "../../../shared/bot/text-delivery"
import type { ServiceDeliveryAction } from "./service-delivery-store"
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
function view(r: ServiceRequestRecord, store: ServiceConversationStore): ServiceRequestView {
  if (r.profile) {
    let result = r.coordinationCancelled ? null : r.result
    let coordination: ServiceRequestView["coordination"]
    if (r.profile === "expert_main_v1" && result?.outcome === "succeeded") {
      const action = store.expert.get(r.scopeKey, "coordinate:" + r.requestId)
      try {
        const input = store.expert.input(r.scopeKey, r.requestId)
        if (!input) throw new Error()
        const envelope = parseCoordination(result.text, input)
        if (envelope.intent) {
          const delivered = action?.phase === "done"
          coordination = {
            taskRef: delivered ? action.targetRef : null,
            title:
              action?.receipt?.task.title ??
              (envelope.intent.kind === "create_task" ? envelope.intent.title : null),
            state: delivered ? "delivered" : action?.phase === "blocked" ? "blocked" : "waiting"
          }
          result = {
            ...result,
            text: delivered
              ? "已交办到任务会话。"
              : action?.phase === "blocked"
                ? "交办未完成，请核对权限后重新说明。"
                : "已保存交办意图，等待转入任务会话。"
          }
        } else result = { ...result, text: envelope.reply }
      } catch {
        result = null
      }
    }
    return {
      requestId: r.requestId,
      taskRef: r.taskRef,
      text: r.text,
      status: r.coordinationCancelled ? "cancelled" : r.protocolFailure ? "failed" : r.status,
      notice: r.protocolFailure ? "回复格式无法识别，未交办；可以重新说明。" : r.notice,
      runId: r.runId,
      result,
      createdAt: r.createdAt,
      ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
      ...(r.origin ? { origin: r.origin } : {}),
      ...(coordination ? { coordination } : {})
    }
  }
  const publication = store.deliveries.get(r.scopeKey, "publish:" + r.requestId)
  return {
    requestId: r.requestId,
    taskRef: r.taskRef,
    text: r.text,
    ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}),
    status: r.status,
    notice: r.notice,
    runId: r.runId,
    ...(r.status === "succeeded"
      ? {
          publication: {
            state: publication
              ? publication.phase === "done"
                ? ("published" as const)
                : publication.phase === "blocked"
                  ? ("blocked" as const)
                  : ("saving" as const)
              : r.autoDelivery
                ? ("saving" as const)
                : ("history" as const),
            notice: publication?.notice ?? null
          }
        }
      : {}),
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
  private deliveryAfter = 0
  private expertAfter = 0
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
  async openChats() {
    const overview = await this.open()
    if (!overview.conversationId) return { ...overview, mainTaskRef: null }
    const { c, conversation } = await this.authorized(overview.conversationId)
    return { ...overview, mainTaskRef: this.deps.store.mainTask(c.scope, conversation.id).ref }
  }
  private async expertSummaries(c: ServiceConversationContext, refs: string[]) {
    const store = this.deps.store,
      key = serviceScopeKey(c.scope)
    const tasks = refs.map((ref) => store.task(key, ref)).filter((t) => t.task)
    if (!tasks.length) return
    const values = await c.client.expertConversationSummaries(
      c.scope.groupId,
      c.scope.botId,
      tasks.map((t) => t.task!.id)
    )
    await this.assertCurrent(key)
    for (const value of values)
      store.expert.saveSummary(key, tasks.find((t) => t.task!.id === value.taskId)!.ref, value)
  }
  async chatTasks(raw: unknown): Promise<ServicePage<ServiceTaskView>> {
    const v = serviceConversationInput("chatTasks", raw),
      { c, key, conversation } = await this.authorized(v.conversationId)
    const kind = "chatTasks:" + v.query,
      records = this.deps.store.chatTaskPage(
        key,
        conversation.id,
        after(v.cursor, key, kind),
        String(v.query)
      ),
      page = records.slice(0, SERVICE_PAGE_SIZE)
    const focus = v.selectedRef ? this.deps.store.task(key, partnerId(v.selectedRef)) : null
    if (focus && focus.conversationId !== conversation.id) throw new PartnerLocalFault("FORBIDDEN")
    const refs = [...new Set([...page.map((t) => t.task.ref), ...(focus ? [focus.ref] : [])])]
    for (let i = 0; i < refs.length; i += 40) await this.expertSummaries(c, refs.slice(i, i + 40))
    await this.assertCurrent(key)
    const item = (task: (typeof page)[number]["task"]): ServiceTaskView => {
      const summary = this.deps.store.expert.summary(key, task.ref)
      return {
        taskRef: task.ref,
        taskNumber: task.task?.taskNumber ?? null,
        title: task.title,
        status: this.deps.store.latest(key, task.ref)?.status ?? "saved",
        role: "task",
        taskStatus: summary?.status ?? (task.task?.status === "completed" ? "completed" : "active"),
        busy: summary?.busy ?? false
      }
    }
    return {
      pending: this.deps.store.hasPending(key) || this.deps.store.expert.hasPending(key),
      ...(focus ? { selectedTask: item(focus) } : {}),
      items: page.map(({ task }) => item(task)),
      nextCursor: records.length > SERVICE_PAGE_SIZE ? cursor(key, kind, page.at(-1)!.seq) : null
    }
  }
  async chat(raw: unknown): Promise<ServiceRequestView> {
    const v = serviceConversationInput("chat", raw),
      { c, key, conversation } = await this.authorized(v.conversationId)
    const profile = v.role === "main" ? "expert_main_v1" : "expert_task_v1"
    const ref =
      v.role === "main"
        ? this.deps.store.mainTask(c.scope, conversation.id).ref
        : v.taskRef === null
          ? null
          : partnerId(v.taskRef)
    const id = partnerId(v.requestId),
      text = textInput(v.text),
      old = this.deps.store.findRequest(key, id)
    if (old) {
      this.deps.store.accept(c.scope, conversation.id, ref, id, text, null, undefined, profile)
      if (old.runId) await this.inspect(c, old)
      await this.assertCurrent(key)
      this.wake()
      return view(this.deps.store.request(key, id), this.deps.store)
    }
    const revision = ref ? this.deps.store.expert.lifecycleRevision(key, ref) : 0
    if (ref) {
      const task = this.deps.store.task(key, ref)
      if (task.conversationId !== conversation.id || (task.role === "main") !== (v.role === "main"))
        throw new PartnerLocalFault("FORBIDDEN")
      await this.expertSummaries(c, [ref])
      if (this.deps.store.expert.summary(key, ref)?.status === "completed")
        throw new PartnerLocalFault("INPUT_CHANGED")
    }
    if (!conversation.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const model = await this.deps.model(conversation.model.ref)
    if (model.hash !== conversation.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    await this.assertCurrent(key)
    // The last check and SQLite admission are synchronous: completion wins or
    // the message wins, even when a model lookup was delayed in another IPC.
    if (
      ref &&
      (revision !== this.deps.store.expert.lifecycleRevision(key, ref) ||
        this.deps.store.expert.summary(key, ref)?.status === "completed" ||
        (this.deps.store.expert.hasPending(key, ref) && v.role === "task"))
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    const accepted = this.deps.store.accept(
      c.scope,
      conversation.id,
      ref,
      id,
      text,
      model,
      undefined,
      profile
    )
    this.wake()
    return view(accepted, this.deps.store)
  }
  private expertAction(
    key: string,
    conversationId: string,
    id: string,
    kind: ExpertAction["kind"],
    ref: string | null
  ): ExpertAction {
    return {
      scopeKey: key,
      id,
      conversationId,
      kind,
      commandId: "ec:" + randomUUID(),
      targetRef: ref,
      sourceRequestId: null,
      sourceRunId: null,
      intent: null,
      expectedVersion: null,
      phase: "remote",
      receipt: null,
      childRequestId: null,
      notice: null
    }
  }
  async taskLifecycle(raw: unknown): Promise<void> {
    const v = serviceConversationInput("taskLifecycle", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef),
      store = this.deps.store
    const task = store.task(key, ref)
    if (task.conversationId !== conversation.id || task.role === "main" || !task.task)
      throw new PartnerLocalFault("FORBIDDEN")
    const action = this.expertAction(
      key,
      conversation.id,
      partnerId(v.operationId),
      v.action as "complete" | "reopen",
      ref
    )
    const prior = store.expert.get(key, action.id)
    if (prior) {
      store.expert.accept(action)
      await this.expertSummaries(c, [ref])
      this.wake()
      return
    }
    await this.expertSummaries(c, [ref])
    const summary = store.expert.summary(key, ref)!
    if (
      (action.kind === "complete" && summary.status === "completed") ||
      (action.kind === "reopen" && summary.status !== "completed") ||
      summary.busy
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    action.expectedVersion = summary.taskVersion
    await this.assertCurrent(key)
    if (
      store.expert.hasPending(key, ref) ||
      (action.kind === "complete" &&
        (store.hasTaskPending(key, ref) ||
          store.hasPendingMain(key) ||
          store.deliveries.hasPending(key, ref)))
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    store.expert.accept(action)
    this.wake()
  }
  async retryChat(raw: unknown): Promise<void> {
    const v = serviceConversationInput("retryChat", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      store = this.deps.store,
      ref = partnerId(v.taskRef),
      source = store.request(key, partnerId(v.requestId))
    if (source.taskRef !== ref || source.conversationId !== conversation.id || !source.profile)
      throw new PartnerLocalFault("FORBIDDEN")
    const a = this.expertAction(key, conversation.id, partnerId(v.operationId), "retry", ref)
    a.sourceRequestId = source.requestId
    if (store.expert.get(key, a.id)) {
      store.expert.accept(a)
      await this.expertSummaries(c, [ref])
      this.wake()
      return
    }
    if (source.runId) await this.inspect(c, source)
    const known = store.request(key, source.requestId)
    if (!known.protocolFailure && !["failed", "cancelled", "blocked"].includes(known.status))
      throw new PartnerLocalFault("INPUT_CHANGED")
    await this.expertSummaries(c, [ref])
    const summary = store.expert.summary(key, ref)
    if (summary?.status === "completed" || summary?.busy)
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (!conversation.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const model = await this.deps.model(conversation.model.ref)
    if (model.hash !== conversation.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    a.model = model
    a.expectedVersion = summary?.taskVersion ?? known.taskVersion
    a.childRequestId = "ec-retry:" + randomUUID()
    await this.assertCurrent(key)
    if (
      store.expert.hasPending(key, ref) ||
      store.hasTaskPending(key, ref, known.requestId) ||
      store.request(key, known.requestId).supersededBy ||
      store.expert.summary(key, ref)?.status === "completed"
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    store.expert.accept(a)
    this.wake()
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
    await this.loadSummaries(
      c,
      key,
      page.map(({ task }) => task)
    )
    await this.assertCurrent(key)
    return {
      items: page.map(({ task }) => ({
        taskRef: task.ref,
        taskNumber: task.task?.taskNumber ?? null,
        title: task.title,
        status: this.deps.store.latest(key, task.ref)?.status ?? "saved",
        delivery: this.deps.store.deliveries.summary(key, task.ref)
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
    // One current task authorization covers the bounded local history page.
    // Pending Runs still inspect execution state; terminal results are immutable.
    if (typeof c.client.expertConversationSummaries === "function")
      await this.expertSummaries(c, [ref])
    for (let i = 0; i < page.length; i += 2)
      await Promise.all(
        page.slice(i, i + 2).map(async (r) => {
          if (
            r.runId &&
            (typeof c.client.expertConversationSummaries !== "function" || !terminal.has(r.status))
          )
            await this.inspect(c, r)
        })
      )
    await this.assertCurrent(key)
    this.wake()
    return {
      task: (() => {
        const task = this.deps.store.task(key, ref),
          summary = this.deps.store.expert.summary(key, ref)
        return {
          taskRef: ref,
          title: task.title,
          taskNumber: task.task?.taskNumber ?? null,
          role: task.role ?? "task",
          status: this.deps.store.latest(key, ref)?.status ?? "saved",
          taskStatus:
            summary?.status ?? (task.task?.status === "completed" ? "completed" : "active"),
          busy: summary?.busy ?? false
        }
      })(),
      items: [...page]
        .reverse()
        .map((r) => view(this.deps.store.request(key, r.requestId), this.deps.store)),
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
    if (typeof c.client.expertConversationSummaries === "function")
      await this.expertSummaries(c, [ref])
    for (let i = 0; i < records.length; i += 2)
      await Promise.all(
        records.slice(i, i + 2).map(async (r) => {
          if (
            r.runId &&
            (typeof c.client.expertConversationSummaries !== "function" || !terminal.has(r.status))
          )
            await this.inspect(c, r)
        })
      )
    await this.assertCurrent(key)
    return records.map((r) => view(this.deps.store.request(key, r.requestId), this.deps.store))
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
      return view(this.deps.store.request(key, requestId), this.deps.store)
    }
    if (ref) {
      const summary = await this.currentSummary(c, key, ref)
      if (summary.taskStatus === "completed") throw new PartnerLocalFault("INPUT_CHANGED")
    }
    if (!conversation.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const selected = await this.deps.model(conversation.model.ref)
    if (selected.hash !== conversation.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    await this.assertCurrent(key)
    if (
      ref &&
      (this.deps.store.deliveries.hasReviewIntent(key, ref) ||
        this.deps.store.deliveries.summary(key, ref)?.taskStatus === "completed")
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
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
    return view(accepted, this.deps.store)
  }
  private async loadSummaries(
    c: ServiceConversationContext,
    key: string,
    tasks: Array<{ ref: string; task: { id: string } | null }>
  ): Promise<void> {
    const existing = tasks.filter((t) => t.task)
    if (!existing.length) return
    const summaries = await c.client.deliverySummaries(existing.map((t) => t.task!.id))
    await this.assertCurrent(key)
    for (const value of summaries) {
      const record = existing.find((t) => t.task!.id === value.taskId)!
      if (
        value.head &&
        (value.head.botId !== c.scope.botId || value.head.groupId !== c.scope.groupId)
      )
        throw new PartnerLocalFault("FORBIDDEN")
      this.deps.store.deliveries.saveSummary(key, record.ref, value)
    }
  }
  private async currentSummary(
    c: ServiceConversationContext,
    key: string,
    ref: string
  ): Promise<TextDeliverySummary> {
    const task = this.deps.store.task(key, ref)
    if (!task.task) throw new PartnerLocalFault("INPUT_CHANGED")
    await this.loadSummaries(c, key, [task])
    return this.deps.store.deliveries.summary(key, ref)!
  }
  async delivery(raw: unknown): Promise<ServiceDeliveryView | null> {
    const v = serviceConversationInput("delivery", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef),
      task = this.deps.store.task(key, ref)
    if (task.conversationId !== conversation.id) throw new PartnerLocalFault("FORBIDDEN")
    if (!task.task) return null
    const summary = await this.currentSummary(c, key, ref),
      page = await c.client.deliveryVersions(
        task.task.id,
        v.before === null ? undefined : Number(v.before)
      )
    await this.assertCurrent(key)
    return {
      summary,
      versions: page.items,
      nextBefore: page.nextBefore,
      actions: this.deps.store.deliveries.actions(key, ref).map((a) => ({
        id: a.id,
        kind: a.kind,
        state: a.phase === "done" ? "done" : a.phase === "blocked" ? "blocked" : "saving",
        notice: a.notice,
        requestId: a.requestId
      }))
    }
  }
  async deliveryVersion(raw: unknown) {
    const v = serviceConversationInput("deliveryVersion", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      task = this.deps.store.task(key, partnerId(v.taskRef))
    if (task.conversationId !== conversation.id || !task.task)
      throw new PartnerLocalFault("FORBIDDEN")
    const detail = await c.client.deliveryVersion(task.task.id, partnerId(v.versionId))
    await this.assertCurrent(key)
    if (detail.version.botId !== c.scope.botId || detail.version.groupId !== c.scope.groupId)
      throw new PartnerLocalFault("FORBIDDEN")
    return detail
  }
  private action(
    key: string,
    ref: string,
    id: string,
    kind: ServiceDeliveryAction["kind"]
  ): ServiceDeliveryAction {
    return {
      id,
      scopeKey: key,
      taskRef: ref,
      kind,
      phase: "prepare",
      notice: null,
      requestId: null,
      runId: null,
      versionId: null,
      comment: null,
      commandId: "td:" + randomUUID(),
      expectedTaskVersion: null,
      expectedReviewVersion: null,
      receipt: null,
      model: null,
      revisionRequestId: kind === "reject" || kind === "retry" ? randomUUID() : null
    }
  }
  private schedulePublication(r: ServiceRequestRecord): void {
    const action: ServiceDeliveryAction = {
      id: "publish:" + r.requestId,
      scopeKey: r.scopeKey,
      taskRef: r.taskRef,
      kind: "publish",
      phase: "prepare",
      notice: null,
      requestId: r.requestId,
      runId: r.runId,
      versionId: null,
      comment: null,
      commandId: "td-publish:" + randomUUID(),
      expectedTaskVersion: r.taskVersion,
      expectedReviewVersion: null,
      receipt: null,
      model: null,
      revisionRequestId: null
    }
    this.deps.store.deliveries.accept(action)
    this.deps.store.update(r.scopeKey, r.requestId, (value) => {
      value.publicationScheduled = true
    })
  }
  async publish(raw: unknown): Promise<void> {
    const v = serviceConversationInput("publish", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      r = this.deps.store.request(key, partnerId(v.requestId))
    if (r.conversationId !== conversation.id || !r.runId) throw new PartnerLocalFault("FORBIDDEN")
    await this.inspect(c, r)
    await this.assertCurrent(key)
    const current = this.deps.store.request(key, r.requestId)
    if (current.status !== "succeeded") throw new PartnerLocalFault("INPUT_CHANGED")
    this.schedulePublication(current)
    this.wake()
  }
  async review(raw: unknown): Promise<void> {
    const v = serviceConversationInput("review", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef),
      task = this.deps.store.task(key, ref)
    if (task.conversationId !== conversation.id) throw new PartnerLocalFault("FORBIDDEN")
    const action = this.action(
      key,
      ref,
      partnerId(v.operationId),
      v.decision as "approve" | "reject"
    )
    action.versionId = partnerId(v.versionId)
    action.comment = v.comment as string | null
    const prior = this.deps.store.deliveries.get(key, action.id)
    if (prior) {
      this.deps.store.deliveries.accept(action)
      await this.currentSummary(c, key, ref)
      this.wake()
      return
    }
    const summary = await this.currentSummary(c, key, ref)
    if (!summary.canReview || summary.head?.versionId !== action.versionId)
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (this.deps.store.hasTaskPending(key, ref) || this.deps.store.deliveries.hasPending(key, ref))
      throw new PartnerLocalFault("INPUT_CHANGED")
    action.expectedTaskVersion = summary.taskVersion
    action.expectedReviewVersion = summary.head.revision
    action.phase = "remote"
    if (action.kind === "reject" && conversation.model) action.model = conversation.model
    await this.assertCurrent(key)
    // No await between this final admission check and the durable review intent.
    if (this.deps.store.hasTaskPending(key, ref) || this.deps.store.deliveries.hasPending(key, ref))
      throw new PartnerLocalFault("INPUT_CHANGED")
    this.deps.store.deliveries.accept(action)
    this.wake()
  }
  async retryRevision(raw: unknown): Promise<void> {
    const v = serviceConversationInput("retryRevision", raw),
      { c, key, conversation } = await this.authorized(v.conversationId),
      ref = partnerId(v.taskRef),
      prior = this.deps.store.deliveries.get(key, partnerId(v.actionId))
    if (
      !prior ||
      prior.taskRef !== ref ||
      prior.receipt?.decision?.decision !== "reject" ||
      !prior.revisionRequestId
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    const replay = this.deps.store.deliveries.get(key, partnerId(v.operationId))
    if (replay) {
      if (
        replay.kind !== "retry" ||
        replay.taskRef !== ref ||
        replay.versionId !== prior.versionId ||
        replay.comment !== prior.comment
      )
        throw new PartnerLocalFault("COMMAND_CONFLICT")
      await this.currentSummary(c, key, ref)
      this.wake()
      return
    }
    const old =
      this.deps.store.findRequest(key, prior.revisionRequestId) ??
      (prior.sourceRequestId ? this.deps.store.findRequest(key, prior.sourceRequestId) : null)
    if (old?.runId) await this.inspect(c, old)
    const previous = old ? this.deps.store.request(key, old.requestId) : null
    if (previous && !["failed", "cancelled", "blocked"].includes(previous.status))
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (
      this.deps.store.hasTaskPending(key, ref, previous?.requestId) ||
      this.deps.store.deliveries.hasPending(key, ref)
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    const summary = await this.currentSummary(c, key, ref)
    if (
      summary.taskStatus !== "active" ||
      summary.head?.versionId !== prior.receipt.versionId ||
      summary.head.reviewerPrincipalId !== c.scope.businessPrincipalId
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    if (!conversation.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
    const model = await this.deps.model(conversation.model.ref)
    if (model.hash !== conversation.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
    const action = this.action(key, ref, partnerId(v.operationId), "retry")
    action.phase = "revision"
    action.sourceRequestId = previous?.requestId ?? null
    action.receipt = prior.receipt
    action.versionId = prior.versionId
    action.comment = prior.comment
    action.model = model
    action.expectedTaskVersion = summary.taskVersion
    await this.assertCurrent(key)
    if (
      this.deps.store.hasTaskPending(key, ref, previous?.requestId) ||
      this.deps.store.deliveries.hasPending(key, ref) ||
      (previous && this.deps.store.request(key, previous.requestId).supersededBy)
    )
      throw new PartnerLocalFault("INPUT_CHANGED")
    this.deps.store.deliveries.accept(action)
    this.wake()
  }
  private async advanceDelivery(
    c: ServiceConversationContext,
    original: ServiceDeliveryAction
  ): Promise<void> {
    const store = this.deps.store,
      actions = store.deliveries,
      key = original.scopeKey,
      task = store.task(key, original.taskRef)
    if (!task.task) throw new PartnerLocalFault("INPUT_CHANGED")
    let a = actions.get(key, original.id)!
    if (a.phase === "prepare") {
      const summary = await this.currentSummary(c, key, a.taskRef)
      a.expectedReviewVersion = summary.head?.revision ?? 0
      a.phase = "remote"
      actions.save(a)
    }
    if (a.phase === "remote") {
      const base = {
        commandId: a.commandId,
        taskId: task.task.id,
        expectedTaskVersion: a.expectedTaskVersion!,
        expectedReviewVersion: a.expectedReviewVersion!
      }
      const receipt =
        a.kind === "publish"
          ? await c.client.publishTextDelivery({ ...base, runId: a.runId! })
          : await c.client.decideTextDelivery({
              ...base,
              versionId: a.versionId!,
              decision: a.kind as "approve" | "reject",
              comment: a.comment
            })
      a = {
        ...a,
        receipt,
        expectedTaskVersion:
          a.kind === "reject" ? receipt.summary.taskVersion : a.expectedTaskVersion,
        phase: a.kind === "reject" ? "revision" : "done",
        notice: null
      }
      actions.save(a)
      // A receipt proves the old mutation, never the current mutable review head.
      await this.currentSummary(c, key, a.taskRef)
    }
    if (a.phase === "revision") {
      const summary = await this.currentSummary(c, key, a.taskRef)
      const existing = store.findRequest(key, a.revisionRequestId!)
      if (existing) {
        a.requestId = existing.requestId
        a.phase = "done"
        actions.save(a)
        return
      }
      if (summary.taskStatus !== "active" || summary.head?.versionId !== a.receipt!.versionId)
        throw new PartnerLocalFault("INPUT_CHANGED")
      if (!a.model) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
      const model = await this.deps.model(a.model.ref)
      if (model.hash !== a.model.hash) throw new PartnerLocalFault("MODEL_CHANGED")
      await this.assertCurrent(key)
      if (a.sourceRequestId) {
        const source = store.request(key, a.sourceRequestId)
        if (source.runId) await this.inspect(c, source)
        const known = store.request(key, source.requestId)
        if (!["failed", "cancelled", "blocked"].includes(known.status))
          throw new PartnerLocalFault("INPUT_CHANGED")
        store.update(key, known.requestId, (r) => {
          r.supersededBy = a.revisionRequestId!
        })
      }
      const conversation = store.requireConversation(c.scope, task.conversationId)
      const r = store.acceptRevision(
        c.scope,
        conversation.id,
        task.ref,
        a.revisionRequestId!,
        a.receipt!.decision!.comment!,
        model,
        a.expectedTaskVersion ?? a.receipt!.summary.taskVersion
      )
      a.requestId = r.requestId
      a.phase = "done"
      actions.save(a)
    }
  }
  private async advanceExpert(
    c: ServiceConversationContext,
    original: ExpertAction
  ): Promise<void> {
    const store = this.deps.store,
      key = original.scopeKey
    let a = store.expert.get(key, original.id)!
    if (a.phase === "remote" && a.kind === "coordinate") {
      if (store.request(key, a.sourceRequestId!).cancelRequested && !a.remoteStarted) {
        a.phase = "done"
        a.notice = "交办已停止，未转入任务。"
        store.expert.save(a)
        store.update(key, a.sourceRequestId!, (value) => {
          value.coordinationDone = true
          value.coordinationCancelled = true
        })
        return
      }
      if (a.intent?.kind === "append_task") {
        const target = store.taskByServer(key, a.intent.targetTaskRef)
        if (!target) throw new PartnerLocalFault("FORBIDDEN")
        await this.expertSummaries(c, [target.ref])
        const summary = store.expert.summary(key, target.ref)!
        // Preserve the original source/action/command while the exact target is
        // busy, unknown or closed. Reopen remains an explicit user operation.
        if (
          summary.busy ||
          summary.status === "completed" ||
          store.hasTaskPending(key, target.ref) ||
          store.deliveries.hasPending(key, target.ref)
        )
          return
      }
      if (store.request(key, a.sourceRequestId!).cancelRequested && !a.remoteStarted) {
        a.phase = "done"
        a.notice = "交办已停止，未转入任务。"
        store.expert.save(a)
        store.update(key, a.sourceRequestId!, (value) => {
          value.coordinationDone = true
          value.coordinationCancelled = true
        })
        return
      }
      // Persist this uncertainty boundary before HTTP. A later stop can no
      // longer claim cancellation; it must recover this exact receipt.
      a.remoteStarted = true
      store.expert.save(a)
      const receipt = await c.client.coordinateExpertTask(a.commandId, a.sourceRunId!)
      if (
        receipt.botId !== c.scope.botId ||
        receipt.principalId !== c.scope.businessPrincipalId ||
        receipt.task.groupId !== c.scope.groupId ||
        receipt.sourceRunId !== a.sourceRunId ||
        (a.intent?.kind === "append_task" && receipt.task.id !== a.intent.targetTaskRef)
      )
        throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
      a.receipt = receipt
      a.phase = "child"
      store.expert.save(a)
    }
    if (a.phase === "remote" && (a.kind === "complete" || a.kind === "reopen")) {
      const task = store.task(key, a.targetRef!)
      if (!task.role) {
        const receipt = await c.client.ensureExpertConversation({
          commandId: a.commandId + ":adopt",
          groupId: c.scope.groupId,
          botId: c.scope.botId,
          role: "task",
          taskId: task.task!.id,
          title: task.title,
          goal: task.task!.goal
        })
        store.saveTask(key, { ...task, task: receipt.task, role: "task" })
      }
      const receipt = await c.client.expertTaskLifecycle({
        commandId: a.commandId,
        taskId: task.task!.id,
        expectedVersion: a.expectedVersion!,
        action: a.kind
      })
      a.receipt = receipt
      a.phase = "done"
      store.expert.save(a)
      // Current authorization and a monotonic summary, never a historical
      // mutation receipt, determine what can be sent next.
      await this.expertSummaries(c, [task.ref])
      if (receipt.task.version >= (store.task(key, task.ref).task?.version ?? 0))
        store.saveTask(key, { ...task, task: receipt.task, role: "task" })
      return
    }
    if (a.kind === "retry" && a.phase === "remote") {
      const old = store.request(key, a.sourceRequestId!)
      if (!old.protocolFailure && !["failed", "cancelled", "blocked"].includes(old.status))
        throw new PartnerLocalFault("INPUT_CHANGED")
      if (old.supersededBy && old.supersededBy !== a.childRequestId)
        throw new PartnerLocalFault("INPUT_CHANGED")
      // Both crash windows recover from this persisted action: supersession can
      // be repeated, and accept always uses the same child request identifier.
      store.update(key, old.requestId, (value) => {
        value.supersededBy = a.childRequestId!
      })
      store.accept(
        c.scope,
        a.conversationId,
        a.targetRef!,
        a.childRequestId!,
        old.text,
        a.model!,
        a.expectedVersion ?? undefined,
        old.profile
      )
      a.phase = "done"
      store.expert.save(a)
      return
    }
    if (a.phase === "child") {
      const record = store.attachExpertTask(c.scope, a.conversationId, a.receipt!.task)
      const source = store.request(key, a.sourceRequestId!)
      const child = store.accept(
        c.scope,
        a.conversationId,
        record.ref,
        a.childRequestId!,
        source.text,
        source.model,
        a.receipt!.task.version,
        "expert_task_v1"
      )
      store.update(key, child.requestId, (value) => {
        value.origin = { mainRequestId: source.requestId }
      })
      a.targetRef = record.ref
      a.phase = "done"
      store.expert.save(a)
    }
    if (a.kind === "coordinate" && a.phase === "done")
      store.update(key, a.sourceRequestId!, (value) => {
        value.coordinationDone = true
      })
  }
  private coordinateResult(r: ServiceRequestRecord): void {
    if (r.profile !== "expert_main_v1" || r.status !== "succeeded" || r.coordinationDone) return
    const store = this.deps.store,
      input = store.expert.input(r.scopeKey, r.requestId)
    if (
      r.cancelRequested &&
      !store.expert.get(r.scopeKey, "coordinate:" + r.requestId)?.remoteStarted
    ) {
      store.update(r.scopeKey, r.requestId, (value) => {
        value.coordinationDone = true
        value.coordinationCancelled = true
      })
      return
    }
    try {
      if (!input || !r.result) throw new PartnerLocalFault("COORDINATION_INVALID_OUTPUT")
      const envelope = parseCoordination(r.result.text, input)
      if (!envelope.intent) {
        store.update(r.scopeKey, r.requestId, (value) => {
          value.coordinationDone = true
        })
        return
      }
      const a = this.expertAction(
        r.scopeKey,
        r.conversationId,
        "coordinate:" + r.requestId,
        "coordinate",
        envelope.intent.kind === "append_task"
          ? (store.taskByServer(r.scopeKey, envelope.intent.targetTaskRef)?.ref ?? null)
          : null
      )
      a.intent = envelope.intent
      a.sourceRequestId = r.requestId
      a.sourceRunId = r.runId
      a.childRequestId = "ec-child:" + r.runId
      const accepted = store.expert.accept(a)
      if (accepted.phase === "done")
        store.update(r.scopeKey, r.requestId, (value) => {
          value.coordinationDone = true
        })
    } catch (error) {
      if (safeCode(error) !== "COORDINATION_INVALID_OUTPUT") throw error
      store.update(r.scopeKey, r.requestId, (value) => {
        value.coordinationDone = true
        value.protocolFailure = true
        value.notice = "COORDINATION_INVALID_OUTPUT"
      })
    }
  }
  async cancel(raw: unknown): Promise<void> {
    const v = serviceConversationInput("cancel", raw),
      { key, conversation } = await this.authorized(v.conversationId),
      requestId = partnerId(v.requestId)
    const r = this.deps.store.request(key, requestId)
    if (r.conversationId !== conversation.id) throw new PartnerLocalFault("FORBIDDEN")
    if (
      r.phase === "terminal" &&
      !(r.profile === "expert_main_v1" && r.status === "succeeded" && !r.coordinationDone)
    )
      return
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
  markProtocolFailure(scope: ServiceScope, run: PartnerRequirementRun): void {
    const key = serviceScopeKey(scope),
      r = this.deps.store.requestByCommand(key, run.commandId ?? "")
    if (r)
      this.deps.store.update(key, r.requestId, (value) => {
        value.protocolFailure = true
        value.coordinationDone = true
        value.notice = "COORDINATION_INVALID_OUTPUT"
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
          if (original.profile && code === "RATE_LIMITED") continue
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
      let deliveries = this.deps.store.deliveries.pending(key, this.deliveryAfter)
      if (!deliveries.length) {
        this.deliveryAfter = 0
        deliveries = this.deps.store.deliveries.pending(key)
      }
      for (const action of deliveries) {
        this.deliveryAfter = action.seq!
        if (this.stopped) break
        const current = await this.deps.context()
        if (serviceScopeKey(current.scope) !== key) break
        try {
          await this.advanceDelivery(current, action)
        } catch (error) {
          const code = safeCode(error),
            latest = this.deps.store.deliveries.get(key, action.id)!
          latest.notice = code
          if (!uncertain.has(code)) latest.phase = "blocked"
          this.deps.store.deliveries.save(latest)
        }
      }
      let expert = this.deps.store.expert.pending(key, this.expertAfter)
      if (!expert.length) {
        this.expertAfter = 0
        expert = this.deps.store.expert.pending(key)
      }
      for (const a of expert) {
        this.expertAfter = a.seq!
        if (this.stopped) break
        const current = await this.deps.context()
        if (serviceScopeKey(current.scope) !== key) break
        try {
          await this.advanceExpert(current, a)
        } catch (error) {
          const latest = this.deps.store.expert.get(key, a.id)!,
            code = safeCode(error)
          latest.notice = code
          let waiting = code === "RATE_LIMITED"
          if (
            code === "INPUT_CHANGED" &&
            latest.kind === "coordinate" &&
            latest.intent?.kind === "append_task" &&
            latest.targetRef
          ) {
            await this.expertSummaries(current, [latest.targetRef])
            const target = this.deps.store.expert.summary(key, latest.targetRef)!
            waiting =
              target.busy ||
              target.status === "completed" ||
              this.deps.store.hasTaskPending(key, latest.targetRef)
            if (waiting) latest.remoteStarted = false // known rejection, no remote commit
          }
          if (!uncertain.has(code) && !waiting) latest.phase = "blocked"
          this.deps.store.expert.save(latest)
          if (latest.kind === "coordinate" && latest.phase === "blocked")
            this.deps.store.update(key, latest.sourceRequestId!, (value) => {
              value.coordinationDone = true
              value.notice = "交办未完成，请核对权限后重新说明。"
            })
        }
      }
      pending =
        this.deps.store.hasPending(key) ||
        this.deps.store.deliveries.hasPending(key) ||
        this.deps.store.expert.hasPending(key)
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
      binding.executionProfile !== run.executionProfile ||
      binding.contextDigest !== run.contextDigest ||
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
        ["starting", "running", "failed"].includes(status) &&
        ["MODEL_CHANGED", "MODEL_UNAVAILABLE"].includes(value.notice ?? "")
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
    if (r.phase === "terminal") {
      this.coordinateResult(r)
      if (r.autoDelivery && r.status === "succeeded" && !r.publicationScheduled)
        this.schedulePublication(r)
      return
    }
    if (r.runId) {
      await this.inspect(c, r)
      r = store.request(key, id)
      this.coordinateResult(r)
      if (r.autoDelivery && r.status === "succeeded" && !r.publicationScheduled)
        this.schedulePublication(r)
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
    if (store.deliveries.hasPending(key, r.taskRef)) {
      store.update(key, id, (v) => {
        v.status = "next_round"
        v.notice = "已保存，将在成果保存后继续处理"
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
        if (r.profile && !record.role) {
          const adopted = await c.client.ensureExpertConversation({
            commandId: r.createCommand,
            groupId: c.scope.groupId,
            botId: c.scope.botId,
            role: "task",
            taskId: record.task.id,
            title: record.title,
            goal: record.task.goal
          })
          store.saveTask(key, { ...record, role: "task", task: adopted.task })
          record = store.task(key, r.taskRef)
        }
        const task = await c.client.lookupTask(c.scope.groupId, record.task!.taskNumber)
        if (task.id !== record.task!.id || task.currentStageId !== record.task!.currentStageId)
          throw new PartnerLocalFault("INPUT_CHANGED")
        r = store.update(key, id, (v) => {
          v.phase = "message"
          v.status = "submitting"
          v.expectedVersion = task.version
        })
      }
    }
    if (r.phase === "create") {
      const task = r.profile
        ? (
            await c.client.ensureExpertConversation({
              commandId: r.createCommand,
              groupId: c.scope.groupId,
              botId: c.scope.botId,
              role: r.profile === "expert_main_v1" ? "main" : "task",
              taskId: null,
              title: r.profile === "expert_main_v1" ? "专家主对话" : record.title,
              goal: r.text
            })
          ).task
        : await c.client.createTask(c.scope.groupId, r.text, r.createCommand)
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
      if (r.profile && !store.expert.input(key, id)) {
        if (!r.allowedTaskIds)
          r = store.update(key, id, (value) => {
            value.freezeGroupVersion = c.group.version
            value.freezeBotVersionId = c.botVersionId
            value.allowedTaskIds =
              value.profile === "expert_main_v1"
                ? store.allowedTargets(key, r.conversationId, r.text).map((t) => t.task!.id)
                : []
          })
        const input = await c.client.freezeExpertInput({
          commandId: r.enqueueCommand,
          taskId: record.task!.id,
          expectedTaskVersion: r.taskVersion!,
          expectedGroupVersion: r.freezeGroupVersion!,
          expectedBotVersionId: r.freezeBotVersionId!,
          sourceRequestId: r.requestId,
          allowedTaskIds: r.allowedTaskIds!
        })
        store.expert.saveInput(key, id, input)
      }
      if (!r.deadline)
        r = store.update(key, id, (v) => {
          v.deadline = new Date(Date.now() + 600000).toISOString()
        })
      const task = record.task!
      store.bind(key, {
        ...c.scope,
        ...(r.profile
          ? { executionProfile: r.profile, contextDigest: store.expert.input(key, id)!.digest }
          : {}),
        commandId: r.enqueueCommand,
        taskId: task.id,
        taskVersion: r.taskVersion!,
        stageId: task.currentStageId,
        groupVersion: r.freezeGroupVersion ?? c.group.version,
        botVersionId: r.freezeBotVersionId ?? c.botVersionId,
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
      if (
        receipt.executionProfile !== b.executionProfile ||
        receipt.contextDigest !== b.contextDigest
      )
        throw new PartnerLocalFault("EXECUTION_BINDING_MISMATCH")
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
