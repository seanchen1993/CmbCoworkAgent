import { afterEach, expect, it, vi } from "vitest"
import { HumanMessage } from "@langchain/core/messages"
import { BotSkillPrompts } from "./skill-prompts"
import type { BotSkillHooks } from "./skill-hooks"
import { prepareBotPeerImages } from "./peer-image-input"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { BotArtifacts } from "./artifacts"
import { BotDocumentReader } from "./document-reader"
import { resolve } from "node:path"
import { avatarImage } from "./image-fixtures"
import { sendReviewedBotPeer } from "./peer-approval"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-images-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const a = store.createBot({ nonce: "a", name: "图表分析" }),
    b = store.createBot({ nonce: "b", name: "复核" })
  const image = await files.publish(
    {
      id: "chart",
      conversationId: a.conversationId,
      runId: null,
      name: "chart.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64")
  )
  store.send({
    nonce: "task",
    conversationId: a.conversationId,
    text: "请复核图表",
    attachments: [image.id]
  })
  const { run, lease } = store.claim("host")!
  const request: BotRuntimeRequest = {
    run,
    lease,
    store,
    bot: a.bot,
    messages: store.messagesForRun(run.id),
    signal: new AbortController().signal
  }
  const check = () => {
    store.assertDispatch(lease)
  }
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const approved: unknown[] = []
  const approve: ApproveLocalBotAction = async (id, action, operation, commit) => {
    approved.push(action)
    const approval = store.requestInteraction(lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    const apply = () =>
      store.approvedToolOnce(lease, { id, action, approvalId: approval.id }, operation)
    return commit ? commit(apply) : apply()
  }
  const input = {
    callId: "share",
    recipient: b.bot.id,
    text: "复核这张图片",
    images: [{ artifact_id: image.id, alt: "图表说明" }]
  }
  return { directory, store, files, a, b, image, request, check, approved, approve, input, reader }
}
it("delivers scoped aliases and exact images in the original peer transaction without copying or duplicate wakes", async () => {
  const f = await fixture()
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files, f.reader)
  )
  const message = f.store.message({ conversationId: f.b.conversationId, id: sent.messageId })
  expect(message.attachments).toHaveLength(1)
  expect(message.attachments[0]).not.toBe(f.image.id)
  expect(message.peerImages).toMatchObject([
    { id: message.attachments[0], sourceId: f.image.id, sha256: f.image.sha256, alt: "图表说明" }
  ])
  expect(f.store.getArtifact(message.attachments[0])).toMatchObject({
    conversationId: f.b.conversationId,
    sha256: f.image.sha256,
    origin: "peer",
    runId: sent.runIds[0]
  })
  const outgoing = f.store
    .messages(f.a.conversationId)
    .find((entry) => entry.peerDelivery?.direction === "outgoing")!
  expect(outgoing).toMatchObject({
    sender: "system",
    runId: f.request.run.id,
    peerDelivery: {
      peer: { botId: f.b.bot.id },
      senderRunId: f.request.run.id,
      recipientRunId: sent.runIds[0],
      counterpart: { conversationId: f.b.conversationId, messageId: sent.messageId }
    },
    attachments: [f.image.id]
  })
  expect(message.peerDelivery).toMatchObject({
    direction: "incoming",
    counterpart: { messageId: outgoing.id }
  })
  expect(f.approved).toMatchObject([
    {
      peer: {
        recipient: { id: f.b.bot.id },
        message: f.input.text,
        images: [
          { sourceId: f.image.id, sha256: f.image.sha256, size: f.image.size, alt: "图表说明" }
        ]
      }
    }
  ])
  expect(
    (await readdir(join(f.directory, "objects"))).filter((name) => /^[a-f0-9]{64}$/.test(name))
  ).toEqual([f.image.sha256])
  const read = vi
    .spyOn(f.files, "withPeerImages")
    .mockRejectedValue(new Error("must not reread an acknowledged image"))
  expect(
    JSON.parse(await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files, f.reader))
  ).toEqual(sent)
  expect(f.approved).toHaveLength(1)
  expect(f.store.messages(f.b.conversationId)).toHaveLength(1)
  await expect(
    sendReviewedBotPeer(
      f.request,
      { ...f.input, images: [{ artifact_id: f.image.id, alt: "CHANGED" }] },
      f.check,
      f.approve,
      f.files,
      f.reader
    )
  ).rejects.toThrow()
  read.mockRestore()
})
it.each(["foreign", "sibling", "path", "duplicate"])(
  "refuses %s image sources before approval without sending",
  async (mode) => {
    const f = await fixture()
    let id = f.image.id
    if (mode === "foreign")
      id = (
        await f.files.publish(
          {
            id: "foreign",
            conversationId: f.b.conversationId,
            runId: null,
            name: "secret.png",
            mime: "image/png"
          },
          Buffer.from(await avatarImage(), "base64")
        )
      ).id
    if (mode === "sibling")
      id = (
        await f.files.publish(
          {
            id: "sibling",
            conversationId: f.a.conversationId,
            runId: null,
            name: "unselected.png",
            mime: "image/png"
          },
          Buffer.from(await avatarImage(), "base64")
        )
      ).id
    if (mode === "path") id = "file:///private/credentials.png"
    const images = [{ artifact_id: id }, ...(mode === "duplicate" ? [{ artifact_id: id }] : [])]
    await expect(
      sendReviewedBotPeer(f.request, { ...f.input, images }, f.check, f.approve, f.files, f.reader)
    ).rejects.toThrow()
    expect(f.approved).toEqual([])
    expect(f.store.messages(f.b.conversationId)).toEqual([])
  }
)
it.each(["cancel", "recipient", "source", "denied"])(
  "does not commit image aliases or wakes after approval %s changes",
  async (mode) => {
    const f = await fixture()
    const approve: ApproveLocalBotAction = async (_id, _action, operation, commit) => {
      if (mode === "denied") return "用户拒绝本次修改，未执行。"
      if (mode === "cancel") f.store.cancel(f.request.run.id)
      if (mode === "recipient")
        f.store.updateBot({ id: f.b.bot.id, revision: f.b.bot.revision, name: "Changed" })
      if (mode === "source")
        f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
          Date.now(),
          f.image.id
        ])
      return commit ? commit(operation) : operation()
    }
    const result = sendReviewedBotPeer(f.request, f.input, f.check, approve, f.files, f.reader)
    if (mode === "denied") expect(await result).toContain("拒绝")
    else await expect(result).rejects.toThrow()
    expect(f.store.messages(f.b.conversationId)).toEqual([])
    expect(f.store.artifacts(f.b.conversationId)).toEqual([])
    expect(f.store.effects(f.request.run.id)).toEqual([])
  }
)
it("keeps [] compatible with the original text receipt and does not ask a new approval", async () => {
  const f = await fixture()
  const original = f.store.sendPeer(f.request.lease, {
    nonce: `peer:${f.request.run.id}:text`,
    recipient: f.b.bot.id,
    text: "text"
  })
  expect(
    JSON.parse(
      await sendReviewedBotPeer(
        f.request,
        { callId: "text", recipient: f.b.bot.id, text: "text", images: [] },
        f.check,
        f.approve,
        f.files,
        f.reader
      )
    )
  ).toEqual(original)
  expect(f.approved).toEqual([])
  const history = vi.spyOn(f.store, "messagesForRun").mockImplementation(() => {
    throw new Error("text handoff must not resolve image history")
  })
  expect(
    JSON.parse(
      await sendReviewedBotPeer(
        f.request,
        { callId: "text-new", recipient: f.b.bot.id, text: "new text", images: [] },
        f.check,
        f.approve,
        f.files,
        f.reader
      )
    ).runIds
  ).toHaveLength(1)
  expect(history).not.toHaveBeenCalled()
  history.mockRestore()
})
it("rolls the original transaction back if a ready image alias cannot be linked", async () => {
  const f = await fixture()
  const run = f.store.db.run.bind(f.store.db)
  const failing = vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
    if (sql === "INSERT INTO bot_message_peer_images VALUES(?,?,?)") throw new Error("disk fault")
    return run(sql, params)
  })
  await expect(
    sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files, f.reader)
  ).rejects.toThrow("disk fault")
  expect(f.store.messages(f.b.conversationId)).toEqual([])
  expect(f.store.artifacts(f.b.conversationId)).toEqual([])
  expect(f.store.effects(f.request.run.id)).toEqual([])
  failing.mockRestore()
})
it("rejects a declared PNG whose actual decoder fails before approval or delivery", async () => {
  const f = await fixture()
  const bad = await f.files.publish(
    {
      id: "broken",
      conversationId: f.a.conversationId,
      runId: f.request.run.id,
      name: "broken.png",
      mime: "image/png"
    },
    Buffer.from("89504e470d0a1a0a00000000", "hex"),
    f.request.lease
  )
  await expect(
    sendReviewedBotPeer(
      f.request,
      { ...f.input, images: [{ artifact_id: bad.id }] },
      f.check,
      f.approve,
      f.files,
      f.reader
    )
  ).rejects.toThrow()
  expect(f.approved).toEqual([])
  expect(f.store.messages(f.b.conversationId)).toEqual([])
})
it("drains an admitted hash verification on close and refuses new image operations", async () => {
  const f = await fixture()
  const images = f.store.peerImageSources(f.request.lease, f.input.images)
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>((done) => {
      release = done
    }),
    ready = new Promise<void>((done) => {
      entered = done
    })
  let committed = false,
    closed = false
  const operation = f.files.withPeerImages(
    f.request.lease,
    images,
    f.check,
    () => {
      committed = true
    },
    async () => {
      entered()
      await blocked
    }
  )
  await ready
  const closing = f.files.close().then(() => {
    closed = true
  })
  await expect(
    f.files.withPeerImages(f.request.lease, images, f.check, () => undefined)
  ).rejects.toThrow("关闭")
  expect(closed).toBe(false)
  expect(committed).toBe(false)
  release()
  await operation
  await closing
  expect(closed).toBe(true)
  expect(committed).toBe(true)
})
it("upgrades an existing v53 database while preserving the original text delivery receipt", async () => {
  const f = await fixture()
  const receipt = f.store.sendPeer(f.request.lease, {
    nonce: "legacy",
    recipient: f.b.bot.id,
    text: "Original"
  })
  f.store.db.run("DROP TABLE bot_message_peer_images")
  f.store.db.run("UPDATE bot_schema SET version=53")
  f.store.close()
  const reopened = new BotStore(join(f.directory, "bots.sqlite"))
  cleanup.push(() => reopened.close())
  expect(reopened.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  expect(
    reopened.sendPeer(f.request.lease, {
      nonce: "legacy",
      recipient: f.b.bot.id,
      text: "Original",
      images: []
    })
  ).toEqual(receipt)
  expect(reopened.messages(f.b.conversationId)).toHaveLength(1)
  expect(reopened.messages(f.b.conversationId)[0].peerImages).toBeUndefined()
})

it("does not borrow an image explicitly attached only in a sibling branch", async () => {
  const f = await fixture()
  f.store.finish(f.request.lease, "succeeded", "ROOT_COMPLETED")
  const siblingImage = await f.files.publish(
    {
      id: "other-branch",
      conversationId: f.a.conversationId,
      runId: null,
      name: "other.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage("#e80027"), "base64")
  )
  const siblingRoot = f.store.send({
    nonce: "other-root",
    conversationId: f.a.conversationId,
    text: "Other fork"
  })
  f.store.cancel(siblingRoot.runIds[0])
  const sibling = f.store.send({
    nonce: "other-thread",
    conversationId: f.a.conversationId,
    threadRootId: siblingRoot.messageId,
    text: "Other thread private attachment",
    attachments: [siblingImage.id]
  })
  f.store.cancel(sibling.runIds[0])
  const selected = f.store.send({
    nonce: "selected-thread",
    conversationId: f.a.conversationId,
    threadRootId: f.request.run.messageId,
    text: "Current branch"
  })
  const current = f.store.claim("branch")!
  expect(current.run.id).toBe(selected.runIds[0])
  const messages = f.store.messagesForRun(current.run.id)
  expect(messages.some((message) => message.attachments.includes(siblingImage.id))).toBe(false)
  const request = { ...f.request, ...current, messages }
  const check = () => {
    f.store.assertDispatch(current.lease)
  }
  await expect(
    sendReviewedBotPeer(
      request,
      { ...f.input, images: [{ artifact_id: siblingImage.id }] },
      check,
      f.approve,
      f.files,
      f.reader
    )
  ).rejects.toThrow("当前任务")
  expect(f.approved).toEqual([])
  expect(f.store.messages(f.b.conversationId)).toEqual([])
  const validImages = f.store.peerImageSources(current.lease, f.input.images)
  const delivered = f.store.sendPeer(current.lease, {
    nonce: "private-branch-image",
    recipient: f.b.bot.id,
    text: "BRANCH_HANDOFF_PRIVATE_TEXT",
    images: validImages
  })
  expect(
    f.store
      .messages(f.a.conversationId)
      .some((message) => message.peerDelivery?.direction === "outgoing")
  ).toBe(false)
  expect(JSON.stringify(f.store.messages(f.a.conversationId))).not.toContain(
    "BRANCH_HANDOFF_PRIVATE_TEXT"
  )
  const outgoing = f.store
    .messages(f.a.conversationId, undefined, 100, undefined, f.request.run.messageId)
    .find((message) => message.peerDelivery?.direction === "outgoing")!
  expect(outgoing).toMatchObject({
    text: "BRANCH_HANDOFF_PRIVATE_TEXT",
    threadRootId: f.request.run.messageId,
    runId: current.run.id,
    attachments: [f.image.id]
  })
  const incoming = f.store.message({ conversationId: f.b.conversationId, id: delivered.messageId })
  expect(incoming.threadRootId).toBeUndefined()
  expect(incoming.peerImages).toMatchObject([{ sourceId: f.image.id }])
  expect(f.store.getArtifact(incoming.attachments[0])).toMatchObject({
    conversationId: f.b.conversationId,
    runId: delivered.runIds[0]
  })
})
it("keeps peer image blocks as peer inputs without invoking a human UserPromptSubmit Hook", async () => {
  const f = await fixture()
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files, f.reader)
  )
  const current = f.store.claim("recipient")!
  expect(current.run.id).toBe(sent.runIds[0])
  const request = {
    ...f.request,
    ...current,
    bot: f.b.bot,
    messages: f.store.messagesForRun(current.run.id)
  }
  const blocks = await prepareBotPeerImages(request, f.files, f.reader, () => {
    f.store.assertDispatch(current.lease)
  })
  expect(blocks).toBeDefined()
  const hook = vi.fn().mockResolvedValue(null)
  const prompts = new BotSkillPrompts(request, { run: hook } as unknown as BotSkillHooks)
  const message = new HumanMessage({ id: current.run.messageId, content: blocks! })
  expect((await prompts.prepare([message]))[0]).toBe(message)
  expect(hook).not.toHaveBeenCalled()
  expect(
    f.store.message({ conversationId: f.b.conversationId, id: current.run.messageId }).sender
  ).toBe("bot")
})
it("preserves real user string Hook rewrite receipts and rejects unsupported user blocks", async () => {
  const f = await fixture()
  const hook = vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    updatedInput: { message: "REWRITTEN_USER_TASK" },
    additionalContext: "USER_HOOK_CONTEXT"
  })
  const prompts = new BotSkillPrompts(f.request, { run: hook } as unknown as BotSkillHooks)
  await expect(
    prompts.prepare([
      new HumanMessage({
        id: f.request.run.messageId,
        content: [{ type: "text", text: "unsupported user blocks" }]
      })
    ])
  ).rejects.toThrow("任务输入检查暂不支持此消息格式")
  expect(hook).not.toHaveBeenCalled()
  const input = new HumanMessage({
    id: f.request.run.messageId,
    content: "Original prepared string"
  })
  const first = await prompts.prepare([input])
  expect(first[0].content).toContain("REWRITTEN_USER_TASK")
  expect(first[0].content).toContain("USER_HOOK_CONTEXT")
  expect((await prompts.prepare([input]))[0].content).toEqual(first[0].content)
  expect(hook).toHaveBeenCalledTimes(1)
})

