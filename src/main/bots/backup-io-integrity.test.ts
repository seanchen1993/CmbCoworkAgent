import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, utimesSync } from "node:fs"
import { chmod, link, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { hashBackupFile } from "./backup-io"
import { withBackupIoObserver } from "./backup-io-observer"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-backup-integrity-"))),
    path = join(root, "bots.sqlite")
  roots.push(root)
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE evidence(id INTEGER PRIMARY KEY,title TEXT NOT NULL,padding BLOB NOT NULL);
      INSERT INTO evidence VALUES(1,'Original',zeroblob(2097152));`)
  } finally {
    db.close()
  }
  await chmod(path, 0o600)
  const expected = await hashBackupFile(root, "bots.sqlite"),
    initial = await lstat(path, { bigint: true })
  expect(expected.size).toBeGreaterThan(1024 * 1024)
  return { root, path, expected, initial }
}

function duringFirstRead<T>(change: () => void, operation: () => Promise<T>): Promise<T> {
  let changed = false
  const completion = withBackupIoObserver(
    {
      assertCurrent() {
        // The isolated hash fixture has no external cancellation source.
      },
      worked(bytes) {
        if (!bytes || changed) return
        changed = true
        change()
      }
    },
    operation
  )
  return completion.finally(() => expect(changed).toBe(true))
}

// Windows chmod does not provide POSIX group permission or ctime semantics.
const metadataChanges =
  process.platform === "win32" ? (["mtime"] as const) : (["chmod", "mtime"] as const)
it.each(metadataChanges)(
  "retains the original metadata guard for an actual %s during SQLite hashing",
  async (kind) => {
    const f = await fixture()
    const failure = await duringFirstRead(
      () => {
        if (kind === "chmod") chmodSync(f.path, 0o640)
        else
          utimesSync(f.path, Number(f.initial.atimeMs) / 1000, Number(f.initial.mtimeMs) / 1000 + 1)
      },
      () => hashBackupFile(f.root, "bots.sqlite", f.expected)
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      message: "恢复文件校验失败：bots.sqlite",
      cause: {
        code: "bot_backup_file_integrity",
        reason: "metadata",
        phase: "final",
        checks: {
          hardLink: false,
          identity: false,
          ...(process.platform === "win32" ? {} : { ctimeChanged: true }),
          mtimeChanged: kind === "mtime",
          sizeMismatch: false,
          digestMismatch: false
        }
      }
    })
    // The content is unchanged. Rejecting metadata drift remains intentional;
    // the diagnostic does not turn it into a retry or successful restore.
    expect(await hashBackupFile(f.root, "bots.sqlite")).toEqual(f.expected)
    expect(() => structuredClone((failure as Error).cause)).not.toThrow()
  }
)

it("retains the metadata guard when SQLite changes a page that was already hashed", async () => {
  const f = await fixture()
  const failure = await duringFirstRead(
    () => {
      const db = new DatabaseSync(f.path)
      try {
        // Same-length text changes the first page without relocating overflow
        // padding. That first page has already entered the streaming hash.
        db.exec("UPDATE evidence SET title='Changed!' WHERE id=1")
      } finally {
        db.close()
      }
    },
    () => hashBackupFile(f.root, "bots.sqlite", f.expected)
  ).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    message: "恢复文件校验失败：bots.sqlite",
    cause: {
      reason: "metadata",
      phase: "final",
      checks: {
        hardLink: false,
        identity: false,
        ...(process.platform === "win32" ? {} : { ctimeChanged: true }),
        mtimeChanged: true,
        sizeMismatch: false,
        digestMismatch: false
      }
    }
  })
  const actual = await hashBackupFile(f.root, "bots.sqlite")
  expect(actual.size).toBe(f.expected.size)
  expect(actual.sha256).not.toBe(f.expected.sha256)
  expect(JSON.stringify((failure as Error).cause)).not.toMatch(/Original|Changed!|padding/)
})

it("accepts an unchanged SQLite file when a read-only connection opens and closes during hashing", async () => {
  const f = await fixture()
  const actual = await duringFirstRead(
    () => {
      const db = new DatabaseSync(f.path, { readOnly: true })
      try {
        expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok")
      } finally {
        db.close()
      }
    },
    () => hashBackupFile(f.root, "bots.sqlite", f.expected)
  )
  expect(actual).toEqual(f.expected)
})

it("identifies a preexisting hard link without weakening link admission", async () => {
  const f = await fixture()
  await link(f.path, join(f.root, "alias.sqlite"))
  await expect(hashBackupFile(f.root, "bots.sqlite", f.expected)).rejects.toMatchObject({
    message: "恢复文件校验失败：bots.sqlite",
    cause: { reason: "hard-link", phase: "initial", initial: { nlink: "2" } }
  })
})

it.skipIf(process.platform === "win32")(
  "identifies an alias directory without accepting a noncanonical prepared path",
  async () => {
    const f = await fixture(),
      alias = join(f.root, "alias")
    await symlink(f.root, alias, "dir")
    await expect(hashBackupFile(alias, "bots.sqlite", f.expected)).rejects.toMatchObject({
      message: "恢复文件校验失败：bots.sqlite",
      cause: { reason: "identity", phase: "initial" }
    })
  }
)

it("identifies an expected-size mismatch before reading database bytes", async () => {
  const f = await fixture()
  await expect(
    hashBackupFile(f.root, "bots.sqlite", {
      ...f.expected,
      size: f.expected.size + 1
    })
  ).rejects.toMatchObject({
    message: "恢复文件校验失败：bots.sqlite",
    cause: {
      reason: "size",
      phase: "opened",
      expectedSize: f.expected.size + 1
    }
  })
})

it("identifies growth while streaming and retains the original read-size bound", async () => {
  const f = await fixture()
  await expect(
    duringFirstRead(
      () => appendFileSync(f.path, Buffer.alloc(4096)),
      () => hashBackupFile(f.root, "bots.sqlite", f.expected)
    )
  ).rejects.toMatchObject({
    message: "恢复文件校验失败：bots.sqlite",
    cause: { reason: "size", phase: "read", openedSize: f.expected.size }
  })
})

it("identifies a digest mismatch without returning bytes or hashes in its cause", async () => {
  const f = await fixture(),
    wrong = createHash("sha256").update("not this database").digest("hex")
  const failure = await hashBackupFile(f.root, "bots.sqlite", {
    ...f.expected,
    sha256: wrong
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    message: "恢复文件校验失败：bots.sqlite",
    cause: {
      reason: "digest",
      phase: "final",
      checks: { digestMismatch: true }
    }
  })
  const cause = JSON.stringify((failure as Error).cause)
  expect(cause).not.toContain(wrong)
  expect(cause).not.toContain(f.expected.sha256)
  expect(cause).not.toContain(f.root)
})
