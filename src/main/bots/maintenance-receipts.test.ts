import { afterEach, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { link, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BOT_MAINTENANCE_RECEIPT_BYTES, BotMaintenanceReceipts } from "./maintenance-receipts"

const roots: string[] = [],
  hash = "a".repeat(64)
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-maintenance-ledger-")))
  roots.push(root)
  return { root, path: join(root, "maintenance-receipts.sqlite") }
}

it("keeps request namespaces independent, releases only unpublished reservations and preserves monotonic tombstones across reopen", async () => {
  const { root } = await fixture(),
    id = randomUUID()
  const first = new BotMaintenanceReceipts(root)
  first.reserve("backup", id, "manual")
  first.reserve("browser", id, "manual")
  first.releaseReservation("browser", id)
  expect(first.get("browser", id)).toBeUndefined()
  first.close()
  const reopened = new BotMaintenanceReceipts(root)
  try {
    expect(reopened.get("backup", id)?.state).toBe("reserved")
    reopened.publish("backup", id, "manual", hash)
    reopened.releaseReservation("backup", id)
    expect(reopened.get("backup", id)?.state).toBe("published")
    expect(() => reopened.publish("backup", id, "manual", "b".repeat(64))).toThrow("变化")
    reopened.retire("backup", id, hash)
    reopened.releaseReservation("backup", id)
    reopened.retire("backup", id.toUpperCase(), hash)
    expect(() => reopened.reserve("backup", id, "manual")).toThrow("已删除")
    expect(() => reopened.retire("backup", id, "0".repeat(64))).toThrow("变化")
    reopened.publish("browser", id, "manual", hash)
  } finally {
    reopened.close()
  }
  const reader = BotMaintenanceReceipts.readOnly(root)!
  try {
    expect(reader.get("backup", id)?.state).toBe("deleted")
    expect(reader.get("browser", id)?.state).toBe("published")
    expect(() => reader.retire("browser", id, hash)).toThrow("记录")
  } finally {
    reader.close()
  }
})

it("allows the owner to finish initialization after a crash immediately following file creation", async () => {
  const { root, path } = await fixture(),
    id = randomUUID()
  await writeFile(path, "")
  const reader = BotMaintenanceReceipts.readOnly(root)!
  expect(reader.get("backup", id)).toBeUndefined()
  reader.close()
  const owner = new BotMaintenanceReceipts(root)
  try {
    owner.reserve("backup", id, "manual")
    expect(owner.get("backup", id)?.state).toBe("reserved")
  } finally {
    owner.close()
  }
})

it("rejects replaced files and linked database or journal paths without changing foreign bytes", async () => {
  const { root, path } = await fixture(),
    id = randomUUID()
  const owner = new BotMaintenanceReceipts(root)
  owner.publish("backup", id, "manual", hash)
  await rename(path, path + ".original")
  await writeFile(path, "unrelated bytes")
  expect(() => owner.get("backup", id)).toThrow("记录")
  owner.close()
  await rm(path)
  await link(path + ".original", path)
  const original = await readFile(path + ".original")
  expect(() => new BotMaintenanceReceipts(root)).toThrow("记录")
  expect((await readFile(path + ".original")).equals(original)).toBe(true)
  await rm(path)
  await rename(path + ".original", path)
  const foreign = join(root, "foreign")
  await writeFile(foreign, "foreign journal bytes")
  await link(foreign, path + "-journal")
  expect(() => new BotMaintenanceReceipts(root)).toThrow("记录")
  expect(await readFile(foreign, "utf8")).toBe("foreign journal bytes")
})

