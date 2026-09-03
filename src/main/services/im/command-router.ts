import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import { hasPendingUserInputForThread } from "../user-input"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import { imEventStore, type ImEventRecord, type ImEventStore } from "./event-store"
import { imInboxService, type ImInboxService } from "./inbox-service"
import { eventShortCode } from "./reply-segmentation"
import {
  ImSelectionContextError,
  imSelectionContextStore,
  type ImSelectionContextStore
} from "./selection-context"
import {
  ImRemoteAccessError,
  imRemoteAccessService,
  type ImRemoteAccessService
} from "./remote-access-service"
import { imRemoteApprovalService, type ImRemoteApprovalService } from "./remote-approval-service"
import {
  imRemoteUserInputService,
  type ImRemoteUserInputService
} from "./remote-user-input-service"

export type ImCommandName =
  | "help"
  | "sessions"
  | "bind"
  | "inbox"
  | "current"
  | "stop"
  | "retry"
  | "approve"
  | "reject"
  | "answer"
  | "retired"

export interface ParsedImCommand {
  name: ImCommandName
  argument: string
}

const COMMANDS = new Map<string, ImCommandName>([
  ["帮助", "help"],
  ["会话", "sessions"],
  ["项目", "retired"],
  ["功能", "retired"],
  ["绑定", "bind"],
  ["收件箱", "inbox"],
  ["当前", "current"],
  ["停止", "stop"],
  ["重试", "retry"],
  ["批准", "approve"],
  ["拒绝", "reject"],
  ["回答", "answer"]
])

export function parseImCommand(message: string): ParsedImCommand | null {
  const normalized = message.trim()
  if (!normalized.startsWith("/")) return null
  const match = normalized.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u)
  if (!match) return null
  const name = COMMANDS.get(match[1])
  return name ? { name, argument: (match[2] ?? "").trim() } : null
}

interface ImCommandRouterDependencies {
  conversations: ImConversationStateStore
  events: ImEventStore
  inbox: ImInboxService
  access: ImRemoteAccessService
  approvals: Pick<ImRemoteApprovalService, "resolveCode">
  userInputs: Pick<ImRemoteUserInputService, "resolveAnswer">
  selections: ImSelectionContextStore
  abortCurrent: (conversationKey: string, threadId?: string) => boolean
  getCurrentEventId: (conversationKey: string, threadId?: string) => string | null
}

