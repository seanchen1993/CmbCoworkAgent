import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { createCanvas } from "@napi-rs/canvas"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { wordDocument } from "./document-fixtures"
import * as XLSX from "xlsx"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(blocked = false) {
  const root = await mkdtemp(join(tmpdir(), "cmb-bot-preview-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new BotStore(join(root, "store.sqlite"))
  cleanup.push(() => store.close())
  const entry = blocked
    ? join(root, "blocked.cjs")
    : resolve("src/main/bots/document-worker-entry.ts")
  if (blocked) await writeFile(entry, 'process.on("message", () => setInterval(() => {}, 1000))')
  const reader = new BotDocumentReader({ entry, execArgv: blocked ? [] : ["--import", "tsx"] })
  const files = new BotArtifacts(join(root, "files"), store, reader)
  cleanup.push(() => files.close())
  const conversationId = store.createBot({ nonce: "bot", name: "预览" }).conversationId
  const other = store.createBot({ nonce: "other", name: "另一个" }).conversationId
  const publish = (id: string, name: string, bytes: Buffer) =>
    files.publish(
      { id, name, conversationId, runId: null, mime: "application/octet-stream" },
      bytes
    )
  return { files, publish, conversationId, other, root, reader, store }
}

it("previews immutable Office, HTML source and bounded images using the shared disposable worker", async () => {
  const f = await fixture()
  await f.publish("word", "设计.docx", wordDocument("开头" + "x".repeat(32_000) + "结尾"))
  const first = await f.files.previews.read({
    id: "word",
    conversationId: f.conversationId,
    requestId: "word-1",
    offset: 0
  })
  expect(first.kind).toBe("document")
  if (!("page" in first)) throw new Error("Expected text page")
  expect(first.page.text).toContain("开头")
  expect(first.page.hasMore).toBe(true)
  const last = await f.files.previews.read({
    id: "word",
    conversationId: f.conversationId,
    requestId: "word-2",
    offset: first.page.nextOffset!
  })
  expect(last).toMatchObject({ kind: "document", page: { hasMore: false, text: "xx结尾\n\n" } })
  const html = '<h1>预览</h1><script>throw new Error("NEVER_EXECUTE_IN_HOST")</script>'
  await f.publish("html", "view.html", Buffer.from(html))
  expect(
    await f.files.previews.read({
      id: "html",
      conversationId: f.conversationId,
      requestId: "html",
      offset: 0
    })
  ).toMatchObject({ kind: "html", page: { text: html } })
  const original = await createCanvas(3200, 1600).encode("png")
  await f.publish("image", "image.png", original)
  expect(
    await f.files.previews.read({
      id: "image",
      conversationId: f.conversationId,
      requestId: "image",
      offset: 0
    })
  ).toMatchObject({ kind: "image", image: { width: 2048, height: 1024, originalWidth: 3200 } })
  expect((await f.files.read("image")).bytes.equals(original)).toBe(true)
}, 20_000)

it("rejects another conversation, invalid requests and corrupted content; never mounts SVG as host HTML", async () => {
  const f = await fixture()
  const value = await f.publish("code", "code.ts", Buffer.from("export const ok = true"))
  const request = { id: value.id, conversationId: f.conversationId, requestId: "read", offset: 0 }
  await expect(f.files.previews.read({ ...request, conversationId: f.other })).rejects.toThrow(
    "不属于"
  )
  await expect(f.files.previews.read({ ...request, offset: -1 })).rejects.toThrow()
  expect(await f.files.previews.read(request)).toMatchObject({
    kind: "text",
    page: { text: "export const ok = true" }
  })
  await writeFile(join(f.root, "files", value.sha256), "corrupted")
  await expect(f.files.previews.read(request)).rejects.toThrow("完整性")
  await f.publish("svg", "drawing.svg", Buffer.from('<svg onload="alert(1)"></svg>'))
  expect(await f.files.previews.read({ ...request, id: "svg" })).toMatchObject({ kind: "text" })
  await f.publish("bin", "program.exe", Buffer.from("binary"))
  expect(await f.files.previews.read({ ...request, id: "bin" })).toMatchObject({
    kind: "unsupported"
  })
})

it("returns bounded table pages from the real parser process and preserves conversation checks", async () => {
  const f = await fixture()
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["标题", "值"]]), "摘要")
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(
      Array.from({ length: 53 }, (_, row) =>
        Array.from({ length: 23 }, (_, column) => `${row}:${column}`)
      )
    ),
    "明细"
  )
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })
  await f.publish("table", "报告.xlsx", bytes)
  const request = {
    id: "table",
    conversationId: f.conversationId,
    requestId: "table-page",
    offset: 50,
    sheet: 1,
    columnOffset: 20
  }
  const page = await f.files.previews.read(request)
  expect(page).toMatchObject({
    kind: "table",
    table: {
      sheet: 1,
      rowOffset: 50,
      columnOffset: 20,
      totalRows: 53,
      totalColumns: 23,
      rows: [
        ["50:20", "50:21", "50:22"],
        ["51:20", "51:21", "51:22"],
        ["52:20", "52:21", "52:22"]
      ]
    }
  })
  expect((await f.files.read("table")).bytes.equals(bytes)).toBe(true)
  await expect(f.files.previews.read({ ...request, conversationId: f.other })).rejects.toThrow(
    "不属于"
  )
  await expect(f.files.previews.read({ ...request, sheet: 2 })).rejects.toThrow("工作表不存在")
  await expect(f.files.previews.read({ ...request, columnOffset: -1 })).rejects.toThrow()
}, 20_000)

