import { types } from "node:util"
import { ModError } from "./errors"

const authorityBrand = Symbol("mod-runtime-authority")
const authorityDataReaders = new WeakMap<ModRuntimeAuthority, {
  readonly registry: ModRuntimeAuthorities
  readonly read: () => boolean
  readonly callbackFree: () => boolean
}>()
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!
const originalSignalPrototype = AbortSignal.prototype
const signalThrow = AbortSignal.prototype.throwIfAborted
const ownDescriptor = Object.getOwnPropertyDescriptor
const originalPrototype = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys
const originalApply = Reflect.apply
const nativeSignalKeys = ownKeys(new AbortController().signal)
const isProxy = types.isProxy
/** A shape classifier only, retaining the native signal's required own data slots. */
export function captureModNativeSignalShape(signal: AbortSignal): () => boolean {
  if (isProxy(signal) || originalPrototype(signal) !== originalSignalPrototype)
    return () => false
  for (let index = 0; index < nativeSignalKeys.length; index++) {
    const field = ownDescriptor(signal, nativeSignalKeys[index])
    if (!field || !("value" in field)) return () => false
  }
  const required = ownKeys(signal)
  for (let index = 0; index < required.length; index++)
    if (!("value" in ownDescriptor(signal, required[index])!)) return () => false
  return () => {
    if (originalPrototype(signal) !== originalSignalPrototype ||
      ownDescriptor(signal, "throwIfAborted") ||
      ownDescriptor(originalSignalPrototype, "throwIfAborted")?.value !== signalThrow) return false
    for (let index = 0; index < required.length; index++) {
      const field = ownDescriptor(signal, required[index])
      if (!field || !("value" in field)) return false
    }
    const current = ownKeys(signal)
    for (let index = 0; index < current.length; index++)
      if (!("value" in ownDescriptor(signal, current[index])!)) return false
    return true
  }
}
const mapGet = Map.prototype.get
const weakGet = WeakMap.prototype.get

export interface ModRuntimeScope {
  workspace: string
  threadId: string
  turnId: string
  agentId?: string
}

/** Host-only object identity. Never include this object in guest events or persisted identities. */
export interface ModRuntimeAuthority extends Readonly<ModRuntimeScope> {
  readonly [authorityBrand]: true
  readonly agentId: string
  readonly parentCallId?: string
  assertLive(): void
}

export function assertModRuntimeAuthority(
  authority: ModRuntimeAuthority,
  scope: ModRuntimeScope
): void {
  authority.assertLive()
  if (
    authority.workspace !== scope.workspace ||
    authority.threadId !== scope.threadId ||
    authority.turnId !== scope.turnId ||
    authority.agentId !== (scope.agentId ?? "main")
  )
    throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
}

interface Entry {
  authority: ModRuntimeAuthority
  readonly key: string
  readonly signal?: AbortSignal
  parent?: Entry
  children: Set<Entry>
  resources: Set<() => void>
  release(): void
}

interface EntryFacts {
  readonly entry: Entry
  readonly key: string
  readonly signal?: AbortSignal
  readonly signalShape?: () => boolean
  readonly descriptors: Readonly<Record<"key" | "signal" | "parent", PropertyDescriptor>>
}
const entryLineages = new WeakMap<Entry, readonly EntryFacts[]>()

function sameDataDescriptor(value: object, key: string, original: PropertyDescriptor): boolean {
  const current = Object.getOwnPropertyDescriptor(value, key)
  return !!current && "value" in current && current.value === original.value &&
    current.enumerable === original.enumerable && current.writable === original.writable &&
    current.configurable === original.configurable
}

/** One authority per physical runtime, independently of temporary native/MCP adapter leases. */
export class ModRuntimeAuthorities {
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new WeakMap<ModRuntimeAuthority, Entry>()
  private closed = false

  private key(scope: Pick<ModRuntimeScope, "workspace" | "threadId" | "agentId">): string {
    return JSON.stringify([scope.workspace, scope.threadId, scope.agentId ?? "main"])
  }

