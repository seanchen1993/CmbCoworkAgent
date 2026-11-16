import { lazy, Suspense, useLayoutEffect, useSyncExternalStore } from "react"
import {
  readProjectAgentWorkspace,
  setProjectAgentAccount,
  setProjectAgentOpen,
  setProjectAgentRunning,
  subscribeProjectAgentWorkspace
} from "./project-agent-workspace"

const Agent = lazy(() =>
  import("./ProjectAnalysisAgent").then((module) => ({ default: module.ProjectAnalysisAgent }))
)

/** Mounted once by the app shell, outside every menu/page branch. */
export function ProjectAgentWorkspaceHost({
  enabled,
  accountRevision
}: {
  enabled: boolean
  accountRevision: number
}) {
  const workspace = useSyncExternalStore(
    subscribeProjectAgentWorkspace,
    readProjectAgentWorkspace,
    readProjectAgentWorkspace
  )
  useLayoutEffect(() => {
    setProjectAgentAccount(enabled ? accountRevision : null)
    return () => setProjectAgentAccount(null)
  }, [accountRevision, enabled])
  if (!enabled || !workspace || workspace.accountRevision !== accountRevision) return null
  return (
    <Suspense fallback={null}>
      <Agent
        key={workspace.session}
        {...workspace.props}
        open={workspace.open}
        sourceAvailable={workspace.attached}
        onOpenChange={setProjectAgentOpen}
        onRunningChange={setProjectAgentRunning}
      />
    </Suspense>
  )
}
