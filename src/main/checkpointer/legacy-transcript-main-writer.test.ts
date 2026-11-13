import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { afterEach, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  createLegacyTranscriptWriter,
  handleLegacyTranscriptWriterCommand as handle,
  cancelLegacyTranscriptWriter,
  settleLegacyTranscriptWriter,
  readLegacyTranscriptWriterData,
  type LegacyTranscriptWriter
} from "./legacy-transcript-main-writer"
import type {
  LegacyTranscriptWriteAcknowledgement,
  LegacyTranscriptWriteCommand,
  LegacyTranscriptWriteRow
} from "./legacy-transcript-write-protocol"

const owned: Array<{ root: string; db: NativeSqliteAdapter; actors: LegacyTranscriptWriter[] }> = []
const wal = vi.hoisted(() => ({
  checkpoint: vi.fn<
    (path: string, options?: import("../db/wal-checkpoint").WalCheckpointOptions) => Promise<void>
  >(async () => undefined)
}))
vi.mock("../db/wal-checkpoint", () => ({ checkpointWalInBackground: wal.checkpoint }))
afterEach(async () => {
  vi.restoreAllMocks()
  for (const item of owned.splice(0)) {
    await Promise.all(item.actors.map(settleLegacyTranscriptWriter))
    item.db.close()
    rmSync(item.root, { recursive: true, force: true })
  }
  wal.checkpoint.mockReset().mockResolvedValue(undefined)
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-legacy-main-writer-"))
  const db = openNativeSqliteDatabase(join(root, "app.sqlite")).database
  db.run(`CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT,thread_values TEXT);
    INSERT INTO threads VALUES('A',1,'{"cmb_thread_incarnation":"inc"}',NULL);
    CREATE TABLE thread_messages(thread_id TEXT NOT NULL,message_id TEXT NOT NULL,provider_source_id TEXT,
      provider_occurrence INTEGER,role TEXT,content_json TEXT,reasoning TEXT,tool_calls_json TEXT,
      tool_call_id TEXT,name TEXT,status TEXT,is_error INTEGER,content_priority INTEGER,goal_id TEXT,
      active_window_id TEXT,created_at INTEGER,start_at INTEGER,end_at INTEGER,ordinal INTEGER,
      recovery_integrity INTEGER,PRIMARY KEY(thread_id,message_id));
    INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
      VALUES('A','live-tail','assistant','"live"',2,0);
    CREATE TABLE thread_message_buckets(thread_id TEXT PRIMARY KEY,message_count INTEGER,next_ordinal INTEGER,updated_at INTEGER);
    INSERT INTO thread_message_buckets VALUES('A',1,1,1);
    CREATE TABLE thread_message_fragments(fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT,message_id TEXT,content_text TEXT,created_at INTEGER);
    CREATE TABLE thread_message_fragment_states(thread_id TEXT,message_id TEXT,total_chars INTEGER,updated_at INTEGER,PRIMARY KEY(thread_id,message_id));
    CREATE TABLE thread_legacy_message_times(thread_id TEXT PRIMARY KEY,values_json TEXT,applied_checkpoint_id TEXT)`)
  const item = { root, db, actors: [] as LegacyTranscriptWriter[] }
  owned.push(item)
  let nextId = 0
  const make = (send?: (reply: LegacyTranscriptWriteAcknowledgement) => void) => {
    const replies: LegacyTranscriptWriteAcknowledgement[] = []
    const worker = {
      postMessage(reply: LegacyTranscriptWriteAcknowledgement) {
        replies.push(reply)
        send?.(reply)
      }
    } as Worker
    let current = true
    const guard = () => {
      const actual = db.exec("SELECT metadata FROM threads WHERE thread_id='A'")[0]?.values[0]?.[0]
      if (!current || actual !== '{"cmb_thread_incarnation":"inc"}')
        throw Error("actual source changed")
    }
    const actor = createLegacyTranscriptWriter({
      actualWorker: worker,
      workerGeneration: 1,
      requestId: ++nextId,
      threadId: "A",
      checkpointNamespace: "",
      incarnation: { token: "inc", legacyCreatedAt: 1 },
      actualDatabase: db,
      assertCurrent: guard
    })
    item.actors.push(actor)
    let sequence = 0
    const wire = (command: LegacyTranscriptWriteCommand) => ({
      ...actor.workerData,
      type: "legacy-transcript-write",
      sequence: ++sequence,
      command
    })
    const sendCommand = (command: LegacyTranscriptWriteCommand) =>
      handle(actor, worker, wire(command))
    return {
      actor,
      worker,
      replies,
      wire,
      sendCommand,
      revoke: () => {
        current = false
      }
    }
  }
  return { ...item, make }
}
function message(messageId = "old-0", content = "original"): LegacyTranscriptWriteRow {
  return {
    recoveryIntegrity: 1,
    messageId,
    providerSourceId: messageId,
    providerOccurrence: 1,
    role: "assistant",
    contentJson: JSON.stringify(content),
    reasoning: null,
    toolCallsJson: null,
    toolCallId: null,
    name: null,
    status: null,
    isError: null,
    createdAt: 10,
    estimatedBytes: Buffer.byteLength(content) + 1024
  }
}
const source = { checkpointId: "original-source", totalMessages: 2 }
function rows(db: NativeSqliteAdapter) {
  return db.exec("SELECT message_id,content_json,ordinal FROM thread_messages ORDER BY ordinal")[0]
    ?.values
}

it("keeps the original reserve/copy/finish SQL atomic and never reserves a completed source again", async () => {
  const f = fixture(),
    a = f.make()
  expect(await a.sendCommand({ kind: "read-state" })).toMatchObject({
    ok: true,
    result: { marker: null, ordinary: true }
  })
  expect(
    f.db.exec("SELECT 1 FROM sqlite_master WHERE name='legacy_checkpoint_transcript_migrations'")[0]
      ?.values ?? []
  ).toHaveLength(0)
  expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: true })
  expect(
    await a.sendCommand({
      kind: "copy",
      mode: "rows",
      ...source,
      index: 0,
      fragmentIndex: 0,
      rows: [message(), message("old-1")]
    })
  ).toMatchObject({ ok: true, result: { inserted: 2 } })
  expect(
    await a.sendCommand({ kind: "finish", ...source, index: 2, fragmentIndex: 0 })
  ).toMatchObject({ ok: true, result: { marker: { status: "complete", nextIndex: 2 } } })
  expect(rows(f.db)).toEqual([
    ["old-0", '"original"', 0],
    ["old-1", '"original"', 1],
    ["live-tail", '"live"', 2]
  ])
  const b = f.make()
  expect(await b.sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: true })
  expect(
    await b.sendCommand({ kind: "reserve", checkpointId: "new-head", totalMessages: 50 })
  ).toMatchObject({ ok: false, error: { code: "LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED" } })
  expect(rows(f.db)?.at(-1)?.[2]).toBe(2)
})

