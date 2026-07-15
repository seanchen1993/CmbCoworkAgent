import { AlertTriangle, GitCommit, Loader2, Upload } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface GitPushDialogProps {
  open: boolean
  running: boolean
  branch: string
  pendingCommits?: Array<{ hash: string; message: string; date: string }>
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
}

export function GitPushDialog({
  open,
  running,
  branch,
  pendingCommits,
  onOpenChange,
  onSubmit
}: GitPushDialogProps): React.JSX.Element {
  const commitCount = pendingCommits?.length ?? 0
  const noPushableCommits = commitCount === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-2xl border border-border bg-background p-0 shadow-xl">
        <div className="px-5 py-4 border-b border-border/70">
          <div className="text-[16px] font-semibold">Git 推送</div>
          <div className="mt-1 text-xs text-muted-foreground">
            只推送已提交但未 push 的 commit
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-xl border border-border/70 bg-muted/25 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">分支</span>
              <span className="font-mono text-foreground truncate max-w-[300px]" title={branch || "-"}>
                {branch || "-"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">待推送</span>
              <span className="font-medium">{commitCount} commits</span>
            </div>
          </div>

          {noPushableCommits ? (
            <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <div className="font-semibold">没有可 Push 的 commit</div>
                  <div className="mt-1 text-xs leading-5">
                    当前分支没有检测到待推送提交。如需推送新改动，请先完成 Commit。
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 text-sm text-muted-foreground">
              Push 不会提交当前未提交文件。如需推送新的改动，请先完成 Commit。
            </div>
          )}

          {pendingCommits && pendingCommits.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <GitCommit className="size-3.5" />
                待推送的 {pendingCommits.length} 个提交
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/10 divide-y divide-border/50 max-h-[180px] overflow-y-auto">
                {pendingCommits.map((commit) => (
                  <div key={commit.hash} className="px-2.5 py-2 flex items-start gap-2">
                    <code className="shrink-0 text-[10px] font-mono text-muted-foreground mt-0.5">
                      {commit.hash.slice(0, 7)}
                    </code>
                    <span className="text-xs text-foreground break-all leading-5">
                      {commit.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
          <Button
            id="git-push-button"
            type="button"
            className="w-full h-9"
            disabled={running || noPushableCommits}
            onClick={onSubmit}
          >
            {running ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                推送中，可能稍慢，请耐心等待...
              </>
            ) : (
              <>
                <Upload className="size-4" />
                Push 推送
              </>
            )}
          </Button>

          <Button
            id="git-cancel-button"
            type="button"
            variant="ghost"
            className="w-full h-9"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
