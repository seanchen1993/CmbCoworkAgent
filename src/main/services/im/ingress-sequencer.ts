import {
  assertRemoteImEventV1,
  type RemoteImAckV1,
  type RemoteImEventV1
} from "../../../shared/im-gateway-contract"
import type { ImTargetSnapshot } from "./conversation-state"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventRecord, type ImEventStore } from "./event-store"

export interface ImIngressResult {
  duplicate: boolean
  event: ImEventRecord
  acknowledgements: RemoteImAckV1[]
}

export interface ImIngressSequencerOptions {
  conversationState?: ImConversationStateStore
  eventStore?: ImEventStore
  resolveTarget?: (event: RemoteImEventV1) => Promise<ImTargetSnapshot>
  emitAcknowledgement?: (ack: RemoteImAckV1) => Promise<void>
}

function acknowledgementForEvent(event: ImEventRecord): RemoteImAckV1 {
  const common = { eventId: event.eventId, leaseId: event.leaseId }
  switch (event.state) {
    case "received":
      return { type: "received", ...common }
    case "queued":
    case "executing":
      return { type: "accepted", ...common }
    case "waiting_desktop":
      return { type: "waiting_desktop", ...common }
    case "completed":
      return { type: "completed", ...common }
    case "cancelled":
      return { type: "cancelled", ...common }
    case "failed":
    case "rejected":
    case "outcome_unknown":
      return {
        type: "failed",
        ...common,
        retryable: event.retryable === true,
        reasonCode:
          event.reasonCode ??
          (event.state === "outcome_unknown" ? "EVENT_OUTCOME_UNKNOWN" : "REMOTE_EVENT_FAILED")
      }
  }
}

export class ImIngressSequencer {
  private readonly conversationState: ImConversationStateStore
  private readonly eventStore: ImEventStore
  private readonly resolveTarget: (event: RemoteImEventV1) => Promise<ImTargetSnapshot>
  private readonly emitAcknowledgement?: (ack: RemoteImAckV1) => Promise<void>
  private readonly ingressTails = new Map<string, Promise<void>>()

  constructor(options: ImIngressSequencerOptions = {}) {
    this.conversationState = options.conversationState ?? imConversationStateStore
    this.eventStore = options.eventStore ?? imEventStore
    this.resolveTarget =
      options.resolveTarget ??
      (async (event) => {
        const target = this.conversationState.getActiveTarget(event.conversationKey)
        if (!target) throw new Error("Conversation has no active IM target")
        return target
      })
    this.emitAcknowledgement = options.emitAcknowledgement
  }

  receiveOrdinaryEvent(event: RemoteImEventV1): Promise<ImIngressResult> {
    assertRemoteImEventV1(event)
    return this.runExclusive(event.conversationKey, async () => {
      await this.conversationState.ensureConversation({
        conversationKey: event.conversationKey,
        principalId: event.principalId,
        deviceEpoch: event.deviceEpoch
      })

      const existing = this.eventStore.getEvent(event.eventId)
      const snapshot = existing?.targetSnapshot ?? (await this.resolveTarget(event))
      const received = await this.eventStore.receiveEvent(event, snapshot)
      if (received.duplicate && received.event.state !== "received") {
        const ack = acknowledgementForEvent(received.event)
        await this.emit(ack)
        return { duplicate: true, event: received.event, acknowledgements: [ack] }
      }

      const receivedAck: RemoteImAckV1 = {
        type: "received",
        eventId: received.event.eventId,
        leaseId: received.event.leaseId
      }
      await this.emit(receivedAck)
      const queued = await this.eventStore.queueEvent(received.event.eventId)
      const acceptedAck: RemoteImAckV1 = {
        type: "accepted",
        eventId: queued.eventId,
        leaseId: queued.leaseId
      }
      await this.emit(acceptedAck)
      return {
        duplicate: received.duplicate,
        event: queued,
        acknowledgements: [receivedAck, acceptedAck]
      }
    })
  }

  private async emit(ack: RemoteImAckV1): Promise<void> {
    await this.emitAcknowledgement?.(ack)
  }

  private runExclusive<T>(conversationKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.ingressTails.get(conversationKey) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior.catch(() => undefined).then(() => current)
    this.ingressTails.set(conversationKey, tail)

    return prior
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release()
        if (this.ingressTails.get(conversationKey) === tail) {
          this.ingressTails.delete(conversationKey)
        }
      })
  }
}
