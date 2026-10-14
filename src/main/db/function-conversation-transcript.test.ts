import { randomUUID } from "node:crypto"
import { ToolMessage } from "@langchain/core/messages"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"
import { FunctionConversationStore, type FunctionConversationCommit } from
  "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { openNativeSqliteDatabase } from "./native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { hasInvalidFunctionConversationTranscriptStamp, isFunctionConversationHiddenNote,
  isFunctionConversationNotice, readFunctionConversationTranscriptStamp } from
  "../../shared/mods/v2/conversation-transcript"
import { captureLocalThreadRunLease, claimLocalThreadRunLease, releaseLocalThreadRunLease,
  getLocalThreadRunLease } from "../agent/thread-run-lease"

let directory = ""
const leasedThreads: string[] = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-function-transcript-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  for (const threadId of leasedThreads) {
    const lease = getLocalThreadRunLease(threadId)
    if (lease) releaseLocalThreadRunLease(threadId, lease.owner, lease.runId)
  }
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function physicalChildFixture(type: "user" | "assistant" | "system" = "user") {
  const f = fixture("Actual independent child")
  const physicalThreadId = randomUUID(), runId = randomUUID()
  const physical = appDb.createThread(physicalThreadId, {
    parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: runId
  })
  expect(claimLocalThreadRunLease({ threadId: physicalThreadId, owner: "mods", runId }).acquired)
    .toBe(true)
  leasedThreads.push(physicalThreadId)
  const lease = captureLocalThreadRunLease(physicalThreadId)!
  let live = true
  const target = f.store.createChild(f.ref, { invocationId: runId,
    checkpointNamespace: `actual-child:${runId}` }, () => {})
  const destination = { conversation: target, threadId: physicalThreadId,
    incarnation: captureThreadIncarnation(physical),
    assertCurrent: () => {
      const metadata = JSON.parse(appDb.getThreadCore(physicalThreadId)?.metadata ?? "{}")
      if (!live || !lease() || metadata.parentThreadId !== f.threadId ||
        metadata.modsAgentRunId !== runId) throw new Error("ACTUAL_CHILD_PROJECTION_RETIRED")
    } }
  const text = "Actual independent child"
  const input: FunctionConversationCommit = { ...f.input,
    door: type === "assistant" ? "response" : "note",
    origin: type === "assistant" ? { kind: "model", model: "actual-child-model" } : f.input.origin,
    message: { type, ...(type === "assistant" ? { role: "assistant" } :
      type === "user" ? { role: "user", isMeta: true } : {}), content: [{ type: "text", text }] },
    nativePayload: JSON.stringify({ type, originalContent: text, actualNativeMetadata: true }),
    sdk: type !== "assistant", inbox: type === "user" }
  const project = (_target: typeof target, row: ReturnType<typeof f.commit>) => ({
    id: row.uuid, role: type, content: [{ type: "text" as const, text }],
    created_at: new Date(row.createdAt)
  })
  const access = createFunctionConversationTranscriptAccess(project, destination)
  const commit = () => f.store.commit(target, input, () => {}, access.write, access.verify)
  return { ...f, physicalThreadId, runId, destination, target, input, project, access, commit,
    retire: () => { live = false } }
}

