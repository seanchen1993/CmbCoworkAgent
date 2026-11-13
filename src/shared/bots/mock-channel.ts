import type { BotTask, BotTaskState } from "./contracts"

/** Development simulation only. These DTOs never extend production RemoteImEventV1. */
export interface BotMockBinding {
  simulation: true
  id: string
  botId: string
  kind: "dm" | "group"
  channelKey: string
  label: string
  allowedSenderIds: string[]
  grantVersion: number
  revoked: boolean
  online: boolean
  createdAt: number
}
/** Persisted external source; omitted transport identifies existing local simulations. */
interface BotChannelScope {
  bindingId: string
  grantVersion: number
  conversationId: string
  audienceKey: string
}
interface BotInboundSource extends BotChannelScope {
  transport?: "im"
  /** Host-verified owner DM shares the personal thread and local Bot capabilities. */
  personal?: true
  desktopWorkId?: never
  desktopMessageId?: never
  eventId: string
  messageId: string
  senderId: string
}
/** Desktop-created group work has no upstream event or sender. Its work row is the receipt. */
interface BotDesktopGroupSource extends BotChannelScope {
  transport: "im"
  desktopWorkId: string
  desktopMessageId?: never
  personal?: never
  eventId?: never
  messageId?: never
  senderId?: never
}
/** App-originated handoff, proven by a durable receipt rather than a fabricated IM event. */
interface BotDesktopMessageSource extends BotChannelScope {
  transport: "im"
  desktopMessageId: string
  desktopWorkId?: never
  personal?: never
  eventId?: never
  messageId?: never
  senderId?: never
}
export type BotMockSource = BotInboundSource | BotDesktopGroupSource | BotDesktopMessageSource
export interface CreateBotMockBinding {
  simulation: true
  botId: string
  operationId: string
  kind: "dm" | "group"
  channelKey: string
  label: string
  allowedSenderIds: string[]
}
export interface BotMockEvent {
  simulation: true
  bindingId: string
  eventId: string
  messageId: string
  senderId: string
  text: string
  mentionsBotIds: string[]
  replyToMessageId?: string
}
export interface BotMockEventReceipt {
  eventId: string
  status: "accepted" | "ignored"
  taskId: string | null
  reason: string | null
}
export interface BotMockOutbox {
  id: string
  botId: string
  bindingId: string
  conversationId: string
  replyToMessageId: string
  sourceTaskId: string
  fileDeliveryId?: string
  progress?: number
  reasonCode?: string
  retryRequested?: boolean
  receiptVersion?: number
  files?: import("./file-delivery").BotDeliveredFile[]
  workId?: string
  text: string
  state: "pending" | "sending" | "sent" | "accepted" | "unknown" | "blocked" | "failed"
  createdAt: number
}
export interface BotMockFeedEntry {
  files?: import("./file-delivery").BotDeliveredFile[]
  threadId?: string
  delivery?: BotFileDeliveryStatus
  id: string
  kind: "user" | "bot"
  text: string
  senderId: string
  replyToMessageId: string | null
  state: BotTaskState | BotMockOutbox["state"] | "ignored"
  workId?: string
  createdAt: number
}
export interface BotMockExecution {
  source: BotMockSource
  threadId: string
  threadInitialized: boolean
  label: string
}
export interface BotMockTransport {
  /** Only this simulated transport boundary may be replaced by a fault fixture. No production sender. */
  send(reply: BotMockOutbox): Promise<"sent" | "unknown">
}
export type BotMockTask = BotTask & { mockSource: BotMockSource }

/** Local projection; never contains platform URLs or recipient credentials. */
export interface BotFileDeliveryStatus {
  id: string
  file: import("./file-delivery").BotDeliveredFile
  state: BotMockOutbox["state"]
  progress: number
  reasonCode?: string
}
