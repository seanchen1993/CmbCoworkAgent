import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { assertFunctionConversationForkReady,
  denyFunctionConversationForkReady } from "./function-conversation-fork-gate"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-fork-entry-gate-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

describe("actual ordinary message writers obey the native fork gate", () => {
  // This suite verifies callers of the gate. Real journal admission, unknown COMMIT and ready
  // proofs are exercised separately against the complete schema in function-conversation-fork.
  function journal() {
    appDb.getDb().run(`CREATE TABLE IF NOT EXISTS function_conversation_fork_imports (
      target_thread_id TEXT, target_incarnation TEXT, status TEXT)`)
  }
  function preparing(thread: ReturnType<typeof appDb.createThread>) {
    journal()
    const incarnation = captureThreadIncarnation(thread)
    const key = JSON.stringify(incarnation.token === null
      ? ["legacy", incarnation.legacyCreatedAt] : ["token", incarnation.token])
    appDb.getDb().run("INSERT INTO function_conversation_fork_imports VALUES (?,?,?)",
      [thread.thread_id, key, "preparing"])
    return { threadId: thread.thread_id, incarnation, key }
  }

  it("keeps ordinary old threads writable without creating any conversation schema", () => {
    const thread = appDb.createThread(randomUUID())
    expect(appDb.upsertThreadMessages(thread.thread_id,
      [{ id: randomUUID(), role: "user", content: "ordinary", created_at: new Date() }])).toBe(1)
    expect(appDb.getDb().exec("SELECT name FROM sqlite_master WHERE name LIKE 'function_%'")[0]
      .values).toEqual([])
  })

  it("blocks both public and transaction writes before changing messages or ordinals", () => {
    const target = preparing(appDb.createThread(randomUUID()))
    const message = { id: randomUUID(), role: "user" as const,
      content: "must remain unsaved", created_at: new Date() }
    expect(() => appDb.upsertThreadMessages(target.threadId, [message]))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    appDb.getDb().run("BEGIN")
    try {
      expect(() => appDb.upsertThreadMessagesInTransaction(target.threadId, [message]))
        .toThrow("MODS_CONVERSATION_FORK_PREPARING")
      expect(appDb.getDb().inTransaction).toBe(true)
    } finally { appDb.getDb().run("ROLLBACK") }
    expect(appDb.getThreadMessages(target.threadId)).toEqual([])
    appDb.getDb().run("UPDATE function_conversation_fork_imports SET status='ready' WHERE target_thread_id=?",
      [target.threadId])
    expect(appDb.upsertThreadMessages(target.threadId, [message])).toBe(1)
  })

  it("uses the actual current incarnation, so a stale journal cannot block a recreated thread", () => {
    const id = randomUUID(), target = preparing(appDb.createThread(id))
    appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [id])
    const next = appDb.createThread(id)
    expect(captureThreadIncarnation(next).token).not.toBe(target.incarnation.token)
    expect(appDb.upsertThreadMessages(id,
      [{ id: randomUUID(), role: "assistant", content: "new incarnation", created_at: new Date() }]))
      .toBe(1)
    expect(() => assertFunctionConversationForkReady(appDb.getDb(), target))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("keeps public writers denied after native quarantine fails with a still-ready journal", () => {
    const target = preparing(appDb.createThread(randomUUID()))
    appDb.getDb().run("UPDATE function_conversation_fork_imports SET status='ready' WHERE target_thread_id=?",
      [target.threadId])
    denyFunctionConversationForkReady(appDb.getDb(), target)
    expect(() => appDb.upsertThreadMessages(target.threadId,
      [{ id: randomUUID(), role: "user", content: "must not reopen", created_at: new Date() }]))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    appDb.getDb().run("BEGIN")
    try {
      expect(() => appDb.upsertThreadMessagesInTransaction(target.threadId,
        [{ id: randomUUID(), role: "assistant", content: "same gate", created_at: new Date() }]))
        .toThrow("MODS_CONVERSATION_FORK_PREPARING")
    } finally { appDb.getDb().run("ROLLBACK") }
    expect(appDb.getThreadMessages(target.threadId)).toEqual([])
    appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [target.threadId])
    const replacement = appDb.createThread(target.threadId)
    expect(captureThreadIncarnation(replacement).token).not.toBe(target.incarnation.token)
    expect(appDb.upsertThreadMessages(target.threadId,
      [{ id: randomUUID(), role: "user", content: "replacement survives", created_at: new Date() }]))
      .toBe(1)
  })

  it("a no-schema probe is read-only even with a physical database reopen", () => {
    const path = join(directory, "old.sqlite")
    let database = openNativeSqliteDatabase(path).database
    const target = { threadId: "old", incarnation: { token: null, legacyCreatedAt: 1 } }
    assertFunctionConversationForkReady(database, target)
    database.close()
    database = openNativeSqliteDatabase(path).database
    try {
      assertFunctionConversationForkReady(database, target)
      expect(database.exec("SELECT name FROM sqlite_master")[0].values).toEqual([])
    } finally { database.close() }
  })
})
