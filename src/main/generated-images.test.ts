import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import sharp from "sharp"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { parseGeneratedImageReceipt } from "../shared/generated-image"
import { setWorkConversationLookup } from "./bots/conversation-link-authority"
import { closeDatabase, createThread, deleteThread, getDb, initializeDatabase, replaceThreadMessageId,
  updateThread, upsertThreadMessages } from "./db"
import { getImageGenerationDeployment, ImageGenerationError, type GeneratedImageResult } from "./models/image-generation"
import { copyGeneratedImageGrants, lookupGeneratedImage, readGeneratedImage, readGeneratedImageForDelivery,
  resumeGeneratedGroupImage, runGeneratedImage, sweepGeneratedImageStorage, type GeneratedImageContext } from "./generated-images"

const state = vi.hoisted(() => ({ dbPath: "" }))
vi.mock("./storage", async importOriginal => ({
  ...(await importOriginal<typeof import("./storage")>()), getDbPath: () => state.dbPath,
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))
vi.mock("./models/image-generation", async importOriginal => ({
  ...(await importOriginal<typeof import("./models/image-generation")>()),
  getImageGenerationDeployment: vi.fn()
}))

let directory: string
let image: GeneratedImageResult
const post = vi.fn<NonNullable<ReturnType<typeof getImageGenerationDeployment>>["generate"]>()
const check = () => {}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "generated-images-"))
  state.dbPath = join(directory, "chats.sqlite")
  vi.stubEnv("CMB_COWORK_AGENT_HOME", directory)
  await initializeDatabase()
  const bytes = await sharp({ create: { width: 13, height: 7, channels: 3, background: "red" } }).png().toBuffer()
  const preview = await sharp(bytes).webp({ quality: 82 }).toBuffer()
  image = { bytes, preview, mimeType: "image/png", width: 13, height: 7, requestId: "request" }
})
beforeEach(() => {
  post.mockReset().mockResolvedValue(image)
  vi.mocked(getImageGenerationDeployment).mockReturnValue({ id: "first-deployment", generate: post })
})
afterAll(async () => {
  await closeDatabase()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

function conversation(): GeneratedImageContext {
  const threadId = randomUUID()
  const userMessageId = randomUUID()
  createThread(threadId)
  upsertThreadMessages(threadId, [{ id: userMessageId, role: "user", content: "画图", created_at: new Date() }])
  return { threadId, userMessageId, callId: "shared-call", assertCurrent: check, forkable: true }
}

function assistant(ctx: GeneratedImageContext, id: string = randomUUID()) {
  const message = { id, role: "assistant" as const, content: "", created_at: new Date(),
    tool_calls: [{ name: "generate_image", id: ctx.callId, args: {} }] }
  upsertThreadMessages(ctx.threadId, [message], { preserveExistingOrder: true })
  return message
}

describe("generated image receipts", () => {
  it("upgrades a development database in place, retaining receipts and assigning new grants by column name", async () => {
    const initialPath = state.dbPath
    await closeDatabase()
    state.dbPath = join(directory, "older-development.sqlite")
    try {
      await initializeDatabase()
      const ctx = conversation()
      const message = assistant(ctx)
      const first = await runGeneratedImage(ctx, "蓝鲸")
      await closeDatabase()
      const old = new DatabaseSync(state.dbPath)
      try {
        old.exec("ALTER TABLE generated_image_grants DROP COLUMN original_user_id")
        old.exec("ALTER TABLE generated_image_actions DROP COLUMN public_message_id")
      } finally { old.close() }
      await initializeDatabase()
      expect((await lookupGeneratedImage({ threadId: ctx.threadId, messageId: message.id, callId: ctx.callId },
        check))?.actionId).toBe(first.actionId)
      expect((await runGeneratedImage(ctx, "蓝鲸")).actionId).toBe(first.actionId)
      const next = conversation()
      const reply = assistant(next)
      const second = await runGeneratedImage(next, "水母")
      expect((await readGeneratedImage({ threadId: next.threadId, messageId: reply.id, actionId: second.actionId },
        "original", check)).bytes).toEqual(image.bytes)
      expect(post).toHaveBeenCalledTimes(2)
    } finally {
      await closeDatabase()
      state.dbPath = initialPath
      await initializeDatabase()
    }
  })

  it("sends one request for concurrent, retried and renamed assistant messages; returns the exact stored pixels", async () => {
    const ctx = conversation()
    const message = assistant(ctx)
    const [first, duplicate] = await Promise.all([runGeneratedImage(ctx, "鲸鱼"), runGeneratedImage(ctx, "鲸鱼")])
    expect(duplicate).toEqual(first)
    expect(post).toHaveBeenCalledTimes(1)
    expect(first.userMessageId).toBe(ctx.userMessageId)
    expect(parseGeneratedImageReceipt(JSON.stringify(first))).toEqual(first)
    const source = { threadId: ctx.threadId, messageId: message.id, actionId: first.actionId }
    expect((await readGeneratedImage(source, "original", check)).bytes).toEqual(image.bytes)
    expect((await readGeneratedImage(source, "thumbnail", check)).bytes).toEqual(image.preview)
    assistant(ctx, "renamed-assistant")
    expect(replaceThreadMessageId(ctx.threadId, message.id, "renamed-assistant", "assistant")).toBe(true)
    await expect(readGeneratedImage(source, "original", check)).rejects.toThrow()
    source.messageId = "renamed-assistant"
    expect(await lookupGeneratedImage({ ...source, callId: ctx.callId }, check)).toEqual(first)
    expect((await readGeneratedImage(source, "original", check)).bytes).toEqual(image.bytes)
    await expect(readGeneratedImage({ ...source, threadId: conversation().threadId }, "original", check)).rejects.toThrow()
    let reads = 0
    await expect(readGeneratedImage(source, "original", () => {
      if (++reads >= 3) throw new Error("revoked")
    })).rejects.toThrow("revoked")
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("grants only copied ordinary messages to a fork and retains the asset after deleting the parent", async () => {
    const ctx = conversation()
    const message = assistant(ctx)
    const item = await runGeneratedImage(ctx, "蘑菇")
    const target = randomUUID()
    createThread(target)
    upsertThreadMessages(target, [
      { id: ctx.userMessageId, role: "user", content: "画图", created_at: new Date() }, message
    ])
    copyGeneratedImageGrants(ctx.threadId, target, [message])
    const source = { threadId: target, messageId: message.id, actionId: item.actionId }
    deleteThread(ctx.threadId)
    await sweepGeneratedImageStorage()
    expect((await readGeneratedImage(source, "original", check)).bytes).toEqual(image.bytes)
    deleteThread(target)
    await sweepGeneratedImageStorage()
    await expect(readFile(join(directory, "generated-images", item.actionId + ".png"))).rejects.toThrow()
    createThread(target)
    await expect(readGeneratedImage(source, "original", check)).rejects.toThrow()
  })

  it("retains original action identity across a user ID rename without merging another occupied user", async () => {
    const ctx = conversation()
    const reply = assistant(ctx)
    const generated = await runGeneratedImage(ctx, "猫")
    expect(replaceThreadMessageId(ctx.threadId, ctx.userMessageId, "final-user", "user")).toBe(true)
    const source = { threadId: ctx.threadId, messageId: reply.id, actionId: generated.actionId }
    expect((await readGeneratedImage(source, "original", check)).bytes).toEqual(image.bytes)
    expect((await lookupGeneratedImage({ ...source, callId: ctx.callId }, check))?.userMessageId).toBe("final-user")
    expect((await runGeneratedImage(ctx, "猫")).actionId).toBe(generated.actionId)
    expect((await runGeneratedImage({ ...ctx, userMessageId: "final-user" }, "猫")).userMessageId).toBe("final-user")
    upsertThreadMessages(ctx.threadId, [{ id: "occupied", role: "user", content: "另一轮", created_at: new Date() }])
    expect(replaceThreadMessageId(ctx.threadId, "final-user", "occupied", "user")).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("recovers a replayed tool result only on the first surviving assistant call", async () => {
    const ctx = conversation()
    const first = assistant(ctx)
    const item = await runGeneratedImage(ctx, "游艇")
    const retry = { ...ctx, callId: "different-replay-id" }
    const second = assistant(retry)
    expect((await runGeneratedImage(retry, "游艇")).actionId).toBe(item.actionId)
    const scope = { threadId: ctx.threadId, messageId: second.id, callId: retry.callId }
    expect(await lookupGeneratedImage(scope, check)).toBeNull()
    upsertThreadMessages(ctx.threadId, [{ id: "kept-tool", role: "tool", content: JSON.stringify(item),
      tool_call_id: retry.callId, created_at: new Date() }], { preserveExistingOrder: true })
    expect(await lookupGeneratedImage({ ...scope, messageId: first.id, callId: ctx.callId }, check)).toBeNull()
    expect((await lookupGeneratedImage(scope, check))?.actionId).toBe(item.actionId)
    getDb().run("DELETE FROM thread_messages WHERE thread_id=? AND message_id='kept-tool'", [ctx.threadId])
    getDb().run("DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [ctx.threadId, first.id])
    expect((await lookupGeneratedImage(scope, check))?.actionId).toBe(item.actionId)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("denies a reused call ID in a later user turn and on a different group task", async () => {
    const ctx = conversation()
    const item = await runGeneratedImage(ctx, "鸭子")
    upsertThreadMessages(ctx.threadId, [{ id: "later", role: "user", content: "另一个问题", created_at: new Date() }])
    const other = assistant(ctx)
    await expect(readGeneratedImage({ threadId: ctx.threadId, messageId: other.id, actionId: item.actionId },
      "original", check)).rejects.toThrow()
    const original = conversation()
    const group = { instanceKey: "host/abc", messageId: "public-message" }
    const work = await runGeneratedImage({ ...original, group }, "风帆")
    await expect(runGeneratedImage({ ...conversation(), group }, "风帆")).rejects.toThrow()
    const groupCall = assistant(original)
    await expect(readGeneratedImage({ threadId: original.threadId, messageId: groupCall.id, actionId: work.actionId },
      "original", check)).rejects.toThrow()
    expect((await readGeneratedImageForDelivery(original.threadId, work.actionId, check, original.userMessageId)).receipt.userMessageId)
      .toBe(group.messageId)
    await expect(readGeneratedImageForDelivery(original.threadId, work.actionId, check, "other-user")).rejects.toThrow()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("preserves an ambiguous submission across configuration changes and only retries known non-submissions", async () => {
    const ctx = conversation()
    post.mockRejectedValueOnce(new ImageGenerationError("unknown", "连接断开"))
    await expect(runGeneratedImage(ctx, "狐狸")).rejects.toThrow("连接断开")
    vi.mocked(getImageGenerationDeployment).mockReturnValue({ id: "different-account", generate: post })
    await expect(runGeneratedImage(ctx, "狐狸")).rejects.toThrow("待确认")
    expect(post).toHaveBeenCalledTimes(1)
    const next = conversation()
    post.mockRejectedValueOnce(new ImageGenerationError("not-submitted", "本地忙"))
    await expect(runGeneratedImage(next, "狐狸")).rejects.toThrow("本地忙")
    await expect(runGeneratedImage(next, "狐狸")).resolves.toMatchObject({ width: 13 })
    expect(post).toHaveBeenCalledTimes(3)
  })

  it("resumes only the original group's existing result without issuing any generate request", async () => {
    const ctx = { ...conversation(), group: { instanceKey: "real-host/group-7", messageId: "origin-1" } }
    await expect(resumeGeneratedGroupImage(ctx)).rejects.toThrow("没有可恢复")
    expect(post).not.toHaveBeenCalled()
    const item = await runGeneratedImage(ctx, "鳄鱼")
    vi.mocked(getImageGenerationDeployment).mockReturnValue(undefined)
    expect(await resumeGeneratedGroupImage(ctx)).toEqual(item)
    await expect(resumeGeneratedGroupImage({ ...ctx, group: { ...ctx.group, messageId: "someone-else" } })).rejects.toThrow()
    await expect(resumeGeneratedGroupImage({ ...conversation(), group: ctx.group })).rejects.toThrow()
    getDb().run("UPDATE generated_image_actions SET state='submitted' WHERE action_id=?", [item.actionId])
    await expect(resumeGeneratedGroupImage(ctx)).rejects.toThrow("待确认")
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("stops publishing a late result after cancellation or user deletion", async () => {
    const ctx = conversation()
    const controller = new AbortController()
    let finish!: (result: GeneratedImageResult) => void
    post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const request = runGeneratedImage({ ...ctx, signal: controller.signal }, "树")
    controller.abort()
    finish(image)
    await expect(request).rejects.toThrow("已停止")
    await expect(runGeneratedImage(ctx, "树")).rejects.toThrow("已停止")
    const next = conversation()
    post.mockImplementationOnce(async () => {
      getDb().run("DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [next.threadId, next.userMessageId])
      return image
    })
    await expect(runGeneratedImage(next, "树")).rejects.toThrow("会话或消息已变更")
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("does not expose or re-submit an earlier workspace's image after a workspace transition", async () => {
    const move = (threadId: string) => updateThread(threadId, { metadata: JSON.stringify({ workspacePath: "/new" }) })
    const ctx = conversation()
    const message = assistant(ctx)
    const item = await runGeneratedImage(ctx, "红色帆船")
    move(ctx.threadId)
    await expect(readGeneratedImage({ threadId: ctx.threadId, messageId: message.id, actionId: item.actionId },
      "original", check)).rejects.toThrow()
    await expect(runGeneratedImage(ctx, "红色帆船")).rejects.toThrow()
    const next = conversation()
    post.mockImplementationOnce(async () => { move(next.threadId); return image })
    await expect(runGeneratedImage(next, "白底")).rejects.toThrow()
    const remote = conversation()
    updateThread(remote.threadId, { metadata: JSON.stringify({ remoteReadOnly: true }) })
    await expect(runGeneratedImage(remote, "远端线程")).rejects.toThrow()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("accepts the real local Bot's private thread and excludes false, group and IM identities", async () => {
    const ctx = conversation()
    let registered = ctx.threadId
    setWorkConversationLookup(() => null, () => ({ id: "blue-bot", hostId: "local", threadId: registered }))
    const metadata = { botId: "blue-bot", botHostId: "local", workspacePath: "/bot-home" }
    try {
      updateThread(ctx.threadId, { metadata: JSON.stringify(metadata) })
      const message = assistant(ctx)
      const item = await runGeneratedImage({ ...ctx, forkable: false }, "蓝鲸")
      const source = { threadId: ctx.threadId, messageId: message.id, actionId: item.actionId }
      expect((await readGeneratedImage(source, "original", check)).bytes).toEqual(image.bytes)
      registered = "different-thread"
      await expect(readGeneratedImage(source, "original", check)).rejects.toThrow()
      registered = ctx.threadId
      for (const flags of [{ botGroupId: "group" }, { botMockBindingId: "mock" }, { imDeliveryContext: {} }]) {
        updateThread(ctx.threadId, { metadata: JSON.stringify({ ...metadata, ...flags }) })
        await expect(readGeneratedImage(source, "original", check)).rejects.toThrow()
      }
      updateThread(ctx.threadId, { metadata: JSON.stringify({ workspacePath: metadata.workspacePath }) })
      await expect(readGeneratedImage(source, "original", check)).rejects.toThrow()
    } finally { setWorkConversationLookup(undefined) }
  })

  it("recovers the checked original after a partial commit, rebuilds previews and refuses a missing or replaced original", async () => {
    const ctx = conversation()
    const message = assistant(ctx)
    const item = await runGeneratedImage(ctx, "独角兽")
    const source = { threadId: ctx.threadId, messageId: message.id, actionId: item.actionId }
    const base = join(directory, "generated-images", item.actionId)
    getDb().run("UPDATE generated_image_actions SET state='received' WHERE action_id=?", [item.actionId])
    await rename(base + ".png", base + ".png.tmp")
    await rm(base + ".webp")
    await closeDatabase()
    await initializeDatabase()
    expect((await readGeneratedImage(source, "thumbnail", check)).bytes).toEqual(image.preview)
    expect(await readFile(base + ".webp")).toEqual(image.preview)
    expect(await runGeneratedImage(ctx, "独角兽")).toEqual(item)
    await writeFile(base + ".png", "not the stored image")
    await expect(readGeneratedImage(source, "original", check)).rejects.toThrow("无法取回")
    await rm(base + ".png")
    getDb().run("UPDATE generated_image_actions SET state='received' WHERE action_id=?", [item.actionId])
    await expect(runGeneratedImage(ctx, "独角兽")).rejects.toThrow("无法取回")
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("does not stage private image bytes into a redirected managed directory", async () => {
    const privateRoot = await mkdtemp(join(directory, "private-"))
    const outside = await mkdtemp(join(directory, "outside-"))
    await symlink(outside, join(privateRoot, "generated-images"), process.platform === "win32" ? "junction" : "dir")
    vi.stubEnv("CMB_COWORK_AGENT_HOME", privateRoot)
    try {
      await expect(runGeneratedImage(conversation(), "私人海报")).rejects.toThrow("无法取回")
      expect(await readdir(outside)).toEqual([])
    } finally { vi.stubEnv("CMB_COWORK_AGENT_HOME", directory) }
  })
})
