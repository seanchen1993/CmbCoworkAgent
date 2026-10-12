import { afterEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { gunzipSync } from "node:zlib"
import type { NativeSqliteBindings } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"
import {
  assertCurrentSchemaAdditions,
  currentSchemaIndexes,
  currentSchemaRows
} from "./migration-current-additions.test-fixture"
import original from "./fixtures/memory-index-v56.json"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const indexes = ["bot_memory_evidence_by_bot", "bot_memory_active_by_bot"] as const

function dump(db: DatabaseSync) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'bot_schema' ORDER BY name"
    )
    .all()
    .map((row) => String(row.name))
  return Object.fromEntries(
    names.map((name) => [
      name,
      db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) =>
          JSON.stringify(row, (_, value) => (value instanceof Uint8Array ? [...value] : value))
        )
        .sort()
    ])
  )
}

function memoryRows(store: BotStore) {
  return JSON.stringify(
    [
      "bot_memory_state",
      "bot_memory_evidence",
      "bot_memories",
      "bot_memory_metadata",
      "bot_events"
    ].map((name) => store.db.exec(`SELECT * FROM ${name} ORDER BY rowid`))
  )
}
function indexNames(db: DatabaseSync) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
    .all()
    .map((row) => String(row.name))
}
function explainActualTargets(store: BotStore) {
  const prepare = store.db.prepare.bind(store.db)
  let query: { sql: string; values: NativeSqliteBindings } | undefined
  const spy = vi.spyOn(store.db, "prepare").mockImplementation((sql, values) => {
    if (sql.includes("SELECT b.id FROM bots b LEFT JOIN bot_memory_state"))
      query = { sql, values: values ?? [] }
    return prepare(sql, values)
  })
  const targets = store.memory.targets()
  spy.mockRestore()
  expect(query).toBeDefined()
  const details = store.db
    .exec(`EXPLAIN QUERY PLAN ${query!.sql}`, query!.values)[0]
    .values.map((row) => String(row[3]))
  // Assert Bot-scoped searches of the actual public targets query, without forcing a query plan.
  expect(details).toContainEqual(
    expect.stringContaining("bot_memory_evidence_by_bot (bot_id=? AND state=? AND next_at<?)")
  )
  expect(details).toContainEqual(expect.stringContaining("bot_memory_active_by_bot (bot_id=?)"))
  expect(details).toContainEqual(
    expect.stringContaining("sqlite_autoindex_bot_memory_metadata_1 (memory_id=?)")
  )
  expect(details).not.toContain("SCAN d")
  console.log(JSON.stringify({ query: query!.sql, values: query!.values, details }))
  return targets
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-memory-real-v56-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite")
  const bytes = gunzipSync(Buffer.from(original.bytes, "base64"), {
    maxOutputLength: 2 * 1024 * 1024
  })
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(original.sha256)
  expect(original.provenance).toMatchObject({
    kind: "genuine-prepared-v56-BotStore",
    acceptedStoreCompletions: 3,
    publicSavedFacts: 3,
    syntheticMetadataSeeds: 2,
    externalModelExecutions: 0
  })
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(56)
    for (const name of indexes) expect(indexNames(db)).not.toContain(name)
    const teach = db.prepare("PRAGMA table_info(bot_teach_sessions)").all()
    for (const name of ["thread_root", "start_request", "learning_epoch"])
      expect(teach).toContainEqual(expect.objectContaining({ name }))
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_peer_dispatch").get()?.n).toBe(0)
    return { directory, path, before: dump(db), oldIndexes: indexNames(db) }
  } finally {
    db.close()
  }
}
it("new databases retain the old pending index and add Bot-scoped evidence and active-memory searches", () => {
  const store = new BotStore(":memory:", () => original.now)
  cleanup.push(() => store.close())
  const definitions = store.db.exec(
    "SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN ('bot_memory_pending','bot_memory_evidence_by_bot','bot_memory_active_by_bot') ORDER BY name"
  )[0].values
  expect(definitions).toEqual([
    [
      "bot_memory_active_by_bot",
      "CREATE INDEX bot_memory_active_by_bot ON bot_memories(bot_id,id) WHERE deleted_at IS NULL"
    ],
    [
      "bot_memory_evidence_by_bot",
      "CREATE INDEX bot_memory_evidence_by_bot ON bot_memory_evidence(bot_id,state,next_at)"
    ],
    [
      "bot_memory_pending",
      "CREATE INDEX bot_memory_pending ON bot_memory_evidence(state,next_at,bot_id)"
    ]
  ])
  const before = memoryRows(store)
  expect(explainActualTargets(store)).toEqual([])
  expect(memoryRows(store)).toBe(before)
})
it("genuine v56 upgrade and backup preserve every record and all six memory-target states", async () => {
  const f = await fixture()
  const store = new BotStore(f.path, () => original.now)
  cleanup.push(() => store.close())
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    assertCurrentSchemaAdditions(db)
    expect(dump(db)).toEqual({
      ...f.before,
      ...currentSchemaRows
    })
    expect(indexNames(db)).toEqual(
      [...f.oldIndexes, ...indexes, ...currentSchemaIndexes.map((index) => index.name)].sort()
    )
  } finally {
    db.close()
  }
  const expected = [original.ids.pending, original.ids.temporal].sort()
  const before = memoryRows(store)
  expect(explainActualTargets(store)).toEqual(expected)
  expect(store.memory.prepare(original.ids.pending)?.evidence).toHaveLength(1)
  expect(store.memory.prepare(original.ids.temporal)).toMatchObject({
    temporal: true,
    evidence: []
  })
  for (const state of ["future", "disabled", "explicit", "deleted"] as const)
    expect(store.memory.prepare(original.ids[state])).toBeNull()
  expect(store.memory.targets()).toEqual(expected)
  expect(memoryRows(store)).toBe(before)
  const backupNames = (await readdir(join(f.directory, "backups"))).filter((name) =>
    name.startsWith("bots-v56-")
  )
  expect(backupNames).toHaveLength(1)
  const backup = new DatabaseSync(join(f.directory, "backups", backupNames[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(56)
    expect(dump(backup)).toEqual(f.before)
    expect(indexNames(backup)).toEqual(f.oldIndexes)
  } finally {
    backup.close()
  }
  store.close()
  const reopened = new BotStore(f.path, () => original.now)
  cleanup.push(() => reopened.close())
  expect(reopened.memory.targets()).toEqual(expected)
  expect(
    (await readdir(join(f.directory, "backups"))).filter((name) => name.endsWith(".sqlite"))
  ).toEqual(backupNames)
})
it("failure after the first new index rolls back both indexes and the version, preserving genuine v56 and its backup", async () => {
  const f = await fixture()
  const db = new DatabaseSync(f.path)
  const exec = db.exec.bind(db)
  let sawFirstIndex = false
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    const second = sql.indexOf("CREATE INDEX IF NOT EXISTS bot_memory_active_by_bot")
    if (second >= 0) {
      exec(sql.slice(0, second))
      sawFirstIndex = indexNames(db).includes(indexes[0])
      throw new Error("controlled second-index migration failure")
    }
    return exec(sql)
  })
  try {
    expect(() => initializeBotDatabase(db, f.path)).toThrow(
      "controlled second-index migration failure"
    )
    spy.mockRestore()
    expect(sawFirstIndex).toBe(true)
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(56)
    expect(indexNames(db)).toEqual(f.oldIndexes)
    expect(dump(db)).toEqual(f.before)
  } finally {
    spy.mockRestore()
    db.close()
  }
  const backupNames = (await readdir(join(f.directory, "backups"))).filter((name) =>
    name.startsWith("bots-v56-")
  )
  expect(backupNames).toHaveLength(1)
  const backup = new DatabaseSync(join(f.directory, "backups", backupNames[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(56)
    expect(dump(backup)).toEqual(f.before)
    expect(indexNames(backup)).toEqual(f.oldIndexes)
  } finally {
    backup.close()
  }
})
