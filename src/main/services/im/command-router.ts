import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { getThreadHydrationCore } from "../../db"
import { IM_DEFAULT_CHAT_LABEL } from "../../../shared/im-display"
import { readImThreadActivity } from "./thread-activity"
import { IM_SESSION_CODE_PATTERN } from "./session-link-store"
import {
  buildBoundCard,
  buildTargetBindCard,
  TARGET_BIND_MODE_INHERIT,
  TARGET_BIND_MODE_KEY,
  TARGET_BIND_TARGET_KEY
} from "./card-builder"
import { imCardPublisher, type ImCardPublisher } from "./card-publisher"
import type { ImFeatureSessionMode } from "./feature-binding-service"
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
import { imHumanGateAdapter, type ImHumanGateAdapter } from "./human-gate-adapter"
import { imBizRetryAdapter, type ImBizRetryAdapter } from "./biz-retry-adapter"
import type { ImTextResendResult } from "./withheld-text-notices"
import type { ManagedBizRetryChoice } from "../../../shared/harness-notifications"

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
  | "text_mode"
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
  ["默认", "inbox"],
  ["收件箱", "inbox"],
  ["当前", "current"],
  ["停止", "stop"],
  ["重试", "retry"],
  ["批准", "approve"],
  ["拒绝", "reject"],
  ["回答", "answer"],
  ["门禁批准", "human_gate_approve"],
  ["门禁拒绝", "human_gate_reject"],
  ["停止托管运行", "managed_stop"],
  ["在当前会话继续托管", "managed_continue"],
  ["开启新会话继续托管", "managed_new_thread"],
  ["切换", "switch_target"],
  ["文字模式", "text_mode"]
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
  humanGates: Pick<ImHumanGateAdapter, "resolveCode">
  managedBizRetries: Pick<ImBizRetryAdapter, "resolveCode">
  selections: ImSelectionContextStore
  abortCurrent: (conversationKey: string, threadId?: string) => boolean
  getCurrentEventId: (conversationKey: string, threadId?: string) => string | null
  getThread: typeof getThreadHydrationCore
  readThreadActivity: typeof readImThreadActivity
  cards: ImCardPublisher
  /**
   * Sends as text every open gate in this conversation whose card went out in
   * its place, across all four kinds.
   */
  resendPendingAsText: (conversationKey: string) => Promise<ImTextResendResult>
  warn: (message: string, error?: unknown) => void
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

/**
 * The same choices as a form, with the omission made selectable.
 *
 * Built from BIND_SESSION_MODES rather than written out again, so a mode added
 * to the typed path cannot quietly go missing from the card.
 */
