import {
  BOT_PROTOCOL_VERSION,
  LOCAL_BOT_HOST_ID,
  BotError,
  botTaskGroupId,
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
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BackgroundCommandLifecycle } from "../agent/background-command-lifecycle"

export interface BotRunLease {
  /** Reuse the active runtime's user-prompt pipeline; inbox remains queued until injection. */
  steer?(task: BotTask, beforeInject: () => boolean): Promise<boolean>
  execute(
    signal: AbortSignal,
    waiting: (value: boolean) => void
  ): Promise<{
    state: "completed" | "failed" | "outcome_unknown" | "superseded"
    error?: string
    result?: string
    files?: BotDeliveredFile[]
  }>
  release(): void
}

export interface BotRunPort {
  browser?: boolean
  /** Cancel only this conversation's detached work through the existing managers. */
  cancelBackground?(threadId: string): void | Promise<void>
  recover?(threadIds: string[], signal: AbortSignal): Promise<void>
  /** Claim the existing runtime's thread lease before changing durable task state. */
  acquire(bot: BotDefinition, task: BotTask): BotRunLease | null
  onAvailable(listener: () => void): () => void
  onSettled?(task: BotTask, state: BotTaskState, result?: string): void
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
  private readonly listeners = new Set<(event: BotChangeEvent) => void>()
  private readonly unsubscribe: () => void
  private readonly lifecycle = new AbortController()
  private recovery: Promise<void> = Promise.resolve()
  private stopping = false
  private faulted = false
  private scheduled = false
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private lastHistoryMaintenance = -Infinity

  constructor(
    private readonly store: BotStore,
    private readonly runtime: BotRunPort,
    private readonly concurrency = 2,
    private readonly reportError: (error: unknown) => void = console.error,
    private readonly nextSchedule?: (input: BotScheduleInput, from: Date) => string | null
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
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
    if (id.startsWith("group-")) {
      const [groupId, memberId, extra] = id.slice(6).split("--")
      if (!memberId || extra) throw new BotError("INVALID_INPUT", "请选择要查看的群成员浏览器")
      this.getGroupMember(groupId, memberId)
    } else {
      this.getBot(id)
    }
    return id
  }

  getGroupMember(groupId: string, botId: string): BotDefinition {
    this.requireRunning()
    const group = this.store.getGroup(groupId)
    if (group.deleting) throw new BotError("CONFLICT", "群聊正在删除")
    if (!group.memberIds.includes(botId)) throw new BotError("CONFLICT", "成员已离开此群")
    return this.getBot(botId)
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
      backgroundThreads: this.store.activeCommandThreads()
    }
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

