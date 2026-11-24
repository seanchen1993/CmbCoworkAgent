import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import zlib from "node:zlib"
import iconv from "iconv-lite"
import yauzl from "yauzl"

export const MAX_PACKAGE_ZIP_BYTES = 120 * 1024 * 1024
export const MAX_PACKAGE_FILES = 5000
export const MAX_PACKAGE_FILE_BYTES = 30 * 1024 * 1024
export const MAX_PACKAGE_TOTAL_BYTES = 200 * 1024 * 1024
export const MAX_PACKAGE_HTML_BYTES = 5 * 1024 * 1024

export const PACKAGE_SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".DS_Store",
  "__MACOSX",
  ".env",
  ".npmrc"
])

const PRECOMPRESSED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".zip",
  ".gz",
  ".br"
])

export interface PackageSizeLimits {
  maxZipBytes: number
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxHtmlBytes: number
}

export const DEFAULT_PACKAGE_SIZE_LIMITS: PackageSizeLimits = {
  maxZipBytes: MAX_PACKAGE_ZIP_BYTES,
  maxFiles: MAX_PACKAGE_FILES,
  maxFileBytes: MAX_PACKAGE_FILE_BYTES,
  maxTotalBytes: MAX_PACKAGE_TOTAL_BYTES,
  maxHtmlBytes: MAX_PACKAGE_HTML_BYTES
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function computeCrc32(chunk: Buffer, previous = 0): number {
  if (typeof zlib.crc32 === "function") return zlib.crc32(chunk, previous) >>> 0
  let crc = (previous ^ 0xffffffff) >>> 0
  for (let i = 0; i < chunk.length; i++) {
    crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Normalize and strictly validate a package-relative POSIX path, allowing common leading `./` prefixes. */
export function normalizePackageRelativePath(raw: string): string {
  let value = String(raw || "").replace(/\\/g, "/")
  while (value.startsWith("./")) value = value.slice(2)
  if (
    !value ||
    value.startsWith("/") ||
    value.includes(":") ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`包内包含无效路径：${raw}`)
  }
  return value
}

export function shouldSkipPackageRelativePath(raw: string): boolean {
  let value = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "")
  while (value.startsWith("./")) value = value.slice(2)
  if (!value || value === ".") return true
  const parts = value.split("/").filter(Boolean)
  if (!parts.length) return true
  return parts.some((part) => PACKAGE_SKIP_SEGMENTS.has(part))
}

export function decodeZipEntryFileName(raw: Buffer | string, generalPurposeBitFlag: number): string {
  if (typeof raw === "string") return raw
  if ((generalPurposeBitFlag & 0x800) !== 0) return raw.toString("utf8")
  try {
    return utf8Decoder.decode(raw)
  } catch {
    return iconv.decode(raw, "gb18030")
  }
}

function ensureSafeDirectoryChain(rootDir: string, realRootDir: string, targetFile: string): void {
  const relativeDir = path.relative(rootDir, path.dirname(targetFile))
  if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    throw new Error(`资源路径越界：${targetFile}`)
  }
  let current = rootDir
  for (const part of relativeDir.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`设计包目录不可为符号链接或文件：${current}`)
      }
    } else {
      fs.mkdirSync(current)
    }
  }
  const realParent = fs.realpathSync(path.dirname(targetFile))
  const check = path.relative(realRootDir, realParent)
  if (check === ".." || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) {
    throw new Error(`资源目录越界：${targetFile}`)
  }
}

export interface StreamingZipEntryContext {
  relativePath: string
  isDirectory: boolean
  headerSize: number
  openStream: () => Promise<NodeJS.ReadableStream>
}

