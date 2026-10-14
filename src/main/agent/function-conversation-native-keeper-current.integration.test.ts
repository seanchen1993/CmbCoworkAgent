import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import type { RunnableConfig } from "@langchain/core/runnables"
import { createAgent } from "langchain"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { readFunctionConversationRawProjection } from "../db/function-conversation-projection-receipt"
import { ModsManager, type ModThreadBinding } from "../mods/manager"
import { DEFAULT_MOD_POLICY } from "../mods/policy"
import { FunctionConversationCoordinator } from "../mods/v2/conversation-coordinator"
import { readFunctionConversationNativeMutationGuard } from "../mods/v2/conversation-registry"
import { projectFunctionSessionApiMessages } from "../mods/v2/session-api-transcript"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"
import { installFunctionConversationNativeNode, readFunctionConversationNativeNodeSlot,
  type FunctionConversationNativeNodeSlot } from "./function-conversation-native-node"
import { captureNativeMessageForOccurrence } from "./native-message-capture"
import { captureFunctionConversationNativeModelCurrent } from "./native-model-current"
import { createFunctionConversationNativeAdoption } from "./function-conversation-native-adoption"
import { FunctionConversationNativeKeeper, type FunctionConversationNativeKeeperAdmission }
  from "./function-conversation-native-keeper"
import { captureFunctionConversationNativeInput } from "./function-conversation-native-input"
import { readFunctionConversationNativeInputCurrent, createFunctionConversationNativeInputRetention } from "./function-conversation-native-input-retention"
import { FunctionNativeMessageProtector } from "./native-message-protector"
import { deserializeFunctionConversationNativeMessage, serializeFunctionConversationNativeMessage }
  from "./function-conversation-native-message"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({ getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test",
  getVersion: () => "0" }, BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  ipcMain: { handle: () => {} } }))
import * as appDb from "../db"

