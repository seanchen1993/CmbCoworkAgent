import { useState, type ReactNode } from "react"
import type { ModObject } from "../../../../shared/mods/types"
import { functionSiteProps } from "../../../../shared/mods/v2/sites"
import { FunctionSite } from "./FunctionSite"

/** Group presentation augments native rows; approval controls never enter this site. */
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
  children(expanded: boolean): ReactNode
}): ReactNode {
  let facts: ModObject
  try {
    if (blocked) return children(false)
    facts = functionSiteProps("ToolGroup", { calls, isActive, isExpanded: false })
  } catch {
    return children(false)
  }
  return (
    <GroupSite threadId={threadId} facts={facts}>
      {children}
    </GroupSite>
  )
}

function GroupSite({
  threadId,
  facts,
  children
}: {
  threadId: string
  facts: ModObject
  children(expanded: boolean): ReactNode
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <FunctionSite
        threadId={threadId}
        component="ToolGroup"
        facts={facts}
        onExpansion={setExpanded}
        fallback={null}
        className="contents"
      />
      {children(expanded)}
    </>
  )
}
