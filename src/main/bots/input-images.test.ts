import { expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { isBotImageInput, prepareBotInputImages } from "./input-images"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import type { FileAttachment } from "../../shared/file-attachment"

const png: FileAttachment = {
  filename: "diagram.png", size: 3, truncated: false, filePath: "diagram.png",
  content: "Selected diagram", mimeType: "image/png"
}

it("freezes group images by source group, request and selected member", () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  try {
    const store = new BotStore(db)
    const def = { instructions: "", color: "#123456", modelRef: null }
    const a = store.create({ ...def, name: "A" }), b = store.create({ ...def, name: "B" })
    const group = store.saveGroup({ name: "Review", memberIds: [a.id, b.id] })
    const other = store.saveGroup({ name: "Other", memberIds: [b.id] })
    const first = store.retainGroupImage(group.id, png, "/host-snapshot")
    const second = store.retainGroupImage(other.id, png, "/other-snapshot")
    const text = buildAttachmentMessageParts([first]).attachmentModelBlocks.trim()
    const req = { groupId: group.id, requestId: "review-image", text, targetBotIds: [a.id],
      inputImageIds: [first.botInputId!] }
    expect(() => store.sendGroup({ ...req, inputImageIds: [second.botInputId!] })).toThrow()
    expect(() => store.sendGroup({ ...req, text: text + text })).toThrow()
    const deny = vi.fn(() => { throw new Error("no eligible vision model") })
    expect(() => store.sendGroup(req, deny)).toThrow("no eligible vision model")
    expect(deny.mock.calls).toHaveLength(1)
    expect(store.groupMessages(group.id)).toHaveLength(0)
    expect(store.sendGroup(req)).toBe(true)
    expect(store.groupMessages(group.id)[0].text).toBe("📎 diagram.png")
    expect(store.sendGroup(req, deny)).toBe(false)
    expect(deny.mock.calls).toHaveLength(1)
    expect(store.sendGroup(req)).toBe(false)
    expect(() => store.sendGroup({ ...req, inputImageIds: [] })).toThrow()
    const taskId = db.exec("SELECT id FROM bot_tasks WHERE bot_id=? AND json_extract(origin_json,'$.kind')='group'", [a.id])[0].values[0][0]
    const task = store.getTask(String(taskId))
    expect(store.groupImagesForTask(task).map(file => file.id)).toEqual([first.botInputId])
    expect(store.groupImagesForTask({ ...task, origin: { kind: "discussion", groupId: group.id,
      messageId: req.requestId, round: 1 } })).toEqual([])
    expect(() => store.groupImagesForTask({ ...task, botId: b.id })).toThrow()
    expect(() => store.inputFiles(a.id, [first.botInputId!])).toThrow()
    store.saveGroup({ ...group, memberIds: [b.id] }, group)
    expect(() => store.groupImagesForTask(task)).toThrow()
  } finally {
    db.close()
  }
})

it("stages only the uniquely approved version and checks the same bytes it gives the decoder", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const root = await mkdtemp(join(tmpdir(), "bot-image-"))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "Review", instructions: "", color: "#112233", modelRef: null })
    const data = Buffer.from("img")
    const digest = createHash("sha256").update(data).digest("hex")
    const dir = join(root, ".bot-deliveries", digest)
    await mkdir(dir, { recursive: true })
    const path = join(dir, png.filename)
    await writeFile(path, data)
    const selected = store.retainInputFile(bot.id, png, path)
    const [file] = store.inputFiles(bot.id, [selected.botInputId!])
    const body = buildAttachmentMessageParts([selected]).attachmentModelBlocks
    const task = store.enqueue({ botId: bot.id, requestId: "image", message: body, inputFileIds: [file.id] })
    const stage = vi.fn(async (_thread: string, filename: string, bytes: ArrayBuffer) => {
      expect(Buffer.from(bytes)).toEqual(data)
      return { ...png, image: { id: "snapshot", filename, width: 1, height: 1 } }
    })
    const invoke = (message: string) => prepareBotInputImages(task, task.threadId, message, [file],
      new AbortController().signal, stage)
    expect(await invoke("hook removed the attachment")).toEqual([])
    expect(await invoke(body + body)).toEqual([])
    expect(stage).not.toHaveBeenCalled()
    expect(await invoke(body)).toEqual([{ id: "snapshot", filename: png.filename, slot: 0 }])
    expect(isBotImageInput({ ...file, attachment: { ...selected, mimeType: "application/octet-stream" } })).toBe(false)
    await writeFile(path, "alt")
    await expect(invoke(body)).rejects.toThrow("图片原件已变化")
    expect(stage).toHaveBeenCalledTimes(1)
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