function positiveIndex(argument: string): number | null {
  if (!/^\d+$/u.test(argument)) return null
  const value = Number(argument)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function targetLabel(target: ImTargetSnapshot): string {
  if (target.kind === "inbox") return "收件箱"
  if (target.kind === "thread") return target.title
  return `${target.projectName ?? target.projectId} / ${target.featureTitle ?? target.featureSlug}`
}

export class ImCommandRouter {
  private readonly dependencies: ImCommandRouterDependencies

  constructor(dependencies: Partial<ImCommandRouterDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      events: dependencies.events ?? imEventStore,
      inbox: dependencies.inbox ?? imInboxService,
      access: dependencies.access ?? imRemoteAccessService,
      approvals: dependencies.approvals ?? imRemoteApprovalService,
      userInputs: dependencies.userInputs ?? imRemoteUserInputService,
      selections: dependencies.selections ?? imSelectionContextStore,
      abortCurrent: dependencies.abortCurrent ?? (() => false),
      getCurrentEventId: dependencies.getCurrentEventId ?? (() => null)
    }
  }

  async handle(input: {
    command: ParsedImCommand
    conversationKey: string
    principalId: string
  }): Promise<string> {
    try {
      switch (input.command.name) {
        case "help":
          return this.helpText()
        case "sessions":
          return await this.listSessions(input)
        case "bind":
          return await this.bindAuthorizedTarget(input, input.command.argument)
        case "inbox":
          return await this.switchToInbox(input)
        case "current":
          return this.currentStatus(input.conversationKey)
        case "stop":
          return this.stopCurrent(input.conversationKey)
        case "retry":
          return this.retryUnknown(input.conversationKey, input.command.argument)
        case "approve":
          return await this.resolveApproval(input, "approve")
        case "reject":
          return await this.resolveApproval(input, "reject")
        case "answer":
          return await this.resolveUserInput(input)
        case "retired":
          return "/项目 和 /功能 已合并为 /会话，请发送 /会话 查看已在桌面授权的目标。"
      }
    } catch (error) {
      if (error instanceof ImSelectionContextError) return error.message
      if (error instanceof ImRemoteAccessError) return error.message
      // Never reflect arbitrary local exception text to IM: plugin and
      // filesystem errors commonly contain absolute paths or credentials.
      console.error("[IM] Command router failed:", error)
      return "指令处理失败，请稍后重试或在桌面查看详情。"
    }
  }

  resolveRetryEvent(
    conversationKey: string,
    shortCode: string
  ): { event: ImEventRecord } | { message: string } {
    if (!/^[A-Fa-f0-9]{8}$/u.test(shortCode)) {
      return { message: "用法：/重试 <8位事件短码>。" }
    }
    const event = this.dependencies.events
      .listConversationEvents(conversationKey)
      .find(
        (candidate) =>
          candidate.state === "outcome_unknown" &&
          eventShortCode(candidate.eventId).toLowerCase() === shortCode.toLowerCase()
      )
    if (!event?.targetSnapshot) return { message: "没有找到可重试的结果未知事件。" }
    const target = this.dependencies.conversations
      .listTargets(conversationKey)
      .find((candidate) => candidate.snapshot.targetId === event.targetSnapshot?.targetId)
    if (!target || target.state !== "active") {
      return { message: "原事件的目标当前不可用，请修复或重新绑定后再重试。" }
    }
    return { event }
  }

  private helpText(): string {
    return [
      "可用指令：",
      "/会话 — 查看已在桌面授权的会话与特性",
      "/绑定 <编号> — 切换到已有会话，或在特性下创建会话",
      "/收件箱 — 切回默认聊天",
      "/技能 — 查看当前会话可用技能",
      "/<技能名> <任务> 或 /技能 <技能名或短码> <任务> — 指定技能执行",
      "/goal <目标> — 启动长期任务",
      "/goal 或 /goal status|pause|resume|clear — 查看或控制当前 Goal",
      "/当前 — 查看目标、运行和队列状态",
      "/停止 — 只停止当前由 IM 发起的任务",
      "/批准 <审批短码> — 一次性批准工具调用（需在桌面设置中开启）",
      "/拒绝 <审批短码> — 拒绝工具调用（需在桌面设置中开启）",
      "/回答 <输入短码> <编号> — 回答 Agent 的补充问题；自定义回答使用“其他 <内容>”",
      "//<文本> — 将以 / 开头的内容作为普通消息发送",
      "/重试 <事件短码> — 显式重试结果未知的事件"
    ].join("\n")
  }

  private async listSessions(input: {
    conversationKey: string
    principalId: string
  }): Promise<string> {
    const targets = await this.dependencies.access.listAuthorizedTargets({
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
    if (targets.length === 0) {
      return "当前没有已授权的会话或 Feature。请先在桌面打开“接入招乎”。"
    }
    await this.dependencies.selections.create(
      input.conversationKey,
      "remote_target",
      targets.map((target) => ({
        id: target.grantId,
        label: target.label,
        targetKind: target.kind,
        grantId: target.grantId,
        grantVersion: target.grantVersion
      }))
    )
    return [
      "可用目标：",
      ...targets.map((target, index) =>
        target.kind === "thread_grant"
          ? `${index + 1}. ${target.label}（${target.sessionKind === "project" ? "项目会话" : "普通会话"}）`
          : `${index + 1}. ${target.label}（特性，可创建新会话）`
      ),
      "发送 /绑定 <编号> 切换。"
    ].join("\n")
  }

  private async bindAuthorizedTarget(
    input: Parameters<ImCommandRouter["handle"]>[0],
    argument: string
  ): Promise<string> {
    const index = positiveIndex(argument)
    if (!index) return "用法：/绑定 <编号>。请先发送 /会话。"
    const selected = await this.dependencies.selections.select(
      input.conversationKey,
      "remote_target",
      index
    )
    if (
      !selected.targetKind ||
      !selected.grantId ||
      !Number.isSafeInteger(selected.grantVersion) ||
      selected.grantVersion! < 1
    ) {
      return "会话编号上下文无效，请重新发送 /会话。"
    }
    const grantVersion = Number(selected.grantVersion)
    const previous = this.selectedTarget(input.conversationKey)
    const route = {
      principalId: input.principalId,
      conversationKey: input.conversationKey
    }
    const createsFeatureThread = selected.targetKind === "feature_grant"
    const target =
      selected.targetKind === "thread_grant"
        ? await this.dependencies.access.bindThreadGrant({
            route,
            grantId: selected.grantId,
            grantVersion
          })
        : await this.dependencies.access.bindFeatureGrant({
            route,
            grantId: selected.grantId,
            grantVersion
          })
    const currentEventId = this.dependencies.getCurrentEventId(
      input.conversationKey,
      previous?.threadId
    )
    const switchedDuringRun = Boolean(
      currentEventId && previous?.kind !== "inbox" && previous?.targetId !== target.targetId
    )
    if (createsFeatureThread) {
      return [
        `已在【${selected.label}】下新建会话并切换。`,
        switchedDuringRun
          ? `上一任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。新消息将发送到新会话。`
          : "后续普通消息将发送到这个新会话。"
      ].join("\n")
    }
    return [
      `已绑定并切换到【${targetLabel(target)}】。`,
      switchedDuringRun
        ? `上一任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。新消息将发送到当前会话。`
        : "后续普通消息将发送到这个会话。"
    ].join("\n")
  }

  private async switchToInbox(input: {
    conversationKey: string
    principalId: string
  }): Promise<string> {
    const previous = this.selectedTarget(input.conversationKey)
    const inbox = await this.dependencies.inbox.ensureInbox(input)
    await this.dependencies.conversations.setActiveTarget(input.conversationKey, inbox.targetId)
    const currentEventId = this.dependencies.getCurrentEventId(
      input.conversationKey,
      previous?.threadId
    )
    const switchedDuringRemoteRun = Boolean(currentEventId && previous?.kind !== "inbox")
    return switchedDuringRemoteRun
      ? `已切换到【收件箱】。\n上一会话任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。\n新消息将发送到收件箱。`
      : "已切换到【收件箱】。后续普通消息将进入默认聊天。"
  }

  private currentStatus(conversationKey: string): string {
    const conversation = this.dependencies.conversations.getConversation(conversationKey)
    const selected = this.dependencies.conversations.getSelectedTarget(conversationKey)
    const target = selected?.snapshot ?? null
    if (!conversation || !target) return "当前会话尚未初始化。"
    const queued = this.dependencies.events
      .listConversationEvents(conversationKey)
      .filter((event) => event.state === "queued").length
    const runningEventId = this.dependencies.getCurrentEventId(conversationKey, target.threadId)
    const runningEvent = runningEventId ? this.dependencies.events.getEvent(runningEventId) : null
    const runtimeTarget = runningEvent?.targetSnapshot ?? target
    const lease = getLocalThreadRunLease(runtimeTarget.threadId)
    const interaction = hasPendingApprovalForRuntimeThread(runtimeTarget.threadId)
      ? "等待桌面审批"
      : hasPendingUserInputForThread(runtimeTarget.threadId)
        ? "等待招乎或桌面补充输入"
        : "无"
    return [
      `当前目标：【${targetLabel(target)}】${selected?.state === "active" ? "" : "（授权不可用，请重新绑定或切回收件箱）"}`,
      `运行状态：${runningEventId ? "IM 任务执行中" : lease?.owner === "desktop" ? "桌面任务执行中" : lease?.owner === "scheduler" ? "定时任务执行中" : "空闲"}`,
      `排队消息：${queued}`,
      `桌面交互：${interaction}`
    ].join("\n")
  }

  private stopCurrent(conversationKey: string): string {
    const target = this.selectedTarget(conversationKey)
    if (target && this.dependencies.abortCurrent(conversationKey, target.threadId)) {
      return "已请求停止当前会话的 IM 任务。"
    }
    const lease = target ? getLocalThreadRunLease(target.threadId) : undefined
    if (lease?.owner === "desktop") return "当前是桌面任务，请在桌面停止。"
    if (lease?.owner === "scheduler") return "当前是定时任务，不能通过 IM 跨来源停止。"
    return "当前没有正在执行的 IM 任务。"
  }

  private retryUnknown(conversationKey: string, shortCode: string): string {
    const resolved = this.resolveRetryEvent(conversationKey, shortCode)
    return "message" in resolved
      ? resolved.message
      : "该事件可以重试，但文件或外部副作用可能重复。请通过统一服务入口确认重试。"
  }

  private resolveApproval(
    input: Parameters<ImCommandRouter["handle"]>[0],
    decision: "approve" | "reject"
  ): Promise<string> {
    return this.dependencies.approvals.resolveCode({
      code: input.command.argument,
      decision,
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
  }

  private resolveUserInput(input: Parameters<ImCommandRouter["handle"]>[0]): Promise<string> {
    return this.dependencies.userInputs.resolveAnswer({
      argument: input.command.argument,
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
  }

  private selectedTarget(conversationKey: string): ImTargetSnapshot | null {
    return this.dependencies.conversations.getSelectedTarget(conversationKey)?.snapshot ?? null
  }
}
