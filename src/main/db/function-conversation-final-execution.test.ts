import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { FunctionNativeMessageProtector } from "../agent/native-message-protector"
import { serializeFunctionConversationNativeMessage } from "../agent/function-conversation-native-message"
import { FunctionConversationNativeRendering } from "../agent/function-conversation-native-rendering"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { FunctionConversationStore } from "./function-conversation-store"
import { FunctionConversationFinalExecutions, readFunctionNativeFinalExecution,
  type FunctionNativeExecutionSource } from "./function-conversation-final-execution"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as appDb from "./index"

let directory = ""
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-final-native-execution-"))
  paths.database = join(directory, "app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(actualMessage?: AIMessage, protectedOutput = false) {
  const threadId = randomUUID(), thread = appDb.createThread(threadId)
  const database = appDb.getDb(), store = new FunctionConversationStore(database)
  const registry = new FunctionConversationRegistry(store, new ModRuntimeAuthorities())
  const protector = new FunctionNativeMessageProtector(), executions = new FunctionConversationFinalExecutions(protector)
  const controller = new AbortController(), producer = {}, run = {}, occurrence = {}
  let live = true, retained = 0, sourceChecks = 0, targetChecks = 0
  let sourceCallback: (() => void) | undefined, targetCallback: (() => void) | undefined
  const current = () => {
    if (!live) throw Error("ACTUAL_SOURCE_RETIRED")
    controller.signal.throwIfAborted()
  }
  const guard = () => {
    current(); sourceChecks += 1; sourceCallback?.(); current()
  }
  const targetGuard = () => {
    current(); targetChecks += 1; targetCallback?.(); current()
  }
  const ref = store.ensureMain({ threadId, workspace: directory,
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, guard)
  const target = registry.registerMain({}, { identity: {}, ref, checkpointThreadId: ref.threadId,
    signal: controller.signal, assertCurrent: targetGuard })
  cleanup.push(async () => {
    executions.close(); protector.close(); await protector.whenDrained(); registry.close()
  })
  const message = actualMessage ?? new AIMessage({ id: randomUUID(), content: "Original body",
    tool_calls: [{ id: "actual-call", name: "ActualTool", args: { final: true }, type: "tool_call" }],
    usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    response_metadata: { provider: "actual" } })
  const protect = (actual: AIMessage, options: { assertCurrent?: () => void; signal?: AbortSignal } = {}) =>
    protector.protect(protector.capture({ message: actual,
    producer, signal: options.signal ?? controller.signal, assertCurrent: options.assertCurrent ?? guard,
    policy: { identity: {}, protected: protectedOutput,
      digest: protectedOutput ? "actual-test-policy" : "explicit-off", epoch: 1,
      deployment: { version: 1, id: "cmb.baseline/v1", required: protectedOutput,
        redactLiterals: [], denyTools: [] } },
    retainActualWork() { retained++; return () => { retained-- } },
    assertExecutionFacts(original, safe) {
      if (original.id !== safe.id) throw Error("ACTUAL_ID_CHANGED")
    },
    inheritPresentation() { /* AI has no Tool error presentation sidecar. */ }
  }))
  const result = await protect(message)
  const source: FunctionNativeExecutionSource = { producer, run, occurrence, target,
    signal: controller.signal, assertCurrent: guard }
  const original = executions.capture(source, result), final = executions.bind(original, result)
  const expected = { producer, run, occurrence, target: ref, uuid: message.id ?? "",
    nativePayload: serializeFunctionConversationNativeMessage(result.message) }
  return { protector, executions, message, source, result, original, final, expected, protect,
    controller, database, threadId, thread, ref,
    checks: () => ({ source: sourceChecks, target: targetChecks }),
    onSource: (callback: () => void) => { sourceCallback = callback },
    onTarget: (callback: () => void) => { targetCallback = callback },
    retired: () => { live = false }, retained: () => retained }
}

function replacement(f: Awaited<ReturnType<typeof fixture>>): void {
  appDb.deleteThread(f.threadId)
  appDb.createThread(f.threadId)
  f.database.run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
    f.thread.created_at, f.threadId
  ])
  const actual = appDb.getThreadCore(f.threadId)
  if (!actual) throw Error("Actual replacement thread missing")
  const incarnation = captureThreadIncarnation(actual)
  expect(incarnation.legacyCreatedAt).toBe(f.ref.incarnation.legacyCreatedAt)
  expect(incarnation.token).not.toBe(f.ref.incarnation.token)
}

