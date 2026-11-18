import { createHash } from "node:crypto"
import { selectedMainBotSkill } from "../agent/bot-skill-dispatch"
import { lstat, realpath, rm, stat } from "node:fs/promises"
import type {
  BotConversationToolsPort,
  BotConversationToolSource,
  BotOrdinaryThreadsPort,
  BotThreadHistorySource,
  BotThreadLinkInput,
  BotThreadListInput,
  BotThreadReadInput,
  BotThreadRenameInput,
  BotWorkUnlinkInput
} from "../../shared/bots/thread-history"
import type { AgentRunTerminal } from "../agent/agent-run-service"
import { pinTransferredBotInputFile, retainedInputFileIds, verifyInputFiles } from "./input-files"
import { hashBotFile } from "./file-copy"
import type { BotHistoricalDeliveryReference, BotHistoricalDeliveryUse } from "./delivery-receipt"
import {
  botInputNeedsLifetimePin, removeUninitializedWorkInputPins, workInputPinStorage, type BotInputHistoryResolver
} from "./attachment-storage"
import {
  requireThreadMutationLease,
  withThreadMutationLeaseLock,
  withThreadRunMutationLock,
  type ThreadMutationLease
} from "../ipc/thread-run-mutation-lock"
import { botHistoryInputProjection } from "./history-input-projection"
import { localWorkConversationRef } from "./conversation-link-validation"
import type { ThreadIncarnationRow } from "../services/thread-incarnation"
import { validateWorkspaceDirectory } from "../services/workspace-validation"
import type { FileAttachment } from "../../shared/file-attachment"
import type {
  BotWorkHistoryInput,
  BotWorkHistoryPort,
  BotWorkHistorySource
} from "../../shared/bots/work-history"
import { AsyncResource } from "node:async_hooks"
import {
  botWorkBrowserScope,
  type BotSkillWorkspaceTarget,
  type BotWorkWorkspacePort,
  type BotWorkItem,
  type BotWorkSummary,
  type BotWorkControlInput,
  type BotWorkInteraction,
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
import type { BotScheduleEdit, BotScheduleToolEdit, BotStore, BotWorkflowReference, BotWorkScheduleCreation } from "./store"
import type { BotDesktopOperationQuery } from "./desktop-operation"
import { BotFeatureTurns } from "./feature-turns"
import type { FeatureScope, FeatureTaskQuery } from "./feature-store"
import type { BotFeatureTask } from "../../shared/bots/feature"
import type { WorkflowRunReference } from "../agent/workflow/run-manager"
import { canDeferBotTask, canSteerBotTask, canDeliverBotFeedback, isRetryableNotificationTerminal } from "./continuation"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BotSkillSelection } from "../../shared/bots/skill-selection"
import type { BackgroundCommandLifecycle } from "../agent/background-command-lifecycle"
import type { UserInputRequest, UserInputResponse } from "../types"
import { parseCreateBotWork } from "../../shared/bots/validation"
import { parseBotReactionTarget, type BotReactionTarget } from "../../shared/bots/message-reactions"
import type { BotImBinding } from "../../shared/bots/im-channel"
import type { BotWorkRuntimeState } from "../../shared/bots/work-status"
import { projectBotWorkStatus } from "./work-status"
import type { BotWorkDeletionIdentity, BotWorkDeletionReceipt } from "./work-deletion"
import type { BotWorkResultDecision, BotWorkResultReviewAlternative } from "./work-result-review"
import { BOT_WORK_RESULT_PUBLICATION_RETRY_LIMIT, RetryableBotWorkPublicationError,
  type BotWorkResultAttachmentReference, type BotWorkResultCommandReference } from "./work-result-settlement"
import type { BotFixedReminderInput, BotScheduledWorkPublication, BotWorkScheduleMonitorInput } from "../../shared/bots/schedule-observation"
import { scheduledDesktopMessage } from "../../shared/bots/schedule-observation"

