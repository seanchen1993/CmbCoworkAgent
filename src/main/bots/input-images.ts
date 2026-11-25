import { createHash } from "node:crypto"
import { extname } from "node:path"
import type { BotTask } from "../../shared/bots/contracts"
import type { BotInputFile } from "../../shared/bots/input-files"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  type SubmittedChatImage
} from "../../shared/file-attachment"
import { stageChatImage } from "../chat-images"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { inputFileSnapshot, retainedInputFileIds } from "./input-files"

export function botImageMime(name: string, size: number): string | undefined {
  if (size <= 0 || size > MAX_ATTACHMENT_FILE_BYTES) return
  switch (extname(name).toLowerCase()) {
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

/** Reopen the trusted snapshot through a stable descriptor. Verify the very bytes being decoded. */
export async function prepareBotInputImages(
  task: BotTask,
  threadId: string,
  body: string,
  authorizedFiles: readonly BotInputFile[],
  signal: AbortSignal,
  stage = stageChatImage
): Promise<SubmittedChatImage[]> {
  const files = authorizedFiles.filter(isBotImageInput)
  const accepted = new Set(retainedInputFileIds(files, body, task))
  const refs: SubmittedChatImage[] = []
  for (const [slot, file] of files.entries()) {
    if (!accepted.has(file.id)) continue
    signal.throwIfAborted()
    const { path, directory, digest } = inputFileSnapshot(file)
    const opened = await openStableFileHandle(directory, path)
    try {
      const bytes = await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)
      if (bytes.byteLength !== file.file.size || createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("图片原件已变化，请重新选择")
      signal.throwIfAborted()
      const staged = await stage(threadId, file.file.filename, Uint8Array.from(bytes).buffer,
        { deduplicationKey: JSON.stringify([task.requestId, file.id, digest]),
          beforePublish: () => signal.throwIfAborted() })
      signal.throwIfAborted()
      if (!staged.image) throw new Error("图片解码失败")
      refs.push({ id: staged.image.id, filename: staged.filename, slot })
    } finally {
      await opened.handle.close()
    }
  }
  return refs
}
