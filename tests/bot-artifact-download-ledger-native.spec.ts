import { randomUUID, createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DesktopArtifactDownloadLedger,
  downloadRecordSchema,
  type DownloadRecord
} from "../src/main/bots/desktop-artifact-download-ledger"
import {
  BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES,
  botArtifactDownloadJobSchema
} from "../src/shared/bot-artifact-downloads"
import { BotDomainError } from "../src/shared/bot-types"
const roots: string[] = []
process.once("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
function path() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cmb-download-ledger-")))
  roots.push(root)
  return join(root, "downloads.sqlite")
}
function record(): DownloadRecord {
  const id = randomUUID(),
    sha = createHash("sha256").digest("hex")
  return {
    prefixHash: sha,
    job: {
      id,
      revision: 1,
      state: "choosing",
      name: "result.txt",
      mime: "text/plain",
      bytes: 0,
      total: 0,
      createdAt: 1,
      updatedAt: 1,
      source: {
        artifactId: "a",
        conversationId: "c",
        size: 0,
        sha256: sha,
        dataEpoch: "e"
      }
    }
  }
}
const rejected = (error: unknown) =>
  error instanceof BotDomainError &&
  ["download_request_rejected", "download_capacity", "download_ledger_unavailable"].includes(
    error.code
  )
test("existing oversized DB and journal rejected before native open", () => {
  for (const suffix of ["", "-journal"]) {
    const target = path()
    writeFileSync(target + suffix, Buffer.alloc(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES + 65537))
    assert.throws(() => new DesktopArtifactDownloadLedger(target), rejected)
  }
})
test("DB and each sidecar reject symlink and multiple hardlinks", () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    for (const kind of ["symlink", "hardlink"]) {
      const target = path(),
        other = target + ".other"
      writeFileSync(other, "")
      if (kind === "symlink") symlinkSync(other, target + suffix)
      else linkSync(other, target + suffix)
      assert.throws(() => new DesktopArtifactDownloadLedger(target), rejected)
    }
})
test("existing user version and table schema validated; every constructor error closes native handle", () => {
  const original = DatabaseSync.prototype.close
  let closes = 0
  DatabaseSync.prototype.close = function () {
    closes++
    return original.call(this)
  }
  try {
    for (const sql of [
      "PRAGMA user_version=2",
      "CREATE TABLE alien(x TEXT)",
      "CREATE TABLE download_jobs(id TEXT PRIMARY KEY);CREATE TABLE download_receipts(id TEXT PRIMARY KEY);PRAGMA user_version=1"
    ]) {
      const target = path(),
        db = new DatabaseSync(target)
      db.exec(sql)
      db.close()
      const before = closes
      assert.throws(() => new DesktopArtifactDownloadLedger(target), rejected)
      assert.equal(closes, before + 1)
    }
  } finally {
    DatabaseSync.prototype.close = original
  }
})
test("SQLite page cap follows real 8192-byte page size", () => {
  const target = path(),
    db = new DatabaseSync(target)
  db.exec("PRAGMA page_size=8192;VACUUM")
  db.close()
  const ledger = new DesktopArtifactDownloadLedger(target),
    internal: unknown = Reflect.get(ledger, "db")
  assert.ok(internal instanceof DatabaseSync)
  try {
    assert.equal(internal.prepare("PRAGMA page_size").get()?.page_size, 8192)
    assert.equal(
      internal.prepare("PRAGMA max_page_count").get()?.max_page_count,
      Math.floor(BOT_ARTIFACT_DOWNLOAD_LEDGER_BYTES / 8192)
    )
    ledger.admit(record())
  } finally {
    ledger.close()
  }
})
test("valid JSON cannot substitute mismatched job identity or missing receipt", () => {
  for (const field of ["id", "revision", "state", "conversation", "receipt"]) {
    const target = path(),
      ledger = new DesktopArtifactDownloadLedger(target),
      saved = record()
    ledger.admit(saved)
    ledger.close()
    const db = new DatabaseSync(target)
    if (field === "receipt")
      db.prepare("DELETE FROM download_receipts WHERE id=?").run(saved.job.id)
    else if (field === "revision")
      db.prepare("UPDATE download_jobs SET revision=2 WHERE id=?").run(saved.job.id)
    else
      db.prepare(`UPDATE download_jobs SET ${field}=? WHERE id=?`).run(
        field === "id" ? randomUUID() : "different",
        saved.job.id
      )
    db.close()
    const reopened = new DesktopArtifactDownloadLedger(target)
    try {
      assert.throws(() => reopened.list(), rejected)
    } finally {
      reopened.close()
    }
  }
})
test("runtime DB replacement or hardlink rejects prior owner before read/write", () => {
  const target = path(),
    ledger = new DesktopArtifactDownloadLedger(target)
  try {
    linkSync(target, target + ".alias")
    assert.throws(() => ledger.list(), rejected)
  } finally {
    ledger.close()
  }
})
test("shared completed packet requires exact declared bytes", () => {
  const value = record().job
  assert.equal(
    botArtifactDownloadJobSchema.safeParse({
      ...value,
      total: 2,
      bytes: 1,
      state: "completed",
      source: { ...value.source, size: 2 }
    }).success,
    false
  )
})

test("private stage receipt cannot point outside its nonce-owned sibling or forge publication identity", () => {
  const saved = record(),
    parent = join(tmpdir(), "save-parent"),
    target = {
      path: join(parent, "result.txt"),
      parent,
      parentDevice: "1",
      parentInode: "2"
    },
    identity = {
      device: "1",
      inode: "3",
      size: "0",
      modified: "0",
      changed: "0"
    }
  assert.equal(
    downloadRecordSchema.safeParse({
      ...saved,
      target,
      stage: { path: join(tmpdir(), "outside"), identity }
    }).success,
    false
  )
  assert.equal(
    downloadRecordSchema.safeParse({
      ...saved,
      target,
      stage: {
        path: join(parent, `.CMBDevClaw-save-${saved.job.id}.part`),
        identity
      },
      intent: {
        identity: { ...identity, inode: "4" },
        sha256: saved.job.source.sha256
      }
    }).success,
    false
  )
})

test("unexpected competing SQLite writer never blocks Main for a busy timeout", () => {
  const target = path(),
    ledger = new DesktopArtifactDownloadLedger(target),
    other = new DatabaseSync(target)
  try {
    other.exec("BEGIN IMMEDIATE")
    const now = performance.now()
    assert.throws(() => ledger.admit(record()))
    assert.ok(performance.now() - now < 200)
  } finally {
    other.exec("ROLLBACK")
    other.close()
    ledger.close()
  }
})
