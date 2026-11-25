import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Worker, type WorkerOptions } from "node:worker_threads"
import { transformSync } from "esbuild"
import { HumanMessage } from "@langchain/core/messages"
import sharp from "sharp"
import { buildAttachmentMessageParts } from "../shared/attachment-message-parts"
import { checkpointHasChatImages } from "../shared/checkpoint-transcript"
import { materializeChatImages } from "./agent/chat-image-middleware"
import {
  approveChatImages,
  beginChatImageSubmission,
  bindBotChatImages,
  bindChatImages,
  boundChatImageReceipt,
  boundChatImages,
  copyBoundChatImages,
  discardChatDraftImage,
  pinQueuedChatImages,
  readChatImage,
  stageChatImage,
  sweepChatImageStorage,
  unpinQueuedChatImages
} from "./chat-images"
import * as db from "./db"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("./storage", async importOriginal => ({
  ...(await importOriginal<typeof import("./storage")>()),
  getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("./chat-image-worker?nodeWorker", () => ({
  default(options: WorkerOptions) {
    const file = fileURLToPath(new URL("./chat-image-worker.ts", import.meta.url))
    const code = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "cjs" }).code
    const load = 'require("module").createRequire(' + JSON.stringify(file) + ')'
    return new Worker("(function(require) {" + code + "})(" + load + ")", { ...options, eval: true })
  }
}))

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "chat-image-test-"))
  state.path = join(directory, "threads.sqlite")
  vi.stubEnv("CMB_COWORK_AGENT_HOME", directory)
  await db.initializeDatabase()
  for (const id of ["parent", "child", "other"]) db.createThread(id)
})
afterAll(async () => {
  await db.closeDatabase()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe("chat image input", () => {
  const request = {
    threadId: "parent",
    userMessageId: "deduplicated",
    message: "original attachment prompt",
    modelId: "vision",
    chatImages: [{ id: "2a1f79f4-dbf8-40a0-bc67-59f219b8bfe0", filename: "report.png", slot: 0 }]
  }

  it("joins a pending invoke and replays the original approval after ACK loss", async () => {
    db.getDb().run("INSERT OR IGNORE INTO chat_image_input_owners VALUES (?, '', ?, '')",
      ["parent", request.chatImages[0].id])
    const first = beginChatImageSubmission(request)
    const concurrent = beginChatImageSubmission({ ...request, streamRequestId: "different-listener" })
    if (!first || !("owner" in first) || !concurrent || !("replay" in concurrent)) throw new Error("bad admission")
    expect(() => beginChatImageSubmission({ ...request, chatImages: [] })).toThrow("不同内容")
    expect(() => beginChatImageSubmission({ ...request, modelId: "other" })).toThrow("不同内容")
    first.owner.accept("edited text without the attachment", [])
    first.owner.release()
    const expected = {
      submissionId: request.userMessageId, preparedText: "edited text without the attachment", images: []
    }
    expect(await concurrent.replay).toEqual(expected)
    const afterAckLoss = beginChatImageSubmission(request)
    if (!afterAckLoss || !("replay" in afterAckLoss)) throw new Error("replayed as a new submission")
    expect(await afterAckLoss.replay).toEqual(expected)
    expect(boundChatImageReceipt("parent", request.userMessageId)).toEqual(expected)
    expect(() => beginChatImageSubmission({ ...request, message: "changed" })).toThrow("不同内容")
    db.upsertThreadMessages("parent", [
      { id: request.userMessageId, role: "user", content: request.message, created_at: new Date(1) }
    ])
    expect(db.replaceThreadMessageId("parent", request.userMessageId, "renamed", "user")).toBe(true)
    const afterRename = beginChatImageSubmission(request)
    if (!afterRename || !("replay" in afterRename)) throw new Error("lost receipt after display rename")
    expect(await afterRename.replay).toEqual(expected)
  })

  it("releases rejected claims without committing approvals or injecting a second turn", async () => {
    db.getDb().run("INSERT OR IGNORE INTO chat_image_input_owners VALUES (?, '', ?, '')",
      ["parent", request.chatImages[0].id])
    const attempt = { ...request, userMessageId: "rejected" }
    const first = beginChatImageSubmission(attempt)
    const duplicate = beginChatImageSubmission(attempt)
    if (!first || !("owner" in first) || !duplicate || !("replay" in duplicate)) throw new Error("bad admission")
    first.owner.release()
    expect(await duplicate.replay).toBeUndefined()
    expect(boundChatImageReceipt("parent", attempt.userMessageId)).toBeUndefined()
    const retry = beginChatImageSubmission({ ...attempt, message: "corrected" })
    if (!retry || !("owner" in retry)) throw new Error("retry not admitted")
    retry.owner.accept("corrected", request.chatImages)
    expect(() => first.owner.accept("stale owner", [])).toThrow("已变更")
  })

  it("reads legacy image receipts and forbids copying Bot grants on fork", async () => {
    const { createHash } = await import("node:crypto")
    const legacyInput = JSON.stringify([request.message, request.chatImages])
    const digest = createHash("sha256").update(legacyInput).digest("hex")
    db.getDb().run("INSERT INTO chat_image_messages VALUES (?, ?, ?, ?)",
      ["parent", "legacy-approval", digest, JSON.stringify(request.chatImages)])
    const legacy = beginChatImageSubmission({ ...request, userMessageId: "legacy-approval" })
    if (!legacy || !("replay" in legacy)) throw new Error("legacy receipt not found")
    expect(await legacy.replay).toEqual({ images: request.chatImages })
    bindBotChatImages("parent", "bot-message", "bot body", "prepared body", request.chatImages)
    await copyBoundChatImages("parent", "child", "bot-message")
    expect(boundChatImageReceipt("child", "bot-message")).toBeUndefined()
  })

  it.each(["png", "jpeg", "webp"] as const)("normalizes %s and sends the approved pixels", async format => {
    const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: "red" } })
      .toFormat(format).toBuffer()
    const file = await stageChatImage("parent", "test." + format, Uint8Array.from(bytes).buffer,
      { draftWorkspace: "" })
    const { attachmentModelBlocks } = buildAttachmentMessageParts([file])
    const refs = [{ id: file.image!.id, filename: file.filename, slot: 0 }]
    const approved = await approveChatImages("parent", attachmentModelBlocks, attachmentModelBlocks, refs)
    expect(approved).toEqual(refs)
    await expect(approveChatImages("other", attachmentModelBlocks, attachmentModelBlocks, refs))
      .rejects.toThrow()
    expect(await approveChatImages("parent", attachmentModelBlocks, "removed by hook", refs)).toEqual([])
    expect(await approveChatImages("parent", attachmentModelBlocks, attachmentModelBlocks.repeat(2), refs)).toEqual([])
    bindChatImages("parent", format, attachmentModelBlocks, refs, approved)
    const message = new HumanMessage({ id: format, content: attachmentModelBlocks,
      additional_kwargs: { cmb_chat_images: approved } })
    const [outbound] = await materializeChatImages("parent", [message], "desktop")
    expect((await materializeChatImages("parent", [message]))[0]).toBe(message)
    expect((await materializeChatImages("parent", [message], {}))[0]).toBe(message)
    expect((await materializeChatImages("parent", [message], { messageId: "other" }))[0]).toBe(message)
    expect(message.content).toBe(attachmentModelBlocks)
    const content = outbound.content as Array<{ image_url?: { url: string } }>
    const url = content.find(block => block.image_url)?.image_url?.url
    expect(url).toMatch(/^data:image\/webp;base64,/)
    const metadata = await sharp(Buffer.from(url!.split(",")[1], "base64")).metadata()
    expect(metadata).toMatchObject({ format: "webp", width: 8, height: 4 })
    await copyBoundChatImages("parent", "child", format)
    expect((await materializeChatImages("child", [message], "desktop"))[0].content).toEqual(outbound.content)
    await expect(materializeChatImages("other", [message], "desktop")).rejects.toThrow("无法读取")
    const task = new HumanMessage({ id: "bot-" + format, content: attachmentModelBlocks,
      additional_kwargs: { cmb_chat_images: refs, cmb_chat_images_source: "bot" } })
    bindBotChatImages("parent", task.id!, "original", attachmentModelBlocks, refs)
    expect((await materializeChatImages("parent", [task], "desktop"))[0]).toBe(task)
    const bot = await materializeChatImages("parent", [message, task], { messageId: task.id })
    expect(bot[0]).toBe(message)
    expect(bot[1].content).toEqual(outbound.content)
    expect(checkpointHasChatImages({ channel_values: { messages: [task] } })).toBe(false)
    expect(checkpointHasChatImages({ channel_values: { messages: [message] } })).toBe(true)
    const [forked] = await materializeChatImages("child", [task], "desktop")
    expect(forked.content).toContain(file.filename)
    expect(forked.content).not.toContain("base64")
  })

  it("separates grant-free Bot pixels, draft, queue and accepted owners", async () => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "blue" } }).png().toBuffer()
    const stage = (options?: Parameters<typeof stageChatImage>[3]) =>
      stageChatImage("parent", "photo.png", Uint8Array.from(png).buffer, options)
    const bot = await stage({ deduplicationKey: "task-only" })
    const draft = await stage({ draftWorkspace: "" })
    const other = await stage({ draftWorkspace: "other" })
    const make = (file: typeof draft, messageId = crypto.randomUUID()) => ({
      threadId: "parent", userMessageId: messageId, message: buildAttachmentMessageParts([file]).attachmentModelBlocks,
      chatImages: [{ id: file.image!.id, slot: 0, filename: file.filename }]
    })
    for (const file of [bot, other]) {
      const req = make(file)
      expect(() => beginChatImageSubmission(req)).toThrow("当前草稿")
      await expect(approveChatImages("parent", req.message, req.message, req.chatImages, req.userMessageId)).rejects.toThrow("当前草稿")
    }
    const req = make(draft), ids = [draft.image!.id]
    pinQueuedChatImages("parent", null, req.userMessageId, ids)
    await discardChatDraftImage("parent", null, ids[0])
    expect(() => beginChatImageSubmission(make(draft))).toThrow("当前草稿")
    expect(await approveChatImages("parent", req.message, req.message, req.chatImages, req.userMessageId)).toEqual(req.chatImages)
    await unpinQueuedChatImages("parent", req.userMessageId, null)
    await expect(readChatImage("parent", ids[0])).rejects.toThrow()
    const acceptedFile = await stage({ draftWorkspace: "" })
    const accepted = make(acceptedFile)
    const claim = beginChatImageSubmission(accepted)
    if (!claim || !("owner" in claim)) throw new Error("expected fresh claim")
    claim.owner.accept(accepted.message, accepted.chatImages)
    await discardChatDraftImage("parent", null, acceptedFile.image!.id)
    await expect(readChatImage("parent", acceptedFile.image!.id)).resolves.toHaveProperty("image_url")
    expect(() => beginChatImageSubmission(make(acceptedFile))).toThrow("当前草稿")
  })

  it("delivers decodable pixels and the question in the same HTTP completion", async () => {
    const { getModelInstance } = await import("./agent/runtime")
    const recorded: string[] = []
    let simulateRetry = false
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk.toString()
      recorded.push(body)
      if (simulateRetry) {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "test backoff" } }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ model: "sample", choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }
      ] }))
    })
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("unexpected server address")
      const config = { id: "vision", model: "sample", apiKey: "fixture",
        baseUrl: "http://127.0.0.1:" + address.port + "/v1" }
      const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: "blue" } })
        .png().toBuffer()
      const asset = await stageChatImage("parent", "figure.png", Uint8Array.from(png).buffer)
      const marker = buildAttachmentMessageParts([asset]).attachmentModelBlocks
      const body = "图中是什么颜色？" + marker
      const refs = [{ id: asset.image!.id, filename: asset.filename, slot: 0 }]
      bindChatImages("parent", "http", body, refs, refs)
      const messages = await materializeChatImages("parent", [new HumanMessage({ id: "http", content: body })], "desktop")
      await expect(getModelInstance(config, undefined, 1).invoke(messages)).rejects.toThrow("图片输入")
      expect(recorded).toHaveLength(0)
      await getModelInstance({ ...config, inputModalities: ["text", "image"] }, undefined, 1)
        .invoke(messages)
      expect(recorded).toHaveLength(1)
      const content = JSON.parse(recorded[0]).messages[0].content
      expect(content[0].text).toContain("图中是什么颜色")
      const decoded = await sharp(Buffer.from(content[1].image_url.url.split(",")[1], "base64"))
        .raw().toBuffer()
      expect(decoded[2]).toBeGreaterThan(240)
      simulateRetry = true
      const validate = vi.fn(() => {
        if (recorded.length > 1) throw new Error("task grant revoked")
      })
      await expect(getModelInstance({ ...config, inputModalities: ["text", "image"] },
        undefined, 2, "agent", undefined, validate).invoke(messages)).rejects.toThrow("图片读取权限已失效")
      expect(validate).toHaveBeenCalledTimes(2)
      expect(recorded).toHaveLength(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 60_000)

  it("moves an approved binding with a user message alias and rejects conflicting merges", () => {
    const ref = { id: "alias-image", filename: "alias.png", slot: 0 }
    db.upsertThreadMessages("parent", [
      { id: "draft-id", role: "user", content: "first", created_at: new Date(1) },
      { id: "separate-id", role: "user", content: "second", created_at: new Date(2) }
    ])
    bindChatImages("parent", "draft-id", "first", [ref], [ref])
    expect(db.replaceThreadMessageId("parent", "draft-id", "separate-id", "user")).toBe(false)
    expect(db.replaceThreadMessageId("parent", "draft-id", "final-id", "user")).toBe(true)
    expect(boundChatImages("parent", "draft-id")).toEqual([])
    expect(boundChatImages("parent", "final-id")).toEqual([ref])
  })

  it("sweeps a deleted parent without removing the child image", async () => {
    db.createThread("removed-parent")
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "green" } })
      .png().toBuffer()
    const attachment = await stageChatImage("removed-parent", "chart.png", Uint8Array.from(png).buffer)
    const refs = [{ slot: 0, filename: attachment.filename, id: attachment.image!.id }]
    bindChatImages("removed-parent", "copied", "chart", refs, refs)
    await copyBoundChatImages("removed-parent", "child", "copied")
    const { readdir } = await import("node:fs/promises")
    const root = join(directory, "chat-images")
    const before = await readdir(root)
    db.deleteThread("removed-parent")
    await sweepChatImageStorage()
    expect(await readdir(root)).toHaveLength(before.length - 1)
    await expect(readChatImage("child", refs[0].id)).resolves.toHaveProperty("image_url.url")
  })

  it("applies orientation, strips metadata and rejects oversize dimensions", async () => {
    const jpeg = await sharp({ create: { width: 9, height: 4, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const asset = await stageChatImage("parent", "oriented.jpg", Uint8Array.from(jpeg).buffer)
    const normalized = await readChatImage("parent", asset.image!.id)
    const meta = await sharp(Buffer.from(normalized.image_url.url.split(",")[1], "base64")).metadata()
    expect(meta).toMatchObject({ width: 4, height: 9 })
    expect(meta.exif).toBeUndefined()
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "red" } })
      .png().toBuffer()
    await expect(stageChatImage("parent", "wide.png", Uint8Array.from(wide).buffer)).rejects.toThrow()
  })

  it("rejects mismatched formats", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
      .png().toBuffer()
    await expect(stageChatImage("parent", "wrong.jpg", Uint8Array.from(png).buffer))
      .rejects.toThrow("图片类型")
  })
})