it("fixes target/actor identity and owns command fields before asynchronous admission", async () => {
  const f = fixture(),
    a = f.make()
  const expected = {
    actualWorker: a.worker,
    workerGeneration: 1,
    requestId: a.actor.workerData.requestId,
    threadId: "A",
    checkpointNamespace: ""
  }
  expect(readLegacyTranscriptWriterData(a.actor, expected)).toBe(a.actor.workerData)
  expect(() => readLegacyTranscriptWriterData({ ...a.actor }, expected)).toThrow("PROTOCOL")
  expect(() => readLegacyTranscriptWriterData(a.actor, { ...expected, threadId: "B" })).toThrow(
    "PROTOCOL"
  )
  const command = { kind: "reserve" as const, ...source }
  const pending = a.sendCommand(command)
  command.checkpointId = "mutated after the first await"
  command.totalMessages = 99
  expect(await pending).toMatchObject({ ok: true, result: { marker: source } })
  const getter = vi.fn(() => "forged")
  const bad = message()
  Object.defineProperty(bad, "contentJson", { get: getter, enumerable: true })
  expect(
    await a.sendCommand({
      kind: "copy",
      mode: "rows",
      ...source,
      index: 0,
      fragmentIndex: 0,
      rows: [bad]
    })
  ).toMatchObject({ ok: false, error: { code: "LEGACY_TRANSCRIPT_WRITE_PROTOCOL" } })
  expect(getter).not.toHaveBeenCalled()
  expect(rows(f.db)).toHaveLength(1)
})

