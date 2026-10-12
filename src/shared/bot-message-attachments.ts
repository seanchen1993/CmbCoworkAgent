import { z } from "zod"
import type { BotArtifact, BotMessage } from "./bot-types"
import { BOT_ATTACHMENT_COUNT, BOT_VIDEO_BYTES, botFileByteLimit } from "./bot-files"
import { botFileOrigin } from "./bot-file-lifecycle"
import { botPeerMessageImages, type BotPeerMessageImage } from "./bot-peer-images"

/** Display metadata of an immutable file actually linked to this exact message.
 * No path, object bytes, token or authorization is granted by this descriptor. */
export const botMessageAttachment = z
  .object({
    id: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200).nullable(),
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(200),
    size: z.number().int().min(0).max(BOT_VIDEO_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    origin: botFileOrigin.optional()
  })
  .strict()
  .refine((file) => file.size <= botFileByteLimit(file.name, file.mime), "附件大小超限")
// Historical send payloads accepted up to twenty references. Current uploads
// still use the six-file admission limit; display must not erase old references.
export const botMessageAttachments = z.array(botMessageAttachment).max(20)
export type BotMessageAttachment = z.infer<typeof botMessageAttachment>

export function sameBotMessageAttachment(
  actual: BotArtifact,
  expected: BotMessageAttachment
): boolean {
  return (
    actual.id === expected.id &&
    actual.conversationId === expected.conversationId &&
    actual.runId === expected.runId &&
    actual.name === expected.name &&
    actual.mime === expected.mime &&
    actual.size === expected.size &&
    actual.sha256 === expected.sha256 &&
    actual.createdAt === expected.createdAt
  )
}

export function botMessageAttachmentPresentation(
  message: Pick<
    BotMessage,
    "conversationId" | "attachments" | "attachmentFiles" | "images" | "peerImages"
  >
): {
  imageGroups: BotPeerMessageImage[][]
  files: { id: string; artifact?: BotMessageAttachment; unavailable: boolean }[]
} {
  const ids = new Set(message.attachments)
  const descriptors = botMessageAttachments.safeParse(message.attachmentFiles)
  const files = new Map<string, BotMessageAttachment>()
  if (descriptors.success) {
    for (const file of descriptors.data) {
      if (file.conversationId === message.conversationId && ids.has(file.id) && !files.has(file.id))
        files.set(file.id, file)
    }
  }
  const published = botPeerMessageImages.safeParse(message.images ?? message.peerImages ?? [])
  const images = published.success ? [...published.data] : []
  const displayed = new Set(images.map((image) => image.id))
  for (const id of message.attachments) {
    const file = files.get(id)
    if (
      !file ||
      displayed.has(id) ||
      file.size === 0 ||
      !(
        /\.(?:png|jpe?g|gif|webp)$/i.test(file.name) ||
        /^image\/(?:png|jpeg|gif|webp)$/i.test(file.mime)
      )
    )
      continue
    images.push({
      id: file.id,
      sourceId: file.id,
      sourceConversationId: file.conversationId,
      name: file.name,
      mime: file.mime,
      size: file.size,
      sha256: file.sha256
    })
    displayed.add(id)
  }
  const imageGroups: BotPeerMessageImage[][] = []
  for (let start = 0; start < images.length; start += BOT_ATTACHMENT_COUNT)
    imageGroups.push(images.slice(start, start + BOT_ATTACHMENT_COUNT))
  return {
    imageGroups,
    files: [...ids]
      .filter((id) => !displayed.has(id))
      .map((id) => ({
        id,
        artifact: files.get(id),
        unavailable: message.attachmentFiles !== undefined && !files.has(id)
      }))
  }
}
