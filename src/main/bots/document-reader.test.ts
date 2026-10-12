import { afterAll, beforeAll, expect, it } from "vitest"
import { build } from "esbuild"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import * as XLSX from "xlsx"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { BOT_IMAGE_BYTES } from "./image-contract"
import { BotDocumentReader } from "./document-reader"
import {
  wordDocument,
  pdfDocument,
  presentationDocument,
  scannedPdfDocument
} from "./document-fixtures"
import { botDocumentToolContent } from "./document-tool"

let directory: string, reader: BotDocumentReader
const signal = () => new AbortController().signal
beforeAll(async () => {
  await mkdir("output", { recursive: true })
  directory = await mkdtemp(resolve("output/bot-document-test-"))
  const entry = join(directory, "document.cjs")
  await build({
    entryPoints: ["src/main/bots/document-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["pdfjs-dist/*", "@napi-rs/canvas"],
    logLevel: "silent"
  })
  reader =
    process.env.CMB_BOT_DOCUMENT_BUILT_TEST === "1"
      ? new BotDocumentReader({
          entry: resolve("out/main/bot-document.js"),
          executable: (await import("electron")).default as unknown as string
        })
      : new BotDocumentReader({ entry })
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it("reads real Word beyond the desktop attachment truncation point without losing content", async () => {
  const text = "开头" + "a".repeat(30_000) + "结尾"
  const bytes = wordDocument(text)
  const first = await reader.read("设计.docx", bytes, 0, 16000, signal())
  const second = await reader.read("设计.docx", bytes, first.nextOffset!, 16000, signal())
  expect(first.hasMore).toBe(true)
  expect(second.nextOffset).toBeNull()
  expect(first.text + second.text).toBe(text + "\n\n")
})

it("extracts PDF page text and identifies pages without pretending to OCR scans", async () => {
  const result = await reader.read(
    "report.pdf",
    pdfDocument(["First page", "Last page", ""]),
    0,
    32000,
    signal()
  )
  expect(result.text).toContain("## Page 1\nFirst page")
  expect(result.text).toContain("## Page 2\nLast page")
  expect(result.text).toContain("本页没有可提取的文本")
  expect(result.hasMore).toBe(false)
}, 20_000)

it("renders real scanned PDF pages and rotated crops that text extraction cannot read", async () => {
  const canvas = createCanvas(300, 150),
    context = canvas.getContext("2d")
  context.fillStyle = "red"
  context.fillRect(0, 0, 150, 150)
  context.fillStyle = "blue"
  context.fillRect(150, 0, 150, 150)
  const jpeg = await canvas.encode("jpeg", 95)
  for (const rotated of [false, true]) {
    const bytes = scannedPdfDocument(jpeg, 300, 150, rotated ? 90 : 0)
    const text = await reader.read("scan.pdf", bytes, 0, 1000, signal())
    expect(text.text).toContain("本页没有可提取的文本")
    const view = await reader.pdfPage(bytes, 1, undefined, signal())
    expect(view).toMatchObject({
      page: 1,
      pageCount: 1,
      dpi: 96,
      image: { originalWidth: rotated ? 200 : 400, originalHeight: rotated ? 400 : 200 }
    })
    const region = rotated
      ? { x: 40, y: 270, width: 80, height: 80 }
      : { x: 270, y: 40, width: 80, height: 80 }
    const crop = await reader.pdfPage(bytes, 1, region, signal())
    expect(crop.image).toMatchObject({ width: 80, height: 80, region })
    const image = await loadImage(Buffer.from(crop.image.base64, "base64")),
      sample = createCanvas(80, 80).getContext("2d")
    sample.drawImage(image, 0, 0)
    const [r, g, b] = sample.getImageData(40, 40, 1, 1).data
    expect(b).toBeGreaterThan(240)
    expect(r).toBeLessThan(10)
    expect(g).toBeLessThan(10)
  }
}, 30_000)

it("returns only the selected PDF page as bounded vision content and rejects invalid views", async () => {
  const bytes = pdfDocument(["first", "second"])
  const view = await reader.pdfPage(bytes, 2, undefined, signal())
  expect(view).toMatchObject({ page: 2, pageCount: 2, image: { width: 400, height: 400 } })
  expect(Buffer.byteLength(view.image.base64, "base64")).toBeLessThanOrEqual(BOT_IMAGE_BYTES)
  const message = await botDocumentToolContent(
    reader,
    {
      name: "design.pdf",
      bytes,
      offset: 0,
      limit: 1000,
      pdfPage: 2,
      callId: "page-2"
    },
    signal(),
    () => {}
  )
  expect(typeof message).toBe("object")
  expect(JSON.stringify(message)).toContain("data:image/jpeg;base64,")
  expect(JSON.stringify(message)).toContain("Visual PDF page")
  for (const page of [0, 3, 1001])
    await expect(reader.pdfPage(bytes, page, undefined, signal())).rejects.toThrow()
  await expect(
    reader.pdfPage(bytes, 1, { x: 390, y: 0, width: 20, height: 20 }, signal())
  ).rejects.toThrow("超出页面")
  await expect(reader.pdfPage(Buffer.from("not PDF"), 1, undefined, signal())).rejects.toThrow(
    "有效的 PDF"
  )
  const jpeg = await createCanvas(2, 2).encode("jpeg", 80)
  const large = scannedPdfDocument(jpeg, 100_000, 100_000)
  await expect(reader.pdfPage(large, 1, undefined, signal())).rejects.toThrow("4000 万")
  const boundedPage = scannedPdfDocument(jpeg, 100_000, 100_000, 0, 300, 150)
  await expect(reader.pdfPage(boundedPage, 1, undefined, signal())).rejects.toThrow(
    "无法提供完整图像"
  )
  await expect(
    reader.pdfPage(scannedPdfDocument(Buffer.from("not a JPEG")), 1, undefined, signal())
  ).rejects.toThrow("无法提供完整")
  expect((await reader.pdfPage(bytes, 1, undefined, signal())).page).toBe(1)
}, 30_000)

it("extracts actual spreadsheet values with sheet names and actual presentation slide order", async () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["名称", "金额"],
      ["项目A", 12]
    ]),
    "成本"
  )
  for (const bookType of ["xlsx", "xls"] as const) {
    const bytes = XLSX.write(workbook, { type: "buffer", bookType })
    const result = await reader.read(`cost.${bookType}`, bytes, 0, 32000, signal())
    expect(result.text).toContain("## Sheet: 成本\n名称,金额\n项目A,12")
  }
  const presentation = await reader.read("demo.pptx", presentationDocument(), 0, 32000, signal())
  expect(presentation.text).toBe("## Slide 1\nFirst slide\n\n## Slide 2\nSecond slide")
  await expect(
    reader.read("external.pptx", presentationDocument(true), 0, 1000, signal())
  ).rejects.toThrow("引用缺失")
})

it("rejects corrupt files, oversized inputs and invalid page requests; a subsequent parse still works", async () => {
  await expect(
    reader.read("broken.pdf", Buffer.from("not PDF"), 0, 1000, signal())
  ).rejects.toThrow("有效的 PDF")
  await expect(
    reader.read("big.txt", Buffer.alloc(25 * 1024 * 1024 + 1), 0, 1000, signal())
  ).rejects.toThrow()
  await expect(reader.read("bad.txt", Buffer.from("x"), -1, 1000, signal())).rejects.toThrow()
  expect((await reader.read("valid.txt", Buffer.from("restored"), 0, 1000, signal())).text).toBe(
    "restored"
  )
})

it("pages a Bot plaintext file beyond the old 8M extracted-document limit without changing desktop limits", async () => {
  const bytes = Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 65), Buffer.from("末尾")])
  const result = await reader.read("large.md", bytes, 9 * 1024 * 1024, 100, signal())
  expect(result.text).toBe("末尾")
  expect(result.hasMore).toBe(false)
})

it("terminates a stuck parser on timeout or cancellation without blocking the Host", async () => {
  const entry = join(directory, "blocked.cjs")
  await writeFile(entry, 'process.on("message", () => { while (true) {} })')
  const blocked = new BotDocumentReader({ entry }, 250)
  let ticks = 0
  const ticker = setInterval(() => ticks++, 5)
  try {
    await expect(blocked.read("blocked.txt", Buffer.from("x"), 0, 1000, signal())).rejects.toThrow(
      "超时"
    )
    const controller = new AbortController()
    const reading = blocked.read("blocked.txt", Buffer.from("x"), 0, 1000, controller.signal)
    setTimeout(() => controller.abort(new Error("用户取消")), 50)
    await expect(reading).rejects.toThrow("用户取消")
  } finally {
    clearInterval(ticker)
  }
  expect(ticks).toBeGreaterThan(5)
  expect((await reader.read("next.txt", Buffer.from("next"), 0, 1000, signal())).text).toBe("next")
})

it("decodes supported raster formats and crops from the original, keeping model views bounded", async () => {
  const canvas = createCanvas(3000, 1500),
    context = canvas.getContext("2d")
  context.fillStyle = "blue"
  context.fillRect(0, 0, 3000, 1500)
  context.fillStyle = "red"
  context.fillRect(2300, 400, 200, 100)
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const bytes =
      format === "png"
        ? await canvas.encode(format)
        : format === "gif"
          ? await canvas.encode(format, 90)
          : await canvas.encode(format, 90)
    const view = await reader.image(bytes, undefined, signal())
    expect(view).toMatchObject({
      originalWidth: 3000,
      originalHeight: 1500,
      width: 2048,
      height: 1024
    })
    expect(Buffer.byteLength(view.base64, "base64")).toBeLessThanOrEqual(BOT_IMAGE_BYTES)
    const region = { x: 2300, y: 400, width: 200, height: 100 }
    const crop = await reader.image(bytes, region, signal())
    expect(crop).toMatchObject({ region, width: 200, height: 100 })
    const decoded = await loadImage(Buffer.from(crop.base64, "base64"))
    const sample = createCanvas(200, 100).getContext("2d")
    sample.drawImage(decoded, 0, 0)
    const [red, green, blue] = sample.getImageData(100, 50, 1, 1).data
    expect(red).toBeGreaterThan(240)
    expect(green).toBeLessThan(10)
    expect(blue).toBeLessThan(10)
  }
}, 30_000)

it("rejects decompression-sized headers, corrupt images and invalid crops before returning a view", async () => {
  const bytes = await createCanvas(16, 8).encode("png")
  const bomb = Buffer.from(bytes)
  bomb.writeUInt32BE(100_000, 16)
  bomb.writeUInt32BE(100_000, 20)
  await expect(reader.image(bomb, undefined, signal())).rejects.toThrow("4000 万")
  await expect(reader.image(bytes.subarray(0, 35), undefined, signal())).rejects.toThrow()
  await expect(
    reader.image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), undefined, signal())
  ).rejects.toThrow("仅支持")
  await expect(reader.image(bytes, { x: 15, y: 0, width: 2, height: 1 }, signal())).rejects.toThrow(
    "超出原图"
  )
  await expect(
    reader.image(bytes, { x: -1, y: 0, width: 2, height: 1 }, signal())
  ).rejects.toThrow()
  expect((await reader.image(bytes, undefined, signal())).width).toBe(16)
})
