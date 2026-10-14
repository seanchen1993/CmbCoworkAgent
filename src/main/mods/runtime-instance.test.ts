import { expect, it, vi } from "vitest"
import { assertModRuntimeAuthority, isModRuntimeAuthorityDataCurrent,
  isModRuntimeAuthorityDataCurrentForRegistry,
  isModRuntimeAuthorityCallbackFreeForRegistry,
  captureModNativeSignalShape,
  ModRuntimeAuthorities } from "./runtime-instance"

it("actively disposes registered runtime resources exactly once on replacement or cancellation", () => {
  const registry = new ModRuntimeAuthorities()
  const controller = new AbortController()
  const first = registry.create(scope, controller.signal)
  const calls: string[] = []
  registry.registerResource(first.authority, () => calls.push("first"))
  const detach = registry.registerResource(first.authority, () => calls.push("detached"))
  detach()
  const next = registry.create(scope)
  expect(calls).toEqual(["first"])
  controller.abort()
  first.release()
  expect(calls).toEqual(["first"])
  expect(() => registry.registerResource(first.authority, () => {})).toThrow(
    "MODS_RUNTIME_INSTANCE_EXPIRED"
  )
  registry.registerResource(next.authority, () => calls.push("next"))
  registry.closeThread(scope.threadId)
  expect(calls).toEqual(["first", "next"])
})

const scope = { workspace: "project", threadId: "thread", turnId: "turn" }

it("pins each private authority reader to its original registry rather than equal scope", () => {
  const original = new ModRuntimeAuthorities(), foreign = new ModRuntimeAuthorities()
  const first = original.create(scope), second = foreign.create(scope)
  let traps = 0
  const proxy = new Proxy(first.authority, {
    get: () => { traps++; throw Error("FOREIGN_AUTHORITY_PROPERTY") },
    getPrototypeOf: () => { traps++; throw Error("FOREIGN_AUTHORITY_PROTOTYPE") }
  })
  try {
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, first.authority)).toBe(true)
    expect(isModRuntimeAuthorityDataCurrentForRegistry(foreign, first.authority)).toBe(false)
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, second.authority)).toBe(false)
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, { ...first.authority })).toBe(false)
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, proxy)).toBe(false)
    expect(traps).toBe(0)
    first.release()
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, first.authority)).toBe(false)
    expect(isModRuntimeAuthorityDataCurrentForRegistry(foreign, second.authority)).toBe(true)
  } finally { original.close(); foreign.close() }
})

it("uses the same private registry lineage without reading its later public methods", () => {
  const original = new ModRuntimeAuthorities(), instance = original.create(scope)
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const forbidden = vi.fn(() => { throw Error("LATE_PUBLIC_REGISTRY_METHOD") })
  try {
    for (const key of ["get", "isCurrent"] as const) {
      originals.set(key, Object.getOwnPropertyDescriptor(original, key))
      Object.defineProperty(original, key, { configurable: true, get: forbidden })
    }
    expect(isModRuntimeAuthorityDataCurrentForRegistry(original, instance.authority)).toBe(true)
    expect(forbidden).not.toHaveBeenCalled()
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(original, key, descriptor)
      else Reflect.deleteProperty(original, key)
    }
    original.close()
  }
  expect(isModRuntimeAuthorityDataCurrentForRegistry(original, instance.authority)).toBe(false)
})

it.each(["getter", "replacement"] as const)(
  "reads private authority and ancestry WeakMaps before a later prototype %s can run", attack => {
    const registry = new ModRuntimeAuthorities(), parent = registry.create(scope)
    const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority)
    const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
    let calls = 0
    const forbidden = () => { calls++; throw Error("LATE_WEAK_MAP_PROTOTYPE_GET") }
    const observed: boolean[] = []
    try {
      Object.defineProperty(WeakMap.prototype, "get", attack === "getter"
        ? { configurable: true, get: forbidden }
        : { configurable: true, writable: true, value: forbidden })
      observed.push(isModRuntimeAuthorityDataCurrent(child.authority))
      observed.push(isModRuntimeAuthorityDataCurrentForRegistry(registry, child.authority))
      parent.release()
      observed.push(isModRuntimeAuthorityDataCurrent(child.authority))
      observed.push(isModRuntimeAuthorityDataCurrentForRegistry(registry, child.authority))
    } finally {
      Object.defineProperty(WeakMap.prototype, "get", original)
      registry.close()
    }
    expect(observed).toEqual([true, true, false, false])
    expect(calls).toBe(0)
  })

