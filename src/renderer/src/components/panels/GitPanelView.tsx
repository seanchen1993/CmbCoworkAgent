import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import {
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Undo2,
  GitBranch,
  GitCommit,
  ShieldCheck,
  TriangleAlert,
  FolderOpen,
  CheckCircle2,
  RefreshCw,
  ArrowDown,
  Loader2,
  Upload,
  GitCompareArrows
} from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { GitCommitDialog } from "./GitCommitDialog"
import type { CommitType } from "./GitCommitDialog"
import { GitPushDialog } from "./GitPushDialog"
import { insertLog } from "../../../js/mmjUtils"
import type { ThreadGitContext } from "@/lib/thread-context"

const GIT_BRANCH_REFRESH_EVENT = "cmb:git-branch-switched"

type GitPanelMetaState = {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  changedFilesTotal?: number
  hasPendingDiff: boolean
  hasPushableCommit: boolean
  pendingCommits?: Array<{ hash: string; message: string; date: string }>
  trackedFiles?: string[]
  worktreeBranch?: string | null
  error?: string
}

type GitPanelDiffState = {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  files: Array<{
    path: string
    previousPath?: string
    status?: GitPanelFileStatus
    diff: string
    additions: number
    deletions: number
  }>
  changedFilesTotal?: number
  omittedFileCount?: number
  totals: { additions: number; deletions: number; fileCount: number }
  hasPendingDiff: boolean
  suggestedCommitMessage?: string
  error?: string
}

type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

function getPathParentDir(filePath?: string): string {
  const normalized = String(filePath || "").replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : ""
}

