import { z } from "zod"

export const botSearchKind = z.enum(["message", "bot", "group", "file", "link", "routine"])
export type BotSearchKind = z.infer<typeof botSearchKind>
export const botSearchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !value.includes("\0")),
    kind: botSearchKind,
    conversationId: z.string().max(160).optional(),
    cursor: z.string().max(1024).optional()
  })
  .strict()
export type BotSearchInput = z.infer<typeof botSearchInput>
export interface BotSearchMatch {
  kind: BotSearchKind
  id: string
  conversationId: string
  conversationName: string
  botId: string | null
  title: string
  snippet: string
  createdAt: number
}
export interface BotSearchPage {
  matches: BotSearchMatch[]
  /** Continues the scan even when this page contained no matches. */
  cursor: string | null
  scanned: number
}
