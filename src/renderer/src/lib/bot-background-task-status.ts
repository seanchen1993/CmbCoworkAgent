import type { WorkflowRunView } from "./workflow-run-view"

/** Running work stays visible across new questions; old terminal runs stay in history. */
export function isBotBackgroundStatusVisible(
  run: Pick<WorkflowRunView, "status" | "startedAtMs">,
  latestUserTime: number | null
): boolean {
  return (
    run.status === "running" ||
    latestUserTime === null ||
    !Number.isFinite(latestUserTime) ||
    !Number.isFinite(run.startedAtMs) ||
    run.startedAtMs >= latestUserTime
  )
}
