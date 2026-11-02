import { createHash } from "node:crypto"
import { basename, dirname } from "node:path"
import { openStableFileHandle } from "../stable-file-handle"
import type { BotDeliveredFile } from "../../../shared/bots/file-delivery"
import {
  BOT_IM_FILE_MAX_BYTES,
  BOT_IM_FILE_CHUNK_BYTES,
  type BotImFileCommand,
  type BotImFileResult
} from "../../../shared/bots/im-file"
import { ImGatewayCommandError } from "./gateway-ws-client"

export async function deliverBotImFile(
  command: (request: BotImFileCommand) => Promise<BotImFileResult>,
  deliveryId: string,
  conversationKey: string,
  file: BotDeliveredFile,
  assertCurrent: () => void
): Promise<"accepted" | "unknown"> {
  const fail = (message: string): never => {
    throw new ImGatewayCommandError(message, { permanent: true })
  }
  const path = file.attachmentPath
  if (!path || basename(dirname(dirname(path))) !== ".bot-deliveries")
    fail("附件没有已保存的交付副本，请重新交付")
  if (file.size > BOT_IM_FILE_MAX_BYTES)
    fail(
      `附件「${file.name}」超过招乎发送上限 ${BOT_IM_FILE_MAX_BYTES / 1024 / 1024} MiB，可在 App 中查看`
    )
  const sha256 = basename(dirname(path!))
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("附件校验信息无效")
  assertCurrent()
  const start = await command({
    action: "begin",
    deliveryId,
    conversationKey,
    name: file.name,
    size: file.size,
    sha256
  })
  if (start.state === "accepted" || start.state === "unknown") return start.state
  if (start.state !== "uploading" || !start.uploadId || start.offset !== 0)
    fail(`附件未能发送：${start.reasonCode ?? start.state}`)
  const uploadId = start.uploadId!
  let finished = false
  try {
    let stable
    try {
      stable = await openStableFileHandle(dirname(dirname(dirname(path!))), path!)
    } catch {
      return fail(`附件「${file.name}」无法读取，请重新交付`)
    }
    try {
      if (stable.size !== file.size) fail("附件大小已变化，请重新交付")
      const digest = createHash("sha256")
      const buffer = Buffer.alloc(BOT_IM_FILE_CHUNK_BYTES)
      let offset = 0
      while (offset < file.size) {
        assertCurrent()
        const { bytesRead } = await stable.handle.read(
          buffer,
          0,
          Math.min(buffer.length, file.size - offset),
          offset
        )
        if (!bytesRead) fail("附件内容不完整")
        const chunk = buffer.subarray(0, bytesRead)
        digest.update(chunk)
        const result = await command({
          action: "chunk",
          uploadId,
          offset,
          data: chunk.toString("base64")
        })
        offset += bytesRead
        if (
          result.state !== "uploading" ||
          result.offset !== offset ||
          result.uploadId !== uploadId
        )
          fail("附件分块回执不匹配")
      }
      if (digest.digest("hex") !== sha256) fail("附件内容已变化，请重新交付")
      await stable.assertPathIdentity()
      assertCurrent()
      const result = await command({ action: "finish", uploadId })
      if (result.state !== "accepted" && result.state !== "unknown")
        fail(`附件未能发送：${result.reasonCode ?? result.state}`)
      finished = true
      return result.state as "accepted" | "unknown"
    } finally {
      await stable.handle.close()
    }
  } finally {
    if (!finished) await command({ action: "abort", uploadId }).catch(() => {})
  }
}
