import { afterEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { BOT_IM_FILE_MAX_BYTES, BOT_IM_FILE_CHUNK_BYTES } from "../../../shared/bots/im-file"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotBotDeliveryFile } from "../../bots/file-copy"
import { deliverBotImFile } from "./bot-file-delivery"
import type { BotImFileCommand, BotImFileResult } from "../../../shared/bots/im-file"
const folders: string[] = []
afterEach(async () => {
  for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true })
})
async function attachment(size = 75000) {
  const root = await mkdtemp(join(tmpdir(), "bot-im-file-"))
  folders.push(root)
  const filePath = join(root, "中文报告.docx"),
    bytes = Buffer.alloc(size, 0x91)
  await writeFile(filePath, bytes)
  const snapshot = await snapshotBotDeliveryFile(root, filePath, new AbortController().signal)
  return { file: { filePath, name: "中文报告.docx", ...snapshot }, bytes }
}
function transport() {
  const chunks: Buffer[] = []
  const command = vi.fn(async (request: BotImFileCommand): Promise<BotImFileResult> => {
    if (request.action === "begin") return { state: "uploading", uploadId: "upload", offset: 0 }
    if (request.action === "chunk") {
      chunks.push(Buffer.from(request.data, "base64"))
      return {
        state: "uploading",
        uploadId: "upload",
        offset: chunks.reduce((sum, b) => sum + b.length, 0)
      }
    }
    return { state: request.action === "finish" ? "accepted" : "aborted" }
  })
  return { command, chunks }
}
it("streams the sent snapshot, not the subsequently edited workspace original", async () => {
  const { file, bytes } = await attachment(),
    t = transport()
  await writeFile(file.filePath, "edited original")
  expect(await deliverBotImFile(t.command, "reply:file:0", "original-group", file, () => {})).toBe(
    "accepted"
  )
  expect(Buffer.concat(t.chunks)).toEqual(bytes)
  expect(t.chunks.length).toBe(3)
  expect(t.chunks.every((b) => b.length <= 32768)).toBe(true)
  expect(t.command.mock.calls[0][0]).toMatchObject({
    conversationKey: "original-group",
    name: file.name
  })
  expect(JSON.stringify(t.command.mock.calls)).not.toContain(file.filePath)
})
it("rejects tampered copies and aborts before posting a file", async () => {
  const { file } = await attachment(),
    t = transport()
  await writeFile(file.attachmentPath, Buffer.alloc(file.size, 1))
  await expect(deliverBotImFile(t.command, "id", "group", file, () => {})).rejects.toThrow(
    "内容已变化"
  )
  expect(t.command.mock.calls.some(([r]) => r.action === "finish")).toBe(false)
  expect(t.command.mock.calls.at(-1)?.[0].action).toBe("abort")
})
it("reuses a durable accepted receipt even after its local snapshot was removed", async () => {
  const { file } = await attachment()
  await rm(file.attachmentPath)
  const command = vi.fn(async (): Promise<BotImFileResult> => ({ state: "accepted" }))
  expect(await deliverBotImFile(command, "id", "group", file, () => {})).toBe("accepted")
  expect(command).toHaveBeenCalledTimes(1)
})
it("keeps uncertain delivery unknown and does not upload another copy", async () => {
  const { file } = await attachment()
  const command = vi.fn(async (): Promise<BotImFileResult> => ({ state: "unknown" }))
  expect(await deliverBotImFile(command, "id", "group", file, () => {})).toBe("unknown")
  expect(command).toHaveBeenCalledTimes(1)
})
it("rejects oversized files and unverified paths before transmitting", async () => {
  const { file } = await attachment(),
    t = transport()
  await expect(
    deliverBotImFile(
      t.command,
      "id",
      "group",
      { ...file, size: BOT_IM_FILE_MAX_BYTES + 1 },
      () => {}
    )
  ).rejects.toThrow("50 MiB")
  await expect(
    deliverBotImFile(t.command, "id", "group", { ...file, attachmentPath: undefined }, () => {})
  ).rejects.toThrow("副本")
  expect(t.command).not.toHaveBeenCalled()
})
it("rechecks the binding before each chunk and finish", async () => {
  const { file } = await attachment(),
    t = transport()
  let calls = 0
  await expect(
    deliverBotImFile(t.command, "id", "group", file, () => {
      if (++calls === 3) throw new Error("revoked")
    })
  ).rejects.toThrow("revoked")
  expect(t.chunks).toHaveLength(1)
  expect(t.command.mock.calls.at(-1)?.[0].action).toBe("abort")
})

it("transfers a full 50 MiB attachment with bounded chunks and unchanged bytes", async () => {
  const { file, bytes } = await attachment(50 * 1024 * 1024)
  const digest = createHash("sha256")
  let transferred = 0
  let chunks = 0
  const command = async (request: BotImFileCommand): Promise<BotImFileResult> => {
    if (request.action === "begin") {
      expect(request.size).toBe(bytes.length)
      return { state: "uploading", uploadId: "large", offset: 0 }
    }
    if (request.action === "chunk") {
      const chunk = Buffer.from(request.data, "base64")
      expect(chunk.length).toBeLessThanOrEqual(BOT_IM_FILE_CHUNK_BYTES)
      expect(request.offset).toBe(transferred)
      transferred += chunk.length
      digest.update(chunk)
      chunks++
      return { state: "uploading", uploadId: "large", offset: transferred }
    }
    expect(request.action).toBe("finish")
    expect(transferred).toBe(bytes.length)
    expect(digest.digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"))
    return { state: "accepted" }
  }
  expect(await deliverBotImFile(command, "large-file", "original-group", file, () => {})).toBe(
    "accepted"
  )
  expect(chunks).toBe(1600)
})
