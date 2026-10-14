import { AIMessage, HumanMessage, SystemMessage, ToolMessage,
  mapStoredMessageToChatMessage, type BaseMessage } from "@langchain/core/messages"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openNativeSqliteDatabase } from "../db/native-sqlite-adapter"
import { FunctionConversationStore, type FunctionConversationRef,
  type FunctionConversationRow } from "../db/function-conversation-store"
import { MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY, MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"
import type { FunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import type { Message } from "../types"
import { createFunctionConversationRecoveryResolver } from "./function-conversation-recovery"
import { isRuntimeVisiblePersistedMessage, persistedMessageToRuntimeMessage
} from "./persisted-runtime-message"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"

const cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function fixture(native: BaseMessage, role: Message["role"], type: "user" | "assistant" = "user",
  child = false
) {
  const directory = mkdtempSync(join(tmpdir(), "function-native-recovery-"))
  const database = openNativeSqliteDatabase(join(directory, "app.sqlite")).database
  cleanup.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })
  database.run("CREATE TABLE threads (thread_id TEXT PRIMARY KEY, created_at INTEGER, metadata TEXT)")
  database.run("CREATE TABLE actual_projection (conversation TEXT, uuid TEXT, native TEXT)")
  const token = randomUUID()
  database.run("INSERT INTO threads VALUES ('actual', 1, ?)", [
    JSON.stringify({ cmb_thread_incarnation: token })
  ])
  const store = new FunctionConversationStore(database)
  const guard = vi.fn(() => undefined)
  const main = store.ensureMain({ threadId: "actual", workspace: "C:/actual",
    incarnation: { token, legacyCreatedAt: 1 }, checkpointNamespace: "" }, guard)
  const target = child ? store.createChild(main,
    { invocationId: "actual-child", checkpointNamespace: "actual-child" }, guard) : main
  const row = store.commit(target, { uuid: native.id!, inputDigest: "actual",
    door: role === "tool" ? "tool-message" : type === "user" ? "note" : "response",
    origin: { kind: "plugin", name: "P" }, message: { type, role: type,
      ...(type === "user" && role !== "tool" ? { isMeta: true } : {}),
      content: [{ type: "text", text: typeof native.content === "string" ? native.content : "actual" }] },
    nativePayload: JSON.stringify(native.toDict()), orderAnchor: { actual: true },
    inbox: type === "user" && role !== "tool", sdk: false }, guard,
  (db, ref, actual) => { db.run("INSERT INTO actual_projection VALUES (?, ?, ?)", [
    ref.conversationId, actual.uuid, actual.nativePayload
  ]) }, (db, ref, actual) => { expect(db.exec(
    "SELECT native FROM actual_projection WHERE conversation = ? AND uuid = ?",
    [ref.conversationId, actual.uuid])[0]?.values[0]?.[0]).toBe(actual.nativePayload) })
  const stamp: FunctionConversationTranscriptStamp = { conversationId: target.conversationId,
    branchId: row.branchId, uuid: row.uuid, sequence: row.sequence, door: row.door as "note",
    messageType: type, ...(row.message.isMeta === true ? { isMeta: true } : {}),
    origin: { kind: "plugin", name: "P" } }
  const projected: Message = { id: native.id!, role, content: "UI-clamped text",
    created_at: new Date(1), function_row: stamp,
    ...(role === "tool" ? { tool_call_id: "actual-tool" } : {}),
    ...(role === "assistant" ? { provider_source_id: "provider", provider_occurrence: 2 } : {}) }
  const verifyProjection = vi.fn((ref: FunctionConversationRef, actual: FunctionConversationRow) => {
    const value = database.exec(
      "SELECT native FROM actual_projection WHERE conversation = ? AND uuid = ?",
      [ref.conversationId, actual.uuid])[0]?.values[0]?.[0]
    if (value !== actual.nativePayload) throw Error("ACTUAL_PROJECTION_CHANGED")
  })
  const deserializeNative = vi.fn((_ref: FunctionConversationRef, actual: FunctionConversationRow) =>
    mapStoredMessageToChatMessage(JSON.parse(actual.nativePayload)))
  const admission = { store, target, cut: { frontier: row.sequence }, guard,
    verifyProjection, deserializeNative,
    // Unit admission: actual native input UUID. The independent Saver case below replaces
    // this with an actual committed original tuple; these unit cases do not claim it.
    verifyCheckpointMembership: (message: Message, actual: FunctionConversationRow) => {
      if (message.id !== native.id || actual.uuid !== native.id) throw Error("ACTUAL_MEMBERSHIP_REQUIRED")
    } }
  const resolveFunctionRow = createFunctionConversationRecoveryResolver(admission)
  return { directory, database, store, row, stamp, projected, admission, resolveFunctionRow,
    verifyProjection, deserializeNative, guard }
}

