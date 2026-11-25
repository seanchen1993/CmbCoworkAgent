import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"
import type { FileAttachment } from "../../shared/file-attachment"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { botImageMime } from "../../shared/bots/input-files"

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

/** Each selection owns one immutable managed copy. Only its receipt carries the physical path. */
export class BotImageImportBatch {
  private readonly directories: string[] = []
  private readonly images: { index: number; input: PrivateImageInput }[] = []

  async add(index: number, name: string, bytes: ArrayBuffer) {
    const filename = basename(name).replace(/[. ]+$/, "")
    const mimeType = botImageMime(filename, bytes.byteLength)
    if (!mimeType) throw new Error("请选择非空且不超过 5 MiB 的 PNG、JPEG 或 WebP 图片")
    const dir = join(await managedRoot(true), randomUUID())
    const digest = createHash("sha256").update(Buffer.from(bytes)).digest("hex")
    const version = join(dir, ".bot-deliveries", digest)
    active.add(dir)
    this.directories.push(dir)
    await mkdir(version, { recursive: true, mode: 0o700 })
    const path = join(version, "source" + extname(filename).toLowerCase())
    await writeFile(path, Buffer.from(bytes), { flag: "wx", mode: 0o600 })
    this.images.push({ index, input: { path, attachment: {
      filename, filePath: "", mimeType, size: bytes.byteLength, content: "", truncated: false
    } } })
  }

  commit(others: FileAttachment[], retain: (inputs: PrivateImageInput[]) => FileAttachment[]) {
    if (!this.images.length) return others
    const retained = retain(this.images.map(image => image.input))
    this.directories.forEach(dir => active.delete(dir))
    this.directories.length = 0
    const result = [...others]
    this.images.forEach(({ index }, i) => result.splice(index, 0, retained[i]))
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
