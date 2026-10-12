import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { sendReviewedBotPeer } from "./peer-approval"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"
import { BOT_FILE_BYTES, BOT_FILE_CHUNK_BYTES, BOT_VIDEO_BYTES } from "../../shared/bot-files"
import { botPeerFileSource } from "../../shared/bot-peer-files"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(bytes = Buffer.from("record_id,amount_cny\r\nP101,1200.50\r\n")) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-files-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const a = store.createBot({ nonce: "a", name: "收集" })
  const b = store.createBot({ nonce: "b", name: "制作" })
  const c = store.createBot({ nonce: "c", name: "审查" })
  const original = await files.publish(
    {
      id: "original",
      conversationId: a.conversationId,
      runId: null,
      name: "原始记录.csv",
      mime: "text/csv"
    },
    bytes
  )
  store.send({
    nonce: "task",
    conversationId: a.conversationId,
    text: "交接原文件",
    attachments: [original.id]
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
  const reviewed: unknown[] = []
  const approve: ApproveLocalBotAction = async (id, action, operation, commit) => {
    reviewed.push(action)
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
    callId: "handoff",
    recipient: b.bot.id,
    text: "独立读取原件，不依赖我的计算。",
    files: [{ artifact_id: original.id }]
  }
  return {
    directory,
    store,
    files,
    a,
    b,
    c,
    original,
    bytes,
    request,
    check,
    reviewed,
    approve,
    input
  }
}

it.each(["csv", "empty"])(
  "hands over %s original bytes with scoped aliases and one durable wake",
  async (kind) => {
    const f = await fixture(kind === "empty" ? Buffer.alloc(0) : undefined)
    const sent = JSON.parse(
      await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files)
    )
    const incoming = f.store.message({ conversationId: f.b.conversationId, id: sent.messageId })
    expect(incoming.attachments).toHaveLength(1)
    const alias = incoming.attachments[0]
    expect(alias).not.toBe(f.original.id)
    expect(incoming.peerImages).toEqual([])
    expect(incoming.attachmentFiles).toMatchObject([{ id: alias, sha256: f.original.sha256 }])
    expect(incoming.peerDelivery).not.toHaveProperty("files")
    const child = f.store.getRun(sent.runIds[0])
    expect(f.store.artifactForRun(child.id, alias)).toMatchObject({
      name: f.original.name,
      sha256: f.original.sha256,
      origin: "peer",
      runId: child.id
    })
    expect(() => f.store.artifactForRun(child.id, f.original.id)).toThrow()
    expect((await f.files.read(alias)).bytes).toEqual(f.bytes)
    expect(f.reviewed).toMatchObject([
      { peer: { recipient: { id: f.b.bot.id }, files: [{ sourceId: f.original.id }] } }
    ])
    const exchange = f.store.peerExchanges.read({
      anchor: { conversationId: f.a.conversationId, runId: f.request.run.id },
      peerRunId: child.id,
      expectedDataEpoch: f.store.snapshot().dataEpoch,
      includeFiles: true
    })
    expect(exchange.request.images).toEqual([])
    expect(exchange.request.attachmentFiles).toMatchObject([
      { id: alias, name: f.original.name, sha256: f.original.sha256 }
    ])
    expect(exchange.request.attachments).toEqual([alias])
    const legacy = f.store.peerExchanges.read({
      anchor: { conversationId: f.a.conversationId, runId: f.request.run.id },
      peerRunId: child.id,
      expectedDataEpoch: f.store.snapshot().dataEpoch
    })
    expect(legacy.request).not.toHaveProperty("attachments")
    expect(legacy.request).not.toHaveProperty("attachmentFiles")
    expect(
      (await readdir(join(f.directory, "objects"))).filter((name) => /^[a-f0-9]{64}$/.test(name))
    ).toEqual([f.original.sha256])
    const guard = vi
      .spyOn(f.files, "withPeerFiles")
      .mockRejectedValue(new Error("lost ACK must not reread"))
    expect(
      JSON.parse(await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files))
    ).toEqual(sent)
    guard.mockRestore()
    expect(f.reviewed).toHaveLength(1)
    expect(f.store.messages(f.b.conversationId)).toHaveLength(1)
    await expect(
      sendReviewedBotPeer(f.request, { ...f.input, files: [] }, f.check, f.approve, f.files)
    ).rejects.toThrow()
  }
)

