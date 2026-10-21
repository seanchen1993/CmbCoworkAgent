import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import type { FunctionSessionAppendInput } from "../../shared/mods/v2/session-append"
import { serializeFunctionConversationNativeMessage } from
  "../agent/function-conversation-native-message"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../agent/thread-run-lease"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../db/function-conversation-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { ModGuestRuntime, type ModHostCall } from "./guest-runtime"
import { ModsManager, type ModThreadBinding } from "./manager"
import { DEFAULT_MOD_POLICY } from "./policy"
import { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { FunctionGuestRuntime } from "./v2/guest-runtime"
import { FunctionModsManager } from "./v2/manager"
import { FunctionSessionAppendTicket } from "./v2/session-append-ticket"
import { projectFunctionSessionApiMessages } from "./v2/session-api-transcript"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} }
}))
// Only the utility-process transport is local: managed policy executes its real QuickJS code.
vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    readonly guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const guest = await ModGuestRuntime.create(code)
      this.guests.set(id, guest)
      return guest.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      const guest = this.guests.get(id)
      if (!guest) throw Error("ACTUAL_POLICY_GUEST_REQUIRED")
      return guest.invoke(handler, event, call)
    }
    stop() {
      for (const guest of this.guests.values()) guest.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-native-conversation-dispatch-"))
  paths.database = join(directory, "actual-app.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

type Lifecycle = Parameters<ModsManager["attachFunctions"]>[0]
type Append = NonNullable<Lifecycle["appendConversation"]>

function nativeTextBlocks(value: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(value)) throw Error("ACTUAL_NATIVE_TEXT_REQUIRED")
  return value.map((block: unknown) => {
    if (!block || typeof block !== "object" ||
      Reflect.get(block, "type") !== "text" || typeof Reflect.get(block, "text") !== "string")
      throw Error("ACTUAL_NATIVE_TEXT_REQUIRED")
    const text: unknown = Reflect.get(block, "text")
    if (typeof text !== "string") throw Error("ACTUAL_NATIVE_TEXT_REQUIRED")
    return { type: "text", text }
  })
}

function acceptedText(result: ReturnType<FunctionSessionAppendTicket["acceptResult"]>) {
  const message = result.message
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw Error("ACTUAL_ACCEPTED_NATIVE_MESSAGE_REQUIRED")
  return nativeTextBlocks(message.content)
}

async function fixture(options: {
  enabled?: boolean
  requiredPolicy?: boolean
  nativePhysical?: boolean
  deferNativePreparation?: boolean
} = {}) {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [],
    async () => true, () => undefined, undefined, {
      ...DEFAULT_MOD_POLICY, required: options.requiredPolicy ?? false,
      redactLiterals: options.requiredPolicy ? ["native-secret-canary"] : []
    })
  manager.configure(root, options.enabled ?? true, options.requiredPolicy ?? false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = options.nativePhysical ? `physical-${randomUUID()}` : turnId
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const db = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const assertThread = () => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== db ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ORIGINAL_THREAD_RETIRED")
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_NATIVE_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: assertThread }
  const instance = manager.createRuntimeAuthority(physical)
  const binding: ModThreadBinding = { ...physical, runtimeAuthority: instance.authority }
  const unbind = manager.bindThread(binding)
  const store = new FunctionConversationStore(db)
  let checkpointGate: {
    entered: ReturnType<typeof Promise.withResolvers<void>>
    released: ReturnType<typeof Promise.withResolvers<void>>
  } | undefined
  const checkpointReads = vi.fn()
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      assertThread()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_OWNER_SCOPE_CHANGED")
    },
    readCurrentCheckpoint: async (_thread, signal, guard) => {
      signal.throwIfAborted()
      guard()
      checkpointReads()
      const held = checkpointGate
      if (held) {
        held.entered.resolve()
        await held.released.promise
        signal.throwIfAborted()
        guard()
      }
      return null // A new native conversation has no checkpoint; no fake checkpoint is supplied.
    },
    protect: async (_context, value, signal, guard) => {
      guard()
      const result = await manager.publish(workspace, value, undefined, signal)
      guard()
      return result
    },
    apiMessages: projectFunctionSessionApiMessages,
    changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: assertThread })
  const prepared = await coordinator.prepareRuntime(workspace, threadId)
  if (!options.deferNativePreparation)
    await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal,
      options.nativePhysical ? physicalRunId : undefined)

  const sources = vi.fn<ConstructorParameters<typeof FunctionModsManager>[1]["plugins"]>(() => [])
  const guestLoads = vi.fn()
  const functions = new FunctionModsManager(manager.store, {
    plugins: sources, enabled: key => manager.isEnabled(key),
    publish: (key, value, signal) => manager.publish(key, value, undefined, signal),
    changed: () => undefined
  }, () => {
    const guests = new Set<FunctionGuestRuntime>()
    return {
      async load(code, guestOptions) {
        guestLoads()
        const guest = await FunctionGuestRuntime.create(code, guestOptions)
        guests.add(guest)
        return guest
      },
      stop() { for (const guest of guests) guest.dispose() }
    }
  })
  const discovery = vi.fn(async () => false)
  const attach = (appendConversation?: Append): Lifecycle => {
    const lifecycle: Lifecycle = {
      invalidate: key => functions.invalidate(key),
      closeThread: id => functions.closeThread(id), close: () => functions.close(),
      hasEventHandler: discovery, ...(appendConversation ? { appendConversation } : {})
    }
    manager.attachFunctions(lifecycle)
    return lifecycle
  }
  const capture = () => {
    const result = manager.captureFunctionConversationRuntime(instance.authority)
    if (!result) throw Error("ACTUAL_RUNTIME_BINDING_REQUIRED")
    return result
  }
  const captureNative = () => {
    const result = manager.captureFunctionNativeConversationRuntime(instance.authority)
    if (!result) throw Error("ACTUAL_NATIVE_RUNTIME_REQUIRED")
    return result
  }
  const writer = vi.fn(), protection = vi.fn()
  const ticket = (text = "original native prompt", admission?: {
    assertCurrent(): void
    afterProtection?(): Promise<void>
  }, nativeRuntime?: ReturnType<typeof captureNative>) => {
    const native = nativeRuntime ?? (options.nativePhysical ? captureNative() : undefined)
    const target = native?.target ?? prepared.target
    const assertCurrent = () => {
      if (native) native.assertCurrent()
      else assertThread()
      admission?.assertCurrent()
    }
    const input: FunctionSessionAppendInput = { uuid: randomUUID(), door: "prompt",
      origin: { kind: "composer" }, message: { type: "user", role: "user",
        content: [{ type: "text", text }] } }
    const access = createFunctionConversationTranscriptAccess((_target, row) => ({
      id: row.uuid, role: "user", content: nativeTextBlocks(row.message.content),
      created_at: new Date(row.createdAt), content_mode: "snapshot"
    }))
    const value = new FunctionSessionAppendTicket({ kind: "native", input,
      target, signal: native?.signal ?? controller.signal, assertCurrent,
      protect: async (candidate, signal, guard) => {
        protection()
        guard()
        const safe = await manager.publish(workspace, candidate, undefined, signal)
        if (admission?.afterProtection) await admission.afterProtection()
        guard()
        return safe
      },
      prepare: async (safe, signal, guard) => {
        signal.throwIfAborted()
        guard()
        const content = nativeTextBlocks(safe.message.content)
        const nativePayload = serializeFunctionConversationNativeMessage(
          new HumanMessage({ id: safe.uuid, content }))
        return {
          commit: check => store.commit(target.ref, {
            uuid: safe.uuid, inputDigest: value.inputDigest, door: safe.door,
            origin: safe.origin, message: safe.message, nativePayload,
            orderAnchor: { kind: "actual-native-dispatch" }, inbox: false, sdk: false
          }, check, (database, target, row) => {
            expect(database).toBe(db)
            expect(database.inTransaction).toBe(true)
            writer()
            access.write(database, target, row)
          }, access.verify),
          read: () => {
            const row = store.readReceipt(target.ref, safe.uuid)
            if (row) access.verify(db, target.ref, row)
            return row
          }
        }
      }
    })
    return value
  }
  const nextNativeRuntime = async () => {
    const previous = getLocalThreadRunLease(threadId)
    if (!previous || !releaseLocalThreadRunLease(threadId, previous.owner, previous.runId))
      throw Error("ACTUAL_NATIVE_LEASE_REQUIRED")
    const runId = `physical-${randomUUID()}`
    if (!claimLocalThreadRunLease({ threadId, runId, owner: "desktop" }).acquired)
      throw Error("ACTUAL_NATIVE_LEASE_REQUIRED")
    const signal = new AbortController().signal
    const nextPhysical: ModThreadBinding = { workspace, threadId, turnId: randomUUID(),
      signal, assertLive: assertThread }
    const next = manager.createRuntimeAuthority(nextPhysical)
    const unbindNext = manager.bindThread({ ...nextPhysical, runtimeAuthority: next.authority })
    cleanups.push(() => { unbindNext(); next.release() })
    await manager.prepareFunctionConversationRuntime(next.authority, signal, runId)
    const runtime = manager.captureFunctionNativeConversationRuntime(next.authority)
    if (!runtime) throw Error("ACTUAL_NATIVE_RUNTIME_REQUIRED")
    expect(runtime.target.ref).toEqual(prepared.target.ref)
    return runtime
  }
  const loadHook = async () => {
    const plugin = join(root, "actual-plugin")
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
    mkdirSync(join(plugin, "hooks"))
    writeFileSync(join(plugin, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "native-dispatch-hook", version: "1.0.0" }))
    writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    writeFileSync(join(plugin, "hooks/register.ts"), `export function register(on) {
      on("session.append", async ($, e, next) => {
        const first = await next({...e, message:{...e.message,
          content:[{type:"text",text:"actual loaded Hook rewrite"}]}})
        await next(e)
        return first
      })
    }`)
    sources.mockImplementation(() => [{ id: "actual-source", name: "native-dispatch-hook",
      path: plugin, enabled: true }])
    const [status] = await functions.status(workspace)
    if (!status?.digest) throw Error("ACTUAL_SOURCE_DIGEST_REQUIRED")
    await functions.approve(workspace, "actual-source", status.digest)
    await functions.commands(workspace, threadId)
    if (!guestLoads.mock.calls.length) throw Error("ACTUAL_RESIDENT_GUEST_REQUIRED")
  }
  cleanups.push(() => {
    functions.close()
    closeOwner()
    coordinator.registry.close()
    unbind()
    instance.release()
    const actualLease = getLocalThreadRunLease(threadId)
    if (actualLease) releaseLocalThreadRunLease(threadId, actualLease.owner, actualLease.runId)
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, workspace, threadId, physicalRunId, store, coordinator, prepared, instance,
    controller, binding, attach, capture, captureNative, ticket, writer, protection, discovery,
    sources, guestLoads, checkpointReads,
    holdNativePreparation: () => {
      checkpointGate = { entered: Promise.withResolvers<void>(),
        released: Promise.withResolvers<void>() }
      return checkpointGate
    },
    functions, loadHook, closeOwner, nextNativeRuntime,
    rows: () => appDb.getThreadMessages(threadId) }
}

