import type {
  GatewayReasonCodeV1,
  RemoteImAckV1,
  RemoteImCardSendV1,
  RemoteImCardUpdateV1,
  RemoteImReplyV1
} from "../../../shared/im-gateway-contract"
import type { ImEventRecord } from "./event-store"

export interface ImExecutionPermitResult {
  status: "granted" | "denied"
  leaseId?: string
  expiresAt?: string
  reasonCode?: GatewayReasonCodeV1 | string
}

export interface ImReplySubmissionResult {
  state: "accepted" | "platform_unknown"
  platformReplyId?: string
}

/**
 * A card is an enhancement, so its submission result never has to be believed
 * for a gate to stay answerable — "rejected" here only means the reader keeps
 * using the short code that was published alongside it.
 */
export interface ImCardSubmissionResult {
  state: "accepted" | "rejected"
  reasonCode?: GatewayReasonCodeV1 | string
}

/**
 * Frozen client-side port for Gateway G0/G1. The production WSS adapter owns
 * authentication and the active desktop session; local services never receive
 * platform credentials or choose a route themselves.
 */
export interface ImGatewayClientPort {
  isAuthenticated(): boolean
  sendAcknowledgement(ack: RemoteImAckV1): Promise<void>
  acquireExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult>
  renewExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult>
  submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult>
  sendCard(card: RemoteImCardSendV1): Promise<ImCardSubmissionResult>
  updateCard(update: RemoteImCardUpdateV1): Promise<ImCardSubmissionResult>
  acknowledgeCardReceipt(receiptId: string): Promise<void>
}

export class ImGatewayUnavailableError extends Error {
  constructor(message = "Unified IM gateway is not connected") {
    super(message)
    this.name = "ImGatewayUnavailableError"
  }
}

/** Deliberately fails closed until the production Gateway G0 transport is wired. */
export const unavailableImGatewayClient: ImGatewayClientPort = {
  isAuthenticated: () => false,
  sendAcknowledgement: async () => {
    throw new ImGatewayUnavailableError()
  },
  acquireExecutionPermit: async () => ({ status: "denied", reasonCode: "DESKTOP_OFFLINE" }),
  renewExecutionPermit: async () => ({ status: "denied", reasonCode: "DESKTOP_OFFLINE" }),
  submitReply: async () => {
    throw new ImGatewayUnavailableError()
  },
  sendCard: async () => ({ state: "rejected", reasonCode: "DESKTOP_OFFLINE" }),
  updateCard: async () => ({ state: "rejected", reasonCode: "DESKTOP_OFFLINE" }),
  acknowledgeCardReceipt: async () => {
    throw new ImGatewayUnavailableError()
  }
}
