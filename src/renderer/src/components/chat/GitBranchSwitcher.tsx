import React, { useState, useEffect, useCallback, useRef, memo } from "react"
import { GitBranch, Check, Loader2, RefreshCw, AlertCircle, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

interface GitBranchSwitcherProps {
  /** 工作区路径，用于执行 git 命令的 cwd */
  workspacePath?: string | null
}

const GIT_BRANCH_REFRESH_EVENT = "cmb:git-branch-switched"

function notifyGitPanelBranchSwitched(workspacePath?: string | null, branch?: string): void {
  window.dispatchEvent(
    new CustomEvent(GIT_BRANCH_REFRESH_EVENT, {
      detail: { workspacePath: workspacePath ?? null, branch }
    })
  )
}

function isRemoteBranch(branch: string): boolean {
  return branch.startsWith("origin/")
}

export const GitBranchSwitcher = memo(GitBranchSwitcherImpl)

function GitBranchSwitcherImpl({
  workspacePath
}: GitBranchSwitcherProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [gitRepoChecked, setGitRepoChecked] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [isWorktree, setIsWorktree] = useState(false)
  const [gitStatusError, setGitStatusError] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 检测是否是 git 仓库并获取当前分支
  const detectBranch = useCallback(async () => {
    setGitRepoChecked(false)
    try {
      const result = await window.api.git.currentBranch(workspacePath ?? undefined)
      setIsGitRepo(result.isGitRepo)
      setCurrentBranch(result.branch)
      setIsWorktree(result.isWorktree)
      setGitStatusError(result.error ?? null)
    } catch (error) {
      setIsGitRepo(false)
      setCurrentBranch(null)
      setIsWorktree(false)
      setGitStatusError(error instanceof Error ? error.message : null)
    } finally {
      setGitRepoChecked(true)
    }
  }, [workspacePath])

  // 加载所有分支
  const loadBranches = useCallback(async (refreshRemote = false) => {
    setLoadingBranches(true)
    setSwitchError(null)
    try {
      const result = await window.api.git.listBranches(workspacePath ?? undefined, { refreshRemote })
      if (result.branches.length > 0) {
        setBranches(result.branches)
      } else {
        setBranches([])
      }
      if (!result.success) {
        setSwitchError(result.error || "刷新分支列表失败")
      }
    } catch {
      setBranches([])
      setSwitchError("刷新分支列表失败")
    } finally {
      setLoadingBranches(false)
    }
  }, [workspacePath])

  // 挂载时检测分支，工作区路径变化时重新检测
  useEffect(() => {
    setGitRepoChecked(false)
    setIsGitRepo(false)
    setCurrentBranch(null)
    setIsWorktree(false)
    setGitStatusError(null)
    setBranches([])
    setOpen(false)
    detectBranch()
  }, [workspacePath, detectBranch])

  // Popover 打开时加载分支列表
  useEffect(() => {
    if (open && isGitRepo) {
      loadBranches()
      setSearchQuery("")
      setSwitchError(null)
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [isGitRepo, open, loadBranches])

  const handleSwitchBranch = useCallback(
    async (branch: string) => {
      if (branch === currentBranch || switching) return
      setSwitching(true)
      setSwitchError(null)
      try {
        const result = await window.api.git.switchBranch(branch, workspacePath ?? undefined)
        if (result.success) {
          setCurrentBranch(branch)
          setOpen(false)
          toast.success(`已切换到分支 ${branch}`)
          notifyGitPanelBranchSwitched(workspacePath, branch)
          void detectBranch()
        } else {
          setSwitchError(result.error || "切换分支失败")
        }
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : "切换分支失败")
      } finally {
        setSwitching(false)
      }
    },
    [currentBranch, detectBranch, switching, workspacePath]
  )

  const busy = switching
  const headerTitle = "切换分支"

  const filteredBranches = branches.filter((b) =>
    b.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const localBranches = filteredBranches.filter((branch) => !isRemoteBranch(branch))
  const remoteBranches = filteredBranches.filter(isRemoteBranch)
  const branchLabel = currentBranch || "未识别分支"

  const renderBranchButton = (branch: string): React.JSX.Element => {
    const isCurrent = branch === currentBranch
    return (
      <button
        key={branch}
        type="button"
        disabled={busy}
        onClick={() => handleSwitchBranch(branch)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
          isCurrent
            ? "text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          busy && !isCurrent && "opacity-50 cursor-not-allowed"
        )}
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="flex-1 truncate">{branch}</span>
        {isCurrent &&
          (switching ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : (
            <Check className="size-3 shrink-0 text-primary" />
          ))}
      </button>
    )
  }

  if (!gitRepoChecked) return null

  if (!isGitRepo) {
    const unavailable = Boolean(gitStatusError)
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled
              className={cn(
                "inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md",
                unavailable
                  ? "text-destructive border border-destructive/40 bg-destructive/10 cursor-help opacity-100 max-w-[200px]"
                  : "text-muted-foreground cursor-not-allowed opacity-70 max-w-[200px]"
              )}
            >
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{unavailable ? "Git 配置异常" : "非 Git 仓库"}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <p>{gitStatusError ?? "当前工作区不是 Git 仓库，无法切换分支"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <Popover open={open} onOpenChange={isWorktree ? undefined : setOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={isWorktree}
                onClick={isWorktree ? undefined : undefined}
                className={cn(
                  "inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-md",
                  isWorktree
                    ? "text-muted-foreground cursor-not-allowed opacity-70"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
                  "max-w-[200px]"
                )}
              >
                <GitBranch className="size-3 shrink-0" />
                <span className="truncate">{branchLabel}</span>
                {!isWorktree && <ChevronDown className="size-3 shrink-0" />}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <p>{isWorktree ? "Worktree 模式下不允许切换分支" : "点击切换分支"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent align="end" side="top" sideOffset={6} className="w-60 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-foreground">{headerTitle}</span>
          <button
            type="button"
            onClick={() => loadBranches(true)}
            disabled={loadingBranches || busy}
            className="flex items-center justify-center size-5 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
            title="刷新分支列表"
          >
            <RefreshCw className={cn("size-3", loadingBranches && "animate-spin")} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="px-2 py-1.5 border-b border-border">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索分支..."
            className={cn(
              "w-full text-xs px-2 py-1 rounded-sm bg-muted/50 border border-transparent",
              "focus:outline-none focus:border-ring focus:bg-background transition-colors",
              "placeholder:text-muted-foreground"
            )}
          />
        </div>

        {/* 错误提示 */}
        {switchError && (
          <div className="flex items-start gap-1.5 px-3 py-2 bg-destructive/10 text-destructive text-[11px] border-b border-border">
            <AlertCircle className="size-3 mt-0.5 shrink-0" />
            <span className="leading-snug break-all">{switchError}</span>
          </div>
        )}

        {/* 分支列表 */}
        <div className="max-h-[200px] overflow-y-auto py-1">
          {loadingBranches ? (
            <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载中...
            </div>
          ) : filteredBranches.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {searchQuery ? "没有匹配的分支" : "暂无分支"}
            </div>
          ) : (
            <>
              {localBranches.length > 0 && (
                <div className="px-3 pb-1 pt-1.5 text-[12px] text-black">本地分支</div>
              )}
              {localBranches.map(renderBranchButton)}
              {localBranches.length > 0 && remoteBranches.length > 0 && (
                <div className="my-1 border-t border-border" />
              )}
              {remoteBranches.length > 0 && (
                <div className="px-3 pb-1 pt-1.5 text-[12px] text-black">远程分支</div>
              )}
              {remoteBranches.map(renderBranchButton)}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
