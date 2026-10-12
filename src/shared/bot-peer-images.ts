import { z } from "zod"
import { BOT_ATTACHMENT_COUNT, BOT_FILE_BYTES } from "./bot-files"

/** Only immutable, explicitly selected task artifacts cross a peer handoff. */
export const botPeerImageSelection = z
  .object({
    artifact_id: z.string().min(1).max(200),
    alt: z.string().trim().max(200).optional()
  })
  .strict()
export const botPeerImageSelections = z
  .array(botPeerImageSelection)
  .max(BOT_ATTACHMENT_COUNT)
  .refine(
    (items) => new Set(items.map((item) => item.artifact_id)).size === items.length,
    "不能重复附加同一张图片"
  )
export type BotPeerImageSelection = z.infer<typeof botPeerImageSelection>
export const botPeerImageSource = z
  .object({
    sourceId: z.string().min(1).max(200),
    sourceConversationId: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(200),
    size: z.number().int().min(1).max(BOT_FILE_BYTES),
    alt: z.string().max(200).optional()
  })
  .strict()
export const botPeerImageSources = z.array(botPeerImageSource).max(BOT_ATTACHMENT_COUNT)
export type BotPeerImageSource = z.infer<typeof botPeerImageSource>
export const botPeerMessageImage = botPeerImageSource.extend({ id: z.string().min(1).max(200) })
export const botPeerMessageImages = z.array(botPeerMessageImage).max(BOT_ATTACHMENT_COUNT)
export type BotPeerMessageImage = z.infer<typeof botPeerMessageImage>

export const botPeerDelivery = z
  .object({
    direction: z.enum(["incoming", "outgoing"]),
    peer: z
      .object({ botId: z.string().min(1).max(200), name: z.string().min(1).max(200) })
      .strict(),
    counterpart: z
      .object({ conversationId: z.string().min(1).max(200), messageId: z.string().min(1).max(200) })
      .strict(),
    /** Existing awaiting turn, not another delegated task. */
    mergedIntoRunId: z.string().min(1).max(200).optional(),
    senderRunId: z.string().min(1).max(200),
    recipientRunId: z.string().min(1).max(200)
  })
  .strict()
export type BotPeerDelivery = z.infer<typeof botPeerDelivery>
