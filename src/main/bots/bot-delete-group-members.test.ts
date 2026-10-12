import { afterEach, expect, it } from "vitest"
import { copyFileSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import type { Socket } from "node:net"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function open(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  return store
}
function fixture(path?: string, count = 3) {
  const store = open(path)
  const bots = Array.from({ length: count }, (_, index) =>
    store.createBot({ nonce: `create-${index}`, name: `Member ${index}` })
  )
  const group = store.createGroup({
    nonce: "group",
    name: "Review group",
    members: bots.slice(0, Math.min(count, 6)).map(({ bot }) => bot.id)
  })
  return { store, bots, group }
}
function events(store: BotStore) {
  return JSON.stringify(store.db.exec("SELECT * FROM bot_events ORDER BY cursor"))
}
function close(store: BotStore) {
  stores.splice(stores.indexOf(store), 1)
  store.close()
}

it("deleting an idle member retires its membership once and releases a full group's replacement slot", () => {
  const f = fixture(undefined, 7)
  const before = f.store.getConversation(f.group.id)
  f.store.deleteBot(f.bots[0].bot.id, f.bots[0].bot.revision)
  const current = f.store.getConversation(f.group.id)
  expect(current.members).toEqual(before.members.filter((id) => id !== f.bots[0].bot.id))
  expect(current.revision).toBe(before.revision + 1)
  expect(f.store.getConversation(f.bots[0].conversationId).members).toEqual([f.bots[0].bot.id])
  const once = events(f.store)
  f.store.deleteBot(f.bots[0].bot.id, f.bots[0].bot.revision)
  expect(events(f.store)).toBe(once)
  expect(f.store.getConversation(f.group.id)).toEqual(current)
  expect(() =>
    f.store.updateGroup({
      ...before,
      description: before.description ?? "",
      nonce: "stale",
      members: current.members
    })
  ).toThrow("群聊已变化")
  const updated = f.store.updateGroup({
    ...current,
    description: current.description ?? "",
    nonce: "replacement",
    members: [...current.members, f.bots[6].bot.id]
  })
  expect(updated.members).toHaveLength(6)
  expect(updated.members).not.toContain(f.bots[0].bot.id)
  expect(() =>
    f.store.updateGroup({
      ...updated,
      description: updated.description ?? "",
      nonce: "revive",
      members: before.members
    })
  ).toThrow("Bot 不存在")
})

it("empty groups preserve historical identities and accept a replacement without creating work while empty", () => {
  const f = fixture(undefined, 2)
  const sent = f.store.send({
    nonce: "history",
    conversationId: f.group.id,
    text: "Historical task"
  })
  const first = f.store.claim("host")!
  f.store.toolOnce(first.lease, "historical-post", {}, () =>
    f.store.groups.post(first.lease, "Historical response")
  )
  f.store.finish(first.lease, "succeeded", "Historical response")
  f.store.cancel(sent.runIds[0])
  for (const owner of f.bots) f.store.deleteBot(owner.bot.id, owner.bot.revision)
  const empty = f.store.getConversation(f.group.id)
  expect(empty.members).toEqual([])
  expect(empty.revision).toBe(f.group.revision + 2)
  expect(f.store.snapshot().conversations.find((item) => item.id === f.group.id)?.members).toEqual(
    []
  )
  const history = JSON.stringify(f.store.messages(f.group.id))
  expect(history).toContain("Historical task")
  expect(history).toContain(first.run.botId)
  const runs = JSON.stringify(f.store.db.exec("SELECT * FROM bot_runs"))
  expect(() =>
    f.store.send({ nonce: "empty", conversationId: f.group.id, text: "Must not dispatch" })
  ).toThrow("没有可用 Bot")
  expect(JSON.stringify(f.store.messages(f.group.id))).toBe(history)
  expect(JSON.stringify(f.store.db.exec("SELECT * FROM bot_runs"))).toBe(runs)
  const replacement = f.store.createBot({ nonce: "replacement", name: "Replacement" })
  const saved = f.store.updateGroup({
    ...empty,
    description: empty.description ?? "",
    nonce: "add-replacement",
    members: [replacement.bot.id]
  })
  expect(saved.members).toEqual([replacement.bot.id])
  const next = f.store.send({ nonce: "continue", conversationId: f.group.id, text: "Continue" })
  expect(f.store.getRun(next.runIds[0]).botId).toBe(replacement.bot.id)
  expect(JSON.stringify(f.store.messages(f.group.id))).toContain("Historical task")
})

it("deleting an idle member closes the active group cycle without granting its remaining worker new authority", () => {
  const f = fixture(undefined, 2)
  f.store.send({
    nonce: "work",
    conversationId: f.group.id,
    text: "Ask for approval",
    recipients: [f.bots[0].bot.id]
  })
  const active = f.store.claim("host")!
  const question = f.store.requestInteraction(active.lease, {
    kind: "question",
    prompt: "Proceed?"
  })
  f.store.deleteBot(f.bots[1].bot.id, f.bots[1].bot.revision)
  expect(f.store.getConversation(f.group.id).revision).toBe(f.group.revision + 1)
  expect(f.store.getRun(active.run.id).status).toBe("cancelling")
  expect(f.store.groups.isCurrent(active.run.id)).toBe(false)
  expect(
    f.store.db.exec("SELECT status FROM bot_interactions WHERE id=?", [question.id])[0].values[0][0]
  ).toBe("cancelled")
  expect(() => f.store.groups.post(active.lease, "Late result")).toThrow()
  const once = events(f.store)
  f.store.deleteBot(f.bots[1].bot.id, f.bots[1].bot.revision)
  expect(events(f.store)).toBe(once)
  expect(f.store.db.exec("SELECT status FROM bot_group_cycles")[0].values[0][0]).toBe("cancelled")
})

it("a busy target retains its existing deletion guard and group version", () => {
  const f = fixture(undefined, 2)
  f.store.send({
    nonce: "work",
    conversationId: f.group.id,
    text: "Work",
    recipients: [f.bots[0].bot.id]
  })
  const active = f.store.claim("host")!
  expect(() => f.store.deleteBot(active.run.botId, f.bots[0].bot.revision)).toThrow("请先停止")
  expect(f.store.getConversation(f.group.id)).toMatchObject({
    members: f.group.members,
    revision: f.group.revision
  })
  expect(f.store.getRun(active.run.id).status).toBe("running")
})

it("legacy membership repair advances only affected groups and is idempotent across SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-deletion-members-legacy-"))
  const path = join(root, "bots.sqlite")
  const f = fixture(path, 3)
  const unaffected = f.store.createGroup({
    nonce: "unaffected",
    name: "Unaffected",
    members: [f.bots[1].bot.id, f.bots[2].bot.id]
  })
  const historical = f.store.send({
    nonce: "history",
    conversationId: f.group.id,
    text: "Historical"
  })
  f.store.cancel(historical.runIds[0])
  f.store.db.run("UPDATE bots SET deleted_at=1,revision=revision+1 WHERE id=?", [f.bots[0].bot.id])
  close(f.store)
  const repaired = open(path)
  expect(repaired.getConversation(f.group.id).members).not.toContain(f.bots[0].bot.id)
  expect(repaired.getConversation(f.group.id).revision).toBe(f.group.revision + 1)
  expect(repaired.getConversation(unaffected.id)).toMatchObject(unaffected)
  const once = events(repaired)
  close(repaired)
  const reopened = open(path)
  expect(events(reopened)).toBe(once)
  expect(reopened.getConversation(f.group.id).revision).toBe(f.group.revision + 1)
  expect(reopened.messages(f.group.id).some((item) => item.id === historical.messageId)).toBe(true)
})

