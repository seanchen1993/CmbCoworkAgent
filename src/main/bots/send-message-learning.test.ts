import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"
import { botSendMessageTool } from "./send-message-tool"
import type { BotRuntimeRequest } from "./host"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function fixture(group = false) {
  const store = new BotStore(":memory:")
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "学习助手" })
  const b = store.createBot({ nonce: "b", name: "其他成员" })
  const conversationId = group
    ? store.createGroup({ nonce: "group", name: "学习讨论", members: [a.bot.id, b.bot.id] }).id
    : a.conversationId
  const root = store.send({ nonce: "root", conversationId, text: "在这里学习示范" })
  for (const id of root.runIds) store.cancel(id)
  const teach = new BotTeachStore(store)
  let session = teach.create({
    botId: a.bot.id,
    conversationId,
    conversationRevision: store.getConversation(conversationId).revision,
    threadRootId: root.messageId,
    expectedDataEpoch: store.dataEpoch(),
    nonce: "recording",
    target: {
      botId: a.bot.id,
      generation: "scope-fixture-generation",
      controlEpoch: 1,
      control: "bot",
      viewId: "scope-fixture-view"
    }
  })
  // Metadata only: the real captured image/learning graph is exercised in teach-browser.test.
  teach.addFrame(session.id, {
    at: 10,
    sha256: "a".repeat(64),
    size: 100,
    url: "https://example.test",
    title: "Scope fixture, not browser evidence"
  })
  session = teach.update(session.id, session.revision, "finalizing")
  session = teach.update(session.id, session.revision, "queued", {
    video: { size: 200, sha256: "b".repeat(64), mime: "video/webm" }
  })
  session = teach.queue(session.id)
  const active = store.claim("learner")!
  expect(active.run.id).toBe(session.learningRunId)
  return { store, teach, a, b, root, session, conversationId, ...active }
}
function bubbles(f: ReturnType<typeof fixture>) {
  return f.store
    .messages(f.conversationId, undefined, 100, undefined, f.root.messageId)
    .filter((message) => message.sender === "bot" && message.runId === f.run.id)
}

it("publishes learning stages in the original branch, replays once and still requires saving the actual skill", () => {
  const f = fixture()
  const initialRuns = f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]
  const input = { content: "收到，正在查看录像。" }
  const receipt = f.store.sendMessage(f.lease, "opening", input)
  expect(f.store.sendMessage(f.lease, "opening", input)).toEqual(receipt)
  expect(bubbles(f)).toMatchObject([
    { id: receipt.messageId, threadRootId: f.root.messageId, text: input.content }
  ])
  expect(f.teach.get(f.session.id).phase).toBe("learning")
  expect(f.store.skills(f.a.bot.id)).toEqual([])
  expect(() =>
    f.teach.saveLearned(f.session.id, f.lease, "save", { name: "技能", instructions: "核对结果" })
  ).toThrow("完整查看")
  f.teach.readFrames(f.session.id, f.lease, [0])
  const skill = f.teach.saveLearned(f.session.id, f.lease, "save", {
    name: "技能",
    instructions: "核对结果"
  })
  expect(f.teach.get(f.session.id)).toMatchObject({ phase: "ready", skillId: skill.id })
  f.store.sendMessage(f.lease, "saved", { content: "已保存技能，尚未试跑。" })
  f.store.finish(f.lease, "succeeded", "学习完成，可选择试跑。")
  expect(bubbles(f).map((message) => message.text)).toEqual([
    input.content,
    "已保存技能，尚未试跑。",
    "学习完成，可选择试跑。"
  ])
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_runs")[0].values[0][0]).toBe(initialRuns)
})

it.each(["bot", "conversation", "thread", "phase"] as const)(
  "rejects a learning message when its persisted %s binding changes",
  (field) => {
    const f = fixture()
    const changes = {
      bot: ["bot_id", f.b.bot.id],
      conversation: ["conversation_id", f.b.conversationId],
      thread: ["thread_root", null],
      phase: ["phase", "failed"]
    } as const
    const [column, value] = changes[field]
    f.store.db.run(`UPDATE bot_teach_sessions SET ${column}=? WHERE id=?`, [value, f.session.id])
    expect(() => f.store.sendMessage(f.lease, "refused", { content: "未发送" })).toThrow(
      expect.objectContaining({ code: "message_scope" })
    )
    expect(bubbles(f)).toEqual([])
    expect(f.store.hasToolResult(f.lease, "refused")).toBe(false)
  }
)

it("checks the original learning epoch before both a new publication and receipt replay", () => {
  const f = fixture()
  const input = { content: "正在查看录像。" }
  f.store.sendMessage(f.lease, "first", input)
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',?)",
    [f.store.now()]
  )
  for (const id of ["first", "after-restore"])
    expect(() => f.store.sendMessage(f.lease, id, input)).toThrow(
      expect.objectContaining({ code: "data_epoch" })
    )
  expect(bubbles(f)).toHaveLength(1)
  expect(f.store.hasToolResult(f.lease, "after-restore")).toBe(false)
})

