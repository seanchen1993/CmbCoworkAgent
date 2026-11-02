import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { snapshotBotDeliveryFile } from "./file-copy"
import { afterEach, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { DatabaseSync } from "node:sqlite"
import { ImGatewayWsClient } from "../services/im/gateway-ws-client"
import { BotImChannelService } from "../services/im/bot-channel-service"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotImBinding } from "../../shared/bots/im-channel"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const wait = async (predicate: () => boolean, timeout = 3500) => {
  const until = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > until) throw new Error("socket condition timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

it.each(["group", "dm"] as const)("routes %s through WebSocket", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "bot-file-wire-"))
  const name = kind === "group" ? "群报告.docx" : "私聊统计.xlsx"
  const filePath = join(root, name), bytes = Buffer.alloc(80000, 0x87)
  await writeFile(filePath, bytes)
  const snapshot = await snapshotBotDeliveryFile(root, filePath, new AbortController().signal)
  const file = { name, filePath, ...snapshot }
  const fileCommands: Record<string, any>[] = [], received: Buffer[] = []
  let fileDeliveries = 0
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server address missing")
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:")),
    store = new BotStore(db)
  const bot = store.create({
    name: "Wire Bot",
    color: "#123456",
    instructions: "Answer",
    modelRef: null
  })
  let runs = 0,
    legacy = 0,
    socket: WebSocket | undefined,
    offerBot = true
  const errors: unknown[] = [],
    replies: Record<string, any>[] = [],
    acks: Record<string, any>[] = []
  const binding: BotImBinding = {
    id: "wire-binding",
    botId: bot.id,
    kind,
    label: bot.name,
    ...(kind === "group" ? { peerLabel: "原项目群" } : {}),
    version: 1,
    state: "active",
    conversationKey: `${kind}-conversation`,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    createdAt: new Date().toISOString()
  }
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      execute: async () => {
        host.mockExecution(task)
        expect(task.threadId === bot.threadId).toBe(kind === "dm" || !task.mockSource)
        runs++
        return { state: "completed", result: "已收到群内交办", files: [file] }
      }
    })
  })
  const send = (
    peer: WebSocket,
    type: string,
    payload: unknown,
    commandId?: string,
    messageId?: string
  ) =>
    peer.send(
      JSON.stringify({
        schemaVersion: 1,
        type,
        sentAt: new Date().toISOString(),
        payload,
        ...(commandId ? { commandId } : {}),
        ...(messageId ? { messageId } : {})
      })
    )
  server.on("connection", (peer) => {
    socket = peer
    peer.on("message", (raw) => {
      const frame = JSON.parse(String(raw)),
        body = frame.payload
      if (frame.type === "HELLO") {
        expect(body.protocolExtensions).toContain("bot-channel-v1")
        send(
          peer,
          "WELCOME",
          {
            sessionId: "session",
            principalId: "owner",
            serverTime: new Date().toISOString(),
            heartbeatIntervalSeconds: 60,
            ...(offerBot ? { protocolExtensions: ["bot-channel-v1", "bot-cards-v1", "bot-files-v1"] } : {})
          },
          frame.commandId
        )
      } else if (frame.type === "SYNC_REQUEST")
        send(
          peer,
          "SYNC_STATE",
          {
            defaultConversationKey: "personal-default",
            routes: [{ principalId: "owner", conversationKey: "personal-default", state: "active" }]
          },
          frame.commandId
        )
      else if (frame.type === "BOT_BINDING_COMMAND")
        send(
          peer,
          "BOT_BINDING_RESULT",
          body.action === "list" ? { items: [binding], before: null } : binding,
          frame.commandId
        )
      else if (frame.type === "EVENT_ACK") acks.push(body)
      else if (frame.type === "EXECUTION_PERMIT_ACQUIRE" || frame.type === "EXECUTION_PERMIT_RENEW")
        send(
          peer,
          "PERMIT_RESULT",
          {
            eventId: body.eventId,
            leaseId: body.lastLeaseId,
            status: "GRANTED",
            expiresAt: new Date(Date.now() + 90000).toISOString()
          },
          frame.commandId
        )
      else if (frame.type === "BOT_FILE_COMMAND") {
        fileCommands.push(body)
        if (body.action === "begin") {
          expect(body.conversationKey).toBe(binding.conversationKey)
          expect(body.name).toBe(name)
          received.length = 0
          send(peer, "BOT_FILE_RESULT", { state: "uploading", uploadId: "upload", offset: 0 }, frame.commandId)
        } else if (body.action === "chunk") {
          received.push(Buffer.from(body.data, "base64"))
          send(peer, "BOT_FILE_RESULT", { state: "uploading", uploadId: "upload", offset: Buffer.concat(received).length }, frame.commandId)
        } else if (body.action === "finish") {
          expect(Buffer.concat(received)).toEqual(bytes)
          fileDeliveries++
          send(peer, "BOT_FILE_RESULT", { state: "accepted" }, frame.commandId)
        }
      }
      else if (frame.type === "REMOTE_REPLY") {
        replies.push(body)
        send(
          peer,
          "REPLY_ACCEPTED",
          {
            deliveryId: body.deliveryId,
            idempotencyKey: body.idempotencyKey,
            segmentIndex: body.segment.index,
            state: "ACCEPTED"
          },
          frame.commandId
        )
      }
    })
  })
  const client = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}`,
    token: () => "local-test-token",
    appVersion: "test",
    onRemoteEvent: () => {
      legacy++
    },
    onBotEvent: (event) => service.receive(event),
    isProactiveRouteConfirmed: (key, principal) => service.isRouteConfirmed(key, principal)
  })
  const service = new BotImChannelService(
    client,
    "test-realm",
    () => host,
    (error) => errors.push(error)
  )
  cleanups.push(async () => {
    service.stop()
    client.stop()
    for (const peer of server.clients) peer.terminate()
    await new Promise<void>((r) => server.close(() => r()))
    await host.stop()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  service.start()
  client.start()
  await wait(() => client.supportsBotChannel())
  expect(client.supportsBotCards()).toBe(true)
  await service.create(bot.id, kind, "create")
  const event = {
    schemaVersion: 1,
    eventId: "wire-event",
    platformMessageId: "platform-message",
    principalId: "owner",
    conversationKey: binding.conversationKey,
    conversationSeq: 1,
    message: { type: "text", text: "群内交办" },
    occurredAt: new Date().toISOString(),
    lease: { id: "lease", expiresAt: new Date(Date.now() + 90000).toISOString() },
    redelivered: false
  }
  const payload = {
    event,
    route: {
      bindingId: binding.id,
      botId: bot.id,
      kind,
      label: bot.name,
      version: 1,
      senderId: "member"
    }
  }
  send(socket!, "BOT_EVENT", payload, undefined, "push-1")
  send(
    socket!,
    "BOT_EVENT",
    { ...payload, event: { ...event, redelivered: true } },
    undefined,
    "push-2"
  )
  await wait(() => replies.length === 1 && acks.some((ack) => ack.type === "completed"))
  await wait(() => fileDeliveries === 1)
  expect(fileCommands.filter(c => c.action === "begin")).toHaveLength(1)
  expect(runs).toBe(1)
  expect(legacy).toBe(0)
  expect(replies[0].conversationKey).toBe(`${kind}-conversation`)
  expect(replies[0].message.content).toBe("已收到群内交办")
  expect(errors).toEqual([])
  if (kind === "group") {
    const before = host.snapshot().imConversations![0]
    expect(before.title).toBe("原项目群")
    const displayed: string[] = []
    const unsubscribe = host.subscribe(() => displayed.push(host.snapshot().imConversations![0].title))
    // Simulate the gateway committing groupName from a new callback before BOT_EVENT.
    binding.peerLabel = "项目群 · 已改名"
    send(socket!, "BOT_EVENT", {
      ...payload,
      event: { ...event, eventId: "rename-event", platformMessageId: "rename-message", conversationSeq: 2 }
    }, undefined, "rename-push")
    await wait(() => displayed.includes(binding.peerLabel!), 7000)
    const after = host.snapshot().imConversations![0]
    expect(after).toMatchObject({ id: before.id, threadId: before.threadId, title: binding.peerLabel })
    expect(host.snapshot().imConversations).toHaveLength(1)
    await wait(() => replies.length === 2 && fileDeliveries === 2)
    expect(runs).toBe(2)
    expect(errors).toEqual([])
    unsubscribe()
  }
  if (kind === "dm") {
    host.send({ botId: bot.id, requestId: "app-input", message: "App 主对话" })
    await wait(() => replies.length === 2)
    await wait(() => fileDeliveries === 2)
    expect(runs).toBe(2)
    expect(replies[1].conversationKey).toBe(binding.conversationKey)
    expect(replies[1].deliveryId).not.toBe(replies[0].deliveryId)
    expect(legacy).toBe(0)
    expect(errors).toEqual([])
  }
  // Downgrading to an old gateway clears the capability; the legacy route still works.
  offerBot = false
  client.reconnect()
  await wait(() => client.isAuthenticated() && !client.supportsBotChannel())
  expect(client.supportsBotCards()).toBe(false)
  expect(client.supportsBotFiles()).toBe(false)
  await expect(client.botFileCommand({ action: "abort", uploadId: "old" })).rejects.toThrow("升级网关")
  await expect(client.botBindingCommand({ action: "list", botId: bot.id })).rejects.toThrow()
  send(
    socket!,
    "REMOTE_EVENT",
    { event: { ...event, eventId: "legacy", conversationKey: "personal-default" } },
    undefined,
    "legacy-push"
  )
  await wait(() => legacy === 1)
}, 15000)
