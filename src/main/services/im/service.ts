import type { RemoteImEventV1 } from "../../../shared/im-gateway-contract"
import { ImConversationTurnQueue } from "./conversation-turn-queue"
import type { ImIngressResult } from "./ingress-sequencer"
import { ImIngressSequencer } from "./ingress-sequencer"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"
import { registerImInboxSchedulerGateway } from "./inbox-scheduler"
import { ImRemoteRunner, createImTurnQueueHandler, setRemoteThreadLifecycle } from "./remote-runner"
import { ImCommandRouter, parseImCommand } from "./command-router"
import { ImReplyClient } from "./reply-client"
import { getBuiltinRobotSettings } from "../../storage"
import { imSelectionContextStore } from "./selection-context"
import { imEventStore } from "./event-store"
import { buildImProactiveReplies, eventShortCode } from "./reply-segmentation"
import { registerImDesktopCompletionReplyDrainer } from "./desktop-completion"
import { imRemoteApprovalService } from "./remote-approval-service"

/**
 * Headless orchestration boundary used by the production WSS adapter and the
 * contract test harness. Ingress returns after durable received/accepted ACKs;
 * the Agent turn drains asynchronously so a long turn never blocks later
 * control-channel delivery.
 */
export class ImUnifiedBotService {
  readonly runner: ImRemoteRunner
  readonly ingress: ImIngressSequencer
  readonly turnQueue: ImConversationTurnQueue
  readonly commandRouter: ImCommandRouter
  readonly replyClient: ImReplyClient
  private readonly unregisterSchedulerGateway: () => void
  private readonly unregisterDesktopCompletionReplyDrainer: () => void
  private readonly unregisterRemoteApprovalReplyDrainer: () => void
  private outboxRetryTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly gateway: ImGatewayClientPort = unavailableImGatewayClient,
    options: { waitingDesktopTtlMs?: number } = {}
  ) {
    this.replyClient = new ImReplyClient(gateway)
    this.unregisterSchedulerGateway = registerImInboxSchedulerGateway(gateway, this.replyClient)
    this.unregisterDesktopCompletionReplyDrainer = registerImDesktopCompletionReplyDrainer(
      this.replyClient
    )
    this.unregisterRemoteApprovalReplyDrainer = imRemoteApprovalService.registerReplyDrainer(
      this.replyClient
    )
    this.runner = new ImRemoteRunner({
      gateway,
      replyClient: this.replyClient,
      ...(options.waitingDesktopTtlMs ? { waitingDesktopTtlMs: options.waitingDesktopTtlMs } : {})
    })
    this.ingress = new ImIngressSequencer({
      emitAcknowledgement: (ack) => gateway.sendAcknowledgement(ack),
      replyClient: this.replyClient
    })
    this.turnQueue = new ImConversationTurnQueue(createImTurnQueueHandler(this.runner))
    this.commandRouter = new ImCommandRouter({
      abortCurrent: (conversationKey) => this.turnQueue.abortCurrentImEvent(conversationKey),
      getCurrentEventId: (conversationKey) => this.turnQueue.getCurrentEventId(conversationKey)
    })
  }

  async receiveEvent(event: RemoteImEventV1): Promise<ImIngressResult> {
    const command = parseImCommand(event.message.text)
    const settings = getBuiltinRobotSettings()
    if (!settings.enabled) {
      return this.ingress.receiveControlEvent(event, async () => "本设备的内置机器人已断开。")
    }
    if (command?.name === "retry") {
      const resolved = this.commandRouter.resolveRetryEvent(event.conversationKey, command.argument)
      if ("message" in resolved) {
        return this.ingress.receiveControlEvent(event, async () => resolved.message)
      }
      const original = resolved.event
      const retryEvent: RemoteImEventV1 = {
        ...event,
        message: { type: "text", text: original.messageText }
      }
      const result = await this.ingress.receiveOrdinaryEvent(retryEvent, {
        targetSnapshot: original.targetSnapshot!,
        retryOfEventId: original.eventId
      })
      const code = eventShortCode(original.eventId)
      await imEventStore.enqueueProactiveReplies(
        buildImProactiveReplies({
          deliveryId: `${event.eventId}:retry-warning`,
          conversationKey: event.conversationKey,
          text: `已按你的明确指令重试事件 ${code}。原事件结果未知，文件或外部副作用可能重复，请核对。`
        })
      )
      await this.replyClient.sendPending()
      if (result.event.state === "queued") {
        void this.turnQueue.notify(event.conversationKey).catch((error) => {
          console.error("[IM] Retry queue failed:", error)
        })
      }
      return result
    }
    if (command) {
      return this.ingress.receiveControlEvent(event, () =>
        this.commandRouter.handle({
          command,
          conversationKey: event.conversationKey,
          principalId: event.principalId
        })
      )
    }
    return this.receiveOrdinaryEvent(event)
  }

  async receiveOrdinaryEvent(event: RemoteImEventV1): Promise<ImIngressResult> {
    const result = await this.ingress.receiveOrdinaryEvent(event)
    if (result.event.state === "queued") {
      void this.turnQueue.notify(event.conversationKey).catch((error) => {
        console.error("[IM] Conversation queue failed:", error)
      })
    }
    return result
  }

  async recoverAndStart(): Promise<string[]> {
    // Numbered selection lists are intentionally session-local. A restart must
    // never let an old number bind to a newly reordered project/Feature list.
    await imSelectionContextStore.clearAll()
    await imEventStore.cleanupExpiredTerminalData()
    await imEventStore.recoverInterruptedOutbox()
    const recovered = await this.turnQueue.recoverAndStart(async (eventIds) => {
      await Promise.all(
        eventIds.map(async (eventId) => {
          const event = imEventStore.getEvent(eventId)
          if (event) await setRemoteThreadLifecycle(event, "outcome_unknown")
        })
      )
    })
    this.startOutboxRetryLoop()
    return recovered
  }

  abortCurrent(conversationKey: string, eventId?: string): boolean {
    return this.turnQueue.abortCurrentImEvent(conversationKey, eventId)
  }

  hasActiveRuns(): boolean {
    return this.turnQueue.hasActiveRuns()
  }

  async resumeQueued(): Promise<void> {
    await this.replyClient.sendPending()
    await Promise.all(
      imEventStore.listQueuedConversationKeys().map((key) => this.turnQueue.notify(key))
    )
  }

  async handleLeaseRevoked(eventId: string, reasonCode = "LEASE_REVOKED"): Promise<void> {
    if (this.runner.revokeExecutionPermit(eventId, reasonCode)) return
    const event = imEventStore.getEvent(eventId)
    if (!event) return
    const terminal = await imEventStore.handlePermitRevoked(eventId, reasonCode)
    if (terminal.state === "outcome_unknown") {
      await setRemoteThreadLifecycle(terminal, "outcome_unknown")
    }
  }

  stop(): Promise<void> {
    if (this.outboxRetryTimer) clearInterval(this.outboxRetryTimer)
    this.outboxRetryTimer = undefined
    this.unregisterSchedulerGateway()
    this.unregisterDesktopCompletionReplyDrainer()
    this.unregisterRemoteApprovalReplyDrainer()
    return this.turnQueue.stop()
  }

  private startOutboxRetryLoop(): void {
    if (this.outboxRetryTimer) return
    this.outboxRetryTimer = setInterval(() => {
      if (!this.gateway.isAuthenticated()) return
      void this.replyClient.sendPending().catch(() => undefined)
    }, 1_000)
    this.outboxRetryTimer.unref?.()
  }
}
