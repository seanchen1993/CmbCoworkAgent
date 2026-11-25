import { parentPort, workerData } from "node:worker_threads"
import { writeFile } from "node:fs/promises"
import sharp from "sharp"

async function normalizeImage() {
  const { bytes, extension, tempPath } = workerData
  const source = Buffer.from(bytes)
  sharp.concurrency(1)
  const decoder = sharp(source, { limitInputPixels: 16_000_000, failOn: "warning" })
  const meta = await decoder.metadata()
  const expected = extension === ".jpg" || extension === ".jpeg" ? "jpeg" : extension.slice(1)
  if (meta.format !== expected || !meta.width || !meta.height ||
    Math.max(meta.width, meta.height) > 8192 || (meta.pages ?? 1) > 1)
    throw new Error("图片类型、帧数或尺寸不受支持")
  if (meta.format === "png") {
    for (let i = 8; i + 12 <= source.length; i += source.readUInt32BE(i) + 12) {
      if (source.toString("ascii", i + 4, i + 8) === "acTL") throw new Error("请选择静态 PNG")
    }
  }
  for (const edge of [2048, 1536, 1024]) {
    const { data, info } = await decoder.clone().rotate()
      .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 92 }).toBuffer({ resolveWithObject: true })
    if (data.length > 2 * 1024 * 1024) continue
    await writeFile(tempPath, data, { flag: "wx", mode: 0o600 })
    return { width: info.width, height: info.height }
  }
  throw new Error("图片压缩后仍超过发送上限")
}

void normalizeImage().then(
  result => parentPort?.postMessage(result),
  error => parentPort?.postMessage({ error: error instanceof Error ? error.message : "图片解析失败" })
)
