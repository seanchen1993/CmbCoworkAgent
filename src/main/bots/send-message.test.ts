import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botSendMessageTool } from "./send-message-tool"
import { botSentMessage } from "../../shared/bot-send-message"
import { BOT_TEACH_LEARNING_SOURCE } from "../../shared/bot-teach"
import type { BotRuntimeRequest } from "./host"
import type { BotImageResult } from "./image-contract"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import { BOT_SCHEMA_VERSION } from "./schema"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function fixture() {
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "开发" })
  const b = store.createBot({ nonce: "b", name: "复核" })
  const sent = store.send({ nonce: "task", conversationId: a.conversationId, text: "检查项目" })
  const claim = store.claim("host")!
  return { store, a, b, sent, ...claim }
}
function image(
  f: ReturnType<typeof fixture>,
  id = "diagram",
  conversationId = f.a.conversationId,
  runId: string | null = f.run.id
) {
  return f.store.publishArtifact({
    id,
    conversationId,
    runId,
    name: "diagram.png",
    mime: "image/png",
    size: 1,
    sha256: "a".repeat(64)
  })
}
it("commits intermediate messages in the original run and leaves streaming and final delivery intact", () => {
  const f = fixture()
  f.store.streamOutput(f.lease, "临时推理")
  const mid = f.store.sendMessage(f.lease, "mid", { content: "已定位问题，继续验证。" })
  expect(mid).toMatchObject({ runId: f.run.id, conversationId: f.a.conversationId })
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "running", output: "" })
  f.store.streamOutput(f.lease, "继续验证中")
  expect(f.store.message({ conversationId: f.a.conversationId, id: mid.messageId }).text).toBe(
    "已定位问题，继续验证。"
  )
  f.store.finish(f.lease, "succeeded", "验证通过，完整结果已交付。")
  expect(
    f.store
      .messages(f.a.conversationId)
      .filter((message) => message.sender === "bot")
      .map((message) => message.text)
  ).toEqual(["已定位问题，继续验证。", "验证通过，完整结果已交付。"])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(1)
})
it("reuses the exact tool receipt without a duplicate bubble and rejects changed content or quote", () => {
  const f = fixture()
  const input = { content: "结果说明", reply_to: f.sent.messageId }
  const receipt = f.store.sendMessage(f.lease, "same", input)
  expect(f.store.sendMessage(f.lease, "same", input)).toEqual(receipt)
  expect(() => f.store.sendMessage(f.lease, "same", { ...input, content: "改写" })).toThrow()
  expect(() => f.store.sendMessage(f.lease, "same", { content: input.content })).toThrow()
  expect(
    f.store.messages(f.a.conversationId).filter((message) => message.sender === "bot")
  ).toHaveLength(1)
})
it("materializes an explicit Bot quote while ordinary final run correlation remains unquoted", () => {
  const f = fixture()
  const receipt = f.store.sendMessage(f.lease, "quoted", {
    content: "对这个问题的阶段结论",
    reply_to: f.sent.messageId
  })
  expect(
    f.store.message({ conversationId: f.a.conversationId, id: receipt.messageId }).replyPreview
  ).toMatchObject({ id: f.sent.messageId, text: "检查项目" })
  const next = f.store.sendMessage(f.lease, "next", {
    content: "进一步确认",
    reply_to: receipt.messageId
  })
  expect(
    f.store.message({ conversationId: f.a.conversationId, id: next.messageId }).replyPreview?.id
  ).toBe(receipt.messageId)
  f.store.finish(f.lease, "succeeded", "完整结果")
  expect(f.store.messages(f.a.conversationId).at(-1)?.replyPreview).toBeUndefined()
})
it("keeps messages in the current branch and refuses another branch or foreign conversation", () => {
  const f = fixture()
  f.store.finish(f.lease, "succeeded", "起点")
  const other = f.store.send({
    nonce: "main",
    conversationId: f.a.conversationId,
    text: "另一个主线"
  })
  f.store.cancel(other.runIds[0])
  const foreign = f.store.send({
    nonce: "foreign",
    conversationId: f.b.conversationId,
    text: "私有对话"
  })
  f.store.cancel(foreign.runIds[0])
  const branch = f.store.send({
    nonce: "branch",
    conversationId: f.a.conversationId,
    threadRootId: f.sent.messageId,
    text: "分支任务"
  })
  const active = f.store.claim("host")!
  expect(active.run.id).toBe(branch.runIds[0])
  const mid = f.store.sendMessage(active.lease, "branch-mid", {
    content: "分支结论",
    reply_to: f.sent.messageId
  })
  expect(
    f.store.message({ conversationId: f.a.conversationId, id: mid.messageId }).threadRootId
  ).toBe(f.sent.messageId)
  expect(f.store.messages(f.a.conversationId).map((message) => message.id)).not.toContain(
    mid.messageId
  )
  for (const id of [other.messageId, foreign.messageId])
    expect(() =>
      f.store.sendMessage(active.lease, `wrong-${id}`, { content: "不能越界", reply_to: id })
    ).toThrow()
})
it("does not quote a later unaccepted message merely because it is in the same conversation", () => {
  const f = fixture()
  const later = f.store.send({
    nonce: "later",
    conversationId: f.a.conversationId,
    text: "另一项任务",
    steerRunId: undefined
  })
  expect(() =>
    f.store.sendMessage(f.lease, "future", { content: "未读目标", reply_to: later.messageId })
  ).toThrow()
})
it("reuses exact visible image artifacts and alt text in the same bubble without peer routing or copies", () => {
  const f = fixture()
  const artifact = image(f)
  const sent = f.store.sendMessage(f.lease, "image", {
    content: "这张图说明原因",
    images: [{ artifact_id: artifact.id, alt: "依赖关系图" }]
  })
  const message = f.store.message({ conversationId: f.a.conversationId, id: sent.messageId })
  expect(message).toMatchObject({
    attachments: [artifact.id],
    images: [{ id: artifact.id, sourceId: artifact.id, sha256: artifact.sha256, alt: "依赖关系图" }]
  })
  expect(message.peerDelivery).toBeUndefined()
  expect(f.store.artifacts(f.a.conversationId)).toHaveLength(1)
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(() =>
    f.store.sendMessage(f.lease, "image", {
      content: "这张图说明原因",
      images: [{ artifact_id: artifact.id, alt: "改写" }]
    })
  ).toThrow()
})
it.each(["foreign", "sibling", "duplicate", "url"])(
  "rejects %s image selection without any delivery receipt",
  (mode) => {
    const f = fixture()
    const current = image(f)
    const selected =
      mode === "foreign"
        ? image(f, "foreign", f.b.conversationId).id
        : mode === "sibling"
          ? image(f, "sibling", f.a.conversationId, null).id
          : mode === "url"
            ? "https://example.invalid/image.png"
            : current.id
    const images = [
      { artifact_id: selected },
      ...(mode === "duplicate" ? [{ artifact_id: selected }] : [])
    ]
    expect(() => f.store.sendMessage(f.lease, "refused", { content: "未发送", images })).toThrow()
    expect(f.store.hasToolResult(f.lease, "refused")).toBe(false)
    expect(
      f.store.messages(f.a.conversationId).filter((message) => message.sender === "bot")
    ).toEqual([])
  }
)
it("rolls back message, metadata, files, provisional output and receipt together on SQL failure", () => {
  const f = fixture()
  const artifact = image(f)
  f.store.streamOutput(f.lease, "仍在显示的进展")
  const baseline = f.store.events().length
  const run = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, parameters) => {
    if (sql === "INSERT INTO bot_message_files VALUES(?,?)")
      throw new Error("controlled disk fault")
    return run(sql, parameters)
  })
  expect(() =>
    f.store.sendMessage(f.lease, "fault", {
      content: "未提交",
      images: [{ artifact_id: artifact.id }]
    })
  ).toThrow("controlled disk fault")
  fault.mockRestore()
  expect(f.store.messages(f.a.conversationId)).toHaveLength(1)
  expect(f.store.getRun(f.run.id).output).toBe("仍在显示的进展")
  expect(f.store.hasToolResult(f.lease, "fault")).toBe(false)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_message_publications")[0].values[0][0]).toBe(0)
  expect(f.store.events()).toHaveLength(baseline)
})
it("refuses waiting, cancelled, group, child and learning execution routes", () => {
  const waiting = fixture()
  waiting.store.requestInteraction(waiting.lease, { kind: "question", prompt: "必要信息" })
  expect(() => waiting.store.sendMessage(waiting.lease, "waiting", { content: "未发送" })).toThrow()
  const cancelled = fixture()
  cancelled.store.cancel(cancelled.run.id)
  expect(() =>
    cancelled.store.sendMessage(cancelled.lease, "cancelled", { content: "未发送" })
  ).toThrow()
  for (const source of ["workflow-child", BOT_TEACH_LEARNING_SOURCE]) {
    const f = fixture()
    f.store.db.run("UPDATE bot_runs SET source=? WHERE id=?", [source, f.run.id])
    expect(() => f.store.sendMessage(f.lease, source, { content: "未发送" })).toThrow()
  }
  const group = fixture()
  group.store.finish(group.lease, "succeeded", "done")
  const room = group.store.createGroup({
    nonce: "room",
    name: "群聊",
    members: [group.a.bot.id, group.b.bot.id]
  })
  group.store.send({ nonce: "group-work", conversationId: room.id, text: "群工作" })
  const active = group.store.claim("host")!
  expect(() => group.store.sendMessage(active.lease, "group", { content: "未发送" })).toThrow()
  expect(
    botWorkflowChildAllows(
      {
        prompt: "task",
        shellAccess: "full",
        agentIndex: 1,
        toolStreamKey: "a".repeat(64),
        durableCallKey: "b".repeat(64),
        label: "task",
        phase: null
      },
      "send_message"
    )
  ).toBe(false)
})
it("preserves the original final even when its text repeats a prior intermediate update", () => {
  const f = fixture()
  const first = f.store.sendMessage(f.lease, "first", { content: "已完成" })
  f.store.finish(f.lease, "succeeded", "已完成")
  const messages = f.store
    .messages(f.a.conversationId)
    .filter((message) => message.sender === "bot")
  expect(messages).toHaveLength(2)
  expect(messages[0].id).toBe(first.messageId)
  expect(messages[1].id).not.toBe(first.messageId)
})
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZmcAAAAASUVORK5CYII=",
  "base64"
)
async function toolFixture() {
  const f = fixture()
  const directory = await mkdtemp(join(tmpdir(), "cmb-send-message-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new BotArtifacts(directory, f.store)
  cleanup.push(() => files.close())
  const artifact = await files.publish(
    {
      id: "real-image",
      conversationId: f.a.conversationId,
      runId: f.run.id,
      name: "view.png",
      mime: "image/png"
    },
    png,
    f.lease
  )
  const abort = new AbortController()
  const request: BotRuntimeRequest = {
    store: f.store,
    run: f.run,
    lease: f.lease,
    bot: f.a.bot,
    messages: f.store.messagesForRun(f.run.id),
    signal: abort.signal
  }
  const check = () => {
    abort.signal.throwIfAborted()
    f.store.assertDispatch(f.lease)
  }
  const reader = { image: vi.fn(async () => ({}) as BotImageResult) }
  return { ...f, files, artifact, abort, request, check, reader }
}
it("returns the original image delivery after source revocation without rereading, while a new call is refused", async () => {
  const f = await toolFixture()
  const tool = botSendMessageTool(f.request, f.check, f.files, f.reader)
  const args = { content: "图像结论", images: [{ artifact_id: f.artifact.id, alt: "画面" }] }
  const invoke = (id: string) => tool.invoke({ type: "tool_call", name: "send_message", id, args })
  const first = await invoke("image-send")
  const message = botSentMessage.parse(JSON.parse(String(first.content)))
  expect(f.reader.image).toHaveBeenCalledTimes(1)
  f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
    Date.now(),
    f.artifact.id
  ])
  expect(await invoke("image-send")).toEqual(first)
  expect(f.reader.image).toHaveBeenCalledTimes(1)
  await expect(invoke("fresh-send")).rejects.toThrow()
  expect(
    f.store.message({ conversationId: f.a.conversationId, id: message.messageId }).images?.[0]
      .sha256
  ).toBe(createHash("sha256").update(png).digest("hex"))
})
it("fences cancellation during image validation without a late message or receipt", async () => {
  const f = await toolFixture()
  let entered!: () => void
  let release!: () => void
  const atRead = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const reader = {
    image: vi.fn(async () => {
      entered()
      await held
      return {} as BotImageResult
    })
  }
  const tool = botSendMessageTool(f.request, f.check, f.files, reader)
  const sending = tool.invoke({
    type: "tool_call",
    name: "send_message",
    id: "late",
    args: { content: "不得晚到", images: [{ artifact_id: f.artifact.id }] }
  })
  const rejected = expect(sending).rejects.toThrow()
  await atRead
  f.store.cancel(f.run.id)
  f.abort.abort(new Error("cancelled"))
  release()
  await rejected
  expect(
    f.store.messages(f.a.conversationId).filter((message) => message.sender === "bot")
  ).toEqual([])
  expect(
    f.store.db.exec("SELECT COUNT(*) FROM bot_receipts WHERE nonce=?", [`tool:${f.run.id}:late`])[0]
      .values[0][0]
  ).toBe(0)
})
it("upgrades schema 60 through the existing backed-up migration without altering old messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-message-migration-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const old = new BotStore(path)
  const bot = old.createBot({ nonce: "old", name: "old" })
  old.send({ nonce: "old-message", conversationId: bot.conversationId, text: "迁移之前" })
  old.close()
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE bot_message_publications; UPDATE bot_schema SET version=60")
  db.close()
  const upgraded = new BotStore(path)
  cleanup.push(() => upgraded.close())
  expect(upgraded.messages(bot.conversationId)[0].text).toBe("迁移之前")
  expect(upgraded.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  const active = upgraded.claim("host")!
  expect(upgraded.sendMessage(active.lease, "new", { content: "迁移之后" }).runId).toBe(
    active.run.id
  )
})

