import { createHash } from "node:crypto"
import type { AgentRunTerminal } from "../agent/agent-run-service"
import type {
  BotWorkHistoryInput,
  BotWorkHistoryPort,
  BotWorkHistorySource
} from "../../shared/bots/work-history"
import { AsyncResource } from "node:async_hooks"
import {
  botWorkBrowserScope,
  type BotWorkWorkspacePort,
  type BotWorkItem,
  type CreateBotWorkInput
} from "../../shared/bots/work"
import type {
  BotMockEvent,
  BotMockTransport,
  CreateBotMockBinding
} from "../../shared/bots/mock-channel"
import {
  BOT_PROTOCOL_VERSION,
  LOCAL_BOT_HOST_ID,
  BotError,
  botTaskGroupId,
  botTaskAcceptsUserInput,
  botTaskWorkFamily,
  type BotChangeEvent,
  type BotDefinition,
  type BotSnapshot,
  type BotTask,
  type BotTaskState,
  type CreateBotInput,
  type UpdateBotInput,
  type SendBotMessageInput,
  type BotRequestCheck,
  type BotScheduleInput,
  type BotSchedule,
  type BotGroup,
  type BotGroupInput,
  type BotGroupMessage,
  type BotGroupHistoryCursor,
  type SendBotGroupMessageInput
} from "../../shared/bots/contracts"
import type { BotStore, BotWorkflowReference } from "./store"
import type { WorkflowRunReference } from "../agent/workflow/run-manager"
import { canDeferBotTask, canSteerBotTask, isRetryableNotificationTerminal } from "./continuation"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BackgroundCommandLifecycle } from "../agent/background-command-lifecycle"
import type { UserInputRequest } from "../types"
import { parseCreateBotWork } from "../../shared/bots/validation"
import { parseBotReactionTarget, type BotReactionTarget } from "../../shared/bots/message-reactions"
import type { BotImBinding } from "../../shared/bots/im-channel"

export interface BotRunLease {
  notificationTerminal?(): AgentRunTerminal | undefined
  /** Reuse the active runtime's user-prompt pipeline; inbox remains queued until injection. */
  steer?(task: BotTask, beforeInject: () => boolean): Promise<boolean>
  /** Move past an obsolete group question without answering it or cancelling detached work. */
  dismissQuestion?(): void
  /** Yield at a model boundary; keep background-task ownership separate from private input. */
  yieldToUser?(stillPending: () => boolean): void
  execute(
    signal: AbortSignal,
    waiting: (value: boolean) => void
  ): Promise<
    | {
        state: "completed" | "failed" | "outcome_unknown" | "superseded"
        error?: string
        result?: string
        files?: BotDeliveredFile[]
        /** Successful group text was delivered explicitly, not through the final scratch reply. */
        explicitGroupMessages?: boolean
        publicContribution?: boolean
      }
    | {
        state: "deferred"
        checkpointId: string
        consumedCommandIds?: string[]
        error?: never
        result?: never
        files?: BotDeliveredFile[]
      }
  >
  release(): void
}

export interface BotRunPort {
  workHistory?: BotWorkHistoryPort
  browser?: boolean
  workspaces?: BotWorkWorkspacePort
  /** Existing workflow/coordinator managers remain authoritative, including durable pending results. */
  hasPendingWork?(threadIds: readonly string[], options?: { allowPendingCoordinatorNotifications?: boolean }): Promise<boolean>
  /** Synchronous archive fence for existing Team conversations; no worker lifecycle changes. */
  hasPendingCoordinator?(threadIds: readonly string[]): boolean
  /** Cancel only this conversation's detached work through the existing managers. */
  cancelBackground?(threadId: string): void | Promise<void>
  /** Release only a removed member's browser ownership in this group; rejoining remains allowed. */
  removeGroupMemberBrowser?(groupId: string, botId: string): void | Promise<void>
  cancelCommands?(threadId: string, ids: readonly string[]): Promise<void>
  cancelBackgroundCommands?(commandIds: readonly string[]): void | Promise<void>
  cancelWorkflowInstances?(runs: readonly BotWorkflowReference[]): Promise<void>
  reconcileWorkflows?(runs: readonly BotWorkflowReference[]): Promise<void>
  acknowledgeWorkflowNotification?(task: BotTask, run?: WorkflowRunReference): Promise<void>
  recover?(threadIds: string[], signal: AbortSignal): Promise<void>
  /** Claim the existing runtime's thread lease before changing durable task state. */
  acquire(bot: BotDefinition, task: BotTask, work?: BotWorkItem): BotRunLease | null
  onAvailable(listener: () => void): () => void
  onSettled?(
    task: BotTask,
    state: BotTaskState,
    result?: string,
    files?: BotDeliveredFile[],
    publicContribution?: boolean
  ): void
}

type BotProfileUpdateReceipt = BotDefinition & {
  changes: { name: boolean; instructions: boolean }
}

/** No Electron or renderer dependency. The host owns the queue even with no open workspace. */
export class LocalBotHost {
  private readonly active = new Map<
    string,
    {
      botId: string
      task: BotTask
      lease: BotRunLease
      controller: AbortController
      done: Promise<void>
      steered: Set<string>
      launchedCommands: Set<string>
      preparingSteers: Set<string>
      steeringReady: boolean
    }
  >()
  private readonly deletions = new Map<string, Promise<void>>()
  private readonly commandCancellations = new Map<
    string,
    { threadId: string; done: Promise<void> }
  >()
  private readonly listeners = new Set<(event: BotChangeEvent) => void>()
  private readonly unsubscribe: () => void
  private readonly lifecycle = new AbortController()
  private recovery: Promise<void> = Promise.resolve()
  private recoveryReady = true
  private stopping = false
  private faulted = false
  private scheduled = false
  private mockDelivering: Promise<void> | null = null
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private lastHistoryMaintenance = -Infinity
  // A tool may wake this queue, but its expiring call scope must not own a new Bot run.
  private readonly pumpInHostContext = AsyncResource.bind(() => {
    this.scheduled = false
    if (this.stopping || this.faulted) return
    try {
      this.pump()
    } catch (error) {
      this.faulted = true
      this.reportError(error)
    }
  })

  constructor(
    private readonly store: BotStore,
    private readonly runtime: BotRunPort,
    private readonly concurrency = 2,
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly nextSchedule?: (input: BotScheduleInput, from: Date) => string | null,
    private readonly mockTransport: BotMockTransport = { send: async () => "sent" }
  ) {
    // Positive infinity explicitly disables only the Host-wide admission cap.
    if (
      concurrency !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    )
      throw new Error("Invalid Bot concurrency")
    store.recover()
    this.unsubscribe = runtime.onAvailable(() => this.wake())
    this.wake()
    this.armSchedules()
    if (runtime.recover) {
      this.recoveryReady = false
      this.recovery = Promise.resolve()
        .then(() => runtime.recover!(store.notificationThreadIds(), this.lifecycle.signal))
        .then(() => { this.recoveryReady = true })
        .catch((error) => {
          if (!this.lifecycle.signal.aborted) this.reportError(error)
        })
    }
  }

  private requireRunning(): void {
    if (this.stopping) throw new BotError("STOPPING", "应用正在退出，请稍后重试")
    if (this.faulted)
      throw new BotError("CONFLICT", "Bot 状态未能可靠保存，已暂停新任务；请检查本机存储后重启应用")
  }

  /** Browser scopes are existing private Bots or existing groups, never arbitrary directories. */
  browserScope(id: string): string {
    this.requireRunning()
    if (id.startsWith("work-")) {
      const [workId, botId, extra] = id.slice(5).split("--")
      if (!workId || !botId || extra) throw new BotError("INVALID_INPUT", "工作浏览器目标无效")
      const source = this.getWork(botId, workId).source
      if (source && source.transport !== "im")
        throw new BotError("CONFLICT", "模拟渠道不开放本机浏览器")
    } else if (id.startsWith("im-")) {
      const [bindingId, botId, executorId, threadId, extra] = id.slice(3).split("--")
      const binding = this.imGateway.binding(bindingId)
      if (
        !bindingId || !botId || extra || !binding || binding.binding.botId !== botId ||
        (threadId !== undefined &&
          (!threadId.startsWith("im-peer-") || !threadId.endsWith(`-${executorId}`)))
      )
        throw new BotError("INVALID_INPUT", "群浏览器目标无效")
      this.getBot(botId)
      if (executorId !== undefined) this.getBot(executorId)
    } else if (id.startsWith("group-")) {
      const [groupId, memberId, extra] = id.slice(6).split("--")
      if (!memberId || extra) throw new BotError("INVALID_INPUT", "请选择要查看的群成员浏览器")
      this.getGroupMember(groupId, memberId)
    } else {
      this.getBot(id)
    }
    return id
  }

