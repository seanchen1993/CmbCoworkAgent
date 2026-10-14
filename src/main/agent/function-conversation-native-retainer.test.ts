import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../shared/mods/types"
import { assertModJson } from "../../shared/mods/validation"
import type { FunctionSessionAppendResult } from "../../shared/mods/v2/session-append"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { FunctionConversationRegistry } from "../mods/v2/conversation-registry"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import {
  FunctionConversationNativeRetainer,
  type FunctionNativeRetentionHost,
  type FunctionNativeRetainerOptions
} from "./function-conversation-native-retainer"
import {
  deserializeFunctionConversationNativeMessage,
  serializeFunctionConversationNativeMessage
} from "./function-conversation-native-message"
import { FunctionConversationNativeRendering } from "./function-conversation-native-rendering"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../storage", () => ({ getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as threadDb from "../db"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-retainer-"))
  state.path = join(directory, "app.sqlite")
  await threadDb.initializeDatabase()
})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

interface FixtureOptions {
  message?: BaseMessage
  protect?: FunctionNativeRetentionHost["protectNative"]
  dispatch?: FunctionNativeRetentionHost["dispatch"]
  apply?: FunctionNativeRetentionHost["apply"]
  project?: FunctionNativeRetentionHost["project"]
  prepareGate?: Promise<void>
  commitAfter?: () => void
  capture?: (owner: object) => object | Promise<object>
}

function fixture(options: FixtureOptions = {}) {
  const message = options.message ?? new AIMessage({ id: randomUUID(), content: "Original body",
    response_metadata: { provider: "native-provider", stop: "stop" },
    usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    additional_kwargs: { originalNative: true } })
  const threadId = `native-retainer:${randomUUID()}`, thread = threadDb.createThread(threadId)
  const db = threadDb.getDb(), store = new FunctionConversationStore(db)
  const authorities = new ModRuntimeAuthorities(), registry = new FunctionConversationRegistry(
    store, authorities)
  const owner = {}, projectionOwner = {}, producer = {}, controller = new AbortController()
  const targetController = new AbortController()
  let live = true
  const guard = () => { if (!live) throw new ModFunctionError("TEST_SOURCE_EXPIRED") }
  const ref = store.ensureMain({ threadId, workspace: "C:/native-retainer-workspace",
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, guard)
  const target = registry.registerMain(owner, { identity: {}, ref,
    checkpointThreadId: ref.threadId, signal: targetController.signal, assertCurrent: guard })
  // A presentation bit is independent of the actual ToolMessage execution status.
  const errorPresentation = new WeakMap<BaseMessage, boolean>()
  const project = (native: BaseMessage): ModObject => {
    let content: ModJson[]
    if (typeof native.content === "string") content = [{ type: "text", text: native.content }]
    else {
      const actual: unknown = native.content
      assertModJson(actual)
      if (!Array.isArray(actual)) throw new ModFunctionError("TEST_RENDERING_INVALID")
      content = actual
    }
    if (ToolMessage.isInstance(native)) return { type: "user", role: "user",
      content: [{ type: "tool_result", tool_use_id: native.tool_call_id, content,
        is_error: errorPresentation.get(native) ?? native.status === "error" }] }
    return { type: native.getType() === "ai" ? "assistant" : "user",
      role: native.getType() === "ai" ? "assistant" : "user", content }
  }
  const apply = (native: BaseMessage, rendering: ModObject): BaseMessage => {
    const changed = deserializeFunctionConversationNativeMessage(
      serializeFunctionConversationNativeMessage(native))
    if (ToolMessage.isInstance(changed)) {
      const blocks = rendering.content
      if (!Array.isArray(blocks) || blocks.length !== 1 || !blocks[0] ||
        typeof blocks[0] !== "object" || Array.isArray(blocks[0]))
        throw new ModFunctionError("TEST_RENDERING_INVALID")
      const block = blocks[0]
      changed.content = block.content as BaseMessage["content"]
      errorPresentation.set(changed, block.is_error === true)
    } else changed.content = rendering.content as BaseMessage["content"]
    return changed
  }
  const capture = vi.fn(() => options.capture?.(projectionOwner) ?? projectionOwner)
  // No policy is enabled in this foundation fixture. It does not simulate a full native policy.
  const protect = vi.fn<FunctionNativeRetentionHost["protectNative"]>(
    options.protect ?? (async (native, signal, assertCurrent) => {
      signal.throwIfAborted(); assertCurrent(); return native
    }))
  const dispatch = vi.fn<FunctionNativeRetentionHost["dispatch"]>(
    options.dispatch ?? (ticket => ticket.core(ticket.input)))
  const writer = vi.fn(), commits = vi.fn()
  const prepare = vi.fn<FunctionNativeRetentionHost["prepare"]>(async (candidate, signal, check) => {
    if (options.prepareGate) await options.prepareGate
    signal.throwIfAborted(); check()
    expect(candidate.target).toBe(target)
    expect(candidate.producer).toBe(producer)
    expect(candidate.projectionOwner).toBe(projectionOwner)
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({
      id: row.uuid, role: ToolMessage.isInstance(candidate.native) ? "tool"
        : candidate.native.getType() === "ai" ? "assistant" : "user",
      content: JSON.stringify(row.message.content), created_at: new Date(row.createdAt),
      ...(ToolMessage.isInstance(candidate.native)
        ? { tool_call_id: candidate.native.tool_call_id } : {})
    }), undefined, ToolMessage.isInstance(candidate.native) ? candidate.native : undefined)
    return {
      commit(assertCurrent) {
        commits()
        const row = store.commit(ref, { uuid: candidate.uuid, inputDigest: candidate.inputDigest,
          door: candidate.door, origin: candidate.origin, message: candidate.rendering,
          nativePayload: candidate.nativePayload, orderAnchor: { actualProducer: "native-test" },
          inbox: false, sdk: false }, assertCurrent, (database, actual, row) => {
            writer(); access.write(database, actual, row)
          }, access.verify)
        options.commitAfter?.()
        return row
      },
      read() {
        const row = store.readReceipt(ref, candidate.uuid)
        if (row) access.verify(db, ref, row)
        return row
      }
    }
  })
  const input: FunctionNativeRetainerOptions = { message, target, producer,
    signal: controller.signal, door: ToolMessage.isInstance(message) ? "tool-result"
      : message.getType() === "ai" ? "response" : "prompt",
    origin: ToolMessage.isInstance(message) ? { kind: "tool", tool: "ActualTool" }
      : message.getType() === "ai" ? { kind: "model", model: "ActualModel" }
        : { kind: "composer" },
    assertCurrent: () => { target.assertCurrent(); guard() },
    host: { captureProjection: capture, protectNative: protect,
      project: options.project ?? project, apply: options.apply ?? apply, dispatch, prepare } }
  const retainer = new FunctionConversationNativeRetainer(input)
  cleanups.push(() => { registry.close(); authorities.close() })
  return { message, input, retainer, store, ref, target, capture, protect, dispatch, prepare,
    writer, commits, controller, targetController,
    expire: () => { live = false }, assertSourceCurrent: guard,
    rows: () => threadDb.getThreadMessages(threadId) }
}

