/**
 * Per-thread run flags for API-driven (headless HTTP) agent runs.
 *
 * A thread created and driven through the HTTP API gateway has no interactive
 * user to answer tool-approval prompts, so its runs must "auto-approve all"
 * (YOLO). YOLO is otherwise a global setting (`getYoloMode()`); forcing it
 * globally would leak into the user's own local threads. Instead the API bridge
 * marks just its own threads here, and the runtime honors this per-thread flag
 * at its single yolo-resolution point.
 *
 * Dependency-free on purpose: imported by both the core runtime and the API
 * feature, so it must not import back into either (no cycles).
 */

const forcedYoloThreads = new Set<string>()

/** Force (or clear) auto-approve-all for a specific thread's runs. */
export function setForcedYoloThread(threadId: string, forced: boolean): void {
  if (forced) {
    forcedYoloThreads.add(threadId)
  } else {
    forcedYoloThreads.delete(threadId)
  }
}

/** True when this thread's runs must skip all tool-approval prompts. */
export function isForcedYoloThread(threadId: string): boolean {
  return forcedYoloThreads.has(threadId)
}
