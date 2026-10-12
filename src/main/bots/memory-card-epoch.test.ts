import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bot = store.createBot({ nonce: "owner", name: "Memory Bot" }).bot
  const api = createBotAPI(new BotHost(store))
  const restore = () =>
    store.db.run(
      "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
      ["replacement", store.now()]
    )
  const evidence = () =>
    JSON.stringify([
      store.db.exec("SELECT * FROM bot_memories"),
      store.db.exec("SELECT * FROM bot_shared_memories"),
      store.db.exec("SELECT * FROM bot_events"),
      store.db.exec("SELECT * FROM bot_deletion_outbox")
    ])
  return { store, bot, api, restore, evidence }
}
it("rejects legacy private edits at the same revision after actual workspace restoration", async () => {
  const f = fixture(),
    memory = f.store.saveMemory({ botId: f.bot.id, text: "reviewed original" }),
    input = { botId: f.bot.id, id: memory.id, revision: memory.revision, text: "stale edit" }
  f.restore()
  const before = f.evidence()
  await expect(f.api.saveMemory(input)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.evidence()).toBe(before)
})
it("rejects legacy private deletes at the same revision after actual workspace restoration", async () => {
  const f = fixture(),
    memory = f.store.saveMemory({ botId: f.bot.id, text: "reviewed original" }),
    input = { botId: f.bot.id, id: memory.id, revision: memory.revision }
  f.restore()
  const before = f.evidence()
  await expect(f.api.deleteMemory(input)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.evidence()).toBe(before)
})
it("rejects legacy shared edits at identical Bot/item revision after restoration", async () => {
  const f = fixture(),
    address = { botId: f.bot.id, botRevision: f.bot.revision, scope: "user" as const },
    memory = await f.api.saveSharedMemory({
      ...address,
      nonce: "create",
      text: "reviewed original"
    }),
    input = {
      ...address,
      nonce: "edit",
      id: memory.id,
      revision: memory.revision,
      text: "stale edit"
    }
  f.restore()
  const before = f.evidence()
  await expect(f.api.saveSharedMemory(input)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.evidence()).toBe(before)
})
it("rejects legacy shared deletes at identical Bot/item revision after restoration", async () => {
  const f = fixture(),
    address = { botId: f.bot.id, botRevision: f.bot.revision, scope: "user" as const },
    memory = await f.api.saveSharedMemory({
      ...address,
      nonce: "create",
      text: "reviewed original"
    }),
    input = { ...address, nonce: "delete", id: memory.id, revision: memory.revision }
  f.restore()
  const before = f.evidence()
  await expect(f.api.deleteSharedMemory(input)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.evidence()).toBe(before)
})
it("accepts genuinely reread replacement authority and preserves private CAS", () => {
  const f = fixture(),
    old = f.store.saveMemory({ botId: f.bot.id, text: "original" })
  f.restore()
  const input = {
    botId: f.bot.id,
    id: old.id,
    revision: old.revision,
    text: "replacement",
    expectedDataEpoch: f.store.dataEpoch()
  }
  expect(f.store.saveMemory(input)).toMatchObject({ text: "replacement", revision: 2 })
  expect(() => f.store.saveMemory(input)).toThrowError(
    expect.objectContaining({ code: "revision_conflict" })
  )
  f.store.deleteMemory(f.bot.id, old.id, 2, f.store.dataEpoch())
  expect(f.store.memories(f.bot.id)).toEqual([])
})
it("real replacement task lease can remember its own facts without borrowing public authority", () => {
  const f = fixture()
  f.restore()
  const conversation = f.store.snapshot().conversations.find((c) => c.members.includes(f.bot.id))!
  f.store.send({ nonce: "task", conversationId: conversation.id, text: "Remember my preference" })
  const claim = f.store.claim("trusted")!
  expect(
    f.store.saveMemory(
      { botId: f.bot.id, text: "remembered", sourceMessageId: claim.run.messageId },
      { kind: "task", lease: claim.lease }
    )
  ).toMatchObject({ text: "remembered" })
  const other = f.store.createBot({
    nonce: "other",
    name: "Other",
    expectedDataEpoch: f.store.dataEpoch()
  }).bot
  const before = f.evidence()
  expect(() =>
    f.store.saveMemory({ botId: other.id, text: "foreign" }, { kind: "task", lease: claim.lease })
  ).toThrowError(expect.objectContaining({ code: "memory_scope" }))
  expect(f.evidence()).toBe(before)
  f.store.finish(claim.lease, "succeeded", "saved")
  expect(() =>
    f.store.saveMemory({ botId: f.bot.id, text: "late" }, { kind: "task", lease: claim.lease })
  ).toThrowError(expect.objectContaining({ code: "stale_lease" }))
})
it("keeps shared exact accepted receipts readonly after replacement without admitting a different intent", async () => {
  const f = fixture(),
    address = { botId: f.bot.id, botRevision: f.bot.revision, scope: "user" as const },
    input = {
      ...address,
      nonce: "accepted",
      text: "shared",
      expectedDataEpoch: f.store.dataEpoch()
    },
    receipt = await f.store.sharedMemories.save(input)
  f.restore()
  const before = f.evidence()
  expect(await f.store.sharedMemories.save(input)).toEqual(receipt)
  expect(f.evidence()).toBe(before)
  await expect(f.store.sharedMemories.save({ ...input, nonce: "different" })).rejects.toMatchObject(
    { code: "data_epoch" }
  )
  expect(f.evidence()).toBe(before)
})
it("rejects restoration during actual asynchronous project resolution before adding a receipt or memory", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os"),
    root = await mkdtemp(join(tmpdir(), "memory-project-epoch-"))
  try {
    const f = fixture(),
      project = join(root, "project")
    await mkdir(project)
    const bot = f.store.updateBot({
        id: f.bot.id,
        revision: f.bot.revision,
        workspacePath: project
      }),
      input = {
        botId: bot.id,
        botRevision: bot.revision,
        scope: "project" as const,
        nonce: "async",
        text: "stale",
        expectedDataEpoch: f.store.dataEpoch()
      },
      pending = f.store.sharedMemories.save(input)
    f.restore()
    const before = f.evidence()
    await expect(pending).rejects.toMatchObject({ code: "data_epoch" })
    expect(f.evidence()).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it("validates exact private input authority and never exposes trusted source/lease fields to public callers", async () => {
  const f = fixture()
  for (const input of [
    { botId: f.bot.id, text: "fact", expectedDataEpoch: "" },
    { botId: f.bot.id, text: "fact", id: "memory" },
    { botId: f.bot.id, text: "fact", sourceMessageId: "guessed" },
    { botId: f.bot.id, text: "fact", authority: { kind: "task", lease: { runId: "guessed" } } }
  ])
    await expect(f.api.saveMemory(input)).rejects.toThrow()
  expect(f.store.memories(f.bot.id)).toEqual([])
  expect((await f.api.status()).capabilities).toContain("memory-mutation-epoch")
})
it("authenticates the real transport and rejects all four stale memory mutations before effects", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path"),
    { randomBytes } = await import("node:crypto"),
    { BotRpcServer } = await import("./rpc"),
    { BotTransportClient } = await import("./transport-client"),
    { BOT_PROTOCOL_VERSION } = await import("../../shared/bot-types")
  const root = mkdtempSync(join(tmpdir(), "memory-rpc-epoch-")),
    f = fixture(),
    privateMemory = f.store.saveMemory({ botId: f.bot.id, text: "private" }),
    address = { botId: f.bot.id, botRevision: f.bot.revision, scope: "user" as const },
    shared = await f.store.sharedMemories.save({ ...address, nonce: "shared", text: "shared" }),
    token = randomBytes(32).toString("hex"),
    host = new BotHost(f.store),
    server = new BotRpcServer(host, token),
    socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\memory-${token.slice(0, 16)}`
        : join(root, "rpc.sock")
  let client: InstanceType<typeof BotTransportClient> | undefined
  try {
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    f.restore()
    const before = f.evidence()
    await expect(
      client.call("saveMemory", {
        botId: f.bot.id,
        id: privateMemory.id,
        revision: 1,
        text: "wrong",
        expectedDataEpoch: "initial"
      })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("deleteMemory", {
        botId: f.bot.id,
        id: privateMemory.id,
        revision: 1,
        expectedDataEpoch: "initial"
      })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("saveSharedMemory", {
        ...address,
        id: shared.id,
        revision: 1,
        text: "wrong",
        nonce: "edit",
        expectedDataEpoch: "initial"
      })
    ).rejects.toMatchObject({ code: "data_epoch" })
    await expect(
      client.call("deleteSharedMemory", {
        ...address,
        id: shared.id,
        revision: 1,
        nonce: "delete",
        expectedDataEpoch: "initial"
      })
    ).rejects.toMatchObject({ code: "data_epoch" })
    expect(f.evidence()).toBe(before)
  } finally {
    client?.close()
    await server.close()
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
