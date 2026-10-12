import { afterEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { gunzipSync } from "node:zlib"
import { BotStore } from "./store"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"
import {
  assertCurrentSchemaAdditions,
  currentSchemaIndexes,
  currentSchemaRows
} from "./migration-current-additions.test-fixture"
import type { BotSaveRoutineInput } from "../../shared/bot-routines"
import original from "./fixtures/routine-readiness-v57.json"
const legacyRequest: BotSaveRoutineInput = {
  ...original.request,
  schedule: { ...original.request.schedule, kind: "interval" }
}
const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) close()
})
function dump(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
      .map(({ name }) => [
        String(name),
        db
          .prepare(`SELECT * FROM "${String(name)}"`)
          .all()
          .map((x) => JSON.stringify(x, (_, v) => (v instanceof Uint8Array ? [...v] : v)))
          .sort()
      ])
  )
}
function indexes(db: DatabaseSync) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all()
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-bot10-actual57-")),
    path = join(directory, "bots.sqlite")
  const bytes = gunzipSync(Buffer.from(original.bytes, "base64"))
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(original.sha256)
  expect(original.provenance).toMatchObject({
    kind: "genuine-frozen-root57-BotStore",
    schema: 57,
    noVersionEditing: true
  })
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" })
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(57)
    expect(
      db
        .prepare("PRAGMA table_info(bot_routines)")
        .all()
        .map((x) => x.name)
    ).not.toContain("desired_enabled")
    return { directory, path, before: dump(db), indexes: indexes(db) }
  } finally {
    db.close()
  }
}
it("genuine57 upgrade preserves legacy receipt bytes, all unrelated records and55/56/57 structures; current reopen never backfills", async () => {
  const f = await fixture(),
    store = new BotStore(f.path, () => original.now)
  cleanup.push(() => store.close())
  expect(store.routine(original.enabled.botId, original.enabled.id)).toMatchObject({
    enabled: true,
    desiredEnabled: true,
    activationRequired: false,
    effectiveState: "active"
  })
  expect(store.routine(original.paused.botId, original.paused.id)).toMatchObject({
    enabled: false,
    desiredEnabled: false,
    activationRequired: false,
    effectiveState: "paused"
  })
  expect(store.saveRoutine(legacyRequest)).toEqual(original.enabled)
  expect(
    store.db.exec("SELECT request_hash,response FROM bot_receipts WHERE nonce=?", [
      original.request.nonce
    ])[0].values[0]
  ).toEqual(original.receipt)
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
    assertCurrentSchemaAdditions(db)
    const after = dump(db)
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(f.before), ...Object.keys(currentSchemaRows)].sort()
    )
    for (const [table, rows] of Object.entries(f.before))
      if (table !== "bot_schema" && table !== "bot_routines")
        expect(after[table], table).toEqual(rows)
    expect(indexes(db).filter((row) => row.name !== "bot_event_restore_cursor")).toEqual(
      [
        ...f.indexes.filter((row) => row.name !== "bot_event_restore_cursor"),
        ...currentSchemaIndexes
      ].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    )
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='bot_event_restore_cursor'").get()?.sql
    ).toBe(
      "CREATE INDEX bot_event_restore_cursor ON bot_events(cursor DESC)\n WHERE kind IN ('workspace.restored','computer.restored')"
    )
    expect(
      db
        .prepare("PRAGMA table_info(bot_teach_sessions)")
        .all()
        .map((x) => x.name)
    ).toEqual(expect.arrayContaining(["thread_root", "start_request", "learning_epoch"]))
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='bot_peer_dispatch'").get()
    ).toBeTruthy()
  } finally {
    db.close()
  }
  const names = await readdir(join(f.directory, "backups"))
  expect(names.filter((x) => x.startsWith("bots-v57-") && x.endsWith(".sqlite"))).toHaveLength(1)
  const backup = new DatabaseSync(
    join(f.directory, "backups", names.find((x) => x.endsWith(".sqlite"))!),
    { readOnly: true }
  )
  try {
    expect(dump(backup)).toEqual(f.before)
    expect(indexes(backup)).toEqual(f.indexes)
  } finally {
    backup.close()
  }
  store.close()
  const reopened = new BotStore(f.path, () => original.now)
  cleanup.push(() => reopened.close())
  expect(await readdir(join(f.directory, "backups"))).toEqual(names)
  expect(reopened.saveRoutine(legacyRequest)).toEqual(original.enabled)
})
it("real partial ALTER/backfill failure rolls back both new columns/data/version and leaves the physical57 backup unchanged", async () => {
  const f = await fixture(),
    db = new DatabaseSync(f.path)
  cleanup.push(() => db.close())
  const exec = db.exec.bind(db)
  let sawBackfill = false
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.includes("ALTER TABLE bot_routines ADD COLUMN activation_required")) {
      sawBackfill = db
        .prepare("SELECT desired_enabled,enabled FROM bot_routines")
        .all()
        .every((x) => x.desired_enabled === x.enabled)
      throw new Error("controlled second-column failure")
    }
    return exec(sql)
  })
  expect(() => initializeBotDatabase(db, f.path)).toThrow("controlled second-column failure")
  spy.mockRestore()
  expect(sawBackfill).toBe(true)
  expect(dump(db)).toEqual(f.before)
  expect(indexes(db)).toEqual(f.indexes)
  expect(
    db
      .prepare("PRAGMA table_info(bot_routines)")
      .all()
      .map((x) => x.name)
  ).not.toContain("desired_enabled")
  const name = (await readdir(join(f.directory, "backups"))).find((x) => x.endsWith(".sqlite"))!
  const backup = new DatabaseSync(join(f.directory, "backups", name), { readOnly: true })
  try {
    expect(dump(backup)).toEqual(f.before)
    expect(indexes(backup)).toEqual(f.indexes)
  } finally {
    backup.close()
  }
})
