import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import * as backupIO from "./backup-io"
import { executeBotBackup, listBotBackups } from "./backups"
import { executeBotBrowserMaintenance, listBotBrowserCheckpoints } from "./browser-maintenance"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-maintenance-receipts-")))
  roots.push(root)
  const store = new BotStore(join(root, "bots.sqlite"))
  store.createBot({ nonce: "create", name: "Receipt recovery" })
  store.close()
  await mkdir(join(root, "browser-profile", "Default"), { recursive: true })
  await writeFile(join(root, "browser-profile", "Default", "Preferences"), "before")
  return root
}

for (const kind of ["backup", "browser"] as const) {
  const execute = async (root: string, input: { action: "create"; nonce: string }) => {
    if (kind === "backup") return (await executeBotBackup(root, input)).backup!
    return (await executeBotBrowserMaintenance(root, input)).checkpoint!
  }
  const remove = async (root: string, value: { id: string; sha256: string }) => {
    const selected = { id: value.id, sha256: value.sha256 }
    if (kind === "backup") await executeBotBackup(root, { action: "delete", backup: selected })
    else await executeBotBrowserMaintenance(root, { action: "delete", checkpoint: selected })
  }
  const list = (root: string) =>
    kind === "backup" ? listBotBackups(root) : listBotBrowserCheckpoints(root)
  const snapshotPath = (root: string, id: string) =>
    join(root, kind === "backup" ? "backups/snapshots" : "browser-maintenance/checkpoints", id)

  it(`${kind}: a create reply lost before deletion cannot recreate the deleted snapshot`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const first = await execute(root, request)
    await remove(root, first)
    await remove(root, first)
    await writeFile(join(root, "browser-profile", "Default", "Preferences"), "after")
    await expect(execute(root, request)).rejects.toThrow("已删除")
    expect(await list(root)).toEqual([])
    await expect(remove(root, { ...first, sha256: "0".repeat(64) })).rejects.toThrow("变化")
  })

  it(`${kind}: a published snapshot retains its original sealed result across owner reopen`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const first = await execute(root, request)
    await writeFile(join(root, "browser-profile", "Default", "Preferences"), "after")
    expect(await execute(root, request)).toEqual(first)
    expect(await list(root)).toEqual([first])
  })

  it(`${kind}: deletion of a legacy snapshot persists its identity before removing the bytes`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const first = await execute(root, request)
    await rm(join(root, "maintenance-receipts.sqlite"), { force: true })
    await remove(root, first)
    await expect(execute(root, request)).rejects.toThrow("已删除")
    expect(await readFile(join(root, "maintenance-receipts.sqlite"))).not.toHaveLength(0)
  })

  it(`${kind}: a crash after sealed publication recovers a reserved receipt without taking a new snapshot`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    vi.spyOn(BotMaintenanceReceipts.prototype, "publish").mockImplementationOnce(() => {
      throw new Error("publication receipt interrupted")
    })
    await expect(execute(root, request)).rejects.toThrow("interrupted")
    const original = (await list(root))[0]
    const receipts = BotMaintenanceReceipts.readOnly(root)!
    try {
      expect(receipts.get(kind, request.nonce)?.state).toBe("reserved")
    } finally {
      receipts.close()
    }
    await writeFile(join(root, "browser-profile", "Default", "Preferences"), "new state")
    expect(await execute(root, request)).toEqual(original)
  })

  it(`${kind}: a crash after delete intent recovers a partially removed directory even without its manifest`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const first = await execute(root, request),
      originalRetire = BotMaintenanceReceipts.prototype.retire
    vi.spyOn(BotMaintenanceReceipts.prototype, "retire").mockImplementationOnce(function (
      this: BotMaintenanceReceipts,
      ...args: Parameters<BotMaintenanceReceipts["retire"]>
    ) {
      originalRetire.apply(this, args)
      throw new Error("delete intent interrupted")
    })
    await expect(remove(root, first)).rejects.toThrow("interrupted")
    await rm(join(snapshotPath(root, first.id), "manifest.json"))
    expect(await list(root)).toEqual([])
    await remove(root, first)
    await expect(
      readFile(join(snapshotPath(root, first.id), "manifest.json"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    })
    await expect(execute(root, request)).rejects.toThrow("已删除")
  })

  it(`${kind}: a missing published snapshot cannot silently acquire new bytes under the same nonce`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const first = await execute(root, request)
    await rm(snapshotPath(root, first.id), { recursive: true })
    await expect(execute(root, request)).rejects.toThrow("已丢失")
    expect(await list(root)).toEqual([])
  })

  it(`${kind}: a pre-publication interruption keeps the same nonce retryable`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    const receipts = new BotMaintenanceReceipts(root)
    receipts.reserve(kind, request.nonce, "manual")
    receipts.close()
    const first = await execute(root, request)
    expect(await execute(root, request)).toEqual(first)
    const reopened = BotMaintenanceReceipts.readOnly(root)!
    try {
      expect(reopened.get(kind, request.nonce)).toMatchObject({
        state: "published",
        sha256: first.sha256
      })
    } finally {
      reopened.close()
    }
  })

  it(`${kind}: normal failure before publication releases its reservation and the same request remains retryable`, async () => {
    const root = await fixture(),
      request = { action: "create" as const, nonce: randomUUID() }
    // DB capture now hashes its prepared file directly instead of making a
    // second full-size copy; both owners still release a failed reservation.
    vi.spyOn(
      backupIO,
      kind === "backup" ? "hashBackupFile" : "copyBackupFile"
    ).mockRejectedValueOnce(new Error("copy interrupted"))
    await expect(execute(root, request)).rejects.toThrow("copy interrupted")
    expect(await list(root)).toEqual([])
    const receipts = BotMaintenanceReceipts.readOnly(root)!
    try {
      expect(receipts.get(kind, request.nonce)).toBeUndefined()
    } finally {
      receipts.close()
    }
    const completed = await execute(root, request)
    expect(await execute(root, request)).toEqual(completed)
  })
}
