import { afterEach, expect, it, vi } from "vitest"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { gunzipSync } from "node:zlib"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { BotBackupScheduler } from "./backup-scheduler"
import { initializeBotDatabase } from "./migrations"
import { BOT_SCHEMA_VERSION } from "./schema"
import {
  assertCurrentSchemaAdditions,
  currentSchemaIndexes,
  currentSchemaRows
} from "./migration-current-additions.test-fixture"
import { executeBotBackup } from "./backups"
import { executeBotComputerCheckpoint } from "./computer-checkpoint-service"
import original from "./fixtures/computer-restoration-v57-v58.json"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex")
async function root() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-legacy-epoch-")))
  roots.push(directory)
  return directory
}
async function fixture(which: "schema57" | "schema58" | "mixed57") {
  const directory = await root(),
    path = join(directory, "bots.sqlite"),
    snapshot = original[which],
    bytes = gunzipSync(Buffer.from(snapshot.bytes, "base64"), { maxOutputLength: 2 * 1024 ** 2 })
  expect(sha(bytes)).toBe(snapshot.sha256)
  expect(bytes.length).toBe(snapshot.size)
  expect(original.provenance).toMatchObject({
    kind: "genuine-public57-computer-restore-and-root58-upgrade",
    noVersionEditing: true,
    noSyntheticRestoreEvents: true,
    legacyApi: "executeBotComputerCheckpoint",
    upgradeApi: "BotStore"
  })
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(snapshot.schema)
    expect(
      db
        .prepare(
          "SELECT cursor,kind,entity_id,created_at FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor"
        )
        .all()
    ).toEqual(snapshot.events)
  } finally {
    db.close()
  }
  return { directory, path, snapshot }
}
function dump(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'bot_schema' ORDER BY name"
      )
      .all()
      .map(({ name }) => [
        String(name),
        db
          .prepare(`SELECT * FROM "${String(name)}"`)
          .all()
          .map((row) =>
            JSON.stringify(row, (_, value) => (value instanceof Uint8Array ? [...value] : value))
          )
          .sort()
      ])
  )
}
function indexes(db: DatabaseSync) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all()
}

