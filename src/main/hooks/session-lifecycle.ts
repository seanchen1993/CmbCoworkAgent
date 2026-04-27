import { runHooks, type HookResultCallback } from "./runner"
import { getEnabledHooks } from "../storage"

// Map<threadId, workspacePath?>. Cleanup paths:
//   - fireSessionEnd(threadId)  ← threads:delete handler removes the entry
//   - fireSessionEndAll()       ← before-quit drains everything
// As long as both call sites stay wired, this Map is bounded by live thread count.
const startedSessions = new Map<string, string | undefined>()

// Map<threadId, additionalContext from SessionStart hooks>
// Consumed by the first UserPromptSubmit and then deleted.
const sessionStartContexts = new Map<string, string>()

/** True when there are still-active sessions awaiting SessionEnd. */
export function hasActiveSessions(): boolean {
  return startedSessions.size > 0
}

/** Fire SessionStart exactly once per threadId lifetime (within the main-process run). */
export async function fireSessionStartOnce(threadId: string, workspacePath?: string, onHookResult?: HookResultCallback): Promise<void> {
  if (startedSessions.has(threadId)) return
  startedSessions.set(threadId, workspacePath)
  const result = await runHooks(getEnabledHooks(workspacePath), "SessionStart", {
    workspacePath,
    sessionId: threadId
  }, onHookResult).catch((e) => { console.warn("[Hooks] SessionStart hook error:", e); return null })
  // Store additionalContext so the first UserPromptSubmit can inject it
  if (result?.additionalContext) {
    sessionStartContexts.set(threadId, result.additionalContext)
  }
}

/**
 * Consume and return any stored SessionStart additionalContext for a thread.
 * Returns undefined if no context was stored or it was already consumed.
 */
export function consumeSessionStartContext(threadId: string): string | undefined {
  const ctx = sessionStartContexts.get(threadId)
  sessionStartContexts.delete(threadId)
  return ctx
}

/** Fire SessionEnd for a thread if it previously fired SessionStart. No-op otherwise. */
export async function fireSessionEnd(threadId: string, workspacePath?: string, onHookResult?: HookResultCallback): Promise<void> {
  if (!startedSessions.has(threadId)) return
  const startedWorkspacePath = startedSessions.get(threadId)
  startedSessions.delete(threadId)
  sessionStartContexts.delete(threadId)
  const effectiveWorkspacePath = workspacePath ?? startedWorkspacePath
  await runHooks(getEnabledHooks(effectiveWorkspacePath), "SessionEnd", {
    workspacePath: effectiveWorkspacePath,
    sessionId: threadId
  }, onHookResult).catch((e) => console.warn("[Hooks] SessionEnd hook error:", e))
}

/**
 * Fire SessionEnd for every still-active thread and resolve once all hooks finish.
 * Call from `before-quit` with `event.preventDefault()`, then `app.quit()` after this resolves.
 *
 * `timeoutMs` caps total wait so a hung hook can't block app shutdown indefinitely.
 */
export async function fireSessionEndAll(
  timeoutMs = 5000,
  getOnHookResult?: (threadId: string) => HookResultCallback | undefined
): Promise<void> {
  const entries = Array.from(startedSessions.entries())
  startedSessions.clear()
  sessionStartContexts.clear()
  if (entries.length === 0) return
  const all = Promise.allSettled(
    entries.map(([id, workspacePath]) =>
      runHooks(
        getEnabledHooks(workspacePath),
        "SessionEnd",
        { sessionId: id, workspacePath },
        getOnHookResult?.(id)
      )
    )
  )
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([all, timeout])
}
