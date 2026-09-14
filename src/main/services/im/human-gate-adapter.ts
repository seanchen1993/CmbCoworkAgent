import { projectHumanGate } from "../../../shared/harness-notifications"
import { registerNotificationChannel } from "../notification-channels"
import { decideNotification } from "../notification-actions"
import { ImDecisionCodeRegistry } from "./decision-code-registry"
import { createDecisionReplyDrainer, resolveImDecisionRoute } from "./decision-delivery"
import { getThread } from "../../db"
import type { HarnessHumanGateSnapshot } from "../../../shared/harness-board-types"
import { imEventStore } from "./event-store"
import { imRemoteAccessService } from "./remote-access-service"
import { buildImProactiveReplies } from "./reply-segmentation"

export class ImHumanGateAdapter {
  private readonly codes = new ImDecisionCodeRegistry("门禁")
  private readonly replies = createDecisionReplyDrainer("Human Gate")
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
    const text = [
      `【项目模式需要审批】`,
      `项目：【${projectName}】`,
      `特性：【${featureName}】`,
      `来源会话：【${threadTitle}】`,
      "",
      gate.message,
      "",
      "可选操作:",
      `/批准推进阶段 ${code}`,
      `/拒绝 ${code}`
    ].join("\n")
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
    const { applied, message } = await decideNotification(
      { notificationId: entry.notificationId, action: input.decision },
      { channel: "im" }
    )
    this.codes.settle(code, applied)
    if (!applied) return message
    return input.decision === "approve" ? "Human Gate 已批准。" : "Human Gate 已拒绝。"
  }

  removeGate(gateId: string): void {
    this.codes.removeNotification(gateId)
  }
}

export const imHumanGateAdapter = new ImHumanGateAdapter()

export function initializeImHumanGateChannel(): void {
  registerNotificationChannel("im-human-gate", "im", {
    created: async (notification) => {
      const gate = projectHumanGate(notification)
      if (gate) await imHumanGateAdapter.publish(gate)
    },
    ended: (notification) => imHumanGateAdapter.removeGate(notification.notificationId)
  }, "human_gate")
}
