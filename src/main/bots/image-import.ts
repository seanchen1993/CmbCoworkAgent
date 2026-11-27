import { AsyncKeyedLock } from "../ipc/async-keyed-lock"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import type { DraftAttachmentImage, FileAttachment } from "../../shared/file-attachment"
import { isVisualDocumentPath, MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"
import { decodeChatImage, decodePreviewImage } from "../chat-image-decoder"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { botImageMime, type BotInputFile } from "../../shared/bots/input-files"
import { inputFileSnapshot } from "./input-files"

export type PrivateImageInput = { attachment: FileAttachment; path: string }
const active = new Set<string>()
async function managedRoot(create: boolean): Promise<string> {
  const data = await realpath(getCmbCoworkAgentDataRoot())
  const root = join(data, "bot-image-inputs")
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error("图片受管目录不可用")
  return root
}

export async function readBotImageSelection(directory: string, path: string): Promise<ArrayBuffer> {
  const opened = await openStableFileHandle(directory, path)
  try {
    return Uint8Array.from(await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)).buffer
  } finally {
    await opened.handle.close()
  }
}

// Take one slot per entire preview before opening any snapshots. Waiting IPCs hold only their IDs.
const previewReads = new AsyncKeyedLock({ maxWaitersTotal: 128, label: "Bot image preview" })

export function withBotImagePreview<T>(read: () => Promise<T>): Promise<T> {
  return previewReads.withKey("preview", read)
}

export async function readBotAttachmentImages(file: BotInputFile, lane: string): Promise<DraftAttachmentImage[]> {
  const { filename, size } = file.file
  const direct = Boolean(botImageMime(filename, size))
  if (!direct && !(file.attachment?.embeddedImageCount && isVisualDocumentPath(filename))) return []
  const { path, directory, digest } = inputFileSnapshot(file)
  const bytes = await readBotImageSelection(directory, path)
  if (bytes.byteLength !== size || createHash("sha256").update(Buffer.from(bytes)).digest("hex") !== digest)
    throw new Error("所选附件的保存版本不可用或已变化，请重新选择附件")
  const images: DraftAttachmentImage[] = []
  const add = async (name: string, source: ArrayBuffer, label: string) => {
    const { data } = await decodePreviewImage(name, source)
    if (!data) throw new Error("图片预览不可用")
    images.push({ filename: label, url: "data:image/webp;base64," + Buffer.from(data).toString("base64") })
  }
  if (direct) await add(filename, bytes, filename)
  else {
    const { getFileAttachmentParserClient } = await import("../file-attachment-parser/client")
    const parsed = await getFileAttachmentParserClient("preview").parse({ kind: "bytes", fileName: filename, bytes }, 1, lane, true)
    if (parsed.documentImages?.length !== file.attachment?.embeddedImageCount)
      throw new Error("文档内嵌图片读取不完整")
    for (const image of parsed.documentImages ?? [])
      await add("embedded" + image.extension, image.bytes, filename + " · 图片 " + (image.index + 1))
  }
  return images
}

/** Each selection owns one immutable managed copy. Only its receipt carries the physical path. */
export class BotImageImportBatch {
  private readonly directories: string[] = []
  private readonly images: { index: number; input: PrivateImageInput }[] = []

  async add(index: number, name: string, bytes: ArrayBuffer) {
    const filename = basename(name).replace(/[. ]+$/, "")
    const mimeType = botImageMime(filename, bytes.byteLength)
    if (!mimeType) throw new Error("请选择非空且不超过 5 MiB 的 PNG、JPEG 或 WebP 图片")
    await decodeChatImage(filename, bytes.slice(0))
    const dir = join(await managedRoot(true), randomUUID())
    const digest = createHash("sha256").update(Buffer.from(bytes)).digest("hex")
    const version = join(dir, ".bot-deliveries", digest)
    active.add(dir)
    this.directories.push(dir)
    await mkdir(version, { recursive: true, mode: 0o700 })
    const path = join(version, "source" + extname(filename).toLowerCase())
    await writeFile(path, Buffer.from(bytes), { flag: "wx", mode: 0o600 })
    this.addRetained(index, {
      filename, filePath: "", mimeType, size: bytes.byteLength, content: "", truncated: false
    }, path)
  }

  addRetained(index: number, attachment: FileAttachment, path: string) {
    this.images.push({ index, input: { attachment, path } })
  }

  commit(others: FileAttachment[], retain: (inputs: PrivateImageInput[]) => FileAttachment[]) {
    if (!this.images.length) return others
    const ordered = this.images.toSorted((a, b) => a.index - b.index)
    const retained = retain(ordered.map(image => image.input))
    this.directories.forEach(dir => active.delete(dir))
    this.directories.length = 0
    const result = [...others]
    ordered.forEach(({ index }, i) => result.splice(index, 0, retained[i]))
    return result
  }

  async close() {
    await Promise.all(this.directories.map(async dir => {
      try { await rm(dir, { recursive: true, force: true }) } finally { active.delete(dir) }
    }))
  }
}

export async function sweepBotImageInputs(retainedPaths: (root: string) => string[]) {
  const root = await managedRoot(false).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined
    throw e
  })
  if (!root) return
  const folders = await readdir(root, { withFileTypes: true })
  if (!folders.length) return
  // Read the receipt index and active operations together, before awaiting individual deletions.
  const owned = new Set(active)
  for (const path of retainedPaths(root)) owned.add(dirname(dirname(dirname(path))))
  for (const folder of folders) {
    if (!folder.isDirectory() || !/^[a-f0-9-]{36}$/.test(folder.name)) continue
    const dir = join(root, folder.name)
    if (!owned.has(dir) && !active.has(dir)) await rm(dir, { recursive: true, force: true })
  }
}
