import { selectWorkspaceFolder } from "@/lib/workspace-utils"
import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  GitBranch,
  Loader2,
  AlertCircle,
  RefreshCw,
  Trash2
} from "lucide-react"
import { useState, useEffect } from "react"
import { toast } from "sonner"
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
const WORKSPACE_SWITCH_LOCKED_MESSAGE = "当前线程已有对话消息，不能切换文件夹或创建 Worktree。"

function getFolderName(path: string | null | undefined): string | undefined {
  return path?.split(/[\\/]/).filter(Boolean).pop()
}

function PathRow({ label, path, highlight = false }: { label: string; path: string; highlight?: boolean }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  async function handleOpenFolder(): Promise<void> {
    try {
      const platform = await window.electron.ipcRenderer.invoke("get-platform")
      const folderPath = platform === "win32" ? path.replace(/\//g, "\\") : path
      await window.electron.ipcRenderer.invoke("open-folder", folderPath)
    } catch (error) {
      console.error("[WorkspacePicker] Failed to open folder:", error)
    }
  }

  return (
    <div
      className="flex flex-col gap-1 group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <div className="flex items-start gap-1.5">
        <div className="relative flex-1 min-w-0">
          <span
            className={cn(
              "block text-[11px] font-mono break-all leading-snug overflow-hidden",
              highlight ? "text-foreground" : "text-muted-foreground"
            )}
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2
            }}
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
          onClick={handleOpenFolder}
          className="shrink-0 p-0.5 rounded hover:bg-muted"
          title="打开文件夹"
          aria-label="打开文件夹"
        >
          <FolderOpen className="size-3 text-muted-foreground" />
        </button>
      </div>
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

  // PR-11 — Setup(maintenance) re-run state. Independent of git/worktree flow.
  const [reinitLoading, setReinitLoading] = useState(false)

  async function handleReinitWorkspace(): Promise<void> {
    if (!workspacePath || reinitLoading) return
    setReinitLoading(true)
    try {
      await window.api.hooks.workspace.runSetupMaintenance(workspacePath)
      toast.success("已触发工作区 Setup hooks（maintenance）")
      setOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`重新初始化失败：${msg}`)
    } finally {
      setReinitLoading(false)
    }
  }

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
        const gitInfo = await window.api.workspace.isGit(p, { includeWorktrees: false, threadId })
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

  useEffect(() => {
    if (canChangeWorkspace || isWorktree) return
    setMode("local")
    setCreatingWorktree(false)
    setBranchName("")
    setWorktreeError(null)
  }, [canChangeWorkspace, isWorktree])

  async function handleSelectFolder(): Promise<void> {
    const selection = await selectWorkspaceFolder(
      threadId,
      setWorkspacePath,
      setWorkspaceFiles,
      setLoading,
      setOpen
    )
    if (selection.status !== "success") return
    const newPath = await window.api.workspace.get(threadId)
    if (newPath) {
      const gitInfo = await window.api.workspace.isGit(newPath, { includeWorktrees: false, threadId })
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
    if (!canChangeWorkspace) {
      toast.error(WORKSPACE_SWITCH_LOCKED_MESSAGE)
      return
    }
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
    if (selected === "worktree" && !canChangeWorkspace) {
      toast.error(WORKSPACE_SWITCH_LOCKED_MESSAGE)
      return
    }
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

  const folderName = getFolderName(workspacePath)

  return (
    <Popover open={open} onOpenChange={(v) => {
      setOpen(v)
      if (!v) {
        setBranchName("")
        setWorktreeError(null)
      } else {
        // Restore worktree creation form if mode was already set to worktree
        if (mode === "worktree" && !isWorktree && canChangeWorkspace) setCreatingWorktree(true)
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
                <Folder className="size-3.5 " />
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
                  <PathRow label="完整路径" path={workspacePath} />
                )}
              </div>

              {/* Git mode selector — 仅在未使用 worktree、且选中路径不是 worktree 时展示 */}
              {isGit && !isWorktree && !isWorktreePath && canChangeWorkspace && (
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
              {isGit && !isWorktree && creatingWorktree && canChangeWorkspace && (
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
                      <span className="min-w-0 break-all">{worktreeError}</span>
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

              {isGit && gitRoot && (isWorktree || (mode === "worktree" && canChangeWorkspace)) && (
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
                  {isGit && mode === "worktree" && canChangeWorkspace
                    ? "将基于当前仓库创建一个独立的 Worktree，代理在隔离的分支中工作。"
                    : "代理将在此文件夹中读写文件。"}
                </p>
              )}

              {!canChangeWorkspace && !isWorktree && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {WORKSPACE_SWITCH_LOCKED_MESSAGE}
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
              {/* PR-11 — Re-run workspace Setup hooks (`trigger: "maintenance"`).
                  Available whenever a workspace is set; independent of whether
                  the thread already has messages (Setup is workspace-level, not
                  thread-level). No-op + silent toast if no Setup hook matches. */}
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={handleReinitWorkspace}
                disabled={reinitLoading}
                title="触发已配置的 Setup hook（trigger=maintenance）；用于重新执行工作区初始化脚本，不影响 setup-state 标记"
              >
                {reinitLoading ? (
                  <Loader2 className="size-3 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5 mr-1.5" />
                )}
                重新初始化工作区
              </Button>
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
