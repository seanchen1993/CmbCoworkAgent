import {
  assertRemoteImEventV1,
  type RemoteImAckV1,
  type RemoteImEventV1
} from "../../../shared/im-gateway-contract"
import type { ImTargetSnapshot } from "./conversation-state"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventRecord, type ImEventStore } from "./event-store"
import { imInboxService, type ImInboxService } from "./inbox-service"
import { buildImEventReplies, eventShortCode } from "./reply-segmentation"
import { ImReplyClient } from "./reply-client"

export interface ImIngressResult {
  duplicate: boolean
  event: ImEventRecord
  acknowledgements: RemoteImAckV1[]
}

export interface ImIngressSequencerOptions {
  conversationState?: ImConversationStateStore
  eventStore?: ImEventStore
  inboxService?: ImInboxService
  resolveTarget?: (event: RemoteImEventV1) => Promise<ImTargetSnapshot>
  emitAcknowledgement?: (ack: RemoteImAckV1) => Promise<void>
  replyClient?: ImReplyClient
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

function acknowledgementForDelivery(
  storedEvent: ImEventRecord,
  delivery: RemoteImEventV1
): RemoteImAckV1 {
  return { ...acknowledgementForEvent(storedEvent), leaseId: delivery.lease.id }
}

export class ImIngressSequencer {
  private readonly conversationState: ImConversationStateStore
  private readonly eventStore: ImEventStore
  private readonly resolveTarget: (event: RemoteImEventV1) => Promise<ImTargetSnapshot>
  private readonly emitAcknowledgement?: (ack: RemoteImAckV1) => Promise<void>
  private readonly replyClient: ImReplyClient
  private readonly ingressTails = new Map<string, Promise<void>>()

  constructor(options: ImIngressSequencerOptions = {}) {
    this.conversationState = options.conversationState ?? imConversationStateStore
    this.eventStore = options.eventStore ?? imEventStore
    const inboxService = options.inboxService ?? imInboxService
    const validateManagedInbox = options.inboxService !== undefined
    this.resolveTarget =
      options.resolveTarget ??
      (async (event) => {
        // A target snapshot becomes immutable only after receiveEvent persists it.
        // For a brand-new delivery, repair a selection left pointing at a deleted
        // or revoked desktop Thread before creating that snapshot. Explicit retry
        // and replay paths still keep their original immutable targetSnapshot.
        const selected = this.conversationState.getSelectedTarget(event.conversationKey)
        if (selected?.state === "active") {
          if (!validateManagedInbox) {
            return selected.snapshot
          }
          if (!inboxService.hasThread(selected.snapshot.threadId)) {
            console.warn("[IM] Selected remote target Thread is missing; falling back to inbox", {
              conversationKey: event.conversationKey,
              targetId: selected.snapshot.targetId,
              targetKind: selected.snapshot.kind,
              threadId: selected.snapshot.threadId
            })
            if (selected.snapshot.kind !== "inbox") {
              await this.conversationState.updateTargetState(
                selected.snapshot.targetId,
                "suspended",
                "TARGET_THREAD_MISSING",
                { fallbackToInboxIfSelected: true }
              )
            }
          } else if (selected.snapshot.kind !== "inbox") {
            return selected.snapshot
          }
          // Production and integration callers pass the inbox service explicitly,
          // allowing ensureInbox to validate the local Thread boundary and rebuild
          // a missing inbox. Lightweight event-store tests may intentionally use
          // synthetic targets and therefore omit that validation dependency.
          return inboxService.ensureInbox({
            conversationKey: event.conversationKey,
            principalId: event.principalId
          })
        }
        if (selected) {
          console.warn("[IM] Selected remote target is unavailable; falling back to inbox", {
            conversationKey: event.conversationKey,
            targetId: selected.snapshot.targetId,
            targetState: selected.state,
            suspendReason: selected.suspendReason
          })
        }
        return inboxService.ensureInbox({
          conversationKey: event.conversationKey,
          principalId: event.principalId
        })
      })
    this.emitAcknowledgement = options.emitAcknowledgement
    this.replyClient = options.replyClient ?? new ImReplyClient()
  }

  receiveOrdinaryEvent(
    event: RemoteImEventV1,
    options: { targetSnapshot?: ImTargetSnapshot; retryOfEventId?: string } = {}
  ): Promise<ImIngressResult> {
    assertRemoteImEventV1(event)
    return this.runExclusive(event.conversationKey, async () => {
      await this.conversationState.ensureConversation({
        conversationKey: event.conversationKey,
        principalId: event.principalId
      })

      const existing = this.eventStore.getEvent(event.eventId)
      const snapshot =
        existing?.targetSnapshot ?? options.targetSnapshot ?? (await this.resolveTarget(event))
      const received = await this.eventStore.receiveEvent(event, snapshot, {
        ...(options.retryOfEventId ? { retryOfEventId: options.retryOfEventId } : {})
      })
      if (received.duplicate && received.event.state !== "received") {
        const ack = acknowledgementForDelivery(received.event, event)
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

  receiveControlEvent(
    event: RemoteImEventV1,
    handle: () => Promise<string>
  ): Promise<ImIngressResult> {
    assertRemoteImEventV1(event)
    return this.runExclusive(event.conversationKey, async () => {
      await this.conversationState.ensureConversation({
        conversationKey: event.conversationKey,
        principalId: event.principalId
      })
      const existing = this.eventStore.getEvent(event.eventId)
      const snapshot = existing?.targetSnapshot ?? (await this.resolveTarget(event))
      const received = await this.eventStore.receiveEvent(event, snapshot)
      if (received.duplicate && received.event.state !== "received") {
        await this.replyClient.sendPending()
        const ack = acknowledgementForDelivery(received.event, event)
        await this.emit(ack)
        return { duplicate: true, event: received.event, acknowledgements: [ack] }
      }

      const receivedAck: RemoteImAckV1 = {
        type: "received",
        eventId: received.event.eventId,
        leaseId: received.event.leaseId
      }
      await this.emit(receivedAck)
      let terminal: ImEventRecord
      try {
        const text = await handle()
        terminal = await this.eventStore.finalizeEventWithReplies({
          eventId: received.event.eventId,
          state: "completed",
          replies: buildImEventReplies({ event: received.event, text }),
          resultText: text,
          retryable: false
        })
      } catch (error) {
        console.error("[IM] Control command failed:", error)
        const text = `指令处理失败。事件短码：${eventShortCode(received.event.eventId)}。请在桌面查看详情。`
        terminal = await this.eventStore.finalizeEventWithReplies({
          eventId: received.event.eventId,
          state: "failed",
          replies: buildImEventReplies({ event: received.event, text }),
          resultText: text,
          reasonCode: "REMOTE_COMMAND_FAILED",
          retryable: false
        })
      }
      await this.replyClient.sendPending()
      const terminalAck = acknowledgementForEvent(terminal)
      await this.emit(terminalAck)
      return {
        duplicate: received.duplicate,
        event: terminal,
        acknowledgements: [receivedAck, terminalAck]
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
