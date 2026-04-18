import { useState, useCallback, useEffect } from "react"
import {
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Undo2,
  GitBranch,
  ShieldCheck,
  TriangleAlert,
  FolderOpen,
  CheckCircle2,
  RefreshCw,
  ArrowDown
} from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffDisplay } from "@/components/chat/ToolCallRenderer"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { GitSubmitDialog } from "./GitSubmitDialog"
import { insertLog } from "../../../js/mmjUtils"

export function GitPanelView({
  threadId,
  workspacePath,
  onOpenFileFolder
}: {
  threadId: string
  workspacePath: string | null
  onOpenFileFolder?: (filePath: string) => void
}): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState<"commit" | "push" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitAction, setSubmitAction] = useState<"commit" | "push" | null>(null)
  const [cardNumber, setCardNumber] = useState("")
  const [commitType, setCommitType] = useState<"fix" | "feat" | "refactor" | "docs" | "style" | "test" | "chore">("fix")
  const [commitMessage, setCommitMessage] = useState("")
  const [expandedFilePaths, setExpandedFilePaths] = useState<Set<string>>(new Set())
  const [revertingFilePath, setRevertingFilePath] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [state, setState] = useState<{
    success: boolean
    isWorktree: boolean
    isGitRepo?: boolean
    taskId: string
    files: Array<{ path: string; diff: string; additions: number; deletions: number }>
    totals: { additions: number; deletions: number; fileCount: number }
    hasPendingDiff: boolean
    hasPushableCommit: boolean
    pendingCommits?: Array<{ hash: string; message: string; date: string }>
    worktreeBranch?: string | null
    suggestedCommitMessage?: string
    error?: string
  } | null>(null)

  useEffect(() => {
    setState(null)
    setError(null)
    setExpandedFilePaths(new Set())
  }, [threadId])

  const showToast = useCallback((text: string, variant: "success" | "error" = "success"): void => {
    if (variant === "success") {
      toast.success(text)
      return
    }
    toast.error(text)
  }, [])

  const refresh = useCallback(async () => {
    if (!threadId) return
    setLoading(true)
    try {
      const next = await window.api.workspace.getGitPanelState(threadId)
      setState(next)
      // showToast("刷新完成", "success")
    } catch (e) {
      const err = e instanceof Error ? e.message : "加载失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setLoading(false)
    }
  }, [threadId, showToast])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const files = state?.files ?? []
    setExpandedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      const next = new Set([...prev].filter((path) => files.some((f) => f.path === path)))
      if (next.size === 0) {
        next.add(files[0].path)
      }
      return next
    })
  }, [state?.files])

  const toggleFileExpanded = useCallback((filePath: string): void => {
    setExpandedFilePaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!threadId) return
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId !== threadId) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refresh()
      }, 120)
    })
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      cleanup()
    }
  }, [threadId, refresh])

  const runReject = useCallback(async () => {
    if (!threadId) return
    setRunning("reject")
    setError(null)
    try {
      const result = await window.api.workspace.rejectWorktreeChanges(threadId)
      if (!result.success) throw new Error(result.error || "回滚失败")
      showToast("已全部回退到上一版编辑内容", "success")
      await refresh()
    } catch (e) {
      const err = e instanceof Error ? e.message : "操作失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setRunning(null)
    }
  }, [threadId, refresh, showToast])

  const runSubmit = useCallback(
    async (action: "commit" | "push") => {
      if (!threadId) return
      const hasPendingChanges = Boolean(state?.hasPendingDiff)

      if (action === "commit" && !hasPendingChanges) {
        showToast("当前没有可提交改动", "error")
        return
      }

      if ((action === "commit" || hasPendingChanges) && !cardNumber.trim()) {
        showToast("cardNumber 不能为空", "error")
        return
      }

      if ((action === "commit" || hasPendingChanges) && !commitMessage.trim()) {
        showToast("commitMessage 不能为空", "error")
        return
      }

      const finalMessage = `${cardNumber.trim()} #comment fix:${commitMessage.trim()} #CMBDevClaw`

      setRunning(action)
      setError(null)
      try {
        if (action === "commit") {
          const result = await window.api.workspace.commitWorktree(threadId, finalMessage)
          if (!result.success) throw new Error(result.error || "提交失败")
          showToast("提交成功", "success")
          insertLog('commit成功')
        } else {
          const result = hasPendingChanges
            ? await window.api.workspace.pushWorktree(threadId, finalMessage)
            : await window.api.workspace.pushWorktree(threadId)
          if (!result.success) throw new Error(result.error || "推送失败")
          showToast("推送成功", "success")
          insertLog('push成功')
        }
        setCardNumber("")
        setCommitMessage("")
        setSubmitAction(null)
        await refresh()
      } catch (e) {
        const err = e instanceof Error ? e.message : "操作失败"
        setError(err)
        showToast(err, "error")
      } finally {
        setRunning(null)
      }
    },
    [threadId, cardNumber, commitMessage, state?.hasPendingDiff, refresh, showToast]
  )

  const handleRevertFile = useCallback(
    async (filePath: string) => {
      if (!threadId) return
      setRevertingFilePath(filePath)
      setError(null)
      try {
        const result = await window.api.workspace.rejectWorktreeFile(threadId, filePath)
        if (!result.success) throw new Error(result.error || "文件回退失败")
        showToast(`已回退文件：${filePath}`, "success")
        await refresh()
      } catch (e) {
        const err = e instanceof Error ? e.message : "文件回退失败"
        setError(err)
        showToast(err, "error")
      } finally {
        setRevertingFilePath(null)
      }
    },
    [threadId, refresh, showToast]
  )

  const runPull = useCallback(async () => {
    if (!threadId) return
    setPulling(true)
    setError(null)
    try {
      const result = await window.api.workspace.pullWorktree(threadId)
      if (!result.success) throw new Error(result.error || "拉取失败")
      showToast(result.detail || "拉取成功", "success")
      await refresh()
    } catch (e) {
      const err = e instanceof Error ? e.message : "拉取失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setPulling(false)
    }
  }, [threadId, refresh, showToast])

  const hasPending = Boolean(state?.hasPendingDiff)
  const hasGitRepo = Boolean(state?.isGitRepo ?? state?.isWorktree)
  const isWorktreePath = Boolean(state?.isWorktree)
  // Keep the submit entry visible for git repos so users can push right after commit,
  // even if pushability detection lags or temporarily reports false.
  const canShowSubmit = hasGitRepo
  const workspaceName = workspacePath
    ? workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath
    : "未关联路径"
  const branchName = state?.worktreeBranch || "-"

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
      <div className="sticky top-0 z-10 px-3 py-2 border-b border-border/70 bg-background-elevated/80 backdrop-blur shrink-0">
        <div className="rounded-lg border border-border/70 bg-background/90 px-2.5 py-2">
          <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1 flex-wrap">
            <span className="font-semibold text-foreground">{workspaceName}</span>
            <span>•</span>
            <span className="text-blue-600 dark:text-blue-400 font-medium">{state?.totals.fileCount ?? 0} files</span>
            <span>,</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{state?.totals.additions ?? 0}</span>
            <span>/</span>
            <span className="text-rose-600 dark:text-rose-400 font-semibold">-{state?.totals.deletions ?? 0}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className="h-5 px-2 text-[10px] normal-case tracking-normal shrink-0 gap-1"
            >
              <GitBranch className="size-2.5" />
              <span className="max-w-[200px] truncate" title={branchName}>
                分支 {branchName}
              </span>
            </Badge>
            {hasGitRepo && (
              <Badge
                variant="outline"
                className={cn(
                  "h-5 px-2 text-[10px] tracking-normal gap-1",
                  isWorktreePath
                    ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/45 text-amber-700 dark:text-amber-300"
                )}
              >
                {isWorktreePath ? (
                  <ShieldCheck className="size-2.5" />
                ) : (
                  <TriangleAlert className="size-2.5" />
                )}
                {isWorktreePath ? "Worktree" : "主仓库目录"}
              </Badge>
            )}
          </div>
          {hasGitRepo && (
            <p className="mt-1.5 text-xs text-muted-foreground leading-5">
              {isWorktreePath
                ? "当前目录是独立 worktree，可直接执行提交与推送。建议保持一个任务一个 worktree。"
                : "当前目录是 Git 仓库主目录。建议切换到独立 worktree 后再执行任务，更安全。"}
            </p>
          )}
          {hasGitRepo && (
            <div className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-2 justify-between">
              <div className={'flex space-x-2'}>
                {canShowSubmit && (
                  <button
                    onClick={() => setSubmitAction(hasPending ? "commit" : "push")}
                    disabled={running !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive transition-colors"
                  >
                    <GitBranch className="size-3.5" />
                    Git提交
                  </button>
                )}

                {hasPending && (
                  <button
                    id={'git-reject-all-button'}
                    onClick={() => {
                      void runReject()
                    }}
                    disabled={running !== null}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/50 text-destructive px-2 py-1 text-[11px] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-destructive/10 transition-colors"
                  >
                    <Undo2 className="size-3.5" />
                    {running === "reject" ? "全部回退中..." : "全部回退"}
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  id="git-refresh-button"
                  onClick={() => {
                    void refresh()
                  }}
                  disabled={loading}
                  title="刷新"
                  aria-label="刷新"
                  className={cn(
                    "group inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-[11px] font-medium",
                    "border border-border/80 bg-background/60 text-muted-foreground",
                    "active:scale-[0.97] transition-all duration-200",
                    loading && "border-blue-400/60 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/30",
                    "disabled:cursor-not-allowed"
                  )}
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5 transition-transform duration-300",
                      loading ? "animate-spin" : "group-hover:rotate-90"
                    )}
                  />
                  {loading ? "刷新中..." : "刷新"}
                </button>
                <button
                  id="git-pull-button"
                  onClick={() => {
                    void runPull()
                  }}
                  disabled={pulling || loading}
                  title="Pull 远端代码"
                  aria-label="Pull 远端代码"
                  className={cn(
                    "group inline-flex items-center gap-1.5 rounded-xl px-3 py-1 text-[11px] font-medium",
                    "border border-border/80 bg-background/60 text-muted-foreground",
                    "active:scale-[0.97] transition-all duration-200",
                    pulling && "border-blue-400/60 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/30",
                    "disabled:cursor-not-allowed"
                  )}
                >
                  <ArrowDown
                    className={cn(
                      "size-3.5 transition-transform duration-300",
                      pulling ? "animate-bounce" : "group-hover:translate-y-0.5"
                    )}
                  />
                  {pulling ? "拉取中..." : "Pull"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="overflow-y-auto overflow-x-hidden right-panel-scroll bg-background flex-1 min-h-0 p-3 space-y-3">
        {(error || state?.error) && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
            <span>{error || state?.error}</span>
          </div>
        )}
        {state && !hasGitRepo && (
          <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            当前任务未关联 Git 仓库。请先在工作区选择器绑定 Git 仓库路径。
          </div>
        )}
        {state !== null && hasGitRepo && (
          <>
            {state.files.length === 0 ? (
              <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-8">
                <div className="mx-auto max-w-[340px] text-center">
                  <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 className="size-4.5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="text-sm font-medium text-foreground">没有待审批改动</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    当前工作区已是最新状态。后续产生文件变更时，这里会自动显示最新 diff。
                  </p>
                </div>
              </div>
            ) : (
              <>
                {state.files.filter((file) => file.diff && file.diff.trim() !== "").map((file) => (
                  <div key={file.path} className="rounded-md border border-border/70 p-2 bg-white">
                    <button
                      type="button"
                      onClick={() => toggleFileExpanded(file.path)}
                      className="w-full flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        {expandedFilePaths.has(file.path) ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span
                          className="font-mono font-semibold truncate text-left"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{file.additions}
                          </span>
                          <span className="text-muted-foreground">/</span>
                          <span className="text-rose-600 dark:text-rose-400">
                            -{file.deletions}
                          </span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span
                          role="button"
                          tabIndex={0}
                          title="打开文件夹"
                          aria-label="打开文件夹"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpenFileFolder?.(file.path)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              onOpenFileFolder?.(file.path)
                            }
                          }}
                          className="inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive"
                        >
                          <FolderOpen className="size-3" />
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          title={revertingFilePath === file.path ? "回退中..." : "回退"}
                          aria-label={revertingFilePath === file.path ? "回退中..." : "回退"}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!revertingFilePath) void handleRevertFile(file.path)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              if (!revertingFilePath) void handleRevertFile(file.path)
                            }
                          }}
                          className={cn(
                            "inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive",
                            revertingFilePath && revertingFilePath !== file.path && "opacity-60",
                            revertingFilePath === file.path && "opacity-80"
                          )}
                        >
                          <Undo2
                            className={cn(
                              "size-3",
                              revertingFilePath === file.path && "animate-spin"
                            )}
                          />
                        </span>
                      </span>
                    </button>
                    {expandedFilePaths.has(file.path) && (
                      <div className="mt-2">
                        <DiffDisplay diff={file.diff} />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      <GitSubmitDialog
        open={submitAction !== null}
        action={submitAction}
        running={running === "commit" || running === "push" ? running : null}
        branch={state?.worktreeBranch || "-"}
        fileCount={state?.totals.fileCount ?? 0}
        additions={state?.totals.additions ?? 0}
        deletions={state?.totals.deletions ?? 0}
        requiresCommitMetadata={hasPending}
        cardNumber={cardNumber}
        commitType={commitType}
        commitMessage={commitMessage}
        pendingCommits={state?.pendingCommits}
        onOpenChange={(open) => {
          if (!open) setSubmitAction(null)
        }}
        onCardNumberChange={setCardNumber}
        onCommitTypeChange={setCommitType}
        onCommitMessageChange={setCommitMessage}
        onSubmit={(action) => {
          void runSubmit(action)
        }}
      />
    </div>
  )
}
