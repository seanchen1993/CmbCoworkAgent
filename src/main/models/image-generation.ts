import { createHash } from "node:crypto"
import { imageGenerationEnvironment } from "./image-generation-environment"

const maxImageBytes = 12 * 1024 * 1024
const maxResponseBytes = 4 * Math.ceil(maxImageBytes / 3) + 64 * 1024
const maxInputPixels = 16_000_000
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class ImageGenerationError extends Error {
  constructor(
    public readonly outcome: "not-submitted" | "rejected" | "unknown" | "unrecoverable",
    message: string
  ) {
    super(message)
  }
}

export interface GeneratedImageResult {
  bytes: Buffer
  mimeType: "image/png"
  width: number
  height: number
  preview: Buffer
  requestId?: string
}

export interface ImageGenerationDeployment {
  /** Identifies the environment, provider, model, settings and credential without exposing them. */
  id: string
  generate(prompt: string, signal?: AbortSignal): Promise<GeneratedImageResult>
}

function invalidResult(): ImageGenerationError {
  return new ImageGenerationError("unrecoverable", "生图服务返回的图片格式、尺寸或内容无效")
}

async function readResponse(response: Response): Promise<unknown> {
  const tooLarge = () => new ImageGenerationError("unrecoverable", "生图服务返回的数据超过大小限制")
  const reader = response.body?.getReader()
  if (!reader) throw invalidResult()
  try {
    if (Number(response.headers.get("content-length")) > maxResponseBytes) throw tooLarge()
    let buffer = Buffer.allocUnsafe(16 * 1024)
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const nextSize = size + value.byteLength
      if (nextSize > maxResponseBytes) throw tooLarge()
      if (nextSize > buffer.byteLength) {
        const next = Buffer.allocUnsafe(Math.min(maxResponseBytes, Math.max(nextSize, size * 2)))
        buffer.copy(next, 0, 0, size)
        buffer = next
      }
      buffer.set(value, size)
      size = nextSize
    }
    try {
      return JSON.parse(buffer.toString("utf8", 0, size))
    } catch {
      throw invalidResult()
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function decodePayload(payload: unknown): Buffer {
  if (!payload || typeof payload !== "object" || !("data" in payload) ||
      !Array.isArray(payload.data) || payload.data.length !== 1) throw invalidResult()
  const item = payload.data[0]
  const value: unknown = item?.b64_json
  if (typeof value !== "string" || !value.length || value.length > 4 * Math.ceil(maxImageBytes / 3) ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidResult()
  const bytes = Buffer.from(value, "base64")
  if (bytes.length > maxImageBytes || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw invalidResult()
  }
  return bytes
}

async function decodePng(bytes: Buffer): Promise<GeneratedImageResult> {
  if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("latin1", 12, 16) !== "IHDR") throw invalidResult()
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height || Math.max(width, height) > 8192 || width * height > maxInputPixels) {
    throw invalidResult()
  }
  // libvips can decode just the first APNG frame. Only publish a complete static PNG.
  let complete = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("latin1", offset + 4, offset + 8)
    offset += length + 12
    if (offset > bytes.length || type === "acTL") throw invalidResult()
    if (type === "IEND") {
      complete = length === 0 && offset === bytes.length
      break
    }
  }
  if (!complete) throw invalidResult()
  try {
    const { default: sharp } = await import("sharp")
    const preview = await sharp(bytes, { failOn: "warning", limitInputPixels: maxInputPixels })
      .timeout({ seconds: 15 })
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer()
    return { bytes, width, height, mimeType: "image/png", preview }
  } catch {
    throw invalidResult()
  }
}

function responseError(status: number): ImageGenerationError {
  if (status === 401 || status === 403) {
    return new ImageGenerationError("rejected", "生图服务拒绝授权，请检查部署凭据与权限")
  }
  if (status === 429) return new ImageGenerationError("rejected", "生图服务已限流，请稍后再试")
  if ([400, 402, 404, 413, 415, 422].includes(status)) {
    return new ImageGenerationError("rejected", "生图服务拒绝了请求，请检查描述或部署配置")
  }
  return new ImageGenerationError("unknown", "无法确认生图服务是否已处理此次请求")
}

let activeRequests = 0

export function getImageGenerationDeployment(
  env: NodeJS.ProcessEnv = imageGenerationEnvironment,
  send: typeof fetch = fetch
): ImageGenerationDeployment | undefined {
  const endpoint = env.CMB_IMAGE_GENERATION_ENDPOINT?.trim()
  const model = env.CMB_IMAGE_GENERATION_MODEL?.trim()
  const key = env.CMB_IMAGE_GENERATION_API_KEY?.trim()
  if (!endpoint && !model && !key) return
  const invalidConfig = () => new ImageGenerationError("not-submitted", "生图服务部署配置无效")
  if (!endpoint || !model || !key || /[^\x21-\x7e]/.test(key)) throw invalidConfig()
  const format = env.CMB_IMAGE_GENERATION_RESPONSE_FORMAT?.trim()
  if (format && format !== "b64_json") throw invalidConfig()
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw invalidConfig()
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) throw invalidConfig()
  const id = createHash("sha256").update(JSON.stringify([
    "images-base64-png-v1", env.CMB_IMAGE_GENERATION_ENVIRONMENT || "custom", url.href,
    model, format || "default", key
  ])).digest("hex")
  return {
    id,
    async generate(prompt, signal) {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_000) {
        throw new ImageGenerationError("not-submitted", "图片描述为空或过长")
      }
      if (signal?.aborted) throw new ImageGenerationError("not-submitted", "已停止生成图片")
      if (activeRequests >= 2) {
        throw new ImageGenerationError("not-submitted", "已有图片正在生成，请稍后重试")
      }
      activeRequests++
      try {
        const timeout = AbortSignal.timeout(180_000)
        const response = await send(url.href, {
          method: "POST",
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { authorization: "Bearer " + key, "content-type": "application/json" },
          body: JSON.stringify({
            model, prompt: prompt.trim(), n: 1, ...(format ? { response_format: format } : {})
          })
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw responseError(response.status)
        }
        const payload = await readResponse(response)
        const result = await decodePng(decodePayload(payload))
        const requestId = response.headers.get("x-request-id")
        if (requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) && requestId !== key) {
          result.requestId = requestId
        }
        return result
      } catch (error) {
        if (error instanceof ImageGenerationError) throw error
        throw new ImageGenerationError("unknown", "连接已中断，无法确认生图结果")
      } finally {
        activeRequests--
      }
    }
  }
}

export function imageGenerationAvailability(): { available: boolean; reason?: string } {
  try {
    if (getImageGenerationDeployment()) return { available: true }
    return { available: false, reason: "尚未配置生图服务" }
  } catch {
    return { available: false, reason: "生图服务部署配置无效" }
  }
}
