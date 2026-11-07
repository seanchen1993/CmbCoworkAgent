import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openNativeSqliteDatabase, readFunctionConversationNativeSqliteCurrentExecution }
  from "./native-sqlite-adapter"
import { createNativeJoinedIncarnationReader } from "./native-joined-incarnation-reader"
import { NATIVE_JOINED_CURRENT_QUERY, NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY }
  from "./native-thread-identity-reader"
import { THREAD_RUNTIME_SCOPE_INDEX, THREAD_RUNTIME_SCOPE_EXPRESSION } from "./thread-runtime-scope-query"

describe("native joined identity-only indexed projection", () => {
  it.each([false, true])("preserves every current join field and raw non-TEXT value (high water %s)", highWater => {
    const directory = mkdtempSync(join(tmpdir(), "joined-incarnation-"))
    const { database } = openNativeSqliteDatabase(join(directory, "actual.sqlite"))
    try {
      database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata)")
      database.run(`CREATE TABLE function_conversations(conversation_id TEXT PRIMARY KEY,
        logical_session_id TEXT, kind TEXT, checkpoint_namespace TEXT, next_sequence INTEGER)`)
      database.run("CREATE TABLE function_conversation_branches(branch_id TEXT, conversation_id TEXT)")
      database.run(`CREATE TABLE function_logical_sessions(logical_session_id TEXT PRIMARY KEY,
        thread_id TEXT, incarnation_key TEXT, workspace TEXT)`)
      database.run("INSERT INTO function_conversations VALUES('c','s','main','',1)")
      database.run("INSERT INTO function_conversation_branches VALUES('b','c')")
      database.run("INSERT INTO function_logical_sessions VALUES('s','a','incarnation','workspace')")
      const raw = JSON.stringify({ cmb_thread_incarnation: "actual", llmFileHistory: "汉😀".repeat(20000) })
      database.run("INSERT INTO threads VALUES('a',1,?)", [raw])
      const execution = readFunctionConversationNativeSqliteCurrentExecution(database)!
      const ordinary = database.prepareReadOne(highWater ? NATIVE_JOINED_CURRENT_HIGH_WATER_QUERY : NATIVE_JOINED_CURRENT_QUERY)
      const args = ["c", "b", "a"]
      const withoutIndex = createNativeJoinedIncarnationReader(execution, highWater)
      expect(withoutIndex(args)).toEqual(ordinary(args))
      database.run(`CREATE INDEX ${THREAD_RUNTIME_SCOPE_INDEX} ON threads(thread_id, ${THREAD_RUNTIME_SCOPE_EXPRESSION})`)
      expect(withoutIndex(args)).toEqual(ordinary(args))
      const read = createNativeJoinedIncarnationReader(execution, highWater)
      expect(read(args)?.physical_metadata).toBe('{"cmb_thread_incarnation":"actual"}')
      const projected = database.prepareReadOne(`SELECT CASE WHEN typeof(metadata)='text'
        THEN ${THREAD_RUNTIME_SCOPE_EXPRESSION} ELSE metadata END AS metadata FROM threads WHERE thread_id=?`)
      for (const metadata of [null, "{broken", "[]", "42", 123,
        '{"cmb_thread_incarnation":"first","cmb_thread_incarnation":"last","llmFileHistory":1}',
        '{"cmb_thread_incarnation":null,"llmFileHistory":1}', "A", "a",
        new Uint8Array(Buffer.from('{"cmb_thread_incarnation":"blob","llmFileHistory":1}')),
        new Uint8Array([0, 1, 255]), raw]) {
        database.run("UPDATE threads SET metadata=?,created_at=created_at+1 WHERE thread_id='a'", [metadata])
        database.run("UPDATE function_conversations SET next_sequence=next_sequence+1")
        const expected = { ...ordinary(args), physical_metadata: projected(["a"])!.metadata }
        expect(read(args)).toEqual(expected)
        expect(read(args)).toEqual(expected)
      }
      database.run("UPDATE function_logical_sessions SET workspace='changed',incarnation_key='changed'")
      database.run("UPDATE function_conversations SET kind='fork',checkpoint_namespace='changed'")
      expect(read(args)).toEqual({ ...ordinary(args), physical_metadata: projected(["a"])!.metadata })
      database.run("DELETE FROM threads WHERE thread_id='a'")
      expect(read(args)).toBeUndefined()
      database.run("INSERT INTO threads VALUES('a',100,?)", [raw])
      expect(read(args)?.physical_created_at).toBe(100)
      database.run(`DROP INDEX ${THREAD_RUNTIME_SCOPE_INDEX}`)
      expect(read(args)).toEqual(ordinary(args))
      database.run("UPDATE threads SET metadata='changed again' WHERE thread_id='a'")
      expect(read(args)).toEqual(ordinary(args))
      database.close()
      expect(() => read(args)).toThrow()
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
