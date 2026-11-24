import { getThread, getThreadMessagesPage } from "../../db"
import {
  projectHarnessNotification,
  type HarnessNotification
} from "../../../shared/harness-notifications"
import {
  isNotificationPendingForTarget,
  type AppNotification
} from "../../../shared/app-notifications"
import { decideNotification } from "../notification-actions"
import { ImDecisionCodeRegistry } from "./decision-code-registry"
import { botFeatureDecisionRoutes, type BotInteractionRoute } from "./bot-interaction-route"
import { createDecisionReplyDrainer, resolveImDecisionRoute } from "./decision-delivery"
import { registerNotificationChannel } from "../notification-channels"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies, segmentImReplyText } from "./reply-segmentation"
import type { ManagedBizRetryChoice } from "../../../shared/harness-notifications"
import { buildBizRetryCard, type HarnessDecisionCardContext } from "./card-builder"
import { imCardPublisher } from "./card-publisher"
import {
  resolveExpiredHarnessDecisionCard,
  resolveHarnessDecisionCard
} from "./harness-decision-card"
import { notificationService } from "../notification-service"
import { isNotificationVisible } from "../notification-read-model"
import {
  conversationSwitchedToText,
  ImWithheldTextNotices,
  type ImTextResendResult
} from "./withheld-text-notices"

const warn = (message: string, error?: unknown): void =>
  console.warn(`[IM] Managed Biz Retry: ${message}`, error ?? "")

function isOpenForIm(decisionId: string): boolean {
  const current = notificationService.get(decisionId)
  return isNotificationPendingForTarget(current, "im") && isNotificationVisible(current)
}

const BIZ_RETRY_SEGMENTATION = {
  maxSegments: 1,
  singleSegmentOverflow: {
    minimumHeadCharacters: 300,
    minimumTailCharacters: 300
  }
}

export class ImBizRetryAdapter {
  private readonly codes = new ImDecisionCodeRegistry("托管")
  private readonly replies = createDecisionReplyDrainer("Managed Biz Retry")
  private readonly cardContexts = new Map<string, HarnessDecisionCardContext>()
  private readonly withheld = new ImWithheldTextNotices()
  private readonly botRoutes = new Map<string, BotInteractionRoute>()
  registerReplyDrainer = this.replies.register

  private routeValid(id: string): boolean {
    const route = this.botRoutes.get(id)
    return !route || botFeatureDecisionRoutes.get(id) === route
  }

  /** See ImWithheldTextNotices: the notices whose cards went out instead. */
  async resendPendingAsText(conversationKey: string): Promise<ImTextResendResult> {
    const result = await this.withheld.resend({
      conversationKey,
      isOpen: (id) => isOpenForIm(id) && this.routeValid(id),
      closedReasonCode: "BIZ_RETRY_ALREADY_RESOLVED",
      warn
    })
    if (result.resent > 0) this.replies.drain()
    return result
  }

