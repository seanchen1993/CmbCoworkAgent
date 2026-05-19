import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import {
  Plus,
  Trash2,
  Pencil,
  Loader2,
  AlertCircle,
  Briefcase,
  LayoutDashboard,
  Cpu,
  Terminal,
  BarChart3,
  Palette,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minimize2,
  FolderPlus,
  Download
} from "lucide-react"
import { toast } from "sonner"
import type { ChatXRobotConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { UpdateActionButton } from "@/components/update/UpdateActionButton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { useAppStore } from "@/lib/store"
import {
  useAllStreamLoadingStates,
  useAllThreadStates,
  useThreadContext
} from "@/lib/thread-context"
import { cn, truncate } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import type { Thread } from "@/types"

const NO_WORKSPACE_PROJECT_KEY = "__no_workspace__"
const COLLAPSED_PROJECTS_STORAGE_KEY = "threads:collapsedProjects"

interface ThreadProject {
  key: string
  name: string
  path: string | null
  threads: Thread[]
}

function getThreadWorkspacePath(thread: Thread, statePath?: string | null): string | null {
  if (statePath) return statePath
  const metadataPath = thread.metadata?.workspacePath
  return typeof metadataPath === "string" && metadataPath.trim() ? metadataPath : null
}

function getWorkspaceName(path: string | null): string {
  if (!path) return "未关联工作区"
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function formatCompactTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const now = new Date()
  const diff = now.getTime() - d.getTime()

  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟`
  if (hours < 24) return `${hours}小时`
  if (days < 7) return `${days}天`

  const month = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return `${month}/${day}`
  return `${String(d.getFullYear()).slice(2)}/${month}/${day}`
}

function getDisplayThreadTitle(thread: Thread): string {
  const title = thread.title?.trim()

  if (!title || title === "..." || title === "…") {
    return truncate(thread.thread_id, 20)
  }

  if (title.startsWith("[Heartbeat]")) return title.slice(12).trim()
  if (title.startsWith("[定时]")) return title.slice(5).trim()
  if (title.startsWith("[远端机器人] ")) return `(远端) ${title.slice(8).trim()}`
  if (title.startsWith("[机器人] ")) return title.slice(6).trim()

  return title
}

// Thread status indicator that shows loading, interrupted, or default state
function ThreadStatusIcon({
  isLoading,
  pendingApproval,
  scheduledTaskLoading
}: {
  isLoading: boolean
  pendingApproval: boolean
  scheduledTaskLoading: boolean
}): React.JSX.Element | null {
  if (isLoading || scheduledTaskLoading) {
    return <Loader2 className="size-4 shrink-0 text-status-info animate-spin" />
  }

  if (pendingApproval) {
    return <AlertCircle className="size-4 shrink-0 text-status-warning" />
  }

  return null
}

function ThreadListItem({
  thread,
  isLoading,
  hasPendingApproval,
  scheduledTaskLoading,
  isSelected,
  isEditing,
  isUnread,
  editingTitle,
  onSelect,
  onDelete,
  onExport,
  onRunFinished,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange,
  isExporting
}: {
  thread: Thread
  isLoading: boolean
  hasPendingApproval: boolean
  scheduledTaskLoading: boolean
  isExporting: boolean
  isSelected: boolean
  isEditing: boolean
  isUnread: boolean
  editingTitle: string
  onSelect: () => void
  onDelete: () => void
  onExport: () => void
  onRunFinished: () => void
  onStartEditing: () => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
}): React.JSX.Element {
  const isRunning = isLoading || scheduledTaskLoading
  const wasRunningRef = useRef(false)
  const onRunFinishedRef = useRef(onRunFinished)

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished
  }, [onRunFinished])

  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      onRunFinishedRef.current()
    }
    wasRunningRef.current = isRunning
  }, [isRunning])

  const displayTitle = getDisplayThreadTitle(thread)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group flex items-center gap-2 rounded-sm px-3 py-2 cursor-pointer transition-colors overflow-hidden",
            isSelected
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50"
          )}
          onClick={() => {
            if (!isEditing) {
              onSelect()
            }
          }}
        >
          <ThreadStatusIcon
            isLoading={isLoading}
            pendingApproval={hasPendingApproval}
            scheduledTaskLoading={scheduledTaskLoading}
          />
          <div className="flex-1 min-w-0 overflow-hidden">
            {isEditing ? (
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={onSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveTitle()
                  if (e.key === "Escape") onCancelEditing()
                }}
                className="w-full bg-background border border-border rounded px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className="flex min-w-0 items-center text-sm"
                title={thread.title || thread.thread_id}
              >
                {thread.title?.startsWith("[定时]") ? (
                  <>
                    <span className="shrink-0 text-[10px] px-1 py-px rounded bg-primary/15 text-primary font-medium">
                      定时
                    </span>
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                )}
              </div>
            )}
          </div>
          {isUnread && !isRunning && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />}
          <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
            <span className="absolute right-0 text-[10px] text-muted-foreground transition-opacity group-hover:opacity-0">
              {formatCompactTime(thread.updated_at)}
            </span>
            <span
              className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
              title={isRunning ? "任务运行中，无法删除" : undefined}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                className="cursor-pointer size-6 hover:bg-accent/20"
                onClick={(e) => {
                  e.stopPropagation()
                  onStartEditing()
                }}
              >
                <Pencil className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn(
                  "cursor-pointer size-6 hover:bg-accent/20",
                  isRunning && "cursor-not-allowed !opacity-30"
                )}
                disabled={isRunning}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartEditing}>
          <Pencil className="size-4 mr-2" />
          重命名
        </ContextMenuItem>
        <ContextMenuItem onClick={onExport} disabled={isRunning || isExporting}>
          {isExporting ? (
            <Loader2 className="size-4 mr-2 animate-spin" />
          ) : (
            <Download className="size-4 mr-2" />
          )}
          {isRunning ? "运行中，无法导出" : isExporting ? "正在导出" : "导出会话"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete} disabled={isRunning}>
          <Trash2 className="size-4 mr-2" />
          {isRunning ? "运行中，无法删除" : "删除"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ThreadSidebar(): React.JSX.Element {
  const {
    threads,
    currentThreadId,
    createThread,
    selectThread,
    deleteThread,
    updateThread,
    mainView,
    pendingEvolution,
    showCustomizeView,
    setShowCustomizeView,
    showKanbanView,
    setShowKanbanView,
    showDesignView,
    setShowDesignView,
    showClaudeCodeView,
    setShowClaudeCodeView,
    showDashboardView,
    setShowDashboardView,
    dashboardAllowed
  } = useAppStore()

  const { cleanupThread } = useThreadContext()
  const allThreadStates = useAllThreadStates()
  const allStreamLoadingStates = useAllStreamLoadingStates()

  const [robots, setRobots] = useState<ChatXRobotConfig[]>([])
  const [showRobotPicker, setShowRobotPicker] = useState(false)
  const robotPickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showRobotPicker) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (robotPickerRef.current && !robotPickerRef.current.contains(e.target as Node)) {
        setShowRobotPicker(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [showRobotPicker])
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem("threads:unreadIds") || "[]")
      return new Set(arr)
    } catch {
      return new Set()
    }
  })
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) || "[]")
      return new Set(arr)
    } catch {
      return new Set()
    }
  })
  const [hoveredProjectKey, setHoveredProjectKey] = useState<string | null>(null)
  const [selectingProjectFolder, setSelectingProjectFolder] = useState(false)
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(null)
  const [projectToDelete, setProjectToDelete] = useState<ThreadProject | null>(null)

  const persistUnread = useCallback((ids: Set<string>) => {
    localStorage.setItem("threads:unreadIds", JSON.stringify([...ids]))
  }, [])

  const persistCollapsedProjects = useCallback((keys: Set<string>) => {
    localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...keys]))
  }, [])

  const currentThreadIdRef = useRef(currentThreadId)
  currentThreadIdRef.current = currentThreadId
  const mainViewRef = useRef(mainView)
  mainViewRef.current = mainView

  const handleRunFinished = useCallback(
    (threadId: string) => {
      if (threadId === currentThreadIdRef.current && mainViewRef.current === "thread") return
      setUnreadIds((prev) => {
        if (prev.has(threadId)) return prev
        const next = new Set(prev)
        next.add(threadId)
        persistUnread(next)
        return next
      })
    },
    [persistUnread]
  )

  const markRead = useCallback(
    (threadId: string) => {
      setUnreadIds((prev) => {
        if (!prev.has(threadId)) return prev
        const next = new Set(prev)
        next.delete(threadId)
        persistUnread(next)
        return next
      })
    },
    [persistUnread]
  )

  const threadProjects = useMemo<ThreadProject[]>(() => {
    const projectMap = new Map<string, ThreadProject>()

    for (const thread of threads) {
      const path = getThreadWorkspacePath(thread, allThreadStates[thread.thread_id]?.workspacePath)
      const key = path || NO_WORKSPACE_PROJECT_KEY
      const existing = projectMap.get(key)

      if (existing) {
        existing.threads.push(thread)
      } else {
        projectMap.set(key, {
          key,
          name: getWorkspaceName(path),
          path,
          threads: [thread]
        })
      }
    }

    return Array.from(projectMap.values())
  }, [allThreadStates, threads])

  const toggleProject = useCallback(
    (projectKey: string) => {
      setCollapsedProjectKeys((prev) => {
        const next = new Set(prev)
        if (next.has(projectKey)) {
          next.delete(projectKey)
        } else {
          next.add(projectKey)
        }
        persistCollapsedProjects(next)
        return next
      })
    },
    [persistCollapsedProjects]
  )

  const expandProject = useCallback(
    (projectKey: string) => {
      setCollapsedProjectKeys((prev) => {
        if (!prev.has(projectKey)) return prev
        const next = new Set(prev)
        next.delete(projectKey)
        persistCollapsedProjects(next)
        return next
      })
    },
    [persistCollapsedProjects]
  )

  const allProjectsCollapsed =
    threadProjects.length > 0 &&
    threadProjects.every((project) => collapsedProjectKeys.has(project.key))

  const toggleAllProjects = useCallback(() => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev)
      if (allProjectsCollapsed) {
        for (const project of threadProjects) {
          next.delete(project.key)
        }
      } else {
        for (const project of threadProjects) {
          next.add(project.key)
        }
      }
      persistCollapsedProjects(next)
      return next
    })
  }, [allProjectsCollapsed, persistCollapsedProjects, threadProjects])

  const startEditing = (threadId: string, currentTitle: string): void => {
    setEditingThreadId(threadId)
    setEditingTitle(currentTitle || "")
  }

  const saveTitle = async (): Promise<void> => {
    if (editingThreadId && editingTitle.trim()) {
      await updateThread(editingThreadId, { title: editingTitle.trim() })
    }
    setEditingThreadId(null)
    setEditingTitle("")
  }

  const cancelEditing = (): void => {
    setEditingThreadId(null)
    setEditingTitle("")
  }

  const loadRobots = useCallback(async () => {
    try {
      const config = await window.api.chatx.getConfig()
      if (!config.enabled) {
        setRobots([])
        return
      }
      // Only show robots that have all required fields filled
      const valid = (config.robots || []).filter(
        (r) =>
          r.chatId &&
          r.fromId &&
          r.clientId &&
          r.clientSecret &&
          r.workDir &&
          r.toUserList.length > 0
      )
      setRobots(valid)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    loadRobots()
  }, [loadRobots, showCustomizeView])

  const handleNewThread = async (): Promise<void> => {
    await createThread({ title: `Thread ${new Date().toLocaleDateString()}` })
  }

  const handleNewProjectThread = async (project: ThreadProject): Promise<void> => {
    expandProject(project.key)
    await createThread({
      title: `Thread ${new Date().toLocaleDateString()}`,
      workspacePath: project.path ?? null
    })
  }

  const [creatingRobot, setCreatingRobot] = useState(false)

  const handleAddProject = async (): Promise<void> => {
    if (selectingProjectFolder) return
    setSelectingProjectFolder(true)
    try {
      const workspacePath = await window.api.workspace.select()
      if (!workspacePath) return
      await createThread({
        title: `Thread ${new Date().toLocaleDateString()}`,
        workspacePath
      })
    } finally {
      setSelectingProjectFolder(false)
    }
  }

  const handleNewRobotThread = async (robot: ChatXRobotConfig): Promise<void> => {
    if (creatingRobot) return
    setCreatingRobot(true)
    setShowRobotPicker(false)
    try {
      if (!robot.workDir) {
        alert("该机器人未配置工作目录")
        return
      }
      const now = new Date()
      const timeTag = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
      await createThread({
        workspacePath: robot.workDir,
        title: `[机器人] ${robot.chatId} · ${timeTag}`,
        chatxChatId: robot.chatId,
        chatxRobotChatId: robot.chatId,
        model: robot.modelId || undefined
      })
    } finally {
      setCreatingRobot(false)
    }
  }

  const confirmDeleteThread = useCallback(() => {
    if (!threadToDelete) return
    cleanupThread(threadToDelete.thread_id)
    deleteThread(threadToDelete.thread_id)
    markRead(threadToDelete.thread_id)
    setThreadToDelete(null)
  }, [cleanupThread, deleteThread, markRead, threadToDelete])

  const handleExportThread = useCallback(
    async (thread: Thread): Promise<void> => {
      if (exportingThreadId) return
      setExportingThreadId(thread.thread_id)
      try {
        const result = await window.api.threads.exportSession(thread.thread_id)
        if (result.canceled) return
        if (result.success) {
          toast.success("会话已导出")
          return
        }
        toast.error(result.error || "导出会话失败")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "导出会话失败")
      } finally {
        setExportingThreadId(null)
      }
    },
    [exportingThreadId]
  )

  const confirmDeleteProject = useCallback(async () => {
    if (!projectToDelete) return

    for (const thread of projectToDelete.threads) {
      cleanupThread(thread.thread_id)
      await deleteThread(thread.thread_id)
      markRead(thread.thread_id)
    }

    setCollapsedProjectKeys((prev) => {
      if (!prev.has(projectToDelete.key)) return prev
      const next = new Set(prev)
      next.delete(projectToDelete.key)
      persistCollapsedProjects(next)
      return next
    })
    setProjectToDelete(null)
    setHoveredProjectKey(null)
  }, [cleanupThread, deleteThread, markRead, persistCollapsedProjects, projectToDelete])

  const [version, setVersion] = useState("")

  useEffect(() => {
    // Fetch version proactively — the did-finish-load event may have
    // already fired before this component mounts.
    window.electron.ipcRenderer
      .invoke("get-version")
      .then((ver) => {
        setVersion(ver as string)
      })
      .catch(() => {
        // ignore — version display is non-critical
      })
  }, [])

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar overflow-hidden">
      {/* New Thread Button - with dynamic safe area padding when zoomed out */}
      <div
        className="p-2 space-y-1.5"
        style={{ paddingTop: "calc(8px + var(--sidebar-safe-padding, 0px))" }}
      >
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-sm font-semibold"
          onClick={handleNewThread}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Plus className="size-3" />
          </div>
          <span className="text-muted-foreground">新任务</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-sm font-semibold",
            mainView === "customize" && "bg-muted"
          )}
          onClick={() => setShowCustomizeView(true, pendingEvolution ? "evolution" : undefined)}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Briefcase className="size-3" />
          </div>
          <span className="flex-1 text-left text-muted-foreground">自定义</span>
          {pendingEvolution && <span className="size-2 rounded-full bg-orange-500 shrink-0" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-sm font-semibold",
            showDesignView && "bg-muted"
          )}
          onClick={() => setShowDesignView(!showDesignView)}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Palette className="size-3" />
          </div>
          <span className="text-muted-foreground">design</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-sm font-semibold",
            showKanbanView && "bg-muted"
          )}
          onClick={() => setShowKanbanView(!showKanbanView)}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <LayoutDashboard className="size-3" />
          </div>
          <span className="text-muted-foreground">看板视图</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 text-sm font-semibold",
            showClaudeCodeView && "bg-muted"
          )}
          onClick={() => setShowClaudeCodeView(!showClaudeCodeView)}
        >
          <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
            <Terminal className="size-3" />
          </div>
          <span className="text-muted-foreground">Code</span>
        </Button>
        {dashboardAllowed && (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full justify-start gap-2 text-sm font-semibold",
              showDashboardView && "bg-muted"
            )}
            onClick={() => setShowDashboardView(!showDashboardView)}
          >
            <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
              <BarChart3 className="size-3" />
            </div>
            <span className="text-muted-foreground">运营面板</span>
          </Button>
        )}
        {robots.length > 0 && (
          <div className="relative" ref={robotPickerRef}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-sm font-semibold"
              onClick={() => setShowRobotPicker(!showRobotPicker)}
            >
              <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
                <Cpu className="size-3" />
              </div>
              <span className="text-muted-foreground">机器人</span>
            </Button>
            {showRobotPicker && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover p-1 shadow-md">
                {robots.map((robot, i) => (
                  <button
                    key={i}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted transition-colors"
                    onClick={() => handleNewRobotThread(robot)}
                  >
                    <Cpu className="size-3 shrink-0 text-blue-400" />
                    <span className="truncate">{robot.chatId || `机器人 ${i + 1}`}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">工作区 {threadProjects.length}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="cursor-pointer size-6 shrink-0"
          title={allProjectsCollapsed ? "全部展开工作区" : "全部收起工作区"}
          onClick={toggleAllProjects}
          disabled={threadProjects.length === 0}
        >
          {allProjectsCollapsed ? (
            <Maximize2 className="size-3.5" />
          ) : (
            <Minimize2 className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="  cursor-pointer size-6 shrink-0 "
          title="新增工作区"
          onClick={handleAddProject}
          disabled={selectingProjectFolder}
        >
          {selectingProjectFolder ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FolderPlus className="size-3.5" />
          )}
        </Button>
      </div>

      {/* Thread List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-2 pb-2 space-y-1 overflow-hidden">
          {threadProjects.map((project) => {
            const isCollapsed = collapsedProjectKeys.has(project.key)
            const hasSelectedThread = project.threads.some(
              (thread) => thread.thread_id === currentThreadId
            )
            const unreadCount = project.threads.filter((thread) =>
              unreadIds.has(thread.thread_id)
            ).length
            const hasRunningThread = project.threads.some((thread) => {
              const threadState = allThreadStates[thread.thread_id]
              return (
                (allStreamLoadingStates[thread.thread_id] ?? false) ||
                Boolean(threadState?.scheduledTaskLoading)
              )
            })

            return (
              <div key={project.key} className="space-y-1">
                <Popover open={hoveredProjectKey === project.key}>
                  <PopoverTrigger asChild>
                    <div
                      className={cn(
                        "group flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left transition-colors",
                        hasSelectedThread
                          ? "bg-sidebar-accent/70 text-sidebar-accent-foreground"
                          : "hover:bg-sidebar-accent/40"
                      )}
                      onMouseEnter={() => setHoveredProjectKey(project.key)}
                      onMouseLeave={() => setHoveredProjectKey(null)}
                      onFocus={() => setHoveredProjectKey(project.key)}
                      onBlur={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setHoveredProjectKey(null)
                        }
                      }}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => toggleProject(project.key)}
                      >
                        {isCollapsed ? (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          {project.name}
                        </span>
                      </button>
                      {unreadCount > 0 && (
                        <span className="size-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                      <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
                        <span className="absolute right-1 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                          {project.threads.length}
                        </span>
                        <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="cursor-pointer size-6 shrink-0 opacity-70 hover:bg-accent/20"
                            title="新增任务"
                            onClick={() => handleNewProjectThread(project)}
                          >
                            <Plus className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(
                              "cursor-pointer size-6 shrink-0 opacity-70 hover:bg-destructive/10 hover:text-destructive",
                              hasRunningThread && "cursor-not-allowed !opacity-30"
                            )}
                            title={
                              hasRunningThread
                                ? "工作区内有运行中的任务，无法删除"
                                : "删除工作区会话"
                            }
                            disabled={hasRunningThread}
                            onClick={(e) => {
                              e.stopPropagation()
                              setProjectToDelete(project)
                            }}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </span>
                      </span>
                    </div>
                  </PopoverTrigger>
                  <PopoverContent
                    side="right"
                    align="start"
                    className="w-72 p-2 text-xs"
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    onMouseEnter={() => setHoveredProjectKey(project.key)}
                    onMouseLeave={() => setHoveredProjectKey(null)}
                  >
                    <div className="mb-1 font-medium text-muted-foreground">工作区路径</div>
                    <div className="break-all text-foreground">
                      {project.path || "未关联工作区"}
                    </div>
                  </PopoverContent>
                </Popover>

                {!isCollapsed && (
                  <div className="ml-4 space-y-1 border-l border-border/70 pl-2">
                    {project.threads.map((thread) => {
                      const threadState = allThreadStates[thread.thread_id]
                      const isLoading = allStreamLoadingStates[thread.thread_id] ?? false
                      const scheduledTaskLoading = Boolean(threadState?.scheduledTaskLoading)
                      const hasPendingApproval = Boolean(threadState?.pendingApproval)

                      return (
                        <ThreadListItem
                          key={thread.thread_id}
                          thread={thread}
                          isLoading={isLoading}
                          hasPendingApproval={hasPendingApproval}
                          scheduledTaskLoading={scheduledTaskLoading}
                          isExporting={exportingThreadId === thread.thread_id}
                          isSelected={currentThreadId === thread.thread_id}
                          isEditing={editingThreadId === thread.thread_id}
                          isUnread={unreadIds.has(thread.thread_id)}
                          editingTitle={editingTitle}
                          onSelect={() => {
                            selectThread(thread.thread_id)
                            markRead(thread.thread_id)
                          }}
                          onRunFinished={() => handleRunFinished(thread.thread_id)}
                          onDelete={() => setThreadToDelete(thread)}
                          onExport={() => handleExportThread(thread)}
                          onStartEditing={() => startEditing(thread.thread_id, thread.title || "")}
                          onSaveTitle={saveTitle}
                          onCancelEditing={cancelEditing}
                          onEditingTitleChange={setEditingTitle}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {threads.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无任务</div>
          )}
        </div>
      </ScrollArea>

      <div className="px-3 py-2.5 flex items-center justify-center gap-1.5 select-none">
        <svg className="size-5 shrink-0" viewBox="0 0 120 120" fill="none">
          <defs>
            <linearGradient id="sidebar-lobster" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ff4d4d" />
              <stop offset="100%" stopColor="#991b1b" />
            </linearGradient>
          </defs>
          <path
            d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
            fill="url(#sidebar-lobster)"
          />
          <path
            d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
            fill="url(#sidebar-lobster)"
          />
          <path
            d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
            fill="url(#sidebar-lobster)"
          />
          <circle cx="45" cy="35" r="6" fill="#050810" />
          <circle cx="75" cy="35" r="6" fill="#050810" />
          <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
          <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
        </svg>
        <div className="flex items-baseline">
          <span
            className="text-[14px] text-foreground/70"
            style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
          >
            CMBDev
          </span>
          <span
            className="text-[14px] text-red-500/80"
            style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
          >
            Claw
          </span>
          <span className="text-[9px] text-foreground/25 ml-1 tabular-nums">
            {version || __APP_VERSION__}
          </span>
          <UpdateActionButton variant="tag" className="ml-1" />
        </div>
      </div>
      <Dialog open={!!threadToDelete} onOpenChange={(open) => !open && setThreadToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认删除会话</DialogTitle>
            <DialogDescription>
              {`确定要删除「${threadToDelete ? getDisplayThreadTitle(threadToDelete) : ""}」吗？删除后不可恢复。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setThreadToDelete(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDeleteThread}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!projectToDelete} onOpenChange={(open) => !open && setProjectToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认删除工作区会话</DialogTitle>
            <DialogDescription>
              {projectToDelete
                ? `确定要删除「${projectToDelete.name}」工作区下的全部 ${projectToDelete.threads.length} 个会话吗？删除后不可恢复。`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectToDelete(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDeleteProject}>
              删除全部
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
