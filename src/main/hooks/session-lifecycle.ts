import { clearOnceStateForSession, runHooks, type HookResultCallback } from "./runner"
import type { HookContext } from "./runner"
import {
  resolveEnabledHooksForRun,
  type HookScopeController,
  type ScopeSkipCallback
} from "./scope"
import {
  hasWorkspaceBeenInitialised,
  markWorkspaceInitialised
} from "../services/setup-state"

// Map<threadId, workspacePath?>. Cleanup paths:
//   - fireSessionEnd(threadId)  ← threads:delete handler removes the entry
//   - fireSessionEndAll()       ← before-quit drains everything
// As long as both call sites stay wired, this Map is bounded by live thread count.
interface StartedSession {
  workspacePath?: string
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
  onHookSkipped?: ScopeSkipCallback,
  turnId?: string
): void {
  const existing = startedSessions.get(threadId)
  if (existing) {
    startedSessions.set(threadId, {
      workspacePath: workspacePath ?? existing.workspacePath,
      hookScope: hookScope ?? existing.hookScope
    })
    return
  }
  startedSessions.set(threadId, { workspacePath, hookScope })

  // PR-11 — Setup fires (per-workspace, fire-and-forget) *before* SessionStart
  // when this is the workspace's first encounter on this machine. SessionStart
  // remains per-thread; this gives a clean "repo init" extension point that
  // doesn't re-fire for every new thread in the same workspace. The state
  // marker is written after the Setup runHooks promise resolves so a crashed
  // hook does not skip future retries.
  if (workspacePath && !hasWorkspaceBeenInitialised(workspacePath)) {
    const setupContext: HookContext = {
      workspacePath,
      sessionId: threadId,
      turnId,
      setupTrigger: "init"
    }
    runHooks(
      resolveEnabledHooksForRun(workspacePath, "Setup", setupContext, hookScope, onHookSkipped),
      "Setup",
      setupContext,
      onHookResult
    )
      .then(() => markWorkspaceInitialised(workspacePath))
      .catch((e) => console.warn("[Hooks] Setup(init) hook error:", e))
  }

  const context: HookContext = {
    workspacePath,
    sessionId: threadId,
    turnId
  }
  runHooks(
    resolveEnabledHooksForRun(workspacePath, "SessionStart", context, hookScope, onHookSkipped),
    "SessionStart",
    context,
    onHookResult
  ).catch((e) => console.warn("[Hooks] SessionStart hook error:", e))
}

/**
 * PR-11 — Fire Setup(maintenance) on user demand. Bypasses the per-workspace
 * init marker so the user can deliberately re-run the maintenance hook chain
 * without deleting state files. Fire-and-forget.
 */
export function fireSetupMaintenance(
  workspacePath: string,
  onHookResult?: HookResultCallback,
  hookScope?: HookScopeController,
  onHookSkipped?: ScopeSkipCallback
): Promise<void> {
  if (!workspacePath) return Promise.resolve()
  const context: HookContext = {
    workspacePath,
    setupTrigger: "maintenance"
  }
  return runHooks(
    resolveEnabledHooksForRun(workspacePath, "Setup", context, hookScope, onHookSkipped),
    "Setup",
    context,
    onHookResult
  )
    .then(() => undefined)
    .catch((e) => console.warn("[Hooks] Setup(maintenance) hook error:", e))
}

/** Fire SessionEnd for a thread if it previously fired SessionStart. No-op otherwise. */
export async function fireSessionEnd(
  threadId: string,
  workspacePath?: string,
  onHookResult?: HookResultCallback
): Promise<void> {
  const started = startedSessions.get(threadId)
  if (!started) return
  startedSessions.delete(threadId)
  const effectiveWorkspacePath = workspacePath ?? started.workspacePath
  const context: HookContext = {
    workspacePath: effectiveWorkspacePath,
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
      const context: HookContext = { sessionId: id, workspacePath: session.workspacePath }
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
