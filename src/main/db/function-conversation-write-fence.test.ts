import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { ThreadMessageWrite } from "../types"
import { buildMessageRoleCollisionId, normalizeMessageRoleCollisionIds } from
  "../../shared/message-role-collision"
import {
  mergeLiveStreamCommitMessagesDetailed,
  resolveCommittedLiveStreamMessages
} from "../../renderer/src/lib/live-stream-messages"
import type { Message } from "../../renderer/src/types"
import { createLiveDisplayMessageProjector } from
  "../../renderer/src/lib/live-display-message-projection"
import { createChatMessageProjector } from "../../renderer/src/lib/chat-message-projection"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { readFunctionConversationRawProjection, readFunctionConversationProjectionReceipt } from
  "./function-conversation-projection-receipt"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-function-write-fence-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(before: readonly ThreadMessageWrite[] = [],
  identity: { uuid?: string; provider?: string; occurrence?: number } = {}) {
  const database = appDb.getDb(), threadId = randomUUID(), uuid = identity.uuid ?? randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  appDb.upsertThreadMessages(threadId, before)
  const incarnation = captureThreadIncarnation(thread), store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, incarnation, workspace: directory,
    checkpointNamespace: "" }, () => {})
  const provider = identity.provider ?? randomUUID(), content = "Protected actual native answer"
  const toolCalls = [{ id: randomUUID(), name: "actual-tool", args: { route: "safe" } }]
  const native = new AIMessage({ id: uuid, content, tool_calls: toolCalls,
    additional_kwargs: { reasoning_content: "protected thought" },
    response_metadata: { finish_reason: "tool_calls" } })
  const projected = (createdAt: number): ThreadMessageWrite => ({ id: uuid, role: "assistant",
    content, reasoning: "protected thought", tool_calls: toolCalls,
    provider_source_id: provider, provider_occurrence: identity.occurrence ?? 2,
    content_mode: "snapshot", reasoning_mode: "snapshot", tool_calls_mode: "snapshot",
    content_priority: 3, recovery_integrity: "verified", created_at: new Date(createdAt) })
  const access = createFunctionConversationTranscriptAccess((_ref, row) => projected(row.createdAt))
  const row = store.commit(target, { uuid, inputDigest: uuid, door: "response",
    origin: { kind: "model", model: "actual-native-model" },
    message: { type: "assistant", role: "assistant", content: [{ type: "text", text: content }] },
    nativePayload: serializeFunctionConversationNativeMessage(native), orderAnchor: { native: uuid },
    sdk: false, inbox: false }, () => store.assertCurrent(target), access.write, access.verify)
  const selection = { target, row, threadId, incarnation,
    assertCurrent: () => store.assertCurrent(target) }
  const original = readFunctionConversationProjectionReceipt(database, selection)
  const receipt = () => database.exec(`SELECT * FROM function_conversation_projection_receipts
    WHERE thread_id=? AND uuid=?`, [threadId, uuid])
  const originalReceipt = receipt()
  const assertKept = () => {
    expect(readFunctionConversationRawProjection(database, threadId, uuid)).toEqual(original)
    expect(readFunctionConversationProjectionReceipt(database, selection)).toEqual(original)
    expect(receipt()).toEqual(originalReceipt)
    expect(database.exec(`SELECT COUNT(*) FROM thread_message_fragments
      WHERE thread_id=? AND message_id=?`, [threadId, uuid])[0].values[0][0]).toBe(0)
    expect(database.exec(`SELECT COUNT(*) FROM thread_message_fragment_states
      WHERE thread_id=? AND message_id=?`, [threadId, uuid])[0].values[0][0]).toBe(0)
  }
  return { database, threadId, uuid, provider, projected: projected(row.createdAt),
    selection, original, assertKept }
}

