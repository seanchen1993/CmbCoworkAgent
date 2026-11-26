import { resolve } from "node:path"
import { getWorkspaceExecutionKey } from "../agent/file-operation-lock"
import { getBtwParentId } from "../../shared/btw-chat"
import {
  clearOnceStateForSession,
  runHooks,
  runSetupHooks,
  type HookContext,
  type HookResultCallback
} from "./runner"
import { getSideThreadLifetimeSignal } from "../side-thread-registry"
import { waitForAbort } from "../utils/wait-for-abort"
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
  // Cleared when Setup or SessionStart is dispatched and SessionEnd becomes due.
  preparing?: AbortController
  setup?: Promise<void>
  workspacePath?: string
  pluginOutputDir?: string
  systemId?: string
  pluginWorkspace?: string
  featureId?: string
  harnessProjectId?: string
  harnessAdapterId?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  projectCode?: string
  projectDir?: string
  hookScope?: HookScopeController
}

const startedSessions = new Map<string, StartedSession>()
// A close may be awaiting a workspace command when the app begins its quit drain.
const closingSideSessions = new Map<string, Promise<void>>()
interface SideSetup {
  parentId: string
  workspaceKey: string
  lifetime: AbortSignal
  attempt: Promise<void>
}
const pendingSideSetups = new Set<SideSetup>()
// Keep only same-family attempts overlapping a marker read, including ones that end before it returns.
const markerReads = new Set<{ parentId: string; candidates: Set<SideSetup> }>()

// Only a closing side can hand off Setup. Independent sessions keep their original concurrency.
async function needsWorkspaceSetup(parentId: string, workspacePath: string, signal: AbortSignal): Promise<boolean> {
  const candidates = new Set([...pendingSideSetups].filter(setup => setup.parentId === parentId))
  const read = { parentId, candidates }
  markerReads.add(read)
  try {
    if (await hasWorkspaceBeenInitialised(workspacePath, signal)) return false
    const workspaceKey = resolve(workspacePath)
    let targetDirectory: Promise<string> | undefined
    while (!signal.aborted) {
      const closing = [...candidates].filter(setup => setup.lifetime.aborted)
      if (closing.length === 0) return true
      const initialised = Promise.withResolvers<boolean>()
      const attempts = closing.map(async setup => {
        candidates.delete(setup)
        if (setup.workspaceKey === workspaceKey) {
          await setup.attempt
        } else {
          targetDirectory ??= getWorkspaceExecutionKey(workspaceKey)
          const aliases = Promise.all([targetDirectory, getWorkspaceExecutionKey(setup.workspaceKey)])
            .then(([target, source]) => target === source, () => false)
          if (await Promise.race([aliases, setup.attempt.then(() => false)])) await setup.attempt
        }
        if (!signal.aborted && await hasWorkspaceBeenInitialised(workspacePath, signal)) initialised.resolve(true)
      })
      const done = Promise.race([initialised.promise, Promise.all(attempts).then(() => false)])
      if (await waitForAbort(done, signal)) return false
      // All checked attempts failed. A different side may have closed while we waited.
    }
    return false
  } finally {
    markerReads.delete(read)
  }
}

/** True when there are still-active sessions awaiting SessionEnd. */
export function hasActiveSessions(): boolean {
  return startedSessions.size > 0 || closingSideSessions.size > 0
}

