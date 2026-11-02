import { useEffect, type ReactNode } from "react"
import { FEATURE_GATES } from "../../../../shared/feature-gates"
import { useFeatureGate } from "../../lib/feature-gates"

/** Resolve the entry before showing editable forms; a late gate must not discard a draft. */
export function ProjectPlatformEntry({
  children,
  onActiveSessionThreadChange
}: {
  children: ReactNode
  onActiveSessionThreadChange?: (threadId: string | null) => void
}) {
  const { enabled, loading, reason } = useFeatureGate(FEATURE_GATES.projectMode, {
    verifyDisabled: true
  })
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
      <div role="status" className="p-4 text-sm text-muted-foreground">
        {reason === "feature-gate-client-error"
          ? "暂时无法核对项目模式权限，请检查连接后重新进入。"
          : "当前账号尚未开放项目模式，请开通后重新进入。"}
      </div>
    )
  return <>{children}</>
}
