import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
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

export type CommitType = (typeof COMMIT_TYPES)[number]["value"]

interface GitCommitDialogProps {
  open: boolean
  running: boolean
  branch: string
  fileCount: number
  additions: number
  deletions: number
  cardNumber: string
  commitType: CommitType
  commitMessage: string
  onOpenChange: (open: boolean) => void
  onCardNumberChange: (value: string) => void
  onCommitTypeChange: (value: CommitType) => void
  onCommitMessageChange: (value: string) => void
  onSubmit: () => void
}

export function GitCommitDialog({
  open,
  running,
  branch,
  fileCount,
  additions,
  deletions,
  cardNumber,
  commitType,
  commitMessage,
  onOpenChange,
  onCardNumberChange,
  onCommitTypeChange,
  onCommitMessageChange,
  onSubmit
}: GitCommitDialogProps): React.JSX.Element {
  const cardValue = cardNumber.trim()
  const messageValue = commitMessage.trim()
  const finalMessagePreview = cardValue
    ? `${cardValue} #comment ${commitType}:${messageValue || "<message>"} #CMBDevClaw`
    : ""
  const noSelectedFiles = fileCount <= 0
  const cardMissing = !noSelectedFiles && !cardValue
  const messageMissing = !noSelectedFiles && !messageValue

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg rounded-2xl border border-border bg-background p-0 shadow-xl">
        <div className="px-5 py-4 border-b border-border/70">
          <div className="text-[16px] font-semibold">Git 提交</div>
          <div className="mt-1 text-xs text-muted-foreground">提交选中的文件改动</div>
        </div>

        <form
          className="px-5 py-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
          }}
        >
          <div className="rounded-xl border border-border/70 bg-muted/25 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">分支</span>
              <span className="font-mono text-foreground truncate max-w-[300px]" title={branch || "-"}>
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

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="git-card-number" className="font-medium text-foreground">
                卡片编号
              </label>
              <span className={cn("text-[11px]", cardMissing ? "text-destructive" : "text-muted-foreground")}>
                必填
              </span>
            </div>
            <Input
              id="git-card-number"
              value={cardNumber}
              onChange={(e) => onCardNumberChange(e.target.value)}
              placeholder="例如：CMP-1024"
              required
              className={cn(cardMissing && "border-destructive/50 focus-visible:ring-destructive/40")}
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
              <span className={cn("text-[11px]", messageMissing ? "text-destructive" : "text-muted-foreground")}>
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
              <div className="text-[11px] text-muted-foreground mb-1">最终 commit message 预览</div>
              <code className="block text-[11px] leading-5 break-all text-foreground">
                {finalMessagePreview}
              </code>
            </div>
          )}

          {noSelectedFiles && (
            <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <div className="font-semibold">没有可 Commit 的文件变更</div>
                  <div className="mt-1 text-xs leading-5">
                    当前选择为 0 文件，请先在文件列表中选择要提交的变更。
                  </div>
                </div>
              </div>
            </div>
          )}
        </form>

        <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
          <Button
            id="git-commit-button"
            type="button"
            className="w-full h-9"
            disabled={running || cardMissing || messageMissing || noSelectedFiles}
            onClick={onSubmit}
          >
            {running ? (
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
