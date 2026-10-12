import { BOT_FILE_CHUNK_BYTES } from "../../../shared/bot-files"

export async function botBinaryHash(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")
}

/** Shared with Teach playback: never expose a partial or unverified local Blob. */
export async function loadVerifiedBotBlob(
  file: { size: number; sha256: string; mime: string },
  read: (
    offset: number
  ) => Promise<{ offset: number; size: number; sha256: string; base64: string }>,
  signal: AbortSignal,
  progress: (percent: number) => void
): Promise<Blob> {
  const bytes = new Uint8Array(file.size)
  for (let offset = 0; offset < bytes.length; ) {
    signal.throwIfAborted()
    const chunk = await read(offset)
    signal.throwIfAborted()
    if (chunk.offset !== offset || chunk.size !== file.size || chunk.sha256 !== file.sha256)
      throw new Error("文件信息已变化，请重新打开")
    const part = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0))
    if (!part.length || part.length > BOT_FILE_CHUNK_BYTES || offset + part.length > bytes.length)
      throw new Error("文件数据不完整")
    bytes.set(part, offset)
    offset += part.length
    progress(Math.floor((offset * 100) / bytes.length))
  }
  if ((await botBinaryHash(bytes.buffer)) !== file.sha256)
    throw new Error("文件完整性校验失败，不能播放或导出")
  signal.throwIfAborted()
  progress(100)
  return new Blob([bytes], { type: file.mime })
}