it("legacy batches retire every affected group once, including multiple deleted members in one group", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-deletion-members-batches-"))
  const path = join(root, "bots.sqlite")
  const f = fixture(path, 3)
  const groups = [f.group]
  for (let index = 0; index < 130; index++)
    groups.push(
      f.store.createGroup({
        nonce: `group-${index}`,
        name: `Group ${index}`,
        members: f.group.members
      })
    )
  f.store.db.run("UPDATE bots SET deleted_at=1,revision=revision+1 WHERE id IN (?,?)", [
    f.bots[0].bot.id,
    f.bots[1].bot.id
  ])
  close(f.store)
  const repaired = open(path)
  for (const group of groups) {
    expect(repaired.getConversation(group.id).members).toEqual([f.bots[2].bot.id])
    expect(repaired.getConversation(group.id).revision).toBe(group.revision + 1)
  }
  const once = events(repaired)
  close(repaired)
  const reopened = open(path)
  expect(events(reopened)).toBe(once)
})

it("real checkpoint restore reuses the deletion ledger and fences group history without resurrecting membership", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-deletion-members-restore-"))
  const path = join(root, "bots.sqlite")
  const point = join(root, "point.sqlite")
  const f = fixture(path, 2)
  const sent = f.store.send({
    nonce: "history",
    conversationId: f.group.id,
    text: "Restored history"
  })
  f.store.cancel(sent.runIds[0])
  close(f.store)
  copyFileSync(path, point)
  const live = open(path)
  live.deleteBot(f.bots[0].bot.id, f.bots[0].bot.revision)
  live.deleteBot(f.bots[1].bot.id, f.bots[1].bot.revision)
  close(live)
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(point, "replacement", ledger)
  } finally {
    ledger.close()
  }
  const restored = open(point)
  expect(restored.getBot(f.bots[0].bot.id, true).deletedAt).not.toBeNull()
  expect(restored.getConversation(f.group.id)).toMatchObject({
    members: [],
    revision: f.group.revision + 1
  })
  expect(restored.snapshot().conversations.some((item) => item.id === f.group.id)).toBe(true)
  expect(restored.messages(f.group.id).some((item) => item.id === sent.messageId)).toBe(true)
  expect(() =>
    restored.updateGroup({
      ...f.group,
      description: f.group.description ?? "",
      nonce: "stale",
      expectedDataEpoch: "replacement"
    })
  ).toThrow("群聊已变化")
  expect(restored.snapshot().runs).toEqual([])
  const once = events(restored)
  close(restored)
  const reopened = open(point)
  expect(events(reopened)).toBe(once)
  expect(reopened.getConversation(f.group.id).members).toEqual([])
})

