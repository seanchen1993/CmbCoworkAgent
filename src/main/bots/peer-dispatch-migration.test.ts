import { afterEach, expect, it, vi } from "vitest"
import { gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"
import {
  assertCurrentSchemaAdditions,
  currentSchemaIndexes,
  currentSchemaRows
} from "./migration-current-additions.test-fixture"
import original from "./fixtures/peer-dispatch-v54.json"
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
type Columns = Record<string, string[]>
function columns(db: DatabaseSync): Columns {
  return Object.fromEntries(
    Object.keys(dump(db)).map((name) => [
      name,
      db
        .prepare(`PRAGMA table_info("${name}")`)
        .all()
        .map((row) => String(row.name))
    ])
  )
}
function dump(db: DatabaseSync, originalColumns?: Columns) {
  const names = originalColumns
    ? Object.keys(originalColumns)
    : db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'bot_schema' ORDER BY name"
        )
        .all()
        .map((r) => String(r.name))
  return Object.fromEntries(
    names.map((name) => [
      name,
      db
        .prepare(
          `SELECT ${originalColumns ? originalColumns[name].map((column) => `"${column}"`).join(",") : "*"} FROM "${name}"`
        )
        .all()
        .map((row) => JSON.stringify(row, (_, v) => (v instanceof Uint8Array ? [...v] : v)))
        .sort()
    ])
  )
}
function indexes(db: DatabaseSync) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all()
}
const memoryIndexes = [
  {
    name: "bot_memory_active_by_bot",
    sql: "CREATE INDEX bot_memory_active_by_bot ON bot_memories(bot_id,id) WHERE deleted_at IS NULL"
  },
  {
    name: "bot_memory_evidence_by_bot",
    sql: "CREATE INDEX bot_memory_evidence_by_bot ON bot_memory_evidence(bot_id,state,next_at)"
  }
]

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-real-v54-")))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, "bots.sqlite")
  const bytes = gunzipSync(Buffer.from(original.bytes, "base64"), {
    maxOutputLength: 2 * 1024 * 1024
  })
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(original.sha256)
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
  const db = new DatabaseSync(path, { readOnly: true })
  let before: ReturnType<typeof dump>, oldColumns: Columns, oldIndexes: ReturnType<typeof indexes>
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(54)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='bot_peer_dispatch'").get()
    ).toBeUndefined()
    before = dump(db)
    oldColumns = columns(db)
    oldIndexes = indexes(db)
  } finally {
    db.close()
  }
  return {
    ...original,
    dir,
    path,
    before: before!,
    oldColumns: oldColumns!,
    oldIndexes: oldIndexes!
  }
}
it("real fixed v54 database adds only dispatch metadata and preserves old threads/images/receipts/waits/unknown effects", async () => {
  const f = await fixture(),
    current = new BotStore(f.path, () => original.now)
  cleanup.push(() => current.close())
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    expect(dump(db, f.oldColumns)).toEqual(f.before)
    assertCurrentSchemaAdditions(db)
    const afterColumns = columns(db)
    expect(Object.keys(afterColumns).sort()).toEqual(
      [...Object.keys(f.oldColumns), ...Object.keys(currentSchemaRows), "bot_peer_dispatch"].sort()
    )
    expect(indexes(db).filter((row) => row.name !== "bot_event_restore_cursor")).toEqual(
      [
        ...f.oldIndexes.filter((row) => row.name !== "bot_event_restore_cursor"),
        ...memoryIndexes,
        ...currentSchemaIndexes,
        { name: "sqlite_autoindex_bot_peer_dispatch_1", sql: null }
      ].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    )
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='bot_event_restore_cursor'").get()?.sql
    ).toBe(
      "CREATE INDEX bot_event_restore_cursor ON bot_events(cursor DESC)\n WHERE kind IN ('workspace.restored','computer.restored')"
    )
    for (const name of Object.keys(afterColumns)) {
      if (!(name in f.oldColumns)) {
        if (name === "bot_primary") {
          expect(
            db
              .prepare(`SELECT * FROM "${name}"`)
              .all()
              .map((row) => JSON.stringify(row))
          ).toEqual(currentSchemaRows[name])
          continue
        }
        expect(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n).toBe(0)
        continue
      }
      for (const column of db.prepare(`PRAGMA table_info("${name}")`).all()) {
        if (f.oldColumns[name].includes(String(column.name))) continue
        const expected =
          column.dflt_value === null
            ? null
            : db.prepare(`SELECT ${String(column.dflt_value)} AS value`).get()?.value
        for (const row of db
          .prepare(`SELECT "${String(column.name)}" AS value FROM "${name}"`)
          .all())
          expect(row.value).toEqual(expected)
      }
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_peer_dispatch").get()?.n).toBe(0)
  } finally {
    db.close()
  }
  const backupName = (await readdir(join(f.dir, "backups"))).filter((name) =>
    name.startsWith("bots-v54-")
  )
  expect(backupName).toHaveLength(1)
  const backup = new DatabaseSync(join(f.dir, "backups", backupName[0]), {
    readOnly: true
  })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(54)
    expect(dump(backup)).toEqual(f.before)
    expect(indexes(backup)).toEqual(f.oldIndexes)
  } finally {
    backup.close()
  }
  const child = current.claim("new-host")!
  expect(child.run.id).toBe(f.sent.runIds[0])
  current.finish(child.lease, "succeeded", "LEGACY_AWAITED_RESULT")
  expect(current.waitForPeer(f.parent.lease, child.run.id).status).toBe("succeeded")
  expect(current.sendPeer(f.parent.lease, f.input)).toEqual(f.sent)
  expect(current.getRun(f.unknown).status).toBe("needs_review")
  expect(current.db.exec("SELECT COUNT(*) FROM bot_peer_dispatch")[0].values[0][0]).toBe(0)
})
it("real v54 migration failure keeps the original version and every old record under the original transaction rollback", async () => {
  const f = await fixture(),
    db = new DatabaseSync(f.path),
    exec = db.exec.bind(db)
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS bot_peer_dispatch")) {
      exec(sql)
      throw new Error("controlled migration commit failure")
    }
    return exec(sql)
  })
  try {
    expect(() => initializeBotDatabase(db, f.path)).toThrow("controlled migration commit failure")
    spy.mockRestore()
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(54)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='bot_peer_dispatch'").get()
    ).toBeUndefined()
    expect(dump(db)).toEqual(f.before)
    expect(indexes(db)).toEqual(f.oldIndexes)
  } finally {
    spy.mockRestore()
    db.close()
  }
  const backups = (await readdir(join(f.dir, "backups"))).filter((name) =>
    name.startsWith("bots-v54-")
  )
  expect(backups).toHaveLength(1)
  const saved = new DatabaseSync(join(f.dir, "backups", backups[0]), { readOnly: true })
  try {
    expect(dump(saved)).toEqual(f.before)
    expect(indexes(saved)).toEqual(f.oldIndexes)
  } finally {
    saved.close()
  }
})