it("fails closed at the durable eight MiB capacity while retaining every previous tombstone", async () => {
  const { root, path } = await fixture(),
    retired = "00000000-0000-4000-8000-000000000000",
    reserved = randomUUID(),
    future = "ffffffff-ffff-4fff-bfff-ffffffffffff"
  const seed = new BotMaintenanceReceipts(root)
  seed.retire("backup", retired, hash)
  seed.reserve("backup", reserved, "manual")
  seed.close()
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
  const pages =
    BOT_MAINTENANCE_RECEIPT_BYTES / Number(db.prepare("PRAGMA page_size").get()!.page_size)
  db.exec(`PRAGMA max_page_count=${pages}`)
  const insert = db.prepare("INSERT INTO receipts VALUES('backup',?,'manual',12,?)")
  let sequence = 1,
    last = sequence,
    full = false
  while (!full) {
    last = sequence
    db.exec("BEGIN IMMEDIATE")
    try {
      for (let i = 0; i < 500; i++, sequence++)
        insert.run(`00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`, hash)
      db.exec("COMMIT")
    } catch {
      if (db.isTransaction) db.exec("ROLLBACK")
      full = true
    }
  }
  for (sequence = last; ; sequence++) {
    try {
      insert.run(`00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`, hash)
    } catch {
      break
    }
  }
  db.close()
  expect((await lstat(path)).size).toBeLessThanOrEqual(BOT_MAINTENANCE_RECEIPT_BYTES)
  const owner = new BotMaintenanceReceipts(root)
  try {
    expect(owner.get("backup", retired)).toMatchObject({ state: "deleted", sha256: hash })
    expect(() => owner.reserve("backup", future, "manual")).toThrow("记录")
    expect(() => owner.retire("backup", future, hash)).toThrow("记录")
    expect(() => owner.publish("backup", reserved, "manual", hash)).not.toThrow()
    expect(() => owner.retire("backup", reserved, hash)).not.toThrow()
    expect(owner.get("backup", reserved)?.state).toBe("deleted")
    expect(owner.get("backup", retired)?.state).toBe("deleted")
    expect(owner.get("backup", future)).toBeUndefined()
  } finally {
    owner.close()
  }
}, 20_000)

it("migrates a real version-3 ledger atomically and reserves bounded Windows results before privilege effects", async () => {
  const { root, path } = await fixture(),
    id = randomUUID(),
    old = new BotMaintenanceReceipts(root)
  old.publish("backup", id, "manual", hash)
  old.close()
  const db = new DatabaseSync(path)
  db.exec(`BEGIN IMMEDIATE; ALTER TABLE operations RENAME TO obsolete;
 CREATE TABLE operations(scope TEXT NOT NULL CHECK(scope IN ('workspace','browser','computer','recovery','computer-delete')),id TEXT NOT NULL CHECK(length(id)=36),action TEXT NOT NULL CHECK(action IN ('restore','reset','delete-recovery','delete')),state INTEGER NOT NULL CHECK(state IN(32,33,34)),request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),journal_sha256 TEXT NOT NULL CHECK(length(journal_sha256)=64),result TEXT NOT NULL CHECK(length(CAST(result AS BLOB))<=8192),PRIMARY KEY(scope,id)) WITHOUT ROWID;
 DROP TABLE obsolete; PRAGMA user_version=3; COMMIT;`)
  db.close()
  const ledger = new BotMaintenanceReceipts(root),
    nonce = randomUUID(),
    request = { nonce, scope: hash },
    result = {
      nonce,
      success: true,
      definitive: true,
      status: { state: "initialized", scope: hash, message: "完成" }
    }
  try {
    expect(ledger.get("backup", id)?.state).toBe("published")
    ledger.reserveOperation(
      "windows-setup",
      nonce,
      "setup",
      BotMaintenanceReceipts.requestHash(request),
      { reserved: true, padding: " ".repeat(7168) }
    )
    ledger.sealOperation("windows-setup", nonce, hash)
    ledger.completeOperation("windows-setup", nonce, hash, result)
    expect(ledger.getOperation("windows-setup", nonce)).toMatchObject({
      state: "completed",
      result
    })
    expect(() => ledger.completeOperation("windows-setup", nonce, hash, result)).not.toThrow()
    expect(() =>
      ledger.completeOperation("windows-setup", nonce, hash, { ...result, extra: "x" })
    ).toThrow()
    const small = randomUUID()
    ledger.reserveOperation("windows-setup", small, "setup", hash, { small: true })
    ledger.sealOperation("windows-setup", small, hash)
    expect(() => ledger.completeOperation("windows-setup", small, hash, result)).toThrow("记录")
    expect(ledger.getOperation("windows-setup", small)?.state).toBe("sealed")
  } finally {
    ledger.close()
  }
  const verify = new DatabaseSync(path, { readOnly: true })
  expect(verify.prepare("PRAGMA user_version").get()?.user_version).toBe(4)
  verify.close()
})
