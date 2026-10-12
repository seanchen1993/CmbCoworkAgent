import type { CoworkBotAPI } from "../../../shared/bot-api"
import { BOT_FILE_CHUNK_BYTES, botFileByteLimit } from "../../../shared/bot-files"
import { botBinaryHash, loadVerifiedBotBlob } from "./bot-binary-transfer"

export async function uploadBotFile(
  api: Pick<CoworkBotAPI, "beginUpload" | "uploadChunk" | "finishUpload" | "cancelUpload">,
  conversationId: string,
  file: File,
  nonce: string,
  signal: AbortSignal,
  progress: (percent: number) => void
) {
  const mime = file.type || "application/octet-stream"
  if (file.size > botFileByteLimit(file.name, mime))
    throw new Error(`${file.name} 超过限制：普通文件 25 MiB，视频 200 MiB`)
  try {
    signal.throwIfAborted()
    const sha256 = await botBinaryHash(await file.arrayBuffer())
    signal.throwIfAborted()
    const started = await api.beginUpload({
      nonce,
      conversationId,
      name: file.name,
      mime,
      size: file.size,
      sha256
    })
    signal.throwIfAborted()
    if (
      started.id !== nonce ||
      !Number.isSafeInteger(started.offset) ||
      started.offset < 0 ||
      started.offset > file.size
    )
      throw new Error("上传进度无效")
    if (!started.artifact) {
      for (let offset = started.offset; offset < file.size; ) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + BOT_FILE_CHUNK_BYTES).arrayBuffer()
        )
        signal.throwIfAborted()
        let encoded = ""
        for (let i = 0; i < bytes.length; i += 16_384)
          encoded += String.fromCharCode(...bytes.subarray(i, i + 16_384))
        const result = await api.uploadChunk({ id: nonce, offset, base64: btoa(encoded) })
        signal.throwIfAborted()
        if (result.id !== nonce || result.offset !== offset + bytes.length)
          throw new Error("上传分块进度不一致")
        offset = result.offset
        progress(Math.floor((offset * 100) / file.size))
      }
    }
    signal.throwIfAborted()
    const artifact = started.artifact ?? (await api.finishUpload(nonce))
    signal.throwIfAborted()
    if (
      artifact.id !== nonce ||
      artifact.sha256 !== sha256 ||
      artifact.size !== file.size ||
      artifact.conversationId !== conversationId ||
      artifact.name !== file.name ||
      artifact.mime !== mime
    )
      throw new Error("上传结果校验失败")
    progress(100)
    return artifact
  } catch (error) {
    // Network failures retain the nonce and staging data for explicit retry.
    if (signal.aborted) await api.cancelUpload(nonce).catch(() => {})
    throw error
  }
}

export async function loadBotFile(
  id: string,
  read: CoworkBotAPI["fileChunk"],
  signal: AbortSignal,
  progress: (percent: number) => void = () => {}
) {
  signal.throwIfAborted()
  const first = await read({ id, offset: 0 }),
    file = first.artifact
  if (
    file.id !== id ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > botFileByteLimit(file.name, file.mime) ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new Error("文件信息无效")
  const blob = await loadVerifiedBotBlob(
    { ...file, mime: "application/octet-stream" },
    async (offset) => {
      const chunk = offset === 0 ? first : await read({ id, offset })
      if (chunk.artifact.id !== id) throw new Error("文件身份不一致")
      return { ...chunk, size: chunk.artifact.size, sha256: chunk.artifact.sha256 }
    },
    signal,
    progress
  )
  return { artifact: file, blob }
}