  async publish(notification: HarnessNotification): Promise<void> {
    if (notification.type !== "biz_retry") return
    const originThreadId = notification.sourceThreadId
    const decisionId = notification.notificationId
    const bot = botFeatureDecisionRoutes.get(decisionId)
    const feature = bot?.featureGate
    if (
      botFeatureDecisionRoutes.has(decisionId) &&
      (!feature ||
        feature.projectId !== notification.projectId ||
        feature.slug !== notification.featureId)
    )
      return
    const route = bot ?? resolveImDecisionRoute(originThreadId)
    if (!route) return
    if (bot) this.botRoutes.set(decisionId, bot)
    const code = this.codes.allocate({ notificationId: decisionId, ...route })
    const featureGrant = feature
      ? null
      : imRemoteAccessService.getFeatureGrant(notification.projectId, notification.featureId)
    const visible = (value: string) => (feature ? feature.publicText(value) : value)
    const projectName = visible(
      feature?.projectName ??
        (featureGrant?.principalId === route.principalId
          ? featureGrant.projectNameSnapshot
          : notification.projectId)
    )
    const featureName = visible(
      feature?.featureName ??
        (featureGrant?.principalId === route.principalId
          ? featureGrant.featureTitleSnapshot
          : notification.featureId)
    )
    const assistantTail = visible(this.lastAssistantTail(originThreadId))
    const assistantCardText = assistantTail.trim()
      ? segmentImReplyText(assistantTail, BIZ_RETRY_SEGMENTATION)[0]
      : ""
    const nextActionText = visible(
      notification.bizRetry?.nextAction
        ? `若选择 /开启新会话继续托管，将调用 /${notification.bizRetry?.nextAction.slashSkill} 技能，并输入 ${notification.bizRetry?.nextAction.userMessage}`
        : "当前没有可用的新会话动作；回复时会重新检查最新状态。"
    )
    const contextText =
      notification.policyResult?.facts?.contextUsageRatio === undefined
        ? "未知"
        : `${Math.round(notification.policyResult?.facts?.contextUsageRatio * 100)}%`
    const context: HarnessDecisionCardContext = {
      projectName,
      featureName,
      threadTitle: visible(
        feature?.threadTitle ?? (getThread(originThreadId)?.title?.trim() || "关联会话")
      )
    }
    this.cardContexts.set(decisionId, context)
    const presentation = {
      ...context,
      reason: visible(notification.message),
      stageName: notification.nodeId ?? "未知",
      stageStatus: notification.policyResult?.facts?.currentNodeStatus ?? "未知",
      contextUsage: contextText,
      assistantTail: assistantCardText,
      nextActionText
    }
    const text = [
      `【项目模式托管运行需要介入】`,
      `项目：【${projectName}】`,
      `特性：【${featureName}】`,
      `触发原因：${presentation.reason}`,
      `当前阶段：${notification.nodeId ?? "未知"}`,
      `阶段状态：${notification.policyResult?.facts?.currentNodeStatus ?? "未知"}`,
      `上下文占用：${contextText}`,
      "模型返回：",
      "",
      assistantTail || "（无可展示内容）",
      "",
      nextActionText,
      "",
      bot?.kind === "group" ? "请在本群 @机器人，发送以下一条指令：" : "可选操作:",
      `/停止托管运行 ${code}`,
      `/在当前会话继续托管 ${code} <输入消息，不填默认继续当前任务>`,
      `/开启新会话继续托管 ${code}`
    ].join("\n")
    const notice = buildImProactiveReplies({
      deliveryId: `managed-biz-retry:${decisionId}`,
      conversationKey: route.conversationKey,
      text,
      segmentation: BIZ_RETRY_SEGMENTATION
    })
    let card
    try {
      card = await imCardPublisher.publish({
        kind: "biz_retry",
        botEventId: bot?.botEventId,
        botBindingRef: bot?.botBindingRef,
        threadId: originThreadId,
        principalId: route.principalId,
        conversationKey: route.conversationKey,
        requestRef: decisionId,
        targetLabel: `特性：${featureName}`,
        build: (tag) => buildBizRetryCard({ ...presentation, tag, group: bot?.kind === "group" })
      })
    } catch (error) {
      warn("托管选择卡片发送失败，改发文字指令。", error)
    }
    if (bot && !this.routeValid(decisionId)) {
      if (isOpenForIm(decisionId)) feature?.onUndeliverable(decisionId)
      return
    }
    if (card) {
      const current = notificationService.get(decisionId)
      if (!isNotificationPendingForTarget(current, "im") || !isNotificationVisible(current)) {
        if (current) {
          this.endNotification(current)
        } else {
          this.codes.removeNotification(decisionId)
          this.cardContexts.delete(decisionId)
          resolveExpiredHarnessDecisionCard({
            interactionId: card.interactionId,
            context,
            kind: "biz_retry"
          })
        }
        return
      }
      // Kept for /文字模式: the reader may find the card cut short by the
      // client and ask for this instead — or already has, while the card was
      // in flight, and then it is handed over now.
      this.withheld.withhold(decisionId, notice)
      if (conversationSwitchedToText(route.conversationKey, warn)) {
        await this.resendPendingAsText(route.conversationKey)
      }
      return
    }
    const current = notificationService.get(decisionId)
    if (!isNotificationPendingForTarget(current, "im") || !isNotificationVisible(current)) {
      this.codes.removeNotification(decisionId)
      this.cardContexts.delete(decisionId)
      return
    }
    try {
      const queued = await imEventStore.enqueueProactiveReplies(notice)
      if (bot && (!isOpenForIm(decisionId) || !this.routeValid(decisionId))) {
        await Promise.all(
          queued.map((row) => imEventStore.markOutboxFailed(row.outboxId, "BIZ_RETRY_ROUTE_CLOSED"))
        )
        if (isOpenForIm(decisionId)) feature?.onUndeliverable(decisionId)
        return
      }
      this.replies.drain()
      return
    } catch (error) {
      this.codes.removeNotification(decisionId)
      this.cardContexts.delete(decisionId)
      if (bot && isOpenForIm(decisionId)) feature?.onUndeliverable(decisionId)
      throw error
    }
  }