async function client(directory: string) {
  const lock = BotHostLock.acquire(directory)
  if (!lock) throw new Error("Lock occupied")
  const store = new BotStore(join(directory, "bots.sqlite")),
    host = new BotHost(store)
  host.bindOwnership(lock)
  host.backups = new BotBackupScheduler(store.backupSchedule, directory, host.id, undefined, () =>
    lock.assertCurrent()
  )
  const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-legacy-${randomBytes(12).toString("hex")}`
        : join(directory, "rpc.sock"),
    token = randomBytes(32).toString("hex"),
    rpc = new BotRpcServer(host, token)
  await rpc.listen(socketPath)
  const transport = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  return {
    store,
    transport,
    async close() {
      await transport.closeAndWait()
      await rpc.close()
      await host.backups!.close()
      await host.stop()
      store.close()
      lock.release()
    }
  }
}
function epochQuery(store: BotStore) {
  const exec = store.db.exec.bind(store.db),
    queries: string[] = []
  const spy = vi.spyOn(store.db, "exec").mockImplementation((sql, ...args) => {
    if (sql.startsWith("SELECT entity_id FROM bot_events")) queries.push(sql)
    return exec(sql, ...args)
  })
  try {
    const value = store.dataEpoch()
    expect(store.backupSchedule.epoch()).toBe(value)
    expect(queries).toHaveLength(2)
    expect(queries[0]).toBe(queries[1])
    expect(queries[0]).toBe(
      "SELECT entity_id FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor DESC LIMIT 1"
    )
    const details = exec(`EXPLAIN QUERY PLAN ${queries[0]}`)[0].values.map((row) => String(row[3]))
    expect(details).toContain("SCAN bot_events USING INDEX bot_event_restore_cursor")
    expect(details).not.toContain("SCAN bot_events")
    expect(details.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false)
    console.log(JSON.stringify({ query: queries[0], details, value }))
    return value
  } finally {
    spy.mockRestore()
  }
}
it.each(["schema57", "schema58"] as const)(
  "genuine %s computer-only restoration rejects stale public create and backup settings without discarding old read-only receipts",
  async (which) => {
    const f = await fixture(which),
      current = await client(f.directory)
    try {
      const before = current.store.db.exec(
        "SELECT nonce,request_hash,response FROM bot_receipts ORDER BY nonce"
      )
      const staleCreate = await current.transport
        .call("create", {
          nonce: randomUUID(),
          name: "Stale initial create",
          expectedDataEpoch: "initial"
        })
        .catch((error: unknown) => error)
      const staleBackup = await current.transport
        .call("changeBackupSchedule", {
          nonce: randomUUID(),
          dataEpoch: "initial",
          revision: current.store.backupSchedule.read().revision,
          enabled: false,
          intervalHours: 48
        })
        .catch((error: unknown) => error)
      expect({ staleCreate, staleBackup }).toMatchObject({
        staleCreate: { code: "data_epoch" },
        staleBackup: { code: "data_epoch" }
      })
      expect(current.store.dataEpoch()).toBe(original.nonce)
      expect(current.store.backupSchedule.epoch()).toBe(original.nonce)
      expect(await current.transport.call("status")).toMatchObject({ dataEpoch: original.nonce })
      // Historical receipt replay stays read-only; public mutation admission is strict.
      expect(current.store.createBot(original.sourceCreate)).toEqual(original.created)
      expect(
        current.store.db.exec("SELECT nonce,request_hash,response FROM bot_receipts ORDER BY nonce")
      ).toEqual(before)
      expect(current.store.snapshot().bots.map((bot) => bot.id)).toEqual([original.created.bot.id])
      expect(epochQuery(current.store)).toBe(original.nonce)
    } finally {
      await current.close()
    }
  }
)
it("latest durable cursor wins over an earlier workspace event, wall-clock order and unrelated higher-cursor events", async () => {
  const f = await fixture("mixed57"),
    store = new BotStore(f.path)
  try {
    expect(store.dataEpoch()).toBe(original.mixed.computer)
    // Change only timestamps of genuine restored records, never create synthetic markers.
    store.db.run(
      "UPDATE bot_events SET created_at=CASE kind WHEN 'workspace.restored' THEN 9000 ELSE 1 END WHERE kind IN ('workspace.restored','computer.restored')"
    )
    store.createBot({
      nonce: randomUUID(),
      name: "Later unrelated event",
      expectedDataEpoch: original.mixed.computer
    })
    expect(epochQuery(store)).toBe(original.mixed.computer)
    expect(
      store.db.exec("SELECT kind FROM bot_events ORDER BY cursor DESC LIMIT 1")[0].values[0][0]
    ).toBe("bot.created")
  } finally {
    store.close()
  }
})
it("actual dual computer markers then later workspace restore use their original nonces and preserve the sealed source", async () => {
  const f = await fixture("mixed57"),
    beforeHash = sha(await readFile(f.path)),
    options = {
      nativeEntry: resolve("src/main/bots/computer-checkpoint-native-entry.ts"),
      nativeExecArgv: ["--import", "tsx"]
    },
    point = await executeBotComputerCheckpoint(
      f.directory,
      { action: "create", nonce: randomUUID() },
      options
    )
  if (point.action !== "create") throw new Error("Expected point")
  const sealedDatabase = join(
      f.directory,
      "computer-recovery",
      "points",
      point.checkpoint.id,
      "data",
      "bots.sqlite"
    ),
    sourceHash = sha(await readFile(sealedDatabase)),
    c = randomUUID()
  await executeBotComputerCheckpoint(
    f.directory,
    {
      action: "restore",
      nonce: c,
      checkpoint: { id: point.checkpoint.id, sha256: point.checkpoint.sha256 }
    },
    options
  )
  expect(sha(await readFile(sealedDatabase))).toBe(sourceHash)
  expect(beforeHash).toBe(f.snapshot.sha256)
  const current = new BotStore(f.path)
  try {
    expect(epochQuery(current)).toBe(c)
    expect(
      current.db.exec(
        "SELECT kind,entity_id,created_at FROM bot_events WHERE kind IN ('workspace.restored','computer.restored') ORDER BY cursor DESC LIMIT 2"
      )[0].values
    ).toEqual([
      ["computer.restored", c, expect.any(Number)],
      ["workspace.restored", c, expect.any(Number)]
    ])
  } finally {
    current.close()
  }
  const backup = await executeBotBackup(f.directory, { action: "create", nonce: randomUUID() })
  if (backup.action !== "create" || !backup.backup) throw new Error("Expected backup")
  const d = randomUUID()
  await executeBotBackup(f.directory, {
    action: "restore",
    nonce: d,
    backup: { id: backup.backup.id, sha256: backup.backup.sha256 }
  })
  const latest = new BotStore(f.path)
  try {
    expect(epochQuery(latest)).toBe(d)
    expect(
      latest.db.exec(
        "SELECT entity_id FROM bot_events WHERE kind='computer.restored' ORDER BY cursor DESC LIMIT 1"
      )[0].values[0][0]
    ).toBe(c)
  } finally {
    latest.close()
  }
}, 20_000)
it("real58 upgrade adds declared tables, the primary seed and restoration index; its backup and current reopen preserve every record", async () => {
  const f = await fixture("schema58"),
    db = new DatabaseSync(f.path, { readOnly: true }),
    before = dump(db),
    oldIndexes = indexes(db)
  db.close()
  const store = new BotStore(f.path)
  try {
    const read = new DatabaseSync(f.path, { readOnly: true })
    try {
      expect(read.prepare("SELECT version FROM bot_schema").get()?.version).toBe(BOT_SCHEMA_VERSION)
      assertCurrentSchemaAdditions(read)
      expect(dump(read)).toEqual({
        ...before,
        ...currentSchemaRows
      })
      expect(indexes(read).filter((row) => row.name !== "bot_event_restore_cursor")).toEqual(
        [
          ...oldIndexes.filter((row) => row.name !== "bot_event_restore_cursor"),
          ...currentSchemaIndexes
        ].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      )
      expect(
        read.prepare("SELECT sql FROM sqlite_master WHERE name='bot_event_restore_cursor'").get()
          ?.sql
      ).toBe(
        "CREATE INDEX bot_event_restore_cursor ON bot_events(cursor DESC)\n WHERE kind IN ('workspace.restored','computer.restored')"
      )
      expect(epochQuery(store)).toBe(original.nonce)
    } finally {
      read.close()
    }
  } finally {
    store.close()
  }
  const names = (await readdir(join(f.directory, "backups"))).filter(
    (name) => name.startsWith("bots-v58-") && name.endsWith(".sqlite")
  )
  expect(names).toHaveLength(1)
  const backup = new DatabaseSync(join(f.directory, "backups", names[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(58)
    expect(dump(backup)).toEqual(before)
    expect(indexes(backup)).toEqual(oldIndexes)
  } finally {
    backup.close()
  }
  const reopened = new BotStore(f.path)
  try {
    expect(reopened.dataEpoch()).toBe(original.nonce)
  } finally {
    reopened.close()
  }
  expect(
    (await readdir(join(f.directory, "backups"))).filter((name) => name.endsWith(".sqlite"))
  ).toEqual(names)
})
it("failure after index replacement rolls back the real58 predicate, version and records while retaining its backup", async () => {
  const f = await fixture("schema58"),
    db = new DatabaseSync(f.path),
    before = dump(db),
    oldIndexes = indexes(db),
    prepare = db.prepare.bind(db)
  let rebuilt = false
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql === "UPDATE bot_schema SET version=?") {
      rebuilt = String(
        prepare("SELECT sql FROM sqlite_master WHERE name='bot_event_restore_cursor'").get()?.sql
      ).includes("computer.restored")
      throw new Error("Controlled migration after index replacement")
    }
    return prepare(sql)
  })
  try {
    expect(() => initializeBotDatabase(db, f.path)).toThrow(
      "Controlled migration after index replacement"
    )
    spy.mockRestore()
    expect(rebuilt).toBe(true)
    expect(db.prepare("SELECT version FROM bot_schema").get()?.version).toBe(58)
    expect(dump(db)).toEqual(before)
    expect(indexes(db)).toEqual(oldIndexes)
  } finally {
    spy.mockRestore()
    db.close()
  }
  const names = (await readdir(join(f.directory, "backups"))).filter((name) =>
    name.endsWith(".sqlite")
  )
  expect(names).toHaveLength(1)
  const backup = new DatabaseSync(join(f.directory, "backups", names[0]), { readOnly: true })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(58)
    expect(dump(backup)).toEqual(before)
    expect(indexes(backup)).toEqual(oldIndexes)
  } finally {
    backup.close()
  }
})
it("fresh databases without a durable restoration marker retain initial despite normal events", () => {
  const store = new BotStore(":memory:")
  try {
    store.createBot({ nonce: randomUUID(), name: "Fresh" })
    expect(epochQuery(store)).toBe("initial")
  } finally {
    store.close()
  }
})
