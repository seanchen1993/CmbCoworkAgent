/**
 * Per-thread run overrides for API-driven (HTTP) agent runs.
 *
 * yolo and the Windows sandbox mode are otherwise GLOBAL settings
 * (getYoloMode / getWindowsSandboxMode). API threads need per-thread control so
 * a remote request can, e.g., run with yolo OFF (approvals surface in the app)
 * or disable the flaky Windows sandbox — without touching the user's global
 * settings or other threads. The runtime consults these at its single
 * yolo/sandbox resolution points.
 *
 * Dependency-free on purpose: imported by both the core runtime and the API
 * feature, so it must not import back into either (no cycles). In-memory only —
 * the API bridge re-applies them from the thread's persisted metadata on each
 * run, so they survive restarts.
 */

// Per-thread yolo override. Present = force this value; absent = use the global
// getYoloMode(). (true = auto-approve all; false = normal approvals.)
const yoloOverrideByThread = new Map<string, boolean>()

// Threads whose runs must disable the (Windows) sandbox.
const sandboxDisabledThreads = new Set<string>()

/** Force yolo on/off for a thread, or pass undefined to clear the override. */
export function setThreadYoloOverride(threadId: string, yolo: boolean | undefined): void {
  if (yolo === undefined) {
    yoloOverrideByThread.delete(threadId)
  } else {
    yoloOverrideByThread.set(threadId, yolo)
  }
}

/** The thread's yolo override, or undefined to fall back to the global setting. */
export function getThreadYoloOverride(threadId: string): boolean | undefined {
  return yoloOverrideByThread.get(threadId)
}

/** Mark (or clear) a thread as having its sandbox disabled. */
export function setThreadSandboxDisabled(threadId: string, disabled: boolean): void {
  if (disabled) {
    sandboxDisabledThreads.add(threadId)
  } else {
    sandboxDisabledThreads.delete(threadId)
  }
}

/** True when this thread's runs must skip the (Windows) sandbox. */
export function isThreadSandboxDisabled(threadId: string): boolean {
  return sandboxDisabledThreads.has(threadId)
}
