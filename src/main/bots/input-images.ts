import { createHash } from "node:crypto"
import type { BotTask } from "../../shared/bots/contracts"
import { botInputImageCount, hasBotInputImages, isBotImageInput, type BotInputFile } from "../../shared/bots/input-files"
export { botImageMime, hasBotInputImages, isBotImageInput } from "../../shared/bots/input-files"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_CHAT_IMAGES,
  type SubmittedChatImage
} from "../../shared/file-attachment"
import { stageChatImage, holdBotImageStage, chatImageIdForKey } from "../chat-images"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { inputFileSnapshot, retainedInputFileIds } from "./input-files"

export function botStageKey(task: BotTask, file: BotInputFile) {
  return JSON.stringify([task.requestId, file.id, inputFileSnapshot(file).digest])
}

function imageKey(task: BotTask, file: BotInputFile, index: number) {
  const key = botStageKey(task, file)
  return isBotImageInput(file) ? key : JSON.stringify([key, index])
}

export function botBoundImageIds(task: BotTask, files: readonly BotInputFile[]) {
  return new Set(files.flatMap(file => Array.from({ length: botInputImageCount(file) },
    (_, index) => chatImageIdForKey(imageKey(task, file, index)))))
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
  const candidates = authorizedFiles.filter(hasBotInputImages)
  const accepted = new Set(retainedInputFileIds(candidates, body, task))
  const files = candidates.filter(file => accepted.has(file.id))
  if (files.reduce((sum, file) => sum + botInputImageCount(file), 0) > MAX_CHAT_IMAGES)
    throw new Error("每条消息最多发送 3 张图片，含文档内嵌图片")
  const refs: SubmittedChatImage[] = []
  for (const file of files) {
    signal.throwIfAborted()
    const { path, directory, digest } = inputFileSnapshot(file)
    const opened = await openStableFileHandle(directory, path)
    try {
      const bytes = await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)
      if (bytes.byteLength !== file.file.size || createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("图片原件已变化，请重新选择")
      signal.throwIfAborted()
      const direct = isBotImageInput(file)
      const input = Uint8Array.from(bytes).buffer
      const images = direct ? [{ index: 0, name: file.file.filename, filename: file.file.filename, bytes: input }]
        : await (async () => {
            const [{ getFileAttachmentParserClient }, { documentImageLabel }] = await Promise.all([
              import("../file-attachment-parser/client"), import("../document-attachment-images")
            ])
            const key = "bot-visual:" + botStageKey(task, file)
            const client = getFileAttachmentParserClient()
            const cancel = () => client.cancelLatest(key)
            signal.addEventListener("abort", cancel, { once: true })
            try {
              signal.throwIfAborted()
              const parsed = await client.parse({ kind: "bytes", fileName: file.file.filename, bytes: input },
                undefined, key, true)
              if (parsed.documentImages?.length !== botInputImageCount(file))
                throw new Error("文档内嵌图片与上传版本不一致，请重新上传")
              return parsed.documentImages.map(image => ({
                ...image, name: "embedded" + image.extension,
                filename: documentImageLabel(file.file.filename.slice(0, 430), image.index) + "（" + file.id + "）"
              }))
            } finally {
              signal.removeEventListener("abort", cancel)
            }
          })()
      for (const image of images) {
        signal.throwIfAborted()
        const key = imageKey(task, file, image.index)
        if (releases) releases.add(holdBotImageStage(threadId, key))
        const staged = await stage(threadId, image.name, image.bytes,
          { deduplicationKey: key, beforePublish: () => signal.throwIfAborted() })
        signal.throwIfAborted()
        if (!staged.image) throw new Error("图片解码失败")
        refs.push({ id: staged.image.id, filename: direct ? staged.filename : image.filename, slot: refs.length })
      }
    } finally {
      await opened.handle.close()
    }
  }
  return refs
}
