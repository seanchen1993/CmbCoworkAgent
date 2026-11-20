import { projectHumanGate } from "../../../shared/harness-notifications"
import {
  isNotificationPendingForTarget,
  type AppNotification
} from "../../../shared/app-notifications"
import { registerNotificationChannel } from "../notification-channels"
import { decideNotification } from "../notification-actions"
import { ImDecisionCodeRegistry } from "./decision-code-registry"
import { botInteractionRoutes, type BotInteractionRoute } from "./bot-interaction-route"
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
import {
  conversationSwitchedToText,
  ImWithheldTextNotices,
  type ImTextResendResult
} from "./withheld-text-notices"

const warn = (message: string, error?: unknown): void =>
  console.warn(`[IM] Human Gate: ${message}`, error ?? "")

function isOpenForIm(gateId: string): boolean {
  const current = notificationService.get(gateId)
  return isNotificationPendingForTarget(current, "im") && isNotificationVisible(current)
}

export class ImHumanGateAdapter {
  private readonly codes = new ImDecisionCodeRegistry("门禁")
  private readonly replies = createDecisionReplyDrainer("Human Gate")
  private readonly cardContexts = new Map<string, HarnessDecisionCardContext>()
  private readonly withheld = new ImWithheldTextNotices()
  private readonly botRoutes = new Map<string, BotInteractionRoute>()
  registerReplyDrainer = this.replies.register

  private routeValid(gateId: string) {
    const route = this.botRoutes.get(gateId)
    return !route || botInteractionRoutes.get(route.threadId) === route
  }

  /** See ImWithheldTextNotices: the notices whose cards went out instead. */
  async resendPendingAsText(conversationKey: string): Promise<ImTextResendResult> {
    const result = await this.withheld.resend({
      conversationKey,
      isOpen: (id) => isOpenForIm(id) && this.routeValid(id),
      closedReasonCode: "HUMAN_GATE_ALREADY_RESOLVED",
      warn
    })
    if (result.resent > 0) this.replies.drain()
    return result
  }

  async publish(gate: HarnessHumanGateSnapshot): Promise<void> {
    const bot = botInteractionRoutes.get(gate.sourceThreadId)
    const feature = bot?.featureGate
    if (
      botInteractionRoutes.has(gate.sourceThreadId) &&
      (!bot || !feature || feature.projectId !== gate.projectId || feature.slug !== gate.featureId)
    )
      return
    const route = bot ?? resolveImDecisionRoute(gate.sourceThreadId)
    if (!route) return
    if (bot) this.botRoutes.set(gate.gateId, bot)
    const code = this.codes.allocate({ notificationId: gate.gateId, ...route })
    const grant = feature
      ? null
      : imRemoteAccessService.getFeatureGrant(gate.projectId, gate.featureId)
    const ownGrant = grant?.principalId === route.principalId ? grant : null
    const visible = (text: string) => (feature ? feature.publicText(text) : text)
    const projectName = visible(
      feature?.projectName ?? ownGrant?.projectNameSnapshot ?? gate.projectId
    )
    const featureName = visible(
      feature?.featureName ?? ownGrant?.featureTitleSnapshot ?? gate.featureId
    )
    const threadTitle = visible(
      feature?.threadTitle ?? (getThread(gate.sourceThreadId)?.title?.trim() || "关联会话")
    )
    const message = visible(gate.message)
    const context: HarnessDecisionCardContext = { projectName, featureName, threadTitle }
    this.cardContexts.set(gate.gateId, context)
    const text = [
      bot?.kind === "group" ? "【项目阶段待确认】" : "【项目模式需要审批】",
      `项目：【${projectName}】`,
      `特性：【${featureName}】`,
      `来源会话：【${threadTitle}】`,
      "",
      message,
      "",
      bot?.kind === "group" ? "请在本群 @机器人，发送以下一条指令：" : "可选操作:",
      `/门禁批准 ${code}`,
      `/门禁拒绝 ${code}`
    ].join("\n")
    const notice = buildImProactiveReplies({
      deliveryId: `human-gate:${gate.gateId}`,
      conversationKey: route.conversationKey,
      text
    })
    let card
    try {
      card = await imCardPublisher.publish({
        kind: "human_gate",
        threadId: gate.sourceThreadId,
        principalId: route.principalId,
        conversationKey: route.conversationKey,
        requestRef: gate.gateId,
        targetLabel: `特性：${featureName}`,
        botEventId: bot?.botEventId,
      botBindingRef: bot?.botBindingRef,
        build: (tag) =>
          buildHumanGateCard({ ...context, message, tag, group: bot?.kind === "group" })
      })
    } catch (error) {
      warn("无法创建阶段确认卡片，改发文字指令。", error)
    }
    if (bot && !this.routeValid(gate.gateId)) {
      if (isOpenForIm(gate.gateId)) feature?.onUndeliverable(gate.gateId)
      return
    }
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
        return
      }
      // Kept for /文字模式: the reader may find the card cut short by the
      // client and ask for this instead — or already has, while the card was
      // in flight, and then it is handed over now.
      this.withheld.withhold(gate.gateId, notice)
      if (conversationSwitchedToText(route.conversationKey, warn)) {
        await this.resendPendingAsText(route.conversationKey)
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
      const queued = await imEventStore.enqueueProactiveReplies(notice)
      if (bot && (!isOpenForIm(gate.gateId) || !this.routeValid(gate.gateId))) {
        await Promise.all(
          queued.map((row) =>
            imEventStore.markOutboxFailed(row.outboxId, "HUMAN_GATE_ROUTE_CLOSED")
          )
        )
        if (isOpenForIm(gate.gateId)) feature?.onUndeliverable(gate.gateId)
        return
      }
      this.replies.drain()
    } catch (error) {
      this.codes.removeNotification(gate.gateId)
      this.cardContexts.delete(gate.gateId)
      if (bot && isOpenForIm(gate.gateId)) feature?.onUndeliverable(gate.gateId)
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
      decision: input.decision,
      principalId: input.principalId,
      conversationKey: input.conversationKey
    })
    this.codes.settle(code, applied)
    if (!applied) return message
    return input.decision === "approve" ? "Human Gate 已批准。" : "Human Gate 已拒绝。"
  }

  async resolveCardDecision(input: {
    notificationId: string
    decision: "approve" | "reject"
    principalId: string
    conversationKey: string
  }): Promise<string | null> {
    const result = await this.resolveDecision(input)
    if (!result.applied) return result.message
    return null
  }

  private resolveDecision(input: {
    notificationId: string
    decision: "approve" | "reject"
    principalId: string
    conversationKey: string
  }) {
    const route = this.botRoutes.get(input.notificationId)
    const isCurrent =
      route &&
      (() =>
        botInteractionRoutes.get(route.threadId) === route &&
        route.principalId === input.principalId &&
        route.conversationKey === input.conversationKey)
    if (isCurrent && !isCurrent())
      return { applied: false, message: "原招乎绑定或项目执行已失效，请在 App 中查看。" }
    return decideNotification(
      { notificationId: input.notificationId, action: input.decision },
      { channel: "im", isCurrent }
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