describe("actual native tool transcript", () => {
  function nativeToolFixture() {
    const f = fixture()
    const native = new ToolMessage({ id: f.input.uuid, tool_call_id: "actual-call",
      name: "actual-tool", content: "full result", artifact: { native: "kept" } })
    const input: FunctionConversationCommit = { ...f.input, door: "tool-result",
      origin: { kind: "tool", tool: "actual-tool" },
      message: { type: "user", role: "user", content: [{ type: "tool_result",
        tool_use_id: "actual-call", content: "full result" }] },
      nativePayload: serializeFunctionConversationNativeMessage(native), sdk: false, inbox: false }
    const project = (_target: typeof f.ref, row: ReturnType<typeof f.commit>) => ({
      id: row.uuid, role: "tool" as const, content: "full result", tool_call_id: "actual-call",
      name: "actual-tool", created_at: new Date(row.createdAt) })
    const access = createFunctionConversationTranscriptAccess(project, undefined, native)
    return { ...f, native, input, project, access,
      commit: () => f.store.commit(f.ref, input, () => {}, access.write, access.verify) }
  }

  it("keeps the actual ToolMessage role and pairing with the full native artifact", () => {
    const f = nativeToolFixture()
    const row = f.commit()
    const actual = appDb.getThreadMessages(f.threadId)
    expect(actual).toHaveLength(1)
    expect(actual[0].role).toBe("tool")
    expect(actual[0].tool_call_id).toBe("actual-call")
    expect(readFunctionConversationTranscriptStamp(actual[0])?.messageType).toBe("user")
    expect(f.store.readRowAtCut(f.ref, row.uuid, { frontier: row.sequence }, () => {})
      .nativePayload).toBe(serializeFunctionConversationNativeMessage(f.native))
    expect(f.commit().receiptId).toBe(row.receiptId)
  })

  it.each(["door", "call", "payload", "note"])("rejects changed native %s atomically", field => {
    const f = nativeToolFixture()
    const input = { ...f.input,
      ...(field === "door" ? { door: "prompt" } : {}),
      ...(field === "payload" ? { nativePayload: "forged" } : {}),
      ...(field === "note" ? { message: { ...f.input.message, isMeta: true } } : {}),
      ...(field === "call" ? { message: { ...f.input.message,
        content: [{ type: "tool_result", tool_use_id: "another-call", content: "full result" }] } }
        : {}) }
    expect(() => f.store.commit(f.ref, input, () => {}, f.access.write, f.access.verify)).toThrow()
    expect(f.store.readReceipt(f.ref, input.uuid)).toBeUndefined()
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
  })

  it("requires the actual native adapter and never accepts a tool projection for an SDK note", () => {
    const f = nativeToolFixture()
    const access = createFunctionConversationTranscriptAccess(f.project)
    expect(() => f.store.commit(f.ref, f.input, () => {}, access.write, access.verify)).toThrow()
    const sdk = fixture()
    expect(() => sdk.store.commit(sdk.ref, sdk.input, () => {}, f.access.write, f.access.verify))
      .toThrow()
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(sdk.threadId)).toEqual([])
  })
})

