import { afterEach, expect, it } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { renameSync } from "node:fs"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHostLock } from "./host-lock"
import { executeBotBackup, recoverBotRestore } from "./backups"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function interrupted(point: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-restore-integrity-")))
  roots.push(root)
  const store = new BotStore(join(root, "bots.sqlite")),
    files = new BotArtifacts(join(root, "objects"), store),
    bot = store.createBot({ nonce: "owner", name: "Original" }),
    artifact = await files.upload({
      nonce: "artifact",
      conversationId: bot.conversationId,
      name: "evidence.txt",
      mime: "text/plain",
      base64: Buffer.from("safe artifact").toString("base64")
    }),
    session = randomUUID(),
    frame = Buffer.from("safe frame")
  await mkdir(join(root, "teach", session), { recursive: true })
  await writeFile(join(root, "teach", session, "0.jpg"), frame)
  store.db.run(
    "INSERT INTO bot_teach_sessions(id,bot_id,conversation_id,nonce,phase,started_at) VALUES(?,?,?,?,'ready',1)",
    [session, bot.bot.id, bot.conversationId, "teach"]
  )
  store.db.run("INSERT INTO bot_teach_frames VALUES(?,0,1,?,?,?,?)", [
    session,
    createHash("sha256").update(frame).digest("hex"),
    frame.length,
    "https://example.test",
    "Evidence"
  ])
  await files.close()
  store.close()
  const backup = (await executeBotBackup(root, { action: "create", nonce: randomUUID() })).backup!
  const live = new BotStore(join(root, "bots.sqlite"))
  live.createBot({ nonce: "later", name: "Retained" })
  live.close()
  const original = await readFile(join(root, "bots.sqlite")),
    request = {
      action: "restore" as const,
      nonce: randomUUID(),
      backup: { id: backup.id, sha256: backup.sha256 }
    }
  await expect(
    executeBotBackup(root, request, (name) => {
      if (name === point) throw new Error("interrupted")
    })
  ).rejects.toThrow("interrupted")
  const journalPath = join(root, "restore.json"),
    journalBytes = await readFile(journalPath),
    journal = JSON.parse(journalBytes.toString()) as { format: number; stage: string }
  return {
    root,
    request,
    original,
    journal,
    journalPath,
    journalBytes,
    stage: join(root, `.restore-${journal.stage}`),
    object: `objects/${artifact.sha256}`,
    frame: `teach/${session}/0.jpg`
  }
}

async function resume(root: string) {
  const lock = BotHostLock.acquire(root)!
  try {
    await recoverBotRestore(root, undefined, () => lock.assertCurrent())
  } finally {
    lock.release()
  }
}

it.each([
  ["old:bots.sqlite", "database"],
  ["next:bots.sqlite", "database"],
  ["old:bots.sqlite", "object"],
  ["next:objects", "object"],
  ["old:bots.sqlite", "frame"],
  ["next:teach", "frame"]
])(
  "rejects changed prepared %s / %s and preserves the original and journal",
  async (point, kind) => {
    const f = await interrupted(point),
      relative = kind === "database" ? "bots.sqlite" : kind === "object" ? f.object : f.frame,
      next = join(f.stage, "next", relative)
    let target = next
    try {
      await readFile(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      target = join(f.root, relative)
    }
    if (kind === "database") {
      // The altered database remains valid SQLite: quick_check alone cannot detect this.
      const db = new DatabaseSync(target)
      try {
        db.exec("UPDATE bots SET name='Tampered'")
        expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok")
      } finally {
        db.close()
      }
    } else await writeFile(target, kind === "object" ? "evil artifact" : "evil frame")
    await expect(resume(f.root)).rejects.toThrow("校验")
    expect((await readFile(f.journalPath)).equals(f.journalBytes)).toBe(true)
    expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
    await expect(readFile(join(f.root, "restore-completed.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  }
)

it("rejects an unmanifested SQLite sidecar in prepared next before making further moves", async () => {
  const f = await interrupted("old:bots.sqlite")
  await writeFile(join(f.stage, "next", "bots.sqlite-wal"), "unowned WAL")
  await expect(resume(f.root)).rejects.toThrow("校验")
  expect((await readFile(f.journalPath)).equals(f.journalBytes)).toBe(true)
  expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
})

it.skipIf(process.platform === "win32")(
  "stops a resumed restore when the held lock inode is replaced between moves",
  async () => {
    const f = await interrupted("old:bots.sqlite"),
      lock = BotHostLock.acquire(f.root)!
    try {
      await expect(
        recoverBotRestore(
          f.root,
          (move) => {
            if (move === "next:bots.sqlite") {
              renameSync(join(f.root, "host-lock.sqlite"), join(f.root, "old-owner-lock.sqlite"))
              const replacement = BotHostLock.acquire(f.root)!
              replacement.release()
            }
          },
          () => lock.assertCurrent()
        )
      ).rejects.toMatchObject({ code: "host_ownership_lost" })
      expect((await readFile(f.journalPath)).equals(f.journalBytes)).toBe(true)
      expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
      await expect(readFile(join(f.stage, "old", f.object))).rejects.toMatchObject({
        code: "ENOENT"
      })
    } finally {
      lock.release()
    }
  }
)

it.each(["objects/" + "f".repeat(64), "teach/" + randomUUID() + "/0.jpg"])(
  "rejects unmanifested prepared file %s before making further moves",
  async (relative) => {
    const f = await interrupted("old:bots.sqlite")
    const path = join(f.stage, "next", relative)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "unowned bytes")
    await expect(resume(f.root)).rejects.toThrow("校验")
    expect((await readFile(f.journalPath)).equals(f.journalBytes)).toBe(true)
    expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
    await expect(readFile(join(f.root, "bots.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
  }
)

it("refuses a legacy pending journal without prepared digests and preserves displaced originals", async () => {
  const f = await interrupted("next:objects"),
    legacy = { ...JSON.parse(f.journalBytes.toString()), format: 1 }
  delete legacy.preparedSha256
  const bytes = JSON.stringify(legacy)
  await writeFile(f.journalPath, bytes)
  await expect(resume(f.root)).rejects.toThrow("旧版恢复日志")
  expect(await readFile(f.journalPath, "utf8")).toBe(bytes)
  expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
})

it("keeps legacy completed and orphaned displaced originals instead of treating them as disposable staging", async () => {
  const f = await interrupted("next:objects"),
    legacy = { ...JSON.parse(f.journalBytes.toString()), format: 1 }
  delete legacy.preparedSha256
  await rm(f.journalPath)
  await writeFile(join(f.root, "restore-completed.json"), JSON.stringify(legacy))
  await resume(f.root)
  expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
  await rm(join(f.root, "restore-completed.json"))
  await resume(f.root)
  expect((await readFile(join(f.stage, "old", "bots.sqlite"))).equals(f.original)).toBe(true)
})
