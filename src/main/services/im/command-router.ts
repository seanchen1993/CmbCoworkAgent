import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { getThread } from "../../db"
import type { ImFeatureSessionMode } from "./feature-binding-service"
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
  type ImAuthorizedRemoteTarget,
  type ImRemoteAccessService
} from "./remote-access-service"
import { imRemoteApprovalService, type ImRemoteApprovalService } from "./remote-approval-service"
import {
  imRemoteUserInputService,
  type ImRemoteUserInputService
} from "./remote-user-input-service"
import { imHumanGateService, type ImHumanGateService } from "./human-gate-service"
import {
  imManagedBizRetryService,
  type ImManagedBizRetryService,
  type ManagedBizRetryChoice
} from "./managed-biz-retry-service"

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
  | "human_gate_approve"
  | "human_gate_reject"
  | "managed_stop"
  | "managed_continue"
  | "managed_new_thread"
  | "switch_target"
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
  ["回答", "answer"],
  ["门禁批准", "human_gate_approve"],
  ["门禁拒绝", "human_gate_reject"],
  ["托管停止", "managed_stop"],
  ["托管继续当前会话", "managed_continue"],
  ["托管开启新会话", "managed_new_thread"],
  ["切换", "switch_target"]
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
  humanGates: Pick<ImHumanGateService, "resolveCode">
  managedBizRetries: Pick<ImManagedBizRetryService, "resolveCode">
  selections: ImSelectionContextStore
  abortCurrent: (conversationKey: string, threadId?: string) => boolean
  getCurrentEventId: (conversationKey: string, threadId?: string) => string | null
  getThread: typeof getThread
}

/**
 * What a person types in Zhaohu, and the session it produces.
 *
 * These are the Feature's own words (agent_team shortened to Team), not the
 * thread's — a person choosing here is choosing the shape of the work, and the
 * Feature is the thing they can see. Solo and Multi are both agentMode
 * "normal" and differ only in whether subagents exist, which is why the map
 * carries a pair: naming the mode alone would let Solo become Multi, since
 * thread-service defaults subagentsEnabled to true when nobody stated it.
 *
 * Omitting the word entirely is different from every entry here — that is what
 * lets the Feature's configuration decide. With no configuration either, the
 * shared path lands on normal + subagents, which is Multi.
 */
const BIND_SESSION_MODES = new Map<string, ImFeatureSessionMode>([
  ["solo", { agentMode: "normal", subagentsEnabled: false }],
  ["multi", { agentMode: "normal", subagentsEnabled: true }],
  ["team", { agentMode: "coordinator" }],
  ["workflow", { agentMode: "workflow" }]
])

const BIND_SESSION_MODE_CHOICES = "Solo / Multi / Team / Workflow"

/** Names a session the way the person who created it asked for it. */
function bindSessionModeLabel(
  metadata: string | Record<string, unknown> | null | undefined
): string {
  const parsed = parseStandardThreadMetadata(metadata)
  if (parsed.agentMode === "coordinator") return "Team"
  if (parsed.agentMode === "workflow") return "Workflow"
  return parsed.metadata.subagentsEnabled === false ? "Solo" : "Multi"
}

