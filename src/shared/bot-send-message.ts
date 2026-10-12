import { z } from "zod"
import { botPeerImageSelections } from "./bot-peer-images"

/** Current task publication only. Files stay immutable artifact references. */
export const botSendMessageInput = z
  .object({
    content: z
      .string()
      .min(1)
      .max(16_000)
      .refine((value) => Boolean(value.trim()) && !value.includes("\0")),
    images: botPeerImageSelections.optional(),
    reply_to: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[\w:.-]+$/)
      .optional()
  })
  .strict()
export type BotSendMessageInput = z.infer<typeof botSendMessageInput>
export const botSentMessage = z
  .object({
    messageId: z.string(),
    conversationId: z.string(),
    runId: z.string(),
    threadRootId: z.string().optional()
  })
  .strict()
export type BotSentMessage = z.infer<typeof botSentMessage>
