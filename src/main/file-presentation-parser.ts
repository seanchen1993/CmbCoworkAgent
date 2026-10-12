import { posix } from "node:path"
import AdmZip from "adm-zip"
import { DOMParser } from "@xmldom/xmldom"

const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main"
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

/** Reads actual slide order and visible text/tables; never follows external relationships. */
export function parsePresentation(buffer: Buffer): string {
  const archive = new AdmZip(buffer)
  const xml = (name: string) => {
    const entry = archive.getEntry(name)
    if (!entry) throw new Error(`演示文稿缺少 ${name}`)
    const content = entry.getData().toString("utf8")
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error("演示文稿包含不支持的 XML 实体")
    return new DOMParser({
      onError: (level) => {
        if (level !== "warning") throw new Error("演示文稿 XML 损坏")
      }
    }).parseFromString(content, "text/xml")
  }
  const presentation = xml("ppt/presentation.xml")
  const relations = xml("ppt/_rels/presentation.xml.rels")
  const targets = new Map<string, string>()
  for (const relationship of Array.from(relations.getElementsByTagName("Relationship"))) {
    if (relationship.getAttribute("TargetMode") === "External") continue
    const id = relationship.getAttribute("Id"),
      target = relationship.getAttribute("Target")
    if (!id || !target || !relationship.getAttribute("Type")?.endsWith("/slide")) continue
    const name = posix.normalize(posix.join("ppt", target))
    if (!name.startsWith("ppt/slides/") || target.includes("\\") || target.includes(":"))
      throw new Error("演示文稿包含无效幻灯片引用")
    targets.set(id, name)
  }
  const slides = Array.from(presentation.getElementsByTagNameNS(PRESENTATION, "sldId"))
  if (slides.length > 1000) throw new Error("演示文稿超过 1000 页，请拆分后读取")
  return slides
    .map((slide, index) => {
      const target = targets.get(slide.getAttributeNS(RELATIONSHIPS, "id") ?? "")
      if (!target) throw new Error("演示文稿幻灯片引用缺失")
      const document = xml(target)
      const paragraphs = Array.from(document.getElementsByTagNameNS(DRAWING, "p"))
      const text = paragraphs
        .map((p) =>
          Array.from(p.getElementsByTagNameNS(DRAWING, "t"))
            .map((t) => t.textContent)
            .join("")
        )
        .join("\n")
      return `## Slide ${index + 1}\n${text || "[本页没有可提取的文本；图片和图表需要视觉检查。]"}`
    })
    .join("\n\n")
}
