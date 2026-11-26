import { z } from "zod"
import { MAX_ATTACHMENT_PICKER_FILES, MAX_CHAT_IMAGES } from "../../../shared/file-attachment"
import { BOT_INPUT_FILE_ID_PATTERN } from "../../../shared/bots/input-files"

export const BOT_CONVERSATION_DRAFT_PREFIX = "cmb-bot-conversation-draft-v1:"
export const ORDINARY_IMAGE_DRAFT_PREFIX = "cmb-ordinary-image-draft-v1:"

export function clearOrdinaryImageDrafts(threadId: string): void {
  const storage = globalThis.localStorage
  if (!storage) return
  const prefix = ORDINARY_IMAGE_DRAFT_PREFIX + JSON.stringify([threadId]).slice(0, -1) + ","
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i)
    if (key?.startsWith(prefix)) storage.removeItem(key)
  }
}

export function botConversationDraftKey(hostId: string, botId: string, workId?: string): string {
  return BOT_CONVERSATION_DRAFT_PREFIX + JSON.stringify(workId ? [hostId, botId, workId] : [hostId, botId])
}

export function botThreadDraftKey(threadId: string): string {
  return `${BOT_CONVERSATION_DRAFT_PREFIX}thread:${threadId}`
}

export const draftImageRef = z.object({
  id: z.string().uuid(), filename: z.string().min(1).max(512),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  draftWorkspace: z.string().max(32_768)
})

export const botDraftContentSchema = z.object({
  text: z.string().max(200_000),
  attachments: z
    .array(
      z.object({
        filename: z.string().max(512),
        filePath: z.string().max(4096),
        // Ordinary attachment parsing appends its truncation notice after the
        // 24k content budget. Preserve that valid output when linking a draft.
        content: z.string().max(25_000),
        mimeType: z.string().max(256),
        size: z.number().int().nonnegative(),
        truncated: z.boolean(),
        embeddedImageCount: z.number().int().min(1).max(MAX_CHAT_IMAGES).optional(),
        visualNotice: z.string().max(1024).optional(),
        botInputId: z.string().regex(BOT_INPUT_FILE_ID_PATTERN).optional(),
        originalUnavailable: z.literal(true).optional()
      }).refine(file => Boolean(file.filePath || (file.botInputId &&
        ["image/png", "image/jpeg", "image/webp"].includes(file.mimeType))))
    )
    .max(MAX_ATTACHMENT_PICKER_FILES)
})

/** Per-conversation records only; no transcript, checkpoints or file bytes. */
export function saveBotDraftRecord<T>(
  key: string,
  record: T,
  schema: z.ZodType<T>,
  empty: boolean
): string | null {
  try {
    const storage = globalThis.localStorage
    if (!storage) return null
    const value = schema.parse(record)
    if (empty) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
    return null
  } catch {
    return "草稿暂未保存到本机，请保留当前窗口并重试。"
  }
}

export function loadBotDraftRecord<T>(
  key: string,
  schema: z.ZodType<T>
): {
  draft?: T
  error?: string
} {
  try {
    const value = globalThis.localStorage?.getItem(key)
    if (!value) return {}
    if (value.length > 1_000_000) throw new Error("Oversized draft")
    return { draft: schema.parse(JSON.parse(value)) }
  } catch {
    return { error: "未能恢复这份草稿，本机记录仍保留；请先检查后再继续编辑。" }
  }
}

export function pruneBotDraftRecords(prefix: string, hostId: string, ids: readonly string[]): void {
  const storage = globalThis.localStorage
  if (!storage) return
  const hostPrefix = prefix + JSON.stringify([hostId]).slice(0, -1) + ","
  const keep = new Set(ids.map((id) => prefix + JSON.stringify([hostId, id])))
  const removed: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(hostPrefix) && !keep.has(key)) {
      let ownsWork = false
      try {
        const identity = JSON.parse(key.slice(prefix.length))
        ownsWork =
          Array.isArray(identity) &&
          identity.length === 3 &&
          identity[0] === hostId &&
          ids.includes(identity[1]) &&
          typeof identity[2] === "string"
      } catch {
        /* Malformed records remain eligible for cleanup. */
      }
      if (!ownsWork) removed.push(key)
    }
  }
  for (const key of removed) storage.removeItem(key)
}