  private changed(memoryBotId?: string): void {
    const event = {
      hostId: LOCAL_BOT_HOST_ID,
      revision: this.store.revision(),
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

  markUnread(kind: "bot" | "group", id: string): void {
    this.requireRunning()
    this.store.markUnread(kind, id)
    this.changed()
  }
  exchange(botId: string, taskId: string, groupId?: string) {
    this.requireRunning()
    return this.store.exchange(botId, taskId, groupId)
  }
  exchangeHistory(botId: string, taskId: string, groupId?: string, before?: string) {
    this.requireRunning()
    return this.store.exchangeHistory(botId, taskId, groupId, before)
  }
  messageOrigins(botId: string, messageIds: string[], groupId?: string) {
    this.requireRunning()
    return this.store.messageOrigins(botId, messageIds, groupId)
  }
  requestReceipts(botId: string, checks: BotRequestCheck[]) {
    this.requireRunning()
    return this.store.requestReceipts(botId, checks)
  }
  markRead(kind: "bot" | "group", id: string, throughVersion: number): void {
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
    for (const [id, run] of this.active) {
      const task = this.store.getTask(id)
      if (botTaskGroupId(task) === group.id && !group.memberIds.includes(task.botId))
        run.controller.abort()
    }
    for (const id of previous?.memberIds ?? []) {
      if (group.memberIds.includes(id)) continue
      const threadId = `group-${group.id}-${id}`
      this.store.suppressCommands(threadId)
      void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
    }
    this.changed()
    return group
  }
  groupMessages(id: string, cursor?: BotGroupHistoryCursor): BotGroupMessage[] {
    this.requireRunning()
    return this.store.groupMessages(id, cursor)
  }
  publishGroupFiles(taskId: string, callId: string, files: BotDeliveredFile[]): void {
    this.requireRunning()
    const run = this.active.get(taskId)
    if (!run || run.controller.signal.aborted)
      throw new BotError("CONFLICT", "任务已停止，无法继续交付附件")
    this.store.publishGroupFiles(taskId, callId, files)
    this.changed()
  }
  sendGroup(input: SendBotGroupMessageInput): void {
    this.requireRunning()
    this.store.sendGroup(input)
    this.changed()
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

  saveSchedule(
    botId: string,
    input: BotScheduleInput,
    existing?: { id: string; version: number }
  ): BotSchedule {
    this.requireRunning()
    if (!this.nextSchedule) throw new BotError("CONFLICT", "此主机未启用例行任务")
    if (input.enabled && input.frequency === "once" && Date.parse(input.runAt ?? "") <= Date.now())
      throw new BotError("INVALID_INPUT", "执行时间必须在未来")
    const next = input.enabled ? this.nextSchedule(input, new Date()) : null
    const schedule = this.store.saveSchedule(botId, input, next, existing)
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
        this.store.finishDeletion(id)
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
    groupId?: string
  ): void {
    this.requireRunning()
    const bot = this.store.getBot(botId)
    if (bot.archived || bot.deleting) return
    const expectedThread = groupId ? `group-${groupId}-${botId}` : bot.threadId
    if (threadId !== expectedThread) throw new BotError("CONFLICT", "后台通知不属于此 Bot 会话")
    if (groupId) {
      const group = this.store.getGroup(groupId)
      if (group.deleting || !group.memberIds.includes(botId)) return
    }
    this.store.enqueue(
      { botId, requestId: `notification:${threadId}:${kind}:${key}`, message },
      { kind: "notification", notificationKind: kind, key, ...(groupId ? { groupId } : {}) }
    )
    this.changed()
    this.wake()
  }

  commandLifecycle(sourceTaskId: string): BackgroundCommandLifecycle {
    return {
      accepted: (command) => {
        this.requireRunning()
        this.store.acceptCommand(sourceTaskId, command)
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

  messageReply(botId: string, messageId: string) {
    this.requireRunning()
    return this.store.messageReply(botId, messageId)
  }

  send(input: SendBotMessageInput): BotTask {
    this.requireRunning()
    const task = this.store.enqueue(input)
    this.changed()
    this.steerDirectMessage(task)
    this.wake()
    return task
  }

  private steerDirectMessage(task: BotTask): void {
    if (task.state !== "queued" || task.origin.kind !== "user") return
    const run = [...this.active.values()].find(
      (candidate) =>
        candidate.task.threadId === task.threadId &&
        (candidate.task.origin.kind === "user" || candidate.task.origin.kind === "introduction")
    )
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
      (run.task.origin.kind !== "user" && run.task.origin.kind !== "introduction") ||
      run.controller.signal.aborted
    )
      return
    run.steeringReady = true
    for (const task of this.store.pendingConversationTasks(run.botId)) this.steerDirectMessage(task)
  }

  updateOwnProfile(taskId: string, patch: { name?: string; instructions?: string }): BotDefinition {
    this.requireRunning()
    const bot = this.store.updateOwnProfile(taskId, patch)
    this.changed()
    return bot
  }

  updateTeammate(
    taskId: string,
    botId: string,
    patch: { name?: string; instructions?: string }
  ): BotDefinition {
    this.requireRunning()
    const bot = this.store.updateTeammate(taskId, botId, patch)
    this.changed()
    return bot
  }

  cancel(taskId: string): void {
    this.requireRunning()
    const task = this.store.getTask(taskId)
    const active =
      this.active.get(taskId) ?? [...this.active.values()].find((run) => run.steered.has(taskId))
    if (active) {
      // Durable cancellation only after runtime cleanup, never while tools are still unwinding.
      active.controller.abort()
    } else if (task.state === "queued") {
      this.store.transition(taskId, "cancelled")
      this.changed()
    }
  }

  stopConversation(botId: string, groupId?: string): void {
    const bot = groupId ? this.getGroupMember(groupId, botId) : this.getBot(botId)
    const threadId = groupId ? `group-${groupId}-${botId}` : bot.threadId
    // Read the inbox now, rather than a possibly stale renderer snapshot.
    // cancel() retains runtime cleanup and leaves group work untouched.
    for (const task of this.store.pendingConversationTasks(botId, groupId)) this.cancel(task.id)
    this.store.suppressCommands(threadId)
    void Promise.resolve(this.runtime.cancelBackground?.(threadId)).catch(this.reportError)
  }

  hasActiveRuns(): boolean {
    return this.active.size > 0 || this.store.activeCommandThreads().length > 0
  }

  private wake(): void {
    if (this.stopping || this.faulted || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.stopping || this.faulted) return
      try {
        this.pump()
      } catch (error) {
        this.faulted = true
        this.reportError(error)
      }
    })
  }

  private pump(): void {
    if (!this.active.size && Date.now() - this.lastHistoryMaintenance >= 10 * 60_000) {
      this.lastHistoryMaintenance = Date.now()
      try {
        this.store.pruneTaskHistory()
      } catch (error) {
        // Optional housekeeping failure must not turn a valid task into a failed run.
        this.reportError(error)
      }
    }
    this.store.flushReplies()
    const excluded = new Set([...this.active.values()].map((run) => run.botId))
    while (!this.stopping && this.active.size < this.concurrency) {
      const task = this.store.nextQueued([...excluded])
      if (!task) return
      excluded.add(task.botId)
      const lease = this.runtime.acquire(this.store.getBot(task.botId), task)
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

  private async execute(
    task: BotTask,
    lease: BotRunLease,
    controller: AbortController
  ): Promise<void> {
    let state: BotTaskState = "outcome_unknown"
    let reason: string | null = null
    let finalText: string | undefined
    let files: BotDeliveredFile[] | undefined
    let waitingCount = 0
    try {
      const result = await lease.execute(controller.signal, (waiting) => {
        if (controller.signal.aborted) return
        waitingCount = Math.max(0, waitingCount + (waiting ? 1 : -1))
        this.store.transition(task.id, waitingCount > 0 ? "waiting_user" : "running")
        this.changed()
      })
      state = result.state
      reason = result.error ?? null
      finalText = result.result
      files = result.files
    } catch (error) {
      state = "failed"
      reason = error instanceof Error ? error.message : "任务执行失败"
    } finally {
      if (controller.signal.aborted) {
        state = this.stopping ? "interrupted" : "cancelled"
        reason = this.stopping ? "应用退出，任务已中断；请检查已有结果后继续。" : null
      }
      try {
        // These messages were consumed by this exact graph, not separate queued runs.
        // Unconsumed messages stay queued and run normally after the lease releases.
        this.store.settleRun(
          task.id,
          this.active.get(task.id)?.steered ?? [],
          state,
          reason,
          finalText,
          files
        )
        this.changed()
        try {
          this.runtime.onSettled?.(task, state, finalText)
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
          [this.recovery],
          backgroundStops.map((stop) => Promise.resolve(stop))
        )
    )
    this.listeners.clear()
  }
}
