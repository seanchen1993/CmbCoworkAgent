import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { createFunctionConversationNativeProjectionAccess } from "../db/function-conversation-native-projection"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FunctionNativeMessageProtector } from "./native-message-protector"
import { serializeFunctionConversationNativeMessage } from "./function-conversation-native-message"
import { FunctionConversationNativeKeeper, type FunctionConversationNativeKeeperAdmission,
  type FunctionConversationNativeKeeperRuntime } from "./function-conversation-native-keeper"
import type { ThreadMessageWrite } from "../types"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "../db"

let directory = ""
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-keeper-actual-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function fixture(options: {
  message?: BaseMessage
  protected?: boolean
  flush?: Promise<void>
  dispatch?: FunctionConversationNativeKeeperRuntime["dispatch"]
  afterCommit?: () => void
} = {}) {
  const message = options.message ?? new AIMessage({ id: randomUUID(), content: "Original private-literal body",
    tool_calls: [{ id: "actual-call", name: "ActualTool", args: { full: "actual-final" }, type: "tool_call" }],
    usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    response_metadata: { provider: "actual" } })
  if (!message.id) throw Error("ACTUAL_FIXTURE_ID_MISSING")
  const uuid = message.id, threadId = randomUUID(), thread = appDb.createThread(threadId)
  const database = appDb.getDb(), store = new FunctionConversationStore(database)
  const authorities = new ModRuntimeAuthorities(), registry = new FunctionConversationRegistry(store, authorities)
  const controller = new AbortController(), owner = {}, producer = {}, occurrence = {}, run = {}
  let live = true, retained = 0, releases = 0, commits = 0, seals = 0, flushes = 0
  let onSeal: (() => void) | undefined
  const guard = () => {
    if (!live) throw new ModFunctionError("MODS_CONVERSATION_SOURCE_RETIRED")
    controller.signal.throwIfAborted()
  }
  const incarnation = captureThreadIncarnation(thread)
  const ref = store.ensureMain({ threadId, workspace: directory, incarnation, checkpointNamespace: "" }, guard)
  const authority = authorities.create({ workspace: directory, threadId, turnId: randomUUID() }, controller.signal)
  const target = registry.registerMain(owner, { identity: {}, ref, checkpointThreadId: threadId,
    authority: authority.authority, signal: controller.signal, assertCurrent: guard })
  const role = ToolMessage.isInstance(message) ? "tool" : AIMessage.isInstance(message) ? "assistant" : "user"
  const partial: ThreadMessageWrite = { id: uuid, role, content: "Partial display",
    provider_source_id: "actual-provider", provider_occurrence: 1, created_at: new Date(100),
    ...(ToolMessage.isInstance(message) ? { tool_call_id: message.tool_call_id,
      status: message.status, name: message.name } : {}),
    ...(AIMessage.isInstance(message) ? { tool_calls: [{ id: "actual-call", name: "ActualTool",
      args: { incomplete: true } }] } : {}) }
  appDb.upsertThreadMessages(threadId, [partial])
  const originalColumns = readFunctionConversationRawProjection(database, threadId, uuid)
  const policy = { identity: {}, protected: options.protected === true, digest: "actual-policy",
    epoch: 1, deployment: { version: 1 as const, id: "cmb.baseline/v1" as const,
      required: options.protected === true, redactLiterals: ["private-literal"], denyTools: [] } }
  const protector = new FunctionNativeMessageProtector()
  const runtime: FunctionConversationNativeKeeperRuntime = { owner, target,
    destination: { conversation: ref, threadId, incarnation, assertCurrent: guard }, run,
    signal: controller.signal, assertCurrent: guard,
    dispatch: options.dispatch ?? (ticket => ticket.core(ticket.input)),
    runMutation: (actualProducer, actualOccurrence, actualRun) => registry.runMutation({ owner,
      plugin: actualProducer, registration: actualOccurrence, signal: controller.signal,
      assertCurrent: guard }, target, "native", actualRun) }
  const keeper = new FunctionConversationNativeKeeper(runtime, protector)
  let sealed = false
  const seal = () => { if (!sealed) { sealed = true; seals++; onSeal?.() } }
  const admission: FunctionConversationNativeKeeperAdmission = { producer, occurrence, message,
    signal: controller.signal, policy, assertCurrent: guard,
    door: ToolMessage.isInstance(message) ? "tool-result" : AIMessage.isInstance(message) ? "response" : "prompt",
    origin: ToolMessage.isInstance(message) ? { kind: "tool", tool: "ActualTool" }
      : AIMessage.isInstance(message) ? { kind: "model", model: "ActualModel" } : { kind: "composer" },
    seal,
    async captureProjection(finalExecution) {
      const access = createFunctionConversationNativeProjectionAccess({ database, target: ref,
        threadId, incarnation, producer, run, signal: controller.signal,
        assertCurrent: () => { guard(); target.assertCurrent() },
        bindOccurrence(actual) {
          if (actual !== occurrence) throw Error("ACTUAL_OCCURRENCE_MISMATCH")
          const aliases = {}
          return { facts: { uuid, role, providerSourceId: "actual-provider", providerOccurrence: 1,
            ...(ToolMessage.isInstance(message) ? { toolCallId: message.tool_call_id,
              status: message.status, name: message.name } : {}) },
            seal, flush() { flushes++; return options.flush },
            captureAliases: () => aliases,
            assertAliases(receipt) {
              guard(); target.assertCurrent()
              if (receipt !== aliases) throw Error("ACTUAL_ALIAS_MISMATCH")
            },
            ...(finalExecution ? { finalExecution } : {}) }
        } })
      return { access, receipt: await access.capture(occurrence) }
    },
    async prepare(candidate, nativeProjection, signal, assertCurrent) {
      guard(); signal.throwIfAborted(); assertCurrent()
      const native = candidate.native
      const access = createFunctionConversationTranscriptAccess((_target, row) => ({
        ...partial, content: JSON.stringify(row.message.content), is_error: ToolMessage.isInstance(native) &&
          Array.isArray(row.message.content) && !!row.message.content[0] &&
          typeof row.message.content[0] === "object" && !Array.isArray(row.message.content[0])
            ? row.message.content[0].is_error === true : false,
        ...(AIMessage.isInstance(native) ? { tool_calls: (native.tool_calls ?? []).map(call => {
          if (!call.id) throw Error("ACTUAL_CALL_ID_MISSING")
          return { id: call.id, name: call.name, args: call.args }
        }) } : {})
      }), runtime.destination, ToolMessage.isInstance(native) ? native : undefined, nativeProjection)
      return {
        commit(check) {
          commits++
          const row = store.commit(ref, { uuid, inputDigest: candidate.inputDigest,
            door: candidate.door, origin: candidate.origin, message: candidate.rendering,
            nativePayload: candidate.nativePayload, orderAnchor: { actualOccurrence: uuid },
            inbox: false, sdk: false }, check, access.write, access.verify)
          options.afterCommit?.()
          return row
        },
        read() {
          const row = store.readReceipt(ref, uuid)
          if (row) access.verify(database, ref, row)
          return row
        }
      }
    },
    retainActualWork() { retained++; return () => { retained--; releases++ } },
    assertExecutionFacts(raw, safe) {
      if (Object.getPrototypeOf(raw) !== Object.getPrototypeOf(safe) || raw.id !== safe.id ||
        (ToolMessage.isInstance(raw) && (!ToolMessage.isInstance(safe) ||
          raw.tool_call_id !== safe.tool_call_id || raw.status !== safe.status)))
        throw Error("ACTUAL_EXECUTION_CHANGED")
    },
    inheritPresentation() { /* The native original has no private presentation override. */ }
  }
  cleanup.push(async () => {
    keeper.close(); await keeper.whenDrained(); registry.close(); authorities.close()
  })
  return { keeper, protector, admission, target, ref, store, registry, runtime, message, policy, controller,
    originalColumns, database, threadId, uuid,
    counts: () => ({ retained, releases, commits, seals, flushes }),
    retire: () => { live = false }, onSeal: (callback: () => void) => { onSeal = callback } }
}

