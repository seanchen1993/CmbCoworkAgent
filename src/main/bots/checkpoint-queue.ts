import type { BotStore } from "./store"

type Scope = { tail?: Promise<void>; pins: Map<string, number> }
const scopes = new WeakMap<BotStore, Map<string, Scope>>()
function scope(store: BotStore, thread: string, ns: string) {
  const key = JSON.stringify([thread, ns])
  const entries = scopes.get(store) ?? new Map<string, Scope>()
  scopes.set(store, entries)
  const state: Scope = entries.get(key) ?? { pins: new Map<string, number>() }
  entries.set(key, state)
  const collect = () => {
    if (!state.tail && !state.pins.size && entries.get(key) === state) entries.delete(key)
  }
  return { state, collect }
}

/** Same namespace FIFO as SqlJsSaver, scoped to the Bot Store's single owner.
 * Separate saver instances for a recovering run share ordering and write pins. */
export async function acquireBotCheckpointWrite(
  store: BotStore,
  thread: string,
  ns: string
): Promise<() => void> {
  const { state, collect } = scope(store, thread, ns)
  const previous = state.tail ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  state.tail = tail
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    void tail.then(() => {
      if (state.tail === tail) state.tail = undefined
      collect()
    })
  }
}

export function pinBotCheckpointResults(
  store: BotStore,
  thread: string,
  ns: string,
  id: string
): () => void {
  const { state, collect } = scope(store, thread, ns)
  state.pins.set(id, (state.pins.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = state.pins.get(id)! - 1
    if (remaining) state.pins.set(id, remaining)
    else state.pins.delete(id)
    collect()
  }
}

export function pendingBotCheckpointResults(
  store: BotStore,
  thread: string,
  ns: string
): Iterable<string> {
  return (
    scopes
      .get(store)
      ?.get(JSON.stringify([thread, ns]))
      ?.pins.keys() ?? []
  )
}
