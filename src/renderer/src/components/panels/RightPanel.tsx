import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import {
  ListTodo,
  FolderTree,
  GitBranch,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Circle,
  Clock,
  XCircle,
  GripHorizontal,
  Download,
  FolderSync,
  Loader2,
  Check,
  Folder,
  FolderOpen,
  File,
  FileText,
  FileCode,
  FileJson,
  Image,
  FileType,
  Sparkles,
  Puzzle,
  Plug,
  Power,
  Webhook
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import { useThreadState } from "@/lib/thread-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Todo, SkillMetadata, PluginMetadata, HookConfig } from "@/types"
import { SubagentCard } from "@/components/panels/SubagentPanel"

const HEADER_HEIGHT = 52 // px
const HANDLE_HEIGHT = 6 // px
const SECTION_GAP = 8 // px
const MIN_CONTENT_HEIGHT = 60 // px
const COLLAPSE_THRESHOLD = 55 // px - auto-collapse when below this

type PanelHeights = { tasks: number; files: number; agents: number; skills: number; plugins: number }

interface SectionHeaderProps {
  title: string
  icon: React.ElementType
  badge?: number
  isOpen: boolean
  onToggle: () => void
}

function SectionHeader({
  title,
  icon: Icon,
  badge,
  isOpen,
  onToggle
}: SectionHeaderProps): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-3 px-5 py-3 text-section-header hover:bg-background-interactive/60 transition-colors shrink-0 w-full"
      style={{ height: HEADER_HEIGHT }}
    >
      <ChevronRight
        className={cn(
          "size-3.5 text-muted-foreground transition-transform duration-200",
          isOpen && "rotate-90"
        )}
      />
      <Icon className="size-4.5 text-foreground/70" />
      <span className="flex-1 text-left text-[16px] font-semibold leading-none">{title}</span>
      {badge !== undefined && badge > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">{badge}</span>
      )}
    </button>
  )
}

interface ResizeHandleProps {
  onDrag: (delta: number) => void
}

function ResizeHandle({ onDrag }: ResizeHandleProps): React.JSX.Element {
  const startYRef = useRef<number>(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      startYRef.current = e.clientY

      const handleMouseMove = (e: MouseEvent): void => {
        // Calculate total delta from drag start
        const totalDelta = e.clientY - startYRef.current
        onDrag(totalDelta)
      }

      const handleMouseUp = (): void => {
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
    },
    [onDrag]
  )

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group bg-transparent hover:bg-border/50 active:bg-border/70 transition-colors cursor-row-resize flex items-center justify-center shrink-0 select-none rounded-sm"
      style={{ height: HANDLE_HEIGHT }}
    >
      <GripHorizontal className="h-4 w-8 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
    </div>
  )
}

