import { afterEach, expect, it } from "vitest"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BOT_PROTOCOL_VERSION } from "../../shared/bot-types"

const dispose: (() => void)[] = []
afterEach(() =>
  dispose
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-group-epoch-")),
    path = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite")
  dispose.push(() => rmSync(directory, { recursive: true, force: true }))
  let store = new BotStore(path)
  dispose.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "A" }).bot,
    b = store.createBot({ nonce: "b", name: "B" }).bot,
    group = store.createGroup({
      nonce: "group",
      name: "Group",
      description: "Point",
      members: [a.id, b.id]
    }),
    create = {
      nonce: "create",
      name: "Reviewed new group",
      description: "",
      members: [a.id, b.id]
    },
    update = {
      nonce: "update",
      id: group.id,
      revision: group.revision,
      name: group.name,
      description: "Reviewed change",
      members: group.members
    }
  const checkpoint = () => {
    store.close()
    copyFileSync(path, point)
    store = new BotStore(path)
  }
  const restore = () => {
    store.close()
    copyFileSync(point, path)
    const ledger = new BotDeletionLedger(path)
    try {
      fenceBotCheckpointDatabase(path, "restored", ledger)
    } finally {
      ledger.close()
    }
    store = new BotStore(path)
    return store
  }
  return {
    get store() {
      return store
    },
    directory,
    group,
    create,
    update,
    checkpoint,
    restore
  }
}
const evidence = (store: BotStore) =>
  JSON.stringify([
    store.snapshot(),
    store.db.exec("SELECT * FROM bot_receipts"),
    store.db.exec("SELECT * FROM bot_members"),
    store.db.exec("SELECT * FROM bot_messages"),
    store.db.exec("SELECT * FROM bot_events")
  ])
it.each(["create", "update"] as const)(
  "rejects fresh old or omitted %s scope after a real copied checkpoint restore without consuming a nonce",
  (kind) => {
    const f = fixture()
    f.checkpoint()
    f.store.updateGroup({
      ...f.update,
      nonce: "live",
      description: "Live change"
    })
    const store = f.restore()
    // Group revisions are restored verbatim: CAS alone cannot identify an old window.
    expect(store.getConversation(f.group.id).revision).toBe(f.group.revision)
    const input = f[kind],
      change = (request: typeof input & { expectedDataEpoch?: string }) =>
        kind === "create"
          ? store.createGroup(request)
          : store.updateGroup(request as typeof f.update)
    const before = evidence(store)
    expect(() => change(input)).toThrow(expect.objectContaining({ code: "data_epoch" }))
    expect(() => change({ ...input, expectedDataEpoch: "initial" })).toThrow(
      expect.objectContaining({ code: "data_epoch" })
    )
    expect(evidence(store)).toBe(before)
    const current = { ...input, expectedDataEpoch: "restored" }
    const accepted = change(current),
      committed = evidence(store)
    expect(change(current)).toEqual(accepted)
    expect(evidence(store)).toBe(committed)
  }
)
it.each([false, true])(
  "keeps accepted %s-scoped create and update receipts read-only replayable after restore",
  (scoped) => {
    const f = fixture(),
      epoch = scoped ? { expectedDataEpoch: "initial" } : {},
      create = { ...f.create, ...epoch },
      update = { ...f.update, ...epoch },
      created = f.store.createGroup(create),
      updated = f.store.updateGroup(update)
    f.checkpoint()
    const store = f.restore(),
      before = evidence(store)
    expect(store.createGroup(create)).toEqual(created)
    expect(store.updateGroup(update)).toEqual(updated)
    expect(evidence(store)).toBe(before)
    expect(() => store.updateGroup({ ...update, expectedDataEpoch: "restored" })).toThrow(
      expect.objectContaining({ code: "nonce_conflict" })
    )
  }
)
it("fences a nonce-less legacy update and validates its explicit generation before any write", () => {
  const f = fixture()
  f.checkpoint()
  const store = f.restore(),
    input = { ...f.update, nonce: undefined },
    before = evidence(store)
  expect(() => store.updateGroup(input)).toThrow(expect.objectContaining({ code: "data_epoch" }))
  expect(() => store.updateGroup({ ...input, expectedDataEpoch: "bad\0epoch" })).toThrow(
    expect.objectContaining({ code: "invalid_input" })
  )
  expect(evidence(store)).toBe(before)
  expect(store.updateGroup({ ...input, expectedDataEpoch: "restored" }).description).toBe(
    input.description
  )
})
it("uses the submitted scope on an authenticated replacement Host instead of backfilling current authority", async () => {
  const f = fixture()
  f.checkpoint()
  const store = f.restore(),
    host = new BotHost(store),
    token = randomBytes(32).toString("hex"),
    server = new BotRpcServer(host, token),
    socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-group-epoch-${token.slice(0, 16)}`
        : join(f.directory, "rpc.sock")
  let client: BotTransportClient | undefined
  try {
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    const status = await client.call("status")
    expect(status.capabilities).toContain("mutation-data-epoch")
    const before = evidence(store)
    await expect(client.call("createGroup", f.create)).rejects.toMatchObject({
      code: "data_epoch"
    })
    await expect(
      client.call("updateGroup", { ...f.update, expectedDataEpoch: "initial" })
    ).rejects.toMatchObject({ code: "data_epoch" })
    expect(evidence(store)).toBe(before)
    const request = { ...f.create, expectedDataEpoch: "restored" },
      saved = await client.call("createGroup", request)
    const committed = evidence(store)
    expect(await client.call("createGroup", request)).toEqual(saved)
    expect(evidence(store)).toBe(committed)
  } finally {
    client?.close()
    await server.close()
    await host.stop()
  }
})
