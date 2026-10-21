import { BookOpen } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function ThreadSkillUsageMetric({
  skills,
  loading,
  error,
  onRetry
}: {
  skills: string[]
  loading: boolean
  error?: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 border-r border-border px-4 py-2.5">
      <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[10px] text-muted-foreground">使用过的技能</p>
        {error ? (
          <button
            className="text-xs text-destructive hover:underline"
            title={error}
            onClick={onRetry}
          >
            加载失败，重试
          </button>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">加载中…</p>
        ) : skills.length ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="block max-w-56 truncate text-[12px] font-semibold">
                {skills.join("、")}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-h-48 max-w-sm overflow-y-auto">
              {skills.map((skill) => (
                <p key={skill} className="break-all">
                  {skill}
                </p>
              ))}
            </TooltipContent>
          </Tooltip>
        ) : (
          <p className="text-xs text-muted-foreground">未记录</p>
        )}
      </div>
    </div>
  )
}
