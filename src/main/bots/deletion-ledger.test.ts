import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, renameSync, linkSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotDeletionLedger } from "./deletion-ledger"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bot-deletions-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    store = new BotStore(path)
  const { bot } = store.createBot({ nonce: "bot", name: "Deletion test" })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "Review",
    prompt: "Inspect",
    schedule: { kind: "interval", everyMs: 60_000, anchor: Date.now() },
    timezone: "UTC",
    enabled: false
  })
  return {
    path,
    store,
    bot,
    routine,
    remove: { botId: bot.id, id: routine.id, revision: routine.revision, nonce: "remove" }
  }
}
function records(path: string) {
  const db = new DatabaseSync(`${path}.deletions`, { readOnly: true })
  try {
    return db.prepare("SELECT kind,key,owner FROM deletions").all()
  } finally {
    db.close()
  }
}

it("does not export rolled-back deletion intents or store the removed content", () => {
  const f = fixture()
  try {
    const memory = f.store.saveMemory({ botId: f.bot.id, text: "PRIVATE_REMEMBERED_TEXT" })
    expect(() =>
      f.store.transaction(() => {
        f.store.db.run("UPDATE bot_memories SET deleted_at=1 WHERE id=?", [memory.id])
        throw new Error("rollback")
      })
    ).toThrow("rollback")
    expect(f.store.memories(f.bot.id)).toHaveLength(1)
    expect(records(f.path)).toEqual([])
    f.store.deleteMemory(f.bot.id, memory.id, memory.revision)
    expect(records(f.path)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "memory", key: memory.id }),
        expect.objectContaining({ kind: "memory-hash", owner: f.bot.id })
      ])
    )
    expect(
      readFileSync(`${f.path}.deletions`).includes(Buffer.from("PRIVATE_REMEMBERED_TEXT"))
    ).toBe(false)
  } finally {
    f.store.close()
  }
})

it.each(["export", "acknowledge"])(
  "recovers the %s failure window without acknowledging or replaying a hard deletion",
  (phase) => {
    const f = fixture()
    const ledger = new DatabaseSync(`${f.path}.deletions`)
    try {
      if (phase === "export")
        ledger.exec(
          "CREATE TRIGGER fail_export BEFORE INSERT ON deletions BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END"
        )
      else
        f.store.db.run(
          "CREATE TEMP TRIGGER fail_ack BEFORE DELETE ON bot_deletion_outbox BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END"
        )
      expect(() => f.store.deleteRoutine(f.remove)).toThrow("simulated storage failure")
      expect(f.store.routines(f.bot.id)).toEqual([])
      expect(f.store.db.exec("SELECT COUNT(*) FROM bot_deletion_outbox")[0].values[0][0]).toBe(1)
      expect(records(f.path)).toHaveLength(phase === "export" ? 0 : 1)
      if (phase === "export") ledger.exec("DROP TRIGGER fail_export")
    } finally {
      ledger.close()
      f.store.close()
    }
    const reopened = new BotStore(f.path)
    try {
      expect(reopened.db.exec("SELECT COUNT(*) FROM bot_deletion_outbox")[0].values[0][0]).toBe(0)
      expect(records(f.path)).toEqual([{ kind: "routine", key: f.routine.id, owner: "" }])
      expect(reopened.deleteRoutine(f.remove)).toEqual({
        id: f.routine.id,
        cancelledRunIds: [],
        activeRunIds: []
      })
      expect(records(f.path)).toHaveLength(1)
    } finally {
      reopened.close()
    }
  }
)

it.each(process.platform === "win32" ? ["hardlink"] : ["symlink", "hardlink"])(
  "rejects a %s ledger without modifying its target",
  (link) => {
    const f = fixture()
    f.store.close()
    const path = `${f.path}.deletions`,
      original = `${path}.original`
    renameSync(path, original)
    if (link === "symlink") symlinkSync(original, path, "file")
    else linkSync(original, path)
    const bytes = readFileSync(original)
    expect(() => new BotDeletionLedger(f.path)).toThrow("删除记录")
    expect(readFileSync(original)).toEqual(bytes)
  }
)
