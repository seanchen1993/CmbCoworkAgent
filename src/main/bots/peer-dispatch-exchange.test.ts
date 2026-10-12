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
import { prepareBotPeerImages } from "./peer-image-input"
import type { BotPeerExchangeLink } from "../../shared/bot-peer-exchange"
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each([false, true])(
  "authenticated both-side merged text/image exchange keeps exact original task and branch (image=%s)",
  async (image) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-merged-")))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const lock = BotHostLock.acquire(dir)!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(dir, "bots.sqlite"))
    cleanup.push(() => store.close())
    const files = new BotArtifacts(join(dir, "objects"), store)
    cleanup.push(() => files.close())
    const host = new BotHost(store, undefined, 1, undefined, files)
    host.bindOwnership(lock)
    cleanup.push(() => host.stop())
    const token = randomBytes(32).toString("hex"),
      socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\peer-${token.slice(0, 16)}`
          : join(dir, "peer.sock"),
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
    const a = store.createBot({ nonce: "a", name: "Requester" }),
      b = store.createBot({ nonce: "b", name: "Responder" })
    const start = store.send({
      nonce: "initial",
      conversationId: a.conversationId,
      text: "A_PRIVATE_USER_GOAL"
    })
    let owner = store.claim(host.id)!,
      threadRootId: string | undefined
    if (image) {
      store.finish(owner.lease, "succeeded", "Initial completed")
      threadRootId = start.messageId
      store.send({
        nonce: "branch",
        conversationId: a.conversationId,
        threadRootId,
        text: "A_PRIVATE_BRANCH_GOAL"
      })
      owner = store.claim(host.id)!
    }
    const sent = store.sendPeer(owner.lease, {
      nonce: "assign",
      recipient: b.bot.id,
      text: "ASSIGNMENT_VISIBLE_ONLY"
    })
    store.waitForPeer(owner.lease, sent.runIds[0])
    const child = store.claim(host.id)!
    let response: ReturnType<BotStore["sendPeer"]>, sourceId: string | undefined
    if (image) {
      const artifact = await files.publish(
        {
          id: "reply-chart",
          conversationId: b.conversationId,
          runId: child.run.id,
          name: "reply.png",
          mime: "image/png"
        },
        Buffer.from(await avatarImage(), "base64"),
        child.lease
      )
      sourceId = artifact.id
      const reader = new BotDocumentReader({
        entry: resolve("src/main/bots/document-worker-entry.ts"),
        execArgv: ["--import", "tsx"]
      })
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
            callId: "reply-image",
            recipient: a.bot.id,
            text: "EXPLICIT_REPLY_ONLY",
            images: [{ artifact_id: artifact.id, alt: "EXACT_ALT" }]
          },
          () => store.assertDispatch(child.lease),
          async (id, action, operation, commit) => {
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
          reader
        )
      )
    } else
      response = store.sendPeer(child.lease, {
        nonce: "reply",
        recipient: a.bot.id,
        text: "EXPLICIT_REPLY_ONLY"
      })
    expect(response).toMatchObject({
      runIds: [],
      mergedIntoRunId: owner.run.id,
      responseRoute: "explicit"
    })
    const received = (
      await client.call("messages", {
        conversationId: a.conversationId,
        ...(threadRootId ? { threadRootId } : {})
      })
    ).find((m) => m.id === response.messageId)!
    expect(received.peerExchanges).toMatchObject([
      {
        anchor: {
          conversationId: a.conversationId,
          runId: owner.run.id,
          ...(threadRootId ? { threadRootId } : {})
        },
        peerRunId: child.run.id,
        mergedMessageId: response.messageId,
        direction: "incoming",
        peer: { botId: b.bot.id }
      }
    ])
    // The RPC schema accepts addresses only, not presentation fields.
    const read = (link: BotPeerExchangeLink) =>
      client.call("peerExchange", {
        anchor: link.anchor,
        peerRunId: link.peerRunId,
        mergedMessageId: link.mergedMessageId,
        expectedDataEpoch: "initial"
      })
    const first = await read(received.peerExchanges![0])
    expect(first).toMatchObject({
      sender: { botId: b.bot.id },
      recipient: { botId: a.bot.id },
      request: { text: "EXPLICIT_REPLY_ONLY" },
      reply: null,
      status: "waiting_input"
    })
    expect(JSON.stringify(first)).not.toMatch(/A_PRIVATE|ASSIGNMENT_VISIBLE|lease|checkpoint/)
    if (image) {
      expect(first.request.images).toMatchObject([{ sourceId, alt: "EXACT_ALT" }])
      expect(first.request.images[0].id).not.toBe(sourceId)
      expect(store.getArtifact(first.request.images[0].id)).toMatchObject({
        conversationId: a.conversationId,
        runId: owner.run.id
      })
      expect(() => store.steering.interruptIfPending(owner.lease)).toThrow(/补充/)
      const currentReader = new BotDocumentReader({
        entry: resolve("src/main/bots/document-worker-entry.ts"),
        execArgv: ["--import", "tsx"]
      })
      const input = await store.steering
        .queue(owner.lease, (message) =>
          prepareBotPeerImages(
            {
              store,
              ...owner,
              bot: a.bot,
              messages: store.messagesForRun(owner.run.id),
              signal: new AbortController().signal
            },
            files,
            currentReader,
            () => store.assertDispatch(owner.lease),
            message
          )
        )
        .take({
          threadId: owner.run.id,
          ownerRunToken: `${owner.lease.owner}:${owner.lease.fence}`,
          appliedIds: [],
          phase: "beforeModel"
        })
      expect(JSON.stringify(input[0].content)).toContain("image_url")
      expect(JSON.stringify(input[0].content)).toContain("another bot reaching out, not the user")
      const outgoing = (await client.call("messages", { conversationId: b.conversationId })).find(
        (m) => m.peerDelivery?.mergedIntoRunId === owner.run.id
      )!
      expect(outgoing.peerExchanges).toMatchObject([
        {
          anchor: { conversationId: b.conversationId, runId: child.run.id },
          mergedMessageId: response.messageId,
          direction: "outgoing"
        }
      ])
      expect((await read(outgoing.peerExchanges![0])).request).toEqual(first.request)
      const senderHistory = await client.call("runHistory", {
        conversationId: b.conversationId,
        runId: child.run.id
      })
      expect(
        senderHistory.items.find((e) => e.label === "回信已进入原任务")?.peerExchange
      ).toMatchObject({
        direction: "outgoing",
        mergedMessageId: response.messageId
      })
      expect(
        (await client.call("messages", { conversationId: a.conversationId })).some(
          (m) => m.id === response.messageId
        )
      ).toBe(false)
      store.db.run("UPDATE bot_artifacts SET run_id=? WHERE id=?", [
        child.run.id,
        first.request.images[0].id
      ])
      expect((await read(received.peerExchanges![0])).request.images).toEqual([])
      store.db.run("UPDATE bot_artifacts SET run_id=? WHERE id=?", [
        owner.run.id,
        first.request.images[0].id
      ])
      store.db.run("UPDATE bot_artifact_lifecycle SET deleted_at=? WHERE artifact_id=?", [
        Date.now(),
        first.request.images[0].id
      ])
      expect((await read(received.peerExchanges![0])).request.images).toEqual([])
    }
    const receiverHistory = await client.call("runHistory", {
      conversationId: a.conversationId,
      runId: owner.run.id,
      ...(threadRootId ? { threadRootId } : {})
    })
    expect(
      receiverHistory.items.find((e) => e.label === "回信已进入原任务")?.peerExchange
    ).toMatchObject({
      direction: "incoming",
      mergedMessageId: response.messageId
    })
    await expect(
      client.call("peerExchange", {
        anchor: { conversationId: b.conversationId, runId: owner.run.id },
        peerRunId: child.run.id,
        mergedMessageId: response.messageId,
        expectedDataEpoch: "initial"
      })
    ).rejects.toThrow()
    await expect(
      client.call("peerExchange", {
        anchor: received.peerExchanges![0].anchor,
        peerRunId: child.run.id,
        mergedMessageId: sent.messageId,
        expectedDataEpoch: "initial"
      })
    ).rejects.toThrow()
    if (threadRootId)
      await expect(
        client.call("peerExchange", {
          anchor: { conversationId: a.conversationId, runId: owner.run.id },
          peerRunId: child.run.id,
          mergedMessageId: response.messageId,
          expectedDataEpoch: "initial"
        })
      ).rejects.toThrow()
    if (!image) {
      expect(() => store.steering.interruptIfPending(owner.lease)).toThrow(/补充/)
      await store.steering.queue(owner.lease).take({
        threadId: owner.run.id,
        ownerRunToken: `${owner.lease.owner}:${owner.lease.fence}`,
        appliedIds: [],
        phase: "beforeModel"
      })
    }
    store.finish(owner.lease, "succeeded", "A_PRIVATE_FINAL_NOT_A_PEER_REPLY")
    store.finish(child.lease, "succeeded", "B_LOCAL_FINAL_NOT_SECOND_SEND")
    expect((await read(received.peerExchanges![0])).reply).toBeNull()
    expect(
      store
        .messages(a.conversationId, undefined, 100, undefined, threadRootId)
        .filter((m) => m.text === "B_LOCAL_FINAL_NOT_SECOND_SEND")
    ).toHaveLength(0)
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at)VALUES('workspace.restored','new-epoch','{}',?)",
      [Date.now()]
    )
    await expect(read(received.peerExchanges![0])).rejects.toMatchObject({
      code: "data_epoch"
    })
  },
  10000
)