export function RightPanel(): React.JSX.Element {
  const { currentThreadId, pluginVersion } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const todos = threadState?.todos ?? []
  const workspaceFiles = threadState?.workspaceFiles ?? []
  const subagents = threadState?.subagents ?? []
  const containerRef = useRef<HTMLDivElement>(null)

  const [tasksOpen, setTasksOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [hooksOpen, setHooksOpen] = useState(false)
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set())
  const [plugins, setPlugins] = useState<PluginMetadata[]>([])
  const [hooks, setHooks] = useState<HookConfig[]>([])

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const [loaded, disabled] = await Promise.all([
          window.api.skills.list(),
          window.api.skills.getDisabled()
        ])
        setSkills(loaded)
        setDisabledSkills(new Set(disabled))
      } catch (e) {
        console.error("[RightPanel] Failed to load skills:", e)
      }
    }
    load()
  }, [])

  useEffect(() => {
    window.api.plugins.list().then(setPlugins).catch(console.error)
  }, [pluginVersion])

  useEffect(() => {
    window.api.hooks.list().then(setHooks).catch(console.error)
  }, [])

  // Store content heights in pixels (null = auto/equal distribution)
  const [tasksHeight, setTasksHeight] = useState<number | null>(null)
  const [filesHeight, setFilesHeight] = useState<number | null>(null)
  const [agentsHeight, setAgentsHeight] = useState<number | null>(null)
  const [skillsHeight, setSkillsHeight] = useState<number | null>(null)
  const [pluginsHeight, setPluginsHeight] = useState<number | null>(null)

  // Track drag start heights
  const dragStartHeights = useRef<{
    tasks: number
    files: number
    agents: number
    skills: number
    plugins: number
  } | null>(null)

  // Calculate available content height
  const getAvailableContentHeight = useCallback(() => {
    if (!containerRef.current) return 0
    const totalHeight = containerRef.current.clientHeight

    const openPanels = [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen]
    let used = HEADER_HEIGHT * 5
    // Fixed visual gaps between section blocks
    used += SECTION_GAP * 4

    // Count handles between consecutive open panels
    let handles = 0
    let lastOpen = false
    for (const isOpen of openPanels) {
      if (isOpen && lastOpen) handles++
      lastOpen = isOpen
    }
    used += HANDLE_HEIGHT * handles

    return Math.max(0, totalHeight - used)
  }, [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen])

  // Get current heights for each panel's content area
  const getContentHeights = useCallback(() => {
    const available = getAvailableContentHeight()
    const openCount = [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen].filter(Boolean).length

    if (openCount === 0) {
      return { tasks: 0, files: 0, agents: 0, skills: 0, plugins: 0 }
    }

    const defaultHeight = available / openCount

    return {
      tasks: tasksOpen ? (tasksHeight ?? defaultHeight) : 0,
      files: filesOpen ? (filesHeight ?? defaultHeight) : 0,
      agents: agentsOpen ? (agentsHeight ?? defaultHeight) : 0,
      skills: skillsOpen ? (skillsHeight ?? defaultHeight) : 0,
      plugins: pluginsOpen ? (pluginsHeight ?? defaultHeight) : 0
    }
  }, [
    getAvailableContentHeight,
    tasksOpen,
    filesOpen,
    agentsOpen,
    skillsOpen,
    pluginsOpen,
    tasksHeight,
    filesHeight,
    agentsHeight,
    skillsHeight,
    pluginsHeight
  ])

  // Handle resize between tasks and the next open section
  const handleTasksResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartHeights.current) {
        const heights = getContentHeights()
        dragStartHeights.current = { ...heights }
      }

      const start = dragStartHeights.current
      const available = getAvailableContentHeight()

      // Determine which panel is being resized against
      const otherStart = filesOpen ? start.files : start.agents

      // Calculate new heights with proper clamping
      let newTasksHeight = start.tasks + totalDelta
      let newOtherHeight = otherStart - totalDelta

      // Clamp both to min height
      if (newTasksHeight < MIN_CONTENT_HEIGHT) {
        newTasksHeight = MIN_CONTENT_HEIGHT
        newOtherHeight = otherStart + (start.tasks - MIN_CONTENT_HEIGHT)
      }
      if (newOtherHeight < MIN_CONTENT_HEIGHT) {
        newOtherHeight = MIN_CONTENT_HEIGHT
        newTasksHeight = start.tasks + (otherStart - MIN_CONTENT_HEIGHT)
      }

      // Ensure total doesn't exceed available (accounting for third panel if open)
      const thirdPanelHeight = filesOpen && agentsOpen ? (agentsHeight ?? available / 3) : 0
      const maxForTwo = available - thirdPanelHeight
      if (newTasksHeight + newOtherHeight > maxForTwo) {
        const excess = newTasksHeight + newOtherHeight - maxForTwo
        if (totalDelta > 0) {
          newOtherHeight = Math.max(MIN_CONTENT_HEIGHT, newOtherHeight - excess)
        } else {
          newTasksHeight = Math.max(MIN_CONTENT_HEIGHT, newTasksHeight - excess)
        }
      }

      setTasksHeight(newTasksHeight)
      if (filesOpen) {
        setFilesHeight(newOtherHeight)
      } else if (agentsOpen) {
        setAgentsHeight(newOtherHeight)
      }

      // Auto-collapse if below threshold
      if (newTasksHeight < COLLAPSE_THRESHOLD) {
        setTasksOpen(false)
      }
      if (newOtherHeight < COLLAPSE_THRESHOLD) {
        if (filesOpen) setFilesOpen(false)
        else if (agentsOpen) setAgentsOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, filesOpen, agentsOpen, agentsHeight]
  )

  // Handle resize between files and agents
  const handleFilesResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartHeights.current) {
        const heights = getContentHeights()
        dragStartHeights.current = { ...heights }
      }

      const start = dragStartHeights.current
      const available = getAvailableContentHeight()
      const tasksH = tasksOpen ? (tasksHeight ?? available / 3) : 0
      const maxForFilesAndAgents = available - tasksH

      // Calculate new heights with proper clamping
      let newFilesHeight = start.files + totalDelta
      let newAgentsHeight = start.agents - totalDelta

      // Clamp both to min height
      if (newFilesHeight < MIN_CONTENT_HEIGHT) {
        newFilesHeight = MIN_CONTENT_HEIGHT
        newAgentsHeight = start.agents + (start.files - MIN_CONTENT_HEIGHT)
      }
      if (newAgentsHeight < MIN_CONTENT_HEIGHT) {
        newAgentsHeight = MIN_CONTENT_HEIGHT
        newFilesHeight = start.files + (start.agents - MIN_CONTENT_HEIGHT)
      }

      // Ensure total doesn't exceed available
      if (newFilesHeight + newAgentsHeight > maxForFilesAndAgents) {
        const excess = newFilesHeight + newAgentsHeight - maxForFilesAndAgents
        if (totalDelta > 0) {
          newAgentsHeight = Math.max(MIN_CONTENT_HEIGHT, newAgentsHeight - excess)
        } else {
          newFilesHeight = Math.max(MIN_CONTENT_HEIGHT, newFilesHeight - excess)
        }
      }

      setFilesHeight(newFilesHeight)
      setAgentsHeight(newAgentsHeight)

      // Auto-collapse if below threshold
      if (newFilesHeight < COLLAPSE_THRESHOLD) {
        setFilesOpen(false)
      }
      if (newAgentsHeight < COLLAPSE_THRESHOLD) {
        setAgentsOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, tasksOpen, tasksHeight]
  )

  // Handle resize between agents and skills
  const handleAgentsResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartHeights.current) {
        const currentHeights = getContentHeights()
        dragStartHeights.current = { ...currentHeights }
      }

      const start = dragStartHeights.current
      const available = getAvailableContentHeight()
      const usedByUpperPanels = (tasksOpen ? start.tasks : 0) + (filesOpen ? start.files : 0)
      const maxForAgentsAndSkills = available - usedByUpperPanels

      let newAgentsHeight = start.agents + totalDelta
      let newSkillsHeight = start.skills - totalDelta

      if (newAgentsHeight < MIN_CONTENT_HEIGHT) {
        newAgentsHeight = MIN_CONTENT_HEIGHT
        newSkillsHeight = start.skills + (start.agents - MIN_CONTENT_HEIGHT)
      }
      if (newSkillsHeight < MIN_CONTENT_HEIGHT) {
        newSkillsHeight = MIN_CONTENT_HEIGHT
        newAgentsHeight = start.agents + (start.skills - MIN_CONTENT_HEIGHT)
      }

      if (newAgentsHeight + newSkillsHeight > maxForAgentsAndSkills) {
        const excess = newAgentsHeight + newSkillsHeight - maxForAgentsAndSkills
        if (totalDelta > 0) {
          newSkillsHeight = Math.max(MIN_CONTENT_HEIGHT, newSkillsHeight - excess)
        } else {
          newAgentsHeight = Math.max(MIN_CONTENT_HEIGHT, newAgentsHeight - excess)
        }
      }

      setAgentsHeight(newAgentsHeight)
      setSkillsHeight(newSkillsHeight)

      if (newAgentsHeight < COLLAPSE_THRESHOLD) {
        setAgentsOpen(false)
      }
      if (newSkillsHeight < COLLAPSE_THRESHOLD) {
        setSkillsOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, tasksOpen, filesOpen]
  )

  // Handle resize between skills and plugins
  const handleSkillsResize = useCallback(
    (totalDelta: number) => {
      if (!dragStartHeights.current) {
        const currentHeights = getContentHeights()
        dragStartHeights.current = { ...currentHeights }
      }

      const start = dragStartHeights.current
      const available = getAvailableContentHeight()
      const usedByUpperPanels =
        (tasksOpen ? start.tasks : 0) +
        (filesOpen ? start.files : 0) +
        (agentsOpen ? start.agents : 0)
      const maxForSkillsAndPlugins = available - usedByUpperPanels

      let newSkillsHeight = start.skills + totalDelta
      let newPluginsHeight = start.plugins - totalDelta

      if (newSkillsHeight < MIN_CONTENT_HEIGHT) {
        newSkillsHeight = MIN_CONTENT_HEIGHT
        newPluginsHeight = start.plugins + (start.skills - MIN_CONTENT_HEIGHT)
      }
      if (newPluginsHeight < MIN_CONTENT_HEIGHT) {
        newPluginsHeight = MIN_CONTENT_HEIGHT
        newSkillsHeight = start.skills + (start.plugins - MIN_CONTENT_HEIGHT)
      }

      if (newSkillsHeight + newPluginsHeight > maxForSkillsAndPlugins) {
        const excess = newSkillsHeight + newPluginsHeight - maxForSkillsAndPlugins
        if (totalDelta > 0) {
          newPluginsHeight = Math.max(MIN_CONTENT_HEIGHT, newPluginsHeight - excess)
        } else {
          newSkillsHeight = Math.max(MIN_CONTENT_HEIGHT, newSkillsHeight - excess)
        }
      }

      setSkillsHeight(newSkillsHeight)
      setPluginsHeight(newPluginsHeight)

      if (newSkillsHeight < COLLAPSE_THRESHOLD) {
        setSkillsOpen(false)
      }
      if (newPluginsHeight < COLLAPSE_THRESHOLD) {
        setPluginsOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, tasksOpen, filesOpen, agentsOpen]
  )

  // Reset drag start on mouse up
  useEffect(() => {
    const handleMouseUp = (): void => {
      dragStartHeights.current = null
    }
    document.addEventListener("mouseup", handleMouseUp)
    return () => document.removeEventListener("mouseup", handleMouseUp)
  }, [])

  // Reset heights when panels open/close to redistribute
  useEffect(() => {
    setTasksHeight(null)
    setFilesHeight(null)
    setAgentsHeight(null)
    setSkillsHeight(null)
    setPluginsHeight(null)
  }, [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen])

  // Calculate heights in an effect (refs can't be accessed during render)
  const [heights, setHeights] = useState<PanelHeights>({ tasks: 0, files: 0, agents: 0, skills: 0, plugins: 0 })
  useEffect(() => {
    setHeights(getContentHeights())
  }, [getContentHeights])

  const allPanelsClosed = !tasksOpen && !filesOpen && !agentsOpen && !skillsOpen && !pluginsOpen

  return (
    <aside
      ref={containerRef}
      className={cn(
        "flex w-full flex-col bg-transparent overflow-hidden",
        allPanelsClosed ? "h-auto self-start" : "h-full"
      )}
    >
      {/* TASKS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95">
        <SectionHeader
          title="任务"
          icon={ListTodo}
          badge={todos.length}
          isOpen={tasksOpen}
          onToggle={() => setTasksOpen((prev) => !prev)}
        />
        {tasksOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.tasks }}>
            <TasksContent />
          </div>
        )}
      </div>

      {/* Resize handle after TASKS */}
      {tasksOpen && (filesOpen || agentsOpen) && <ResizeHandle onDrag={handleTasksResize} />}

      {/* FILES */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="文件"
          icon={FolderTree}
          badge={workspaceFiles.length}
          isOpen={filesOpen}
          onToggle={() => setFilesOpen((prev) => !prev)}
        />
        {filesOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.files }}>
            <FilesContent />
          </div>
        )}
      </div>

      {/* Resize handle after FILES */}
      {filesOpen && agentsOpen && <ResizeHandle onDrag={handleFilesResize} />}

      {/* AGENTS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="代理"
          icon={GitBranch}
          badge={subagents.length}
          isOpen={agentsOpen}
          onToggle={() => setAgentsOpen((prev) => !prev)}
        />
        {agentsOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.agents }}>
            <AgentsContent />
          </div>
        )}
      </div>

      {/* Resize handle after AGENTS */}
      {agentsOpen && skillsOpen && <ResizeHandle onDrag={handleAgentsResize} />}

      {/* SKILLS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="技能"
          icon={Sparkles}
          badge={skills.length}
          isOpen={skillsOpen}
          onToggle={() => setSkillsOpen((prev) => !prev)}
        />
        {skillsOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.skills }}>
            <SkillsContent skills={skills} disabledSkills={disabledSkills} />
          </div>
        )}
      </div>

      {/* Resize handle after SKILLS */}
      {skillsOpen && pluginsOpen && <ResizeHandle onDrag={handleSkillsResize} />}

      {/* PLUGINS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="插件"
          icon={Puzzle}
          badge={plugins.length}
          isOpen={pluginsOpen}
          onToggle={() => setPluginsOpen((prev) => !prev)}
        />
        {pluginsOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.plugins }}>
            <PluginsContent plugins={plugins} />
          </div>
        )}
      </div>

      {/* HOOKS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="钩子"
          icon={Webhook}
          badge={hooks.length}
          isOpen={hooksOpen}
          onToggle={() => setHooksOpen((prev) => !prev)}
        />
        {hooksOpen && (
          <div className="overflow-auto right-panel-scroll max-h-[200px]">
            <HooksContent hooks={hooks} />
          </div>
        )}
      </div>
    </aside>
  )
}

// ============ Content Components ============

const STATUS_CONFIG = {
  pending: {
    icon: Circle,
    badge: "outline" as const,
    label: "待处理",
    color: "text-muted-foreground"
  },
  in_progress: {
    icon: Clock,
    badge: "info" as const,
    label: "进行中",
    color: "text-status-info"
  },
  completed: {
    icon: CheckCircle2,
    badge: "nominal" as const,
    label: "已完成",
    color: "text-status-nominal"
  },
  cancelled: {
    icon: XCircle,
    badge: "critical" as const,
    label: "已取消",
    color: "text-muted-foreground"
  }
}

function TasksContent(): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const todos = threadState?.todos ?? []
  const [completedExpanded, setCompletedExpanded] = useState(false)

  if (todos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <ListTodo className="size-8 mb-2 opacity-50" />
        <span>暂无任务</span>
        <span className="text-xs mt-1">代理创建任务后会显示在这里</span>
      </div>
    )
  }

  const inProgress = todos.filter((t) => t.status === "in_progress")
  const pending = todos.filter((t) => t.status === "pending")
  const completed = todos.filter((t) => t.status === "completed")
  const cancelled = todos.filter((t) => t.status === "cancelled")

  // Completed section includes both completed and cancelled
  const doneItems = [...completed, ...cancelled]

  const done = completed.length
  const total = todos.length
  const progress = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div>
      {/* Progress bar */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between mb-1.5 text-xs">
          <span className="text-muted-foreground">进度</span>
          <span className="font-mono">
            {done}/{total}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-background overflow-hidden">
          <div
            className="h-full bg-status-nominal transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Todo list */}
      <div className="p-3 space-y-2">
        {/* Completed/Cancelled Section (Collapsible) */}
        {doneItems.length > 0 && (
          <div className="mb-1">
            <button
              onClick={() => setCompletedExpanded(!completedExpanded)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2 w-full"
            >
              {completedExpanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <span className="tracking-wider font-medium">已完成 ({doneItems.length})</span>
            </button>
            {completedExpanded && (
              <div className="space-y-2 pl-5 mb-3">
                {doneItems.map((todo) => (
                  <TaskItem key={todo.id} todo={todo} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* In Progress Section */}
        {inProgress.map((todo) => (
          <TaskItem key={todo.id} todo={todo} />
        ))}

        {/* Pending Section */}
        {pending.map((todo) => (
          <TaskItem key={todo.id} todo={todo} />
        ))}
      </div>
    </div>
  )
}

function TaskItem({ todo }: { todo: Todo }): React.JSX.Element {
  const config = STATUS_CONFIG[todo.status]
  const Icon = config.icon
  const isDone = todo.status === "completed" || todo.status === "cancelled"

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-sm border border-border p-3",
        isDone && "opacity-50"
      )}
    >
      <Icon className={cn("size-4 shrink-0 mt-0.5", config.color)} />
      <span className={cn("flex-1 text-sm", isDone && "line-through")}>{todo.content}</span>
      <Badge variant={config.badge} className="shrink-0 text-[10px]">
        {config.label}
      </Badge>
    </div>
  )
}

function FilesContent(): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const workspaceFiles = threadState?.workspaceFiles ?? []
  const workspacePath = threadState?.workspacePath ?? null
  const setWorkspacePath = threadState?.setWorkspacePath
  const setWorkspaceFiles = threadState?.setWorkspaceFiles
  const [syncing, setSyncing] = useState(false)
  const [syncSuccess] = useState(false)

  // Load workspace path and files for current thread
  useEffect(() => {
    async function loadWorkspace(): Promise<void> {
      if (currentThreadId && setWorkspacePath && setWorkspaceFiles) {
        const path = await window.api.workspace.get(currentThreadId)
        setWorkspacePath(path)

        // If a folder is linked, load files from disk
        if (path) {
          const result = await window.api.workspace.loadFromDisk(currentThreadId)
          if (result.success && result.files) {
            setWorkspaceFiles(result.files)
          }
        }
      }
    }
    loadWorkspace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId])

  // Listen for file changes from the workspace watcher
  useEffect(() => {
    if (!currentThreadId || !setWorkspaceFiles) return

    const cleanup = window.api.workspace.onFilesChanged(async (data) => {
      // Only reload if the event is for the current thread
      if (data.threadId === currentThreadId) {
        console.log("[FilesContent] Files changed, reloading...", data)
        const result = await window.api.workspace.loadFromDisk(currentThreadId)
        if (result.success && result.files) {
          setWorkspaceFiles(result.files)
        }
      }
    })

    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId])

  // Handle selecting a workspace folder
  async function handleSelectFolder(): Promise<void> {
    if (!currentThreadId || !setWorkspacePath || !setWorkspaceFiles) return
    setSyncing(true)
    try {
      const path = await window.api.workspace.select(currentThreadId)
      if (path) {
        setWorkspacePath(path)
        // Load files from the newly selected folder
        const result = await window.api.workspace.loadFromDisk(currentThreadId)
        if (result.success && result.files) {
          setWorkspaceFiles(result.files)
        }
      }
    } catch (e) {
      console.error("[FilesContent] Select folder error:", e)
    } finally {
      setSyncing(false)
    }
  }

  // Handle sync to disk
  // TODO: Implement syncToDisk API in main process
  async function handleSyncToDisk(): Promise<void> {
    if (!currentThreadId) return

    // If no files, just select a folder
    if (workspaceFiles.length === 0) {
      await handleSelectFolder()
      return
    }

    // syncToDisk is not yet implemented
    console.warn("[FilesContent] syncToDisk is not yet implemented")
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with sync button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-background/30">
        <span
          className="text-[10px] text-muted-foreground truncate flex-1"
          title={workspacePath || undefined}
        >
          {workspacePath ? workspacePath.split("/").pop() : "未关联文件夹"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={workspaceFiles.length > 0 ? handleSyncToDisk : handleSelectFolder}
          disabled={syncing || !currentThreadId}
          className="h-5 px-1.5 text-[10px]"
          title={
            workspaceFiles.length > 0
              ? workspacePath
                ? `同步到 ${workspacePath}`
                : "同步文件到磁盘"
              : workspacePath
                ? "更换文件夹"
                : "关联同步文件夹"
          }
        >
          {syncing ? (
            <Loader2 className="size-3 animate-spin" />
          ) : syncSuccess ? (
            <Check className="size-3 text-status-nominal" />
          ) : workspaceFiles.length > 0 ? (
            <Download className="size-3" />
          ) : (
            <FolderSync className="size-3" />
          )}
          <span className="ml-1">
            {workspaceFiles.length > 0 ? "同步" : workspacePath ? "更换" : "关联"}
          </span>
        </Button>
      </div>

      {/* File tree or empty state */}
      {workspaceFiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4 flex-1">
          <FolderTree className="size-8 mb-2 opacity-50" />
          <span>暂无工作区文件</span>
          <span className="text-xs mt-1">
            {workspacePath
              ? `已关联 ${workspacePath.split("/").pop()}`
              : '点击"关联"设置同步文件夹'}
          </span>
        </div>
      ) : (
        <div className="py-1 overflow-auto flex-1">
          <FileTree files={workspaceFiles} />
        </div>
      )}
    </div>
  )
}

// ============ File Tree Components ============

interface FileInfo {
  path: string
  is_dir?: boolean
  size?: number
  modified_at?: string
}

interface TreeNode {
  name: string
  path: string
  is_dir: boolean
  size?: number
  children: TreeNode[]
}

function buildFileTree(files: FileInfo[]): TreeNode[] {
  const root: TreeNode[] = []
  const nodeMap = new Map<string, TreeNode>()

  // Sort files so directories come first, then alphabetically
  const sortedFiles = [...files].sort((a, b) => {
    const aIsDir = a.is_dir ?? false
    const bIsDir = b.is_dir ?? false
    if (aIsDir && !bIsDir) return -1
    if (!aIsDir && bIsDir) return 1
    return a.path.localeCompare(b.path)
  })

  for (const file of sortedFiles) {
    // Normalize path - remove leading slash
    const normalizedPath = file.path.startsWith("/") ? file.path.slice(1) : file.path
    const parts = normalizedPath.split("/")
    const fileName = parts[parts.length - 1]

    const node: TreeNode = {
      name: fileName,
      path: file.path,
      is_dir: file.is_dir ?? false,
      size: file.size,
      children: []
    }

    if (parts.length === 1) {
      // Root level item
      root.push(node)
      nodeMap.set(normalizedPath, node)
    } else {
      // Nested item - find or create parent directories
      let currentPath = ""
      let parentChildren = root

      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]

        let parentNode = nodeMap.get(currentPath)
        if (!parentNode) {
          // Create implicit directory node
          parentNode = {
            name: parts[i],
            path: "/" + currentPath,
            is_dir: true,
            children: []
          }
          parentChildren.push(parentNode)
          nodeMap.set(currentPath, parentNode)
        }
        parentChildren = parentNode.children
      }

      // Add node to parent
      parentChildren.push(node)
      nodeMap.set(normalizedPath, node)
    }
  }

  // Sort children of each node (dirs first, then alphabetically)
  function sortChildren(nodes: TreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1
      if (!a.is_dir && b.is_dir) return 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => sortChildren(n.children))
  }
  sortChildren(root)

  return root
}