let directory = ""
const cleanups: Array<() => Promise<void>> = []
const controllers = new Set<AbortController>()
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-keeper-current-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  for (const controller of controllers) controller.abort()
  controllers.clear()
  const errors: unknown[] = []
  // Actual Keepers and installed Nodes precede Saver/DB cleanup in reverse registration order.
  for (const close of cleanups.splice(0).reverse()) {
    try { await close() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks()
  if (errors.length) throw errors[0]
})
afterAll(async () => {
  await appDb.closeDatabase()
  if (resolve(dirname(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("cmb-keeper-current-")) throw Error("UNSAFE_TEST_CLEANUP")
  rmSync(directory, { recursive: true, force: true })
})

class ActualModel extends BaseChatModel {
  readonly outputs: AIMessage[] = []
  _llmType() { return "actual-keeper-current-provider" }
  bindTools(): this { return this }
  constructor() { super({}) }
  async _generate(): Promise<ChatResult> {
    const message = new AIMessage({ id: randomUUID(), content: "actual keeper model body",
      response_metadata: { original: true } })
    this.outputs.push(message)
    return { generations: [{ message, text: String(message.content) }] }
  }
}

/** Original AppDB/lease/Manager/Registry and real completed createAgent Slot. */
async function fixture() {
  const root = mkdtempSync(join(directory, "workspace-"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false }, () => true)
  manager.configure(root, false, false)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), controller = new AbortController()
  controllers.add(controller)
  const thread = appDb.createThread(threadId, { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const action: { callback?: () => void } = {}
  const guard = vi.fn(() => {
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_KEEPER_PHYSICAL_RUN_REQUIRED")
    action.callback?.()
  })
  if (!claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" }).acquired)
    throw Error("ACTUAL_KEEPER_LEASE_REQUIRED")
  const binding: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: guard }
  const instance = manager.createRuntimeAuthority(binding)
  const unbind = manager.bindThread({ ...binding, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_KEEPER_OWNER_REQUIRED")
    }, readCurrentCheckpoint: async (_thread, signal, current) => {
      signal.throwIfAborted(); current(); return null
    }, protect: async (_context, value, signal, current) => {
      signal.throwIfAborted(); current(); return value
    }, apiMessages: projectFunctionSessionApiMessages, changed: () => undefined
  })
  manager.setFunctionConversations(coordinator)
  const closeOwner = coordinator.openConversationOwner({ owner: {}, workspace, threadId,
    signal: controller.signal, readOnly: false, assertCurrent: guard })
  await coordinator.prepareRuntime(workspace, threadId)
  await manager.prepareFunctionConversationRuntime(instance.authority, controller.signal, physicalRunId)
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_KEEPER_RUNTIME_REQUIRED")
  const saver = new SqlJsSaver(join(root, "checkpoint.sqlite"), undefined, { maxRootCheckpoints: 3 })
  const config: RunnableConfig = { signal: controller.signal,
    configurable: { thread_id: threadId, checkpoint_ns: "" } }
  cleanups.push(async () => {
    action.callback = undefined
    await saver.close()
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close()
    if (resolve(dirname(root)) !== resolve(directory) ||
      !basename(root).startsWith("workspace-")) throw Error("UNSAFE_TEST_CLEANUP")
    rmSync(root, { recursive: true, force: true })
  })
  return { runtime, store, saver, config, controller, action, guard, coordinator, threadId,
    physicalRunId, workspace,
    changePolicy: () => manager.configure(root, false, false), removeBinding: unbind }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
type PrivateKeeperGuard = { guard(work: unknown, signal: AbortSignal, mutation: () => void): void }

async function run(f: Fixture, finalize: (slot: FunctionConversationNativeNodeSlot) => Promise<BaseMessage>) {
  const model = new ActualModel()
  const agent = createAgent({ model, checkpointer: f.saver })
  const control = installFunctionConversationNativeNode({ graph: agent.graph, node: "model_request",
    runtime: f.runtime, assertCurrent: f.runtime.assertCurrent, finalize })
  const result = agent.invoke({ messages: [new HumanMessage("actual native request")] }, f.config)
  void result.catch(() => undefined)
  cleanups.push(async () => {
    control.close()
    const settled = await Promise.allSettled([result, control.whenDrained()])
    if (settled[1].status === "rejected") throw settled[1].reason
  })
  return { result, model }
}

function admission(f: Fixture, slot: FunctionConversationNativeNodeSlot, wrapper = false) {
  const view = readFunctionConversationNativeNodeSlot(slot), message = view.message
  const uuid = message.id
  if (!uuid) throw Error("ACTUAL_KEEPER_UUID_REQUIRED")
  const policy = f.runtime.capturePolicy()
  const captured = captureNativeMessageForOccurrence(message, uuid)
  const name = captured.snapshot.data.name
  if (name !== undefined && typeof name !== "string") throw Error("ACTUAL_KEEPER_NAME_REQUIRED")
  const current = captureFunctionConversationNativeModelCurrent({ slot, runtime: f.runtime,
    policy, uuid, originalDigest: captured.originalDigest,
    signal: f.controller.signal, expiresAtNs: process.hrtime.bigint() + 30_000_000_000n,
    hostLatch: { failed: false } })
  if (!current) throw Error("ACTUAL_KEEPER_MODEL_CURRENT_REQUIRED")
  const producer = {}, occurrence = slot
  const adoption = createFunctionConversationNativeAdoption({ runtime: f.runtime, store: f.store,
    producer, occurrence, assertCurrent: current, seal: () => undefined, flush: () => undefined,
    facts: { uuid, role: "assistant", providerSourceId: uuid, providerOccurrence: 1,
      ...(name === undefined ? {} : { name }) } })
  let retained = 0
  const value: FunctionConversationNativeKeeperAdmission = { producer, occurrence, message,
    door: "response", origin: { kind: "model", model: "actual-keeper-provider" },
    signal: f.controller.signal, policy: policy.value,
    assertCurrent: wrapper ? () => current() : current,
    seal: () => undefined, captureProjection: adoption.captureProjection, prepare: adoption.prepare,
    retainActualWork() {
      retained++
      let released = false
      return () => {
        if (released) throw Error("ACTUAL_KEEPER_RELEASE_ONCE")
        released = true; retained--
      }
    }, assertExecutionFacts(original, safe) {
      if (Object.getPrototypeOf(original) !== Object.getPrototypeOf(safe) || original.id !== safe.id)
        throw Error("ACTUAL_KEEPER_EXECUTION_CHANGED")
    }, inheritPresentation() { /* No enhanced model presentation is present. */ }
  }
  return { value, current, uuid, retained: () => retained }
}

describe("Keeper original mutation/current relationship", () => {
  it.each(["certified", "current-wrapper", "runtime-clone"] as const)(
    "preserves every M/A/T/D full check for %s", async mode => {
      const f = await fixture()
      const actual = await run(f, async slot => {
        const a = admission(f, slot, mode === "current-wrapper")
        const keeper = new FunctionConversationNativeKeeper(mode === "runtime-clone"
          ? { ...f.runtime } : f.runtime, new FunctionNativeMessageProtector())
        cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
        const target = keeper as unknown as PrivateKeeperGuard
        const original = target.guard
        let measured = false
        vi.spyOn(target, "guard").mockImplementation((work, signal, mutation) => {
          if (!measured) {
            measured = true
            const relation = readFunctionConversationNativeMutationGuard(mutation, f.runtime,
              a.value.producer, a.value.occurrence)
            expect(relation).toBeDefined()
            const beforeTail = f.guard.mock.calls.length
            relation?.assertTail()
            expect(f.guard.mock.calls).toHaveLength(beforeTail)
            f.runtime.assertCurrent()
            const r = f.guard.mock.calls.length - beforeTail
            const beforeFull = f.guard.mock.calls.length
            f.runtime.assertCurrent(); mutation(); a.value.assertCurrent()
            f.runtime.target.assertCurrent(); f.runtime.destination.assertCurrent()
            const full = f.guard.mock.calls.length - beforeFull
            const beforeActual = f.guard.mock.calls.length
            Reflect.apply(original, keeper, [work, signal, mutation])
            expect(f.guard.mock.calls.length - beforeActual)
              .toBe(full - (mode === "certified" ? r : 0))
            return
          }
          Reflect.apply(original, keeper, [work, signal, mutation])
        })
        const saved = await keeper.retain(a.value)
        await keeper.whenDrained()
        expect(measured).toBe(true)
        expect(a.retained()).toBe(0)
        expect(saved.message.content).toBe("actual keeper model body")
        expect(saved.message.name).toBe(a.value.message.name)
        expect(serializeFunctionConversationNativeMessage(saved.message)).toBe(saved.row.nativePayload)
        const columns = readFunctionConversationRawProjection(f.runtime.database, f.threadId, a.uuid)
        if (!columns || typeof columns.content_json !== "string")
          throw Error("ACTUAL_KEEPER_23_COLUMN_BODY_REQUIRED")
        expect(columns.role).toBe("assistant")
        expect(columns.content_json).toBe(JSON.stringify("actual keeper model body"))
        expect(JSON.parse(columns.content_json)).toBe("actual keeper model body")
        expect(columns.name).toBe(a.value.message.name)
        if (typeof saved.row.nativePayload !== "string")
          throw Error("ACTUAL_KEEPER_COMPLETE_NATIVE_PAYLOAD_REQUIRED")
        const restored = deserializeFunctionConversationNativeMessage(saved.row.nativePayload)
        expect(restored.content).toBe("actual keeper model body")
        expect(restored.name).toBe(a.value.message.name)
        expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
        return saved.message
      })
      await actual.result
      expect(actual.model.outputs).toHaveLength(1)
      const tuple = await f.saver.getTuple(f.config)
      const messages: unknown = tuple?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_CANONICAL_CHECKPOINT_REQUIRED")
      const canonical = messages.find(message => message.id === actual.model.outputs[0].id)
      expect(canonical).toBeDefined()
      expect(serializeFunctionConversationNativeMessage(canonical))
        .toBe(f.store.readRows(f.runtime.target.ref)[0].nativePayload)
    })

  it("rejects foreign/wrapped guards and retires the actual relation in the original finally", async () => {
    const f = await fixture(), foreign = await fixture(), producer = {}, occurrence = {}
    let retained: ReturnType<typeof readFunctionConversationNativeMutationGuard>
    let traps = 0
    await f.runtime.runMutation(producer, occurrence, async (_signal, guard) => {
      retained = readFunctionConversationNativeMutationGuard(guard, f.runtime, producer, occurrence)
      expect(retained).toBeDefined()
      expect(readFunctionConversationNativeMutationGuard(guard, foreign.runtime, producer, occurrence))
        .toBeUndefined()
      expect(readFunctionConversationNativeMutationGuard(guard.bind(undefined), f.runtime,
        producer, occurrence)).toBeUndefined()
      expect(readFunctionConversationNativeMutationGuard(guard, f.runtime, {}, occurrence))
        .toBeUndefined()
      const proxy = new Proxy(guard, { get() { traps++; throw Error("UNKNOWN_GUARD_PROXY") },
        getPrototypeOf() { traps++; throw Error("UNKNOWN_GUARD_PROXY") } })
      expect(readFunctionConversationNativeMutationGuard(proxy, f.runtime, producer, occurrence))
        .toBeUndefined()
      const before = f.guard.mock.calls.length
      retained?.assertTail()
      expect(f.guard.mock.calls).toHaveLength(before)
      expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    })
    expect(() => retained?.assertTail()).toThrow()
    expect(traps).toBe(0)
    expect(f.coordinator.registry.activeMutations).toBe(0)
  })

  it.each(["getter", "replacement"] as const)(
    "executes the original R/M functions without their later own bind %s", async kind => {
      const f = await fixture()
      let reads = 0
      const actual = await run(f, async slot => {
        const a = admission(f, slot), fn = f.runtime.assertCurrent
        const previous = Object.getOwnPropertyDescriptor(fn, "bind")
        Object.defineProperty(fn, "bind", kind === "getter"
          ? { configurable: true, get() { reads++; throw Error("LATE_BIND_MUST_NOT_EXECUTE") } }
          : { configurable: true, value: () => { reads++; return () => undefined } })
        try {
          const keeper = new FunctionConversationNativeKeeper(f.runtime, new FunctionNativeMessageProtector())
          cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
          const before = f.guard.mock.calls.length
          const saved = await keeper.retain(a.value)
          await keeper.whenDrained()
          expect(f.guard.mock.calls.length).toBeGreaterThan(before)
          expect(reads).toBe(0)
          expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
          return saved.message
        } finally {
          if (previous) Object.defineProperty(fn, "bind", previous)
          else Reflect.deleteProperty(fn, "bind")
        }
      })
      await actual.result
      expect(actual.model.outputs).toHaveLength(1)
      expect(reads).toBe(0)
    })

  it.each(["body", "metadata", "policy", "binding", "closed", "reentry"] as const)(
    "rejects the destination's last original %s mutation without a write or retry", async kind => {
      const f = await fixture()
      const actual = await run(f, async slot => {
        const a = admission(f, slot)
        const keeper = new FunctionConversationNativeKeeper(f.runtime, new FunctionNativeMessageProtector())
        cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
        const target = keeper as unknown as PrivateKeeperGuard, original = target.guard
        let armed = false, changed = false
        vi.spyOn(target, "guard").mockImplementation((work, signal, mutation) => {
          if (!armed) {
            armed = true
            const beforeR = f.guard.mock.calls.length
            f.runtime.assertCurrent()
            const r = f.guard.mock.calls.length - beforeR
            const beforeFull = f.guard.mock.calls.length
            f.runtime.assertCurrent(); mutation(); a.value.assertCurrent()
            f.runtime.target.assertCurrent(); f.runtime.destination.assertCurrent()
            const end = f.guard.mock.calls.length + f.guard.mock.calls.length - beforeFull - r
            f.action.callback = () => {
              if (f.guard.mock.calls.length !== end) return
              f.action.callback = undefined
              changed = true
              if (kind === "body") a.value.message.content = "late original model body"
              else if (kind === "metadata") Object.defineProperty(a.value.message.response_metadata,
                "changed", { value: true, enumerable: true, writable: true, configurable: true })
              else if (kind === "policy") f.changePolicy()
              else if (kind === "binding") f.removeBinding()
              else if (kind === "closed") keeper.close()
              else {
                expect(() => Reflect.apply(original, keeper, [work, signal, mutation])).toThrow()
              }
            }
          }
          Reflect.apply(original, keeper, [work, signal, mutation])
        })
        const first = keeper.retain(a.value)
        await expect(first).rejects.toThrow()
        await keeper.whenDrained()
        expect(changed).toBe(true)
        expect(keeper.retain(a.value)).toBe(first)
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        expect(readFunctionConversationRawProjection(f.runtime.database, f.threadId, a.uuid))
          .toBeUndefined()
        expect(a.retained()).toBe(0)
        await first
        return a.value.message
      })
      await expect(actual.result).rejects.toThrow()
      expect(actual.model.outputs).toHaveLength(1)
      const tuple = await f.saver.getTuple(f.config)
      const messages: unknown = tuple?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_INPUT_CHECKPOINT_REQUIRED")
      expect(messages.some(message => message.id === actual.model.outputs[0].id)).toBe(false)
    })

  it("rejects late actual collection accessors without running them or reviving a poisoned relation", async () => {
    const f = await fixture(), producer = {}, occurrence = {}
    const ordinaryId = randomUUID()
    expect(appDb.upsertThreadMessages(f.threadId, [{ id: ordinaryId, role: "user",
      content: "actual ordinary message must survive the denied accessor", created_at: new Date() }]))
      .toBe(1)
    let getters = 0
    await expect(f.runtime.runMutation(producer, occurrence, async (_signal, guard) => {
      const relation = readFunctionConversationNativeMutationGuard(guard, f.runtime, producer, occurrence)
      if (!relation) throw Error("ACTUAL_MUTATION_RELATION_REQUIRED")
      const registry = f.coordinator.registry
      const descriptor = Object.getOwnPropertyDescriptor(registry, "mutations")
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_MUTATION_COLLECTION_REQUIRED")
      Object.defineProperty(registry, "mutations", { configurable: true, get() {
        getters++
        f.runtime.database.run("DELETE FROM thread_messages WHERE thread_id=?", [f.threadId])
        return descriptor.value
      } })
      try {
        expect(() => relation.assertTail()).toThrow()
        expect(getters).toBe(0)
      } finally { Object.defineProperty(registry, "mutations", descriptor) }
      expect(() => relation.assertTail()).toThrow()
    })).rejects.toThrow()
    expect(getters).toBe(0)
    expect(f.coordinator.registry.activeMutations).toBe(0)
    expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
    expect(appDb.getThreadMessagesByIds(f.threadId, [ordinaryId])[0].content)
      .toBe("actual ordinary message must survive the denied accessor")
  })

  it.each(["certified-getter", "reentered-getter", "certified-replacement",
    "admission-replacement", "caught-restore", "prior-getter"] as const)(
    "rejects a last original destination Work %s without evaluating it", async kind => {
      const f = await fixture()
      let getters = 0, changed = false
      const actual = await run(f, async slot => {
        const a = admission(f, slot)
        const keeper = new FunctionConversationNativeKeeper(f.runtime, new FunctionNativeMessageProtector())
        cleanups.push(async () => { keeper.close(); await keeper.whenDrained() })
        const target = keeper as unknown as PrivateKeeperGuard, original = target.guard
        let armed = false, restore: (() => void) | undefined
        vi.spyOn(target, "guard").mockImplementation((work, signal, mutation) => {
          if (!armed) {
            armed = true
            const beforeR = f.guard.mock.calls.length
            f.runtime.assertCurrent()
            const r = f.guard.mock.calls.length - beforeR
            const beforeFull = f.guard.mock.calls.length
            f.runtime.assertCurrent(); mutation(); a.value.assertCurrent()
            f.runtime.target.assertCurrent(); f.runtime.destination.assertCurrent()
            const end = f.guard.mock.calls.length + f.guard.mock.calls.length - beforeFull - r
            f.action.callback = () => {
              if (f.guard.mock.calls.length !== end) return
              f.action.callback = undefined
              changed = true
              const key = kind === "admission-replacement" ? "admission"
                : kind.startsWith("certified-") ? "certified" : "reentered"
              const value = work as object
              const field = Object.getOwnPropertyDescriptor(value, key)
              if (!field || !("value" in field)) throw Error("ACTUAL_WORK_DATA_FIELD_REQUIRED")
              restore = () => Object.defineProperty(value, key, field)
              if (kind.endsWith("replacement"))
                Object.defineProperty(value, key, { ...field, value: {} })
              else Object.defineProperty(value, key, {
                configurable: true, enumerable: field.enumerable, get() {
                  getters++
                  f.runtime.database.run("DELETE FROM thread_messages WHERE thread_id=?", [f.threadId])
                  return field.value
                }
              })
              if (kind === "caught-restore" || kind === "prior-getter") {
                try {
                  expect(() => kind === "prior-getter"
                    ? keeper.retain({ ...a.value })
                    : Reflect.apply(original, keeper, [work, signal, mutation])).toThrow()
                } finally { restore() }
              }
            }
          }
          Reflect.apply(original, keeper, [work, signal, mutation])
        })
        const first = keeper.retain(a.value)
        await expect(first).rejects.toThrow()
        restore?.()
        await keeper.whenDrained()
        expect(changed).toBe(true)
        expect(getters).toBe(0)
        expect(keeper.retain(a.value)).toBe(first)
        expect(f.store.readRows(f.runtime.target.ref)).toEqual([])
        expect(readFunctionConversationRawProjection(f.runtime.database, f.threadId, a.uuid))
          .toBeUndefined()
        expect(a.retained()).toBe(0)
        await first
        return a.value.message
      })
      await expect(actual.result).rejects.toThrow()
      expect(getters).toBe(0)
      expect(actual.model.outputs).toHaveLength(1)
      const tuple = await f.saver.getTuple(f.config)
      const messages: unknown = tuple?.checkpoint.channel_values.messages
      if (!Array.isArray(messages)) throw Error("ACTUAL_INPUT_CHECKPOINT_REQUIRED")
      expect(messages.some(message => message.id === actual.model.outputs[0].id)).toBe(false)
    })
})


describe("actual input keeper current provenance", () => {
  it.each(["factory", "factory-default-namespace", "wrapper"] as const)("keeps original checks with %s input guard", async mode => {
    const f = await fixture()
    if (mode === "factory-default-namespace") delete f.config.configurable!.checkpoint_ns
    const message = new HumanMessage({ id: randomUUID(), content: "actual input guard comparison" })
    appDb.upsertThreadMessages(f.threadId, [{ id: message.id!, role: "user",
      content: String(message.content), created_at: new Date() }])
    const source = captureFunctionConversationNativeInput({ message, threadId: f.threadId,
      workspace: f.workspace, physicalRunId: f.physicalRunId, signal: f.controller.signal,
      origin: { kind: "composer" }, assertCurrent: f.guard })
    const retention = createFunctionConversationNativeInputRetention({ source,
      runtime: f.runtime, store: f.store, agentId: "main", flush: () => undefined,
      register: () => undefined })
    cleanups.push(async () => { retention.close(); await retention.whenDrained() })
    const prototype = FunctionConversationNativeKeeper.prototype
    const retain = prototype.retain
    let actualAdmission: FunctionConversationNativeKeeperAdmission | undefined
    vi.spyOn(prototype, "retain").mockImplementation(function (this: FunctionConversationNativeKeeper, admission) {
      expect(readFunctionConversationNativeInputCurrent(admission.assertCurrent, f.runtime,
        admission.producer, admission.occurrence)).toBeDefined()
      expect(readFunctionConversationNativeInputCurrent(admission.assertCurrent, f.runtime,
        admission.producer, {})).toBeUndefined()
      expect(readFunctionConversationNativeInputCurrent(admission.assertCurrent, { ...f.runtime },
        admission.producer, admission.occurrence)).toBeUndefined()
      expect(readFunctionConversationNativeInputCurrent(() => admission.assertCurrent(), f.runtime,
        admission.producer, admission.occurrence)).toBeUndefined()
      actualAdmission = mode === "wrapper" ? { ...admission,
        assertCurrent: () => admission.assertCurrent() } : admission
      return retain.call(this, actualAdmission)
    })
    const target = prototype as unknown as PrivateKeeperGuard
    const original = target.guard
    let measured = false
    vi.spyOn(target, "guard").mockImplementation(function (this: FunctionConversationNativeKeeper, work, signal, mutation) {
      const admission = actualAdmission
      if (!measured && admission) {
        measured = true
        const beforeRuntime = f.guard.mock.calls.length
        f.runtime.assertCurrent()
        const runtimeChecks = f.guard.mock.calls.length - beforeRuntime
        const beforeFull = f.guard.mock.calls.length
        f.runtime.assertCurrent(); mutation(); admission.assertCurrent()
        f.runtime.target.assertCurrent(); f.runtime.destination.assertCurrent()
        const full = f.guard.mock.calls.length - beforeFull
        const beforeActual = f.guard.mock.calls.length
        Reflect.apply(original, this, [work, signal, mutation])
        expect(f.guard.mock.calls.length - beforeActual)
          .toBe(full - (mode !== "wrapper" ? runtimeChecks : 0))
        return
      }
      Reflect.apply(original, this, [work, signal, mutation])
    })
    await retention.retainInput({ messages: [message] }, f.config)
    expect(measured).toBe(true)
    expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(1)
  })
})


describe("input current final callback fences", () => {
  it.each(["data", "authority", "config", "getter", "reentry"] as const)(
    "rejects %s changes within the original callbacks", async change => {
      const f = await fixture()
      const message = new HumanMessage({ id: randomUUID(), content: "original private input" })
      appDb.upsertThreadMessages(f.threadId, [{ id: message.id!, role: "user",
        content: String(message.content), created_at: new Date() }])
      const source = captureFunctionConversationNativeInput({ message, threadId: f.threadId,
        workspace: f.workspace, physicalRunId: f.physicalRunId, signal: f.controller.signal,
        origin: { kind: "composer" }, assertCurrent: f.guard })
      const retention = createFunctionConversationNativeInputRetention({ source,
        runtime: f.runtime, store: f.store, agentId: "main", flush: () => undefined,
        register: () => undefined })
      cleanups.push(async () => { retention.close(); await retention.whenDrained() })
      const target = FunctionConversationNativeKeeper.prototype as unknown as PrivateKeeperGuard
      const original = target.guard
      let armed = false, fired = false, getterCalls = 0
      vi.spyOn(target, "guard").mockImplementation(function (this: FunctionConversationNativeKeeper, work, signal, mutation) {
        if (!armed) {
          armed = true
          let callbacks = 0
          f.action.callback = () => {
            callbacks++
            if (callbacks !== (change === "reentry" ? 1 : 7)) return
            fired = true
            f.action.callback = undefined
            if (change === "data") message.content = "changed original input"
            else if (change === "authority") f.changePolicy()
            else if (change === "config") f.config.configurable!.thread_id = "changed-thread"
            else if (change === "getter") Object.defineProperty(f.config.configurable!, "thread_id",
              { configurable: true, get() { getterCalls++; return f.threadId } })
            else {
              // An adversarial callback may swallow its own reentry error; the work stays poisoned.
              try { Reflect.apply(original, this, [work, signal, mutation]) } catch { /* expected */ }
            }
          }
        }
        Reflect.apply(original, this, [work, signal, mutation])
      })
      await expect(retention.retainInput({ messages: [message] }, f.config)).rejects.toThrow()
      expect(fired).toBe(true)
      expect(getterCalls).toBe(0)
      expect(f.store.readRows(f.runtime.target.ref)).toHaveLength(0)
    })
})
