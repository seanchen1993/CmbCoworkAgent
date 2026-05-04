import React, { useState, useEffect, useCallback, useRef } from "react"
import { GitBranch, Check, Loader2, RefreshCw, AlertCircle, ChevronDown, Plus } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface GitBranchSwitcherProps {
  /** 工作区路径，用于执行 git 命令的 cwd */
  workspacePath?: string | null
}

export function GitBranchSwitcher({ workspacePath }: GitBranchSwitcherProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [isWorktree, setIsWorktree] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [switching, setSwitching] = useState(false)
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [loadingBranches, setLoadingBranches] = useState(false)
  const [createBranchName, setCreateBranchName] = useState("")
  const searchInputRef = useRef<HTMLInputElement>(null)

  // 检测是否是 git 仓库并获取当前分支
  const detectBranch = useCallback(async () => {
    try {
      const result = await window.api.git.currentBranch(workspacePath ?? undefined)
      setIsGitRepo(result.isGitRepo)
      setCurrentBranch(result.branch)
      setIsWorktree(result.isWorktree)
    } catch {
      setIsGitRepo(false)
      setCurrentBranch(null)
      setIsWorktree(false)
    }
  }, [workspacePath])

  // 加载所有分支
  const loadBranches = useCallback(async () => {
    setLoadingBranches(true)
    setSwitchError(null)
    try {
      const result = await window.api.git.listBranches(workspacePath ?? undefined)
      if (result.success) {
        setBranches(result.branches)
      } else {
        setBranches([])
      }
    } catch {
      setBranches([])
    } finally {
      setLoadingBranches(false)
    }
  }, [workspacePath])

  // 挂载时检测分支，工作区路径变化时重新检测
  useEffect(() => {
    setIsGitRepo(false)
    setCurrentBranch(null)
    setIsWorktree(false)
    setBranches([])
    detectBranch()
  }, [workspacePath, detectBranch])

  // Popover 打开时加载分支列表
  useEffect(() => {
    if (open) {
      loadBranches()
      setSearchQuery("")
      setCreateBranchName("")
      setSwitchError(null)
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [open, loadBranches])

  const handleSwitchBranch = useCallback(
    async (branch: string) => {
      if (branch === currentBranch || switching || creatingBranch) return
      setSwitching(true)
      setSwitchError(null)
      try {
        const result = await window.api.git.switchBranch(branch, workspacePath ?? undefined)
        if (result.success) {
          setCurrentBranch(branch)
          setOpen(false)
        } else {
          setSwitchError(result.error || "切换分支失败")
        }
      } catch (err) {
        setSwitchError(err instanceof Error ? err.message : "切换分支失败")
      } finally {
        setSwitching(false)
      }
    },
    [currentBranch, switching, creatingBranch, workspacePath]
  )

  const handleCreateBranch = useCallback(async () => {
    const branch = createBranchName.trim()
    if (!branch || switching || creatingBranch) return
    if (branch === currentBranch) {
      setSwitchError("当前已在该分支")
      return
    }

    setCreatingBranch(true)
    setSwitchError(null)
    try {
      const result = await window.api.git.createBranch(branch, workspacePath ?? undefined)
      if (!result.success) {
        setSwitchError(result.error || "创建分支失败")
        return
      }
      setCurrentBranch(branch)
      setCreateBranchName("")
      await loadBranches()
      setOpen(false)
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "创建分支失败")
    } finally {
      setCreatingBranch(false)
    }
  }, [createBranchName, switching, creatingBranch, currentBranch, workspacePath, loadBranches])

  const busy = switching || creatingBranch
  const canCreate = createBranchName.trim().length > 0 && !busy

  const handleCreateBranchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    void handleCreateBranch()
  }, [handleCreateBranch])

  const createActionLabel = creatingBranch ? "创建中..." : "创建并切换"
  const headerTitle = "切换分支"

  const filteredBranches = branches.filter((b) =>
    b.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // 不是 git 仓库或没有分支时不展示
  if (!isGitRepo || !currentBranch) return null

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
                <span className="truncate">{currentBranch}</span>
                {!isWorktree && <ChevronDown className="size-3 shrink-0" />}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <p>{isWorktree ? "Worktree 模式下不允许切换分支" : "点击切换分支"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-60 p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-foreground">{headerTitle}</span>
          <button
            type="button"
            onClick={loadBranches}
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

        {/* 创建分支 */}
        {/*<div className="px-2 py-1.5 border-b border-border space-y-1.5">*/}
        {/*  <div className="flex items-center gap-1.5">*/}
        {/*    <input*/}
        {/*      type="text"*/}
        {/*      value={createBranchName}*/}
        {/*      onChange={(e) => setCreateBranchName(e.target.value)}*/}
        {/*      onKeyDown={handleCreateBranchKeyDown}*/}
        {/*      placeholder="新分支名，例如 feat/demo"*/}
        {/*      className={cn(*/}
        {/*        "w-full text-xs px-2 py-1 rounded-sm bg-muted/50 border border-transparent",*/}
        {/*        "focus:outline-none focus:border-ring focus:bg-background transition-colors",*/}
        {/*        "placeholder:text-muted-foreground"*/}
        {/*      )}*/}
        {/*    />*/}
        {/*    <button*/}
        {/*      type="button"*/}
        {/*      onClick={() => {*/}
        {/*        void handleCreateBranch()*/}
        {/*      }}*/}
        {/*      disabled={!canCreate}*/}
        {/*      className={cn(*/}
        {/*        "shrink-0 h-6 px-2 rounded-sm border text-[11px] inline-flex items-center gap-1 transition-colors",*/}
        {/*        canCreate*/}
        {/*          ? "border-border hover:bg-muted/50 text-foreground"*/}
        {/*          : "border-border/60 text-muted-foreground cursor-not-allowed opacity-60"*/}
        {/*      )}*/}
        {/*      title={createActionLabel}*/}
        {/*    >*/}
        {/*      {creatingBranch ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}*/}
        {/*    </button>*/}
        {/*  </div>*/}
        {/*  <div className="text-[10px] text-muted-foreground">{createActionLabel}</div>*/}
        {/*</div>*/}

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
            filteredBranches.map((branch) => {
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
                  {isCurrent && (
                    switching ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" />
                    ) : (
                      <Check className="size-3 shrink-0 text-primary" />
                    )
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
