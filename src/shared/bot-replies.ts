import { z } from "zod"

/** A bounded, server-resolved quote. No renderer-provided message content is trusted. */
export const botReplyPreview = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  sender: z.enum(["user", "bot", "system"]),
  botId: z.string().nullable(),
  text: z.string().max(8_000),
  truncated: z.boolean(),
  attachments: z.array(z.string()).max(20)
})
export type BotReplyPreview = z.infer<typeof botReplyPreview>
