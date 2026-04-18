import { selectWorkspaceFolder } from "@/lib/workspace-utils"
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  Loader2,
  AlertCircle,
  Copy,
  CheckCheck,
  Trash2
} from "lucide-react"
import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCurrentThread } from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

interface WorkspacePickerProps {
  threadId: string
  onGitStatusChange?: (threadId: string, isGit: boolean) => void
}

type WorkspaceMode = "local" | "worktree"
type WorktreeItem = { path: string; branch: string; isMain: boolean; createdAt?: Date }

function PathRow({ label, path, highlight = false }: { label: string; path: string; highlight?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)

  function handleCopy(): void {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className="flex items-center gap-1.5 group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <div className="relative flex-1 min-w-0">
        <span
          className={cn(
            "block text-[11px] font-mono truncate leading-snug",
            highlight ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {path}
        </span>
        {/* Full path shown on hover */}
        {hovered && (
          <div className="absolute bottom-full left-0 mb-1 z-50 max-w-[340px] break-all rounded-md bg-popover border border-border shadow-md px-2.5 py-1.5 text-[11px] font-mono text-foreground leading-relaxed pointer-events-none">
            {path}
          </div>
        )}
      </div>
      <button
        onClick={handleCopy}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
        title="复制路径"
      >
        {copied
          ? <CheckCheck className="size-3 text-status-nominal" />
          : <Copy className="size-3 text-muted-foreground" />
        }
      </button>
    </div>
  )
}

export function WorkspacePicker({ threadId, onGitStatusChange }: WorkspacePickerProps): React.JSX.Element {
  const { workspacePath, setWorkspacePath, setWorkspaceFiles, messages } = useCurrentThread(threadId)
  const canChangeWorkspace = messages.length === 0
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  // Git detection state
  const [isGit, setIsGit] = useState(false)
  const [gitRoot, setGitRoot] = useState<string | null>(null)
  const [isWorktreePath, setIsWorktreePath] = useState(false)
  const [mode, setMode] = useState<WorkspaceMode>("local")

  // Worktree context (from thread metadata)
  const [isWorktree, setIsWorktree] = useState(false)
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null)
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState<string | null>(null)

  // Worktree creation state
  const [creatingWorktree, setCreatingWorktree] = useState(false)
  const [branchName, setBranchName] = useState("")
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const [worktreeList, setWorktreeList] = useState<WorktreeItem[]>([])
  const [worktreeListLoading, setWorktreeListLoading] = useState(false)
  const [removingWorktreePath, setRemovingWorktreePath] = useState<string | null>(null)

  async function refreshWorktreeList(root: string): Promise<void> {
    setWorktreeListLoading(true)
    try {
      const rows = await window.api.workspace.listWorktrees(root)
      setWorktreeList(rows)
    } catch {
      setWorktreeList([])
    } finally {
      setWorktreeListLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadWorkspace(): Promise<void> {
      if (!threadId) return

      // Reset all state before loading new thread to avoid stale values showing
      setIsGit(false)
      setGitRoot(null)
      setIsWorktreePath(false)
      setMode("local")
      setIsWorktree(false)
      setWorktreeBranch(null)
      setWorktreeBaseBranch(null)
      setCreatingWorktree(false)
      setWorktreeError(null)
      setWorktreeList([])

      const p = await window.api.workspace.get(threadId)
      if (cancelled) return
      setWorkspacePath(p)
      if (p) {
        const result = await window.api.workspace.loadFromDisk(threadId)
        if (cancelled) return
        if (result.success && result.files) setWorkspaceFiles(result.files)

        const gitInfo = await window.api.workspace.isGit(p, { includeWorktrees: false })
        if (cancelled) return
        setIsGit(gitInfo.isGit)
        setGitRoot(gitInfo.isGit ? gitInfo.gitRoot : null)
        setIsWorktreePath(gitInfo.isWorktreePath)
        onGitStatusChange?.(threadId, gitInfo.isGit)

        // Load worktree context from thread metadata
        const thread = await window.api.threads.get(threadId)
        if (cancelled) return
        const meta = thread?.metadata as Record<string, unknown> | undefined
        if (meta?.isWorktree && meta.gitRoot && meta.worktreeBranch) {
          setIsWorktree(true)
          setGitRoot(meta.gitRoot as string)
          setWorktreeBranch(meta.worktreeBranch as string)
          setWorktreeBaseBranch((meta.worktreeBaseBranch as string) ?? null)
          setMode("worktree")
        }
      } else {
        onGitStatusChange?.(threadId, false)
      }
    }
    loadWorkspace()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  useEffect(() => {
    if (!open || !isGit || !gitRoot) return
    void refreshWorktreeList(gitRoot)
  }, [open, isGit, gitRoot])

  async function handleSelectFolder(): Promise<void> {
    await selectWorkspaceFolder(threadId, setWorkspacePath, setWorkspaceFiles, setLoading, setOpen)
    const newPath = await window.api.workspace.get(threadId)
    if (newPath) {
      const gitInfo = await window.api.workspace.isGit(newPath, { includeWorktrees: false })
      setIsGit(gitInfo.isGit)
      setGitRoot(gitInfo.isGit ? gitInfo.gitRoot : null)
      setIsWorktreePath(gitInfo.isWorktreePath)
      onGitStatusChange?.(threadId, gitInfo.isGit)
      setWorktreeList([])
      setMode("local")
      setIsWorktree(false)
      setWorktreeBranch(null)
      setWorktreeBaseBranch(null)
      setCreatingWorktree(false)
      setWorktreeError(null)
    }
  }

  async function handleCreateWorktree(): Promise<void> {
    if (!gitRoot || !branchName.trim()) return
    setLoading(true)
    setWorktreeError(null)
    try {
      const result = await window.api.workspace.createWorktree(gitRoot, branchName.trim())
      if (!result.success || !result.path || !result.branch) {
        setWorktreeError(result.error ?? "创建失败")
        return
      }
      await window.api.workspace.set(threadId, result.path)
      await window.api.workspace.saveWorktreeContext(
        threadId,
        gitRoot,
        result.branch,
        result.baseBranch,
        result.baseCommit
      )
      setWorkspacePath(result.path)
      setIsWorktree(true)
      setWorktreeBranch(result.branch)
      setWorktreeBaseBranch(result.baseBranch ?? null)
      setMode("worktree")
      const diskResult = await window.api.workspace.loadFromDisk(threadId)
      if (diskResult.success && diskResult.files) setWorkspaceFiles(diskResult.files)
      setCreatingWorktree(false)
      setBranchName("")
      await refreshWorktreeList(gitRoot)
      setOpen(false)
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : "创建失败")
    } finally {
      setLoading(false)
    }
  }

  function handleModeSelect(selected: WorkspaceMode): void {
    setMode(selected)
    setWorktreeError(null)
    if (selected === "worktree" && !isWorktree) {
      setCreatingWorktree(true)
    } else {
      setCreatingWorktree(false)
      setBranchName("")
    }
  }

  async function handleRemoveWorktree(item: WorktreeItem): Promise<void> {
    if (!gitRoot || item.isMain) return
    if (workspacePath === item.path) {
      setWorktreeError("当前正在使用该 Worktree，请先切换到其他路径后再删除。")
      return
    }
    setRemovingWorktreePath(item.path)
    setWorktreeError(null)
    try {
      const result = await window.api.workspace.removeWorktree(gitRoot, item.path)
      if (!result.success) {
        setWorktreeError(result.error ?? "删除失败")
        return
      }
      await refreshWorktreeList(gitRoot)
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : "删除失败")
    } finally {
      setRemovingWorktreePath(null)
    }
  }

  const folderName = workspacePath?.split("/").pop()

  return (
    <Popover open={open} onOpenChange={(v) => {
      setOpen(v)
      if (!v) {
        setBranchName("")
        setWorktreeError(null)
      } else {
        // Restore worktree creation form if mode was already set to worktree
        if (mode === "worktree" && !isWorktree) setCreatingWorktree(true)
      }
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-2 text-xs gap-1.5",
            workspacePath ? "text-foreground" : "text-amber-500"
          )}
          disabled={!threadId}
        >
          {isWorktree ? <GitBranch className="size-3.5" /> : <Folder className="size-3.5" />}
          <span className="max-w-[160px] truncate">
            {workspacePath
              ? isWorktree && worktreeBranch
                ? worktreeBaseBranch
                  ? `${worktreeBaseBranch} ← ${worktreeBranch}`
                  : worktreeBranch
                : folderName
              : "选择工作区"}
          </span>
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground tracking-wider">
            工作区文件夹
          </div>

          {workspacePath ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-2 rounded-md bg-background-secondary border border-border">
                <Check className="size-3.5 text-status-nominal shrink-0" />
                <span className="text-sm truncate flex-1" title={workspacePath}>
                  {isWorktree && worktreeBranch ? worktreeBranch : folderName}
                </span>
                {isWorktree && (
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                    worktree
                  </span>
                )}
              </div>

              {/* Full path display */}
              <div className="space-y-1">
                {isWorktree && gitRoot ? (
                  <>
                    <PathRow label="主仓库" path={gitRoot} />
                    <PathRow label="Worktree" path={workspacePath} highlight />
                  </>
                ) : (
                  <PathRow label="路径" path={workspacePath} />
                )}
              </div>

              {/* Git mode selector — 仅在未使用 worktree、且选中路径不是 worktree 时展示 */}
              {isGit && !isWorktree && !isWorktreePath && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">工作模式</div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleModeSelect("local")}
                      className={cn(
                        "flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors",
                        mode === "local"
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border hover:bg-muted"
                      )}
                    >
                      <Folder className="size-3" />
                      Local
                      {mode === "local" && <Check className="size-3 ml-auto" />}
                    </button>
                    <button
                      onClick={() => handleModeSelect("worktree")}
                      className={cn(
                        "flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border transition-colors",
                        mode === "worktree"
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border hover:bg-muted"
                      )}
                    >
                      <GitBranch className="size-3" />
                      Worktree
                      {mode === "worktree" && <Check className="size-3 ml-auto" />}
                    </button>
                  </div>
                </div>
              )}

              {/* Worktree creation form */}
              {isGit && !isWorktree && creatingWorktree && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">新建分支名称</div>
                  <Input
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="feature/my-feature"
                    className="h-7 text-xs"
                    onKeyDown={(e) => e.key === "Enter" && handleCreateWorktree()}
                  />
                  {worktreeError && (
                    <div className="flex items-start gap-1.5 text-[11px] text-destructive">
                      <AlertCircle className="size-3 mt-0.5 shrink-0" />
                      <span>{worktreeError}</span>
                    </div>
                  )}
                  <Button
                    size="sm"
                    className="w-full h-7 text-xs"
                    onClick={handleCreateWorktree}
                    disabled={loading || !branchName.trim()}
                  >
                    {loading && <Loader2 className="size-3 mr-1.5 animate-spin" />}
                    创建 Worktree 并切换
                  </Button>
                </div>
              )}

              {/* Worktree info */}
              {isWorktree && gitRoot && (
                <div className="space-y-2">
                  {/* Branch lineage */}
                  {worktreeBaseBranch && worktreeBranch && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <GitBranch className="size-3 shrink-0" />
                      <span className="font-mono">{worktreeBaseBranch}</span>
                      <span>←</span>
                      <span className="font-mono text-foreground">{worktreeBranch}</span>
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    提交、推送和回滚请在右上角的 Git 操作里进行。
                  </p>
                </div>
              )}

              {isGit && gitRoot && (isWorktree || mode === "worktree") && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Worktree 列表</div>
                  <div className="max-h-40 overflow-auto rounded-md border border-border bg-background-secondary">
                    {worktreeListLoading ? (
                      <div className="h-16 flex items-center justify-center text-xs text-muted-foreground">
                        <Loader2 className="size-3 mr-1.5 animate-spin" />
                        加载中...
                      </div>
                    ) : worktreeList.length === 0 ? (
                      <div className="h-16 flex items-center justify-center text-xs text-muted-foreground">
                        暂无 Worktree
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {worktreeList.map((item) => (
                          <div key={item.path} className="px-2 py-1.5 flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] truncate text-foreground">{item.branch}</div>
                              <div className="text-[10px] truncate text-muted-foreground">{item.path}</div>
                            </div>
                            {item.isMain ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                main
                              </span>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-destructive hover:text-destructive"
                                onClick={() => handleRemoveWorktree(item)}
                                disabled={removingWorktreePath === item.path}
                              >
                                {removingWorktreePath === item.path ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Trash2 className="size-3" />
                                )}
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!isWorktree && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {isGit && mode === "worktree"
                    ? "将基于当前仓库创建一个独立的 Worktree，代理在隔离的分支中工作。"
                    : "代理将在此文件夹中读写文件。"}
                </p>
              )}

              {canChangeWorkspace && !isWorktree && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-xs"
                  onClick={handleSelectFolder}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="size-3 mr-1.5 animate-spin" /> : <Folder className="size-3.5 mr-1.5" />}
                  更换文件夹
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                选择一个文件夹作为工作区，代理将直接在该位置读写文件。
              </p>
              <Button
                variant="default"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={handleSelectFolder}
                disabled={loading}
              >
                <Folder className="size-3.5 mr-1.5" />
                选择文件夹
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
