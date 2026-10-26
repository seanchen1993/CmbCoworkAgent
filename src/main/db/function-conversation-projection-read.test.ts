import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationRawProjection }
  from "./function-conversation-projection-receipt"
import { assertStoredProjectionReceipt } from "./function-conversation-projection-seal"
import { findFunctionConversationProjectionMarkers,
  hasFunctionConversationProjectionMarker, withFunctionConversationProjectionReadScope,
  readStoredFunctionConversationProjection, readSealedFunctionConversationProjectionPresentation,
  readStoredFunctionConversationProjectionPresentationSummary,
  runFunctionConversationProjectionGuard, type FunctionConversationProjectionReadScope }
  from "./function-conversation-projection-read"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-projection-fresh-read-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(child = false, assistant = false) {
  const database = appDb.getDb(), logicalThreadId = randomUUID()
  const logicalThread = appDb.createThread(logicalThreadId, { workspacePath: directory })
  const logicalIncarnation = captureThreadIncarnation(logicalThread)
  const store = new FunctionConversationStore(database)
  const main = store.ensureMain({ threadId: logicalThreadId, workspace: directory,
    incarnation: logicalIncarnation,
    checkpointNamespace: "" }, () => undefined)
  const target = child ? store.createChild(main, { invocationId: randomUUID(),
    checkpointNamespace: "actual-child" }, () => undefined) : main
  const threadId = child ? randomUUID() : logicalThreadId
  const thread = child ? appDb.createThread(threadId, { workspacePath: directory }) : logicalThread
  const incarnation = captureThreadIncarnation(thread)
  const uuid = randomUUID(), content = [{ type: "text" as const, text: "actual safe row" }]
  const role = assistant ? "assistant" : "user"
  const native = assistant ? new AIMessage({ id: uuid, content })
    : new HumanMessage({ id: uuid, content, additional_kwargs: { isMeta: true } })
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
    role, content, content_mode: "snapshot", created_at: new Date(row.createdAt) }),
  { conversation: target, threadId, incarnation, assertCurrent: () => store.assertCurrent(target) })
  const row = store.commit(target, { uuid, inputDigest: uuid, door: assistant ? "response" : "note",
    origin: assistant ? { kind: "model", model: "actual-durable-model" }
      : { kind: "plugin", name: "actual-source" }, message: { type: role, role,
      ...(assistant ? {} : { isMeta: true }), content },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: assistant ? "native-producer" : "sdk-note" },
    sdk: !assistant, inbox: !assistant }, () => undefined, access.write, access.verify)
  const input = { threadId, incarnation, messageId: uuid, assertCurrent: () => store.assertCurrent(target) }
  return { database, threadId, uuid, target, store, row, input }
}