it("cancels only the requested conversation and kills parsers on close without retaining queue slots", async () => {
  const f = await fixture(true)
  await f.publish("text", "text.txt", Buffer.from("pending"))
  const request = { id: "text", conversationId: f.conversationId, requestId: "cancel", offset: 0 }
  const pending = f.files.previews.read(request)
  const result = expect(pending).rejects.toThrow("取消")
  await delay(75)
  expect(() => f.files.previews.cancel({ ...request, conversationId: f.other })).toThrow("不属于")
  await expect(f.files.previews.read(request)).rejects.toThrow("已存在")
  f.files.previews.cancel(request)
  await result
  const next = f.files.previews.read(request)
  const closing = expect(next).rejects.toThrow("关闭")
  await f.files.close()
  await closing
  await expect(f.files.previews.read(request)).rejects.toThrow("关闭")
})

it("reuses a scoped image parse but still checks every original and rejects changed epochs at completion", async () => {
  const f = await fixture(),
    bytes = await createCanvas(20, 10).encode("png")
  const artifact = await f.publish("shared-image", "image.png", bytes)
  const view = {
    mime: "image/jpeg" as const,
    base64: Buffer.from("view").toString("base64"),
    width: 20,
    height: 10,
    originalWidth: 20,
    originalHeight: 10,
    region: { x: 0, y: 0, width: 20, height: 10 }
  }
  const parse = vi.spyOn(f.reader, "image").mockResolvedValue(view)
  const request = { id: artifact.id, conversationId: f.conversationId, offset: 0 }
  await Promise.all(
    ["gallery", "lightbox", "filmstrip"].map((requestId) =>
      f.files.previews.read({ ...request, requestId })
    )
  )
  expect(parse).toHaveBeenCalledTimes(1)
  await expect(
    f.files.previews.read({ ...request, conversationId: f.other, requestId: "foreign" })
  ).rejects.toThrow("不属于")
  await writeFile(join(f.root, "files", artifact.sha256), "corrupted")
  await expect(
    f.files.previews.read({ ...request, requestId: "corrupt-cache-hit" })
  ).rejects.toThrow("完整性")
  await writeFile(join(f.root, "files", artifact.sha256), bytes)
  const epoch = vi.spyOn(f.store, "dataEpoch").mockReturnValue("next-epoch")
  let complete!: (value: typeof view) => void
  parse.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const pending = f.files.previews.read({ ...request, requestId: "changed-epoch" })
  const rejected = expect(pending).rejects.toThrow("版本已变化")
  await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(2))
  epoch.mockReturnValue("restored-epoch")
  complete(view)
  await rejected
  expect((await f.files.previews.read({ ...request, requestId: "restored" })).kind).toBe("image")
  expect(parse).toHaveBeenCalledTimes(3)
  epoch.mockRestore()
})

