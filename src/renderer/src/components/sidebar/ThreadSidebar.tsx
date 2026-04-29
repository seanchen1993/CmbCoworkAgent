import { useState, useCallback, useEffect, useRef } from "react"
import { Plus, MessageSquare, Trash2, Pencil, Loader2, AlertCircle, Briefcase, HeartPulse, LayoutDashboard, Cpu, Radio, Terminal, BarChart3,Palette } from "lucide-react"
import type { ChatXRobotConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore } from "@/lib/store"
import { useAllStreamLoadingStates, useAllThreadStates, useThreadContext } from "@/lib/thread-context"
import { cn, formatRelativeTime, truncate } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import type { Thread } from "@/types"

// Thread status indicator that shows loading, interrupted, or default state
function ThreadStatusIcon({
  isLoading,
  pendingApproval,
  scheduledTaskLoading
}: {
  isLoading: boolean
  pendingApproval: boolean
  scheduledTaskLoading: boolean
}): React.JSX.Element {
  if (isLoading || scheduledTaskLoading) {
    return <Loader2 className="size-4 shrink-0 text-status-info animate-spin" />
  }

  if (pendingApproval) {
    return <AlertCircle className="size-4 shrink-0 text-status-warning" />
  }

  return <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
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
  onRunFinished,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange
}: {
  thread: Thread
  isLoading: boolean
  hasPendingApproval: boolean
  scheduledTaskLoading: boolean
  isSelected: boolean
  isEditing: boolean
  isUnread: boolean
  editingTitle: string
  onSelect: () => void
  onDelete: () => void
  onRunFinished: () => void
  onStartEditing: () => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
}): React.JSX.Element {
  const isRunning = isLoading || scheduledTaskLoading
  const wasRunningRef = useRef(false)
  const onRunFinishedRef = useRef(onRunFinished)
  onRunFinishedRef.current = onRunFinished

  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      onRunFinishedRef.current()
    }
    wasRunningRef.current = isRunning
  }, [isRunning])
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
              <>
                <div
                  className="text-sm truncate block flex items-center gap-1"
                  title={thread.title || thread.thread_id}
                >
                  {thread.title?.startsWith("[Heartbeat]") ? (
                    <>
                      <HeartPulse className="size-3 shrink-0 text-red-400" />
                      <span className="truncate">{thread.title.slice(12)}</span>
                    </>
                  ) : thread.title?.startsWith("[定时]") ? (
                    <>
                      <span className="shrink-0 text-[10px] px-1 py-px rounded bg-primary/15 text-primary font-medium">定时</span>
                      <span className="truncate">{thread.title.slice(5)}</span>
                    </>
                  ) : thread.title?.startsWith("[远端机器人] ") ? (
                    <>
                      <Radio className="size-3 shrink-0 text-green-400" />
                      <span className="truncate">(远端) {thread.title.slice(8)}</span>
                    </>
                  ) : thread.title?.startsWith("[机器人] ") ? (
                    <>
                      <Cpu className="size-3 shrink-0 text-blue-400" />
                      <span className="truncate">{thread.title.slice(6)}</span>
                    </>
                  ) : (
                    <span className="truncate">{thread.title || truncate(thread.thread_id, 20)}</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {formatRelativeTime(thread.updated_at)}
                </div>
              </>
            )}
          </div>
          {isUnread && !isRunning && (
            <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          )}
          <span className="shrink-0" title={isRunning ? "任务运行中，无法删除" : undefined}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("opacity-0 group-hover:opacity-100", isRunning && "cursor-not-allowed !opacity-30")}
              disabled={isRunning}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartEditing}>
          <Pencil className="size-4 mr-2" />
          重命名
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

  const persistUnread = useCallback((ids: Set<string>) => {
    localStorage.setItem("threads:unreadIds", JSON.stringify([...ids]))
  }, [])

  const currentThreadIdRef = useRef(currentThreadId)
  currentThreadIdRef.current = currentThreadId
  const mainViewRef = useRef(mainView)
  mainViewRef.current = mainView

  const handleRunFinished = useCallback((threadId: string) => {
    if (threadId === currentThreadIdRef.current && mainViewRef.current === "thread") return
    setUnreadIds((prev) => {
      if (prev.has(threadId)) return prev
      const next = new Set(prev)
      next.add(threadId)
      persistUnread(next)
      return next
    })
  }, [persistUnread])

  const markRead = useCallback((threadId: string) => {
    setUnreadIds((prev) => {
      if (!prev.has(threadId)) return prev
      const next = new Set(prev)
      next.delete(threadId)
      persistUnread(next)
      return next
    })
  }, [persistUnread])

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
        (r) => r.chatId && r.fromId && r.clientId && r.clientSecret && r.workDir && r.toUserList.length > 0
      )
      setRobots(valid)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadRobots()
  }, [loadRobots, showCustomizeView])

  const handleNewThread = async (): Promise<void> => {
    await createThread({ title: `Thread ${new Date().toLocaleDateString()}` })
  }

  const [creatingRobot, setCreatingRobot] = useState(false)

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

  const [version, setVersion] = useState('')

  useEffect(() => {
    // Fetch version proactively — the did-finish-load event may have
    // already fired before this component mounts.
    window.electron.ipcRenderer.invoke("get-version").then((ver) => {
      setVersion(ver as string)
    }).catch(() => {
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

      {/* Thread List */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1 overflow-hidden">
          {threads.map((thread) => {
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
                isSelected={currentThreadId === thread.thread_id}
                isEditing={editingThreadId === thread.thread_id}
                isUnread={unreadIds.has(thread.thread_id)}
                editingTitle={editingTitle}
                onSelect={() => {
                  selectThread(thread.thread_id)
                  markRead(thread.thread_id)
                }}
                onRunFinished={() => handleRunFinished(thread.thread_id)}
                onDelete={() => {
                  cleanupThread(thread.thread_id)
                  deleteThread(thread.thread_id)
                  markRead(thread.thread_id)
                }}
                onStartEditing={() => startEditing(thread.thread_id, thread.title || "")}
                onSaveTitle={saveTitle}
                onCancelEditing={cancelEditing}
                onEditingTitleChange={setEditingTitle}
              />
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
        </div>
      </div>
    </aside>
  )
}
