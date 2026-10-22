import { encodeModJson } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  validateFunctionDisplaySnapshotData,
  type FunctionDisplaySnapshot,
  type FunctionDisplaySnapshotData
} from "../../../shared/mods/v2/display-snapshot"
import { FunctionDisplayScopes, type FunctionDisplayScope } from "./display-scopes"

export { validateFunctionDisplaySnapshotData } from "../../../shared/mods/v2/display-snapshot"

const proofBrand: unique symbol = Symbol("FunctionDisplaySnapshotProof")
export interface FunctionDisplaySnapshotProof {
  readonly [proofBrand]: true
}
export interface FunctionDisplaySnapshotProofInput {
  version: string
  reusable: boolean
  /** Full current route/source/config/policy guard, not an assertion from the renderer. */
  assertCurrent(): void
  dependencies?: { current(): boolean; release(): void }
  onEvict?(): void
}
interface Proof {
  scope: FunctionDisplayScope
  input: FunctionDisplaySnapshotProofInput
  state: "new" | "retained" | "released"
}
interface Entry {
  scope: FunctionDisplayScope
  key: string
  version: string
  encoded: string
  bytes: number
  expiresAt: number
  proof: FunctionDisplaySnapshotProof
}
const LIMITS = {
  maxEntriesPerScope: 96,
  maxBytesPerScope: 2 * 1024 * 1024,
  maxEntryBytes: 128 * 1024,
  maxBytes: 16 * 1024 * 1024,
  maxAgeMs: 120000
}
export type FunctionDisplaySnapshotCacheLimits = typeof LIMITS

/** Pure data only. Authority guards and dependency proofs remain private in the main process. */
export class FunctionDisplaySnapshotCache {
  private readonly entries = new Map<string, Entry>()
  private readonly scopeEntries = new Map<string, { entries: Map<string, Entry>; bytes: number }>()
  private readonly proofs = new WeakMap<FunctionDisplaySnapshotProof, Proof>()
  private readonly pending = new Map<string, Promise<FunctionDisplaySnapshot>>()
  private readonly limits: FunctionDisplaySnapshotCacheLimits
  private bytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0
  private observerDepth = 0