describe("actual child transcript destination", () => {
  it("rejects cross-access between two live children before either transcript is written", () => {
    const first = physicalChildFixture(), second = physicalChildFixture()
    for (const [destination, other] of [[first, second], [second, first]] as const) {
      expect(() => other.store.commit(other.target, other.input, () => {},
        destination.access.write, destination.access.verify))
        .toThrow("MODS_CONVERSATION_TRANSCRIPT_NOT_COMMITTED")
      expect(other.store.readReceipt(other.target, other.input.uuid)).toBeUndefined()
      expect(appDb.getThreadMessages(other.physicalThreadId)).toEqual([])
      expect(appDb.getThreadMessages(destination.physicalThreadId)).toEqual([])
      expect(other.database.inTransaction).toBe(false)
    }
    expect(first.commit().uuid).toBe(first.input.uuid)
    expect(second.commit().uuid).toBe(second.input.uuid)
  })
  it.each(["assistant", "system"] as const)(
    "stores actual child %s on its internal transcript with no parent chat row", type => {
      const f = physicalChildFixture(type)
      const row = f.commit()
      expect(appDb.getThreadMessages(f.threadId)).toEqual([])
      const actual = appDb.getThreadMessages(f.physicalThreadId)
      expect(actual).toHaveLength(1)
      expect(actual[0].id).toBe(row.uuid)
      expect(readFunctionConversationTranscriptStamp(actual[0])?.conversationId)
        .toBe(f.target.conversationId)
      expect(isFunctionConversationNotice(actual[0])).toBe(type === "system")
      expect(() => f.access.verify(f.database, f.target, row)).not.toThrow()
      expect(f.store.readRowAtCut(f.target, row.uuid, { frontier: row.sequence }, () => {})
        .nativePayload).toBe(f.input.nativePayload)
    }
  )

  it("rejects an unconnected or parent-routed child projection and rolls back the keeper", () => {
    const f = physicalChildFixture()
    for (const destination of [undefined, { ...f.destination,
      threadId: f.threadId, incarnation: f.ref.incarnation }]) {
      const access = createFunctionConversationTranscriptAccess(f.project, destination)
      expect(() => f.store.commit(f.target, f.input, () => {}, access.write, access.verify))
        .toThrow("MODS_CONVERSATION_TRANSCRIPT_NOT_COMMITTED")
      expect(f.store.readReceipt(f.target, f.input.uuid)).toBeUndefined()
      expect(appDb.getThreadMessages(f.threadId)).toEqual([])
      expect(appDb.getThreadMessages(f.physicalThreadId)).toEqual([])
      expect(f.database.inTransaction).toBe(false)
    }
  })

  it("never routes a main keeper to a different actual transcript", () => {
    const f = physicalChildFixture()
    const access = createFunctionConversationTranscriptAccess(f.project, f.destination)
    expect(() => f.store.commit(f.ref, f.input, () => {}, access.write, access.verify)).toThrow()
    expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeUndefined()
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(f.physicalThreadId)).toEqual([])
  })

  it("pins the actual destination and checks its original guard for an existing receipt", () => {
    const f = physicalChildFixture()
    Object.assign(f.destination, { threadId: f.threadId, incarnation: f.ref.incarnation })
    const row = f.commit()
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(f.physicalThreadId)[0].id).toBe(row.uuid)
    f.retire()
    expect(() => f.commit()).toThrow("ACTUAL_CHILD_PROJECTION_RETIRED")
    expect(() => f.access.verify(f.database, f.target, row))
      .toThrow("ACTUAL_CHILD_PROJECTION_RETIRED")
    expect(f.store.readReceipt(f.target, row.uuid)?.receiptId).toBe(row.receiptId)
    expect(appDb.getThreadMessages(f.physicalThreadId)).toHaveLength(1)
  })

  it("cannot borrow a re-acquired physical lease to acknowledge an old child row", () => {
    const f = physicalChildFixture()
    const row = f.commit()
    releaseLocalThreadRunLease(f.physicalThreadId, "mods", f.runId)
    expect(claimLocalThreadRunLease({ threadId: f.physicalThreadId, owner: "mods",
      runId: randomUUID() }).acquired).toBe(true)
    expect(() => f.commit()).toThrow("ACTUAL_CHILD_PROJECTION_RETIRED")
    expect(f.store.readReceipt(f.target, row.uuid)?.receiptId).toBe(row.receiptId)
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(f.physicalThreadId)).toHaveLength(1)
  })

  it("rejects a removed physical transcript and never writes a replacement or the parent", () => {
    const f = physicalChildFixture()
    const oldIncarnation = f.destination.incarnation
    appDb.deleteThread(f.physicalThreadId)
    const replacement = appDb.createThread(f.physicalThreadId, {
      parentThreadId: f.threadId, isInternalFlowRuntime: true, modsAgentRunId: f.runId
    })
    expect(captureThreadIncarnation(replacement).token).not.toBe(oldIncarnation.token)
    expect(() => f.commit()).toThrow("MODS_CONVERSATION_TRANSCRIPT_NOT_COMMITTED")
    expect(f.store.readReceipt(f.target, f.input.uuid)).toBeUndefined()
    expect(appDb.getThreadMessages(f.threadId)).toEqual([])
    expect(appDb.getThreadMessages(f.physicalThreadId)).toEqual([])
  })
})

