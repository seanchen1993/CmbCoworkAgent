import { HumanMessage } from "@langchain/core/messages"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, getLocalThreadRunLease,
  releaseLocalThreadRunLease } from "./thread-run-lease"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { FunctionConversationStore } from "../db/function-conversation-store"
import type { FunctionSessionAppendOrigin } from "../../shared/mods/v2/session-append"
import { bindFunctionConversationNativeInput, captureFunctionConversationNativeInput,
  readFunctionConversationNativeInput,
  readInputTranscriptIntent,
  type FunctionConversationNativeInputCapture } from "./function-conversation-native-input"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-input-source-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

/** Source lifetime belongs to this real physical lease, independently of candidate authority. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(directory, "workspace-")))
  const workspace = process.platform === "win32" ? root.toLowerCase() : root
  const threadId = randomUUID(), physicalRunId = randomUUID()
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const acquired = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!acquired.acquired) throw Error("ACTUAL_INPUT_LEASE_REQUIRED")
  let checks = 0, action: (() => unknown) | undefined
  const guard = () => {
    checks++
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_INPUT_SOURCE_RETIRED")
    return action?.()
  }
  const source = (message = new HumanMessage({ id: randomUUID(), content: "original input" }),
    sourceOrigin: FunctionSessionAppendOrigin = { kind: "composer" }):
    FunctionConversationNativeInputCapture => ({ message, threadId, physicalRunId, workspace,
      signal: controller.signal, origin: sourceOrigin, assertCurrent: guard })
  const runtime = async () => {
    const manager = new ModsManager(join(root, `${randomUUID()}.sqlite`), () => [],
      async () => true, () => undefined, undefined,
      { ...DEFAULT_MOD_POLICY, required: false }, () => true)
    manager.configure(workspace, false, true)
    const physical: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
      signal: controller.signal, assertLive: guard }
    const instance = manager.createRuntimeAuthority(physical)
    const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
    const store = new FunctionConversationStore(database)
    const coordinator = new FunctionConversationCoordinator(store, {
      authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
      assertScope: context => {
        guard()
        if (context.workspace !== workspace || context.threadId !== threadId)
          throw Error("ACTUAL_INPUT_OWNER_CHANGED")
      },
      readCurrentCheckpoint: async (_thread, signal, current) => {
        signal.throwIfAborted(); current()
        return null
      },
      protect: async (_context, value, signal, current) => {
        signal.throwIfAborted(); current()
        return value
      },
      apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
    })
    manager.setFunctionConversations(coordinator)
    const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
      signal: controller.signal, readOnly: false, assertCurrent: guard })
    await coordinator.prepareRuntime(workspace, threadId)
    await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal,
      physicalRunId)
    const actual = manager.captureFunctionNativeConversationRuntime(instance.authority)
    if (!actual) throw Error("ACTUAL_INPUT_RUNTIME_REQUIRED")
    const policy = actual.capturePolicy()
    cleanups.push(() => {
      action = undefined
      actual.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
      manager.close()
    })
    return { manager, actual, policy }
  }
  cleanups.push(() => {
    action = undefined
    const current = getLocalThreadRunLease(threadId)
    if (current) releaseLocalThreadRunLease(threadId, current.owner, current.runId)
    rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, threadId, physicalRunId, database, controller, incarnation,
    source, runtime, checks: () => checks,
    action: (value: (() => unknown) | undefined) => { action = value } }
}

describe("actual user input private source", () => {
  it("pins the actual successful writer and original raw baseline in an opaque intent", () => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "actual user" })
    const write = { id: message.id!, role: "user" as const, content: "actual user",
      goal_id: "actual-goal", created_at: new Date(100) }
    expect(appDb.upsertThreadMessages(f.threadId, [write])).toBe(1)
    const receipt = captureFunctionConversationNativeInput({ ...f.source(message),
      transcript: { write, disposition: "persisted" } })
    const token = readFunctionConversationNativeInput(receipt).transcript
    if (!token) throw Error("ACTUAL_INTENT_REQUIRED")
    const view = readInputTranscriptIntent(token)
    expect(view.disposition).toBe("persisted")
    expect(view.baseline?.goal_id).toBe("actual-goal")
    expect(view.write).toEqual(write)
    expect(view.write.created_at).not.toBe(write.created_at)
    expect(() => readInputTranscriptIntent({ ...token })).toThrow()
    write.created_at.setTime(200)
    expect(() => view.assertCurrent()).toThrow()
  })
  it.each(["blank", "plumbing"] as const)("captures actual skipped %s without a UI row", mode => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "complete input" })
    const write = { id: message.id!, role: "user" as const, content: mode === "blank" ? "" : "plumbing",
      created_at: new Date(100) }
    const receipt = captureFunctionConversationNativeInput({ ...f.source(message),
      transcript: { write, disposition: mode } })
    const token = readFunctionConversationNativeInput(receipt).transcript
    if (!token) throw Error("ACTUAL_INTENT_REQUIRED")
    const view = readInputTranscriptIntent(token)
    expect(view.disposition).toBe(mode)
    expect(view.baseline).toBeUndefined()
    expect(Object.keys(view)).not.toContain("message")
    expect(message.content).toBe("complete input")
    expect(f.database.exec("SELECT * FROM thread_messages WHERE thread_id=?", [f.threadId])[0]
      .values).toHaveLength(0)
  })
  it("refuses an after-success intent whose original row is missing", () => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "user" })
    expect(() => captureFunctionConversationNativeInput({ ...f.source(message), transcript: {
      write: { id: message.id!, role: "user", content: "user", created_at: new Date() },
      disposition: "persisted" } })).toThrow()
  })
  it("refuses skipped intent with an actual ordinary row instead of treating it as hidden", () => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "user" })
    const write = { id: message.id!, role: "user" as const, content: "user", created_at: new Date() }
    appDb.upsertThreadMessages(f.threadId, [write])
    expect(() => captureFunctionConversationNativeInput({ ...f.source(message), transcript: {
      write, disposition: "blank" } })).toThrow()
  })
  it("checks copied write and original write on both sides of an original callback", () => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "user" })
    const write = { id: message.id!, role: "user" as const, content: "", created_at: new Date() }
    const receipt = captureFunctionConversationNativeInput({ ...f.source(message), transcript: {
      write, disposition: "blank" } })
    const token = readFunctionConversationNativeInput(receipt).transcript
    if (!token) throw Error("ACTUAL_INTENT_REQUIRED")
    const view = readInputTranscriptIntent(token)
    f.action(() => { view.write.content = "changed copy" })
    expect(() => view.assertCurrent()).toThrow()
    f.action(undefined)
    const next = readInputTranscriptIntent(token)
    expect(next.write.content).toBe("")
    f.action(() => { write.content = "changed original" })
    expect(() => next.assertCurrent()).toThrow()
  })
  it("keeps original qualification separate from the adopter's later actual raw verification", () => {
    const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "user" })
    const write = { id: message.id!, role: "user" as const, content: "user", created_at: new Date() }
    appDb.upsertThreadMessages(f.threadId, [write])
    const receipt = captureFunctionConversationNativeInput({ ...f.source(message), transcript: {
      write, disposition: "persisted" } })
    const token = readFunctionConversationNativeInput(receipt).transcript
    if (!token) throw Error("ACTUAL_INTENT_REQUIRED")
    f.database.run("UPDATE thread_messages SET content_json=? WHERE thread_id=? AND message_id=?",
      [JSON.stringify("safe adopted body"), f.threadId, write.id])
    expect(readInputTranscriptIntent(token).baseline?.content_json).toBe(JSON.stringify("user"))
    expect(readInputTranscriptIntent(token).disposition).toBe("persisted")
  })
  it("captures the actual Human address and preserves full input separately from visible text", () => {
    const f = fixture()
    const message = new HumanMessage({ id: randomUUID(), content: "visible plus private context",
      additional_kwargs: { cmb_visible_user_message: "visible" } })
    const input = { ...f.source(message), visible: "visible" }
    const receipt = captureFunctionConversationNativeInput(input)
    const view = readFunctionConversationNativeInput(receipt)
    expect(view.message).toBe(message)
    expect(view.uuid).toBe(message.id)
    expect(view.physicalRunId).toBe(f.physicalRunId)
    expect(view.visible).toBe("visible")
    expect(message.content).toBe("visible plus private context")
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.origin)).toBe(true)
    expect(Object.keys(view)).not.toContain("saved")
    expect(Object.keys(view)).not.toContain("retain")
    expect(Object.keys(view)).not.toContain("ack")
    expect(f.checks()).toBe(2)
  })

  it("does not let cloned receipts or a message UUID mint a source", () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    expect(() => readFunctionConversationNativeInput({ ...receipt })).toThrow()
    expect(() => readFunctionConversationNativeInput(new Proxy(receipt, {}))).toThrow()
    expect(() => readFunctionConversationNativeInput(Object.create(null))).toThrow()
  })

  it("requires a real original UUID before any source callback", () => {
    const f = fixture()
    expect(() => captureFunctionConversationNativeInput(f.source(new HumanMessage("no id"))))
      .toThrow("MODS_NATIVE_CAPTURE_INVALID")
    expect(f.checks()).toBe(0)
  })

  it("keeps only descriptor-safe origin data and rechecks the original origin", () => {
    const f = fixture(), original: FunctionSessionAppendOrigin = {
      kind: "plugin", name: "original-plugin", asUser: true }
    const receipt = captureFunctionConversationNativeInput(f.source(undefined, original))
    expect(readFunctionConversationNativeInput(receipt).origin).toEqual(original)
    original.name = "replacement-plugin"
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
  })

  it.each(["content", "type", "toJSON", "proxy", "subclass"] as const)(
    "rejects raw %s before evaluating provider or host behavior", kind => {
      const f = fixture(), actual = new HumanMessage({ id: randomUUID(), content: "original" })
      let behavior = 0, input = actual
      if (kind === "content" || kind === "type") Object.defineProperty(actual, kind, {
        enumerable: true, configurable: true, get: () => { behavior++; return "human" } })
      else if (kind === "toJSON") Object.defineProperty(actual, "toJSON", {
        enumerable: true, value: () => { behavior++; return {} } })
      else if (kind === "proxy") input = new Proxy(actual, {
        getPrototypeOf: () => { behavior++; return HumanMessage.prototype },
        get: (target, property) => { behavior++; return Reflect.get(target, property) } })
      else {
        class ForeignHuman extends HumanMessage {}
        input = new ForeignHuman({ id: randomUUID(), content: "foreign" })
      }
      expect(() => captureFunctionConversationNativeInput(f.source(input))).toThrow()
      expect(behavior).toBe(0)
      expect(f.checks()).toBe(0)
    })

  it.each(["getter", "proxy", "toJSON"] as const)(
    "rejects foreign origin %s with zero behavior", kind => {
      const f = fixture()
      let behavior = 0
      let original: FunctionSessionAppendOrigin = { kind: "composer" }
      if (kind === "getter") Object.defineProperty(original, "kind", {
        enumerable: true, get: () => { behavior++; return "composer" } })
      else if (kind === "proxy") original = new Proxy(original, {
        ownKeys: () => { behavior++; return ["kind"] },
        getPrototypeOf: () => { behavior++; return Object.prototype } })
      else Object.defineProperty(original, "toJSON", {
        enumerable: true, value: () => { behavior++; return { kind: "composer" } } })
      expect(() => captureFunctionConversationNativeInput(f.source(undefined, original))).toThrow()
      expect(behavior).toBe(0)
      expect(f.checks()).toBe(0)
    })

  it.each(["function_row", "function_row_invalid"] as const)(
    "rejects an incoming %s instead of deriving authority from public data", field => {
      const f = fixture(), message = new HumanMessage({ id: randomUUID(), content: "original",
        additional_kwargs: { [field]: true } })
      expect(() => captureFunctionConversationNativeInput(f.source(message))).toThrow()
      expect(f.checks()).toBe(0)
    })

  it("publishes no source when a caught synchronous recapture invalidates the outer capture", () => {
    const f = fixture(), input = f.source()
    let reentries = 0
    f.action(() => {
      reentries++
      expect(() => captureFunctionConversationNativeInput(input))
        .toThrow("MODS_CONVERSATION_NATIVE_INPUT_CAPTURE_ONCE")
    })
    expect(() => captureFunctionConversationNativeInput(input)).toThrow()
    expect(reentries).toBe(1)
    f.action(undefined)
    expect(() => captureFunctionConversationNativeInput(input))
      .toThrow("MODS_CONVERSATION_NATIVE_INPUT_CAPTURE_ONCE")
  })

  it("does not execute a guard call getter and preserves the original synchronous error", () => {
    const f = fixture(), input = f.source(), error = Error("ORIGINAL_TRANSPORT_RETIRED")
    let callReads = 0
    Object.defineProperty(input.assertCurrent, "call", {
      get: () => { callReads++; throw Error("FOREIGN_CALL") } })
    f.action(() => { throw error })
    let observed: unknown
    try { captureFunctionConversationNativeInput(input) } catch (caught) { observed = caught }
    expect(observed).toBe(error)
    expect(callReads).toBe(0)
  })

  it.each(["promise", "thenable"] as const)("rejects asynchronous guard %s without adoption", kind => {
    const f = fixture()
    let thenReads = 0
    const result = kind === "promise" ? Promise.resolve() : Object.defineProperty({}, "then", {
      get: () => { thenReads++; throw Error("FOREIGN_THEN") } })
    f.action(() => result)
    expect(() => captureFunctionConversationNativeInput(f.source()))
      .toThrow("MODS_CONVERSATION_NATIVE_INPUT_GUARD_ASYNC")
    expect(thenReads).toBe(0)
  })

  it("rechecks raw mutation after the original source callback", () => {
    const f = fixture(), input = f.source()
    f.action(() => { input.message.content = "changed inside source callback" })
    expect(() => captureFunctionConversationNativeInput(input)).toThrow()
  })

  it("rejects read after raw metadata mutation even with the same UUID and content", () => {
    const f = fixture(), input = f.source(), receipt = captureFunctionConversationNativeInput(input)
    input.message.response_metadata.changed = true
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
  })

  it("provides a callback-free complete data tail without borrowing source authority", () => {
    const f = fixture(), input = f.source(), receipt = captureFunctionConversationNativeInput(input)
    const source = readFunctionConversationNativeInput(receipt), checks = f.checks()
    source.assertDataCurrent()
    expect(f.checks()).toBe(checks)
    input.message.response_metadata.changed = true
    expect(() => source.assertDataCurrent()).toThrow()
    expect(f.checks()).toBe(checks)
  })

  it.each(["media", "binary", "truncated", "ignored"] as const)(
    "keeps full raw mutation detection for lossy %s input", kind => {
      const f = fixture(), bytes = new Uint8Array([1, 2])
      const item = { type: "image_url", url: "original", truncated: false,
        constructor: "original", output: "original" }
      const value: unknown = kind === "binary" ? bytes : kind === "media"
        ? { type: item.type, url: item.url } : kind === "truncated"
          ? { truncated: true, output: item.output } : { constructor: item.constructor }
      const message = new HumanMessage({ id: randomUUID(), content: "original input",
        response_metadata: { value } })
      const receipt = captureFunctionConversationNativeInput(f.source(message))
      const source = readFunctionConversationNativeInput(receipt), checks = f.checks()
      if (kind === "binary") bytes[0] = 9
      else if (value && typeof value === "object") Object.defineProperty(value,
        kind === "media" ? "url" : kind === "truncated" ? "output" : "constructor",
        { value: "changed", enumerable: true, configurable: true, writable: true })
      expect(() => source.assertDataCurrent()).toThrow()
      expect(f.checks()).toBe(checks)
    })

  it("rejects an accessor installed by the actual source callback without invoking it", () => {
    const f = fixture(), input = f.source(), receipt = captureFunctionConversationNativeInput(input)
    let behavior = 0
    f.action(() => { Object.defineProperty(input.message.response_metadata, "changed", {
      enumerable: true, get: () => { behavior++; return true } }) })
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
    expect(behavior).toBe(0)
  })

  it("rejects physical lease ABA despite identical copied owner/run/time fields", () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const lease = getLocalThreadRunLease(f.threadId)
    if (!lease) throw Error("ACTUAL_INPUT_LEASE_REQUIRED")
    expect(releaseLocalThreadRunLease(f.threadId, lease.owner, lease.runId)).toBe(true)
    expect(claimLocalThreadRunLease(lease).acquired).toBe(true)
    expect(getLocalThreadRunLease(f.threadId)).toEqual(lease)
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
  })

  it("rejects a new actual thread incarnation at the same persisted thread ID", () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    appDb.deleteThread(f.threadId)
    const replacement = appDb.createThread(f.threadId, { workspacePath: f.workspace })
    expect(matchesThreadIncarnation(replacement, f.incarnation)).toBe(false)
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
  })

  it("rechecks the actual workspace directory instead of trusting unchanged IDs", () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const other = fixture()
    appDb.updateThread(f.threadId, { metadata: JSON.stringify({ workspacePath: other.workspace }) })
    expect(() => readFunctionConversationNativeInput(receipt)).toThrow()
  })

  it("propagates actual physical cancellation before the original callback", () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const before = f.checks(), reason = Error("ACTUAL_INPUT_CANCELLED")
    f.controller.abort(reason)
    let observed: unknown
    try { readFunctionConversationNativeInput(receipt) } catch (caught) { observed = caught }
    expect(observed).toBe(reason)
    expect(f.checks()).toBe(before)
  })

  it("binds only the actual Manager runtime and private policy admission", async () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const value = await f.runtime()
    const binding = bindFunctionConversationNativeInput(receipt, value.actual, value.policy)
    expect(binding.runtime).toBe(value.actual)
    expect(binding.message).toBe(readFunctionConversationNativeInput(receipt).message)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(() => bindFunctionConversationNativeInput(receipt,
      Object.freeze({ ...value.actual }), value.policy)).toThrow()
    expect(() => bindFunctionConversationNativeInput(receipt, value.actual,
      Object.freeze({ ...value.policy }))).toThrow()
    value.actual.close()
    expect(() => binding.assertCurrent()).toThrow()
    // Closing a candidate is not physical source retirement or a saved/handoff certificate.
    expect(readFunctionConversationNativeInput(receipt).physicalRunId).toBe(f.physicalRunId)
  })

  it("rejects a genuine foreign runtime even when its policy is privately certified", async () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const other = fixture(), value = await other.runtime()
    expect(() => bindFunctionConversationNativeInput(receipt, value.actual, value.policy)).toThrow()
  })

  it("checks the actual policy epoch and runtime maps on every bound read", async () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const value = await f.runtime()
    const binding = bindFunctionConversationNativeInput(receipt, value.actual, value.policy)
    value.manager.configure(f.workspace, true, true)
    expect(() => binding.assertCurrent()).toThrow()
    expect(readFunctionConversationNativeInput(receipt).uuid).toBe(binding.uuid)
  })

  it("keeps the original physical source independent of a closed candidate during new binding", async () => {
    const f = fixture(), receipt = captureFunctionConversationNativeInput(f.source())
    const first = await f.runtime()
    const old = bindFunctionConversationNativeInput(receipt, first.actual, first.policy)
    first.actual.close()
    const next = await f.runtime()
    const fresh = bindFunctionConversationNativeInput(receipt, next.actual, next.policy)
    expect(() => old.assertCurrent()).toThrow()
    fresh.assertCurrent()
    expect(fresh.message).toBe(old.message)
    expect(fresh.physicalRunId).toBe(old.physicalRunId)
    expect(Object.keys(fresh)).not.toContain("saved")
    expect(Object.keys(fresh)).not.toContain("handoff")
  })
})
