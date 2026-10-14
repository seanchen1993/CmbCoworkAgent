import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { FunctionNativeMessageProtector } from "../agent/native-message-protector"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { FunctionConversationFinalExecutions,
  type FunctionNativeFinalExecutionReceipt } from "./function-conversation-final-execution"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { ThreadMessageWrite } from "../types"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"
import { FunctionConversationStore, type FunctionConversationCommit,
  type FunctionConversationRow } from "./function-conversation-store"
import { createFunctionConversationNativeProjectionAccess,
  type FunctionNativeProjectionClaim, type FunctionNativeProjectionPreparation,
  type FunctionNativeProjectionReceipt } from "./function-conversation-native-projection"
import { NativeSqliteAdapter } from "./native-sqlite-adapter"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionStamp,
  readFunctionConversationRawProjection, readFunctionConversationProjectionReceipt,
  recordFunctionConversationProjectionReceipt, type FunctionConversationProjectionColumns } from
  "./function-conversation-projection-receipt"
import { recordFunctionConversationPresentationDisposition } from
  "./function-conversation-presentation-disposition"

let directory = ""
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-occurrence-adoption-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(options: { fresh?: boolean; tool?: boolean; human?: boolean;
  flush?: Promise<void>; final?: boolean } = {}) {
  const database = appDb.getDb(), threadId = randomUUID(), uuid = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: directory })
  const incarnation = captureThreadIncarnation(thread), store = new FunctionConversationStore(database)
  const target = store.ensureMain({ threadId, workspace: directory, incarnation,
    checkpointNamespace: "" }, () => {})
  const role = options.tool ? "tool" as const : options.human ? "user" as const : "assistant" as const
  const original: ThreadMessageWrite = { id: uuid, role, content: "Original partial display",
    provider_source_id: `actual-provider-${uuid}`, provider_occurrence: 2,
    ...(options.tool ? { tool_call_id: "actual-tool-call", name: "ActualTool", status: "success" }
      : options.human ? {} : { tool_calls: [
        { id: "actual-tool-call", name: "ActualTool", args: { actual: true } }] }),
    reasoning: "Original partial reasoning", goal_id: "actual-goal", active_window_id: "actual-window",
    created_at: new Date(100), start_at: new Date(90), end_at: new Date(110) }
  if (!options.fresh) {
    appDb.upsertThreadMessages(threadId, [original])
    database.run("UPDATE thread_messages SET prompt_origin_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify({ original: "native prompt origin" }), threadId, uuid])
  }
  let live = true, aliases = new Map<string, string>([[uuid, uuid]])
  const aliasReceipts = new WeakMap<object, { actual: Map<string, string>; entries: string }>()
  const controller = new AbortController(), occurrence = {}, producer = {}, run = {}
  let onSeal: (() => void) | undefined, onGuard: (() => void) | undefined
  const additional = new WeakMap<object, string>()
  let finalReceipt: FunctionNativeFinalExecutionReceipt | undefined
  let seals = 0, flushes = 0, writes = 0
  const guard = () => {
    if (!live) throw Error("ACTUAL_NATIVE_SOURCE_RETIRED")
    if (controller.signal.aborted) throw Error("MODS_CONVERSATION_SOURCE_RETIRED")
    onGuard?.()
    if (!live) throw Error("ACTUAL_NATIVE_SOURCE_RETIRED")
    if (controller.signal.aborted) throw Error("MODS_CONVERSATION_SOURCE_RETIRED")
    if (appDb.getDb() !== database) throw Error("MODS_CONVERSATION_THREAD_CHANGED")
    store.assertCurrent(target)
  }
  const access = createFunctionConversationNativeProjectionAccess({ database, target, threadId,
    incarnation, producer, run, signal: controller.signal, assertCurrent: guard,
    bindOccurrence(actual) {
      const extraUuid = additional.get(actual)
      if (actual !== occurrence && !extraUuid) throw Error("UNKNOWN_ACTUAL_OCCURRENCE")
      return { facts: { uuid: extraUuid ?? uuid, role,
        providerSourceId: extraUuid ?? original.provider_source_id!,
        providerOccurrence: extraUuid ? 1 : 2,
        ...(options.tool ? { toolCallId: "actual-tool-call", name: "ActualTool", status: "success" } : {}) },
      seal() { seals += 1; onSeal?.() },
      flush() { flushes += 1; return options.flush },
      captureAliases() {
        const proof = {}
        aliasReceipts.set(proof, { actual: aliases, entries: JSON.stringify([...aliases]) })
        return proof
      },
      assertAliases(proof) {
        guard()
        const captured = aliasReceipts.get(proof)
        if (!captured || captured.actual !== aliases || captured.entries !== JSON.stringify([...aliases]))
          throw Error("ACTUAL_ALIAS_CHANGED")
      },
      ...(options.final ? { finalExecution() {
        if (!finalReceipt) throw Error("MISSING_ACTUAL_FINAL_EXECUTION")
        return finalReceipt
      } } : {}) }
    } })
  const native = options.tool ? new ToolMessage({ id: uuid, content: "Protected final rendering",
    tool_call_id: "actual-tool-call", name: "ActualTool", status: "success",
    artifact: { actualExecution: "retained" } }) : options.human
      ? new HumanMessage({ id: uuid, content: "Protected final rendering" }) : new AIMessage({ id: uuid,
    content: "Protected final rendering", response_metadata: { actualProvider: "retained" },
    ...(options.final ? { tool_calls: [{ id: "actual-tool-call", name: "ActualTool",
      args: { complete: "actual-handler-result" }, type: "tool_call" as const }] } : {}) })
  const fields: FunctionConversationCommit = { uuid, inputDigest: uuid,
    door: options.tool ? "tool-result" : options.human ? "prompt" : "response",
    origin: options.tool ? { kind: "tool", tool: "ActualTool" } : options.human
      ? { kind: "composer" } : { kind: "model", model: "ActualModel" },
    message: options.tool ? { type: "user", role: "user", content: [{ type: "tool_result",
      tool_use_id: "actual-tool-call", content: [{ type: "text", text: "Protected final rendering" }],
      is_error: true }] } : options.human ? { type: "user", role: "user",
      content: [{ type: "text", text: "Protected final rendering" }] }
      : { type: "assistant", role: "assistant",
      content: [{ type: "text", text: "Protected final rendering" }] },
    nativePayload: serializeFunctionConversationNativeMessage(native),
    orderAnchor: { kind: "native-occurrence", ...(options.human ? { presentation: {
      version: 1, disposition: "persisted", intentDigest: "a".repeat(64) } } : {}) },
    sdk: false, inbox: false }
  const protectedColumns = (row: FunctionConversationRow): FunctionConversationProjectionColumns => {
    const projection = appDb.projectFunctionConversationThreadMessageStorageColumns({ ...original,
      content: "Protected final rendering", reasoning: "Protected final reasoning", is_error: true,
      content_mode: "snapshot", reasoning_mode: "snapshot", tool_calls_mode: "snapshot" }, 100)
    const baseline = readFunctionConversationRawProjection(database, threadId, uuid)
    if (!baseline) database.run(`INSERT INTO thread_message_buckets
      (thread_id,message_count,next_ordinal,updated_at) VALUES (?,0,0,100)
      ON CONFLICT(thread_id) DO NOTHING`, [threadId])
    const ordinal = baseline?.ordinal ?? database.exec(
      "SELECT next_ordinal FROM thread_message_buckets WHERE thread_id=?", [threadId])[0].values[0][0]
    const values = { thread_id: threadId, ...projection,
      function_row_json: JSON.stringify(functionConversationProjectionStamp(target, row)), ordinal }
    return Object.freeze(Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key =>
      [key, Object.getOwnPropertyDescriptor(values, key)?.value]))) as FunctionConversationProjectionColumns
  }
  let prepared: FunctionNativeProjectionPreparation | undefined, savedRow: FunctionConversationRow | undefined
  const selection = (row: FunctionConversationRow) => ({ target, row, threadId, incarnation,
    assertCurrent: guard })
  const apply = (value: FunctionNativeProjectionPreparation) => {
    access.claim(value.claim); access.assertPrepared(value.claim)
    writes += 1
    const names = FUNCTION_CONVERSATION_PROJECTION_COLUMNS
    if (value.kind === "insert") database.run(`INSERT INTO thread_messages (${names.join(",")})
      VALUES (${names.map(() => "?").join(",")})`, names.map(key => value.expected[key]))
    else database.run(`UPDATE thread_messages SET ${names.map(key => `${key}=?`).join(",")}
      WHERE thread_id=? AND message_id=?`, [...names.map(key => value.expected[key]), threadId, uuid])
    database.run("DELETE FROM thread_message_fragments WHERE thread_id=? AND message_id=?", [threadId, uuid])
    database.run("DELETE FROM thread_message_fragment_states WHERE thread_id=? AND message_id=?", [threadId, uuid])
    database.run(`UPDATE thread_message_buckets SET message_count=(SELECT COUNT(*) FROM
      thread_messages WHERE thread_id=?),next_ordinal=(SELECT COALESCE(MAX(ordinal),-1)+1 FROM
      thread_messages WHERE thread_id=?) WHERE thread_id=?`, [threadId, threadId, threadId])
    access.assertPrepared(value.claim)
  }
  const commit = (receipt: FunctionNativeProjectionReceipt, beforeApply?:
    (value: FunctionNativeProjectionPreparation) => void) => store.commit(target, fields, guard,
    (_db, _target, row) => {
      savedRow = row
      prepared = access.prepare(receipt, { database, target, row, protectedColumns: protectedColumns(row) })
      beforeApply?.(prepared)
      apply(prepared)
      recordFunctionConversationProjectionReceipt(database, selection(row))
      if (options.human) recordFunctionConversationPresentationDisposition(database, selection(row),
        readFunctionConversationProjectionReceipt(database, selection(row)))
    }, (_db, _target, row) => {
      if (!prepared) throw Error("Actual preparation missing")
      if (database.inTransaction) {
        access.assertPrepared(prepared.claim)
        readFunctionConversationProjectionReceipt(database, selection(row))
      } else access.verify(prepared.claim)
    })
  const probe = (receipt: FunctionNativeProjectionReceipt,
    transform: (request: Parameters<typeof access.prepare>[1]) => Parameters<typeof access.prepare>[1]) =>
    store.commit(target, fields, guard, (_db, _target, row) => {
      access.prepare(receipt, transform({ database, target, row, protectedColumns: protectedColumns(row) }))
      throw Error("INVALID_PREPARATION_WAS_ACCEPTED")
    }, () => { throw Error("INVALID_PREPARATION_WAS_ACCEPTED") })
  return { database, threadId, incarnation, target, store, uuid, role, original, occurrence, access,
    producer, run, guard, native, setFinalReceipt: (receipt: FunctionNativeFinalExecutionReceipt) => {
      finalReceipt = receipt
    },
    capture: () => access.capture(occurrence),
    captureAdditional(actual = {}) {
      if (!additional.has(actual)) additional.set(actual, randomUUID())
      return access.capture(actual)
    }, protectedColumns, commit, probe, apply, fields,
    selection, counts: () => ({ seals, flushes, writes }),
    prepared: () => { if (!prepared) throw Error("Actual preparation missing"); return prepared },
    row: () => { if (!savedRow) throw Error("Actual row missing"); return savedRow },
    retire: () => { live = false }, controller,
    setSeal: (callback: () => void) => { onSeal = callback },
    setGuard: (callback: (() => void) | undefined) => { onGuard = callback },
    changeAlias: () => { aliases.set(uuid, "another-native-row") },
    replaceAliasMap: () => { aliases = new Map(aliases) } }
}

