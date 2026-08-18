import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { VirtualList } from "@/components/ui/virtual-list"
import { cn } from "@/lib/utils"
import { parseUnifiedDiffRows, type DiffRow } from "@/lib/diff-utils"
import {
  AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE,
  buildInitialSelectedPaths,
  normalizeCommitPath,
  pathMatchesSelection,
  pathsForCommitSelectionFile,
  resolveCommitWorktreePath,
  shouldAutoDismissEmptyAgentCommitSelection
} from "@/lib/agent-git-commit-selection"
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

type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"
interface DiffFile {
  path: string
  previousPath?: string
  status?: GitPanelFileStatus
  additions: number
  deletions: number
  diff: string
  diffLoaded?: boolean
}

function basename(filePath: string): string {
  const parts = filePath.split("/")
  return parts[parts.length - 1] || filePath
}

function isDiffFileSelected(file: DiffFile, selectedPaths: Set<string>): boolean {
  for (const selectedPath of selectedPaths) {
    if (pathMatchesSelection(file, selectedPath)) return true
  }
  return false
}

function pathsForDiffFile(file: DiffFile): string[] {
  return pathsForCommitSelectionFile(file)
}

/** Fixed row height for virtualized diff (matched to leading-5 = 20px). */
const DIFF_ROW_HEIGHT = 20

function renderDiffListItem(row: DiffRow): React.ReactNode {
  if (row.type === "file") {
    return (
      <div className="h-5 leading-5 truncate border-t border-border/60 bg-muted/60 px-2 font-medium text-foreground first:border-t-0">
        {row.text}
      </div>
    )
  }
  if (row.type === "hunk") {
    return (
      <div className="h-5 leading-5 truncate bg-muted/30 px-2 text-muted-foreground">
        {row.text}
      </div>
    )
  }
  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " "
  return (
    <div
      className={cn(
        "flex h-5 gap-2 px-2",
        row.type === "add" && "bg-emerald-500/10",
        row.type === "del" && "bg-rose-500/10"
      )}
    >
      <span
        className={cn(
          "w-3 shrink-0 select-none text-right leading-5",
          row.type === "add"
            ? "text-emerald-600 dark:text-emerald-400"
            : row.type === "del"
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground/40"
        )}
      >
        {sign}
      </span>
      <span className="min-w-0 flex-1 truncate leading-5">
        {row.text || "\u00a0"}
      </span>
    </div>
  )
}

/**
 * Virtualized unified diff for a single file — renders only visible rows into the DOM.
 * The parent supplies height + border.
 */
