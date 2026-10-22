import type { ModJson, ModObject } from "../../../shared/mods/types"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"

interface Entry {
  value: ModJson
  version: number
  bytes: number
}
export interface FunctionNamedStateScope {
  values?: ReadonlyMap<string, Entry>
  drawing?: string
}
const dependencyProofBrand: unique symbol = Symbol("FunctionNamedStateDependencyProof")
export interface FunctionNamedStateDependencyProof {
  readonly [dependencyProofBrand]: true
}
interface Reader {
  versions: Map<string, number>
  coherent: boolean
  invalidated?: () => void
}
type ReaderIdentity = string | FunctionNamedStateDependencyProof

export function namedStateAddress(value: unknown): ModObject {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["plugin", "key", "id"].includes(key))
  )
    throw new ModFunctionError("MODS_STATE_REFERENCE")
  for (const key of ["plugin", "key", "id"]) {
    const item = value[key]
    if (key === "id" && item === undefined) continue
    if (
      typeof item !== "string" ||
      (key !== "id" && !item) ||
      item.includes("\0") ||
      Buffer.byteLength(item) > 4096
    )
      throw new ModFunctionError("MODS_STATE_REFERENCE")
  }
  return {
    plugin: value.plugin,
    key: value.key,
    ...(value.id === undefined ? {} : { id: value.id })
  }
}

export function namedStateInput(method: string, args: ModJson[]): ModObject {
  if (
    (method === "state.get" && args.length !== 1) ||
    (method === "state.set" && (args.length < 2 || args.length > 3))
  )
    throw new ModFunctionError("MODS_STATE_ARGUMENTS")
  const ref = namedStateAddress(args[0])
  if (method === "state.get") return ref
  const options = args[2]
  if (
    options !== undefined &&
    (!isModObject(options) || Object.keys(options).some((key) => key !== "ifVersion"))
  )
    throw new ModFunctionError("MODS_STATE_ARGUMENTS")
  const ifVersion = isModObject(options) ? options.ifVersion : undefined
  if (ifVersion !== undefined && (!Number.isSafeInteger(ifVersion) || Number(ifVersion) < 0))
    throw new ModFunctionError("MODS_STATE_VERSION")
  encodeModJson(args[1])
  return { ...ref, value: args[1], ...(ifVersion === undefined ? {} : { ifVersion }) }
}

function identity(ref: ModObject): string {
  return JSON.stringify([ref.plugin, ref.key, ref.id ?? null])
}

export function validateNamedStateEvent(method: string, input: ModObject): void {
  if (method !== "state.get" && method !== "state.set") return
  if (method === "state.get") {
    namedStateAddress(input)
    return
  }
  if (
    Object.keys(input).some(
      (key) => !["plugin", "key", "id", "value", "previous", "ifVersion"].includes(key)
    )
  )
    throw new ModFunctionError("MODS_STATE_ARGUMENTS")
  const ref = {
    plugin: input.plugin,
    key: input.key,
    ...(input.id === undefined ? {} : { id: input.id })
  }
  namedStateInput(method, [
    ref,
    input.value,
    ...(input.ifVersion === undefined ? [] : [{ ifVersion: input.ifVersion }])
  ])
}

/** Session memory, separate from persistent store. Immutable maps make reads coherent. */
export class FunctionNamedState {
  private values = new Map<string, Entry>()
  private bytes = 0
  private readonly readers = new Map<ReaderIdentity, Reader>()
  private readonly proofs = new Set<FunctionNamedStateDependencyProof>()
  private readerCount = 0
  private readerBytes = 0
  private readonly listeners = new Set<(generation: string) => void>()

  constructor(private readonly retain?: () => void) {}

