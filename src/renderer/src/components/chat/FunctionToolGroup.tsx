import type { ReactNode } from "react"
import type { ModObject } from "../../../../shared/mods/types"
import { functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"

/** Native rows are rendered only at the protected engine position; approvals stay host-owned. */
export function FunctionToolGroup({
  threadId,
  calls,
  blocked,
  isActive,
  children
}: {
  threadId: string
  calls: unknown[]
  blocked: boolean
  isActive: boolean
  children(expanded: boolean, safeCalls?: ModObject[]): ReactNode
}): ReactNode {
  let facts: ModObject
  try {
    if (blocked) return children(false)
    facts = functionSiteProps("ToolGroup", { calls, isActive, isExpanded: false })
  } catch {
    return children(false)
  }
  return (
    <FunctionSite
      threadId={threadId}
      component="ToolGroup"
      facts={facts}
      fallback={children(false)}
      renderNative={(safe) => {
        let checked: ModObject
        try {
          checked = functionSiteProps("ToolGroup", safe)
        } catch {
          return null
        }
        const pinned = (value: ModObject) =>
          (value.calls as ModObject[]).map((call) => [
            call.tool_use_id,
            call.tool,
            call.isRunning,
            call.isErrored,
            call.isInterrupted
          ])
        if (
          checked.isActive !== facts.isActive ||
          JSON.stringify(pinned(checked)) !== JSON.stringify(pinned(facts))
        )
          return null
        return children(checked.isExpanded === true, checked.calls as ModObject[])
      }}
      className="contents"
    />
  )
}
