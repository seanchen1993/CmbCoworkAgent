import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openNativeSqliteDatabase, readFunctionConversationNativeSqliteCurrentExecution }
  from "./native-sqlite-adapter"
import { createNativeThreadIdentityReader, createNativeJoinedThreadIdentityReader,
  NATIVE_JOINED_CURRENT_QUERY, NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY }
  from "./native-thread-identity-reader"

describe("native identity text transfer deduplication", () => {
  it.each([false, true])("keeps all joined columns fresh (high water: %s)", highWater => {
    const directory = mkdtempSync(join(tmpdir(), "native-joined-identity-text-"))
    const { database } = openNativeSqliteDatabase(join(directory, "test.sqlite"), "Identity")
    try {
      database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata COLLATE NOCASE)")
      database.run(`CREATE TABLE function_conversations(conversation_id TEXT PRIMARY KEY,
        logical_session_id TEXT, kind TEXT, checkpoint_namespace TEXT, next_sequence INTEGER)`)
      database.run(`CREATE TABLE function_conversation_branches(branch_id TEXT PRIMARY KEY,
        conversation_id TEXT)`)
      database.run(`CREATE TABLE function_logical_sessions(logical_session_id TEXT PRIMARY KEY,
        thread_id TEXT, incarnation_key TEXT, workspace TEXT)`)
      database.run("INSERT INTO function_conversations VALUES('c','s','main','',1)")
      database.run("INSERT INTO function_conversation_branches VALUES('b','c')")
      database.run("INSERT INTO function_logical_sessions VALUES('s','a','incarnation','workspace')")
      const read = createNativeJoinedThreadIdentityReader(
        readFunctionConversationNativeSqliteCurrentExecution(database)!, highWater)
      const ordinary = database.prepareReadOne(highWater ? NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY :
        NATIVE_JOINED_CURRENT_QUERY)
      const bindings = ["c", "b", "a"]
      const large = JSON.stringify({ padding: "汉😀".repeat(20000), token: "original" })
      database.run("INSERT INTO threads VALUES('a',1,?)", [large])
      expect(read(bindings)).toEqual(ordinary(bindings))
      read(bindings)!.physical_metadata = "caller mutation"
      database.run("UPDATE threads SET created_at=2 WHERE thread_id='a'")
      database.run("UPDATE function_conversations SET next_sequence=8,kind='fork',checkpoint_namespace='next'")
      database.run("UPDATE function_logical_sessions SET incarnation_key='changed',workspace='changed'")
      expect(read(bindings)).toEqual(ordinary(bindings))
      for (const metadata of [null, "", "{broken", '{"x":1,"x":2}', "汉😀", "A", "a",
        "x\u0000y", "\ud800", "\udc00", 123, new Uint8Array([65]), "x".repeat(300000), large]) {
        database.run("UPDATE threads SET metadata=? WHERE thread_id='a'", [metadata])
        expect(read(bindings)).toEqual(ordinary(bindings))
        expect(read(bindings)).toEqual(ordinary(bindings))
      }
      // Same physical thread/metadata cannot keep stale joins or a stale high-water mark.
      expect(read(["missing", "b", "a"])).toEqual(ordinary(["missing", "b", "a"]))
      database.run("DELETE FROM function_conversation_branches WHERE branch_id='b'")
      expect(read(bindings)).toEqual(ordinary(bindings))
      database.run("DELETE FROM threads WHERE thread_id='a'")
      expect(read(bindings)).toBeUndefined()
      database.run("INSERT INTO threads VALUES('a',3,?)", [large])
      expect(read(bindings)).toEqual(ordinary(bindings))
      database.close()
      expect(() => read(bindings)).toThrow()
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reads current timestamps, raw metadata and deletion on every call", () => {
    const directory = mkdtempSync(join(tmpdir(), "native-identity-text-"))
    const { database } = openNativeSqliteDatabase(join(directory, "test.sqlite"), "Identity")
    try {
      // Deliberately permissive/NOCASE storage verifies explicit BINARY and type handling.
      database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata COLLATE NOCASE)")
      const read = createNativeThreadIdentityReader(
        readFunctionConversationNativeSqliteCurrentExecution(database)!)
      const ordinary = database.prepareReadOne(
        "SELECT created_at,metadata FROM threads WHERE thread_id=?")
      const large = JSON.stringify({ padding: "汉😀".repeat(20000), token: "original" })
      database.run("INSERT INTO threads VALUES('a',1,?)", [large])
      const first = read(["a"])!
      expect(first.metadata).toBe(large)
      first.metadata = "caller mutation"
      database.run("UPDATE threads SET created_at=2 WHERE thread_id='a'")
      expect(read(["a"])).toEqual({ created_at: 2, metadata: large })
      for (const metadata of [null, "", "{broken", '{"x":1,"x":2}', "汉😀", "A", "a",
        "x\u0000y", "\ud800", "\udc00", 123, new Uint8Array([65]), "x".repeat(300000)]) {
        database.run("UPDATE threads SET metadata=? WHERE thread_id='a'", [metadata])
        // Compare the original native API, including its embedded-NUL text behavior.
        expect(read(["a"])).toEqual(ordinary(["a"]))
        expect(read(["a"])).toEqual(ordinary(["a"]))
      }
      database.run("INSERT INTO threads VALUES('b',3,?)", [large])
      expect(read(["b"])).toEqual({ created_at: 3, metadata: large })
      database.run("DELETE FROM threads WHERE thread_id='b'")
      expect(read(["b"])).toBeUndefined()
      database.run("INSERT INTO threads VALUES('b',4,?)", [large])
      expect(read(["b"])).toEqual({ created_at: 4, metadata: large })
      database.close()
      expect(() => read(["b"])).toThrow()
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