  /** A verified personal IM audience is also visible from its owner's desktop conversation. */
  hasPersonalBrowserScope(viewer: string, scope: string): boolean {
    if (!scope.startsWith("im-")) return false
    const [bindingId, ownerId] = scope.slice(3).split("--")
    return ownerId === viewer &&
      this.imGateway.binding(bindingId)?.binding.botId === viewer &&
      this.imGateway.isPersonalBinding(bindingId)
  }

  getGroupMember(groupId: string, botId: string): BotDefinition {
    const group = this.getGroup(groupId)
    if (!group.memberIds.includes(botId)) throw new BotError("CONFLICT", "成员已离开此群")
    return this.getBot(botId)
  }

  /** The user's retained group history outlives its current member list. */
  getGroup(groupId: string): BotGroup {
    this.requireRunning()
    const group = this.store.getGroup(groupId)
    if (group.deleting) throw new BotError("CONFLICT", "群聊正在删除")
    return group
  }

  /** Selected group identity facts only; never read history or publish a group message. */
  getGroupReference(groupId: string, botId: string) {
    const bot = this.getBot(botId),
      group = this.store.getGroup(groupId)
    if (
      group.id !== groupId ||
      group.deleting ||
      group.hostId !== bot.hostId ||
      !group.memberIds.includes(bot.id)
    )
      throw new BotError("CONFLICT", "提及的群聊已不可用，请重新选择")
    return {
      id: group.id,
      currentName: group.name,
      botMembers: group.memberIds.map((id) => {
        const member = this.getBot(id)
        if (member.hostId !== group.hostId)
          throw new BotError("CONFLICT", "提及的群聊成员已不可用，请重新选择")
        return { id: member.id, currentName: member.name }
      })
    }
  }

  listBotIds(): string[] {
    this.requireRunning()
    return this.store.listBots().map((bot) => bot.id)
  }

  snapshot(): BotSnapshot {
    if (this.stopping) throw new BotError("STOPPING", "应用正在退出，请稍后重试")
    return {
      host: {
        id: LOCAL_BOT_HOST_ID,
        kind: "local",
        name: "本机",
        protocolVersion: BOT_PROTOCOL_VERSION,
        capabilities: {
          browser: Boolean(this.runtime.browser),
          groups: true,
          schedules: Boolean(this.nextSchedule)
        }
      },
      revision: this.store.revision(),
      bots: this.store.listBots(),
      tasks: this.store.recentTasks(true),
      schedules: this.store.schedules(),
      groups: this.store.groups(),
      activities: this.store.activities(),
      workActivity: this.store.workActivities(),
      personalIm: this.store.imGateway.personalStatuses(),
      imConversations: this.store.imGateway.groupConversations(),
      backgroundThreads: [...new Set([
        ...this.store.activeCommandThreads(true),
        ...this.store.workflowReferences().map(run => run.threadId)
      ])],
      collaborationThreads: this.store.stoppableCollaborationThreads()
    }
  }

  imConversationHistory(botId: string, id: string, before?: string) {
    return this.store.imConversationHistory(botId, id, before)
  }
  imConversationWorks(botId: string, id: string, cursor?: string, query?: string) {
    return this.store.imConversationWorks(botId, id, cursor, query)
  }

  memoryContext(
    botId: string,
    groupId?: string
  ): import("../../shared/bots/memory-scope").BotMemoryContext {
    this.getBot(botId)
    if (!groupId) return {}
    if (groupId.startsWith("im-")) {
      const route = this.store.imGateway.binding(groupId)
      if (!route || route.binding.botId !== botId || route.binding.kind !== "group")
        throw new BotError("NOT_FOUND", "群聊不属于当前 Bot")
    } else if (groupId.startsWith("mock-")) {
      this.store.mock.get(botId, groupId.slice(5))
    } else if (!this.getGroup(groupId).memberIds.includes(botId)) {
      throw new BotError("NOT_FOUND", "Bot 不是当前群成员")
    }
    return { groupId }
  }

