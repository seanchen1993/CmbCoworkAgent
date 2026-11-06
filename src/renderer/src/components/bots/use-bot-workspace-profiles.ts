import { useMemo, useSyncExternalStore } from "react"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkspaceProfile } from "@/lib/bot-workspace-display"

const empty: readonly BotWorkspaceProfile[] = []
const noSubscribe = () => () => {}
const emptySnapshot = () => empty

/** Sidebar and directory picker share one coalesced catalog read, never one lookup per thread. */
export function createBotWorkspaceProfiles(client: BotClient) {
  let profiles = empty
  let pending = false
  let dirty = false
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const read = async () => {
    dirty = true
    if (pending) return
    pending = true
    try {
      while (dirty && listeners.size) {
        dirty = false
        const snapshot = await client.snapshot()
        const next = snapshot.bots.map(({ id, name, color, shape }) => ({ id, name, color, shape }))
        if (JSON.stringify(next) !== JSON.stringify(profiles)) {
          profiles = next
          listeners.forEach((listener) => listener())
        }
      }
    } catch {
      // Folder and task access remain available if Bot labels cannot be refreshed.
    } finally {
      pending = false
    }
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void read()
    }, 200)
  }
  return {
    getSnapshot: () => profiles,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        unsubscribe = client.subscribe((event) => {
          if (!event.memoryBotId && !event.reactionTarget) schedule()
        })
        window.addEventListener("focus", schedule)
        void read()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          unsubscribe?.()
          window.removeEventListener("focus", schedule)
          clearTimeout(timer)
          timer = undefined
        }
      }
    }
  }
}
const catalogs = new WeakMap<BotClient, ReturnType<typeof createBotWorkspaceProfiles>>()
export function useBotWorkspaceProfiles(enabled = true) {
  const client = window.api.bots
  const catalog = useMemo(() => {
    if (!enabled || !client) return null
    let cached = catalogs.get(client)
    if (!cached) {
      cached = createBotWorkspaceProfiles(client)
      catalogs.set(client, cached)
    }
    return cached
  }, [enabled, client])
  return useSyncExternalStore(
    catalog?.subscribe ?? noSubscribe,
    catalog?.getSnapshot ?? emptySnapshot
  )
}
