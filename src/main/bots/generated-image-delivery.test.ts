import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import sharp from "sharp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { readGeneratedImageForDelivery } from "../generated-images"
import { MAX_GROUP_IMAGE_BYTES, readDeliveredGeneratedImage, stageGeneratedGroupFile } from "./generated-image-delivery"
import { BotStore } from "./store"
import { resolveBotWorkspaceFile } from "./workspace-file"

const current = vi.hoisted(() => ({ store: undefined as BotStore | undefined }))
vi.mock("../generated-images", () => ({ readGeneratedImageForDelivery: vi.fn() }))
vi.mock("./local-service", () => ({ getLocalBotHost: () => current.store }))

const databases: NativeSqliteAdapter[] = []
const actionId = "11111111-1111-4111-8111-111111111111"
const promptId = "original-human-post"
afterEach(() => {
  current.store = undefined
  vi.clearAllMocks()
  databases.splice(0).forEach(db => db.close())
})

function room() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = current.store = new BotStore(db, () => 1000)
  const bot = store.create({ name: "Artist", color: "#ff0000", instructions: "", modelRef: null })
  const group = store.saveGroup({ name: "Design room", memberIds: [bot.id] })
  const other = store.saveGroup({ name: "Design room", memberIds: [bot.id] })
  store.sendGroup({ groupId: group.id, requestId: promptId, text: "画一张海报", targetBotIds: [bot.id] })
  const task = store.recentTasks().find(task => task.origin.kind === "group")!
  store.transition(task.id, "running")
  const grant = store.groupImageGenerationRequest(group.id, promptId, bot.id)!
  const turn = { threadId: task.threadId, userMessageId: "original-task", signal: new AbortController().signal,
    assertCurrent: vi.fn(), group: { instanceKey: grant.instanceKey, messageId: promptId } }
  const messageId = "group-image-" + createHash("sha256").update(JSON.stringify([group.id, actionId])).digest("hex")
  const source = { groupId: group.id, messageId, fileIndex: 0, actionId }
  const stage = async (bytes?: Buffer) => {
    vi.mocked(readGeneratedImageForDelivery).mockResolvedValueOnce({
      bytes: bytes ?? await sharp({ create: { width: 23, height: 9, channels: 3, background: "blue" } }).png().toBuffer(),
      name: "original.png", receipt: { kind: "generated-image", actionId, width: 23, height: 9,
        mimeType: "image/png", userMessageId: promptId }
    })
    return stageGeneratedGroupFile(turn, actionId)
  }
  const rows = () => db.exec("SELECT count(*) FROM bot_group_generated_images")[0].values[0][0]
  const publish = (file: Awaited<ReturnType<typeof stage>>, handoff?: () => never) =>
    store.publishGroupFiles(task.id, "generated-image:" + actionId, [file], "", handoff)
  return { db, group, other, store, turn, source, stage, rows, publish, task }
}

describe("group image publication", () => {
  it("stages no workspace file or group bytes and rolls back an unsuccessful public handoff", async () => {
    const f = room(), file = await f.stage()
    const workspace = await mkdtemp(join(tmpdir(), "generated-group-snapshot-"))
    try {
      expect(file.attachmentPath).toBeUndefined()
      expect(file.attachmentRoot).toBeUndefined()
      expect(await readdir(workspace)).toEqual([])
      await expect(resolveBotWorkspaceFile(workspace, file.filePath)).rejects.toThrow()
      expect(f.rows()).toBe(0)
      expect(() => f.store.groupGeneratedImage(f.source, true)).toThrow()
      expect(() => f.publish(file, () => { throw new Error("handoff interrupted") })).toThrow("interrupted")
      expect(f.rows()).toBe(0)
      expect(f.store.groupMessages(f.group.id).some(message => message.files?.length)).toBe(false)
      const retry = await f.stage()
      expect(f.publish(retry)).toBe(true)
      expect(await readdir(workspace)).toEqual([])
      expect(f.rows()).toBe(1)
      expect(f.publish(await f.stage())).toBe(false)
      expect(f.rows()).toBe(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("requires host provenance and keeps independent, group-scoped pixels after the producer is removed", async () => {
    const f = room(), file = await f.stage()
    expect(() => f.publish({ ...file })).toThrow("宿主交付记录")
    f.publish(file)
    f.db.run("DELETE FROM bot_tasks WHERE id=?", [f.task.id])
    vi.mocked(readGeneratedImageForDelivery).mockRejectedValue(new Error("production thread deleted"))
    const saved = await readDeliveredGeneratedImage(f.source, "original", () => {})
    expect(await sharp(saved.bytes).metadata()).toMatchObject({ format: "png", width: 23, height: 9 })
    const preview = await readDeliveredGeneratedImage(f.source, "thumbnail", () => {})
    expect(await sharp(preview.bytes).metadata()).toMatchObject({ format: "webp" })
    expect(readGeneratedImageForDelivery).toHaveBeenCalledTimes(1)
    for (const wrong of [
      { groupId: f.other.id }, { messageId: promptId }, { fileIndex: 1 }, { actionId: "other" }
    ]) expect(() => f.store.groupGeneratedImage({ ...f.source, ...wrong }, true)).toThrow()
    f.db.run("UPDATE bot_groups SET payload=json_set(payload,'$.deleting',json('true')) WHERE id=?", [f.group.id])
    expect(saved.assertCurrent).toThrow()
    await expect(readDeliveredGeneratedImage(f.source, "original", () => {})).rejects.toThrow()
  })

  it.each(["original post", "delivery post", "removed file"])("reclaims pixels on withdrawal of %s", async mode => {
    const f = room()
    f.publish(await f.stage())
    const { assertCurrent } = await readDeliveredGeneratedImage(f.source, "original", () => {})
    if (mode === "removed file") {
      f.db.run("UPDATE bot_group_messages SET files_json=NULL WHERE id=?", [f.source.messageId])
    } else {
      f.db.run("DELETE FROM bot_group_messages WHERE id=?", [mode === "original post" ? promptId : f.source.messageId])
    }
    expect(f.rows()).toBe(0)
    expect(assertCurrent).toThrow()
  })

  it("bounds the SQLite BLOB and never includes it in the history page or authorization recheck", async () => {
    const f = room()
    await expect(f.stage(Buffer.alloc(MAX_GROUP_IMAGE_BYTES + 1))).rejects.toThrow("大小")
    f.publish(await f.stage(Buffer.alloc(MAX_GROUP_IMAGE_BYTES, 0x33)))
    const large = f.store.groupGeneratedImage(f.source, true).pixels as Uint8Array
    expect(large).toHaveLength(MAX_GROUP_IMAGE_BYTES)
    expect(f.store.groupGeneratedImage(f.source, false).pixels).toBeUndefined()
    expect(JSON.stringify(f.store.groupMessages(f.group.id, { targetMessageId: f.source.messageId })).length)
      .toBeLessThan(4000)
    expect(() => f.db.run("UPDATE bot_group_generated_images SET pixels=zeroblob(?)",
      [MAX_GROUP_IMAGE_BYTES + 1])).toThrow()
    expect(() => f.db.run("UPDATE bot_group_generated_images SET pixels='fake'")).toThrow()
  })
})