function FileTree({ files }: { files: FileInfo[] }): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const openFile = threadState?.openFile
  const tree = useMemo(() => buildFileTree(files), [files])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  return (
    <div className="select-none">
      {tree.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggleExpand}
          openFile={openFile}
        />
      ))}
    </div>
  )
}

const FileTreeNode = memo(
  function FileTreeNode({
    node,
    depth,
    expanded,
    onToggle,
    openFile
  }: {
    node: TreeNode
    depth: number
    expanded: Set<string>
    onToggle: (path: string) => void
    openFile?: (path: string, name: string) => void
  }): React.JSX.Element {
    const isExpanded = expanded.has(node.path)
    const hasChildren = node.children.length > 0
    const paddingLeft = 8 + depth * 16

    const handleClick = (): void => {
      if (node.is_dir) {
        onToggle(node.path)
      } else if (openFile) {
        // Open file in a new tab
        openFile(node.path, node.name)
      }
    }

    return (
      <>
        <div
          onClick={handleClick}
          className={cn(
            "flex items-center gap-1.5 py-1 pr-3 text-xs hover:bg-background-interactive cursor-pointer"
          )}
          style={{ paddingLeft }}
        >
          {/* Expand/collapse chevron for directories */}
          {node.is_dir ? (
            <span className="w-3.5 flex items-center justify-center shrink-0">
              {hasChildren &&
                (isExpanded ? (
                  <ChevronDown className="size-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 text-muted-foreground" />
                ))}
            </span>
          ) : (
            <span className="w-3.5 shrink-0" />
          )}

          {/* Icon */}
          <FileIcon name={node.name} isDir={node.is_dir} isOpen={isExpanded} />

          {/* Name */}
          <span className="truncate flex-1">{node.name}</span>

          {/* Size for files */}
          {!node.is_dir && node.size !== undefined && (
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {formatSize(node.size)}
            </span>
          )}
        </div>

        {/* Children */}
        {node.is_dir &&
          isExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              openFile={openFile}
            />
          ))}
      </>
    )
  },
  (prevProps, nextProps) => {
    // Only re-render if:
    // 1. The node itself changed
    // 2. The expansion state of THIS node changed
    // 3. The openFile callback changed
    // 4. The onToggle callback changed
    return (
      prevProps.node === nextProps.node &&
      prevProps.expanded.has(prevProps.node.path) === nextProps.expanded.has(nextProps.node.path) &&
      prevProps.openFile === nextProps.openFile &&
      prevProps.onToggle === nextProps.onToggle &&
      prevProps.depth === nextProps.depth
    )
  }
)