it("replays the durable image delivery after reopening Store without rereading a revoked source", async () => {
  const f = await fixture()
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files, f.reader)
  )
  f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
    Date.now(),
    f.image.id
  ])
  f.store.close()
  const store = new BotStore(join(f.directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(f.directory, "objects"), store)
  cleanup.push(() => files.close())
  const inspect = vi
    .spyOn(files, "withPeerImages")
    .mockRejectedValue(new Error("must not reread a revoked source"))
  const approval = vi.fn().mockRejectedValue(new Error("must not request another approval"))
  const request = { ...f.request, store, messages: store.messagesForRun(f.request.run.id) }
  expect(
    JSON.parse(
      await sendReviewedBotPeer(
        request,
        f.input,
        () => {
          store.assertDispatch(f.request.lease)
        },
        approval,
        files,
        f.reader
      )
    )
  ).toEqual(sent)
  expect(inspect).not.toHaveBeenCalled()
  expect(approval).not.toHaveBeenCalled()
  expect(
    store
      .messages(f.b.conversationId)
      .filter((message) => message.peerDelivery?.direction === "incoming")
  ).toHaveLength(1)
  expect(
    store.getArtifact(
      store.message({ conversationId: f.b.conversationId, id: sent.messageId }).attachments[0]
    ).sha256
  ).toBe(f.image.sha256)
})

