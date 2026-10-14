import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModCommandJob } from "../../shared/mods/types"
import { ModControlStore } from "./control-store"

const directories: string[] = []
const stores: ModControlStore[] = []
const originalExec = DatabaseSync.prototype.exec
const originalClose = DatabaseSync.prototype.close
const originalSaveJob = ModControlStore.prototype.saveJob
const originalGetSetting = ModControlStore.prototype.getSetting
const body = "原始完整内容\u0000💡".repeat(2000)

function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "cmb-mods-startup-transaction-"))
  directories.push(directory)
  return join(directory, "control.sqlite")
}

function legacy(file: string, version = "1"): void {
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      CREATE TABLE mods_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE mods_calls (id TEXT PRIMARY KEY, args_hash TEXT NOT NULL,
        status TEXT NOT NULL, at INTEGER NOT NULL, finished_at INTEGER, scope TEXT);
      CREATE TABLE mods_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace,key));
      CREATE TABLE mods_jobs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE mods_completion_evidence (id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL,
        phase TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
    `)
    db.prepare("INSERT INTO mods_meta VALUES(?,?)").run("schema", version)
    db.prepare("INSERT INTO mods_meta VALUES(?,?)").run(
      "complete-legacy-setting",
      JSON.stringify({ body })
    )
    db.prepare("INSERT INTO mods_state VALUES(?,?,?)").run(
      "legacy",
      "body",
      JSON.stringify({ body })
    )
    for (const state of ["running", "succeeded"]) {
      db.prepare("INSERT INTO mods_calls VALUES(?,?,?,?,?,?)").run(
        state,
        `hash:${state}`,
        state,
        11,
        null,
        JSON.stringify({ workspace: "project", threadId: "thread", body })
      )
    }
    for (const state of ["queued", "running", "succeeded"] as const) {
      const job: ModCommandJob = {
        id: state,
        threadId: "thread",
        workspace: "project",
        command: body,
        state,
        createdAt: 12
      }
      db.prepare("INSERT INTO mods_jobs VALUES(?,?,?,?)").run(
        state,
        "thread",
        JSON.stringify(job),
        12
      )
    }
    const payload = { id: "evidence", status: "running", detail: { body } }
    db.prepare("INSERT INTO mods_completion_evidence VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "evidence",
      "evidence",
      "project",
      "thread",
      "turn",
      "run",
      "capture.started",
      "running",
      JSON.stringify(payload),
      13
    )
  } finally {
    db.close()
  }
}

function snapshot(file: string): unknown {
  const db = new DatabaseSync(file)
  try {
    const schema = db
      .prepare(
        "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name,type"
      )
      .all()
    const tables = schema
      .filter((row) => row.type === "table")
      .map((row) => {
        const name = String(row.name).replaceAll('"', '""')
        return {
          name: row.name,
          rows: db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all()
        }
      })
    return { schema, tables }
  } finally {
    db.close()
  }
}

function failed(action: () => unknown): unknown {
  let rejected = false,
    reason: unknown
  try {
    action()
  } catch (error) {
    rejected = true
    reason = error
  }
  expect(rejected).toBe(true)
  return reason
}

function assertRecovered(file: string): void {
  const db = new DatabaseSync(file)
  try {
    expect(db.prepare("SELECT value FROM mods_meta WHERE key='schema'").get()?.value).toBe("7")
    expect(
      db.prepare("SELECT value FROM mods_meta WHERE key='complete-legacy-setting'").get()?.value
    ).toBe(JSON.stringify({ body }))
    expect(db.prepare("SELECT value FROM mods_state WHERE namespace='legacy'").get()?.value).toBe(
      JSON.stringify({ body })
    )
    expect(
      db.prepare("SELECT status,workspace,thread_id,scope FROM mods_calls ORDER BY id").all()
    ).toEqual(
      ["unknown", "succeeded"].map((status) => ({
        status,
        workspace: "project",
        thread_id: "thread",
        scope: JSON.stringify({ workspace: "project", threadId: "thread", body })
      }))
    )
    const jobs = db
      .prepare("SELECT payload FROM mods_jobs ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.payload)) as ModCommandJob)
    expect(jobs.map((job) => job.state)).toEqual(["cancelled", "unknown", "succeeded"])
    for (const job of jobs) expect(job.command).toBe(body)
    for (const job of jobs.slice(0, 2)) {
      expect(job.error).toBe("MODS_PROCESS_RESTARTED")
      expect(typeof job.finishedAt).toBe("number")
    }
    expect(jobs[2]).toEqual({
      id: "succeeded",
      threadId: "thread",
      workspace: "project",
      command: body,
      state: "succeeded",
      createdAt: 12
    })
    const evidence = db.prepare("SELECT status,payload FROM mods_completion_evidence").get()
    expect(evidence?.status).toBe("interrupted")
    expect(JSON.parse(String(evidence?.payload))).toEqual({
      id: "evidence",
      status: "interrupted",
      detail: { body, error: "MODS_PROCESS_RESTARTED" }
    })
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("cmb-mods-startup-transaction-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("Mods control store complete startup transaction", () => {
  it("creates the actual complete store with WAL and FULL and preserves normal state across reopen", () => {
    const file = path(),
      calls: string[] = []
    let durability: unknown
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      calls.push(sql)
      const result = Reflect.apply(originalExec, this, [sql])
      if (sql === "BEGIN IMMEDIATE")
        durability = {
          journal: this.prepare("PRAGMA journal_mode").get()?.journal_mode,
          synchronous: this.prepare("PRAGMA synchronous").get()?.synchronous
        }
      return result
    })
    const store = new ModControlStore(file)
    stores.push(store)
    expect(durability).toEqual({ journal: "wal", synchronous: 2 })
    expect(calls.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(1)
    expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(1)
    expect(calls).not.toContain("ROLLBACK")
    store.functionState.set("plugin", "full", { body })
    store.setSetting("legacy-setting", JSON.stringify({ body }))
    store.close()
    stores.pop()
    vi.restoreAllMocks()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.getSetting("schema")).toBe("7")
    expect(reopened.getSetting("legacy-setting")).toBe(JSON.stringify({ body }))
    expect(reopened.functionState.get("plugin", "full")).toEqual({ body })
  })

  it("migrates a genuine old schema and recovers complete calls, evidence and jobs without replay", () => {
    const file = path()
    legacy(file)
    const store = new ModControlStore(file)
    stores.push(store)
    assertRecovered(file)
    store.close()
    stores.pop()
    const before = new DatabaseSync(file)
    let jobs: unknown
    try {
      jobs = before.prepare("SELECT * FROM mods_jobs ORDER BY id").all()
    } finally {
      before.close()
    }
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    assertRecovered(file)
    const after = new DatabaseSync(file)
    try {
      expect(after.prepare("SELECT * FROM mods_jobs ORDER BY id").all()).toEqual(jobs)
    } finally {
      after.close()
    }
  })

  it("rejects an unknown version without leaving new schema or changing any original row", () => {
    const file = path()
    legacy(file, "99")
    const before = snapshot(file)
    expect(failed(() => new ModControlStore(file))).toMatchObject({ code: "MODS_STORE_VERSION" })
    expect(snapshot(file)).toEqual(before)
  })

  it.each([
    { label: "undefined", reason: undefined },
    { label: "null", reason: null },
    { label: "error", reason: Error("actual migration failure") }
  ])(
    "rolls back an actual mid-migration write and retains the original $label reason",
    ({ reason }) => {
      const file = path()
      legacy(file)
      const before = snapshot(file),
        calls: string[] = []
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql
      ) {
        calls.push(sql)
        const result = Reflect.apply(originalExec, this, [sql])
        if (sql === "ALTER TABLE mods_calls ADD COLUMN policy_digest TEXT") throw reason
        return result
      })
      expect(failed(() => new ModControlStore(file))).toBe(reason)
      expect(calls).toContain("ROLLBACK")
      expect(calls).not.toContain("COMMIT")
      vi.restoreAllMocks()
      expect(snapshot(file)).toEqual(before)
    }
  )

  it("rolls back already executed restart recovery when the real original job save later fails", () => {
    const file = path()
    legacy(file)
    const before = snapshot(file),
      recovered: unknown[] = []
    vi.spyOn(ModControlStore.prototype, "saveJob").mockImplementation(function (
      this: ModControlStore,
      job
    ) {
      const field = Object.getOwnPropertyDescriptor(this, "db")
      const database: unknown = field && "value" in field ? field.value : undefined
      expect(database).toBeInstanceOf(DatabaseSync)
      recovered.push(
        (database as DatabaseSync).prepare("SELECT status FROM mods_calls WHERE id='running'").get()
          ?.status
      )
      Reflect.apply(originalSaveJob, this, [job])
      recovered.push(job.state)
      throw undefined
    })
    expect(failed(() => new ModControlStore(file))).toBeUndefined()
    expect(recovered).toEqual(["unknown", "cancelled"])
    vi.restoreAllMocks()
    expect(snapshot(file)).toEqual(before)
    const restarted = new ModControlStore(file)
    stores.push(restarted)
    assertRecovered(file)
  })

  it("closes the actual connection after BEGIN fails without rolling back a transaction it never acquired", () => {
    const file = path()
    legacy(file)
    const before = snapshot(file),
      calls: string[] = []
    let closes = 0
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      calls.push(sql)
      if (sql === "BEGIN IMMEDIATE") throw undefined
      return Reflect.apply(originalExec, this, [sql])
    })
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      closes++
      return Reflect.apply(originalClose, this, [])
    })
    expect(failed(() => new ModControlStore(file))).toBeUndefined()
    expect(calls).not.toContain("ROLLBACK")
    expect(closes).toBe(1)
    vi.restoreAllMocks()
    expect(snapshot(file)).toEqual(before)
  })

  it("preserves a real competing writer and closes after native BEGIN reports the original busy error", () => {
    const file = path()
    legacy(file)
    const before = snapshot(file),
      calls: string[] = []
    const writer = new DatabaseSync(file)
    try {
      writer.exec("PRAGMA journal_mode = WAL")
      writer.exec("BEGIN IMMEDIATE")
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql
      ) {
        calls.push(sql)
        return Reflect.apply(originalExec, this, [sql])
      })
      expect(failed(() => new ModControlStore(file))).toMatchObject({
        message: expect.stringContaining("locked")
      })
      expect(calls).toContain("BEGIN IMMEDIATE")
      expect(calls).not.toContain("ROLLBACK")
      vi.restoreAllMocks()
      expect(writer.prepare("SELECT value FROM mods_meta WHERE key='schema'").get()?.value).toBe(
        "1"
      )
    } finally {
      vi.restoreAllMocks()
      try {
        writer.exec("ROLLBACK")
      } finally {
        writer.close()
      }
    }
    expect(snapshot(file)).toEqual(before)
    const restarted = new ModControlStore(file)
    stores.push(restarted)
    assertRecovered(file)
  })

  it("rolls back the complete migration after a real COMMIT call fails before committing", () => {
    const file = path(),
      reason = Error("actual commit rejection")
    legacy(file)
    const before = snapshot(file),
      calls: string[] = []
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      calls.push(sql)
      if (sql === "COMMIT") throw reason
      return Reflect.apply(originalExec, this, [sql])
    })
    expect(failed(() => new ModControlStore(file))).toBe(reason)
    expect(calls.at(-1)).toBe("ROLLBACK")
    vi.restoreAllMocks()
    expect(snapshot(file)).toEqual(before)
  })

  it("observes independent rollback and close failures without losing an undefined first failure", () => {
    const file = path(),
      closeReason = Error("close observer failure")
    legacy(file)
    const before = snapshot(file)
    let closes = 0
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "ROLLBACK") throw null
      const result = Reflect.apply(originalExec, this, [sql])
      if (sql === "ALTER TABLE mods_calls ADD COLUMN policy_digest TEXT") throw undefined
      return result
    })
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      closes++
      Reflect.apply(originalClose, this, [])
      throw closeReason
    })
    const reason = failed(() => new ModControlStore(file))
    expect(reason).toBeInstanceOf(AggregateError)
    expect((reason as AggregateError).errors).toEqual([undefined, null, closeReason])
    expect(closes).toBe(1)
    vi.restoreAllMocks()
    expect(snapshot(file)).toEqual(before)
  })

  it("preserves the original dynamic method call and rejects an actual nested transaction with full rollback", () => {
    const file = path()
    legacy(file)
    const before = snapshot(file)
    let entered = 0
    vi.spyOn(ModControlStore.prototype, "getSetting").mockImplementation(function (
      this: ModControlStore,
      key,
      fallback
    ) {
      const result = Reflect.apply(originalGetSetting, this, [key, fallback])
      entered++
      this.setSettings({ unexpected: "must not persist" })
      return result
    })
    expect(failed(() => new ModControlStore(file))).toMatchObject({
      message: expect.stringContaining("within a transaction")
    })
    expect(entered).toBe(1)
    vi.restoreAllMocks()
    expect(snapshot(file)).toEqual(before)
  })

  it("retains genuinely committed recovery when an observer throws after the real COMMIT", () => {
    const file = path()
    legacy(file)
    let closes = 0
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const result = Reflect.apply(originalExec, this, [sql])
      if (sql === "COMMIT") throw undefined
      return result
    })
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      closes++
      return Reflect.apply(originalClose, this, [])
    })
    const reason = failed(() => new ModControlStore(file))
    expect(reason).toBeInstanceOf(AggregateError)
    const errors = (reason as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBeUndefined()
    expect(errors[1]).toMatchObject({
      message: expect.stringContaining("no transaction is active")
    })
    expect(closes).toBe(1)
    vi.restoreAllMocks()
    assertRecovered(file)
  })
})