it("admits completed discovery facts while rejecting every native-owner write", async () => {
  const f = fixture(),
    a = f.make()
  await a.sendCommand({ kind: "reserve", checkpointId: "empty", totalMessages: 0 })
  await a.sendCommand({
    kind: "finish",
    checkpointId: "empty",
    totalMessages: 0,
    index: 0,
    fragmentIndex: 0
  })
  f.db.run("CREATE TABLE function_logical_sessions(thread_id TEXT,incarnation_key TEXT)")
  f.db.run("INSERT INTO function_logical_sessions VALUES('A',?)", [
    JSON.stringify(["token", "inc"])
  ])
  expect(await a.sendCommand({ kind: "read-state" })).toMatchObject({
    ok: true,
    result: { ordinary: false, marker: { status: "complete" } }
  })
  expect(await a.sendCommand({ kind: "timing-source", checkpointId: "empty" })).toMatchObject({
    ok: false,
    error: { code: "MODS_CONVERSATION_MIGRATION_REQUIRED" }
  })
})

it("resumes fragment cursors, binds original headers/totals, and lets a live duplicate win", async () => {
  const f = fixture(),
    a = f.make(),
    point = { checkpointId: "fragment-source", totalMessages: 1 }
  await a.sendCommand({ kind: "reserve", ...point })
  const header = message("fragment", "")
  const chunk = {
    kind: "copy" as const,
    mode: "fragments" as const,
    ...point,
    index: 0,
    fragmentIndex: 0,
    row: header,
    fragments: ["a", "b"],
    totalFragments: 3,
    nextFragmentIndex: 2,
    complete: false
  }
  expect(await a.sendCommand(chunk)).toMatchObject({
    ok: true,
    result: { fragmentOwned: true, marker: { fragmentIndex: 2, nextIndex: 0 } }
  })
  expect(
    await a.sendCommand({
      ...chunk,
      fragmentIndex: 2,
      fragments: ["c"],
      nextFragmentIndex: 3,
      complete: true,
      row: { ...header, name: "replaced header" }
    })
  ).toMatchObject({ ok: false })
  expect(f.db.exec("SELECT content_text FROM thread_message_fragments")[0]?.values).toEqual([
    ["a"],
    ["b"]
  ])
  await settleLegacyTranscriptWriter(a.actor)
  const b = f.make()
  expect(await b.sendCommand({ kind: "reserve", ...point })).toMatchObject({ ok: true })
  expect(
    await b.sendCommand({
      ...chunk,
      fragmentIndex: 2,
      fragments: ["c"],
      nextFragmentIndex: 3,
      complete: true
    })
  ).toMatchObject({ ok: true, result: { marker: { nextIndex: 1, fragmentIndex: 0 } } })
  expect(f.db.exec("SELECT content_text FROM thread_message_fragments")[0]?.values).toEqual([
    ["a"],
    ["b"],
    ["c"]
  ])
  await b.sendCommand({ kind: "finish", ...point, index: 1, fragmentIndex: 0 })
  const duplicate = fixture(),
    c = duplicate.make()
  await c.sendCommand({ kind: "reserve", ...point })
  expect(
    await c.sendCommand({
      ...chunk,
      row: message("live-tail", ""),
      fragments: ["old"],
      nextFragmentIndex: 1
    })
  ).toMatchObject({
    ok: true,
    result: { fragmentOwned: false, marker: { nextIndex: 1, fragmentIndex: 0 } }
  })
  expect(
    duplicate.db.exec("SELECT content_text FROM thread_message_fragments")[0]?.values ?? []
  ).toHaveLength(0)
})

