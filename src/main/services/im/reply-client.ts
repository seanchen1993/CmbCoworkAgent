import { submitFormattedImReply } from "./submit-formatted-reply"
import type { RemoteImReplyFormat, RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
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

function toReply(record: ImReplyOutboxRecord, type: RemoteImReplyFormat): RemoteImReplyV1 {
  return {
    schemaVersion: 1,
    deliveryId: record.deliveryId,
    ...(record.eventId ? { eventId: record.eventId } : {}),
    conversationKey: record.conversationKey,
    idempotencyKey: record.idempotencyKey,
    segment: { index: record.segmentIndex, count: record.segmentCount },
    message: { type, content: record.content }
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

// All clients backed by one store share ownership of a conversation's active submission.
interface ConversationDrain {
  wake: boolean
  done: Promise<ImReplyDrainResult>
}
const activeDrains = new WeakMap<ImEventStore, Map<string, ConversationDrain>>()
const emptyResult = (): ImReplyDrainResult => ({ sent: 0, unknown: 0, failed: 0, deferred: 0 })

export class ImReplyClient {
  constructor(
    private readonly gateway: ImGatewayClientPort = unavailableImGatewayClient,
    private readonly eventStore: ImEventStore = imEventStore,
    private readonly now: () => number = Date.now,
    private readonly afterDrain?: (key?: string) => void
  ) {}

  async wakePending(): Promise<void> {
    const active = activeDrains.get(this.eventStore)
    for (const key of this.eventStore.pendingReplyConversations()) {
      if (!active?.has(key)) void this.sendPending(key).catch(error => console.warn("[IM] Reply remains queued:", error))
    }
  }

  async sendPending(conversationKey?: string): Promise<ImReplyDrainResult> {
    let active = activeDrains.get(this.eventStore)
    if (!active) {
      active = new Map()
      activeDrains.set(this.eventStore, active)
    }
    const keys = conversationKey ? [conversationKey]
      : new Set([...this.eventStore.pendingReplyConversations(), ...active.keys()])
    const drains = Array.from(keys, key => {
      const running = active.get(key)
      if (running) {
        running.wake = true
        return running.done
      }
      const lane: ConversationDrain = {
        wake: true,
        done: Promise.resolve().then(async () => {
          const result = emptyResult()
          try {
            while (lane.wake) {
              lane.wake = false
              await this.drainConversation(key, result)
            }
            return result
          } finally {
            active.delete(key)
            this.notifyDrained(key)
          }
        })
      }
      active.set(key, lane)
      return lane.done
    })
    if (!drains.length) this.notifyDrained()
    const total = emptyResult()
    for (const result of await Promise.all(drains)) {
      total.sent += result.sent
      total.unknown += result.unknown
      total.failed += result.failed
      total.deferred += result.deferred
    }
    return total
  }

  private notifyDrained(key?: string): void {
    try {
      this.afterDrain?.(key)
    } catch (error) {
      console.warn("[IM] Auxiliary switch cards deferred:", error)
    }
  }

  private async drainConversation(key: string, result: ImReplyDrainResult): Promise<void> {
    const records = this.eventStore.conversationOutbox(key)
    const deliveryStates = new Map<string, Map<number, ImReplyOutboxRecord["state"]>>()
    for (const record of records) {
      const states = deliveryStates.get(record.deliveryId) ?? new Map()
      states.set(record.segmentIndex, record.state)
      deliveryStates.set(record.deliveryId, states)
    }
    for (const record of records) {
      if (record.state === "sending") return
      if (record.state !== "pending") continue
      const states = deliveryStates.get(record.deliveryId)!
      let precedingSegmentsSent = true
      for (let index = 0; index < record.segmentIndex; index += 1) {
        if (states.get(index) !== "sent") {
          precedingSegmentsSent = false
          break
        }
      }
      if (!precedingSegmentsSent) continue
      if (record.nextAttemptAt !== null && record.nextAttemptAt > this.now()) return
      let release: (() => void) | undefined
      try {
        if (this.gateway.deliveryOrder) {
          release = await this.gateway.deliveryOrder.acquire(key, "reply", record.deliveryOrder ?? record.createdAt * 1024)
          if (!this.eventStore.isOutboxPending(record.outboxId)) continue
        }
        const outcome = await this.sendOne(record)
        result[outcome] += 1
        if (outcome === "deferred") return
        states.set(record.segmentIndex, outcome)
        if (this.gateway.deliveryOrder && outcome === "sent" && record.segmentIndex === record.segmentCount - 1)
          this.notifyDrained(key)
      } finally {
        release?.()
      }
    }
  }

  /**
   * Decided per send, not when the reply was queued: the connection a reply
   * leaves on — and so what the gateway accepts — can differ from the one it
   * was queued under. /文字模式 changes forms and notices, not the Agent's
   * answer: headings, lists and code should still render in that mode.
   */
  private wireFormat(record: ImReplyOutboxRecord): RemoteImReplyFormat {
    if (record.contentFormat !== "markdown") return "text"
    if (this.gateway.supportsMarkdownReplies?.() !== true) return "text"
    return "markdown"
  }

  /**
   * A markdown segment refused as a payload goes again at once as text.
   *
   * That refusal can only mean the connection agreed to something the gateway
   * does not accept after all — never that the reply is bad — and without this
   * it would count as permanent and the answer would never arrive. A refused
   * payload was not stored, so the text reuses the same idempotency key.
   */
  private async submit(
    record: ImReplyOutboxRecord,
    format: RemoteImReplyFormat
  ): Promise<ImReplySubmissionResult> {
    return submitFormattedImReply(this.gateway, toReply(record, format))
  }

  private async sendOne(
    record: ImReplyOutboxRecord
  ): Promise<"sent" | "unknown" | "failed" | "deferred"> {
    await this.eventStore.markOutboxSending(record.outboxId)
    try {
      const submitted: ImReplySubmissionResult = await this.submit(record, this.wireFormat(record))
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