function noRows(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.database.exec(`SELECT COUNT(*) FROM function_conversation_rows
    WHERE conversation_id = ? AND uuid = ?`, [f.ref.conversationId, f.expected.uuid])[0].values)
    .toEqual([[0]])
  expect(f.database.exec("SELECT COUNT(*) FROM thread_messages WHERE thread_id = ?",
    [f.threadId])[0].values).toEqual([[0]])
  expect(f.database.inTransaction).toBe(false)
  expect(f.retained()).toBe(0)
}

describe("private final execution receipts from actual protected AI results", () => {
  it.each([false, true])("keeps two full source checks for same-source rewritten result (%s)",
    async rewrite => {
      const f = await fixture()
      const result = rewrite ? await f.protect(new AIMessage({ id: f.message.id, content: "Changed body",
        tool_calls: f.message.tool_calls, usage_metadata: f.message.usage_metadata,
        response_metadata: f.message.response_metadata })) : f.result
      const receipt = rewrite ? f.executions.bind(f.original, result) : f.final
      const before = f.checks()
      expect(readFunctionNativeFinalExecution(receipt, { ...f.expected,
        nativePayload: serializeFunctionConversationNativeMessage(result.message) }).tool_calls_json)
        .toBe(JSON.stringify([{ id: "actual-call", name: "ActualTool", args: { final: true } }]))
      expect(f.checks()).toEqual({ source: before.source + 2, target: before.target + 2 })
      noRows(f)
    })

  it.each(["source", "signal"] as const)("keeps the old full fallback for a different %s", async kind => {
    const f = await fixture(), other = new AbortController()
    const current = kind === "source" ? () => f.source.assertCurrent() : f.source.assertCurrent
    const changed = new AIMessage({ id: f.message.id, content: "Changed body",
      tool_calls: f.message.tool_calls, usage_metadata: f.message.usage_metadata,
      response_metadata: f.message.response_metadata })
    const result = await f.protect(changed, { assertCurrent: current,
      signal: kind === "signal" ? other.signal : f.controller.signal })
    const receipt = f.executions.bind(f.original, result)
    expect(f.protector.matchesResultSource(result.receipt, result.message, f.source.producer,
      f.source.assertCurrent, f.controller.signal)).toBe(false)
    const before = f.checks()
    expect(readFunctionNativeFinalExecution(receipt, { ...f.expected,
      nativePayload: serializeFunctionConversationNativeMessage(result.message) }).tool_calls_json)
      .toBe(JSON.stringify([{ id: "actual-call", name: "ActualTool", args: { final: true } }]))
    expect(f.checks()).toEqual({ source: before.source + 4, target: before.target + 2 })
    noRows(f)
  })

  it.each([
    { boundary: "source", effect: "raw", error: "MODS_NATIVE_MESSAGE_CHANGED" },
    { boundary: "target", effect: "safe", error: "MODS_NATIVE_PROTECTION_IDENTITY" },
    { boundary: "source", effect: "protector-close", error: "MODS_NATIVE_PROTECTION_IDENTITY" },
    { boundary: "target", effect: "execution-close", error: "MODS_CONVERSATION_FINAL_EXECUTION_INVALID" },
    { boundary: "source", effect: "abort", error: "ACTUAL_ABORT" },
    { boundary: "target", effect: "incarnation", error: "MODS_CONVERSATION_THREAD_CHANGED" }
  ] as const)("rejects $effect from the final $boundary callback", async ({ boundary, effect, error }) => {
    const f = await fixture(undefined, effect === "raw" || effect === "safe")
    if (effect === "raw" || effect === "safe") expect(f.result.message).not.toBe(f.message)
    const before = f.checks()
    let attacks = 0
    const callback = () => {
      if (f.checks()[boundary] !== before[boundary] + 2) return
      attacks += 1
      if (effect === "raw") f.message.content = "Changed original raw body"
      else if (effect === "safe") f.result.message.content = "Changed protected safe body"
      else if (effect === "protector-close") f.protector.close()
      else if (effect === "execution-close") f.executions.close()
      else if (effect === "abort") f.controller.abort(Error("ACTUAL_ABORT"))
      else replacement(f)
    }
    if (boundary === "source") f.onSource(callback)
    else f.onTarget(callback)
    expect(() => readFunctionNativeFinalExecution(f.final, f.expected)).toThrow(error)
    expect(attacks).toBe(1)
    noRows(f)
  })

  it.each(["getType", "toDict"] as const)("checks the source again after real serializer %s callbacks",
    async method => {
      for (const effect of ["source", "abort", "incarnation"] as const) {
        const f = await fixture()
        let callbacks = 0
        const attack = () => {
          if (callbacks) return
          callbacks += 1
          if (effect === "source") f.retired()
          else if (effect === "abort") f.controller.abort(Error("ACTUAL_ABORT"))
          else replacement(f)
        }
        const restore = method === "getType" ? (() => {
          const original = AIMessage.prototype.getType
          const spy = vi.spyOn(AIMessage.prototype, "getType").mockImplementation(function (this: AIMessage) {
            attack()
            return original.call(this)
          })
          return () => spy.mockRestore()
        })() : (() => {
          const original = AIMessage.prototype.toDict
          const spy = vi.spyOn(AIMessage.prototype, "toDict").mockImplementation(function (this: AIMessage) {
            attack()
            return original.call(this)
          })
          return () => spy.mockRestore()
        })()
        try {
          expect(() => readFunctionNativeFinalExecution(f.final, f.expected)).toThrow(
            effect === "source" ? "ACTUAL_SOURCE_RETIRED" : effect === "abort" ? "ACTUAL_ABORT"
              : "MODS_CONVERSATION_THREAD_CHANGED")
          expect(callbacks).toBe(1)
          noRows(f)
        } finally { restore() }
      }
    })

  it("accepts only a v1 content rewrite with fixed calls and fixed signed content", async () => {
    const native = new AIMessage({ id: randomUUID(), content: [
      { type: "reasoning", reasoning: "fixed", signature: "native-signature" },
      { type: "text", text: "old body" }
    ], response_metadata: { output_version: "v1" }, tool_calls: [
      { id: "actual-call", name: "ActualTool", args: { final: true }, type: "tool_call" }
    ] })
    const f = await fixture(native), rendering = new FunctionConversationNativeRendering()
    const projected = rendering.project(f.result.message)
    if (!Array.isArray(projected.content)) throw Error("ACTUAL_V1_BLOCKS_MISSING")
    const changed = rendering.apply(f.result.message, { ...projected,
      content: projected.content.map(block => block && typeof block === "object" &&
        !Array.isArray(block) && block.type === "text" ? { type: "text", text: "new body" } : block) })
    if (!AIMessage.isInstance(changed)) throw Error("ACTUAL_AI_CLASS_LOST")
    const safe = await f.protect(changed), receipt = f.executions.bind(f.original, safe)
    expect(readFunctionNativeFinalExecution(receipt, { ...f.expected,
      nativePayload: serializeFunctionConversationNativeMessage(safe.message) }).tool_calls_json)
      .toBe(readFunctionNativeFinalExecution(f.final, f.expected).tool_calls_json)
    const invalid = new AIMessage({ id: native.id, content: [
      { type: "reasoning", reasoning: "changed", signature: "native-signature" },
      { type: "text", text: "body" }
    ], response_metadata: { output_version: "v1" }, tool_calls: native.tool_calls })
    const invalidResult = await f.protect(invalid)
    expect(() => f.executions.bind(f.original, invalidResult)).toThrow()
  })
  it("derives final calls from an actual result and permits content-only protected candidates", async () => {
    const f = await fixture()
    expect(readFunctionNativeFinalExecution(f.final, f.expected).tool_calls_json)
      .toBe(JSON.stringify([{ id: "actual-call", name: "ActualTool", args: { final: true } }]))
    const changed = new AIMessage({ id: f.message.id, content: "Changed body",
      tool_calls: f.message.tool_calls, usage_metadata: f.message.usage_metadata,
      response_metadata: f.message.response_metadata })
    const safe = await f.protect(changed), receipt = f.executions.bind(f.original, safe)
    expect(readFunctionNativeFinalExecution(receipt, { ...f.expected,
      nativePayload: serializeFunctionConversationNativeMessage(safe.message) }).tool_calls_json)
      .toBe(readFunctionNativeFinalExecution(f.final, f.expected).tool_calls_json)
    expect(f.retained()).toBe(0)
  })

  it.each(["producer", "run", "occurrence", "branch", "uuid", "payload"])(
    "rejects a receipt borrowed by another actual %s", async kind => {
      const f = await fixture(), expected = { ...f.expected }
      if (kind === "producer") expected.producer = {}
      if (kind === "run") expected.run = {}
      if (kind === "occurrence") expected.occurrence = {}
      if (kind === "branch") expected.target = { ...expected.target, branchId: randomUUID() }
      if (kind === "uuid") expected.uuid = randomUUID()
      if (kind === "payload") expected.nativePayload += " "
      expect(() => readFunctionNativeFinalExecution(f.final, expected))
        .toThrow(expect.objectContaining({ code: "MODS_CONVERSATION_FINAL_EXECUTION_INVALID" }))
    }
  )

  it("rejects clone capabilities and changed actual calls without using public columns", async () => {
    const f = await fixture()
    expect(() => readFunctionNativeFinalExecution({ ...f.final }, f.expected)).toThrow()
    expect(() => f.executions.bind({ ...f.original }, f.result)).toThrow()
    const altered = new AIMessage({ id: f.message.id, content: "body",
      tool_calls: [{ id: "actual-call", name: "ActualTool", args: { fabricated: true }, type: "tool_call" }],
      usage_metadata: f.message.usage_metadata, response_metadata: f.message.response_metadata })
    expect(() => f.executions.bind(f.original, f.result)).not.toThrow()
    const safe = await f.protect(altered)
    expect(() => f.executions.bind(f.original, safe)).toThrow()
  })

  it("rechecks actual policy/source cancellation and safe-object mutation on every read", async () => {
    for (const kind of ["source", "signal", "mutation"] as const) {
      const f = await fixture()
      if (kind === "source") f.retired()
      if (kind === "signal") f.controller.abort()
      if (kind === "mutation") f.result.message.content = "late mutation"
      expect(() => readFunctionNativeFinalExecution(f.final, f.expected)).toThrow()
    }
  })

  it("rejects expectation accessors or proxies without executing a trap", async () => {
    const f = await fixture()
    let traps = 0
    const proxy = new Proxy(f.expected, { get() { traps++; throw Error("TRAP") } })
    expect(() => readFunctionNativeFinalExecution(f.final, proxy)).toThrow()
    const accessor = { ...f.expected }
    Object.defineProperty(accessor, "target", { get() { traps++; throw Error("GETTER") } })
    expect(() => readFunctionNativeFinalExecution(f.final, accessor)).toThrow()
    expect(traps).toBe(0)
  })
})