it("supports the original empty-fragment and single oversized-field compatibility cases", async () => {
  const f = fixture(),
    a = f.make(),
    point = { checkpointId: "empty-fragment", totalMessages: 1 }
  await a.sendCommand({ kind: "reserve", ...point })
  expect(
    await a.sendCommand({
      kind: "copy",
      mode: "fragments",
      ...point,
      index: 0,
      fragmentIndex: 0,
      totalFragments: 0,
      nextFragmentIndex: 0,
      complete: true,
      row: message("empty", ""),
      fragments: []
    })
  ).toMatchObject({ ok: true, result: { marker: { nextIndex: 1 } } })
  const huge = fixture(),
    b = huge.make()
  await b.sendCommand({ kind: "reserve", ...source })
  const large = { ...message(), name: "n".repeat(2 * 1024 * 1024) }
  expect(
    await b.sendCommand({
      kind: "copy",
      mode: "rows",
      ...source,
      index: 0,
      fragmentIndex: 0,
      rows: [large, message("other")]
    })
  ).toMatchObject({ ok: false })
  expect(
    await b.sendCommand({
      kind: "copy",
      mode: "rows",
      ...source,
      index: 0,
      fragmentIndex: 0,
      rows: [large]
    })
  ).toMatchObject({ ok: true })
  expect(
    huge.db.exec("SELECT length(name) FROM thread_messages WHERE message_id='old-0'")[0]
      ?.values[0]?.[0]
  ).toBe(2 * 1024 * 1024)
})

it("bounds queued commands, removes cancelled waiters, and retains until ACK dispatch", async () => {
  const f = fixture(),
    actors = Array.from({ length: 18 }, () => f.make())
  const tasks = actors.map((a) => a.sendCommand({ kind: "read-state" }))
  expect(await tasks[17]).toMatchObject({
    ok: false,
    error: { code: "LEGACY_TRANSCRIPT_WRITE_BUSY" }
  })
  cancelLegacyTranscriptWriter(actors[1].actor)
  expect(await tasks[1]).toMatchObject({
    ok: false,
    error: { code: "LEGACY_TRANSCRIPT_WRITE_CANCELLED" }
  })
  const replacement = f.make().sendCommand({ kind: "read-state" })
  await Promise.all(tasks)
  expect(await replacement).toMatchObject({ ok: true })
  let settled = false,
    duringAck: boolean | undefined,
    done: Promise<void> | undefined
  const a: ReturnType<typeof f.make> = f.make(() => {
    done = settleLegacyTranscriptWriter(a.actor).then(() => {
      settled = true
    })
    queueMicrotask(() => {
      duringAck = settled
    })
  })
  await a.sendCommand({ kind: "read-state" })
  await done
  expect(duringAck).toBe(false)
  expect(settled).toBe(true)
})

it("rolls back a BEGIN wrapper's after-effect failure and preserves COMMIT-unknown data", async () => {
  const f = fixture(),
    a = f.make(),
    run = f.db.run.bind(f.db)
  f.db.run = (...args) => {
    const result = run(...args)
    if (args[0] === "BEGIN IMMEDIATE") throw Error("after actual BEGIN")
    return result
  }
  expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: false })
  expect(f.db.inTransaction).toBe(false)
  f.db.run = (...args) => {
    const result = run(...args)
    if (args[0] === "COMMIT") throw Error("after actual COMMIT")
    return result
  }
  expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({
    ok: false,
    error: { code: "LEGACY_TRANSCRIPT_WRITE_COMMIT_UNKNOWN" }
  })
  f.db.run = run
  expect(rows(f.db)?.[0]?.[2]).toBe(2)
  expect(await f.make().sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: true })
  expect(rows(f.db)?.[0]?.[2]).toBe(2)
})