it("republishes an already admitted peer image alias in the recipient's conversation without another handoff", () => {
  const f = fixture()
  const artifact = image(f)
  const handed = f.store.sendPeer(f.lease, {
    nonce: "handoff",
    recipient: f.b.bot.id,
    text: "复核图表",
    images: f.store.peerImageSources(f.lease, [{ artifact_id: artifact.id }])
  })
  const recipient = f.store.claim("recipient")!
  expect(recipient.run.id).toBe(handed.runIds[0])
  const source = f.store.message({ conversationId: f.b.conversationId, id: handed.messageId })
  const alias = source.attachments[0]
  expect(alias).not.toBe(artifact.id)
  const published = f.store.sendMessage(recipient.lease, "recipient-update", {
    content: "图表复核进展",
    images: [{ artifact_id: alias, alt: "复核图表" }]
  })
  expect(
    f.store.message({ conversationId: f.b.conversationId, id: published.messageId })
  ).toMatchObject({
    attachments: [alias],
    images: [
      {
        id: alias,
        sourceId: alias,
        sourceConversationId: f.b.conversationId,
        sha256: artifact.sha256,
        alt: "复核图表"
      }
    ]
  })
  expect(f.store.artifacts(f.b.conversationId)).toHaveLength(1)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(2)
})
it("keeps the durable message and tool receipt across a real SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cmb-message-reopen-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const first = new BotStore(path)
  const created = first.createBot({ nonce: "bot", name: "开发" })
  const sent = first.send({ nonce: "work", conversationId: created.conversationId, text: "检查" })
  const claim = first.claim("host")!
  const input = { content: "已完成定位，继续验证。", reply_to: sent.messageId }
  const delivery = first.sendMessage(claim.lease, "durable", input)
  first.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.sendMessage(claim.lease, "durable", input)).toEqual(delivery)
  expect(
    reopened.message({ conversationId: created.conversationId, id: delivery.messageId })
  ).toMatchObject({ text: input.content, replyPreview: { id: sent.messageId } })
  expect(reopened.messages(created.conversationId)).toHaveLength(2)
  reopened.finish(claim.lease, "succeeded", "验证结果")
  expect(reopened.messages(created.conversationId)).toHaveLength(3)
})
