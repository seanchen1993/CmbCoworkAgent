import PptxGenJS from "pptxgenjs"
import { botPresentationLayout, type BotPresentationLayout } from "./presentation-contract"

/** Real editable text and shapes, not images renamed .pptx. No network or filesystem inputs. */
export async function writePresentation(raw: BotPresentationLayout): Promise<Buffer> {
  const layout = botPresentationLayout.parse(raw),
    deck = new PptxGenJS()
  deck.layout = "LAYOUT_WIDE"
  deck.title = layout.title
  deck.subject = "CMBDevClaw presentation"
  deck.author = "CMBDevClaw"
  deck.company = "CMBDevClaw"
  deck.theme = { headFontFace: layout.font, bodyFontFace: layout.font }
  for (const page of layout.pages) {
    const slide = deck.addSlide()
    slide.background = { color: page.background }
    for (const rect of page.rectangles)
      slide.addShape(deck.ShapeType.rect, {
        x: rect.x / 72,
        y: rect.y / 72,
        w: rect.width / 72,
        h: rect.height / 72,
        fill: { color: rect.color },
        line: { color: rect.color, transparency: 100 }
      })
    for (const item of page.labels)
      slide.addText(item.lines.join("\n"), {
        x: item.x / 72,
        y: item.y / 72,
        w: item.width / 72,
        h: item.height / 72,
        color: item.color,
        bold: item.bold,
        fontFace: layout.font,
        fontSize: item.size,
        margin: 0,
        breakLine: false,
        valign: "top",
        fit: "shrink",
        wrap: true,
        lineSpacingMultiple: 1.3,
        paraSpaceAfter: 0,
        lang: "zh-CN"
      })
  }
  const bytes = await deck.write({ outputType: "nodebuffer", compression: true })
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > 25 * 1024 * 1024)
    throw new Error("演示文稿生成结果无效或超过 25 MiB")
  return bytes
}
