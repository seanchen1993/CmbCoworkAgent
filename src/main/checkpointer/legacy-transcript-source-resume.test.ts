import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { bootstrapLegacyCheckpointTranscript } from "./runtime-projection-store"
import { readThreadMessagesPage } from "../thread-message-hydration/page-reader"
import { prepareLegacyCheckpointTranscriptSource } from "./runtime-projection-store"

const ORIGINAL = "a-original", LATEST = "z-new-compacted"
const owned: Array<{ directory: string; app: DatabaseSync; checkpoint: DatabaseSync }> = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const fixture of owned.splice(0)) {
    fixture.app.close()
    fixture.checkpoint.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

function history() {
  return Array.from({ length: 180 }, (_, index) => ({
    type: index % 2 ? "ai" : "human", id: `historical-${index}`,
    content: `original body ${index} \ud800`, additional_kwargs: {}
  }))
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-legacy-v1-resume-"))
  const appPath = join(directory, "app.sqlite"), checkpointPath = join(directory, "checkpoint.sqlite")
  const app = new DatabaseSync(appPath), checkpoint = new DatabaseSync(checkpointPath)
  owned.push({ directory, app, checkpoint })
  app.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE threads(thread_id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,
      metadata TEXT,thread_values TEXT);
    CREATE TABLE thread_messages(thread_id TEXT NOT NULL,message_id TEXT NOT NULL,
      provider_source_id TEXT,provider_occurrence INTEGER,role TEXT NOT NULL,content_json TEXT NOT NULL,
      reasoning TEXT,tool_calls_json TEXT,tool_call_id TEXT,name TEXT,status TEXT,is_error INTEGER,
      content_priority INTEGER,goal_id TEXT,active_window_id TEXT,created_at INTEGER NOT NULL,
      start_at INTEGER,end_at INTEGER,ordinal INTEGER NOT NULL,recovery_integrity INTEGER,
      PRIMARY KEY(thread_id,message_id));
    CREATE INDEX idx_thread_messages_thread_order ON thread_messages(thread_id,ordinal,created_at);
    CREATE TABLE thread_message_buckets(thread_id TEXT PRIMARY KEY,message_count INTEGER NOT NULL,
      next_ordinal INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE thread_message_fragments(fragment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,message_id TEXT NOT NULL,content_text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE thread_message_fragment_states(thread_id TEXT NOT NULL,message_id TEXT NOT NULL,
      total_chars INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(thread_id,message_id));
    CREATE TABLE thread_goal_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE thread_legacy_message_times(thread_id TEXT PRIMARY KEY,values_json TEXT NOT NULL,
      applied_checkpoint_id TEXT);
    INSERT INTO threads VALUES('thread','original',1,NULL,NULL);
    INSERT INTO thread_messages(thread_id,message_id,role,content_json,created_at,ordinal)
      VALUES('thread','live-tail','assistant','"live tail body"',2,0);
    INSERT INTO thread_message_buckets VALUES('thread',1,1,1)`)
  checkpoint.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE checkpoints(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,checkpoint_ts TEXT,
      type TEXT NOT NULL,checkpoint BLOB NOT NULL,metadata BLOB NOT NULL,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
    CREATE TABLE checkpoint_message_snapshots(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,prefix_length INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL,generation TEXT NOT NULL DEFAULT '',type TEXT,suffix BLOB NOT NULL,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
    CREATE TABLE checkpoint_runtime_projections(thread_id TEXT NOT NULL,checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,parent_checkpoint_id TEXT,checkpoint_ts TEXT NOT NULL,
      projection_version INTEGER NOT NULL DEFAULT 1,type TEXT NOT NULL,runtime_checkpoint BLOB NOT NULL,
      PRIMARY KEY(thread_id,checkpoint_ns))`)
  const put = (id: string, messages: unknown[], namespace = "") => {
    const ts = id === ORIGINAL ? "2026-11-01T00:00:00.000Z" : "2026-11-01T01:00:00.000Z"
    const value = { v: 1, id, ts, channel_values: { messages,
      todos: [{ id: "todo", content: id, status: "pending" }] },
      channel_versions: { messages: 1 }, versions_seen: {}, pending_sends: [] }
    checkpoint.prepare("INSERT INTO checkpoints VALUES('thread',?,?,NULL,?,'json',?,?)")
      .run(namespace, id, ts, Buffer.from(JSON.stringify(value)), Buffer.from('{"source":"loop","step":1,"parents":{}}'))
  }
  put(ORIGINAL, history())
  const bootstrap = () => bootstrapLegacyCheckpointTranscript(checkpointPath, appPath,
    "thread", "", new SharedArrayBuffer(4))
  const appendLatest = () => put(LATEST, [{ type: "human", id: "summary", content: "new summary",
    additional_kwargs: { lc_source: "summarization" } }, ...history().slice(-50)])
  return { app, checkpoint, appPath, checkpointPath, put, bootstrap, appendLatest }
}

function seedPartial(f: ReturnType<typeof fixture>, external = true) {
  const cancellation = new SharedArrayBuffer(4), applicationHandles = new WeakSet<DatabaseSync>()
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec
  let commits = 0
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql) {
    if (/FROM\s+threads\b/i.test(sql)) applicationHandles.add(this)
    return Reflect.apply(prepare, this, [sql])
  })
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql) {
    const result = Reflect.apply(exec, this, [sql])
    if (applicationHandles.has(this) && sql.trim().toUpperCase() === "COMMIT" && ++commits === 2)
      Atomics.store(new Int32Array(cancellation), 0, 1)
    return result
  })
  try {
    expect(() => bootstrapLegacyCheckpointTranscript(f.checkpointPath, f.appPath,
      "thread", "", cancellation)).toThrow("Checkpoint runtime projection request was superseded")
  } finally { vi.restoreAllMocks() }
  expect(f.app.prepare("SELECT checkpoint_id,total_messages,next_index,status FROM legacy_checkpoint_transcript_migrations")
    .get()).toEqual({ checkpoint_id: ORIGINAL, total_messages: 180, next_index: 64, status: "migrating" })
  expect(f.app.prepare("SELECT ordinal FROM thread_messages WHERE message_id='live-tail'").get()?.ordinal).toBe(180)
  // Published auxiliary schemas produce the actual external chain during the
  // first bootstrap, rather than a hand-authored replacement source for resume.
  if (external)
    expect(f.checkpoint.prepare("SELECT message_count FROM checkpoint_message_snapshots WHERE checkpoint_id=?")
      .get(ORIGINAL)?.message_count).toBe(180)
}

