import { useEffect, useId } from "react"
import type { ProjectAnalysisAgentProps } from "./ProjectAnalysisAgent"

type SourceProps = Omit<
  ProjectAnalysisAgentProps,
  "open" | "onOpenChange" | "onRunningChange" | "sourceAvailable"
>
interface Workspace {
  accountRevision: number
  session: number
  sourceId: string
  scopeKey: string
  props: SourceProps
  attached: boolean
  open: boolean
  running: boolean
}
let workspace: Workspace | null = null
let accountRevision: number | null = null
let session = 0
const listeners = new Set<() => void>()
const publish = (next: Workspace | null) => {
  workspace = next
  for (const listener of listeners) listener()
}
export const readProjectAgentWorkspace = () => workspace
export function subscribeProjectAgentWorkspace(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const resetProjectAgentWorkspace = () => publish(null)
export function setProjectAgentAccount(revision: number | null) {
  accountRevision = revision
  resetProjectAgentWorkspace()
}
export function setProjectAgentOpen(open: boolean) {
  if (workspace && workspace.open !== open) publish({ ...workspace, open })
}
export function setProjectAgentRunning(running: boolean) {
  if (workspace && workspace.running !== running) publish({ ...workspace, running })
}

/** Only the lightweight Agent workspace survives route changes; dashboard pages may unmount. */
export function useProjectAgentLauncher(props: SourceProps, scopeKey: string) {
  const sourceId = useId()
  useEffect(() => {
    if (workspace?.sourceId !== sourceId) return
    // An explicit room/permission change on the source page still discards that source's session.
    if (workspace.scopeKey !== scopeKey) resetProjectAgentWorkspace()
    else publish({ ...workspace, props, attached: true })
  })
  useEffect(
    () => () => {
      if (workspace?.sourceId === sourceId) publish({ ...workspace, attached: false })
    },
    [sourceId]
  )
  return () => {
    if (accountRevision === null) return
    // Opening another menu's entry must not replace a running task or its frozen scope.
    if (workspace?.running) {
      setProjectAgentOpen(true)
      return
    }
    publish({
      accountRevision,
      session: workspace?.scopeKey === scopeKey ? workspace.session : ++session,
      sourceId,
      scopeKey,
      props,
      attached: true,
      open: true,
      running: false
    })
  }
}
