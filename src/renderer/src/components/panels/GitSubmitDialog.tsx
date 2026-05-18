import { CheckCircle2, GitCommit, Loader2, Upload } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const COMMIT_TYPES = [
  { value: "fix", label: "fix" },
  { value: "feat", label: "feat" },
  { value: "refactor", label: "refactor" },
  { value: "docs", label: "docs" },
  { value: "style", label: "style" },
  { value: "test", label: "test" },
  { value: "chore", label: "chore" }
] as const

type CommitType = (typeof COMMIT_TYPES)[number]["value"]

type GitSubmitAction = "commit" | "push"

interface GitSubmitDialogProps {
  open: boolean
  action: GitSubmitAction | null
  running: "commit" | "push" | null
  branch: string
  fileCount: number
  additions: number
  deletions: number
  requiresCommitMetadata: boolean
  cardNumber: string
  commitType: CommitType
  commitMessage: string
  pendingCommits?: Array<{ hash: string; message: string; date: string }>
  onOpenChange: (open: boolean) => void
  onCardNumberChange: (value: string) => void
  onCommitTypeChange: (value: CommitType) => void
  onCommitMessageChange: (value: string) => void
  onSubmit: (action: GitSubmitAction) => void
}

export function GitSubmitDialog({
  open,
  action,
  running,
  branch,
  fileCount,
  additions,
  deletions,
  requiresCommitMetadata,
  cardNumber,
  commitType,
  commitMessage,
  pendingCommits,
  onOpenChange,
  onCardNumberChange,
  onCommitTypeChange,
  onCommitMessageChange,
  onSubmit
}: GitSubmitDialogProps): React.JSX.Element {
  const formId = "git-submit-form"
  const cardValue = cardNumber.trim()
  const messageValue = commitMessage.trim()
  const finalMessagePreview = cardValue
    ? `${cardValue} #comment ${commitType}:${messageValue || "<message>"} #CMBDevClaw`
    : ""
  const cardMissing = requiresCommitMetadata && !cardValue
  const messageMissing = requiresCommitMetadata && !messageValue
  const commitRunning = running === "commit"
  const pushRunning = running === "push"
  const anyRunning = running !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-2xl border border-border bg-background p-0 shadow-xl">
        <div className="px-5 py-4 border-b border-border/70">
          <div className="text-[16px] font-semibold">Git 提交</div>
          <div className="mt-1 text-xs text-muted-foreground">审核改动后选择提交或推送</div>
        </div>

        <form
          id={formId}
          className="px-5 py-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
          }}
        >
          <div className="rounded-xl border border-border/70 bg-muted/25 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">分支</span>
              <span
                className="font-mono text-foreground truncate max-w-[300px]"
                title={branch || "-"}
              >
                {branch || "-"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">变更</span>
              <span className="font-medium">
                <span>{fileCount} 文件</span>
                <span className="ml-2 text-emerald-600 dark:text-emerald-400">+{additions}</span>
                <span className="ml-1 text-rose-600 dark:text-rose-400">-{deletions}</span>
              </span>
            </div>
          </div>

          {requiresCommitMetadata ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="git-card-number" className="font-medium text-foreground">
                    卡片编号
                  </label>
                  <span
                    className={cn(
                      "text-[11px]",
                      cardMissing ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    必填
                  </span>
                </div>
                <Input
                  id="git-card-number"
                  value={cardNumber}
                  onChange={(e) => onCardNumberChange(e.target.value)}
                  placeholder="例如：CMP-1024"
                  required
                  className={cn(
                    cardMissing && "border-destructive/50 focus-visible:ring-destructive/40"
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="git-commit-type" className="font-medium text-foreground">
                    提交类型
                  </label>
                </div>
                <Select value={commitType} onValueChange={onCommitTypeChange}>
                  <SelectTrigger id="git-commit-type" className="w-full">
                    <SelectValue placeholder="选择提交类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMIT_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="git-message" className="font-medium text-foreground">
                    提交消息
                  </label>
                  <span
                    className={cn(
                      "text-[11px]",
                      messageMissing ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    必填
                  </span>
                </div>
                <textarea
                  id="git-message"
                  value={commitMessage}
                  onChange={(e) => onCommitMessageChange(e.target.value)}
                  placeholder="请输入本次修改说明"
                  rows={4}
                  className={cn(
                    "flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y",
                    messageMissing && "border-destructive/50 focus-visible:ring-destructive/40"
                  )}
                />
              </div>

              {cardValue && (
                <div className="rounded-lg border border-border/70 bg-background-secondary p-2.5">
                  <div className="text-[11px] text-muted-foreground mb-1">
                    最终 commit message 预览
                  </div>
                  <code className="block text-[11px] leading-5 break-all text-foreground">
                    {finalMessagePreview}
                  </code>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 text-sm text-muted-foreground">
                当前没有文件改动，将直接推送已有提交。
              </div>
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
          )}
        </form>

        <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
          {requiresCommitMetadata ? (
            <>
              <Button
                id={"git-commit-button"}
                type="button"
                className="w-full h-9"
                variant={action === "push" ? "outline" : "default"}
                disabled={anyRunning || cardMissing || messageMissing}
                onClick={() => onSubmit("commit")}
              >
                {commitRunning ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    提交中...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="size-4" />
                    Commit 提交
                  </>
                )}
              </Button>

              <Button
                id={"git-commit-push-button"}
                type="button"
                className="w-full h-9"
                variant={action === "push" ? "default" : "outline"}
                disabled={anyRunning || cardMissing || messageMissing}
                onClick={() => onSubmit("push")}
              >
                {pushRunning ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    推送中，可能稍慢，请耐心等待...
                  </>
                ) : (
                  <>
                    <Upload className="size-4" />
                    Commit 并 Push 推送
                  </>
                )}
              </Button>
            </>
          ) : (
            <Button
              id={"git-push-button"}
              type="button"
              className="w-full h-9"
              disabled={anyRunning}
              onClick={() => onSubmit("push")}
            >
              {pushRunning ? (
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
          )}

          <Button
            id={"git-cancel-button"}
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