it("preserves the original blocking UserPromptSubmit decision for a real user string", async () => {
  const f = await fixture()
  const hook = vi.fn().mockResolvedValue({
    exitCode: 2,
    stdout: "",
    stderr: "",
    blocked: true,
    decision: "block",
    reason: "USER_POLICY_REFUSED"
  })
  const prompts = new BotSkillPrompts(f.request, { run: hook } as unknown as BotSkillHooks)
  await expect(
    prompts.prepare([
      new HumanMessage({ id: f.request.run.messageId, content: "Original prepared user string" })
    ])
  ).rejects.toThrow("USER_POLICY_REFUSED")
  expect(hook).toHaveBeenCalledTimes(1)
})

it("rolls back the entire standalone peer transaction when the second image alias fails", async () => {
  const f = await fixture()
  const another = await f.files.publish(
    {
      id: "second",
      conversationId: f.a.conversationId,
      runId: f.request.run.id,
      name: "second.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    f.request.lease
  )
  const images = f.store.peerImageSources(f.request.lease, [
    ...f.input.images,
    { artifact_id: another.id }
  ])
  const tables = [
    "bot_artifacts",
    "bot_artifact_lifecycle",
    "bot_message_files",
    "bot_message_peer_images",
    "bot_messages",
    "bot_runs",
    "bot_receipts",
    "bot_events",
    "bot_peer_authority"
  ]
  const counts = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
      ])
    )
  const before = counts()
  const execute = f.store.db.run.bind(f.store.db)
  let aliases = 0
  const broken = vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
    if (
      sql === "INSERT INTO bot_artifacts VALUES(?,?,?,?,?,?,?,?)" &&
      Array.isArray(params) &&
      String(params[0]).startsWith("peer-image:") &&
      ++aliases === 2
    )
      throw new Error("second alias fault")
    return execute(sql, params)
  })
  expect(() =>
    f.store.sendPeer(f.request.lease, {
      nonce: "two-image-transaction",
      recipient: f.b.bot.id,
      text: "Two images",
      images
    })
  ).toThrow("second alias fault")
  expect(aliases).toBe(2)
  expect(counts()).toEqual(before)
  expect(f.store.messages(f.b.conversationId)).toEqual([])
  expect(f.store.artifacts(f.b.conversationId)).toEqual([])
  broken.mockRestore()
})
