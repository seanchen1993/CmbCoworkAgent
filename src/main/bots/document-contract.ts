import { z } from "zod"
import { BOT_FILE_BYTES } from "../../shared/bot-files"

export const botDocumentRequest = z.object({
  name: z.string().min(1).max(200),
  asText: z.boolean().optional(),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= BOT_FILE_BYTES),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(32_000)
})
export const botDocumentResult = z.object({
  name: z.string().max(200),
  offset: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  text: z.string().max(32_000),
  nextOffset: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean()
})
export type BotDocumentResult = z.infer<typeof botDocumentResult>
