import { createCanvas, GlobalFonts } from "@napi-rs/canvas"
import {
  botPresentationInput,
  BOT_PRESENTATION_STYLES,
  type BotPresentationStyle
} from "../../shared/bot-presentation"
import {
  botPresentationLayout,
  BotPresentationInputError,
  type BotPresentationLayout
} from "./presentation-contract"

const palettes = {
  minimal: {
    background: "FAFBFC",
    ink: "17212F",
    muted: "566477",
    accent: "306BED",
    panel: "EEF2F7"
  },
  executive: {
    background: "112231",
    ink: "F6FAFD",
    muted: "B3C7D5",
    accent: "69DFCD",
    panel: "1D3447"
  },
  warm: { background: "FAF5EB", ink: "3C332D", muted: "746558", accent: "AC593C", panel: "EEE5D5" }
} as const
function fontFor(value: string) {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
  const available = new Set(GlobalFonts.families.map((item) => item.family))
  const candidates = cjk
    ? [
        "Noto Sans CJK SC",
        "Microsoft YaHei",
        "PingFang SC",
        "Hiragino Sans GB",
        "Noto Sans SC",
        "Arial Unicode MS"
      ]
    : ["Inter", "Arial", "Helvetica", "DejaVu Sans", "Noto Sans"]
  const font = candidates.find((name) => available.has(name))
  if (!font)
    throw new BotPresentationInputError(
      "presentation_font_unavailable",
      cjk
        ? "未找到中文字体；请安装 Noto Sans CJK 或系统中文字体后重试"
        : "未找到可用字体，暂不能生成演示文稿"
    )
  return font
}
const canvas = () => createCanvas(960, 540)
/** Text is measured once and the same explicit line breaks drive editable OOXML and previews. */
export function preparePresentationLayouts(raw: unknown): BotPresentationLayout[] {
  const input = botPresentationInput.parse(raw),
    font = fontFor(JSON.stringify(input.slides))
  const measure = canvas().getContext("2d")
  return BOT_PRESENTATION_STYLES.map((style) => {
    const colors = palettes[style]
    const pages = input.slides.map((slide, index) => {
      const page: BotPresentationLayout["pages"][number] = {
        background: colors.background,
        rectangles: [],
        labels: []
      }
      const rect = (x: number, y: number, width: number, height: number, color: string) =>
        page.rectangles.push({ x, y, width, height, color })
      const text = (
        value: string,
        x: number,
        y: number,
        width: number,
        height: number,
        size: number,
        color = colors.ink as string,
        bold = false
      ) => {
        for (let px = size; px >= Math.max(12, size - 6); px--) {
          measure.font = `${bold ? "bold " : ""}${px}px "${font}"`
          const lines: string[] = []
          for (const paragraph of value.split("\n")) {
            let line = ""
            for (const character of paragraph) {
              if (measure.measureText(line + character).width > width - 8 && line) {
                lines.push(line)
                line = character
              } else line += character
            }
            lines.push(line)
          }
          if (
            lines.length * px * 1.3 <= height &&
            lines.every((line) => measure.measureText(line).width <= width)
          ) {
            page.labels.push({ x, y, width, height, text: value, lines, size: px, color, bold })
            return
          }
        }
        throw new BotPresentationInputError(
          "presentation_invalid_layout",
          `第 ${index + 1} 页文字过多，请拆分页面或缩短要点后重新生成`
        )
      }
      rect(48, 44, 42, 5, colors.accent)
      if (slide.kind === "title") {
        text(slide.title, 60, 160, 830, 156, 46, colors.ink, true)
        if (slide.subtitle) text(slide.subtitle, 62, 330, 790, 98, 24, colors.muted)
      } else {
        text(slide.title, 48, 74, 864, 91, 34, colors.ink, true)
        if (slide.kind === "content") {
          const row = Math.min(72, 292 / slide.points.length)
          slide.points.forEach((point, n) => {
            rect(50, 187 + row * n, 5, 5, colors.accent)
            text(point, 74, 176 + row * n, 818, row - 8, slide.points.length > 4 ? 22 : 25)
          })
        } else {
          for (const [n, column] of [slide.left, slide.right].entries()) {
            const x = 48 + 446 * n
            rect(x, 178, 418, 292, colors.panel)
            text(column.heading, x + 20, 196, 378, 54, 25, colors.accent, true)
            const row = 198 / column.points.length
            column.points.forEach((point, i) =>
              text(point, x + 20, 254 + row * i, 378, row - 7, 20)
            )
          }
        }
      }
      text(`${index + 1} / ${input.slides.length}`, 834, 498, 80, 20, 14, colors.muted)
      return page
    })
    return botPresentationLayout.parse({ version: 1, style, title: input.title, font, pages })
  })
}
export async function renderPresentationPage(raw: BotPresentationLayout, index: number) {
  const layout = botPresentationLayout.parse(raw),
    page = layout.pages[index]
  if (!page)
    throw new BotPresentationInputError("presentation_invalid_layout", "幻灯片页码超出范围")
  if (!GlobalFonts.families.some((item) => item.family === layout.font))
    throw new BotPresentationInputError(
      "presentation_font_unavailable",
      `缺少保存时使用的字体 ${layout.font}，无法准确预览；原件仍可下载`
    )
  const result = canvas(),
    context = result.getContext("2d")
  context.fillStyle = `#${page.background}`
  context.fillRect(0, 0, 960, 540)
  for (const rect of page.rectangles) {
    context.fillStyle = `#${rect.color}`
    context.fillRect(rect.x, rect.y, rect.width, rect.height)
  }
  context.textBaseline = "top"
  for (const item of page.labels) {
    context.fillStyle = `#${item.color}`
    context.font = `${item.bold ? "bold " : ""}${item.size}px "${layout.font}"`
    for (const [line, value] of item.lines.entries())
      context.fillText(value, item.x, item.y + line * item.size * 1.3)
  }
  const bytes = await result.encode("png")
  if (bytes.byteLength > 1024 * 1024)
    throw new BotPresentationInputError(
      "presentation_invalid_layout",
      "单页预览超过大小限制，请简化页面"
    )
  return {
    page: index,
    pageCount: layout.pages.length,
    base64: bytes.toString("base64"),
    width: 960 as const,
    height: 540 as const
  }
}
export function presentationPalette(style: BotPresentationStyle) {
  return palettes[style]
}
