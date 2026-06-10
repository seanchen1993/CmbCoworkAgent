import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, GitCommitHorizontal, Loader2 } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { TaskCardPicker } from "@/components/git/TaskCardPicker"
import { useWorkspaceTaskCard } from "@/components/git/use-workspace-task-card"
import { DiffDisplay } from "./DiffDisplay"
import { cn } from "@/lib/utils"
import type { TaskCardItem } from "../../../../shared/task-card-types"

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

/**
 * Pull the commit type + plain message out of a message the agent suggested via `-m`.
 * If the agent already produced a CMB-formatted message (`#comment <type>:<msg> #CMBDevClaw`)
 * we unwrap it so the user edits the inner text instead of nesting the format twice.
 */
function parseSuggestedMessage(raw?: string): { type?: CommitType; message: string } {
  const text = (raw || "").trim()
  if (!text) return { message: "" }
  const match = text.match(/#comment\s+([A-Za-z]+):([\s\S]*?)\s*#CMBDevClaw\s*$/i)
  if (match) {
    const parsedType = COMMIT_TYPES.find((item) => item.value === match[1].toLowerCase())?.value
    return { type: parsedType, message: match[2].trim() }
  }
  return { message: text }
}

export interface AgentCommitOutcome {
  success: boolean
  commitMessage?: string
  error?: string
}

interface AgentGitCommitDialogProps {
  /** The git_commit approval request, or null when no commit is pending. */
  open: boolean
  threadId: string
  workspacePath?: string | null
  /** Message the agent passed to `git commit -m`, used as the initial message. */
  suggestedMessage?: string
  /** Called after the commit succeeds; the parent resolves the approval with the result. */
  onCommitted: (outcome: AgentCommitOutcome) => void
  /** Called when the user cancels; the parent rejects the approval. */
  onCancel: () => void
}

/**
 * Task-card commit dialog shown when the agent runs `git commit`. Mirrors the Git Panel's
 * commit form (task card + type + message) and performs the actual commit through the same
 * `workspace:commitWorktree` IPC, then reports the outcome back so the agent's tool call
 * resolves. The CMB commit-message format is built here so it stays consistent everywhere.
 */
export function AgentGitCommitDialog({
  open,
  threadId,
  workspacePath,
  suggestedMessage,
  onCommitted,
  onCancel
}: AgentGitCommitDialogProps): React.JSX.Element {
  const { cardNumber, handleCardNumberChange, persistNow } = useWorkspaceTaskCard(workspacePath)
  // Seed type + message from the agent's suggestion. The parent remounts this dialog
  // (via a key tied to the approval id) for each new commit, so lazy initializers give
  // fresh state per commit without a state-resetting effect.
  const [commitType, setCommitType] = useState<CommitType>(
    () => parseSuggestedMessage(suggestedMessage).type ?? "fix"
  )
  const [commitMessage, setCommitMessage] = useState(
    () => parseSuggestedMessage(suggestedMessage).message
  )
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Changed files + diffs for the thread workspace, so the user sees exactly what scope
  // will be committed (commitWorktree commits the agent's tracked changes, not a
  // hand-picked set). Mirrors the data the Git Panel shows.
  const [diff, setDiff] = useState<{
    files: Array<{ path: string; additions: number; deletions: number; diff: string }>
    totals: { fileCount: number; additions: number; deletions: number }
    omittedFileCount: number
  } | null>(null)
  // Starts true so the first paint shows "加载中"; the fetch's finally clears it. The
  // dialog is remounted per commit (keyed on the approval id), so this re-initializes.
  const [diffLoading, setDiffLoading] = useState(true)
  const [showDiffDetails, setShowDiffDetails] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api.workspace
      .getGitPanelDiffs(threadId)
      .then((res) => {
        if (cancelled || !res.success) return
        setDiff({
          files: res.files ?? [],
          totals: res.totals,
          omittedFileCount: res.omittedFileCount ?? 0
        })
      })
      .catch(() => {
        /* best-effort: the commit itself still validates there are changes */
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, threadId])

  const combinedDiff = useMemo(
    () => (diff?.files ?? []).map((f) => f.diff).filter(Boolean).join("\n"),
    [diff]
  )

  const cardValue = cardNumber.trim()
  const messageValue = commitMessage.trim()
  const cardMissing = !cardValue
  const messageMissing = !messageValue
  const finalMessage = useMemo(
    () => (cardValue ? `${cardValue} #comment ${commitType}:${messageValue} #CMBDevClaw` : ""),
    [cardValue, commitType, messageValue]
  )

  const handleSubmit = async (): Promise<void> => {
    if (running || cardMissing || messageMissing) return
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.workspace.commitWorktree(threadId, finalMessage)
      if (!result.success) {
        setError(result.error || "提交失败")
        setRunning(false)
        return
      }
      // Remember the card actually committed with for this workspace.
      persistNow(cardValue)
      onCommitted({ success: true, commitMessage: finalMessage })
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败")
      setRunning(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-lg rounded-2xl border border-border bg-background p-0 shadow-xl flex max-h-[85vh] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 px-5 py-4 border-b border-border/70">
          <GitCommitHorizontal className="size-4 text-status-info" />
          <div className="text-[16px] font-semibold">Agent 请求提交</div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="rounded-xl border border-border/70 bg-muted/25 p-3 mx-4 mt-4 space-y-2">
          <div className="text-xs text-muted-foreground">
            Agent 想要提交当前工作区改动。请选择任务卡片并确认，将按 CMB 规范生成 commit message。
          </div>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">变更</span>
            <span className="font-medium">
              {diffLoading && !diff ? (
                <span className="text-muted-foreground">加载中...</span>
              ) : (
                <>
                  <span>{diff?.totals.fileCount ?? 0} 文件</span>
                  <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                    +{diff?.totals.additions ?? 0}
                  </span>
                  <span className="ml-1 text-rose-600 dark:text-rose-400">
                    -{diff?.totals.deletions ?? 0}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>

        {diff && diff.files.length > 0 && (
          <div className="mx-4 mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-foreground">
                变更文件（{diff.files.length}）
              </div>
              {combinedDiff && (
                <button
                  type="button"
                  className="text-[11px] text-status-info hover:underline"
                  onClick={() => setShowDiffDetails((v) => !v)}
                >
                  {showDiffDetails ? "隐藏改动详情" : "查看改动详情"}
                </button>
              )}
            </div>
            <div className="rounded-lg border border-border/70 divide-y divide-border/60 overflow-hidden max-h-40 overflow-y-auto">
              {diff.files.map((file) => (
                <div
                  key={file.path}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                >
                  <span className="truncate font-mono text-foreground" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 font-medium">
                    <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                    <span className="ml-1 text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
            {diff.omittedFileCount > 0 && (
              <div className="text-[11px] text-muted-foreground">
                另有 {diff.omittedFileCount} 个文件因体积过大未展示明细
              </div>
            )}
            {showDiffDetails && combinedDiff && (
              <div className="rounded-lg border border-border/70 overflow-hidden">
                <DiffDisplay diff={combinedDiff} />
              </div>
            )}
          </div>
        )}

        <form
          className="px-5 py-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="font-medium text-foreground">任务卡片</label>
              <span
                className={cn(
                  "text-[11px]",
                  cardMissing ? "text-destructive" : "text-muted-foreground"
                )}
              >
                必填
              </span>
            </div>
            <TaskCardPicker
              value={cardNumber}
              onValueChange={(nextValue, card?: TaskCardItem | null) =>
                handleCardNumberChange(nextValue, card)
              }
              autoSelect={false}
              disabled={running}
              placeholder="选择任务卡片"
              className={cn(cardMissing && "border-destructive/50 focus-visible:ring-destructive/40")}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">提交类型</label>
            <Select
              value={commitType}
              onValueChange={(value) => setCommitType(value as CommitType)}
              disabled={running}
            >
              <SelectTrigger className="w-full">
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
              <label htmlFor="agent-commit-message" className="font-medium text-foreground">
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
              id="agent-commit-message"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="请输入本次修改说明"
              rows={4}
              disabled={running}
              className={cn(
                "flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y",
                messageMissing && "border-destructive/50 focus-visible:ring-destructive/40"
              )}
            />
          </div>

          {finalMessage && (
            <div className="rounded-lg border border-border/70 bg-background-secondary p-2.5">
              <div className="text-[11px] text-muted-foreground mb-1">最终 commit message 预览</div>
              <code className="block text-[11px] leading-5 break-all text-foreground">
                {finalMessage}
              </code>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/45 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </form>
        </div>

        <div className="shrink-0 border-t border-border/70 px-5 pb-5 pt-3 flex flex-col gap-2 bg-background">
          <Button
            type="button"
            className="w-full h-9"
            disabled={running || cardMissing || messageMissing}
            onClick={() => void handleSubmit()}
          >
            {running ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                提交中...
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4" />
                确认提交
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full h-9"
            disabled={running}
            onClick={onCancel}
          >
            取消提交
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