  async resolveCode(input: {
    code: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const resolved = this.codes.resolve(input)
    if ("message" in resolved) return resolved.message
    const { code, entry } = resolved
    const result = await this.resolveDecision({
      notificationId: entry.notificationId,
      choice: input.choice,
      message: input.message,
      principalId: entry.principalId,
      conversationKey: entry.conversationKey
    })
    this.codes.settle(code, result.applied)
    return result.message
  }

  async resolveCardDecision(input: {
    notificationId: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }): Promise<string | null> {
    const result = await this.resolveDecision(input)
    return result.applied ? null : result.message
  }

  private resolveDecision(input: {
    notificationId: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }) {
    const bot = this.botRoutes.get(input.notificationId)
    const isCurrent = () => {
      const current = notificationService.get(input.notificationId)
      const note = current && projectHarnessNotification(current)
      if (!note || note.type !== "biz_retry") return false
      const route = bot
        ? botFeatureDecisionRoutes.get(input.notificationId)
        : resolveImDecisionRoute(note.sourceThreadId)
      return (
        !!route &&
        (!bot || route === bot) &&
        route.principalId === input.principalId &&
        route.conversationKey === input.conversationKey
      )
    }
    if (!isCurrent())
      return { applied: false, message: "原招乎绑定或托管决策已失效，请在 App 中查看。" }
    return decideNotification(
      {
        notificationId: input.notificationId,
        action: input.choice,
        message: input.message
      },
      {
        channel: "im",
        isCurrent,
        context: {
          route: { principalId: input.principalId, conversationKey: input.conversationKey }
        }
      }
    )
  }

  endNotification(notification: AppNotification): void {
    this.botRoutes.delete(notification.notificationId)
    this.codes.removeNotification(notification.notificationId)
    this.withheld.forget(notification.notificationId)
    const context = this.cardContexts.get(notification.notificationId)
    this.cardContexts.delete(notification.notificationId)
    if (!context) return
    resolveHarnessDecisionCard({
      notification,
      context,
      kind: "biz_retry",
      describeOutcome: (current, channelLabel) => {
        const outcome =
          current.status !== "resolved"
            ? "已失效"
            : current.action === "continue"
              ? `已在当前会话继续（${channelLabel}）`
              : current.action === "new_thread"
                ? `已开启新会话（${channelLabel}）`
                : current.action === "stop"
                  ? `已停止托管（${channelLabel}）`
                  : "已处理"
        const continued =
          current.status === "resolved" &&
          (current.action === "continue" || current.action === "new_thread")
        return { outcome, outcomeStyle: continued ? "approved" : "neutral" }
      }
    })
  }
  private lastAssistantTail(threadId: string): string {
    const message = [
      ...getThreadMessagesPage(threadId, { limit: 16, byteBudget: 64 * 1024 }).messages
    ]
      .reverse()
      .find((item) => item.role === "assistant")
    if (!message) return ""
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
    return text
  }
}

export const imBizRetryAdapter = new ImBizRetryAdapter()
export function initializeImBizRetryChannel(): void {
  registerNotificationChannel(
    "im-biz-retry",
    "im",
    {
      created: (notification) => {
        const value = projectHarnessNotification(notification)
        return value ? imBizRetryAdapter.publish(value) : undefined
      },
      ended: (notification) => imBizRetryAdapter.endNotification(notification)
    },
    "biz_retry"
  )
}
