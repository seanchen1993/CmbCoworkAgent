import { useState, useCallback, useEffect, useMemo, useRef, memo } from "react"
import {
  Plus,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  Loader2,
  AlertCircle,
  Briefcase,
  LayoutDashboard,
  Cpu,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minimize2,
  FolderPlus,
  Download,
  GitFork,
  HeartPulse
} from "lucide-react"
import { toast } from "sonner"
import type { ChatXRobotConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
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
import { isHarnessFeatureThread, isHarnessProjectModeThread } from "@/lib/thread-classification"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { WorkspaceRenameDialog } from "./WorkspaceRenameDialog"
import type { ForkableCheckpoint, Thread, ThreadForkOverrides } from "@/types"

const NO_WORKSPACE_PROJECT_KEY = "__no_workspace__"
const COLLAPSED_PROJECTS_STORAGE_KEY = "threads:collapsedProjects"
const PINNED_PROJECTS_STORAGE_KEY = "threads:pinnedProjects"
const PROJECT_NAME_OVERRIDES_STORAGE_KEY = "threads:projectNameOverrides"
/** 工作区展开时默认可见的 thread 条数;点"展开显示"每次追加的条数。 */
const DEFAULT_VISIBLE_THREADS = 5
const VISIBLE_THREADS_STEP = 10
type ForkDestinationMode = "local" | "workspace"

interface ThreadProject {
  key: string
  name: string
  defaultName: string
  path: string | null
  threads: Thread[]
  isPinned: boolean
  hasCustomName: boolean
  sortIndex: number
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

function readStoredStringSet(key: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]")
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === "string"))
  } catch {
    return new Set()
  }
}

function readStoredStringRecord(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0
      )
    )
  } catch {
    return {}
  }
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

function formatCheckpointTime(value?: string): string {
  if (!value) return "未知时间"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "未知时间"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date)
}

