import type { ModCard } from "../../../shared/mods/types"
import type { ModsThreadScope } from "./mods-thread-scope"

const empty: ModCard[] = []
interface Entry {
  scope: ModsThreadScope
  cards: ModCard[]
  listeners: Set<() => void>
  sequence: number
  refresh: () => void
  stop: () => void
}
const threads = new Map<string, Entry>()

// One IPC fetch and one subscription per current thread owner, regardless of tool-row count.
export function subscribeModCards(scope: ModsThreadScope | null, listener: () => void): () => void {
  if (!scope) return () => {}
  const threadId = scope.threadId
  let entry = threads.get(threadId)
  let created = false
  if (entry && entry.scope !== scope) {
    entry.stop()
    threads.delete(threadId)
    entry = undefined
  }
  if (!entry) {
    const value: Entry = {
      scope,
      cards: empty,
      listeners: new Set(),
      sequence: 0,
      refresh: () => {},
      stop: () => {}
    }
    let alive = true,
      running = false,
      pending = false
    value.refresh = () => {
      if (!alive || !value.listeners.size || threads.get(threadId) !== value) return
      if (running) {
        pending = true
        value.sequence++
        return
      }
      running = true
      const sequence = ++value.sequence
      void window.api.mods
        .cards(threadId, "")
        .then(
          (cards) => {
            if (!alive || threads.get(threadId) !== value || sequence !== value.sequence) return
            value.cards = cards
            for (const notify of value.listeners) notify()
          },
          () => {
            if (!alive || threads.get(threadId) !== value || sequence !== value.sequence) return
            value.cards = empty
            for (const notify of value.listeners) notify()
          }
        )
        .finally(() => {
          running = false
          if (alive && pending && threads.get(threadId) === value) {
            pending = false
            value.refresh()
          }
        })
    }
    const stopCards = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) value.refresh()
    })
    window.addEventListener("mods:configuration-changed", value.refresh)
    value.stop = () => {
      if (!alive) return
      alive = false
      pending = false
      stopCards()
      window.removeEventListener("mods:configuration-changed", value.refresh)
    }
    threads.set(threadId, value)
    entry = value
    created = true
  }
  entry.listeners.add(listener)
  if (created) entry.refresh()
  const current = entry
  return () => {
    current.listeners.delete(listener)
    // React can unmount/remount rows for the same owner in one virtual-scrolling frame.
    queueMicrotask(() => {
      if (!current.listeners.size && threads.get(threadId) === current) {
        current.stop()
        threads.delete(threadId)
      }
    })
  }
}
export function getModCards(scope: ModsThreadScope | null): ModCard[] {
  if (!scope) return empty
  const entry = threads.get(scope.threadId)
  return entry?.scope === scope ? entry.cards : empty
}
