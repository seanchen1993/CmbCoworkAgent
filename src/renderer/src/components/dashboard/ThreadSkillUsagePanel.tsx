import type {
  DashboardThreadSkill,
  DashboardThreadSkillSource
} from "../../../../shared/dashboard-thread-skills"

export function ThreadSkillUsagePanel({
  skills,
  error,
  onRetry,
  onViewSource
}: {
  skills?: DashboardThreadSkill[]
  error?: string
  onRetry: () => void
  onViewSource: (skill: string, source: DashboardThreadSkillSource) => void
}): React.JSX.Element | null {
  if (error) {
    return (
      <div className="mb-3 flex items-center gap-2 text-xs text-destructive" role="alert">
        <span>会话技能汇总加载失败</span>
        <button type="button" className="underline" title={error} onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }
  if (!skills?.length) return null
  return (
    <details className="mb-3 rounded-md border border-border bg-muted/10 p-3" open>
      <summary className="cursor-pointer text-xs font-medium">
        本会话使用的技能（{skills.length}）
      </summary>
      <p className="mt-1 text-[10px] text-muted-foreground">
        汇总主 Agent 和子 Agent 实际读取的技能，点击来源查看会话。
      </p>
      <div className="mt-2 max-h-36 space-y-2 overflow-y-auto">
        {skills.map(({ skill, sources }) => (
          <div key={skill} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="break-all font-medium">{skill}</span>
            {sources.map((source) => (
              <button
                key={source.threadId ?? source.traceId ?? source.label}
                type="button"
                disabled={!source.threadId}
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                title={source.threadId ?? "未记录来源会话"}
                onClick={() => onViewSource(skill, source)}
              >
                {source.isSubagent ? "由 " : ""}
                {source.label}
                {" 加载"}
              </button>
            ))}
          </div>
        ))}
      </div>
    </details>
  )
}
