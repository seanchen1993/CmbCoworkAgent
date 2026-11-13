import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { openNativeSqliteDatabase, type NativeSqliteAdapter,
  type NativeSqliteReadOne } from "./native-sqlite-adapter"
import { FunctionConversationStore } from "./function-conversation-store"
import { assertFunctionConversationNativeDestinationCleanupInTransaction,
  recordFunctionConversationNativeDestinationInTransaction,
  readFunctionConversationNativeDestination,
  assertFunctionConversationNativeDestinationDataCurrent,
  assertFunctionConversationNativeDestinationScopeThread,
  withFunctionConversationNativeDestinationDataScope } from "./function-conversation-native-destination"

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-native-destination-"))
  const db = openNativeSqliteDatabase(join(directory, "actual.sqlite")).database
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  db.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const threadId = randomUUID(), destinationThreadId = randomUUID(), invocationId = randomUUID()
  const threadMetadata = JSON.stringify({ cmb_thread_incarnation: randomUUID(), workspacePath: directory })
  const originalMetadata = JSON.stringify({ cmb_thread_incarnation: randomUUID(),
    isInternalFlowRuntime: true, isFunctionConversationProjection: true, parentThreadId: threadId,
    workspacePath: directory, modsAgentRunId: invocationId })
  db.run("INSERT INTO threads VALUES (?,1000,?)", [threadId, threadMetadata])
  db.run("INSERT INTO threads VALUES (?,1001,?)", [destinationThreadId, originalMetadata])
  const incarnation = captureThreadIncarnation({ created_at: 1000, metadata: threadMetadata })
  const destinationIncarnation = captureThreadIncarnation({ created_at: 1001, metadata: originalMetadata })
  const store = new FunctionConversationStore(db)
  const parent = store.ensureMain({ threadId, incarnation, workspace: directory,
    checkpointNamespace: "" }, () => {})
  let live = true
  const guard = () => { if (!live) throw Error("ORIGINAL_NATIVE_SOURCE_CLOSED") }
  const input = { parent, invocationId, checkpointThreadId: threadId, checkpointIncarnation: incarnation,
    destinationThreadId, destinationIncarnation, originalMetadata, assertCurrent: guard }
  const create = () => store.createChild(parent, { invocationId,
    checkpointNamespace: `native-task:${randomUUID()}` }, guard,
    child => recordFunctionConversationNativeDestinationInTransaction(db, child, input))
  return { db, store, parent, input, create, guard, close: () => { live = false } }
}
function actualNative(database: NativeSqliteAdapter): DatabaseSync {
  const value: unknown = Object.getOwnPropertyDescriptor(database, "native")?.value
  if (!(value instanceof DatabaseSync)) throw Error("ACTUAL_NATIVE_DATABASE_REQUIRED")
  return value
}
function identifier(value: string): string { return `"${value.replace(/"/g, "\"\"")}"` }

