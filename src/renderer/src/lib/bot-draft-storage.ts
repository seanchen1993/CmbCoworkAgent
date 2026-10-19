import { z } from "zod"
import { MAX_ATTACHMENT_PICKER_FILES } from "../../../shared/file-attachment"

export const botDraftContentSchema = z.object({
  text: z.string().max(200_000),
  attachments: z
    .array(
      z.object({
        filename: z.string().max(512),
        filePath: z.string().min(1).max(4096),
        content: z.string().max(24_000),
        mimeType: z.string().max(256),
        size: z.number().int().nonnegative(),
        truncated: z.boolean()
      })
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
