import { BotError } from "./contracts"
import { MAX_ATTACHMENT_PICKER_FILES, type FileAttachment } from "../file-attachment"

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

export function parseBotInputFileIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_PICKER_FILES ||
      value.some(id => typeof id !== "string" || !BOT_INPUT_FILE_ID_PATTERN.test(id)) ||
      new Set(value).size !== value.length)
    throw new BotError("INVALID_INPUT", "附件引用无效，请重新选择附件")
  return [...value]
}

export function botInputFileIds(attachments: readonly FileAttachment[]): string[] {
  return parseBotInputFileIds(attachments.flatMap(file => file.botInputId ? [file.botInputId] : []))
}