  subscribe(listener: (event: BotChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  memoryChanged(botId: string): void {
    if (!this.stopping) this.changed(botId)
  }

  private changed(memoryBotId?: string, reactionTarget?: BotReactionTarget): void {
    const event = {
      hostId: LOCAL_BOT_HOST_ID,
      revision: this.store.revision(),
      ...(reactionTarget ? { reactionTarget } : {}),
      ...(memoryBotId ? { memoryBotId } : {})
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.reportError(error)
      }
    }
  }

  getBot(id: string): BotDefinition {
    this.requireRunning()
    const bot = this.store.getBot(id)
    if (bot.deleting) throw new BotError("CONFLICT", "Bot 正在删除，请完成删除后重试")
    return bot
  }

  /** Tool authority is the still-live host lease, never a model-supplied task or request key. */
  workToolSource(taskId: string): BotTask {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted) throw new BotError("CONFLICT", "当前执行已停止")
    const task = this.store.getTask(taskId)
    if (task.mockSource) this.store.external(task.mockSource).execution(task)
    else if (
      task.origin.kind === "mock" ||
      (task.workId && this.store.getWork(task.botId, task.workId).source)
    )
      throw new BotError("CONFLICT", "模拟来源证明缺失")
    if (botTaskGroupId(task)) throw new BotError("CONFLICT", "请在私聊主会话中管理独立工作")
    return task
  }
  async changeWorkFromTool(
    source: { taskId: string; callId: string; key: string },
    workId: string,
    version: number,
    action: "complete" | "continue"
  ) {
    const task = this.workToolSource(source.taskId)
    if (!this.store.hasWorkUserRequest(task.id))
      throw new BotError("CONFLICT", "只有当前用户明确指令可以完成或继续工作")
    const pending = action === "complete" ? await this.pendingWork(task.botId, workId) : false
    this.workToolSource(source.taskId)
    if (!this.store.hasWorkUserRequest(task.id))
      throw new BotError("CONFLICT", "当前用户指令已不可用")
    const result = this.store.changeWork(
      task.botId,
      workId,
      version,
      source.callId,
      action,
      source,
      pending
    )
    this.changed()
    this.wake()
    return result
  }
  sendWork(
    source: { taskId: string; callId: string; key: string },
    workId: string,
    message: string
  ) {
    const task = this.workToolSource(source.taskId)
    if (!this.store.hasWorkUserRequest(task.id))
      throw new BotError("CONFLICT", "只有当前用户明确指令可以转达工作消息")
    const result = this.store.sendWork(source, workId, message)
    this.changed()
    this.steerUserMessage(result)
    this.wake()
    return result
  }
  getWork(botId: string, workId: string) {
    this.getBot(botId)
    return this.store.getWork(botId, workId)
  }
  /** Available only while remove() owns the deleting fence; never exposed through renderer reads. */
  getWorkForDeletion(botId: string, workId: string) {
    this.requireRunning()
    if (!this.deletions.has(botId) || !this.store.getBot(botId).deleting)
      throw new BotError("CONFLICT", "任务解绑仅可由正在进行的 Bot 删除协调执行。")
    return this.store.getWork(botId, workId)
  }
  markWorksRead(botId: string, throughVersion: number) {
    this.requireRunning()
    this.store.markWorksRead(botId, throughVersion)
    this.changed()
  }
  workSummaries(botId: string, workIds: string[]) {
    this.getBot(botId)
    return this.store.workSummaries(botId, workIds)
  }
  listWorks(botId: string, cursor?: string, query?: string) {
    this.getBot(botId)
    return this.store.listWorks(botId, cursor, query, "desktop")
  }
  workTargets(taskId: string, cursor?: string, query?: string) {
    const task = this.workToolSource(taskId)
    return this.store.listWorks(
      task.botId,
      cursor,
      query,
      task.mockSource?.audienceKey ?? "desktop"
    )
  }
  associatedWorks(botId: string) {
    this.getBot(botId)
    return this.store.associatedWorks(botId)
  }
  private historyTarget(taskId: string, workId: string) {
    const task = this.workToolSource(taskId)
    const work = this.getWork(task.botId, workId)
    if (
      (task.mockSource && task.mockSource.transport !== "im") ||
      work.audienceKey !== (task.mockSource?.audienceKey ?? "desktop")
    )
      throw new BotError("CONFLICT", "渠道会话不能读取本机私有历史")
    return work
  }
  async workHistory(taskId: string, input: BotWorkHistoryInput) {
    if (!this.runtime.workHistory) throw new BotError("CONFLICT", "此主机暂不支持历史查询")
    const work = this.historyTarget(taskId, input.workId)
    const result = await this.runtime.workHistory.query(work, input)
    this.historyTarget(taskId, input.workId)
    return result
  }
  async resolveWorkHistorySource(botId: string, source: BotWorkHistorySource) {
    if (!this.runtime.workHistory) throw new BotError("CONFLICT", "此主机暂不支持历史定位")
    const work = this.getWork(botId, source.workId)
    if (work.source && work.source.transport !== "im")
      throw new BotError("CONFLICT", "不是本机或 IM 任务")
    const result = await this.runtime.workHistory.resolve(work, source)
    this.getWork(botId, source.workId)
    return result
  }
  /** Main-process authenticated IM adapter only; not exposed as a renderer injection API. */
  get imChannel() {
    return this.store.im
  }
  get imGateway() {
    return this.store.imGateway
  }
  get telemetry() {
    return this.store.telemetry
  }
  /** Invalidate the group read model when authenticated binding metadata changes. */
  registerImBinding(realm: string, principal: string, binding: BotImBinding) {
    this.requireRunning()
    return this.updateImState(() => this.store.imGateway.register(realm, principal, binding))
  }
  /** Authenticated binding revocation; never stop a whole shared personal thread. */
  revokeImBinding(botId: string, id: string, version: number): void {
    this.requireRunning()
    const current = this.store.im.get(botId, id)
    if (!current.revoked) this.store.im.revoke(botId, id, version)
    const execution = this.store.suppressRevokedImExecution(botId, id)
    this.cancelWorkflows(execution.workflows)
    for (const task of execution.tasks) this.cancel(task.id, false)
    if (execution.commandIds.length)
      void Promise.resolve(this.runtime.cancelBackgroundCommands?.(execution.commandIds)).catch(this.reportError)
    this.changed()
    this.wake()
  }
  /** Authenticated main-process IM registration; unchanged syncs need no queue wake. */
  setImOnline(botId: string, id: string, online: boolean) {
    this.requireRunning()
    const previous = this.store.im.get(botId, id).online
    const result = this.store.im.setOnline(botId, id, online)
    if (previous !== result.online) {
      this.changed()
      this.wake()
    }
    return result
  }
  acceptImEvent(input: Omit<BotMockEvent, "simulation">) {
    this.requireRunning()
    const result = this.updateImState(() => this.store.im.inject({ ...input, simulation: true }))
    this.wake()
    return result
  }
  /** Notify existing desktop subscribers only when authenticated IM state actually changes. */
  private updateImState<T>(update: () => T): T {
    const revision = this.store.revision()
    const result = update()
    if (revision !== this.store.revision()) this.changed()
    return result
  }
  beginImDelivery() {
    return this.updateImState(() => this.store.im.beginDelivery())
  }
  setImOffline(): void {
    this.updateImState(() => this.store.im.setAllOffline())
  }
  mayDeliverImReply(id: string) {
    return this.updateImState(() => this.store.im.mayDeliver(id))
  }
  settleImDelivery(id: string, state: Parameters<BotStore["im"]["delivered"]>[1]): void {
    this.updateImState(() => this.store.im.delivered(id, state))
  }
  mockBindings(botId: string, before?: string) {
    this.requireRunning()
    return this.store.mock.bindings(botId, before)
  }
  mockBinding(botId: string, id: string) {
    this.requireRunning()
    return this.store.mock.get(botId, id)
  }
  createMockBinding(input: CreateBotMockBinding) {
    this.requireRunning()
    const result = this.store.mock.create(input)
    this.changed()
    return result
  }
  setMockOnline(botId: string, id: string, online: boolean) {
    this.requireRunning()
    const result = this.store.mock.setOnline(botId, id, online)
    this.changed()
    this.wake()
    return result
  }
  revokeMockBinding(botId: string, id: string, version: number) {
    this.requireRunning()
    const result = this.store.mock.revoke(botId, id, version)
    this.changed()
    this.wake()
    return result
  }
  injectMockEvent(input: BotMockEvent) {
    this.requireRunning()
    const result = this.store.mock.inject(input)
    this.changed()
    this.wake()
    return result
  }
  mockHistory(botId: string, id: string, before?: string) {
    this.requireRunning()
    return this.store.mock.history(botId, id, before)
  }
  mockExecution(task: BotTask) {
    this.requireRunning()
    return this.store.external(task.mockSource).execution(task)
  }
  initializeMockThread(task: BotTask) {
    if (task.mockSource) this.store.external(task.mockSource).initialize(task.mockSource, task)
  }
  async createWork(
    input: CreateBotWorkInput,
    source?: { taskId: string; callId: string; key: string }
  ) {
    this.requireRunning()
    input = parseCreateBotWork(input)
    const task = source ? this.workToolSource(source.taskId) : undefined
    // Replay before IO: moving a project or deleting a directory must not create a second work.
    const existing = this.store.workCreationReceipt(input, source)
    if (existing) return existing
    if (input.workspace && !this.runtime.workspaces)
      throw new BotError("CONFLICT", "当前主机不支持选择任务工作目录")
    const workspace =
      task?.mockSource && (task.mockSource.transport !== "im" ||
        (!task.mockSource.personal && !input.workspace))
        ? undefined
        : await this.runtime.workspaces?.resolve(input.botId, input.workspace)
    this.requireRunning()
    if (source) this.workToolSource(source.taskId)
    const receipt = this.store.createWork(input, source, workspace)
    this.changed()
    this.wake()
    return receipt
  }
  async workProjects(taskId: string, query: string, cursor?: number) {
    const validate = () => {
      const task = this.workToolSource(taskId)
      if (
        (task.mockSource && task.mockSource.transport !== "im") ||
        task.workId ||
        !this.store.hasWorkUserRequest(task.id)
      )
        throw new BotError("CONFLICT", "只能在本机主对话的当前用户交办中查找项目")
    }
    validate()
    if (!this.runtime.workspaces) throw new BotError("CONFLICT", "当前主机不支持查询项目")
    const page = await this.runtime.workspaces.projects(query, cursor)
    validate()
    return page
  }
  private async pendingWork(botId: string, workId: string): Promise<boolean> {
    await this.recovery
    return (
      (await this.runtime.hasPendingWork?.([this.store.getWork(botId, workId).threadId])) ?? false
    )
  }
  async changeWork(
    botId: string,
    workId: string,
    version: number,
    operationId: string,
    action: "complete" | "continue"
  ) {
    this.requireRunning()
    const pending = action === "complete" ? await this.pendingWork(botId, workId) : false
    this.requireRunning()
    const result = this.store.changeWork(
      botId,
      workId,
      version,
      operationId,
      action,
      undefined,
      pending
    )
    this.changed()
    this.wake()
    return result
  }
  initializeWorkThread(botId: string, workId: string) {
    this.store.initializeWorkThread(botId, workId)
  }
  get conversationLinks() {
    return this.store.conversations
  }
  conversationLinkChanged() {
    this.changed()
  }
  async assertConversationLinkIdle(threadId: string, deletingWork?: { botId: string; workId: string }) {
    this.requireRunning()
    await this.recovery
    if (deletingWork) {
      const work = this.getWorkForDeletion(deletingWork.botId, deletingWork.workId)
      if (work.threadId !== threadId || work.conversation?.origin !== "existing")
        throw new BotError("CONFLICT", "删除恢复只能解除保留的原会话。")
    }
    // A preserved original Team can consume its completed results after unlink.
    // Live work and terminal persistence still block; ordinary unlink stays strict.
    if (await this.runtime.hasPendingWork?.([threadId], deletingWork
      ? { allowPendingCoordinatorNotifications: true } : undefined))
      throw new BotError("CONFLICT", "请先处理此会话的后台执行和待通知结果。")
    this.requireRunning()
    if (deletingWork) this.getWorkForDeletion(deletingWork.botId, deletingWork.workId)
    if (this.store.pendingTasksForThread(threadId).length)
      throw new BotError("CONFLICT", "请先处理此会话的待办和正在执行的消息。")
  }
  conversation(botId: string, workId?: string) {
    const bot = this.getBot(botId),
      work = workId ? this.getWork(botId, workId) : undefined
    return {
      bot,
      work,
      threadId: work?.threadId ?? bot.threadId,
      browserScope: work ? botWorkBrowserScope(work.id, bot.id) : bot.id
    }
  }
  markUnread(kind: "bot" | "group", id: string): void {
    this.requireRunning()
    this.store.markUnread(kind, id)
    this.changed()
  }
  exchange(botId: string, taskId: string, groupId?: string, workId?: string, imConversationId?: string) {
    this.requireRunning()
    return this.store.exchange(botId, taskId, groupId, workId, imConversationId)
  }
  exchangeHistory(
    botId: string,
    taskId: string,
    groupId?: string,
    before?: string,
    workId?: string,
    imConversationId?: string
  ) {
    this.requireRunning()
    return this.store.exchangeHistory(botId, taskId, groupId, before, workId, imConversationId)
  }
  messageOrigins(botId: string, messageIds: string[], groupId?: string, workId?: string) {
    this.requireRunning()
    return this.store.messageOrigins(botId, messageIds, groupId, workId)
  }
  requestReceipts(botId: string, checks: BotRequestCheck[], workId?: string) {
    this.requireRunning()
    return this.store.requestReceipts(botId, checks, workId)
  }
  markRead(kind: "bot" | "group" | "work" | "im", id: string, throughVersion: number): void {
    this.requireRunning()
    this.store.markRead(kind, id, throughVersion)
    this.changed()
  }