it("reads original parent and child cancellation without invoking signal accessors", () => {
  const registry = new ModRuntimeAuthorities(), parentCut = new AbortController()
  const childCut = new AbortController(), getter = vi.fn(() => false)
  const parent = registry.create(scope, parentCut.signal)
  const child = registry.create({ ...scope, agentId: "child" }, childCut.signal, parent.authority)
  Object.defineProperty(parentCut.signal, "aborted", { get: getter })
  Object.defineProperty(childCut.signal, "aborted", { get: getter })
  try {
    expect(isModRuntimeAuthorityDataCurrent(parent.authority)).toBe(true)
    expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(true)
    expect(isModRuntimeAuthorityDataCurrent({ ...child.authority })).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    childCut.abort()
    expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(false)
    expect(isModRuntimeAuthorityDataCurrent(parent.authority)).toBe(true)
    parentCut.abort()
    expect(isModRuntimeAuthorityDataCurrent(parent.authority)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  } finally { registry.close() }
})

it("fails closed on a non-native signal without reading its replaced data getter", () => {
  const registry = new ModRuntimeAuthorities(), getter = vi.fn(() => false)
  const signal = { aborted: false, throwIfAborted() { /* non-native test stub */ }, addEventListener() { /* test stub */ },
    removeEventListener() { /* test stub */ } } as unknown as AbortSignal
  const original = registry.create(scope, signal)
  Object.defineProperty(signal, "aborted", { get: getter })
  try {
    expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  } finally { registry.close() }
})

it.each(["closed", "entries"] as const)(
  "rejects a genuine registry's later %s getter without executing it", key => {
    const registry = new ModRuntimeAuthorities(), original = registry.create(scope)
    const descriptor = Object.getOwnPropertyDescriptor(registry, key)!
    const getter = vi.fn(() => descriptor.value)
    try {
      Object.defineProperty(registry, key, { configurable: true, get: getter })
      expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(false)
      expect(getter).not.toHaveBeenCalled()
      Object.defineProperty(registry, key, descriptor)
      expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(true)
      registry.close()
      expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(false)
    } finally {
      Object.defineProperty(registry, key, descriptor)
      registry.close()
    }
  }
)

it.each(["parent", "child"] as const)(
  "checks %s's fixed ancestry fields without executing late getters", ancestor => {
    for (const key of ["key", "signal", "parent"] as const) {
      const registry = new ModRuntimeAuthorities()
      const parent = registry.create(scope, new AbortController().signal)
      const child = registry.create({ ...scope, agentId: "child" },
        new AbortController().signal, parent.authority)
      const entries = Object.getOwnPropertyDescriptor(registry, "entries")!.value as
        Map<string, object>
      const entry = entries.get(JSON.stringify([scope.workspace, scope.threadId,
        ancestor === "child" ? "child" : "main"]))!
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)!
      const getter = vi.fn(() => descriptor.value)
      try {
        Object.defineProperty(entry, key, { configurable: true, get: getter })
        expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(false)
        expect(getter).not.toHaveBeenCalled()
        Object.defineProperty(entry, key, descriptor)
        expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(true)
        parent.release()
        expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(false)
      } finally {
        Object.defineProperty(entry, key, descriptor)
        registry.close()
      }
    }
  }
)

it.each(["getter", "replacement"] as const)(
  "uses the original entry Map read after a later %s override", attack => {
    const registry = new ModRuntimeAuthorities(), original = registry.create(scope)
    const entries = Object.getOwnPropertyDescriptor(registry, "entries")!.value as Map<string, object>
    const own = Object.getOwnPropertyDescriptor(entries, "get")
    const forbidden = vi.fn(() => { throw Error("LATE_ENTRY_MAP_READ") })
    try {
      Object.defineProperty(entries, "get", attack === "getter"
        ? { configurable: true, get: forbidden }
        : { configurable: true, value: forbidden })
      expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(true)
      expect(forbidden).not.toHaveBeenCalled()
    } finally {
      if (own) Object.defineProperty(entries, "get", own)
      else Reflect.deleteProperty(entries, "get")
      registry.close()
    }
    expect(isModRuntimeAuthorityDataCurrent(original.authority)).toBe(false)
  }
)

it("reads original private authority and ancestors without invoking replaceable public guards", () => {
  const registry = new ModRuntimeAuthorities()
  const parent = registry.create(scope)
  const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority)
  const counterfeit = { ...child.authority, assertLive() { throw Error("CALLER_GUARD") } }
  registry.isCurrent = () => true
  expect(isModRuntimeAuthorityDataCurrent(counterfeit)).toBe(false)
  expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(true)
  parent.release()
  expect(isModRuntimeAuthorityDataCurrent(child.authority)).toBe(false)
  const nextParent = registry.create(scope)
  const nextChild = registry.create({ ...scope, agentId: "child" }, undefined, nextParent.authority)
  expect(isModRuntimeAuthorityDataCurrent(nextChild.authority)).toBe(true)
  child.release()
  expect(isModRuntimeAuthorityDataCurrent(nextChild.authority)).toBe(true)
  nextChild.release()
  expect(isModRuntimeAuthorityDataCurrent(nextChild.authority)).toBe(false)
  registry.close()
})

it("continues child and parent revocation after a disposer throws and permits reentrant cleanup", () => {
  const registry = new ModRuntimeAuthorities()
  const parent = registry.create(scope)
  const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority)
  const calls: string[] = []
  registry.registerResource(child.authority, () => {
    calls.push("child throws")
    throw Error("cleanup")
  })
  registry.registerResource(child.authority, () => calls.push("child finishes"))
  registry.registerResource(parent.authority, () => {
    calls.push("parent throws")
    throw Error("cleanup")
  })
  registry.registerResource(parent.authority, () => {
    calls.push("parent finishes")
    parent.release()
  })
  expect(() => parent.release()).not.toThrow()
  parent.release()
  child.release()
  expect(calls).toEqual(["child throws", "child finishes", "parent throws", "parent finishes"])
  expect(() => child.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => parent.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
})