function FileIcon({
  name,
  isDir,
  isOpen
}: {
  name: string
  isDir: boolean
  isOpen?: boolean
}): React.JSX.Element {
  if (isDir) {
    return isOpen ? (
      <FolderOpen className="size-3.5 text-amber-500 shrink-0" />
    ) : (
      <Folder className="size-3.5 text-amber-500 shrink-0" />
    )
  }

  // Get file extension
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""

  // Map extensions to icons and colors
  switch (ext) {
    case "ts":
    case "tsx":
      return <FileCode className="size-3.5 text-blue-400 shrink-0" />
    case "js":
    case "jsx":
      return <FileCode className="size-3.5 text-yellow-400 shrink-0" />
    case "json":
      return <FileJson className="size-3.5 text-yellow-600 shrink-0" />
    case "md":
    case "mdx":
      return <FileText className="size-3.5 text-muted-foreground shrink-0" />
    case "py":
      return <FileCode className="size-3.5 text-green-400 shrink-0" />
    case "css":
    case "scss":
    case "sass":
      return <FileCode className="size-3.5 text-pink-400 shrink-0" />
    case "html":
      return <FileCode className="size-3.5 text-orange-400 shrink-0" />
    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return <Image className="size-3.5 text-purple-400 shrink-0" />
    case "yml":
    case "yaml":
      return <FileType className="size-3.5 text-red-400 shrink-0" />
    default:
      return <File className="size-3.5 text-muted-foreground shrink-0" />
  }
}

