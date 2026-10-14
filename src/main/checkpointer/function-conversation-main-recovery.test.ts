import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { functionConversationState } from "../agent/mods-conversation"
import { createMainFunctionConversationRecoveryCapture, nativeFunctionConversationWorkspace } from
  "./function-conversation-main-recovery"

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })

function fixture(createMain = true) {
  const directory = mkdtempSync(join(tmpdir(), "cmb-main-recovery-admission-"))
  const database = openNativeSqliteDatabase(join(directory, "actual.sqlite")).database
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  const token = randomUUID(), metadata = JSON.stringify({ workspacePath: directory,
    cmb_thread_incarnation: token })
  database.run("INSERT INTO threads VALUES ('thread',1000,?)", [metadata])
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  const store = new FunctionConversationStore(database)
  const originalThread = { created_at: 1000, metadata }
  const signal = new AbortController()
  let currentDatabase: NativeSqliteAdapter = database, live = true
  const readThread = () => {
    const row = database.exec("SELECT created_at,metadata FROM threads WHERE thread_id='thread'")[0]
      ?.values[0]
    return row ? { created_at: Number(row[0]), metadata: String(row[1]) } : undefined
  }
  const target = createMain ? store.ensureMain({ threadId: "thread", workspace: directory,
    incarnation: { token, legacyCreatedAt: 1000 }, checkpointNamespace: "" }, () => undefined) : undefined
  const capture = createMainFunctionConversationRecoveryCapture({ database, store,
    threadId: "thread", workspace: directory, originalThread, signal: signal.signal,
    currentDatabase: () => currentDatabase, readThread,
    assertCurrent: () => { if (!live) throw Error("Original Saver scope retired") } })
  const config = { configurable: { thread_id: "thread", checkpoint_ns: "",
    checkpoint_id: "original-exact-checkpoint" } }
  const state = target ? functionConversationState(target) : { version: 1 as const,
    logicalSessionId: "fake-session", conversationId: "fake-conversation", branchId: "fake-branch",
    frontier: 0 }
  return { database, target, capture, config, state, signal, directory,
    retire: () => { live = false }, replaceDatabase: () => {
      const replacement = openNativeSqliteDatabase(join(directory, "replacement.sqlite")).database
      cleanups.push(() => replacement.close())
      currentDatabase = replacement
    } }
}

describe("original main recovery host admission", () => {
  it("selects the existing main data and exact saved branch without creating an authority", () => {
    const f = fixture()
    const before = f.database.exec("SELECT COUNT(*) FROM function_logical_sessions")[0].values[0][0]
    const binding = f.capture(f.config, f.state)
    expect(binding.target).toEqual(f.target)
    expect(binding.signal).toBe(f.signal.signal)
    expect(f.database.exec("SELECT COUNT(*) FROM function_logical_sessions")[0].values[0][0])
      .toBe(before)
    expect(Object.hasOwn(binding, "authority")).toBe(false)
  })

  it("does not create a missing main identity from saved public channel data", () => {
    const f = fixture(false)
    expect(() => f.capture(f.config, f.state)).toThrow("MODS_CONVERSATION_RECOVERY_REQUIRED")
    expect(f.database.exec("SELECT COUNT(*) FROM function_logical_sessions")[0].values[0][0]).toBe(0)
  })

  it.each(["other-thread", "child-namespace", "no-checkpoint"])("rejects %s", reason => {
    const f = fixture(), config = structuredClone(f.config)
    if (reason === "other-thread") config.configurable.thread_id = "another"
    if (reason === "child-namespace") config.configurable.checkpoint_ns = "actual-child"
    if (reason === "no-checkpoint") config.configurable.checkpoint_id = ""
    expect(() => f.capture(config, f.state)).toThrow("MODS_CONVERSATION_CHECKPOINT_SCOPE")
  })

  it("rejects copied conversation IDs even with a genuine same-thread branch", () => {
    const f = fixture()
    expect(() => f.capture(f.config, { ...f.state, conversationId: "another" }))
      .toThrow("MODS_CONVERSATION_STATE_CHANGED")
  })

  it.each(["incarnation", "workspace", "database", "retired", "cancelled"])(
    "keeps the original %s guard live after capture", reason => {
      const f = fixture(), binding = f.capture(f.config, f.state)
      if (reason === "incarnation") f.database.run("UPDATE threads SET metadata=?", [
        JSON.stringify({ workspacePath: f.directory, cmb_thread_incarnation: randomUUID() })])
      if (reason === "workspace") f.database.run("UPDATE threads SET metadata=?", [
        JSON.stringify({ workspacePath: "another", cmb_thread_incarnation: f.target?.incarnation.token })])
      if (reason === "database") f.replaceDatabase()
      if (reason === "retired") f.retire()
      if (reason === "cancelled") f.signal.abort()
      expect(() => binding.assertCurrent()).toThrow()
    }
  )

  it.each([null, "{broken", "null", "[]", "{}"])(
    "does not invent a workspace from legacy metadata %s", metadata => {
      expect(nativeFunctionConversationWorkspace(metadata)).toBeUndefined()
    }
  )
})
