import { projectHumanGate } from "../../../shared/harness-notifications"
import {
  isNotificationPendingForTarget,
  type AppNotification
} from "../../../shared/app-notifications"
import { registerNotificationChannel } from "../notification-channels"
import { decideNotification } from "../notification-actions"
import { ImDecisionCodeRegistry } from "./decision-code-registry"
import { createDecisionReplyDrainer, resolveImDecisionRoute } from "./decision-delivery"
import { getThread } from "../../db"
import type { HarnessHumanGateSnapshot } from "../../../shared/harness-board-types"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"
import { buildHumanGateCard, type HarnessDecisionCardContext } from "./card-builder"
import { imCardPublisher } from "./card-publisher"
import {
  resolveExpiredHarnessDecisionCard,
  resolveHarnessDecisionCard
} from "./harness-decision-card"
import { notificationService } from "../notification-service"
import { isNotificationVisible } from "../notification-read-model"

export class ImHumanGateAdapter {
  private readonly codes = new ImDecisionCodeRegistry("门禁")
  private readonly replies = createDecisionReplyDrainer("Human Gate")
  private readonly cardContexts = new Map<string, HarnessDecisionCardContext>()
  registerReplyDrainer = this.replies.register

  async publish(gate: HarnessHumanGateSnapshot): Promise<void> {
    const route = resolveImDecisionRoute(gate.sourceThreadId)
    if (!route) return
    const code = this.codes.allocate({ notificationId: gate.gateId, ...route })
    const threadTitle = getThread(gate.sourceThreadId)?.title?.trim() || "关联会话"
    const featureGrant = imRemoteAccessService.getFeatureGrant(gate.projectId, gate.featureId)
    const projectName =
      featureGrant?.principalId === route.principalId
        ? featureGrant.projectNameSnapshot
        : gate.projectId
    const featureName =
      featureGrant?.principalId === route.principalId
        ? featureGrant.featureTitleSnapshot
        : gate.featureId
    const context: HarnessDecisionCardContext = {
      projectName,
      featureName,
      threadTitle
    }
    this.cardContexts.set(gate.gateId, context)
    const text = [
      `【项目模式需要审批】`,
      `项目：【${projectName}】`,
      `特性：【${featureName}】`,
      `来源会话：【${threadTitle}】`,
      "",
      gate.message,
      "",
      "可选操作:",
      `/门禁批准 ${code}`,
      `/门禁拒绝 ${code}`
    ].join("\n")
    const card = await imCardPublisher.publish({
      kind: "human_gate",
      threadId: gate.sourceThreadId,
      principalId: route.principalId,
      conversationKey: route.conversationKey,
      requestRef: gate.gateId,
      targetLabel: `特性：${featureName}`,
      build: (tag) => buildHumanGateCard({ ...context, message: gate.message, tag })
    })
    if (card) {
      const current = notificationService.get(gate.gateId)
      if (!isNotificationPendingForTarget(current, "im") || !isNotificationVisible(current)) {
        if (current) {
          this.endNotification(current)
        } else {
          this.codes.removeNotification(gate.gateId)
          this.cardContexts.delete(gate.gateId)
          resolveExpiredHarnessDecisionCard({
            interactionId: card.interactionId,
            context,
            kind: "human_gate"
          })
        }
      }
      return
    }
    const current = notificationService.get(gate.gateId)
    if (!isNotificationPendingForTarget(current, "im") || !isNotificationVisible(current)) {
      this.codes.removeNotification(gate.gateId)
      this.cardContexts.delete(gate.gateId)
      return
    }
    try {
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `human-gate:${gate.gateId}`,
          conversationKey: route.conversationKey,
          text
        })
      )
      this.replies.drain()
    } catch (error) {
      this.codes.removeNotification(gate.gateId)
      this.cardContexts.delete(gate.gateId)
      throw error
    }
  }

  async resolveCode(input: {
    code: string
    decision: "approve" | "reject"
    principalId: string
    conversationKey: string
  }): Promise<string> {
    const resolved = this.codes.resolve(input)
    if ("message" in resolved) return resolved.message
    const { code, entry } = resolved
    const { applied, message } = await this.resolveDecision({
      notificationId: entry.notificationId,
      decision: input.decision
    })
    this.codes.settle(code, applied)
    if (!applied) return message
    return input.decision === "approve" ? "Human Gate 已批准。" : "Human Gate 已拒绝。"
  }

  async resolveCardDecision(input: {
    notificationId: string
    decision: "approve" | "reject"
  }): Promise<string | null> {
    const result = await this.resolveDecision(input)
    if (!result.applied) return result.message
    return null
  }

  private resolveDecision(input: { notificationId: string; decision: "approve" | "reject" }) {
    return decideNotification(
      { notificationId: input.notificationId, action: input.decision },
      { channel: "im" }
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
      kind: "human_gate",
      describeOutcome: (current, channelLabel) => {
        const approved = current.status === "resolved" && current.action === "approve"
        const rejected = current.status === "resolved" && current.action === "reject"
        return {
          outcome: approved
            ? `已批准（${channelLabel}）`
            : rejected
              ? `已拒绝（${channelLabel}）`
              : "已失效",
          outcomeStyle: approved ? "approved" : rejected ? "rejected" : "neutral"
        }
      }
    })
  }
}

export const imHumanGateAdapter = new ImHumanGateAdapter()

export function initializeImHumanGateChannel(): void {
  registerNotificationChannel(
    "im-human-gate",
    "im",
    {
      created: async (notification) => {
        const gate = projectHumanGate(notification)
        if (gate) await imHumanGateAdapter.publish(gate)
      },
      ended: (notification) => imHumanGateAdapter.endNotification(notification)
    },
    "human_gate"
  )
}