/** Stream ZIP entries via yauzl with strict path validation, GB18030 fallback, and symlink rejection. */
export async function visitZipStreaming(
  zipPath: string,
  limits: PackageSizeLimits,
  onEntry: (entry: StreamingZipEntryContext) => Promise<void>
): Promise<void> {
  const resolvedPath = path.resolve(zipPath)
  const stat = fs.lstatSync(resolvedPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("请选择普通 .zip 压缩包")
  }
  if (stat.size > limits.maxZipBytes) {
    throw new Error(`压缩包超过 ${Math.round(limits.maxZipBytes / 1024 / 1024)} MB 限制`)
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let activeZip: yauzl.ZipFile | null = null
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try {
        activeZip?.close()
      } catch {
        // Best-effort close on failure.
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    yauzl.open(
      resolvedPath,
      { decodeStrings: false, lazyEntries: true, autoClose: true, validateEntrySizes: false },
      (openErr, zipfile) => {
        if (openErr || !zipfile) {
          fail(openErr ?? new Error("无法打开 ZIP 压缩包"))
          return
        }
        activeZip = zipfile
        if (zipfile.entryCount > limits.maxFiles * 2) {
          fail(new Error("压缩包文件数量过多"))
          return
        }

        zipfile.on("error", fail)
        zipfile.on("end", finish)

        zipfile.on("entry", (entry: yauzl.Entry) => {
          void (async () => {
            if (settled) return
            const rawName = decodeZipEntryFileName(
              entry.fileName as unknown as Buffer | string,
              entry.generalPurposeBitFlag
            )
            if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
              throw new Error(`压缩包不支持符号链接：${rawName}`)
            }

            const normalizedSlash = rawName.replace(/\\/g, "/")
            const isDirectory = normalizedSlash.endsWith("/")
            if (shouldSkipPackageRelativePath(normalizedSlash)) {
              if (!settled) zipfile.readEntry()
              return
            }

            const trimmed = isDirectory ? normalizedSlash.slice(0, -1) : normalizedSlash
            const relativePath = normalizePackageRelativePath(trimmed)

            await onEntry({
              relativePath,
              isDirectory,
              headerSize: entry.uncompressedSize,
              openStream: () =>
                new Promise<NodeJS.ReadableStream>((streamResolve, streamReject) => {
                  zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (streamErr || !readStream) {
                      streamReject(streamErr ?? new Error(`无法读取压缩条目：${relativePath}`))
                    } else {
                      streamResolve(readStream)
                    }
                  })
                })
            })

            if (!settled) zipfile.readEntry()
          })().catch(fail)
        })

        zipfile.readEntry()
      }
    )
  })
}

export async function extractZipStreaming(
  zipPath: string,
  targetRootDir: string,
  limits: PackageSizeLimits = DEFAULT_PACKAGE_SIZE_LIMITS
): Promise<{ files: string[]; totalBytes: number }> {
  fs.mkdirSync(targetRootDir, { recursive: true })
  const realRootDir = fs.realpathSync(targetRootDir)
  const files: string[] = []
  const seenLower = new Set<string>()
  let totalBytes = 0

  await visitZipStreaming(zipPath, limits, async (entry) => {
    if (entry.isDirectory) return
    const key = entry.relativePath.toLowerCase()
    if (seenLower.has(key)) {
      throw new Error(`压缩包包含重复路径：${entry.relativePath}`)
    }
    if (files.length >= limits.maxFiles) {
      throw new Error(`包文件数超过 ${limits.maxFiles} 个限制`)
    }
    if (entry.headerSize > limits.maxFileBytes) {
      throw new Error(`文件超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB 限制：${entry.relativePath}`)
    }
    const isHtml = /\.html?$/i.test(entry.relativePath)
    if (isHtml && entry.headerSize > limits.maxHtmlBytes) {
      throw new Error(`HTML 文件超过 ${Math.round(limits.maxHtmlBytes / 1024 / 1024)} MB 限制：${entry.relativePath}`)
    }

    const targetFile = path.join(targetRootDir, entry.relativePath)
    ensureSafeDirectoryChain(targetRootDir, realRootDir, targetFile)
    if (fs.existsSync(targetFile) && fs.lstatSync(targetFile).isSymbolicLink()) {
      throw new Error(`目标文件不可为符号链接：${entry.relativePath}`)
    }

    const readStream = await entry.openStream()
    const writeStream = fs.createWriteStream(targetFile, { flags: "w" })
    let entryBytes = 0

    await new Promise<void>((resolve, reject) => {
      let done = false
      const abort = (err: unknown) => {
        if (done) return
        done = true
        const destroyable = readStream as NodeJS.ReadableStream & { destroy?: () => void }
        destroyable.destroy?.()
        writeStream.destroy()
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      readStream.on("error", abort)
      writeStream.on("error", abort)
      writeStream.on("finish", () => {
        if (!done) {
          done = true
          resolve()
        }
      })

      readStream.on("data", (chunk: Buffer) => {
        entryBytes += chunk.length
        totalBytes += chunk.length
        if (entryBytes > limits.maxFileBytes) {
          abort(new Error(`文件实际解压大小超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB 限制：${entry.relativePath}`))
          return
        }
        if (isHtml && entryBytes > limits.maxHtmlBytes) {
          abort(new Error(`HTML 实际解压大小超过 ${Math.round(limits.maxHtmlBytes / 1024 / 1024)} MB 限制：${entry.relativePath}`))
          return
        }
        if (totalBytes > limits.maxTotalBytes) {
          abort(new Error(`项目包总大小超过 ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB 限制`))
          return
        }
        if (!writeStream.write(chunk)) {
          readStream.pause()
          writeStream.once("drain", () => {
            if (!done) readStream.resume()
          })
        }
      })

      readStream.on("end", () => {
        if (!done) writeStream.end()
      })
    })

    seenLower.add(key)
    files.push(entry.relativePath)
  })

  files.sort()
  return { files, totalBytes }
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear())
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f)
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f)
  return { dosTime, dosDate }
}

