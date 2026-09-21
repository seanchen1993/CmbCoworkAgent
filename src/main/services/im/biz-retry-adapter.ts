import { getThread, getThreadMessages } from "../../db"
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
  registerReplyDrainer = this.replies.register

  async publish(notification: HarnessNotification): Promise<void> {
    if (notification.type !== "biz_retry") return
    const originThreadId = notification.sourceThreadId
    const route = resolveImDecisionRoute(originThreadId)
    if (!route) return
    const decisionId = notification.notificationId
    const code = this.codes.allocate({ notificationId: decisionId, ...route })
    const featureGrant = imRemoteAccessService.getFeatureGrant(
      notification.projectId,
      notification.featureId
    )
    const projectName =
      featureGrant?.principalId === route.principalId
        ? featureGrant.projectNameSnapshot
        : notification.projectId
    const featureName =
      featureGrant?.principalId === route.principalId
        ? featureGrant.featureTitleSnapshot
        : notification.featureId
    const assistantTail = this.lastAssistantTail(originThreadId)
    const assistantCardText = assistantTail.trim()
      ? segmentImReplyText(assistantTail, BIZ_RETRY_SEGMENTATION)[0]
      : ""
    const nextActionText = notification.bizRetry?.nextAction
      ? `若选择 /开启新会话继续托管，将调用 /${notification.bizRetry?.nextAction.slashSkill} 技能，并输入 ${notification.bizRetry?.nextAction.userMessage}`
      : "当前没有可用的新会话动作；回复时会重新检查最新状态。"
    const contextText =
      notification.policyResult?.facts?.contextUsageRatio === undefined
        ? "未知"
        : `${Math.round(notification.policyResult?.facts?.contextUsageRatio * 100)}%`
    const context: HarnessDecisionCardContext = {
      projectName,
      featureName,
      threadTitle: getThread(originThreadId)?.title?.trim() || "关联会话"
    }
    this.cardContexts.set(decisionId, context)
    const presentation = {
      ...context,
      reason: notification.message,
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
      `触发原因：${notification.message}`,
      `当前阶段：${notification.nodeId ?? "未知"}`,
      `阶段状态：${notification.policyResult?.facts?.currentNodeStatus ?? "未知"}`,
      `上下文占用：${contextText}`,
      "模型返回：",
      "",
      assistantTail || "（无可展示内容）",
      "",
      "可选操作:",
      `/停止托管运行 ${code}`,
      `/在当前会话继续托管 ${code} <输入消息，不填默认继续当前任务>`,
      `/开启新会话继续托管 ${code}`,
      "",
      nextActionText
    ].join("\n")
    const card = await imCardPublisher.publish({
      kind: "biz_retry",
      threadId: originThreadId,
      principalId: route.principalId,
      conversationKey: route.conversationKey,
      requestRef: decisionId,
      targetLabel: `特性：${featureName}`,
      build: (tag) => buildBizRetryCard({ ...presentation, tag })
    })
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
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `managed-biz-retry:${decisionId}`,
          conversationKey: route.conversationKey,
          text,
          segmentation: BIZ_RETRY_SEGMENTATION
        })
      )
      this.replies.drain()
      return
    } catch (error) {
      this.codes.removeNotification(decisionId)
      this.cardContexts.delete(decisionId)
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

  resolveCardDecision(input: {
    notificationId: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }): Promise<string> {
    return this.resolveDecision(input).then((result) => result.message)
  }

  private resolveDecision(input: {
    notificationId: string
    choice: ManagedBizRetryChoice
    message?: string
    principalId: string
    conversationKey: string
  }) {
    return decideNotification(
      {
        notificationId: input.notificationId,
        action: input.choice,
        message: input.message
      },
      {
        channel: "im",
        context: {
          route: { principalId: input.principalId, conversationKey: input.conversationKey }
        }
      }
    )
  }

  endNotification(notification: AppNotification): void {
    this.codes.removeNotification(notification.notificationId)
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
    const message = [...getThreadMessages(threadId)]
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