function getFileStatusMeta(status?: GitPanelFileStatus, path?: string, previousPath?: string): {
  label: string
  className: string
} {
  switch (status) {
    case "deleted":
      return {
        label: "删除",
        className: "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      }
    case "added":
    case "untracked":
      return {
        label: "新增",
        className: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      }
    case "renamed":
      return {
        label: getPathParentDir(path) === getPathParentDir(previousPath) ? "改名" : "移动",
        className: "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300"
      }
    case "copied":
      return {
        label: "复制",
        className: "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
      }
    case "modified":
    default:
      return {
        label: "修改",
        className: "border-border bg-muted/40 text-muted-foreground"
      }
  }
}

/**
 * 根据 thread context 中已经恢复出的 Git 信息，构造 GitPanel 的首屏 meta 状态。
 *
 * 这里生成的是“轻量初始状态”：只用于让 header 立即显示仓库/worktree/分支信息。
 * changed files、pending commits、pushability、diff 等实时数据仍由后台的
 * `getGitPanelMeta` / `getGitPanelDiffs` 请求覆盖。
 */
function createInitialMetaState(
  threadId: string,
  gitContext?: ThreadGitContext | null
): GitPanelMetaState | null {
  if (
    !gitContext ||
    (gitContext.isGitRepo === undefined &&
      gitContext.isWorktree === undefined &&
      !gitContext.branch)
  ) {
    return null
  }

  return {
    success: gitContext.isGitRepo !== false,
    isGitRepo: gitContext.isGitRepo,
    isWorktree: Boolean(gitContext.isWorktree),
    taskId: threadId,
    hasPendingDiff: false,
    hasPushableCommit: false,
    pendingCommits: [],
    trackedFiles: [],
    worktreeBranch: gitContext.branch ?? null
  }
}

export function GitPanelView({
  threadId,
  workspacePath,
  initialGitContext,
  onOpenFileFolder
}: {
  threadId: string
  workspacePath: string | null
  initialGitContext?: ThreadGitContext | null
  onOpenFileFolder?: (filePath: string) => void
}): React.JSX.Element {
  const metaRequestIdRef = useRef(0)
  const diffRequestIdRef = useRef(0)
  const [metaLoading, setMetaLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(true)
  const [running, setRunning] = useState<"commit" | "push" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitAction, setSubmitAction] = useState<"commit" | "push" | null>(null)
  const [cardNumber, setCardNumber] = useState("")
  const [commitType, setCommitType] = useState<CommitType>("fix")
  const [commitMessage, setCommitMessage] = useState("")
  const [expandedFilePaths, setExpandedFilePaths] = useState<Set<string>>(new Set())
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set())
  const [revertingFilePath, setRevertingFilePath] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const initialMetaState = useMemo(
    () => createInitialMetaState(threadId, initialGitContext),
    [threadId, initialGitContext]
  )
  const [metaState, setMetaState] = useState<GitPanelMetaState | null>(initialMetaState)
  const [diffState, setDiffState] = useState<GitPanelDiffState | null>(null)

  useEffect(() => {
    metaRequestIdRef.current += 1
    diffRequestIdRef.current += 1
    setMetaState(initialMetaState)
    setDiffState(null)
    setMetaLoading(true)
    setDiffLoading(true)
    setError(null)
    setSubmitAction(null)
    setExpandedFilePaths(new Set())
    setSelectedFilePaths(new Set())
  }, [threadId, initialMetaState])

  const showToast = useCallback((text: string, variant: "success" | "error" = "success"): void => {
    if (variant === "success") {
      toast.success(text)
      return
    }
    toast.error(text)
  }, [])

  const refresh = useCallback(
    async (options?: { meta?: boolean; diff?: boolean }) => {
      if (!threadId) return
      const shouldRefreshMeta = options?.meta ?? false
      const shouldRefreshDiff = options?.diff ?? true
      if (!shouldRefreshMeta && !shouldRefreshDiff) return

      let toastShown = false
      setError(null)

      const reportRefreshError = (message: string): void => {
        setError((prev) => prev ?? message)
        if (!toastShown) {
          toastShown = true
          showToast(message, "error")
        }
      }

      console.log("[Git] Refreshing git panel state for threadId:", threadId, {
        meta: shouldRefreshMeta,
        diff: shouldRefreshDiff
      })

      const tasks: Promise<void>[] = []

      if (shouldRefreshMeta) {
        const requestId = ++metaRequestIdRef.current
        setMetaState((prev) => (prev ? { ...prev, error: undefined } : prev))
        setMetaLoading(true)
        tasks.push(
          (async () => {
            try {
              const nextMeta = await window.api.workspace.getGitPanelMeta(threadId)
              if (requestId !== metaRequestIdRef.current) return
              setMetaState(nextMeta)
            } catch (e) {
              if (requestId !== metaRequestIdRef.current) return
              reportRefreshError(e instanceof Error ? e.message : "加载 Git 仓库信息失败")
            } finally {
              if (requestId === metaRequestIdRef.current) {
                setMetaLoading(false)
              }
            }
          })()
        )
      }

      if (shouldRefreshDiff) {
        const requestId = ++diffRequestIdRef.current
        setDiffState((prev) => (prev ? { ...prev, error: undefined } : prev))
        setDiffLoading(true)
        tasks.push(
          (async () => {
            try {
              const nextDiff = await window.api.workspace.getGitPanelDiffs(threadId)
              if (requestId !== diffRequestIdRef.current) return
              setDiffState(nextDiff)
            } catch (e) {
              if (requestId !== diffRequestIdRef.current) return
              reportRefreshError(e instanceof Error ? e.message : "加载 Git 文件变更失败")
            } finally {
              if (requestId === diffRequestIdRef.current) {
                setDiffLoading(false)
              }
            }
          })()
        )
      }

      await Promise.allSettled(tasks)
    },
    [threadId, showToast]
  )

  useEffect(() => {
    void refresh({ meta: true, diff: true })
  }, [refresh])

  useEffect(() => {
    const handleBranchSwitched = (event: Event): void => {
      const detail = (event as CustomEvent<{ workspacePath?: string | null }>).detail
      if (detail?.workspacePath && workspacePath && detail.workspacePath !== workspacePath) return
      void refresh({ meta: true, diff: true })
    }

    window.addEventListener(GIT_BRANCH_REFRESH_EVENT, handleBranchSwitched)
    return () => {
      window.removeEventListener(GIT_BRANCH_REFRESH_EVENT, handleBranchSwitched)
    }
  }, [refresh, workspacePath])

  useEffect(() => {
    const files = diffState?.files ?? []
    setExpandedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      const next = new Set([...prev].filter((path) => files.some((f) => f.path === path)))
      if (next.size === 0) {
        next.add(files[0].path)
      }
      return next
    })
  }, [diffState?.files])

  useEffect(() => {
    const files = diffState?.files ?? []
    setSelectedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      const filePaths = files.map((file) => file.path)
      const next = new Set([...prev].filter((path) => filePaths.includes(path)))
      if (prev.size === 0 || next.size === 0) {
        return new Set(filePaths)
      }
      return next
    })
  }, [diffState?.files])

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

  const toggleFileSelected = useCallback((filePath: string): void => {
    setSelectedFilePaths((prev) => {
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
        void refresh({ meta: false, diff: true })
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
      await refresh({ meta: false, diff: true })
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
      const hasPendingChanges = Boolean(diffState?.hasPendingDiff)

      if (action === "commit" && !hasPendingChanges) {
        showToast("当前没有可提交改动", "error")
        return
      }

      const selectedPaths = (diffState?.files ?? []).flatMap((file) => {
        if (!selectedFilePaths.has(file.path)) return []
        if (file.status === "renamed" && file.previousPath) {
          return [file.previousPath, file.path]
        }
        return [file.path]
      })

      if (action === "commit" && selectedPaths.length === 0) {
        showToast("请至少选择 1 个文件", "error")
        return
      }

      if (action === "commit" && !cardNumber.trim()) {
        showToast("cardNumber 不能为空", "error")
        return
      }

      if (action === "commit" && !commitMessage.trim()) {
        showToast("commitMessage 不能为空", "error")
        return
      }

      const finalMessage =
        action === "commit"
          ? `${cardNumber.trim()} #comment ${commitType}:${commitMessage.trim()} #CMBDevClaw`
          : undefined

      setRunning(action)
      setError(null)
      try {
        if (action === "commit") {
          const result = await window.api.workspace.commitWorktree(threadId, finalMessage ?? "", selectedPaths)
          if (!result.success) throw new Error(result.error || "提交失败")
          showToast("提交成功", "success")
          insertLog("commit成功")
        } else {
          const result = await window.api.workspace.pushWorktree(threadId)
          if (!result.success) throw new Error(result.error || "推送失败")
          showToast("推送成功", "success")
          insertLog("push成功")
        }
        setCardNumber("")
        setCommitMessage("")
        setSubmitAction(null)
        await refresh({ meta: true, diff: true })
      } catch (e) {
        const err = e instanceof Error ? e.message : "操作失败"
        setError(err)
        showToast(err, "error")
      } finally {
        setRunning(null)
      }
    },
    [
      threadId,
      cardNumber,
      commitType,
      commitMessage,
      diffState?.hasPendingDiff,
      diffState?.files,
      selectedFilePaths,
      refresh,
      showToast
    ]
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
        await refresh({ meta: false, diff: true })
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
      await refresh({ meta: true, diff: true })
    } catch (e) {
      const err = e instanceof Error ? e.message : "拉取失败"
      setError(err)
      showToast(err, "error")
    } finally {
      setPulling(false)
    }
  }, [threadId, refresh, showToast])

  const loading = metaLoading || diffLoading
  const combinedError = error || metaState?.error || diffState?.error || null
  const hasPending = Boolean(diffState?.hasPendingDiff ?? metaState?.hasPendingDiff)
  const hasGitRepo = Boolean(
    metaState?.isGitRepo ?? metaState?.isWorktree ?? diffState?.isGitRepo ?? diffState?.isWorktree
  )
  const isWorktreePath = Boolean(metaState?.isWorktree ?? diffState?.isWorktree)
  const isInitialMetaLoading = metaLoading && metaState === null && !error
  const isInitialDiffLoading = diffLoading && diffState === null && !error
  const isDiffReady = Boolean(diffState?.success)
  // Keep the submit entry visible for git repos so users can push right after commit,
  // even if pushability detection lags or temporarily reports false.
  const canShowSubmit = hasGitRepo
  const workspaceName = workspacePath
    ? workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath
    : "未关联路径"
  const branchName = metaState?.worktreeBranch || "-"
  const totalChangedFiles = diffState?.changedFilesTotal ?? metaState?.changedFilesTotal ?? 0
  const omittedFileCount = diffState?.omittedFileCount ?? 0
  const visibleFilesCount = diffState?.totals.fileCount ?? 0
  const selectedFiles = useMemo(
    () => (diffState?.files ?? []).filter((file) => selectedFilePaths.has(file.path)),
    [diffState?.files, selectedFilePaths]
  )
  const selectedTotals = useMemo(
    () =>
      selectedFiles.reduce(
        (acc, file) => {
          acc.additions += file.additions
          acc.deletions += file.deletions
          return acc
        },
        { additions: 0, deletions: 0, fileCount: selectedFiles.length }
      ),
    [selectedFiles]
  )
  const allVisibleFilesSelected =
    diffState?.files.length ? selectedFiles.length === diffState.files.length : false

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
      <div className="sticky top-0 z-10 px-3 py-2 border-b border-border/70 bg-background-elevated/80 backdrop-blur shrink-0">
        <div className="rounded-lg border border-border/70 bg-background/90 px-2.5 py-2">
          {isInitialMetaLoading ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                <span className="font-medium text-foreground">正在加载 Git 仓库信息</span>
                <span>请稍候，正在读取仓库、分支和推送状态。</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="h-5 w-32 rounded-full bg-muted/70 animate-pulse" />
                <div className="h-5 w-24 rounded-full bg-muted/70 animate-pulse" />
                <div className="h-5 w-20 rounded-full bg-muted/60 animate-pulse" />
              </div>
              <div className="mt-2 h-4 w-full max-w-[420px] rounded bg-muted/50 animate-pulse" />
            </>
          ) : (
            <>
              <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1 flex-wrap">
                <span className="font-semibold text-foreground">{workspaceName}</span>
                <span>•</span>
                {isInitialDiffLoading ? (
                  <>
                    <div className="h-4 w-20 rounded bg-muted/60 animate-pulse" />
                    <span>,</span>
                    <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
                  </>
                ) : (
                  <>
                    <span className="text-blue-600 dark:text-blue-400 font-medium">
                      {totalChangedFiles} files
                    </span>
                    {omittedFileCount > 0 && (
                      <>
                        <span>(仅展示 {visibleFilesCount})</span>
                      </>
                    )}
                    <span>,</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                      +{diffState?.totals.additions ?? 0}
                    </span>
                    <span>/</span>
                    <span className="text-rose-600 dark:text-rose-400 font-semibold">
                      -{diffState?.totals.deletions ?? 0}
                    </span>
                  </>
                )}
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
                  <div className={"flex space-x-2"}>
                    {canShowSubmit && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setSubmitAction("commit")}
                          disabled={running !== null || !isDiffReady || !hasPending}
                          title={isInitialDiffLoading ? "准备中..." : "Commit 提交"}
                          aria-label={isInitialDiffLoading ? "准备中" : "Commit 提交"}
                          className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px]  cursor-pointer  disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive hover:text-foreground transition-colors"
                        >
                          {isInitialDiffLoading ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <GitCommit className="size-3.5" />
                          )}
                          <span>Commit</span>
                        </button>
                        <button
                          onClick={() => setSubmitAction("push")}
                          disabled={running !== null || !isDiffReady}
                          title={isInitialDiffLoading ? "准备中..." : "Push 推送"}
                          aria-label={isInitialDiffLoading ? "准备中" : "Push 推送"}
                          className=" inline-flex h-7 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px]  disabled:opacity-50 disabled:cursor-not-allowed hover:bg-background-interactive hover:text-foreground transition-colors cursor-pointer "
                        >
                          {isInitialDiffLoading ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Upload className="size-3.5" />
                          )}
                          <span>Push</span>
                        </button>
                      </div>
                    )}

                    {hasPending && isDiffReady && (
                      <button
                        id={"git-reject-all-button"}
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
                        "border border-border/80 bg-background/60  cursor-pointer ",
                        "active:scale-[0.97] transition-all duration-200",
                        loading &&
                          "border-blue-400/60 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/30",
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
                        "border border-border/80 bg-background/60  cursor-pointer ",
                        "active:scale-[0.97] transition-all duration-200",
                        pulling &&
                          "border-blue-400/60 text-blue-600 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/30",
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
            </>
          )}
        </div>
      </div>
      <div
        className="overflow-y-auto overflow-x-hidden right-panel-scroll bg-background flex-1 min-h-0 p-3 space-y-3"
        aria-busy={loading}
      >
        {combinedError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
            <span>{combinedError}</span>
          </div>
        )}
        {hasGitRepo && isInitialDiffLoading && (
          <div className="rounded-xl border border-border/70 bg-muted/10 px-4 py-8">
            <div className="mx-auto max-w-[360px] text-center">
              <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full border border-blue-500/25 bg-blue-500/10">
                <Loader2 className="size-5 animate-spin text-blue-600 dark:text-blue-400" />
              </div>
              <div className="text-sm font-medium text-foreground">文件变更加载中</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Git 仓库信息已就绪，正在读取文件变更和 diff，请稍候。
              </p>
              <div className="mt-4 space-y-2">
                <div className="h-10 rounded-lg border border-border/60 bg-background/80 animate-pulse" />
                <div className="h-10 rounded-lg border border-border/60 bg-background/70 animate-pulse" />
                <div className="h-24 rounded-lg border border-border/60 bg-background/60 animate-pulse" />
              </div>
            </div>
          </div>
        )}
        {(metaState || diffState) && !hasGitRepo && (
          <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            当前任务未关联 Git 仓库。请先在工作区选择器绑定 Git 仓库路径。
          </div>
        )}
        {hasGitRepo && diffState?.success === false && !diffLoading && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            文件变更加载失败，分支与仓库信息已就绪。可点击右上角“刷新”重试。
          </div>
        )}
        {diffState?.success && hasGitRepo && (
          <>
            {omittedFileCount > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                当前变更文件较多，为避免卡顿仅展示前 {visibleFilesCount}{" "}
                个文件。请先提交或回退部分改动后再查看全部详情。
              </div>
            )}
            {diffState.files.length === 0 ? (
              <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-8">
                <div className="mx-auto max-w-[420px]">
                  <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
                    <CheckCircle2 className="size-4.5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div className="text-center text-sm font-medium text-foreground">
                    没有待审批改动
                  </div>
                  <p className="mt-1 text-center text-xs leading-5 text-muted-foreground">
                    当前工作区与基线一致，暂时没有可展示的净变更。
                  </p>
                  <div className="mt-3 rounded-lg border border-border/70 bg-background/70 p-3">
                    <div className="mb-2 inline-flex items-center rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      可能原因
                    </div>
                    <ul className="space-y-1.5 text-xs leading-5 text-muted-foreground">
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                        文件被{" "}
                        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">.gitignore</code>{" "}
                        忽略
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                        文件改动后又恢复为原内容，最终净变更为 0
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                        当前修改仅影响未纳入 Git 跟踪的内容
                      </li>
                    </ul>
                  </div>
                  <p className="mt-3 text-center text-[11px] leading-5 text-muted-foreground">
                    后续出现可跟踪的净变更时，这里会自动显示最新 diff。
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-md border border-border/70 bg-background px-2.5 py-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    已选择{" "}
                    <span className="font-semibold text-foreground">{selectedTotals.fileCount}</span>{" "}
                    / {diffState.files.length} 个文件
                    <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                      +{selectedTotals.additions}
                    </span>
                    <span className="ml-1 text-rose-600 dark:text-rose-400">
                      -{selectedTotals.deletions}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-background-interactive hover:text-foreground"
                    onClick={() => {
                      setSelectedFilePaths(
                        allVisibleFilesSelected
                          ? new Set()
                          : new Set(diffState.files.map((file) => file.path))
                      )
                    }}
                  >
                    {allVisibleFilesSelected ? "取消全选" : "全选文件"}
                  </button>
                </div>
                {diffState.files.map((file) => {
                  const diff = file.diff
                  const isExpanded = expandedFilePaths.has(file.path)
                  const isSelected = selectedFilePaths.has(file.path)
                  const statusMeta = getFileStatusMeta(file.status, file.path, file.previousPath)
                  const showMovePath = file.status === "renamed" && Boolean(file.previousPath)
                  return (
                    <div
                      key={file.path}
                      className="rounded-md border border-border/70 p-2 bg-white"
                    >
                      <button
                        type="button"
                        onClick={() => toggleFileExpanded(file.path)}
                        className="w-full flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            aria-label={`选择文件 ${file.path}`}
                            onChange={(e) => {
                              e.stopPropagation()
                              toggleFileSelected(file.path)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="size-3.5 shrink-0 accent-blue-600"
                          />
                          {isExpanded ? (
                            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span
                            className={cn(
                              "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[9px] font-medium leading-none",
                              statusMeta.className
                            )}
                            title={`文件状态：${statusMeta.label}`}
                          >
                            {statusMeta.label}
                          </span>
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
                      {isExpanded && (
                        <div className="mt-2">
                          {showMovePath && (
                            <div className="mb-2 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
                              <div className="mb-1 flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-300">
                                <GitCompareArrows className="size-3.5" />
                                {statusMeta.label}信息
                              </div>
                              <div className="grid gap-1.5 font-mono">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="shrink-0 text-muted-foreground">原路径</span>
                                  <span
                                    className="truncate text-muted-foreground line-through decoration-muted-foreground/50"
                                    title={file.previousPath}
                                  >
                                    {file.previousPath}
                                  </span>
                                </div>
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="shrink-0 text-muted-foreground">现路径</span>
                                  <span className="truncate font-semibold text-foreground" title={file.path}>
                                    {file.path}
                                  </span>
                                </div>
                              </div>
                            </div>
                          )}
                          {diff && diff.trim() !== "" ? (
                            <DiffDisplay diff={diff} />
                          ) : (
                            <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                              当前文件暂无可展示 diff（可能已恢复、删除或为二进制文件）。
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </>
        )}
      </div>

      <GitCommitDialog
        open={submitAction === "commit"}
        running={running === "commit"}
        branch={metaState?.worktreeBranch || "-"}
        fileCount={hasPending ? selectedTotals.fileCount : (diffState?.totals.fileCount ?? 0)}
        additions={hasPending ? selectedTotals.additions : (diffState?.totals.additions ?? 0)}
        deletions={hasPending ? selectedTotals.deletions : (diffState?.totals.deletions ?? 0)}
        cardNumber={cardNumber}
        commitType={commitType}
        commitMessage={commitMessage}
        onOpenChange={(open) => {
          if (!open) setSubmitAction(null)
        }}
        onCardNumberChange={setCardNumber}
        onCommitTypeChange={setCommitType}
        onCommitMessageChange={setCommitMessage}
        onSubmit={() => {
          void runSubmit("commit")
        }}
      />
      <GitPushDialog
        open={submitAction === "push"}
        running={running === "push"}
        branch={metaState?.worktreeBranch || "-"}
        pendingCommits={metaState?.pendingCommits}
        onOpenChange={(open) => {
          if (!open) setSubmitAction(null)
        }}
        onSubmit={() => {
          void runSubmit("push")
        }}
      />
    </div>
  )
}
