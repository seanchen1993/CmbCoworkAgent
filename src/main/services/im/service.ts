import type { RemoteImEventV1 } from "../../../shared/im-gateway-contract"
import { ImConversationTurnQueue } from "./conversation-turn-queue"
import type { ImIngressResult } from "./ingress-sequencer"
import { ImIngressSequencer } from "./ingress-sequencer"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"
import { registerImInboxSchedulerGateway } from "./inbox-scheduler"
import { ImRemoteRunner, createImTurnQueueHandler } from "./remote-runner"
import { ImCommandRouter, parseImCommand } from "./command-router"
import { ImReplyClient } from "./reply-client"
import { getBuiltinRobotSettings } from "../../storage"
import { imSelectionContextStore } from "./selection-context"
import { imEventStore } from "./event-store"
import { buildImProactiveReplies, eventShortCode } from "./reply-segmentation"

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

  constructor(readonly gateway: ImGatewayClientPort = unavailableImGatewayClient) {
    this.unregisterSchedulerGateway = registerImInboxSchedulerGateway(gateway)
    this.runner = new ImRemoteRunner({ gateway })
    this.replyClient = new ImReplyClient(gateway)
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
          expectedDeviceEpoch: event.deviceEpoch,
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
          principalId: event.principalId,
          deviceEpoch: event.deviceEpoch
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
    return this.turnQueue.recoverAndStart()
  }

  abortCurrent(conversationKey: string, eventId?: string): boolean {
    return this.turnQueue.abortCurrentImEvent(conversationKey, eventId)
  }

  stop(): Promise<void> {
    this.unregisterSchedulerGateway()
    return this.turnQueue.stop()
  }
}
