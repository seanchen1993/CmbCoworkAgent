import { TimeControlBar, type DashboardTimeControl } from "./TimeControlBar"
import type {
  RunAnalysisMembership,
  RunAnalysisRange
} from "../../../../shared/project-run-analysis"

/** The analysis panel and Agent edit the same membership selection. */
export function ProjectAnalysisMembership({
  value,
  onChange,
  disabled = false
}: {
  value: RunAnalysisMembership
  onChange: (value: RunAnalysisMembership) => void
  disabled?: boolean
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs">
      <span className="shrink-0">查看范围</span>
      <select
        aria-label="查看范围"
        className="h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as RunAnalysisMembership)}
      >
        <option value="active">进行中的全部项目</option>
        <option value="executed">所选日期内有执行（含归档）</option>
        <option value="created">所选日期内新建项目（含归档）</option>
      </select>
    </label>
  )
}

export function ProjectAnalysisScope({
  range,
  timeControl,
  membership,
  busy,
  onMembershipChange
}: {
  range: RunAnalysisRange
  timeControl: Omit<DashboardTimeControl, "range">
  membership: RunAnalysisMembership
  busy: boolean
  onMembershipChange: (value: RunAnalysisMembership) => void
}) {
  return (
    <div className="shrink-0 space-y-1 border-b border-border pb-2">
      <TimeControlBar
        key={`${range.from}:${range.to}`}
        {...timeControl}
        range={range}
        disabled={busy}
        className="gap-2 border-0 bg-transparent p-0 backdrop-blur-none"
        orgFilter={
          <ProjectAnalysisMembership
            value={membership}
            onChange={onMembershipChange}
            disabled={busy}
          />
        }
      />
      <p className="text-xs text-muted-foreground">
        {membership === "active"
          ? "与面板筛选同步；进行中的全部项目不受日期限制。"
          : "与面板筛选同步；日期用于筛选项目，指标为累计值。"}
      </p>
    </div>
  )
}
