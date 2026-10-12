import { afterEach, expect, it, vi } from "vitest"
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { guardBotRpcMutationEpoch } from "./rpc-mutation-epoch"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function directory() {
  const evidence = process.env.CMB_DELETE_EPOCH_EVIDENCE
  if (evidence) mkdirSync(evidence, { recursive: true })
  const root = mkdtempSync(join(evidence ?? tmpdir(), "cmb-delete-epoch-"))
  if (!evidence) cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function replace(path: string, restored: string, epoch = "replacement") {
  copyFileSync(path, restored)
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(restored, epoch, ledger)
  } finally {
    ledger.close()
  }
}
async function connection(path: string, root: string) {
  const store = new BotStore(path),
    host = new BotHost(store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token),
    socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-delete-${token.slice(0, 16)}`
        : join(root, "rpc.sock")
  await server.listen(socketPath)
  const client = new BotTransportClient({
    version: BOT_PROTOCOL_VERSION,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    client.close()
    await server.close()
    await host.stop()
    store.close()
  }
  cleanup.push(close)
  return { store, host, server, client, close }
}
function events(store: BotStore) {
  return JSON.stringify(store.db.exec("SELECT * FROM bot_events ORDER BY cursor"))
}

it("two authenticated Host generations reject the captured delete for an identical replacement Bot", async () => {
  const root = directory(),
    path = join(root, "original.sqlite"),
    restored = join(root, "replacement.sqlite"),
    original = await connection(path, root),
    created = await original.client.call("create", { nonce: "bot", name: "Original" }),
    snapshot = await original.client.call("snapshot"),
    captured = {
      id: created.bot.id,
      revision: created.bot.revision,
      expectedDataEpoch: snapshot.dataEpoch
    },
    originalHostId = original.host.id
  await original.close()
  replace(path, restored)
  const next = await connection(restored, root),
    current = await next.client.call("snapshot"),
    before = events(next.store)
  expect(next.host.id).not.toBe(originalHostId)
  expect(current.dataEpoch).toBe("replacement")
  expect(current.bots[0]).toMatchObject({ id: captured.id, revision: captured.revision })
  await expect(next.client.call("delete", captured)).rejects.toMatchObject({ code: "data_epoch" })
  await expect(
    next.client.call("delete", { id: captured.id, revision: captured.revision })
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(events(next.store)).toBe(before)
  expect(next.store.getBot(captured.id).deletedAt).toBeNull()
  const fresh = { ...captured, expectedDataEpoch: current.dataEpoch }
  await next.client.call("delete", fresh)
  const once = events(next.store)
  await next.client.call("delete", fresh)
  expect(events(next.store)).toBe(once)
  expect(next.store.getBot(captured.id, true).deletedAt).not.toBeNull()
  writeFileSync(
    join(root, "receipts.json"),
    JSON.stringify(
      {
        originalHostId,
        replacementHostId: next.host.id,
        captured,
        fresh,
        oldAdmissionsRejected: 2,
        freshDeleteAndExactRetryAccepted: true,
        scope: "two Host objects in one Node process; source SQLite and authenticated socket"
      },
      null,
      2
    )
  )
})

it("Store checks replacement epoch inside its deletion transaction before all writes", () => {
  const root = directory(),
    path = join(root, "original.sqlite"),
    restored = join(root, "replacement.sqlite")
  const original = new BotStore(path),
    created = original.createBot({ nonce: "bot", name: "Original" })
  original.close()
  replace(path, restored)
  const store = new BotStore(restored)
  cleanup.push(() => store.close())
  const before = events(store)
  expect(() => store.deleteBot(created.bot.id, created.bot.revision, "initial")).toThrow(
    "工作区数据已恢复"
  )
  expect(() => store.deleteBot(created.bot.id, created.bot.revision)).toThrow("工作区数据已恢复")
  expect(events(store)).toBe(before)
  expect(store.getBot(created.bot.id).deletedAt).toBeNull()
  store.deleteBot(created.bot.id, created.bot.revision, store.dataEpoch())
  expect(store.getBot(created.bot.id, true).deletedAt).not.toBeNull()
})

it("a restored original deletion remains evidence and cannot authorize a stale RPC acknowledgement", async () => {
  const root = directory(),
    path = join(root, "original.sqlite"),
    point = join(root, "point.sqlite"),
    restored = join(root, "replacement.sqlite")
  const original = new BotStore(path),
    created = original.createBot({ nonce: "bot", name: "Original" })
  original.close()
  copyFileSync(path, point)
  const live = new BotStore(path)
  live.deleteBot(created.bot.id, created.bot.revision)
  live.close()
  copyFileSync(point, restored)
  const ledger = new BotDeletionLedger(path)
  try {
    fenceBotCheckpointDatabase(restored, "replacement", ledger)
  } finally {
    ledger.close()
  }
  const current = await connection(restored, root),
    before = events(current.store),
    captured = { id: created.bot.id, revision: created.bot.revision, expectedDataEpoch: "initial" }
  expect(current.store.getBot(created.bot.id, true).deletedAt).not.toBeNull()
  await expect(current.client.call("delete", captured)).rejects.toMatchObject({
    code: "data_epoch"
  })
  expect(() => current.store.deleteBot(created.bot.id, created.bot.revision, "initial")).toThrow(
    "工作区数据已恢复"
  )
  expect(events(current.store)).toBe(before)
})

it("legacy two-field delete remains compatible only in the original workspace", async () => {
  const root = directory(),
    current = await connection(join(root, "initial.sqlite"), root),
    created = await current.client.call("create", { nonce: "bot", name: "Original" })
  expect((await current.client.call("status")).capabilities).toContain("bot-delete-epoch")
  const request = { id: created.bot.id, revision: created.bot.revision }
  await current.client.call("delete", request)
  const once = events(current.store)
  await current.client.call("delete", request)
  expect(events(current.store)).toBe(once)
  await expect(
    current.client.call("delete", { ...request, revision: request.revision + 1 })
  ).rejects.toMatchObject({ code: "revision_conflict" })
  expect(events(current.store)).toBe(once)
})

it("delete captures admission epoch across asynchronous resource cleanup", async () => {
  let epoch = "original"
  const input = { id: "bot", revision: 1, expectedDataEpoch: "original" },
    execute = vi.fn(async () => {
      input.expectedDataEpoch = epoch = "replacement"
      return undefined
    })
  await expect(
    guardBotRpcMutationEpoch("delete", input, () => epoch, execute)
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(execute).toHaveBeenCalledOnce()
  const stale = vi.fn(async () => undefined)
  await expect(
    guardBotRpcMutationEpoch("delete", { expectedDataEpoch: "original" }, () => epoch, stale)
  ).rejects.toMatchObject({ code: "data_epoch" })
  expect(stale).not.toHaveBeenCalled()
})

it("malformed delete scope rejects before mutation", async () => {
  const root = directory(),
    current = await connection(join(root, "initial.sqlite"), root),
    created = await current.client.call("create", { nonce: "bot", name: "Original" }),
    before = events(current.store)
  await expect(
    current.client.call("delete", {
      id: created.bot.id,
      revision: created.bot.revision,
      expectedDataEpoch: 123 as unknown as string
    })
  ).rejects.toMatchObject({ code: "invalid_input" })
  expect(events(current.store)).toBe(before)
  expect(current.store.getBot(created.bot.id).deletedAt).toBeNull()
})
