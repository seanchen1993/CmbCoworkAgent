import { createContext, createElement, useContext, type ReactNode } from "react"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

/** Renderer admission and lifetime only. Main continues resolving the trusted Thread workspace. */
export interface ModsThreadScope {
  readonly threadId: string
  readonly workspaceKey: string
}
export function modsWorkspaceKey(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) return null
  return normalizeWorkspacePathKey(path) || "/"
}
/** Each committed workspace change receives a new owner, including A → B → A. */
export function createModsThreadScope(
  threadId: string,
  workspaceKey: string | null
): ModsThreadScope | null {
  return threadId && workspaceKey ? Object.freeze({ threadId, workspaceKey }) : null
}
export const ModsThreadScopeContext = createContext<ModsThreadScope | null>(null)
export function provideModsThreadScope(
  scope: ModsThreadScope | null,
  children: ReactNode
): React.JSX.Element {
  return createElement(ModsThreadScopeContext.Provider, { value: scope }, children)
}
export function useModsThreadScope(threadId: string): ModsThreadScope | null {
  const scope = useContext(ModsThreadScopeContext)
  return scope?.threadId === threadId ? scope : null
}

export function createModsScopeLifetime() {
  let active = false
  let generation = 0
  return {
    activate() {
      active = true
      generation++
    },
    dispose() {
      active = false
      generation++
    },
    isActive: () => active,
    capture: () => (active ? generation : null),
    isCurrent: (token: number | null) => active && token !== null && token === generation
  }
}