it.each(["foreign", "unsubmitted", "path", "duplicate", "image-duplicate", "corrupt"])(
  "refuses %s file selection without approval or a delivered child",
  async (kind) => {
    const f = await fixture()
    let id = f.original.id
    if (kind === "foreign" || kind === "unsubmitted")
      id = (
        await f.files.publish(
          {
            id: "hidden",
            conversationId: kind === "foreign" ? f.b.conversationId : f.a.conversationId,
            runId: null,
            name: "未授权.csv",
            mime: "text/csv"
          },
          Buffer.from("private,not_shared")
        )
      ).id
    if (kind === "path") id = "/tmp/original.csv"
    if (kind === "corrupt")
      await writeFile(
        join(f.directory, "objects", f.original.sha256),
        Buffer.alloc(f.bytes.length, 1)
      )
    await expect(
      sendReviewedBotPeer(
        f.request,
        {
          ...f.input,
          files: [{ artifact_id: id }, ...(kind === "duplicate" ? [{ artifact_id: id }] : [])],
          ...(kind === "image-duplicate" ? { images: [{ artifact_id: id }] } : {})
        },
        f.check,
        f.approve,
        f.files
      )
    ).rejects.toThrow()
    expect(f.reviewed).toEqual([])
    expect(f.store.messages(f.b.conversationId)).toEqual([])
    expect(
      f.store.db.exec("SELECT id FROM bot_runs WHERE parent_run_id=?", [f.request.run.id])[0]
        ?.values ?? []
    ).toEqual([])
  }
)

it("rechecks destination revision after review before committing file aliases", async () => {
  const f = await fixture()
  const changeDestination: ApproveLocalBotAction = async (id, action, operation, commit) => {
    f.store.updateBot({ id: f.b.bot.id, revision: f.b.bot.revision, name: "已变更职责" })
    return f.approve(id, action, operation, commit)
  }
  await expect(
    sendReviewedBotPeer(f.request, f.input, f.check, changeDestination, f.files)
  ).rejects.toThrow("职责或权限已变化")
  expect(f.store.messages(f.b.conversationId)).toEqual([])
  expect(f.store.artifacts(f.b.conversationId)).toEqual([])
})

it("streams document verification without using the whole-object reader", async () => {
  const f = await fixture(Buffer.alloc(2 * 1024 * 1024, 65))
  const read = vi.spyOn(f.files, "read").mockRejectedValue(new Error("no complete object read"))
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files)
  )
  expect(sent.runIds).toHaveLength(1)
  expect(read).not.toHaveBeenCalled()
  read.mockRestore()
})

it("hands over a video above the ordinary file limit using the existing video byte policy", async () => {
  const f = await fixture()
  const bytes = Buffer.alloc(BOT_FILE_BYTES + 1)
  bytes.writeUInt32BE(16, 0)
  bytes.write("ftypisom", 4, "ascii")
  bytes.writeUInt32BE(bytes.length - 16, 16)
  bytes.write("free", 20, "ascii")
  bytes[bytes.length - 1] = 23
  const video = await f.files.publish(
    {
      id: "source-video",
      conversationId: f.a.conversationId,
      runId: f.request.run.id,
      name: "recording.mp4",
      mime: "video/mp4"
    },
    bytes,
    f.request.lease
  )
  const sent = JSON.parse(
    await sendReviewedBotPeer(
      f.request,
      { ...f.input, files: [{ artifact_id: video.id }] },
      f.check,
      f.approve,
      f.files
    )
  )
  const received = f.store.message({ conversationId: f.b.conversationId, id: sent.messageId })
  const alias = received.attachments[0]
  expect(f.store.artifactForRun(sent.runIds[0], alias)).toMatchObject({
    name: video.name,
    size: bytes.length,
    sha256: video.sha256,
    origin: "peer"
  })
  const head = await f.files.chunk({ id: alias, offset: 0 })
  const tail = await f.files.chunk({ id: alias, offset: BOT_FILE_BYTES })
  expect(Buffer.from(head.base64, "base64")).toEqual(bytes.subarray(0, BOT_FILE_CHUNK_BYTES))
  expect(Buffer.from(tail.base64, "base64")).toEqual(bytes.subarray(BOT_FILE_BYTES))
  const source = f.store.peerFileSources(f.request.lease, [{ artifact_id: video.id }])[0]
  expect(botPeerFileSource.safeParse({ ...source, size: BOT_VIDEO_BYTES }).success).toBe(true)
  expect(botPeerFileSource.safeParse({ ...source, size: BOT_VIDEO_BYTES + 1 }).success).toBe(false)
  expect(
    botPeerFileSource.safeParse({ ...source, name: "recording.csv", mime: "text/csv" }).success
  ).toBe(false)
  const exchange = f.store.peerExchanges.read({
    anchor: { conversationId: f.a.conversationId, runId: f.request.run.id },
    peerRunId: sent.runIds[0],
    expectedDataEpoch: f.store.snapshot().dataEpoch,
    includeFiles: true
  })
  expect(exchange.request.attachmentFiles).toMatchObject([
    { id: alias, size: bytes.length, mime: "video/mp4", sha256: video.sha256 }
  ])
})

it("rejects a tampered file counterpart instead of granting an unrelated exchange address", async () => {
  const f = await fixture()
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files)
  )
  const incoming = f.store.message({ conversationId: f.b.conversationId, id: sent.messageId })
  f.store.db.run("UPDATE bot_artifacts SET sha256=? WHERE id=?", [
    "e".repeat(64),
    incoming.attachments[0]
  ])
  expect(() =>
    f.store.peerExchanges.read({
      anchor: { conversationId: f.a.conversationId, runId: f.request.run.id },
      peerRunId: sent.runIds[0],
      expectedDataEpoch: f.store.snapshot().dataEpoch,
      includeFiles: true
    })
  ).toThrow("身份不一致")
})

