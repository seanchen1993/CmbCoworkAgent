import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import {
  Check,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Undo2,
  GitBranch,
  GitCommit,
  ShieldCheck,
  TriangleAlert,
  Folder,
  FolderOpen,
  FileText,
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
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { OpenInIdeButton } from "@/components/ui/open-in-ide-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { toast } from "sonner"
import { GitCommitDialog } from "./GitCommitDialog"
import type { CommitType } from "./GitCommitDialog"
import { GitPushDialog } from "./GitPushDialog"
import { GitRejectDialog, type GitRejectFile } from "./GitRejectDialog"
import {
  buildGitPanelFileTree,
  flattenGitPanelFileTree,
  type GitPanelFileTreeRow,
  type GitPanelTreeFile
} from "./git-panel-file-tree"
import { insertLog } from "../../../js/mmjUtils"
import type { ThreadGitContext } from "@/lib/thread-context"
import type { GitCommitHistoryRecord } from "../../../../shared/git-commit-history"
import { useWorkspaceTaskCard } from "@/components/git/use-workspace-task-card"

const GIT_BRANCH_REFRESH_EVENT = "cmb:git-branch-switched"
const COMMIT_TYPE_VALUES = new Set<string>([
  "fix",
  "feat",
  "refactor",
  "docs",
  "style",
  "test",
  "chore"
])

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

type GitRepositoryInfo = {
  path: string
  displayPath: string
  gitRoot: string
}

type GitPanelDiffState = {
  success: boolean
  isWorktree: boolean
  isGitRepo?: boolean
  taskId: string
  repositories?: GitRepositoryInfo[]
  files: Array<{
    path: string
    previousPath?: string
    status?: GitPanelFileStatus
    diff: string
    diffLoaded?: boolean
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
type GitPanelDiffFile = GitPanelDiffState["files"][number]
type GitPanelTreeDiffFile = GitPanelDiffFile & GitPanelTreeFile

// 同时按需拉取的文件 diff 上限，避免刷新后一次性为大量已展开文件并发拉取 diff 拖垮主进程。
const MAX_CONCURRENT_FILE_DIFF_LOADS = 3
const GIT_REJECT_DIALOG_FILE_LIMIT = 10_000
const ALL_REPOSITORIES_VALUE = "__all__"
const WORKSPACE_REPOSITORY_KEY = "__workspace__"

function normalizePanelPath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "")
}

function getRepositoryPrefix(repo: GitRepositoryInfo): string {
  return normalizePanelPath(repo.displayPath)
}

function isFileInRepository(filePath: string, repo: GitRepositoryInfo): boolean {
  const normalizedFile = normalizePanelPath(filePath)
  const prefix = getRepositoryPrefix(repo)
  return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`)
}

function getFileRepository(
  filePath: string,
  repositories: GitRepositoryInfo[]
): GitRepositoryInfo | null {
  const sorted = [...repositories].sort((a, b) => getRepositoryPrefix(b).length - getRepositoryPrefix(a).length)
  return sorted.find((repo) => isFileInRepository(filePath, repo)) ?? null
}

function stripRepositoryPrefix(filePath: string, repo: GitRepositoryInfo): string {
  const normalizedFile = normalizePanelPath(filePath)
  const prefix = getRepositoryPrefix(repo)
  if (normalizedFile === prefix) return ""
  if (normalizedFile.startsWith(`${prefix}/`)) {
    return normalizedFile.slice(prefix.length + 1)
  }
  return normalizedFile
}

function getRepositoryFileDisplayPath(filePath: string, repo?: GitRepositoryInfo | null): string {
  return repo ? stripRepositoryPrefix(filePath, repo) : filePath
}

function getPathParentDir(filePath?: string): string {
  const normalized = String(filePath || "").replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : ""
}

function getFileStatusMeta(
  status?: GitPanelFileStatus,
  path?: string,
  previousPath?: string
): {
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

function makeDirectoryCollapseKey(repositoryKey: string, directoryId: string): string {
  return `${repositoryKey}::${directoryId}`
}

function getCollapsedDirectoryIds(
  repositoryKey: string,
  collapsedDirectoryPaths: ReadonlySet<string>
): Set<string> {
  const prefix = `${repositoryKey}::`
  return new Set(
    [...collapsedDirectoryPaths]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
  )
}

function TreeSelectionCheckbox({
  checked,
  indeterminate,
  ariaLabel,
  onChange
}: {
  checked: boolean
  indeterminate?: boolean
  ariaLabel: string
  onChange: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = Boolean(indeterminate)
    }
  }, [indeterminate])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      aria-checked={indeterminate ? "mixed" : checked}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
      className="size-3.5 shrink-0 accent-blue-600"
    />
  )
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
  const activeThreadIdRef = useRef(threadId)
  const rejectInFlightRef = useRef(false)
  const suppressFileChangeRefreshUntilRef = useRef(0)
  const rejectDialogRequestIdRef = useRef(0)
  const pushMetaRequestIdRef = useRef(0)
  const [metaLoading, setMetaLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(true)
  const [running, setRunning] = useState<"commit" | "push" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitAction, setSubmitAction] = useState<"commit" | "push" | null>(null)
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false)
  const [rejectDialogFiles, setRejectDialogFiles] = useState<GitRejectFile[]>([])
  const [rejectDialogOmittedFileCount, setRejectDialogOmittedFileCount] = useState(0)
  const [rejectDialogLoading, setRejectDialogLoading] = useState(false)
  const [rejectDialogSelectionSeed, setRejectDialogSelectionSeed] = useState(0)
  const {
    cardNumber,
    handleCardNumberChange,
    setCardNumberLocal,
    persistNow: persistWorkspaceCard
  } = useWorkspaceTaskCard(workspacePath)
  const [commitType, setCommitType] = useState<CommitType>("fix")
  const [commitMessage, setCommitMessage] = useState("")
  const [commitHistory, setCommitHistory] = useState<GitCommitHistoryRecord[]>([])
  const [expandedFilePaths, setExpandedFilePaths] = useState<Set<string>>(new Set())
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set())
  const [collapsedRepositoryPaths, setCollapsedRepositoryPaths] = useState<Set<string>>(new Set())
  const [collapsedDirectoryPaths, setCollapsedDirectoryPaths] = useState<Set<string>>(new Set())
  const [activeRepositoryPath, setActiveRepositoryPath] = useState(ALL_REPOSITORIES_VALUE)
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false)
  const [fileDiffLoadingPaths, setFileDiffLoadingPaths] = useState<Set<string>>(new Set())
  const [fileDiffErrors, setFileDiffErrors] = useState<Record<string, string>>({})
  const [revertingFilePath, setRevertingFilePath] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const selectionScopeRef = useRef(ALL_REPOSITORIES_VALUE)
  const initialMetaState = useMemo(
    () => createInitialMetaState(threadId, initialGitContext),
    [threadId, initialGitContext]
  )
  const [metaState, setMetaState] = useState<GitPanelMetaState | null>(initialMetaState)
  const [diffState, setDiffState] = useState<GitPanelDiffState | null>(null)
  const [pushMetaState, setPushMetaState] = useState<GitPanelMetaState | null>(null)
  const [pushMetaLoading, setPushMetaLoading] = useState(false)

  useEffect(() => {
    activeThreadIdRef.current = threadId
    metaRequestIdRef.current += 1
    diffRequestIdRef.current += 1
    setMetaState(initialMetaState)
    setDiffState(null)
    setMetaLoading(true)
    setDiffLoading(true)
    setError(null)
    setSubmitAction(null)
    setRejectDialogOpen(false)
    setRejectDialogFiles([])
    setRejectDialogOmittedFileCount(0)
    setRejectDialogLoading(false)
    setRejectDialogSelectionSeed(0)
    rejectDialogRequestIdRef.current += 1
    pushMetaRequestIdRef.current += 1
    rejectInFlightRef.current = false
    suppressFileChangeRefreshUntilRef.current = 0
    setCommitHistory([])
    setExpandedFilePaths(new Set())
    setSelectedFilePaths(new Set())
    setCollapsedRepositoryPaths(new Set())
    setCollapsedDirectoryPaths(new Set())
    setActiveRepositoryPath(ALL_REPOSITORIES_VALUE)
    setRepositoryPickerOpen(false)
    selectionScopeRef.current = ALL_REPOSITORIES_VALUE
    setFileDiffLoadingPaths(new Set())
    setFileDiffErrors({})
    setPushMetaState(null)
    setPushMetaLoading(false)
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
              const nextDiff = await window.api.workspace.getGitPanelDiffs(threadId, {
                includeDiffs: false,
                includeChangedFiles: false,
                statusUntrackedMode: "normal"
              })
              if (requestId !== diffRequestIdRef.current) return
              setDiffState(nextDiff)
              setFileDiffLoadingPaths(new Set())
              setFileDiffErrors({})
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

  const repositories = useMemo(
    () => diffState?.repositories ?? [],
    [diffState?.repositories]
  )
  const hasMultipleRepositories = repositories.length > 1
  const activeRepository = useMemo(() => {
    if (!hasMultipleRepositories || activeRepositoryPath === ALL_REPOSITORIES_VALUE) return null
    return repositories.find((repo) => repo.path === activeRepositoryPath) ?? null
  }, [activeRepositoryPath, hasMultipleRepositories, repositories])
  const activeRepositoryLabel = activeRepository?.displayPath ?? "全部仓库"
  const visibleDiffFiles = useMemo(() => {
    const files = diffState?.files ?? []
    if (!activeRepository) return files
    return files.filter((file) => isFileInRepository(file.path, activeRepository))
  }, [activeRepository, diffState?.files])

  const selectActiveRepository = useCallback((repositoryPath: string): void => {
    setActiveRepositoryPath(repositoryPath)
    setRepositoryPickerOpen(false)
    pushMetaRequestIdRef.current += 1
    setPushMetaState(null)
    setPushMetaLoading(false)
    setSubmitAction(null)
  }, [])

  const toRepositoryRelativePaths = useCallback(
    (filePaths: string[], repo: GitRepositoryInfo | null): string[] => {
      if (!repo) return filePaths
      return filePaths
        .map((filePath) => stripRepositoryPrefix(filePath, repo))
        .filter((filePath) => filePath.length > 0)
    },
    []
  )

  const resolveActionRepository = useCallback(
    (filePaths: string[] = []): GitRepositoryInfo | null => {
      if (!hasMultipleRepositories) return null
      if (activeRepository) return activeRepository
      const matchedRepositories = new Map<string, GitRepositoryInfo>()
      for (const filePath of filePaths) {
        const repo = getFileRepository(filePath, repositories)
        if (repo) matchedRepositories.set(repo.path, repo)
      }
      if (matchedRepositories.size === 1) {
        return Array.from(matchedRepositories.values())[0]
      }
      return null
    },
    [activeRepository, hasMultipleRepositories, repositories]
  )

  const formatFilesForRejectDialog = useCallback(
    (files: GitRejectFile[]): GitRejectFile[] => {
      if (!activeRepository) return files
      return files.map((file) => ({
        ...file,
        path: stripRepositoryPrefix(file.path, activeRepository),
        previousPath: file.previousPath
          ? stripRepositoryPrefix(file.previousPath, activeRepository)
          : undefined
      }))
    },
    [activeRepository]
  )

  const openPushDialog = useCallback(() => {
    if (hasMultipleRepositories && !activeRepository) {
      showToast("请先在“操作仓库”中选择要推送的子仓库", "error")
      return
    }
    setSubmitAction("push")
  }, [activeRepository, hasMultipleRepositories, showToast])

  useEffect(() => {
    if (submitAction !== "push" || !threadId) return
    const requestId = ++pushMetaRequestIdRef.current
    setPushMetaLoading(true)
    setPushMetaState(null)
    const targetOptions = activeRepository ? { worktreePath: activeRepository.path } : undefined

    void window.api.workspace
      .getGitPanelMeta(threadId, targetOptions)
      .then((result) => {
        if (requestId !== pushMetaRequestIdRef.current || activeThreadIdRef.current !== threadId) return
        setPushMetaState(result)
        if (!result.success && result.error) {
          setError(result.error)
          showToast(result.error, "error")
        }
      })
      .catch((error) => {
        if (requestId !== pushMetaRequestIdRef.current || activeThreadIdRef.current !== threadId) return
        const message = error instanceof Error ? error.message : "读取待推送提交失败"
        setPushMetaState(null)
        setError(message)
        showToast(message, "error")
      })
      .finally(() => {
        if (requestId === pushMetaRequestIdRef.current && activeThreadIdRef.current === threadId) {
          setPushMetaLoading(false)
        }
      })

    return () => {
      pushMetaRequestIdRef.current += 1
    }
  }, [activeRepository, showToast, submitAction, threadId])

  useEffect(() => {
    if (!hasMultipleRepositories) {
      if (activeRepositoryPath !== ALL_REPOSITORIES_VALUE) {
        setActiveRepositoryPath(ALL_REPOSITORIES_VALUE)
      }
      return
    }
    if (
      activeRepositoryPath !== ALL_REPOSITORIES_VALUE &&
      !repositories.some((repo) => repo.path === activeRepositoryPath)
    ) {
      setActiveRepositoryPath(ALL_REPOSITORIES_VALUE)
    }
  }, [activeRepositoryPath, hasMultipleRepositories, repositories])

  useEffect(() => {
    const files = visibleDiffFiles
    setExpandedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      return new Set([...prev].filter((path) => files.some((f) => f.path === path)))
    })
  }, [visibleDiffFiles])

  useEffect(() => {
    const files = visibleDiffFiles
    const scopeChanged = selectionScopeRef.current !== activeRepositoryPath
    selectionScopeRef.current = activeRepositoryPath
    setSelectedFilePaths((prev) => {
      if (files.length === 0) return new Set()
      const filePaths = files.map((file) => file.path)
      const next = new Set([...prev].filter((path) => filePaths.includes(path)))
      if (scopeChanged || prev.size === 0 || next.size === 0) {
        return new Set(filePaths)
      }
      return next
    })
  }, [activeRepositoryPath, visibleDiffFiles])

  const applyCommitHistoryRecord = useCallback(
    (record: GitCommitHistoryRecord): void => {
      // Prefill the card from history only when the workspace has none yet, and
      // keep it local — it is persisted on a successful commit, not on dialog open.
      if (!cardNumber.trim() && record.cardNumber.trim()) {
        setCardNumberLocal(record.cardNumber)
      }
      if (COMMIT_TYPE_VALUES.has(record.commitType)) {
        setCommitType(record.commitType as CommitType)
      }
      setCommitMessage(record.commitMessage)
    },
    [cardNumber, setCardNumberLocal]
  )

  useEffect(() => {
    if (submitAction !== "commit" || !threadId) return
    let canceled = false
    void window.api.gitPanel
      .getCommitHistory(threadId)
      .then((result) => {
        if (canceled) return
        const records = result.success ? result.records : []
        setCommitHistory(records)
      })
      .catch((error) => {
        if (canceled) return
        console.warn("[GitPanel] failed to load commit history:", error)
        setCommitHistory([])
      })
    return () => {
      canceled = true
    }
  }, [submitAction, threadId])

  const loadFileDiff = useCallback(
    async (filePath: string): Promise<void> => {
      if (!threadId) return
      const currentFile = diffState?.files.find((file) => file.path === filePath)
      if (!currentFile || currentFile.diffLoaded || fileDiffLoadingPaths.has(filePath)) return
      const requestDiffId = diffRequestIdRef.current
      const requestThreadId = threadId

      setFileDiffLoadingPaths((prev) => new Set(prev).add(filePath))
      setFileDiffErrors((prev) => {
        const next = { ...prev }
        delete next[filePath]
        return next
      })

      try {
        const repo = getFileRepository(filePath, repositories)
        const requestFilePath = repo ? stripRepositoryPrefix(filePath, repo) : filePath
        const result = await window.api.workspace.getGitPanelFileDiff(
          threadId,
          requestFilePath,
          repo ? { worktreePath: repo.path } : undefined
        )
        if (requestDiffId !== diffRequestIdRef.current || result.taskId !== activeThreadIdRef.current) return
        if (!result.success || !result.file) {
          throw new Error(result.error || "加载文件 diff 失败")
        }

        setDiffState((prev) => {
          if (!prev) return prev
          if (requestDiffId !== diffRequestIdRef.current || requestThreadId !== activeThreadIdRef.current) return prev
          const files = prev.files.map((file) => {
            if (file.path !== filePath) return file
            return {
              ...file,
              diff: result.file?.diff ?? "",
              diffLoaded: true,
              additions: result.file?.additions ?? file.additions,
              deletions: result.file?.deletions ?? file.deletions
            }
          })
          // 懒加载下文件级行数可能在展开后才精确化（尤其是未跟踪新文件），
          // 这里同步重算全局 totals，避免顶部汇总与逐文件 +/- 长期对不上。
          const totals = files.reduce(
            (acc, file) => {
              acc.additions += file.additions
              acc.deletions += file.deletions
              return acc
            },
            { additions: 0, deletions: 0 }
          )
          return {
            ...prev,
            files,
            totals: { ...prev.totals, additions: totals.additions, deletions: totals.deletions }
          }
        })
      } catch (e) {
        if (requestDiffId !== diffRequestIdRef.current || requestThreadId !== activeThreadIdRef.current) return
        const message = e instanceof Error ? e.message : "加载文件 diff 失败"
        setFileDiffErrors((prev) => ({ ...prev, [filePath]: message }))
      } finally {
        if (requestDiffId === diffRequestIdRef.current && requestThreadId === activeThreadIdRef.current) {
          setFileDiffLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(filePath)
            return next
          })
        }
      }
    },
    [threadId, diffState?.files, fileDiffLoadingPaths, repositories]
  )

  const toggleFileExpanded = useCallback((filePath: string): void => {
    const shouldExpand = !expandedFilePaths.has(filePath)
    setExpandedFilePaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
    if (shouldExpand) {
      void loadFileDiff(filePath)
    }
  }, [expandedFilePaths, loadFileDiff])

  useEffect(() => {
    // 刷新会把已展开文件的 diffLoaded 重置，若一次性为所有展开文件并发拉取 diff，
    // 每个文件会触发多个 git 子进程，展开数较多时主进程 CPU 会瞬时飙升。
    // 这里用并发预算自时钟节流：单个 loadFileDiff 完成后会更新 loading 集合并重跑本 effect，
    // 从而按 MAX_CONCURRENT_FILE_DIFF_LOADS 排队补齐剩余文件。
    let budget = MAX_CONCURRENT_FILE_DIFF_LOADS - fileDiffLoadingPaths.size
    if (budget <= 0) return
    for (const filePath of expandedFilePaths) {
      if (budget <= 0) break
      const file = visibleDiffFiles.find((item) => item.path === filePath)
      if (!file || file.diffLoaded || fileDiffLoadingPaths.has(filePath) || fileDiffErrors[filePath]) {
        continue
      }
      void loadFileDiff(filePath)
      budget -= 1
    }
  }, [expandedFilePaths, fileDiffErrors, fileDiffLoadingPaths, loadFileDiff, visibleDiffFiles])

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

  const setFilePathsSelected = useCallback((filePaths: string[], selected: boolean): void => {
    setSelectedFilePaths((prev) => {
      const next = new Set(prev)
      for (const filePath of filePaths) {
        if (selected) {
          next.add(filePath)
        } else {
          next.delete(filePath)
        }
      }
      return next
    })
  }, [])

  const toggleRepositoryCollapsed = useCallback((repositoryPath: string): void => {
    setCollapsedRepositoryPaths((prev) => {
      const next = new Set(prev)
      if (next.has(repositoryPath)) {
        next.delete(repositoryPath)
      } else {
        next.add(repositoryPath)
      }
      return next
    })
  }, [])

  const toggleDirectoryCollapsed = useCallback((repositoryKey: string, directoryId: string): void => {
    const key = makeDirectoryCollapseKey(repositoryKey, directoryId)
    setCollapsedDirectoryPaths((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!threadId) return
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId !== threadId) return
      if (rejectInFlightRef.current || Date.now() < suppressFileChangeRefreshUntilRef.current) {
        return
      }
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

  const runReject = useCallback(async (filePaths: string[]) => {
    if (!threadId) return
    if (filePaths.length === 0) {
      showToast("请至少选择 1 个文件", "error")
      return
    }
    const actionRepository = resolveActionRepository(filePaths)
    if (hasMultipleRepositories && !actionRepository) {
      showToast("请先在“操作仓库”中选择一个子仓库再回退", "error")
      return
    }
    const requestFilePaths = toRepositoryRelativePaths(filePaths, actionRepository)
    setRunning("reject")
    setError(null)
    rejectInFlightRef.current = true
    suppressFileChangeRefreshUntilRef.current = Number.POSITIVE_INFINITY
    try {
      const result = await window.api.workspace.rejectWorktreeChanges(
        threadId,
        requestFilePaths,
        actionRepository ? { worktreePath: actionRepository.path } : undefined
      )
      if (!result.success) throw new Error(result.error || "回滚失败")
      setRejectDialogOpen(false)
      const count = result.revertedFileCount ?? filePaths.length
      showToast(`已回退 ${count} 个文件`, "success")
      await refresh({ meta: false, diff: true })
    } catch (e) {
      const err = e instanceof Error ? e.message : "操作失败"
      setError(err)
      showToast(err, "error")
    } finally {
      rejectInFlightRef.current = false
      suppressFileChangeRefreshUntilRef.current = Date.now() + 1200
      setRunning(null)
    }
  }, [
    threadId,
    hasMultipleRepositories,
    refresh,
    resolveActionRepository,
    showToast,
    toRepositoryRelativePaths
  ])

  const openRejectDialog = useCallback(() => {
    if (!threadId) return
    const requestId = ++rejectDialogRequestIdRef.current
    const initialFiles = formatFilesForRejectDialog(visibleDiffFiles)
    setRejectDialogFiles(initialFiles)
    setRejectDialogOmittedFileCount(activeRepository ? 0 : (diffState?.omittedFileCount ?? 0))
    setRejectDialogLoading(true)
    setRejectDialogSelectionSeed((seed) => seed + 1)
    setRejectDialogOpen(true)

    void window.api.workspace
      .getGitPanelDiffs(threadId, {
        includeDiffs: false,
        includeChangedFiles: false,
        statusUntrackedMode: "all",
        visibleFileLimit: GIT_REJECT_DIALOG_FILE_LIMIT,
        worktreePath: activeRepository?.path
      })
      .then((result) => {
        if (requestId !== rejectDialogRequestIdRef.current || result.taskId !== activeThreadIdRef.current) return
        if (!result.success) {
          showToast(result.error || "加载回退文件列表失败", "error")
          setRejectDialogLoading(false)
          return
        }
        const nextFiles = formatFilesForRejectDialog(result.files ?? [])
        setRejectDialogOmittedFileCount(result.omittedFileCount ?? 0)
        setRejectDialogFiles(nextFiles)
        setRejectDialogSelectionSeed((seed) => seed + 1)
        setRejectDialogLoading(false)
      })
      .catch((error) => {
        if (requestId !== rejectDialogRequestIdRef.current) return
        setRejectDialogLoading(false)
        showToast(error instanceof Error ? error.message : "加载回退文件列表失败", "error")
      })
  }, [
    threadId,
    activeRepository,
    diffState?.omittedFileCount,
    formatFilesForRejectDialog,
    showToast,
    visibleDiffFiles
  ])

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
        showToast("请选择任务卡片", "error")
        return
      }

      if (action === "commit" && !commitMessage.trim()) {
        showToast("请输入提交说明", "error")
        return
      }

      const actionRepository = action === "commit"
        ? resolveActionRepository(selectedPaths)
        : activeRepository
      if (hasMultipleRepositories && !actionRepository) {
        showToast(
          action === "commit"
            ? "请先在“操作仓库”中选择一个子仓库，或只勾选同一仓库的文件"
            : "请先在“操作仓库”中选择要推送的子仓库",
          "error"
        )
        return
      }
      const requestSelectedPaths = toRepositoryRelativePaths(selectedPaths, actionRepository)

      const finalMessage =
        action === "commit"
          ? `${cardNumber.trim()} #comment ${commitType}:${commitMessage.trim()} #CMBDevClaw`
          : undefined

      setRunning(action)
      setError(null)
      try {
        if (action === "commit") {
          const result = await window.api.workspace.commitWorktree(
            threadId,
            finalMessage ?? "",
            requestSelectedPaths,
            actionRepository ? { worktreePath: actionRepository.path } : undefined
          )
          if (!result.success) throw new Error(result.error || "提交失败")
          void window.api.gitPanel
            .recordCommitHistory(threadId, finalMessage ?? "")
            .catch((historyError) => {
              console.warn("[GitPanel] failed to record commit history:", historyError)
            })
          showToast("提交成功", "success")
          insertLog("commit成功")
          // Remember the card actually committed with for this workspace.
          persistWorkspaceCard(cardNumber.trim())
        } else {
          const result = await window.api.workspace.pushWorktree(
            threadId,
            actionRepository ? { worktreePath: actionRepository.path } : undefined
          )
          if (!result.success) throw new Error(result.error || "推送失败")
          showToast("推送成功", "success")
          insertLog("push成功")
        }
        setCommitMessage("")
        setSubmitAction(null)
        if (action === "push") {
          void refresh({ meta: true, diff: true })
        } else {
          await refresh({ meta: true, diff: true })
        }
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
      activeRepository,
      hasMultipleRepositories,
      resolveActionRepository,
      selectedFilePaths,
      refresh,
      showToast,
      toRepositoryRelativePaths,
      persistWorkspaceCard
    ]
  )

  const handleRevertFile = useCallback(
    async (filePath: string) => {
      if (!threadId) return
      setRevertingFilePath(filePath)
      setError(null)
      try {
        const actionRepository = getFileRepository(filePath, repositories)
        const requestFilePath = actionRepository
          ? stripRepositoryPrefix(filePath, actionRepository)
          : filePath
        const result = await window.api.workspace.rejectWorktreeFile(
          threadId,
          requestFilePath,
          actionRepository ? { worktreePath: actionRepository.path } : undefined
        )
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
    [threadId, refresh, repositories, showToast]
  )

  const runPull = useCallback(async () => {
    if (!threadId) return
    setPulling(true)
    setError(null)
    try {
      const result = await window.api.workspace.pullWorktree(
        threadId,
        activeRepository ? { worktreePath: activeRepository.path } : undefined
      )
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
  }, [threadId, activeRepository, refresh, showToast])

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
    () => visibleDiffFiles.filter((file) => selectedFilePaths.has(file.path)),
    [selectedFilePaths, visibleDiffFiles]
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
  const allVisibleFilesSelected = visibleDiffFiles.length
    ? selectedFiles.length === visibleDiffFiles.length
    : false
  const repositoryGroups = useMemo(() => {
    if (!hasMultipleRepositories) {
      return [{ repo: null as GitRepositoryInfo | null, files: visibleDiffFiles }]
    }
    const groups = repositories
      .map((repo) => ({
        repo,
        files: visibleDiffFiles.filter((file) => isFileInRepository(file.path, repo))
      }))
      .filter((group) => group.files.length > 0)
    if (activeRepository || groups.length > 0) return groups
    return [{ repo: null as GitRepositoryInfo | null, files: visibleDiffFiles }]
  }, [activeRepository, hasMultipleRepositories, repositories, visibleDiffFiles])

  const repositoryTreeGroups = useMemo(
    () =>
      repositoryGroups.map((group) => {
        const repositoryKey = group.repo?.path ?? WORKSPACE_REPOSITORY_KEY
        const files = group.files.map((file) => ({
          ...file,
          displayPath: getRepositoryFileDisplayPath(file.path, group.repo)
        }))
        return {
          ...group,
          repositoryKey,
          tree: buildGitPanelFileTree(files)
        }
      }),
    [repositoryGroups]
  )

  const renderDiffFileCard = (
    file: GitPanelDiffFile,
    repo?: GitRepositoryInfo | null,
    treeRow?: GitPanelFileTreeRow<GitPanelTreeDiffFile>
  ): React.JSX.Element => {
    const diff = file.diff
    const isExpanded = expandedFilePaths.has(file.path)
    const isSelected = selectedFilePaths.has(file.path)
    const isFileDiffLoading = fileDiffLoadingPaths.has(file.path)
    const fileDiffError = fileDiffErrors[file.path]
    const statusMeta = getFileStatusMeta(file.status, file.path, file.previousPath)
    const showMovePath = file.status === "renamed" && Boolean(file.previousPath)
    const revertHint =
      revertingFilePath === file.path ? "回退中..." : "回退（大模型改动的上一个版本）"
    const fullDisplayPath = getRepositoryFileDisplayPath(file.path, repo)
    const displayPath = treeRow?.name ?? fullDisplayPath
    const previousDisplayPath = file.previousPath
      ? getRepositoryFileDisplayPath(file.previousPath, repo)
      : undefined
    const treeIndent = treeRow ? 8 + treeRow.depth * 18 : 8
    const diffIndent = treeRow ? 30 + treeRow.depth * 18 : 8

    return (
      <div
        key={file.path}
        className={cn(
          "border-t border-border/60 bg-background transition-colors first:border-t-0",
          isExpanded && "bg-muted/10"
        )}
      >
        <div
          className="flex items-center justify-between gap-2 py-1.5 pr-2 text-xs"
          style={{ paddingLeft: treeIndent }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              type="checkbox"
              checked={isSelected}
              aria-label={`选择文件 ${fullDisplayPath}`}
              onChange={(e) => {
                e.stopPropagation()
                toggleFileSelected(file.path)
              }}
              onClick={(e) => e.stopPropagation()}
              className="size-3.5 shrink-0 accent-blue-600"
            />
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => toggleFileExpanded(file.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {isExpanded ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
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
                title={fullDisplayPath}
              >
                {displayPath}
              </span>
            </button>
          </div>
          <span className="flex items-center gap-2 shrink-0">
            <OpenInIdeButton
              filePath={file.path}
              workspacePath={workspacePath}
              fileMissing={file.status === "deleted"}
              align="end"
              stopPropagation
              onOpenError={(message) => {
                showToast(message, "error")
              }}
            />
            <IconPopoverButton
              icon={<FolderOpen className="size-3" />}
              popoverContent="打开文件夹"
              aria-label="打开文件夹"
              align="end"
              stopPropagation
              onClick={() => onOpenFileFolder?.(file.path)}
            />
            <IconPopoverButton
              icon={
                <Undo2
                  className={cn(
                    "size-3",
                    revertingFilePath === file.path && "animate-spin"
                  )}
                />
              }
              popoverContent={revertHint}
              disabled={Boolean(revertingFilePath && revertingFilePath !== file.path)}
              aria-label={revertHint}
              align="end"
              stopPropagation
              className={cn(revertingFilePath === file.path && "opacity-80")}
              onClick={() => {
                if (!revertingFilePath) void handleRevertFile(file.path)
              }}
            />
          </span>
        </div>
        {isExpanded && (
          <div className="pb-2 pr-2" style={{ paddingLeft: diffIndent }}>
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground">变更统计</span>
              <span
                className={cn(
                  "inline-flex h-4 items-center rounded border px-1 text-[9px] font-medium leading-none",
                  statusMeta.className
                )}
              >
                {statusMeta.label}
              </span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                +{file.additions}
              </span>
              <span className="text-muted-foreground">/</span>
              <span className="font-semibold text-rose-600 dark:text-rose-400">
                -{file.deletions}
              </span>
            </div>
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
                      {previousDisplayPath}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted-foreground">现路径</span>
                    <span
                      className="truncate font-semibold text-foreground"
                      title={file.path}
                    >
                      {fullDisplayPath}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {isFileDiffLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-blue-600 dark:text-blue-400" />
                正在加载该文件 diff...
              </div>
            ) : fileDiffError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {fileDiffError}
              </div>
            ) : !file.diffLoaded ? (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                展开后将按需加载该文件 diff。
              </div>
            ) : diff && diff.trim() !== "" ? (
              <DiffDisplay diff={diff} filePath={displayPath} />
            ) : (
              <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                当前文件暂无可展示 diff（可能已恢复、删除或为二进制文件）。
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderFileTreeRow = (
    row: GitPanelFileTreeRow<GitPanelTreeDiffFile>,
    repo: GitRepositoryInfo | null,
    repositoryKey: string
  ): React.JSX.Element | null => {
    if (row.kind === "file") {
      if (!row.file) return null
      return renderDiffFileCard(row.file, repo, row)
    }

    const directoryCollapseKey = makeDirectoryCollapseKey(repositoryKey, row.id)
    const isCollapsed = collapsedDirectoryPaths.has(directoryCollapseKey)
    const filePaths = row.files.map((file) => file.path)
    const selectedInDirectory = filePaths.filter((filePath) => selectedFilePaths.has(filePath)).length
    const allDirectoryFilesSelected = filePaths.length > 0 && selectedInDirectory === filePaths.length
    const someDirectoryFilesSelected = selectedInDirectory > 0 && !allDirectoryFilesSelected
    const treeIndent = 8 + row.depth * 18

    return (
      <div
        key={`${repositoryKey}:${row.id}`}
        className="border-t border-border/60 bg-muted/20 first:border-t-0"
      >
        <div
          className="flex items-center justify-between gap-2 py-1.5 pr-2 text-xs"
          style={{ paddingLeft: treeIndent }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <TreeSelectionCheckbox
              checked={allDirectoryFilesSelected}
              indeterminate={someDirectoryFilesSelected}
              ariaLabel={`选择目录 ${row.fullPath}`}
              onChange={() => setFilePathsSelected(filePaths, !allDirectoryFilesSelected)}
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left font-medium transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-expanded={!isCollapsed}
              onClick={() => toggleDirectoryCollapsed(repositoryKey, row.id)}
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Folder className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
              <span className="min-w-0 truncate font-mono text-foreground" title={row.fullPath}>
                {row.name}
              </span>
              <span className="shrink-0 rounded-full border border-border/70 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                {selectedInDirectory}/{row.fileCount}
              </span>
            </button>
          </div>
        </div>
      </div>
    )
  }

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
                    {hasMultipleRepositories ? "多仓库工作区" : isWorktreePath ? "Worktree" : "主仓库目录"}
                  </Badge>
                )}
              </div>
              {hasGitRepo && (
                <p className="mt-1.5 text-xs text-muted-foreground leading-5">
                  {hasMultipleRepositories
                    ? "当前工作区包含多个 Git 仓库。请在下方“操作仓库”选择具体子仓库后提交、推送或回退；Pull 在“全部仓库”下会逐仓库执行。"
                    : isWorktreePath
                      ? "当前目录是独立 worktree，可直接执行提交与推送。建议保持一个任务一个 worktree。"
                      : "当前目录是 Git 仓库主目录。建议切换到独立 worktree 后再执行任务，更安全。"}
                </p>
              )}
              {hasGitRepo && (
                <div className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-2 justify-between">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {hasMultipleRepositories && (
                      <Popover open={repositoryPickerOpen} onOpenChange={setRepositoryPickerOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              "inline-flex h-7 min-w-0 max-w-[280px] items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/5 px-2",
                              "text-[11px] font-medium text-blue-800 transition-colors hover:bg-blue-500/10 dark:text-blue-200"
                            )}
                            title={activeRepository?.path ?? "全部仓库（仅查看和 Pull）"}
                          >
                            <GitBranch className="size-3.5 shrink-0" />
                            <span className="shrink-0 text-blue-700 dark:text-blue-300">操作仓库</span>
                            <span className="min-w-0 truncate font-semibold text-foreground">
                              {activeRepositoryLabel}
                            </span>
                            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          sideOffset={6}
                          className="w-[min(420px,calc(100vw_-_2rem))] p-1"
                        >
                          <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                            选择 Git 操作要作用的子仓库
                          </div>
                          <div className="max-h-[280px] overflow-y-auto py-1">
                            <button
                              type="button"
                              className={cn(
                                "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors",
                                activeRepositoryPath === ALL_REPOSITORIES_VALUE
                                  ? "bg-blue-500/10 text-foreground"
                                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                              )}
                              onClick={() => selectActiveRepository(ALL_REPOSITORIES_VALUE)}
                            >
                              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                                {activeRepositoryPath === ALL_REPOSITORIES_VALUE && (
                                  <Check className="size-3.5 text-blue-600 dark:text-blue-400" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block font-semibold text-foreground">全部仓库</span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  用于查看汇总变更和逐仓库 Pull；提交、推送、回退需选择具体仓库
                                </span>
                              </span>
                            </button>
                            {repositories.map((repo) => {
                              const selected = activeRepositoryPath === repo.path
                              return (
                                <button
                                  key={repo.path}
                                  type="button"
                                  className={cn(
                                    "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors",
                                    selected
                                      ? "bg-blue-500/10 text-foreground"
                                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                  )}
                                  title={repo.path}
                                  onClick={() => selectActiveRepository(repo.path)}
                                >
                                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                                    {selected && (
                                      <Check className="size-3.5 text-blue-600 dark:text-blue-400" />
                                    )}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-mono font-semibold text-foreground">
                                      {repo.displayPath}
                                    </span>
                                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                      {repo.path}
                                    </span>
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
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
                          onClick={openPushDialog}
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
                          openRejectDialog()
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
            {visibleDiffFiles.length === 0 ? (
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
                    <span className="font-semibold text-foreground">
                      {selectedTotals.fileCount}
                    </span>{" "}
                    / {visibleDiffFiles.length} 个文件
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-background-interactive hover:text-foreground"
                    onClick={() => {
                      setSelectedFilePaths(
                        allVisibleFilesSelected
                          ? new Set()
                          : new Set(visibleDiffFiles.map((file) => file.path))
                      )
                    }}
                  >
                    {allVisibleFilesSelected ? "取消全选" : "全选文件"}
                  </button>
                </div>
                <div className="space-y-3">
                  {repositoryTreeGroups.map((group) => {
                    const repositoryKey = group.repositoryKey
                    const isCollapsed = collapsedRepositoryPaths.has(repositoryKey)
                    const selectedInGroup = group.files.filter((file) => selectedFilePaths.has(file.path))
                    const allGroupFilesSelected =
                      group.files.length > 0 && selectedInGroup.length === group.files.length
                    const someGroupFilesSelected =
                      selectedInGroup.length > 0 && !allGroupFilesSelected
                    const collapsedDirectoryIds = getCollapsedDirectoryIds(
                      repositoryKey,
                      collapsedDirectoryPaths
                    )
                    const treeRows = flattenGitPanelFileTree(group.tree, collapsedDirectoryIds)
                    return (
                      <section
                        key={repositoryKey}
                        className="overflow-hidden rounded-md border border-border/80 bg-background"
                      >
                        {hasMultipleRepositories && group.repo && (
                          <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-blue-500/5 px-3 py-2">
                            <label className="inline-flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold">
                              <TreeSelectionCheckbox
                                checked={allGroupFilesSelected}
                                indeterminate={someGroupFilesSelected}
                                ariaLabel={`选择仓库 ${group.repo.displayPath}`}
                                onChange={() =>
                                  setFilePathsSelected(
                                    group.files.map((file) => file.path),
                                    !allGroupFilesSelected
                                  )
                                }
                              />
                              <button
                                type="button"
                                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                aria-label={isCollapsed ? "展开仓库" : "折叠仓库"}
                                aria-expanded={!isCollapsed}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  toggleRepositoryCollapsed(repositoryKey)
                                }}
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="size-3.5" />
                                ) : (
                                  <ChevronDown className="size-3.5" />
                                )}
                              </button>
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-blue-500/25 bg-blue-500/10">
                                <GitBranch className="size-3.5 text-blue-700 dark:text-blue-300" />
                              </span>
                              <span className="shrink-0 rounded border border-blue-500/25 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-blue-700 dark:text-blue-300">
                                仓库
                              </span>
                              <span
                                className="truncate font-mono text-foreground"
                                title={group.repo.path}
                              >
                                {group.repo.displayPath}
                              </span>
                            </label>
                            <div className="flex shrink-0 items-center gap-2 text-[11px] font-medium text-muted-foreground">
                              <span className="rounded-full border border-border/70 bg-background/80 px-2 py-0.5">
                                {selectedInGroup.length}/{group.files.length}
                              </span>
                            </div>
                          </div>
                        )}
                        <div className={cn("divide-y-0", isCollapsed && "hidden")}>
                          {treeRows.map((row) => renderFileTreeRow(row, group.repo, repositoryKey))}
                        </div>
                      </section>
                    )
                  })}
                </div>
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
        commitHistory={commitHistory}
        preferredTaskText={branchName}
        onOpenChange={(open) => {
          if (!open) setSubmitAction(null)
        }}
        onCardNumberChange={handleCardNumberChange}
        onCommitTypeChange={setCommitType}
        onCommitMessageChange={setCommitMessage}
        onHistorySelect={applyCommitHistoryRecord}
        onSubmit={() => {
          void runSubmit("commit")
        }}
      />
      <GitRejectDialog
        open={rejectDialogOpen}
        running={running === "reject"}
        loading={rejectDialogLoading}
        selectionSeed={rejectDialogSelectionSeed}
        files={rejectDialogFiles}
        omittedFileCount={rejectDialogOmittedFileCount}
        onOpenChange={(open) => {
          setRejectDialogOpen(open)
          if (!open) {
            rejectDialogRequestIdRef.current += 1
            setRejectDialogLoading(false)
          }
        }}
        onSubmit={(filePaths) => {
          void runReject(filePaths)
        }}
      />
      <GitPushDialog
        open={submitAction === "push"}
        running={running === "push"}
        loading={pushMetaLoading}
        branch={pushMetaState?.worktreeBranch || activeRepository?.displayPath || metaState?.worktreeBranch || "-"}
        pendingCommits={pushMetaLoading ? undefined : (pushMetaState?.pendingCommits ?? metaState?.pendingCommits)}
        onOpenChange={(open) => {
          if (!open) {
            pushMetaRequestIdRef.current += 1
            setPushMetaLoading(false)
            setPushMetaState(null)
            setSubmitAction(null)
          }
        }}
        onSubmit={() => {
          void runSubmit("push")
        }}
      />
    </div>
  )
}
