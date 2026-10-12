import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { migrateBotMaintenanceJsonReceipts } from "./maintenance-receipts-migration"
import { hashBackupFile, writePrivateJson } from "./backup-io"
const roots: string[] = [],
  hash = "a".repeat(64)
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-receipts-migrate-")))
  roots.push(root)
  return root
}
it.each([1, 2])(
  "migrates prior SQLite schema %s without losing tombstones or operation namespaces",
  async (version) => {
    const root = await fixture(),
      id = randomUUID(),
      initial = new BotMaintenanceReceipts(root)
    initial.retire("backup", id, hash)
    if (version === 2)
      initial.importCompletedOperation(
        "computer",
        id,
        "restore",
        { restore: id },
        { restored: true },
        hash
      )
    initial.close()
    const db = new DatabaseSync(join(root, "maintenance-receipts.sqlite"))
    if (version === 1) db.exec("DROP TABLE operations")
    db.exec(`PRAGMA user_version=${version}`)
    db.close()
    const migrated = new BotMaintenanceReceipts(root)
    try {
      expect(migrated.get("backup", id)).toMatchObject({ state: "deleted", sha256: hash })
      if (version === 2)
        expect(migrated.getOperation("computer", id)).toMatchObject({
          state: "completed",
          result: { restored: true }
        })
      migrated.reserveOperation("computer-delete", id, "delete", hash, { authorized: true })
      migrated.sealOperation("computer-delete", id, hash)
      migrated.completeOperation("computer-delete", id, hash)
      expect(migrated.getOperation("computer-delete", id)).toMatchObject({
        state: "completed",
        action: "delete"
      })
    } finally {
      migrated.close()
    }
  }
)
it("migrates completed JSON nonces and binds a removed JSON to the exact imported identity on restart", async () => {
  const root = await fixture(),
    id = randomUUID(),
    receiptRoot = join(root, "workspace-maintenance", "receipts")
  await mkdir(receiptRoot, { recursive: true })
  const request = { action: "create", nonce: id },
    result = {
      action: "create",
      checkpoint: {
        id,
        sha256: hash,
        createdAt: 1,
        reason: "manual",
        platform: process.platform,
        workspaceId: randomUUID(),
        files: 0,
        bytes: 0
      }
    },
    receipt = { request, result }
  await writePrivateJson(join(receiptRoot, `${id}.json`), receipt)
  // No old checkpoint bytes remain. Import must preserve a tombstone, never
  // treat the old successful create nonce as permission to capture new files.
  const source = await hashBackupFile(receiptRoot, `${id}.json`)
  await migrateBotMaintenanceJsonReceipts(root, () => {})
  const ledger = new BotMaintenanceReceipts(root)
  expect(ledger.get("workspace", id)).toMatchObject({ state: "deleted", sha256: hash })
  ledger.close()
  await expect(readFile(join(receiptRoot, `${id}.json`))).rejects.toMatchObject({ code: "ENOENT" })
  const item = {
    scope: "workspace",
    name: `${id}.json`,
    sha256: source.sha256,
    action: "create",
    id,
    identitySha256: hash
  }
  await writePrivateJson(join(root, "maintenance-receipts-migration.json"), {
    format: 2,
    items: [item]
  })
  await migrateBotMaintenanceJsonReceipts(root, () => {})
  await expect(readFile(join(root, "maintenance-receipts-migration.json"))).rejects.toMatchObject({
    code: "ENOENT"
  })
  await writePrivateJson(join(root, "maintenance-receipts-migration.json"), {
    format: 2,
    items: [{ ...item, identitySha256: "b".repeat(64) }]
  })
  await expect(migrateBotMaintenanceJsonReceipts(root, () => {})).rejects.toThrow("原收据已保留")
  expect(await readFile(join(root, "maintenance-receipts-migration.json"), "utf8")).toContain(
    "b".repeat(64)
  )
})
