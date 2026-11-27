import { visualDocx } from "../../../tests/support/document-attachment-fixtures.mjs"
import { parseFileBytes } from "../file-parser"
import { expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { canonicalBotMessageInput } from "../../shared/bots/message-mentions"
import { LocalBotHost } from "./host"
import { BotStore } from "./store"
import { attachmentFallbackText } from "../../shared/file-attachment"
import { botBoundImageIds, isBotImageInput, prepareBotInputImages } from "./input-images"
import { inputAttachmentHash, projectWorkInputAttachment } from "./input-files"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import type { FileAttachment } from "../../shared/file-attachment"

const png: FileAttachment = {
  filename: "diagram.png", size: 3, truncated: false, filePath: "diagram.png",
  content: "Selected diagram", mimeType: "image/png"
}

it("preserves blank user text for pure Bot images and the existing fallback for documents", () => {
  expect(attachmentFallbackText([{ ...png, filePath: "", botInputId: "user-selection" }])).toBe("")
  expect(attachmentFallbackText([{ ...png, mimeType: "text/plain" }])).toBe("请分析以下文件内容。")
})

it("keeps a visual document's exhausted text budget when it moves to a work snapshot", () => {
  const document: FileAttachment = {
    filename: "visual.docx", filePath: "source.docx",
    content: "", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 27, truncated: true, embeddedImageCount: 1
  }
  const projected = projectWorkInputAttachment({
    id: "document-receipt", botId: "bot", file: document,
    attachment: document, blockHash: inputAttachmentHash(document)
  }, "work-snapshot.docx")
  expect(projected).toMatchObject({ filePath: "work-snapshot.docx", content: "", embeddedImageCount: 1 })
})

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
    const doc = store.retainGroupImage(group.id, { ...png, filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      embeddedImageCount: 3 }, "/group-doc")
    const overBudget = buildAttachmentMessageParts([first, doc], true).attachmentModelBlocks
    expect(() => store.sendGroup({ ...req, text: overBudget, inputImageIds: [first.botInputId!, doc.botInputId!] }))
      .toThrow("最多发送 3 张图片")
    expect(store.groupMessages(group.id)).toHaveLength(0)
    expect(() => store.sendGroup({ ...req, inputImageIds: [second.botInputId!] })).toThrow()
    expect(() => store.sendGroup({ ...req, text: text + text })).toThrow()
    const deny = vi.fn(() => { throw new Error("no eligible vision model") })
    expect(() => store.sendGroup(req, deny)).toThrow("no eligible vision model")
    expect(deny.mock.calls).toHaveLength(1)
    expect(store.groupMessages(group.id)).toHaveLength(0)
    expect(store.sendGroup(req)).toBe(true)
    expect(store.groupMessages(group.id)[0]).toMatchObject({ text: "📎 diagram.png", hasInputImages: true })
    expect(store.groupMessageImageInputs(group.id, req.requestId).map(file => file.id)).toEqual([first.botInputId])
    expect(store.groupMessageImageInputs(other.id, req.requestId)).toEqual([])
    expect(store.groupMessageImageInputs(group.id, first.botInputId!)).toEqual([])
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
    expect(store.groupMessageImageInputs(group.id, req.requestId)[0].id).toBe(first.botInputId)
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
    expect(store.desktopMessageImageInput(bot.id, file.id, "image").id).toBe(file.id)
    expect(() => store.desktopMessageImageInput(bot.id, file.id, "other-message")).toThrow()
    expect(store.messageOrigins(bot.id, ["image"])[0].origin).toMatchObject({ visualInputFileIds: [file.id] })
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

it.each(["accept", "reject"] as const)("reports private image admission after the runtime decision: %s", async result => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  let signalPrepared!: () => void
  let finish!: () => void
  const running = new Promise<void>(resolve => { signalPrepared = resolve })
  const decision = new Promise<void>(resolve => { finish = resolve })
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release: vi.fn(),
      async execute() {
        signalPrepared()
        await decision
        if (result === "reject") return { state: "failed", error: "没有视觉模型" }
        host.acceptDesktopImageInput(task.id)
        return { state: "completed" }
      }
    })
  })
  try {
    const bot = store.create({ name: "Reader", instructions: "", color: "#112233", modelRef: null })
    const file = store.retainInputFile(bot.id, png, "/host-snapshot")
    const request = { botId: bot.id, requestId: "private-image", inputFileIds: [file.botInputId!],
      message: buildAttachmentMessageParts([file]).attachmentModelBlocks.trim() }
    const hash = createHash("sha256").update(canonicalBotMessageInput(request.message, undefined, request.inputFileIds)).digest("hex")
    const receipt = () => host.requestReceipts(bot.id, [{ requestId: request.requestId, messageHash: hash }])[0].state
    const submission = Promise.resolve(host.sendDesktopMessage(request))
    let done = false
    submission.then(() => { done = true }, () => { done = true })
    await running
    expect(done).toBe(false)
    expect(receipt()).toBe("admitting")
    expect(host.cancelQueuedImageInput(bot.id, { requestId: request.requestId, messageHash: hash })).toBe(false)
    finish()
    if (result === "accept") {
      const first = await submission
      expect(receipt()).toBe("accepted")
      expect((await host.sendDesktopMessage(request)).id).toBe(first.id)
    } else {
      await expect(submission).rejects.toThrow("没有视觉模型")
      expect(receipt()).toBe("rejected")
    }
  } finally {
    finish()
    await host.stop()
    db.close()
  }
})