describe("actual native conversation runtime dispatch", () => {
  it.each(["unattached", "method-absent", "no-resident"] as const)(
    "%s uses the same native ticket core without discovery or Guest loading", async mode => {
      const f = await fixture()
      if (mode === "method-absent") f.attach()
      if (mode === "no-resident") f.attach(f.functions.appendConversation.bind(f.functions))
      const ticket = f.ticket(), runtime = f.capture()
      expect(runtime.store).toBe(f.store)
      const result = await runtime.dispatch(ticket)
      expect(ticket.acceptResult(result)).toEqual(result)
      expect(f.rows().map(row => row.id)).toEqual([ticket.input.uuid])
      expect(f.store.readReceipt(f.prepared.target.ref, ticket.input.uuid)?.nativePayload)
        .toContain("original native prompt")
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(f.protection).toHaveBeenCalledTimes(1)
      expect(f.discovery).not.toHaveBeenCalled()
      expect(f.sources).not.toHaveBeenCalled()
      expect(f.guestLoads).not.toHaveBeenCalled()
    }
  )

  it("dispatches a real approved resident Hook and repeated next commits exactly once", async () => {
    const f = await fixture()
    await f.loadHook()
    f.attach(f.functions.appendConversation.bind(f.functions))
    const loads = f.guestLoads.mock.calls.length, ticket = f.ticket()
    const result = await f.capture().dispatch(ticket)
    expect(ticket.acceptResult(result)).toMatchObject({ message: {
      content: [{ type: "text", text: "actual loaded Hook rewrite" }]
    } })
    expect(f.rows()).toHaveLength(1)
    expect(f.store.readReceipt(f.prepared.target.ref, ticket.input.uuid)?.message.content)
      .toEqual([{ type: "text", text: "actual loaded Hook rewrite" }])
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.guestLoads).toHaveBeenCalledTimes(loads)
    expect(f.discovery).not.toHaveBeenCalled()
  })

  it("never falls back or replays native core after the original lifecycle throws postcommit", async () => {
    const f = await fixture(), calls = vi.fn()
    f.attach(async (_workspace, _thread, ticket) => {
      calls()
      await ticket.core(ticket.input)
      throw Error("ORIGINAL_NATIVE_DISPATCH_FAILED")
    })
    const ticket = f.ticket()
    await expect(f.capture().dispatch(ticket)).rejects.toThrow("ORIGINAL_NATIVE_DISPATCH_FAILED")
    expect(ticket.committedRow?.uuid).toBe(ticket.input.uuid)
    expect(f.rows()).toHaveLength(1)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.protection).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(f.guestLoads).not.toHaveBeenCalled()
  })

  it("keeps required real policy protection in native core with optional Guests disabled", async () => {
    const f = await fixture({ enabled: false, requiredPolicy: true }), append = vi.fn<Append>()
    f.attach(append)
    expect(f.manager.protects(f.workspace)).toBe(true)
    const ticket = f.ticket("native-secret-canary"), result = await f.capture().dispatch(ticket)
    expect(ticket.acceptResult(result)).toMatchObject({ message: {
      content: [{ type: "text", text: "[REDACTED]" }]
    } })
    const row = f.store.readReceipt(f.prepared.target.ref, ticket.input.uuid)
    expect(row?.nativePayload).toContain("[REDACTED]")
    expect(row?.nativePayload).not.toContain("native-secret-canary")
    expect(f.rows()[0].content).not.toContain("native-secret-canary")
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.protection).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    expect(f.sources).not.toHaveBeenCalled()
    expect(f.guestLoads).not.toHaveBeenCalled()
  })

  it.each(["physical-authority", "original-binding", "conversation-owner", "lifecycle"] as const)(
    "rejects a held ACK after %s replacement without replaying the saved row", async changed => {
      const f = await fixture(), entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>(), calls = vi.fn()
      const replacement = vi.fn<Append>()
      f.attach(async (_workspace, _thread, ticket) => {
        calls()
        const result = await ticket.core(ticket.input)
        entered.resolve()
        await gate.promise
        return result
      })
      const ticket = f.ticket(), runtime = f.capture(), pending = runtime.dispatch(ticket)
      const rejected = expect(pending).rejects.toThrow(changed === "physical-authority"
        ? "MODS_RUNTIME_INSTANCE_EXPIRED" : changed === "conversation-owner"
          ? "MODS_CONVERSATION_SESSION_CLOSED" : "MODS_CALL_SCOPE_CHANGED")
      await entered.promise
      expect(f.writer).toHaveBeenCalledTimes(1)
      if (changed === "physical-authority") {
        const replacementAuthority = f.manager.createRuntimeAuthority(f.binding)
        cleanups.push(replacementAuthority.release)
      }
      if (changed === "original-binding") {
        const unbind = f.manager.bindThread({ ...f.binding })
        cleanups.push(unbind)
      }
      if (changed === "conversation-owner") f.closeOwner()
      if (changed === "lifecycle") f.attach(replacement)
      gate.resolve()
      await rejected
      expect(ticket.committedRow?.uuid).toBe(ticket.input.uuid)
      expect(f.store.readReceipt(f.prepared.target.ref, ticket.input.uuid)?.uuid).toBe(ticket.input.uuid)
      expect(f.rows()).toHaveLength(1)
      expect(f.writer).toHaveBeenCalledTimes(1)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(replacement).not.toHaveBeenCalled()
    }
  )

  it("rejects an expired captured lifecycle before any native core or new lifecycle call", async () => {
    const f = await fixture(), old = vi.fn<Append>(), newer = vi.fn<Append>()
    f.attach(old)
    const runtime = f.capture(), ticket = f.ticket()
    f.attach(newer)
    await expect(runtime.dispatch(ticket)).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(old).not.toHaveBeenCalled()
    expect(newer).not.toHaveBeenCalled()
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.protection).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("caches the exact native runtime without repeated Registry/resource registration", async () => {
    const f = await fixture({ nativePhysical: true })
    const runtime = f.captureNative()
    expect(f.physicalRunId).not.toBe(f.instance.authority.turnId)
    expect(Object.is(runtime.database, appDb.getDb())).toBe(true)
    expect(Object.isFrozen(runtime)).toBe(true)
    for (let index = 0; index < 150; index++) expect(f.captureNative()).toBe(runtime)
    expect(f.captureNative().target).toBe(runtime.target)
    const reads = f.checkpointReads.mock.calls.length
    await expect(f.manager.prepareFunctionConversationRuntime(f.instance.authority,
      f.controller.signal, f.physicalRunId))
      .rejects.toThrow("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    expect(f.checkpointReads).toHaveBeenCalledTimes(reads)
    runtime.assertCurrent()
  })

  it("rejects a second preparation while the exact original checkpoint read is held", async () => {
    const f = await fixture({ nativePhysical: true, deferNativePreparation: true })
    const held = f.holdNativePreparation(), reads = f.checkpointReads.mock.calls.length
    const first = f.manager.prepareFunctionConversationRuntime(f.instance.authority,
      f.controller.signal, f.physicalRunId)
    await held.entered.promise
    const second = expect(f.manager.prepareFunctionConversationRuntime(f.instance.authority,
      f.controller.signal, f.physicalRunId))
      .rejects.toThrow("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    await second
    expect(f.checkpointReads).toHaveBeenCalledTimes(reads + 1)
    held.released.resolve()
    await first
    const runtime = f.captureNative()
    runtime.assertCurrent()
    expect(f.captureNative()).toBe(runtime)
    expect(f.checkpointReads).toHaveBeenCalledTimes(reads + 1)
    const ticket = f.ticket()
    expect(ticket.acceptResult(await runtime.dispatch(ticket)).uuid).toBe(ticket.input.uuid)
    expect(f.writer).toHaveBeenCalledTimes(1)
  })

  it("requires a fresh physical run after policy configuration without renewing old Guards",
    async () => {
      const f = await fixture({ nativePhysical: true, requiredPolicy: true })
      await f.loadHook()
      const append = vi.fn<Append>(f.functions.appendConversation.bind(f.functions))
      f.attach(append)
      const runtime = f.captureNative()
      const oldGuest = f.manager.captureFunctionRuntimeGuard(f.instance.authority)
      const oldPolicy = runtime.capturePolicy()
      const loads = f.guestLoads.mock.calls.length, sources = f.sources.mock.calls.length
      f.manager.configure(f.workspace, false, true)
      expect(() => oldGuest()).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(() => oldPolicy.assertCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
      runtime.assertCurrent()
      f.instance.authority.assertLive()
      f.binding.assertLive?.()
      expect(() => runtime.capturePolicy()).toThrow("MODS_CALL_SCOPE_CHANGED")
      const currentRuntime = await f.nextNativeRuntime()
      const currentPolicy = currentRuntime.capturePolicy()
      currentPolicy.assertCurrent()
      expect(currentPolicy.value.epoch).not.toBe(oldPolicy.value.epoch)
      const first = f.ticket("native-secret-canary", currentPolicy, currentRuntime)
      const firstResult = await currentRuntime.dispatch(first)
      expect(acceptedText(first.acceptResult(firstResult)))
        .toEqual([{ type: "text", text: "[REDACTED]" }])
      f.manager.configure(f.workspace, true, true)
      expect(() => currentPolicy.assertCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(() => currentRuntime.capturePolicy()).toThrow("MODS_CALL_SCOPE_CHANGED")
      const nextRuntime = await f.nextNativeRuntime()
      const nextPolicy = nextRuntime.capturePolicy()
      const second = f.ticket("new physical core after reenable", nextPolicy, nextRuntime)
      expect(acceptedText(second.acceptResult(await nextRuntime.dispatch(second))))
        .toEqual([{ type: "text", text: "new physical core after reenable" }])
      expect(nextRuntime).not.toBe(currentRuntime)
      expect(append).toHaveBeenCalledTimes(1)
      expect(f.writer).toHaveBeenCalledTimes(2)
      expect(f.guestLoads).toHaveBeenCalledTimes(loads)
      expect(f.sources).toHaveBeenCalledTimes(sources)
      expect(f.discovery).not.toHaveBeenCalled()
    })

  it("rejects a pending old-policy publication and admits the current policy only on a new physical run", async () => {
    const f = await fixture({ nativePhysical: true, requiredPolicy: true })
    const runtime = f.captureNative(), policy = runtime.capturePolicy()
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const old = f.ticket("native-secret-canary", {
      assertCurrent: policy.assertCurrent,
      afterProtection: async () => { entered.resolve(); await gate.promise }
    })
    const pending = runtime.dispatch(old)
    const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await entered.promise
    f.manager.configure(f.workspace, false, true)
    runtime.assertCurrent()
    gate.resolve()
    await rejected
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
    expect(f.store.readReceipt(runtime.target.ref, old.input.uuid)).toBeUndefined()
    expect(() => runtime.capturePolicy()).toThrow("MODS_CALL_SCOPE_CHANGED")
    const currentRuntime = await f.nextNativeRuntime()
    const current = f.ticket("native-secret-canary", currentRuntime.capturePolicy(), currentRuntime)
    expect(acceptedText(current.acceptResult(await currentRuntime.dispatch(current))))
      .toEqual([{ type: "text", text: "[REDACTED]" }])
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(f.rows()).toHaveLength(1)
  })

  it("keeps a closed cached runtime terminal and does not recapture a fresh native owner", async () => {
    const f = await fixture({ nativePhysical: true })
    const runtime = f.captureNative(), ticket = f.ticket()
    runtime.close()
    runtime.close()
    expect(runtime.signal.aborted).toBe(true)
    expect(f.controller.signal.aborted).toBe(false)
    f.instance.authority.assertLive()
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
    expect(() => runtime.assertCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(() => f.captureNative()).toThrow("MODS_CALL_SCOPE_CHANGED")
    await expect(runtime.dispatch(ticket)).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await expect(f.manager.prepareFunctionConversationRuntime(f.instance.authority,
      f.controller.signal, f.physicalRunId))
      .rejects.toThrow("MODS_CONVERSATION_REGISTRATION_CONFLICT")
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.coordinator.registry.activeMutations).toBe(0)
  })

  it("rejects cached native admission after a same-id physical lease release/reacquire", async () => {
    const f = await fixture({ nativePhysical: true })
    const runtime = f.captureNative(), ticket = f.ticket()
    const original = getLocalThreadRunLease(f.threadId)
    if (!original) throw Error("ACTUAL_NATIVE_LEASE_REQUIRED")
    expect(releaseLocalThreadRunLease(f.threadId, original.owner, original.runId)).toBe(true)
    expect(claimLocalThreadRunLease(original).acquired).toBe(true)
    expect(getLocalThreadRunLease(f.threadId)).toEqual(original)
    expect(() => runtime.assertCurrent()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(() => f.captureNative()).toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    await expect(runtime.dispatch(ticket)).rejects.toThrow("MODS_CONVERSATION_NATIVE_RUN_CHANGED")
    expect(f.writer).not.toHaveBeenCalled()
    expect(f.rows()).toEqual([])
  })

  it("does not replay an entered Guest append after configuration changes postcommit", async () => {
    const f = await fixture({ nativePhysical: true })
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const calls = vi.fn()
    f.attach(async (_workspace, _thread, ticket) => {
      calls()
      const result = await ticket.core(ticket.input)
      entered.resolve()
      await gate.promise
      return result
    })
    const runtime = f.captureNative(), ticket = f.ticket()
    const pending = runtime.dispatch(ticket)
    const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await entered.promise
    expect(f.writer).toHaveBeenCalledTimes(1)
    f.manager.configure(f.workspace, false, false)
    gate.resolve()
    await rejected
    runtime.assertCurrent()
    expect(f.store.readReceipt(runtime.target.ref, ticket.input.uuid)?.uuid).toBe(ticket.input.uuid)
    expect(f.rows()).toHaveLength(1)
    expect(f.writer).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(1)
    const next = f.ticket("new native admission after the old Guest rejection")
    expect(next.acceptResult(await runtime.dispatch(next)).uuid).toBe(next.input.uuid)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(f.writer).toHaveBeenCalledTimes(2)
    expect(f.rows()).toHaveLength(2)
  })

  it("retires effects on native close but retains ignored host work through its actual finally", async () => {
    const f = await fixture({ nativePhysical: true }), runtime = f.captureNative()
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const finallyRan = vi.fn()
    const pending = runtime.runMutation({}, {}, async (signal, guard) => {
      guard()
      entered.resolve()
      try {
        await gate.promise
        expect(signal.aborted).toBe(true)
        return "actual ignored cancellation settled"
      } finally { finallyRan() }
    })
    const rejected = expect(pending).rejects.toThrow("MODS_CONVERSATION_SESSION_CLOSED")
    await entered.promise
    expect(f.coordinator.registry.activeMutations).toBe(1)
    runtime.close()
    expect(f.coordinator.registry.activeMutations).toBe(1)
    expect(finallyRan).not.toHaveBeenCalled()
    expect(f.controller.signal.aborted).toBe(false)
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe(f.physicalRunId)
    gate.resolve()
    await rejected
    expect(finallyRan).toHaveBeenCalledTimes(1)
    expect(f.coordinator.registry.activeMutations).toBe(0)
  })
})