function positiveIndex(argument: string): number | null {
  if (!/^\d+$/u.test(argument)) return null
  const value = Number(argument)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Compares names the way a person retypes them: case and spacing forgiven. */
function normalizeTargetName(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase()
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
      humanGates: dependencies.humanGates ?? imHumanGateService,
      managedBizRetries: dependencies.managedBizRetries ?? imManagedBizRetryService,
      selections: dependencies.selections ?? imSelectionContextStore,
      abortCurrent: dependencies.abortCurrent ?? (() => false),
      getCurrentEventId: dependencies.getCurrentEventId ?? (() => null),
      getThread: dependencies.getThread ?? getThread
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
        case "human_gate_approve":
          return await this.resolveHumanGate(input, "approve")
        case "human_gate_reject":
          return await this.resolveHumanGate(input, "reject")
        case "managed_stop":
          return await this.resolveManagedBizRetry(input, "stop")
        case "managed_continue":
          return await this.resolveManagedBizRetry(input, "continue")
        case "managed_new_thread":
          return await this.resolveManagedBizRetry(input, "new_thread")
        case "switch_target":
          return await this.switchToNamedTarget(input, input.command.argument)
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
      `/绑定 <编号> [${BIND_SESSION_MODE_CHOICES}] — 切换到已有会话，或在特性下创建会话（模式仅用于新建，省略则跟随特性配置）`,
      "/切换 <会话名称> — 按名称切回某个会话，名称就是回复开头【】里的那个",
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
      "/门禁批准 <短码> — 批准 Human Gate",
      "/门禁拒绝 <短码> — 拒绝 Human Gate",
      "/托管停止 <短码> — 停止待决策的托管运行",
      "/托管继续当前会话 <短码> <消息> — 在当前托管会话继续执行",
      "/托管开启新会话 <短码> — 创建新的托管会话",
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
      "发送 /绑定 <编号> 切换。",
      // Only where it applies. The mode is a creation-time choice, so a list
      // with no Feature in it has nothing to say about one.
      ...(targets.some((target) => target.kind === "feature_grant")
        ? [
            `在特性下新建会话可指定模式：/绑定 <编号> ${BIND_SESSION_MODE_CHOICES}，省略则跟随特性配置。`
          ]
        : [])
    ].join("\n")
  }

  private async bindAuthorizedTarget(
    input: Parameters<ImCommandRouter["handle"]>[0],
    argument: string
  ): Promise<string> {
    const [indexText = "", ...modeWords] = argument.split(/\s+/u).filter(Boolean)
    const index = positiveIndex(indexText)
    if (!index) return `用法：/绑定 <编号> [${BIND_SESSION_MODE_CHOICES}]。请先发送 /会话。`
    const requestedModeWord = modeWords.join(" ").toLowerCase()
    const requestedMode = requestedModeWord ? BIND_SESSION_MODES.get(requestedModeWord) : undefined
    if (requestedModeWord && !requestedMode) {
      return `模式无效。可选：${BIND_SESSION_MODE_CHOICES}。`
    }
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
    // Only the Feature branch creates a session, so only it has a mode to
    // choose. On an existing session the same argument would mean "change what
    // this thread already is", which is a different operation with different
    // risk — its checkpoints and any running turn were produced under the old
    // mode — and it is not offered here.
    if (requestedMode && !createsFeatureThread) {
      return "模式只能在特性下新建会话时指定；已存在的会话请在桌面切换模式。"
    }
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
            grantVersion,
            ...(requestedMode ? { sessionMode: requestedMode } : {})
          })
    const currentEventId = this.dependencies.getCurrentEventId(
      input.conversationKey,
      previous?.threadId
    )
    const switchedDuringRun = Boolean(
      currentEventId && previous?.kind !== "inbox" && previous?.targetId !== target.targetId
    )
    if (createsFeatureThread) {
      // Report what the thread actually is, not what was requested: with no
      // mode word the Feature decided, and a reader cannot see that anywhere
      // else from Zhaohu.
      const mode = bindSessionModeLabel(this.dependencies.getThread(target.threadId)?.metadata)
      return [
        `已在【${selected.label}】下新建 ${mode} 会话并切换。`,
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

  /**
   * Switches back to a session by the name the reply prefix already shows.
   *
   * Deliberately not by number: /会话 numbering lives in a 5-minute selection
   * context that every /会话 rebuilds, so a number printed in a background
   * reply is stale or meaningless by the time anyone reads it. The name in
   * 【会话：X】 is on screen, does not expire, and cannot drift onto a
   * different target.
   *
   * Only existing sessions are matched. A Feature entry would CREATE a session
   * rather than return to one, and "switch" must never mean "start something
   * new" — /绑定 stays the command that creates.
   */
  private async switchToNamedTarget(
    input: Parameters<ImCommandRouter["handle"]>[0],
    argument: string
  ): Promise<string> {
    const query = normalizeTargetName(argument)
    if (!query) return "用法：/切换 <会话名称>。名称就是回复开头【】里的那个。"
    const route = { principalId: input.principalId, conversationKey: input.conversationKey }
    const targets = await this.dependencies.access.listAuthorizedTargets(route)
    const sessions = targets.filter(
      (target): target is Extract<ImAuthorizedRemoteTarget, { kind: "thread_grant" }> =>
        target.kind === "thread_grant"
    )
    const exact = sessions.filter((target) => normalizeTargetName(target.label) === query)
    const matches =
      exact.length > 0
        ? exact
        : sessions.filter((target) => normalizeTargetName(target.label).includes(query))

    if (matches.length === 0) {
      const feature = targets.find(
        (target) =>
          target.kind === "feature_grant" && normalizeTargetName(target.label).includes(query)
      )
      return feature
        ? `【${feature.label}】是特性，不是会话；在它下面新建会话请发送 /会话 后用 /绑定 <编号>。`
        : `没有找到可切换的会话「${argument.trim()}」。它可能已在桌面关闭远程访问；请发送 /会话 查看当前可用目标。`
    }

    if (matches.length > 1) {
      // Renumbering here is safe in a way it would not be inside a background
      // reply: the person just asked for this list, so the numbers they are
      // about to use are the ones they are looking at.
      await this.dependencies.selections.create(
        input.conversationKey,
        "remote_target",
        matches.map((target) => ({
          id: target.grantId,
          label: target.label,
          targetKind: target.kind,
          grantId: target.grantId,
          grantVersion: target.grantVersion
        }))
      )
      return [
        `有 ${matches.length} 个会话叫这个名字：`,
        ...matches.map((target, index) => `${index + 1}. ${target.label}`),
        "发送 /绑定 <编号> 选择。"
      ].join("\n")
    }

    const [selected] = matches
    const previous = this.selectedTarget(input.conversationKey)
    const target = await this.dependencies.access.bindThreadGrant({
      route,
      grantId: selected.grantId,
      grantVersion: selected.grantVersion
    })
    const currentEventId = this.dependencies.getCurrentEventId(
      input.conversationKey,
      previous?.threadId
    )
    const switchedDuringRun = Boolean(
      currentEventId && previous?.kind !== "inbox" && previous?.targetId !== target.targetId
    )
    return [
      `已切换到【${targetLabel(target)}】。`,
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

  private resolveHumanGate(
    input: Parameters<ImCommandRouter["handle"]>[0],
    decision: "approve" | "reject"
  ): Promise<string> {
    return this.dependencies.humanGates.resolveCode({
      code: input.command.argument,
      decision,
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
  }

  private resolveManagedBizRetry(
    input: Parameters<ImCommandRouter["handle"]>[0],
    choice: ManagedBizRetryChoice
  ): Promise<string> {
    const match = input.command.argument.match(/^([^\s]+)(?:\s+([\s\S]*))?$/u)
    const code = match?.[1] ?? ""
    const message = match?.[2]?.trim()
    if (choice !== "continue" && message) {
      return Promise.resolve(
        choice === "new_thread" ? "托管开启新会话不支持附加消息。" : "用法：/托管停止 <短码>。"
      )
    }
    return this.dependencies.managedBizRetries.resolveCode({
      code,
      choice,
      ...(choice === "continue" ? { message: message || "继续当前任务" } : {}),
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
  }

  private selectedTarget(conversationKey: string): ImTargetSnapshot | null {
    return this.dependencies.conversations.getSelectedTarget(conversationKey)?.snapshot ?? null
  }
}
