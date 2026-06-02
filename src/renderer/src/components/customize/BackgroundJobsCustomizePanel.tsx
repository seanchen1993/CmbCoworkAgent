import { BriefcaseBusiness } from "lucide-react"
import { BackgroundJobsPanel } from "@/components/panels/BackgroundJobsPanel"
import { useAppStore } from "@/lib/store"
import { useThreadState } from "@/lib/thread-context"

export function BackgroundJobsCustomizePanel(): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const workspacePath = threadState?.workspacePath ?? null

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted/60">
              <BriefcaseBusiness className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-foreground">后台任务</h2>
              <p className="mt-1 text-xs text-muted-foreground">查看当前工作目录的后台 job 执行记录</p>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 p-4">
          <div className="h-full min-h-0 overflow-hidden rounded-xl border border-border/70 bg-background/80">
            <BackgroundJobsPanel workspacePath={workspacePath} />
          </div>
        </div>
      </div>
    </div>
  )
}
