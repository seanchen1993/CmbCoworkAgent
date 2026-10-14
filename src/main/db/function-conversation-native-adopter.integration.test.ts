import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import type { ThreadMessageWrite } from "../types"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore, type FunctionConversationCommit } from "./function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "./function-conversation-transcript"
import { createFunctionConversationNativeProjectionAccess } from "./function-conversation-native-projection"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, readFunctionConversationProjectionReceipt,
  readFunctionConversationRawProjection } from
  "./function-conversation-projection-receipt"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-actual-native-adopter-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => {
  vi.restoreAllMocks()
  if (appDb.getDb().inTransaction) appDb.getDb().run("ROLLBACK")
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Real index/TranscriptAccess writer; seal is a private factory driver, not an application door. */
async function fixture(kind: "user" | "ai" | "tool" = "ai", fresh = false, streamed = false) {
  const database = appDb.getDb(), threadId = randomUUID(), uuid = randomUUID(), provider = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(thread), store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => {})
  const role = kind === "ai" ? "assistant" as const : kind
  const calls = streamed ? [] : [{ id: "original-call", name: "ActualTool", args: { original: true } }]
  const original: ThreadMessageWrite = { id: uuid, role, content: "Original displayed words",
    provider_source_id: provider, provider_occurrence: 2, goal_id: "original-goal",
    active_window_id: "original-window", created_at: new Date(100), start_at: new Date(90),
    end_at: new Date(110), ...(kind === "ai" ? (streamed ? {} : {
      tool_calls: calls, reasoning: "original complete thought" })
      : kind === "tool" ? { tool_call_id: "original-call", name: "ActualTool", status: "success" } : {}) }
  const before = randomUUID(), after = randomUUID()
  appDb.upsertThreadMessages(threadId, [{ id: before, role: "user", content: "Before",
    created_at: new Date(1) }])
  if (!fresh) appDb.upsertThreadMessages(threadId, [original], kind === "user" ? {
    hostPromptOrigin: { messageId: uuid, text: "Original displayed words",
      origin: { kind: "plugin", name: "ActualOriginalPlugin" } }
  } : {})
  appDb.upsertThreadMessages(threadId, [{ id: after, role: "user", content: "After",
    created_at: new Date(200) }])
  if (!fresh && kind === "ai" && streamed) expect(appDb.appendThreadMessageTextDelta(threadId,
    { ...original, content: " actual stream delta" })).toBe(true)
  let live = true, seals = 0, flushes = 0, projects = 0, sourceChecks = 0
  const controller = new AbortController()
  let afterAliases: (() => void) | undefined
  const guard = () => {
    sourceChecks += 1
    if (!live) throw Error("ACTUAL_NATIVE_SOURCE_RETIRED")
    if (controller.signal.aborted) throw Error("MODS_CONVERSATION_SOURCE_RETIRED")
    if (appDb.getDb() !== database || !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_NATIVE_THREAD_CHANGED")
    store.assertCurrent(target)
  }
  const alias = appDb.captureFunctionConversationMessageAliasAccess({ threadId, incarnation,
    uuid, providerSourceId: provider, assertCurrent: guard })
  const occurrence = {}, allowed = new WeakSet([occurrence])
  const projection = createFunctionConversationNativeProjectionAccess({ database, target, threadId,
    incarnation, producer: {}, run: {}, signal: controller.signal, assertCurrent: guard,
    bindOccurrence(actual) {
      if (!allowed.has(actual)) throw Error("UNKNOWN_NATIVE_OCCURRENCE")
      return { facts: { uuid, role, providerSourceId: provider, providerOccurrence: 2,
        ...(kind === "tool" ? { toolCallId: "original-call", name: "ActualTool", status: "success" } : {}) },
      seal() { seals += 1 }, flush() { flushes += 1 },
      captureAliases: alias.captureAliases,
      assertAliases(handle) { alias.assertAliases(handle); afterAliases?.() } }
    } })
  const receipt = await projection.capture(occurrence)
  const native = kind === "user" ? new HumanMessage({ id: uuid,
    content: "Actual model framing of protected user words", additional_kwargs: { actualInput: true } })
    : kind === "tool" ? new ToolMessage({ id: uuid, content: "Protected final tool result",
      tool_call_id: "original-call", name: "ActualTool", status: "success",
      artifact: { actualExecution: "kept", ordinary: { nested: true } } })
      : new AIMessage({ id: uuid, content: "Protected final answer", tool_calls: calls,
        response_metadata: { actualProvider: "kept" } })
  const commitInput: FunctionConversationCommit = { uuid, inputDigest: uuid,
    door: kind === "user" ? "prompt" : kind === "tool" ? "tool-result" : "response",
    origin: kind === "user" ? { kind: "composer" }
      : kind === "tool" ? { kind: "tool", tool: "ActualTool" } : { kind: "model", model: "ActualModel" },
    message: kind === "tool" ? { type: "user", role: "user", content: [{ type: "tool_result",
      tool_use_id: "original-call", content: "Protected final tool result", is_error: true }] }
      : { type: role, role, content: [{ type: "text", text: "Protected final display" }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "actual-native-source" }, sdk: false, inbox: false }
  const project = (): ThreadMessageWrite => {
    projects += 1
    return { ...original, content: "Protected final display", reasoning: "Protected final thought",
      content_mode: "snapshot", reasoning_mode: "snapshot", tool_calls_mode: "snapshot",
      content_priority: 3, recovery_integrity: "verified", is_error: true,
      // An existing native projection must keep the true earlier dates and control arguments.
      created_at: new Date(999), start_at: new Date(998), end_at: new Date(1000),
      ...(kind === "ai" ? { tool_calls: streamed ? [] : [{ id: "wrong-display-call",
        name: "WrongDisplayTool", args: { wrong: true } }] } : {}) }
  }
  const makeTranscript = (actualReceipt = receipt) => createFunctionConversationTranscriptAccess(
    project, undefined, ToolMessage.isInstance(native) ? native : undefined,
    { access: projection, receipt: actualReceipt })
  const transcript = makeTranscript()
  const commit = () => store.commit(target, commitInput, guard, transcript.write, transcript.verify)
  const originalRaw = readFunctionConversationRawProjection(database, threadId, uuid)
  const selection = (row: ReturnType<typeof commit>) => ({ target, row, threadId, incarnation,
    assertCurrent: guard })
  return { database, threadId, incarnation, target, store, uuid, provider, before, after, original, originalRaw,
    alias, receipt, projection, transcript, native, commitInput, commit, makeTranscript, selection,
    controller, sourceChecks: () => sourceChecks,
    setAfterAliases: (callback: (() => void) | undefined) => { afterAliases = callback },
    counts: () => ({ seals, flushes, projects }), retire: () => { live = false } }
}

describe("actual index native adopter and fourth TranscriptAccess parameter", () => {
  it("checks the actual full source once before comparing its captured alias facts", async () => {
    const f = await fixture(), handle = f.alias.captureAliases()
    const before = f.sourceChecks()
    f.alias.assertAliases(handle)
    expect(f.sourceChecks()).toBe(before + 1)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.originalRaw)
    expect(f.store.readRows(f.target)).toEqual([])
  })

  it.each(["source", "abort", "incarnation"] as const)(
    "rejects late %s changes after a real alias callback without committing native data",
    async (kind) => {
      const f = await fixture("ai", false, true)
      const raw = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
      const messages = appDb.getThreadMessages(f.threadId)
      const fragments = f.database.exec(`SELECT * FROM thread_message_fragments
        WHERE thread_id = ? ORDER BY fragment_id`, [f.threadId])
      const fragmentState = f.database.exec(`SELECT * FROM thread_message_fragment_states
        WHERE thread_id = ?`, [f.threadId])
      const observed: { incarnation: ReturnType<typeof captureThreadIncarnation> | undefined } = {
        incarnation: undefined
      }
      let projectionWrites = 0, commits = 0
      const projectionTables = ["thread_messages", "thread_message_fragments",
        "thread_message_fragment_states", "function_conversation_projection_receipts"]
      const originalRun = f.database.run.bind(f.database)
      vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
        const table = /^(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(\w+)/.exec(sql.trim())?.[1]
        if (table && projectionTables.includes(table)) projectionWrites += 1
        if (sql.trim() === "COMMIT") commits += 1
        return originalRun(sql, args)
      })
      let callbacks = 0
      f.setAfterAliases(() => {
        f.setAfterAliases(undefined)
        callbacks += 1
        if (kind === "source") f.retire()
        else if (kind === "abort") f.controller.abort(Error("MODS_CONVERSATION_SOURCE_RETIRED"))
        else {
          f.database.run("DELETE FROM threads WHERE thread_id = ?", [f.threadId])
          appDb.createThread(f.threadId, { workspacePath: directory })
          f.database.run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
            f.incarnation.legacyCreatedAt, f.threadId
          ])
          const replacement = appDb.getThreadCore(f.threadId)
          if (!replacement) throw Error("The real post-alias replacement thread is missing")
          observed.incarnation = captureThreadIncarnation(replacement)
        }
      })
      const errors = { source: "ACTUAL_NATIVE_SOURCE_RETIRED",
        abort: "MODS_CONVERSATION_SOURCE_RETIRED", incarnation: "ACTUAL_NATIVE_THREAD_CHANGED" }
      expect(() => f.commit()).toThrow(errors[kind])
      expect(callbacks).toBe(1)
      expect(projectionWrites).toBe(0)
      expect(commits).toBe(0)
      expect(f.database.inTransaction).toBe(false)
      expect(f.controller.signal.aborted).toBe(kind === "abort")
      if (kind === "incarnation") {
        const replaced = observed.incarnation, restored = appDb.getThreadCore(f.threadId)
        if (!replaced || !restored) throw Error("The real replacement and rollback were not observed")
        expect(replaced.legacyCreatedAt).toBe(f.incarnation.legacyCreatedAt)
        expect(replaced.token).not.toBe(f.incarnation.token)
        expect(captureThreadIncarnation(restored)).toEqual(f.incarnation)
      }
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(raw)
      expect(appDb.getThreadMessages(f.threadId)).toEqual(messages)
      expect(f.database.exec(`SELECT * FROM thread_message_fragments
        WHERE thread_id = ? ORDER BY fragment_id`, [f.threadId])).toEqual(fragments)
      expect(f.database.exec(`SELECT * FROM thread_message_fragment_states
        WHERE thread_id = ?`, [f.threadId])).toEqual(fragmentState)
      expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_rows
        WHERE conversation_id = ? AND uuid = ?`, [f.target.conversationId, f.uuid])[0].values)
        .toEqual([[0]])
      expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_projection_receipts
        WHERE thread_id = ? AND uuid = ?`, [f.threadId, f.uuid])[0].values).toEqual([[0]])
      expect(f.counts()).toMatchObject({ seals: 1, flushes: 1 })
    }
  )

  it("adopts user display in its original position and preserves genuine plugin prompt origin, goal and times", async () => {
    const f = await fixture("user"), row = f.commit()
    const columns = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    for (const key of ["prompt_origin_json", "goal_id", "active_window_id", "created_at",
      "start_at", "end_at", "ordinal", "provider_source_id", "provider_occurrence"] as const)
      expect(columns[key]).toBe(f.originalRaw![key])
    expect(JSON.parse(String(columns.prompt_origin_json))).toEqual({ kind: "plugin", name: "ActualOriginalPlugin" })
    expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([f.before, f.uuid, f.after])
    expect(appDb.getThreadMessages(f.threadId)[1].content).toBe("Protected final display")
    expect(row.nativePayload).toBe(f.commitInput.nativePayload)
    expect(row.nativePayload).toContain("Actual model framing")
    expect(f.counts()).toEqual({ seals: 1, flushes: 1, projects: 1 })
  })

  it("closes actual pure text streamed AI fragments/state without replacing neighbouring ordinals", async () => {
    const f = await fixture("ai", false, true)
    expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=?",
      [f.threadId])[0].values[0][0]).toBeGreaterThan(0)
    const bucket = f.database.exec("SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.threadId])
    const row = f.commit(), columns = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    expect(columns.tool_calls_json).toBe(f.originalRaw!.tool_calls_json)
    expect(columns.ordinal).toBe(f.originalRaw!.ordinal)
    expect(columns.reasoning).toBe("Protected final thought")
    expect(columns.stream_authority).toBe(7)
    expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=?",
      [f.threadId])[0].values).toEqual([[0]])
    expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragment_states WHERE thread_id=?",
      [f.threadId])[0].values).toEqual([[0]])
    expect(f.database.exec("SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.threadId])).toEqual(bucket)
    expect(appDb.getThreadMessages(f.threadId).map(message => message.id)).toEqual([f.before, f.uuid, f.after])
  })

  it("preserves an already complete actual AI call list independently from final display formatting", async () => {
    const f = await fixture(), row = f.commit()
    const columns = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    expect(JSON.parse(String(columns.tool_calls_json))).toEqual([
      { id: "original-call", name: "ActualTool", args: { original: true } }
    ])
    expect(columns.tool_calls_json).toBe(f.originalRaw!.tool_calls_json)
    expect(row.nativePayload).toBe(f.commitInput.nativePayload)
    expect(row.nativePayload).toContain("original-call")
    expect(row.nativePayload).not.toContain("wrong-display-call")
    expect(columns.ordinal).toBe(f.originalRaw!.ordinal)
  })

  it("keeps actual Tool call/status/artifact separately from protected is_error presentation", async () => {
    const f = await fixture("tool"), row = f.commit()
    const columns = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    expect(columns.role).toBe("tool")
    expect(columns.status).toBe("success")
    expect(columns.tool_call_id).toBe("original-call")
    expect(columns.name).toBe("ActualTool")
    expect(columns.is_error).toBe(1)
    expect(row.nativePayload).toBe(serializeFunctionConversationNativeMessage(f.native))
    expect(row.nativePayload).toContain("actualExecution")
  })

  it("lets the actual index repair/allocate a fresh bucket ordinal and advances it exactly once", async () => {
    const f = await fixture("ai", true)
    const bucket = f.database.exec("SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.threadId])[0].values[0]
    const row = f.commit()
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection(row)).ordinal).toBe(bucket[1])
    expect(f.database.exec("SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.threadId])[0].values[0]).toEqual([Number(bucket[0]) + 1, Number(bucket[1]) + 1])
    expect(f.commit().receiptId).toBe(row.receiptId)
    expect(f.counts().projects).toBe(1)
  })

  it("rejects clones of real alias handles and private native receipts without certifying the old raw body", async () => {
    const f = await fixture()
    const handle = f.alias.captureAliases()
    expect(() => f.alias.assertAliases({ ...handle })).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    const transcript = f.makeTranscript({ ...f.receipt })
    expect(() => f.store.commit(f.target, f.commitInput, () => {}, transcript.write, transcript.verify))
      .toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.originalRaw)
    expect(f.store.readRows(f.target)).toEqual([])
  })

  it("rejects a real relevant alias change after capture instead of writing the replacement UUID", async () => {
    const f = await fixture("ai", false, true), newId = randomUUID()
    expect(appDb.replaceThreadMessageId(f.threadId, f.uuid, newId, "assistant")).toBe(true)
    expect(() => f.commit()).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(f.store.readRows(f.target)).toEqual([])
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toBeUndefined()
    expect(readFunctionConversationRawProjection(f.database, f.threadId, newId)?.function_row_json).toBeNull()
  })

  it("pins the actual original alias Map and thread incarnation after deletion/recreation", async () => {
    const f = await fixture(), handle = f.alias.captureAliases()
    appDb.deleteThread(f.threadId)
    appDb.createThread(f.threadId, { workspacePath: directory })
    const replacement = appDb.getThreadCore(f.threadId)
    if (!replacement) throw Error("Actual replacement missing")
    const replacementIncarnation = captureThreadIncarnation(replacement)
    const newDriver = appDb.captureFunctionConversationMessageAliasAccess({ threadId: f.threadId,
      uuid: f.uuid, providerSourceId: f.provider, incarnation: replacementIncarnation,
      assertCurrent: () => {
        f.controller.signal.throwIfAborted()
        if (appDb.getDb() !== f.database ||
          !matchesThreadIncarnation(appDb.getThreadCore(f.threadId), replacementIncarnation))
          throw Error("ACTUAL_NATIVE_THREAD_CHANGED")
      } })
    newDriver.captureAliases()
    expect(() => f.alias.assertAliases(handle)).toThrow("ACTUAL_NATIVE_THREAD_CHANGED")
    expect(() => f.commit()).toThrow("ACTUAL_NATIVE_THREAD_CHANGED")
    expect(appDb.getThreadMessageCount(f.threadId)).toBe(0)
  })

  it.each(["content_json", "ordinal", "provider_occurrence"])(
    "rejects changed captured raw %s with the actual Keeper transaction fully rolled back", async field => {
      const f = await fixture()
      f.database.run(`UPDATE thread_messages SET ${field}=? WHERE thread_id=? AND message_id=?`,
        [field === "content_json" ? JSON.stringify("changed before adoption") : 9, f.threadId, f.uuid])
      const changed = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
      expect(() => f.commit()).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(changed)
      expect(f.store.readRows(f.target)).toEqual([])
      expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_projection_receipts WHERE thread_id=?",
        [f.threadId])[0].values).toEqual([[0]])
    }
  )

  it("rejects a captured absence replaced before actual index INSERT rather than switching to adopt", async () => {
    const f = await fixture("ai", true)
    appDb.upsertThreadMessages(f.threadId, [f.original])
    const raw = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    expect(() => f.commit()).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(raw)
    expect(f.store.readRows(f.target)).toEqual([])
  })

  it("rejects an actual competing provider tuple while preserving the transaction's prior raw rows", async () => {
    const f = await fixture(), other = randomUUID()
    const columns = FUNCTION_CONVERSATION_PROJECTION_COLUMNS
    f.database.run(`INSERT INTO thread_messages (${columns.join(",")})
      SELECT ${columns.map(column => column === "message_id" ? "?"
        : column === "ordinal" ? "999" : column).join(",")}
      FROM thread_messages WHERE thread_id=? AND message_id=?`, [other, f.threadId, f.uuid])
    expect(() => f.commit()).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(f.store.readRows(f.target)).toEqual([])
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(f.originalRaw)
    expect(readFunctionConversationRawProjection(f.database, f.threadId, other)?.function_row_json).toBeNull()
  })

  it("uses the actual same claim/receipt after COMMIT acknowledgement loss with one UPDATE and one projection", async () => {
    const f = await fixture(), run = f.database.run.bind(f.database)
    let lost = false, updates = 0
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      if (/^UPDATE thread_messages SET thread_id=/.test(sql)) updates++
      const result = run(sql, args)
      if (sql === "COMMIT" && !lost) { lost = true; throw Error("ACTUAL_COMMIT_ACK_LOST") }
      return result
    })
    const row = f.commit()
    expect(lost).toBe(true)
    expect(updates).toBe(1)
    expect(f.counts().projects).toBe(1)
    f.transcript.verify(f.database, f.target, row)
    expect(updates).toBe(1)
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection(row)).content_json)
      .toBe(JSON.stringify("Protected final display"))
  })

  it("rejects a postcommit retired original source ACK without a second formatter or removing committed facts", async () => {
    const f = await fixture(), run = f.database.run.bind(f.database)
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      const result = run(sql, args)
      if (sql === "COMMIT") f.retire()
      return result
    })
    expect(() => f.commit()).toThrow("ACTUAL_NATIVE_SOURCE_RETIRED")
    expect(f.database.inTransaction).toBe(false)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=?",
      [f.target.conversationId])[0].values).toEqual([[1]])
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_projection_receipts WHERE thread_id=?",
      [f.threadId])[0].values).toEqual([[1]])
    expect(f.counts().projects).toBe(1)
  })
})
