import type { HarnessWatchRef } from "../../../shared/harness-board-types"

/** Original board watch layout, owned by the AutoBiz compatibility adapter. */
export function makeAutobizWatchRefs(slug?: string): HarnessWatchRef[] {
  const base = ".autobizdevops"
  return slug
    ? [
        { path: `${base}/STATE.md`, purpose: "run-state" },
        { path: `${base}/features/${slug}`, purpose: "artifacts" },
        { path: `${base}/features/${slug}/hooks.ndjson`, purpose: "hook-log" }
      ]
    : [{ path: `${base}/STATE.md`, purpose: "run-list" }]
}
