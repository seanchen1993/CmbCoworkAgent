import { randomBytes } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer, createBotAPI } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bot = store.createBot({ nonce: "owner", name: "Memory Bot" }).bot
  const input = {
    botId: bot.id,
    expectedDataEpoch: store.dataEpoch(),
    nonce: "original",
    text: "one fact"
  }
  const restore = () =>
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
      ["replacement", store.now()]
    )
  const evidence = () =>
    JSON.stringify([
      store.db.exec("SELECT * FROM bot_memories"),
      store.db.exec("SELECT * FROM bot_memory_state"),
      store.db.exec("SELECT * FROM bot_events"),
      store.db.exec("SELECT * FROM bot_receipts")
    ])
  return { store, bot, input, restore, evidence }
}
it("replays the original creation without inserting another memory, including after a later edit", () => {
  const f = fixture(),
    saved = f.store.saveMemory(f.input)
  f.store.saveMemory({
    botId: f.bot.id,
    id: saved.id,
    revision: saved.revision,
    text: "later edit",
    nonce: "later",
    expectedDataEpoch: f.input.expectedDataEpoch
  })
  const before = f.evidence()
  expect(f.store.saveMemory(f.input)).toEqual(saved)
  expect(f.evidence()).toBe(before)
  expect(f.store.memories(f.bot.id)).toMatchObject([
    { id: saved.id, text: "later edit", revision: 2 }
  ])
})
it("replays a committed edit before CAS while preserving the current row", () => {
  const f = fixture(),
    saved = f.store.saveMemory({ ...f.input, nonce: "create" }),
    edit = { ...f.input, id: saved.id, revision: 1, text: "edited" },
    edited = f.store.saveMemory(edit)
  f.store.saveMemory({ ...edit, nonce: "later", revision: 2, text: "newer" })
  const before = f.evidence()
  expect(f.store.saveMemory(edit)).toEqual(edited)
  expect(f.evidence()).toBe(before)
  expect(() => f.store.saveMemory({ ...edit, nonce: "different" })).toThrow(
    expect.objectContaining({ code: "revision_conflict" })
  )
  expect(f.evidence()).toBe(before)
})
it("returns the exact durable deletion receipt and never recreates a deleted memory", () => {
  const f = fixture(),
    saved = f.store.saveMemory({ ...f.input, nonce: "create" }),
    receipt = f.store.deleteMemory(f.bot.id, saved.id, 1, f.input.expectedDataEpoch, "remove")
  expect(receipt).toMatchObject({ botId: f.bot.id, id: saved.id, revision: 2 })
  expect(Number.isSafeInteger(receipt.deletedAt)).toBe(true)
  const before = f.evidence()
  expect(f.store.deleteMemory(f.bot.id, saved.id, 1, f.input.expectedDataEpoch, "remove")).toEqual(
    receipt
  )
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect(f.evidence()).toBe(before)
  expect(() =>
    f.store.saveMemory({ ...f.input, id: saved.id, revision: 1, nonce: "resurrect" })
  ).toThrow(expect.objectContaining({ code: "revision_conflict" }))
  expect(f.evidence()).toBe(before)
})
it("refuses a reused nonce with changed text, scope, Bot, revision or operation", () => {
  const f = fixture(),
    saved = f.store.saveMemory(f.input)
  const other = f.store.createBot({ nonce: "other-bot", name: "Other" }).bot
  const before = f.evidence()
  for (const input of [
    { ...f.input, text: "changed" },
    { ...f.input, botId: other.id },
    { ...f.input, expectedDataEpoch: "changed" },
    { ...f.input, id: saved.id, revision: 1 }
  ])
    expect(() => f.store.saveMemory(input)).toThrow(
      expect.objectContaining({ code: "nonce_conflict" })
    )
  expect(() =>
    f.store.deleteMemory(f.bot.id, saved.id, 1, f.input.expectedDataEpoch, f.input.nonce)
  ).toThrow(expect.objectContaining({ code: "nonce_conflict" }))
  expect(f.evidence()).toBe(before)
})
it("keeps old accepted receipts read-only internally and rejects public old-scope ACK after restoration", async () => {
  const f = fixture(),
    saved = f.store.saveMemory(f.input),
    deleted = f.store.deleteMemory(f.bot.id, saved.id, 1, f.input.expectedDataEpoch, "remove")
  f.restore()
  const before = f.evidence(),
    api = createBotAPI(new BotHost(f.store)),
    remove = {
      botId: f.bot.id,
      id: saved.id,
      revision: 1,
      nonce: "remove",
      expectedDataEpoch: f.input.expectedDataEpoch
    }
  expect(f.store.saveMemory(f.input)).toEqual(saved)
  expect(f.store.deleteMemory(f.bot.id, saved.id, 1, f.input.expectedDataEpoch, "remove")).toEqual(
    deleted
  )
  for (const [method, input] of [
    ["saveMemory", f.input],
    ["deleteMemory", remove]
  ] as const)
    await expect(
      guardBotRpcMutationEpoch<unknown>(
        method,
        input,
        () => f.store.dataEpoch(),
        () => (method === "saveMemory" ? api.saveMemory(f.input) : api.deleteMemory(remove))
      )
    ).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.evidence()).toBe(before)
  expect(() => f.store.saveMemory({ ...f.input, nonce: "new-intent" })).toThrow(
    expect.objectContaining({ code: "data_epoch" })
  )
  expect(f.evidence()).toBe(before)
})
it("does not save a receipt for rejected CAS and permits a corrected request with that nonce", () => {
  const f = fixture(),
    saved = f.store.saveMemory({ ...f.input, nonce: "create" }),
    input = { ...f.input, id: saved.id, revision: 99, text: "edit" }
  const before = f.evidence()
  expect(() => f.store.saveMemory(input)).toThrow(
    expect.objectContaining({ code: "revision_conflict" })
  )
  expect(f.evidence()).toBe(before)
  expect(f.store.saveMemory({ ...input, revision: 1 })).toMatchObject({
    id: saved.id,
    text: "edit",
    revision: 2
  })
})
it("retains legacy no-nonce behavior and does not deduplicate independent identical facts", () => {
  const f = fixture(),
    { nonce, ...legacy } = f.input
  expect(nonce).toBe("original")
  const first = f.store.saveMemory(legacy),
    second = f.store.saveMemory(legacy)
  expect(first.id).not.toBe(second.id)
  expect(f.store.memories(f.bot.id)).toHaveLength(2)
})
it("reuses task toolOnce and refuses a public nonce combined with a trusted task lease", () => {
  const f = fixture(),
    conversation = f.store.directConversation(f.bot.id)
  f.store.send({ nonce: "message", conversationId: conversation.id, text: "remember" })
  const claim = f.store.claim("worker")!,
    input = { botId: f.bot.id, text: "task fact", sourceMessageId: claim.run.messageId }
  const saved = f.store.toolOnce(claim.lease, "remember-call", input, () =>
    f.store.saveMemory(input, { kind: "task", lease: claim.lease })
  )
  const before = f.evidence()
  expect(
    f.store.toolOnce(claim.lease, "remember-call", input, () =>
      f.store.saveMemory(input, { kind: "task", lease: claim.lease })
    )
  ).toEqual(saved)
  expect(f.evidence()).toBe(before)
  expect(() =>
    f.store.saveMemory({ ...input, nonce: "public" }, { kind: "task", lease: claim.lease })
  ).toThrow(expect.objectContaining({ code: "invalid_input" }))
  expect(f.evidence()).toBe(before)
})
it("advertises the new private receipt capability only from the actual implementing API", async () => {
  const f = fixture(),
    status = await createBotAPI(new BotHost(f.store)).status()
  expect(status.capabilities).toEqual(
    expect.arrayContaining([
      "mutation-data-epoch-v2",
      "memory-mutation-epoch",
      "private-memory-receipts"
    ])
  )
})
it("reconnects after an authenticated socket is closed after real commit, reopens SQLite, and returns exact original save/delete receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-memory-receipts-")),
    database = join(root, "bots.sqlite"),
    token = randomBytes(32).toString("hex"),
    socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\private-memory-${token.slice(0, 16)}`
        : join(root, "rpc.sock")
  let store = new BotStore(database),
    host = new BotHost(store),
    server = new BotRpcServer(host, token),
    client: BotTransportClient | undefined
  const connect = () =>
    new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
  try {
    await server.listen(socket)
    client = connect()
    const bot = store.createBot({ nonce: "owner", name: "Memory" }).bot,
      input = {
        botId: bot.id,
        text: "one intended fact",
        expectedDataEpoch: store.dataEpoch(),
        nonce: "create-once"
      },
      write = store.saveMemory.bind(store)
    let drop = true
    store.saveMemory = (...args) => {
      const result = write(...args)
      if (drop) {
        drop = false
        client!.close()
      }
      return result
    }
    await expect(client.call("saveMemory", input)).rejects.toMatchObject({
      code: "host_disconnected"
    })
    const saved = store.memories(bot.id)[0]
    expect(store.memories(bot.id)).toHaveLength(1)
    await client.closeAndWait()
    await server.close()
    await host.stop()
    store.close()
    store = new BotStore(database)
    host = new BotHost(store)
    server = new BotRpcServer(host, token)
    await server.listen(socket)
    client = connect()
    expect(await client.call("saveMemory", input)).toEqual(saved)
    expect(store.memories(bot.id)).toHaveLength(1)
    const remove = {
        botId: bot.id,
        id: saved.id,
        revision: saved.revision,
        expectedDataEpoch: input.expectedDataEpoch,
        nonce: "delete-once"
      },
      erase = store.deleteMemory.bind(store)
    drop = true
    store.deleteMemory = (...args) => {
      const result = erase(...args)
      if (drop) {
        drop = false
        client!.close()
      }
      return result
    }
    await expect(client.call("deleteMemory", remove)).rejects.toMatchObject({
      code: "host_disconnected"
    })
    expect(store.memories(bot.id)).toHaveLength(0)
    const receipt = await client.call("deleteMemory", remove)
    await client.closeAndWait()
    await server.close()
    await host.stop()
    store.close()
    store = new BotStore(database)
    host = new BotHost(store)
    server = new BotRpcServer(host, token)
    await server.listen(socket)
    client = connect()
    expect(await client.call("deleteMemory", remove)).toEqual(receipt)
    expect(store.memories(bot.id)).toHaveLength(0)
  } finally {
    await client?.closeAndWait()
    await server.close()
    await host.stop()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
