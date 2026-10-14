import { useEffect, type ReactNode } from "react"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import { useFeatureGate } from "../../lib/feature-gates"
import { LocalProjectsPanel } from "./LocalProjectsPanel"

/** Resolve the entry before showing editable forms; a late gate must not discard a draft. */
export function ProjectPlatformEntry({
  children,
  onActiveSessionThreadChange
}: {
  children: ReactNode
  onActiveSessionThreadChange?: (threadId: string | null) => void
}) {
  const { enabled, loading } = useFeatureGate(FEATURE_GATES.projectMode, { verifyDisabled: true })
  useEffect(() => {
    if (!enabled) onActiveSessionThreadChange?.(null)
  }, [enabled, onActiveSessionThreadChange])
  if (loading && !enabled)
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        正在准备项目入口…
      </div>
    )
  if (!enabled)
    return (
      <div className="h-full min-w-0 overflow-y-auto p-4">
        <LocalProjectsPanel />
      </div>
    )
  return <>{children}</>
}