describe("original native shared destination data", () => {
  it.each([false, true])("keeps four role identities and one fresh snapshot with separate checkpoint=%s",
    separateCheckpoint => {
      const f = fixture()
      if (separateCheckpoint) {
        const checkpointThreadId = randomUUID()
        const checkpointMetadata = JSON.stringify({ cmb_thread_incarnation: randomUUID(),
          workspacePath: f.parent.workspace })
        f.db.run("INSERT INTO threads VALUES (?,1002,?)", [checkpointThreadId, checkpointMetadata])
        f.input.checkpointThreadId = checkpointThreadId
        f.input.checkpointIncarnation = captureThreadIncarnation({
          created_at: 1002, metadata: checkpointMetadata })
        f.input.originalMetadata = JSON.stringify({ ...JSON.parse(f.input.originalMetadata),
          parentThreadId: checkpointThreadId })
        f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
          [f.input.originalMetadata, f.input.destinationThreadId])
      }
      const child = f.create(), originalPrepare = f.db.prepareReadOne
      let snapshots = 0
      const prepare = vi.spyOn(f.db, "prepareReadOne")
        .mockImplementation(function (this: NativeSqliteAdapter, sql) {
          const read = Reflect.apply(originalPrepare, this, [sql]) as NativeSqliteReadOne
          const snapshot = sql.includes("FROM function_conversation_native_destinations m")
          return function (this: unknown, ...args: Parameters<NativeSqliteReadOne>) {
            if (snapshot) snapshots++
            return Reflect.apply(read, this, args)
          }
        })
      try {
        const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
        expect(prepare).toHaveBeenCalledTimes(4)
        const captured = snapshots
        expect(captured).toBe(1)
        original.assertCurrent()
        expect(snapshots).toBe(captured + 1)
        assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
        expect(snapshots).toBe(captured + 2)
        const roles = [{ id: child.threadId, incarnation: child.incarnation },
          { id: f.parent.threadId, incarnation: f.parent.incarnation },
          { id: f.input.checkpointThreadId, incarnation: f.input.checkpointIncarnation },
          { id: f.input.destinationThreadId, incarnation: f.input.destinationIncarnation }]
        withFunctionConversationNativeDestinationDataScope(original, f.db, scope => {
          for (const role of roles)
            assertFunctionConversationNativeDestinationScopeThread(scope, original, f.db,
              role.id, role.incarnation)
        })
        expect(snapshots).toBe(captured + 3)
        expect(prepare).toHaveBeenCalledTimes(4)
        const changed = JSON.stringify({ cmb_thread_incarnation: randomUUID() })
        f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
          [changed, f.input.checkpointThreadId])
        expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
          .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
        expect(snapshots).toBe(captured + 4)
        expect(prepare).toHaveBeenCalledTimes(4)
      } finally { prepare.mockRestore() }
    })

  it("rejects a distinct checkpoint incarnation even when its thread ID shares the target alias", () => {
    const f = fixture(), child = f.create()
    expect(f.input.checkpointThreadId).toBe(child.threadId)
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
    const incompatible = { ...f.input.checkpointIncarnation, token: randomUUID() }
    f.db.run("UPDATE function_conversation_native_destinations SET checkpoint_incarnation=?",
      [JSON.stringify(incompatible)])
    expect(() => readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
  })

  it("rejects a parent conversation moved to another real logical session", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    const threadId = randomUUID(), metadata = JSON.stringify({ cmb_thread_incarnation: randomUUID(),
      workspacePath: f.parent.workspace })
    f.db.run("INSERT INTO threads VALUES (?,1002,?)", [threadId, metadata])
    const other = f.store.ensureMain({ threadId,
      incarnation: captureThreadIncarnation({ created_at: 1002, metadata }),
      workspace: f.parent.workspace, checkpointNamespace: "" }, f.guard)
    expect(other.logicalSessionId).not.toBe(f.parent.logicalSessionId)
    expect(other.workspace).toBe(f.parent.workspace)
    // Free its unique main slot while keeping the actual session and thread.
    f.db.run("DELETE FROM function_conversation_branches WHERE conversation_id=? AND branch_id=?",
      [other.conversationId, other.branchId])
    f.db.run("DELETE FROM function_conversations WHERE conversation_id=? AND logical_session_id=?",
      [other.conversationId, other.logicalSessionId])
    const incarnationKey = JSON.stringify(other.incarnation.token === null
      ? ["legacy", other.incarnation.legacyCreatedAt] : ["token", other.incarnation.token])
    expect(f.db.exec(`SELECT thread_id,incarnation_key,workspace FROM function_logical_sessions
      WHERE logical_session_id=?`, [other.logicalSessionId])[0].values)
      .toEqual([[threadId, incarnationKey, f.parent.workspace]])
    // The real schema forbids two sessions with the same physical thread and incarnation.
    // A missing parent-session JOIN would still reuse the target session's old fields here.
    f.db.run("UPDATE function_conversations SET logical_session_id=? WHERE conversation_id=?",
      [other.logicalSessionId, f.parent.conversationId])
    expect(f.db.exec("SELECT logical_session_id FROM function_conversations WHERE conversation_id=?",
      [f.parent.conversationId])[0].values).toEqual([[other.logicalSessionId]])
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    let entered = false
    expect(() => withFunctionConversationNativeDestinationDataScope(original, f.db, () => {
      entered = true
    })).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(entered).toBe(false)
  })

  it.each(["target", "parent"] as const)("keeps the %s branch in every fresh destination snapshot",
    kind => {
      const f = fixture(), child = f.create()
      const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
      const selected = kind === "target" ? child : f.parent
      f.db.run("DELETE FROM function_conversation_branches WHERE conversation_id=? AND branch_id=?",
        [selected.conversationId, selected.branchId])
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      let entered = false
      expect(() => withFunctionConversationNativeDestinationDataScope(original, f.db, () => {
        entered = true
      })).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(entered).toBe(false)
    })

  it("pins original statements and a complete snapshot while reading fresh data on every check", () => {
    const f = fixture(), child = f.create()
    const prepare = vi.spyOn(f.db, "prepareReadOne")
    let calls = 0
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent,
      () => { calls++; f.guard() })
    expect(prepare).toHaveBeenCalledTimes(4)
    const capturedCalls = calls
    original.assertCurrent()
    original.assertCurrent()
    expect(calls).toBe(capturedCalls + 2)
    assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
    expect(calls).toBe(capturedCalls + 2)
    expect(prepare).toHaveBeenCalledTimes(4)
    f.db.run("UPDATE function_logical_sessions SET workspace='changed after repeated checks'")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
    expect(prepare).toHaveBeenCalledTimes(4)
    prepare.mockRestore()
  })

  it("rejects a replaced physical incarnation before minting a proof despite late parser replacement", () => {
    const f = fixture(), child = f.create()
    const raw = f.db.exec("SELECT metadata FROM threads WHERE thread_id=?", [f.parent.threadId])[0]
      .values[0][0] as string
    const parseOriginal = JSON.parse
    const changed = JSON.stringify({ ...parseOriginal(raw), cmb_thread_incarnation: randomUUID() })
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [changed, f.parent.threadId])
    let substitute = false
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      parseOriginal(substitute && text === changed ? raw : text, reviver))
    try {
      expect(() => readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
        f.guard()
        substitute = true
      })).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    } finally { parse.mockRestore() }
  })

  it("reads fresh native metadata with captured decoding and never caches a source match", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    const raw = f.db.exec("SELECT metadata FROM threads WHERE thread_id=?", [f.parent.threadId])[0]
      .values[0][0] as string
    const parseOriginal = JSON.parse
    const changed = JSON.stringify({ ...parseOriginal(raw), extra: "same incarnation, new text" })
    let initialReads = 0, changedReads = 0
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text === raw) initialReads++
      if (text === changed) changedReads++
      return parseOriginal(text, reviver)
    })
    try {
      assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
      assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
      expect(initialReads).toBe(0)
      f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [changed, f.parent.threadId])
      assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
      assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
      expect(changedReads).toBe(0)
      const replaced = JSON.stringify({ ...parseOriginal(changed), cmb_thread_incarnation: randomUUID() })
      f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [replaced, f.parent.threadId])
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    } finally { parse.mockRestore() }
  })

  it.each(["target_json", "parent_json", "invocation_id", "checkpoint_thread_id",
    "checkpoint_incarnation", "destination_thread_id", "destination_incarnation",
    "metadata_json", "metadata_digest"])("reads a new %s mapping value after the original source returns",
    field => {
      const f = fixture(), child = f.create()
      let armed = false, calls = 0
      const original = readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
        calls++; f.guard()
        if (armed) {
          armed = false
          f.db.run(`UPDATE function_conversation_native_destinations SET ${field}=?`,
            [`late original source ${field}`])
        }
      })
      const capturedCalls = calls
      armed = true
      expect(() => original.assertCurrent()).toThrow()
      expect(calls).toBe(capturedCalls + 1)
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
      expect(calls).toBe(capturedCalls + 1)
    })

  it.each(["physical incarnation", "destination metadata", "session workspace",
    "child namespace", "parent branch"] as const)("reads a new %s after its original source guard", kind => {
    const f = fixture(), child = f.create()
    let armed = false
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
      f.guard()
      if (!armed) return
      armed = false
      if (kind === "physical incarnation") f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.input.checkpointThreadId])
      if (kind === "destination metadata") f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ ...JSON.parse(f.input.originalMetadata), modsAgentRunId: randomUUID() }),
          f.input.destinationThreadId])
      if (kind === "session workspace") f.db.run("UPDATE function_logical_sessions SET workspace=?",
        ["different actual workspace"])
      if (kind === "child namespace") f.db.run(
        "UPDATE function_conversations SET checkpoint_namespace=? WHERE conversation_id=?",
        ["different actual namespace", child.conversationId])
      if (kind === "parent branch") f.db.run("DELETE FROM function_conversation_branches WHERE branch_id=?",
        [f.parent.branchId])
    })
    armed = true
    expect(() => original.assertCurrent()).toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
  })

  it("never borrows a retained row after the original database closes", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    original.assertCurrent()
    f.db.close()
    expect(() => original.assertCurrent()).toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
  })

  it.each(["additional_field", "__cmb_native_destination_target_thread_metadata"])(
    "preserves an existing extra %s mapping column without alias overwrite", column => {
      const f = fixture(), child = f.create()
      f.db.run(`ALTER TABLE function_conversation_native_destinations ADD COLUMN ${column} TEXT`)
      f.db.run(`UPDATE function_conversation_native_destinations SET ${column}='original extra column'`)
      const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
      original.assertCurrent()
      assertFunctionConversationNativeDestinationDataCurrent(original, f.db)
      f.db.run(`UPDATE function_conversation_native_destinations SET ${column}='changed extra column'`)
      expect(() => original.assertCurrent()).toThrow()
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
    })

  it("ignores a later unselected mapping alias without hiding a changed real thread", () => {
    const f = fixture(), child = f.create()
    const originalThreadMetadata = f.db.exec("SELECT metadata FROM threads WHERE thread_id=?",
      [f.input.checkpointThreadId])[0].values[0][0]
    let armed = false
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
      f.guard()
      if (!armed) return
      armed = false
      f.db.run("ALTER TABLE function_conversation_native_destinations ADD COLUMN " +
        "__cmb_native_destination_target_thread_metadata TEXT")
      f.db.run("UPDATE function_conversation_native_destinations SET " +
        "__cmb_native_destination_target_thread_metadata=?", [originalThreadMetadata])
    })
    armed = true
    expect(() => original.assertCurrent()).not.toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.input.checkpointThreadId])
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
  })

  it("ignores a TEMP mapping alias without hiding fresh destination metadata", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    f.db.run("CREATE TEMP TABLE function_conversation_native_destinations AS " +
      "SELECT * FROM main.function_conversation_native_destinations")
    f.db.run("ALTER TABLE temp.function_conversation_native_destinations ADD COLUMN " +
      "__cmb_native_destination_destination_thread_metadata TEXT")
    f.db.run("UPDATE temp.function_conversation_native_destinations SET " +
      "__cmb_native_destination_destination_thread_metadata=?", [f.input.originalMetadata])
    expect(() => original.assertCurrent()).not.toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ ...JSON.parse(f.input.originalMetadata), modsAgentRunId: randomUUID() }),
        f.input.destinationThreadId])
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    let entered = false
    expect(() => withFunctionConversationNativeDestinationDataScope(original, f.db, () => {
      entered = true
    })).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(entered).toBe(false)
  })

  it("cannot hide fresh destination changes behind writable_schema and an added alias", () => {
    const f = fixture(), child = f.create()
    const name = "function_conversation_native_destinations"
    const schema = f.db.exec("SELECT sql FROM main.sqlite_schema WHERE name=?", [name])[0].values[0][0]
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    f.db.run(`ALTER TABLE ${name} ADD COLUMN __cmb_native_destination_destination_thread_metadata TEXT`)
    f.db.run(`UPDATE ${name} SET __cmb_native_destination_destination_thread_metadata=?`,
      [f.input.originalMetadata])
    f.db.run("PRAGMA writable_schema=ON")
    try {
      f.db.run("UPDATE main.sqlite_schema SET sql=? WHERE name=?", [schema, name])
      // A forged schema string is not a data receipt. The fixed projection must continue
      // reading actual joined thread data, rather than trusting the added alias column.
      expect(() => original.assertCurrent()).not.toThrow()
      f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ ...JSON.parse(f.input.originalMetadata), modsAgentRunId: randomUUID() }),
          f.input.destinationThreadId])
      expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    } finally { f.db.run("PRAGMA writable_schema=OFF") }
  })

  it("reads replacement table rows when its original CREATE SQL is restored", () => {
    const f = fixture(), child = f.create()
    const name = "function_conversation_native_destinations"
    const schema = f.db.exec("SELECT sql FROM main.sqlite_schema WHERE name=?", [name])[0].values[0][0]
    if (typeof schema !== "string") throw Error("ACTUAL_DESTINATION_SCHEMA_REQUIRED")
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    f.db.run(`ALTER TABLE ${name} RENAME TO original_destination_mapping`)
    f.db.run(schema)
    f.db.run(`INSERT INTO ${name} SELECT * FROM original_destination_mapping`)
    f.db.run("DROP TABLE original_destination_mapping")
    expect(() => original.assertCurrent()).not.toThrow()
    f.db.run(`UPDATE ${name} SET metadata_digest='replacement row changed'`)
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
  })

  it("does not execute SQL glob or count callbacks installed by the actual source", () => {
    const f = fixture(), child = f.create(), native = actualNative(f.db)
    let armed = false, sourceCalls = 0, globCalls = 0, countCalls = 0
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
      sourceCalls++; f.guard()
      if (!armed) return
      armed = false
      native.function("glob", (pattern, name) => {
        globCalls++
        if (typeof pattern !== "string" || typeof name !== "string")
          throw Error("ACTUAL_GLOB_TEXT_REQUIRED")
        f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='glob callback'")
        return 0
      })
      native.function("count", () => {
        countCalls++
        f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='count callback'")
        return 0
      })
    })
    const capturedCalls = sourceCalls
    armed = true
    expect(() => original.assertCurrent()).not.toThrow()
    expect(sourceCalls).toBe(capturedCalls + 1)
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
    expect(sourceCalls).toBe(capturedCalls + 1)
    expect(globCalls).toBe(0); expect(countCalls).toBe(0)
    f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='actual later mutation'")
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(sourceCalls).toBe(capturedCalls + 2)
    expect(globCalls).toBe(0); expect(countCalls).toBe(0)
  })

  it("retains Unicode, quoted and case-different ordinary mapping columns in the full snapshot", () => {
    const f = fixture(), child = f.create()
    const columns = ["普通列🙂", "quoted\"*?[", "__CMB_native_destination_case"]
    for (const column of columns) {
      f.db.run(`ALTER TABLE function_conversation_native_destinations ADD COLUMN ${identifier(column)} TEXT`)
      f.db.run(`UPDATE function_conversation_native_destinations SET ${identifier(column)}=?`,
        ["actual original extra field"])
    }
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    expect(() => original.assertCurrent()).not.toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
    f.db.run(`UPDATE function_conversation_native_destinations SET ${identifier(columns[0])}=?`,
      ["actual later extra field"])
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
  })

  it("keeps original prefix avoidance when two existing prefixes collide", () => {
    const f = fixture(), child = f.create()
    const columns = ["__cmb_native_destination_existing", "__cmb_native_destination_x_existing"]
    for (const column of columns)
      f.db.run(`ALTER TABLE function_conversation_native_destinations ADD COLUMN ${identifier(column)} TEXT`)
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    expect(() => original.assertCurrent()).not.toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
    f.db.run(`UPDATE function_conversation_native_destinations SET ${identifier(columns[1])}=?`,
      ["actual changed avoided-prefix field"])
    expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
  })

  it.each(["__cmb_native_destination_", "__cmb_native_destination_雪🙂",
    "__cmb_native_destination_quote\"*?["])("ignores an unselected normal alias-prefix column %s while keeping real mapping checks", column => {
      const f = fixture(), child = f.create(), native = actualNative(f.db)
      let armed = false, calleeCalls = 0
      const original = readFunctionConversationNativeDestination(f.db, child, f.parent, () => {
        f.guard()
        if (!armed) return
        armed = false
        f.db.run(`ALTER TABLE function_conversation_native_destinations ADD COLUMN ${identifier(column)} TEXT`)
        native.function("glob", (pattern, name) => {
          calleeCalls++
          if (typeof pattern !== "string" || typeof name !== "string")
            throw Error("ACTUAL_GLOB_TEXT_REQUIRED")
          return 0
        })
        native.function("count", () => { calleeCalls++; return 0 })
      })
      armed = true
      expect(() => original.assertCurrent()).not.toThrow()
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
      expect(calleeCalls).toBe(0)
      f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='actual changed mapping'")
      expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(calleeCalls).toBe(0)
    })

  it("ignores an unrelated TEMP PRAGMA shadow while retaining fresh mapping checks", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    original.assertCurrent()
    f.db.run("CREATE TEMP TABLE pragma_table_info(name TEXT)")
    try {
      const captured = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
      expect(() => captured.assertCurrent()).not.toThrow()
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).not.toThrow()
      f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='real mapping mutation'")
      expect(() => original.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(() => assertFunctionConversationNativeDestinationDataCurrent(captured, f.db))
        .toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
    } finally { f.db.run("DROP TABLE temp.pragma_table_info") }
  })

  it("rejects a changed child invocation in the fresh joined relation", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    original.assertCurrent()
    f.db.run("UPDATE function_conversations SET invocation_id=? WHERE conversation_id=?",
      [randomUUID(), child.conversationId])
    expect(() => original.assertCurrent()).toThrow()
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
  })

  it("rechecks the complete original mapping without rerunning its source callback", () => {
    const f = fixture(), child = f.create()
    let calls = 0
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent,
      () => { calls++; f.guard() })
    const capturedCalls = calls
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db))
      .not.toThrow()
    expect(calls).toBe(capturedCalls)
    expect(() => assertFunctionConversationNativeDestinationDataCurrent({ ...original }, f.db))
      .toThrow()
    f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='late change'")
    expect(() => assertFunctionConversationNativeDestinationDataCurrent(original, f.db)).toThrow()
    expect(calls).toBe(capturedCalls)
  })
  it("records even an empty actual destination in the original child transaction", () => {
    const f = fixture(), child = f.create()
    const result = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    expect(result.invocationId).toBe(f.input.invocationId)
    expect(result.destinationThreadId).toBe(f.input.destinationThreadId)
    expect(result.originalMetadata).toBe(f.input.originalMetadata)
    expect(result.destinationIncarnation).toEqual(f.input.destinationIncarnation)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_rows")[0].values[0][0]).toBe(0)
    expect(() => result.assertCurrent()).not.toThrow()
  })

  it("rolls back both conversation and mapping if the original guard fails in the callback", () => {
    const f = fixture()
    expect(() => f.store.createChild(f.parent, { invocationId: f.input.invocationId,
      checkpointNamespace: "native-task" }, f.guard, child => {
      recordFunctionConversationNativeDestinationInTransaction(f.db, child, f.input)
      f.close()
    })).toThrow("ORIGINAL_NATIVE_SOURCE_CLOSED")
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]).toBe(0)
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_native_destinations")[0].values[0][0]).toBe(0)
  })

  it("rejects async child-creation callbacks instead of acknowledging a split transaction", () => {
    const f = fixture()
    expect(() => f.store.createChild(f.parent, { invocationId: f.input.invocationId,
      checkpointNamespace: "native-task" }, f.guard, async () => {})).toThrow("ASYNC_TRANSACTION")
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversations WHERE kind='child'")[0].values[0][0]).toBe(0)
  })

  it("cannot record outside the original transaction or recertify an existing mapping", () => {
    const f = fixture(), child = f.create()
    expect(() => recordFunctionConversationNativeDestinationInTransaction(f.db, child, f.input))
      .toThrow("TRANSACTION_REQUIRED")
    f.db.run("BEGIN IMMEDIATE")
    try {
      expect(() => recordFunctionConversationNativeDestinationInTransaction(f.db, child, f.input))
        .toThrow("DESTINATION_CHANGED")
    } finally { f.db.run("ROLLBACK") }
  })

  it("refuses missing historical mappings instead of guessing a new UI destination", () => {
    const f = fixture()
    const child = f.store.createChild(f.parent, { invocationId: f.input.invocationId,
      checkpointNamespace: "native-task" }, f.guard)
    expect(() => readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard))
      .toThrow("MIGRATION_REQUIRED")
  })

  it("rejects another actual parent branch even within the same family", () => {
    const f = fixture(), child = f.create()
    const branch = f.store.forkBranch(f.parent, { parentFrontier: 0, checkpointId: "real-cut" }, f.guard)
    expect(() => readFunctionConversationNativeDestination(f.db, child, branch, f.guard))
      .toThrow("DESTINATION_CHANGED")
  })

  it.each(["destination", "physical"])("rejects %s thread ABA while retaining the old mapping", changed => {
    const f = fixture(), child = f.create()
    const id = changed === "physical" ? f.input.checkpointThreadId : f.input.destinationThreadId
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
      JSON.stringify({ cmb_thread_incarnation: randomUUID() }), id])
    expect(() => readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard))
      .toThrow()
    expect(f.db.exec("SELECT COUNT(*) FROM function_conversation_native_destinations")[0].values[0][0]).toBe(1)
  })

  it("does not rewrite original destination run metadata when a current run differs", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [
      JSON.stringify({ ...JSON.parse(f.input.originalMetadata), modsAgentRunId: randomUUID() }),
      f.input.destinationThreadId])
    expect(() => original.assertCurrent()).toThrow("DESTINATION_CHANGED")
    expect(() => readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard))
      .toThrow("DESTINATION_CHANGED")
  })

  it("checks mapping changes again when the original source guard returns", () => {
    const f = fixture(), child = f.create()
    const original = readFunctionConversationNativeDestination(f.db, child, f.parent, f.guard)
    f.db.run("UPDATE function_conversation_native_destinations SET metadata_digest='changed'")
    expect(() => original.assertCurrent()).toThrow("DESTINATION_CHANGED")
  })

  it("retains current replacement bucket data in a cleanup preflight for the old mapping", () => {
    const f = fixture(), child = f.create()
    const replacement = JSON.stringify({ cmb_thread_incarnation: randomUUID(), replacement: true })
    f.db.run("UPDATE threads SET metadata=? WHERE thread_id=?", [replacement, f.input.destinationThreadId])
    f.db.run("BEGIN IMMEDIATE")
    try {
      expect(() => assertFunctionConversationNativeDestinationCleanupInTransaction(f.db,
        [child.conversationId], f.guard)).not.toThrow()
      expect(f.db.exec("SELECT metadata FROM threads WHERE thread_id=?",
        [f.input.destinationThreadId])[0].values[0][0]).toBe(replacement)
    } finally { f.db.run("ROLLBACK") }
  })
})
