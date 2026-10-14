import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { projectFunctionSessionApiMessages } from "./v2/session-api-transcript"
import { FunctionConversationCoordinator } from "./v2/conversation-coordinator"
import { FunctionConversationStore } from "../db/function-conversation-store"
import { captureThreadIncarnation, matchesThreadIncarnation } from
  "../services/thread-incarnation"
import { ModsManager, type ModThreadBinding } from "./manager"
import { DEFAULT_MOD_POLICY, ManagedModPolicy } from "./policy"
import { ModRuntimeAuthorities } from "./runtime-instance"
import { captureFunctionConversationNativePolicyData, readFunctionConversationNativePolicySource,
  readFunctionConversationNativeSharedPolicySource,
  snapshotFunctionNativeDeployment } from "./native-conversation-policy-source"

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
  directory = mkdtempSync(join(tmpdir(), "cmb-native-policy-source-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close() })
afterAll(async () => {
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(withRules = false) {
  const root = mkdtempSync(join(directory, "workspace-"))
  let physicalChecks = 0, physicalAction: (() => void) | undefined
  let globalAction: (() => void) | undefined
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined, undefined, { ...DEFAULT_MOD_POLICY, required: false,
      ...(withRules ? { denyTools: ["actual_private_tool"],
        redactLiterals: ["actual-private-rule"] } : {}) }, () => {
      globalAction?.()
      return true
    })
  manager.configure(root, false, true)
  const workspace = manager.workspaceKey(root), threadId = randomUUID(), turnId = randomUUID()
  const physicalRunId = randomUUID(), thread = appDb.createThread(threadId,
    { workspacePath: workspace })
  const database = appDb.getDb(), incarnation = captureThreadIncarnation(thread)
  const controller = new AbortController()
  const guard = () => {
    physicalChecks++
    controller.signal.throwIfAborted()
    if (appDb.getDb() !== database ||
      !matchesThreadIncarnation(appDb.getThreadCore(threadId), incarnation))
      throw Error("ACTUAL_POLICY_THREAD_RETIRED")
    physicalAction?.()
  }
  const lease = claimLocalThreadRunLease({ threadId, runId: physicalRunId, owner: "desktop" })
  if (!lease.acquired) throw Error("ACTUAL_POLICY_LEASE_REQUIRED")
  const physical: ModThreadBinding = { workspace, threadId, turnId,
    signal: controller.signal, assertLive: guard }
  const instance = manager.createRuntimeAuthority(physical)
  const unbind = manager.bindThread({ ...physical, runtimeAuthority: instance.authority })
  const store = new FunctionConversationStore(database)
  const coordinator = new FunctionConversationCoordinator(store, {
    authorities: { get: scope => manager.getFunctionConversationAuthority(scope) },
    assertScope: context => {
      guard()
      if (context.workspace !== workspace || context.threadId !== threadId)
        throw Error("ACTUAL_POLICY_OWNER_CHANGED")
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
  const runtime = manager.captureFunctionNativeConversationRuntime(instance.authority)
  if (!runtime) throw Error("ACTUAL_POLICY_RUNTIME_REQUIRED")
  const admission = runtime.capturePolicy()
  const source = readFunctionConversationNativePolicySource(admission, runtime)
  if (!source) throw Error("ACTUAL_POLICY_SOURCE_REQUIRED")
  const policy = admission.value.identity
  if (!(policy instanceof ManagedModPolicy)) throw Error("ACTUAL_MANAGED_POLICY_REQUIRED")
  cleanups.push(() => {
    physicalAction = undefined; globalAction = undefined
    runtime.close(); closeOwner(); coordinator.registry.close(); unbind(); instance.release()
    releaseLocalThreadRunLease(threadId, "desktop", physicalRunId)
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, workspace, runtime, coordinator, controller, unbind, instance,
    source, admission, policy, checks: () => physicalChecks,
    physicalAction: (action: () => void) => { physicalAction = action },
    globalAction: (action: () => void) => { globalAction = action } }
}

describe("actual Manager native policy source", () => {
  it("does not replace the independent Main or unknown policy checks with a Shared guard", async () => {
    const value = await fixture(), before = value.checks()
    expect(readFunctionConversationNativeSharedPolicySource(value.admission, value.runtime))
      .toBeUndefined()
    expect(readFunctionConversationNativeSharedPolicySource(Object.freeze({ ...value.admission }),
      value.runtime)).toBeUndefined()
    let callbacks = 0
    const unknown = Object.freeze({ value: value.admission.value,
      assertCurrent() { callbacks++; value.admission.assertCurrent() } })
    expect(readFunctionConversationNativeSharedPolicySource(unknown, value.runtime)).toBeUndefined()
    expect(callbacks).toBe(0)
    expect(value.checks()).toBe(before)
    value.runtime.assertCurrent()
    const afterRuntime = value.checks()
    expect(afterRuntime).toBeGreaterThan(before)
    value.admission.assertCurrent()
    expect(value.checks()).toBeGreaterThan(afterRuntime)
  })

  it("certifies only the original admission and exact actual runtime", async () => {
    const value = await fixture()
    expect(readFunctionConversationNativePolicySource(value.admission, value.runtime))
      .toBe(value.source)
    expect(readFunctionConversationNativePolicySource(Object.freeze({ ...value.admission }),
      value.runtime)).toBeUndefined()
    expect(readFunctionConversationNativePolicySource(value.admission,
      Object.freeze({ ...value.runtime }))).toBeUndefined()
    expect(readFunctionConversationNativePolicySource(Object.freeze({
      value: value.admission.value, assertCurrent: () => undefined }), value.runtime))
      .toBeUndefined()
    expect(Object.isFrozen(value.admission.value.deployment)).toBe(true)
    expect(Object.isFrozen(value.admission.value.deployment.denyTools)).toBe(true)
  })

  it("retains one original full physical guard and a callback-free map/policy tail", async () => {
    const value = await fixture()
    let start = value.checks()
    value.runtime.assertCurrent()
    const original = value.checks() - start
    expect(original).toBeGreaterThan(0)
    start = value.checks()
    value.source.assertCurrent()
    expect(value.checks() - start).toBe(original)
    start = value.checks()
    value.source.assertTail()
    expect(value.checks()).toBe(start)
  })

  it.each([
    [Symbol.iterator, "getter"], [Symbol.iterator, "replacement"],
    ["some", "getter"], ["some", "replacement"],
    ["push", "getter"], ["push", "replacement"]
  ] as const)("keeps the real policy tail pure with a late Array %s %s", async (key, attack) => {
    const value = await fixture(true)
    value.source.assertCurrent()
    const expected = captureFunctionConversationNativePolicyData(value.policy)
    const before = value.checks(), original = Object.getOwnPropertyDescriptor(Array.prototype, key)
    let calls = 0, failure: unknown, failed = false
    const forbidden = () => { calls++; throw Error("LATE_POLICY_ARRAY_CALLBACK") }
    try {
      Object.defineProperty(Array.prototype, key, attack === "getter"
        ? { configurable: true, get: forbidden }
        : { configurable: true, writable: true, value: forbidden })
      try { value.source.assertTail() } catch (error) { failed = true; failure = error }
    } finally {
      if (original) Object.defineProperty(Array.prototype, key, original)
      else Reflect.deleteProperty(Array.prototype, key)
    }
    expect(failed).toBe(false)
    expect(failure).toBeUndefined()
    expect(calls).toBe(0)
    expect(value.checks()).toBe(before)
    expect(captureFunctionConversationNativePolicyData(value.policy)).toEqual(expected)
    expect(expected.deployment.denyTools).toEqual(["actual_private_tool"])
    expect(expected.deployment.redactLiterals).toEqual(["actual-private-rule"])
    value.policy.deployment.redactLiterals[0] = "actual-changed-rule"
    expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
    value.policy.deployment.redactLiterals[0] = "actual-private-rule"
    value.source.assertTail()
    value.instance.release()
    expect(() => value.source.assertTail()).toThrow()
    expect(calls).toBe(0)
  })

  it("checks the original run and target signals without executing their later methods", async () => {
    const value = await fixture()
    const signals = new Set([value.runtime.signal, value.runtime.target.signal])
    const originals = new Map<AbortSignal, PropertyDescriptor | undefined>()
    let calls = 0
    try {
      for (const signal of signals) {
        originals.set(signal, Object.getOwnPropertyDescriptor(signal, "throwIfAborted"))
        Object.defineProperty(signal, "throwIfAborted", { configurable: true,
          get() { calls++; throw Error("LATE_POLICY_SIGNAL_METHOD") } })
      }
      value.source.assertTail()
      expect(calls).toBe(0)
    } finally {
      for (const [signal, descriptor] of originals) {
        if (descriptor) Object.defineProperty(signal, "throwIfAborted", descriptor)
        else Reflect.deleteProperty(signal, "throwIfAborted")
      }
    }
    value.controller.abort(Error("ACTUAL_POLICY_SIGNAL_ABORT"))
    expect(() => value.source.assertTail()).toThrow()
    expect(calls).toBe(0)
  })

  it.each(["getter", "replacement"] as const)(
    "checks the physical authority signal without executing a later %s", async attack => {
      const value = await fixture(), signal = value.controller.signal
      const original = Object.getOwnPropertyDescriptor(signal, "throwIfAborted")
      const forbidden = vi.fn(() => { throw Error("LATE_PHYSICAL_AUTHORITY_METHOD") })
      const start = value.checks()
      try {
        Object.defineProperty(signal, "throwIfAborted", attack === "getter"
          ? { configurable: true, get: forbidden }
          : { configurable: true, value: forbidden })
        value.source.assertTail()
        expect(forbidden).not.toHaveBeenCalled()
        expect(value.checks()).toBe(start)
        value.controller.abort(Error("ACTUAL_PHYSICAL_AUTHORITY_ABORT"))
        expect(() => value.source.assertTail()).toThrow()
        expect(forbidden).not.toHaveBeenCalled()
      } finally {
        if (original) Object.defineProperty(signal, "throwIfAborted", original)
        else Reflect.deleteProperty(signal, "throwIfAborted")
      }
    })

  it.each(["runtimeAuthorities", "bindings", "settings", "functionNativeConversationRuntimes",
    "functionConversationNativeRuns", "functionConversationRuntimes",
    "functionConversationSharedScopes", "functionConversationSharedProducers", "policy",
    "functionConversations"] as const)(
    "rejects the actual Manager's late %s getter before its database side effect", async key => {
      const value = await fixture()
      const descriptor = Object.getOwnPropertyDescriptor(value.manager, key)
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_MANAGER_FIELD_REQUIRED")
      const before = appDb.getThreadCore(value.runtime.destination.threadId)
      const forbidden = vi.fn(() => {
        appDb.getDb().run("UPDATE threads SET title='FORBIDDEN_POLICY_GETTER' WHERE thread_id=?",
          [value.runtime.destination.threadId])
        return descriptor.value
      })
      const start = value.checks()
      try {
        Object.defineProperty(value.manager, key, { configurable: true, get: forbidden })
        expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
        expect(forbidden).not.toHaveBeenCalled()
        expect(value.checks()).toBe(start)
        expect(appDb.getThreadCore(value.runtime.destination.threadId)).toEqual(before)
      } finally { Object.defineProperty(value.manager, key, descriptor) }
    })

  it.each(["runtimeAuthorities", "bindings", "settings", "functionNativeConversationRuntimes",
    "functionConversationNativeRuns", "functionConversationRuntimes",
    "functionConversationSharedScopes", "functionConversationSharedProducers", "policy",
    "functionConversations"] as const)(
    "rejects replacement of the actual %s field without querying its Proxy", async key => {
      const value = await fixture(), descriptor = Object.getOwnPropertyDescriptor(value.manager, key)
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_MANAGER_FIELD_REQUIRED")
      let traps = 0
      const replacement = new Proxy({}, { get: () => { traps++; return undefined },
        getPrototypeOf: () => { traps++; return Object.prototype } })
      try {
        Object.defineProperty(value.manager, key, { ...descriptor, value: replacement })
        expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
        expect(traps).toBe(0)
      } finally { Object.defineProperty(value.manager, key, descriptor) }
    })

  it.each(["bindings", "settings", "functionNativeConversationRuntimes",
    "functionConversationNativeRuns", "functionConversationRuntimes",
    "functionConversationSharedScopes", "functionConversationSharedProducers"] as const)(
    "reads original %s entries without evaluating that collection's own get", async key => {
      const value = await fixture(), field = Object.getOwnPropertyDescriptor(value.manager, key)
      if (!field || !("value" in field) || !(field.value instanceof Map ||
        field.value instanceof WeakMap)) throw Error("ACTUAL_MANAGER_COLLECTION_REQUIRED")
      const collection: object = field.value
      const descriptor = Object.getOwnPropertyDescriptor(collection, "get")
      const forbidden = vi.fn(() => { throw Error("LATE_NATIVE_POLICY_COLLECTION_GET") })
      try {
        for (const attack of ["getter", "replacement"] as const) {
          Object.defineProperty(collection, "get", attack === "getter"
            ? { configurable: true, get: forbidden }
            : { configurable: true, value: forbidden })
          expect(() => value.source.assertTail()).not.toThrow()
        }
        expect(forbidden).not.toHaveBeenCalled()
      } finally {
        if (descriptor) Object.defineProperty(collection, "get", descriptor)
        else Reflect.deleteProperty(collection, "get")
      }
    })

  it("retains the exact original registry relationship with a genuine foreign registry", async () => {
    const value = await fixture(), foreign = new ModRuntimeAuthorities()
    const descriptor = Object.getOwnPropertyDescriptor(value.manager, "runtimeAuthorities")
    if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_MANAGER_REGISTRY_REQUIRED")
    const sameScope = foreign.create(value.instance.authority)
    const forbidden = vi.fn(() => sameScope.authority)
    try {
      Object.defineProperty(foreign, "get", { configurable: true, get: forbidden })
      Object.defineProperty(value.manager, "runtimeAuthorities", { ...descriptor, value: foreign })
      expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(forbidden).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(value.manager, "runtimeAuthorities", descriptor)
      foreign.close()
    }
  })

  it.each(["proof", "binding"] as const)(
    "rejects the actual native run record's late %s getter without reading it", async key => {
      const value = await fixture()
      const field = Object.getOwnPropertyDescriptor(value.manager, "functionConversationNativeRuns")
      if (!field || !("value" in field) || !(field.value instanceof WeakMap))
        throw Error("ACTUAL_NATIVE_RUN_MAP_REQUIRED")
      const record: unknown = Reflect.apply(WeakMap.prototype.get, field.value,
        [value.instance.authority])
      if (!record || typeof record !== "object") throw Error("ACTUAL_NATIVE_RUN_RECORD_REQUIRED")
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_NATIVE_RUN_FIELD_REQUIRED")
      const forbidden = vi.fn(() => descriptor.value)
      try {
        Object.defineProperty(record, key, { configurable: true, get: forbidden })
        expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
        expect(forbidden).not.toHaveBeenCalled()
      } finally { Object.defineProperty(record, key, descriptor) }
    })

  it("rejects a late epoch accessor on the current actual settings object", async () => {
    const value = await fixture(), field = Object.getOwnPropertyDescriptor(value.manager, "settings")
    if (!field || !("value" in field) || !(field.value instanceof Map))
      throw Error("ACTUAL_POLICY_SETTINGS_MAP_REQUIRED")
    const settings: unknown = Reflect.apply(Map.prototype.get, field.value, [value.workspace])
    if (!settings || typeof settings !== "object") throw Error("ACTUAL_POLICY_SETTINGS_REQUIRED")
    const descriptor = Object.getOwnPropertyDescriptor(settings, "epoch")
    if (!descriptor || !("value" in descriptor)) throw Error("ACTUAL_POLICY_EPOCH_REQUIRED")
    const forbidden = vi.fn(() => descriptor.value)
    try {
      Object.defineProperty(settings, "epoch", { configurable: true, get: forbidden })
      expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(forbidden).not.toHaveBeenCalled()
    } finally { Object.defineProperty(settings, "epoch", descriptor) }
  })

  it.each(["release", "replacement"] as const)(
    "rejects true authority %s during the original physical callback", async attack => {
      const value = await fixture()
      let changed = false
      value.physicalAction(() => {
        if (changed) return
        changed = true
        if (attack === "release") value.instance.release()
        else value.manager.createRuntimeAuthority({ workspace: value.workspace,
          threadId: value.runtime.destination.threadId, turnId: randomUUID(),
          signal: value.controller.signal })
      })
      expect(() => value.source.assertCurrent()).toThrow()
      expect(changed).toBe(true)
      expect(() => value.source.assertTail()).toThrow()
      expect(appDb.getThreadMessages(value.runtime.destination.threadId)).toEqual([])
    })

  it.each(["close", "registry-close", "unbind", "abort"] as const)(
    "rejects %s from inside the original actual physical binding callback", async kind => {
      const value = await fixture()
      value.physicalAction(() => {
        if (kind === "close") value.runtime.close()
        else if (kind === "registry-close") value.coordinator.registry.closeOwner(value.runtime.owner)
        else if (kind === "unbind") value.unbind()
        else value.controller.abort(Error("ACTUAL_POLICY_ABORT"))
      })
      expect(() => value.source.assertCurrent()).toThrow()
      expect(() => value.source.assertTail()).toThrow()
    })

  it("catches a synchronous global switch callback that retires the original runtime", async () => {
    const value = await fixture()
    value.globalAction(() => value.runtime.close())
    expect(() => value.source.assertCurrent()).toThrow()
    expect(() => value.source.assertTail()).toThrow()
  })

  it("rechecks the current epoch and policy data without trusting the frozen copy", async () => {
    const value = await fixture()
    value.policy.deployment.redactLiterals.push("current-rule")
    expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(value.admission.value.deployment.redactLiterals).toEqual([])
  })

  it("rejects a new real configuration epoch", async () => {
    const value = await fixture()
    value.manager.configure(value.workspace, true, true)
    expect(() => value.source.assertTail()).toThrow()
    expect(() => value.source.assertCurrent()).toThrow()
  })

  it("never evaluates an actual deployment getter or custom toJSON", async () => {
    const value = await fixture()
    let getters = 0, jsonCalls = 0
    Object.defineProperty(value.policy.deployment, "required", { enumerable: true,
      configurable: true, get: () => { getters++; return true } })
    expect(() => value.source.assertCurrent()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(() => value.runtime.capturePolicy()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(getters).toBe(0)
    Object.defineProperty(value.policy.deployment, "required", { enumerable: true,
      configurable: true, writable: true, value: false })
    Object.defineProperty(value.policy.deployment, "toJSON", { enumerable: true,
      configurable: true, value: () => { jsonCalls++; return DEFAULT_MOD_POLICY } })
    expect(() => value.source.assertTail()).toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(jsonCalls).toBe(0)
  })
})

describe("native policy descriptor copy", () => {
  it("copies fixed primitives and dense arrays without sharing mutable source arrays", () => {
    const original = { ...DEFAULT_MOD_POLICY, denyTools: ["one"], redactLiterals: ["secret"] }
    const copy = snapshotFunctionNativeDeployment(original)
    original.denyTools.push("two")
    expect(copy.denyTools).toEqual(["one"])
    expect(Object.isFrozen(copy.redactLiterals)).toBe(true)
  })

  it.each(["proxy", "getter", "extra", "sparse", "nonprimitive"] as const)(
    "rejects %s before evaluating foreign behavior", kind => {
      let evaluated = 0
      const original: Record<string, unknown> = { ...DEFAULT_MOD_POLICY,
        denyTools: [], redactLiterals: [] }
      let input: unknown = original
      if (kind === "proxy") input = new Proxy(original, {
        ownKeys: () => { evaluated++; return Reflect.ownKeys(original) },
        getPrototypeOf: () => { evaluated++; return Object.prototype }
      })
      else if (kind === "getter") Object.defineProperty(original, "required", {
        enumerable: true, get: () => { evaluated++; return false } })
      else if (kind === "extra") original.unknown = "no"
      else if (kind === "sparse") original.denyTools = new Array(1)
      else original.redactLiterals = [{ toJSON: () => { evaluated++; return "secret" } }]
      expect(() => snapshotFunctionNativeDeployment(input)).toThrow("MODS_CALL_SCOPE_CHANGED")
      expect(evaluated).toBe(0)
    })

  it("rejects a policy field getter before deployment extraction", () => {
    let evaluated = 0
    const policy = Object.defineProperty({ digest: "a".repeat(64) }, "deployment", {
      enumerable: true, get: () => { evaluated++; return DEFAULT_MOD_POLICY } })
    expect(() => captureFunctionConversationNativePolicyData(policy))
      .toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(evaluated).toBe(0)
  })
})
