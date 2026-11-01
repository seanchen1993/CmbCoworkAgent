import { useSyncExternalStore } from "react"
import { useAppStore } from "./store"
import { captureSurfaceNavigationScope, surfaceNavigationScopeCurrent,
  type SurfaceNavigationScope } from "./platform-surface-intent"

let pending: { id: string; connectorId: string; scope: SurfaceNavigationScope } | null = null
const listeners = new Set<() => void>()
export function openMcpConnectorSettings(connectorId: string, threadId: string, workspace: string) {
  const scope = captureSurfaceNavigationScope(threadId, workspace)
  if (!scope) return
  pending = { id: crypto.randomUUID(), connectorId, scope }
  useAppStore.getState().setShowCustomizeView(true, "connectors")
  listeners.forEach(listener => listener())
}
export function mcpSettingsCurrent(request: NonNullable<typeof pending>) {
  return surfaceNavigationScopeCurrent(request.scope)
}
export function consumeMcpSettings(id: string) {
  if (pending?.id !== id) return
  pending = null
  listeners.forEach(listener => listener())
}
export const useMcpSettingsRequest = () => useSyncExternalStore(listener => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}, () => pending)
