/**
 * Pure, Electron-free predicate extracted from runtime.ts so the worker-watchdog
 * approval-exemption probe can be unit-tested without importing the Electron-
 * coupled runtime module.
 *
 * True when an approval registered on `approvalRuntimeThreadId` belongs to
 * `targetRuntimeThreadId` — either the exact thread OR one of its sub-threads.
 * Worker / nested runtimes use the `${parent}__worker__${id}` (and deeper
 * `__`-delimited) convention, so a pending approval on a sub-thread must count
 * as an approval for the target.
 *
 * The trailing `__` separator in the prefix check is load-bearing: it prevents a
 * sibling thread that merely shares a name prefix (e.g. `t1` vs `t10`) from
 * being treated as a sub-thread. Matching bare `startsWith(target)` would leak
 * across siblings and wrongly exempt/keep-alive an unrelated worker.
 */
export function approvalMatchesRuntimeThread(
  approvalRuntimeThreadId: string,
  targetRuntimeThreadId: string
): boolean {
  return (
    approvalRuntimeThreadId === targetRuntimeThreadId ||
    approvalRuntimeThreadId.startsWith(`${targetRuntimeThreadId}__`)
  )
}