describe("actual native keeper foundation with SQLite projection and full protection", () => {
  it("notifies the original producer only with certified first and final protected results", async () => {
    const seen: string[] = []
    const f = fixture({ protected: true,
      message: new HumanMessage({ id: randomUUID(), content: "first private-literal body" }),
      dispatch: ticket => ticket.core({ ...ticket.input, message: { ...ticket.input.message,
        content: [{ type: "text", text: "final private-literal body" }] } }) })
    f.admission.onProtected = result => {
      f.protector.assertResult(result.receipt, result.message, f.admission.producer)
      f.protector.assertProtected(result.receipt, result.message, f.admission.producer)
      seen.push(String(result.message.content))
    }
    const saved = await f.keeper.retain(f.admission)
    await f.keeper.whenDrained()
    expect(seen).toEqual(["first [REDACTED] body", "final [REDACTED] body"])
    expect(saved.message.content).toBe("final [REDACTED] body")
    expect(f.counts().commits).toBe(1)
  })

  it("rejects a protected observer accessor before calling it or starting native work", () => {
    const f = fixture()
    let getters = 0
    Object.defineProperty(f.admission, "onProtected", { enumerable: true, get() {
      getters++
      return () => undefined
    } })
    expect(() => f.keeper.retain(f.admission)).toThrow("MODS_CONVERSATION_NATIVE_KEEPER_INVALID")
    expect(getters).toBe(0)
    expect(f.counts()).toEqual({ retained: 0, releases: 0, commits: 0, seals: 0, flushes: 0 })
  })

  it("keeps both result checks for an immutable protected policy from a generic source", async () => {
    const f = fixture({ protected: true })
    Object.defineProperty(f.policy, "protected", { value: true, enumerable: true,
      writable: false, configurable: false })
    const trace: string[] = []
    const observed: string[][] = []
    const assertResult = f.protector.assertResult, assertProtected = f.protector.assertProtected
    const result = vi.spyOn(f.protector, "assertResult").mockImplementation(function (
      this: FunctionNativeMessageProtector, ...args) {
      trace.push("result")
      Reflect.apply(assertResult, this, args)
    })
    cleanup.push(async () => { result.mockRestore() })
    const protectedResult = vi.spyOn(f.protector, "assertProtected")
      .mockImplementation(function (this: FunctionNativeMessageProtector, ...args) {
        trace.push("protected")
        Reflect.apply(assertProtected, this, args)
      })
    cleanup.push(async () => { protectedResult.mockRestore() })
    f.admission.onProtected = () => { observed.push(trace.slice(-3)) }
    const saved = await f.keeper.retain(f.admission)
    await f.keeper.whenDrained()
    expect(observed).toEqual([
      ["result", "protected", "result"], ["result", "protected", "result"]
    ])
    expect(saved.message.content).toBe("Original [REDACTED] body")
    expect(f.counts().commits).toBe(1)
  })

  it("still checks protection when the first generic result check enables a mutable policy", async () => {
    const f = fixture()
    let changed = false
    const assertResult = f.protector.assertResult
    const result = vi.spyOn(f.protector, "assertResult").mockImplementation(function (
      this: FunctionNativeMessageProtector, ...args) {
      Reflect.apply(assertResult, this, args)
      if (!changed) { changed = true; f.policy.protected = true }
    })
    cleanup.push(async () => { result.mockRestore() })
    const protectedResult = vi.spyOn(f.protector, "assertProtected")
    cleanup.push(async () => { protectedResult.mockRestore() })
    await expect(f.keeper.retain(f.admission)).rejects.toThrow("MODS_NATIVE_PROTECTION_IDENTITY")
    await f.keeper.whenDrained()
    expect(changed).toBe(true)
    expect(protectedResult).toHaveBeenCalledOnce()
    expect(f.counts().commits).toBe(0)
    expect(f.store.readRows(f.ref)).toEqual([])
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid))
      .toEqual(f.originalColumns)
  })

  it.each(["abort", "source"] as const)(
    "rejects a protected producer observer's late %s before writing", async (attack) => {
      const f = fixture({ protected: true })
      let observed = 0
      f.admission.onProtected = () => {
        observed++
        if (attack === "abort") f.controller.abort(Error("ACTUAL_KEEPER_OBSERVER_CANCEL"))
        else f.retire()
      }
      await expect(f.keeper.retain(f.admission)).rejects.toThrow(attack === "abort"
        ? "ACTUAL_KEEPER_OBSERVER_CANCEL" : "MODS_CONVERSATION_SOURCE_RETIRED")
      await f.keeper.whenDrained()
      expect(observed).toBe(1)
      expect(f.counts().commits).toBe(0)
      expect(f.store.readRows(f.ref)).toEqual([])
      expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid))
        .toEqual(f.originalColumns)
      expect(f.registry.activeMutations).toBe(0)
    })

  it("does not adopt an observer-mutated protected result", async () => {
    const f = fixture()
    f.admission.onProtected = result => { result.message.content = "uncertified observer body" }
    await expect(f.keeper.retain(f.admission)).rejects.toThrow()
    await f.keeper.whenDrained()
    expect(f.counts().commits).toBe(0)
    expect(f.registry.activeMutations).toBe(0)
  })

  it("does not commit or replay when the original protected observer fails", async () => {
    const f = fixture()
    let notifications = 0
    f.admission.onProtected = () => { notifications++; throw Error("ACTUAL_PRESENTATION_FAILED") }
    const first = f.keeper.retain(f.admission)
    await expect(first).rejects.toThrow("ACTUAL_PRESENTATION_FAILED")
    await f.keeper.whenDrained()
    expect(f.keeper.retain(f.admission)).toBe(first)
    expect(notifications).toBe(1)
    expect(f.counts().commits).toBe(0)
    expect(f.registry.activeMutations).toBe(0)
  })

  it("commits an actual v1 text rewrite while retaining the complete calls and signed reasoning", async () => {
    const message = new AIMessage({ id: randomUUID(), content: [
      { type: "reasoning", reasoning: "fixed reasoning", signature: "native-signature" },
      { type: "text", text: "old v1 body" }
    ], response_metadata: { output_version: "v1", provider: "actual" }, tool_calls: [{
      id: "actual-call", name: "ActualTool", args: { final: "preserved" }, type: "tool_call"
    }], usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })
    const f = fixture({ message, dispatch: ticket => {
      const content = ticket.input.message.content
      if (!Array.isArray(content)) throw Error("ACTUAL_V1_BLOCKS_MISSING")
      return ticket.core({ ...ticket.input, message: { ...ticket.input.message,
        content: content.map(block => block && typeof block === "object" && !Array.isArray(block) &&
          block.type === "text" ? { type: "text", text: "actual rewritten v1 body" } : block) } })
    } })
    const saved = await f.keeper.retain(f.admission)
    expect(AIMessage.isInstance(saved.message) && saved.message.tool_calls).toEqual(message.tool_calls)
    expect(saved.message.content).toContainEqual({ type: "text", text: "actual rewritten v1 body" })
    expect(saved.message.content).toContainEqual({ type: "reasoning",
      reasoning: "fixed reasoning", signature: "native-signature" })
    expect(saved.message.content).not.toContainEqual({ type: "text", text: "old v1 body" })
    const payload = JSON.parse(saved.row.nativePayload)
    expect(payload.message.data.content_blocks).toEqual(payload.message.data.content)
    expect(serializeFunctionConversationNativeMessage(saved.message)).toBe(saved.row.nativePayload)
    expect(f.counts().commits).toBe(1)
  })

  it("uses one native admission/core, preserves final calls and returns a separate canonical stamped AI", async () => {
    const f = fixture({ dispatch: ticket => {
      const original = ticket.input.message.content
      if (!Array.isArray(original)) throw Error("ACTUAL_AI_PUBLIC_BLOCKS_MISSING")
      const changed = { ...ticket.input, message: { ...ticket.input.message,
        content: [{ type: "text", text: "Hook body" }, ...original.filter(block =>
          !block || typeof block !== "object" || Array.isArray(block) || block.type !== "text")] } }
      const first = ticket.core(changed)
      expect(ticket.core(ticket.input)).toBe(first)
      return first
    } })
    let reentered: Promise<unknown> | undefined
    f.onSeal(() => { reentered = f.keeper.retain(f.admission) })
    const first = f.keeper.retain(f.admission)
    expect(reentered).toBe(first)
    expect(f.keeper.retain(f.admission)).toBe(first)
    const saved = await first
    expect(AIMessage.isInstance(saved.message)).toBe(true)
    expect(saved.message.content).toBe("Hook body")
    expect(saved.message).not.toBe(f.message)
    expect(saved.message.additional_kwargs.function_row).toMatchObject({ uuid: f.uuid,
      sequence: saved.row.sequence, messageType: "assistant" })
    expect(f.message.additional_kwargs.function_row).toBeUndefined()
    expect(serializeFunctionConversationNativeMessage(saved.message)).toBe(saved.row.nativePayload)
    const actual = readFunctionConversationRawProjection(f.database, f.threadId, f.uuid)
    expect(actual?.tool_calls_json).toBe(JSON.stringify([{ id: "actual-call", name: "ActualTool",
      args: { full: "actual-final" } }]))
    expect(actual?.ordinal).toBe(f.originalColumns?.ordinal)
    expect(saved.row.inbox).toBe(false)
    expect(f.counts()).toMatchObject({ retained: 0, commits: 1, seals: 1, flushes: 1 })
  })

  it("runs real full protection before constructing the Retainer or committing", async () => {
    const f = fixture({ protected: true, message: new HumanMessage({ id: randomUUID(),
      content: "User private-literal body", additional_kwargs: { apiKey: "raw-secret" } }) })
    const saved = await f.keeper.retain(f.admission)
    expect(saved.message.content).toBe("User [REDACTED] body")
    expect(saved.row.nativePayload).not.toContain("raw-secret")
    expect(saved.message.additional_kwargs.isMeta).toBeUndefined()
    expect(saved.message.additional_kwargs.function_row).not.toHaveProperty("isMeta")
    expect(f.counts().retained).toBe(0)
    expect(f.counts().commits).toBe(1)
  })

  it("stamps a high-sequence native row without consuming an earlier actual pending SDK note", async () => {
    const f = fixture(), uuid = randomUUID()
    const note = new HumanMessage({ id: uuid, content: "pending actual note",
      additional_kwargs: { isMeta: true } })
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({
      id: row.uuid, role: "user", content: JSON.stringify(row.message.content),
      created_at: new Date(row.createdAt)
    }))
    const pendingNote = f.store.commit(f.ref, { uuid, inputDigest: uuid, door: "note",
      origin: { kind: "plugin", name: "actual-note-plugin" },
      message: { type: "user", role: "user", isMeta: true,
        content: [{ type: "text", text: "pending actual note" }] },
      nativePayload: serializeFunctionConversationNativeMessage(note),
      orderAnchor: {}, inbox: true, sdk: true }, () => f.runtime.assertCurrent(),
      access.write, access.verify)
    const saved = await f.keeper.retain(f.admission)
    expect(saved.row.sequence).toBeGreaterThan(pendingNote.sequence)
    expect(saved.message.additional_kwargs.function_row).toMatchObject({ sequence: saved.row.sequence })
    const inbox = f.store.captureInbox(f.ref, 0)
    expect(inbox.frontier).toBe(0)
    expect(inbox.highWater).toBe(saved.row.sequence)
    expect(inbox.rows.map(row => row.uuid)).toEqual([pendingNote.uuid])
  })

  it("keeps Tool execution status/artifact facts while public is_error changes independently", async () => {
    const f = fixture({ protected: true, message: new ToolMessage({ id: randomUUID(),
      tool_call_id: "actual-call", name: "ActualTool", status: "success", content: "real output",
      artifact: { executed: true, apiKey: "raw-secret" } }),
      dispatch: ticket => ticket.core({ ...ticket.input, message: { ...ticket.input.message,
        content: [{ type: "tool_result", tool_use_id: "actual-call", is_error: true,
          content: [{ type: "text", text: "Presented error" }] }] } }) })
    const saved = await f.keeper.retain(f.admission)
    expect(ToolMessage.isInstance(saved.message) && saved.message.status).toBe("success")
    expect(ToolMessage.isInstance(saved.message) && saved.message.artifact)
      .toEqual({ executed: true, apiKey: "[REDACTED]" })
    expect(readFunctionConversationRawProjection(f.database, f.threadId, f.uuid))
      .toMatchObject({ status: "success", is_error: 1, tool_call_id: "actual-call" })
  })

  it("retains complete >1MiB native text without entering the bounded public Hook", async () => {
    let hooks = 0
    const body = "完整正文".repeat(300_000)
    const f = fixture({ message: new HumanMessage({ id: randomUUID(), content: body }),
      dispatch: ticket => { hooks++; return ticket.core(ticket.input) } })
    const saved = await f.keeper.retain(f.admission)
    expect(saved.message.content).toBe(body)
    expect(saved.publicAvailability).toBe("limit")
    expect(saved.row.nativePayload.length).toBeGreaterThan(1_048_576)
    expect(hooks).toBe(0)
    expect(f.counts().commits).toBe(1)
  })

  it("rejects raw overrides before codec, native flush or actual retain", async () => {
    const message = new HumanMessage({ id: randomUUID(), content: "raw" })
    let calls = 0
    Object.defineProperty(message, "toJSON", { value: () => { calls++; return {} } })
    const f = fixture({ message })
    await expect(f.keeper.retain(f.admission)).rejects.toMatchObject({ code: "MODS_NATIVE_CAPTURE_TYPE" })
    expect(calls).toBe(0)
    expect(f.counts()).toEqual({ retained: 0, releases: 0, commits: 0, seals: 1, flushes: 0 })
  })

  it("rejects public cancellation promptly while a real strict flush retains mutation ownership", async () => {
    const gate = deferred(), f = fixture({ flush: gate.promise })
    const result = f.keeper.retain(f.admission)
    expect(f.registry.activeMutations).toBe(1)
    f.controller.abort(new ModFunctionError("MODS_CANCELLED"))
    await expect(result).rejects.toMatchObject({ code: "MODS_CANCELLED" })
    expect(f.registry.activeMutations).toBe(1)
    let drained = false
    const drain = f.keeper.whenDrained().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    await drain
    expect(f.registry.activeMutations).toBe(0)
    expect(f.counts().commits).toBe(0)
  })

  it("keeps the committed fact when source retirement rejects the final ACK, without replay", async () => {
    const f = fixture({ afterCommit: () => f.retire() })
    await expect(f.keeper.retain(f.admission)).rejects.toThrow()
    await f.keeper.whenDrained()
    expect(f.store.readReceipt(f.ref, f.uuid)?.nativePayload).toContain("Original private-literal body")
    expect(f.counts().commits).toBe(1)
    await expect(f.keeper.retain(f.admission)).rejects.toThrow()
    expect(f.counts().commits).toBe(1)
  })
})
