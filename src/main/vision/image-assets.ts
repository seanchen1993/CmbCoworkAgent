import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_ANALYSIS_IMAGES = 8
export const MAX_IMAGE_ENCODED_BYTES = 20 * 1024 * 1024

export interface ImageReference {
  id: string
  mimeType: string
  source: string
  size: number
}

export interface StoredVisionImage extends ImageReference {
  data: Buffer
}

export function hasImageContent(content: unknown): content is unknown[] {
  return (
    Array.isArray(content) &&
    content.some((item) => {
      if (!item || typeof item !== "object") return false
      return ["image", "image_url", "input_image"].includes(
        String((item as Record<string, unknown>).type)
      )
    })
  )
}

export function detectImageMime(data: Uint8Array): string {
  const bytes = Buffer.from(data)
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg"
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)))
    return "image/gif"
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp"
  throw new Error("图片格式无效，仅支持 PNG、JPEG、GIF、WebP")
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function imageReferenceText(image: ImageReference): string {
  return `[图片 image_id=${image.id}，来源=${JSON.stringify(image.source)}，类型=${image.mimeType}。请使用 analyze_images 读取图片；如工具不可用，请在模型配置中配置多模态模型，不要猜测图片内容。]`
}

/** References are capabilities scoped to a conversation, never filesystem paths or remote URLs. */
export class ImageAssetStore {
  constructor(private readonly root: string) {}

  private directory(threadId: string): string {
    if (!threadId || threadId.length > 512) throw new Error("图片需要有效的会话")
    return join(this.root, digest(threadId))
  }

  async deleteThread(threadId: string): Promise<void> {
    await rm(this.directory(threadId), { recursive: true, force: true })
  }

  async register(threadId: string, data: Buffer, source: string): Promise<ImageReference> {
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error("图片过大，单张不超过 5MB")
    const mimeType = detectImageMime(data)
    const id = `img_${digest(Buffer.concat([Buffer.from(`${threadId}\0`), data]))}`
    const directory = this.directory(threadId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const reference: ImageReference = {
      id,
      mimeType,
      source: source.slice(0, 512),
      size: data.length
    }
    // Content addressing makes retries and repeated history projection stable.
    await writeFile(join(directory, `${id}.bin`), data, { flag: "wx", mode: 0o600 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      }
    )
    await writeFile(join(directory, `${id}.json`), JSON.stringify(reference), {
      flag: "wx",
      mode: 0o600
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    return reference
  }

  async resolve(threadId: string, ids: string[]): Promise<StoredVisionImage[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ANALYSIS_IMAGES)
      throw new Error("每次请提供 1 至 8 个 image_ids")
    let encodedSize = 0
    const images: StoredVisionImage[] = []
    for (const id of ids) {
      if (typeof id !== "string" || !/^img_[a-f0-9]{64}$/.test(id))
        throw new Error("无效的 image_id，请使用本会话已有图片引用")
      const directory = this.directory(threadId)
      try {
        const handle = await open(
          join(directory, `${id}.bin`),
          constants.O_RDONLY | constants.O_NOFOLLOW
        )
        let data: Buffer
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error("invalid image")
          data = Buffer.alloc(MAX_IMAGE_BYTES + 1)
          const { bytesRead } = await handle.read(data, 0, data.length, 0)
          data = data.subarray(0, bytesRead)
          if (data.length > MAX_IMAGE_BYTES) throw new Error("invalid image")
        } finally {
          await handle.close()
        }
        if (`img_${digest(Buffer.concat([Buffer.from(`${threadId}\0`), data]))}` !== id)
          throw new Error("changed image")
        const mimeType = detectImageMime(data)
        const metadata = JSON.parse(
          await readFile(join(directory, `${id}.json`), "utf8")
        ) as ImageReference
        encodedSize += Math.ceil(data.length / 3) * 4
        if (encodedSize > MAX_IMAGE_ENCODED_BYTES) throw new Error("图片编码后总大小超过 20MB")
        images.push({
          id,
          mimeType,
          data,
          size: data.length,
          source: typeof metadata.source === "string" ? metadata.source.slice(0, 512) : "图片"
        })
      } catch (error) {
        if (error instanceof Error && error.message === "图片编码后总大小超过 20MB") throw error
        throw new Error(`图片 ${id} 无权限、已删除或已损坏，请重新上传到当前会话`)
      }
    }
    return images
  }

  async projectContent(threadId: string, content: unknown, source: string): Promise<unknown> {
    if (!hasImageContent(content)) return content
    let count = 0
    let encodedSize = 0
    return Promise.all(
      content.map(async (item, index) => {
        if (!item || typeof item !== "object") return item
        const block = item as Record<string, unknown>
        if (block.type !== "image" && block.type !== "image_url" && block.type !== "input_image")
          return item
        try {
          count += 1
          if (count > MAX_ANALYSIS_IMAGES) throw new Error("单次最多 8 张图片")
          let base64: string | undefined
          if (typeof block.data === "string") base64 = block.data
          const rawUrl =
            typeof block.image_url === "string"
              ? block.image_url
              : ((block.image_url as { url?: unknown } | undefined)?.url ?? block.url)
          if (typeof rawUrl === "string") {
            const match = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(
              rawUrl
            )
            if (!match)
              throw new Error("只接受本会话上传或工具产生的 base64 图片，不接受远端图片 URL")
            base64 = match[1]
          }
          if (
            !base64 ||
            base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(base64.replace(/[\r\n]/g, ""))
          )
            throw new Error("图片编码无效或超过 5MB")
          encodedSize += base64.length
          if (encodedSize > MAX_IMAGE_ENCODED_BYTES) throw new Error("图片编码后总大小超过 20MB")
          const reference = await this.register(
            threadId,
            Buffer.from(base64, "base64"),
            `${source} #${index + 1}`
          )
          return { type: "text", text: imageReferenceText(reference) }
        } catch (error) {
          return {
            type: "text",
            text: `[图片不可用：${error instanceof Error ? error.message : "读取失败"}；请重新上传，不要猜测图片内容。]`
          }
        }
      })
    )
  }
}

let storePromise: Promise<ImageAssetStore> | undefined
async function getStore(): Promise<ImageAssetStore> {
  storePromise ??= import("../storage").then(
    ({ getOpenworkDir }) => new ImageAssetStore(join(getOpenworkDir(), "image-assets"))
  )
  return storePromise
}

export async function registerImage(
  threadId: string,
  data: Buffer,
  source: string
): Promise<ImageReference> {
  return (await getStore()).register(threadId, data, source)
}

export async function resolveImages(threadId: string, ids: string[]): Promise<StoredVisionImage[]> {
  return (await getStore()).resolve(threadId, ids)
}

export async function deleteThreadImages(threadId: string): Promise<void> {
  await (await getStore()).deleteThread(threadId)
}

export async function projectImageContent(
  threadId: string,
  content: unknown,
  source: string
): Promise<unknown> {
  if (!hasImageContent(content)) return content
  return (await getStore()).projectContent(threadId, content, source)
}
