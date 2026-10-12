import { afterEach, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotTeachService } from "./teach-service"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotHost } from "./host"
import { botTeachTools } from "./teach-tools"
import type { BotRuntimeRequest } from "./host"
import { ToolMessage } from "@langchain/core/messages"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-teach-files-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  cleanup.push(() => computer.close())
  const teach = new BotTeachService(join(directory, "teach"), store, computer)
  cleanup.push(() => teach.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "学习助手" })
  const input = { botId: bot.id, conversationId, nonce: "recording" }
  const session = teach.repository.create(input)
  const content = Buffer.alloc(600 * 1024, 31)
  const folder = join(directory, "teach", session.id)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, "video.webm"), content)
  teach.repository.update(session.id, session.revision, "failed", {
    video: {
      mime: "video/webm",
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    }
  })
  return {
    directory,
    folder,
    teach,
    store,
    input,
    content,
    session: teach.repository.get(session.id)
  }
}

it("serves bounded chunks, rejects invalid offsets and makes deletion durable and retryable", async () => {
  const f = await fixture()
  const first = await f.teach.videoChunk({ id: f.session.id, offset: 0 })
  expect(Buffer.from(first.base64, "base64").equals(f.content.subarray(0, 512 * 1024))).toBe(true)
  const last = await f.teach.videoChunk({ id: f.session.id, offset: 512 * 1024 })
  expect(Buffer.from(last.base64, "base64").equals(f.content.subarray(512 * 1024))).toBe(true)
  expect(last.sha256).toBe(first.sha256)
  for (const offset of [-1, 0.5, f.content.length, 64 * 1024 ** 2 + 1])
    await expect(f.teach.videoChunk({ id: f.session.id, offset })).rejects.toThrow()
  await expect(f.teach.videoChunk({ id: "../../outside", offset: 0 })).rejects.toThrow()
  await f.teach.deleteRecording(f.session)
  await f.teach.deleteRecording(f.session)
  await expect(readFile(join(f.folder, "video.webm"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(f.teach.videoChunk({ id: f.session.id, offset: 0 })).rejects.toThrow("完整录像")
  expect(f.teach.repository.forNonce(f.input)?.phase).toBe("discarded")
})

it("reports a learning run that completed without saving a skill once, while task cancellation stays silent", async () => {
  const f = await fixture()
  const host = new BotHost(f.store)
  cleanup.push(() => host.stop())
  f.teach.bindFailureReporter((notice, error) => {
    host.reportFailure(notice, error)
  })
  for (const outcome of ["succeeded", "cancelled"] as const) {
    const session = f.teach.repository.create({ ...f.input, nonce: `learning-${outcome}` })
    const finalizing = f.teach.repository.update(session.id, session.revision, "finalizing")
    f.teach.repository.update(session.id, finalizing.revision, "queued", { video: f.session.video })
    const learning = f.teach.repository.queue(session.id)
    const claim = f.store.claim("learning")!
    expect(claim.run.id).toBe(learning.learningRunId)
    f.store.finish(claim.lease, outcome, "finished without a skill")
    f.teach.maintain()
    f.teach.maintain()
    expect(f.teach.repository.get(session.id).phase).toBe("failed")
  }
  expect(host.getErrorTrays().items).toHaveLength(1)
  expect(host.getErrorTrays().items[0]).toMatchObject({ source: "teach", title: "示范学习未完成" })
})

it("relearns a saved demonstration when the completed learning run never saved a skill", async () => {
  const f = await fixture()
  let session = f.teach.repository.create({ ...f.input, nonce: "learning-without-skill" })
  f.teach.repository.addFrame(session.id, {
    at: 10,
    sha256: "a".repeat(64),
    size: 100,
    url: "https://example.test",
    title: "任务"
  })
  session = f.teach.repository.update(session.id, session.revision, "finalizing")
  f.teach.repository.update(session.id, session.revision, "queued", { video: f.session.video })
  const learning = f.teach.repository.queue(session.id)
  const claim = f.store.claim("learning")!
  f.store.finish(claim.lease, "succeeded", "finished without a skill")

  const failed = f.teach.status(session.botId)!
  expect(failed).toMatchObject({ id: session.id, phase: "failed", skillId: null })
  const frames = f.teach.repository.frames(session.id)
  const retried = f.teach.repository.retry({ id: session.id, nonce: "relearn-once" })
  expect(retried).toMatchObject({
    phase: "learning",
    attempt: 1,
    skillId: null,
    video: failed.video
  })
  expect(retried.learningRunId).not.toBe(learning.learningRunId)
  expect(f.store.getRun(learning.learningRunId!).status).toBe("succeeded")
  expect(f.store.getRun(retried.learningRunId!).status).toBe("queued")
  expect(f.teach.repository.frames(session.id)).toEqual(frames)
  expect(f.teach.repository.retry({ id: session.id, nonce: "relearn-once" })).toEqual(retried)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(2)
  expect(f.store.skills(session.botId)).toEqual([])
  expect(() => f.teach.repository.authorizeRead(session.id, claim.lease)).toThrow()
})

it("rejects offsets from an older recording without recording a false end-of-recording receipt", async () => {
  const f = await fixture()
  let session = f.teach.repository.create({ ...f.input, nonce: "fresh-recording" })
  for (let index = 0; index < 5; index++) {
    const bytes = Buffer.from(`synthetic-frame-${index}`)
    f.teach.repository.addFrame(session.id, {
      at: 10 + index,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      url: "https://example.test",
      title: "任务"
    })
    await mkdir(join(f.directory, "teach", session.id), { recursive: true })
    await writeFile(join(f.directory, "teach", session.id, `${index}.jpg`), bytes)
  }
  session = f.teach.repository.get(session.id)
  session = f.teach.repository.update(session.id, session.revision, "finalizing")
  f.teach.repository.update(session.id, session.revision, "queued", { video: f.session.video })
  f.teach.repository.queue(session.id)
  const { lease } = f.store.claim("learning")!
  const [read, save] = botTeachTools(f.teach, {
    lease,
    signal: new AbortController().signal
  } as BotRuntimeRequest)
  await expect(read.invoke({ session_id: "mistyped-recording", offset: 0 })).rejects.toThrow(
    "请省略 session_id"
  )
  for (const offset of [5, 555])
    await expect(f.teach.readFrames(session.id, offset, lease)).rejects.toThrow("offset=0")
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_teach_reads")[0].values[0][0]).toBe(0)
  expect(() =>
    f.teach.repository.saveLearned(session.id, lease, "unread", {
      name: "未查看",
      instructions: "没有实际查看画面"
    })
  ).toThrow("完整查看")
  const readResult = await read.invoke({ offset: 0 })
  if (!ToolMessage.isInstance(readResult) || typeof readResult.content === "string")
    throw new Error("Expected the assigned recording's actual image blocks")
  expect(readResult.content.filter((block) => block.type === "image_url")).toHaveLength(4)
  const first = await f.teach.readFrames(session.id, 0, lease)
  expect(first.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3])
  expect(first.nextOffset).toBe(4)
  const last = await f.teach.readFrames(session.id, first.nextOffset!, lease)
  expect(last.frames.map((frame) => frame.index)).toEqual([4])
  expect(last.nextOffset).toBeNull()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_teach_reads")[0].values[0][0]).toBe(5)
  const saveCall = {
    type: "tool_call" as const,
    id: "read-all",
    name: "save_taught_skill",
    args: {
      name: "已完整查看",
      when_to_use: "用户需要此示范流程时",
      inputs: ["用户提供的条件"],
      steps: ["按真实画面识别控件，再填写给定条件"],
      decisions: "根据真实结果决定是否继续",
      how_to_check: "核对输出与给定条件",
      what_to_return: "实际结果",
      approval_boundaries: "执行操作需原授权",
      failure_handling: "保留现场并报告问题"
    }
  }
  const saved = await save.invoke(saveCall)
  const replayed = await save.invoke(saveCall)
  expect(replayed.content).toEqual(saved.content)
  expect(f.store.skills(session.botId)).toHaveLength(1)
  expect(f.store.skills(session.botId)[0]).toMatchObject({
    name: "已完整查看",
    verified: false
  })
})

it("rejects replaced and truncated video files", async () => {
  const f = await fixture()
  await writeFile(join(f.folder, "video.webm"), "truncated")
  await expect(f.teach.videoChunk({ id: f.session.id, offset: 0 })).rejects.toThrow("文件已变化")
  await rm(join(f.folder, "video.webm"))
  const outside = join(f.directory, "outside.webm")
  await writeFile(outside, f.content)
  await symlink(outside, join(f.folder, "video.webm"))
  await expect(f.teach.videoChunk({ id: f.session.id, offset: 0 })).rejects.toThrow()
})

it("blocks new capture before launching a browser when storage is full, preserving saved recordings", async () => {
  const f = await fixture()
  const reserved = await open(join(f.folder, "full.pending"), "w")
  try {
    await reserved.truncate(2 * 1024 ** 3)
  } finally {
    await reserved.close()
  }
  await expect(
    f.teach.start({ ...f.input, nonce: "next", target: { botId: f.input.botId } as never })
  ).rejects.toThrow("2 GB")
  expect(f.teach.repository.forNonce({ ...f.input, nonce: "next" })).toBeNull()
  expect((await readFile(join(f.folder, "video.webm"))).equals(f.content)).toBe(true)
})