it("acknowledges and withdraws an exact visual request while another private turn owns the lease", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  let entered!: () => void
  let finish!: () => void
  const active = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { finish = resolve })
  const execute = vi.fn(async () => {
    entered()
    await hold
    return { state: "completed" as const }
  })
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: () => ({ release: vi.fn(), execute })
  })
  try {
    const bot = store.create({ name: "Reader", instructions: "", color: "#112233", modelRef: null })
    const other = store.create({ name: "Other", instructions: "", color: "#112233", modelRef: null })
    const first = host.send({ botId: bot.id, requestId: "first", message: "working" })
    await active
    const file = store.retainInputFile(bot.id, png, "/host-snapshot")
    const request = { botId: bot.id, requestId: "queued-image", inputFileIds: [file.botInputId!],
      message: buildAttachmentMessageParts([file]).attachmentModelBlocks.trim() }
    const hash = createHash("sha256").update(canonicalBotMessageInput(request.message, undefined, request.inputFileIds)).digest("hex")
    const check = { requestId: request.requestId, messageHash: hash }
    const receipt = () => host.requestReceipts(bot.id, [check])[0].state

    const queued = await host.sendDesktopMessage(request)
    expect(queued.state).toBe("queued")
    expect(receipt()).toBe("queued")
    expect(host.cancelQueuedImageInput(other.id, check)).toBe(false)
    expect(host.cancelQueuedImageInput(bot.id, { ...check, messageHash: "0".repeat(64) })).toBe(false)
    expect(host.cancelQueuedImageInput(bot.id, check)).toBe(true)
    expect(host.cancelQueuedImageInput(bot.id, check)).toBe(true)
    expect(receipt()).toBe("withdrawn")
    expect(() => host.desktopAttachmentPreviewInput(bot.id, file.botInputId!, undefined, undefined, request.requestId))
      .toThrow("此消息没有该附件")
    expect(store.getTask(first.id).state).toBe("running")
    expect(() => host.sendDesktopMessage(request)).toThrow("图片消息已取消发送")
    finish()
    await vi.waitFor(() => expect(store.getTask(first.id).state).toBe("completed"))
    expect(store.getTask(queued.id).state).toBe("cancelled")
    expect(execute).toHaveBeenCalledOnce()
  } finally {
    finish()
    await host.stop()
    db.close()
  }
})

vi.mock("../file-attachment-parser/client", () => ({
  getFileAttachmentParserClient: () => ({
    parse: ({ fileName, bytes }: { fileName: string; bytes: ArrayBuffer },
      maxLength?: number, _key?: string, includeImageBytes?: boolean) =>
      parseFileBytes(fileName, bytes, maxLength, includeImageBytes),
    cancelLatest: () => undefined
  })
}))

it("extracts ordered pixels from the authorized immutable Word version and binds their resume identities", async () => {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const root = await mkdtemp(join(tmpdir(), "bot-visual-doc-"))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "Word Review", instructions: "", color: "#112233", modelRef: null })
    const pixels = [Buffer.from("first"), Buffer.from("second")]
    const data: Buffer = visualDocx(pixels)
    const digest = createHash("sha256").update(data).digest("hex")
    const dir = join(root, ".bot-deliveries", digest)
    await mkdir(dir, { recursive: true })
    const path = join(dir, "report.docx")
    await writeFile(path, data)
    const parsed = await parseFileBytes("report.docx", Uint8Array.from(data).buffer)
    const selected = store.retainInputFile(bot.id, parsed, path)
    const [file] = store.inputFiles(bot.id, [selected.botInputId!])
    const body = buildAttachmentMessageParts([selected], true).attachmentModelBlocks
    const task = store.enqueue({ botId: bot.id, requestId: "word", message: body, inputFileIds: [file.id] })
    const approved = [...botBoundImageIds(task, [file])]
    const stage = vi.fn(async (_thread: string, filename: string, bytes: ArrayBuffer) => {
      const index = pixels.findIndex(pixel => pixel.equals(Buffer.from(bytes)))
      expect(index).toBeGreaterThanOrEqual(0)
      return { ...png, image: { id: approved[index], filename, width: 1, height: 1 } }
    })
    const invoke = (message: string) => prepareBotInputImages(task, task.threadId, message, [file],
      new AbortController().signal, stage)
    expect(await invoke("hook removed the Word attachment")).toEqual([])
    expect(await invoke(body + body)).toEqual([])
    expect(stage).not.toHaveBeenCalled()
    const images = await invoke(body)
    expect(images.map(item => item.id)).toEqual(approved)
    expect(images[0].filename).toContain("report.docx · 图 1")
    expect(images[1].filename).toContain("report.docx · 图 2")
    await writeFile(path, Buffer.alloc(data.length))
    await expect(invoke(body)).rejects.toThrow("图片原件已变化")
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