  listen(listener: (generation: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  read(ref: ModObject, scope: FunctionNamedStateScope): ModObject {
    const key = identity(ref)
    scope.values ??= this.values
    const entry = scope.values.get(key)
    if (scope.drawing) {
      const reader = this.readers.get(scope.drawing) ?? { versions: new Map(), coherent: true }
      const observed = entry?.version ?? 0
      if (!reader.versions.has(key)) {
        const bytes = Buffer.byteLength(key)
        if (
          reader.versions.size >= 1024 ||
          this.readerCount >= 8192 ||
          this.readerBytes + bytes > 4 * 1024 * 1024
        )
          throw new ModFunctionError("MODS_STATE_SUBSCRIPTION_QUOTA")
        this.readerCount++
        this.readerBytes += bytes
      } else if (reader.versions.get(key) !== observed) reader.coherent = false
      reader.versions.set(key, observed)
      this.readers.set(scope.drawing, reader)
      if ((this.values.get(key)?.version ?? 0) !== (entry?.version ?? 0))
        for (const listener of this.listeners) listener(scope.drawing)
    }
    return {
      ...(entry ? { value: parseModJson(encodeModJson(entry.value)) as ModJson } : {}),
      version: entry?.version ?? 0
    }
  }

  previous(ref: ModObject): ModJson | undefined {
    const entry = this.values.get(identity(ref))
    return entry ? (parseModJson(encodeModJson(entry.value)) as ModJson) : undefined
  }

  write(input: ModObject, scope: FunctionNamedStateScope): ModObject {
    const key = identity(input)
    const old = this.values.get(key)
    const version = old?.version ?? 0
    if (input.ifVersion !== undefined && input.ifVersion !== version) {
      scope.values = this.values
      return { isSet: false, version }
    }
    if (version >= Number.MAX_SAFE_INTEGER) throw new ModFunctionError("MODS_STATE_VERSION")
    const text = encodeModJson(input.value)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(text)
    const total = this.bytes - (old?.bytes ?? 0) + bytes
    if (total > 4 * 1024 * 1024 || (!old && this.values.size >= 8192))
      throw new ModFunctionError("MODS_STATE_QUOTA")
    const next = new Map(this.values)
    next.set(key, { value: parseModJson(text) as ModJson, version: version + 1, bytes })
    this.retain?.()
    this.values = next
    this.bytes = total
    scope.values = next
    for (const [generation, reader] of this.readers) {
      if (!reader.versions.has(key)) continue
      if (typeof generation === "string") {
        for (const listener of this.listeners) listener(generation)
      } else {
        reader.coherent = false
        const invalidated = reader.invalidated
        reader.invalidated = undefined
        try {
          invalidated?.()
        } catch {
          /* Passive cache invalidation must not change an already committed write. */
        }
      }
    }
    return { isSet: true, version: version + 1 }
  }

  release(generation: string): void {
    this.removeReader(generation)
  }

  /** Register an actual host drawing before invoking it, including a draw with no state reads. */
  beginDrawingDependencies(generation: string): boolean {
    if (this.readers.has(generation)) return true
    if (!generation || this.readers.size >= 8192) return false
    this.readers.set(generation, { versions: new Map(), coherent: true })
    return true
  }

  /** Called by the host only after a qualified drawing's final protected publication.
   * Copies only actual observed versions, synchronously registers in the original dependency
   * engine, and spends the same subscription quotas as active drawings. No state values escape.
   * An empty vector requires beginDrawingDependencies; released/unknown drawings fail closed.
   */
  captureDrawingDependencies(
    generation: string,
    reclaim?: () => boolean
  ): FunctionNamedStateDependencyProof | undefined {
    let reader: Reader | undefined
    let bytes = 0
    // Reclaim only through the host cache LRU. Every callback can reenter or change
    // state, so recapture the reader and check coherence before issuing any proof.
    for (let attempts = 0; ; attempts++) {
      reader = this.readers.get(generation)
      if (!reader || !this.currentReader(reader)) return undefined
      bytes = [...reader.versions.keys()].reduce((sum, key) => sum + Buffer.byteLength(key), 0)
      if (
        this.proofs.size < 96 &&
        this.readerCount + reader.versions.size <= 8192 &&
        this.readerBytes + bytes <= 4 * 1024 * 1024
      ) break
      if (attempts >= 96 || !reclaim?.()) return undefined
    }
    const proof: FunctionNamedStateDependencyProof = Object.freeze({
      [dependencyProofBrand]: true as const
    })
    this.readers.set(proof, { versions: new Map(reader.versions), coherent: true })
    this.proofs.add(proof)
    this.readerCount += reader.versions.size
    this.readerBytes += bytes
    return proof
  }

  drawingDependenciesCurrent(proof: FunctionNamedStateDependencyProof): boolean {
    const reader = this.proofs.has(proof) ? this.readers.get(proof) : undefined
    return Boolean(reader && this.currentReader(reader))
  }

  /** Declared literal dependencies must have reached the real native reader, even at version 0. */
  coversDisplayDependencies(
    proof: FunctionNamedStateDependencyProof,
    expectedRefs: readonly ModObject[]
  ): boolean {
    const reader = this.proofs.has(proof) ? this.readers.get(proof) : undefined
    if (
      !reader ||
      !this.currentReader(reader) ||
      !Array.isArray(expectedRefs) ||
      expectedRefs.length > 1024
    )
      return false
    try {
      return expectedRefs.every((ref) => reader.versions.has(identity(namedStateAddress(ref))))
    } catch {
      // Unknown declarations cannot certify a snapshot or change normal rendering semantics.
      return false
    }
  }

  listenDrawingDependencies(
    proof: FunctionNamedStateDependencyProof,
    listener: () => void
  ): () => void {
    const reader = this.proofs.has(proof) ? this.readers.get(proof) : undefined
    if (!reader || !this.currentReader(reader)) {
      listener()
      return () => {}
    }
    if (reader.invalidated) throw new ModFunctionError("MODS_STATE_SUBSCRIPTION_QUOTA")
    reader.invalidated = listener
    return () => {
      if (reader.invalidated === listener) reader.invalidated = undefined
    }
  }

  releaseDrawingDependencies(proof: FunctionNamedStateDependencyProof): void {
    if (!this.proofs.delete(proof)) return
    this.removeReader(proof)
  }

  private currentReader(reader: Reader): boolean {
    return (
      reader.coherent &&
      [...reader.versions].every(
        ([key, version]) => (this.values.get(key)?.version ?? 0) === version
      )
    )
  }

  private removeReader(identity: ReaderIdentity): void {
    const reader = this.readers.get(identity)
    if (!reader) return
    this.readerCount -= reader.versions.size
    for (const key of reader.versions.keys()) this.readerBytes -= Buffer.byteLength(key)
    this.readers.delete(identity)
  }

  dependencyStats() {
    return {
      readers: this.readers.size,
      proofs: this.proofs.size,
      subscriptions: this.readerCount,
      bytes: this.readerBytes
    }
  }
}