  constructor(
    private readonly scopes: FunctionDisplayScopes,
    limits: Partial<FunctionDisplaySnapshotCacheLimits> = {},
    private readonly now = Date.now
  ) {
    this.limits = { ...LIMITS }
    for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
      const value = limits[key]
      if (value !== undefined && Number.isFinite(value))
        this.limits[key] = Math.max(0, Math.min(LIMITS[key], Math.floor(value)))
    }
  }

  /** Issue only after native eligibility analysis. Unknown or effectful draws stay uncached. */
  captureProof(
    scope: FunctionDisplayScope,
    input: FunctionDisplaySnapshotProofInput
  ): FunctionDisplaySnapshotProof | undefined {
    this.assertOutsideObserver()
    this.scopes.assertCurrent(scope)
    input.assertCurrent()
    if (
      !input.reusable ||
      !input.version ||
      input.version.length > 4096 ||
      (input.dependencies && !input.dependencies.current())
    )
      return undefined
    const proof: FunctionDisplaySnapshotProof = Object.freeze({ [proofBrand]: true as const })
    this.proofs.set(proof, { scope, input: { ...input }, state: "new" })
    return proof
  }

  private checked(scope: FunctionDisplayScope, proof: FunctionDisplaySnapshotProof): Proof {
    this.scopes.assertCurrent(scope)
    const record = this.proofs.get(proof)
    if (!record || record.scope !== scope || record.state === "released")
      throw new ModFunctionError("MODS_DISPLAY_PROOF_INVALID")
    record.input.assertCurrent()
    this.scopes.assertCurrent(scope)
    if (record.input.dependencies && !record.input.dependencies.current())
      throw new ModFunctionError("MODS_DISPLAY_DEPENDENCY_CHANGED")
    return record
  }

  releaseProof(proof: FunctionDisplaySnapshotProof): void {
    const record = this.proofs.get(proof)
    if (!record || record.state === "released") return
    record.state = "released"
    this.proofs.delete(proof)
    this.observerDepth++
    try {
      try {
        record.input.dependencies?.release()
      } catch {
        /* Passive cleanup failure cannot preserve an entry or fail an unrelated drawing. */
      }
      try {
        record.input.onEvict?.()
      } catch {
        /* An eviction observer carries no execution authority. */
      }
    } finally {
      this.observerDepth--
    }
  }

  private assertOutsideObserver(): void {
    // Cleanup may inspect or clear the cache, but cannot synchronously replace the
    // entry whose accounting is still being removed. Do not queue replayable writes.
    if (this.observerDepth) throw new ModFunctionError("MODS_DISPLAY_OBSERVER_REENTRY")
  }

  private identity(scope: FunctionDisplayScope, key: string): string {
    if (!key || key.length > 65536) throw new ModFunctionError("MODS_DISPLAY_KEY_INVALID")
    return JSON.stringify([scope.id, key])
  }

  read(
    scope: FunctionDisplayScope,
    key: string,
    expectedVersion?: string
  ): FunctionDisplaySnapshot | null {
    this.scopes.assertCurrent(scope)
    const id = this.identity(scope, key)
    const entry = this.entries.get(id)
    if (
      !entry ||
      entry.expiresAt <= this.now() ||
      (expectedVersion !== undefined && entry.version !== expectedVersion)
    ) {
      if (entry) this.remove(id, entry)
      this.misses++
      return null
    }
    try {
      this.checked(scope, entry.proof)
    } catch (error) {
      this.remove(id, entry)
      if (error instanceof ModFunctionError && error.code === "MODS_DISPLAY_DEPENDENCY_CHANGED") {
        this.misses++
        return null
      }
      throw error
    }
    this.entries.delete(id)
    this.entries.set(id, entry)
    const usage = this.scopeEntries.get(scope.id)!
    usage.entries.delete(id)
    usage.entries.set(id, entry)
    this.hits++
    return JSON.parse(entry.encoded) as FunctionDisplaySnapshot
  }

  write(
    scope: FunctionDisplayScope,
    key: string,
    proof: FunctionDisplaySnapshotProof,
    data: FunctionDisplaySnapshotData,
    retain = true
  ): FunctionDisplaySnapshot {
    try {
      this.assertOutsideObserver()
      return this.writeQualified(scope, key, proof, data, retain)
    } catch (error) {
      if (this.proofs.get(proof)?.state === "new") this.releaseProof(proof)
      throw error
    }
  }

  private writeQualified(
    scope: FunctionDisplayScope,
    key: string,
    proof: FunctionDisplaySnapshotProof,
    data: FunctionDisplaySnapshotData,
    retain: boolean
  ): FunctionDisplaySnapshot {
    const record = this.checked(scope, proof)
    if (record.state !== "new") throw new ModFunctionError("MODS_DISPLAY_PROOF_CONSUMED")
    const id = this.identity(scope, key)
    validateFunctionDisplaySnapshotData(data)
    const expiresAt = this.now() + this.limits.maxAgeMs
    const encoded = encodeModJson({
      scopeId: scope.id,
      key,
      version: record.input.version,
      expiresAt,
      data
    })
    const bytes = encoded.length * 2 + 256
    this.checked(scope, proof)
    const result = JSON.parse(encoded) as FunctionDisplaySnapshot
    if (
      !retain ||
      bytes > this.limits.maxEntryBytes ||
      bytes > this.limits.maxBytesPerScope ||
      bytes > this.limits.maxBytes ||
      !this.limits.maxEntriesPerScope ||
      !this.limits.maxAgeMs
    ) {
      this.releaseProof(proof)
      return result
    }
    const prior = this.entries.get(id)
    if (prior) this.remove(id, prior)
    let usage = this.scopeEntries.get(scope.id)
    while (
      usage &&
      (usage.entries.size >= this.limits.maxEntriesPerScope ||
        usage.bytes + bytes > this.limits.maxBytesPerScope)
    ) {
      const oldest = usage.entries.entries().next().value
      if (!oldest) break
      this.remove(oldest[0], oldest[1])
      usage = this.scopeEntries.get(scope.id)
    }
    while (this.bytes + bytes > this.limits.maxBytes) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.remove(oldest[0], oldest[1])
    }
    this.checked(scope, proof)
    record.state = "retained"
    const entry: Entry = {
      scope,
      key,
      version: record.input.version,
      encoded,
      bytes,
      expiresAt,
      proof
    }
    this.entries.set(id, entry)
    usage = this.scopeEntries.get(scope.id) ?? { entries: new Map(), bytes: 0 }
    usage.entries.set(id, entry)
    usage.bytes += bytes
    this.scopeEntries.set(scope.id, usage)
    this.bytes += bytes
    return result
  }

  /** Single-flight is restricted to already qualified pure display computations. */
  async resolve(
    scope: FunctionDisplayScope,
    key: string,
    proof: FunctionDisplaySnapshotProof,
    produce: () => Promise<FunctionDisplaySnapshotData>,
    retain = true
  ): Promise<FunctionDisplaySnapshot> {
    try {
      this.assertOutsideObserver()
      return await this.resolveQualified(scope, key, proof, produce, retain)
    } catch (error) {
      if (this.proofs.get(proof)?.state === "new") this.releaseProof(proof)
      throw error
    }
  }

  private async resolveQualified(
    scope: FunctionDisplayScope,
    key: string,
    proof: FunctionDisplaySnapshotProof,
    produce: () => Promise<FunctionDisplaySnapshotData>,
    retain: boolean
  ): Promise<FunctionDisplaySnapshot> {
    const record = this.checked(scope, proof)
    if (record.state !== "new") throw new ModFunctionError("MODS_DISPLAY_PROOF_CONSUMED")
    const cached = retain ? this.read(scope, key, record.input.version) : null
    if (cached) {
      this.releaseProof(proof)
      return cached
    }
    const id = JSON.stringify([this.identity(scope, key), record.input.version, retain])
    const pending = this.pending.get(id)
    if (pending) {
      try {
        const result = await pending
        this.checked(scope, proof)
        return structuredClone(result)
      } finally {
        this.releaseProof(proof)
      }
    }
    if (this.pending.size >= 256) {
      this.releaseProof(proof)
      throw new ModFunctionError("MODS_DISPLAY_PENDING_LIMIT")
    }
    const task = (async () => {
      try {
        this.checked(scope, proof)
        const data = await produce()
        this.checked(scope, proof)
        return this.write(scope, key, proof, data, retain)
      } catch (error) {
        this.releaseProof(proof)
        throw error
      }
    })()
    this.pending.set(id, task)
    try {
      return await task
    } finally {
      if (this.pending.get(id) === task) this.pending.delete(id)
    }
  }

  private remove(id: string, entry: Entry): void {
    if (this.detach(id, entry)) this.releaseProof(entry.proof)
  }

  /** Release the least recently used data and its dependency proof before a new handoff. */
  evictOldest(scope: FunctionDisplayScope): boolean {
    this.assertOutsideObserver()
    this.scopes.assertCurrent(scope)
    const oldest = this.scopeEntries.get(scope.id)?.entries.entries().next().value
    if (!oldest) return false
    this.remove(oldest[0], oldest[1])
    this.scopes.assertCurrent(scope)
    return true
  }

  /** Cleanup only: a resumed real owner no longer needs the retained dependency reader. */
  deleteEntry(scope: FunctionDisplayScope, key: string): void {
    const id = this.identity(scope, key)
    const entry = this.entries.get(id)
    if (entry?.scope === scope) this.remove(id, entry)
  }

  private detach(id: string, entry: Entry): boolean {
    if (this.entries.get(id) !== entry) return false
    this.entries.delete(id)
    const usage = this.scopeEntries.get(entry.scope.id)
    if (usage) {
      usage.entries.delete(id)
      usage.bytes -= entry.bytes
      if (!usage.entries.size) this.scopeEntries.delete(entry.scope.id)
    }
    this.bytes -= entry.bytes
    this.evictions++
    return true
  }

  deleteScope(scopeId: string): void {
    const usage = this.scopeEntries.get(scopeId)
    const removed: Entry[] = []
    if (usage)
      for (const [id, entry] of usage.entries) if (this.detach(id, entry)) removed.push(entry)
    this.scopes.deleteScope(scopeId)
    for (const entry of removed) this.releaseProof(entry.proof)
  }

  clear(): void {
    // Detach the whole batch before callbacks. A callback may clear again without
    // recursively walking every retained proof or observing a half-retired scope.
    const removed: Entry[] = []
    for (const [id, entry] of this.entries) if (this.detach(id, entry)) removed.push(entry)
    this.scopes.clear()
    for (const entry of removed) this.releaseProof(entry.proof)
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      pending: this.pending.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    }
  }
}
