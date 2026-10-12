import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes, randomUUID } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import {
  inspectBotOwnedShellMaintenance,
  ownedShellMaintenanceOwner
} from "./owned-shell-maintenance-fence"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { executeBotBackup } from "./backups"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `cmb-clone-epoch-${label}-`)))
  await mkdir(join(root, "objects"))
  const seed = new BotStore(join(root, "bots.sqlite"))
  const source = seed.createBot({ nonce: "source", name: "Source", instructions: "Review work" })
  const other = seed.createBot({ nonce: "other", name: "Other" })
  seed.saveMemory({ botId: source.bot.id, text: "Private fact must not enter a clone" })
  seed.close()
  const backup = (await executeBotBackup(root, { action: "create", nonce: randomUUID() })).backup!
  type Live = {
    store: BotStore
    host: BotHost
    client: BotTransportClient
    stopped: Promise<void>
  }
  let live: Live | undefined
  const open = async () => {
    const lock = BotHostLock.acquire(root)!
    const store = new BotStore(join(root, "bots.sqlite"))
    const host = new BotHost(store)
    host.bindOwnership(lock)
    host.bindIdleRestartPreflight((signal) =>
      inspectBotOwnedShellMaintenance(root, ownedShellMaintenanceOwner(lock), signal)
    )
    let done!: () => void, failed!: (failure: unknown) => void
    const stopped = new Promise<void>((resolve, reject) => {
      done = resolve
      failed = reject
    })
    void stopped.catch(() => {})
    const token = randomBytes(32).toString("hex")
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-clone-${token.slice(0, 16)}`
        : join(tmpdir(), `cmb-clone-${token.slice(0, 24)}.sock`)
    const server = new BotRpcServer(host, token, async () => {
      try {
        await server.close()
        await host.stop()
        store.close()
        lock.release()
        done()
      } catch (failure) {
        failed(failure)
      }
    })
    await server.listen(socket)
    const client = new BotTransportClient({
      version: 1,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    live = { store, host, client, stopped }
  }
  const stop = async () => {
    if (!live) return
    const previous = live
    expect((await previous.client.restartIfIdle(previous.host.id)).accepted).toBe(true)
    await previous.stopped
    await previous.client.closeAndWait()
    live = undefined
  }
  const restore = async (selected = backup) => {
    await stop()
    await executeBotBackup(root, {
      action: "restore",
      nonce: randomUUID(),
      backup: { id: selected.id, sha256: selected.sha256 }
    })
    await open()
    expect(live!.store.dataEpoch()).not.toBe("initial")
  }
  await open()
  cleanup.push(async () => {
    const evidence = live
      ? {
          dataEpoch: live.store.dataEpoch(),
          snapshot: live.store.snapshot(),
          receipts: live.store.db.exec("SELECT * FROM bot_receipts ORDER BY nonce")
        }
      : null
    await stop()
    // Keep the physical public-restore database/backup as auditable test evidence.
    await writeFile(
      join(root, "proof.json"),
      JSON.stringify({ root, source, other, backup, evidence }, null, 2) + "\n"
    )
    console.log(JSON.stringify({ fixture: label, retainedRoot: root }))
  })
  const request = { nonce: "clone", id: source.bot.id, revision: source.bot.revision }
  return {
    root,
    source,
    other,
    backup,
    open,
    stop,
    restore,
    request,
    get live() {
      return live!
    }
  }
}
it("the Store refuses an unconsumed legacy clone after actual public restore before any clone row or receipt", async () => {
  const f = await fixture("store-stale")
  await f.restore()
  const before = f.live.store.snapshot()
  expect(() => f.live.store.cloneBot(f.request)).toThrowError(
    expect.objectContaining({ code: "data_epoch" })
  )
  expect(f.live.store.snapshot()).toEqual(before)
  expect(
    f.live.store.db.exec("SELECT nonce FROM bot_receipts WHERE nonce=?", [f.request.nonce])[0]
      .values
  ).toEqual([])
})
it("a replacement authenticated Host rejects the old clone input but accepts only fresh exact scope", async () => {
  const f = await fixture("rpc-stale")
  await f.restore()
  const before = f.live.store.snapshot()
  await expect(f.live.client.call("clone", f.request)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.live.store.snapshot()).toEqual(before)
  const current = { ...f.request, expectedDataEpoch: f.live.store.dataEpoch() }
  const copied = await f.live.client.call("clone", current)
  expect(await f.live.client.call("clone", current)).toEqual(copied)
  expect(f.live.store.snapshot().bots).toHaveLength(3)
  expect(copied.bot.id).not.toBe(f.source.bot.id)
  expect(copied.bot.instructions).toBe("Review work")
  expect(f.live.store.messages(copied.conversationId)).toEqual([])
  expect(f.live.store.memories(copied.bot.id)).toEqual([])
  expect(f.live.store.artifacts(copied.conversationId)).toEqual([])
})
it("original clone fingerprints remain readonly receipts after actual backup restore but not public success authorization", async () => {
  const f = await fixture("legacy-receipt")
  const copied = await f.live.client.call("clone", f.request)
  const originalFingerprint = f.live.store.db.exec(
    "SELECT request_hash FROM bot_receipts WHERE nonce=?",
    [f.request.nonce]
  )
  await f.stop()
  const accepted = (await executeBotBackup(f.root, { action: "create", nonce: randomUUID() }))
    .backup!
  await f.restore(accepted)
  const before = f.live.store.snapshot()
  expect(f.live.store.cloneBot(f.request)).toEqual(copied)
  expect(f.live.store.cloneBot({ ...f.request, expectedDataEpoch: undefined })).toEqual(copied)
  expect(
    f.live.store.db.exec("SELECT request_hash FROM bot_receipts WHERE nonce=?", [f.request.nonce])
  ).toEqual(originalFingerprint)
  expect(f.live.store.snapshot()).toEqual(before)
  await expect(f.live.client.call("clone", f.request)).rejects.toMatchObject({ code: "data_epoch" })
  expect(f.live.store.snapshot()).toEqual(before)
})
it("a scoped clone retains its nonce identity and validates explicit scope without silently ignoring it", async () => {
  const f = await fixture("nonce")
  const current = { ...f.request, expectedDataEpoch: f.live.store.dataEpoch() }
  const copied = f.live.store.cloneBot(current)
  expect(f.live.store.cloneBot(current)).toEqual(copied)
  expect(() => f.live.store.cloneBot({ ...f.request, expectedDataEpoch: undefined })).toThrowError(
    expect.objectContaining({ code: "nonce_conflict" })
  )
  expect(() => f.live.store.cloneBot({ ...current, revision: current.revision + 1 })).toThrowError(
    expect.objectContaining({ code: "nonce_conflict" })
  )
  const before = f.live.store.snapshot()
  for (const expectedDataEpoch of ["", "x".repeat(161), "different-workspace"])
    expect(() =>
      f.live.store.cloneBot({ ...f.request, nonce: "invalid", expectedDataEpoch })
    ).toThrow()
  expect(f.live.store.snapshot()).toEqual(before)
})