  create(
    scope: ModRuntimeScope,
    signal?: AbortSignal,
    parent?: ModRuntimeAuthority,
    parentCallId?: string
  ): { authority: ModRuntimeAuthority; release(): void } {
    if (this.closed) throw new ModError("MODS_RUNTIME_CLOSED")
    signal?.throwIfAborted()
    parent?.assertLive()
    const parentEntry = parent && this.owners.get(parent)
    if (parent && (!parentEntry || parent.workspace !== scope.workspace))
      throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    const parentLineage = parentEntry && entryLineages.get(parentEntry)
    if (parentEntry && !parentLineage) throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    const key = this.key(scope)
    for (let ancestor = parentEntry; ancestor; ancestor = ancestor.parent)
      if (key === this.key(ancestor.authority)) throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    this.entries.get(key)?.release()
    if (this.entries.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    const authority: ModRuntimeAuthority = Object.freeze({
      [authorityBrand]: true as const,
      workspace: scope.workspace,
      threadId: scope.threadId,
      turnId: scope.turnId,
      agentId: scope.agentId ?? "main",
      ...(parentCallId ? { parentCallId } : {}),
      assertLive: () => {
        if (this.closed || this.entries.get(key) !== entry)
          throw new ModError("MODS_RUNTIME_INSTANCE_EXPIRED")
        signal?.throwIfAborted()
        parent?.assertLive()
      }
    })
    let released = false
    const entry: Entry = {
      authority,
      key,
      signal,
      parent: parentEntry,
      children: new Set(),
      resources: new Set(),
      release: () => {
        if (released) return
        released = true
        signal?.removeEventListener("abort", entry.release)
        if (this.entries.get(key) === entry) this.entries.delete(key)
        for (const child of [...entry.children]) child.release()
        entry.children.clear()
        parentEntry?.children.delete(entry)
        const resources = [...entry.resources]
        entry.resources.clear()
        for (const dispose of resources) {
          try {
            dispose()
          } catch {
            // A failed resource cleanup must never keep other owned work authorized.
          }
        }
      }
    }
    this.entries.set(key, entry)
    this.owners.set(authority, entry)
    // Only the original factory publishes this data reader. It captures private entries directly,
    // so a final source callback cannot replace a public method to keep revoked work alive.
    const entries = this.entries
    const entriesDescriptor = Object.getOwnPropertyDescriptor(this, "entries")!
    const closedDescriptor = Object.getOwnPropertyDescriptor(this, "closed")!
    const facts: EntryFacts = Object.freeze({ entry, key, signal, signalShape: signal && captureModNativeSignalShape(signal), descriptors: Object.freeze({
      key: Object.freeze(Object.getOwnPropertyDescriptor(entry, "key")!),
      signal: Object.freeze(Object.getOwnPropertyDescriptor(entry, "signal")!),
      parent: Object.freeze(Object.getOwnPropertyDescriptor(entry, "parent")!)
    }) })
    const lineage = Object.freeze([facts, ...(parentLineage ?? [])])
    entryLineages.set(entry, lineage)
    authorityDataReaders.set(authority, { registry: this, callbackFree: () => {
      if (ownDescriptor(originalSignalPrototype, "throwIfAborted")?.value !== signalThrow)
        return false
      for (let index = 0; index < lineage.length; index++) {
        const shape = lineage[index].signalShape
        if (shape && !shape()) return false
      }
      return true
    }, read: () => {
      if (closedDescriptor.value !== false ||
        !sameDataDescriptor(this, "closed", closedDescriptor) ||
        !sameDataDescriptor(this, "entries", entriesDescriptor)) return false
      for (let index = 0; index < lineage.length; index++) {
        const current = lineage[index]
        if (Reflect.apply(weakGet, entryLineages, [current.entry])?.[0] !== current ||
          Reflect.apply(mapGet, entries, [current.key]) !== current.entry ||
          !sameDataDescriptor(current.entry, "key", current.descriptors.key) ||
          !sameDataDescriptor(current.entry, "signal", current.descriptors.signal) ||
          !sameDataDescriptor(current.entry, "parent", current.descriptors.parent)) return false
        if (current.signal) {
          try { if (Reflect.apply(signalAborted, current.signal, [])) return false }
          catch { return false }
        }
      }
      return true
    } })
    parentEntry?.children.add(entry)
    signal?.addEventListener("abort", entry.release, { once: true })
    if (signal?.aborted) entry.release()
    authority.assertLive()
    return { authority, release: entry.release }
  }

  get(scope: Pick<ModRuntimeScope, "workspace" | "threadId" | "agentId">) {
    const authority = this.entries.get(this.key(scope))?.authority
    authority?.assertLive()
    return authority
  }

  /** Original private address only; use after the full live guard, never as an admission. */
  isCurrent(authority: ModRuntimeAuthority): boolean {
    return this.owners.has(authority) && isModRuntimeAuthorityDataCurrent(authority)
  }

  /** Host resources are revoked with the exact owner, never transferred to a replacement. */
  registerResource(authority: ModRuntimeAuthority, dispose: () => void): () => void {
    authority.assertLive()
    const entry = this.owners.get(authority)
    if (!entry) throw new ModError("MODS_RUNTIME_SCOPE_CHANGED")
    if (entry.resources.size >= 100) throw new ModError("MODS_RUNTIME_CAPACITY")
    entry.resources.add(dispose)
    return () => entry.resources.delete(dispose)
  }

  closeThread(threadId: string): void {
    for (const entry of [...this.entries.values()])
      if (entry.authority.threadId === threadId) entry.release()
  }

  close(): void {
    this.closed = true
    for (const entry of [...this.entries.values()]) entry.release()
  }
}

/** Pure original private authority data, after full guards. It never admits an unknown object. */
export function isModRuntimeAuthorityDataCurrent(authority: ModRuntimeAuthority): boolean {
  const original: { read(): boolean } | undefined =
    Reflect.apply(weakGet, authorityDataReaders, [authority])
  return original?.read() === true
}

/** Exact original registry relationship plus its private data; no public live method is called. */
export function isModRuntimeAuthorityDataCurrentForRegistry(
  registry: ModRuntimeAuthorities, authority: ModRuntimeAuthority
): boolean {
  const original: { registry: ModRuntimeAuthorities; read(): boolean } | undefined =
    Reflect.apply(weakGet, authorityDataReaders, [authority])
  return original?.registry === registry && original.read() === true
}

/** Classification only: every signal actually captured by the private authority lineage is native. */
export function isModRuntimeAuthorityCallbackFreeForRegistry(
  registry: ModRuntimeAuthorities, authority: ModRuntimeAuthority
): boolean {
  const original = originalApply(weakGet, authorityDataReaders, [authority]) as
    { registry: ModRuntimeAuthorities; read(): boolean; callbackFree(): boolean } | undefined
  return original?.registry === registry && original.callbackFree() && original.read()
}
