import { z } from "zod"
import { botPresentationInput, botPresentationStyle } from "../../shared/bot-presentation"

const color = z.string().regex(/^[A-F0-9]{6}$/)
const coord = z.number().finite().min(0).max(960)
const rect = z
  .object({ x: coord, y: coord, width: coord.positive(), height: coord.positive(), color })
  .strict()
const label = rect
  .omit({ color: true })
  .extend({
    text: z.string().min(1).max(1500),
    size: z.number().int().min(13).max(48),
    color,
    bold: z.boolean(),
    lines: z.array(z.string().max(1500)).min(1).max(12)
  })
  .strict()
export const botPresentationLayout = z
  .object({
    version: z.literal(1),
    style: botPresentationStyle,
    font: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    pages: z
      .array(
        z
          .object({
            background: color,
            rectangles: z.array(rect).max(16),
            labels: z.array(label).max(16)
          })
          .strict()
      )
      .min(1)
      .max(20)
  })
  .strict()
  .superRefine((layout, ctx) => {
    layout.pages.forEach((page, i) => {
      for (const item of [...page.rectangles, ...page.labels])
        if (item.x + item.width > 960 || item.y + item.height > 540)
          ctx.addIssue({ code: "custom", path: ["pages", i], message: "元素超出幻灯片边界" })
      for (const label of page.labels)
        if (
          label.lines.length * label.size * 1.3 > label.height + 0.01 ||
          label.lines.join("") !== label.text.replace(/\n/g, "")
        )
          ctx.addIssue({ code: "custom", path: ["pages", i], message: "文本布局不完整" })
    })
  })
export type BotPresentationLayout = z.infer<typeof botPresentationLayout>
const png = z
  .string()
  .min(1)
  .max(1_400_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
export const botPresentationDraftRequest = z
  .object({ kind: z.literal("presentation-drafts"), input: botPresentationInput })
  .strict()
export const botPresentationDrafts = z
  .object({
    layouts: z.array(botPresentationLayout).length(3),
    previews: z.array(png).length(3)
  })
  .strict()
export const botPresentationWriteRequest = z
  .object({ kind: z.literal("presentation-write"), layout: botPresentationLayout })
  .strict()
export const botPresentationBytes = z
  .object({
    bytes: z
      .instanceof(Uint8Array)
      .refine((v) => v.byteLength > 0 && v.byteLength <= 25 * 1024 * 1024)
  })
  .strict()
export const botPresentationPageRequest = z
  .object({
    kind: z.literal("presentation-page"),
    layout: botPresentationLayout,
    page: z.number().int().min(0).max(19)
  })
  .strict()
export const botPresentationPage = z
  .object({
    page: z.number().int().min(0).max(19),
    pageCount: z.number().int().min(1).max(20),
    base64: png,
    width: z.literal(960),
    height: z.literal(540)
  })
  .strict()
export type BotPresentationPage = z.infer<typeof botPresentationPage>
export const presentationFailureCode = z.enum([
  "presentation_invalid_layout",
  "presentation_font_unavailable"
])
export class BotPresentationInputError extends Error {
  constructor(
    readonly code: z.infer<typeof presentationFailureCode>,
    message: string
  ) {
    super(message)
    this.name = "BotPresentationInputError"
  }
}