it("deleted originals cannot return cached or in-flight raster previews", async () => {
  const f = await fixture(),
    bytes = await createCanvas(20, 10).encode("png")
  const artifact = await f.publish("deleted-image", "image.png", bytes)
  const view = {
    mime: "image/jpeg" as const,
    base64: Buffer.from("view").toString("base64"),
    width: 20,
    height: 10,
    originalWidth: 20,
    originalHeight: 10,
    region: { x: 0, y: 0, width: 20, height: 10 }
  }
  let complete!: (value: typeof view) => void
  const parse = vi.spyOn(f.reader, "image").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const request = {
    id: artifact.id,
    conversationId: f.conversationId,
    offset: 0,
    requestId: "pending-delete"
  }
  const pending = f.files.previews.read(request)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1))
  f.store.deleteArtifact({
    id: artifact.id,
    conversationId: f.conversationId,
    sha256: artifact.sha256,
    nonce: "delete-original",
    expectedDataEpoch: f.store.dataEpoch()
  })
  complete(view)
  await rejected
  await expect(f.files.previews.read({ ...request, requestId: "deleted-cache" })).rejects.toThrow()
  expect(parse).toHaveBeenCalledTimes(1)
})

it("admits seven overlapping gallery consumers without capacity failures or duplicate image decoding", async () => {
  const f = await fixture(),
    bytes = await createCanvas(20, 10).encode("png")
  for (const id of ["a", "b", "c"]) await f.publish(id, `${id}.png`, bytes)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const view = {
    mime: "image/jpeg" as const,
    base64: "AA==",
    width: 20,
    height: 10,
    originalWidth: 20,
    originalHeight: 10,
    region: { x: 0, y: 0, width: 20, height: 10 }
  }
  const parse = vi.spyOn(f.reader, "image").mockImplementation(async () => {
    await gate
    return view
  })
  const read = vi.spyOn(f.files, "read")
  const requests = ["a", "b", "c", "b", "a", "b", "c"].map((id, index) =>
    f.files.previews.read({
      id,
      conversationId: f.conversationId,
      requestId: `view-${index}`,
      offset: 0
    })
  )
  const results = Promise.all(requests)
  try {
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(3))
    expect(read).toHaveBeenCalledTimes(4)
  } finally {
    release()
  }
  expect((await results).map((result) => result.kind)).toEqual(Array(7).fill("image"))
  expect(parse).toHaveBeenCalledTimes(3)
  // Every consumer, including queued cache hits, still verifies the scoped bytes.
  expect(read).toHaveBeenCalledTimes(7)
})

it("bounds waiting preview metadata and cancels queued consumers before reading any bytes", async () => {
  const f = await fixture(),
    bytes = await createCanvas(20, 10).encode("png")
  await f.publish("queued", "queued.png", bytes)
  vi.spyOn(f.reader, "image").mockImplementation(
    (_bytes, _region, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
  )
  const read = vi.spyOn(f.files, "read"),
    request = { id: "queued", conversationId: f.conversationId, offset: 0 }
  const pending = Array.from({ length: 16 }, (_, index) =>
    f.files.previews.read({ ...request, requestId: `queued-${index}` }).then(
      () => "unexpected success",
      (error) => error.message
    )
  )
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  await expect(f.files.previews.read({ ...request, requestId: "excess" })).rejects.toThrow("较多")
  f.files.previews.cancel({ conversationId: f.conversationId, requestId: "queued-15" })
  expect(await pending[15]).toContain("取消")
  expect(read).toHaveBeenCalledTimes(4)
  const replacement = f.files.previews.read({ ...request, requestId: "replacement" }).then(
    () => "unexpected success",
    (error) => error.message
  )
  await f.files.previews.close()
  const results = await Promise.all([...pending, replacement])
  expect(results.every((result) => /取消|关闭/.test(result))).toBe(true)
  expect(read).toHaveBeenCalledTimes(4)
})
