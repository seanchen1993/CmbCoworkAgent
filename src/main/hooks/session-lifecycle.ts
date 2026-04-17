import { runHooks } from "./runner"
import { getEnabledHooks } from "../storage"

// Map<threadId, workspacePath?>. Cleanup paths:
//   - fireSessionEnd(threadId)  ← threads:delete handler removes the entry
//   - fireSessionEndAll()       ← before-quit drains everything
// As long as both call sites stay wired, this Map is bounded by live thread count.
const startedSessions = new Map<string, string | undefined>()

/** True when there are still-active sessions awaiting SessionEnd. */
export function hasActiveSessions(): boolean {
  return startedSessions.size > 0
}

/** Fire SessionStart exactly once per threadId lifetime (within the main-process run). */
export function fireSessionStartOnce(threadId: string, workspacePath?: string): void {
  if (startedSessions.has(threadId)) return
  startedSessions.set(threadId, workspacePath)
  runHooks(getEnabledHooks(workspacePath), "SessionStart", {
    workspacePath,
    sessionId: threadId
  }).catch((e) => console.warn("[Hooks] SessionStart hook error:", e))
}

/** Fire SessionEnd for a thread if it previously fired SessionStart. No-op otherwise. */
export function fireSessionEnd(threadId: string, workspacePath?: string): void {
  if (!startedSessions.has(threadId)) return
  const startedWorkspacePath = startedSessions.get(threadId)
  startedSessions.delete(threadId)
  const effectiveWorkspacePath = workspacePath ?? startedWorkspacePath
  runHooks(getEnabledHooks(effectiveWorkspacePath), "SessionEnd", {
    workspacePath: effectiveWorkspacePath,
    sessionId: threadId
  }).catch((e) => console.warn("[Hooks] SessionEnd hook error:", e))
}

/**
 * Fire SessionEnd for every still-active thread and resolve once all hooks finish.
 * Call from `before-quit` with `event.preventDefault()`, then `app.quit()` after this resolves.
 *
 * `timeoutMs` caps total wait so a hung hook can't block app shutdown indefinitely.
 */
export async function fireSessionEndAll(timeoutMs = 5000): Promise<void> {
  const entries = Array.from(startedSessions.entries())
  startedSessions.clear()
  if (entries.length === 0) return
  const all = Promise.allSettled(
    entries.map(([id, workspacePath]) =>
      runHooks(getEnabledHooks(workspacePath), "SessionEnd", { sessionId: id, workspacePath })
    )
  )
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([all, timeout])
}