function getForkUnstableReasonLabel(reason?: ForkableCheckpoint["unstableReason"]): string {
  switch (reason) {
    case "interrupt":
      return "中断中"
    case "pending_approval":
      return "等待审批"
    case "pending_writes":
      return "写入未完成"
    case "in_progress_turn":
      return "运行中"
    case "missing_boundary_marker":
      return "非完成边界"
    default:
      return "不可 fork"
  }
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

function getProjectDisplayName(
  path: string | null,
  projectNameOverrides: Record<string, string>
): { defaultName: string; name: string; hasCustomName: boolean } {
  const defaultName = getWorkspaceName(path)
  const customName = path ? projectNameOverrides[path]?.trim() : ""

  if (!customName) {
    return {
      defaultName,
      name: defaultName,
      hasCustomName: false
    }
  }

  return {
    defaultName,
    name: customName,
    hasCustomName: customName !== defaultName
  }
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

function ThreadListItemImpl({
  thread,
  isLoading,
  hasPendingApproval,
  hasPendingUserInput,
  hasContextReminder,
  scheduledTaskLoading,
  isSelected,
  isEditing,
  isUnread,
  editingTitle,
  onSelect,
  onDelete,
  onExport,
  onFork,
  onForkFromCheckpoint,
  onRunFinished,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange,
  isExporting,
  isForking = false,
  hoverTitle
}: {
  thread: Thread
  isLoading: boolean
  hasPendingApproval: boolean
  hasPendingUserInput: boolean
  hasContextReminder: boolean
  scheduledTaskLoading: boolean
  isExporting: boolean
  isForking?: boolean
  isSelected: boolean
  isEditing: boolean
  isUnread: boolean
  editingTitle: string
  onSelect: () => void
  onDelete: () => void
  onExport: () => void
  onFork?: () => void
  onForkFromCheckpoint?: () => void
  onRunFinished: () => void
  onStartEditing: () => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
  hoverTitle?: string
}): React.JSX.Element {
  const isRunning = isLoading || scheduledTaskLoading
  const forkDisabled = isRunning || hasPendingApproval || hasPendingUserInput || isForking
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
  const pendingUserInputBadge = hasPendingUserInput ? (
    <span className="ml-1 shrink-0 rounded-sm border border-status-warning/45 bg-status-warning/10 px-1.5 py-0.5 text-[10px] leading-none text-status-warning">
      等待用户回复
    </span>
  ) : null

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
                title={hoverTitle ?? thread.title ?? thread.thread_id}
              >
                {thread.title?.startsWith("[定时]") ? (
                  <>
                    <span className="shrink-0 text-[10px] px-1 py-px rounded bg-primary/15 text-primary font-medium">
                      定时
                    </span>
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                ) : thread.title?.startsWith("[Heartbeat]") ? (
                  <>
                    <HeartPulse className="mr-1 size-3 shrink-0 text-red-400" />
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                )}
              </div>
            )}
          </div>
          {hasContextReminder && !isRunning ? (
            <span className="size-2 rounded-full bg-status-warning shrink-0" />
          ) : (
            isUnread && !isRunning && <span className="size-2 rounded-full bg-blue-500 shrink-0" />
          )}
          <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
            <span className="absolute right-0 text-[10px] text-muted-foreground transition-opacity group-hover:opacity-0">
              {formatCompactTime(thread.updated_at)}
            </span>
            <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
              <IconPopoverButton
                icon={<Pencil className="size-3" />}
                popoverContent="重命名会话"
                stopPropagation
                className="size-6 rounded-sm p-0 hover:bg-accent/20"
                onClick={onStartEditing}
              />
              <IconPopoverButton
                icon={<Trash2 className="size-3" />}
                popoverContent={isRunning ? "任务运行中，无法删除" : "删除会话"}
                disabled={isRunning}
                stopPropagation
                className={cn(
                  "size-6 rounded-sm p-0 hover:bg-accent/20",
                  isRunning && "cursor-not-allowed !opacity-30"
                )}
                onClick={onDelete}
              />
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
        {onFork ? (
          <ContextMenuItem onClick={onFork} disabled={forkDisabled}>
            {isForking ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <GitFork className="size-4 mr-2" />
            )}
            {isForking ? "正在 fork" : forkDisabled ? "当前状态无法 fork" : "Fork 当前会话"}
          </ContextMenuItem>
        ) : null}
        {onForkFromCheckpoint ? (
          <ContextMenuItem onClick={onForkFromCheckpoint} disabled={forkDisabled}>
            {isForking ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <GitFork className="size-4 mr-2" />
            )}
            从 checkpoint fork
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete} disabled={isRunning}>
          <Trash2 className="size-4 mr-2" />
          {isRunning ? "运行中，无法删除" : "删除"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

type ThreadListItemProps = Parameters<typeof ThreadListItemImpl>[0]

// Re-render a row only when its own rendered data changes. Callback props are
// intentionally excluded from the comparison: the parent recreates them on every
// render, but each row's closures always act on its own thread, so their identity
// is irrelevant. Without this, a single thread's state tick (loading / approval /
// unread / …) in allThreadStates re-rendered EVERY row in the list.
function areThreadListItemPropsEqual(
  prev: ThreadListItemProps,
  next: ThreadListItemProps
): boolean {
  if (
    prev.thread !== next.thread ||
    prev.isLoading !== next.isLoading ||
    prev.hasPendingApproval !== next.hasPendingApproval ||
    prev.hasPendingUserInput !== next.hasPendingUserInput ||
    prev.hasContextReminder !== next.hasContextReminder ||
    prev.scheduledTaskLoading !== next.scheduledTaskLoading ||
    prev.isExporting !== next.isExporting ||
    prev.isForking !== next.isForking ||
    prev.isSelected !== next.isSelected ||
    prev.isEditing !== next.isEditing ||
    prev.isUnread !== next.isUnread ||
    Boolean(prev.onForkFromCheckpoint) !== Boolean(next.onForkFromCheckpoint) ||
    prev.hoverTitle !== next.hoverTitle
  ) {
    return false
  }
  // editingTitle only affects the row currently being edited.
  if (next.isEditing && prev.editingTitle !== next.editingTitle) return false
  return true
}

export const ThreadListItem = memo(ThreadListItemImpl, areThreadListItemPropsEqual)

export function ThreadSidebar(): React.JSX.Element {
  const {
    threads,
    currentThreadId,
    createThread,
    forkThread,
    listForkableCheckpoints,
    selectThread,
    deleteThread,
    updateThread,
    mainView,
    pendingEvolution,
    showCustomizeView,
    setShowCustomizeView,
    showKanbanView,
    setShowKanbanView,
    showDashboardView,
    setShowDashboardView,
    dashboardAllowed
  } = useAppStore()

  const { cleanupThread } = useThreadContext()
  const allThreadStates = useAllThreadStates()
  const allStreamLoadingStates = useAllStreamLoadingStates()

  // FIX: 发送消息后侧边栏线程时间不更新。
  // 当线程开始或结束流式加载时，更新本地 updated_at，确保侧边栏时间立即刷新
  const streamChangeRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const prev = streamChangeRef.current
    const now = new Date()
    let changed = false
    // 检查当前所有线程的加载状态变化
    for (const threadId of Object.keys(allStreamLoadingStates)) {
      const wasLoading = prev[threadId] === true
      const isLoading = allStreamLoadingStates[threadId] === true
      if (isLoading !== wasLoading) {
        changed = true
        break
      }
    }
    // 检查是否有线程从加载状态中移除（流式结束）
    if (!changed) {
      for (const threadId of Object.keys(prev)) {
        if (!(threadId in allStreamLoadingStates)) {
          changed = true
          break
        }
      }
    }
    if (changed) {
      // 收集所有受影响的 thread ID（当前 + 之前但已移除的）
      const affectedIds = new Set([...Object.keys(allStreamLoadingStates), ...Object.keys(prev)])
      useAppStore.setState((state) => ({
        threads: state.threads.map((t) =>
          affectedIds.has(t.thread_id) ? { ...t, updated_at: now } : t
        )
      }))
    }
    streamChangeRef.current = { ...allStreamLoadingStates }
  }, [allStreamLoadingStates])

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
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() =>
    readStoredStringSet("threads:unreadIds")
  )
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(() =>
    readStoredStringSet(COLLAPSED_PROJECTS_STORAGE_KEY)
  )
  // 每个工作区当前可见的 thread 条数(无记录 = 默认 5)。会话级状态:
  // 折叠工作区时清除,重新展开回到默认 5 条;不落盘。
  const [visibleThreadCounts, setVisibleThreadCounts] = useState<Record<string, number>>({})
  const [pinnedProjectKeys, setPinnedProjectKeys] = useState<Set<string>>(() =>
    readStoredStringSet(PINNED_PROJECTS_STORAGE_KEY)
  )
  const [projectNameOverrides, setProjectNameOverrides] = useState<Record<string, string>>(() =>
    readStoredStringRecord(PROJECT_NAME_OVERRIDES_STORAGE_KEY)
  )
  const [hoveredProjectKey, setHoveredProjectKey] = useState<string | null>(null)
  const [selectingProjectFolder, setSelectingProjectFolder] = useState(false)
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(null)
  const [forkingThreadId, setForkingThreadId] = useState<string | null>(null)
  const [forkDialogThread, setForkDialogThread] = useState<Thread | null>(null)
  const [forkCheckpoints, setForkCheckpoints] = useState<ForkableCheckpoint[]>([])
  const [selectedForkCheckpoint, setSelectedForkCheckpoint] = useState<ForkableCheckpoint | null>(
    null
  )
  const [forkDestinationMode, setForkDestinationMode] = useState<ForkDestinationMode>("local")
  const [forkWorkspacePath, setForkWorkspacePath] = useState<string | null>(null)
  const [selectingForkWorkspace, setSelectingForkWorkspace] = useState(false)
  const [loadingForkCheckpoints, setLoadingForkCheckpoints] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<ThreadProject | null>(null)
  const [projectToRename, setProjectToRename] = useState<ThreadProject | null>(null)
  const exportingThreadIdRef = useRef<string | null>(null)
  const forkingThreadIdRef = useRef<string | null>(null)
  const forkCheckpointRequestRef = useRef(0)

  const persistUnread = useCallback((ids: Set<string>) => {
    localStorage.setItem("threads:unreadIds", JSON.stringify([...ids]))
  }, [])

  const persistCollapsedProjects = useCallback((keys: Set<string>) => {
    localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...keys]))
  }, [])

  const persistPinnedProjects = useCallback((keys: Set<string>) => {
    localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify([...keys]))
  }, [])

  const persistProjectNameOverrides = useCallback((names: Record<string, string>) => {
    localStorage.setItem(PROJECT_NAME_OVERRIDES_STORAGE_KEY, JSON.stringify(names))
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
    let sortIndex = 0

    for (const thread of threads.filter((item) => !isHarnessProjectModeThread(item))) {
      const path = getThreadWorkspacePath(thread, allThreadStates[thread.thread_id]?.workspacePath)
      const key = path || NO_WORKSPACE_PROJECT_KEY
      const existing = projectMap.get(key)

      if (existing) {
        existing.threads.push(thread)
      } else {
        const { defaultName, name, hasCustomName } = getProjectDisplayName(
          path,
          projectNameOverrides
        )
        projectMap.set(key, {
          key,
          name,
          defaultName,
          path,
          threads: [thread],
          isPinned: pinnedProjectKeys.has(key),
          hasCustomName,
          sortIndex: sortIndex++
        })
      }
    }

    return Array.from(projectMap.values()).sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
      return a.sortIndex - b.sortIndex
    })
  }, [allThreadStates, pinnedProjectKeys, projectNameOverrides, threads])

  const currentThreadWorkspacePath = useMemo(() => {
    if (!currentThreadId) return null

    const currentThread = threads.find((thread) => thread.thread_id === currentThreadId)
    if (!currentThread || isHarnessFeatureThread(currentThread)) return null

    return getThreadWorkspacePath(currentThread, allThreadStates[currentThreadId]?.workspacePath)
  }, [allThreadStates, currentThreadId, threads])

  const toggleProject = useCallback(
    (projectKey: string) => {
      setCollapsedProjectKeys((prev) => {
        const next = new Set(prev)
        if (next.has(projectKey)) {
          next.delete(projectKey)
        } else {
          next.add(projectKey)
          // 折叠即丢弃展开进度,下次展开回到默认 5 条。
          setVisibleThreadCounts((counts) => {
            if (!(projectKey in counts)) return counts
            const nextCounts = { ...counts }
            delete nextCounts[projectKey]
            return nextCounts
          })
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

  const toggleProjectPin = useCallback(
    (projectKey: string) => {
      setPinnedProjectKeys((prev) => {
        const next = new Set(prev)
        if (next.has(projectKey)) {
          next.delete(projectKey)
        } else {
          next.add(projectKey)
        }
        persistPinnedProjects(next)
        return next
      })
    },
    [persistPinnedProjects]
  )

  const closeProjectRenameDialog = useCallback(() => {
    setProjectToRename(null)
  }, [])

  const openProjectRenameDialog = useCallback((project: ThreadProject) => {
    if (!project.path) return
    setProjectToRename(project)
  }, [])

  const saveProjectName = useCallback(
    (path: string, nextName: string | null) => {
      setProjectNameOverrides((prev) => {
        const next = { ...prev }
        if (!nextName) {
          delete next[path]
        } else {
          next[path] = nextName
        }
        persistProjectNameOverrides(next)
        return next
      })
    },
    [persistProjectNameOverrides]
  )

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
    const metadata: Record<string, unknown> = {
      title: `Thread ${new Date().toLocaleDateString()}`
    }

    // When the user creates a new task from an existing thread, keep it in the
    // same workspace instead of falling back to the last globally selected one.
    if (currentThreadWorkspacePath) {
      metadata.workspacePath = currentThreadWorkspacePath
    }

    await createThread(metadata)
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

  const confirmDeleteThread = useCallback(async () => {
    if (!threadToDelete) return

    try {
      await deleteThread(threadToDelete.thread_id)
      cleanupThread(threadToDelete.thread_id)
      markRead(threadToDelete.thread_id)
      setThreadToDelete(null)
    } catch (error) {
      console.error("[ThreadSidebar] Failed to delete thread:", error)
    }
  }, [cleanupThread, deleteThread, markRead, threadToDelete])

  const handleExportThread = useCallback(async (thread: Thread): Promise<void> => {
    if (exportingThreadIdRef.current) return
    exportingThreadIdRef.current = thread.thread_id
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
      if (exportingThreadIdRef.current === thread.thread_id) {
        exportingThreadIdRef.current = null
        setExportingThreadId(null)
      }
    }
  }, [])

  const handleForkThread = useCallback(
    async (thread: Thread): Promise<void> => {
      if (forkingThreadIdRef.current) return
      forkingThreadIdRef.current = thread.thread_id
      setForkingThreadId(thread.thread_id)
      try {
        const forked = await forkThread({ sourceThreadId: thread.thread_id })
        markRead(forked.thread_id)
        toast.success("已从当前 checkpoint 创建新会话")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Fork 会话失败")
      } finally {
        if (forkingThreadIdRef.current === thread.thread_id) {
          forkingThreadIdRef.current = null
          setForkingThreadId(null)
        }
      }
    },
    [forkThread, markRead]
  )

  const openForkCheckpointDialog = useCallback(
    async (thread: Thread): Promise<void> => {
      const requestId = forkCheckpointRequestRef.current + 1
      forkCheckpointRequestRef.current = requestId
      setForkDialogThread(thread)
      setForkCheckpoints([])
      setSelectedForkCheckpoint(null)
      setForkDestinationMode("local")
      setForkWorkspacePath(null)
      setSelectingForkWorkspace(false)
      setLoadingForkCheckpoints(true)
      try {
        const checkpoints = await listForkableCheckpoints(thread.thread_id)
        if (forkCheckpointRequestRef.current !== requestId) return
        setForkCheckpoints(checkpoints)
        setSelectedForkCheckpoint(
          checkpoints.find((checkpoint) => checkpoint.isStableTurnBoundary) ?? null
        )
      } catch (error) {
        if (forkCheckpointRequestRef.current !== requestId) return
        toast.error(error instanceof Error ? error.message : "读取 checkpoint 失败")
      } finally {
        if (forkCheckpointRequestRef.current === requestId) {
          setLoadingForkCheckpoints(false)
        }
      }
    },
    [listForkableCheckpoints]
  )

  const handleSelectForkWorkspace = useCallback(async (): Promise<string | null> => {
    if (selectingForkWorkspace) return forkWorkspacePath
    setSelectingForkWorkspace(true)
    try {
      const path = await window.api.workspace.select()
      if (path) {
        setForkDestinationMode("workspace")
        setForkWorkspacePath(path)
      }
      return path
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择工作区失败")
      return null
    } finally {
      setSelectingForkWorkspace(false)
    }
  }, [forkWorkspacePath, selectingForkWorkspace])

  const resetForkCheckpointDialog = useCallback((): void => {
    forkCheckpointRequestRef.current += 1
    setForkDialogThread(null)
    setForkCheckpoints([])
    setSelectedForkCheckpoint(null)
    setForkDestinationMode("local")
    setForkWorkspacePath(null)
    setSelectingForkWorkspace(false)
    setLoadingForkCheckpoints(false)
  }, [])

  const handleForkCheckpoint = useCallback(async (): Promise<void> => {
    if (
      !forkDialogThread ||
      !selectedForkCheckpoint ||
      forkingThreadIdRef.current ||
      !selectedForkCheckpoint.isStableTurnBoundary
    ) {
      return
    }

    let selectedWorkspacePath = forkWorkspacePath
    if (forkDestinationMode === "workspace" && !selectedWorkspacePath) {
      selectedWorkspacePath = await handleSelectForkWorkspace()
      if (!selectedWorkspacePath) return
    }

    const overrides: ThreadForkOverrides | undefined =
      forkDestinationMode === "workspace" ? { workspacePath: selectedWorkspacePath } : undefined

    const sourceThreadId = forkDialogThread.thread_id
    forkingThreadIdRef.current = sourceThreadId
    setForkingThreadId(sourceThreadId)
    try {
      const forked = await forkThread({
        sourceThreadId,
        checkpointId: selectedForkCheckpoint.checkpointId,
        overrides
      })
      markRead(forked.thread_id)
      resetForkCheckpointDialog()
      toast.success("已从历史 checkpoint 创建新会话")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fork 会话失败")
    } finally {
      if (forkingThreadIdRef.current === sourceThreadId) {
        forkingThreadIdRef.current = null
        setForkingThreadId(null)
      }
    }
  }, [
    forkDestinationMode,
    forkThread,
    forkWorkspacePath,
    forkDialogThread,
    handleSelectForkWorkspace,
    markRead,
    resetForkCheckpointDialog,
    selectedForkCheckpoint
  ])

  const confirmDeleteProject = useCallback(async () => {
    if (!projectToDelete) return

    for (const thread of projectToDelete.threads) {
      await deleteThread(thread.thread_id)
      cleanupThread(thread.thread_id)
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

  const isForkDialogForking = forkDialogThread
    ? forkingThreadId === forkDialogThread.thread_id
    : false
  const forkDialogBusy = isForkDialogForking || selectingForkWorkspace
  const forkDialogCurrentWorkspacePath = forkDialogThread
    ? getThreadWorkspacePath(forkDialogThread)
    : null

  return (
    <aside className="flex h-full w-full flex-col border-r border-border bg-sidebar overflow-hidden">
      {/* New Thread Button - with dynamic safe area padding when zoomed out */}
      <div
        className="p-1 space-y-1.5"
        style={{ paddingTop: "calc(8px + var(--sidebar-safe-padding, 0px))" }}
      >
        <>
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
            onClick={() => {
              setShowCustomizeView(true, pendingEvolution ? "evolution" : undefined)
            }}
          >
            <div
              className={cn(
                "flex size-5 items-center justify-center rounded-full ring-1 transition-colors",
                mainView === "customize"
                  ? "bg-amber-500/20 ring-amber-500/25 text-amber-700 dark:bg-amber-400/20 dark:ring-amber-400/30 dark:text-amber-200"
                  : "bg-amber-500/12 ring-amber-500/20 text-amber-700 dark:bg-amber-400/15 dark:ring-amber-400/20 dark:text-amber-300"
              )}
            >
              <Briefcase className="size-3" />
            </div>
            <span
              className={cn(
                "flex-1 text-left",
                mainView === "customize" ? "text-foreground" : "text-muted-foreground"
              )}
            >
              自定义
            </span>
            {pendingEvolution && <span className="size-2 rounded-full bg-orange-500 shrink-0" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "w-full justify-start gap-2 text-sm font-semibold",
              showKanbanView && "bg-muted"
            )}
            onClick={() => {
              setShowKanbanView(!showKanbanView)
            }}
          >
            <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
              <LayoutDashboard className="size-3" />
            </div>
            <span className="text-muted-foreground">看板视图</span>
          </Button>
          {dashboardAllowed && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "w-full justify-start gap-2 text-sm font-semibold",
                showDashboardView && "bg-muted"
              )}
              onClick={() => {
                setShowDashboardView(!showDashboardView)
              }}
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
        </>
      </div>

      <>
        <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">工作区 {threadProjects.length}</span>
          <IconPopoverButton
            icon={
              allProjectsCollapsed ? (
                <Maximize2 className="size-3.5" />
              ) : (
                <Minimize2 className="size-3.5" />
              )
            }
            popoverContent={
              threadProjects.length === 0
                ? "暂无工作区"
                : allProjectsCollapsed
                  ? "全部展开工作区"
                  : "全部收起工作区"
            }
            disabled={threadProjects.length === 0}
            className="size-6 shrink-0 rounded-sm p-0"
            onClick={toggleAllProjects}
          />
          <IconPopoverButton
            icon={
              selectingProjectFolder ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FolderPlus className="size-3.5" />
              )
            }
            popoverContent={selectingProjectFolder ? "正在选择工作区" : "新增工作区"}
            disabled={selectingProjectFolder}
            className="size-6 shrink-0 rounded-sm p-0"
            onClick={handleAddProject}
          />
        </div>

        {/* Thread List */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-2 pb-2 space-y-1 overflow-hidden">
            {threadProjects.map((project) => {
              const isCollapsed = collapsedProjectKeys.has(project.key)
              const canCustomizeProject = Boolean(project.path)
              const hasSelectedThread = project.threads.some(
                (thread) => thread.thread_id === currentThreadId
              )
              // 折叠切片的有效条数:默认 5 / 用户点"展开显示"追加。但当前选中的
              // thread 必须始终可见——若它排在可见范围之外(如重启恢复上次会话时
              // 排到第 6+ 位),把切片扩展到刚好包含它,避免选中项被截断藏掉。
              const requestedVisibleThreads =
                visibleThreadCounts[project.key] ?? DEFAULT_VISIBLE_THREADS
              const selectedThreadIndex = currentThreadId
                ? project.threads.findIndex((thread) => thread.thread_id === currentThreadId)
                : -1
              const visibleThreadCount =
                selectedThreadIndex >= 0
                  ? Math.max(requestedVisibleThreads, selectedThreadIndex + 1)
                  : requestedVisibleThreads
              const unreadCount = project.threads.filter((thread) =>
                unreadIds.has(thread.thread_id)
              ).length
              const hasContextReminderThread = project.threads.some((thread) =>
                Boolean(allThreadStates[thread.thread_id]?.contextReminder?.pending)
              )
              const hasRunningThread = project.threads.some((thread) => {
                const threadState = allThreadStates[thread.thread_id]
                return (
                  (allStreamLoadingStates[thread.thread_id] ?? false) ||
                  Boolean(
                    threadState?.coordinatorWorkers.some((worker) => worker.status === "running")
                  ) ||
                  Boolean(threadState?.scheduledTaskLoading) ||
                  threadState?.workflowRun?.status === "running"
                )
              })

              return (
                <div key={project.key} className="space-y-1">
                  <ContextMenu>
                    <Popover open={hoveredProjectKey === project.key}>
                      <PopoverTrigger asChild>
                        <ContextMenuTrigger asChild>
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
                              {project.isPinned ? (
                                <Pin className="size-4 shrink-0 text-primary" aria-hidden="true" />
                              ) : (
                                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1 truncate text-xs font-medium duration-150">
                                {project.name}
                              </span>
                            </button>
                            {hasContextReminderThread ? (
                              <span className="size-2 rounded-full bg-status-warning shrink-0" />
                            ) : (
                              unreadCount > 0 && (
                                <span className="size-2 rounded-full bg-blue-500 shrink-0" />
                              )
                            )}
                            <span className="relative flex h-6 w-4 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150 group-hover:w-28 group-focus-within:w-28">
                              <span className="absolute right-1 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                                {project.threads.length}
                              </span>
                              <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                <IconPopoverButton
                                  icon={
                                    project.isPinned ? (
                                      <PinOff className="size-3" />
                                    ) : (
                                      <Pin className="size-3" />
                                    )
                                  }
                                  popoverContent={
                                    project.isPinned ? "取消置顶工作区" : "置顶工作区"
                                  }
                                  disabled={!canCustomizeProject}
                                  stopPropagation
                                  className={cn(
                                    "size-6 shrink-0 rounded-sm p-0 opacity-70 hover:bg-accent/20",
                                    project.isPinned && "text-primary opacity-100",
                                    !canCustomizeProject && "cursor-not-allowed !opacity-30"
                                  )}
                                  onClick={() => toggleProjectPin(project.key)}
                                />
                                <IconPopoverButton
                                  icon={<Pencil className="size-3" />}
                                  popoverContent={
                                    canCustomizeProject
                                      ? "修改工作区名称"
                                      : "未关联工作区无法重命名"
                                  }
                                  disabled={!canCustomizeProject}
                                  stopPropagation
                                  className={cn(
                                    "size-6 shrink-0 rounded-sm p-0 opacity-70 hover:bg-accent/20",
                                    !canCustomizeProject && "cursor-not-allowed !opacity-30"
                                  )}
                                  onClick={() => openProjectRenameDialog(project)}
                                />
                                <IconPopoverButton
                                  icon={<Plus className="size-3" />}
                                  popoverContent="新增任务"
                                  stopPropagation
                                  className="size-6 shrink-0 rounded-sm p-0 opacity-70 hover:bg-accent/20"
                                  onClick={() => void handleNewProjectThread(project)}
                                />
                                <IconPopoverButton
                                  icon={<Trash2 className="size-3" />}
                                  popoverContent={
                                    hasRunningThread
                                      ? "工作区内有运行中的任务，无法删除"
                                      : "删除工作区会话"
                                  }
                                  disabled={hasRunningThread}
                                  stopPropagation
                                  className={cn(
                                    "size-6 shrink-0 rounded-sm p-0 opacity-70 hover:bg-destructive/10 hover:text-destructive",
                                    hasRunningThread && "cursor-not-allowed !opacity-30"
                                  )}
                                  onClick={() => setProjectToDelete(project)}
                                />
                              </span>
                            </span>
                          </div>
                        </ContextMenuTrigger>
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
                    <ContextMenuContent>
                      <ContextMenuItem
                        disabled={!canCustomizeProject}
                        onClick={() => toggleProjectPin(project.key)}
                      >
                        {project.isPinned ? (
                          <PinOff className="size-4 mr-2" />
                        ) : (
                          <Pin className="size-4 mr-2" />
                        )}
                        {project.isPinned ? "取消置顶工作区" : "置顶工作区"}
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!canCustomizeProject}
                        onClick={() => openProjectRenameDialog(project)}
                      >
                        <Pencil className="size-4 mr-2" />
                        修改工作区名称
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void handleNewProjectThread(project)}>
                        <Plus className="size-4 mr-2" />
                        新增任务
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setProjectToDelete(project)}
                        disabled={hasRunningThread}
                      >
                        <Trash2 className="size-4 mr-2" />
                        {hasRunningThread ? "运行中，无法删除工作区" : "删除工作区会话"}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>

                  {!isCollapsed && (
                    <div className="ml-4 space-y-1 border-l border-border/70 pl-2">
                      {project.threads.slice(0, visibleThreadCount).map((thread) => {
                        const threadState = allThreadStates[thread.thread_id]
                        const hasRunningCoordinatorWorker = Boolean(
                          threadState?.coordinatorWorkers.some(
                            (worker) => worker.status === "running"
                          )
                        )
                        const isLoading =
                          (allStreamLoadingStates[thread.thread_id] ?? false) ||
                          hasRunningCoordinatorWorker ||
                          threadState?.workflowRun?.status === "running"
                        const scheduledTaskLoading = Boolean(threadState?.scheduledTaskLoading)
                        const hasPendingApproval = Boolean(threadState?.pendingApproval)
                        const hasPendingUserInput = Boolean(threadState?.pendingUserInput)
                        const hasContextReminder = Boolean(threadState?.contextReminder?.pending)

                        return (
                          <ThreadListItem
                            key={thread.thread_id}
                            thread={thread}
                            isLoading={isLoading}
                            hasPendingApproval={hasPendingApproval}
                            hasPendingUserInput={hasPendingUserInput}
                            hasContextReminder={hasContextReminder}
                            scheduledTaskLoading={scheduledTaskLoading}
                            isExporting={exportingThreadId === thread.thread_id}
                            isForking={forkingThreadId === thread.thread_id}
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
                            onFork={() => handleForkThread(thread)}
                            onForkFromCheckpoint={() => void openForkCheckpointDialog(thread)}
                            onStartEditing={() =>
                              startEditing(thread.thread_id, thread.title || "")
                            }
                            onSaveTitle={saveTitle}
                            onCancelEditing={cancelEditing}
                            onEditingTitleChange={setEditingTitle}
                          />
                        )
                      })}
                      {project.threads.length > visibleThreadCount && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground"
                          onClick={() =>
                            setVisibleThreadCounts((counts) => ({
                              ...counts,
                              // 基于当前实际可见条数追加,确保"选中项撑开切片"时点击仍能继续展开。
                              [project.key]: visibleThreadCount + VISIBLE_THREADS_STEP
                            }))
                          }
                        >
                          <ChevronDown className="size-3 shrink-0" />
                          展开显示
                          <span className="text-[10px] text-muted-foreground/60">
                            还有 {project.threads.length - visibleThreadCount} 条
                          </span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {threadProjects.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无任务</div>
            )}
          </div>
        </ScrollArea>
      </>

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
      <Dialog
        open={!!forkDialogThread}
        onOpenChange={(open) => {
          if (!open && !forkDialogBusy) resetForkCheckpointDialog()
        }}
      >
        <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base">从 checkpoint fork</DialogTitle>
            <DialogDescription className="truncate">
              {forkDialogThread ? getDisplayThreadTitle(forkDialogThread) : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-2 overflow-y-auto p-3">
            {loadingForkCheckpoints ? (
              <div className="flex h-28 items-center justify-center text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : forkCheckpoints.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                暂无可 fork 的 checkpoint
              </div>
            ) : (
              forkCheckpoints.map((checkpoint) => {
                const selected = selectedForkCheckpoint?.checkpointId === checkpoint.checkpointId
                const disabled = !checkpoint.isStableTurnBoundary || forkDialogBusy
                return (
                  <button
                    key={checkpoint.checkpointId}
                    type="button"
                    disabled={disabled}
                    className={cn(
                      "w-full rounded-sm border border-border px-3 py-2 text-left transition-colors",
                      disabled
                        ? "cursor-not-allowed bg-muted/30 opacity-60"
                        : selected
                          ? "border-primary bg-primary/10"
                          : "hover:border-primary/40 hover:bg-accent/60"
                    )}
                    onClick={() => setSelectedForkCheckpoint(checkpoint)}
                  >
                    <div className="mb-1 flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 text-muted-foreground">
                        {formatCheckpointTime(checkpoint.createdAt)}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {checkpoint.messageCount} 条消息
                      </span>
                      <span
                        className={cn(
                          "ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]",
                          checkpoint.isStableTurnBoundary
                            ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {checkpoint.isStableTurnBoundary
                          ? "可 fork"
                          : getForkUnstableReasonLabel(checkpoint.unstableReason)}
                      </span>
                    </div>
                    <div className="truncate text-sm text-foreground">
                      {checkpoint.lastMessagePreview || "无可见消息"}
                    </div>
                    {checkpoint.lastUserMessagePreview ? (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        用户：{checkpoint.lastUserMessagePreview}
                      </div>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
          <div className="space-y-3 border-t border-border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                disabled={forkDialogBusy}
                onClick={() => setForkDestinationMode("local")}
                className={cn(
                  "rounded-sm border px-3 py-2 text-left transition-colors",
                  forkDestinationMode === "local"
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-accent"
                )}
              >
                <div className="text-sm font-medium">派生到本地</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {getWorkspaceName(forkDialogCurrentWorkspacePath)}
                </div>
              </button>
              <button
                type="button"
                disabled={forkDialogBusy}
                onClick={() => setForkDestinationMode("workspace")}
                className={cn(
                  "rounded-sm border px-3 py-2 text-left transition-colors",
                  forkDestinationMode === "workspace"
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-accent"
                )}
              >
                <div className="text-sm font-medium">派生到其他工作区</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {forkWorkspacePath
                    ? getWorkspaceName(forkWorkspacePath)
                    : "选择一个本地工作区路径"}
                </div>
              </button>
            </div>
            {forkDestinationMode === "workspace" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={forkDialogBusy}
                onClick={() => void handleSelectForkWorkspace()}
                className="w-full justify-start"
              >
                {selectingForkWorkspace ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
                {forkWorkspacePath || "选择工作区文件夹"}
              </Button>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={forkDialogBusy}
                onClick={resetForkCheckpointDialog}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={!selectedForkCheckpoint || forkDialogBusy}
                onClick={() => void handleForkCheckpoint()}
              >
                {forkDialogBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GitFork className="size-4" />
                )}
                {forkDialogBusy
                  ? selectingForkWorkspace
                    ? "选择中"
                    : "正在 fork"
                  : forkDestinationMode === "workspace" && !forkWorkspacePath
                    ? "选择工作区并 Fork"
                    : "Fork"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
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
      <WorkspaceRenameDialog
        open={!!projectToRename}
        workspace={projectToRename}
        onOpenChange={(open) => {
          if (!open) closeProjectRenameDialog()
        }}
        onSubmit={saveProjectName}
      />
    </aside>
  )
}