function AgentsContent(): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const subagents = threadState?.subagents ?? []

  if (subagents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <GitBranch className="size-8 mb-2 opacity-50" />
        <span>暂无子代理任务</span>
        <span className="text-xs mt-1">子代理启动后会显示在这里</span>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      {subagents.map((agent) => (
        <SubagentCard key={agent.id} subagent={agent} />
      ))}
    </div>
  )
}

function SkillsContent({
  skills,
  disabledSkills
}: {
  skills: SkillMetadata[]
  disabledSkills: Set<string>
}): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Sparkles className="size-8 mb-2 opacity-50" />
        <span>暂无技能</span>
      </div>
    )
  }

  const programmingSkillIds = new Set([
    "security-review",
    "code-review-expert",
    "vercel-react-best-practices",
    "audit-website",
    "supabase-postgres-best-practices",
    "typescript-advanced-types",
    "api-design-principles",
    "architecture-patterns",
    "error-handling-patterns",
    "planning-with-files",
    "mcp-builder",
    "webapp-testing",
    "frontend-design"
  ])
  const isProgrammingSkill = (skill: SkillMetadata): boolean => {
    return programmingSkillIds.has(skill.name.trim().toLowerCase())
  }

  const programmingSkills = skills.filter(isProgrammingSkill)
  const generalSkills = skills.filter((skill) => !isProgrammingSkill(skill))

  const renderSkillCard = (skill: SkillMetadata): React.JSX.Element => {
    const disabled = disabledSkills.has(skill.name)
    return (
      <div
        key={skill.name}
        className={cn(
          "p-3 rounded-sm border border-border",
          disabled && "opacity-60"
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className={cn("size-3.5 shrink-0", disabled ? "text-muted-foreground" : "text-amber-500")} />
          <span className={cn("flex-1 truncate", disabled && "text-muted-foreground line-through")}>{skill.name}</span>
          {disabled && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">已禁用</Badge>
          )}
        </div>
        {skill.description && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{skill.description}</p>
        )}
      </div>
    )
  }

  return (
    <div className="p-3 space-y-2">
      {generalSkills.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
              通用场景
            </span>
            <Badge variant="outline" className="text-[10px] h-5">
              {generalSkills.length}
            </Badge>
          </div>
          {generalSkills.map(renderSkillCard)}
        </div>
      )}

      {programmingSkills.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
              编程场景
            </span>
            <Badge variant="outline" className="text-[10px] h-5">
              {programmingSkills.length}
            </Badge>
          </div>
          {programmingSkills.map(renderSkillCard)}
        </div>
      )}
    </div>
  )
}