it("requires the modern recording's persisted learning authorization", () => {
  const f = fixture()
  f.store.db.run("UPDATE bot_teach_sessions SET learning_epoch=NULL WHERE id=?", [f.session.id])
  expect(() => f.store.sendMessage(f.lease, "missing-epoch", { content: "未发送" })).toThrow(
    expect.objectContaining({ code: "teach_scope" })
  )
  expect(bubbles(f)).toEqual([])
})

it("recovers the same learning run's delivery receipt with a new lease and fences the previous owner", () => {
  const f = fixture()
  const input = { content: "已经读到录像。" }
  const receipt = f.store.sendMessage(f.lease, "before-restart", input)
  f.store.recoverAbandonedAtStartup()
  const interrupted = f.store.getRun(f.run.id)
  f.store.recover({
    id: interrupted.id,
    revision: interrupted.revision,
    decision: "resume",
    note: "核对后继续原学习任务",
    effects: []
  })
  const recovered = f.store.claim("second-learner")!
  expect(recovered.run.id).toBe(f.run.id)
  expect(recovered.lease.fence).toBeGreaterThan(f.lease.fence)
  expect(() => f.store.sendMessage(f.lease, "late", { content: "未发送" })).toThrow(
    expect.objectContaining({ code: "stale_lease" })
  )
  expect(f.store.sendMessage(recovered.lease, "before-restart", input)).toEqual(receipt)
  expect(bubbles(f)).toHaveLength(1)
})

it("binds fresh progress to the current learning retry rather than the previous failed run", () => {
  const f = fixture()
  f.store.finish(f.lease, "failed", "模型服务暂时不可用")
  const failed = f.teach.update(f.session.id, f.session.revision, "failed")
  const retried = f.teach.retry({
    id: failed.id,
    revision: failed.revision,
    conversationRevision: f.store.getConversation(f.conversationId).revision,
    expectedDataEpoch: f.store.dataEpoch(),
    nonce: "retry"
  })
  const current = f.store.claim("retry-learner")!
  expect(current.run.id).toBe(retried.learningRunId)
  expect(current.run.id).not.toBe(f.run.id)
  expect(() => f.store.sendMessage(f.lease, "old-run", { content: "未发送" })).toThrow()
  const receipt = f.store.sendMessage(current.lease, "retry-stage", { content: "重新核对录像。" })
  expect(receipt).toMatchObject({ runId: current.run.id, threadRootId: f.root.messageId })
  expect(f.teach.forRun(current.run.id)?.attempt).toBe(1)
  expect(f.teach.forRun(f.run.id)).toBeNull()
})

it.each([{ images: [] }, { images: [{ artifact_id: "not-granted" }] }, { reply_to: "reply" }])(
  "does not grant images or quoted replies to a genuine learning run: %o",
  (extra) => {
    const f = fixture()
    expect(() => f.store.sendMessage(f.lease, "refused", { content: "未发送", ...extra })).toThrow(
      expect.objectContaining({ code: "message_scope" })
    )
    expect(f.store.hasToolResult(f.lease, "refused")).toBe(false)
    expect(bubbles(f)).toEqual([])
  }
)

it("keeps original group learning unable to publish an explicit progress message", () => {
  const f = fixture(true)
  expect(() => f.store.sendMessage(f.lease, "group", { content: "未发送" })).toThrow(
    expect.objectContaining({ code: "message_scope" })
  )
  expect(bubbles(f)).toEqual([])
})

it("exposes only the original content field in the learning tool without granting image access", async () => {
  const f = fixture()
  const request: BotRuntimeRequest = {
    store: f.store,
    bot: f.a.bot,
    run: f.run,
    lease: f.lease,
    signal: new AbortController().signal,
    messages: f.store.messagesForRun(f.run.id)
  }
  const tool = botSendMessageTool(
    request,
    () => f.store.assertDispatch(f.lease),
    undefined,
    undefined,
    {
      textOnly: true
    }
  )
  expect(tool.schema.safeParse({ content: "正在核对录像。" }).success).toBe(true)
  expect(tool.schema.safeParse({ content: "未发送", images: [] }).success).toBe(false)
  expect(tool.schema.safeParse({ content: "未发送", reply_to: f.root.messageId }).success).toBe(
    false
  )
  await tool.invoke({
    type: "tool_call",
    name: "send_message",
    id: "stage",
    args: { content: "正在核对录像。" }
  })
  expect(bubbles(f).map((message) => message.text)).toEqual(["正在核对录像。"])
})