function appSnapshot(app: DatabaseSync) {
  return ["thread_messages", "thread_message_buckets", "thread_message_fragments",
    "thread_message_fragment_states", "legacy_checkpoint_transcript_migrations",
    "thread_legacy_message_times"].map(table => ({ table,
    rows: app.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }))
}

function expectComplete(f: ReturnType<typeof fixture>) {
  const rows = f.app.prepare("SELECT message_id,role,content_json,ordinal FROM thread_messages ORDER BY ordinal,created_at")
    .all()
  expect(rows).toEqual([...history().map((message, index) => ({ message_id: message.id,
    role: index % 2 ? "assistant" : "user", content_json: JSON.stringify(message.content), ordinal: index })),
  { message_id: "live-tail", role: "assistant", content_json: '"live tail body"', ordinal: 180 }])
  expect(f.app.prepare("SELECT message_count,next_ordinal FROM thread_message_buckets").get())
    .toEqual({ message_count: 181, next_ordinal: 181 })
  expect(f.app.prepare("SELECT checkpoint_id,total_messages,next_index,status FROM legacy_checkpoint_transcript_migrations")
    .get()).toEqual({ checkpoint_id: ORIGINAL, total_messages: 180, next_index: 180, status: "complete" })
}

it("continues the original partial 64/180 source when a new summary head retains only 50 rows", () => {
  const f = fixture()
  seedPartial(f)
  f.appendLatest()
  const result = f.bootstrap()
  console.info("V1 original-source resume", { stats: result.stats,
    tail: f.app.prepare("SELECT ordinal FROM thread_messages WHERE message_id='live-tail'").get(),
    count: f.app.prepare("SELECT COUNT(*) AS total FROM thread_messages").get() })
  expect(result.stats).toMatchObject({ checkpointId: ORIGINAL, totalMessages: 180, migratedMessages: 116 })
  expectComplete(f)
  expect(result.runtimeTuple).toMatchObject({ config: { configurable: { checkpoint_id: LATEST } },
    checkpoint: { channel_values: { todos: [{ content: LATEST }] } } })
  expect((result.runtimeTuple as { checkpoint: { channel_values: object } }).checkpoint.channel_values)
    .toHaveProperty("messages", [])
  f.bootstrap()
  expectComplete(f)
})

