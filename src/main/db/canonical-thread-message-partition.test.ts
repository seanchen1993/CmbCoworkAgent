import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { ThreadMessageWrite } from "../types"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationRawProjection } from
  "./function-conversation-projection-receipt"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-canonical-partition-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(long = false) {
  const database = appDb.getDb(), threadId = randomUUID(), uuid = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  const store = new FunctionConversationStore(database)
  const ref = store.ensureMain({ threadId, workspace: directory,
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, () => undefined)
  const content = long ? "Full protected display ".repeat(20_000) : "Full protected display"
  const calls = [{ id: "actual-call", name: "ActualTool", args: { value: long ? "x".repeat(100_000) : "ok" } }]
  const native = new AIMessage({ id: uuid, content, tool_calls: calls })
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid, role: "assistant", content, tool_calls: calls,
    provider_source_id: "actual-provider", provider_occurrence: 2,
    reasoning: "Actual protected thought", content_mode: "snapshot",
    reasoning_mode: "snapshot", tool_calls_mode: "snapshot", content_priority: 1,
    created_at: new Date(row.createdAt), start_at: new Date(10), end_at: new Date(20)
  }))
  store.commit(ref, { uuid, inputDigest: uuid, door: "response",
    origin: { kind: "model", model: "ActualModel" },
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: content }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-native-occurrence" }, sdk: false, inbox: false },
  () => store.assertCurrent(ref), access.write, access.verify)
  const snapshot = appDb.readCanonicalThreadMessageSnapshot(threadId, uuid)
  if (!snapshot) throw Error("ACTUAL_CANONICAL_SNAPSHOT_MISSING")
  return { database, threadId, uuid, ref, snapshot }
}

describe("strict read-only canonical stream partition", () => {
  it("accepts exact safe snapshots without writing and preserves ordinary upsert changed=0", () => {
    const f = fixture()
    const ordinary: ThreadMessageWrite = { id: randomUUID(), role: "user", content: "Next user",
      created_at: new Date() }
    const run = vi.spyOn(f.database, "run")
    const result = appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot, ordinary])
    expect(result.ordinary).toEqual([ordinary])
    expect(result.canonical).toEqual([f.snapshot])
    expect(result.canonicalIds).toEqual([f.uuid])
    expect(result.canonicalCount).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(Object.isFrozen(result)).toBe(true)
    run.mockRestore()
    expect(appDb.upsertThreadMessages(f.threadId, [f.snapshot])).toBe(0)
    expect(appDb.upsertThreadMessages(f.threadId, result.ordinary,
      { preserveExistingOrder: true }) + result.canonicalCount).toBe(2)
    expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([f.uuid, ordinary.id])
  })

  it("never reclamps the already bounded long display or tool argument projection", () => {
    const f = fixture(true)
    const columns = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    expect(JSON.stringify(f.snapshot.content)).toBe(columns?.content_json)
    expect(JSON.stringify(f.snapshot.tool_calls)).toBe(columns?.tool_calls_json)
    const result = appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot])
    expect(result.canonical).toEqual([f.snapshot])
    expect(result.canonicalCount).toBe(1)
  })

  it.each(FUNCTION_CONVERSATION_PROJECTION_COLUMNS)("rejects changed sealed column %s", field => {
    const f = fixture()
    const columns = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    if (!columns) throw Error("ACTUAL_PROJECTION_MISSING")
    const prior = columns[field]
    const changed = field === "role" ? "system" :
      typeof prior === "number" ? prior + 1 : `${prior ?? ""} changed`
    f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
      [changed, f.threadId, f.uuid])
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot])).toThrow()
  })

  it.each(["content", "tool_calls", "status", "provider_occurrence", "created_at"])(
    "does not turn a wrong echo %s into a successful ACK", field => {
      const f = fixture(), message = { ...f.snapshot }
      if (field === "content") message.content = "raw unprotected echo"
      else if (field === "tool_calls") message.tool_calls = []
      else if (field === "status") message.status = "error"
      else if (field === "provider_occurrence") message.provider_occurrence = 3
      else message.created_at = new Date(123)
      expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [message]))
        .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    })

  it.each(["content_mode", "reasoning_mode", "tool_calls_mode"] as const)(
    "refuses a canonical suffix %s", field => {
      const f = fixture()
      expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId,
        [{ ...f.snapshot, [field]: "delta" }])).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    })

  it("rejects a forged marker, extra execution metadata, missing receipt and pending fragments", () => {
    const f = fixture()
    const stamp = f.snapshot.function_row
    if (!stamp) throw Error("ACTUAL_STAMP_MISSING")
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId,
      [{ ...f.snapshot, function_row: { ...stamp, sequence: stamp.sequence + 1 } }])).toThrow()
    const extra = { ...f.snapshot, additional_kwargs: { raw: true } }
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [extra])).toThrow()
    f.database.run("INSERT INTO thread_message_fragments(thread_id,message_id,content_text,created_at) VALUES(?,?,?,?)",
      [f.threadId, f.uuid, "late raw fragment", 100])
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot])).toThrow()
    f.database.run("DELETE FROM thread_message_fragments WHERE thread_id=?", [f.threadId])
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.threadId])
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot]))
      .toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })

  it("rejects a missing canonical row rather than rewriting a public marker as ordinary", () => {
    const f = fixture()
    f.database.run("DELETE FROM thread_messages WHERE thread_id=?", [f.threadId])
    expect(() => appDb.partitionCanonicalThreadMessageEchoes(f.threadId, [f.snapshot])).toThrow()
  })
})
