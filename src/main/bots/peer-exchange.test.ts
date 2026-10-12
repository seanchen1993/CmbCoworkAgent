import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotArtifacts } from "./artifacts"
import { avatarImage } from "./image-fixtures"
import { sendReviewedBotPeer } from "./peer-approval"
import { BotDocumentReader } from "./document-reader"
import type { ApproveLocalBotAction } from "./profile-tools"
import { resolve } from "node:path"
import type { BotPeerExchange, BotPeerExchangeRequest } from "../../shared/bot-peer-exchange"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-exchange-"))
  cleanup.push(() => rm(directory, { force: true, recursive: true }))
  const lock = BotHostLock.acquire(directory)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const host = new BotHost(store, undefined, 1, undefined, files)
  host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex")
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-exchange-${token.slice(0, 16)}`
      : join(directory, "rpc.sock")
  const rpc = new BotRpcServer(host, token)
  await rpc.listen(socketPath)
  cleanup.push(() => rpc.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  cleanup.push(() => client.closeAndWait())
  const a = await client.call("create", { nonce: "a", name: "安排" }),
    b = await client.call("create", { nonce: "b", name: "核对" })
  await client.call("send", {
    nonce: "task",
    conversationId: a.conversationId,
    text: "SOURCE_PRIVATE_USER_REQUEST"
  })
  const parent = store.claim(host.id)!
  const input = { nonce: "peer", recipient: b.bot.id, text: "计算 17+25" }
  const sent = store.sendPeer(parent.lease, input)
  const child = store.getRun(sent.runIds[0])
  const source: BotPeerExchangeRequest = {
    anchor: { conversationId: a.conversationId, runId: parent.run.id },
    peerRunId: child.id,
    expectedDataEpoch: "initial"
  }
  const received: BotPeerExchangeRequest = {
    ...source,
    anchor: { conversationId: b.conversationId, runId: child.id }
  }
  // Reflect keeps the exact same tests executable against the older API baseline.
  const read = (input: BotPeerExchangeRequest): Promise<BotPeerExchange> =>
    Reflect.apply(client.call, client, ["peerExchange", input]) as Promise<BotPeerExchange>
  return {
    directory,
    store,
    files,
    host,
    client,
    a,
    b,
    parent,
    child,
    input,
    sent,
    source,
    received,
    read
  }
}
const counts = (store: BotStore) =>
  ["bot_runs", "bot_messages", "bot_effects", "bot_receipts", "bot_peer_waits"].map(
    (name) => store.db.exec(`SELECT COUNT(*) FROM ${name}`)[0].values[0][0]
  )
it("opens the same exact text dispatch from both sides and only reads committed replies across reconnect", async () => {
  const f = await fixture(),
    before = counts(f.store)
  const incoming = (await f.client.call("messages", { conversationId: f.b.conversationId })).find(
    (m) => m.id === f.sent.messageId
  )!
  expect(incoming.runId).toBe(f.parent.run.id)
  expect(incoming.peerExchanges).toMatchObject([
    { anchor: f.received.anchor, peerRunId: f.child.id, direction: "incoming" }
  ])
  const queued = await f.read(f.source),
    received = await f.read(f.received)
  expect(queued.request).toEqual(received.request)
  expect(queued).toMatchObject({ status: "queued", request: { text: "计算 17+25" }, reply: null })
  expect(counts(f.store)).toEqual(before)
  const leased = f.store.claim(f.host.id)!
  expect(leased.run.id).toBe(f.child.id)
  f.store.streamOutput(leased.lease, "PROVISIONAL_NOT_A_REPLY")
  expect(await f.read(f.received)).toMatchObject({ status: "running", reply: null })
  f.store.finish(leased.lease, "succeeded", "42")
  const result = await f.read(f.source)
  expect(result).toMatchObject({
    status: "succeeded",
    reply: { text: "42", conversationId: f.b.conversationId }
  })
  expect((await f.read(f.received)).reply).toEqual(result.reply)
  const returned = f.store.messages(f.a.conversationId).find((m) => m.runId === f.child.id)!
  expect(returned.peerExchanges).toMatchObject([
    { anchor: f.source.anchor, peerRunId: f.child.id, direction: "outgoing" }
  ])
  const history = await f.client.call("runHistory", f.source.anchor)
  expect(history.items.find((e) => e.label === "已委派协作任务")?.peerExchange).toMatchObject({
    anchor: f.source.anchor,
    peerRunId: f.child.id
  })
  const completedCounts = counts(f.store)
  f.client.close()
  await f.client.connect()
  expect((await f.read(f.source)).reply).toEqual(result.reply)
  expect(f.store.sendPeer(f.parent.lease, f.input)).toEqual(f.sent)
  expect(counts(f.store)).toEqual(completedCounts)
  expect(JSON.stringify(result)).not.toMatch(
    /SOURCE_PRIVATE|PROVISIONAL|checkpoint|leaseOwner|instructions/
  )
})
it("rejects wrong conversation, branch, sibling, root and the foreign incoming message runId", async () => {
  const f = await fixture()
  const sibling = f.store.sendPeer(f.parent.lease, {
    nonce: "sibling",
    recipient: f.b.bot.id,
    text: "SIBLING_PRIVATE"
  })
  const c = f.store.createBot({ nonce: "other", name: "Other" })
  f.store.send({ nonce: "other-task", conversationId: c.conversationId, text: "OTHER_PRIVATE" })
  const other = f.store.claim(f.host.id)!
  expect(other.run.conversationId).toBe(c.conversationId)
  for (const anchor of [
    { ...f.source.anchor, conversationId: c.conversationId },
    { ...f.source.anchor, threadRootId: "unknown-branch" },
    { conversationId: f.b.conversationId, runId: f.parent.run.id },
    { conversationId: f.b.conversationId, runId: sibling.runIds[0] },
    { conversationId: c.conversationId, runId: other.run.id }
  ])
    await expect(f.read({ ...f.source, anchor })).rejects.toThrow()
  const child = f.store.claim(f.host.id)!
  f.store.finish(child.lease, "succeeded", "42")
  expect(JSON.stringify(await f.read(f.source))).not.toMatch(/SIBLING_PRIVATE|OTHER_PRIVATE/)
})
it("keeps a nested peer's own conversation separate from its source and immediate child", async () => {
  const f = await fixture(),
    mid = f.store.claim(f.host.id)!
  const c = f.store.createBot({ nonce: "c", name: "Third" })
  const nested = f.store.sendPeer(mid.lease, {
    nonce: "nested",
    recipient: c.bot.id,
    text: "Only nested assignment"
  })
  const message = f.store.message({ conversationId: c.conversationId, id: nested.messageId })
  expect(message.peerExchanges).toMatchObject([
    {
      anchor: { conversationId: c.conversationId, runId: nested.runIds[0] },
      peerRunId: nested.runIds[0],
      direction: "incoming"
    }
  ])
  await expect(f.read({ ...f.source, peerRunId: nested.runIds[0] })).rejects.toThrow()
  expect(
    (await f.read({ ...f.source, anchor: f.received.anchor, peerRunId: nested.runIds[0] })).request
      .text
  ).toBe("Only nested assignment")
})
it("does not invent an exchange for unknown legacy messages or corrupt dispatch identity", async () => {
  const f = await fixture()
  f.store.db.run("UPDATE bot_messages SET run_id='unknown' WHERE id=?", [f.sent.messageId])
  expect(f.store.messages(f.b.conversationId)[0].peerExchanges).toBeUndefined()
  await expect(f.read(f.source)).rejects.toThrow()
  f.store.db.run("UPDATE bot_messages SET run_id=? WHERE id=?", [f.parent.run.id, f.sent.messageId])
  f.store.db.run("UPDATE bot_events SET payload=? WHERE entity_id=? AND kind='run.handoff'", [
    "{}",
    f.parent.run.id
  ])
  expect(f.store.messages(f.b.conversationId)[0].peerExchanges).toBeUndefined()
  await expect(f.read(f.source)).rejects.toThrow()
})
it.each(["failed", "cancelled"] as const)(
  "shows %s as its actual outcome and never a succeeded reply",
  async (status) => {
    const f = await fixture(),
      child = f.store.claim(f.host.id)!
    f.store.finish(child.lease, status, "Actual terminal evidence")
    expect(await f.read(f.source)).toMatchObject({
      status,
      reply: { text: "Actual terminal evidence" }
    })
  }
)
it("scopes restored data and a real branch without creating or restarting a run", async () => {
  const f = await fixture()
  f.store.finish(f.parent.lease, "succeeded", "Initial source completed")
  const root = f.store.messages(f.a.conversationId)[0].id
  const sent = f.store.send({
    nonce: "branch",
    conversationId: f.a.conversationId,
    threadRootId: root,
    text: "Branch user context"
  })
  const parent = f.store.claim(f.host.id)!
  expect(parent.run.id).toBe(sent.runIds[0])
  const peer = f.store.sendPeer(parent.lease, {
    nonce: "branch-peer",
    recipient: f.b.bot.id,
    text: "Branch assignment"
  })
  const request = {
    anchor: { conversationId: f.a.conversationId, runId: parent.run.id, threadRootId: root },
    peerRunId: peer.runIds[0],
    expectedDataEpoch: "initial"
  }
  expect((await f.read(request)).request.text).toBe("Branch assignment")
  await expect(
    f.read({ ...request, anchor: { conversationId: f.a.conversationId, runId: parent.run.id } })
  ).rejects.toThrow()
  f.store.db.run(
    "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','new-epoch','{}',?)",
    [Date.now()]
  )
  const before = counts(f.store)
  await expect(f.read(request)).rejects.toMatchObject({ code: "data_epoch" })
  expect((await f.read({ ...request, expectedDataEpoch: "new-epoch" })).dataEpoch).toBe("new-epoch")
  expect(counts(f.store)).toEqual(before)
})
it("reads exact image aliases without changing original delivery receipts or exposing extra files", async () => {
  const f = await fixture()
  const image = await f.files.publish(
    {
      id: "shared-image",
      conversationId: f.a.conversationId,
      runId: f.parent.run.id,
      name: "chart.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    f.parent.lease
  )
  await f.files.publish(
    {
      id: "unrelated",
      conversationId: f.b.conversationId,
      runId: null,
      name: "PRIVATE_OTHER_IMAGE.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64")
  )
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const approve: ApproveLocalBotAction = async (id, action, operation, commit) => {
    const approval = f.store.requestInteraction(f.parent.lease, {
      kind: "approval",
      prompt: JSON.stringify(action),
      action
    })
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    const apply = () =>
      f.store.approvedToolOnce(f.parent.lease, { id, action, approvalId: approval.id }, operation)
    return commit ? commit(apply) : apply()
  }
  const sent = JSON.parse(
    await sendReviewedBotPeer(
      {
        store: f.store,
        ...f.parent,
        bot: f.a.bot,
        messages: f.store.messagesForRun(f.parent.run.id),
        signal: new AbortController().signal
      },
      {
        callId: "with-image",
        recipient: f.b.bot.id,
        text: "Verify chart",
        images: [{ artifact_id: image.id, alt: "Chart" }]
      },
      () => {
        f.store.assertDispatch(f.parent.lease)
      },
      approve,
      f.files,
      reader
    )
  )
  const child = f.store.getRun(sent.runIds[0])
  const source = { ...f.source, peerRunId: child.id },
    received = { ...source, anchor: { conversationId: f.b.conversationId, runId: child.id } }
  const before = counts(f.store),
    a = await f.read(source),
    b = await f.read(received)
  expect(a.request).toEqual(b.request)
  expect(a.request.images).toMatchObject([
    { id: expect.any(String), sourceId: image.id, sha256: image.sha256, alt: "Chart" }
  ])
  expect(a.request.images[0].id).not.toBe(image.id)
  expect(f.store.getArtifact(a.request.images[0].id).conversationId).toBe(f.b.conversationId)
  const outgoing = f.store
    .messages(f.a.conversationId)
    .find((m) => m.peerDelivery?.recipientRunId === child.id)!
  expect(outgoing.peerExchanges).toMatchObject([{ peerRunId: child.id, anchor: f.source.anchor }])
  expect(outgoing.peerExchanges).toHaveLength(1)
  expect(counts(f.store)).toEqual(before)
  expect(JSON.stringify(a)).not.toContain("PRIVATE_OTHER_IMAGE")
  f.store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
    Date.now(),
    a.request.images[0].id
  ])
  expect((await f.read(received)).request.images).toEqual([])
})

it("rejects an epoch replacement after the real read but before the authenticated success ACK", async () => {
  const f = await fixture(),
    before = counts(f.store)
  const original = f.store.peerExchanges.read.bind(f.store.peerExchanges)
  const spy = vi.spyOn(f.store.peerExchanges, "read").mockImplementationOnce((input) => {
    const result = original(input)
    f.store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','reply-gap-epoch','{}',?)",
      [Date.now()]
    )
    return result
  })
  cleanup.push(() => {
    spy.mockRestore()
  })
  await expect(f.read(f.source)).rejects.toMatchObject({ code: "data_epoch" })
  expect(await f.read({ ...f.source, expectedDataEpoch: "reply-gap-epoch" })).toMatchObject({
    dataEpoch: "reply-gap-epoch",
    reply: null
  })
  expect(counts(f.store)).toEqual(before)
})
it("keeps an exact group dispatch private without broadcasting its peer reply", async () => {
  const f = await fixture()
  f.store.finish(f.parent.lease, "succeeded", "Original source ended")
  const oldChild = f.store.claim(f.host.id)!
  f.store.finish(oldChild.lease, "succeeded", "Old peer ended")
  const group = f.store.createGroup({
    nonce: "group",
    name: "项目讨论",
    members: [f.a.bot.id, f.b.bot.id]
  })
  f.store.send({ nonce: "group-task", conversationId: group.id, text: "@安排 请核对" })
  const parent = f.store.claim(f.host.id)!
  expect(parent.run.botId).toBe(f.a.bot.id)
  const sent = f.store.sendPeer(parent.lease, {
    nonce: "group-private",
    recipient: f.b.bot.id,
    text: "Only this private request"
  })
  const child = f.store.claim(f.host.id)!
  expect(child.run.id).toBe(sent.runIds[0])
  f.store.finish(child.lease, "succeeded", "Private group child evidence")
  const before = counts(f.store)
  const source = {
    ...f.source,
    anchor: { conversationId: group.id, runId: parent.run.id },
    peerRunId: child.run.id
  }
  expect(await f.read(source)).toMatchObject({
    request: { text: "Only this private request" },
    reply: { text: "Private group child evidence" }
  })
  expect(
    f.store.messages(group.id).some((m) => m.text.includes("Private group child evidence"))
  ).toBe(false)
  const recipient = {
    ...source,
    anchor: { conversationId: f.b.conversationId, runId: child.run.id }
  }
  expect((await f.read(recipient)).request).toEqual((await f.read(source)).request)
  expect(counts(f.store)).toEqual(before)
})
it("reopens the same original SQLite lineage without re-enqueueing a peer", async () => {
  const f = await fixture(),
    child = f.store.claim(f.host.id)!
  f.store.finish(child.lease, "succeeded", "Original persisted reply")
  const before = counts(f.store),
    original = await f.read(f.source)
  const reopened = new BotStore(join(f.directory, "bots.sqlite"))
  try {
    expect(reopened.peerExchanges.read(f.source)).toEqual(original)
    expect(counts(reopened)).toEqual(before)
  } finally {
    reopened.close()
  }
  expect(counts(f.store)).toEqual(before)
})
it("binds both approved image records to their exact branch and rejects a source record moved to main", async () => {
  const f = await fixture()
  f.store.finish(f.parent.lease, "succeeded", "Original source ended")
  const root = f.store.messages(f.a.conversationId)[0].id
  const send = f.store.send({
    nonce: "branch-image-task",
    conversationId: f.a.conversationId,
    threadRootId: root,
    text: "Branch only"
  })
  const parent = f.store.claim(f.host.id)!
  expect(parent.run.id).toBe(send.runIds[0])
  const image = await f.files.publish(
    {
      id: "branch-image",
      conversationId: f.a.conversationId,
      runId: parent.run.id,
      name: "branch.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    parent.lease
  )
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const sent = JSON.parse(
    await sendReviewedBotPeer(
      {
        store: f.store,
        ...parent,
        bot: f.a.bot,
        messages: f.store.messagesForRun(parent.run.id),
        signal: new AbortController().signal
      },
      {
        callId: "branch-image",
        recipient: f.b.bot.id,
        text: "Exact branch chart",
        images: [{ artifact_id: image.id }]
      },
      () => {
        f.store.assertDispatch(parent.lease)
      },
      async (id, action, operation, commit) => {
        const ask = f.store.requestInteraction(parent.lease, {
          kind: "approval",
          prompt: JSON.stringify(action),
          action
        })
        f.store.answerInteraction({ id: ask.id, revision: ask.revision, answer: "approve" })
        const apply = () =>
          f.store.approvedToolOnce(parent.lease, { id, action, approvalId: ask.id }, operation)
        return commit ? commit(apply) : apply()
      },
      f.files,
      reader
    )
  )
  const request = {
    ...f.source,
    anchor: { conversationId: f.a.conversationId, runId: parent.run.id, threadRootId: root },
    peerRunId: sent.runIds[0]
  }
  const received = {
    ...request,
    anchor: { conversationId: f.b.conversationId, runId: sent.runIds[0] }
  }
  const before = counts(f.store),
    result = await f.read(request)
  expect((await f.read(received)).request).toEqual(result.request)
  expect(
    f.store
      .messages(f.a.conversationId)
      .some((m) => m.peerDelivery?.recipientRunId === sent.runIds[0])
  ).toBe(false)
  const outbound = f.store
    .messages(f.a.conversationId, undefined, 100, undefined, root)
    .find((m) => m.peerDelivery?.recipientRunId === sent.runIds[0])!
  expect(outbound.peerExchanges).toMatchObject([
    { anchor: request.anchor, peerRunId: sent.runIds[0] }
  ])
  f.store.db.run("DELETE FROM bot_message_threads WHERE message_id=?", [outbound.id])
  expect(
    f.store.messages(f.a.conversationId).find((m) => m.id === outbound.id)?.peerExchanges
  ).toBeUndefined()
  await expect(f.read(request)).rejects.toThrow()
  await expect(f.read(received)).rejects.toThrow()
  expect(counts(f.store)).toEqual(before)
})
