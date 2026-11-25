import { createHash } from "node:crypto"
import type { BotTask } from "../../shared/bots/contracts"
import { isBotImageInput, type BotInputFile } from "../../shared/bots/input-files"
export { botImageMime, isBotImageInput } from "../../shared/bots/input-files"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  type SubmittedChatImage
} from "../../shared/file-attachment"
import { stageChatImage, holdBotImageStage, chatImageIdForKey } from "../chat-images"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { inputFileSnapshot, retainedInputFileIds } from "./input-files"

export function botStageKey(task: BotTask, file: BotInputFile) {
  return JSON.stringify([task.requestId, file.id, inputFileSnapshot(file).digest])
}

export function botBoundImageIds(task: BotTask, files: readonly BotInputFile[]) {
  return new Set(files.filter(isBotImageInput).map(file => chatImageIdForKey(botStageKey(task, file))))
}

/** Reopen the trusted snapshot through a stable descriptor. Verify the very bytes being decoded. */
export async function prepareBotInputImages(
  task: BotTask,
  threadId: string,
  body: string,
  authorizedFiles: readonly BotInputFile[],
  signal: AbortSignal,
  stage = stageChatImage,
  releases?: Set<() => Promise<void>>
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
      const key = botStageKey(task, file)
      if (releases) releases.add(holdBotImageStage(threadId, key))
      const staged = await stage(threadId, file.file.filename, Uint8Array.from(bytes).buffer,
        { deduplicationKey: key,
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
