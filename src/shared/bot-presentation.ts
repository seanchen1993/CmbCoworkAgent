import { z } from "zod"
import { botPeerMessageImages } from "./bot-peer-images"

function supportsPresentationText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return false
    }
  }
  return true
}

// Deliberately finite native presentation vocabulary. No HTML, code, paths or URLs.
const text = (max: number) =>
  z.string().trim().min(1).max(max).refine(supportsPresentationText, "文字包含不支持的控制字符")
const column = z.object({ heading: text(80), points: z.array(text(300)).min(1).max(5) }).strict()
export const botPresentationSlide = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("title"), title: text(140), subtitle: text(400).optional() }).strict(),
  z
    .object({
      kind: z.literal("content"),
      title: text(140),
      points: z.array(text(400)).min(1).max(6)
    })
    .strict(),
  z
    .object({ kind: z.literal("two-column"), title: text(140), left: column, right: column })
    .strict()
])
export const botPresentationStyle = z.enum(["minimal", "executive", "warm"])
export const botPresentationInput = z
  .object({
    name: text(180).refine(
      (name) => /\.pptx$/i.test(name) && !/[\\/]/.test(name),
      "请提供 .pptx 文件名"
    ),
    title: text(200),
    slides: z.array(botPresentationSlide).min(1).max(20),
    style: botPresentationStyle
      .optional()
      .describe(
        "Only set a style if the user has chosen it; otherwise show three visual drafts and wait for selection."
      )
  })
  .strict()
  .refine((value) => JSON.stringify(value).length <= 32_000, "演示文稿内容超过 32000 字符")
export type BotPresentationInput = z.infer<typeof botPresentationInput>
export type BotPresentationStyle = z.infer<typeof botPresentationStyle>
export const BOT_PRESENTATION_STYLES = ["minimal", "executive", "warm"] as const
export const BOT_PRESENTATION_LABELS: Record<BotPresentationStyle, string> = {
  minimal: "简洁白",
  executive: "深海蓝",
  warm: "暖纸色"
}
export const botPresentationChoice = z
  .object({
    version: z.literal(1),
    dataEpoch: z.string().min(1).max(200),
    conversationId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    callId: z.string().min(1).max(160),
    layoutHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(3),
    images: botPeerMessageImages.length(3)
  })
  .strict()
export function readBotPresentationChoice(prompt: string) {
  try {
    return botPresentationChoice.safeParse(JSON.parse(prompt).botPresentation).data ?? null
  } catch {
    return null
  }
}
export function hasBotPresentationChoice(prompt: string): boolean {
  try {
    return Object.hasOwn(JSON.parse(prompt), "botPresentation")
  } catch {
    return false
  }
}
