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
const wait = async (predicate: () => boolean) => {
  const until = Date.now() + 3500
  while (!predicate()) {
    if (Date.now() > until) throw new Error("socket condition timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

it.each(["group", "dm"] as const)("routes %s through WebSocket", async (kind) => {
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
        return { state: "completed", result: "已收到群内交办" }
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
            ...(offerBot ? { protocolExtensions: ["bot-channel-v1", "bot-cards-v1"] } : {})
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
  expect(runs).toBe(1)
  expect(legacy).toBe(0)
  expect(replies[0].conversationKey).toBe(`${kind}-conversation`)
  expect(replies[0].message.content).toBe("已收到群内交办")
  expect(errors).toEqual([])
  if (kind === "dm") {
    host.send({ botId: bot.id, requestId: "app-input", message: "App 主对话" })
    await wait(() => replies.length === 2)
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
  await expect(client.botBindingCommand({ action: "list", botId: bot.id })).rejects.toThrow()
  send(
    socket!,
    "REMOTE_EVENT",
    { event: { ...event, eventId: "legacy", conversationKey: "personal-default" } },
    undefined,
    "legacy-push"
  )
  await wait(() => legacy === 1)
})
