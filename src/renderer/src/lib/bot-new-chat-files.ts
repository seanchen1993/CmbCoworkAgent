import type { BotClient } from "../../../shared/bots/contracts"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_PICKER_FILES,
  type FileAttachment
} from "../../../shared/file-attachment"

export function validateNewChatFiles(files: readonly File[], existingCount = 0): void {
  if (files.length + existingCount > MAX_ATTACHMENT_PICKER_FILES)
    throw new Error(`一次最多添加 ${MAX_ATTACHMENT_PICKER_FILES} 个附件。`)
  if (files.some((file) => file.size > MAX_ATTACHMENT_FILE_BYTES))
    throw new Error("单个附件不能超过 5 MiB。")
}

/** Only the selected recipient receives bytes. Successful partial imports survive a retry. */
export class BotDraftFileTransfer {
  private scope = ""
  private retained = new Map<File, FileAttachment>()

  clear(): void {
    this.scope = ""
    this.retained.clear()
  }

  keep(files: readonly File[]): void {
    for (const file of this.retained.keys()) if (!files.includes(file)) this.retained.delete(file)
  }

  async retain(
    client: BotClient,
    botId: string,
    groupId: string | undefined,
    files: readonly File[],
    existing: readonly FileAttachment[],
    isCurrent: () => boolean
  ): Promise<FileAttachment[]> {
    validateNewChatFiles(files, existing.length)
    const scope = JSON.stringify([client.hostId, groupId ? "group" : "bot", groupId ?? botId])
    if (scope !== this.scope) {
      this.clear()
      this.scope = scope
    }
    // Removed files must not keep their blobs alive for the rest of the workspace session.
    this.keep(files)
    let remaining = 24_000 - existing.reduce((sum, file) => sum + file.content.length, 0)
    const result: FileAttachment[] = []
    for (const file of files) {
      if (!isCurrent()) throw new Error("收件人已切换，请重新选择。")
      if (remaining < 1) throw new Error("附件正文超过 24,000 字符，请减少附件后重试。")
      let attachment = this.retained.get(file)
      if (!attachment) {
        const bytes = await file.arrayBuffer()
        if (!isCurrent()) throw new Error("收件人已切换，请重新选择。")
        const imported = await client.attachFileBytes(
          botId,
          [{ fileName: file.name, bytes }],
          remaining,
          groupId
        )
        if (!isCurrent()) throw new Error("收件人已切换，请重新选择。")
        attachment = imported[0]
        if (imported.length !== 1 || !attachment) throw new Error("附件未能保留，请重试。")
        this.retained.set(file, attachment)
      }
      if (attachment.content.length > remaining)
        throw new Error("附件正文超过 24,000 字符，请减少附件后重试。")
      remaining -= attachment.content.length
      result.push(attachment)
    }
    return result
  }
}