const TARGET_BIND_MODE_CHOICES: ReadonlyArray<{ label: string; value: string }> = [
  { label: "跟随特性配置", value: TARGET_BIND_MODE_INHERIT },
  ...[...BIND_SESSION_MODES.keys()].map((word) => ({
    label: word.charAt(0).toUpperCase() + word.slice(1),
    value: word
  }))
]

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
  if (target.kind === "inbox") return IM_DEFAULT_CHAT_LABEL
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
      humanGates: dependencies.humanGates ?? imHumanGateAdapter,
      managedBizRetries: dependencies.managedBizRetries ?? imBizRetryAdapter,
      selections: dependencies.selections ?? imSelectionContextStore,
      abortCurrent: dependencies.abortCurrent ?? (() => false),
      getCurrentEventId: dependencies.getCurrentEventId ?? (() => null),
      getThread: dependencies.getThread ?? getThreadHydrationCore,
      readThreadActivity: dependencies.readThreadActivity ?? readImThreadActivity,
      cards: dependencies.cards ?? imCardPublisher,
      resendPendingAsText:
        dependencies.resendPendingAsText ??
        (async (conversationKey) => {
          const results = await Promise.all([
            imRemoteApprovalService.resendPendingAsText(conversationKey),
            imRemoteUserInputService.resendPendingAsText(conversationKey),
            imHumanGateAdapter.resendPendingAsText(conversationKey),
            imBizRetryAdapter.resendPendingAsText(conversationKey)
          ])
          return results.reduce(
            (sum, result) => ({
              resent: sum.resent + result.resent,
              failed: sum.failed + result.failed
            }),
            { resent: 0, failed: 0 }
          )
        }),
      warn: dependencies.warn ?? ((message, error) => console.warn(`[IM] ${message}`, error ?? ""))
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
          return await this.currentStatus(input)
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
        case "text_mode":
          return await this.switchReplyMode(input.conversationKey, input.command.argument)
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
      "直接发送消息即可继续当前会话；首次使用会进入默认聊天。",
      "常用指令：",
      "/会话 — 查看已接入招乎的会话与特性",
      `/绑定 <编号> [${BIND_SESSION_MODE_CHOICES}] — 切换到已有会话，或在特性下创建会话（模式仅用于新建，省略则跟随特性配置）`,
      "/切换 <会话名称> — 按名称切回某个会话，名称就是回复开头【】里的那个",
      "/切换 @会话码 — 精确切回推送对应的会话，同名或改名也不受影响",
      "/默认 — 返回默认聊天，不影响其他会话的任务",
      "/收件箱 — /默认 的兼容指令",
      "/当前 — 查看消息接收目标、正在运行的会话和排队情况",
      "/停止 — 停止当前招乎主任务，不清空排队消息；后台子任务请在桌面停止",
      "/文字模式 开 — 卡片显示不全时改用文字；/文字模式 关 恢复卡片",
      "",
      "技能与长期任务：",
      "/技能 — 查看当前会话可用技能",
      "/<技能名> <任务> 或 /技能 <技能名或短码> <任务> — 指定技能执行",
      "/goal <目标> — 启动长期任务",
      "/goal 或 /goal status|pause|resume|clear — 查看或控制当前 Goal",
      "",
      "回答与审批（也可直接操作收到的卡片）：",
      "/批准 <审批短码> — 一次性批准工具调用（需在桌面设置中开启）",
      "/拒绝 <审批短码> — 拒绝工具调用（需在桌面设置中开启）",
      "/回答 <输入短码> <编号> — 回答 Agent 的补充问题；自定义回答使用“其他 <内容>”",
      "/门禁批准 <短码> — 批准 Human Gate",
      "/门禁拒绝 <短码> — 拒绝 Human Gate",
      "/停止托管运行 <短码> — 停止待决策的托管运行",
      "/在当前会话继续托管 <短码> <消息> — 在当前托管会话继续执行",
      "/开启新会话继续托管 <短码> — 创建新的托管会话",
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
      return "当前没有已接入招乎的会话或特性，你仍可在默认聊天中直接提问。\n要继续已有工作，请在桌面“内置统一机器人 → 接入招乎”开启对应会话或特性，再发送 /会话。"
    }
    const selection = await this.dependencies.selections.create(
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
    // After the selection, so a card can never outlive the numbering it renders.
    const card = await this.publishTargetBindCard(input, targets, selection.expiresAt)
    // A control event must finalize with at least one reply segment — the event
    // store refuses an empty outbox with OUTBOX_INCOMPLETE, and a command that
    // never finalizes is redelivered when its 90-second lease expires, which
    // republishes this card forever. So the card replaces the numbered list,
    // never the answer itself.
    //
    // The answer is also where a list the client cut short finds its way out.
    // It takes two steps: /文字模式 re-sends what waits on a decision, and a
    // list is not that, so the reader asks for it again once text is on.
    if (card) {
      return "可切换的目标见上方卡片，选好点「切换」即可。显示不全时先发 /文字模式 开，再发 /会话 查看文字列表。"
    }

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
    return this.bindSelectedTarget(input, index, requestedMode)
  }

  /**
   * The one place a target actually gets bound.
   *
   * Both `/绑定 <编号>` and a card submit land here with an index into the same
   * selection context, so neither can reach a target the other could not. The
   * card adds no authority: it is the numbered list, rendered.
   */
  private async bindSelectedTarget(
    input: Parameters<ImCommandRouter["handle"]>[0],
    index: number,
    requestedMode: ImFeatureSessionMode | undefined
  ): Promise<string> {
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
      await this.closeTargetBindCard(input.conversationKey, "已切换")
      return [
        `已在【${selected.label}】下新建 ${mode} 会话并切换。`,
        switchedDuringRun
          ? `上一任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。新消息将发送到新会话。`
          : "后续普通消息将发送到这个新会话。"
      ].join("\n")
    }
    await this.closeTargetBindCard(input.conversationKey, "已切换")
    return [
      `已绑定并切换到【${targetLabel(target)}】。`,
      switchedDuringRun
        ? `上一任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。新消息将发送到当前会话。`
        : "后续普通消息将发送到这个会话。"
    ].join("\n")
  }

  /** Codes resolve an exact thread; legacy name matching still offers a picker for duplicates. */
  private async switchToNamedTarget(
    input: Parameters<ImCommandRouter["handle"]>[0],
    argument: string
  ): Promise<string> {
    if (argument.trim().startsWith("@"))
      return this.switchToSessionCode({ ...input, code: argument })
    const query = normalizeTargetName(argument)
    if (!query) return "用法：/切换 <会话名称>。名称就是回复开头【】里的那个。"
    const route = { principalId: input.principalId, conversationKey: input.conversationKey }
    const targets = await this.dependencies.access.listAuthorizedTargets(route)
    const sessions = targets.filter(
      (target): target is Extract<ImAuthorizedRemoteTarget, { kind: "thread_grant" }> =>
        target.kind === "thread_grant"
    )
    const exact = sessions.filter(
      (target) =>
        normalizeTargetName(target.label) === query ||
        (target.sourceTitle && normalizeTargetName(target.sourceTitle) === query)
    )
    const matches =
      exact.length > 0
        ? exact
        : sessions.filter(
            (target) =>
              normalizeTargetName(target.label).includes(query) ||
              (target.sourceTitle && normalizeTargetName(target.sourceTitle).includes(query))
          )

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

  /** A code only locates a session. Live route and grant checks still own access. */
  async switchToSessionCode(input: {
    principalId: string
    conversationKey: string
    code: string
  }): Promise<string> {
    const code = input.code.trim().replace(/^@/u, "").toUpperCase()
    if (!IM_SESSION_CODE_PATTERN.test(code))
      return "会话码格式不正确，请完整复制消息中的 /切换 @会话码。"
    this.dependencies.conversations.assertConversationOwner(
      input.conversationKey,
      input.principalId
    )
    const link = this.dependencies.events.sessionLinks.get(code)
    if (
      !link ||
      link.principal_id !== input.principalId ||
      link.conversation_key !== input.conversationKey
    ) {
      return "未找到此聊天可用的会话码，请发送 /会话 重新选择。"
    }
    if (!this.dependencies.getThread(link.thread_id))
      return "该会话已删除，无法切换。请发送 /会话 选择其他会话。"
    let label = link.target_label
    if (link.target_kind === "inbox") {
      const target = this.dependencies.conversations
        .listTargets(input.conversationKey)
        .find(
          (entry) =>
            entry.state === "active" &&
            entry.snapshot.kind === "inbox" &&
            entry.snapshot.threadId === link.thread_id
        )
      if (!target) return "该默认聊天已停用，无法切回原会话。可发送 /默认 进入当前默认聊天。"
      await this.dependencies.conversations.setActiveTarget(
        input.conversationKey,
        target.snapshot.targetId
      )
    } else {
      const grant = this.dependencies.access.getThreadGrant(link.thread_id)
      if (
        !grant ||
        grant.state !== "active" ||
        grant.principalId !== input.principalId ||
        grant.conversationKey !== input.conversationKey
      ) {
        return "该会话当前未接入此招乎聊天，或授权已失效。请在桌面重新开启“接入招乎”。"
      }
      const target = await this.dependencies.access.bindThreadGrant({
        route: input,
        grantId: grant.grantId,
        grantVersion: grant.grantVersion,
        direct: true
      })
      label = target.title
    }
    return `已切换到【${label}】（会话码 @${code}）。\n后续消息将发送到此会话，其他会话中的任务会继续执行。`
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
      ? `已切换到【${IM_DEFAULT_CHAT_LABEL}】。\n上一会话任务仍在执行，完成后会以【${targetLabel(previous!)}】标识返回。\n新消息将发送到默认聊天。`
      : `已切换到【${IM_DEFAULT_CHAT_LABEL}】。直接发送消息即可聊天；发送 /会话 可切换到已接入的其他会话。`
  }

  private async currentStatus(input: {
    conversationKey: string
    principalId: string
  }): Promise<string> {
    const { conversationKey, principalId } = input
    const conversation = this.dependencies.conversations.getConversation(conversationKey)
    const selected = this.dependencies.conversations.getSelectedTarget(conversationKey)
    const target = selected?.snapshot ?? null
    if (!conversation || !target) return "当前会话尚未初始化，请直接发送消息开始聊天。"
    const queued = this.dependencies.events.countQueuedConversationEvents(conversationKey)
    // Route-scoped grants avoid discovering unrelated desktop sessions or
    // scanning feature catalogs/workspaces just to answer a status command.
    const candidates = new Map<string, string>()
    const threads = new Map<string, ReturnType<typeof getThreadHydrationCore>>()
    const readThread = (id: string) => {
      if (!threads.has(id)) threads.set(id, this.dependencies.getThread(id))
      return threads.get(id) ?? null
    }
    if (selected?.state === "active") candidates.set(target.threadId, targetLabel(target))
    const knownTargets = this.dependencies.conversations.listTargets(conversationKey)
    const targetsByThread = new Map(
      knownTargets
        .filter((known) => known.state === "active")
        .map((known) => [known.snapshot.threadId, known.snapshot])
    )
    for (const known of knownTargets) {
      if (known.state === "active" && known.snapshot.kind === "inbox") {
        candidates.set(known.snapshot.threadId, IM_DEFAULT_CHAT_LABEL)
      }
    }
    for (const grant of this.dependencies.access.listThreadGrants(conversationKey)) {
      if (
        grant.state !== "active" ||
        grant.principalId !== principalId ||
        grant.conversationKey !== conversationKey
      )
        continue
      const snapshot = targetsByThread.get(grant.threadId)
      const thread = readThread(grant.threadId)
      if (!candidates.has(grant.threadId) && thread) {
        candidates.set(
          grant.threadId,
          snapshot ? targetLabel(snapshot) : thread.title?.trim() || grant.titleSnapshot
        )
      }
    }
    const statuses = new Map<string, Awaited<ReturnType<typeof readImThreadActivity>>>()
    // Bound local I/O concurrency; no full message history or ES requests.
    const entries = [...candidates]
    for (let offset = 0; offset < entries.length; offset += 4) {
      await Promise.all(
        entries.slice(offset, offset + 4).map(async ([id]) => {
          const thread = readThread(id)
          if (!thread) return
          try {
            statuses.set(
              id,
              await this.dependencies.readThreadActivity(
                thread,
                Boolean(this.dependencies.getCurrentEventId(conversationKey, id))
              )
            )
          } catch (error) {
            this.dependencies.warn("Could not read remote session activity.", error)
            statuses.set(id, { busy: false, label: "状态暂时无法读取", interaction: null })
          }
        })
      )
    }
    const current = statuses.get(target.threadId)
    const running = entries.filter(([id]) => statuses.get(id)?.busy)
    const unknown = entries.filter(([id]) => statuses.get(id)?.label === "状态暂时无法读取")
    return [
      `当前目标：【${targetLabel(target)}】${selected?.state === "active" ? "" : "（授权不可用，请发送 /会话 重新选择或 /默认 返回默认聊天）"}`,
      `运行状态：${current?.label ?? "目标不可用"}`,
      `排队消息：${queued}${queued ? "（按发送时的目标依次执行，切换会话不会转移已排队消息）" : ""}`,
      `待处理交互：${current?.interaction ?? "无"}`,
      `展示方式：${this.dependencies.conversations.getReplyMode(conversationKey) === "text" ? "文字" : "卡片"}`,
      "",
      "正在运行的会话（已接入此招乎聊天）：",
      ...(running.length
        ? running.map(
            ([id, label], index) =>
              `${index + 1}. 【${label}】${id === target.threadId ? "（当前目标）" : ""}：${statuses.get(id)!.label}`
          )
        : [unknown.length ? "暂无已确认正在运行的会话。" : "暂无正在运行的会话。"]),
      ...(unknown.length
        ? [
            `状态暂时无法读取：${unknown.map(([, label]) => `【${label}】`).join("、")}，可稍后再发 /当前。`
          ]
        : []),
      "新消息会发送到当前目标；发送 /会话 切换，/默认 返回默认聊天。"
    ].join("\n")
  }

  /**
   * /文字模式: a switch, like a phone's night mode — the command names the mode
   * that is off by default, and sending it again turns it off.
   *
   * A bare switch is what a Zhaohu menu button can send, which is the point of
   * it; 开 and 关 exist for anyone who would rather state the mode than flip
   * it, and make a repeated send harmless. Every reply names the mode now in
   * force, since a switch is only usable if you can tell which way it went.
   *
   * Switching to text also sends what the cards stood in for, because the card
   * that prompted the switch is usually still open and cut short. Switching
   * back sends nothing: the text already in the chat carries every open gate
   * in full, with its code.
   */
  private async switchReplyMode(conversationKey: string, argument: string): Promise<string> {
    const current = this.dependencies.conversations.getReplyMode(conversationKey)
    const requested =
      argument === ""
        ? current === "text"
          ? "card"
          : "text"
        : argument === "开"
          ? "text"
          : argument === "关"
            ? "card"
            : null
    if (!requested) {
      return "用法：/文字模式 在卡片和文字之间切换；/文字模式 开 或 /文字模式 关 直接指定。"
    }
    if (requested === "card") {
      if (current === "card") return "当前已经是卡片模式。"
      await this.dependencies.conversations.setReplyMode(conversationKey, "card")
      return "已切回卡片模式：之后的回答、审批、提问等以卡片发送；已经用文字发出的不会再补发卡片。"
    }
    if (current !== "text") {
      await this.dependencies.conversations.setReplyMode(conversationKey, "text")
    }
    // Also run when already in text mode: an explicit 开 is how a reader
    // recovers a notice whose resend failed the first time.
    let result: ImTextResendResult = { resent: 0, failed: 0 }
    let resendThrew = false
    try {
      result = await this.dependencies.resendPendingAsText(conversationKey)
    } catch (error) {
      resendThrew = true
      this.dependencies.warn("Pending gates could not be resent as text.", error)
    }
    return [
      current === "text"
        ? "当前已经是文字模式。"
        : "已切换为文字模式：之后的回答原样以文字发送，审批、提问、门禁、托管介入也以文字发送，带短码。",
      ...(result.resent > 0 ? [`当前有 ${result.resent} 条待处理，已用文字重发。`] : []),
      ...(resendThrew
        ? ["重发待处理时出错，可发送 /文字模式 开 再试一次。"]
        : result.failed > 0
          ? [`另有 ${result.failed} 条重发失败，可发送 /文字模式 开 再试一次。`]
          : []),
      ...(current === "text" ? [] : ["再发一次 /文字模式 可切回卡片。"])
    ].join("\n")
  }

  private stopCurrent(conversationKey: string): string {
    const target = this.selectedTarget(conversationKey)
    if (target && this.dependencies.abortCurrent(conversationKey, target.threadId)) {
      return "已请求停止当前会话的招乎任务。"
    }
    const lease = target ? getLocalThreadRunLease(target.threadId) : undefined
    if (lease?.owner === "desktop") return "当前是桌面任务，请在桌面停止。"
    if (lease?.owner === "mods") return "当前是 Mods 命令，请在桌面的命令面板停止。"
    if (lease?.owner === "scheduler") return "当前是定时任务，不能通过 IM 跨来源停止。"
    return "当前没有可由 /停止 停止的招乎主任务。发送 /当前 查看运行情况；子任务请在桌面查看或停止。"
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
        choice === "new_thread" ? "托管开启新会话不支持附加消息。" : "用法：/停止托管运行 <短码>。"
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

  /**
   * Renders the numbered list as a form, and never lets that fail loudly.
   *
   * Returns whether the card was accepted, because for this one card that
   * decides what the text says: the caller prints the full numbered list only
   * when the card is not there to carry it. A failure here is always a warning
   * and never a throw — the list still goes out either way.
   */
  private async publishTargetBindCard(
    input: { conversationKey: string; principalId: string },
    targets: ReadonlyArray<ImAuthorizedRemoteTarget>,
    expiresAt: number
  ): Promise<boolean> {
    try {
      const current = this.selectedTarget(input.conversationKey)
      const createsSession = targets.some((target) => target.kind === "feature_grant")
      const interaction = await this.dependencies.cards.publish({
        kind: "target_bind",
        // No run is waiting on this card, so it has no thread to be retained
        // by. It lives exactly as long as the numbering it renders.
        threadId: null,
        expiresAt,
        principalId: input.principalId,
        conversationKey: input.conversationKey,
        // One live list per conversation, so the conversation identifies it.
        requestRef: targetBindRequestRef(input.conversationKey),
        targetLabel: current ? targetLabel(current) : IM_DEFAULT_CHAT_LABEL,
        build: (tag) =>
          buildTargetBindCard({
            currentLabel: current ? targetLabel(current) : IM_DEFAULT_CHAT_LABEL,
            targets: targets.map((target, index) => ({
              index: index + 1,
              label: target.label,
              kindLabel:
                target.kind === "thread_grant"
                  ? target.sessionKind === "project"
                    ? "项目会话"
                    : "普通会话"
                  : "特性，可创建新会话"
            })),
            modeChoices: createsSession ? TARGET_BIND_MODE_CHOICES : [],
            tag
          })
      })
      return interaction !== null
    } catch (error) {
      this.dependencies.warn("Zhaohu target list card could not be published.", error)
      return false
    }
  }

  /**
   * Replaces a live target list with where the conversation actually ended up.
   *
   * Called from the one bind path, so a typed `/绑定` closes the card exactly
   * as a submit does — otherwise the list would sit there looking live after
   * the switch it offers has already happened.
   */
  private async closeTargetBindCard(conversationKey: string, outcome: string): Promise<void> {
    try {
      const interaction = this.dependencies.cards.interactions.findByRequestRef(
        targetBindRequestRef(conversationKey)
      )
      if (!interaction) return
      const current = this.selectedTarget(conversationKey)
      await this.dependencies.cards.resolve(
        interaction.interactionId,
        buildBoundCard({
          targetLabel: current ? targetLabel(current) : IM_DEFAULT_CHAT_LABEL,
          outcome,
          detail: "这张列表已经用过，如需再切换请重新发送 /会话。"
        })
      )
      this.dependencies.cards.interactions.release(interaction.interactionId)
    } catch (error) {
      this.dependencies.warn("Zhaohu target list card could not be closed.", error)
    }
  }

  /**
   * Turns a card submit into the same bind a typed `/绑定 <编号>` performs.
   *
   * The index is validated by the selection context exactly as the typed path
   * validates it, so a receipt carrying a number that was never on the list is
   * refused there rather than here.
   */
  async resolveTargetBindCard(input: {
    principalId: string
    conversationKey: string
    feedback: ReadonlyArray<{ key: string; value: string }>
  }): Promise<string> {
    const entry = (key: string): string =>
      input.feedback.find((item) => item.key === key)?.value.trim() ?? ""
    const index = positiveIndex(entry(TARGET_BIND_TARGET_KEY))
    if (!index) return "请先在卡片里选择一个会话，再点「切换」。"

    // The typed path expresses 「跟随特性配置」 by omitting the word, so the
    // card's explicit default is normalized back to that omission here — once,
    // rather than at both the lookup and the validity check, where the two
    // could drift apart and 「inherit」 would start reading as an invalid mode.
    const modeValue = entry(TARGET_BIND_MODE_KEY)
    const modeWord = modeValue === TARGET_BIND_MODE_INHERIT ? "" : modeValue.toLowerCase()
    const requestedMode = modeWord ? BIND_SESSION_MODES.get(modeWord) : undefined
    if (modeWord && !requestedMode) {
      return `模式无效。可选：${BIND_SESSION_MODE_CHOICES}。`
    }

    try {
      return await this.bindSelectedTarget(
        { command: { name: "bind", argument: "" }, ...input },
        index,
        requestedMode
      )
    } catch (error) {
      if (error instanceof ImSelectionContextError) return error.message
      if (error instanceof ImRemoteAccessError) return error.message
      throw error
    }
  }
}

/** One live target list per conversation, so the key is the conversation. */
function targetBindRequestRef(conversationKey: string): string {
  return `target-bind:${conversationKey}`
}