export interface BotRunLease {
  notificationTerminal?(): AgentRunTerminal | undefined
  /** Approval IDs produced by this physical run's existing wait hook. */
  approvalRequestIds?: ReadonlySet<string>
  /** Reuse the active runtime's user-prompt pipeline; inbox remains queued until injection. */
  steer?(task: BotTask, beforeInject: () => boolean, stillAllowed?: () => boolean): Promise<boolean | { rejected: true }>
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
        /** This communication turn ended on verified asynchronous dispatch receipts. */
        dispatchAcknowledged?: boolean
        files?: BotDeliveredFile[]
        /** Group text is published explicitly; final scratch stays private, including on failure. */
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
  workRuntimeStatus?(work: BotWorkSummary): BotWorkRuntimeState
  ordinaryThreads?: BotOrdinaryThreadsPort
  conversationTools?: BotConversationToolsPort
  pendingUserInput?(task: BotTask): UserInputRequest | null
  answerUserInput?(response: UserInputResponse): boolean
  pendingApproval?(task: BotTask, requestIds: ReadonlySet<string>): string | undefined
  subscribeApprovalChanges?(listener: (registeredId?: string) => void): () => void
  scheduleObservationPublication?: {
    persist(bot: BotDefinition, publication: BotScheduledWorkPublication): string | null | void
    announce(publication: BotScheduledWorkPublication): Promise<void>
  }
  desktopWorkScheduleDirectory?(work: BotWorkItem): { path: string; incarnation?: string } | undefined
  /** Existing thread mutation guard; metadata only, never creates or runs a thread. */
  renameWork?(work: BotWorkItem, commit: () => BotWorkItem, lease?: ThreadMutationLease): Promise<BotWorkItem>
  browser?: boolean
  workspaces?: BotWorkWorkspacePort
  validateSkillSelection?(selection: BotSkillSelection): Promise<void>
  /** Existing workflow/coordinator managers remain authoritative, including durable pending results. */
  hasPendingWork?(threadIds: readonly string[], options?: { allowPendingCoordinatorNotifications?: boolean }): Promise<boolean>
  /** Synchronous archive fence for existing Team conversations; no worker lifecycle changes. */
  hasPendingCoordinator?(threadIds: readonly string[]): boolean
  /** Cancel only this conversation's detached work through the existing managers. */
  cancelBackground?(threadId: string): void | Promise<void>
  /** Retire the exact browser scope of a permanently deleted work. */
  removeWorkBrowser?(scope: string): Promise<void>
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

type BotChangeDetail = Omit<BotChangeEvent, "hostId" | "revision">
type BotProfileUpdateReceipt = BotDefinition & {
  changes: { name: boolean; instructions: boolean }
}

/** No Electron or renderer dependency. The host owns the queue even with no open workspace. */
export class LocalBotHost {
  readonly featureTurns = new BotFeatureTurns()
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
      browserHelp?: import("./browser").BotBrowserHelp
      workReviewCommitted?: true
    }
  >()
  private readonly deletions = new Map<string, Promise<void>>()
  private readonly workDeletions = new Map<string, Promise<BotWorkDeletionReceipt>>()
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
  private yieldBeforePump = false
  private admissionExcluded: Set<string> | undefined
  private mockDelivering: Promise<void> | null = null
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private schedulePublicationRetryAt: number | undefined
  private readonly schedulePublicationRetries = new Map<string, { failures: number; at?: number }>()
  private changeRevision = 0
  private lastHistoryMaintenance = -Infinity
  // A tool may wake this queue, but its expiring call scope must not own a new Bot run.
  private readonly pumpInHostContext = AsyncResource.bind(() => {
    if (this.stopping || this.faulted) {
      this.scheduled = false
      return
    }
    // A wake already queued by a receipt/listener must not bypass a requested yield.
    if (this.yieldBeforePump) {
      this.yieldBeforePump = false
      setImmediate(this.pumpInHostContext)
      return
    }
    this.scheduled = false
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
    // Production disables only the Host-wide cap; thread/resource ownership still applies.
    if (
      concurrency !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    )
      throw new Error("Invalid Bot concurrency")
    store.recover()
    if (runtime.scheduleObservationPublication) store.settleQueuedScheduledWorkObservations()
    const unsubscribeAvailable = runtime.onAvailable(() => { this.admissionExcluded = undefined; this.wake() })
    const unsubscribeApprovals = runtime.subscribeApprovalChanges?.(registeredId => {
      if (this.stopping) return
      for (const { task, lease } of this.active.values()) {
        if (!lease.approvalRequestIds?.size || (registeredId && !lease.approvalRequestIds.has(registeredId)) ||
            task.mockSource || botTaskGroupId(task) || !botTaskWorkFamily(task)) continue
        this.changed()
        break
      }
    })
    this.unsubscribe = () => {
      unsubscribeAvailable()
      unsubscribeApprovals?.()
    }
    this.wake()
    this.armSchedules()
    if (runtime.recover) {
      this.recoveryReady = false
      this.recovery = Promise.resolve()
        .then(() => runtime.recover!(store.notificationThreadIds(), this.lifecycle.signal))
        .then(() => { this.recoveryReady = true; this.wake() })
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
      const work = this.getWork(botId, workId)
      if (work.deletionPending || work.deletionCommitted)
        throw new BotError("CONFLICT", "任务正在删除或已删除，无法操作浏览器。")
      const { source } = work
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
  getGroupReference(groupId: string, botId: string, source: "app" | "zhaohu" = "app") {
    this.requireRunning()
    return this.store.getGroupReference(groupId, botId, source)
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
      schedules: this.store.schedulesWithPendingOccurrences(),
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

  hasUnread(): boolean {
    if (this.stopping) throw new BotError("STOPPING", "应用正在退出，请稍后重试")
    return this.store.hasUnread()
  }

  imConversationHistory(botId: string, id: string, before?: string) {
    return this.store.imConversationHistory(botId, id, before)
  }
  imConversationWorks(botId: string, id: string, cursor?: string, query?: string) {
    return this.withWorkExecution(this.store.imConversationWorks(botId, id, cursor, query))
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
    if (!this.stopping) this.changed({ memoryBotId: botId })
  }

  private changed(detail?: BotChangeDetail): void {
    try {
      this.changeRevision = this.store.revision()
    } catch (error) {
      if (!detail?.reminder) throw error
      // The committed transcript append has an exact identity independent of
      // the optional snapshot refresh. Still deliver it to resident chats.
      this.reportError(error)
    }
    const event: BotChangeEvent = {
      hostId: LOCAL_BOT_HOST_ID,
      revision: this.changeRevision,
      workChanges: this.store.workInvalidations.take(),
      ...detail
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
  async renameWorkFromTool(
    source: { taskId: string; callId: string; key: string },
    workId: string,
    expectedVersion: number,
    title: string
  ): Promise<BotWorkItem> {
    const validate = () => {
      const task = this.workToolSource(source.taskId)
      if (task.workId || !this.store.hasWorkUserRequest(task.id))
        throw new BotError("CONFLICT", "只能从主对话的当前用户要求修改任务名称")
      const work = this.store.assertWorkAudience(task, workId)
      if (work.conversation?.origin === "existing") this.ordinaryThreadSource(source.taskId)
      return work
    }
    return this.renameManagedWork(validate(), () => {
      validate()
      return this.store.renameWork(source, workId, expectedVersion, title)
    })
  }
  async renameWorkFromDesktop(work: BotWorkItem, title: string, lease: ThreadMutationLease): Promise<BotWorkItem> {
    this.requireRunning()
    return this.renameManagedWork(work, () => {
      this.requireRunning()
      return this.store.renameDesktopWork(work, title)
    }, lease)
  }
  private async renameManagedWork(
    work: BotWorkItem, commit: () => BotWorkItem, lease?: ThreadMutationLease
  ): Promise<BotWorkItem> {
    if (!this.runtime.renameWork) throw new BotError("CONFLICT", "当前主机不支持修改任务名称")
    try {
      return await this.runtime.renameWork(work, commit, lease)
    } finally {
      // A native-title persistence failure can follow a committed work title.
      // Publish the true work state so both entrances can retry the synchronization.
      this.changed()
    }
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
    const work = this.store.assertWorkAudience(task, workId)
    if (action === "continue" && work.dispatchStopped && work.conversation?.origin === "existing")
      this.ordinaryThreadSource(task.id)
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
  stopWorkFromTool(
    source: { taskId: string; callId: string; key: string },
    workId: string,
    expectedVersion: number
  ) {
    const task = this.workToolSource(source.taskId)
    const target = this.store.assertWorkAudience(task, workId)
    if (target.conversation?.origin === "existing") this.ordinaryThreadSource(task.id)
    const revision = this.store.revision()
    const receipt = this.store.requestWorkStop(source, workId, expectedVersion)
    const current = this.store.getWork(receipt.botId, workId)
    // A lost Stop reply must never cancel work the user has since continued.
    if (!current.dispatchStopped || current.version !== receipt.version)
      throw new BotError("CONFLICT", "原停止请求已处理，任务已有后续操作；未重复停止，请查看当前状态")
    this.stopConversationRuns(receipt.botId, undefined, workId, "work", revision)
    const stopped = this.store.getWork(receipt.botId, workId)
    return {
      ...receipt,
      cleanupPending: stopped.backgroundBusy ||
        this.store.pendingWorkFamily(receipt.botId, workId).length > 0
    }
  }
  pauseWorkReviewFromTool(
    source: BotConversationToolSource,
    workId: string,
    expectedVersion: number
  ) {
    this.workToolSource(source.taskId)
    const receipt = this.store.requestWorkReviewPause(source, workId, expectedVersion)
    this.changed()
    this.wake()
    return receipt
  }
  sendWork(
    source: { taskId: string; callId: string; key: string },
    workId: string,
    message: string,
    expectedVersion?: number,
    inputFileIds: readonly string[] = []
  ) {
    const task = this.workToolSource(source.taskId)
    if (!this.store.hasWorkUserRequest(task.id))
      throw new BotError("CONFLICT", "只有当前用户明确指令可以转达工作消息")
    const result = this.store.sendWork(source, workId, message, expectedVersion, inputFileIds)
    return this.publishWorkSend(result)
  }

  private publishWorkSend(result: BotTask): BotTask {
    this.changed()
    // A replay returns the original admission receipt, not the current state.
    // Never run preparation again for an already consumed or rejected entry.
    this.steerUserMessage(this.store.getTask(result.id))
    this.wake()
    return result
  }
  async sendWorkWithFiles(
    source: { taskId: string; callId: string; key: string }, workId: string, message: string,
    expectedVersion: number | undefined, inputFileIds: readonly string[]
  ) {
    if (!this.store.hasWorkUserRequest(this.workToolSource(source.taskId).id))
      throw new BotError("CONFLICT", "只有当前用户明确指令可以转达工作消息")
    return this.withVerifiedWorkInputs(source, workId, inputFileIds,
      () => this.store.workSendReceipt(source, workId, message, expectedVersion, inputFileIds),
      pins => this.store.sendWork(source, workId, message, expectedVersion, inputFileIds, pins),
      admitted => this.publishWorkSend(admitted))
  }
  private async withVerifiedWorkInputs<T>(
    source: { taskId: string; callId: string; key: string }, workId: string, inputFileIds: readonly string[],
    replay: () => T | undefined, commit: (pins?: ReadonlyMap<string, string>) => T, onCommit: (receipt: T) => void
  ) {
    const task = this.workToolSource(source.taskId)
    const receipt = replay()
    if (receipt) return receipt
    const signal = this.active.get(source.taskId)!.controller.signal
    const files = this.store.workInputFiles(source.taskId, inputFileIds)
    const transfers = new Set(files.filter(file => botInputNeedsLifetimePin(file, workId)).map(file => file.id))
    if (!transfers.size) {
      await verifyInputFiles(files, signal)
      signal.throwIfAborted()
      this.workToolSource(source.taskId)
      const prior = replay()
      if (prior) return prior
      const admitted = commit()
      onCommit(admitted)
      return admitted
    }
    const target = this.getWork(task.botId, workId)
    return withThreadRunMutationLock(target.threadId, async () => {
      signal.throwIfAborted()
      const prior = replay()
      if (prior) return prior
      const work = this.getWork(task.botId, workId)
      if (work.threadId !== target.threadId) throw new BotError("CONFLICT", "原任务会话已变化")
      const destination = workInputPinStorage(work)
      const createdPaths = new Set<string>()
      const pinnedInputs = new Map<string, string>()
      let admitted: T
      try {
        for (const file of files) {
          if (transfers.has(file.id))
            pinnedInputs.set(file.id, await pinTransferredBotInputFile(file, destination, signal, createdPaths))
          else await verifyInputFiles([file], signal)
        }
        signal.throwIfAborted()
        this.workToolSource(source.taskId)
        admitted = commit(pinnedInputs)
      } catch (error) {
        await Promise.all([...createdPaths].map(path => realpath(path).then(async actual => {
          if (actual === path) await rm(path, { force: true })
        }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.reportError(error)
        })))
        throw error
      }
      onCommit(admitted)
      return admitted
    })
  }
  beginInputPreparation(runTaskId: string, inputTaskId: string): void {
    const run = this.workToolSource(runTaskId)
    const input = this.store.getTask(inputTaskId)
    if (run.botId !== input.botId || run.threadId !== input.threadId ||
        (input.id !== run.id && input.state !== "queued" && input.injectedInto !== run.id))
      throw new BotError("CONFLICT", "输入不属于当前运行")
    this.store.beginInputPreparation(inputTaskId)
  }
  recordPreparedInput(runTaskId: string, inputTaskId: string, body: string | null): void {
    const run = this.workToolSource(runTaskId)
    const input = this.store.getTask(inputTaskId)
    if (run.botId !== input.botId || run.threadId !== input.threadId ||
        (input.id !== run.id && input.state !== "queued" && input.injectedInto !== run.id))
      throw new BotError("CONFLICT", "附件输入不属于当前运行")
    const revision = this.store.revision()
    this.store.recordPreparedInput(inputTaskId, body)
    if (revision !== this.store.revision()) this.changed()
  }
  armWorkResultReview(taskId: string, incarnation: string): boolean {
    this.workToolSource(taskId)
    return this.store.armWorkResultReview(taskId, incarnation)
  }
  workResultReviewActiveForExecution(taskId: string): boolean {
    this.requireRunning()
    return this.store.workResultReviewActiveForExecution(taskId)
  }
  recordWorkResultEvidence(taskId: string, input: Parameters<BotStore["recordWorkResultEvidence"]>[1]): void {
    this.workToolSource(taskId)
    this.store.recordWorkResultEvidence(taskId, input)
  }
  workResultReview(taskId: string) {
    this.workToolSource(taskId)
    return this.store.getWorkResultReview(taskId)
  }
  recordWorkResultServiceReady(taskId: string, serviceId: string, reason: string, inspected?: BotWorkResultCommandReference) {
    this.workToolSource(taskId)
    const result = this.store.recordWorkResultServiceReady(taskId, serviceId, reason, inspected)
    this.changed()
    this.wake()
    return result
  }
  commitWorkResultReview(
    taskId: string,
    decision: BotWorkResultDecision | null,
    selected: readonly BotWorkResultAttachmentReference[],
    inspectedCommands: readonly BotWorkResultCommandReference[] = [],
    alternative?: BotWorkResultReviewAlternative,
    response?: { messageId: string; finalText: string; serviceIds?: string[]; filesSelected?: true },
    reportRejectionInCurrentTurn = false
  ) {
    this.workToolSource(taskId)
    const receipt = this.store.commitWorkResultReview(taskId, decision, selected, inspectedCommands, alternative, response, reportRejectionInCurrentTurn)
    this.active.get(taskId)!.workReviewCommitted = true
    this.changed()
    this.wake()
    return receipt
  }
  workResultPublication(taskId: string, refreshUnwritten = false) {
    this.workToolSource(taskId)
    return this.store.getWorkResultPublication(taskId, refreshUnwritten)
  }
  hasPublishedWorkResultMessage(input: Parameters<BotStore["hasPublishedWorkResultMessage"]>[0]): boolean {
    this.requireRunning()
    return this.store.hasPublishedWorkResultMessage(input)
  }
  acknowledgeWorkResultPublication(taskId: string) {
    this.workToolSource(taskId)
    const first = this.store.acknowledgeWorkResultPublication(taskId)
    try { this.changed() } catch (error) { this.reportError(error) }
    this.wake()
    return first
  }
  canDispatchWorkResultRepair(taskId: string, incarnation: string): boolean {
    this.workToolSource(taskId)
    return this.store.canDispatchWorkResultRepair(taskId, incarnation)
  }
  historicalMessageOrigins(...args: Parameters<BotStore["historicalMessageOrigins"]>) {
    this.requireRunning()
    return this.store.historicalMessageOrigins(...args)
  }
  legacyHistoryRequests(...args: Parameters<BotStore["legacyHistoryRequests"]>) {
    this.requireRunning()
    return this.store.legacyHistoryRequests(...args)
  }
  inputProjections(botId: string, threadId: string, messageIds: readonly string[], workIds?: readonly string[], purpose?: "reply") {
    this.requireRunning()
    return this.store.inputProjections(botId, threadId, messageIds, workIds, purpose)
  }
  inputFilesForTask(taskId: string) {
    const task = this.store.getTask(taskId)
    return this.store.inputFiles(task.botId,
      task.origin.kind === "user" || task.origin.kind === "work" ? task.origin.inputFileIds ?? [] : [])
  }
  async verifyInputFilesForRun(runTaskId: string, inputTaskId: string): Promise<void> {
    const run = this.workToolSource(runTaskId), input = this.store.getTask(inputTaskId)
    if (run.botId !== input.botId || run.threadId !== input.threadId)
      throw new BotError("CONFLICT", "附件输入不属于当前运行")
    const files = this.inputFilesForTask(inputTaskId)
    await verifyInputFiles(input.origin.kind === "work" ? files : files.filter(file => file.blockHash),
      this.active.get(runTaskId)!.controller.signal)
    this.workToolSource(runTaskId)
  }
  getWork(botId: string, workId: string): BotWorkItem {
    this.getBot(botId)
    const work = this.store.getWork(botId, workId)
    return { ...work, execution: this.workExecutionStatus(work) }
  }
  /** One accepted assignment, retaining the existing task's workspace and source/audience checks. */
  continueSkillWork(source: { taskId: string; callId: string; key: string }, workId: string, message: string) {
    const task = this.workToolSource(source.taskId)
    if (!selectedMainBotSkill(task)) throw new BotError("CONFLICT", "当前主对话没有通过 / 选择技能")
    const receipt = this.store.continueSkillWork(source, workId, message)
    this.changed()
    this.steerUserMessage(receipt.task)
    this.wake()
    return receipt
  }
  async continueSkillWorkWithFiles(source: { taskId: string; callId: string; key: string }, workId: string,
    message: string, inputFileIds: readonly string[]) {
    const task = this.workToolSource(source.taskId)
    if (!selectedMainBotSkill(task)) throw new BotError("CONFLICT", "当前主对话没有通过 / 选择技能")
    return this.withVerifiedWorkInputs(source, workId, inputFileIds,
      () => this.store.skillRouteReceipt(source, workId, message, inputFileIds),
      pins => this.store.continueSkillWork(source, workId, message, inputFileIds, pins),
      receipt => this.publishWorkSend(receipt.task))
  }
  /** Available only while remove() owns the deleting fence; never exposed through renderer reads. */
  getWorkForDeletion(botId: string, workId: string) {
    this.requireRunning()
    if (!this.deletions.has(botId) || !this.store.getBot(botId).deleting)
      throw new BotError("CONFLICT", "任务解绑仅可由正在进行的 Bot 删除协调执行。")
    return this.store.getWork(botId, workId)
  }
  workDeletionRecord(botId: string, workId: string) {
    this.requireRunning()
    return this.store.workDeletionRecord(botId, workId)
  }
  assertWorkNotDeleting(work: Pick<BotWorkItem, "botId" | "id">): void {
    this.store.assertWorkNotDeleting(work)
  }
  hasPendingWorkDeletionResults(workId: string): boolean {
    this.requireRunning()
    return this.store.pendingWorkDeletionResults(workId).length > 0
  }
  removeWork(
    target: BotWorkDeletionIdentity,
    cleanup: (readWork: () => BotWorkItem, ready: () => void) => Promise<string | undefined>,
    assertLive: () => void,
    source?: BotConversationToolSource
  ): Promise<BotWorkDeletionReceipt> {
    this.requireRunning()
    const assertSource = () => {
      assertLive()
      if (source) {
        const task = this.ordinaryThreadSource(source.taskId)
        const bot = this.getBot(task.botId)
        if (task.botId !== target.botId || task.threadId !== bot.threadId || bot.archived)
          throw new BotError("CONFLICT", "只能在桌面主对话中删除当前 Bot 的工作。")
      }
    }
    assertSource()
    const { botId, workId, threadId } = target
    if (this.workDeletions.has(workId))
      throw new BotError("CONFLICT", "原工作正在删除，请等待清理结果。")
    let record = this.store.beginWorkDeletion(target, source)
    if (record.phase === "deleted")
      return Promise.resolve({ botId, workId, state: "deleted",
        ...(record.incarnation ? { deletedThreadId: threadId } : {}) })
    const stopped = record.phase === "stopping" ? this.stopWorkForDeletion(botId, workId, threadId) : Promise.resolve()
    const readWork = () => {
      this.requireRunning()
      assertSource()
      if (this.workDeletions.get(workId) !== deletion ||
          this.store.workDeletionRecord(botId, workId)?.phase !== record.phase)
        throw new BotError("CONFLICT", "工作删除授权已结束。")
      return this.store.getWork(botId, workId)
    }
    const ready = () => {
      readWork()
      if (record.phase === "stopping")
        record = this.store.advanceWorkDeletion(record, "ready")
    }
    const deletion = stopped.then(async (): Promise<BotWorkDeletionReceipt> => {
      readWork()
      if (record.phase === "stopping" && this.runtime.removeWorkBrowser) {
        try {
          await this.runtime.removeWorkBrowser(botWorkBrowserScope(workId, botId))
        } catch (error) {
          this.reportError(error)
          throw new BotError("CONFLICT", "原任务的浏览器页面未能关闭，请重试删除。")
        }
        readWork()
      }
      const deletedThreadId = await cleanup(readWork, ready)
      try {
        this.store.advanceWorkDeletion(record, "deleted")
      } catch (error) {
        if (!deletedThreadId) throw error
        this.reportError(error)
        return { botId, workId, deletedThreadId, state: "cleanup_pending", error: "原会话已删除，工作清理回执尚未写入。" }
      }
      this.changed()
      return { botId, workId, state: "deleted", ...(deletedThreadId ? { deletedThreadId } : {}) }
    }).finally(() => this.workDeletions.delete(workId))
    this.workDeletions.set(workId, deletion)
    this.changed()
    this.wake()
    return deletion
  }

  private async stopWorkForDeletion(botId: string, workId: string, threadId: string): Promise<void> {
    const reports = this.store.pendingWorkDeletionResults(workId)
    for (const task of reports) this.cancelSingleTask(task.id, false)
    const { taskIds, cleanup } = this.stopConversationRuns(botId, undefined, workId)
    cleanup.push(this.recovery)
    for (const task of reports) taskIds.add(task.id)
    for (const run of this.active.values()) {
      if (run.task.threadId === threadId || taskIds.has(run.task.id) ||
          [...run.steered].some(id => taskIds.has(id))) cleanup.push(run.done)
    }
    for (const [id, run] of this.commandCancellations) {
      if (run.threadId === threadId || taskIds.has(id)) cleanup.push(run.done)
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(cleanup),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new BotError("CONFLICT", "原任务仍在清理，请等待实际退出后重试删除。")), 10_000)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
    if (this.store.pendingWorkDeletionResults(workId).length ||
        await this.runtime.hasPendingWork?.([threadId]))
      throw new BotError("CONFLICT", "原任务仍有待处理的后台工作，请核对后重试删除。")
    this.store.conversations.assertIdle(botId, workId)
  }
  markWorksRead(botId: string, throughVersion: number) {
    this.requireRunning()
    this.store.markWorksRead(botId, throughVersion)
    this.changed()
  }
  workSummaries(botId: string, workIds: string[], allowMissing?: true) {
    this.getBot(botId)
    return this.store.workSummaries(botId, workIds, allowMissing).map(work => ({ ...work, execution: this.workExecutionStatus(work) }))
  }
  /** Only live requests from the work itself or its exact local return chain. */
  private workInteraction(bot: BotDefinition, taskId: string) {
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted || bot.archived || !botTaskWorkFamily(run.task)) return
    const task = this.store.getTask(taskId)
    if (task.state !== "waiting_user" || task.mockSource || botTaskGroupId(task)) return
    let root = task
    if (!task.workId) {
      if (task.origin.kind !== "bot") return
      // A downstream receipt can resume the intermediate peer's original handoff.
      // Use that handoff only for routing, and the current physical run for the request.
      const handoff = task.origin.expectsReply ? task : this.store.peerHandoffSource(task)
      if (!handoff || handoff.threadId !== task.threadId || handoff.mockSource) return
      const origin = handoff.origin
      if (origin.kind !== "bot" || !origin.rootWorkId ||
          origin.feedbackForTaskId || this.store.taskRootCancelled(handoff)) return
      root = this.store.getTask(origin.rootTaskId)
      if (root.workId !== origin.rootWorkId || root.mockSource || botTaskGroupId(root)) return
      const parent = origin.upstreamTaskId ? this.store.getTask(origin.upstreamTaskId) : root
      if (parent.botId !== origin.fromBotId || parent.mockSource || botTaskGroupId(parent) ||
          botTaskWorkFamily(parent) !== root.workId || origin.returnWorkId !== parent.workId) return
    }
    if (root.botId !== bot.id || !root.workId) return
    const work = this.store.conversations.forThread(root.threadId)
    if (!work || work.id !== root.workId || work.botId !== bot.id || work.parentThreadId !== bot.threadId ||
        work.audienceKey !== "desktop" || work.source || work.state !== "active" || work.deletionPending ||
        (work.conversation && work.conversation.state !== "bound")) return
    const asker = this.store.getBot(task.botId)
    if (asker.archived || asker.deleting) return
    return {
      task, run, asker,
      source: {
        taskId: task.id, workId: work.id, workTitle: work.title, askedBy: asker.name,
        ...(work.workspace?.kind === "project" ? { projectName: work.workspace.projectName } : {})
      }
    }
  }
  pendingWorkQuestions(botId: string): BotWorkInteraction[] {
    const bot = this.getBot(botId)
    const interactions: BotWorkInteraction[] = []
    for (const taskId of this.active.keys()) {
      const context = this.workInteraction(bot, taskId)
      if (!context) continue
      const { task, run, asker, source } = context
      const request = this.runtime.pendingUserInput?.(task)
      if (request?.threadId === task.threadId) interactions.push({ ...source, kind: "question", request })
      if (interactions.length === 12) break
      const requestIds = run.lease.approvalRequestIds
      const requestId = requestIds?.size ? this.runtime.pendingApproval?.(task, requestIds) : undefined
      if (requestId && (task.workId || task.threadId === asker.threadId)) {
        interactions.push({
          ...source, kind: "approval", requestId,
          target: { botId: asker.id, threadId: task.threadId, ...(task.workId ? { workId: task.workId } : {}) }
        })
      }
      if (interactions.length === 12) break
    }
    return interactions
  }
  answerWorkQuestion(botId: string, taskId: string, response: UserInputResponse): void {
    const context = this.workInteraction(this.getBot(botId), taskId)
    const request = context && this.runtime.pendingUserInput?.(context.task)
    if (!request || request.threadId !== context?.task.threadId || request.requestId !== response.requestId ||
        !this.runtime.answerUserInput?.(response))
      throw new BotError("CONFLICT", "问题已处理或已失效，请核对原任务。")
  }
  listWorks(botId: string, cursor?: string, query?: string) {
    this.getBot(botId)
    return this.withWorkExecution(this.store.listWorks(botId, cursor, query, "desktop"))
  }
  workTargets(taskId: string, cursor?: string, query?: string) {
    const task = this.workToolSource(taskId)
    const page = this.store.listWorks(
      task.botId,
      cursor,
      query,
      task.mockSource?.audienceKey ?? "desktop",
      "model"
    )
    return this.withWorkExecution(page)
  }
  private withWorkExecution(page: import("../../shared/bots/work").BotWorkPage) {
    const snapshots = new Map<string, ReturnType<LocalBotHost["workExecutionStatus"]>>()
    const enrich = (work: BotWorkSummary) => {
      let execution = snapshots.get(work.id)
      if (!execution) {
        execution = this.workExecutionStatus(work)
        snapshots.set(work.id, execution)
      }
      return { ...work, execution }
    }
    return { ...page, items: page.items.map(enrich), priority: page.priority.map(enrich) }
  }
  private workExecutionStatus(work: BotWorkSummary) {
    const runs = [...this.active.values()].filter(run => run.task.threadId === work.threadId && !run.controller.signal.aborted)
    let runtime: BotWorkRuntimeState | undefined
    try { runtime = this.runtime.workRuntimeStatus?.(work) } catch { /* Unknown is not idle. */ }
    return projectBotWorkStatus(work, runtime, runs.length > 0, runs.find(run => run.browserHelp)?.browserHelp?.instruction)
  }
  private workStatusForModel(work: BotWorkSummary) {
    return {
      version: work.version,
      ...(work.dispatchStopped ? { dispatchStopped: true } : {}),
      execution: this.workExecutionStatus(work)
    }
  }
  featureTasks(scope: FeatureScope, options?: FeatureTaskQuery) {
    return this.featureStore.taskRows(scope, options).map((row) => {
      const { ordinal, attentionThreadId, ...rest } = row
      const live = this.featureTurns.activity(row.id)
      const phase =
        live &&
        row.state === "active" &&
        row.phase !== "decision" &&
        (live.phase !== "running" || row.phase !== "managed")
          ? live.phase
          : row.phase
      const target =
        phase === "decision"
          ? attentionThreadId
          : phase === "question" || phase === "approval"
            ? live?.threadId
            : undefined
      const task: BotFeatureTask = {
        ...rest,
        kind: "feature",
        phase,
        ...(target ? { attentionThreadId: target } : {})
      }
      return { task, ordinal }
    })
  }
  featureTaskPage(scope: FeatureScope, input: import("../../shared/bots/feature").BotFeaturePageInput = {}) {
    const query = input.query ?? ""
    const ids = input.refreshIds ?? []
    if (typeof query !== "string" || query.length > 200 || !Array.isArray(ids) || ids.length > 40 ||
      ids.some(id => typeof id !== "string" || id.length > 160) || new Set(ids).size !== ids.length)
      throw new BotError("INVALID_INPUT", "Feature 查询无效")
    let before = Number.MAX_SAFE_INTEGER
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== "string" || input.cursor.length > 2048) throw new Error()
        const [botId, audience, search, ordinal] = JSON.parse(Buffer.from(input.cursor, "base64url").toString())
        if (botId !== scope.botId || audience !== scope.audience || search !== query || !Number.isSafeInteger(ordinal) || ordinal <= 0) throw new Error()
        before = ordinal
      } catch { throw new BotError("INVALID_INPUT", "Feature 游标无效") }
    }
    const rows = this.featureTasks(scope, { query, before, limit: 41 })
    return {
      items: rows.slice(0, 40).map(row => row.task),
      priority: this.featureTasks(scope, { query, attentionOnly: true, liveIds: this.featureTurns.activeFollowIds(), limit: 6 }).map(row => row.task),
      refreshed: ids.length ? this.featureTasks(scope, { followIds: ids, limit: 40 }).map(row => row.task) : [],
      nextCursor: rows.length > 40 ? Buffer.from(JSON.stringify([scope.botId, scope.audience, query, rows[39].ordinal])).toString("base64url") : null
    }
  }
  taskDirectory(taskId: string, cursor?: string, query = "") {
    const source = this.workToolSource(taskId)
    if (source.workId || (source.mockSource && source.mockSource.transport !== "im"))
      return this.workTargets(taskId, cursor, query)
    const scope = { botId: source.botId, audience: source.mockSource?.audienceKey ?? "desktop" }
    const key = createHash("sha256")
      .update(JSON.stringify([scope, query]))
      .digest("hex")
      .slice(0, 24)
    let before: number | undefined,
      workCursor = cursor
    if (cursor?.startsWith("tasks:")) {
      const parts = /^tasks:([a-f0-9]{24}):(\d+):(.*)$/u.exec(cursor)
      if (!parts || parts[1] !== key || !Number.isSafeInteger(Number(parts[2])))
        throw new BotError("INVALID_INPUT", "任务列表游标已失效")
      before = Number(parts[2])
      workCursor = parts[3] || undefined
    }
    const works =
      cursor?.startsWith("tasks:") && !workCursor
        ? { items: [], priority: [], nextCursor: null }
        : this.workTargets(taskId, workCursor, query)
    const rows =
      before === 0 ? [] : this.featureTasks(scope, { query: query.trim(), before, limit: 21 })
    const features = rows.slice(0, 20).map((r) => r.task)
    const next = rows.length > 20 ? rows[19].ordinal : 0
    const ordinary = works.items.map((w) => ({ ...w, kind: "conversation" as const }))
    return {
      items: [...ordinary, ...features].sort((a, b) => b.updatedAt - a.updatedAt),
      priority: [...works.priority, ...features.filter((f) => f.attentionThreadId)],
      nextCursor: next || works.nextCursor ? `tasks:${key}:${next}:${works.nextCursor ?? ""}` : null
    }
  }
  changeFeatureState(
    scope: FeatureScope,
    id: string,
    action: "complete" | "reopen",
    version: number
  ) {
    const owner = this.featureStore.owner(id, scope)
    const bot = this.getBot(scope.botId)
    if (
      bot.archived ||
      bot.deleting ||
      (scope.audience !== "desktop" &&
        this.imGateway.binding(scope.audience.slice(3))?.binding.state !== "active")
    )
      throw new BotError("CONFLICT", "Bot 或群绑定当前不可用")
    if (action === "complete" && this.featureTurns.activity(owner.id))
      throw new BotError("CONFLICT", "任务仍在执行")
    this.featureStore.lifecycle(owner, action, version)
    this.featureChanged(scope)
  }
  /** A bounded, same-audience snapshot for each main Bot turn, including automatic reports. */
  workStatusContext(taskId: string) {
    const task = this.workToolSource(taskId)
    const page = this.store.listWorks(
      task.botId,
      undefined,
      "",
      task.mockSource?.audienceKey ?? "desktop",
      8
    )
    const works = new Map<string, BotWorkSummary>()
    if (task.origin.kind === "work_result") {
      const work = this.historyTarget(taskId, task.origin.workId)
      works.set(work.id, work)
    }
    for (const work of [...page.priority, ...page.items]) works.set(work.id, work)
    const projects =
      !task.workId && (!task.mockSource || task.mockSource.transport === "im")
        ? this.featureTasks(
            { botId: task.botId, audience: task.mockSource?.audienceKey ?? "desktop" },
            { limit: 5 }
          )
        : []
    return {
      items: [...works.values()].slice(0, 8).map((work) => ({
        workId: work.id,
        title: work.title,
        ...this.workStatusForModel(work)
      })),
      ...(projects.length
        ? {
            projectTasks: projects.slice(0, 4).map(({ task: f }) => ({
              followId: f.id,
              title: f.title,
              phase: f.phase,
              state: f.state,
              attentionThreadId: f.attentionThreadId
            }))
          }
        : {}),
      hasMore: works.size > 8 || page.nextCursor !== null || projects.length > 4
    }
  }
  projectWorkForModel<T extends Pick<BotWorkItem, "id" | "botId" | "title"> & Partial<Pick<BotWorkItem, "goal" | "activity">>>(work: T): T {
    return this.store.projectWorkForModel(work)
  }
  private ordinaryThreadSource(taskId: string) {
    const task = this.workToolSource(taskId)
    if (task.workId || task.mockSource || !this.store.hasWorkUserRequest(taskId))
      throw new BotError("CONFLICT", "只能在桌面主对话中按当前用户要求访问普通会话")
    return task
  }
  desktopOperationReceipts(taskId: string, query: BotDesktopOperationQuery) {
    this.ordinaryThreadSource(taskId)
    return this.store.desktopOperationReceipts(taskId, query)
  }
  async ordinaryThreads(taskId: string, input: BotThreadListInput) {
    this.ordinaryThreadSource(taskId)
    if (!this.runtime.ordinaryThreads) throw new BotError("CONFLICT", "当前主机不支持普通会话查询")
    const page = await this.runtime.ordinaryThreads.list(input)
    this.ordinaryThreadSource(taskId)
    return page
  }
  async ordinaryThreadHistory(taskId: string, input: BotThreadReadInput) {
    this.ordinaryThreadSource(taskId)
    if (!this.runtime.ordinaryThreads) throw new BotError("CONFLICT", "当前主机不支持普通会话查询")
    const page = await this.runtime.ordinaryThreads.read(input)
    this.ordinaryThreadSource(taskId)
    return page
  }
  async renameOrdinaryThreadFromTool(source: { taskId: string; callId: string; key: string }, input: BotThreadRenameInput) {
    this.ordinaryThreadSource(source.taskId)
    if (!this.runtime.ordinaryThreads?.rename) throw new BotError("CONFLICT", "当前主机不支持修改普通会话名称")
    return this.runtime.ordinaryThreads.rename(input, apply => {
      this.ordinaryThreadSource(source.taskId)
      return this.store.renameOrdinaryThread(source, input, apply)
    })
  }
  private conversationToolAuthority(source: BotConversationToolSource, signal: AbortSignal) {
    const validate = () => {
      signal.throwIfAborted()
      const task = this.ordinaryThreadSource(source.taskId)
      const bot = this.getBot(task.botId)
      if (bot.archived || task.threadId !== bot.threadId || !source.callId || !source.key.trim() || source.key.length > 160)
        throw new BotError("CONFLICT", "只能从桌面主对话的当前用户要求管理会话")
      return bot.id
    }
    const botId = validate()
    return { botId, validate }
  }
  async linkOrdinaryThreadFromTool(source: BotConversationToolSource, input: BotThreadLinkInput, signal: AbortSignal) {
    const { botId, validate } = this.conversationToolAuthority(source, signal)
    if (!this.runtime.conversationTools) throw new BotError("CONFLICT", "当前主机不支持关联普通会话")
    return this.runtime.conversationTools.link(botId, input, source, signal, validate)
  }
  async unlinkWorkFromTool(source: BotConversationToolSource, input: BotWorkUnlinkInput, signal: AbortSignal) {
    const { botId, validate } = this.conversationToolAuthority(source, signal)
    if (!this.runtime.conversationTools) throw new BotError("CONFLICT", "当前主机不支持解除会话关联")
    return this.runtime.conversationTools.unlink(botId, input, source, signal, validate)
  }
  async deleteOrdinaryThreadFromTool(source: BotConversationToolSource, input: import("../../shared/bots/thread-history").BotThreadDeleteInput, signal: AbortSignal) {
    const { botId, validate } = this.conversationToolAuthority(source, signal)
    if (!this.runtime.conversationTools?.deleteThread) throw new BotError("CONFLICT", "当前主机不支持删除普通会话")
    return this.runtime.conversationTools.deleteThread(botId, input, source, signal, validate)
  }
  async deleteWorkFromTool(source: BotConversationToolSource, input: BotWorkUnlinkInput, signal: AbortSignal) {
    const { botId, validate } = this.conversationToolAuthority(source, signal)
    if (!this.runtime.conversationTools?.deleteWork) throw new BotError("CONFLICT", "当前主机不支持删除工作")
    return this.runtime.conversationTools.deleteWork(botId, input, source, signal, validate)
  }
  ordinaryThreadInputProjections(threadId: string, ids: readonly string[], row: ThreadIncarnationRow) {
    return botHistoryInputProjection(threadId, row)?.(ids) ?? new Map()
  }
  workOwnerCandidates(threadIds: readonly string[]) {
    this.requireRunning()
    return this.store.workOwnerCandidates(threadIds)
  }
  async resolveOrdinaryThreadSource(botId: string, source: BotThreadHistorySource) {
    this.getBot(botId)
    if (!this.runtime.ordinaryThreads) throw new BotError("CONFLICT", "当前主机不支持普通会话查询")
    const ref = localWorkConversationRef(source.conversation)
    const owner = this.conversationLinks.forThread(ref.threadId)
    // A link issued before association still names the same original message.
    // Only navigation reuses work history; ordinary model tools stay restricted.
    if (owner && !owner.source && owner.audienceKey === "desktop" &&
        owner.conversation?.state === "bound" && owner.conversation.origin === "existing") {
      return this.resolveWorkHistorySource(owner.botId, {
        workId: owner.id,
        messageId: source.messageId,
        incarnation: createHash("sha256").update(JSON.stringify(ref.incarnation)).digest("hex")
      })
    }
    const result = await this.runtime.ordinaryThreads.resolve(source)
    this.getBot(botId)
    return result
  }
  associatedWorks(botId: string, view: "display" | "model" = "display") {
    this.getBot(botId)
    return this.store.associatedWorks(botId, view)
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
    // History hydration is async: sample status afterwards, after rechecking audience authority.
    const current = this.historyTarget(taskId, input.workId)
    return { ...result, delegations: this.store.workDelegations(work.botId, work.id), work: { ...result.work, ...this.workStatusForModel(current) } }
  }
  workExchange(taskId: string, workId: string, delegationTaskId: string) {
    const work = this.historyTarget(taskId, workId)
    const exchange = this.store.exchange(work.botId, delegationTaskId, undefined, work.id)
    return {
      taskId: exchange.taskId, recipient: exchange.recipient.name,
      turnState: exchange.state,
      reply: exchange.reply ? { ...exchange.reply,
        message: exchange.reply.message.slice(0, 30_000),
        truncated: exchange.reply.message.length > 30_000 } : null
    }
  }
  workHistoryCommands(botId: string, workId: string, incarnation: string) {
    this.getWork(botId, workId)
    return this.store.workHistoryCommands(botId, workId, incarnation)
  }
  async resolveWorkHistorySource(botId: string, source: BotWorkHistorySource) {
    if (!this.runtime.workHistory) throw new BotError("CONFLICT", "此主机暂不支持历史定位")
    this.requireRunning()
    if (this.store.archivedDeliveryWork(botId, source.workId)) {
      const { resolveDetachedBotWorkHistory } = await import("./work-history")
      this.requireRunning()
      const archived = this.store.archivedDeliveryWork(botId, source.workId)
      if (!archived) throw new BotError("CONFLICT", "原交付附件已不可用，请查看原任务。")
      return resolveDetachedBotWorkHistory(archived, source, this)
    }
    const work = this.getWork(botId, source.workId)
    this.assertWorkNotDeleting(work)
    if (work.source && work.source.transport !== "im")
      throw new BotError("CONFLICT", "不是本机或 IM 任务")
    const result = await this.runtime.workHistory.resolve(work, source)
    this.assertWorkNotDeleting(this.getWork(botId, source.workId))
    return result
  }
  get featureStore() {
    return this.store.features
  }
  reconcileProjectFeatures(projectId: string, retained: ReadonlySet<string>) {
    for (const owner of this.featureStore.removeMissingFeatures(projectId, retained)) {
      this.featureTurns.cancelFollow(owner.id)
      this.featureChanged(owner, owner)
    }
  }
  featureScope(botId: string, groupId?: string) {
    this.getBot(botId)
    if (groupId) {
      const route = this.imGateway.binding(groupId)
      if (route?.binding.kind !== "group" || route.binding.botId !== botId)
        throw new BotError("NOT_FOUND", "此招乎群不属于当前 Bot")
    }
    return { botId, audience: groupId ? `im:${groupId}` : "desktop" }
  }
  featureTask(taskId: string) {
    return this.store.getTask(taskId)
  }
  featureToolTask(taskId: string) {
    const task = this.workToolSource(taskId)
    if (
      task.workId ||
      (task.mockSource && task.mockSource.transport !== "im") ||
      !this.store.hasWorkUserRequest(taskId)
    )
      throw new BotError("CONFLICT", "请从 Bot 主对话或已绑定的招乎群交办项目工作")
    return task
  }
  featureChanged(scope: FeatureScope & { id?: string; projectId?: string; slug?: string }, followed?: { id?: string; projectId: string; slug: string }) {
    if (!followed && scope.projectId && scope.slug) followed = { id: scope.id, projectId: scope.projectId, slug: scope.slug }
    if (!this.stopping)
      this.changed({
        featureScope: {
          botId: scope.botId,
          audience: scope.audience,
          ...(followed ? { projectId: followed.projectId, slug: followed.slug, ...(followed.id ? { followId: followed.id } : {}) } : {})
        }
      })
  }
  desktopDeliveryWorks(threadId: string) {
    return this.store.desktopDeliveryWorks(threadId)
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
    return this.updateImState(
      () => this.store.imGateway.register(realm, principal, binding),
      binding.kind === "group" ? { featureTargetsChanged: true } : undefined
    )
  }
  /** Authenticated binding revocation; never stop a whole shared personal thread. */
  revokeImBinding(botId: string, id: string, version: number): void {
    this.requireRunning()
    const current = this.store.im.get(botId, id)
    if (!current.revoked) this.store.im.revoke(botId, id, version)
    this.featureTurns.cancel(botId, id)
    const execution = this.store.suppressRevokedImExecution(botId, id)
    this.cancelWorkflows(execution.workflows)
    for (const task of execution.tasks) this.cancel(task.id, false)
    if (execution.commandIds.length)
      void Promise.resolve(this.runtime.cancelBackgroundCommands?.(execution.commandIds)).catch(
        this.reportError
      )
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
  private updateImState<T>(update: () => T, detail?: BotChangeDetail): T {
    const revision = this.store.revision()
    const result = update()
    if (revision !== this.store.revision()) this.changed(detail)
    return result
  }
  publishImFiles(taskId: string, callId: string, files: import("../../shared/bots/file-delivery").BotDeliveredFile[]): void {
    this.requireRunning()
    const task = this.store.getTask(taskId)
    if (task.state !== "running") throw new BotError("CONFLICT", "执行已结束，不能继续交付附件")
    if (task.workId && this.store.workResultReviewActiveForExecution(task.id)) return
    this.updateImState(() => this.store.im.publishFiles(task, callId, files))
  }
  browserHelpNotice(taskId: string, help: import("./browser").BotBrowserHelp, active: boolean): void {
    const run = this.active.get(taskId)
    if (run && !run.controller.signal.aborted) {
      if (active) run.browserHelp = help
      else if (run.browserHelp?.generation === help.generation) run.browserHelp = undefined
    }
    const task = this.store.getTask(taskId)
    const workId = botTaskWorkFamily(task)
    if (workId) this.store.workInvalidations.mark(workId)
    this.updateImState(() => this.store.im.browserHelpNotice(task, help, active))
    // Local browser help can change without an IM outbox write.
    if (workId) this.changed()
  }
  imFileStatuses(botId: string, threadId: string, callId: string) {
    return this.store.im.fileStatuses(botId, threadId, callId)
  }
  retryImFile(botId: string, id: string): void {
    this.requireRunning()
    this.updateImState(() => this.store.im.retryFile(botId, id))
  }
  updateImFileReceiptVersion(id: string, version: number): void {
    this.store.im.receiptVersion(id, version)
  }
  updateImFileProgress(id: string, percent: number): void {
    this.updateImState(() => this.store.im.progress(id, percent))
  }
  settleImFileReceipt(id: string, state: "sent" | "failed" | "unknown", reason?: string, version?: number): void {
    this.updateImState(() => this.store.im.receipt(id, state, reason, version))
  }
  beginImDelivery(lane?: "text" | "file") {
    return this.updateImState(() => this.store.im.beginDelivery(lane))
  }
  setImOffline(): void {
    this.updateImState(() => this.store.im.setAllOffline())
  }
  mayDeliverImReply(id: string) {
    return this.updateImState(() => this.store.im.mayDeliver(id))
  }
  settleImDelivery(id: string, state: Parameters<BotStore["im"]["delivered"]>[1], reason?: string): void {
    this.updateImState(() => this.store.im.delivered(id, state, reason))
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
  workInputContext(taskId: string, messageIndex = 0, offset = 0, assignmentId?: string) {
    this.requireRunning()
    return this.store.workInputContext(taskId, messageIndex, offset, assignmentId)
  }

  async validateSkillWorkspace(botId: string, target: BotSkillWorkspaceTarget): Promise<void> {
    if (this.getBot(botId).archived) throw new BotError("CONFLICT", "请先恢复已归档的 Bot")
    if (target.kind === "work") {
      const work = this.getWork(botId, target.workId)
      this.store.assertWorkNotDeleting(work)
      if (work.threadId !== target.threadId || work.source || work.audienceKey !== "desktop" ||
          work.state !== "active" || work.userControl?.settling ||
          (work.conversation && work.conversation.state !== "bound"))
        throw new BotError("CONFLICT", "所选任务暂时无法接收消息，请选择其他位置。")
      const path = work.conversation
        ? (await import("./work-result-thread")).verifiedWorkResultThread(work).workspacePath
        : work.workspace?.path
      // Legacy native work with no pinned workspace provisions the Bot default on dispatch.
      if (path) await validateWorkspaceDirectory(path)
      return
    }
    if (!this.runtime.workspaces) throw new BotError("CONFLICT", "当前主机不支持选择任务工作目录")
    await this.runtime.workspaces.resolve(botId, target)
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
    const groupDefault = !input.workspace &&
      (input.imConversationId || (task?.mockSource && !task.mockSource.personal))
    const workspace = groupDefault
      ? undefined
      : await this.runtime.workspaces?.resolve(input.botId, input.workspace)
    this.requireRunning()
    if (source) this.workToolSource(source.taskId)
    if (source && input.inputFileIds?.length) {
      await verifyInputFiles(this.store.workInputFiles(source.taskId, input.inputFileIds), this.active.get(source.taskId)!.controller.signal)
      this.workToolSource(source.taskId)
    }
    if (!source && input.explicitSkill && input.inputFileIds?.length) {
      await verifyInputFiles(this.store.desktopInputFiles(input.botId, input.inputFileIds), AbortSignal.timeout(30_000))
      this.requireRunning()
    }
    if (!source && input.explicitSkill && this.runtime.validateSkillSelection) {
      await this.runtime.validateSkillSelection(input.explicitSkill)
      this.requireRunning()
    }
    const receipt = this.store.createWork(input, source, workspace)
    this.changed()
    this.wake()
    return receipt
  }
  async workProjects(taskId: string, query?: string, cursor?: number) {
    const validate = () => {
      const task = this.workToolSource(taskId)
      if (
        (task.mockSource && task.mockSource.transport !== "im") ||
        task.workId ||
        !this.store.hasWorkUserRequest(task.id)
      )
        throw new BotError("CONFLICT", "只能在本机主对话的当前用户交办中查找项目")
      if (task.mockSource && !query?.trim())
        throw new BotError("CONFLICT", "请在桌面主对话中浏览全部项目；IM 仍可按项目名称查询")
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
  changeWorkControl(input: BotWorkControlInput): BotWorkItem {
    this.requireRunning()
    this.store.changeWorkControl(input)
    this.applyWorkControlStops()
    this.finishWorkControlHandoffs()
    this.changed()
    // Reconsider the existing inbox on return; no new task or request is created.
    if (input.action === "return") {
      const work = this.store.getWork(input.botId, input.workId)
      for (const run of this.active.values())
        if (run.task.threadId === work.threadId) this.onSteeringReady(run.task.id)
    }
    this.wake()
    return this.store.getWork(input.botId, input.workId)
  }
  workControlPending(botId: string, workId: string, taskId?: string) {
    this.requireRunning()
    return this.store.workControlPending(botId, workId, taskId)
  }
  retainReadyWorkService(taskId: string, serviceId: string, checkId: string, reason: string) {
    this.workToolSource(taskId)
    const receipt = this.store.retainReadyWorkService(taskId, serviceId, checkId, reason)
    this.changed()
    this.wake()
    return receipt
  }
  private readonly appliedWorkControlStops = new Set<string>()
  private applyWorkControlStops(): void {
    if (!this.recoveryReady) return
    const stops = this.store.workControlStops()
    const pending = new Set(stops.map(stop => stop.operationId))
    for (const id of this.appliedWorkControlStops)
      if (!pending.has(id)) this.appliedWorkControlStops.delete(id)
    for (const stop of stops) {
      if (this.appliedWorkControlStops.has(stop.operationId)) continue
      for (const id of stop.taskIds) this.cancel(id, false)
      this.appliedWorkControlStops.add(stop.operationId)
    }
  }
  private finishWorkControlHandoffs(): void {
    if (!this.recoveryReady) return
    this.applyWorkControlStops()
    const activeThreads = new Set([
      ...[...this.active.values()].map(run => run.task.threadId),
      ...[...this.commandCancellations.values()].map(run => run.threadId)
    ])
    if (this.store.finishWorkControlHandoffs(activeThreads)) {
      this.changed()
      this.wake()
    }
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
    this.wake()
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
    const source = taskId ? this.store.getTask(taskId) : undefined
    const groupId = source ? botTaskGroupId(source) : undefined
    const members = groupId ? this.store.getGroup(groupId).memberIds : undefined
    return this.store.listBots()
      .filter(bot => !bot.archived && !bot.deleting && (!members || members.includes(bot.id)))
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
  groupTargets(taskId: string): import("../../shared/bots/im-channel").BotGroupTarget[] {
    this.requireRunning()
    const task = this.store.getTask(taskId)
    if (
      task.workId ||
      task.mockSource ||
      botTaskGroupId(task) ||
      (!this.store.hasDirectUserRequest(taskId) && !this.store.profileContinuationRequest(taskId))
    )
      throw new BotError("CONFLICT", "请从私人主对话选择交办群聊")
    const bot = this.getBot(task.botId)
    const bots = new Map(
      this.store
        .listBots()
        .filter((item) => item.hostId === bot.hostId && !item.archived && !item.deleting)
        .map((item) => [item.id, item])
    )
    return [
      ...this.store
        .groups()
        .filter(
          (group) =>
            !group.deleting && group.hostId === bot.hostId && group.memberIds.includes(bot.id)
        )
        .map((group) => ({
          id: group.id,
          source: "app" as const,
          name: group.name,
          description: group.memberIds
            .map((id) => bots.get(id)?.name)
            .filter(Boolean)
            .join("、"),
          available: true
        })),
      ...this.store.imGateway
        .groupConversations()
        .filter((group) => group.state === "active" && bots.has(group.botId))
        .map((group) => ({
          id: group.id,
          source: "zhaohu" as const,
          name: group.title,
          description: bots.get(group.botId)!.name,
          available: group.connected
        }))
    ]
  }

  publishGroupMessage(taskId: string, callId: string, text: string, targetGroupId?: string, source: "app" | "zhaohu" = "app") {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted) throw new BotError("CONFLICT", "当前群任务已结束")
    if (source === "zhaohu") {
      if (!targetGroupId) throw new BotError("INVALID_INPUT", "请选择交办的招乎群")
      const receipt = this.store.handoffImGroup(taskId,callId,targetGroupId,text)
      this.changed()
      this.wake()
      return receipt
    }
    const receipt =
      targetGroupId === undefined
        ? this.store.publishGroupMessage(taskId, callId, text)
        : this.store.publishGroupMessage(taskId, callId, text, targetGroupId)
    this.changed()
    // A directed public review joins only an already-running assignment of the
    // same human request. The model never selects a physical task or return route.
    for (const target of this.active.values()) {
      if (target.controller.signal.aborted || target.task.id === taskId ||
          botTaskGroupId(target.task) !== receipt.groupId) continue
      const feedback = this.store.groupFeedback(taskId, receipt.messageId, target.task.id)
      if (feedback) this.steerUserMessage(feedback)
    }
    this.wake()
    return receipt
  }
  publishGroupFiles(taskId: string, callId: string, files: BotDeliveredFile[], content = "",
    handoff?: () => { files: BotDeliveredFile[]; outputBindings?: Record<string, string>; forwardedOutputs?: Record<string, string> } | undefined): boolean {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted)
      throw new BotError("CONFLICT", "任务已停止，无法继续交付附件")
    const fresh = this.store.publishGroupFiles(taskId, callId, files, content, handoff)
    if (fresh) this.changed()
    return fresh
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
    this.steerUserMessage(task)
    this.wake()
    return task
  }

  peerHandoff(task: Pick<BotTask, "id">) {
    this.requireRunning()
    return this.store.peerHandoff(task.id)
  }

  recordPeerDelivery(taskId: string, files: BotDeliveredFile[], outputBindings?: Record<string, string>, forwardedOutputs?: Record<string, string>): void {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted)
      throw new BotError("CONFLICT", "任务已停止，无法记录交付附件")
    this.store.recordPeerDelivery(taskId, files, outputBindings, forwardedOutputs)
  }

  saveSchedule(
    botId: string,
    input: BotScheduleInput,
    existing?: BotScheduleEdit,
    sourceTaskId?: string,
    desktopWork?: BotWorkScheduleCreation
  ): BotSchedule {
    this.requireRunning()
    if (existing?.tool) this.workToolSource(existing.tool.source.taskId)
    if (!this.nextSchedule) throw new BotError("CONFLICT", "此主机未启用例行任务")
    const expired = input.enabled && input.frequency === "once" && Date.parse(input.runAt ?? "") <= Date.now()
    if (expired && !desktopWork)
      throw new BotError("INVALID_INPUT", "执行时间必须在未来")
    // A replay may arrive after its one-shot deadline. Only a new record needs a future time.
    const next = input.enabled && !expired ? this.nextSchedule(input, new Date()) : null
    const schedule = this.store.saveSchedule(botId, input, next, existing, sourceTaskId, desktopWork)
    this.changed()
    this.wake()
    this.armSchedules()
    return schedule
  }

  replayDesktopScheduleEdit(botId: string, id: string, edit: BotScheduleToolEdit): BotSchedule | undefined {
    this.workToolSource(edit.source.taskId)
    return this.store.replayDesktopScheduleEdit(botId, id, edit)
  }

  desktopScheduleRequestTime(taskId: string): number {
    this.workToolSource(taskId)
    // Reuse the operation's admitted user-input binding, including a consumed steer.
    // No target exists yet for a new schedule; this binding is read only, not persisted.
    const source = this.store.desktopOperationBinding(taskId, { kind: "schedule_save", targetId: "" })
    if (!source) throw new BotError("CONFLICT", "无法确认相对时间所属的用户请求")
    return this.store.getTask(source.requestTaskId).createdAt
  }

  removeSchedule(id: string, version: number): void {
    this.requireRunning()
    this.store.removeSchedule(id, version)
    this.changed()
    this.wake()
    this.armSchedules()
  }

  saveDesktopWorkScheduleFromTool(
    botId: string,
    input: BotScheduleInput,
    workId: string,
    source: BotConversationToolSource
  ): BotSchedule {
    this.workToolSource(source.taskId)
    return this.saveSchedule(botId, input, undefined, undefined, { workId, source })
  }

  saveDesktopScheduleFollowUp(
    botId: string,
    input: BotScheduleInput,
    followUp: BotWorkScheduleMonitorInput | BotFixedReminderInput,
    source: BotConversationToolSource,
    existing?: BotScheduleEdit
  ): BotSchedule {
    this.workToolSource(source.taskId)
    if (!this.nextSchedule || !this.runtime.scheduleObservationPublication)
      throw new BotError("CONFLICT", "此主机未启用工作观察或固定提醒")
    const now = new Date()
    const next = input.enabled && (input.frequency !== "once" || Date.parse(input.runAt ?? "") > now.getTime())
      ? this.nextSchedule(input, now)
      : null
    const schedule = this.store.saveSchedule(botId, input, next, existing, undefined, undefined, { input: followUp, source })
    this.changed()
    this.wake()
    this.armSchedules()
    return schedule
  }

  /** Called on OS resume as well as the single deadline timer. Missed intervals coalesce. */
  resume(): void {
    for (const [id, retry] of this.schedulePublicationRetries) {
      if (retry.at === undefined) this.schedulePublicationRetries.delete(id)
    }
    this.resumeSchedules()
  }

  private resumeSchedules(): void {
    if (this.stopping || this.faulted) return
    if (this.nextSchedule) {
      const now = Date.now()
      for (const schedule of this.store.schedules()) {
        const expiresAt = schedule.workMonitor?.expiresAt ?? schedule.fixedReminder?.expiresAt
        const expired = expiresAt !== undefined && Date.parse(expiresAt) <= now
        if (!schedule.enabled || !schedule.nextRunAt || (!expired && Date.parse(schedule.nextRunAt) > now))
          continue
        try {
          const next =
            expired || schedule.frequency === "once" ? null : this.nextSchedule(schedule, new Date(now + 1))
          this.store.fireSchedule(schedule, next, Boolean(this.runtime.scheduleObservationPublication))
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
    if (this.stopping || this.faulted) return
    const due = this.nextSchedule ? this.store
      .schedules()
      .filter((item) => item.enabled && item.nextRunAt)
      .map((item) => {
        const expiresAt = item.workMonitor?.expiresAt ?? item.fixedReminder?.expiresAt
        return Math.min(Date.parse(item.nextRunAt!), expiresAt ? Date.parse(expiresAt) : Infinity)
      })
      .filter(Number.isFinite) : []
    if (this.schedulePublicationRetryAt !== undefined) due.push(this.schedulePublicationRetryAt)
    if (!due.length) return
    // A rejected queue insertion backs off; no hot retry loop at an expired deadline.
    const delay = Math.max(1000, Math.min(86_400_000, Math.min(...due) - Date.now()))
    this.scheduleTimer = setTimeout(() => this.resumeSchedules(), delay)
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
    if (
      input.archived &&
      !this.store.getBot(input.id).archived &&
      this.runtime.hasPendingCoordinator
    ) {
      if (!this.recoveryReady) throw new BotError("CONFLICT", "后台状态正在恢复，请稍后再归档。")
      if (this.runtime.hasPendingCoordinator(this.store.notificationThreadIds(input.id)))
        throw new BotError("CONFLICT", "请先处理此 Bot 的后台执行和待通知结果，再归档。")
    }
    const bot = this.store.update(input)
    if (bot.archived) this.featureTurns.cancel(bot.id)
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
    this.featureTurns.cancel(id)
    this.changed()
    this.wake()
    this.armSchedules()
    const deletion = Promise.resolve()
      .then(() => cleanup(threads))
      .then(async () => {
        // Whole-Bot deletion skips missing native threads and preserves user
        // conversations. Only those uninitialized native works need this sweep.
        for (const work of this.store.uninitializedDesktopWorks(id)) {
          await withThreadRunMutationLock(work.threadId, () => removeUninitializedWorkInputPins(work))
        }
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
      this.changed({ reactionTarget: canonicalTarget })
      if (present && (canonicalTarget.kind !== "bot" || !canonicalTarget.workId)) this.wake()
    }
    return result
  }

  setBotMessageReaction(taskId: string, emoji: string, present: boolean) {
    this.workToolSource(taskId)
    const before = this.store.revision()
    const result = this.store.setBotMessageReaction(taskId, emoji, present)
    if (result.revision !== before)
      this.changed({ reactionTarget: { kind: "bot", botId: this.store.getTask(taskId).botId } })
    return result
  }

  removeMessageReactionsForThreads(threadIds: readonly string[]): void {
    this.requireRunning()
    const before = this.store.revision()
    this.store.removeMessageReactionsForThreads(threadIds)
    if (this.store.revision() !== before) this.changed()
  }

  retainInputFile(botId: string, attachment: FileAttachment, snapshotPath: string, workId?: string): FileAttachment {
    this.requireRunning()
    return this.store.retainInputFile(botId, attachment, snapshotPath, workId)
  }

  async acceptedBrowserInputPath(
    taskId: string, reference: string, signal: AbortSignal, historyStorage?: BotInputHistoryResolver,
    editableWorkspace?: string
  ) {
    this.workToolSource(taskId)
    const file = this.store.acceptedDesktopInputFile(taskId, reference, true, historyStorage, editableWorkspace)
    if (!file) return undefined
    await verifyInputFiles([file], signal)
    this.workToolSource(taskId)
    return file.file.filePath
  }

  acceptedDeliveryInputFile(taskId: string, reference: string, historyStorage?: BotInputHistoryResolver) {
    this.workToolSource(taskId)
    return this.store.acceptedDesktopInputFile(taskId, reference, false, historyStorage)
  }

  async acceptedHistoricalWorkDelivery(
    taskId: string, reference: BotHistoricalDeliveryReference, storageRoot: string, signal: AbortSignal,
    use: BotHistoricalDeliveryUse = "deliver"
  ) {
    const task = this.workToolSource(taskId)
    if (!task.workId) return undefined
    const requestIds = this.store.preparedDesktopWorkAttachmentRequests(task)
    if (!requestIds.length) return undefined
    const { findHistoricalBotWorkDelivery, revalidateDesktopBotDelivery } = await import("./delivery-receipt")
    const workId = task.workId
    const currentWork = () => {
      signal.throwIfAborted()
      this.workToolSource(taskId)
      const work = this.getWork(task.botId, workId)
      this.store.assertWorkNotDeleting(work)
      if (work.threadId !== task.threadId || work.source || work.audienceKey !== "desktop" ||
          (work.conversation && work.conversation.state !== "bound"))
        throw new BotError("CONFLICT", "原任务关联已变化，请检查原交付。")
      return work
    }
    const previous = findHistoricalBotWorkDelivery(currentWork(), requestIds, storageRoot, reference, use)
    if (!previous) return undefined
    const { source, receipt } = previous
    const { path, root, digest } = receipt
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size !== receipt.file.size || await realpath(path) !== path ||
        await hashBotFile(root, path, signal) !== digest || await realpath(path) !== path)
      throw new BotError("CONFLICT", "已保存的成果版本发生变化，请查看原交付。")
    const work = currentWork()
    const current = revalidateDesktopBotDelivery({ desktopDeliveryWorks: () => [work] }, source, receipt)
    if (current.resultId !== receipt.resultId)
      throw new BotError("CONFLICT", "原交付附件已不可用，请查看原任务。")
    return current
  }

  send(input: SendBotMessageInput): BotTask {
    this.requireRunning()
    return this.notifyUserMessageAccepted(this.store.enqueue(input))
  }

  private notifyUserMessageAccepted(task: BotTask): BotTask {
    this.changed()
    this.steerUserMessage(task)
    this.wake()
    return task
  }

  /** A live run accepts a targeted text supplement. Starting a new task turn
   * from its desktop composer requires user control. */
  sendDesktopMessage(input: SendBotMessageInput): BotTask | Promise<BotTask> {
    this.assertDesktopWorkInputControl(input)
    if (input.workId && !input.skillDraftFromMain && input.inputFileIds?.length) {
      const files = this.store.desktopDraftInputFiles(input.inputFileIds)
      if (files.some(file => file.botId !== input.botId || file.workId !== input.workId)) {
        const work = this.getWork(input.botId, input.workId)
        const lease = requireThreadMutationLease(work.threadId)
        return withThreadMutationLeaseLock(lease, async row => {
          const transfers = this.store.desktopDraftInputTransfers(input, row)
          await verifyInputFiles(input.explicitSkill ? files : transfers, AbortSignal.timeout(30_000))
          this.assertDesktopWorkInputControl(input)
          return this.notifyUserMessageAccepted(this.store.enqueueWithDesktopDraftInputs(input, row, transfers))
        })
      }
    }
    return input.explicitSkill
      ? this.sendWithSelectedSkill(input, () => this.assertDesktopWorkInputControl(input))
      : this.send(input)
  }

  private assertDesktopWorkInputControl(input: SendBotMessageInput): void {
    this.requireRunning()
    if (!input.workId) return
    const work = this.getWork(input.botId, input.workId)
    if (input.skillDraftFromMain || input.skillDraftSourceThreadId !== undefined) {
      const bot = this.getBot(input.botId)
      if (!input.explicitSkill || input.skillDraftFromMain !== true ||
          input.skillDraftSourceThreadId !== bot.threadId || work.parentThreadId !== bot.threadId ||
          work.botId !== bot.id || work.source || work.audienceKey !== "desktop" ||
          (work.conversation && work.conversation.state !== "bound"))
        throw new BotError("CONFLICT", "技能草稿的主对话来源或任务目标已变化，请在原主对话重新选择。")
      return
    }
    if (work.source || work.audienceKey !== "desktop") return
    if (work.userControl?.settling)
      throw new BotError("CONFLICT", "正在等待原任务结算，控制权移交后可发送；草稿已保留。")
    if (input.supplementRunId) {
      const run = this.active.get(input.supplementRunId)
      if (run && !run.controller.signal.aborted && run.task.botId === work.botId &&
          run.task.workId === work.id && run.task.threadId === work.threadId &&
          !input.explicitSkill && !input.inputFileIds?.length && !work.deletionPending && !work.deletionCommitted) return
      throw new BotError("CONFLICT", "原运行已变化，草稿已保留。请回主对话继续交办，或获取任务控制权后发送。")
    }
    if (!work.userControl)
      throw new BotError("CONFLICT", "此任务由 Bot 管理，请先获取控制权，或在主 Bot 对话补充要求。草稿已保留。")
  }

  private async sendWithSelectedSkill(input: SendBotMessageInput, beforeSend: () => void): Promise<BotTask> {
    this.requireRunning()
    if (!input.explicitSkill) throw new BotError("INVALID_INPUT", "请选择技能")
    if (input.inputFileIds?.length) {
      const files = this.store.desktopInputFiles(input.botId, input.inputFileIds, input.skillDraftFromMain ? undefined : input.workId)
      if (retainedInputFileIds(files, input.message).length !== files.length)
        throw new BotError("INVALID_INPUT", "技能草稿附件与保留版本不一致，请重新选择")
      await verifyInputFiles(files, AbortSignal.timeout(30_000))
    }
    beforeSend()
    return this.send(input)
  }

  private steerUserMessage(task: BotTask): void {
    // Automatic results wait for the conversation lease. Never inject or yield
    // the active user turn, even when its runtime is ready to accept steer.
    if (task.origin.kind === "work_result") return
    if (task.origin.kind === "user" && task.origin.explicitSkill) return
    const controlToken = task.workId ? this.store.workDispatchToken(task.id) : "bot"
    if (controlToken === null) return
    const stillAllowed = () => !task.workId || this.store.workDispatchToken(task.id) === controlToken
    const peerFeedback = task.origin.kind === "bot" && Boolean(task.origin.feedbackForTaskId)
    if (
      task.state !== "queued" ||
      (!peerFeedback && !["user", "group"].includes(task.origin.kind) &&
        !(task.origin.kind === "work" && botTaskAcceptsUserInput(task)))
    )
      return
    const groupId = task.origin.kind === "group" ? task.origin.groupId : undefined
    // Forwarded context must not dismiss a background receipt's question or
    // preempt its model turn. It stays in the existing queue until lease release.
    const backgroundRun = peerFeedback || task.origin.kind === "work" ? undefined : [...this.active.values()].find(
      (candidate) =>
        candidate.botId === task.botId &&
        candidate.task.threadId === task.threadId &&
        canDeferBotTask(candidate.task) &&
        !canSteerBotTask(candidate.task, task) &&
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
          stillAllowed() &&
          this.active.get(backgroundRun.task.id) === backgroundRun &&
          this.store
            .pendingConversationTasks(task.botId, groupId, task.workId)
            .some(
              (pending) => pending.state === "queued" && pending.origin.kind === task.origin.kind
            )
      )
      return
    }
    const run = [...this.active.values()].find((candidate) => canSteerBotTask(candidate.task, task) || canDeliverBotFeedback(candidate.task, task))
    if (
      !run?.lease.steer ||
      !run.steeringReady ||
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
        if (!stillAllowed()) return false
        if (this.store.getTask(task.id).state !== "queued") return false
        if (!this.store.injectIntoRun(task.id, run.task.id)) return false
        run.steered.add(task.id)
        this.changed()
        if (this.store.hasPendingCommandNotifications()) this.wake()
        return true
      }, stillAllowed)
      .then((result) => {
        // Runtime admission can precede injection by a long tool call. Retain
        // the exact-run marker so a receipt replay does not run Hooks again.
        if (result === true) return
        run.preparingSteers.delete(task.id)
        // A Hook refusal is terminal for this inbox entry, not a request to
        // retry it as a new run. Transient lease/readiness failures stay queued.
        if (
          typeof result === "boolean" ||
          this.stopping || this.faulted || run.controller.signal.aborted ||
          this.active.get(run.task.id) !== run ||
          this.store.getTask(task.id).state !== "queued"
        ) return
        // Hook diagnostics stay in the existing local Hook events/logs, never
        // in a public group, external-channel or result-summary receipt.
        const message = "输入检查未通过，未执行这条补充消息。"
        try {
          this.store.settle(task.id, "failed", message)
        } catch (error) {
          this.faulted = true
          throw error
        }
        this.changed()
        this.wake()
        this.runtime.onSettled?.(task, "failed", message)
      })
      .catch((error) => {
        run.preparingSteers.delete(task.id)
        this.reportError(error)
      })
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

  workPromptGoal(botId: string, workId: string) {
    this.requireRunning()
    return this.store.workPromptGoal(botId, workId)
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
    if (active?.task.workId) {
      const work = this.store.getWork(active.task.botId, active.task.workId)
      if (!work.userControl?.stopping && !work.dispatchStopped)
        this.store.stopWorkConversationReview(work.botId, work.id, active.task.id)
    }
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
      if ((task.origin.kind === "work_result" && task.origin.review?.phase === "review") ||
          this.store.taskCheckpoint(taskId) || task.mockSource?.transport === "im" ||
          (notifyQueuedCaller && ((task.origin.kind === "bot" && (task.origin.expectsReply || task.origin.upstreamTaskId)) ||
          (task.origin.kind === "notification" && task.origin.notificationKind === "workflow"))))
        this.store.settle(taskId, "cancelled", null)
      else if (!this.store.withdrawHeldWorkResultRepair(task))
        this.store.transition(taskId, "cancelled")
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

  /** Cancel current conversation activity and keep the work's dispatch policy. */
  stopConversation(botId: string, groupId?: string, workId?: string, scope?: "background"): void {
    if (scope === "background") {
      if (groupId) throw new BotError("INVALID_INPUT", "群聊不支持此停止范围")
      if (!workId) {
        const { threadId } = this.getBot(botId)
        if ([...this.active.values()].some(({ task }) => task.threadId === threadId &&
            task.origin.kind !== "work_result"))
          throw new BotError("CONFLICT", "任务状态已变化，请根据当前状态重试")
        const revision = this.store.revision()
        const stopped = this.store.stopMainConversationBackground(botId, threadId)
        this.cancelWorkflows(stopped.workflows)
        for (const id of stopped.tasks) this.cancelSingleTask(id)
        if (stopped.commandIds.length)
          void Promise.resolve(this.runtime.cancelBackgroundCommands?.(stopped.commandIds)).catch(this.reportError)
        if (this.store.revision() !== revision) {
          this.changed()
          this.wake()
        }
        return
      }
      const work = this.getWork(botId, workId)
      // The button was shown using an idle foreground snapshot. Never stop a
      // reply that was accepted before that click reached the Host.
      if (!work.userControl || work.userControl.settling ||
          [...this.active.values()].some(({ task }) => task.threadId === work.threadId) ||
          this.store.pendingWorkFamily(botId, workId, true).some(task =>
            task.workId === workId && task.threadId === work.threadId && task.origin.kind === "user"))
        throw new BotError("CONFLICT", "任务状态已变化，请根据当前状态重试")
    }
    this.stopConversationRuns(botId, groupId, workId, "conversation")
  }

  /** Explicit work Stop also prevents future automatic dispatch. */
  stopWork(botId: string, workId: string): void {
    this.stopConversationRuns(botId, undefined, workId, "work")
  }

  private stopConversationRuns(botId: string, groupId?: string, workId?: string, scope?: "work" | "conversation",
    revision = this.store.revision()) {
    if (groupId && workId) throw new BotError("INVALID_INPUT", "群与工作目标不能混用")
    const bot = groupId ? this.getGroupMember(groupId, botId) : this.getBot(botId)
    if (workId && scope === "work") {
      this.store.stopWorkDispatch(botId, workId)
      for (const { task, controller } of this.active.values()) {
        if (task.botId === botId && task.origin.kind === "work_result" &&
            task.origin.review?.phase === "publish" && task.origin.workId === workId &&
            this.store.getTask(task.id).state === "cancelled") controller.abort()
      }
    }
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
    if (workId && scope === "conversation") this.store.stopWorkConversationReview(botId, workId)
    // Read the inbox now, rather than a possibly stale renderer snapshot.
    // cancel() retains runtime cleanup and leaves group work untouched.
    const pending = workId
      ? this.store.pendingWorkFamily(botId, workId, scope === "conversation")
      : this.store.pendingConversationTasks(botId, groupId)
    const peers = this.store.stopConversationPeers(botId, threadId)
    const workflowCleanup = this.cancelWorkflows([
      ...peers.workflows,
      ...this.store.suppressConversationWorkflows(threadId, workId)
    ])
    for (const task of pending) this.cancelSingleTask(task.id, !workId)
    // The stopped branch reports once through its owner, not each unstarted descendant.
    for (const task of peers.tasks) this.cancelSingleTask(task.id, false)
    this.store.suppressCommands(threadId)
    const cleanup = [Promise.resolve(this.runtime.cancelBackground?.(threadId))]
    if (workflowCleanup) cleanup.push(workflowCleanup)
    const commandIds = [...new Set([
      ...peers.commandIds,
      ...(workId ? this.store.suppressWorkPeerCommands(botId, workId) : [])
    ])]
    if (commandIds.length) cleanup.push(Promise.resolve(this.runtime.cancelBackgroundCommands?.(commandIds)))
    for (const job of cleanup) void job.catch(this.reportError)
    if (revision !== this.store.revision()) {
      this.changed()
      this.wake()
    }
    return { cleanup, taskIds: new Set([...pending, ...peers.tasks].map(task => task.id)) }
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

  private cancelWorkflows(runs: readonly BotWorkflowReference[]) {
    if (!runs.length || !this.runtime.cancelWorkflowInstances) return
    const unique = [...new Map(runs.map((run) => [JSON.stringify([run.threadId, run.runId, run.startedAt]), run])).values()]
    const pending = Promise.resolve().then(() => this.runtime.cancelWorkflowInstances!(unique))
      .catch(this.reportError).finally(() => this.workflowCleanup.delete(pending))
    this.workflowCleanup.add(pending)
    return pending
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

  private wake(yieldToLoop = false): void {
    if (this.stopping || this.faulted) return
    this.yieldBeforePump ||= yieldToLoop
    if (this.scheduled) return
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
    this.finishWorkControlHandoffs()
    for (const run of this.active.values()) {
      const { task, controller } = run
      if (
        task.origin.kind === "work_result" && task.origin.review?.phase === "review" &&
        !run.workReviewCommitted && !controller.signal.aborted &&
        (this.store.yieldWorkResultReview(task.id) || !this.store.getWorkResultReview(task.id))
      ) controller.abort()
    }
    this.pumpMockDelivery()
    const unavailable = this.admissionExcluded ?? new Set<string>()
    const excluded = new Set([
      ...unavailable,
      ...[...this.active.values()].map((run) => run.task.threadId),
      ...[...this.commandCancellations.values()].map((run) => run.threadId)
    ])
    this.admissionExcluded = undefined
    const startedAt = performance.now()
    let inspected = 0
    this.publishScheduledWorkObservations()
    while (!this.stopping && this.active.size < this.concurrency) {
      // Bound synchronous scheduling time, never the number of concurrent tasks.
      // Count unsuccessful lease attempts too; unavailable threads must not spin.
      if (inspected > 0 && performance.now() - startedAt >= 8) {
        // Only failed acquisitions survive a yield. A running thread can finish
        // before the next slice; retaining it here would strand its queued results.
        this.admissionExcluded = unavailable
        this.wake(true)
        return
      }
      inspected++
      const task = this.store.nextQueued(
        [...excluded],
        this.concurrency === Number.POSITIVE_INFINITY ||
          ![...this.active.values()].some(run => !!botTaskWorkFamily(run.task))
      )
      if (!task) return
      // A review may have queued before a follow-up reached its submit hook.
      // Yield before taking the lease, preserving the original result and budget.
      if (task.origin.kind === "work_result" && task.origin.review?.phase === "review" &&
          this.store.yieldWorkResultReview(task.id, "queued")) {
        this.changed()
        continue
      }
      if (this.store.taskRootCancelled(task)) {
        this.cancel(task.id)
        excluded.add(task.threadId)
        continue
      }
      excluded.add(task.threadId)
      const schedule = this.runtime.desktopWorkScheduleDirectory
        ? this.store.desktopWorkScheduleForDispatch(task) : undefined
      const lease = this.runtime.acquire(
        this.store.getBot(task.botId),
        task,
        task.workId ? this.store.getWork(task.botId, task.workId) : undefined
      )
      if (!lease) {
        unavailable.add(task.threadId)
        continue
      }
      try {
        if (!schedule) this.store.transition(task.id, "running", null, task.groupSnapshotOrdinal)
      } catch (error) {
        lease.release()
        throw error
      }
      const controller = new AbortController()
      // Start in a microtask so cancellation and waiting hooks always see their active owner.
      const done = Promise.resolve().then(() => schedule
        ? this.prepareScheduledExecution(task, lease, controller, schedule)
        : this.execute(task, lease, controller))
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

  private publishScheduledWorkObservations(): void {
    const port = this.runtime.scheduleObservationPublication
    if (!port) return
    const previousRetryAt = this.schedulePublicationRetryAt
    const now = Date.now()
    const deferred = Array.from(this.schedulePublicationRetries)
      .filter(([, retry]) => retry.at === undefined || retry.at > now)
      .map(([taskId]) => taskId)
    const pending = this.store.pendingScheduledWorkPublications(deferred)
    for (const publication of pending) {
      let text: string | null | void
      let acknowledged: boolean
      try {
        text = port.persist(this.store.getBot(publication.botId), publication)
        acknowledged = this.store.acknowledgeScheduledWorkPublication(
          publication.taskId, text === undefined ? undefined : text
        )
      } catch (error) {
        const failures = (this.schedulePublicationRetries.get(publication.taskId)?.failures ?? 0) + 1
        const failedAt = Date.now()
        const expiresAt = publication.reminderExpiresAt ? Date.parse(publication.reminderExpiresAt) : Infinity
        const retryAt = Math.min(
          failures <= BOT_WORK_RESULT_PUBLICATION_RETRY_LIMIT ? failedAt + 5_000 : Infinity,
          expiresAt > failedAt ? expiresAt : Infinity
        )
        this.schedulePublicationRetries.set(publication.taskId, {
          failures, ...(Number.isFinite(retryAt) ? { at: retryAt } : {})
        })
        this.reportError(error)
        continue
      }
      this.schedulePublicationRetries.delete(publication.taskId)
      if (!acknowledged) continue
      const delivered = typeof text === "string" ? { ...publication, text } : publication
      try {
        const { id, threadId, createdAt } = delivered
        this.changed(text === null ? undefined : {
          reminder: { id, threadId, content: scheduledDesktopMessage(delivered), createdAt }
        })
      } catch (error) {
        this.reportError(error)
      }
      if (text !== null) void port.announce(delivered).catch(this.reportError)
    }
    this.schedulePublicationRetryAt = undefined
    for (const [id, { at }] of this.schedulePublicationRetries) {
      // A due row that disappeared (for example on archive or deletion) must
      // not keep arming the timer after the eligible queue has drained.
      if (at !== undefined && at <= now && pending.length < 8) {
        this.schedulePublicationRetries.delete(id)
      } else if (at !== undefined) {
        this.schedulePublicationRetryAt = Math.min(at, this.schedulePublicationRetryAt ?? Infinity)
      }
    }
    if (this.schedulePublicationRetryAt !== previousRetryAt) this.armSchedules()
    if (pending.length === 8) this.wake()
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
    let dispatchAcknowledged = false
    let explicitGroupMessages = false
    let publicContribution = false
    let waitingCount = 0
    let deferredCheckpoint: string | undefined
    let deferredFiles: BotDeliveredFile[] | undefined
    let consumedCommandIds: string[] | undefined
    let retryPublication = false
    try {
      const result = await lease.execute(controller.signal, (waiting) => {
        if (controller.signal.aborted) return
        waitingCount = Math.max(0, waitingCount + (waiting ? 1 : -1))
        this.store.transition(task.id, waitingCount > 0 ? "waiting_user" : "running")
        this.changed()
        if (waitingCount > 0 && botTaskGroupId(task)) this.wake()
        if (waitingCount === 0 && task.workId && this.active.get(task.id)?.steeringReady)
          this.onSteeringReady(task.id)
      })
      if (result.state === "deferred") {
        deferredCheckpoint = result.checkpointId
        deferredFiles = result.files
        consumedCommandIds = result.consumedCommandIds
      } else {
        state = result.state
        reason = result.error ?? null
        finalText = result.result
        dispatchAcknowledged = result.dispatchAcknowledged === true
        files = result.files
        explicitGroupMessages = result.explicitGroupMessages === true
        publicContribution = result.publicContribution === true
      }
    } catch (error) {
      state = "failed"
      reason = error instanceof Error ? error.message : "任务执行失败"
      retryPublication = error instanceof RetryableBotWorkPublicationError
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
        const retrying = retryPublication && !controller.signal.aborted &&
          this.store.retryWorkResultPublication(task.id)
        if (deferredCheckpoint)
          this.store.deferTask(task.id, deferredCheckpoint, deferredFiles, consumedCommandIds)
        else if (!retrying)
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
              : lease.notificationTerminal?.(),
            dispatchAcknowledged
          )
        this.changed()
        try {
          if (!deferredCheckpoint &&
              !(task.origin.kind === "work_result" && task.origin.review) &&
              !(task.workId && this.store.workResultReviewActiveForExecution(task.id))) {
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

  /** Keep the trigger queued for pause/edit/stop while checking its original directory. */
  private async prepareScheduledExecution(
    task: BotTask, lease: BotRunLease, controller: AbortController, schedule: BotSchedule
  ): Promise<void> {
    const { signal } = controller
    let started = false
    try {
      const token = this.store.workDispatchToken(task.id)
      const stillQueued = () => token !== null && this.store.workDispatchToken(task.id) === token
      if (signal.aborted || !stillQueued() || !task.workId) return
      let missing = false
      try {
        const work = this.store.getWork(task.botId, task.workId)
        if (work.threadId !== task.threadId)
          throw new BotError("CONFLICT", "原工作已改变，此次例行未执行。")
        const directory = this.runtime.desktopWorkScheduleDirectory?.(work)
        if (directory && await this.scheduleDirectoryMissing(directory.path, signal)) {
          if (signal.aborted || !stillQueued()) return
          // Re-read the original thread after I/O. A stale probe cannot pause a new target.
          const current = this.store.getWork(task.botId, task.workId)
          const verified = this.runtime.desktopWorkScheduleDirectory?.(current)
          if (current.threadId !== task.threadId || verified?.path !== directory.path ||
              verified.incarnation !== directory.incarnation)
            throw new BotError("CONFLICT", "原工作目录已改变，此次例行未执行。")
          missing = true
        }
      } catch (error) {
        if (!signal.aborted && stillQueued())
          this.store.settle(task.id, "failed", error instanceof Error ? error.message : "例行任务未能开始")
        return
      }
      if (signal.aborted || !stillQueued()) return
      if (missing) {
        // A file-system result observed against an old schedule version cannot change the new one.
        if (this.store.pauseScheduleForMissingDirectory(task.id, schedule)) this.armSchedules()
        return
      }
      this.store.transition(task.id, "running")
      started = true
      this.changed()
      // This is the same release and settlement path as every other Bot execution.
      await this.execute(task, lease, controller)
    } catch (error) {
      this.faulted = true
      this.reportError(error)
    } finally {
      if (!started) {
        try {
          if (signal.aborted && !this.stopping && this.store.getTask(task.id).state === "queued")
            this.store.transition(task.id, "cancelled")
          this.changed()
        } catch (error) {
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
  }

  private async scheduleDirectoryMissing(path: string, signal: AbortSignal): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    return Promise.race([
      stat(path).then(
        (entry) => !entry.isDirectory(),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT" || error.code === "ENOTDIR"
      ),
      new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false)
        signal.addEventListener("abort", onAbort, { once: true })
        timer = setTimeout(onAbort, 3_000)
        timer.unref?.()
      })
    ]).finally(() => {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener("abort", onAbort)
    })
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      if (this.mockRecoveryTimer) clearTimeout(this.mockRecoveryTimer)
      this.mockRecoveryTimer = undefined
      this.lifecycle.abort()
      this.featureTurns.cancel()
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
          [...this.workDeletions.values()].map(run => run.then(() => undefined)),
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
