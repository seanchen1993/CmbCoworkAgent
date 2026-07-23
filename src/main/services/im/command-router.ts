import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { hasPendingApprovalForRuntimeThread } from "../../agent/runtime"
import { getBuiltinRobotSettings } from "../../storage"
import { hasPendingUserInputForThread } from "../user-input"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import { imEventStore, type ImEventRecord, type ImEventStore } from "./event-store"
import {
  ImFeatureBindingError,
  imFeatureBindingService,
  type ImFeatureBindingService
} from "./feature-binding-service"
import { imInboxService, type ImInboxService } from "./inbox-service"
import { eventShortCode } from "./reply-segmentation"
import {
  ImSelectionContextError,
  imSelectionContextStore,
  type ImSelectionContextStore
} from "./selection-context"

export type ImCommandName =
  | "help"
  | "projects"
  | "features"
  | "bind"
  | "inbox"
  | "current"
  | "stop"
  | "retry"

export interface ParsedImCommand {
  name: ImCommandName
  argument: string
}

const COMMANDS = new Map<string, ImCommandName>([
  ["帮助", "help"],
  ["项目", "projects"],
  ["功能", "features"],
  ["绑定", "bind"],
  ["收件箱", "inbox"],
  ["当前", "current"],
  ["停止", "stop"],
  ["重试", "retry"]
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
  features: ImFeatureBindingService
  selections: ImSelectionContextStore
  getSettings: typeof getBuiltinRobotSettings
  abortCurrent: (conversationKey: string) => boolean
  getCurrentEventId: (conversationKey: string) => string | null
}

function positiveIndex(argument: string): number | null {
  if (!/^\d+$/u.test(argument)) return null
  const value = Number(argument)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function targetLabel(target: ImTargetSnapshot): string {
  return target.kind === "inbox"
    ? "收件箱"
    : `${target.projectName ?? target.projectId} / ${target.featureTitle ?? target.featureSlug}`
}

function featureCandidateId(projectId: string, slug: string): string {
  return JSON.stringify({ projectId, slug })
}

function parseFeatureCandidateId(value: string): { projectId: string; slug: string } | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return typeof parsed.projectId === "string" && typeof parsed.slug === "string"
      ? { projectId: parsed.projectId, slug: parsed.slug }
      : null
  } catch {
    return null
  }
}

export class ImCommandRouter {
  private readonly dependencies: ImCommandRouterDependencies

