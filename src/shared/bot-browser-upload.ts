import { z } from "zod"

export const BOT_BROWSER_UPLOAD_BYTES = 25 * 1024 * 1024
export const BOT_BROWSER_UPLOAD_COUNT = 8
export const botBrowserUploadFile = z
  .object({
    id: z.string().min(1).max(160),
    name: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !/[\\/]/.test(value) &&
          Array.from(value).every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          )
      ),
    mime: z
      .string()
      .min(1)
      .max(200)
      .refine((value) =>
        Array.from(value).every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
        )
      ),
    size: z.number().int().min(0).max(BOT_BROWSER_UPLOAD_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const botBrowserUploadFiles = z
  .array(botBrowserUploadFile)
  .min(1)
  .max(BOT_BROWSER_UPLOAD_COUNT)
  .refine(
    (files) =>
      new Set(files.map((file) => file.id)).size === files.length &&
      files.reduce((sum, file) => sum + file.size, 0) <= BOT_BROWSER_UPLOAD_BYTES,
    "文件必须唯一，合计不超过 25 MiB"
  )
export type BotBrowserUploadFile = z.infer<typeof botBrowserUploadFile>
export const botBrowserUploadDestination = z
  .object({
    origin: z.string().url().max(8192),
    url: z.string().url().max(8192),
    title: z.string().max(2048),
    field: z.string().max(500),
    accept: z.string().max(2000),
    multiple: z.boolean(),
    formAction: z.string().max(8192).nullable(),
    formMethod: z.string().max(100).nullable()
  })
  .strict()
export const botBrowserUploadCard = z
  .object({
    version: z.literal(1),
    purpose: z.string().min(1).max(500),
    destination: botBrowserUploadDestination,
    files: botBrowserUploadFiles
  })
  .strict()
export function readBotBrowserUploadCard(
  prompt: string
): z.infer<typeof botBrowserUploadCard> | null {
  try {
    return botBrowserUploadCard.safeParse(JSON.parse(prompt)?.browserUpload).data ?? null
  } catch {
    return null
  }
}
