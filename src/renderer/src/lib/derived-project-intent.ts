import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import type { PluginDerivationScope } from "../../../shared/plugin-derivation"

type Intent = { id: string; pluginId: string; name: string; scope?: PluginDerivationScope }
let pending: Intent | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function openDerivedProject(
  pluginId: string,
  name: string,
  scope?: PluginDerivationScope
): void {
  pending = { id: crypto.randomUUID(), pluginId, name, scope }
  const store = useAppStore.getState()
  store.setShowCustomizeView(false)
  store.setShowHarnessBoardView(true)
  for (const listener of listeners) listener()
}
export function dismissDerivedProject(id: string): void {
  if (pending?.id !== id) return
  pending = null
  for (const listener of listeners) listener()
}
export const useDerivedProjectIntent = () => useSyncExternalStore(subscribe, () => pending)
