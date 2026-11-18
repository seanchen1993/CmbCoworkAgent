import type { BotWorkConversationRef } from "./conversation"

export type BotOrdinaryThreadRef = Extract<BotWorkConversationRef, { kind: "local_thread" }>
export interface BotThreadHistorySource {
  conversation: BotOrdinaryThreadRef
  messageId: string
}
export interface BotThreadListInput {
  query?: string
  workspacePath?: string
  cursor?: string
}
export interface BotThreadReadInput {
  conversation: BotOrdinaryThreadRef
  query?: string
  messageId?: string
  cursor?: string
}
export interface BotThreadRenameInput {
  conversation: BotOrdinaryThreadRef
  expectedTitle: string
  title: string
}
export interface BotThreadLinkInput {
  conversation: BotOrdinaryThreadRef
  title: string
  goal: string
}
export interface BotWorkUnlinkInput {
  workId: string
  expectedVersion: number
}
export interface BotThreadDeleteInput {
  conversation: BotOrdinaryThreadRef
  expectedTitle: string
}
export interface BotConversationDeleteReceipt {
  state: "deleted" | "cleanup_pending"
  deletedThreadId?: string
  botId?: string
  workId?: string
  error?: string
}
export interface BotConversationToolSource {
  taskId: string
  callId: string
  key: string
}
export interface BotConversationToolReceipt {
  workId: string
  version: number
  conversation: BotOrdinaryThreadRef
  state: "bound" | "detached"
}
export interface BotConversationToolsPort {
  link(botId: string, input: BotThreadLinkInput, source: BotConversationToolSource,
    signal: AbortSignal, assertLive: () => void): Promise<BotConversationToolReceipt>
  unlink(botId: string, input: BotWorkUnlinkInput, source: BotConversationToolSource,
    signal: AbortSignal, assertLive: () => void): Promise<BotConversationToolReceipt>
  deleteThread?(botId: string, input: BotThreadDeleteInput, source: BotConversationToolSource,
    signal: AbortSignal, assertLive: () => void): Promise<BotConversationDeleteReceipt>
  deleteWork?(botId: string, input: BotWorkUnlinkInput, source: BotConversationToolSource,
    signal: AbortSignal, assertLive: () => void): Promise<BotConversationDeleteReceipt>
}
export interface BotThreadSummary {
  conversation: BotOrdinaryThreadRef
  title: string
  workspacePath: string | null
  updatedAt: number
}
export interface BotThreadHistoryPage {
  thread: BotThreadSummary
  entries: Array<{
    source: BotThreadHistorySource
    href: string
    role: "user" | "assistant"
    ordinal: number
    text: string
    truncated: boolean
  }>
  nextCursor: string | null
  scanned: number
  coverage: "more" | "incomplete" | "exhausted"
}
export interface BotOrdinaryThreadsPort {
  list(input: BotThreadListInput): Promise<{
    items: BotThreadSummary[]; nextCursor: string | null; scanned: number
  }>
  read(input: BotThreadReadInput): Promise<BotThreadHistoryPage>
  resolve(source: BotThreadHistorySource): Promise<{ threadId: string; messageId: string; ordinal: number }>
  rename?(input: BotThreadRenameInput, commit: (apply: () => BotThreadSummary) => BotThreadSummary): Promise<BotThreadSummary>
}
export function botThreadHistoryHref(source: BotThreadHistorySource): string {
  return `#bot-thread-history/${encodeURIComponent(JSON.stringify(source))}`
}
export function parseBotThreadHistoryHref(href: string): BotThreadHistorySource | null {
  if (!href.startsWith("#bot-thread-history/") || href.length > 8192) return null
  try {
    const source = JSON.parse(decodeURIComponent(href.slice(20)))
    const ref = source?.conversation, stamp = ref?.incarnation
    if (ref?.kind !== "local_thread" || typeof ref.threadId !== "string" ||
        !ref.threadId || ref.threadId.length > 256 || !stamp ||
        (stamp.token !== null && (typeof stamp.token !== "string" || !stamp.token || stamp.token.length > 4096)) ||
        !Number.isSafeInteger(stamp.legacyCreatedAt) || stamp.legacyCreatedAt < 0 ||
        typeof source.messageId !== "string" || !source.messageId || source.messageId.length > 512) return null
    return { conversation: ref, messageId: source.messageId }
  } catch { return null }
}