  constructor(dependencies: Partial<ImCommandRouterDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      events: dependencies.events ?? imEventStore,
      inbox: dependencies.inbox ?? imInboxService,
      features: dependencies.features ?? imFeatureBindingService,
      selections: dependencies.selections ?? imSelectionContextStore,
      getSettings: dependencies.getSettings ?? getBuiltinRobotSettings,
      abortCurrent: dependencies.abortCurrent ?? (() => false),
      getCurrentEventId: dependencies.getCurrentEventId ?? (() => null)
    }
  }

  async handle(input: {
    command: ParsedImCommand
    conversationKey: string
    principalId: string
    deviceEpoch: number
  }): Promise<string> {
    try {
      switch (input.command.name) {
        case "help":
          return this.helpText()
        case "projects":
          return await this.listProjects(input.conversationKey)
        case "features":
          return await this.listFeatures(input.conversationKey, input.command.argument)
        case "bind":
          return await this.bindFeature(input, input.command.argument)
        case "inbox":
          return await this.switchToInbox(input)
        case "current":
          return this.currentStatus(input.conversationKey)
        case "stop":
          return this.stopCurrent(input.conversationKey)
        case "retry":
          return this.retryUnknown(input.conversationKey, input.command.argument)
      }
    } catch (error) {
      if (error instanceof ImSelectionContextError) return error.message
      if (error instanceof ImFeatureBindingError) return error.message
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
      "/项目 — 查看可远程访问的项目",
      "/功能 <项目编号> — 查看项目中的 Feature",
      "/绑定 <Feature编号> — 切换到 Feature",
      "/收件箱 — 切回默认聊天",
      "/当前 — 查看目标、运行和队列状态",
      "/停止 — 只停止当前由 IM 发起的任务",
      "/重试 <事件短码> — 显式重试结果未知的事件"
    ].join("\n")
  }

  private async listProjects(conversationKey: string): Promise<string> {
    const settings = this.dependencies.getSettings()
    if (!settings.enabled) return "本设备的内置机器人已断开。"
    if (settings.remoteAccess !== "inbox-and-features") {
      return "本设备当前仅开放收件箱。请先在桌面将远程访问改为“收件箱 + Feature”。"
    }
    const projects = await this.dependencies.features.listRemoteProjects()
    if (projects.length === 0) return "当前没有可远程绑定的项目。"
    await this.dependencies.selections.create(
      conversationKey,
      "project",
      projects.map((project) => ({ id: project.id, label: project.name }))
    )
    return [
      "可绑定项目：",
      ...projects.map((project, index) => `${index + 1}. ${project.name}`),
      "发送 /功能 <项目编号> 继续。"
    ].join("\n")
  }

  private async listFeatures(conversationKey: string, argument: string): Promise<string> {
    const index = positiveIndex(argument)
    if (!index) return "用法：/功能 <项目编号>。请先发送 /项目。"
    const selectedProject = await this.dependencies.selections.select(
      conversationKey,
      "project",
      index
    )
    const features = await this.dependencies.features.listRemoteFeatures(selectedProject.id)
    if (features.length === 0) return `项目“${selectedProject.label}”没有可绑定的 Feature。`
    await this.dependencies.selections.create(
      conversationKey,
      "feature",
      features.map((feature) => ({
        id: featureCandidateId(feature.projectId, feature.slug),
        label: `${feature.title}（${feature.slug} · ${feature.status}）`
      }))
    )
    return [
      `项目“${selectedProject.label}”的 Feature：`,
      ...features.map(
        (feature, featureIndex) =>
          `${featureIndex + 1}. ${feature.title}（${feature.slug} · ${feature.status}）`
      ),
      "发送 /绑定 <Feature编号> 完成绑定。"
    ].join("\n")
  }

  private async bindFeature(
    input: Omit<Parameters<ImCommandRouter["handle"]>[0], "command">,
    argument: string
  ): Promise<string> {
    const index = positiveIndex(argument)
    if (!index) return "用法：/绑定 <Feature编号>。请先发送 /项目 和 /功能。"
    const selected = await this.dependencies.selections.select(
      input.conversationKey,
      "feature",
      index
    )
    const identity = parseFeatureCandidateId(selected.id)
    if (!identity) return "Feature 编号上下文无效，请重新发送 /项目。"
    const previous = this.dependencies.conversations.getActiveTarget(input.conversationKey)
    const target = await this.dependencies.features.bindFeature({
      ...input,
      projectId: identity.projectId,
      featureSlug: identity.slug
    })
    const currentEventId = this.dependencies.getCurrentEventId(input.conversationKey)
    const switchedDuringRun = Boolean(
      currentEventId && previous?.kind === "feature" && previous.targetId !== target.targetId
    )
    return [
      `已绑定并切换到【${targetLabel(target)}】。`,
      switchedDuringRun
        ? `上一 Feature 任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。新消息将进入当前 Feature 队列。`
        : "后续普通消息将发送到这个 Feature。"
    ].join("\n")
  }

  private async switchToInbox(input: {
    conversationKey: string
    principalId: string
    deviceEpoch: number
  }): Promise<string> {
    const previous = this.dependencies.conversations.getActiveTarget(input.conversationKey)
    const inbox = await this.dependencies.inbox.ensureInbox(input)
    await this.dependencies.conversations.setActiveTarget(input.conversationKey, inbox.targetId)
    const currentEventId = this.dependencies.getCurrentEventId(input.conversationKey)
    const switchedDuringFeatureRun = Boolean(currentEventId && previous?.kind === "feature")
    return switchedDuringFeatureRun
      ? `已切换到【收件箱】。\n上一 Feature 任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。\n新消息将进入收件箱队列。`
      : "已切换到【收件箱】。后续普通消息将进入默认聊天。"
  }

  private currentStatus(conversationKey: string): string {
    const conversation = this.dependencies.conversations.getConversation(conversationKey)
    const target = this.dependencies.conversations.getActiveTarget(conversationKey)
    if (!conversation || !target) return "当前会话尚未初始化。"
    const queued = this.dependencies.events
      .listConversationEvents(conversationKey)
      .filter((event) => event.state === "queued").length
    const runningEventId = this.dependencies.getCurrentEventId(conversationKey)
    const runningEvent = runningEventId ? this.dependencies.events.getEvent(runningEventId) : null
    const runtimeTarget = runningEvent?.targetSnapshot ?? target
    const lease = getLocalThreadRunLease(runtimeTarget.threadId)
    const interaction = hasPendingApprovalForRuntimeThread(runtimeTarget.threadId)
      ? "等待桌面审批"
      : hasPendingUserInputForThread(runtimeTarget.threadId)
        ? "等待桌面补充输入"
        : "无"
    return [
      `当前目标：【${targetLabel(target)}】`,
      `设备版本：${conversation.deviceEpoch}`,
      `运行状态：${runningEventId ? "IM 任务执行中" : lease?.owner === "desktop" ? "桌面任务执行中" : lease?.owner === "scheduler" ? "定时任务执行中" : "空闲"}`,
      `排队消息：${queued}`,
      `桌面交互：${interaction}`
    ].join("\n")
  }

  private stopCurrent(conversationKey: string): string {
    if (this.dependencies.abortCurrent(conversationKey)) return "已请求停止当前 IM 任务。"
    const target = this.dependencies.conversations.getActiveTarget(conversationKey)
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
}
