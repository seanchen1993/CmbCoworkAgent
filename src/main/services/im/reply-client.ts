import type { RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
import { trackEvent } from "../event-reporter"
import { imEventStore, type ImEventStore, type ImReplyOutboxRecord } from "./event-store"
import {
  unavailableImGatewayClient,
  type ImGatewayClientPort,
  type ImReplySubmissionResult
} from "./gateway-client"

export interface ImReplySendError extends Error {
  /** True when the gateway may already have durably accepted the reply. */
  resultUnknown?: boolean
  /** Stable gateway/platform reason code when available. */
  reasonCode?: string
  /** A current route/epoch rejection is permanent for this outbox envelope. */
  permanent?: boolean
}

function toReply(record: ImReplyOutboxRecord): RemoteImReplyV1 {
  return {
    schemaVersion: 1,
    deliveryId: record.deliveryId,
    ...(record.eventId ? { eventId: record.eventId } : {}),
    conversationKey: record.conversationKey,
    idempotencyKey: record.idempotencyKey,
    segment: { index: record.segmentIndex, count: record.segmentCount },
    message: { type: "text", content: record.content }
  }
}

function errorDetails(error: unknown): {
  reasonCode: string
  resultUnknown: boolean
  permanent: boolean
} {
  const candidate = error as Partial<ImReplySendError> | null
  return {
    reasonCode: candidate?.reasonCode?.trim() || "GATEWAY_REPLY_FAILED",
    resultUnknown: candidate?.resultUnknown === true,
    permanent: candidate?.permanent === true
  }
}

export interface ImReplyDrainResult {
  sent: number
  unknown: number
  failed: number
  deferred: number
}

// Scheduler, ingress and Agent completion can all request an outbox drain.
// Serialize by store rather than by client instance so those entry points can
// never submit the same durable segment concurrently.
const activeDrains = new WeakMap<ImEventStore, Promise<ImReplyDrainResult>>()

export class ImReplyClient {
  constructor(
    private readonly gateway: ImGatewayClientPort = unavailableImGatewayClient,
    private readonly eventStore: ImEventStore = imEventStore,
    private readonly now: () => number = Date.now
  ) {}

  async sendPending(): Promise<ImReplyDrainResult> {
    const active = activeDrains.get(this.eventStore)
    if (active) return active
    const drain = this.drainPending().finally(() => {
      if (activeDrains.get(this.eventStore) === drain) activeDrains.delete(this.eventStore)
    })
    activeDrains.set(this.eventStore, drain)
    return drain
  }

  private async drainPending(): Promise<ImReplyDrainResult> {
    const result = { sent: 0, unknown: 0, failed: 0, deferred: 0 }
    const records = this.eventStore.listOutbox()
    const deliveryStates = new Map<string, Map<number, ImReplyOutboxRecord["state"]>>()
    for (const record of records) {
      const states = deliveryStates.get(record.deliveryId) ?? new Map()
      states.set(record.segmentIndex, record.state)
      deliveryStates.set(record.deliveryId, states)
    }
    for (const record of records) {
      if (
        record.state !== "pending" ||
        (record.nextAttemptAt !== null && record.nextAttemptAt > this.now())
      ) {
        continue
      }
      const states = deliveryStates.get(record.deliveryId)!
      let precedingSegmentsSent = true
      for (let index = 0; index < record.segmentIndex; index += 1) {
        if (states.get(index) !== "sent") {
          precedingSegmentsSent = false
          break
        }
      }
      if (!precedingSegmentsSent) continue
      const outcome = await this.sendOne(record)
      result[outcome] += 1
      states.set(
        record.segmentIndex,
        outcome === "sent"
          ? "sent"
          : outcome === "unknown"
            ? "unknown"
            : outcome === "failed"
              ? "failed"
              : "pending"
      )
    }
    return result
  }

  private async sendOne(
    record: ImReplyOutboxRecord
  ): Promise<"sent" | "unknown" | "failed" | "deferred"> {
    await this.eventStore.markOutboxSending(record.outboxId)
    try {
      const submitted: ImReplySubmissionResult = await this.gateway.submitReply(toReply(record))
      if (submitted.state === "platform_unknown") {
        await this.eventStore.markOutboxUnknown(record.outboxId, "PLATFORM_RESULT_UNKNOWN")
        return this.reportDelivery(record, "unknown")
      }
      await this.eventStore.markOutboxSent(
        record.outboxId,
        submitted.platformReplyId?.trim() || `gateway:${record.idempotencyKey}`
      )
      return this.reportDelivery(record, "sent")
    } catch (error) {
      const details = errorDetails(error)
      if (details.resultUnknown) {
        await this.eventStore.markOutboxUnknown(record.outboxId, details.reasonCode)
        return this.reportDelivery(record, "unknown")
      }
      if (details.permanent) {
        await this.eventStore.markOutboxFailed(record.outboxId, details.reasonCode)
        return this.reportDelivery(record, "failed")
      }
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(record.attemptCount, 6))
      await this.eventStore.rescheduleOutbox(
        record.outboxId,
        this.now() + delayMs,
        details.reasonCode
      )
      // Deliberately unreported. A deferred send is a retry of the same message,
      // and this envelope comes back through here until it settles — counting it
      // would report one message as several.
      return "deferred"
    }
  }

  /**
   * The one place every outbound text message leaves for Zhaohu.
   *
   * `kind` comes from the envelope's own eventId rather than from the caller:
   * a reply to an inbound event carries one, and a proactive delivery is
   * inserted with event_id NULL. That is the distinction worth showing — the
   * robot answering what it was asked, versus pushing a background result back
   * on its own.
   */
  private reportDelivery<T extends "sent" | "unknown" | "failed">(
    record: ImReplyOutboxRecord,
    outcome: T
  ): T {
    trackEvent("im.message.delivered", "im", {
      direction: "outbound",
      kind: record.eventId ? "reply" : "push",
      outcome
    })
    return outcome
  }
}