describe("actual native occurrence projection capture and compare-and-adopt foundation", () => {
  it("composes expected-row verification within the full-seal source boundaries", async () => {
    const f = fixture({ human: true }), receipt = await f.capture()
    f.commit(receipt)
    let guards = 0
    f.setGuard(() => { guards++ })
    f.access.verify(f.prepared().claim)
    // Each seal boundary checks the original alias source and original scope source.
    expect(guards).toBe(4)
  })

  it.each(["column", "abort", "close", "reentry"])(
    "rejects final full-seal source callback %s without another write", async attack => {
      const f = fixture({ human: true }), receipt = await f.capture()
      f.commit(receipt)
      let guards = 0, attacked = false
      f.setGuard(() => {
        if (++guards !== 4) return
        attacked = true
        if (attack === "column") f.database.run(
          "UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
          ['"changed"', f.threadId, f.uuid])
        if (attack === "abort") f.controller.abort(Error("ACTUAL_FINAL_GUARD_ABORT"))
        if (attack === "close") f.access.close()
        if (attack === "reentry") {
          try { f.access.verify(f.prepared().claim) } catch { /* A caught reentry still poisons it. */ }
        }
      })
      expect(() => f.access.verify(f.prepared().claim)).toThrow()
      expect(attacked).toBe(true)
      expect(f.counts().writes).toBe(1)
    }
  )
  async function finalResult(f: ReturnType<typeof fixture>) {
    const protector = new FunctionNativeMessageProtector(), registry = new FunctionConversationRegistry(
      f.store, new ModRuntimeAuthorities())
    const target = registry.registerMain({}, { identity: {}, ref: f.target,
      checkpointThreadId: f.threadId, signal: f.controller.signal, assertCurrent: f.guard })
    const safe = await protector.protect(protector.capture({ message: f.native, producer: f.producer,
      signal: f.controller.signal, assertCurrent: f.guard,
      policy: { identity: {}, protected: false, epoch: 1, digest: "explicit-off",
        deployment: { version: 1, id: "cmb.baseline/v1", required: false,
          redactLiterals: [], denyTools: [] } },
      retainActualWork: () => () => { /* The synchronous off result has no pending host work. */ },
      assertExecutionFacts() { /* The actual off message is returned without changing execution facts. */ },
      inheritPresentation() { /* This actual AI result has no Tool presentation sidecar. */ }
    }))
    const executions = new FunctionConversationFinalExecutions(protector)
    const original = executions.capture({ producer: f.producer, run: f.run, occurrence: f.occurrence,
      target, signal: f.controller.signal, assertCurrent: f.guard }, safe)
    const receipt = executions.bind(original, safe)
    cleanups.push(async () => {
      executions.close(); protector.close(); await protector.whenDrained(); registry.close()
    })
    return receipt
  }

  it("adopts final actual AI arguments through a private receipt and preserves every other fixed column", async () => {
    const f = fixture({ final: true })
    f.setFinalReceipt(await finalResult(f))
    const before = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    if (!before) throw Error("ACTUAL_PARTIAL_ROW_MISSING")
    const row = f.commit(await f.capture())
    const after = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    expect(after.tool_calls_json).toBe(JSON.stringify([{ id: "actual-tool-call", name: "ActualTool",
      args: { complete: "actual-handler-result" } }]))
    expect(after.tool_calls_json).not.toBe(before.tool_calls_json)
    for (const key of ["provider_source_id", "provider_occurrence", "ordinal", "role", "status",
      "tool_call_id", "name", "prompt_origin_json", "goal_id", "active_window_id", "created_at",
      "start_at", "end_at"] as const) expect(after[key]).toBe(before[key])
    expect(f.counts().writes).toBe(1)
  })

  it.each(["clone", "cross-occurrence", "changed-payload"])(
    "rejects a false final execution before adoption (%s)", async kind => {
      const f = fixture({ final: true })
      const receipt = kind === "cross-occurrence" ? await finalResult(fixture({ final: true }))
        : await finalResult(f)
      f.setFinalReceipt(kind === "clone" ? { ...receipt } : receipt)
      if (kind === "changed-payload") Object.defineProperty(f.fields, "nativePayload", {
        value: f.fields.nativePayload + " ", enumerable: true
      })
      const before = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
      const capture = await f.capture()
      expect(() => f.commit(capture)).toThrow()
      expect(f.counts().writes).toBe(0)
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(before)
    }
  )

  it("adopts an actual partial row, preserving execution/source/order columns and recording a real receipt", async () => {
    const f = fixture()
    f.database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,?)`, [f.threadId, f.uuid, "delta", 101])
    f.database.run(`INSERT INTO thread_message_fragment_states
      (thread_id,message_id,total_chars,updated_at) VALUES (?,?,5,101)`, [f.threadId, f.uuid])
    const before = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)!
    const receipt = await f.capture(), row = f.commit(receipt)
    const after = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    for (const key of ["provider_source_id", "provider_occurrence", "role", "tool_calls_json",
      "prompt_origin_json", "goal_id", "active_window_id", "created_at", "start_at", "end_at",
      "ordinal"] as const) expect(after[key]).toBe(before[key])
    expect(after.content_json).toBe(JSON.stringify("Protected final rendering"))
    expect(after.is_error).toBe(1)
    expect(after.stream_authority).toBe(7)
    expect(f.prepared().kind).toBe("adopt")
    expect(f.counts()).toEqual({ seals: 1, flushes: 1, writes: 1 })
    expect(f.database.exec("SELECT COUNT(*) FROM thread_message_fragments WHERE thread_id=?",
      [f.threadId])[0].values[0][0]).toBe(0)
    expect(row.nativePayload).toBe(f.fields.nativePayload)
  })

  it("retains actual tool success and artifact while a protected presentation has is_error=true", async () => {
    const f = fixture({ tool: true }), receipt = await f.capture(), row = f.commit(receipt)
    const columns = readFunctionConversationProjectionReceipt(f.database, f.selection(row))
    expect(columns.status).toBe("success")
    expect(columns.tool_call_id).toBe("actual-tool-call")
    expect(columns.is_error).toBe(1)
    expect(row.nativePayload).toContain("actualExecution")
  })

  it("inserts exact absence only after the real same-transaction bucket allocation", async () => {
    const f = fixture({ fresh: true }), receipt = await f.capture(), row = f.commit(receipt)
    expect(f.prepared().kind).toBe("insert")
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection(row)).ordinal).toBe(0)
    expect(f.database.exec("SELECT message_count,next_ordinal FROM thread_message_buckets WHERE thread_id=?",
      [f.threadId])[0].values).toEqual([[1, 1]])
  })

  it("registers once before native binding/seal synchronous reentry and waits for the actual flush", async () => {
    const gate = deferred(), f = fixture({ flush: gate.promise })
    let nested: Promise<FunctionNativeProjectionReceipt> | undefined
    f.setSeal(() => { nested = f.capture() })
    const first = f.capture()
    expect(nested).toBe(first)
    let settled = false
    first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.counts()).toEqual({ seals: 1, flushes: 1, writes: 0 })
    gate.resolve()
    const receipt = await first
    expect(f.capture()).toBe(first)
    f.commit(receipt)
  })

  it.each(["content_json", "ordinal", "provider_occurrence", "prompt_origin_json"])(
    "rejects actual baseline column %s changed after seal/flush without any keeper write", async key => {
      const f = fixture(), receipt = await f.capture()
      f.database.run(`UPDATE thread_messages SET ${key}=? WHERE thread_id=? AND message_id=?`,
        [key.endsWith("json") ? JSON.stringify("changed") : 9, f.threadId, f.uuid])
      expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
      expect(f.counts().writes).toBe(0)
      expect(f.store.readRows(f.target)).toEqual([])
    }
  )

  it("rejects changed fragment identity/state even when the visible body and character count are equal", async () => {
    const f = fixture()
    f.database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,100)`, [f.threadId, f.uuid, "same"])
    const receipt = await f.capture()
    f.database.run("DELETE FROM thread_message_fragments WHERE thread_id=?", [f.threadId])
    f.database.run(`INSERT INTO thread_message_fragments
      (thread_id,message_id,content_text,created_at) VALUES (?,?,?,100)`, [f.threadId, f.uuid, "same"])
    expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(f.counts().writes).toBe(0)
  })

  it.each(["entries", "map"])("pins the original private alias %s rather than accepting a clone", async kind => {
    const f = fixture(), receipt = await f.capture()
    if (kind === "entries") f.changeAlias()
    else f.replaceAliasMap()
    expect(() => f.commit(receipt)).toThrow("ACTUAL_ALIAS_CHANGED")
    expect(f.counts().writes).toBe(0)
  })

  it("cannot switch a captured absence to adopting a later row or another provider occurrence", async () => {
    const f = fixture({ fresh: true }), receipt = await f.capture()
    appDb.upsertThreadMessages(f.threadId, [f.original])
    expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(f.counts().writes).toBe(0)
    const second = fixture({ fresh: true }), original = await second.capture()
    appDb.upsertThreadMessages(second.threadId, [{ ...second.original, id: randomUUID() }])
    expect(() => second.commit(original)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(second.counts().writes).toBe(0)
  })

  it("rejects copied receipts and claims and latches claim before a reentrant actual source guard", async () => {
    const f = fixture(), receipt = await f.capture()
    const clone = { ...receipt }
    expect(() => f.commit(clone)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(f.counts().writes).toBe(0)
    let repeated: unknown, armed = false
    f.commit(receipt, prepared => {
      f.setGuard(() => {
        if (!armed) return
        armed = false
        try { f.access.claim(prepared.claim) } catch (error) { repeated = error }
      })
      armed = true
    })
    expect(repeated).toBeInstanceOf(Error)
    expect(String(repeated)).toContain("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(() => f.access.verify({ ...f.prepared().claim })).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(() => f.access.claim(f.prepared().claim)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(f.counts().writes).toBe(1)
  })

  it("never performs a second mutation after a failed claimed writer, and rollback preserves the original row", async () => {
    const f = fixture(), receipt = await f.capture()
    const before = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    let claim: FunctionNativeProjectionClaim | undefined
    expect(() => f.commit(receipt, prepared => {
      claim = prepared.claim
      f.access.claim(claim)
      throw Error("ACTUAL_WRITER_FAILED")
    })).toThrow("ACTUAL_WRITER_FAILED")
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(before)
    expect(f.store.readRows(f.target)).toEqual([])
    if (!claim) throw Error("Actual claim missing")
    expect(() => f.access.claim(claim!)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(f.counts().writes).toBe(0)
  })

  it("strictly reads back a real COMMIT whose acknowledgement is lost without replaying the writer", async () => {
    const f = fixture(), receipt = await f.capture(), originalRun = f.database.run.bind(f.database)
    let lost = false
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      const result = originalRun(sql, args)
      if (sql === "COMMIT" && !lost) { lost = true; throw Error("ACTUAL_COMMIT_ACK_LOST") }
      return result
    })
    const row = f.commit(receipt)
    expect(lost).toBe(true)
    expect(f.database.inTransaction).toBe(false)
    f.access.verify(f.prepared().claim)
    expect(readFunctionConversationProjectionReceipt(f.database, f.selection(row))).toEqual(f.prepared().expected)
    expect(f.counts().writes).toBe(1)
    expect(() => f.access.claim(f.prepared().claim)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
  })

  it("keeps all 256 original admissions held until actual COMMIT, rejecting transaction-local verify", async () => {
    const f = fixture({ fresh: true }), allowed = new WeakMap<object, string>()
    const access = createFunctionConversationNativeProjectionAccess({ database: f.database,
      target: f.target, threadId: f.threadId, incarnation: f.incarnation, producer: {}, run: {},
      signal: f.controller.signal, assertCurrent: f.guard, bindOccurrence(actual) {
        const uuid = allowed.get(actual)
        if (!uuid) throw Error("Unknown actual capacity occurrence")
        return { facts: { uuid, role: "assistant",
          providerSourceId: uuid === f.uuid ? f.original.provider_source_id! : uuid,
          providerOccurrence: uuid === f.uuid ? 2 : 1 }, seal() { /* Fixture has no mutable producer buffer. */ }, flush() { /* No pending native writes. */ },
        captureAliases: () => ({}), assertAliases() { f.guard() } }
      } })
    const actuals = Array.from({ length: 256 }, (_, index) => {
      const occurrence = {}; allowed.set(occurrence, index === 0 ? f.uuid : randomUUID()); return occurrence
    })
    const receipts = await Promise.all(actuals.map(occurrence => access.capture(occurrence)))
    const overflow = {}; allowed.set(overflow, randomUUID())
    let blocked: Promise<FunctionNativeProjectionReceipt> | undefined
    let preparation: FunctionNativeProjectionPreparation | undefined
    f.store.commit(f.target, f.fields, () => {}, (_db, _target, row) => {
      preparation = access.prepare(receipts[0], { database: f.database, target: f.target, row,
        protectedColumns: f.protectedColumns(row) })
      access.claim(preparation.claim)
      f.database.run(`INSERT INTO thread_messages (${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.join(",")})
        VALUES (${FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(() => "?").join(",")})`,
      FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key => preparation!.expected[key]))
      f.database.run("UPDATE thread_message_buckets SET message_count=1,next_ordinal=1 WHERE thread_id=?",
        [f.threadId])
      recordFunctionConversationProjectionReceipt(f.database, f.selection(row))
    }, (_db, _target, row) => {
      if (!preparation) throw Error("Actual capacity preparation missing")
      if (f.database.inTransaction) {
        access.assertPrepared(preparation.claim)
        readFunctionConversationProjectionReceipt(f.database, f.selection(row))
        expect(() => access.verify(preparation!.claim)).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
        blocked = access.capture(overflow)
        void blocked.catch(() => {})
      } else access.verify(preparation.claim)
    })
    if (!blocked) throw Error("Actual transaction capacity probe missing")
    await expect(blocked).rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
    // The rejected overflow had no admission/once claim; the real COMMIT freed exactly one slot.
    await expect(access.capture(overflow)).resolves.toBeDefined()
    const extra = {}; allowed.set(extra, randomUUID())
    await expect(access.capture(extra)).rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
    access.close()
  })

  it.each([
    { kind: "delete", lostCommit: false }, { kind: "change", lostCommit: false },
    { kind: "delete", lostCommit: true }, { kind: "change", lostCommit: true }
  ])(
    "keeps admissions held after last-source ledger $kind (lost COMMIT: $lostCommit)",
    async ({ kind, lostCommit }) => {
      const f = fixture({ human: true })
      const receipt = await f.capture()
      await Promise.all(Array.from({ length: 255 }, () => f.captureAdditional()))
      const overflow = {}
      await expect(f.captureAdditional(overflow))
        .rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
      let committed = false, ledgerReads = 0, receiptReads = 0, changes = 0
      const originalRun = f.database.run.bind(f.database)
      vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
        const result = originalRun(sql, args)
        if (sql === "COMMIT") {
          committed = true
          ledgerReads = 0
          if (lostCommit) throw Error("ACTUAL_COMMIT_ACK_LOST")
        }
        return result
      })
      const originalReadReceipt = f.store.readReceipt.bind(f.store)
      vi.spyOn(f.store, "readReceipt").mockImplementation((target, uuid) => {
        const result = originalReadReceipt(target, uuid)
        if (committed) receiptReads++
        return result
      })
      const originalExec = f.database.exec.bind(f.database)
      vi.spyOn(f.database, "exec").mockImplementation((sql, args) => {
        const result = originalExec(sql, args)
        if (committed && sql.includes("SELECT * FROM function_conversation_presentation_dispositions"))
          ledgerReads++
        return result
      })
      f.setGuard(() => {
        if (!committed || changes || (lostCommit ? receiptReads < 2 : !ledgerReads)) return
        changes++
        f.database.run(kind === "delete"
          ? "DELETE FROM function_conversation_presentation_dispositions WHERE thread_id=? AND uuid=?"
          : "UPDATE function_conversation_presentation_dispositions SET intent_digest=? WHERE thread_id=? AND uuid=?",
        kind === "delete" ? [f.threadId, f.uuid] : ["b".repeat(64), f.threadId, f.uuid])
      })
      expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_")
      expect(committed).toBe(true)
      expect(changes).toBe(1)
      expect(ledgerReads).toBeGreaterThan(0)
      expect(f.counts().writes).toBe(1)
      expect(f.database.inTransaction).toBe(false)
      expect(f.store.readReceipt(f.target, f.uuid)?.uuid).toBe(f.uuid)
      await expect(f.captureAdditional(overflow))
        .rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
      f.setGuard(undefined)
      f.access.close()
    })

  it("poisons caught same-claim verification reentry without releasing its real admission", async () => {
    const f = fixture({ human: true }), receipt = await f.capture()
    await Promise.all(Array.from({ length: 255 }, () => f.captureAdditional()))
    let committed = false, ledgerReads = 0, reentries = 0
    const originalRun = f.database.run.bind(f.database)
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      const result = originalRun(sql, args)
      if (sql === "COMMIT") { committed = true; ledgerReads = 0 }
      return result
    })
    const originalExec = f.database.exec.bind(f.database)
    vi.spyOn(f.database, "exec").mockImplementation((sql, args) => {
      const result = originalExec(sql, args)
      if (committed && sql.includes("SELECT * FROM function_conversation_presentation_dispositions"))
        ledgerReads++
      return result
    })
    f.setGuard(() => {
      if (!committed || !ledgerReads || reentries) return
      reentries++
      expect(() => f.access.verify(f.prepared().claim))
        .toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    })
    expect(() => f.commit(receipt)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(reentries).toBe(1)
    expect(f.counts().writes).toBe(1)
    expect(f.database.inTransaction).toBe(false)
    expect(f.store.readReceipt(f.target, f.uuid)?.uuid).toBe(f.uuid)
    f.setGuard(undefined)
    expect(() => f.access.verify(f.prepared().claim)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    await expect(f.captureAdditional()).rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
    f.access.close()
  })

  it("retains the sealed baseline after rollback of transaction-local verified rows", async () => {
    const f = fixture(), receipt = await f.capture()
    const original = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    let preparation: FunctionNativeProjectionPreparation | undefined
    expect(() => f.store.commit(f.target, f.fields, () => {}, (_db, _target, row) => {
      preparation = f.access.prepare(receipt, { database: f.database, target: f.target, row,
        protectedColumns: f.protectedColumns(row) })
      f.apply(preparation)
      recordFunctionConversationProjectionReceipt(f.database, f.selection(row))
    }, () => {
      if (!preparation) throw Error("Actual rollback preparation missing")
      f.access.assertPrepared(preparation.claim)
      expect(() => f.access.verify(preparation!.claim)).toThrow("MODS_CONVERSATION_NOT_COMMITTED")
      throw Error("ACTUAL_TRANSACTION_ROLLED_BACK")
    })).toThrow("ACTUAL_TRANSACTION_ROLLED_BACK")
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toEqual(original)
    expect(f.database.inTransaction).toBe(false)
    const actualPreparation = (() => {
      if (!preparation) throw Error("Actual rollback preparation missing")
      return preparation
    })()
    f.access.assertPrepared(actualPreparation.claim)
    expect(() => f.access.verify(actualPreparation.claim)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(() => f.access.claim(actualPreparation.claim)).toThrow("MODS_CONVERSATION_PROJECTION_CLAIM")
    expect(f.store.readRows(f.target)).toEqual([])
  })

  it("does not certify an already marked projection or a missing durable receipt from public field values", async () => {
    const f = fixture(), receipt = await f.capture()
    f.commit(receipt)
    const another = createFunctionConversationNativeProjectionAccess({ database: f.database,
      target: f.target, threadId: f.threadId, incarnation: f.incarnation, producer: {}, run: {},
      signal: f.controller.signal, assertCurrent: f.guard, bindOccurrence: () => ({
        facts: { uuid: f.uuid, role: "assistant", providerSourceId: f.original.provider_source_id!,
          providerOccurrence: 2 }, seal() { /* Fixture has no mutable producer buffer. */ }, flush() { /* No pending native writes. */ }, captureAliases: () => ({}),
        assertAliases() { f.guard() } }) })
    await expect(another.capture({})).rejects.toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
    f.database.run("DELETE FROM function_conversation_projection_receipts WHERE thread_id=?", [f.threadId])
    expect(() => f.access.verify(f.prepared().claim)).toThrow("MODS_CONVERSATION_MIGRATION_REQUIRED")
  })

  it.each(["database", "target", "ordinal"])(
    "rejects an unproven prepare %s without changing actual canonical data", async kind => {
      const f = fixture({ fresh: true }), receipt = await f.capture()
      const foreign = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
      try {
        expect(() => f.probe(receipt, request => kind === "database" ? { ...request, database: foreign }
          : kind === "target" ? { ...request, target: { ...request.target, conversationId: randomUUID() } }
            : { ...request, protectedColumns: { ...request.protectedColumns, ordinal: 9 } }))
          .toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
        expect(f.store.readRows(f.target)).toEqual([])
        expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)).toBeUndefined()
        expect(f.counts().writes).toBe(0)
      } finally { foreign.close() }
    }
  )

  it("rejects projection accessors without evaluating them or using a successful public field as proof", async () => {
    const f = fixture(), receipt = await f.capture()
    let getterCalls = 0
    expect(() => f.probe(receipt, request => {
      const columns = { ...request.protectedColumns }
      Object.defineProperty(columns, "content_json", { enumerable: true, get() {
        getterCalls += 1; return JSON.stringify("secret")
      } })
      return { ...request, protectedColumns: columns }
    })).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    expect(getterCalls).toBe(0)
    expect(f.counts().writes).toBe(0)
  })

  it("rejects a post-COMMIT retired source ACK while preserving the real committed row and receipt", async () => {
    const f = fixture(), receipt = await f.capture(), originalRun = f.database.run.bind(f.database)
    vi.spyOn(f.database, "run").mockImplementation((sql, args) => {
      const result = originalRun(sql, args)
      if (sql === "COMMIT") f.retire()
      return result
    })
    expect(() => f.commit(receipt)).toThrow("ACTUAL_NATIVE_SOURCE_RETIRED")
    expect(f.database.inTransaction).toBe(false)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_rows WHERE conversation_id=?",
      [f.target.conversationId])[0].values[0][0]).toBe(1)
    expect(f.database.exec("SELECT COUNT(*) FROM function_conversation_projection_receipts WHERE thread_id=?",
      [f.threadId])[0].values[0][0]).toBe(1)
    expect(f.counts().writes).toBe(1)
    expect(() => f.access.verify(f.prepared().claim)).toThrow("ACTUAL_NATIVE_SOURCE_RETIRED")
  })

  it("preserves actual source failures, abort and same-ID incarnation replacement without re-binding", async () => {
    for (const kind of ["source", "abort", "incarnation"] as const) {
      const f = fixture(), receipt = await f.capture()
      if (kind === "source") f.retire()
      if (kind === "abort") f.controller.abort()
      if (kind === "incarnation") f.database.run("UPDATE threads SET metadata=? WHERE thread_id=?",
        [JSON.stringify({ cmb_thread_incarnation: randomUUID() }), f.threadId])
      expect(() => f.commit(receipt)).toThrow(kind === "source" ? "ACTUAL_NATIVE_SOURCE_RETIRED" :
        kind === "abort" ? "MODS_CONVERSATION_SOURCE_RETIRED" : "MODS_CONVERSATION_THREAD_CHANGED")
      expect(f.counts().writes).toBe(0)
    }
  })

  it("keeps an actual failed flush once terminal and never re-seals on a later capture", async () => {
    const gate = deferred(), f = fixture({ flush: gate.promise }), promise = f.capture()
    const failure = new Error("ACTUAL_STRICT_FLUSH_FAILED")
    gate.reject(failure)
    await expect(promise).rejects.toBe(failure)
    expect(f.capture()).toBe(promise)
    await expect(f.capture()).rejects.toBe(failure)
    expect(f.counts()).toEqual({ seals: 1, flushes: 1, writes: 0 })
  })

  it("bounds outstanding original occurrences and closing does not pretend a held native flush settled", async () => {
    const f = fixture({ fresh: true }), gate = deferred(), calls = { seal: 0, flush: 0 }
    const allowed = new WeakMap<object, string>()
    const access = createFunctionConversationNativeProjectionAccess({ database: f.database,
      target: f.target, threadId: f.threadId, incarnation: f.incarnation, producer: {}, run: {},
      signal: f.controller.signal, assertCurrent: f.guard, bindOccurrence(actual) {
        const uuid = allowed.get(actual)
        if (!uuid) throw Error("Unknown original occurrence")
        return { facts: { uuid, role: "assistant", providerSourceId: uuid, providerOccurrence: 1 },
          seal() { calls.seal += 1 }, flush() { calls.flush += 1; return gate.promise },
          captureAliases: () => ({}), assertAliases() { f.guard() } }
      } })
    const promises = Array.from({ length: 256 }, () => {
      const actual = {}; allowed.set(actual, randomUUID()); return access.capture(actual)
    })
    await expect(access.capture({})).rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
    access.close()
    let settled = false
    Promise.all(promises).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(calls).toEqual({ seal: 256, flush: 256 })
    gate.resolve()
    await Promise.all(promises)
    await expect(access.capture({})).rejects.toThrow("MODS_CONVERSATION_PROJECTION_UNAVAILABLE")
  })
})