async function writeChunkWithBackpressure(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        stream.off("error", onError)
        resolve()
      }
      const onError = (err: Error) => {
        stream.off("drain", onDrain)
        reject(err)
      }
      stream.once("drain", onDrain)
      stream.once("error", onError)
    })
  }
}

export interface WriteStreamingZipOptions {
  entryOverride?: { relativePath: string; content: Buffer | string }
  excludeEntry?: (name: string, relativePath: string) => boolean
}

/** Stream directory tree into a standard ZIP archive with O(1) memory overhead. */
export async function writeZipFromDirectoryStreaming(
  rootDir: string,
  outputPath: string,
  options: WriteStreamingZipOptions = {}
): Promise<{ fileCount: number; totalBytes: number }> {
  const resolvedRoot = path.resolve(rootDir)
  const resolvedOut = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true })
  const tempPath = path.join(
    path.dirname(resolvedOut),
    `.${path.basename(resolvedOut)}-${randomUUID()}.zip.tmp`
  )

  interface CentralRecord {
    nameBuf: Buffer
    method: number
    dosTime: number
    dosDate: number
    crc32: number
    compressedSize: number
    uncompressedSize: number
    localOffset: number
  }

  const collectedFiles: Array<{ relativePath: string; fullPath: string; mtime: Date }> = []
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/")
      if (options.excludeEntry?.(entry.name, relativePath)) continue
      if (entry.isSymbolicLink()) throw new Error(`导出资源不可为符号链接：${relativePath}`)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) {
        collectedFiles.push({
          relativePath,
          fullPath,
          mtime: fs.statSync(fullPath).mtime
        })
      }
    }
  }
  walk(resolvedRoot)
  collectedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  const overrideTarget = options.entryOverride
    ? {
        relativePath: normalizePackageRelativePath(options.entryOverride.relativePath),
        content: Buffer.isBuffer(options.entryOverride.content)
          ? options.entryOverride.content
          : Buffer.from(options.entryOverride.content, "utf8")
      }
    : null

  const out = fs.createWriteStream(tempPath, { flags: "wx" })
  let outError: Error | null = null
  out.on("error", (err) => {
    outError = err
  })
  const writeOut = async (chunk: Buffer) => {
    if (outError) throw outError
    await writeChunkWithBackpressure(out, chunk)
  }
  const centralRecords: CentralRecord[] = []
  let offset = 0
  let totalUncompressedBytes = 0
  let overrideWritten = false

  const writeEntryFromSource = async (
    relativePath: string,
    mtime: Date,
    inlineBuffer?: Buffer,
    filePath?: string
  ) => {
    const nameBuf = Buffer.from(relativePath, "utf8")
    const ext = path.posix.extname(relativePath).toLowerCase()
    const method = PRECOMPRESSED_EXTENSIONS.has(ext) ? 0 : 8
    const flags = 0x0808 // bit 3 (data descriptor) + bit 11 (UTF-8 filename)
    const { dosTime, dosDate } = toDosDateTime(mtime)
    const localOffset = offset

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed 2.0
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(0, 14) // crc
    localHeader.writeUInt32LE(0, 18) // compressed
    localHeader.writeUInt32LE(0, 22) // uncompressed
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra len

    await writeOut(localHeader)
    await writeOut(nameBuf)
    offset += localHeader.length + nameBuf.length

    let crc = 0
    let uncompressedSize = 0
    let compressedSize = 0

    const streamData = async (source: NodeJS.ReadableStream) => {
      if (method === 0) {
        for await (const rawChunk of source) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
          crc = computeCrc32(chunk, crc)
          uncompressedSize += chunk.length
          compressedSize += chunk.length
          await writeOut(chunk)
          offset += chunk.length
        }
      } else {
        const deflate = zlib.createDeflateRaw({ level: 6 })
        const writeDeflated = (async () => {
          for await (const rawChunk of deflate) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
            compressedSize += chunk.length
            await writeOut(chunk)
            offset += chunk.length
          }
        })()
        try {
          for await (const rawChunk of source) {
            const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
            crc = computeCrc32(chunk, crc)
            uncompressedSize += chunk.length
            if (!deflate.write(chunk)) {
              await new Promise<void>((resolve, reject) => {
                const onDrain = () => {
                  deflate.off("error", onError)
                  resolve()
                }
                const onError = (err: Error) => {
                  deflate.off("drain", onDrain)
                  reject(err)
                }
                deflate.once("drain", onDrain)
                deflate.once("error", onError)
              })
            }
          }
          deflate.end()
          await writeDeflated
        } catch (err) {
          deflate.destroy()
          await writeDeflated.catch(() => undefined)
          throw err
        }
      }
    }

    if (inlineBuffer) {
      const { Readable } = await import("node:stream")
      await streamData(Readable.from([inlineBuffer]))
    } else if (filePath) {
      const fileStream = fs.createReadStream(filePath)
      await streamData(fileStream)
    }

    if (offset + 16 > 0xffffffff) {
      throw new Error("导出 ZIP 体积超出标准 32 位 ZIP 上限")
    }

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc >>> 0, 4)
    descriptor.writeUInt32LE(compressedSize >>> 0, 8)
    descriptor.writeUInt32LE(uncompressedSize >>> 0, 12)
    await writeOut(descriptor)
    offset += descriptor.length

    totalUncompressedBytes += uncompressedSize
    centralRecords.push({
      nameBuf,
      method,
      dosTime,
      dosDate,
      crc32: crc >>> 0,
      compressedSize: compressedSize >>> 0,
      uncompressedSize: uncompressedSize >>> 0,
      localOffset: localOffset >>> 0
    })
  }

  try {
    for (const file of collectedFiles) {
      if (overrideTarget && file.relativePath === overrideTarget.relativePath) {
        overrideWritten = true
        await writeEntryFromSource(file.relativePath, new Date(), overrideTarget.content)
      } else {
        await writeEntryFromSource(file.relativePath, file.mtime, undefined, file.fullPath)
      }
    }
    if (overrideTarget && !overrideWritten) {
      await writeEntryFromSource(overrideTarget.relativePath, new Date(), overrideTarget.content)
    }

    const centralOffset = offset
    let centralSize = 0
    for (const rec of centralRecords) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(0x0314, 4) // version made by: Unix / 2.0
      cd.writeUInt16LE(20, 6)
      cd.writeUInt16LE(0x0808, 8)
      cd.writeUInt16LE(rec.method, 10)
      cd.writeUInt16LE(rec.dosTime, 12)
      cd.writeUInt16LE(rec.dosDate, 14)
      cd.writeUInt32LE(rec.crc32, 16)
      cd.writeUInt32LE(rec.compressedSize, 20)
      cd.writeUInt32LE(rec.uncompressedSize, 24)
      cd.writeUInt16LE(rec.nameBuf.length, 28)
      cd.writeUInt16LE(0, 30)
      cd.writeUInt16LE(0, 32)
      cd.writeUInt16LE(0, 34)
      cd.writeUInt16LE(0, 36)
      cd.writeUInt32LE((0o100644 << 16) >>> 0, 38)
      cd.writeUInt32LE(rec.localOffset, 42)
      await writeOut(cd)
      await writeOut(rec.nameBuf)
      centralSize += cd.length + rec.nameBuf.length
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(centralRecords.length & 0xffff, 8)
    eocd.writeUInt16LE(centralRecords.length & 0xffff, 10)
    eocd.writeUInt32LE(centralSize >>> 0, 12)
    eocd.writeUInt32LE(centralOffset >>> 0, 16)
    eocd.writeUInt16LE(0, 20)
    await writeOut(eocd)

    if (outError) throw outError
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject)
      out.once("finish", resolve)
      out.end()
    })
    fs.renameSync(tempPath, resolvedOut)
    return { fileCount: centralRecords.length, totalBytes: totalUncompressedBytes }
  } catch (error) {
    out.destroy()
    fs.rmSync(tempPath, { force: true })
    throw error
  }
}
