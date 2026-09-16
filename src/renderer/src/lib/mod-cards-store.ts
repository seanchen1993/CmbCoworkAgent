import type { ModCard } from "../../../shared/mods/types"

const empty: ModCard[] = []
interface Entry {
  cards: ModCard[]
  listeners: Set<() => void>
  sequence: number
  refresh: () => void
  stop: () => void
}
const threads = new Map<string, Entry>()

// One IPC fetch and one subscription per mounted thread, regardless of tool-row count.
export function subscribeModCards(threadId: string, listener: () => void): () => void {
  let entry = threads.get(threadId)
  if (!entry) {
    const value: Entry = {
      cards: empty,
      listeners: new Set(),
      sequence: 0,
      refresh: () => {},
      stop: () => {}
    }
    value.refresh = () => {
      const sequence = ++value.sequence
      void window.api.mods.cards(threadId, "").then(
        (cards) => {
          if (threads.get(threadId) !== value || sequence !== value.sequence) return
          value.cards = cards
          for (const notify of value.listeners) notify()
        },
        () => {}
      )
    }
    value.stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) value.refresh()
    })
    threads.set(threadId, value)
    value.refresh()
    entry = value
  }
  entry.listeners.add(listener)
  const current = entry
  return () => {
    current.listeners.delete(listener)
    // React can unmount/remount rows in the same frame during virtual scrolling.
    queueMicrotask(() => {
      if (!current.listeners.size && threads.get(threadId) === current) {
        current.stop()
        threads.delete(threadId)
      }
    })
  }
}

export function getModCards(threadId: string): ModCard[] {
  return threads.get(threadId)?.cards ?? empty
}
