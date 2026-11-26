import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { copyFile } from "node:fs/promises"
import { promises as nativeFs } from "node:fs"
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
  captureDesktopImageAccess,
  getChatImageHistoryProjections,
  getChatImageSubmissionStatus,
  settleContinuedChatImageSubmission,
  discardChatDraftImage,
  pinQueuedChatImages,
  readChatImage,
  stageChatImage,
  holdBotImageStage,
  sweepChatImageStorage,
  unpinQueuedChatImages
} from "./chat-images"
import * as db from "./db"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, copyFile: vi.fn(fs.copyFile) }
})
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

  function makeClaim(messageId: string) {
    db.getDb().run("INSERT OR IGNORE INTO chat_image_input_owners VALUES (?, '', ?, '')",
      ["parent", request.chatImages[0].id])
    const input = { ...request, userMessageId: messageId }
    const first = beginChatImageSubmission(input)
    if (!first || !("owner" in first)) throw new Error("missing original claim")
    return { input, owner: first.owner }
  }

  it("claims an accepted but unstarted message once and recovers even an empty image manifest", async () => {
    const { input, owner } = makeClaim(request.userMessageId)
    const concurrent = beginChatImageSubmission({ ...input, streamRequestId: "second-listener" })
    if (!concurrent || !("replay" in concurrent)) throw new Error("duplicate admitted")
    expect(() => beginChatImageSubmission({ ...input, modelId: "other" })).toThrow("不同内容")
    owner.beginHook()
    owner.accept("edited text without the attachment", [])
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("accepted")
    owner.release() // No graph start or terminal marker before process exit.
    const expected = { submissionId: input.userMessageId, images: [], preparedText: "edited text without the attachment" }
    expect(await concurrent.replay).toEqual(expected)
    db.upsertThreadMessages("parent", [
      { id: input.userMessageId, role: "user", content: input.message, created_at: new Date(1) }
    ])
    expect(db.replaceThreadMessageId("parent", input.userMessageId, "renamed", "user")).toBe(true)
    const retry = beginChatImageSubmission(input)
    if (!retry || !("owner" in retry)) throw new Error("accepted input was lost")
    expect(retry.owner.recovered).toEqual(expected)
    expect(beginChatImageSubmission(input)).toHaveProperty("replay")
    retry.owner.start()
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("running")
    retry.owner.finish("success")
    retry.owner.release()
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("succeeded")
    expect(beginChatImageSubmission(input)).toHaveProperty("replay")
    expect(() => beginChatImageSubmission({ ...input, chatImages: [] })).toThrow("不同内容")
    await copyBoundChatImages("parent", "child", "renamed")
    expect(getChatImageHistoryProjections("child", ["renamed"]).get("renamed"))
      .toMatchObject({ images: [], preparedText: expected.preparedText })
  })

  it("omits unknown Hook input and rejects replay of rejected and failed messages", async () => {
    const abandoned = makeClaim("hook-crashed")
    abandoned.owner.beginHook()
    expect(getChatImageSubmissionStatus("parent", "hook-crashed")).toBe("pending")
    abandoned.owner.release()
    expect(getChatImageSubmissionStatus("parent", "hook-crashed")).toBe("unknown")
    expect(beginChatImageSubmission(abandoned.input)).toHaveProperty("replay")
    expect(getChatImageHistoryProjections("parent", ["hook-crashed"]).get("hook-crashed")).toBeNull()
    await copyBoundChatImages("parent", "child", "hook-crashed")
    expect(getChatImageHistoryProjections("child", ["hook-crashed"]).get("hook-crashed")).toBeNull()

    const rejected = makeClaim("rejected")
    rejected.owner.beginHook()
    rejected.owner.reject()
    rejected.owner.release()
    expect(boundChatImageReceipt("parent", "rejected")).toBeUndefined()
    expect(getChatImageSubmissionStatus("parent", "rejected")).toBe("rejected")
    expect(beginChatImageSubmission(rejected.input)).toHaveProperty("replay")
    expect(() => beginChatImageSubmission({ ...rejected.input, message: "corrected" })).toThrow("不同内容")

    const failed = makeClaim("failed")
    failed.owner.accept("approved", [])
    failed.owner.start()
    failed.owner.finish("error")
    failed.owner.release()
    expect(getChatImageSubmissionStatus("parent", "failed")).toBe("failed")
    expect(beginChatImageSubmission(failed.input)).toHaveProperty("replay")
  })

  it("requires checkpoint continuation once graph execution may have started", () => {
    const { input, owner } = makeClaim("crashed-running")
    owner.accept("approved", [])
    owner.start()
    owner.finish("unknown")
    owner.release()
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("unknown")
    expect(beginChatImageSubmission(input)).toHaveProperty("replay")
    settleContinuedChatImageSubmission("parent", "another-origin", "success")
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("unknown")
    settleContinuedChatImageSubmission("parent", input.userMessageId, "success")
    expect(getChatImageSubmissionStatus("parent", input.userMessageId)).toBe("succeeded")
  })

  it("binds recovery and graph start to the authoritative workspace and thread incarnation", () => {
    const threadId = "scope-recovery"
    const input = { ...request, threadId, userMessageId: "scope-request" }
    const fileId = input.chatImages[0].id
    db.createThread(threadId, { workspacePath: "/first" })
    db.getDb().run("INSERT INTO chat_image_input_owners VALUES (?, '', ?, ?)", [threadId, fileId, "/first"])
    const claim = beginChatImageSubmission(input)
    if (!claim || !("owner" in claim)) throw new Error("missing claim")
    claim.owner.accept("approved only in first workspace", [])
    claim.owner.release()

    db.updateThread(threadId, { metadata: JSON.stringify({ workspacePath: "/another" }) })
    expect(getChatImageSubmissionStatus(threadId, input.userMessageId)).toBe("unknown")
    expect(() => beginChatImageSubmission(input)).toThrow("工作区或会话已变更")
    expect(getChatImageHistoryProjections(threadId, [input.userMessageId]).get(input.userMessageId)).toBeNull()
    db.updateThread(threadId, { metadata: JSON.stringify({ workspacePath: "/first/" }) })
    const retry = beginChatImageSubmission(input)
    if (!retry || !("owner" in retry)) throw new Error("unable to recover approval")
    const validateHttpAttempt = captureDesktopImageAccess(threadId)
    expect(validateHttpAttempt).not.toThrow()
    db.updateThread(threadId, { metadata: JSON.stringify({ workspacePath: "/another" }) })
    expect(() => retry.owner.start()).toThrow("工作区或会话已变更")
    expect(validateHttpAttempt).toThrow("工作区或会话已变更")
    db.updateThread(threadId, { metadata: JSON.stringify({ workspacePath: "/first" }) })
    const saved = db.getDb().exec("SELECT request_digest, images_json FROM chat_image_messages WHERE thread_id=?",
      [threadId])[0].values[0]
    db.deleteThread(threadId)
    db.createThread(threadId, { workspacePath: "/first" })
    expect(() => retry.owner.start()).toThrow("工作区或会话已变更")
    retry.owner.release()
    // Simulate a restored stale receipt in a thread recreated with the same public ID and workspace.
    db.getDb().run("INSERT INTO chat_image_messages VALUES (?, ?, ?, ?)", [threadId, input.userMessageId, ...saved])
    expect(() => beginChatImageSubmission(input)).toThrow("工作区或会话已变更")
    expect(getChatImageSubmissionStatus(threadId, input.userMessageId)).toBe("unknown")
  })

  it("requires review when an older accepted record cannot prove its workspace and incarnation", () => {
    const { input, owner } = makeClaim("unscoped-receipt")
    owner.accept("approved", [])
    owner.release()
    db.getDb().run("UPDATE chat_image_messages SET images_json=json_remove(images_json, '$.scope') WHERE thread_id=? AND message_id=?",
      [input.threadId, input.userMessageId])
    expect(getChatImageSubmissionStatus(input.threadId, input.userMessageId)).toBe("unknown")
    expect(beginChatImageSubmission(input)).toHaveProperty("replay")
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
    expect(getChatImageSubmissionStatus("parent", "legacy-approval")).toBe("unknown")
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
    const botHistory = { channel_values: { messages: [message, task] } }
    expect(checkpointHasChatImages(botHistory, task.id)).toBe(true)
    expect(checkpointHasChatImages(botHistory, "another-task")).toBe(false)
    expect(checkpointHasChatImages({ channel_values: { messages: [task, message],
      _summarizationEvent: { cutoffIndex: 1 } } }, task.id)).toBe(false)
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

  it("prioritizes the newest message when the conversation exceeds the visual context budget", async () => {
    const png = await sharp({ create: { width: 8, height: 4, channels: 3, background: "blue" } }).png().toBuffer()
    const file = await stageChatImage("parent", "tile.png", Uint8Array.from(png).buffer,
      { draftWorkspace: "" })
    const ref = { id: file.image!.id, filename: file.filename, slot: 0 }
    const { attachmentModelBlocks } = buildAttachmentMessageParts([file])
    const messages = Array.from({ length: 4 }, (_, i) => {
      const id = "recent-" + i
      const body = "Question " + i + attachmentModelBlocks
      bindChatImages("parent", id, body, [ref], [ref])
      return new HumanMessage({ id, content: body })
    })
    const result = await materializeChatImages("parent", messages, "desktop")
    expect(result[0].content).toContain("历史图片未随本次请求发送")
    expect(result.slice(1).every(message => Array.isArray(message.content))).toBe(true)
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

  it.each([
    { status: 400, reason: "text only", overflow: false, dataUrl: false, textOnly: true },
    { status: 400, reason: "invalid image", overflow: false, dataUrl: false },
    { status: 485, reason: "任务上下文超过最大限度", overflow: true, dataUrl: true },
    { status: 580, reason: "任务上下文超过最大限度", overflow: true, dataUrl: false },
    { status: 485, reason: "服务暂时不可用", overflow: false, dataUrl: false },
    { status: 400, reason: "maximum context length is 4096 tokens", overflow: true, dataUrl: true }
  ])("keeps overflow recovery and redacts image error details ($status $reason)", async row => {
    const { getModelInstance } = await import("./agent/runtime")
    const { isCmbContextOverflow } = await import("./agent/context-summarization-middleware")
    const { contextWindowFromError } = await import("./agent/context-compaction-recovery")
    const encoded = Buffer.from("private fixture bytes").toString("base64")
    const url = "data:image/png;base64," + encoded
    const server = createServer((_request, response) => {
      response.writeHead(row.status, { "content-type": "application/json", "x-request-id": encoded })
      response.end(JSON.stringify({ error: { message: row.reason + " " + (row.dataUrl ? url : encoded) } }))
    })
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("unexpected server address")
      const onFetchError = vi.fn()
      const model = getModelInstance({ id: "vision", model: "sample", apiKey: "fixture",
        baseUrl: "http://127.0.0.1:" + address.port + "/v1", inputModalities: ["text", "image"]
      }, { onFetchError }, 1)
      const message = row.textOnly ? new HumanMessage("image_url") : new HumanMessage({
        content: [{ type: "image_url", image_url: { url } }]
      })
      const failure = await model.invoke([message]).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(onFetchError).toHaveBeenCalledOnce()
      if (row.textOnly) {
        expect(onFetchError.mock.calls[0][0].requestId).toBe(encoded)
        expect(String(failure)).toContain(row.reason)
        return
      }
      expect(JSON.stringify(onFetchError.mock.calls)).not.toContain(encoded)
      expect(String(failure) + JSON.stringify(failure)).not.toContain(encoded)
      expect(isCmbContextOverflow(failure)).toBe(row.overflow)
      if (row.reason.includes("4096")) expect(contextWindowFromError(failure)).toBe(4096)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(done => server.close(() => done()))
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

  it("keeps copied pixels during a sweep before the fork receipt is written", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "orange" } })
      .png().toBuffer()
    const attachment = await stageChatImage("parent", "fork.png", Uint8Array.from(png).buffer)
    const refs = [{ slot: 0, filename: attachment.filename, id: attachment.image!.id }]
    bindChatImages("parent", "fork-sweep", "caption", refs, refs)
    vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
      await nativeFs.copyFile(...args)
      await sweepChatImageStorage()
    })
    await copyBoundChatImages("parent", "child", "fork-sweep")
    await expect(readChatImage("child", refs[0].id)).resolves.toHaveProperty("image_url.url")
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

  it("reclaims failed Bot stages on release or restart while retaining a second holder", async () => {
    const source = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toBuffer()
    const stage = (key: string) => stageChatImage("parent", "photo.png", Uint8Array.from(source).buffer,
      { deduplicationKey: key })
    const first = holdBotImageStage("parent", "two holders")
    const second = holdBotImageStage("parent", "two holders")
    const file = await stage("two holders")
    await first()
    await sweepChatImageStorage()
    await expect(readChatImage("parent", file.image!.id)).resolves.toHaveProperty("image_url.url")
    await second()
    await expect(readChatImage("parent", file.image!.id)).rejects.toThrow()
    const interrupted = await stage("prior process exited after decoding")
    await sweepChatImageStorage()
    await expect(readChatImage("parent", interrupted.image!.id)).rejects.toThrow()
  })

  it("rejects mismatched formats", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } })
      .png().toBuffer()
    await expect(stageChatImage("parent", "wrong.jpg", Uint8Array.from(png).buffer))
      .rejects.toThrow("图片类型")
  })
})