function UnifiedDiffView({ diff }: { diff: string }): React.JSX.Element {
  const rows = useMemo(() => parseUnifiedDiffRows(diff), [diff])
  return (
    <div className="h-full bg-background-secondary font-mono text-[11px]">
      <VirtualList
        items={rows}
        itemHeight={DIFF_ROW_HEIGHT}
        maxHeight="100%"
        overscanCount={30}
        renderItem={(row) => renderDiffListItem(row)}
        listClassName="overflow-x-auto"
      />
    </div>
  )
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
  /** File paths the agent selected via commit pathspecs or existing staged files. */
  suggestedFilePaths?: string[]
  /** Base cwd for explicit pathspecs after applying git -C. */
  suggestedFileBasePath?: string
  /** Preferred Git operation target, normally the repository root. */
  suggestedGitWorktreePath?: string
  /** Where suggestedFilePaths came from. */
  suggestedFileSelectionSource?: "pathspec" | "staged"
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
  suggestedFilePaths,
  suggestedFileBasePath,
  suggestedGitWorktreePath,
  suggestedFileSelectionSource,
  onCommitted,
  onCancel
}: AgentGitCommitDialogProps): React.JSX.Element {
  const activeThreadIdRef = useRef(threadId)
  const diffListRequestIdRef = useRef(0)
  const emptySelectionResolvedRef = useRef(false)
  const { cardNumber, handleCardNumberChange, persistNow } = useWorkspaceTaskCard(workspacePath)
  const commitWorktreePath = resolveCommitWorktreePath(
    workspacePath,
    suggestedGitWorktreePath
  )
  // Seed type + message from the agent's suggestion. The parent remounts this dialog
  // (via a key tied to the approval id) for each new commit, so lazy initializers give
  // fresh state per commit without a state-resetting effect.
  // Parse the agent's suggestion once on mount (the dialog is remounted per commit via a
  // key on the approval id, so this re-runs for each new commit).
  const [initialSuggestion] = useState(() => parseSuggestedMessage(suggestedMessage))
  const [initialSuggestedFilePaths] = useState(() => suggestedFilePaths ?? [])
  const [initialSuggestedFileBasePath] = useState(() => suggestedFileBasePath)
  const [initialFileSelectionSource] = useState(() => suggestedFileSelectionSource)
  const [commitType, setCommitType] = useState<CommitType>(initialSuggestion.type ?? "fix")
  const [commitMessage, setCommitMessage] = useState(initialSuggestion.message)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Changed files + diffs for the thread workspace, so the user can review and adjust the
  // agent-selected commit scope. Mirrors the data the Git Panel shows.
  const [diff, setDiff] = useState<{
    files: DiffFile[]
    changedFiles?: string[]
    totals: { fileCount: number; additions: number; deletions: number }
    omittedFileCount: number
  } | null>(null)
  // Starts true so the first paint shows "加载中"; the fetch's finally clears it. The
  // dialog is remounted per commit (keyed on the approval id), so this re-initializes.
  const [diffLoading, setDiffLoading] = useState(true)
  const [diffError, setDiffError] = useState<string | null>(null)
  // Per-file lazy diff loading: only the file the user is viewing has its patch fetched.
  const [fileDiffLoadingPaths, setFileDiffLoadingPaths] = useState<Set<string>>(new Set())
  const [fileDiffErrors, setFileDiffErrors] = useState<Record<string, string>>({})
  // Master-detail: which file's diff is shown on the right. null → fall back to first file.
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedCommitPaths, setSelectedCommitPaths] = useState<Set<string>>(
    () =>
      buildInitialSelectedPaths([], initialSuggestedFilePaths, undefined, {
        suggestedBasePath: initialSuggestedFileBasePath,
        repositoryRootPath: suggestedGitWorktreePath,
        suggestedPathKind: initialFileSelectionSource,
        workspacePath,
        targetWorktreePath: commitWorktreePath
      })
  )

  useEffect(() => {
    activeThreadIdRef.current = threadId
    if (!open) {
      diffListRequestIdRef.current += 1
      return
    }
    const requestId = ++diffListRequestIdRef.current
    let cancelled = false
    setDiffError(null)
    window.api.workspace
      // 仅拉取文件列表与统计，diff 正文等用户在右侧查看某文件时再按需加载，
      // 避免一次性为所有变更文件串行计算 diff 导致打开提交弹窗很慢。
      .getGitPanelDiffs(threadId, {
        includeDiffs: false,
        includeChangedFiles: true,
        statusUntrackedMode: "normal",
        worktreePath: commitWorktreePath
      })
      .then((res) => {
        if (cancelled || requestId !== diffListRequestIdRef.current) return
        if (!res.success) {
          setDiffError(res.error || "加载 Git 文件变更失败")
          return
        }
        setFileDiffLoadingPaths(new Set())
        setFileDiffErrors({})
        setDiff({
          files: res.files ?? [],
          changedFiles: res.changedFiles ?? [],
          totals: res.totals,
          omittedFileCount: res.omittedFileCount ?? 0
        })
        setSelectedCommitPaths(
          buildInitialSelectedPaths(res.files ?? [], initialSuggestedFilePaths, res.changedFiles ?? [], {
            suggestedBasePath: initialSuggestedFileBasePath,
            repositoryRootPath: suggestedGitWorktreePath,
            suggestedPathKind: initialFileSelectionSource,
            workspacePath,
            targetWorktreePath: commitWorktreePath
          })
        )
      })
      .catch(() => {
        if (!cancelled && requestId === diffListRequestIdRef.current) setDiffError("加载 Git 文件变更失败")
      })
      .finally(() => {
        if (!cancelled && requestId === diffListRequestIdRef.current) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    open,
    threadId,
    initialSuggestedFilePaths,
    initialSuggestedFileBasePath,
    initialFileSelectionSource,
    suggestedGitWorktreePath,
    workspacePath,
    commitWorktreePath
  ])

  const selectedFile = useMemo(
    () => diff?.files.find((f) => f.path === selectedFilePath) ?? diff?.files[0],
    [diff, selectedFilePath]
  )

  const loadFileDiff = useCallback(
    async (filePath: string): Promise<void> => {
      const target = diff?.files.find((f) => f.path === filePath)
      if (!target || target.diffLoaded || fileDiffLoadingPaths.has(filePath)) return
      const requestId = diffListRequestIdRef.current
      const requestThreadId = threadId

      setFileDiffLoadingPaths((prev) => new Set(prev).add(filePath))
      setFileDiffErrors((prev) => {
        if (!(filePath in prev)) return prev
        const next = { ...prev }
        delete next[filePath]
        return next
      })

      try {
        const res = await window.api.workspace.getGitPanelFileDiff(threadId, filePath, {
          worktreePath: commitWorktreePath
        })
        if (requestId !== diffListRequestIdRef.current || res.taskId !== activeThreadIdRef.current) return
        if (!res.success || !res.file) {
          throw new Error(res.error || "加载文件 diff 失败")
        }
        setDiff((prev) => {
          if (!prev) return prev
          if (requestId !== diffListRequestIdRef.current || requestThreadId !== activeThreadIdRef.current) return prev
          const files = prev.files.map((f) =>
            f.path === filePath
              ? {
                  ...f,
                  diff: res.file?.diff ?? "",
                  diffLoaded: true,
                  additions: res.file?.additions ?? f.additions,
                  deletions: res.file?.deletions ?? f.deletions
                }
              : f
          )
          // 行数在按需加载后可能精确化，同步重算 totals，避免汇总与逐文件 +/- 对不上。
          const totals = files.reduce(
            (acc, f) => {
              acc.additions += f.additions
              acc.deletions += f.deletions
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
        if (requestId !== diffListRequestIdRef.current || requestThreadId !== activeThreadIdRef.current) return
        setFileDiffErrors((prev) => ({
          ...prev,
          [filePath]: e instanceof Error ? e.message : "加载文件 diff 失败"
        }))
      } finally {
        if (requestId === diffListRequestIdRef.current && requestThreadId === activeThreadIdRef.current) {
          setFileDiffLoadingPaths((prev) => {
            const next = new Set(prev)
            next.delete(filePath)
            return next
          })
        }
      }
    },
    [threadId, diff?.files, fileDiffLoadingPaths, commitWorktreePath]
  )

  useEffect(() => {
    if (!open) return
    const filePath = selectedFile?.path
    if (!filePath) return
    if (selectedFile?.diffLoaded || fileDiffLoadingPaths.has(filePath) || fileDiffErrors[filePath]) {
      return
    }
    void loadFileDiff(filePath)
  }, [
    open,
    selectedFile?.path,
    selectedFile?.diffLoaded,
    fileDiffLoadingPaths,
    fileDiffErrors,
    loadFileDiff
  ])

  const selectedCommitFilePaths = useMemo(() => {
    const selected = new Set<string>()
    for (const filePath of selectedCommitPaths) {
      const normalized = normalizeCommitPath(filePath)
      if (normalized) selected.add(normalized)
    }
    return Array.from(selected)
  }, [selectedCommitPaths])

  const selectedVisibleFileCount = useMemo(
    () => (diff?.files ?? []).filter((file) => isDiffFileSelected(file, selectedCommitPaths)).length,
    [diff, selectedCommitPaths]
  )
  const suggestedFilePathCount = useMemo(
    () => initialSuggestedFilePaths.map(normalizeCommitPath).filter(Boolean).length,
    [initialSuggestedFilePaths]
  )
  const selectionSourceLabel =
    initialFileSelectionSource === "pathspec"
      ? `Agent 指定了 ${suggestedFilePathCount} 个路径`
      : initialFileSelectionSource === "staged"
        ? `Agent 已暂存 ${suggestedFilePathCount} 个路径`
        : "Agent 未指定文件，默认全选当前变更"

  const cardValue = cardNumber.trim()
  const messageValue = commitMessage.trim()
  const cardMissing = !cardValue
  const messageMissing = !messageValue
  const fileSelectionPending = diffLoading
  const fileSelectionFailed = Boolean(diffError)
  const fileSelectionMissing =
    !fileSelectionPending && !fileSelectionFailed && selectedCommitFilePaths.length === 0
  const fileSelectionBlocked = fileSelectionPending || fileSelectionFailed || fileSelectionMissing

  useEffect(() => {
    if (emptySelectionResolvedRef.current || !diff) return
    if (
      !shouldAutoDismissEmptyAgentCommitSelection({
        selectionSource: initialFileSelectionSource,
        suggestedPathCount: suggestedFilePathCount,
        selectedPathCount: selectedCommitFilePaths.length,
        loading: fileSelectionPending,
        failed: fileSelectionFailed
      })
    ) {
      return
    }
    emptySelectionResolvedRef.current = true
    onCommitted({ success: false, error: AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE })
  }, [
    diff,
    fileSelectionFailed,
    fileSelectionPending,
    initialFileSelectionSource,
    onCommitted,
    selectedCommitFilePaths.length,
    suggestedFilePathCount
  ])

  const finalMessage = useMemo(
    () => (cardValue ? `${cardValue} #comment ${commitType}:${messageValue} #CMBDevClaw` : ""),
    [cardValue, commitType, messageValue]
  )

  const handleSubmit = async (): Promise<void> => {
    if (running || cardMissing || messageMissing || fileSelectionBlocked) return
    setRunning(true)
    setError(null)
    try {
      const result = await window.api.workspace.commitWorktree(
        threadId,
        finalMessage,
        selectedCommitFilePaths,
        { worktreePath: commitWorktreePath, agentInitiated: true }
      )
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

  const toggleCommitFile = (file: DiffFile): void => {
    setSelectedCommitPaths((prev) => {
      const next = new Set(prev)
      const selected = isDiffFileSelected(file, prev)
      for (const filePath of pathsForDiffFile(file)) {
        if (selected) next.delete(filePath)
        else next.add(filePath)
      }
      return next
    })
  }

  const selectAllFiles = (): void => {
    const allChangedFiles = diff?.changedFiles?.length
      ? diff.changedFiles
      : (diff?.files ?? []).map((file) => file.path)
    setSelectedCommitPaths(
      new Set(allChangedFiles.map((filePath) => normalizeCommitPath(filePath)).filter(Boolean))
    )
  }

  const clearFileSelection = (): void => {
    setSelectedCommitPaths(new Set())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-2xl rounded-2xl border border-border bg-background p-0 shadow-xl flex max-h-[85vh] flex-col overflow-hidden">
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

        {diffLoading && !diff && (
          <div className="mx-4 mt-3 flex h-64 items-center justify-center rounded-lg border border-border/70 bg-muted/10 text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            正在加载文件变更...
          </div>
        )}

        {diff && diff.files.length > 0 && (
          <div className="mx-4 mt-3 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="font-medium text-foreground">
                提交文件（预览已选 {selectedVisibleFileCount}/{diff.files.length}，共{" "}
                {selectedCommitFilePaths.length} 路径）
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={selectAllFiles}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  onClick={clearFileSelection}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {selectionSourceLabel}
            </div>
            <div className="flex h-64 overflow-hidden rounded-lg border border-border/70">
              {/* Left: file list (select one to view its diff). */}
              <div className="w-44 shrink-0 overflow-y-auto border-r border-border/60 bg-muted/20">
                {diff.files.map((file) => {
                  const active = file.path === selectedFile?.path
                  const checked = isDiffFileSelected(file, selectedCommitPaths)
                  return (
                    <div
                      key={file.path}
                      title={file.path}
                      className={cn(
                        "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] transition-colors",
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-muted/60"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCommitFile(file)}
                        className="size-3 shrink-0 accent-primary"
                        aria-label={`选择提交 ${file.path}`}
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setSelectedFilePath(file.path)}
                      >
                        <span className="block truncate font-mono">{basename(file.path)}</span>
                      </button>
                      <span className="shrink-0 font-medium">
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{file.additions}
                        </span>
                        <span className="ml-0.5 text-rose-600 dark:text-rose-400">
                          -{file.deletions}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
              {/* Right: selected file's diff only (loaded on demand). */}
              <div className="min-w-0 flex-1">
                {!selectedFile ? (
                  <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                    选择左侧文件查看改动
                  </div>
                ) : fileDiffLoadingPaths.has(selectedFile.path) ||
                  (!selectedFile.diffLoaded && !fileDiffErrors[selectedFile.path]) ? (
                  <div className="flex h-full items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在加载该文件 diff...
                  </div>
                ) : fileDiffErrors[selectedFile.path] ? (
                  <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-destructive">
                    {fileDiffErrors[selectedFile.path]}
                  </div>
                ) : selectedFile.diff ? (
                  <UnifiedDiffView diff={selectedFile.diff} />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                    该文件无文本改动（可能为二进制或体积过大）
                  </div>
                )}
              </div>
            </div>
            {diff.omittedFileCount > 0 && (
              <div className="text-[11px] text-muted-foreground">
                另有 {diff.omittedFileCount} 个文件因体积过大未展示明细
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
          {diffError && (
            <div className="rounded-lg border border-destructive/45 bg-destructive/10 p-3 text-sm text-destructive">
              {diffError}，请取消后重试，避免在无法确认文件范围时提交
            </div>
          )}
          {fileSelectionMissing && (
            <div className="rounded-lg border border-destructive/45 bg-destructive/10 p-3 text-sm text-destructive">
              请至少选择 1 个文件提交
            </div>
          )}
        </form>
        </div>

        <div className="shrink-0 border-t border-border/70 px-5 pb-5 pt-3 flex flex-col gap-2 bg-background">
          <Button
            type="button"
            className="w-full h-9"
            disabled={running || cardMissing || messageMissing || fileSelectionBlocked}
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
