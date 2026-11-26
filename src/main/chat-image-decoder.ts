import { extname } from "node:path"
import { chatImageExtensions, MAX_ATTACHMENT_FILE_BYTES } from "../shared/file-attachment"

let decoding = 0

/** Decode and normalize in the image worker. A validation-only call publishes no asset. */
export async function decodeChatImage(name: string, bytes: ArrayBuffer, tempPath?: string, includeData = false) {
  const extension = extname(name).toLowerCase()
  if (!chatImageExtensions.includes(extension) || !bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES)
    throw new Error("图片格式或大小超限")
  if (decoding >= 3) throw new Error("其他图片正在处理，请稍后重试")
  decoding++
  try {
    const { default: launch } = await import("./chat-image-worker?nodeWorker")
    const worker = launch({
      workerData: { bytes, extension, tempPath, includeData }, transferList: [bytes],
      resourceLimits: { maxOldGenerationSizeMb: 128 }
    })
    const timer = setTimeout(() => void worker.terminate(), 15_000)
    try {
      return await new Promise<{ width: number; height: number; data?: Uint8Array }>((resolve, reject) => {
        worker.once("error", reject)
        worker.once("exit", () => reject(new Error("图片解析任务已结束或超时")))
        worker.once("message", value => value.error ? reject(new Error(value.error)) : resolve(value))
      })
    } finally {
      clearTimeout(timer)
      await worker.terminate()
    }
  } finally {
    decoding--
  }
}