it.each(["before", "after"] as const)(
  "really rolls back when run() fails %s its rollback effect",
  async (effect) => {
    const f = fixture(),
      a = f.make(),
      run = f.db.run.bind(f.db)
    const failure = Error("after actual BEGIN")
    let rollbackAttempts = 0
    f.db.run = (...args) => {
      if (args[0] === "ROLLBACK") {
        rollbackAttempts++
        if (effect === "after") run(...args)
        throw Error("rollback wrapper failure")
      }
      const result = run(...args)
      if (args[0] === "BEGIN IMMEDIATE") throw failure
      return result
    }
    expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({
      ok: false,
      error: { code: "LEGACY_TRANSCRIPT_WRITE_FAILED" }
    })
    expect(rollbackAttempts).toBe(1)
    expect(f.db.inTransaction).toBe(false)
    expect(rows(f.db)?.[0]?.[2]).toBe(0)
    expect(
      f.db.exec("SELECT * FROM legacy_checkpoint_transcript_migrations")[0]?.values ?? []
    ).toEqual([])
    f.db.run = run
    expect(await f.make().sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: true })
    expect(rows(f.db)?.[0]?.[2]).toBe(2)
  }
)

/** Fault only the captured cleanup dispatch; migration/body SQL and SQLite close stay real. */
async function cleanupFailureWriter(failClose = false) {
  vi.resetModules()
  const native = await import("../db/native-sqlite-adapter")
  const exec = native.NativeSqliteAdapter.prototype.exec
  vi.spyOn(native.NativeSqliteAdapter.prototype, "exec").mockImplementation(function (
    this: NativeSqliteAdapter,
    sql,
    bindings
  ) {
    if (sql === "ROLLBACK") throw Error("injected fixed rollback dispatch failure")
    return Reflect.apply(exec, this, [sql, bindings])
  })
  if (failClose)
    vi.spyOn(native.NativeSqliteAdapter.prototype, "close").mockImplementation(() => {
      throw Error("injected fixed close dispatch failure")
    })
  return import("./legacy-transcript-main-writer")
}

function failingReservation(database: NativeSqliteAdapter) {
  const run = database.run.bind(database)
  database.run = (...args) => {
    if (args[0] === "ROLLBACK") throw Error("injected run rollback failure")
    const result = run(...args)
    if (args[0].includes("INSERT INTO thread_message_buckets"))
      throw Error("after actual uncommitted reservation")
    return result
  }
}

function faultActor(
  api: typeof import("./legacy-transcript-main-writer"),
  db: NativeSqliteAdapter,
  requestId = 1
) {
  const worker = { postMessage: vi.fn() } as unknown as Worker
  const actor = api.createLegacyTranscriptWriter({
    actualWorker: worker,
    workerGeneration: 1,
    requestId,
    threadId: "A",
    checkpointNamespace: "",
    incarnation: { token: "inc", legacyCreatedAt: 1 },
    actualDatabase: db,
    assertCurrent() {
      if (
        db.exec("SELECT metadata FROM threads WHERE thread_id='A'")[0]?.values[0]?.[0] !==
        '{"cmb_thread_incarnation":"inc"}'
      )
        throw Error("actual source changed")
    }
  })
  return {
    actor,
    send(command: LegacyTranscriptWriteCommand) {
      return api.handleLegacyTranscriptWriterCommand(actor, worker, {
        ...actor.workerData,
        type: "legacy-transcript-write",
        sequence: 1,
        command
      })
    }
  }
}