/** Fire SessionStart exactly once per threadId lifetime (within the main-process run). */
export async function fireSessionStartOnce(
  threadId: string,
  workspacePath?: string,
  onHookResult?: HookResultCallback,
  hookScope?: HookScopeController,
  onHookSkipped?: ScopeSkipCallback,
  turnId?: string,
  pluginOutputDir?: string,
  systemId?: string,
  harnessContext?: Pick<
    HookContext,
    | "pluginWorkspace"
    | "featureId"
    | "harnessProjectId"
    | "harnessAdapterId"
    | "harnessAdapterName"
    | "harnessAdapterVersion"
    | "harnessNodeName"
    | "harnessNodeStatus"
    | "projectCode"
    | "projectDir"
  >,
  runSignal?: AbortSignal
): Promise<void> {
  const lifetime = getSideThreadLifetimeSignal(threadId)
  if (lifetime?.aborted || runSignal?.aborted) return
  const existing = startedSessions.get(threadId)
  if (existing) {
    Object.assign(existing, {
      workspacePath: workspacePath ?? existing.workspacePath,
      pluginOutputDir: pluginOutputDir ?? existing.pluginOutputDir,
      systemId: systemId ?? existing.systemId,
      pluginWorkspace: harnessContext?.pluginWorkspace ?? existing.pluginWorkspace,
      featureId: harnessContext?.featureId ?? existing.featureId,
      harnessProjectId: harnessContext?.harnessProjectId ?? existing.harnessProjectId,
      harnessAdapterId: harnessContext?.harnessAdapterId ?? existing.harnessAdapterId,
      harnessAdapterName: harnessContext?.harnessAdapterName ?? existing.harnessAdapterName,
      harnessAdapterVersion:
        harnessContext?.harnessAdapterVersion ?? existing.harnessAdapterVersion,
      harnessNodeName: harnessContext?.harnessNodeName ?? existing.harnessNodeName,
      harnessNodeStatus: harnessContext?.harnessNodeStatus ?? existing.harnessNodeStatus,
      projectCode: harnessContext?.projectCode ?? existing.projectCode,
      projectDir: harnessContext?.projectDir ?? existing.projectDir,
      hookScope: hookScope ?? existing.hookScope
    })
    return existing.setup
  }
  const preparing = new AbortController()
  const session: StartedSession = {
    preparing,
    workspacePath,
    pluginOutputDir,
    systemId,
    pluginWorkspace: harnessContext?.pluginWorkspace,
    featureId: harnessContext?.featureId,
    harnessProjectId: harnessContext?.harnessProjectId,
    harnessAdapterId: harnessContext?.harnessAdapterId,
    harnessAdapterName: harnessContext?.harnessAdapterName,
    harnessAdapterVersion: harnessContext?.harnessAdapterVersion,
    harnessNodeName: harnessContext?.harnessNodeName,
    harnessNodeStatus: harnessContext?.harnessNodeStatus,
    projectCode: harnessContext?.projectCode,
    projectDir: harnessContext?.projectDir,
    hookScope
  }
  startedSessions.set(threadId, session)

  const parentId = getBtwParentId(threadId) ?? threadId
  let needsSetup = false
  if (workspacePath) {
    const signals = [preparing.signal, lifetime, runSignal].filter((s): s is AbortSignal => !!s)
    const signal = AbortSignal.any(signals)
    try {
      needsSetup = await waitForAbort(needsWorkspaceSetup(parentId, workspacePath, signal), signal)
      signal.throwIfAborted()
    } catch (e) {
      if (startedSessions.get(threadId) === session) startedSessions.delete(threadId)
      if (signal.aborted) return
      throw e
    }
  }
  delete session.preparing
  if (workspacePath && needsSetup) {
    try {
      const setupContext: HookContext = {
        workspacePath,
        sessionId: threadId,
        turnId,
        pluginOutputDir,
        systemId,
        ...harnessContext,
        setupTrigger: "init"
      }
      const hooks = resolveEnabledHooksForRun(
        workspacePath,
        "Setup",
        setupContext,
        hookScope,
        onHookSkipped
      )
      // Closing the initiating side releases its wait. A later session joins
      // the actual batch and can retry with its own context if it fails.
      const attempt = runSetupHooks(hooks, setupContext, onHookResult)
        .then(async (result) => {
          if (result === null) {
            await markWorkspaceInitialised(workspacePath)
          } else if (!lifetime?.aborted) {
            console.warn(
              `[Hooks] Setup(init) skipped marker write — at least one hook failed:`,
              result.stderr || result.stdout || "(no detail)"
            )
          }
        })
        .catch((e) => {
          if (!lifetime?.aborted) console.warn("[Hooks] Setup(init) hook error:", e)
        })
      if (lifetime) {
        const setup = { parentId, workspaceKey: resolve(workspacePath), lifetime, attempt }
        pendingSideSetups.add(setup)
        for (const read of markerReads) {
          if (read.parentId === parentId) read.candidates.add(setup)
        }
        void attempt.then(() => pendingSideSetups.delete(setup))
      }
      session.setup = attempt
      await waitForAbort(attempt, lifetime)
    } catch (e) {
      if (!lifetime?.aborted) console.warn("[Hooks] Setup(init) hook error:", e)
    } finally {
      delete session.setup
    }
  }
  if (lifetime?.aborted || startedSessions.get(threadId) !== session) return

  const context: HookContext = {
    workspacePath,
    sessionId: threadId,
    turnId,
    pluginOutputDir,
    systemId,
    ...harnessContext,
    // PR-16 follow-up — CC SessionStart matcher matches on `source`. This
    // project doesn't yet distinguish resume / clear / compact paths from a
    // fresh launch, so the value is hard-coded "startup" here.
    sessionStartSource: "startup"
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
  onHookResult?: HookResultCallback,
  pluginOutputDir?: string,
  // PR-16 follow-up — CC matcher target for SessionEnd is `reason`. Default is
  // "clear" (the thread:delete IPC path); the before-quit shutdown drain
  // calls fireSessionEndAll which supplies "logout".
  reason: "clear" | "logout" | "prompt_input_exit" | "other" = "clear"
): Promise<void> {
  const started = startedSessions.get(threadId)
  if (!started) return closingSideSessions.get(threadId)
  startedSessions.delete(threadId)
  if (started.preparing) {
    started.preparing.abort()
    clearOnceStateForSession(threadId)
    return
  }
  const effectiveWorkspacePath = workspacePath ?? started.workspacePath
  const effectivePluginOutputDir = pluginOutputDir ?? started.pluginOutputDir
  const context: HookContext = {
    workspacePath: effectiveWorkspacePath,
    pluginOutputDir: effectivePluginOutputDir,
    systemId: started.systemId,
    pluginWorkspace: started.pluginWorkspace,
    featureId: started.featureId,
    harnessProjectId: started.harnessProjectId,
    harnessAdapterId: started.harnessAdapterId,
    harnessAdapterName: started.harnessAdapterName,
    harnessAdapterVersion: started.harnessAdapterVersion,
    harnessNodeName: started.harnessNodeName,
    harnessNodeStatus: started.harnessNodeStatus,
    projectCode: started.projectCode,
    projectDir: started.projectDir,
    sessionId: threadId,
    sessionEndReason: reason
  }
  const end = runHooks(
    resolveEnabledHooksForRun(effectiveWorkspacePath, "SessionEnd", context, started.hookScope),
    "SessionEnd",
    context,
    onHookResult
  ).then(() => undefined, (e) => console.warn("[Hooks] SessionEnd hook error:", e))
  if (getSideThreadLifetimeSignal(threadId)) closingSideSessions.set(threadId, end)
  await end
  if (closingSideSessions.get(threadId) === end) closingSideSessions.delete(threadId)
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
  const pending = [...closingSideSessions.values()]
  for (const threadId of [...startedSessions.keys()]) {
    pending.push(fireSessionEnd(threadId, undefined, getOnHookResult?.(threadId), undefined, "logout"))
  }
  if (pending.length === 0) return
  const all = Promise.allSettled(pending)
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([all, timeout])
}