describe("native retention foundation with actual SQLite keeper and transcript", () => {
  it.each(["live", "cancel", "revoke"])("services pending I/O between native phases: %s", async mode => {
    let serviced = false
    let scheduled = false
    const f = fixture({ protect: async native => {
      if (!scheduled) {
        scheduled = true
        setImmediate(() => {
          serviced = true
          if (mode === "cancel") f.controller.abort(Error("FAIRNESS_CANCEL"))
          if (mode === "revoke") f.expire()
        })
        const end = performance.now() + 12
        while (performance.now() < end) { /* A bounded synchronous host phase. */ }
      }
      return native
    }, dispatch: ticket => {
      expect(serviced).toBe(true)
      return ticket.core(ticket.input)
    } })
    const pending = f.retainer.retain()
    expect(f.retainer.retain()).toBe(pending)
    if (mode === "live") {
      await pending
      expect(f.commits).toHaveBeenCalledTimes(1)
    } else {
      await expect(pending).rejects.toThrow(mode === "cancel" ? "FAIRNESS_CANCEL" : "TEST_SOURCE_EXPIRED")
      expect(f.commits).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  })
  it("retains an exact v1 content-only rewrite through its actual ticket and complete SQLite payload", async () => {
    const rendering = new FunctionConversationNativeRendering()
    const original = new AIMessage({ id: randomUUID(), content: [
      { type: "text", text: "old v1 body" },
      { type: "reasoning", reasoning: "fixed", signature: "native-signature" }
    ], response_metadata: { output_version: "v1" },
    tool_calls: [{ id: "call", name: "ActualTool", args: { actual: true }, type: "tool_call" }] })
    const f = fixture({ message: original, project: message => rendering.project(message),
      apply: (message, input) => rendering.apply(message, input),
      dispatch: ticket => ticket.core({ ...ticket.input, message: { ...ticket.input.message,
        content: ticket.input.message.content.map(block => block.type === "text"
          ? { type: "text", text: "new actual v1 body" } : block) } }) })
    const saved = await f.retainer.retain()
    expect(saved.message.content).toContainEqual({ type: "text", text: "new actual v1 body" })
    expect(saved.message.content).toContainEqual({ type: "reasoning",
      reasoning: "fixed", signature: "native-signature" })
    expect(AIMessage.isInstance(saved.message) && saved.message.tool_calls).toEqual(original.tool_calls)
    expect(serializeFunctionConversationNativeMessage(saved.message)).toBe(saved.row.nativePayload)
    expect(f.commits).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
  })
  it("seals synchronously, shares one admission, and retains the actual AI class and metadata", async () => {
    let observed: Promise<unknown> | undefined
    const f = fixture({ dispatch: async ticket => {
      const changed = { ...ticket.input, message: { ...ticket.input.message,
        content: [{ type: "text", text: "Hook body" }] } }
      const first = ticket.core(changed)
      expect(ticket.core(ticket.input)).toBe(first)
      return first
    }, capture: owner => { observed = f.retainer.retain(); return owner } })
    const once = f.retainer.retain()
    expect(observed).toBe(once)
    expect(f.capture).toHaveBeenCalledTimes(1)
    expect(f.retainer.retain()).toBe(once)
    const result = await once
    expect(AIMessage.isInstance(result.message)).toBe(true)
    expect(result.message.content).toEqual([{ type: "text", text: "Hook body" }])
    expect(result.message.response_metadata).toEqual(f.message.response_metadata)
    expect((result.message as AIMessage).usage_metadata).toEqual((f.message as AIMessage).usage_metadata)
    expect(result.message.additional_kwargs.originalNative).toBe(true)
    expect(result.publicAvailability).toBe("bounded")
    expect(f.commits).toHaveBeenCalledTimes(1)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
    expect(f.store.readReceipt(f.ref, f.message.id!)).toEqual(result.row)
  })

  it.each(["success", "error"] as const)("keeps actual tool %s facts while changing error presentation", async status => {
    const original = new ToolMessage({ id: randomUUID(), tool_call_id: "actual-call", status,
      content: "Original tool body", artifact: { actualExecution: [1, 2, 3] },
      metadata: { providerFact: "fixed" } })
    const f = fixture({ message: original, dispatch: ticket => ticket.core({ ...ticket.input,
      message: { ...ticket.input.message, content: [{ type: "tool_result",
        tool_use_id: "actual-call", is_error: status !== "error", content: "Hook tool body" }] } }) })
    const result = await f.retainer.retain()
    expect(ToolMessage.isInstance(result.message)).toBe(true)
    const tool = result.message as ToolMessage
    expect(tool.tool_call_id).toBe("actual-call")
    expect(tool.status).toBe(status)
    expect(tool.artifact).toEqual(original.artifact)
    expect(tool.metadata).toEqual(original.metadata)
    expect(tool.content).toBe("Hook tool body")
    expect(result.row.message.content).toEqual([{ type: "tool_result", tool_use_id: "actual-call",
      is_error: status !== "error", content: [{ type: "text", text: "Hook tool body" }] }])
    expect(f.rows()[0].role).toBe("tool")
    expect(f.rows()[0].tool_call_id).toBe("actual-call")
    expect(f.commits).toHaveBeenCalledTimes(1)
  })

  it("rejects a native adapter that changes tool execution status, before any write", async () => {
    const original = new ToolMessage({ id: randomUUID(), tool_call_id: "actual-call",
      status: "error", content: "Failed", artifact: { retained: true } })
    const f = fixture({ message: original, apply: native => new ToolMessage({
      id: native.id, tool_call_id: "actual-call", status: "success", content: "changed",
      artifact: { retained: true } }) })
    const once = f.retainer.retain()
    await expect(once).rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED" })
    expect(f.retainer.retain()).toBe(once)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it.each(["deny", "fake-success"] as const)("does not mistake native %s for persistence", async mode => {
    const f = fixture({ dispatch: async (ticket): Promise<FunctionSessionAppendResult> => {
      if (mode === "deny") return { deny: "No" }
      return { uuid: ticket.input.uuid, message: ticket.input.message }
    } })
    const result = await f.retainer.retain()
    expect(result.row.uuid).toBe(f.message.id)
    expect(f.commits).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
  })

  it("retains complete oversized native data through the real core without entering a public Hook", async () => {
    const text = "中".repeat(400000)
    const original = new AIMessage({ id: randomUUID(), content: text,
      response_metadata: { provider: "actual" },
      tool_calls: [{ id: "call-1", name: "RealTool", args: { value: "preserved" }, type: "tool_call" }] })
    const f = fixture({ message: original })
    const result = await f.retainer.retain()
    expect(result.publicAvailability).toBe("limit")
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.protect).toHaveBeenCalledTimes(1)
    expect(f.protect.mock.calls[0][0]).toBe(original)
    expect(result.message.content).toBe(text)
    expect((result.message as AIMessage).tool_calls).toEqual(original.tool_calls)
    expect(Buffer.byteLength(result.row.nativePayload)).toBeGreaterThan(1024 * 1024)
    expect(f.store.readReceipt(f.ref, original.id!)).toEqual(result.row)
    expect(f.rows()).toHaveLength(1)
  })

  it("rejects native source mutation across the real protector await", async () => {
    const held = deferred<BaseMessage>()
    const f = fixture({ protect: () => held.promise })
    const once = f.retainer.retain()
    await Promise.resolve()
    f.message.content = "Later different occurrence"
    held.resolve(f.message)
    await expect(once).rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_MESSAGE_CHANGED" })
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.commits).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("rejects a revoked source after prepare and preserves the same failed once admission", async () => {
    const held = deferred<void>()
    const f = fixture({ prepareGate: held.promise })
    const once = f.retainer.retain()
    for (let index = 0; index < 5; index++) await Promise.resolve()
    f.expire(); held.resolve()
    await expect(once).rejects.toMatchObject({ code: "TEST_SOURCE_EXPIRED" })
    expect(f.retainer.retain()).toBe(once)
    expect(f.commits).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("rejects a recreated target across protection while the source and signals stay live", async () => {
    const entered = deferred<void>(), held = deferred<BaseMessage>()
    const protectionSignals: AbortSignal[] = []
    const f = fixture({ protect: async (_message, signal, current) => {
      signal.throwIfAborted()
      current()
      protectionSignals.push(signal)
      entered.resolve()
      return held.promise
    } })
    const once = f.retainer.retain()
    const rejected = expect(once).rejects.toMatchObject({
      code: "MODS_CONVERSATION_THREAD_CHANGED"
    })
    try {
      await entered.promise
      const db = threadDb.getDb()
      db.run("DELETE FROM threads WHERE thread_id = ?", [f.ref.threadId])
      threadDb.createThread(f.ref.threadId)
      db.run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
        f.ref.incarnation.legacyCreatedAt, f.ref.threadId
      ])
      const replacement = threadDb.getThreadCore(f.ref.threadId)
      if (!replacement) throw Error("Actual replacement thread is missing")
      expect(replacement.created_at).toBe(f.ref.incarnation.legacyCreatedAt)
      expect(captureThreadIncarnation(replacement).token).not.toBe(f.ref.incarnation.token)
      expect(f.assertSourceCurrent).not.toThrow()
      expect(f.controller.signal.aborted).toBe(false)
      expect(f.targetController.signal.aborted).toBe(false)
      expect(f.target.signal.aborted).toBe(false)
      expect(protectionSignals).toHaveLength(1)
      expect(protectionSignals[0].aborted).toBe(false)
      held.resolve(f.message)
      await rejected
      expect(f.retainer.retain()).toBe(once)
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.commits).not.toHaveBeenCalled()
      expect(f.writer).not.toHaveBeenCalled()
      expect(f.rows()).toEqual([])
      expect(db.exec(`SELECT COUNT(*) FROM function_conversation_rows
        WHERE conversation_id = ? AND uuid = ?`, [f.ref.conversationId, f.message.id!])[0].values)
        .toEqual([[0]])
    } finally {
      held.resolve(f.message)
      await Promise.allSettled([once, rejected])
    }
  })

  it("keeps the real committed row when its original source expires before the ACK", async () => {
    const f = fixture({ commitAfter: () => f.expire() })
    const once = f.retainer.retain()
    await expect(once).rejects.toMatchObject({ code: "TEST_SOURCE_EXPIRED" })
    expect(f.retainer.retain()).toBe(once)
    expect(f.commits).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
    expect(f.store.readReceipt(f.ref, f.message.id!)).toBeDefined()
  })

  it("keeps dispatch failure and never invents a fallback commit for an incomplete host chain", async () => {
    const f = fixture({ dispatch: async () => { throw new ModFunctionError("TEST_MANDATORY_FAILURE") } })
    await expect(f.retainer.retain()).rejects.toMatchObject({ code: "TEST_MANDATORY_FAILURE" })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.commits).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("rejects fixed native rendering identity instead of classifying it as unavailable", async () => {
    const f = fixture({ message: new HumanMessage({ id: randomUUID(), content: "Actual input" }),
      project: () => ({ type: "assistant", role: "assistant", content: [] }) })
    await expect(f.retainer.retain()).rejects.toMatchObject({ code: "MODS_CONVERSATION_NATIVE_IDENTITY_CHANGED" })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })
})