it("rolls back file aliases, messages, receipts and child runs as one original transaction", async () => {
  const f = await fixture()
  const sources = f.store.peerFileSources(f.request.lease, f.input.files)
  const tables = [
    "bot_artifacts",
    "bot_messages",
    "bot_runs",
    "bot_receipts",
    "bot_events",
    "bot_message_files",
    "bot_message_peer_images"
  ]
  const counts = () =>
    tables.map((table) => f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0])
  const before = counts(),
    execute = f.store.db.run.bind(f.store.db)
  const fault = vi.spyOn(f.store.db, "run").mockImplementation((sql, params) => {
    if (
      sql === "INSERT INTO bot_artifacts VALUES(?,?,?,?,?,?,?,?)" &&
      Array.isArray(params) &&
      String(params[0]).startsWith("peer-file:")
    )
      throw new Error("alias commit fault")
    return execute(sql, params)
  })
  expect(() =>
    f.store.sendPeer(f.request.lease, {
      nonce: "atomic-file",
      recipient: f.b.bot.id,
      text: "交接",
      files: sources
    })
  ).toThrow("alias commit fault")
  fault.mockRestore()
  expect(counts()).toEqual(before)
})

it("forwards the original alias and new result through a second approved Bot without exposing source chats", async () => {
  const f = await fixture()
  const first = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files)
  )
  const originalAlias = f.store.message({ conversationId: f.b.conversationId, id: first.messageId })
    .attachments[0]
  const child = f.store.claim("host")!
  expect(child.run.id).toBe(first.runIds[0])
  const result = await f.files.publish(
    {
      id: "new-result",
      conversationId: f.b.conversationId,
      runId: child.run.id,
      name: "result.csv",
      mime: "text/csv"
    },
    Buffer.from("total\n1200.50\n"),
    child.lease
  )
  const request: BotRuntimeRequest = {
    ...child,
    store: f.store,
    bot: f.b.bot,
    messages: f.store.messagesForRun(child.run.id),
    signal: new AbortController().signal
  }
  const approve: ApproveLocalBotAction = async (id, action, operation, commit) => {
    const approval = f.store.requestInteraction(child.lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    const apply = () =>
      f.store.approvedToolOnce(child.lease, { id, action, approvalId: approval.id }, operation)
    return commit ? commit(apply) : apply()
  }
  const sent = JSON.parse(
    await sendReviewedBotPeer(
      request,
      {
        callId: "review",
        recipient: f.c.bot.id,
        text: "独立核对原件和结果",
        files: [{ artifact_id: originalAlias }, { artifact_id: result.id }]
      },
      () => {
        f.store.assertDispatch(child.lease)
      },
      approve,
      f.files
    )
  )
  const received = f.store.message({ conversationId: f.c.conversationId, id: sent.messageId })
  expect(received.attachments).toHaveLength(2)
  expect((await f.files.read(received.attachments[0])).bytes).toEqual(f.bytes)
  expect((await f.files.read(received.attachments[1])).bytes.toString()).toBe("total\n1200.50\n")
  expect(() => f.store.artifactForRun(sent.runIds[0], f.original.id)).toThrow()
  expect(() => f.store.artifactForRun(sent.runIds[0], originalAlias)).toThrow()
  const view = f.store.peerExchanges.read({
    anchor: { conversationId: f.b.conversationId, runId: child.run.id },
    peerRunId: sent.runIds[0],
    expectedDataEpoch: f.store.snapshot().dataEpoch,
    includeFiles: true
  })
  expect(view.request.attachmentFiles?.map((file) => file.name)).toEqual([
    "原始记录.csv",
    "result.csv"
  ])
})

it("keeps the received original and its provenance after the source file is deleted", async () => {
  const f = await fixture()
  const sent = JSON.parse(
    await sendReviewedBotPeer(f.request, f.input, f.check, f.approve, f.files)
  )
  const alias = f.store.message({ conversationId: f.b.conversationId, id: sent.messageId })
    .attachments[0]
  f.store.finish(f.request.lease, "succeeded", "交接完成")
  f.store.deleteArtifact({
    nonce: "delete-source",
    id: f.original.id,
    conversationId: f.a.conversationId,
    sha256: f.original.sha256,
    expectedDataEpoch: f.store.snapshot().dataEpoch
  })
  expect(f.store.artifactGarbage()).not.toContain(f.original.sha256)
  expect((await f.files.read(alias)).bytes).toEqual(f.bytes)
  const view = f.store.peerExchanges.read({
    anchor: { conversationId: f.a.conversationId, runId: f.request.run.id },
    peerRunId: sent.runIds[0],
    expectedDataEpoch: f.store.snapshot().dataEpoch,
    includeFiles: true
  })
  expect(view.request.attachments).toEqual([alias])
})