function expectEchoConflict(action: () => unknown, field: string): void {
  let failure: unknown
  try { action() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("MODS_CONVERSATION_PROJECTION_CONFLICT")
  expect((failure as Error).stack).toContain(`CanonicalTranscriptEcho.${field}`)
}

describe("actual immutable kept-row write fences", () => {
  it("flushes a sealed host answer after a temporary stream row without duplicating or rewriting it", () => {
    const f = fixture([], { occurrence: 1 })
    const canonical = appDb.getThreadMessages(f.threadId) as Message[]
    expect(canonical).toHaveLength(1)
    expect(canonical[0].function_row?.uuid).toBe(f.uuid)
    const temporary: Message = {
      id: f.provider,
      role: "assistant",
      provider_source_id: f.provider,
      provider_occurrence: 1,
      content: "Protected actual native answer",
      created_at: new Date()
    }
    const normalized = normalizeMessageRoleCollisionIds([temporary], canonical)
    const committed = mergeLiveStreamCommitMessagesDetailed([temporary], normalized)
    expect(committed.messages.map((message) => message.id)).toEqual([f.uuid])
    const resolved = resolveCommittedLiveStreamMessages(
      committed.messages,
      committed.resolvedIncoming
    )
    expect(resolved.unresolved).toEqual([])
    expect(resolved.resolved.map((message) => message.id)).toEqual([f.uuid])
    expect(appDb.upsertThreadMessages(f.threadId, resolved.resolved)).toBe(0)
    expect(appDb.getThreadMessages(f.threadId).map((message) => message.id)).toEqual([f.uuid])
    // No guessed durable alias and no writes to the sealed answer or its receipt.
    expect(appDb.getThreadMessageCanonicalId(f.threadId, f.provider)).toBe(f.provider)
    const live = createLiveDisplayMessageProjector()(committed.messages, [{
      id: f.provider,
      type: "ai",
      provider_source_id: f.provider,
      provider_occurrence: 1,
      content: "Protected actual native answer"
    }])
    const display = createChatMessageProjector()(committed.messages, live.messages, undefined)
    expect(display.messages.map((message) => message.id)).toEqual([f.uuid])
    f.assertKept()
  })

  it("consumes a late authoritative raw snapshot while persisting its ordinary batch neighbour", () => {
    const f = fixture(), ordinary = randomUUID()
    expect(appDb.upsertThreadMessages(f.threadId, [{ ...f.projected,
      content: "late raw answer before protection", reasoning: "raw thought",
      tool_calls: [{ id: "different-call", name: "different-tool", args: { route: "raw" } }],
      content_priority: 99, created_at: new Date(999999), start_at: new Date(1), end_at: new Date(2) },
    { id: ordinary, role: "user", content: "ordinary new user", created_at: new Date() }])).toBe(1)
    f.assertKept()
    expect(appDb.getThreadMessages(f.threadId).find(message => message.id === ordinary)?.content)
      .toBe("ordinary new user")
    expect(appDb.getThreadMessageCount(f.threadId)).toBe(2)
  })

  it("consumes canonical AI delta as handled without writing a fragment or touching a receipt", () => {
    const f = fixture()
    expect(appDb.appendThreadMessageTextDelta(f.threadId, { id: f.uuid, role: "assistant",
      content: "late raw delta", provider_source_id: f.provider, provider_occurrence: 2,
      created_at: new Date() })).toBe(true)
    f.assertKept()
  })

  it.each(["role", "provider", "occurrence"])(
    "rejects a real canonical %s mismatch before saving a same-batch ordinary row", mismatch => {
      const f = fixture(), ordinary = randomUUID()
      const incoming: ThreadMessageWrite = { ...f.projected, content: "late raw",
        ...(mismatch === "role" ? { role: "user" as const } :
          mismatch === "provider" ? { provider_source_id: "foreign-provider" } :
            { provider_occurrence: 3 }) }
      expectEchoConflict(() => appDb.upsertThreadMessages(f.threadId, [
        { id: ordinary, role: "user", content: "must not be saved", created_at: new Date() }, incoming
      ]), mismatch === "provider" ? "provider_source_id" :
        mismatch === "occurrence" ? "provider_occurrence" : "role")
      expect(appDb.getThreadMessagesByIds(f.threadId, [ordinary])).toEqual([])
      expect(appDb.getThreadMessageCount(f.threadId)).toBe(1)
      expect(appDb.getThreadMessageCanonicalId(f.threadId, incoming.id)).toBe(incoming.id)
      f.assertKept()
    }
  )

  it("rejects a new provider alias and explicit ID replacements without recording an alias", () => {
    const f = fixture(), alias = randomUUID(), other = randomUUID()
    expectEchoConflict(() => appDb.upsertThreadMessages(f.threadId,
      [{ ...f.projected, id: alias, content: "late alias raw" }]), "canonical_id")
    expect(() => appDb.replaceThreadMessageId(f.threadId, f.uuid, alias, "assistant"))
      .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    appDb.upsertThreadMessages(f.threadId, [{ id: other, role: "assistant", content: "ordinary",
      created_at: new Date() }],
      { preserveExistingOrder: true })
    expect(() => appDb.replaceThreadMessageId(f.threadId, other, f.uuid, "assistant"))
      .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(appDb.getThreadMessageCanonicalId(f.threadId, f.uuid)).toBe(f.uuid)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, alias)).toBe(alias)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, other)).toBe(other)
    f.assertKept()
  })

  it("keeps the original echo field order and getter counts without logging message values", () => {
    const f = fixture(), reads: string[] = []
    const incoming: ThreadMessageWrite = { ...f.projected }
    for (const field of ["role", "provider_source_id", "provider_occurrence"] as const) {
      Object.defineProperty(incoming, field, {
        enumerable: true,
        get() {
          if (Error().stack?.includes("at assertCanonicalThreadMessageEcho")) reads.push(field)
          return f.projected[field]
        }
      })
    }
    expect(appDb.upsertThreadMessages(f.threadId, [incoming])).toBe(0)
    expect(reads).toEqual(["role", "provider_source_id", "provider_source_id",
      "provider_occurrence", "provider_occurrence"])
    f.assertKept()
  })

  it("reorders ordinary rows in their original slots while a canonical ordinal stays pinned", () => {
    const first = randomUUID(), last = randomUUID()
    const a: ThreadMessageWrite = { id: first, role: "user", content: "ordinary first",
      created_at: new Date(1) }
    const b: ThreadMessageWrite = { id: last, role: "user", content: "ordinary last",
      created_at: new Date(3) }
    const f = fixture([a])
    appDb.upsertThreadMessages(f.threadId, [b], { preserveExistingOrder: true })
    appDb.upsertThreadMessages(f.threadId, [b, f.projected, a])
    expect(f.database.exec(`SELECT message_id,ordinal FROM thread_messages WHERE thread_id=?
      ORDER BY ordinal`, [f.threadId])[0].values).toEqual([[last, 0], [f.uuid, 1], [first, 2]])
    f.assertKept()
  })

  it("keeps a canonical pin intact when moving an ordinary block through its neighbours", () => {
    const anchor = randomUUID(), middle = randomUUID(), last = randomUUID()
    const f = fixture([{ id: anchor, role: "user", content: "original anchor", created_at: new Date(1) }])
    appDb.upsertThreadMessages(f.threadId, [
      { id: middle, role: "assistant", content: "ordinary middle", created_at: new Date(3) },
      { id: last, role: "assistant", content: "ordinary tail", created_at: new Date(4) }
    ], { preserveExistingOrder: true })
    expect(appDb.moveThreadMessagesAfterAnchor(f.threadId, anchor, [last])).toBe(true)
    expect(f.database.exec(`SELECT message_id,ordinal FROM thread_messages WHERE thread_id=?
      ORDER BY ordinal`, [f.threadId])[0].values)
      .toEqual([[anchor, 0], [f.uuid, 1], [last, 2], [middle, 3]])
    f.assertKept()
    expect(() => appDb.moveThreadMessagesAfterAnchor(f.threadId, anchor, [f.uuid]))
      .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    f.assertKept()
  })

  it.each(["raw", "receipt", "state"])(
    "rejects damaged canonical %s without writing a mixed ordinary message", corruption => {
      const f = fixture(), ordinary = randomUUID()
      if (corruption === "raw") f.database.run(`UPDATE thread_messages SET content_json=?
        WHERE thread_id=? AND message_id=?`, [JSON.stringify("tampered"), f.threadId, f.uuid])
      else if (corruption === "receipt") f.database.run(`DELETE FROM function_conversation_projection_receipts
        WHERE thread_id=? AND uuid=?`, [f.threadId, f.uuid])
      else f.database.run(`INSERT INTO thread_message_fragment_states
        (thread_id,message_id,total_chars,updated_at) VALUES (?,?,0,?)`, [f.threadId, f.uuid, Date.now()])
      expect(() => appDb.upsertThreadMessages(f.threadId,
        [f.projected, { id: ordinary, role: "user", content: "must not be saved",
          created_at: new Date() }])).toThrow()
      expect(() => appDb.appendThreadMessageTextDelta(f.threadId, { id: f.uuid, role: "assistant",
        content: "must not append", provider_source_id: f.provider, provider_occurrence: 2,
        created_at: new Date() })).toThrow()
      expect(appDb.getThreadMessagesByIds(f.threadId, [ordinary])).toEqual([])
      expect(appDb.getThreadMessageCount(f.threadId)).toBe(1)
    }
  )

  it("preserves the original unmarked snapshot, delta, alias and reorder behaviour", () => {
    const threadId = randomUUID(), user = randomUUID(), temporary = randomUUID(), final = randomUUID()
    const provider = randomUUID()
    appDb.createThread(threadId)
    const a: ThreadMessageWrite = { id: user, role: "user", content: "ordinary user", created_at: new Date(1) }
    const b: ThreadMessageWrite = { id: temporary, role: "assistant", content: "ordinary draft",
      provider_source_id: provider, provider_occurrence: 1, created_at: new Date(2) }
    expect(appDb.upsertThreadMessages(threadId, [a, b])).toBe(2)
    expect(appDb.appendThreadMessageTextDelta(threadId, { ...b, content: " tail",
      created_at: new Date() })).toBe(true)
    expect(appDb.getThreadMessages(threadId).find(message => message.id === temporary)?.content)
      .toBe("ordinary draft tail")
    expect(appDb.replaceThreadMessageId(threadId, temporary, final, "assistant")).toBe(true)
    expect(appDb.getThreadMessageCanonicalId(threadId, temporary)).toBe(final)
    appDb.upsertThreadMessages(threadId, [{ ...b, id: final, content: "ordinary replacement",
      content_mode: "snapshot" }, a])
    expect(appDb.getThreadMessages(threadId).map(message => message.id)).toEqual([final, user])
    expect(appDb.getThreadMessages(threadId)[0].content).toBe("ordinary replacement")
    expect(appDb.getDb().exec(`SELECT COUNT(*) FROM thread_messages WHERE thread_id=?
      AND function_row_json IS NOT NULL`, [threadId])[0].values[0][0]).toBe(0)
  })

  it("checks the sealed occurrence reached only after a real provider collision normalization", () => {
    const ordinary = randomUUID(), ordinaryProvider = randomUUID(), sealedProvider = randomUUID()
    const f = fixture([{ id: ordinary, role: "assistant", content: "ordinary original",
      provider_source_id: ordinaryProvider, provider_occurrence: 1, created_at: new Date(1) }],
    { uuid: buildMessageRoleCollisionId(sealedProvider, "assistant"),
      provider: sealedProvider, occurrence: 1 })
    const originalOrdinary = readFunctionConversationRawProjection(f.database, f.threadId, ordinary)
    expect(() => appDb.upsertThreadMessages(f.threadId, [{ id: ordinary, role: "assistant",
      content: "raw provider reassignment", provider_source_id: sealedProvider,
      content_priority: 99, content_mode: "snapshot", created_at: new Date() }]))
      .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    f.assertKept()
    expect(readFunctionConversationRawProjection(f.database, f.threadId, ordinary)).toEqual(originalOrdinary)
    expect(appDb.getThreadMessageCount(f.threadId)).toBe(2)
    expect(appDb.getThreadMessageCanonicalId(f.threadId, ordinary)).toBe(ordinary)
  })
})