it("expires a same-agent same-turn predecessor without letting its disposer revoke the replacement", () => {
  const registry = new ModRuntimeAuthorities()
  const first = registry.create(scope)
  const next = registry.create(scope)
  expect(() => first.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  first.release()
  expect(registry.get(scope)).toBe(next.authority)
  assertModRuntimeAuthority(next.authority, scope)
  expect(() => assertModRuntimeAuthority(next.authority, { ...scope, agentId: "child" })).toThrow(
    "MODS_RUNTIME_SCOPE_CHANGED"
  )
  next.release()
  expect(registry.get(scope)).toBeUndefined()
})

it("revokes descendants on parent replacement and rejects a foreign parent", () => {
  const registry = new ModRuntimeAuthorities()
  const parent = registry.create(scope)
  const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority, "task")
  const grandchild = registry.create(
    { ...scope, agentId: "grandchild" },
    undefined,
    child.authority
  )
  expect(() => registry.create(scope, undefined, grandchild.authority)).toThrow(
    "MODS_RUNTIME_SCOPE_CHANGED"
  )
  parent.authority.assertLive()
  expect(child.authority.parentCallId).toBe("task")
  registry.create(scope)
  expect(() => child.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => grandchild.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  const foreign = new ModRuntimeAuthorities().create(scope)
  expect(() =>
    registry.create({ ...scope, agentId: "child" }, undefined, foreign.authority)
  ).toThrow("MODS_RUNTIME_SCOPE_CHANGED")
})

it("bounds live authority entries without evicting an unrelated active runtime", () => {
  const registry = new ModRuntimeAuthorities()
  const first = registry.create(scope)
  for (let index = 1; index < 100; index++)
    registry.create({ ...scope, threadId: `thread-${index}` })
  expect(() => registry.create({ ...scope, threadId: "overflow" })).toThrow("MODS_RUNTIME_CAPACITY")
  first.authority.assertLive()
  registry.close()
})

it("closes scopes on abort, thread close and application close without crossing projects", () => {
  const registry = new ModRuntimeAuthorities(),
    controller = new AbortController()
  const first = registry.create(scope, controller.signal)
  const other = registry.create({ ...scope, workspace: "other", threadId: "other" })
  controller.abort()
  expect(() => first.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(registry.get(scope)).toBeUndefined()
  const second = registry.create(scope)
  registry.closeThread(scope.threadId)
  expect(() => second.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  other.authority.assertLive()
  registry.close()
  expect(() => other.authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(() => registry.create(scope)).toThrow("MODS_RUNTIME_CLOSED")
})

it("classifies every actual authority ancestor signal without invoking callbacks", () => {
  const registry = new ModRuntimeAuthorities(), controller = new AbortController()
  const parent = registry.create(scope, controller.signal)
  const child = registry.create({ ...scope, agentId: "child" }, undefined, parent.authority)
  let calls = 0
  try {
    expect(isModRuntimeAuthorityCallbackFreeForRegistry(registry, child.authority)).toBe(true)
    Object.defineProperty(controller.signal, "throwIfAborted", { configurable: true,
      get: () => { calls++; return () => {} } })
    expect(isModRuntimeAuthorityCallbackFreeForRegistry(registry, child.authority)).toBe(false)
    expect(calls).toBe(0)
    Reflect.deleteProperty(controller.signal, "throwIfAborted")
    const key = Symbol("signal-callback")
    Object.defineProperty(controller.signal, key, { configurable: true,
      get: () => { calls++; return false } })
    expect(isModRuntimeAuthorityCallbackFreeForRegistry(registry, child.authority)).toBe(false)
    expect(calls).toBe(0)
    Reflect.deleteProperty(controller.signal, key)
    expect(isModRuntimeAuthorityCallbackFreeForRegistry(registry, child.authority)).toBe(true)
    controller.abort()
    expect(isModRuntimeAuthorityCallbackFreeForRegistry(registry, child.authority)).toBe(false)
  } finally { registry.close() }
})

it("rejects missing native signal data slots both before and after admission", () => {
  const controller = new AbortController(), signal = controller.signal
  const shape = captureModNativeSignalShape(signal)
  const key = Reflect.ownKeys(signal).find(key => String(key) === "Symbol(kAborted)")!
  expect(key).toBeDefined()
  const field = Object.getOwnPropertyDescriptor(signal, key)!
  let calls = 0
  try {
    Reflect.deleteProperty(signal, key)
    Object.defineProperty(AbortSignal.prototype, key, { configurable: true,
      get: () => { calls++; return false } })
    expect(shape()).toBe(false)
    expect(captureModNativeSignalShape(signal)()).toBe(false)
    expect(calls).toBe(0)
  } finally {
    Reflect.deleteProperty(AbortSignal.prototype, key)
    Object.defineProperty(signal, key, field)
  }
})