function PluginsContent({ plugins }: { plugins: PluginMetadata[] }): React.JSX.Element {
  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Puzzle className="size-8 mb-2 opacity-50" />
        <span>暂无插件</span>
        <span className="text-xs mt-1">在自定义面板中安装插件</span>
      </div>
    )
  }

  const enabled = plugins.filter((p) => p.enabled)
  const disabled = plugins.filter((p) => !p.enabled)

  const renderPluginCard = (plugin: PluginMetadata): React.JSX.Element => (
    <div
      key={plugin.id}
      className={cn(
        "p-3 rounded-sm border border-border",
        !plugin.enabled && "opacity-60"
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Puzzle className={cn("size-3.5 shrink-0", plugin.enabled ? "text-primary" : "text-muted-foreground")} />
        <span className={cn("flex-1 truncate", !plugin.enabled && "text-muted-foreground")}>{plugin.name}</span>
        <Power className={cn("size-3 shrink-0", plugin.enabled ? "text-status-nominal" : "text-muted-foreground")} />
      </div>
      {plugin.description && (
        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{plugin.description}</p>
      )}
      <div className="flex items-center gap-3 mt-1.5">
        {plugin.skillCount > 0 && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Sparkles className="size-2.5" />
            {plugin.skillCount} skills
          </span>
        )}
        {plugin.mcpServerCount > 0 && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Plug className="size-2.5" />
            {plugin.mcpServerCount} MCPs
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="p-3 space-y-2">
      {enabled.length > 0 && enabled.map(renderPluginCard)}
      {disabled.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
              已禁用
            </span>
            <Badge variant="outline" className="text-[10px] h-5">
              {disabled.length}
            </Badge>
          </div>
          {disabled.map(renderPluginCard)}
        </div>
      )}
    </div>
  )
}

