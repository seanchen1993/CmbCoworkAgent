import { basename, extname, posix } from "node:path"
import { DOMParser, type Options } from "@xmldom/xmldom"
import type AdmZip from "adm-zip"
import { utils } from "xlsx"
import { MAX_ATTACHMENT_FILE_BYTES, MAX_CHAT_IMAGES } from "../shared/file-attachment"

export interface DocumentImage {
  index: number
  extension: string
  bytes: ArrayBuffer
}

const formats: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"
}

export function documentImageLabel(filename: string, index: number) {
  return filename.slice(0, 480) + " · 图 " + (index + 1)
}

export class DocumentImages {
  readonly images: DocumentImage[] = []
  private totalBytes = 0
  private readonly omissions = new Set<string>()

  omit(reason: string) {
    this.omissions.add(reason)
    return "【图片未读取：" + reason + "】"
  }

  get notice() {
    return this.omissions.size ? "部分文档视觉内容未读取：" + [...this.omissions].join("、") : undefined
  }

  add(mime: string, load: () => Buffer): string {
    const extension = formats[mime.toLowerCase()]
    if (!extension) return this.omit("图片格式不支持")
    if (this.images.length >= MAX_CHAT_IMAGES) return this.omit("超过图片数量上限")
    let bytes: Buffer
    try {
      bytes = load()
    } catch {
      return this.omit("图片原件无法读取")
    }
    if (!bytes.length || bytes.length + this.totalBytes > MAX_ATTACHMENT_FILE_BYTES)
      return this.omit("内嵌图片大小超限或为空")
    const index = this.images.length
    this.totalBytes += bytes.length
    this.images.push({ index, extension, bytes: Uint8Array.from(bytes).buffer })
    return "【图 " + (index + 1) + "】"
  }

  htmlSource(src: string): string {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(src)
    return match
      ? this.add(match[1], () => Buffer.from(match[2], "base64"))
      : this.omit(/^data:/i.test(src) ? "内嵌图片编码不支持" : "图片引用外部文件或网址")
  }
}

const relationshipNamespaces = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships"
]

function relationshipId(element: Element, key: "id" | "embed") {
  return relationshipNamespaces.map(ns => element.getAttributeNS(ns, key)).find(Boolean) ?? ""
}

function elements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name))
}

function readXml(zip: AdmZip, name: string): Document | undefined {
  const entry = zip.getEntry(name)
  if (!entry) return
  const source = entry.getData().toString("utf8")
  if (/<!DOCTYPE/i.test(source)) throw new Error("表格附件包含不支持的 XML 声明")
  const fail = () => { throw new Error("表格附件 XML 无效") }
  const options: Options = { errorHandler: { error: fail, fatalError: fail } }
  return new DOMParser(options).parseFromString(source, "application/xml")
}

function relatedParts(zip: AdmZip, source: string) {
  const dir = posix.dirname(source)
  const rels = readXml(zip, posix.join(dir, "_rels", basename(source) + ".rels"))
  return new Map((rels ? elements(rels, "Relationship") : []).map(rel => {
    const target = rel.getAttribute("Target") ?? ""
    const part = rel.getAttribute("TargetMode")?.toLowerCase() === "external" ||
      /[\\:#?%]/.test(target) ? "" : target.startsWith("/")
        ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(dir, target))
    return [rel.getAttribute("Id"), part.startsWith("xl/") ? part : ""]
  }))
}

export function spreadsheetImageLabels(zip: AdmZip, images: DocumentImages) {
  const bySheet = new Map<string, string[]>()
  // A text-only workbook does not need its relationship tree parsed again.
  const entries = zip.getEntries()
  if (entries.some(entry => entry.entryName.startsWith("xl/richData/")))
    images.omit("Excel 单元格内的富数据图片")
  if (!entries.some(entry => /^xl\/(?:drawings|media)\//.test(entry.entryName))) return bySheet
  const workbookPath = "xl/workbook.xml"
  const workbook = readXml(zip, workbookPath)
  if (!workbook) return bySheet
  const sheets = relatedParts(zip, workbookPath)
  for (const sheet of elements(workbook, "sheet")) {
    const sheetPath = sheets.get(relationshipId(sheet, "id"))
    const worksheet = sheetPath && readXml(zip, sheetPath)
    if (!worksheet) continue
    const drawings = relatedParts(zip, sheetPath)
    const labels: string[] = []
    for (const drawing of elements(worksheet, "drawing")) {
      const drawingPath = drawings.get(relationshipId(drawing, "id"))
      const doc = drawingPath && readXml(zip, drawingPath)
      if (!doc) {
        labels.push(images.omit("表格绘图原件无法读取"))
        continue
      }
      const links = relatedParts(zip, drawingPath)
      for (const anchor of Array.from(doc.documentElement.childNodes)) {
        if (anchor.nodeType !== 1) continue
        const element = anchor as Element
        const from = elements(element, "from")[0]
        const coordinate = (name: string) => Number(from && elements(from, name)[0]?.textContent)
        const row = coordinate("row"), col = coordinate("col")
        const position = Number.isInteger(row) && row >= 0 && row < 1048576 &&
          Number.isInteger(col) && col >= 0 && col < 16384
          ? utils.encode_cell({ r: row, c: col }) + " 附近 " : ""
        for (const blip of elements(element, "blip")) {
          const part = links.get(relationshipId(blip, "embed"))
          const mime = Object.keys(formats).find(type =>
            formats[type] === extname(part ?? "").toLowerCase() ||
            type === "image/jpeg" && /\.jpeg$/i.test(part ?? ""))
          const label = part?.startsWith("xl/media/") && mime
            ? images.add(mime, () => {
                const entry = zip.getEntry(part)
                if (!entry || entry.header.size > MAX_ATTACHMENT_FILE_BYTES)
                  throw new Error("图片缺失或超限")
                return entry.getData()
              })
            : images.omit("表格图片格式或链接不支持")
          labels.push(position + label)
        }
        if (elements(element, "chart").length)
          labels.push(position + images.omit("原生图表无法渲染"))
      }
    }
    bySheet.set(sheet.getAttribute("name") ?? "", labels)
  }
  return bySheet
}
