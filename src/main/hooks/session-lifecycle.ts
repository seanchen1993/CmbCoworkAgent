import { clearOnceStateForSession, runHooks, type HookResultCallback } from "./runner"
import type { HookContext } from "./runner"
import type { HookAccountingBinder } from "./model-accounting"
import { isCreatorBudgetError } from "../mods/devtools/creator-model-accounting"
import { captureRuntimePluginSourceToken, retainRuntimePluginSourceToken, withRuntimePluginSource,
  type RuntimePluginSourceToken } from "../plugins/runtime-source-scope"
import type { SnapshotLease } from "../harness-board/project-runtime/snapshot-retention"
import { derivationFamilyFor } from "../plugins/derivation-scope"
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
  derivationBinding?: boolean
  pluginSourceSnapshot?: RuntimePluginSourceToken
  snapshotLease?: SnapshotLease
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

/** True when there are still-active sessions awaiting SessionEnd. */
export function hasActiveSessions(): boolean {
  return startedSessions.size > 0
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
  bindHookAccounting?: HookAccountingBinder
): Promise<void> {
  const existing = startedSessions.get(threadId)
  if (existing) {
    const derivationBinding = Boolean(existing.derivationBinding ||
      derivationFamilyFor(existing.harnessAdapterId ?? "") ||
      derivationFamilyFor(harnessContext?.harnessAdapterId ?? ""))
    if (derivationBinding && (
      existing.harnessAdapterId !== harnessContext?.harnessAdapterId ||
      existing.harnessProjectId !== harnessContext?.harnessProjectId ||
      existing.workspacePath !== (workspacePath ?? existing.workspacePath) ||
      existing.pluginOutputDir !== (pluginOutputDir ?? existing.pluginOutputDir) ||
      existing.systemId !== (systemId ?? existing.systemId) ||
      existing.pluginWorkspace !== (harnessContext?.pluginWorkspace ?? existing.pluginWorkspace) ||
      existing.projectDir !== (harnessContext?.projectDir ?? existing.projectDir) ||
      existing.projectCode !== (harnessContext?.projectCode ?? existing.projectCode) ||
      existing.featureId !== (harnessContext?.featureId ?? existing.featureId)
    )) throw Error("插件谱系会话绑定或目录已变化，请在新会话中开始项目")
    const pluginSourceSnapshot = captureRuntimePluginSourceToken() ?? existing.pluginSourceSnapshot
    const snapshotLease = pluginSourceSnapshot === existing.pluginSourceSnapshot
      ? existing.snapshotLease
      : retainRuntimePluginSourceToken(pluginSourceSnapshot, "deferred-session-end", true)
    if (snapshotLease !== existing.snapshotLease) existing.snapshotLease?.release()
    startedSessions.set(threadId, {
      derivationBinding,
      pluginSourceSnapshot,
      snapshotLease,
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
    return
  }
  const pluginSourceSnapshot = captureRuntimePluginSourceToken()
  startedSessions.set(threadId, {
    derivationBinding: Boolean(derivationFamilyFor(harnessContext?.harnessAdapterId ?? "")),
    pluginSourceSnapshot,
    snapshotLease: retainRuntimePluginSourceToken(pluginSourceSnapshot, "deferred-session-end", true),
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
  })

  // PR-11 — Setup fires (per-workspace) *before* SessionStart when this is
  // the workspace's first encounter on this machine. SessionStart remains
  // per-thread; this gives a clean "repo init" extension point that doesn't
  // re-fire for every new thread in the same workspace.
  //
  // PR-11 follow-up — runHooks's "Setup" branch is now awaited and surfaces
  // a synthetic blocking result when any hook timed out or returned non-zero
  // exit. We only write the workspace setup-state marker when that returns
  // a nonblocking success from a participating handler, so empty chains and
  // failed init runs remain eligible when Setup is installed or retried later.
  if (workspacePath && !hasWorkspaceBeenInitialised(workspacePath)) {
    const setupContext: HookContext = {
      workspacePath,
      sessionId: threadId,
      turnId,
      pluginOutputDir,
      systemId,
      ...harnessContext,
      setupTrigger: "init"
    }
    bindHookAccounting?.(setupContext)
    try {
      let participated = false
      const result = await runHooks(
        resolveEnabledHooksForRun(workspacePath, "Setup", setupContext, hookScope, onHookSkipped),
        "Setup",
        setupContext,
        (event, hook, result) => {
          // Only matched legacy handlers reach the runner's result callback.
          participated = true
          onHookResult?.(event, hook, result)
        },
        () => { participated = true }
      )
      // A Function handler can return valid context without producing a legacy
      // result. Participation comes from native dispatch provenance, not fields
      // in its JSON output. Engine-only dispatch and pure skips do not count.
      const succeeded = result === null || (result.exitCode === 0 && !result.blocked &&
        result.continue !== false && result.decision !== "block")
      if (participated && succeeded) {
        markWorkspaceInitialised(workspacePath)
      } else if (!succeeded) {
        console.warn(
          `[Hooks] Setup(init) skipped marker write — at least one hook failed:`,
          result.stderr || result.stdout || "(no detail)"
        )
      }
    } catch (e) {
      if (isCreatorBudgetError(e)) throw e
      console.warn("[Hooks] Setup(init) hook error:", e)
    }
  }

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
  bindHookAccounting?.(context)
  void runHooks(
    resolveEnabledHooksForRun(workspacePath, "SessionStart", context, hookScope, onHookSkipped),
    "SessionStart",
    context,
    onHookResult
  ).catch((e) => {
    console.warn("[Hooks] SessionStart hook error:", e)
  })
  // SessionStart remains observational; the runner records a budget denial without
  // changing its original scheduling. Never retain billing in startedSessions.
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
  if (!started) return
  startedSessions.delete(threadId)
  const frozen = started.derivationBinding ||
    Boolean(derivationFamilyFor(started.harnessAdapterId ?? ""))
  const effectiveWorkspacePath = frozen ? started.workspacePath : workspacePath ?? started.workspacePath
  const effectivePluginOutputDir = frozen ? started.pluginOutputDir : pluginOutputDir ?? started.pluginOutputDir
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
  await Promise.resolve().then(() => withRuntimePluginSource(started.pluginSourceSnapshot, () => runHooks(
    resolveEnabledHooksForRun(effectiveWorkspacePath, "SessionEnd", context, started.hookScope),
    "SessionEnd",
    context,
    onHookResult
  ))).catch((e) => console.warn("[Hooks] SessionEnd hook error:", e))
    .finally(() => started.snapshotLease?.release())
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
        pluginOutputDir: session.pluginOutputDir,
        systemId: session.systemId,
        pluginWorkspace: session.pluginWorkspace,
        featureId: session.featureId,
        harnessProjectId: session.harnessProjectId,
        harnessAdapterId: session.harnessAdapterId,
        harnessAdapterName: session.harnessAdapterName,
        harnessAdapterVersion: session.harnessAdapterVersion,
        harnessNodeName: session.harnessNodeName,
        harnessNodeStatus: session.harnessNodeStatus,
        projectCode: session.projectCode,
        projectDir: session.projectDir,
        // PR-16 follow-up — before-quit drain → CC `reason: "logout"`.
        sessionEndReason: "logout"
      }
      return Promise.resolve().then(() => withRuntimePluginSource(session.pluginSourceSnapshot, () => runHooks(
        resolveEnabledHooksForRun(session.workspacePath, "SessionEnd", context, session.hookScope),
        "SessionEnd",
        context,
        getOnHookResult?.(id)
      ))).finally(() => {
        session.snapshotLease?.release()
        clearOnceStateForSession(id)
      })
    })
  )
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  await Promise.race([all, timeout])
}