const HOOK_EVENT_COLORS: Record<string, string> = {
  PreToolUse: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PostToolUse: "bg-green-500/15 text-green-600 dark:text-green-400",
  Stop: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Notification: "bg-purple-500/15 text-purple-600 dark:text-purple-400"
}

function HooksContent({ hooks }: { hooks: HookConfig[] }): React.JSX.Element {
  if (hooks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Webhook className="size-8 mb-2 opacity-50" />
        <span>暂无钩子</span>
        <span className="text-xs mt-1">在自定义面板中添加钩子</span>
      </div>
    )
  }

  const enabled = hooks.filter((h) => h.enabled)
  const disabled = hooks.filter((h) => !h.enabled)

  const renderHookCard = (hook: HookConfig): React.JSX.Element => (
    <div
      key={hook.id}
      className={cn(
        "p-3 rounded-sm border border-border",
        !hook.enabled && "opacity-60"
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <span
          className={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0",
            HOOK_EVENT_COLORS[hook.event] ?? "bg-muted text-muted-foreground"
          )}
        >
          {hook.event}
        </span>
        <span className={cn("flex-1 truncate font-mono text-xs", !hook.enabled && "text-muted-foreground")}>
          {hook.command}
        </span>
        <Power className={cn("size-3 shrink-0", hook.enabled ? "text-status-nominal" : "text-muted-foreground")} />
      </div>
      {hook.matcher && (
        <p className="text-[10px] text-muted-foreground mt-1 font-mono">匹配: {hook.matcher}</p>
      )}
    </div>
  )

  return (
    <div className="p-3 space-y-2">
      {enabled.length > 0 && enabled.map(renderHookCard)}
      {disabled.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
              已禁用
            </span>
            <Badge variant="outline" className="text-[10px] h-5">
              {disabled.length}
            </Badge>
          </div>
          {disabled.map(renderHookCard)}
        </div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
