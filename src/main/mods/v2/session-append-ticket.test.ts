import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { FunctionSessionAppendInput } from "../../../shared/mods/v2/session-append"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { functionConversationNoteMessage } from "../../agent/mods-conversation"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionConversationRegistry } from "./conversation-registry"
import {
  FunctionSessionAppendTicket,
  type FunctionSessionAppendCommitPlan,
  type FunctionSessionAppendTicketOptions
} from "./session-append-ticket"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as threadDb from "../../db"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-append-ticket-"))
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
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

function textInput(input: FunctionSessionAppendInput, text: string): FunctionSessionAppendInput {
  return { ...input, message: { ...input.message, content: [{ type: "text", text }] } }
}

interface FixtureOptions {
  kind?: "sdk" | "native"
  messageType?: "user" | "system"
  protect?: FunctionSessionAppendTicketOptions["protect"]
  preparing?: () => Promise<void>
  plan?: (plan: FunctionSessionAppendCommitPlan) => FunctionSessionAppendCommitPlan
  writer?: () => void
}

function fixture(options: FixtureOptions = {}) {
  const kind = options.kind ?? "sdk"
  const messageType = options.messageType ?? "user"
  const threadId = `append-ticket:${randomUUID()}`
  const thread = threadDb.createThread(threadId)
  const db = threadDb.getDb(), store = new FunctionConversationStore(db)
  const authorities = new ModRuntimeAuthorities()
  const registry = new FunctionConversationRegistry(store, authorities)
  const owner = {}, controller = new AbortController(), targetController = new AbortController()
  const sourceController = new AbortController()
  let targetLive = true, sourceLive = true, hostLive = true
  const ref = store.ensureMain({ threadId, workspace: "C:/ticket-workspace",
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, () => undefined)
  const targetSourceCurrent = vi.fn(() => {
    if (!targetLive) throw new ModFunctionError("TEST_TARGET_EXPIRED")
  })
  const target = registry.registerMain(owner, { identity: {}, ref, checkpointThreadId: ref.threadId,
    signal: targetController.signal, assertCurrent: targetSourceCurrent })
  const input: FunctionSessionAppendInput = { uuid: randomUUID(),
    door: kind === "sdk" ? "note" : "prompt",
    origin: kind === "sdk" ? { kind: "plugin", name: "P" } : { kind: "composer" },
    message: { type: messageType, ...(messageType === "user" ? {
      role: "user", ...(kind === "sdk" ? { isMeta: true } : {})
    } : {}),
      content: [{ type: "text", text: "Original note" }] } }
  const writer = vi.fn(() => options.writer?.())
  const prepare = vi.fn<FunctionSessionAppendTicketOptions["prepare"]>(async (safe, _signal, guard) => {
    if (options.preparing) await options.preparing()
    guard()
    const nativePayload = JSON.stringify({ actualNative: true, uuid: safe.uuid,
      metadata: { artifact: "preserved" }, content: safe.message.content })
    const plan: FunctionSessionAppendCommitPlan = {
      commit: (check) => store.commit(ref, {
        uuid: safe.uuid, inputDigest: ticket.inputDigest, door: safe.door,
        origin: safe.origin, message: safe.message, nativePayload,
        orderAnchor: { request: "actual-request", toolBatch: "actual-batch" },
        inbox: kind === "sdk" && safe.message.type === "user", sdk: kind === "sdk"
      }, check, (database, actual, row) => {
        expect(database).toBe(db)
        expect(database.inTransaction).toBe(true)
        expect(actual).toBe(ref)
        writer()
        const stored = JSON.parse(row.nativePayload) as { content: unknown }
        expect(stored.content).toEqual(safe.message.content)
        threadDb.upsertThreadMessagesInTransaction(threadId, [{ id: row.uuid,
          role: safe.message.role ?? "system", content: JSON.stringify(safe.message.content),
          created_at: new Date(row.createdAt) }],
        { preserveExistingOrder: true })
      }, (database, actual, row) => {
        expect(database).toBe(db)
        expect(actual).toBe(ref)
        const canonical = threadDb.getThreadMessagesByIds(threadId, [row.uuid])[0]
        if (!canonical || canonical.role !== (safe.message.role ?? "system") ||
          canonical.content !== JSON.stringify(safe.message.content))
          throw new ModFunctionError("MODS_SESSION_APPEND_NOT_COMMITTED")
        expect(JSON.parse(row.nativePayload)).toEqual(JSON.parse(nativePayload))
        expect(row.origin).toEqual(safe.origin)
      }),
      read: () => {
        const receipt = store.readReceipt(ref, safe.uuid)
        const canonical = threadDb.getThreadMessages(threadId).find((row) => row.id === safe.uuid)
        return receipt && canonical && canonical.role === (safe.message.role ?? "system") &&
          canonical.content === JSON.stringify(safe.message.content) ? receipt : undefined
      }
    }
    return options.plan ? options.plan(plan) : plan
  })
  const assertHostPermission = () => {
    if (!hostLive) throw new ModFunctionError("TEST_HOST_CHANGED")
  }
  const hostCurrent = vi.fn(() => {
    if (kind === "native") target.assertCurrent()
    assertHostPermission()
  })
  const ticket = new FunctionSessionAppendTicket({ kind, input, target,
    ...(kind === "sdk" ? { source: { owner, plugin: {}, registration: {},
      signal: sourceController.signal, assertCurrent: () => {
        if (!sourceLive) throw new ModFunctionError("TEST_SOURCE_EXPIRED")
      } } } : {}), signal: controller.signal,
    assertCurrent: hostCurrent,
    protect: options.protect ?? (async (value) => value), prepare })
  cleanups.push(() => { registry.close(); authorities.close() })
  return { ticket, input, store, ref, registry, target, threadId, writer, prepare,
    targetSourceCurrent, hostCurrent, assertHostPermission,
    controller, sourceController, targetController,
    expireSource: () => { sourceLive = false }, expireTarget: () => { targetLive = false },
    changeHost: () => { hostLive = false },
    rows: () => threadDb.getThreadMessages(threadId) }
}

describe("FunctionSessionAppendTicket real canonical SQLite once core", () => {
  it.each(["native", "sdk"] as const)(
    "keeps the %s full target responsibility when accepting its real saved row",
    async (kind) => {
      const f = fixture({ kind })
      const result = await f.ticket.core(f.input)
      f.targetSourceCurrent.mockClear()
      f.hostCurrent.mockClear()

      expect(f.ticket.acceptResult(result)).toEqual(result)
      expect(f.hostCurrent).toHaveBeenCalledTimes(2)
      // Registry target FULL delegates its captured backend exactly once. Native reaches
      // it through each host FULL; SDK retains its two independent target checks.
      expect(f.targetSourceCurrent).toHaveBeenCalledTimes(2)
      expect(f.ticket.committedRow).toEqual(f.store.readReceipt(f.ref, f.input.uuid))
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(f.rows()).toHaveLength(1)
    }
  )

  it("rejects a native ACK when its target is recreated after the actual saved-row read", async () => {
    let armed = false
    let rebuild = (): void => {
      throw Error("The actual post-read replacement is not installed")
    }
    const observed: { row: ReturnType<FunctionSessionAppendCommitPlan["read"]> } = {
      row: undefined
    }
    const replacement: { ref: ReturnType<FunctionConversationStore["ensureMain"]> | undefined } = {
      ref: undefined
    }
    const f = fixture({ kind: "native", plan: (plan) => ({
      ...plan,
      read: () => {
        const row = plan.read()
        if (armed) {
          armed = false
          if (!row) throw Error("The original actual saved row is missing")
          observed.row = row
          rebuild()
        }
        return row
      }
    }) })
    const once = f.ticket.core(f.input)
    const result = await once
    const saved = f.ticket.committedRow
    if (!saved) throw Error("The native core did not retain its actual committed fact")
    expect(saved).toEqual(f.store.readReceipt(f.ref, f.input.uuid))
    expect(f.writer).toHaveBeenCalledTimes(1)
    rebuild = () => {
      threadDb.deleteThread(f.threadId)
      threadDb.createThread(f.threadId)
      const database = threadDb.getDb()
      database.run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [
        f.ref.incarnation.legacyCreatedAt, f.threadId
      ])
      const current = threadDb.getThreadCore(f.threadId)
      if (!current) throw Error("The actual replacement thread is missing")
      replacement.ref = f.store.ensureMain({ threadId: f.threadId, workspace: f.ref.workspace,
        incarnation: captureThreadIncarnation(current), checkpointNamespace: "" },
      f.assertHostPermission)
    }
    armed = true

    expect(() => f.ticket.acceptResult(result)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(observed.row).toEqual(saved)
    const newTarget = replacement.ref
    if (!newTarget) throw Error("The post-read replacement did not create a real target")
    expect(newTarget.threadId).toBe(f.ref.threadId)
    expect(newTarget.incarnation.legacyCreatedAt).toBe(f.ref.incarnation.legacyCreatedAt)
    expect(newTarget.incarnation.token).not.toBe(f.ref.incarnation.token)
    expect(newTarget.conversationId).not.toBe(f.ref.conversationId)
    expect(f.assertHostPermission).not.toThrow()
    expect(f.targetSourceCurrent).not.toThrow()
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.targetController.signal.aborted).toBe(false)
    expect(f.target.signal.aborted).toBe(false)
    expect(f.ticket.signal.aborted).toBe(false)
    expect(f.ticket.committedRow).toBe(saved)
    await expect(once).resolves.toEqual(result)
    expect(() => f.ticket.core(f.input)).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(threadDb.getDb().exec(`SELECT COUNT(*) FROM function_conversation_rows
      WHERE conversation_id = ? AND uuid = ?`, [newTarget.conversationId, f.input.uuid])[0].values)
      .toEqual([[0]])
    expect(f.rows()).toEqual([])
  })

  it("shares a physical commit for repeated next, retaining the complete native saved row", async () => {
    const f = fixture()
    const first = f.ticket.core(textInput(f.input, "Kept note"))
    const repeated = f.ticket.core(textInput(f.input, "Second next must not replace it"))
    expect(repeated).toBe(first)
    const result = await first
    expect(f.ticket.acceptResult(JSON.parse(JSON.stringify(result)))).toEqual(result)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
    const actual = f.store.readReceipt(f.ref, f.input.uuid)
    expect(actual?.message.content).toEqual([{ type: "text", text: "Kept note" }])
    expect(JSON.parse(actual!.nativePayload)).toMatchObject({ actualNative: true,
      metadata: { artifact: "preserved" } })
    expect(f.ticket.committedRow).toEqual(actual)
  })

  it("rejects a malformed first next before admission so the original native fallback can save", async () => {
    const f = fixture()
    expect(() => f.ticket.core({ ...f.input, uuid: "foreign-uuid" }))
      .toThrow("MODS_SESSION_APPEND_PINNED")
    expect(() => f.ticket.core({ ...f.input, message: { ...f.input.message,
      content: [{ type: "text", text: 3 }] } })).toThrow("MODS_SESSION_APPEND_INVALID")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
    await f.ticket.core(f.input)
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("rejects extra SDK text fields before admission and keeps the fallback readable by the real inbox serializer", async () => {
    const f = fixture()
    const invalid = { ...f.input, message: { ...f.input.message,
      content: [{ type: "text", text: "Unreadable note", metadata: { extra: true } }] } }
    expect(() => f.ticket.normalizeInput(invalid)).toThrow("MODS_SESSION_APPEND_INVALID")
    expect(() => f.ticket.core(invalid)).toThrow("MODS_SESSION_APPEND_INVALID")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.store.captureInbox(f.ref, 0).rows).toEqual([])
    const result = await f.ticket.core(f.input)
    expect(f.ticket.acceptResult(result)).toEqual(result)
    const inbox = f.store.captureInbox(f.ref, 0).rows
    expect(inbox).toHaveLength(1)
    const note = functionConversationNoteMessage(inbox[0], f.ref)
    expect(note.id).toBe(f.input.uuid)
    expect(note.content).toEqual([{ type: "text", text: "Original note" }])
    expect(note.additional_kwargs.isMeta).toBe(true)
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it.each(["user", "system"] as const)(
    "rejects extra protected SDK %s text fields before prepare or commit", async (messageType) => {
      const f = fixture({ messageType, protect: async (input) => ({ ...input,
        message: { ...input.message, content: [{ type: "text", text: "Protected text",
          cache_control: { type: "ephemeral" } }] } }) })
      const once = f.ticket.core(f.input)
      await expect(once).rejects.toMatchObject({ code: "MODS_SESSION_APPEND_INVALID" })
      expect(f.ticket.core(f.input)).toBe(once)
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.writer).not.toHaveBeenCalled()
      expect(f.rows()).toEqual([])
      expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeUndefined()
      expect(f.store.captureInbox(f.ref, 0).rows).toEqual([])
      expect(f.ticket.committedRow).toBeUndefined()
    }
  )

  it("preserves richer native text blocks instead of applying the SDK note restriction", async () => {
    const f = fixture({ kind: "native", protect: async (input) => ({ ...input,
      message: { ...input.message, content: [{ type: "text", text: "Native protected text",
        cache_control: { type: "ephemeral" } }] } }) })
    const candidate = { ...f.input, message: { ...f.input.message,
      content: [{ type: "text", text: "Native Hook text", metadata: { extra: true } }] } }
    expect(f.ticket.normalizeInput(candidate).message.content).toEqual(candidate.message.content)
    const result = await f.ticket.core(candidate)
    expect(f.ticket.acceptResult(result)).toEqual(result)
    expect(f.store.readReceipt(f.ref, f.input.uuid)?.message.content).toEqual([
      { type: "text", text: "Native protected text", cache_control: { type: "ephemeral" } }
    ])
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("rejects SDK asUser provenance that the actual SDK note constructor never creates", () => {
    const f = fixture()
    expect(() => new FunctionSessionAppendTicket({ kind: "sdk", target: f.target,
      input: { ...f.input, origin: { kind: "plugin", name: "P", asUser: true } },
      source: { owner: {}, plugin: {}, registration: {}, signal: f.sourceController.signal,
        assertCurrent: () => { /* Actual source remains live; the host note shape is invalid. */ } },
      signal: f.controller.signal,
      assertCurrent: () => { /* Shape rejection precedes any host effect. */ },
      protect: async (input) => input, prepare: f.prepare
    })).toThrow("MODS_SESSION_APPEND_SOURCE")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("requires its own real commit, and rejects different row, UUID or native receipt data", async () => {
    const f = fixture()
    const forged = { message: f.input.message, uuid: f.input.uuid }
    expect(() => f.ticket.acceptResult(forged)).toThrow("MODS_SESSION_APPEND_RESULT")
    expect(f.rows()).toEqual([])
    const actual = await f.ticket.core(f.input)
    expect(() => f.ticket.acceptResult({ ...actual, uuid: randomUUID() }))
      .toThrow("MODS_SESSION_APPEND_RESULT")
    expect(() => f.ticket.acceptResult({ uuid: f.input.uuid,
      message: textInput(f.input, "Not the saved content").message }))
      .toThrow("MODS_SESSION_APPEND_RESULT")
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("accepts only an SDK own-note deny before core, leaving the actual thread unchanged", async () => {
    const sdk = fixture(), native = fixture({ kind: "native" })
    expect(sdk.ticket.acceptResult({ deny: "Skip my note" })).toEqual({ deny: "Skip my note" })
    expect(() => sdk.ticket.core(sdk.input)).toThrow("MODS_SESSION_APPEND_DENIED")
    expect(sdk.rows()).toEqual([])
    expect(sdk.writer).not.toHaveBeenCalled()
    expect(() => native.ticket.acceptResult({ deny: "Cannot erase a native input" }))
      .toThrow("MODS_SESSION_APPEND_DENY")
    await native.ticket.core(native.input)
    expect(native.writer).toHaveBeenCalledTimes(1)
    expect(native.rows()).toHaveLength(1)
  })

  it("precommit deny cancels a pending core without aborting the original source", async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const f = fixture({ protect: async (input) => { entered.resolve(); await gate.promise
      return input } })
    const core = f.ticket.core(f.input)
    const rejected = expect(core).rejects.toMatchObject({ code: "MODS_SESSION_APPEND_DENIED" })
    await entered.promise
    expect(f.ticket.acceptResult({ deny: "No note" })).toEqual({ deny: "No note" })
    expect(f.sourceController.signal.aborted).toBe(false)
    gate.resolve()
    await rejected
    expect(f.rows()).toEqual([])
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it("never rewrites or retries after a committed next followed by deny or an author error", async () => {
    const f = fixture()
    const once = f.ticket.core(f.input)
    await once
    expect(() => f.ticket.acceptResult({ deny: "Too late" })).toThrow("MODS_SESSION_APPEND_DENY")
    expect(() => { throw Error("Author error after next") }).toThrow("Author error after next")
    expect(f.ticket.core(textInput(f.input, "Fallback must not overwrite"))).toBe(once)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.readReceipt(f.ref, f.input.uuid)?.message).toEqual(f.input.message)
  })

  it.each(["source", "target", "host", "cancel"] as const)(
    "checks the original %s after asynchronous protection and makes zero writes", async (kind) => {
      const gate = deferred<void>(), entered = deferred<void>()
      const f = fixture({ protect: async (input) => { entered.resolve(); await gate.promise
        return input } })
      const pending = f.ticket.core(f.input)
      const codes = { source: "TEST_SOURCE_EXPIRED", target: "TEST_TARGET_EXPIRED",
        host: "TEST_HOST_CHANGED", cancel: "TEST_CANCELLED" }
      const rejected = expect(pending).rejects.toMatchObject({ code: codes[kind] })
      await entered.promise
      if (kind === "source") f.expireSource()
      if (kind === "target") f.expireTarget()
      if (kind === "host") f.changeHost()
      if (kind === "cancel") f.controller.abort(new ModFunctionError(codes.cancel))
      gate.resolve()
      await rejected
      expect(f.prepare).not.toHaveBeenCalled()
      expect(f.rows()).toEqual([])
      expect(f.writer).not.toHaveBeenCalled()
    })

  it("rechecks target after preparation, then synchronously adopts only the protected input", async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const f = fixture({ preparing: async () => { entered.resolve(); await gate.promise } })
    const pending = f.ticket.core(f.input)
    const rejected = expect(pending).rejects.toMatchObject({ code: "TEST_TARGET_EXPIRED" })
    await entered.promise
    f.expireTarget()
    gate.resolve()
    await rejected
    expect(f.writer).not.toHaveBeenCalled()
    const safe = fixture({ protect: async (input) => textInput(input, "REDACTED") })
    const result = await safe.ticket.core(safe.input)
    expect(result).toMatchObject({ message: { content: [{ type: "text", text: "REDACTED" }] } })
    expect(safe.store.readReceipt(safe.ref, safe.input.uuid)?.message.content)
      .toEqual([{ type: "text", text: "REDACTED" }])
    expect(JSON.stringify(safe.rows())).not.toContain("Original note")
  })

  it("latches a failed physical writer and leaves canonical row, receipt and inbox rolled back", async () => {
    const f = fixture({ writer: () => { throw Error("Actual writer rejected") } })
    const once = f.ticket.core(f.input)
    await expect(once).rejects.toThrow("Actual writer rejected")
    expect(f.ticket.core(f.input)).toBe(once)
    await expect(once).rejects.toThrow("Actual writer rejected")
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.highWater(f.ref)).toBe(0)
    expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeUndefined()
    expect(f.rows()).toEqual([])
  })

  it("refuses an uncertain postcommit result without replaying its already persisted row", async () => {
    const f = fixture({ plan: (plan) => ({ ...plan, commit: (check) => {
      plan.commit(check)
      throw Error("Lost actual commit reply")
    } }) })
    const once = f.ticket.core(f.input)
    await expect(once).rejects.toThrow("Lost actual commit reply")
    expect(f.ticket.core(f.input)).toBe(once)
    expect(f.ticket.committedRow).toBeUndefined()
    expect(() => f.ticket.acceptResult({ message: f.input.message, uuid: f.input.uuid }))
      .toThrow("MODS_SESSION_APPEND_RESULT")
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeDefined()
    expect(f.rows()).toHaveLength(1)
  })

  it("verifies the full stored row rather than accepting matching public message and UUID", async () => {
    let corrupt = false
    const f = fixture({ plan: (plan) => ({ ...plan, read: () => {
      const row = plan.read()
      return row && corrupt ? { ...row, nativePayload: "different native metadata" } : row
    } }) })
    const result = await f.ticket.core(f.input)
    corrupt = true
    expect(() => f.ticket.acceptResult(result)).toThrow("MODS_SESSION_APPEND_RESULT")
    expect(f.ticket.committedRow).toBeDefined()
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("refuses a sidecar receipt whose actual canonical transcript row was not kept", async () => {
    let missingThreadId = ""
    const f = fixture({ plan: (plan) => ({ ...plan, commit: (check) => {
      const row = plan.commit(check)
      threadDb.getDb().run("DELETE FROM thread_messages WHERE thread_id = ? AND message_id = ?",
        [missingThreadId, row.uuid])
      return row
    } }) })
    missingThreadId = f.threadId
    const once = f.ticket.core(f.input)
    await expect(once).rejects.toMatchObject({ code: "MODS_SESSION_APPEND_NOT_COMMITTED" })
    expect(f.ticket.core(f.input)).toBe(once)
    expect(f.store.readReceipt(f.ref, f.input.uuid)).toBeDefined()
    expect(f.ticket.committedRow).toBeUndefined()
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("keeps a confirmed committed fact when the owner expires before the public ACK", async () => {
    let expire = (): void => { /* Bound to the original fixture source before admission. */ }
    const f = fixture({ plan: (plan) => ({ ...plan, commit: (check) => {
      const row = plan.commit(check)
      expire()
      return row
    } }) })
    expire = f.expireSource
    await expect(f.ticket.core(f.input)).rejects.toMatchObject({ code: "TEST_SOURCE_EXPIRED" })
    expect(f.ticket.committedRow).toEqual(f.store.readReceipt(f.ref, f.input.uuid))
    expect(f.rows()).toHaveLength(1)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(() => f.ticket.acceptResult({ message: f.input.message, uuid: f.input.uuid }))
      .toThrow("TEST_SOURCE_EXPIRED")
  })

  it("pins the actual input snapshot before the caller mutates its original object", async () => {
    const f = fixture()
    f.input.uuid = "replacement"
    f.input.message.content = [{ type: "text", text: "Replacement body" }]
    const result = await f.ticket.core(f.ticket.input)
    expect(result).toMatchObject({ message: { content: [{ type: "text", text: "Original note" }] } })
    expect(f.rows()[0].id).not.toBe("replacement")
    expect(Object.isFrozen(f.ticket.input.message.content)).toBe(true)
  })
})
