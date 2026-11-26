import { BotError } from "./contracts"
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_PICKER_FILES, MAX_CHAT_IMAGES, type FileAttachment } from "../file-attachment"

export const BOT_INPUT_FILE_ID_PATTERN = /^input-[a-f0-9-]{36}$/

/** Issued by the real Bot attachment picker/drop handler, never inferred from message XML. */
export interface BotInputFile {
  id: string
  botId: string
  /** Desktop composer scope that retained this selection. */
  workId?: string
  file: Pick<FileAttachment, "filename" | "filePath" | "mimeType" | "size">
  /** Present only on new picker receipts; older references cannot grant cross-task input. */
  attachment?: FileAttachment
  blockHash?: string
}

export function botImageMime(name: string, size: number): string | undefined {
  if (size <= 0 || size > MAX_ATTACHMENT_FILE_BYTES) return
  switch (name.slice(name.lastIndexOf(".")).toLowerCase()) {
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".webp": return "image/webp"
    default: return undefined
  }
}

export function isBotImageInput(file: BotInputFile): boolean {
  const mime = botImageMime(file.file.filename, file.file.size)
  return Boolean(mime && file.attachment?.mimeType === mime && file.blockHash)
}

export function botInputImageCount(file: BotInputFile): number {
  if (isBotImageInput(file)) return 1
  const count = file.attachment?.embeddedImageCount
  return file.blockHash && count && Number.isInteger(count) && count > 0 && count <= MAX_CHAT_IMAGES
    ? count : 0
}

export function hasBotInputImages(file: BotInputFile): boolean {
  return botInputImageCount(file) > 0
}

export function parseBotInputFileIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_PICKER_FILES ||
      value.some(id => typeof id !== "string" || !BOT_INPUT_FILE_ID_PATTERN.test(id)) ||
      new Set(value).size !== value.length)
    throw new BotError("INVALID_INPUT", "附件引用无效，请重新选择附件")
  return [...value]
}

export function botAttachmentIdentity(file: FileAttachment): string {
  return file.botInputId ?? file.filePath
}

export function botInputFileIds(attachments: readonly FileAttachment[]): string[] {
  return parseBotInputFileIds(attachments.flatMap(file => file.botInputId ? [file.botInputId] : []))
}
