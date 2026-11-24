import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import iconv from "iconv-lite"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_PACKAGE_SIZE_LIMITS,
  decodeZipEntryFileName,
  extractZipStreaming,
  normalizePackageRelativePath,
  writeZipFromDirectoryStreaming
} from "./streaming-zip"

function crc32Raw(buf: Buffer): number {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function buildCustomZip(
  entries: Array<{
    nameBytes: Buffer
    data: Buffer
    flags?: number
    externalAttrs?: number
    method?: 0 | 8
    headerSizeOverride?: number
  }>
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const item of entries) {
    const method = item.method ?? 0
    const payload = method === 8 ? zlib.deflateRawSync(item.data) : item.data
    const crc = crc32Raw(item.data)
    const flags = item.flags ?? 0
    const headerUncompressed = item.headerSizeOverride ?? item.data.length

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(flags, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(payload.length, 18)
    lh.writeUInt32LE(headerUncompressed, 22)
    lh.writeUInt16LE(item.nameBytes.length, 26)
    lh.writeUInt16LE(0, 28)

    localParts.push(lh, item.nameBytes, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(0x0314, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(headerUncompressed, 24)
    cd.writeUInt16LE(item.nameBytes.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE((item.externalAttrs ?? (0o100644 << 16)) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    centralParts.push(cd, item.nameBytes)

    offset += lh.length + item.nameBytes.length + payload.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

const tempRoots: string[] = []
function makeTempDir(prefix = "cmb-streaming-zip-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("streaming-zip", () => {
  it("normalizes ./ prefixes and rejects unsafe traversal/drive paths", () => {
    expect(normalizePackageRelativePath("./pages/home.html")).toBe("pages/home.html")
    expect(normalizePackageRelativePath("././images\\logo.png")).toBe("images/logo.png")
    expect(() => normalizePackageRelativePath("../secret.txt")).toThrow()
    expect(() => normalizePackageRelativePath("/abs/path.html")).toThrow()
    expect(() => normalizePackageRelativePath("C:\\foo.html")).toThrow()
    expect(() => normalizePackageRelativePath("pages/../secret.html")).toThrow()
  })

  it("decodes both UTF-8 bit-11 and GB18030 Chinese entry names", async () => {
    const root = makeTempDir()
    const zipPath = path.join(root, "gb18030.zip")
    const outDir = path.join(root, "out")

    const gbName = iconv.encode("./页面/首页.html", "gb18030")
    const gbImg = iconv.encode("图片/海报背景.png", "gb18030")
    expect(decodeZipEntryFileName(gbName, 0)).toBe("./页面/首页.html")

    const buf = buildCustomZip([
      {
        nameBytes: gbName,
        data: Buffer.from("<html><body><img src='../图片/海报背景.png'></body></html>", "utf8"),
        flags: 0
      },
      {
        nameBytes: gbImg,
        data: Buffer.from("png-bytes"),
        flags: 0
      },
      {
        nameBytes: Buffer.from("__MACOSX/._ignored.html", "utf8"),
        data: Buffer.from("noise"),
        flags: 0x800
      }
    ])
    fs.writeFileSync(zipPath, buf)

    const extracted = await extractZipStreaming(zipPath, outDir)
    expect(extracted.files).toEqual(["页面/首页.html", "图片/海报背景.png"].sort())
    expect(fs.readFileSync(path.join(outDir, "页面/首页.html"), "utf8")).toContain("海报背景.png")
    expect(fs.existsSync(path.join(outDir, "__MACOSX"))).toBe(false)
  })

  it("rejects symlinks and actual decompressed byte limit violations", async () => {
    const root = makeTempDir()
    const symlinkZip = path.join(root, "symlink.zip")
    fs.writeFileSync(
      symlinkZip,
      buildCustomZip([
        {
          nameBytes: Buffer.from("evil-link", "utf8"),
          data: Buffer.from("/etc/passwd", "utf8"),
          externalAttrs: 0o120777 << 16
        }
      ])
    )
    await expect(extractZipStreaming(symlinkZip, path.join(root, "sym-out"))).rejects.toThrow(/符号链接/)

    const bombZip = path.join(root, "bomb.zip")
    fs.writeFileSync(
      bombZip,
      buildCustomZip([
        {
          nameBytes: Buffer.from("big.bin", "utf8"),
          data: Buffer.alloc(1024 * 128, 65),
          method: 8,
          headerSizeOverride: 10
        }
      ])
    )
    await expect(
      extractZipStreaming(bombZip, path.join(root, "bomb-out"), {
        ...DEFAULT_PACKAGE_SIZE_LIMITS,
        maxFileBytes: 64 * 1024
      })
    ).rejects.toThrow(/实际解压大小/)
  })

  it("streams >50 MB archives with STORE media and DEFLATE text and round-trips cleanly", async () => {
    const root = makeTempDir()
    const srcDir = path.join(root, "src")
    const outZip = path.join(root, "package-over-50mb.zip")
    const extractDir = path.join(root, "re-extracted")
    fs.mkdirSync(path.join(srcDir, "pages"), { recursive: true })
    fs.mkdirSync(path.join(srcDir, "images"), { recursive: true })

    fs.writeFileSync(
      path.join(srcDir, "pages/home.html"),
      "<!DOCTYPE html><html><body><img src='../images/big-1.png'></body></html>",
      "utf8"
    )
    const mediaChunk = Buffer.alloc(11 * 1024 * 1024)
    for (let i = 0; i < 5; i++) {
      mediaChunk[0] = i
      mediaChunk[mediaChunk.length - 1] = 255 - i
      fs.writeFileSync(path.join(srcDir, `images/big-${i + 1}.png`), mediaChunk)
    }

    const written = await writeZipFromDirectoryStreaming(srcDir, outZip, {
      entryOverride: {
        relativePath: "pages/home.html",
        content: "<!DOCTYPE html><html><body>updated</body></html>"
      }
    })
    expect(written.fileCount).toBe(6)
    expect(fs.statSync(outZip).size).toBeGreaterThan(50 * 1024 * 1024)

    const extracted = await extractZipStreaming(outZip, extractDir)
    expect(extracted.files.length).toBe(6)
    expect(fs.readFileSync(path.join(extractDir, "pages/home.html"), "utf8")).toContain("updated")
    expect(fs.statSync(path.join(extractDir, "images/big-3.png")).size).toBe(11 * 1024 * 1024)
  })
})
