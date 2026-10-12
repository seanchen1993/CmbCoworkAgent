import { z } from "zod"
import { BOT_ATTACHMENT_COUNT, BOT_VIDEO_BYTES, botFileByteLimit } from "./bot-files"

export const BOT_PEER_FILES_CAPABILITY = "peer-files-v1"

/** Explicit file references, never host paths or implicit access to another chat. */
export const botPeerFileSelection = z.object({ artifact_id: z.string().min(1).max(200) }).strict()
export const botPeerFileSelections = z
  .array(botPeerFileSelection)
  .max(BOT_ATTACHMENT_COUNT)
  .refine(
    (files) => new Set(files.map((file) => file.artifact_id)).size === files.length,
    "不能重复附加同一文件"
  )
export type BotPeerFileSelection = z.infer<typeof botPeerFileSelection>
export const botPeerFileSource = z
  .object({
    sourceId: z.string().min(1).max(200),
    sourceConversationId: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(200),
    size: z.number().int().min(0).max(BOT_VIDEO_BYTES)
  })
  .strict()
  .refine((file) => file.size <= botFileByteLimit(file.name, file.mime), "附件大小超限")
export const botPeerFileSources = z.array(botPeerFileSource).max(BOT_ATTACHMENT_COUNT)
export type BotPeerFileSource = z.infer<typeof botPeerFileSource>
