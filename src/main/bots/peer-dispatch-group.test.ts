import { afterEach, expect, it } from "vitest"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
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
import type { BotPeerDispatchOptions } from "../../shared/bot-peer-dispatch"
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(branch = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-private-group-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const lock = BotHostLock.acquire(directory)!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const host = new BotHost(store, undefined, 1, undefined, files)
  host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\group-peer-${token.slice(0, 16)}`
        : join(directory, "peer.sock"),
    rpc = new BotRpcServer(host, token)
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
  const a = store.createBot({ nonce: "a", name: "OwnerA" }),
    b = store.createBot({ nonce: "b", name: "WorkerB" }),
    c = store.createBot({ nonce: "c", name: "UnrelatedC" }),
    group = store.createGroup({
      nonce: "group",
      name: "Public discussion",
      members: [a.bot.id, b.bot.id]
    })
  let threadRootId: string | undefined
  if (branch) {
    const root = store.send({
      nonce: "root",
      conversationId: group.id,
      recipients: [a.bot.id],
      text: "GROUP_FORK_BACKGROUND"
    })
    root.runIds.forEach((id) => store.cancel(id))
    threadRootId = root.messageId
  }
  const request = store.send({
      nonce: "group-task",
      conversationId: group.id,
      recipients: [a.bot.id],
      text: "GROUP_PRIVATE_USER_GOAL",
      ...(threadRootId ? { threadRootId } : {})
    }),
    parent = store.claim(host.id)!
  expect(parent.run).toMatchObject({
    id: request.runIds[0],
    botId: a.bot.id,
    conversationId: group.id,
    source: "group-member",
    lane: "user",
    ...(threadRootId ? { threadRootId } : {})
  })
  const assignment = store.sendPeer(parent.lease, {
    nonce: "assign",
    recipient: b.bot.id,
    text: "ASSIGNMENT_PRIVATE_TO_B"
  })
  store.waitForPeer(parent.lease, assignment.runIds[0])
  const child = store.claim(host.id)!
  expect(child.run.id).toBe(assignment.runIds[0])
  return {
    directory,
    store,
    files,
    host,
    client,
    a,
    b,
    c,
    group,
    parent,
    child,
    assignment,
    threadRootId
  }
}
it.each([false, true])(
  "group await keeps explicit one-to-one response private (approved image=%s)",
  async (image) => {
    const f = await fixture(image),
      { store, client, files, parent, child, a, b, c, group } = f
    const originalWait = store.db.exec("SELECT * FROM bot_peer_waits WHERE run_id=?", [
      parent.run.id
    ])[0].values
    const groupMessages = store.messages(group.id, undefined, 100, undefined, f.threadRootId)
    const route = store.peerDispatch.resolve(child.run, a.bot.id, {})
    expect(route.conversationId).toBe(a.conversationId)
    expect(route.threadRootId).toBeUndefined()
    let response: ReturnType<BotStore["sendPeer"]>
    if (image) {
      const artifact = await files.publish(
        {
          id: "group-private-chart",
          conversationId: b.conversationId,
          runId: child.run.id,
          name: "chart.png",
          mime: "image/png"
        },
        Buffer.from(await avatarImage(), "base64"),
        child.lease
      )
      response = JSON.parse(
        await sendReviewedBotPeer(
          {
            store,
            ...child,
            bot: b.bot,
            messages: store.messagesForRun(child.run.id),
            signal: new AbortController().signal
          },
          {
            callId: "private-image",
            recipient: a.bot.id,
            text: "PRIVATE_REPLY_ONLY",
            images: [{ artifact_id: artifact.id, alt: "PRIVATE_CHART" }]
          },
          () => store.assertDispatch(child.lease),
          async (id, action, operation, commit) => {
            expect(JSON.stringify(action)).toContain(a.conversationId)
            expect(JSON.stringify(action)).toContain(artifact.sha256)
            const approval = store.requestInteraction(child.lease, {
              kind: "approval",
              prompt: JSON.stringify(action),
              action
            })
            store.answerInteraction({
              id: approval.id,
              revision: approval.revision,
              answer: "approve"
            })
            const apply = () =>
              store.approvedToolOnce(
                child.lease,
                { id, action, approvalId: approval.id },
                operation
              )
            return commit ? commit(apply) : apply()
          },
          files,
          new BotDocumentReader({
            entry: resolve("src/main/bots/document-worker-entry.ts"),
            execArgv: ["--import", "tsx"]
          })
        )
      )
    } else {
      const input = { nonce: "private-reply", recipient: a.bot.id, text: "PRIVATE_REPLY_ONLY" }
      response = store.sendPeer(child.lease, input)
      expect(store.sendPeer(child.lease, input)).toEqual(response)
    }
    expect(store.peerDispatch.awaiting(route)).toBeNull()
    expect(response.runIds).toHaveLength(1)
    expect(response.mergedIntoRunId).toBeUndefined()
    const privateRun = store.getRun(response.runIds[0])
    expect(privateRun).toMatchObject({
      botId: a.bot.id,
      conversationId: a.conversationId,
      rootRunId: parent.run.rootRunId,
      parentRunId: child.run.id,
      depth: child.run.depth + 1,
      status: "queued",
      source: "peer",
      lane: "agent"
    })
    expect(privateRun.threadRootId).toBeUndefined()
    expect(store.getRun(parent.run.id).status).toBe("waiting_input")
    expect(
      store.db.exec("SELECT * FROM bot_peer_waits WHERE run_id=?", [parent.run.id])[0].values
    ).toEqual(originalWait)
    expect(store.steering.hasPending(parent.run.id)).toBe(false)
    expect(store.messages(group.id, undefined, 100, undefined, f.threadRootId)).toEqual(
      groupMessages
    )
    expect(store.claim("cannot-run-two-a-turns")).toBeNull()
    const incoming = (await client.call("messages", { conversationId: a.conversationId })).find(
      (m) => m.id === response.messageId
    )!
    const link = incoming.peerExchanges![0]
    expect(link).toMatchObject({
      anchor: { conversationId: a.conversationId, runId: privateRun.id },
      peerRunId: privateRun.id,
      direction: "incoming"
    })
    const exchange = await client.call("peerExchange", {
      anchor: link.anchor,
      peerRunId: link.peerRunId,
      expectedDataEpoch: "initial"
    })
    expect(exchange).toMatchObject({
      sender: { botId: b.bot.id },
      recipient: { botId: a.bot.id },
      request: { text: "PRIVATE_REPLY_ONLY" },
      reply: null
    })
    expect(JSON.stringify(exchange)).not.toMatch(
      /GROUP_PRIVATE_USER_GOAL|ASSIGNMENT_PRIVATE_TO_B|GROUP_FORK_BACKGROUND/
    )
    if (image) {
      expect(exchange.request.images).toHaveLength(1)
      expect(store.getArtifact(exchange.request.images[0].id)).toMatchObject({
        conversationId: a.conversationId,
        runId: privateRun.id
      })
      const outgoing = (await client.call("messages", { conversationId: b.conversationId })).find(
        (m) => m.peerDelivery?.recipientRunId === privateRun.id
      )!
      const other = outgoing.peerExchanges!.find((m) => m.peerRunId === privateRun.id)!
      expect(
        (
          await client.call("peerExchange", {
            anchor: other.anchor,
            peerRunId: other.peerRunId,
            expectedDataEpoch: "initial"
          })
        ).request
      ).toEqual(exchange.request)
      expect(store.artifacts(group.id).filter((a) => a.origin === "peer")).toHaveLength(0)
    }
    await expect(
      client.call("peerExchange", {
        anchor: {
          conversationId: group.id,
          runId: parent.run.id,
          ...(f.threadRootId ? { threadRootId: f.threadRootId } : {})
        },
        peerRunId: privateRun.id,
        expectedDataEpoch: "initial"
      })
    ).rejects.toThrow()
    await expect(
      client.call("peerExchange", {
        anchor: { conversationId: c.conversationId, runId: privateRun.id },
        peerRunId: privateRun.id,
        expectedDataEpoch: "initial"
      })
    ).rejects.toThrow()
    if (f.threadRootId)
      await expect(
        client.call("peerExchange", {
          anchor: { ...link.anchor, threadRootId: f.threadRootId },
          peerRunId: link.peerRunId,
          expectedDataEpoch: "initial"
        })
      ).rejects.toThrow()
    store.finish(child.lease, "succeeded", "B_LOCAL_FINAL_WAIT_RESULT")
    expect(store.waitForPeer(parent.lease, child.run.id)).toMatchObject({
      status: "succeeded",
      result: "B_LOCAL_FINAL_WAIT_RESULT"
    })
    expect(store.getRun(parent.run.id).status).toBe("running")
    expect(store.messages(group.id, undefined, 100, undefined, f.threadRootId)).toEqual(
      groupMessages
    )
    expect(
      store.messages(a.conversationId).some((m) => m.text === "B_LOCAL_FINAL_WAIT_RESULT")
    ).toBe(false)
  },
  10000
)
it.each(["status", "question"] as const)(
  "group waiting %s keeps one private response and the original await",
  async (intent) => {
    const { store, parent, child, a, group } = await fixture()
    const response = store.sendPeer(child.lease, {
      nonce: "private-update",
      recipient: a.bot.id,
      text: "PRIVATE_UPDATE",
      intent
    })
    expect(response.runIds).toHaveLength(1)
    expect(response.mergedIntoRunId).toBeUndefined()
    expect(store.getRun(response.runIds[0])).toMatchObject({
      conversationId: a.conversationId,
      parentRunId: child.run.id,
      rootRunId: parent.run.rootRunId
    })
    expect(store.getRun(parent.run.id).status).toBe("waiting_input")
    expect(store.messages(group.id).some((m) => m.text === "PRIVATE_UPDATE")).toBe(false)
    store.finish(child.lease, "succeeded", "TERMINAL_EVIDENCE")
    expect(store.waitForPeer(parent.lease, child.run.id).status).toBe("succeeded")
    expect(store.messages(group.id).some((m) => m.text === "TERMINAL_EVIDENCE")).toBe(false)
  }
)
it("withdrawn group membership and wrong task references cannot deliver or grant private reply access", async () => {
  const { store, client, parent, child, a, b, c, group } = await fixture(true)
  const counts = () =>
    store.db.exec(
      "SELECT (SELECT COUNT(*) FROM bot_runs),(SELECT COUNT(*) FROM bot_messages),(SELECT COUNT(*) FROM bot_receipts),(SELECT COUNT(*) FROM bot_steering),(SELECT COUNT(*) FROM bot_effects)"
    )[0].values[0]
  const beforeWrong = counts()
  expect(() =>
    store.sendPeer(child.lease, {
      nonce: "foreign-reply",
      recipient: c.bot.id,
      text: "WRONG_BOT",
      reply_to_run_id: child.run.id
    } satisfies BotPeerDispatchOptions & { nonce: string; recipient: string; text: string })
  ).toThrow()
  expect(counts()).toEqual(beforeWrong)
  await expect(
    client.call("peerExchange", {
      anchor: { conversationId: group.id, runId: parent.run.id },
      peerRunId: child.run.id,
      expectedDataEpoch: "initial"
    })
  ).rejects.toThrow()
  store.updateGroup({
    id: group.id,
    revision: group.revision,
    name: group.name,
    description: "",
    members: [a.bot.id]
  })
  expect(store.getRun(parent.run.id).status).toBe("cancelling")
  expect(store.getRun(child.run.id).status).toBe("cancelling")
  const beforeRevoked = counts()
  expect(() =>
    store.sendPeer(child.lease, { nonce: "revoked", recipient: a.bot.id, text: "NOT_AUTHORIZED" })
  ).toThrow()
  expect(counts()).toEqual(beforeRevoked)
  expect(store.messages(a.conversationId)).toEqual([])
  expect(store.getConversation(group.id).members).not.toContain(b.bot.id)
})
