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
export interface BotMockSource {
  transport?: "im"
  /** Host-verified owner DM shares the personal thread; this turn still has text-only tools. */
  personal?: true
  bindingId: string
  grantVersion: number
  conversationId: string
  audienceKey: string
  eventId: string
  messageId: string
  senderId: string
}
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
  workId?: string
  text: string
  state: "pending" | "sending" | "sent" | "accepted" | "unknown" | "blocked"
  createdAt: number
}
export interface BotMockFeedEntry {
  id: string
  kind: "user" | "bot"
  text: string
  senderId: string
  replyToMessageId: string | null
  state: BotTaskState | BotMockOutbox["state"] | "ignored"
  workId?: string
  createdAt: number
}
export interface BotMockClient {
  binding(botId: string, bindingId: string): Promise<BotMockBinding>
  bindings(
    botId: string,
    before?: string
  ): Promise<{ items: BotMockBinding[]; before: string | null }>
  create(input: CreateBotMockBinding): Promise<BotMockBinding>
  revoke(botId: string, bindingId: string, expectedVersion: number): Promise<BotMockBinding>
  online(botId: string, bindingId: string, online: boolean): Promise<BotMockBinding>
  inject(input: BotMockEvent): Promise<BotMockEventReceipt>
  history(
    botId: string,
    bindingId: string,
    before?: string
  ): Promise<{ items: BotMockFeedEntry[]; before: string | null }>
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