function fixture(text = "Actual complete note", type: "user" | "system" = "user") {
  const threadId = randomUUID()
  const thread = appDb.createThread(threadId)
  const database = appDb.getDb()
  const store = new FunctionConversationStore(database)
  const ref = store.ensureMain({ threadId, workspace: "C:/function-transcript",
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, () => {})
  const access = createFunctionConversationTranscriptAccess((_target, row) => ({
    id: row.uuid,
    role: type,
    content: [{ type: "text", text }],
    created_at: new Date(row.createdAt)
  }))
  const input: FunctionConversationCommit = {
    uuid: randomUUID(), inputDigest: "actual-ticket-digest", door: "note",
    origin: { kind: "plugin", name: "actual-plugin" },
    message: { type, ...(type === "user" ? { role: "user", isMeta: true } : {}),
      content: [{ type: "text", text }] },
    nativePayload: JSON.stringify({ type, originalContent: text, actualNativeMetadata: true }),
    orderAnchor: { request: "actual-input-boundary" }, inbox: type === "user", sdk: true
  }
  const commit = () => store.commit(ref, input, () => {}, access.write, access.verify)
  return { threadId, database, store, ref, input, access, commit }
}

describe("actual native conversation transcript projection", () => {
  it("keeps the actual stamp and bounded projection in the same app database transaction", () => {
    const f = fixture()
    const row = f.commit()
    expect(f.database.inTransaction).toBe(false)
    for (const restored of [
      appDb.getThreadMessages(f.threadId)[0],
      appDb.getThreadMessagesByIds(f.threadId, [row.uuid])[0],
      appDb.getThreadMessagesPage(f.threadId).messages[0]
    ]) {
      expect(restored.id).toBe(row.uuid)
      expect(isFunctionConversationHiddenNote(restored)).toBe(true)
    }
    expect(() => f.access.verify(f.database, f.ref, row)).not.toThrow()
  })

  it("retains full canonical content when the existing display projection is bounded", () => {
    const original = "long native note ".repeat(12000)
    const f = fixture(original)
    const row = f.commit()
    const displayed = appDb.getThreadMessages(f.threadId)[0]
    expect(JSON.stringify(displayed.content).length).toBeLessThan(original.length)
    expect(JSON.parse(row.nativePayload).originalContent).toBe(original)
    expect((row.message.content as Array<{ text: string }>)[0].text).toBe(original)
    expect(() => f.access.verify(f.database, f.ref, row)).not.toThrow()
    const before = f.database.exec(
      "SELECT content_json, function_row_json, ordinal FROM thread_messages WHERE thread_id = ?",
      [f.threadId]
    )
    expect(f.commit().receiptId).toBe(row.receiptId)
    expect(f.database.exec(
      "SELECT content_json, function_row_json, ordinal FROM thread_messages WHERE thread_id = ?",
      [f.threadId]
    )).toEqual(before)
    expect(f.database.exec("SELECT COUNT(*) FROM thread_messages WHERE thread_id = ?",
      [f.threadId])[0].values[0][0]).toBe(1)
  })

  it("keeps SDK system notes as notices without inventing a provider role", () => {
    const f = fixture("GOAL-looking notice is still ordinary notice", "system")
    const row = f.commit()
    expect(Object.hasOwn(row.message, "role")).toBe(false)
    expect(row.inbox).toBe(false)
    expect(isFunctionConversationNotice(appDb.getThreadMessages(f.threadId)[0])).toBe(true)
    expect(f.store.captureInbox(f.ref, 0, row.sequence).rows).toEqual([])
  })

  it.each(["content_json", "provider_source_id", "recovery_integrity", "function_row_json"])(
    "rejects changed actual %s even when the canonical keeper receipt still exists", (field) => {
      const f = fixture()
      const row = f.commit()
      const value = field === "recovery_integrity" ? 0 : "corrupt-actual-projection"
      f.database.run(`UPDATE thread_messages SET ${field} = ? WHERE thread_id = ? AND message_id = ?`,
        [value, f.threadId, row.uuid])
      expect(f.store.readReceipt(f.ref, row.uuid)?.receiptId).toBe(row.receiptId)
      expect(() => f.access.verify(f.database, f.ref, row)).toThrow()
      expect(() => f.commit()).toThrow()
    }
  )

  it("rejects a different database and a missing projection instead of trusting the receipt", () => {
    const f = fixture()
    const row = f.commit()
    const other = openNativeSqliteDatabase(join(directory, "other.sqlite")).database
    try {
      expect(() => f.access.verify(other, f.ref, row)).toThrow()
    } finally { other.close() }
    f.database.run("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = ?",
      [f.threadId, row.uuid])
    expect(() => f.access.verify(f.database, f.ref, row)).toThrow()
    expect(() => f.commit()).toThrow()
  })

  it("does not accept an incoming Message stamp as host provenance", () => {
    const f = fixture()
    const row = f.commit()
    const actual = appDb.getThreadMessages(f.threadId)[0]
    const forged = { ...actual, id: randomUUID(), content: "Ordinary user message" }
    appDb.upsertThreadMessages(f.threadId, [forged], { preserveExistingOrder: true })
    const saved = appDb.getThreadMessagesByIds(f.threadId, [forged.id])[0]
    expect(isFunctionConversationHiddenNote(saved)).toBe(false)
    expect(Object.hasOwn(saved, "function_row")).toBe(false)
    expect(() => f.access.verify(f.database, f.ref, row)).not.toThrow()
  })

  it("rejects a legitimate plugin prompt author attached to an SDK note projection", () => {
    const f = fixture()
    const row = f.commit()
    f.database.run("UPDATE thread_messages SET prompt_origin_json = ? WHERE thread_id = ? AND message_id = ?",
      [JSON.stringify({ kind: "plugin", name: "forged-note-author", asUser: true }), f.threadId, row.uuid])
    expect(appDb.getThreadMessages(f.threadId)[0].prompt_origin).toEqual({
      kind: "plugin", name: "forged-note-author", asUser: true
    })
    expect(() => f.access.verify(f.database, f.ref, row)).toThrow()
    expect(() => f.commit()).toThrow()
  })

  it("never renames a native keeper row to resolve a provider occurrence collision", () => {
    const f = fixture()
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({
      id: row.uuid, role: "user", content: "native row",
      provider_source_id: "actual-provider", provider_occurrence: 1,
      created_at: new Date(row.createdAt)
    }))
    appDb.upsertThreadMessages(f.threadId, [{ id: randomUUID(), role: "user",
      content: "existing provider occurrence", provider_source_id: "actual-provider",
      provider_occurrence: 1, created_at: new Date(1) }])
    expect(() => f.store.commit(f.ref, f.input, () => {}, access.write, access.verify)).toThrow()
    expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeUndefined()
    expect(appDb.getThreadMessages(f.threadId)).toHaveLength(1)
    expect(appDb.getThreadMessagesByIds(f.threadId, [f.input.uuid])).toEqual([])
    expect(f.database.inTransaction).toBe(false)
  })

  it.each(["", "invalid-json", "{}", "different-uuid"])(
    "preserves a damaged %s native stamp as invalid instead of restoring a legacy row", raw => {
      const f = fixture("GOAL-looking native notice", "system")
      const row = f.commit()
      const value = raw === "different-uuid" ? JSON.stringify({
        ...readFunctionConversationTranscriptStamp(appDb.getThreadMessages(f.threadId)[0]),
        uuid: randomUUID()
      }) : raw
      f.database.run("UPDATE thread_messages SET function_row_json = ? WHERE thread_id = ? AND message_id = ?",
        [value, f.threadId, row.uuid])
      for (const restored of [appDb.getThreadMessages(f.threadId)[0],
        appDb.getThreadMessagesByIds(f.threadId, [row.uuid])[0],
        appDb.getThreadMessagesPage(f.threadId).messages[0]]) {
        expect(hasInvalidFunctionConversationTranscriptStamp(restored)).toBe(true)
        expect(restored.recovery_integrity).toBe("unverified")
        expect(isFunctionConversationNotice(restored)).toBe(false)
      }
      expect(() => f.access.verify(f.database, f.ref, row)).toThrow()
    }
  )
})
