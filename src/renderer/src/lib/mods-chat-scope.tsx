import { FunctionSiteLifetime } from "./function-site-lifecycle"
import { createContext, useContext, useEffect, useCallback, useRef, useState, type ComponentType } from "react"

export const ModsChatScope = createContext<{
  threadId: string
  enabled: boolean
  ready?: boolean
  error?: string
  retry?: () => void
  isCurrent?: () => boolean
} | null>(null)

export function useModsChatEnabled(
  threadId: string,
  workspace: string | null | undefined
): boolean {
  return useModsChatState(threadId, workspace).enabled
}

export function useModsChatState(
  threadId: string,
  workspace: string | null | undefined
): { enabled: boolean; ready: boolean; error?: string; retry: () => void; isCurrent: () => boolean } {
  const key = JSON.stringify([threadId, workspace])
  const [identity, setIdentity] = useState({ key })
  const [scopeLifetime] = useState(() => new FunctionSiteLifetime())
  const [snapshot, setSnapshot] = useState<{
    identity: typeof identity; enabled?: boolean; error?: string; current: () => boolean
  }>()
  // React retries this render before committing. Returning to A creates a fresh identity.
  if (identity.key !== key) {
    // Revocation is conservative even if React abandons this render.
    scopeLifetime.invalidate()
    setIdentity({ key })
  }
  const requestRef = useRef<{ identity: typeof identity; current: () => boolean } | null>(null)
  const retryRef = useRef<() => void>(() => {})
  const retry = useCallback(() => retryRef.current(), [])
  useEffect(() => {
    if (!workspace?.trim()) {
      setSnapshot(undefined)
      return
    }
    let live = true
    let generation = 0
    const refresh = () => {
      const revision = ++generation
      // Revocation is synchronous, including before React commits the pending state.
      const ticket = scopeLifetime.capture()
      const current = () => live && generation === revision && ticket.current()
      requestRef.current = { identity, current }
      setSnapshot(undefined)
      void (async () => window.api.mods.chatDisplayCapability(threadId, workspace))().then(
        (enabled) => {
          if (!current()) return
          setSnapshot(typeof enabled === "boolean" ? { identity, enabled, current }
            : { identity, current, error: "无法确认当前显示保护，请重新读取。" })
        },
        () => {
          if (current()) setSnapshot({ identity, current,
            error: "无法确认当前显示保护，请重新读取。" })
        }
      )
    }
    retryRef.current = refresh
    const stop = window.api.mods.onConfigurationChanged((event) => {
      // Form fields changed, not the current display authorization.
      if (event?.scope !== "schema") refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      live = false
      if (requestRef.current?.identity === identity) requestRef.current = null
      retryRef.current = () => {}
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [identity, scopeLifetime, threadId, workspace])
  // An abandoned concurrent scope render may revoke a ticket without committing its identity.
  // A later commit must obtain a fresh decision, never revive the revoked snapshot.
  useEffect(() => {
    const request = requestRef.current
    if (request?.identity === identity && !request.current()) retryRef.current()
  })
  const current = snapshot?.identity === identity && identity.key === key && snapshot.current()
  const isCurrent = () => Boolean(workspace?.trim() && snapshot?.identity === identity &&
    identity.key === key && snapshot.current() && typeof snapshot.enabled === "boolean")
  return {
    enabled: Boolean(workspace?.trim() && current && snapshot?.enabled),
    ready: Boolean(workspace?.trim() && current && typeof snapshot?.enabled === "boolean"),
    error: !workspace?.trim() ? "无法确认当前聊天的工作区，请重新读取聊天信息。"
      : current ? snapshot?.error : undefined,
    retry,
    isCurrent
  }
}

export function useModsChatReady(threadId: string): boolean {
  const scope = useContext(ModsChatScope)
  return !scope || scope.threadId !== threadId || scope.ready !== false
}

export function useModsChatScope(threadId: string): boolean {
  const scope = useContext(ModsChatScope)
  return Boolean(scope?.enabled && scope.threadId === threadId)
}

/** Disabled surfaces never mount their subscriptions, requests, or drawing owners. */
export function withModsChatScope<P extends { threadId: string }>(Surface: ComponentType<P>) {
  return function ScopedModsSurface(props: P): React.JSX.Element | null {
    return useModsChatScope(props.threadId) ? <Surface {...props} /> : null
  }
}

/** Matching scope only; a failed capability read never enables unprotected fallback. */
export function useModsChatLoadError(threadId: string):
  { error: string; retry?: () => void } | null {
  const scope = useContext(ModsChatScope)
  return scope?.threadId === threadId && scope.error
    ? { error: scope.error, retry: scope.retry } : null
}

/** The captured decision can be revoked before React commits its replacement. */
export function useModsChatCurrent(threadId: string): () => boolean {
  const scope = useContext(ModsChatScope)
  return scope?.threadId === threadId ? scope.isCurrent ?? (() => scope.ready !== false)
    : () => true
}
