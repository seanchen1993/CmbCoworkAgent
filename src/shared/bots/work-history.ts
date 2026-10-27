import type { BotWorkItem } from "./work"

export interface BotWorkHistorySource {
  workId: string
  messageId: string
  /** Pins the original thread incarnation; never a model-selected thread ID. */
  incarnation: string
}
export interface BotWorkHistoryEntry {
  source: BotWorkHistorySource
  href: string
  role: "user" | "assistant"
  createdAt: number
  ordinal: number
  text: string
  truncated: boolean
}
export interface BotWorkHistoryPage {
  work: { id: string; title: string; goal: string }
  entries: BotWorkHistoryEntry[]
  nextCursor: string | null
  scanned: number
  truncated: boolean
  /** A bounded page is not a statement that the entire conversation was searched. */
  coverage: "more" | "exhausted" | "incomplete"
}
export interface BotWorkHistoryInput {
  workId: string
  query?: string
  messageId?: string
  cursor?: string
}
export interface BotWorkAssociation {
  workId: string
  title: string
  goal: string
  createdAt: number
}
export interface BotWorkHistoryPort {
  query(work: BotWorkItem, input: BotWorkHistoryInput): Promise<BotWorkHistoryPage>
  resolve(
    work: BotWorkItem,
    source: BotWorkHistorySource
  ): Promise<{ threadId: string; messageId: string; ordinal: number }>
}

export function botWorkHistoryHref(source: BotWorkHistorySource): string {
  return (
    "#bot-history/" +
    [source.workId, source.messageId, source.incarnation].map(encodeURIComponent).join("/")
  )
}
export function parseBotWorkHistoryHref(href: string): BotWorkHistorySource | null {
  if (!href.startsWith("#bot-history/") || href.length > 2048) return null
  try {
    const parts = href.slice(13).split("/").map(decodeURIComponent)
    if (parts.length !== 3 || parts.some((part) => !part || part.length > 512)) return null
    return { workId: parts[0], messageId: parts[1], incarnation: parts[2] }
  } catch {
    return null
  }
}