it("closes only the failed connection after both rollback dispatches fail and preserves committed data", async () => {
  const f = fixture(),
    api = await cleanupFailureWriter(),
    a = faultActor(api, f.db)
  failingReservation(f.db)
  try {
    expect(await a.send({ kind: "reserve", ...source })).toMatchObject({
      ok: false,
      error: { code: "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE" }
    })
    await api.settleLegacyTranscriptWriter(a.actor)
    expect(() => f.db.exec("SELECT 1")).toThrow("closed")
    const reopened = openNativeSqliteDatabase(join(f.root, "app.sqlite")).database
    try {
      expect(rows(reopened)).toEqual([["live-tail", '"live"', 0]])
      expect(
        reopened.exec("SELECT * FROM legacy_checkpoint_transcript_migrations")[0]?.values ?? []
      ).toEqual([])
      reopened.run("INSERT INTO threads VALUES('still-writable',2,NULL,NULL)")
    } finally {
      reopened.close()
    }
  } finally {
    f.db.close({ checkpoint: false })
    await api.settleLegacyTranscriptWriter(a.actor)
  }
})

it("retains physical credit after injected close failure until the actual connection is closed", async () => {
  const f = fixture(),
    other = fixture(),
    api = await cleanupFailureWriter(true)
  const a = faultActor(api, f.db),
    b = faultActor(api, other.db, 2)
  failingReservation(f.db)
  let next: Promise<LegacyTranscriptWriteAcknowledgement> | undefined
  try {
    expect(await a.send({ kind: "reserve", ...source })).toMatchObject({
      ok: false,
      error: { code: "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE" }
    })
    let drained = false,
      admitted = false
    const drain = api.settleLegacyTranscriptWriter(a.actor).then(() => {
      drained = true
    })
    next = b.send({ kind: "read-state" })
    void next.then(() => {
      admitted = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(drained).toBe(false)
    expect(admitted).toBe(false)
    expect(() =>
      f.db.run("INSERT INTO threads VALUES('must-not-join-abandoned',2,NULL,NULL)")
    ).toThrow("Database is unavailable")
    // Use the original fixture class's real close, not the injected failing dispatch.
    f.db.close({ checkpoint: false })
    await api.settleLegacyTranscriptWriter(a.actor)
    await drain
    expect(await next).toMatchObject({ ok: true })
  } finally {
    f.db.close({ checkpoint: false })
    await api.settleLegacyTranscriptWriter(a.actor)
    await next?.catch(() => undefined)
    await api.settleLegacyTranscriptWriter(b.actor)
  }
})

it("holds reserve credit through maintenance and restores policy before its only ACK", async () => {
  const f = fixture(),
    a = f.make(),
    second = fixture(),
    b = second.make()
  f.db.run("PRAGMA wal_autocheckpoint = 1")
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  wal.checkpoint.mockImplementation(async () => {
    await held
  })
  const run = f.db.run.bind(f.db)
  let ddlPolicy: unknown
  f.db.run = (...args) => {
    if (args[0].startsWith("CREATE TABLE IF NOT EXISTS legacy_checkpoint"))
      ddlPolicy = f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]
    return run(...args)
  }
  const reserve = a.sendCommand({ kind: "reserve", ...source })
  let next: Promise<LegacyTranscriptWriteAcknowledgement> | undefined
  try {
    await vi.waitFor(() => expect(wal.checkpoint).toHaveBeenCalledOnce())
    expect(ddlPolicy).toBe(0)
    expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(0)
    expect(f.db.inTransaction).toBe(false)
    expect(a.replies).toHaveLength(0)
    // Foreground work uses the same connection while asynchronous maintenance is held.
    f.db.run("UPDATE threads SET thread_values='{}' WHERE thread_id='A'")
    let nextSettled = false
    next = b.sendCommand({ kind: "read-state" })
    void next.then(() => {
      nextSettled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(nextSettled).toBe(false)
    expect(wal.checkpoint.mock.calls[0]?.[1]).toMatchObject({
      freshAfterCurrent: true,
      identity: { path: join(f.root, "app.sqlite") }
    })
  } finally {
    release()
  }
  expect(await reserve).toMatchObject({ ok: true })
  expect(await next).toMatchObject({ ok: true })
  expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(1)
  expect(a.replies).toHaveLength(1)
})

it.each([0, 2147483647])(
  "preserves prior policy %s and avoids a small/no-policy WAL Worker",
  async (pages) => {
    const f = fixture(),
      a = f.make()
    f.db.run(`PRAGMA wal_autocheckpoint = ${pages}`)
    const run = vi.spyOn(f.db, "run")
    expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({ ok: true })
    expect(wal.checkpoint).not.toHaveBeenCalled()
    expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(pages)
    if (pages === 0)
      expect(
        run.mock.calls.filter((call) => call[0].startsWith("PRAGMA wal_autocheckpoint ="))
      ).toHaveLength(0)
  }
)

it.each(["cancel", "source"] as const)(
  "restores reserve policy even after %s while maintenance is held",
  async (reason) => {
    const f = fixture(),
      a = f.make()
    f.db.run("PRAGMA wal_autocheckpoint = 1")
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    wal.checkpoint.mockImplementation(async () => {
      await held
    })
    const reserve = a.sendCommand({ kind: "reserve", ...source })
    try {
      await vi.waitFor(() => expect(wal.checkpoint).toHaveBeenCalledOnce())
      if (reason === "cancel") cancelLegacyTranscriptWriter(a.actor)
      else a.revoke()
      expect(a.replies).toHaveLength(0)
    } finally {
      release()
    }
    expect(await reserve).toMatchObject({ ok: false })
    expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(1)
    expect(
      f.db.exec("SELECT checkpoint_id FROM legacy_checkpoint_transcript_migrations")[0]?.values
    ).toEqual([[source.checkpointId]])
  }
)

it.each(["source", "cancel"] as const)(
  "prioritizes restore failure cleanup over %s",
  async (reason) => {
    const f = fixture(),
      a = f.make()
    f.db.run("PRAGMA wal_autocheckpoint = 1")
    wal.checkpoint.mockImplementation(async () => {
      if (reason === "source") a.revoke()
      else cancelLegacyTranscriptWriter(a.actor)
    })
    const run = f.db.run.bind(f.db)
    f.db.run = (...args) => {
      if (args[0] === "PRAGMA wal_autocheckpoint = 1")
        throw Error("injected restore dispatch failure")
      return run(...args)
    }
    expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({
      ok: false,
      error: { code: "LEGACY_TRANSCRIPT_WRITE_DATABASE_UNAVAILABLE" }
    })
    expect(() => f.db.exec("SELECT 1")).toThrow("Database is closed")
  }
)

it("rejects ordinary continuation when a native owner appears during reserve maintenance", async () => {
  const f = fixture(),
    a = f.make()
  f.db.run("PRAGMA wal_autocheckpoint = 1")
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  wal.checkpoint.mockImplementation(async () => {
    await held
  })
  const reserve = a.sendCommand({ kind: "reserve", ...source })
  try {
    await vi.waitFor(() => expect(wal.checkpoint).toHaveBeenCalledOnce())
    f.db.run("CREATE TABLE function_logical_sessions(thread_id TEXT,incarnation_key TEXT)")
    f.db.run("INSERT INTO function_logical_sessions VALUES('A',?)", [
      JSON.stringify(["token", "inc"])
    ])
  } finally {
    release()
  }
  expect(await reserve).toMatchObject({
    ok: false,
    error: { code: "MODS_CONVERSATION_MIGRATION_REQUIRED" }
  })
  expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(1)
  expect(
    f.db.exec("SELECT checkpoint_id FROM legacy_checkpoint_transcript_migrations")[0]?.values
  ).toEqual([[source.checkpointId]])
})

it("rechecks the source in the outer continuation after asynchronous reserve returns", async () => {
  const f = fixture(),
    a = f.make()
  f.db.run("PRAGMA wal_autocheckpoint = 1")
  const exec = f.db.exec.bind(f.db)
  let scheduled = false
  f.db.exec = (...args) => {
    const result = exec(...args)
    if (
      args[0] === "SELECT metadata FROM threads WHERE thread_id='A'" &&
      !scheduled &&
      wal.checkpoint.mock.calls.length > 0 &&
      exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0] === 1
    ) {
      scheduled = true
      queueMicrotask(() => {
        f.db.run("CREATE TABLE function_logical_sessions(thread_id TEXT,incarnation_key TEXT)")
        f.db.run("INSERT INTO function_logical_sessions VALUES('A',?)", [
          JSON.stringify(["token", "inc"])
        ])
      })
    }
    return result
  }
  expect(await a.sendCommand({ kind: "reserve", ...source })).toMatchObject({
    ok: false,
    error: { code: "MODS_CONVERSATION_MIGRATION_REQUIRED" }
  })
  expect(scheduled).toBe(true)
  expect(f.db.exec("PRAGMA wal_autocheckpoint")[0]?.values[0]?.[0]).toBe(1)
  expect(await f.make().sendCommand({ kind: "read-state" })).toMatchObject({
    ok: true,
    result: { ordinary: false }
  })
})

it("uses exact native timing source CAS and never marks a changed source applied", async () => {
  const f = fixture(),
    a = f.make(),
    point = { checkpointId: "timed-source", totalMessages: 1 }
  await a.sendCommand({ kind: "reserve", ...point })
  await a.sendCommand({
    kind: "copy",
    mode: "rows",
    ...point,
    index: 0,
    fragmentIndex: 0,
    rows: [message()]
  })
  await a.sendCommand({ kind: "finish", ...point, index: 1, fragmentIndex: 0 })
  f.db.run("UPDATE threads SET thread_values=?", [
    JSON.stringify({ messageTimes: { "old-0": { start_at: 10, end_at: 20 } } })
  ])
  const source = await a.sendCommand({ kind: "timing-source", checkpointId: point.checkpointId })
  expect(source).toMatchObject({ ok: true })
  if (!source.ok || !("timing" in source.result) || !source.result.timing)
    throw Error("timing source missing")
  const command = {
    kind: "timing-page" as const,
    checkpointId: point.checkpointId,
    timingToken: source.result.timing.timingToken,
    index: 0,
    complete: true,
    entries: [{ messageId: "old-0", startAt: 10, endAt: 20 }]
  }
  f.db.run("UPDATE threads SET thread_values=?", [
    JSON.stringify({ messageTimes: { "old-0": { start_at: 11, end_at: 21 } } })
  ])
  expect(await a.sendCommand(command)).toMatchObject({
    ok: false,
    error: { code: "LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED" }
  })
  expect(
    f.db.exec("SELECT start_at,end_at FROM thread_messages WHERE message_id='old-0'")[0]?.values[0]
  ).toEqual([null, null])
  expect(
    f.db.exec("SELECT applied_checkpoint_id FROM thread_legacy_message_times")[0]?.values[0]?.[0]
  ).toBeNull()
  const fresh = await a.sendCommand({ kind: "timing-source", checkpointId: point.checkpointId })
  if (!fresh.ok || !("timing" in fresh.result) || !fresh.result.timing)
    throw Error("fresh timing source missing")
  expect(
    await a.sendCommand({
      ...command,
      timingToken: fresh.result.timing.timingToken,
      entries: [{ messageId: "old-0", startAt: 11, endAt: 21 }]
    })
  ).toMatchObject({ ok: true })
  expect(
    f.db.exec("SELECT start_at,end_at,created_at FROM thread_messages WHERE message_id='old-0'")[0]
      ?.values[0]
  ).toEqual([11, 21, 11])
})
