import type { RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
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
    expectedDeviceEpoch: record.expectedDeviceEpoch,
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

export class ImReplyClient {
  constructor(
    private readonly gateway: ImGatewayClientPort = unavailableImGatewayClient,
    private readonly eventStore: ImEventStore = imEventStore,
    private readonly now: () => number = Date.now
  ) {}

  async sendPending(): Promise<{
    sent: number
    unknown: number
    failed: number
    deferred: number
  }> {
    const result = { sent: 0, unknown: 0, failed: 0, deferred: 0 }
    const candidates = this.eventStore
      .listOutbox("pending")
      .filter((record) => record.nextAttemptAt === null || record.nextAttemptAt <= this.now())
    for (const record of candidates) {
      const outcome = await this.sendOne(record)
      result[outcome] += 1
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
        return "unknown"
      }
      await this.eventStore.markOutboxSent(
        record.outboxId,
        submitted.platformReplyId?.trim() || `gateway:${record.idempotencyKey}`
      )
      return "sent"
    } catch (error) {
      const details = errorDetails(error)
      if (details.resultUnknown) {
        await this.eventStore.markOutboxUnknown(record.outboxId, details.reasonCode)
        return "unknown"
      }
      if (details.permanent) {
        await this.eventStore.markOutboxFailed(record.outboxId, details.reasonCode)
        return "failed"
      }
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(record.attemptCount, 6))
      await this.eventStore.rescheduleOutbox(
        record.outboxId,
        this.now() + delayMs,
        details.reasonCode
      )
      return "deferred"
    }
  }
}
