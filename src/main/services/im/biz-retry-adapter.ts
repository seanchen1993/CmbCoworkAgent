import { getThreadMessages } from "../../db"
import { projectHarnessNotification, type HarnessNotification } from "../../../shared/harness-notifications"
import { decideNotification } from "../notification-actions"
import { ImDecisionCodeRegistry } from "./decision-code-registry"
import { createDecisionReplyDrainer, resolveImDecisionRoute } from "./decision-delivery"
import { registerNotificationChannel } from "../notification-channels"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"
import type { ManagedBizRetryChoice } from "../../../shared/harness-notifications"

export class ImBizRetryAdapter {
  private readonly codes = new ImDecisionCodeRegistry("托管")
  private readonly replies = createDecisionReplyDrainer("Managed Biz Retry")
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
    const nextActionText = notification.bizRetry?.nextAction
      ? `若选择 /托管开启新会话，将调用 /${notification.bizRetry?.nextAction.slashSkill} 技能并输入 ${notification.bizRetry?.nextAction.userMessage}`
      : "当前没有可用的新会话动作；回复时会重新检查最新状态。"
    const contextText =
      notification.policyResult?.facts?.contextUsageRatio === undefined
        ? "未知"
        : `${Math.round(notification.policyResult?.facts?.contextUsageRatio * 100)}%`
    const text = [
      `托管模式运行项目：[${projectName}]`,
      `特性: [${featureName}]需要人工介入：`,
      `触发原因：${notification.message}`,
      `当前阶段：${notification.nodeId ?? "未知"}`,
      `节点状态：${notification.policyResult?.facts?.currentNodeStatus ?? "未知"}`,
      `上下文占用：${contextText}`,
      "",
      "最近一条大模型返回消息：",
      assistantTail || "（无可展示内容）",
      "",
      "可选操作:",
      "",
      `/托管停止 ${code}`,
      `/托管继续当前会话 ${code} <输入消息，不填默认继续当前任务>`,
      `/托管开启新会话 ${code}`,
      "",
      nextActionText
    ].join("\n")
    try {
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `managed-biz-retry:${decisionId}`,
          conversationKey: route.conversationKey,
          text,
          segmentation: {
            maxSegments: 1,
            singleSegmentOverflow: {
              minimumHeadCharacters: 300,
              minimumTailCharacters: 300
            }
          }
        })
      )
      this.replies.drain()
      return
    } catch (error) {
      this.codes.removeNotification(decisionId)
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
    const result = await decideNotification(
      {
        notificationId: entry.notificationId,
        action: input.choice,
        message: input.message
      },
      {
        channel: "im",
        context: {
          route: { principalId: entry.principalId, conversationKey: entry.conversationKey }
        }
      }
    )
    this.codes.settle(code, result.applied)
    return result.message
  }

  removeNotification(notificationId: string): void {
    this.codes.removeNotification(notificationId)
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
  registerNotificationChannel("im-biz-retry", "im", {
    created: (notification) => {
      const value = projectHarnessNotification(notification)
      return value ? imBizRetryAdapter.publish(value) : undefined
    },
    ended: (notification) => imBizRetryAdapter.removeNotification(notification.notificationId)
  }, "biz_retry")
}
