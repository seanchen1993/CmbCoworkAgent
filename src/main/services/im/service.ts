import type { RemoteImEventV1 } from "../../../shared/im-gateway-contract"
import { ImConversationTurnQueue } from "./conversation-turn-queue"
import type { ImIngressResult } from "./ingress-sequencer"
import { ImIngressSequencer } from "./ingress-sequencer"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"
import { registerImInboxSchedulerGateway } from "./inbox-scheduler"
import { ImRemoteRunner, createImTurnQueueHandler } from "./remote-runner"

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
  private readonly unregisterSchedulerGateway: () => void

  constructor(readonly gateway: ImGatewayClientPort = unavailableImGatewayClient) {
    this.unregisterSchedulerGateway = registerImInboxSchedulerGateway(gateway)
    this.runner = new ImRemoteRunner({ gateway })
    this.ingress = new ImIngressSequencer({
      emitAcknowledgement: (ack) => gateway.sendAcknowledgement(ack)
    })
    this.turnQueue = new ImConversationTurnQueue(createImTurnQueueHandler(this.runner))
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

  recoverAndStart(): Promise<string[]> {
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
