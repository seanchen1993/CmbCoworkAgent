import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"

type PluginSettingsRequest = { id: string; pluginId: string }
let pending: PluginSettingsRequest | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function openPluginSettings(pluginId: string): void {
  pending = { id: crypto.randomUUID(), pluginId }
  useAppStore.getState().setShowCustomizeView(true, "plugins")
  for (const listener of listeners) listener()
}

export function consumePluginSettings(id: string): void {
  if (pending?.id !== id) return
  pending = null
  for (const listener of listeners) listener()
}

export const usePluginSettingsRequest = () => useSyncExternalStore(subscribe, () => pending)
