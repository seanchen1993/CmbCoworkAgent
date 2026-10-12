import { z } from "zod"
import { BOT_FILE_BYTES } from "../../shared/bot-files"
import { botImageRegion, botImageResult } from "./image-contract"

export const botPdfPage = z.number().int().min(1).max(1000)
export const botPdfRequest = z
  .object({
    kind: z.literal("pdf-page"),
    bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= BOT_FILE_BYTES),
    page: botPdfPage,
    region: botImageRegion.optional()
  })
  .strict()
export const botPdfResult = z
  .object({
    page: botPdfPage,
    pageCount: botPdfPage,
    dpi: z.literal(96),
    image: botImageResult
  })
  .strict()
  .refine((value) => value.page <= value.pageCount)
export type BotPdfResult = z.infer<typeof botPdfResult>
