import { createLatestDisplayRead } from "./latest-display-read"
import type { ModCard } from "../../../shared/mods/types"
import { modUiChangeAffects } from "../../../shared/mods/types"

const empty: ModCard[] = []
interface Entry {
  cards: ModCard[]
  listeners: Set<() => void>
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
      refresh: () => {},
      stop: () => {}
    }
    const publish = (cards: ModCard[]) => {
      if (threads.get(threadId) !== value) return
      value.cards = cards
      for (const notify of value.listeners) notify()
    }
    const reader = createLatestDisplayRead({
      read: () => window.api.mods.cards(threadId, ""),
      publish,
      failed: () => publish(empty)
    })
    value.refresh = reader.refresh
    const invalidate = () => {
      reader.invalidate()
      publish(empty)
      reader.refresh()
    }
    const stopCards = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId && modUiChangeAffects(event.scope, "cards")) {
        if (event.scope === "cards") value.refresh()
        else invalidate()
      }
    })
    const stopConfiguration = window.api.mods.onConfigurationChanged((event) => {
      if (event?.scope === "schema") reader.refresh()
      else invalidate()
    })
    window.addEventListener("mods:configuration-changed", invalidate)
    value.stop = () => {
      reader.close()
      stopCards()
      stopConfiguration()
      window.removeEventListener("mods:configuration-changed", invalidate)
    }
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
