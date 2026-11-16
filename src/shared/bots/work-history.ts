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
export interface BotWorkHistoryTarget {
  threadId: string
  messageId: string
  ordinal: number
  detached?: true
}
export interface BotWorkHistoryPort {
  query(work: BotWorkItem, input: BotWorkHistoryInput): Promise<BotWorkHistoryPage>
  resolve(
    work: BotWorkItem,
    source: BotWorkHistorySource
  ): Promise<BotWorkHistoryTarget>
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

/** An exact retained attachment, resolved through its original work identity before file authorization. */
export interface BotWorkAttachmentSource extends BotWorkHistorySource {
  callId: string
  fileIndex: number
}

const ATTACHMENT_SELECTOR = "?attachment="

export function botWorkAttachmentHref(source: BotWorkAttachmentSource): string {
  return botWorkHistoryHref(source) + ATTACHMENT_SELECTOR +
    encodeURIComponent(JSON.stringify({ callId: source.callId, fileIndex: source.fileIndex }))
      .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function parseBotWorkAttachmentHref(href: string): BotWorkAttachmentSource | null {
  if (href.length > 8192) return null
  const separator = href.indexOf(ATTACHMENT_SELECTOR)
  if (separator < 0) return null
  const source = parseBotWorkHistoryHref(href.slice(0, separator))
  if (!source) return null
  try {
    const attachment = JSON.parse(decodeURIComponent(href.slice(separator + ATTACHMENT_SELECTOR.length)))
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) ||
        Object.keys(attachment).some(key => key !== "callId" && key !== "fileIndex") ||
        typeof attachment.callId !== "string" || !attachment.callId || attachment.callId.length > 1024 ||
        attachment.callId.includes("\0") || !Number.isSafeInteger(attachment.fileIndex) ||
        attachment.fileIndex < 0 || attachment.fileIndex >= 8) return null
    return { ...source, callId: attachment.callId, fileIndex: attachment.fileIndex }
  } catch { return null }
}

export function botWorkHref(workId: string): string {
  return "#bot-work/" + encodeURIComponent(workId)
}

export function parseBotWorkHref(href: string): string | undefined {
  if (!href.startsWith("#bot-work/") || href.length > 500) return
  try {
    const id = decodeURIComponent(href.slice("#bot-work/".length))
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined
  } catch { return }
}
