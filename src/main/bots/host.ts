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
import type { BotStore } from "./store"
import { canDeferBotTask, canSteerBotTask } from "./continuation"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BackgroundCommandLifecycle } from "../agent/background-command-lifecycle"
import type { UserInputRequest } from "../types"
import { parseCreateBotWork } from "../../shared/bots/validation"
import { parseBotReactionTarget, type BotReactionTarget } from "../../shared/bots/message-reactions"

export interface BotRunLease {
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
      }
    | {
        state: "deferred"
        checkpointId: string
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
  hasPendingWork?(threadIds: readonly string[]): Promise<boolean>
  /** Cancel only this conversation's detached work through the existing managers. */
  cancelBackground?(threadId: string): void | Promise<void>
  /** Release only a removed member's browser ownership in this group; rejoining remains allowed. */
  removeGroupMemberBrowser?(groupId: string, botId: string): void | Promise<void>
  cancelCommands?(threadId: string, ids: readonly string[]): Promise<void>
  cancelBackgroundCommands?(commandIds: readonly string[]): void | Promise<void>
  recover?(threadIds: string[], signal: AbortSignal): Promise<void>
  /** Claim the existing runtime's thread lease before changing durable task state. */
  acquire(bot: BotDefinition, task: BotTask, work?: BotWorkItem): BotRunLease | null
  onAvailable(listener: () => void): () => void
  onSettled?(task: BotTask, state: BotTaskState, result?: string, files?: BotDeliveredFile[]): void
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
    if (runtime.recover)
      this.recovery = Promise.resolve()
        .then(() => runtime.recover!(store.notificationThreadIds(), this.lifecycle.signal))
        .catch((error) => {
          if (!this.lifecycle.signal.aborted) this.reportError(error)
        })
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
      const [bindingId, botId, extra] = id.slice(3).split("--")
      const binding = this.imGateway.binding(bindingId)
      if (!bindingId || !botId || extra || !binding || binding.binding.botId !== botId)
        throw new BotError("INVALID_INPUT", "群浏览器目标无效")
      this.getBot(botId)
    } else if (id.startsWith("group-")) {
      const [groupId, memberId, extra] = id.slice(6).split("--")
      if (!memberId || extra) throw new BotError("INVALID_INPUT", "请选择要查看的群成员浏览器")
      this.getGroupMember(groupId, memberId)
    } else {
      this.getBot(id)
    }
    return id
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
      backgroundThreads: this.store.activeCommandThreads()
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
    const result = this.store.im.inject({ ...input, simulation: true })
    this.wake()
    return result
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
    if (task.mockSource) this.store.external(task.mockSource).initialize(task.mockSource)
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
      task?.mockSource && task.mockSource.transport !== "im"
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
  async assertConversationLinkIdle(threadId: string, botId?: string, workId?: string) {
    this.requireRunning()
    await this.recovery
    if (await this.runtime.hasPendingWork?.([threadId]))
      throw new BotError("CONFLICT", "请先处理此会话的后台执行和待通知结果。")
    this.requireRunning()
    if (this.store.pendingTasksForThread(threadId).length)
      throw new BotError("CONFLICT", "请先处理此会话的待办和正在执行的消息。")
    if (botId && workId) this.store.conversations.assertIdle(botId, workId)
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
  exchange(botId: string, taskId: string, groupId?: string, workId?: string) {
    this.requireRunning()
    return this.store.exchange(botId, taskId, groupId, workId)
  }
  exchangeHistory(
    botId: string,
    taskId: string,
    groupId?: string,
    before?: string,
    workId?: string
  ) {
    this.requireRunning()
    return this.store.exchangeHistory(botId, taskId, groupId, before, workId)
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
      this.store.suppressCommands(threadId)
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
    return group
  }
  groupMessages(id: string, cursor?: BotGroupHistoryCursor): BotGroupMessage[] {
    this.requireRunning()
    return this.store.groupMessages(id, cursor)
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
    const task = this.store.delegate(taskId, target, message, key, outputFiles)
    this.changed()
    this.wake()
    return task
  }

  peerHandoff(task: Pick<BotTask, "id">) {
    this.requireRunning()
    return this.store.peerHandoff(task.id)
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
    this.armSchedules()
    return schedule
  }

  removeSchedule(id: string, version: number): void {
    this.requireRunning()
    this.store.removeSchedule(id, version)
    this.changed()
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
    const threads = this.store.beginDeletion(id, expectedVersion)
    this.changed()
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
  ): void {
    this.requireRunning()
    const bot = this.store.getBot(botId)
    if (bot.archived || bot.deleting) return
    const work = this.store.workForThread(botId, threadId)
    // A late result remains in the original manager's history. It cannot reopen or run a closed work.
    if (work?.state === "completed") return
    const imParent = this.store.imThreadSource(botId, threadId)
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
    this.store.enqueue(
      {
        botId,
        ...(work ? { workId: work.id } : {}),
        requestId: `notification:${threadId}:${kind}:${key}${runStartedAt ? `:${runStartedAt}` : ""}`,
        message
      },
      {
        kind: "notification",
        notificationKind: kind,
        ...(imParent ? { sourceTaskId: imParent.id } : {}),
        key,
        ...(groupId ? { groupId } : {}),
        ...(runStartedAt ? { runStartedAt } : {})
      },
      imParent?.mockSource
    )
    this.changed()
    this.wake()
  }

  commandLifecycle(sourceTaskId: string, continueSource = false): BackgroundCommandLifecycle {
    return {
      accepted: (command) => {
        this.requireRunning()
        this.store.acceptCommand(sourceTaskId, command, continueSource)
        this.changed()
      },
      settled: (result) => {
        try {
          this.store.settleCommand(result)
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

  cancel(taskId: string): void {
    this.requireRunning()
    if (this.commandCancellations.has(taskId)) return
    const task = this.store.getTask(taskId)
    if (task.origin.kind === "group" || task.origin.kind === "discussion")
      this.store.stopGroupDiscussion(task.origin.groupId, task.origin.messageId)
    const active =
      this.active.get(taskId) ?? [...this.active.values()].find((run) => run.steered.has(taskId))
    if (active) {
      // Durable cancellation only after runtime cleanup, never while tools are still unwinding.
      active.controller.abort()
    } else if (task.state === "queued") {
      const commands = this.store.continuationCommandIds(task.id)
      if (commands.length && this.runtime.cancelCommands) {
        // Keep the source pending and excluded from dispatch until physical cleanup and its receipt settle.
        const done = Promise.resolve()
          .then(async () => {
            try {
              await this.runtime.cancelCommands!(task.threadId, commands)
              if (this.store.getTask(task.id).state !== "queued") return
              const results = this.store.continuationCommandResults(task.id)
              if (!commands.every((id) => results.some((result) => result.task_id === id)))
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
      if (this.store.taskCheckpoint(taskId) || task.mockSource?.transport === "im")
        this.store.settle(taskId, "cancelled", null)
      else this.store.transition(taskId, "cancelled")
      this.changed()
      this.wake()
    }
  }

  stopImConversation(botId: string, bindingId: string): void {
    this.requireRunning()
    const { tasks, threads } = this.store.imConversationControl(botId, bindingId)
    for (const task of tasks) this.cancel(task.id)
    for (const threadId of threads) {
      this.store.suppressCommands(threadId)
      void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    }
  }
  stopConversation(botId: string, groupId?: string, workId?: string): void {
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
    for (const task of pending) this.cancel(task.id)
    this.store.suppressCommands(threadId)
    void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    if (workId) {
      const ids = this.store.suppressWorkPeerCommands(botId, workId)
      if (ids.length)
        void Promise.resolve(this.runtime.cancelBackgroundCommands?.(ids)).catch(this.reportError)
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
    this.store.flushReplies()
    this.store.advanceGroupDiscussions()
    this.pumpMockDelivery()
    const excluded = new Set([
      ...[...this.active.values()].map((run) => run.task.threadId),
      ...[...this.commandCancellations.values()].map((run) => run.threadId)
    ])
    while (!this.stopping && this.active.size < this.concurrency) {
      const task = this.store.nextQueued(
        [...excluded],
        ![...this.active.values()].some((run) => !!botTaskWorkFamily(run.task))
      )
      if (!task) return
      excluded.add(task.threadId)
      const lease = this.runtime.acquire(
        this.store.getBot(task.botId),
        task,
        task.workId ? this.store.getWork(task.botId, task.workId) : undefined
      )
      if (!lease) continue
      try {
        this.store.transition(task.id, "running")
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
        preparingSteers: new Set(),
        steeringReady: false
      })
      this.changed()
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
    let waitingCount = 0
    let deferredCheckpoint: string | undefined
    let deferredFiles: BotDeliveredFile[] | undefined
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
      } else {
        state = result.state
        reason = result.error ?? null
        finalText = result.result
        files = result.files
        explicitGroupMessages = result.explicitGroupMessages === true
      }
    } catch (error) {
      state = "failed"
      reason = error instanceof Error ? error.message : "任务执行失败"
    } finally {
      if (controller.signal.aborted) {
        deferredCheckpoint = undefined
        state = this.stopping ? "interrupted" : "cancelled"
        reason = this.stopping ? "应用退出，任务已中断；请检查已有结果后继续。" : null
        const commands = this.store.continuationCommandIds(task.id)
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
        if (deferredCheckpoint) this.store.deferTask(task.id, deferredCheckpoint, deferredFiles)
        else
          this.store.settleRun(
            task.id,
            this.active.get(task.id)?.steered ?? [],
            state,
            reason,
            finalText,
            files,
            explicitGroupMessages
          )
        this.changed()
        try {
          if (!deferredCheckpoint) this.runtime.onSettled?.(task, state, finalText, files)
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
      this.store.suppressCommands(threadId)
      return this.runtime.cancelBackground?.(threadId)
    })
    await Promise.allSettled(
      [...this.active.values()]
        .map((run) => run.done)
        .concat(
          [...this.deletions.values()],
          [...this.commandCancellations.values()].map((run) => run.done),
          [this.recovery],
          this.mockDelivering ? [this.mockDelivering] : [],
          backgroundStops.map((stop) => Promise.resolve(stop))
        )
    )
    this.listeners.clear()
  }
}
