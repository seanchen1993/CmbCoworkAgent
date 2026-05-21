import { clearOnceStateForSession, runHooks, type HookResultCallback } from "./runner"
import type { HookContext } from "./runner"
import { resolveEnabledHooksForRun, type HookScopeController } from "./scope"

// Map<threadId, workspacePath?>. Cleanup paths:
//   - fireSessionEnd(threadId)  ← threads:delete handler removes the entry
//   - fireSessionEndAll()       ← before-quit drains everything
// As long as both call sites stay wired, this Map is bounded by live thread count.
interface StartedSession {
  workspacePath?: string
  pluginOutputDir?: string
  hookScope?: HookScopeController
}

const startedSessions = new Map<string, StartedSession>()

/** True when there are still-active sessions awaiting SessionEnd. */
export function hasActiveSessions(): boolean {
  return startedSessions.size > 0
}

/** Fire SessionStart exactly once per threadId lifetime (within the main-process run). */
export function fireSessionStartOnce(
  threadId: string,
  workspacePath?: string,
  onHookResult?: HookResultCallback,
  hookScope?: HookScopeController,
  pluginOutputDir?: string
): void {
  const existing = startedSessions.get(threadId)
  if (existing) {
    startedSessions.set(threadId, {
      workspacePath: workspacePath ?? existing.workspacePath,
      pluginOutputDir: pluginOutputDir ?? existing.pluginOutputDir,
      hookScope: hookScope ?? existing.hookScope
    })
    return
  }
  startedSessions.set(threadId, { workspacePath, pluginOutputDir, hookScope })
  const context: HookContext = {
    workspacePath,
    pluginOutputDir,
    sessionId: threadId
  }
  runHooks(
    resolveEnabledHooksForRun(workspacePath, "SessionStart", context, hookScope),
    "SessionStart",
    context,
    onHookResult
  ).catch((e) => console.warn("[Hooks] SessionStart hook error:", e))
}

/** Fire SessionEnd for a thread if it previously fired SessionStart. No-op otherwise. */
export async function fireSessionEnd(
  threadId: string,
  workspacePath?: string,
  onHookResult?: HookResultCallback,
  pluginOutputDir?: string
): Promise<void> {
  const started = startedSessions.get(threadId)
  if (!started) return
  startedSessions.delete(threadId)
  const effectiveWorkspacePath = workspacePath ?? started.workspacePath
  const effectivePluginOutputDir = pluginOutputDir ?? started.pluginOutputDir
  const context: HookContext = {
    workspacePath: effectiveWorkspacePath,
    pluginOutputDir: effectivePluginOutputDir,
    sessionId: threadId
  }
  await runHooks(
    resolveEnabledHooksForRun(effectiveWorkspacePath, "SessionEnd", context, started.hookScope),
    "SessionEnd",
    context,
    onHookResult
  ).catch((e) => console.warn("[Hooks] SessionEnd hook error:", e))
  // Drop this thread's `once` fired-state so a future thread with the same id
  // (re-import / re-create) starts fresh. Bounded — runs after SessionEnd hooks
  // complete so `once` SessionEnd hooks themselves still fire correctly.
  clearOnceStateForSession(threadId)
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
  if (entries.length === 0) return
  const all = Promise.allSettled(
    entries.map(([id, session]) => {
      const context: HookContext = {
        sessionId: id,
        workspacePath: session.workspacePath,
        pluginOutputDir: session.pluginOutputDir
      }
      return runHooks(
        resolveEnabledHooksForRun(session.workspacePath, "SessionEnd", context, session.hookScope),
        "SessionEnd",
        context,
        getOnHookResult?.(id)
      ).finally(() => clearOnceStateForSession(id))
    })
  )
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([all, timeout])
}
