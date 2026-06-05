import { BrowserWindow, type WebContents } from "electron"
import type { HookResultCallback } from "./runner"
import type { HookConfig, HookEvent, HookResult } from "./types"
import type { ScopeSkipCallback, ScopeSkipReason } from "./scope"
import {
  buildHookResultRecord,
  buildHookSkippedRecord,
  persistHookRecordOnce,
  type HookExecutedEnvelope,
  type ScopedHook
} from "./log-record"

function emit(webContents: WebContents, channel: string, envelope: HookExecutedEnvelope): void {
  if (webContents.isDestroyed()) return
  webContents.send(channel, { type: "custom", data: envelope })
}

export function makeHookResultCallback(
  window: BrowserWindow,
  channel: string,
  turnId?: string
): HookResultCallback {
  return (event: HookEvent, hook: HookConfig, result: HookResult): void => {
    const envelope = buildHookResultRecord(event, hook, result, turnId)
    if (!envelope) return
    if (window.isDestroyed()) return
    emit(window.webContents, channel, envelope)
  }
}

/**
 * Hook-result callback for coordinator workers.
 *
 * Workers run detached/async (CoordinatorWorkerManager background promise), so
 * their hooks typically fire after the spawning turn's run stream has closed —
 * at which point the run-scoped `agent:stream:${threadId}` listener is gone and
 * `makeHookResultCallback`'s emit is dropped. Worker tool/stream activity avoids
 * this by using a durable, thread-scoped channel; this callback does the same
 * for hook records.
 *
 * The envelope is delivered raw (not wrapped in the `{type:"custom"}` stream
 * shape) on `agent:coordinator-worker-hook:${parentThreadId}`; the renderer
 * feeds it straight into `handleCustomEvent`, which dispatches on
 * `envelope.type === "hook_executed"`.
 */
export function makeCoordinatorWorkerHookResultCallback(
  window: BrowserWindow,
  parentThreadId: string,
  turnId?: string
): HookResultCallback {
  const channel = `agent:coordinator-worker-hook:${parentThreadId}`
  return (event: HookEvent, hook: HookConfig, result: HookResult): void => {
    const envelope = buildHookResultRecord(event, hook, result, turnId)
    if (!envelope) return
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(channel, envelope)
  }
}

export function makeBroadcastHookResultCallback(channel: string, turnId?: string): HookResultCallback {
  return (event: HookEvent, hook: HookConfig, result: HookResult): void => {
    const envelope = buildHookResultRecord(event, hook, result, turnId)
    if (!envelope) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      emit(window.webContents, channel, envelope)
    }
  }
}

/**
 * Skip-event callback factory — diagnostic mode only. Feed this into
 * `resolveEnabledHooksForRun(..., onSkipped)` so the renderer can show
 * "matched but filtered out" rows.
 *
 * `event` is captured in the closure rather than passed at call time:
 * `ScopeSkipCallback` only receives `(hook, reason)` — the event isn't part
 * of the per-hook information `filterScopedHooks` has, so callers must
 * supply it once when constructing the callback (one factory call per
 * `resolveEnabledHooksForRun` invocation).
 *
 * Diagnostic gate lives inside `buildHookSkippedRecord`, so constructing the
 * callback is cheap even when logging is disabled — calling it just hits the
 * gate and returns.
 */
export function makeHookSkippedCallback(
  window: BrowserWindow,
  channel: string,
  event: HookEvent,
  turnId?: string
): ScopeSkipCallback {
  return (hook, reason: ScopeSkipReason): void => {
    const envelope = buildHookSkippedRecord(event, hook as ScopedHook, reason, turnId)
    if (!envelope) return
    persistHookRecordOnce(envelope)
    if (window.isDestroyed()) return
    emit(window.webContents, channel, envelope)
  }
}