it("resumes a deployed base-only inline source without constructing historical projection storage", () => {
  const f = fixture()
  f.checkpoint.exec("DROP TABLE checkpoint_message_snapshots; DROP TABLE checkpoint_runtime_projections")
  seedPartial(f, false)
  f.appendLatest()
  const result = f.bootstrap()
  expect(result.stats).toMatchObject({ checkpointId: ORIGINAL, totalMessages: 180, migratedMessages: 116 })
  expectComplete(f)
  const row = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?").get(ORIGINAL)!
  expect(JSON.parse(Buffer.from(row.checkpoint as Uint8Array).toString("utf8"))
    .channel_values.messages).toHaveLength(180)
  expect(f.checkpoint.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('checkpoint_message_snapshots','checkpoint_runtime_projections')`).all()).toEqual([])
})

it.each(["checkpoint", "message-chain"] as const)(
  "preserves every partial row and marker without writes when its original %s was pruned", source => {
    const f = fixture()
    seedPartial(f)
    f.appendLatest()
    f.checkpoint.prepare(source === "checkpoint" ? "DELETE FROM checkpoints WHERE checkpoint_id=?" :
      "DELETE FROM checkpoint_message_snapshots WHERE checkpoint_id=?").run(ORIGINAL)
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    const checkpointVersion = f.checkpoint.prepare("PRAGMA data_version").get()
    expect(() => f.bootstrap()).toThrow("LEGACY_CHECKPOINT_TRANSCRIPT_SOURCE_UNAVAILABLE")
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
    expect(f.checkpoint.prepare("PRAGMA data_version").get()).toEqual(checkpointVersion)
  }
)

it("keeps a complete transcript readable after source pruning without pretending timing enrichment completed", () => {
  const f = fixture()
  f.bootstrap()
  expectComplete(f)
  f.appendLatest()
  f.checkpoint.prepare("DELETE FROM checkpoints WHERE checkpoint_id=?").run(ORIGINAL)
  f.app.prepare("INSERT INTO thread_legacy_message_times VALUES('thread',?,NULL)")
    .run(JSON.stringify([{ "historical-0": { start_at: "2026-11-01T00:00:00.000Z" } }, [], {}, []]))
  const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
  const result = f.bootstrap()
  expect(result.stats).toMatchObject({ checkpointId: ORIGINAL, totalMessages: 180, migratedMessages: 0, batches: 0 })
  expectComplete(f)
  expect(appSnapshot(f.app)).toEqual(before)
  expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
  const page = readThreadMessagesPage(f.app, { type: "read-page", requestId: 1,
    databasePath: f.appPath, threadId: "thread", options: { limit: 128, byteBudget: 1024 * 1024,
      includeVisibleMessagePresence: true }, cancellationBuffer: new SharedArrayBuffer(4) }).page
  expect(page).toMatchObject({ total: 181, hasVisibleMessages: true,
    legacyCheckpointMigrationStatus: "complete", legacyMessageTimesPending: true })
  expect(page.messages.at(-1)).toMatchObject({ id: "live-tail", content: "live tail body" })
  expect(result.runtimeTuple).toMatchObject({ config: { configurable: { checkpoint_id: LATEST } },
    checkpoint: { channel_values: { todos: [{ content: LATEST }] } } })
})

it.each(["ambiguous-namespace", "bad-progress"] as const)(
  "rejects %s without replacing the original partial marker or shifting its tail", condition => {
    const f = fixture()
    seedPartial(f)
    f.appendLatest()
    if (condition === "ambiguous-namespace") f.put(ORIGINAL, history(), "foreign")
    else f.app.exec("UPDATE legacy_checkpoint_transcript_migrations SET next_index=181")
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    const checkpointVersion = f.checkpoint.prepare("PRAGMA data_version").get()
    expect(() => f.bootstrap()).toThrow("LEGACY_CHECKPOINT_TRANSCRIPT_SOURCE_UNAVAILABLE")
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
    expect(f.checkpoint.prepare("PRAGMA data_version").get()).toEqual(checkpointVersion)
  }
)

function patchLatest(f: ReturnType<typeof fixture>, change: (value: {
  channel_values: Record<string, unknown>
}) => void) {
  const row = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?").get(LATEST)!
  const value = JSON.parse(Buffer.from(row.checkpoint as Uint8Array).toString("utf8"))
  change(value)
  f.checkpoint.prepare("UPDATE checkpoints SET checkpoint=? WHERE checkpoint_id=?")
    .run(Buffer.from(JSON.stringify(value)), LATEST)
}

function createRoot(f: ReturnType<typeof fixture>, current = true) {
  f.app.exec(`CREATE TABLE function_logical_sessions(logical_session_id TEXT PRIMARY KEY,
    thread_id TEXT,incarnation_key TEXT);
    CREATE TABLE function_conversations(logical_session_id TEXT,kind TEXT,invocation_id TEXT)`)
  f.app.prepare("INSERT INTO function_logical_sessions VALUES('session','thread',?)")
    .run(JSON.stringify(current ? ["legacy", 1] : ["token", "another-incarnation"]))
  f.app.exec("INSERT INTO function_conversations VALUES('session','main','')")
}

it.each(["channel", "hidden-stamp"] as const)(
  "rejects a partial ordinary resume after current head gains a native %s", kind => {
    const f = fixture()
    seedPartial(f)
    f.appendLatest()
    patchLatest(f, value => {
      if (kind === "channel") value.channel_values.cmbFunctionConversation = { invalid: true }
      else (value.channel_values.messages as Array<{ additional_kwargs: object }>)[0]
        .additional_kwargs = { lc_source: "summarization", function_row_invalid: false }
    })
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    const checkpointVersion = f.checkpoint.prepare("PRAGMA data_version").get()
    expect(() => f.bootstrap()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
    expect(f.checkpoint.prepare("PRAGMA data_version").get()).toEqual(checkpointVersion)
  }
)

it.each([true, false])("uses the actual current-incarnation native root; current=%s", current => {
  const f = fixture()
  seedPartial(f)
  f.appendLatest()
  createRoot(f, current)
  if (current) {
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    expect(() => f.bootstrap()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
  } else {
    f.bootstrap()
    expectComplete(f)
  }
})

it.each([true, false])("respects a native destination even without a logical-session row; current=%s", current => {
  const f = fixture()
  seedPartial(f)
  f.appendLatest()
  f.app.exec(`CREATE TABLE function_conversation_native_destinations(
    destination_thread_id TEXT,destination_incarnation TEXT)`)
  f.app.prepare("INSERT INTO function_conversation_native_destinations VALUES('thread',?)")
    .run(JSON.stringify({ token: current ? null : "another-incarnation", legacyCreatedAt: 1 }))
  if (current) {
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    expect(() => f.bootstrap()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
  } else {
    f.bootstrap()
    expectComplete(f)
  }
})

it.each(["native-head", "native-root"] as const)(
  "keeps completed timing pending and performs no AppDB writes after %s", kind => {
    const f = fixture()
    f.bootstrap()
    f.appendLatest()
    f.app.prepare("INSERT INTO thread_legacy_message_times VALUES('thread',?,NULL)")
      .run(JSON.stringify([{ "historical-0": { start_at: "2026-11-01T00:00:00.000Z" } }, [], {}, []]))
    if (kind === "native-head")
      patchLatest(f, value => { value.channel_values.cmbFunctionConversation = { invalid: true } })
    else createRoot(f)
    const before = appSnapshot(f.app), version = f.app.prepare("PRAGMA data_version").get()
    const result = f.bootstrap()
    expect(result.stats).toMatchObject({ checkpointId: ORIGINAL, totalMessages: 180,
      migratedMessages: 0, batches: 0 })
    expectComplete(f)
    expect(appSnapshot(f.app)).toEqual(before)
    expect(f.app.prepare("PRAGMA data_version").get()).toEqual(version)
    expect(result.runtimeTuple).toMatchObject({ config: { configurable: { checkpoint_id: LATEST } },
      checkpoint: { channel_values: { messages: [], todos: [{ content: LATEST }] } } })
  }
)

it("does not reject a legal 5 MiB non-message channel on the new ordinary head", () => {
  const f = fixture()
  seedPartial(f)
  f.appendLatest()
  patchLatest(f, value => { value.channel_values.legalState = "x".repeat(5 * 1024 * 1024) })
  const result = f.bootstrap()
  expectComplete(f)
  expect(result.runtimeTuple).toMatchObject({ config: { configurable: { checkpoint_id: LATEST } },
    checkpoint: { channel_values: { messages: [] } } })
  expect(JSON.stringify(result.runtimeTuple).length).toBeLessThan(4096)
})

it("prepares only worker-local normalized source when a driver supplies the fixed Main state", () => {
  const f = fixture()
  seedPartial(f)
  f.appendLatest()
  const before = appSnapshot(f.app)
  const source = prepareLegacyCheckpointTranscriptSource(f.checkpointPath, "thread", "", {
    ordinary: true, marker: { checkpointId: ORIGINAL, totalMessages: 180, nextIndex: 64,
      fragmentIndex: 0, status: "migrating" }
  }, new SharedArrayBuffer(4))
  expect(source).toMatchObject({ kind: "source", checkpointId: ORIGINAL, complete: false })
  if (source.kind !== "source") throw Error("Expected original source")
  expect(source.messages).toHaveLength(180)
  expect(source.messages[179]).toMatchObject({ messageId: "historical-179",
    contentJson: JSON.stringify(history()[179].content) })
  expect(appSnapshot(f.app)).toEqual(before)
})


// These spies observe only complete legacy message arrays, not per-message body
// serialization. They prove allocation work disappears without timing assertions.
function countWholeLegacyArrays() {
  const stringify = JSON.stringify
  let calls = 0
  vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
    if (Array.isArray(value) && value.some(item => item && typeof item === "object" &&
      typeof item.id === "string" && item.id.startsWith("historical-"))) calls++
    return Reflect.apply(stringify, JSON, [value, ...rest])
  })
  return () => calls
}

it.each(["base-only", "runtime-only"] as const)(
  "does not materialize unused whole-message projection buffers with %s storage", kind => {
    const f = fixture()
    f.checkpoint.exec("DROP TABLE checkpoint_message_snapshots")
    if (kind === "base-only") f.checkpoint.exec("DROP TABLE checkpoint_runtime_projections")
    const row = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?")
      .get(ORIGINAL)!.checkpoint as Uint8Array
    const expectedBytes = Math.max(row.byteLength,
      Buffer.byteLength(JSON.stringify(history()), "utf8"))
    const before = f.checkpoint.prepare("SELECT name FROM sqlite_master ORDER BY name").all()
    const version = f.checkpoint.prepare("PRAGMA data_version").get()
    const wholeArrays = countWholeLegacyArrays()
    const source = prepareLegacyCheckpointTranscriptSource(f.checkpointPath, "thread", "", {
      marker: null, ordinary: true
    }, new SharedArrayBuffer(4))
    expect(wholeArrays()).toBe(0)
    expect(source).toMatchObject({ kind: "source", checkpointId: ORIGINAL,
      payloadBytes: expectedBytes, complete: false })
    if (source.kind !== "source") throw Error("Expected original source")
    expect(source.messages.map(message => message.contentJson))
      .toEqual(history().map(message => JSON.stringify(message.content)))
    expect(f.checkpoint.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(before)
    expect(f.checkpoint.prepare("PRAGMA data_version").get()).toEqual(version)
    expect(f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?")
      .get(ORIGINAL)!.checkpoint).toEqual(row)
    if (kind === "runtime-only")
      expect(f.checkpoint.prepare("SELECT COUNT(*) AS count FROM checkpoint_runtime_projections")
        .get()!.count).toBe(0)
  }
)

it("counts historical external messages without another whole-array serialization", () => {
  const f = fixture()
  seedPartial(f)
  const expectedBytes = Buffer.byteLength(JSON.stringify(history()), "utf8")
  const row = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?")
    .get(ORIGINAL)!.checkpoint as Uint8Array
  expect(expectedBytes).toBeGreaterThan(row.byteLength)
  const wholeArrays = countWholeLegacyArrays()
  const source = prepareLegacyCheckpointTranscriptSource(f.checkpointPath, "thread", "", {
    ordinary: true, marker: { checkpointId: ORIGINAL, totalMessages: 180, nextIndex: 64,
      fragmentIndex: 0, status: "migrating" }
  }, new SharedArrayBuffer(4))
  expect(wholeArrays()).toBe(0)
  expect(source).toMatchObject({ kind: "source", payloadBytes: expectedBytes })
})

it("retains actual auxiliary projection publication when both schemas are available", () => {
  const f = fixture()
  const row = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?")
    .get(ORIGINAL)!.checkpoint as Uint8Array
  const source = prepareLegacyCheckpointTranscriptSource(f.checkpointPath, "thread", "", {
    marker: null, ordinary: true
  }, new SharedArrayBuffer(4))
  expect(source).toMatchObject({ kind: "source", payloadBytes: Math.max(row.byteLength,
    Buffer.byteLength(JSON.stringify(history()), "utf8")) })
  expect(f.checkpoint.prepare("SELECT message_count FROM checkpoint_message_snapshots")
    .get()!.message_count).toBe(180)
  expect(f.checkpoint.prepare("SELECT checkpoint_id FROM checkpoint_runtime_projections")
    .get()!.checkpoint_id).toBe(ORIGINAL)
  expect(JSON.parse(Buffer.from(f.checkpoint.prepare("SELECT checkpoint FROM checkpoints")
    .get()!.checkpoint as Uint8Array).toString()).channel_values.messages)
    .toEqual({ __cmb_sqljs_external_messages_v1: true, messageCount: 180 })
})

it("keeps exact parsed JSON byte accounting and a legal oversized message", () => {
  const f = fixture()
  const content = "大😀\\\n\u0000\ud800".repeat(130000)
  const messages = [null, true, 17, "primitive", { type: "human", id: "historical-large",
    content, toJSON: { inert: true }, extra: { overflow: "NUMBER_OVERFLOW" } },
  { type: "ai", id: "historical-tail", content: "tail\udfff", toJSON: "data" }]
  const checkpoint = { v: 1, id: ORIGINAL, ts: "2026-11-01T00:00:00.000Z",
    channel_values: { messages }, channel_versions: {}, versions_seen: {}, pending_sends: [] }
  const raw = JSON.stringify(checkpoint).replace('"NUMBER_OVERFLOW"', '1e400')
  f.checkpoint.prepare("UPDATE checkpoints SET checkpoint=? WHERE checkpoint_id=?")
    .run(Buffer.from(raw), ORIGINAL)
  const parsedMessages = JSON.parse(raw).channel_values.messages
  const expectedBytes = Buffer.byteLength(JSON.stringify(parsedMessages), "utf8")
  // Publish the real external chain first; its small raw row cannot mask a byte
  // accounting error in the hydrated messages.
  f.bootstrap()
  const stored = f.checkpoint.prepare("SELECT checkpoint FROM checkpoints WHERE checkpoint_id=?")
    .get(ORIGINAL)!.checkpoint as Uint8Array
  expect(expectedBytes).toBeGreaterThan(stored.byteLength)
  const wholeArrays = countWholeLegacyArrays()
  const source = prepareLegacyCheckpointTranscriptSource(f.checkpointPath, "thread", "", {
    ordinary: true, marker: { checkpointId: ORIGINAL, totalMessages: 2, nextIndex: 1,
      fragmentIndex: 0, status: "migrating" }
  }, new SharedArrayBuffer(4))
  expect(wholeArrays()).toBe(0)
  expect(source).toMatchObject({ kind: "source", payloadBytes: expectedBytes })
  if (source.kind !== "source") throw Error("Expected original source")
  expect(source.messages).toHaveLength(2)
  expect(source.messages[0].contentFragments?.join("")).toBe(content)
  expect(source.messages[1].contentJson).toBe(JSON.stringify("tail\udfff"))
})