describe("native canonical message recovery at an actual captured cut", () => {
  it("requires actual committed original Saver membership and rejects a later pending note", async () => {
    const native = new HumanMessage({ id: "consumed", content: "actual consumed note" })
    const f = fixture(native, "user")
    const saver = new SqlJsSaver(join(f.directory, "checkpoint.sqlite"))
    try {
      const checkpointId = randomUUID()
      const committed = await saver.put({ configurable: { thread_id: f.admission.target.threadId,
        checkpoint_ns: "" } }, { v: 1, id: checkpointId, ts: new Date().toISOString(),
        channel_values: { messages: [native] }, channel_versions: { messages: 1 },
        versions_seen: {} }, { source: "input", step: 0, parents: {} })
      const tuple = await saver.getTuple(committed)
      expect(tuple?.config.configurable?.checkpoint_id).toBe(checkpointId)
      const rows = tuple?.checkpoint.channel_values.messages
      expect(Array.isArray(rows)).toBe(true)
      if (!Array.isArray(rows)) throw Error("ACTUAL_CHECKPOINT_MESSAGES_REQUIRED")
      const actualIds = new Set(rows.map((value: unknown) => {
        if (HumanMessage.isInstance(value)) return value.id
        if (value && typeof value === "object") {
          const kwargs = Reflect.get(value, "kwargs")
          return kwargs && typeof kwargs === "object" ? Reflect.get(kwargs, "id") :
            Reflect.get(value, "id")
        }
        return undefined
      }))
      expect(actualIds).toEqual(new Set(["consumed"]))
      const verifyCheckpointMembership = (message: Message, row: FunctionConversationRow) => {
        if (tuple?.config.configurable?.thread_id !== f.admission.target.threadId ||
          tuple.config.configurable?.checkpoint_id !== checkpointId ||
          !actualIds.has(message.id) || row.uuid !== message.id)
          throw Error("ACTUAL_MEMBERSHIP_REQUIRED")
      }
      const resolver = createFunctionConversationRecoveryResolver({ ...f.admission, verifyCheckpointMembership })
      expect(persistedMessageToRuntimeMessage(f.projected, { resolveFunctionRow: resolver })?.content)
        .toBe("actual consumed note")
      const later = f.store.commit(f.admission.target, { uuid: "pending-later", inputDigest: "later",
        door: "note", origin: { kind: "plugin", name: "P" }, message: { type: "user", role: "user",
          isMeta: true, content: [{ type: "text", text: "future pending" }] },
        nativePayload: JSON.stringify(new HumanMessage({ id: "pending-later", content: "future pending" }).toDict()),
        orderAnchor: {}, inbox: true, sdk: true }, f.guard,
      (db, target, row) => { db.run("INSERT INTO actual_projection VALUES (?, ?, ?)", [
        target.conversationId, row.uuid, row.nativePayload
      ]) }, (db, target, row) => { expect(db.exec(
        "SELECT native FROM actual_projection WHERE conversation = ? AND uuid = ?",
        [target.conversationId, row.uuid])[0]?.values[0]?.[0]).toBe(row.nativePayload) })
      const highWaterResolver = createFunctionConversationRecoveryResolver({ ...f.admission,
        cut: { frontier: later.sequence }, verifyCheckpointMembership })
      const pending: Message = { ...f.projected, id: later.uuid,
        function_row: { ...f.stamp, uuid: later.uuid, sequence: later.sequence } }
      expect(() => persistedMessageToRuntimeMessage(pending, { resolveFunctionRow: highWaterResolver }))
        .toThrow("ACTUAL_MEMBERSHIP_REQUIRED")
    } finally { await saver.close() }
  })
  it("restores hidden notes in full without inferring Goal or using the displayed prefix", () => {
    const text = "[Starting active goal]\n" + "全".repeat(350_000)
    const f = fixture(new HumanMessage({ id: "note", content: text,
      additional_kwargs: { original: { preserved: true } } }), "user")
    expect(isRuntimeVisiblePersistedMessage(f.projected)).toBe(false)
    expect(() => persistedMessageToRuntimeMessage(f.projected)).toThrow("RECOVERY_REQUIRED")
    const restored = persistedMessageToRuntimeMessage(f.projected, f)
    expect(restored).toBeInstanceOf(HumanMessage)
    expect(restored?.content).toBe(text)
    expect(restored?.additional_kwargs).toMatchObject({ original: { preserved: true }, function_row: f.stamp })
    expect(f.projected.content).toBe("UI-clamped text")
    expect(f.verifyProjection).toHaveBeenCalledTimes(1)
  })

  it("retains the actual ToolMessage, tool ID and native artifact", () => {
    const f = fixture(new ToolMessage({ id: "tool", content: "original result",
      tool_call_id: "actual-tool", artifact: { original: [1, 2, 3] }, status: "success" }), "tool")
    const restored = persistedMessageToRuntimeMessage(f.projected, f)
    expect(restored).toBeInstanceOf(ToolMessage)
    expect((restored as ToolMessage).tool_call_id).toBe("actual-tool")
    expect((restored as ToolMessage).artifact).toEqual({ original: [1, 2, 3] })
    expect(restored?.content).toBe("original result")
  })

  it("uses an explicitly captured actual child conversation and never falls back to main", () => {
    const f = fixture(new HumanMessage({ id: "child-note", content: "actual child note" }), "user", "user", true)
    expect(f.admission.target.kind).toBe("child")
    expect(persistedMessageToRuntimeMessage(f.projected, f)?.content).toBe("actual child note")
    const main = f.store.ensureMain({ threadId: f.admission.target.threadId,
      workspace: f.admission.target.workspace, incarnation: f.admission.target.incarnation,
      checkpointNamespace: "" }, f.guard)
    const wrong = createFunctionConversationRecoveryResolver({ ...f.admission, target: main,
      cut: { frontier: 0 } })
    expect(() => persistedMessageToRuntimeMessage(f.projected, { resolveFunctionRow: wrong }))
      .toThrow("OUTSIDE_CUT")
  })

  it("retains actual provider occurrence, response and usage metadata", () => {
    const f = fixture(new AIMessage({ id: "ai", content: "original response",
      additional_kwargs: { [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "provider",
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2 },
      response_metadata: { finish_reason: "stop" },
      usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }), "assistant", "assistant")
    const restored = persistedMessageToRuntimeMessage(f.projected, f) as AIMessage
    expect(restored).toBeInstanceOf(AIMessage)
    expect(restored.response_metadata).toEqual({ finish_reason: "stop" })
    expect(restored.usage_metadata?.total_tokens).toBe(3)
    expect(() => persistedMessageToRuntimeMessage({ ...f.projected, provider_occurrence: 3 }, f))
      .toThrow("RECOVERY_REQUIRED")
  })

  it.each(["uuid", "branchId", "conversationId", "sequence", "origin"])(
    "does not use a copied stamp to select a native row: %s", (field) => {
      const f = fixture(new HumanMessage({ id: "note", content: "original" }), "user")
      const stamp = { ...f.stamp, ...(field === "sequence" ? { sequence: 2 } :
        field === "origin" ? { origin: { kind: "plugin" as const, name: "other" } } : { [field]: "foreign" }) }
      expect(() => persistedMessageToRuntimeMessage({ ...f.projected, function_row: stamp }, f)).toThrow()
      expect(f.deserializeNative).not.toHaveBeenCalled()
  })

  it("refuses a damaged/mismatched stored marker instead of restoring its displayed body", () => {
    const f = fixture(new HumanMessage({ id: "note", content: "original" }), "user")
    expect(() => persistedMessageToRuntimeMessage({ ...f.projected, function_row_invalid: true }, f))
      .toThrow("TRANSCRIPT_INVALID")
    expect(() => persistedMessageToRuntimeMessage({ ...f.projected, id: "other" }, f))
      .toThrow("TRANSCRIPT_INVALID")
    expect(f.deserializeNative).not.toHaveBeenCalled()
  })

  it("refuses a failed actual projection verification and preserves source guard errors", () => {
    const f = fixture(new HumanMessage({ id: "note", content: "original" }), "user")
    f.database.run("UPDATE actual_projection SET native = 'changed'")
    expect(() => persistedMessageToRuntimeMessage(f.projected, f)).toThrow("ACTUAL_PROJECTION_CHANGED")
    expect(f.deserializeNative).not.toHaveBeenCalled()
    const expired = Error("actual source expired")
    f.guard.mockImplementation(() => { throw expired })
    expect(() => persistedMessageToRuntimeMessage(f.projected, f)).toThrow(expired)
  })

  it("cannot substitute a HumanMessage or different tool ID for a native tool row", () => {
    const f = fixture(new ToolMessage({ id: "tool", content: "original", tool_call_id: "actual-tool" }), "tool")
    const human = createFunctionConversationRecoveryResolver({ ...f.admission,
      deserializeNative: () => new HumanMessage({ id: "tool", content: "fake result" }) })
    expect(() => persistedMessageToRuntimeMessage(f.projected, { resolveFunctionRow: human }))
      .toThrow("RECOVERY_REQUIRED")
    expect(() => persistedMessageToRuntimeMessage({ ...f.projected, tool_call_id: "other" }, f))
      .toThrow("RECOVERY_REQUIRED")
  })

  it("keeps a fixed frontier even if the caller mutates its cut after capture", () => {
    const f = fixture(new HumanMessage({ id: "note", content: "original" }), "user")
    f.admission.cut.frontier = 0
    expect(persistedMessageToRuntimeMessage(f.projected, f)?.content).toBe("original")
    const early = createFunctionConversationRecoveryResolver({ ...f.admission, cut: { frontier: 0 } })
    expect(() => persistedMessageToRuntimeMessage(f.projected, { resolveFunctionRow: early }))
      .toThrow("OUTSIDE_CUT")
  })

  it("excludes marked system notices without constructing a provider SystemMessage", () => {
    const message: Message = { id: "notice", role: "system", content: "Goal 已暂停：literal",
      created_at: new Date(1), function_row: { conversationId: "actual", branchId: "actual",
        uuid: "notice", sequence: 1, door: "note", messageType: "system",
        origin: { kind: "plugin", name: "P" } } }
    const resolveFunctionRow = vi.fn()
    expect(isRuntimeVisiblePersistedMessage(message)).toBe(false)
    expect(persistedMessageToRuntimeMessage(message, { resolveFunctionRow })).toBeNull()
    expect(resolveFunctionRow).not.toHaveBeenCalled()
    expect(() => persistedMessageToRuntimeMessage({ ...message, function_row: undefined }))
      .toThrow("TRANSCRIPT_INVALID")
    const { function_row: _stamp, ...old } = message
    expect(persistedMessageToRuntimeMessage(old)).toBeInstanceOf(SystemMessage)
  })
})