describe("fresh joined canonical read and exact private composition", () => {
  it("reads fresh complete A/B without exec/all or writes and shares only the explicit operation", () => {
    const database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
    let joinedReads = 0, schemaReads = 0
    const read = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const actual = prepare(sql)
      return bindings => {
        if (sql.includes("AS keeper_payload_json")) joinedReads++
        else if (sql.includes("AS receipt_schema")) schemaReads++
        return actual(bindings)
      }
    })
    const f = fixture(), original = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    const exec = vi.spyOn(f.database, "exec"), run = vi.spyOn(f.database, "run")
    joinedReads = 0
    schemaReads = 0
    const result = appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      const columns = reader.readColumns(f.uuid)
      const snapshot = reader.readSnapshot(f.uuid)
      if (!snapshot) throw Error("ACTUAL_SNAPSHOT_MISSING")
      const partition = reader.partition([snapshot])
      return { columns, snapshot, partition }
    })
    expect(result.partition.canonicalCount).toBe(1)
    expect(result.partition.ordinary).toHaveLength(0)
    expect(result.partition.canonical).toEqual([result.snapshot])
    expect(exec.mock.calls.every(([sql]) => !/function_conversation_rows|projection_receipts|thread_messages\b/.test(sql)))
      .toBe(true)
    expect(run).not.toHaveBeenCalled()
    expect(read.mock.calls.filter(([sql]) => sql.includes("AS keeper_payload_json"))).toHaveLength(1)
    expect(joinedReads).toBe(2)
    expect(schemaReads).toBe(0)
    expect(Object.isFrozen(result.snapshot)).toBe(true)
    expect(Object.isFrozen(result.columns)).toBe(true)
    expect(result.columns).toEqual(original)
    expect(Object.keys(result.columns ?? {})).toHaveLength(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length)
    expect(result.columns?.goal_id).toBeNull()
    expect(result.columns?.reasoning).toBeNull()
  })

  it.each([false, true])("keeps large history untouched and rejects final same-id recreation=%s", recreate => {
    const f = fixture(), row = appDb.getThreadCore(f.threadId)!
    const metadata = JSON.stringify({ ...JSON.parse(row.metadata!),
      llmFileHistory: "历史🙂".repeat(20_000), retainedScope: { enabled: true } })
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, f.threadId])
    const writes = vi.spyOn(f.database, "run")
    const read = () => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      const result = reader.requireSnapshotAndPresentation(f.uuid)
      if (recreate) reader.runGuard(() => {
        f.database.run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
        appDb.createThread(f.threadId, { workspacePath: directory })
        f.database.run("UPDATE threads SET created_at=? WHERE thread_id=?",
          [row.created_at, f.threadId])
      })
      return result
    })
    if (recreate) {
      expect(read).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
      expect(appDb.getThreadCore(f.threadId)?.created_at).toBe(row.created_at)
    } else {
      expect(read().snapshot.id).toBe(f.uuid)
      expect(writes).not.toHaveBeenCalled()
      expect(appDb.getThreadCore(f.threadId)?.metadata).toBe(metadata)
    }
  })

  it("reads snapshot and presentation together and still rejects a later source mutation", () => {
    const f = fixture()
    const observed = appDb.withCanonicalThreadMessageReadScope(f.threadId,
      reader => reader.readSnapshotAndPresentation(f.uuid))
    expect(observed?.snapshot.id).toBe(f.uuid)
    expect(observed?.presentation.kind).toBe("visible")
    expect(observed?.presentation.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      reader.readSnapshotAndPresentation(f.uuid)
      reader.runGuard(() => f.database.run(
        "UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
        [JSON.stringify("late replacement"), f.threadId, f.uuid]))
    })).toThrow()
  })

  it.each(["stamp", "row", "receipt"])(
    "required canonical reads reject a missing %s instead of using ordinary classification", kind => {
      const f = fixture()
      const before = appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.requireSnapshotAndPresentation(f.uuid))
      expect(before.snapshot.id).toBe(f.uuid)
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : kind === "row" ? "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?"
          : "DELETE FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?",
      [f.threadId, f.uuid])
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.requireSnapshotAndPresentation(f.uuid))).toThrow()
    })

  it("required canonical reads reject genuine ordinary and nonexistent messages", () => {
    const f = fixture(), ordinary = randomUUID()
    appDb.upsertThreadMessages(f.threadId, [{ id: ordinary, role: "user",
      content: "ordinary input", created_at: new Date(1) }])
    for (const uuid of [ordinary, randomUUID()]) {
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.requireSnapshotAndPresentation(uuid))).toThrow()
    }
  })

  it("reads presentation data only from the exact full-seal scope and columns", () => {
    const f = fixture()
    let savedScope: FunctionConversationProjectionReadScope | undefined
    let savedColumns: ReturnType<typeof readStoredFunctionConversationProjection> | undefined
    const presentation = withFunctionConversationProjectionReadScope(f.database, scope => {
      const columns = readStoredFunctionConversationProjection(f.database, f.input, scope)
      savedScope = scope; savedColumns = columns
      const original = readSealedFunctionConversationProjectionPresentation(f.database, scope, columns)
      expect(original.kind).toBe("visible")
      expect(original.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(() => readSealedFunctionConversationProjectionPresentation(f.database, scope,
        { ...columns })).toThrow()
      expect(() => withFunctionConversationProjectionReadScope(f.database, different =>
        readSealedFunctionConversationProjectionPresentation(f.database, different, columns))).toThrow()
      return original
    })
    expect(presentation.kind).toBe("visible")
    if (!savedScope || !savedColumns) throw Error("ACTUAL_FULL_SEAL_MISSING")
    const retiredScope = savedScope, retiredColumns = savedColumns
    expect(() => readSealedFunctionConversationProjectionPresentation(f.database, retiredScope,
      retiredColumns)).toThrow()
  })

  it("does not expose presentation evidence while the actual scope is suspended", () => {
    const f = fixture()
    expect(() => withFunctionConversationProjectionReadScope(f.database, scope => {
      const columns = readStoredFunctionConversationProjection(f.database, f.input, scope)
      runFunctionConversationProjectionGuard(scope, () =>
        readSealedFunctionConversationProjectionPresentation(f.database, scope, columns))
    })).toThrow()
  })

  it("does not return a former legacy-visible decision after a ledger appears in the source guard", () => {
    const f = fixture()
    let published = false
    expect(() => {
      const value = appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
        const presentation = reader.readPresentation(f.uuid)
        expect(presentation?.kind).toBe("visible")
        reader.runGuard(() => f.database.run(`INSERT INTO function_conversation_presentation_dispositions
          (thread_id,incarnation,uuid,target_json,canonical_receipt_id,canonical_row_digest,
           native_payload_digest,projection_digest,anchor_digest,intent_digest,disposition,version)
          SELECT thread_id,incarnation,uuid,target_json,canonical_receipt_id,canonical_row_digest,
            native_payload_digest,projection_digest,? ,? ,'blank',1
          FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?`,
        ["0".repeat(64), "1".repeat(64), f.threadId, f.uuid]))
        return presentation
      })
      published = value !== undefined
    }).toThrow()
    expect(published).toBe(false)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)?.content_json)
      .not.toBe(JSON.stringify(""))
  })

  it.each(["stamp", "row"] as const)(
    "rejects a public snapshot after the actual canonical %s is deleted", kind => {
      const f = fixture()
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.uuid])
      expect(() => appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toThrow()
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
    })

  it.each(["stamp", "row"] as const)(
    "rejects both exact reader methods after the actual canonical %s is deleted", kind => {
      const f = fixture()
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.uuid])
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.readColumns(f.uuid))).toThrow()
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.readSnapshot(f.uuid))).toThrow()
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId,
        reader => reader.readSnapshotAndPresentation(f.uuid))).toThrow()
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
    })

  it.each(["stamp", "row"] as const)(
    "does not downgrade a deleted canonical %s to an ordinary echo", kind => {
      const f = fixture(), snapshot = appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)
      if (!snapshot) throw Error("ACTUAL_SNAPSHOT_MISSING")
      const ordinary = { ...snapshot, function_row: undefined }
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.uuid])
      expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [ordinary])).toThrow()
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
    })

  it.each(["stamp", "row"] as const)(
    "does not let the old writer replace a deleted canonical %s", kind => {
      const f = fixture()
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.uuid])
      expect(() => appDb.upsertThreadMessages(f.threadId, [{ id: f.uuid, role: "user",
        content: "unacknowledged replacement", created_at: new Date(1) }])).toThrow()
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
      const raw = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
      expect(kind === "row" ? raw : raw?.function_row_json).toBe(kind === "row" ? undefined : null)
      expect(raw?.content_json).not.toBe(JSON.stringify("unacknowledged replacement"))
    })

  it("does not downgrade a stale incarnation receipt after the marker is removed", () => {
    const f = fixture()
    f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.threadId])
    f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
      [f.threadId, f.uuid])
    expect(() => appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid)).toThrow()
  })

  it("keeps genuine ordinary messages on the original read, partition and writer paths", () => {
    const f = fixture(), uuid = randomUUID()
    const row = { id: uuid, role: "user" as const, content: "ordinary legacy input",
      created_at: new Date(1) }
    expect(appDb.upsertThreadMessages(f.threadId, [row])).toBe(1)
    expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, uuid)).toBeUndefined()
    const partition = appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [row])
    expect(partition.ordinary).toEqual([row])
    expect(partition.canonicalCount).toBe(0)
    expect(appDb.upsertThreadMessages(f.threadId, [{ ...row, content: "ordinary edited input" }])).toBe(1)
  })

  it.each(["absent", "missing-column", "same-count-wrong-column"])(
    "rejects a fresh %s projection schema before reading a seal", kind => {
      const database = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`),
        "actual incomplete projection schema").database
      try {
        database.run("CREATE TABLE function_conversation_projection_receipts(thread_id TEXT)")
        if (kind !== "absent") {
          const columns: string[] = FUNCTION_CONVERSATION_PROJECTION_COLUMNS.slice(0, -1)
          if (kind === "same-count-wrong-column") columns.push("unexpected_projection_column")
          database.run(`CREATE TABLE thread_messages(${columns.map(name => `${name} TEXT`).join(",")})`)
        }
        expect(() => assertStoredProjectionReceipt(database, {
          threadId: "thread", messageId: "message",
          incarnation: { token: "owned-token", legacyCreatedAt: 1 }, assertCurrent: () => undefined
        })).toThrow("MODS_CONVERSATION_PROJECTION_SCHEMA")
      } finally { database.close({ checkpoint: false }) }
    })

  it.each(["missing", "view"] as const)(
    "rejects a %s receipt table with the original migration error", kind => {
      const f = fixture(), table = "function_conversation_projection_receipts"
      // Warm the compiled statement first; schema changes must still be observed.
      assertStoredProjectionReceipt(f.database, f.input)
      f.database.run(`ALTER TABLE ${table} RENAME TO receipt_test_backup`)
      try {
        if (kind === "view") f.database.run(`CREATE VIEW ${table} AS SELECT * FROM receipt_test_backup`)
        expect(() => assertStoredProjectionReceipt(f.database, f.input))
          .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
      } finally {
        if (kind === "view") f.database.run(`DROP VIEW ${table}`)
        f.database.run(`ALTER TABLE receipt_test_backup RENAME TO ${table}`)
      }
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).not.toThrow()
    }
  )

  it.each(["missing-receipts", "view-receipts", "wrong-column"] as const)(
    "rejects final B %s even after a valid initial observation", kind => {
      const f = fixture(), table = "function_conversation_projection_receipts"
      let calls = 0, changed = false
      try {
        expect(() => assertStoredProjectionReceipt(f.database, { ...f.input, assertCurrent: () => {
          f.input.assertCurrent()
          if (++calls !== 2) return
          if (kind === "wrong-column") {
            f.database.run("ALTER TABLE thread_messages RENAME COLUMN reasoning TO unexpected_reasoning")
          } else {
            f.database.run(`ALTER TABLE ${table} RENAME TO receipt_test_backup`)
            if (kind === "view-receipts")
              f.database.run(`CREATE VIEW ${table} AS SELECT * FROM receipt_test_backup`)
          }
          changed = true
        } })).toThrow(kind === "wrong-column" ? "MODS_CONVERSATION_PROJECTION_SCHEMA" :
          "MODS_CONVERSATION_MIGRATION_REQUIRED")
      } finally {
        if (changed) {
          if (kind === "wrong-column")
            f.database.run("ALTER TABLE thread_messages RENAME COLUMN unexpected_reasoning TO reasoning")
          else {
            if (kind === "view-receipts") f.database.run(`DROP VIEW ${table}`)
            f.database.run(`ALTER TABLE receipt_test_backup RENAME TO ${table}`)
          }
        }
      }
      expect(changed).toBe(true)
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).not.toThrow()
    }
  )

  it("reads genuine old schema presence without creating or writing a receipt table", () => {
    const database = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`),
      "actual old projection schema").database
    try {
      database.run("CREATE TABLE thread_messages(thread_id TEXT,message_id TEXT,function_row_json TEXT)")
      database.run("INSERT INTO thread_messages VALUES(?,?,?)", ["old-thread", "ordinary", null])
      database.run("INSERT INTO thread_messages VALUES(?,?,?)", ["old-thread", "marked", "actual marker"])
      const writes = vi.spyOn(database, "run")
      expect(hasFunctionConversationProjectionMarker(database, "old-thread", "ordinary")).toBe(false)
      expect(hasFunctionConversationProjectionMarker(database, "old-thread", "missing")).toBe(false)
      expect(hasFunctionConversationProjectionMarker(database, "old-thread", "marked")).toBe(true)
      expect(writes).not.toHaveBeenCalled()
      expect(database.exec("SELECT name FROM sqlite_master WHERE type='table'" )[0]?.values)
        .toEqual([["thread_messages"]])
    } finally { database.close({ checkpoint: false }) }
  })

  it.each(["receipt", "ledger"] as const)(
    "checks fresh %s evidence even when the old message schema has no marker column", evidence => {
      const database = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`),
        "actual old schema evidence").database
      try {
        database.run("CREATE TABLE thread_messages(thread_id TEXT,message_id TEXT)")
        database.run("INSERT INTO thread_messages VALUES(?,?)", ["old-thread", "ordinary"])
        expect(hasFunctionConversationProjectionMarker(database, "old-thread", "ordinary")).toBe(false)
        expect(findFunctionConversationProjectionMarkers(database, "old-thread", ["ordinary", "missing"]))
          .toEqual(new Set())
        const table = evidence === "receipt" ? "function_conversation_projection_receipts"
          : "function_conversation_presentation_dispositions"
        database.run(`CREATE TABLE ${table}(thread_id TEXT,incarnation TEXT,uuid TEXT)`)
        database.run(`INSERT INTO ${table} VALUES(?,?,?)`, ["old-thread", "retired-incarnation", "ordinary"])
        const writes = vi.spyOn(database, "run")
        expect(hasFunctionConversationProjectionMarker(database, "old-thread", "ordinary")).toBe(true)
        expect(hasFunctionConversationProjectionMarker(database, "old-thread", "missing")).toBe(false)
        expect(findFunctionConversationProjectionMarkers(database, "old-thread", ["ordinary", "missing"]))
          .toEqual(new Set(["ordinary"]))
        expect(writes).not.toHaveBeenCalled()
        writes.mockRestore()
        database.run(`DELETE FROM ${table}`)
        expect(hasFunctionConversationProjectionMarker(database, "old-thread", "ordinary")).toBe(false)
        expect(findFunctionConversationProjectionMarkers(database, "old-thread", ["ordinary"]))
          .toEqual(new Set())
      } finally { database.close({ checkpoint: false }) }
    })

  it("does not let a provider occurrence alias bypass a deleted marker", () => {
    const f = fixture()
    f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
      [f.threadId, f.uuid])
    expect(() => appDb.upsertThreadMessages(f.threadId, [{ id: randomUUID(), role: "user",
      provider_source_id: f.uuid, provider_occurrence: 1,
      content: "unacknowledged provider alias", created_at: new Date(1) }])).toThrow()
    expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
  })

  it.each(["stamp", "row"] as const)(
    "does not let a late ordinary assistant delta bypass a deleted canonical %s", kind => {
      const f = fixture(false, true)
      f.database.run(kind === "stamp"
        ? "UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?"
        : "DELETE FROM thread_messages WHERE thread_id=? AND message_id=?", [f.threadId, f.uuid])
      expect(() => appDb.appendThreadMessageTextDelta(f.threadId, { id: f.uuid, role: "assistant",
        content: "late raw fragment", provider_source_id: f.uuid, provider_occurrence: 1,
        created_at: new Date(1) })).toThrow()
      expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=?",
        [f.threadId])[0]?.values).toEqual([[0]])
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
    })

  it.each(["source", "target"] as const)(
    "does not let an ID replacement bypass a deleted canonical %s marker", side => {
      const f = fixture(), ordinaryId = randomUUID()
      appDb.upsertThreadMessages(f.threadId, [{ id: ordinaryId, role: "user",
        content: "ordinary actual source", created_at: new Date(1) }])
      f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
        [f.threadId, f.uuid])
      expect(() => appDb.replaceThreadMessageId(f.threadId,
        side === "source" ? f.uuid : ordinaryId,
        side === "source" ? ordinaryId : f.uuid, "user")).toThrow()
      expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
      expect(readFunctionConversationRawProjection(f.database, f.threadId, ordinaryId)?.content_json)
        .toBe(JSON.stringify("ordinary actual source"))
    })

  it("bounds batched presence bindings and observes real second-connection changes", () => {
    const f = fixture(), ids = Array.from({ length: 1025 }, () => randomUUID())
    ids[512] = f.uuid
    const second = openNativeSqliteDatabase(paths.database, "actual marker second connection").database
    const prepare = vi.spyOn(f.database, "prepareReadOne")
    const writes = vi.spyOn(f.database, "run")
    try {
      expect([...findFunctionConversationProjectionMarkers(f.database, f.threadId, ids)]).toEqual([f.uuid])
      const batch = prepare.mock.calls.filter(([sql]) => sql.includes("WITH wanted(uuid)"))
      expect(batch.length).toBeGreaterThan(0)
      expect(batch.every(([sql]) => (sql.match(/\?/g) ?? []).length <= 514)).toBe(true)
      second.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
        [f.threadId, f.uuid])
      expect([...findFunctionConversationProjectionMarkers(f.database, f.threadId, ids)]).toEqual([f.uuid])
      second.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?",
        [f.threadId, f.uuid])
      expect([...findFunctionConversationProjectionMarkers(f.database, f.threadId, ids)]).toEqual([])
      expect(writes).not.toHaveBeenCalled()
    } finally { second.close({ checkpoint: false }) }
  })

  it("does not move a canonical occurrence with a deleted marker", () => {
    const f = fixture(), anchor = randomUUID(), before =
      readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    appDb.upsertThreadMessages(f.threadId, [{ id: anchor, role: "user", content: "ordinary anchor",
      created_at: new Date(1) }])
    f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
      [f.threadId, f.uuid])
    expect(() => appDb.moveThreadMessagesAfterAnchor(f.threadId, anchor, [f.uuid])).toThrow()
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)?.ordinal)
      .toBe(before?.ordinal)
    expect(f.store.readReceipt(f.target, f.uuid)).toEqual(f.row)
  })

  it("rechecks durable ownership after incoming delta field reads", () => {
    const f = fixture(false, true)
    const receipt = f.database.exec(`SELECT * FROM function_conversation_projection_receipts
      WHERE thread_id=? AND uuid=?`, [f.threadId, f.uuid])[0]
    const values = receipt?.values[0]
    if (!receipt || !values) throw Error("ACTUAL_RECEIPT_MISSING")
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?",
      [f.threadId, f.uuid])
    f.database.run(`UPDATE thread_messages SET function_row_json=NULL,content_json=?,
      provider_source_id=?,provider_occurrence=1 WHERE thread_id=? AND message_id=?`,
    [JSON.stringify("original damaged display"), f.uuid, f.threadId, f.uuid])
    let restored = false
    const incoming = { id: f.uuid, role: "assistant" as const, content: "late raw delta",
      provider_source_id: f.uuid, provider_occurrence: 1, created_at: new Date(1),
      get reasoning(): undefined {
        if (!restored) {
          restored = true
          f.database.run(`INSERT INTO function_conversation_projection_receipts
            (${receipt.columns.join(",")}) VALUES (${values.map(() => "?").join(",")})`, values)
        }
        return undefined
      } }
    expect(() => appDb.appendThreadMessageTextDelta(f.threadId, incoming)).toThrow()
    expect(restored).toBe(true)
    expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=?",
      [f.threadId])[0]?.values).toEqual([[0]])
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)?.content_json)
      .toBe(JSON.stringify("original damaged display"))
  })

  it("rolls back ordering when an ordinary row acquires durable ownership before SQL", () => {
    const f = fixture(), anchor = randomUUID(), newId = randomUUID()
    const ordinary = { id: anchor, role: "user" as const, content: "ordinary anchor",
      created_at: new Date(1) }
    appDb.upsertThreadMessages(f.threadId, [ordinary])
    const receipt = f.database.exec(`SELECT * FROM function_conversation_projection_receipts
      WHERE thread_id=? AND uuid=?`, [f.threadId, f.uuid])[0]
    const values = receipt?.values[0]
    if (!receipt || !values) throw Error("ACTUAL_RECEIPT_MISSING")
    f.database.run("UPDATE thread_messages SET function_row_json=NULL WHERE thread_id=? AND message_id=?",
      [f.threadId, f.uuid])
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?",
      [f.threadId, f.uuid])
    const before = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    const run = f.database.run.bind(f.database)
    let restored = false
    vi.spyOn(f.database, "run").mockImplementation((sql, parameters) => {
      if (!restored && /UPDATE thread_messages SET ordinal\s*=/.test(sql)) {
        restored = true
        run(`INSERT INTO function_conversation_projection_receipts (${receipt.columns.join(",")})
          VALUES (${values.map(() => "?").join(",")})`, values)
      }
      return run(sql, parameters)
    })
    expect(() => appDb.upsertThreadMessages(f.threadId, [{ id: newId, role: "user",
      content: "new before anchor", created_at: new Date(2) }, ordinary],
    { preserveExistingOrder: false })).toThrow()
    expect(restored).toBe(true)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(before)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, newId)).toBeUndefined()
  })

  it.each(["columns", "snapshot"] as const)(
    "does not publish an old absent %s after the real guard keeps that occurrence", kind => {
      const f = fixture(), uuid = randomUUID()
      const content = [{ type: "text" as const, text: "new actual canonical input" }]
      const native = new HumanMessage({ id: uuid, content })
      const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
        role: "user", content, content_mode: "snapshot", created_at: new Date(row.createdAt) }),
      { conversation: f.target, threadId: f.threadId, incarnation: f.input.incarnation,
        assertCurrent: f.input.assertCurrent })
      let published = false
      expect(() => {
        const value = appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
          const absent = kind === "columns" ? reader.readColumns(uuid) : reader.readSnapshot(uuid)
          expect(absent).toBeUndefined()
          reader.runGuard(() => {
            f.store.commit(f.target, { uuid, inputDigest: uuid, door: "note",
              origin: { kind: "plugin", name: "actual-source" },
              message: { type: "user", role: "user", isMeta: true, content },
              nativePayload: serializeFunctionConversationNativeMessage(native),
              orderAnchor: { kind: "sdk-note" }, sdk: true, inbox: true },
            () => undefined, access.write, access.verify)
          })
          return absent
        })
        published = value === undefined
      }).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
      expect(published).toBe(false)
      expect(f.store.readReceipt(f.target, uuid)?.nativePayload)
        .toBe(serializeFunctionConversationNativeMessage(native))
      expect(appDb.readCanonicalThreadMessageSnapshot(f.threadId, uuid)?.content).toEqual(content)
    })

  it("does not publish raw columns when an original tail guard changes a null field", () => {
    const f = fixture()
    let published = false
    expect(() => {
      const columns = appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
        const actual = reader.readColumns(f.uuid)
        expect(actual?.goal_id).toBeNull()
        reader.runGuard(() => f.database.run(
          "UPDATE thread_messages SET goal_id='new goal' WHERE thread_id=? AND message_id=?",
          [f.threadId, f.uuid]))
        return actual
      })
      published = !!columns
    }).toThrow()
    expect(published).toBe(false)
  })

  it.each(FUNCTION_CONVERSATION_PROJECTION_COLUMNS)("rejects final-guard mutation of raw %s", field => {
    const f = fixture(), raw = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    if (!raw) throw Error("ACTUAL_RAW_MISSING")
    let calls = 0
    expect(() => assertStoredProjectionReceipt(f.database, { ...f.input, assertCurrent: () => {
      f.input.assertCurrent()
      if (++calls === 2) {
        const prior = raw[field], changed = typeof prior === "number" ? prior + 1 : `${prior ?? ""} changed`
        f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
          [changed, f.threadId, f.uuid])
      }
    } })).toThrow()
    expect(calls).toBe(2)
  })

  it.each(["payload_json", "payload_digest", "bytes", "receipt_id", "sequence"])(
    "rejects final-guard changed Keeper %s", field => {
      const f = fixture()
      let calls = 0
      expect(() => assertStoredProjectionReceipt(f.database, { ...f.input, assertCurrent: () => {
        f.input.assertCurrent()
        if (++calls === 2) f.database.run(`UPDATE function_conversation_rows SET ${field}=?
          WHERE conversation_id=? AND uuid=?`, [field === "bytes" ? f.row.bytes + 1 :
          field === "sequence" ? f.row.sequence + 1 : "changed", f.target.conversationId, f.uuid])
      } })).toThrow()
    })

  it.each(["receipt", "physical", "logical", "target", "branch", "fragment", "state", "schema"])(
    "does not return the old observation after final-guard %s change", kind => {
      const f = fixture(kind === "physical" || kind === "logical")
      let calls = 0
      try {
        expect(() => assertStoredProjectionReceipt(f.database, { ...f.input, assertCurrent: () => {
          if (++calls !== 2) return
          if (kind === "receipt") f.database.run(`UPDATE function_conversation_projection_receipts
            SET projection_digest='changed' WHERE thread_id=?`, [f.threadId])
          else if (kind === "physical" || kind === "logical") f.database.run(
            "UPDATE threads SET metadata=? WHERE thread_id=?",
            [JSON.stringify({ cmb_thread_incarnation: randomUUID() }),
              kind === "physical" ? f.threadId : f.target.threadId])
          else if (kind === "target") f.database.run(`UPDATE function_logical_sessions SET workspace='changed'
            WHERE logical_session_id=?`, [f.target.logicalSessionId])
          else if (kind === "branch") f.database.run(`UPDATE function_conversation_branches
            SET conversation_id='changed' WHERE branch_id=?`, [f.target.branchId])
          else if (kind === "fragment") f.database.run(`INSERT INTO thread_message_fragments
            (thread_id,message_id,content_text,created_at) VALUES(?,?,?,?)`, [f.threadId, f.uuid, "raw", 1])
          else if (kind === "state") f.database.run(`INSERT INTO thread_message_fragment_states
            (thread_id,message_id,total_chars,updated_at) VALUES(?,?,?,?)`, [f.threadId, f.uuid, 0, 1])
          else f.database.run("ALTER TABLE thread_messages ADD COLUMN unexpected_projection_column TEXT")
        } })).toThrow()
      } finally {
        if (kind === "schema") f.database.run("ALTER TABLE thread_messages DROP COLUMN unexpected_projection_column")
      }
    })

  it("sees a real second connection's final-guard change rather than a cached row", () => {
    const f = fixture(), second = openNativeSqliteDatabase(paths.database, "actual second connection").database
    let calls = 0
    try {
      expect(() => assertStoredProjectionReceipt(f.database, { ...f.input, assertCurrent: () => {
        if (++calls === 2) second.run(`UPDATE thread_messages SET content_json=?
          WHERE thread_id=? AND message_id=?`, [JSON.stringify("second connection raw"), f.threadId, f.uuid])
      } })).toThrow()
      expect(() => assertStoredProjectionReceipt(f.database, f.input)).toThrow()
    } finally { second.close({ checkpoint: false }) }
  })

  it("does not let a reentrant public read borrow an outer A", () => {
    const f = fixture()
    let innerDenied = false
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      const prior = reader.readSnapshot(f.uuid)
      reader.runGuard(() => {
        f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
          [JSON.stringify("mutated in native guard"), f.threadId, f.uuid])
        try { appDb.readCanonicalThreadMessageSnapshot(f.threadId, f.uuid) }
        catch { innerDenied = true }
      })
      return prior
    })).toThrow()
    expect(innerDenied).toBe(true)
  })

  it("evicts a failed prepared query and does not reuse its failed observation", () => {
    const f = fixture()
    const database = openNativeSqliteDatabase(paths.database, "query failure connection").database
    const prepare = database.prepareReadOne.bind(database)
    let failOnce = true, joinedPrepares = 0
    vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      if (!sql.includes("AS keeper_payload_json")) return read
      joinedPrepares += 1
      return bindings => {
        if (failOnce) { failOnce = false; throw Error("ACTUAL_READ_FAILURE") }
        return read(bindings)
      }
    })
    try {
      expect(() => assertStoredProjectionReceipt(database, f.input)).toThrow("ACTUAL_READ_FAILURE")
      expect(assertStoredProjectionReceipt(database, f.input).message_id).toBe(f.uuid)
      expect(joinedPrepares).toBe(2)
    } finally { database.close({ checkpoint: false }) }
  })

  it("rejects the suspended exact reader, a clone and the retired reader before any read", () => {
    const f = fixture(), saved: { reader?: appDb.CanonicalThreadMessageReadScope } = {}
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      saved.reader = reader
      reader.readSnapshot(f.uuid)
      expect(() => Object.assign({}, reader).readSnapshot(f.uuid)).toThrow()
      expect(() => Object.assign({}, reader).readColumns(f.uuid)).toThrow()
      expect(() => Object.assign({}, reader).readSnapshotAndPresentation(f.uuid)).toThrow()
      expect(() => Object.assign({}, reader).requireSnapshotAndPresentation(f.uuid)).toThrow()
      reader.runGuard(() => {
        expect(() => reader.readSnapshot(f.uuid)).toThrow()
        expect(() => reader.readSnapshotAndPresentation(f.uuid)).toThrow()
        expect(() => reader.requireSnapshotAndPresentation(f.uuid)).toThrow()
      })
    })).toThrow()
    const actual = saved.reader
    if (!actual) throw Error("ACTUAL_READER_MISSING")
    const prepare = vi.spyOn(f.database, "prepareReadOne")
    expect(() => actual.readSnapshot(f.uuid)).toThrow()
    expect(() => actual.readColumns(f.uuid)).toThrow()
    expect(() => actual.readSnapshotAndPresentation(f.uuid)).toThrow()
    expect(() => actual.requireSnapshotAndPresentation(f.uuid)).toThrow()
    expect(prepare).not.toHaveBeenCalled()
  })

  it("does not call then/getter/Proxy code and publishes no successful async read", () => {
    const f = fixture()
    let getters = 0, traps = 0
    const thenable = Object.defineProperty({}, "then", { get() { getters += 1; return () => undefined } })
    const proxy = new Proxy({}, { getPrototypeOf() { traps += 1; return Object.prototype } })
    for (const value of [thenable, proxy, Promise.resolve()]) {
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
        reader.readSnapshot(f.uuid)
        return value
      })).toThrow("MODS_CONVERSATION_ASYNC_TRANSACTION")
    }
    expect(getters).toBe(0)
    expect(traps).toBe(0)
  })
  it("keeps a summary small and loads visible columns only against its original full observation", () => {
    const f = fixture(), original = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    if (!original) throw Error("ACTUAL_RAW_MISSING")
    const database = openNativeSqliteDatabase(paths.database, "actual summary connection").database
    const prepare = database.prepareReadOne.bind(database)
    let joinedReads = 0
    vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => {
        if (sql.includes("AS keeper_payload_json")) joinedReads++
        return read(bindings)
      }
    })
    try {
    const result = withFunctionConversationProjectionReadScope(database, scope => {
      const summary = readStoredFunctionConversationProjectionPresentationSummary(database, f.input, scope)
      expect(summary).toEqual({ columnsDigest: createHash("sha256").update(JSON.stringify(
        FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key => original[key]))).digest("hex"),
      presentation: readStoredFunctionConversationProjectionPresentationSummary(database,
        f.input, scope).presentation })
      expect(Object.keys(summary ?? {})).toEqual(["columnsDigest", "presentation"])
      expect(summary?.presentation.kind).toBe("visible")
      expect(joinedReads).toBe(1)
      const columns = readStoredFunctionConversationProjection(database, f.input, scope)
      expect(joinedReads).toBe(2)
      expect(readStoredFunctionConversationProjection(database, f.input, scope)).toBe(columns)
      expect(readSealedFunctionConversationProjectionPresentation(database, scope, columns))
        .toBe(summary.presentation)
      return { summary, columns }
    })
    expect(joinedReads).toBe(3)
    expect(result.columns).toEqual(original)
    } finally { database.close({ checkpoint: false }) }
  })

  it("summary-only reads still repeat the complete native/member join at final B", () => {
    const f = fixture()
    expect(() => withFunctionConversationProjectionReadScope(f.database, scope => {
      const summary = readStoredFunctionConversationProjectionPresentationSummary(f.database,
        f.input, scope)
      runFunctionConversationProjectionGuard(scope, () => {
        f.database.run("UPDATE function_conversation_rows SET payload_json=? WHERE conversation_id=? AND uuid=?",
          [JSON.stringify({ unexpected: "late body" }), f.target.conversationId, f.uuid])
      })
      return summary
    })).toThrow()
  })

  it("refuses to upgrade a summary after a late UI body change", () => {
    const f = fixture()
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      reader.readPresentationSummary(f.uuid)
      reader.runGuard(() => {
        f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
          [JSON.stringify("late visible body"), f.threadId, f.uuid])
      })
      return reader.readColumns(f.uuid)
    })).toThrow()
  })

  it("refuses an inserted presentation ledger during summary upgrade and final B", () => {
    for (const upgrade of [false, true]) {
      const f = fixture()
      expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
        const summary = reader.readPresentationSummary(f.uuid)
        reader.runGuard(() => {
          f.database.run(`INSERT INTO function_conversation_presentation_dispositions
            SELECT thread_id,incarnation,uuid,target_json,canonical_receipt_id,canonical_row_digest,
              native_payload_digest,projection_digest,'changed','changed','blank',1
            FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?`,
          [f.threadId, f.uuid])
        })
        return upgrade ? reader.readColumns(f.uuid) : summary
      })).toThrow()
    }
  })

  it("keeps summary absence provisional until all source callbacks have finished", () => {
    const f = fixture(), absent = randomUUID()
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      expect(reader.readPresentationSummary(absent)).toBeUndefined()
      reader.runGuard(() => {
        f.database.run(`INSERT INTO function_conversation_projection_receipts
          SELECT thread_id,incarnation,?,target_json,canonical_receipt_id,canonical_row_digest,
            native_payload_digest,projection_json,projection_digest
          FROM function_conversation_projection_receipts WHERE thread_id=? AND uuid=?`,
        [absent, f.threadId, f.uuid])
      })
    })).toThrow()
  })

  it("rejects cloned, suspended and retired summary readers without lending their observation", () => {
    const f = fixture()
    let saved: appDb.CanonicalThreadMessageReadScope | undefined
    expect(() => appDb.withCanonicalThreadMessageReadScope(f.threadId, reader => {
      saved = reader
      expect(reader.readPresentationSummary(f.uuid)?.presentation.kind).toBe("visible")
      expect(() => Object.assign({}, reader).readPresentationSummary(f.uuid)).toThrow()
      reader.runGuard(() => {
        expect(() => reader.readPresentationSummary(f.uuid)).toThrow()
      })
    })).toThrow()
    const read = vi.spyOn(f.database, "prepareReadOne")
    expect(() => saved?.readPresentationSummary(f.uuid)).toThrow()
    expect(read).not.toHaveBeenCalled()
  })


})
