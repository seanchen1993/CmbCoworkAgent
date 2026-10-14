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
  private readonly readers = new Map<string, Set<string>>()
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
      const keys = this.readers.get(scope.drawing) ?? new Set<string>()
      if (!keys.has(key)) {
        const bytes = Buffer.byteLength(key)
        if (
          keys.size >= 1024 ||
          this.readerCount >= 8192 ||
          this.readerBytes + bytes > 4 * 1024 * 1024
        )
          throw new ModFunctionError("MODS_STATE_SUBSCRIPTION_QUOTA")
        this.readerCount++
        this.readerBytes += bytes
      }
      keys.add(key)
      this.readers.set(scope.drawing, keys)
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
    for (const [generation, keys] of this.readers)
      if (keys.has(key)) for (const listener of this.listeners) listener(generation)
    return { isSet: true, version: version + 1 }
  }

  release(generation: string): void {
    const keys = this.readers.get(generation)
    if (keys) {
      this.readerCount -= keys.size
      for (const key of keys) this.readerBytes -= Buffer.byteLength(key)
    }
    this.readers.delete(generation)
  }
}