it("authenticated deletion survives a lost socket ACK without repeating group revision or cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-deletion-members-rpc-"))
  const f = fixture(join(root, "bots.sqlite"), 2)
  const host = new BotHost(f.store)
  const token = randomBytes(32).toString("hex")
  const server = new BotRpcServer(host, token)
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-del-${token.slice(0, 16)}`
      : join(root, "rpc.sock")
  const client = new BotTransportClient({
    version: BOT_PROTOCOL_VERSION,
    hostId: host.id,
    pid: process.pid,
    socketPath,
    token
  })
  const replyOwner = server as unknown as {
    reply(
      socket: Socket,
      response: { ok: boolean; [key: string]: unknown },
      flushed?: () => void
    ): void
  }
  const reply = replyOwner.reply.bind(server)
  let dropDeleteAck = true
  replyOwner.reply = (socket, response, flushed) => {
    if (dropDeleteAck && response.ok && f.store.getBot(f.bots[0].bot.id, true).deletedAt !== null) {
      dropDeleteAck = false
      socket.destroy()
      return
    }
    reply(socket, response, flushed)
  }
  try {
    await server.listen(socketPath)
    await expect(
      client.call("delete", { id: f.bots[0].bot.id, revision: f.bots[0].bot.revision })
    ).rejects.toThrow()
    const current = f.store.getConversation(f.group.id)
    expect(current.members).toEqual([f.bots[1].bot.id])
    expect(current.revision).toBe(f.group.revision + 1)
    const once = events(f.store)
    await client.call("delete", { id: f.bots[0].bot.id, revision: f.bots[0].bot.revision })
    expect(events(f.store)).toBe(once)
    expect(f.store.getConversation(f.group.id)).toEqual(current)
    await expect(
      client.call("updateGroup", {
        ...f.group,
        description: f.group.description ?? "",
        nonce: "stale",
        expectedDataEpoch: "initial"
      })
    ).rejects.toMatchObject({ code: "revision_conflict" })
    expect(events(f.store)).toBe(once)
  } finally {
    client.close()
    await server.close()
    await host.stop()
  }
})