  peers(taskId?: string): Array<{ id: string; name: string }> {
    this.requireRunning()
    const groupId = taskId ? botTaskGroupId(this.store.getTask(taskId)) : undefined
    const members = groupId ? this.store.getGroup(groupId).memberIds : undefined
    return this.store
      .listBots()
      .filter((bot) => !bot.archived && !bot.deleting && (!members || members.includes(bot.id)))
      .map(({ id, name }) => ({ id, name }))
  }

  saveGroup(input: BotGroupInput, existing?: { id: string; version: number }): BotGroup {
    this.requireRunning()
    const previous = existing ? this.store.getGroup(existing.id) : undefined
    const group = this.store.saveGroup(input, existing)
    const membershipChanged =
      previous && JSON.stringify(previous.memberIds) !== JSON.stringify(group.memberIds)
    for (const [id, run] of this.active) {
      const task = this.store.getTask(id)
      if (
        botTaskGroupId(task) === group.id &&
        (!group.memberIds.includes(task.botId) ||
          (membershipChanged && task.origin.kind === "discussion"))
      )
        run.controller.abort()
    }
    for (const id of previous?.memberIds ?? []) {
      if (group.memberIds.includes(id)) continue
      const threadId = `group-${group.id}-${id}`
      const peers = this.store.stopConversationPeers(id, threadId)
      for (const task of this.store.pendingTasksForThread(threadId)) this.cancelSingleTask(task.id)
      for (const task of peers.tasks) this.cancelSingleTask(task.id, false)
      this.store.suppressCommands(threadId)
      this.cancelWorkflows([...peers.workflows, ...this.store.suppressConversationWorkflows(threadId)])
      if (peers.commandIds.length)
        void Promise.resolve(this.runtime.cancelBackgroundCommands?.(peers.commandIds)).catch(this.reportError)
      try {
        void Promise.resolve(this.runtime.removeGroupMemberBrowser?.(group.id, id)).catch(
          this.reportError
        )
      } catch (error) {
        this.reportError(error)
      }
      void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    }
    this.changed()
    this.wake()
    return group
  }
  groupMessages(id: string, cursor?: BotGroupHistoryCursor): BotGroupMessage[] {
    this.requireRunning()
    return this.store.groupMessages(id, cursor)
  }
  groupTaskDeliveries(groupId: string, taskId: string, authorBotId: string, includeHandoffFiles = false) {
    this.requireRunning()
    return this.store.groupTaskDeliveries(groupId, taskId, authorBotId, includeHandoffFiles)
  }
  groupTaskRequest(taskId: string): Pick<BotGroupMessage, "id" | "text" | "createdAt"> | null {
    this.requireRunning()
    return this.store.groupTaskRequest(taskId)
  }
  recordGroupQuestion(taskId: string, request: UserInputRequest): void {
    const run = this.active.get(taskId)
    if (!run) return
    if (this.store.recordGroupQuestion(taskId, request)) {
      this.changed()
      // A group message can arrive before the delegated tool registers its question.
      if (run.task.origin.kind === "bot" && run.steeringReady) this.onSteeringReady(taskId)
    }
  }
  recordGroupQuestionResult(taskId: string, requestId: string, resultId: string): void {
    if (!this.active.has(taskId)) return
    if (this.store.recordGroupQuestionResult(taskId, requestId, resultId)) this.changed()
  }
  publishGroupMessage(taskId: string, callId: string, text: string, targetGroupId?: string) {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted) throw new BotError("CONFLICT", "当前群任务已结束")
    const receipt =
      targetGroupId === undefined
        ? this.store.publishGroupMessage(taskId, callId, text)
        : this.store.publishGroupMessage(taskId, callId, text, targetGroupId)
    this.changed()
    if (targetGroupId !== undefined) this.wake()
    return receipt
  }
  publishGroupFiles(taskId: string, callId: string, files: BotDeliveredFile[], content = ""): void {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted)
      throw new BotError("CONFLICT", "任务已停止，无法继续交付附件")
    this.store.publishGroupFiles(taskId, callId, files, content)
    this.changed()
  }
  sendGroup(input: SendBotGroupMessageInput): void {
    this.requireRunning()
    const obsolete = this.store.groupDiscussionTask(input.groupId, input.requestId)
    const fresh = this.store.sendGroup(input)
    if (fresh && obsolete) this.cancel(obsolete)
    this.changed()
    for (const run of this.active.values()) {
      if (botTaskGroupId(run.task) !== input.groupId || run.controller.signal.aborted) continue
      if (
        run.task.origin.kind === "notification" &&
        run.task.origin.notificationKind === "command"
      ) {
        // A new user request gets its own prompt/tools, never the notification's authority.
        if (fresh) run.lease.dismissQuestion?.()
        continue
      }
      if (run.task.origin.kind !== "group" && run.task.origin.kind !== "bot") continue
      if (!input.targetBotIds.includes(run.botId)) {
        if (fresh && run.task.origin.kind === "group") run.lease.dismissQuestion?.()
      } else
        for (const task of this.store.pendingConversationTasks(run.botId, input.groupId))
          if (task.origin.kind === "group" && task.origin.messageId === input.requestId)
            this.steerUserMessage(task)
    }
    this.wake()
  }

  delegate(
    taskId: string,
    target: string,
    message: string,
    key: string,
    outputFiles: string[] = []
  ): BotTask {
    this.requireRunning()
    if (
      this.active.get(taskId)?.controller.signal.aborted ||
      this.store.taskRootCancelled(this.store.getTask(taskId))
    )
      throw new BotError("CONFLICT", "任务已停止，不能继续交办")
    const task = this.store.delegate(taskId, target, message, key, outputFiles)
    this.changed()
    this.wake()
    return task
  }

  peerHandoff(task: Pick<BotTask, "id">) {
    this.requireRunning()
    return this.store.peerHandoff(task.id)
  }

  recordPeerDelivery(taskId: string, files: BotDeliveredFile[]): void {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted)
      throw new BotError("CONFLICT", "任务已停止，无法记录交付附件")
    this.store.recordPeerDelivery(taskId, files)
  }

  saveSchedule(
    botId: string,
    input: BotScheduleInput,
    existing?: { id: string; version: number },
    sourceTaskId?: string
  ): BotSchedule {
    this.requireRunning()
    if (!this.nextSchedule) throw new BotError("CONFLICT", "此主机未启用例行任务")
    if (input.enabled && input.frequency === "once" && Date.parse(input.runAt ?? "") <= Date.now())
      throw new BotError("INVALID_INPUT", "执行时间必须在未来")
    const next = input.enabled ? this.nextSchedule(input, new Date()) : null
    const schedule = this.store.saveSchedule(botId, input, next, existing, sourceTaskId)
    this.changed()
    this.wake()
    this.armSchedules()
    return schedule
  }

  removeSchedule(id: string, version: number): void {
    this.requireRunning()
    this.store.removeSchedule(id, version)
    this.changed()
    this.wake()
    this.armSchedules()
  }

  /** Called on OS resume as well as the single deadline timer. Missed intervals coalesce. */
  resume(): void {
    if (this.stopping || this.faulted) return
    if (this.nextSchedule) {
      const now = Date.now()
      for (const schedule of this.store.schedules()) {
        if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now)
          continue
        try {
          const next =
            schedule.frequency === "once" ? null : this.nextSchedule(schedule, new Date(now + 1))
          this.store.fireSchedule(schedule, next)
          this.changed()
        } catch (error) {
          this.reportError(error)
        }
      }
    }
    this.wake()
    this.armSchedules()
  }

  private armSchedules(): void {
    clearTimeout(this.scheduleTimer)
    this.scheduleTimer = undefined
    if (this.stopping || this.faulted || !this.nextSchedule) return
    const due = this.store
      .schedules()
      .filter((item) => item.enabled && item.nextRunAt)
      .map((item) => Date.parse(item.nextRunAt!))
      .filter(Number.isFinite)
    if (!due.length) return
    // A rejected queue insertion backs off; no hot retry loop at an expired deadline.
    const delay = Math.max(1000, Math.min(86_400_000, Math.min(...due) - Date.now()))
    this.scheduleTimer = setTimeout(() => this.resume(), delay)
    this.scheduleTimer.unref?.()
  }

  create(input: CreateBotInput): BotDefinition {
    this.requireRunning()
    const bot = this.store.create(input)
    this.changed()
    return bot
  }

  createTeammate(
    taskId: string,
    requestKey: string,
    profile: { name: string; instructions: string }
  ): BotDefinition {
    this.requireRunning()
    const bot = this.store.createTeammate(taskId, requestKey, profile)
    this.changed()
    return bot
  }

  introduce(id: string): void {
    this.requireRunning()
    if (!this.store.introduce(id)) return
    this.changed()
    this.wake()
  }

  hasDirectUserRequest(taskId: string): boolean {
    this.requireRunning()
    return this.store.hasDirectUserRequest(taskId)
  }

  profileContinuationRequest(taskId: string): string | null {
    this.requireRunning()
    return this.store.profileContinuationRequest(taskId)
  }

  commandUserRequest(taskId: string): BotTask | null {
    this.requireRunning()
    return this.store.commandUserRequest(taskId)
  }

  update(input: UpdateBotInput): BotDefinition {
    this.requireRunning()
    if (input.archived && !this.store.getBot(input.id).archived && this.runtime.hasPendingCoordinator) {
      if (!this.recoveryReady) throw new BotError("CONFLICT", "后台状态正在恢复，请稍后再归档。")
      if (this.runtime.hasPendingCoordinator(this.store.notificationThreadIds(input.id)))
        throw new BotError("CONFLICT", "请先处理此 Bot 的后台执行和待通知结果，再归档。")
    }
    const bot = this.store.update(input)
    this.changed()
    this.wake()
    return bot
  }

  remove(
    id: string,
    expectedVersion: number,
    cleanup: (threadIds: string[]) => Promise<void>
  ): Promise<void> {
    this.requireRunning()
    const pending = this.deletions.get(id)
    if (pending) return pending
    // Check the original Team owner before the durable deletion fence prevents
    // its linked conversation from consuming results or stopping background work.
    if (!this.store.getBot(id).deleting && this.runtime.hasPendingCoordinator) {
      if (!this.recoveryReady) throw new BotError("CONFLICT", "后台状态正在恢复，请稍后再删除。")
      if (this.runtime.hasPendingCoordinator(this.store.notificationThreadIds(id)))
        throw new BotError("CONFLICT", "请先处理此 Bot 的后台执行和待通知结果，再删除。")
    }
    const threads = this.store.beginDeletion(id, expectedVersion)
    this.changed()
    this.wake()
    this.armSchedules()
    const deletion = Promise.resolve()
      .then(() => cleanup(threads))
      .then(() => {
        this.store.finishDeletion(id, threads)
        this.changed()
      })
      .finally(() => this.deletions.delete(id))
    this.deletions.set(id, deletion)
    return deletion
  }

  removeGroup(
    id: string,
    version: number,
    cleanup: (threadIds: string[]) => Promise<void>
  ): Promise<void> {
    this.requireRunning()
    const key = `group:${id}`
    const pending = this.deletions.get(key)
    if (pending) return pending
    const threads = this.store.beginGroupDeletion(id, version)
    this.changed()
    this.wake()
    const deletion = Promise.resolve()
      .then(() => cleanup(threads))
      .then(() => {
        this.store.finishGroupDeletion(id)
        this.changed()
      })
      .finally(() => this.deletions.delete(key))
    this.deletions.set(key, deletion)
    return deletion
  }

  enqueueNotification(
    botId: string,
    threadId: string,
    kind: "workflow" | "coordinator",
    key: string,
    message: string,
    groupId?: string,
    runStartedAt?: string
  ): BotTask | undefined {
    this.requireRunning()
    const workflow = kind === "workflow" && runStartedAt
      ? this.store.workflowReference(threadId, key, runStartedAt) : undefined
    if (workflow?.suppressed) return
    const workflowSource = workflow ? this.store.getTask(workflow.sourceTaskId) : undefined
    if (workflowSource && (this.store.taskRootCancelled(workflowSource) || workflowSource.state === "cancelled")) return
    if (workflowSource && (workflowSource.botId !== botId || workflowSource.threadId !== threadId || botTaskGroupId(workflowSource) !== groupId))
      throw new BotError("CONFLICT", "后台通知不属于原 workflow 来源")
    const bot = this.store.getBot(botId)
    if (bot.archived || bot.deleting) return
    const work = this.store.workForThread(botId, threadId)
    // A late result remains in the original manager's history. It cannot reopen or run a closed work.
    if (work?.state === "completed") return
    const imParent = workflowSource ?? this.store.imThreadSource(botId, threadId)
    if (imParent?.mockSource)
      this.store.im.validateSource(imParent.mockSource, this.store.im.continuationOwner(imParent))
    const expectedThread =
      work?.threadId ?? imParent?.threadId ?? (groupId ? `group-${groupId}-${botId}` : bot.threadId)
    if (threadId !== expectedThread) throw new BotError("CONFLICT", "后台通知不属于此 Bot 会话")
    if (groupId) {
      const group = this.store.getGroup(groupId)
      if (group.deleting || !group.memberIds.includes(botId)) return
    }
    if (
      runStartedAt !== undefined &&
      (kind !== "workflow" || !runStartedAt.trim() || runStartedAt.length > 100)
    )
      throw new BotError("INVALID_INPUT", "后台通知运行版本无效")
    if (
      runStartedAt &&
      this.store.hasLegacyWorkflowNotification(botId, threadId, key, runStartedAt)
    )
      return
    const previous = kind === "coordinator" || runStartedAt
      ? this.store.notificationAttempt(threadId, kind, key, runStartedAt) : undefined
    if (previous) {
      const terminal = this.store.notificationTerminal(previous.id)
      if (!["failed", "outcome_unknown", "interrupted"].includes(previous.state) ||
          !terminal || !isRetryableNotificationTerminal(terminal) || this.store.taskRootCancelled(previous))
        return previous
      // One deterministic successor per failed attempt. Preserve its original authorization
      // and transcript; only the pending background result's summary is attempted again.
      const retry = this.store.enqueue({
        botId: previous.botId,
        ...(previous.workId ? { workId: previous.workId } : {}),
        requestId: `notification-retry:${createHash("sha256").update(previous.id).digest("hex")}`,
        message: previous.message
      }, previous.origin, previous.mockSource)
      this.changed()
      this.wake()
      return retry
    }
    const task = this.store.enqueue(
      {
        botId,
        ...(work ? { workId: work.id } : {}),
        requestId: `notification:${threadId}:${kind}:${key}${runStartedAt ? `:${runStartedAt}` : ""}`,
        message
      },
      {
        kind: "notification",
        notificationKind: kind,
        ...(workflow ? { sourceTaskId: workflow.sourceTaskId } : imParent ? { sourceTaskId: imParent.id } : {}),
        ...(workflowSource && botTaskWorkFamily(workflowSource) ? { rootWorkId: botTaskWorkFamily(workflowSource) } : {}),
        ...(workflowSource ? { rootTaskId:
          (workflowSource.origin.kind === "bot" || workflowSource.origin.kind === "notification")
            ? workflowSource.origin.rootTaskId ?? workflowSource.id : workflowSource.id } : {}),
        key,
        ...(groupId ? { groupId } : {}),
        ...(runStartedAt ? { runStartedAt } : {})
      },
      imParent?.mockSource
    )
    this.changed()
    this.wake()
    return task
  }

  async acknowledgeNotification(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId)
    if (task.origin.kind !== "notification" || task.origin.notificationKind !== "workflow" || !task.origin.runStartedAt) return false
    const terminal = this.store.notificationTerminal(taskId)
    if (task.state !== "completed" && task.state !== "cancelled" &&
        !(terminal && !isRetryableNotificationTerminal(terminal) &&
          ["failed", "outcome_unknown", "interrupted"].includes(task.state))) return false
    if (!this.runtime.acknowledgeWorkflowNotification) return false
    await this.runtime.acknowledgeWorkflowNotification(task,
      this.store.workflowReference(task.threadId, task.origin.key, task.origin.runStartedAt))
    return true
  }

  recordNotificationTerminal(taskId: string, terminal: AgentRunTerminal): void {
    const active = this.active.get(taskId)
    if (!active || active.controller.signal.aborted) return
    try { this.store.recordNotificationTerminal(taskId, terminal) }
    catch (error) { this.faulted = true; throw error }
  }

  /** A completed notification turn can still owe command integration in the same task. */
  workflowNotificationConsumed(taskId: string): boolean {
    const task = this.store.getTask(taskId)
    return task.origin.kind === "notification" && task.origin.notificationKind === "workflow" &&
      Boolean(task.origin.runStartedAt) && Boolean(this.store.taskCheckpoint(taskId)) &&
      this.store.notificationTerminal(taskId)?.outcome === "success"
  }

  /** Observe the existing queue, not a second executor. Completion includes lease cleanup. */
  waitForNotification(taskId: string): Promise<AgentRunTerminal | undefined> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {}
      let finished = false
      let observed: Promise<void> | undefined
      const dispose = () => {
        unsubscribe()
        this.lifecycle.signal.removeEventListener("abort", stopped)
      }
      const stopped = () => {
        if (finished) return
        finished = true
        dispose()
        resolve(undefined)
      }
      const check = () => {
        if (finished) return
        if (this.stopping) return stopped()
        try {
          if (this.faulted) throw new Error("Bot notification storage is unavailable")
          const task = this.store.getTask(taskId)
          if (["queued", "running", "waiting_user"].includes(task.state)) {
            const done = this.active.get(taskId)?.done
            if (done && done !== observed) {
              observed = done
              void done.then(check, (error) => { finished = true; dispose(); reject(error) })
            }
            return
          }
          finished = true
          dispose()
          const done = this.active.get(taskId)?.done ?? Promise.resolve()
          void done.then(() => {
            if (this.faulted) throw new Error("Bot notification settlement failed")
            resolve(this.store.notificationTerminal(taskId) ?? {
              outcome: task.state === "completed" ? "success" : "error",
              code: task.state === "completed" ? "normal" : "cancelled"
            })
          }).catch(reject)
        } catch (error) { finished = true; dispose(); reject(error) }
      }
      unsubscribe = this.subscribe(check)
      this.lifecycle.signal.addEventListener("abort", stopped, { once: true })
      check()
    })
  }

  commandLifecycle(sourceTaskId: string, continueSource = false): BackgroundCommandLifecycle {
    return {
      allowSilentServices: true,
      ...(continueSource ? { retainSource: true } : {}),
      accepted: (command) => {
        this.requireRunning()
        const run = this.active.get(sourceTaskId)
        if (run?.controller.signal.aborted)
          throw new BotError("CONFLICT", "任务已停止，后台命令未启动")
        this.store.acceptCommand(sourceTaskId, command, continueSource)
        // The persisted source may be the original user authorization. Cleanup
        // also needs the exact commands launched by this physical run.
        run?.launchedCommands.add(command.id)
        this.changed()
      },
      settled: (result) => {
        try {
          this.store.settleCommand(result)
          // Retain launcher identity until this run exits: a completed command
          // can still own a queued notification that Stop must withdraw.
          this.changed()
          if (!this.stopping) this.wake()
        } catch (error) {
          this.faulted = true
          throw error
        }
      }
    }
  }

  messageReply(botId: string, messageId: string, workId?: string) {
    this.requireRunning()
    return this.store.messageReply(botId, messageId, workId)
  }

  messageReactions(target: BotReactionTarget, messageIds: string[]) {
    this.requireRunning()
    return this.store.messageReactions(target, messageIds)
  }

  setMessageReaction(
    target: BotReactionTarget,
    messageId: string,
    emoji: string,
    present: boolean
  ) {
    this.requireRunning()
    const canonicalTarget = parseBotReactionTarget(target)
    const before = this.store.revision()
    const result = this.store.setMessageReaction(canonicalTarget, messageId, emoji, present)
    if (result.revision !== before) {
      this.changed(undefined, canonicalTarget)
      if (present) this.wake()
    }
    return result
  }

  setBotMessageReaction(taskId: string, emoji: string, present: boolean) {
    this.workToolSource(taskId)
    const before = this.store.revision()
    const result = this.store.setBotMessageReaction(taskId, emoji, present)
    if (result.revision !== before)
      this.changed(undefined, { kind: "bot", botId: this.store.getTask(taskId).botId })
    return result
  }

  removeMessageReactionsForThreads(threadIds: readonly string[]): void {
    this.requireRunning()
    const before = this.store.revision()
    this.store.removeMessageReactionsForThreads(threadIds)
    if (this.store.revision() !== before) this.changed()
  }

  send(input: SendBotMessageInput): BotTask {
    this.requireRunning()
    const task = this.store.enqueue(input)
    this.changed()
    this.steerUserMessage(task)
    this.wake()
    return task
  }

  private steerUserMessage(task: BotTask): void {
    if (
      task.state !== "queued" ||
      (!["user", "group"].includes(task.origin.kind) &&
        !(task.origin.kind === "work" && botTaskAcceptsUserInput(task)))
    )
      return
    const groupId = task.origin.kind === "group" ? task.origin.groupId : undefined
    const backgroundRun = [...this.active.values()].find(
      (candidate) =>
        candidate.botId === task.botId &&
        candidate.task.threadId === task.threadId &&
        canDeferBotTask(candidate.task) &&
        (task.origin.kind !== "group" ||
          (candidate.task.origin.kind === "bot" &&
            candidate.task.origin.groupId === groupId &&
            this.store.getTask(candidate.task.id).state === "waiting_user"))
    )
    if (backgroundRun?.steeringReady && !backgroundRun.controller.signal.aborted) {
      backgroundRun.lease.yieldToUser?.(
        () =>
          !this.stopping &&
          !this.faulted &&
          !backgroundRun.controller.signal.aborted &&
          this.active.get(backgroundRun.task.id) === backgroundRun &&
          this.store
            .pendingConversationTasks(task.botId, groupId, task.workId)
            .some(
              (pending) => pending.state === "queued" && pending.origin.kind === task.origin.kind
            )
      )
      return
    }
    const run = [...this.active.values()].find((candidate) => canSteerBotTask(candidate.task, task))
    if (
      !run?.lease.steer ||
      !run.steeringReady ||
      (task.origin.kind === "group" && this.store.getTask(run.task.id).state !== "waiting_user") ||
      run.controller.signal.aborted ||
      run.preparingSteers.has(task.id)
    )
      return
    run.preparingSteers.add(task.id)
    // Hooks may take time. The runtime rechecks the exact lease after preparation,
    // and this callback commits ownership just before transcript/model injection.
    // A crash after this point yields interrupted, never an automatic replay.
    void run.lease
      .steer(task, () => {
        if (
          this.stopping ||
          this.faulted ||
          run.controller.signal.aborted ||
          this.active.get(run.task.id) !== run
        )
          return false
        if (run.steered.has(task.id)) return true // transcript flush retry
        if (this.store.getTask(task.id).state !== "queued") return false
        this.store.injectIntoRun(task.id, run.task.id)
        run.steered.add(task.id)
        this.changed()
        if (this.store.hasPendingCommandNotifications()) this.wake()
        return true
      })
      .catch(this.reportError)
      .finally(() => run.preparingSteers.delete(task.id))
  }

  onSteeringReady(taskId: string): void {
    const run = this.active.get(taskId)
    if (
      !run ||
      (!canDeferBotTask(run.task) && !botTaskAcceptsUserInput(run.task)) ||
      run.controller.signal.aborted
    )
      return
    run.steeringReady = true
    // Only this conversation can steer or yield its running turn.
    for (const task of this.store.pendingTasksForThread(run.task.threadId))
      this.steerUserMessage(task)
  }

  taskCheckpoint(taskId: string): string | undefined {
    this.requireRunning()
    return this.store.taskCheckpoint(taskId)
  }

  continuationFiles(taskId: string): BotDeliveredFile[] {
    this.requireRunning()
    return this.store.continuationFiles(taskId)
  }

  continuationCommandResults(taskId: string): Record<string, unknown>[] {
    this.requireRunning()
    return this.store.continuationCommandResults(taskId)
  }

  continuationCommandIds(taskId: string, includeServices = false): string[] {
    this.requireRunning()
    return this.store.continuationCommandIds(taskId, includeServices)
  }

  stoppedTaskContext(taskId: string) {
    this.requireRunning()
    return this.store.stoppedTaskContext(taskId)
  }

  updateOwnProfile(
    taskId: string,
    patch: { name?: string; instructions?: string }
  ): BotProfileUpdateReceipt {
    this.requireRunning()
    const before = this.store.getBot(this.store.getTask(taskId).botId)
    const bot = this.store.updateOwnProfile(taskId, patch)
    this.changed()
    return {
      ...bot,
      changes: {
        name: before.name !== bot.name,
        instructions: before.instructions !== bot.instructions
      }
    }
  }

  updateTeammate(
    taskId: string,
    botId: string,
    patch: { name?: string; instructions?: string }
  ): BotProfileUpdateReceipt {
    this.requireRunning()
    const before = this.store.getBot(botId)
    const bot = this.store.updateTeammate(taskId, botId, patch)
    this.changed()
    return {
      ...bot,
      changes: {
        name: before.name !== bot.name,
        instructions: before.instructions !== bot.instructions
      }
    }
  }

  cancel(taskId: string, notifyQueuedCaller = true): void {
    this.requireRunning()
    const before = this.store.revision()
    const active =
      this.active.get(taskId) ?? [...this.active.values()].find((run) => run.steered.has(taskId))
    const peers = this.store.stopTaskPeers(active?.task.id ?? taskId)
    this.cancelWorkflows(peers.workflows)
    this.cancelSingleTask(taskId, notifyQueuedCaller)
    for (const peer of peers.tasks) this.cancelSingleTask(peer.id, false)
    if (peers.commandIds.length)
      void Promise.resolve(this.runtime.cancelBackgroundCommands?.(peers.commandIds)).catch(this.reportError)
    if (this.store.revision() !== before) {
      this.changed()
      this.wake()
    }
  }

  private cancelSingleTask(taskId: string, notifyQueuedCaller = true): void {
    if (this.commandCancellations.has(taskId)) return
    const task = this.store.getTask(taskId)
    if (task.origin.kind === "group" || task.origin.kind === "discussion")
      this.store.stopGroupDiscussion(task.origin.groupId, task.origin.messageId)
    const active =
      this.active.get(taskId) ?? [...this.active.values()].find((run) => run.steered.has(taskId))
    this.cancelWorkflows(this.store.suppressTaskWorkflows(active?.task.id ?? taskId))
    if (active) {
      // Persist the notification's Stop decision before cleanup, without
      // claiming its tools have already stopped. Restart must not retry it.
      try {
        this.store.stopRunCommands(task.threadId, [...active.launchedCommands])
        if (active.task.origin.kind === "notification" && ["workflow", "coordinator"].includes(active.task.origin.notificationKind))
          this.recordNotificationTerminal(active.task.id, { outcome: "error", code: "cancelled" })
      } finally {
        active.controller.abort()
      }
    } else if (task.state === "queued") {
      const commands = this.store.continuationCommandIds(task.id, true)
      if (commands.length && this.runtime.cancelCommands) {
        // Keep the source pending and excluded from dispatch until physical cleanup and its receipt settle.
        const done = Promise.resolve()
          .then(async () => {
            try {
              await this.runtime.cancelCommands!(task.threadId, commands)
              if (this.store.getTask(task.id).state !== "queued") return
              if (this.store.continuationCommandIds(task.id, true).length)
                throw new Error("原命令的停止回执未确认，请检查进程及结果。")
              this.store.settle(task.id, this.stopping ? "interrupted" : "cancelled", null)
            } catch (error) {
              if (error instanceof BotError && error.code === "NOT_FOUND") return
              this.faulted = true
              this.store.settle(
                task.id,
                "outcome_unknown",
                error instanceof Error ? error.message : "命令停止结果未确认"
              )
              this.reportError(error)
            } finally {
              this.commandCancellations.delete(task.id)
              this.changed()
              this.wake()
            }
          })
          .catch((error) => {
            this.faulted = true
            this.reportError(error)
          })
        this.commandCancellations.set(task.id, { threadId: task.threadId, done })
        return
      }
      if (this.store.taskCheckpoint(taskId) || task.mockSource?.transport === "im" ||
          (notifyQueuedCaller && ((task.origin.kind === "bot" && (task.origin.expectsReply || task.origin.upstreamTaskId)) ||
          (task.origin.kind === "notification" && task.origin.notificationKind === "workflow"))))
        this.store.settle(taskId, "cancelled", null)
      else this.store.transition(taskId, "cancelled")
      this.changed()
      this.wake()
    }
  }

  stopImConversation(botId: string, bindingId: string): void {
    const revision = this.store.revision()
    this.requireRunning()
    const { tasks, threads } = this.store.imConversationControl(botId, bindingId)
    // Completed dispatchers can still own live peer services. Reuse the same
    // ancestry fence and precise command cleanup as stopping a local conversation.
    const peers = threads.map((threadId) => this.store.stopConversationPeers(botId, threadId))
    this.cancelWorkflows([
      ...peers.flatMap((peer) => peer.workflows),
      ...threads.flatMap((threadId) => this.store.suppressConversationWorkflows(threadId))
    ])
    for (const task of tasks) this.cancelSingleTask(task.id)
    // The stopped branch reports once through its owner, not each unstarted descendant.
    for (const peer of peers) for (const task of peer.tasks) this.cancelSingleTask(task.id, false)
    for (const threadId of threads) {
      this.store.suppressCommands(threadId)
      void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    }
    const commandIds = [...new Set(peers.flatMap((peer) => peer.commandIds))]
    if (commandIds.length)
      void Promise.resolve(this.runtime.cancelBackgroundCommands?.(commandIds)).catch(
        this.reportError
      )
    if (revision !== this.store.revision()) {
      this.changed()
      this.wake()
    }
  }
  stopGroup(groupId: string): void {
    const group = this.getGroup(groupId)
    // Include finished dispatchers that still own peer work. Stop the members in
    // one synchronous Host call, before queued cancellation receipts can dispatch.
    for (const botId of group.memberIds) this.stopConversation(botId, groupId)
  }

  stopConversation(botId: string, groupId?: string, workId?: string): void {
    const revision = this.store.revision()
    if (groupId && workId) throw new BotError("INVALID_INPUT", "群与工作目标不能混用")
    const bot = groupId ? this.getGroupMember(groupId, botId) : this.getBot(botId)
    if (groupId) {
      const review = this.store.groupDiscussionTask(groupId)
      this.store.stopGroupDiscussion(groupId)
      if (review) this.cancel(review)
    }
    const threadId = workId
      ? this.getWork(botId, workId).threadId
      : groupId
        ? `group-${groupId}-${botId}`
        : bot.threadId
    // Read the inbox now, rather than a possibly stale renderer snapshot.
    // cancel() retains runtime cleanup and leaves group work untouched.
    const pending = workId
      ? this.store.pendingWorkFamily(botId, workId)
      : this.store.pendingConversationTasks(botId, groupId)
    const peers = this.store.stopConversationPeers(botId, threadId)
    this.cancelWorkflows([
      ...peers.workflows,
      ...this.store.suppressConversationWorkflows(threadId, workId)
    ])
    for (const task of pending) this.cancelSingleTask(task.id, !workId)
    // The stopped branch reports once through its owner, not each unstarted descendant.
    for (const task of peers.tasks) this.cancelSingleTask(task.id, false)
    this.store.suppressCommands(threadId)
    void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    const commandIds = [...new Set([
      ...peers.commandIds,
      ...(workId ? this.store.suppressWorkPeerCommands(botId, workId) : [])
    ])]
    if (commandIds.length)
      void Promise.resolve(this.runtime.cancelBackgroundCommands?.(commandIds)).catch(
        this.reportError
      )
    if (revision !== this.store.revision()) {
      this.changed()
      this.wake()
    }
  }

  hasActiveRuns(): boolean {
    return (
      this.active.size > 0 ||
      this.commandCancellations.size > 0 ||
      Boolean(this.mockDelivering) ||
      this.store.activeCommandThreads().length > 0
    )
  }

  private readonly workflowCleanup = new Set<Promise<void>>()
  private readonly workflowRefresh = new Map<string, Promise<void>>()

  acceptWorkflow(taskId: string, run: WorkflowRunReference): void {
    this.requireRunning()
    const active = this.active.get(taskId)
    if (!active || active.controller.signal.aborted) throw new BotError("CONFLICT", "任务已停止，workflow 未启动")
    this.store.acceptWorkflow(taskId, run)
    this.changed()
  }

  retireWorkflow(run: WorkflowRunReference): void {
    this.store.retireWorkflow(run)
    this.changed()
  }

  refreshWorkflows(threadId: string): Promise<void> {
    const existing = this.workflowRefresh.get(threadId)
    if (existing) return existing
    if (this.stopping || !this.runtime.reconcileWorkflows) return Promise.resolve()
    const refs = this.store.workflowReferences(threadId)
    if (!refs.length) return Promise.resolve()
    const pending = Promise.resolve().then(() => this.runtime.reconcileWorkflows!(refs))
      .catch(this.reportError).finally(() => { this.workflowRefresh.delete(threadId) })
    this.workflowRefresh.set(threadId, pending)
    return pending
  }

  private cancelWorkflows(runs: readonly BotWorkflowReference[]): void {
    if (!runs.length || !this.runtime.cancelWorkflowInstances) return
    const unique = [...new Map(runs.map((run) => [JSON.stringify([run.threadId, run.runId, run.startedAt]), run])).values()]
    const pending = Promise.resolve().then(() => this.runtime.cancelWorkflowInstances!(unique))
      .catch(this.reportError).finally(() => this.workflowCleanup.delete(pending))
    this.workflowCleanup.add(pending)
  }

  private mockRecoveryComplete = false
  private mockRecoveryTimer: ReturnType<typeof setTimeout> | undefined
  private pumpMockRecovery(): void {
    if (this.mockRecoveryComplete || this.mockRecoveryTimer) return
    const mockMore = this.store.mock.recoverInterruptedBatch()
    const imMore = this.store.im.recoverInterruptedBatch()
    if (!mockMore && !imMore) {
      this.mockRecoveryComplete = true
      return
    }
    // Yield between bounded recovery batches, including when the simulated sender is immediate.
    this.mockRecoveryTimer = setTimeout(() => {
      this.mockRecoveryTimer = undefined
      this.wake()
    }, 0)
    this.mockRecoveryTimer.unref?.()
  }

  private wake(): void {
    if (this.stopping || this.faulted || this.scheduled) return
    this.scheduled = true
    queueMicrotask(this.pumpInHostContext)
  }

  private pump(): void {
    this.pumpMockRecovery()
    if (
      this.mockRecoveryComplete &&
      !this.active.size &&
      Date.now() - this.lastHistoryMaintenance >= 10 * 60_000
    ) {
      this.lastHistoryMaintenance = Date.now()
      try {
        this.store.pruneTaskHistory()
      } catch (error) {
        // Optional housekeeping failure must not turn a valid task into a failed run.
        this.reportError(error)
      }
    }
    if (this.store.flushReplies()) this.wake()
    this.store.advanceGroupDiscussions()
    // Retiring stale group posts can free capacity without dispatching a task.
    if (this.store.hasPendingCommandNotifications() && this.store.flushReplies()) this.wake()
    this.pumpMockDelivery()
    const excluded = new Set([
      ...[...this.active.values()].map((run) => run.task.threadId),
      ...[...this.commandCancellations.values()].map((run) => run.threadId)
    ])
    while (!this.stopping && this.active.size < this.concurrency) {
      const task = this.store.nextQueued(
        [...excluded],
        // The finite-slot policy reserves capacity for main conversations. With
        // admission uncapped, unrelated work threads need no global reservation.
        this.concurrency === Number.POSITIVE_INFINITY ||
          ![...this.active.values()].some((run) => !!botTaskWorkFamily(run.task))
      )
      if (!task) return
      if (this.store.taskRootCancelled(task)) {
        this.cancel(task.id)
        excluded.add(task.threadId)
        continue
      }
      excluded.add(task.threadId)
      const lease = this.runtime.acquire(
        this.store.getBot(task.botId),
        task,
        task.workId ? this.store.getWork(task.botId, task.workId) : undefined
      )
      if (!lease) continue
      try {
        this.store.transition(task.id, "running", null, task.groupSnapshotOrdinal)
      } catch (error) {
        lease.release()
        throw error
      }
      const controller = new AbortController()
      // Start in a microtask so cancellation and waiting hooks always see their active owner.
      const done = Promise.resolve().then(() => this.execute(task, lease, controller))
      this.active.set(task.id, {
        botId: task.botId,
        task,
        lease,
        controller,
        done,
        steered: new Set(),
        launchedCommands: new Set(),
        preparingSteers: new Set(),
        steeringReady: false
      })
      this.changed()
      // Dispatch frees a queued slot even if this run will remain active for a long time.
      if (this.store.hasPendingCommandNotifications()) this.wake()
    }
  }

  private pumpMockDelivery(): void {
    if (this.mockDelivering || this.stopping) return
    const reply = this.store.mock.beginDelivery()
    if (!reply) return
    this.changed()
    this.mockDelivering = Promise.resolve()
      .then(async () => {
        if (!this.store.mock.mayDeliver(reply.id)) return
        let state: "sent" | "unknown" = "unknown"
        try {
          state = await this.mockTransport.send(reply)
        } catch {
          /* A transport exception is not proof of non-delivery. */
        }
        this.store.mock.delivered(reply.id, state)
        this.changed()
      })
      .catch((error) => {
        this.faulted = true
        this.reportError(error)
      })
      .finally(() => {
        this.mockDelivering = null
        this.wake()
      })
  }

  private async execute(
    task: BotTask,
    lease: BotRunLease,
    controller: AbortController
  ): Promise<void> {
    let state: BotTaskState = "outcome_unknown"
    let reason: string | null = null
    let finalText: string | undefined
    let files: BotDeliveredFile[] | undefined
    let explicitGroupMessages = false
    let publicContribution = false
    let waitingCount = 0
    let deferredCheckpoint: string | undefined
    let deferredFiles: BotDeliveredFile[] | undefined
    let consumedCommandIds: string[] | undefined
    try {
      const result = await lease.execute(controller.signal, (waiting) => {
        if (controller.signal.aborted) return
        waitingCount = Math.max(0, waitingCount + (waiting ? 1 : -1))
        this.store.transition(task.id, waitingCount > 0 ? "waiting_user" : "running")
        this.changed()
        if (waitingCount > 0 && botTaskGroupId(task)) this.wake()
      })
      if (result.state === "deferred") {
        deferredCheckpoint = result.checkpointId
        deferredFiles = result.files
        consumedCommandIds = result.consumedCommandIds
      } else {
        state = result.state
        reason = result.error ?? null
        finalText = result.result
        files = result.files
        explicitGroupMessages = result.explicitGroupMessages === true
        publicContribution = result.publicContribution === true
      }
    } catch (error) {
      state = "failed"
      reason = error instanceof Error ? error.message : "任务执行失败"
    } finally {
      if (controller.signal.aborted) {
        deferredCheckpoint = undefined
        state = this.stopping ? "interrupted" : "cancelled"
        reason = this.stopping ? "应用退出，任务已中断；请检查已有结果后继续。" : null
      }
      if (
        controller.signal.aborted ||
        (!deferredCheckpoint &&
          task.origin.kind !== "schedule" &&
          (state === "failed" || state === "outcome_unknown"))
      ) {
        const launched = controller.signal.aborted
          ? this.store.stopRunCommands(task.threadId, [...(this.active.get(task.id)?.launchedCommands ?? [])], this.stopping)
          : []
        const commands = [...new Set([...this.store.continuationCommandIds(task.id, true), ...launched])]
        if (commands.length) {
          try {
            await this.runtime.cancelCommands?.(task.threadId, commands)
          } catch (error) {
            this.faulted = true
            state = "outcome_unknown"
            reason = "任务命令停止结果未确认，请检查已有进程及结果。"
            this.reportError(error)
          }
        }
      }
      try {
        // These messages were consumed by this exact graph, not separate queued runs.
        // Unconsumed messages stay queued and run normally after the lease releases.
        if (deferredCheckpoint)
          this.store.deferTask(task.id, deferredCheckpoint, deferredFiles, consumedCommandIds)
        else
          this.store.settleRun(
            task.id,
            this.active.get(task.id)?.steered ?? [],
            state,
            reason,
            finalText,
            files,
            explicitGroupMessages,
            task.origin.kind === "notification" && ["workflow", "coordinator"].includes(task.origin.notificationKind)
              ? (state === "cancelled" ? { outcome: "error", code: "cancelled" }
                : lease.notificationTerminal?.() ?? {
                    outcome: state === "completed" ? "success" : "error",
                    code: state === "completed" ? "normal" : controller.signal.aborted ? "cancelled" : "setup_error"
                  })
              : undefined
          )
        this.changed()
        try {
          if (!deferredCheckpoint) {
            if (publicContribution) this.runtime.onSettled?.(task, state, finalText, files, true)
            else this.runtime.onSettled?.(task, state, finalText, files)
          }
        } catch (error) {
          this.reportError(error)
        }
      } catch (error) {
        // Do not start new side effects after losing a durable terminal receipt.
        // A restart reconciles the still-active record as interrupted, without replay.
        this.faulted = true
        this.reportError(error)
      } finally {
        this.active.delete(task.id)
        try {
          lease.release()
        } catch (error) {
          this.faulted = true
          this.reportError(error)
        }
        this.wake()
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      if (this.mockRecoveryTimer) clearTimeout(this.mockRecoveryTimer)
      this.mockRecoveryTimer = undefined
      this.lifecycle.abort()
      clearTimeout(this.scheduleTimer)
      this.unsubscribe()
      for (const run of this.active.values()) run.controller.abort()
    }
    const backgroundStops = this.store.activeCommandThreads().map((threadId) => {
      this.store.suppressCommands(threadId, undefined, false)
      return this.runtime.cancelBackground?.(threadId)
    })
    await Promise.allSettled(
      [...this.active.values()]
        .map((run) => run.done)
        .concat(
          [...this.deletions.values()],
          [...this.commandCancellations.values()].map((run) => run.done),
          [...this.workflowCleanup],
          [...this.workflowRefresh.values()],
          [this.recovery],
          this.mockDelivering ? [this.mockDelivering] : [],
          backgroundStops.map((stop) => Promise.resolve(stop))
        )
    )
    this.listeners.clear()
  }
}
