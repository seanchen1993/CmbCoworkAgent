import { isDeepStrictEqual } from "node:util"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionPromptCore } from "../../../shared/mods/v2/prompt-composition"
import type { ModRuntimeAuthority } from "../runtime-instance"

export type CachedPromptEvent = "prompt.context" | "prompt.attachment"
const occurrences = new WeakMap<FunctionPromptCore, { event: CachedPromptEvent; source: object }>()
const guards = new WeakMap<FunctionPromptCore, () => void>()

/** Private invocation guard; never stored with a cached result or passed into guest JSON. */
export function bindHostPromptGuard(core: FunctionPromptCore, guard: () => void): void {
  guards.set(core, guard)
}
export function hostPromptGuard(core: FunctionPromptCore): (() => void) | undefined {
  return guards.get(core)
}

/** Host-only producer binding. SDK input and registration metadata cannot mint a source. */
export function bindHostPromptOccurrence(
  core: FunctionPromptCore,
  event: CachedPromptEvent,
  source: object
): FunctionPromptCore {
  occurrences.set(core, { event, source })
  return core
}
export function hostPromptOccurrence(core: FunctionPromptCore, event: string): object | undefined {
  const occurrence = occurrences.get(core)
  return occurrence?.event === event ? occurrence.source : undefined
}
export function isCachedPromptEvent(event: string): event is CachedPromptEvent {
  return event === "prompt.context" || event === "prompt.attachment"
}

function frozen(value: ModObject): ModObject {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object") return
    Object.values(item).forEach(freeze)
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}
type Entry = { input: ModObject; value?: ModObject; reusable: boolean }
type Owners = WeakMap<ModRuntimeAuthority, WeakMap<object, Entry>>

/** Only settled data, scoped to the exact physical owner and genuine source occurrence. */
export class FunctionPromptCache {
  private generations: Record<CachedPromptEvent, number> = {
    "prompt.context": 0,
    "prompt.attachment": 0
  }
  private owners: Record<CachedPromptEvent, Owners> = {
    "prompt.context": new WeakMap(),
    "prompt.attachment": new WeakMap()
  }
  generation(event: CachedPromptEvent): number {
    return this.generations[event]
  }
  invalidate(event: CachedPromptEvent): void {
    this.generations[event]++
    this.owners[event] = new WeakMap()
  }
  read(
    event: CachedPromptEvent,
    owner: ModRuntimeAuthority,
    source: object,
    input: ModObject
  ): ModObject | undefined {
    owner.assertLive()
    const entry = this.owners[event].get(owner)?.get(source)
    if (!entry) return undefined
    if (!isDeepStrictEqual(entry.input, input)) {
      // A reused mutable producer identity cannot claim the old occurrence again.
      entry.reusable = false
      delete entry.value
      return undefined
    }
    return entry.reusable && entry.value !== undefined ? structuredClone(entry.value) : undefined
  }
  write(
    event: CachedPromptEvent,
    owner: ModRuntimeAuthority,
    source: object,
    input: ModObject,
    value: ModObject,
    generation: number
  ): void {
    owner.assertLive()
    if (generation !== this.generations[event]) return
    let entries = this.owners[event].get(owner)
    if (!entries) {
      entries = new WeakMap()
      this.owners[event].set(owner, entries)
    }
    const previous = entries.get(source)
    if (previous && (!previous.reusable || !isDeepStrictEqual(previous.input, input))) return
    entries.set(source, { input: frozen(input), value: frozen(value), reusable: true })
  }
}
