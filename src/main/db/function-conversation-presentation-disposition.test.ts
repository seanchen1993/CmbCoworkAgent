import { HumanMessage } from "@langchain/core/messages"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { readFunctionConversationRawProjection } from "./function-conversation-projection-receipt"
import { ensureFunctionConversationPresentationDispositionSchema,
  readFunctionConversationPresentationDisposition, recordFunctionConversationPresentationDisposition }
  from "./function-conversation-presentation-disposition"
import { readFunctionConversationPresentationDispositionData,
  revalidateFunctionConversationPresentationDispositionData,
  type FunctionConversationPresentationDispositionData } from
  "./function-conversation-presentation-disposition"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-presentation-disposition-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function fixture(mode: "persisted" | "blank" | "plumbing" | "legacy" = "persisted",
  beforeCommit?: () => void) {
  const database = appDb.getDb(), threadId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(thread), store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => {})
  ensureFunctionConversationPresentationDispositionSchema(database)
  const uuid = randomUUID(), text = "complete protected native input"
  const native = new HumanMessage({ id: uuid, content: text })
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({ id: row.uuid,
    role: "user", content: mode === "blank" || mode === "plumbing" ? "" : text,
    recovery_integrity: mode === "blank" || mode === "plumbing" ? "unverified" : "verified",
    created_at: new Date(row.createdAt) }))
  let writes = 0
  const selection = (row: Parameters<typeof access.verify>[2]) => ({ target, row, threadId,
    incarnation, assertCurrent: () => store.assertCurrent(target) })
  const columns = () => {
    const value = readFunctionConversationRawProjection(database, threadId, uuid)
    if (!value) throw Error("ACTUAL_RAW_REQUIRED")
    return value
  }
  const commit = () => store.commit(target, { uuid, inputDigest: uuid, door: "prompt",
    origin: { kind: "composer" }, message: { type: "user", content: [{ type: "text", text }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "native-producer", uuid, ...(mode === "legacy" ? {} : { presentation: {
      version: 1, disposition: mode, intentDigest: "a".repeat(64) } }) },
    sdk: false, inbox: false }, () => {}, (db, ref, row) => {
    writes++
    access.write(db, ref, row)
    recordFunctionConversationPresentationDisposition(db, selection(row), columns())
  }, (db, ref, row) => {
    access.verify(db, ref, row)
    readFunctionConversationPresentationDisposition(db, selection(row), columns())
  })
  beforeCommit?.()
  const row = commit()
  return { database, threadId, target, row, incarnation, native, columns, commit,
    selection: selection(row), writes: () => writes,
    read: () => readFunctionConversationPresentationDisposition(database, selection(row), columns()) }
}
describe("actual canonical presentation disposition ledger", () => {
  function data(f: ReturnType<typeof fixture>): FunctionConversationPresentationDispositionData {
    const result = f.database.exec(`SELECT * FROM function_conversation_projection_receipts
      WHERE thread_id=? AND uuid=?`, [f.threadId, f.row.uuid])[0]
    const raw = Object.fromEntries(result.columns.map((key, index) => [key, result.values[0][index]]))
    const value = (key: string): string => {
      const item = raw[key]
      if (typeof item !== "string") throw Error("ACTUAL_RECEIPT_FIELD_REQUIRED")
      return item
    }
    const columns = f.columns()
    if (typeof columns.content_json !== "string" || typeof columns.role !== "string" ||
      typeof f.row.message.type !== "string")
      throw Error("ACTUAL_SEALED_CONTENT_REQUIRED")
    return { threadId: f.threadId, incarnation: value("incarnation"), uuid: f.row.uuid,
      targetJson: value("target_json"), canonicalReceiptId: value("canonical_receipt_id"),
      canonicalRowDigest: value("canonical_row_digest"), nativePayloadDigest: value("native_payload_digest"),
      projectionDigest: value("projection_digest"), orderAnchor: f.row.orderAnchor,
      role: columns.role, door: f.row.door, messageType: f.row.message.type,
      contentJson: columns.content_json, recoveryIntegrity: columns.recovery_integrity }
  }
  it("reuses caller full-seal facts while reading a fresh ledger without another native scan", () => {
    const f = fixture("blank"), facts = data(f), expected = f.read()
    const exec = f.database.exec.bind(f.database), queries: string[] = []
    vi.spyOn(f.database, "exec").mockImplementation((sql, args) => {
      queries.push(sql)
      return exec(sql, args)
    })
    expect(readFunctionConversationPresentationDispositionData(f.database, facts)).toEqual(expected)
    expect(queries.every(sql => !sql.includes("function_conversation_rows") &&
      !sql.includes("thread_messages") && !sql.includes("projection_receipts"))).toBe(true)
    f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
      [f.threadId])
    expect(() => readFunctionConversationPresentationDispositionData(f.database, facts))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })
  it.each(["getter", "proxy", "extra"] as const)(
    "rejects invalid pure-seal fact %s with zero behavior", kind => {
      const f = fixture(), facts = data(f)
      let calls = 0, supplied = facts
      if (kind === "getter") Object.defineProperty(facts, "orderAnchor", {
        enumerable: true, get: () => { calls++; return f.row.orderAnchor } })
      else if (kind === "proxy") supplied = new Proxy(facts, {
        ownKeys: () => { calls++; return [] } })
      else Object.defineProperty(facts, "extra", { enumerable: true, value: true })
      expect(() => readFunctionConversationPresentationDispositionData(f.database, supplied)).toThrow()
      expect(calls).toBe(0)
    })
  it("makes the legacy absence fingerprint participate in each later pure read", () => {
    const f = fixture("legacy"), facts = data(f)
    const first = readFunctionConversationPresentationDispositionData(f.database, facts)
    expect(first).toEqual(f.read())
    expect(readFunctionConversationPresentationDispositionData(f.database,
      { ...facts, projectionDigest: "b".repeat(64) }).fingerprint).not.toBe(first.fingerprint)
  })
  it("revalidates only the original bounded observation and original database", () => {
    const f = fixture("blank"), result = readFunctionConversationPresentationDispositionData(
      f.database, data(f))
    revalidateFunctionConversationPresentationDispositionData(f.database, result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(() => revalidateFunctionConversationPresentationDispositionData(f.database,
      { ...result })).toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
    const other = openNativeSqliteDatabase(join(directory, `${randomUUID()}.sqlite`)).database
    try {
      expect(() => revalidateFunctionConversationPresentationDispositionData(other, result))
        .toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
    } finally { other.close() }
    expect(() => Object.defineProperty(result, "kind", { value: "visible" })).toThrow()
    f.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
      [f.threadId])
    expect(() => revalidateFunctionConversationPresentationDispositionData(f.database, result))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })
  it("revalidates a legacy absence after a ledger is inserted at its exact original key", () => {
    const f = fixture("legacy"), seed = fixture("blank"), result = f.read()
    f.database.run(`INSERT INTO function_conversation_presentation_dispositions
      SELECT ?,?, ?,target_json,canonical_receipt_id,canonical_row_digest,native_payload_digest,
        projection_digest,anchor_digest,intent_digest,disposition,version
      FROM function_conversation_presentation_dispositions WHERE thread_id=?`,
    [f.threadId, JSON.stringify(["token", f.incarnation.token]), f.row.uuid, seed.threadId])
    expect(() => revalidateFunctionConversationPresentationDispositionData(f.database, result))
      .toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
  })
  it.each(["no-primary-key-duplicates", "nullable", "wrong-type", "wrong-key-order",
    "wrong-column-order"] as const)("rejects a same-name %s ledger without rebuilding it", kind => {
    const f = fixture("blank"), result = f.read(), table = "function_conversation_presentation_dispositions"
    const saved = `ledger_${randomUUID().replaceAll("-", "")}`
    const names = ["thread_id", "incarnation", "uuid", "target_json", "canonical_receipt_id",
      "canonical_row_digest", "native_payload_digest", "projection_digest", "anchor_digest",
      "intent_digest", "disposition", "version"]
    const ordered = kind === "wrong-column-order" ? [...names].reverse() : names
    f.database.run(`ALTER TABLE ${table} RENAME TO ${saved}`)
    try {
      f.database.run(`CREATE TABLE ${table} (${ordered.map(name => `${name} ${
        name === "version" || kind === "wrong-type" && name === "disposition" ? "INTEGER" : "TEXT"
      }${kind === "nullable" && name === "intent_digest" ? "" : " NOT NULL"}`).join(",")}${
        kind === "no-primary-key-duplicates" ? "" : `, PRIMARY KEY(${kind === "wrong-key-order"
          ? "uuid,incarnation,thread_id" : "thread_id,incarnation,uuid"})`})`)
      f.database.run(`INSERT INTO ${table} (${names.join(",")}) SELECT ${names.join(",")} FROM ${saved}`)
      if (kind === "no-primary-key-duplicates") {
        f.database.run(`INSERT INTO ${table} SELECT * FROM ${table} WHERE thread_id=?`, [f.threadId])
        expect(f.database.exec(`SELECT COUNT(*) FROM ${table} WHERE thread_id=?`,
          [f.threadId])[0].values[0][0]).toBe(2)
      }
      expect(() => f.read()).toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
      expect(() => revalidateFunctionConversationPresentationDispositionData(f.database, result))
        .toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
      expect(() => ensureFunctionConversationPresentationDispositionSchema(f.database))
        .toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
    } finally {
      f.database.run(`DROP TABLE ${table}`)
      f.database.run(`ALTER TABLE ${saved} RENAME TO ${table}`)
    }
    expect(f.read()).toEqual(result)
  })
  it.each(["persisted", "blank", "plumbing"] as const)(
    "keeps full native input while certifying actual %s UI disposition", mode => {
      const f = fixture(mode), value = f.read()
      expect(value.kind).toBe(mode === "persisted" ? "visible" : mode)
      expect(value.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(f.row.nativePayload).toContain("complete protected native input")
      if (mode !== "persisted") {
        expect(f.columns().content_json).toBe(JSON.stringify(""))
        expect(f.columns().recovery_integrity).toBe(0)
      }
      expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_presentation_dispositions
        WHERE thread_id=?`, [f.threadId])[0].values[0][0]).toBe(1)
      expect(f.commit().receiptId).toBe(f.row.receiptId)
      expect(f.writes()).toBe(1)
      expect(f.database.inTransaction).toBe(false)
    })
  it("never calls or reads the caller's source callback", () => {
    const f = fixture("blank"), selection = { ...f.selection }
    let callbacks = 0
    Object.defineProperty(selection, "assertCurrent", { get: () => { callbacks++; throw Error("NO") } })
    expect(readFunctionConversationPresentationDisposition(f.database, selection, f.columns()).kind)
      .toBe("blank")
    expect(callbacks).toBe(0)
  })
  it("distinguishes legacy absence from a new marker whose ledger was removed", () => {
    const old = fixture("legacy")
    expect(old.read().kind).toBe("visible")
    const current = fixture("blank")
    current.database.run("DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=?",
      [current.threadId])
    expect(() => current.read()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(() => current.commit()).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    expect(current.writes()).toBe(1)
  })
  it.each(["target_json", "canonical_receipt_id", "canonical_row_digest", "native_payload_digest",
    "projection_digest", "anchor_digest", "intent_digest", "disposition", "version"] as const)(
    "rejects actual ledger %s mutation rather than downgrading to visible", field => {
      const f = fixture("plumbing")
      f.database.run(`UPDATE function_conversation_presentation_dispositions SET ${field}=?
        WHERE thread_id=?`, [field === "version" ? 2 : "changed", f.threadId])
      expect(() => f.read()).toThrow("MODS_CONVERSATION_PRESENTATION_CONFLICT")
      expect(() => f.commit()).toThrow()
      expect(f.writes()).toBe(1)
    })
  it("detects insertion into previously absent legacy presentation at the later read", () => {
    const old = fixture("legacy"), source = fixture("blank"), first = old.read()
    old.database.run(`INSERT INTO function_conversation_presentation_dispositions
      SELECT ?,?,uuid,target_json,canonical_receipt_id,canonical_row_digest,native_payload_digest,
        projection_digest,anchor_digest,intent_digest,disposition,version
      FROM function_conversation_presentation_dispositions WHERE thread_id=?`,
    [old.threadId, JSON.stringify(["token", old.incarnation.token]), source.threadId])
    // Corruption with the exact old PK cannot manufacture a valid legacy-visible classification.
    old.database.run(`UPDATE function_conversation_presentation_dispositions SET uuid=? WHERE thread_id=?`,
      [old.row.uuid, old.threadId])
    expect(first.kind).toBe("visible")
    expect(() => old.read()).toThrow()
  })
  it("rejects raw projection mutation and same-ID thread replacement", () => {
    const f = fixture("blank")
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=?", [JSON.stringify("raw"),
      f.threadId])
    expect(() => f.read()).toThrow()
    const next = fixture("blank")
    next.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
      [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), next.threadId])
    expect(() => next.read()).toThrow()
  })
  it("cannot record a disposition outside the original keeper transaction", () => {
    const f = fixture()
    expect(() => recordFunctionConversationPresentationDisposition(f.database, f.selection, f.columns()))
      .toThrow("MODS_CONVERSATION_NOT_COMMITTED")
  })
  it("retains one ledger after actual COMMIT acknowledgement loss without repeating its writer", () => {
    const run = appDb.getDb().run.bind(appDb.getDb())
    let lost = false
    const f = fixture("blank", () => {
      vi.spyOn(appDb.getDb(), "run").mockImplementation((sql, args = []) => {
        const result = run(sql, args)
        if (sql === "COMMIT" && !lost) { lost = true; throw Error("LOST_ACTUAL_COMMIT_ACK") }
        return result
      })
    })
    expect(lost).toBe(true)
    expect(f.read().kind).toBe("blank")
    expect(f.writes()).toBe(1)
    expect(f.database.inTransaction).toBe(false)
  })
})
