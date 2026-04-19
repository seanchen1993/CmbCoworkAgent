import { useState, useRef, useCallback, useEffect, useMemo, memo, lazy, Suspense } from "react"
import {
  ListTodo,
  FolderTree,
  GitBranch,
  Code2,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
  Circle,
  Clock,
  XCircle,
  GripHorizontal,
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
  AlertCircle,
  RotateCcw,
  Webhook,
  Maximize2,
  Minimize2,
  EyeOff,
  Loader2,
  Copy,
  Check
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useAppStore, selectSkillGenerationAgent, selectSkillRetryContext } from "@/lib/store"
import { useShallow } from "zustand/react/shallow"
import { useThreadState, useThreadStream } from "@/lib/thread-context"
import { getFileType } from "@/lib/file-types"
import { Badge } from "@/components/ui/badge"
import { DiffDisplay } from "@/components/chat/ToolCallRenderer"
import { onOpenResourcePreview } from "@/lib/resource-preview-events"
import type { Todo, SkillMetadata, PluginMetadata, LspConfig, LspStatus } from "@/types"
import { SubagentCard } from "@/components/panels/SubagentPanel"
import { LspPanel } from "@/components/customize/LspPanel"

type HookConfig = Awaited<ReturnType<typeof window.api.hooks.list>>[number]

const FileViewer = lazy(() =>
  import("@/components/tabs/FileViewer").then((m) => ({ default: m.FileViewer }))
)
const GitPanelView = lazy(() =>
  import("@/components/panels/GitPanelView").then((m) => ({ default: m.GitPanelView }))
)

const HEADER_HEIGHT = 52 // px
const HANDLE_HEIGHT = 6 // px
const SECTION_GAP = 8 // px
const MIN_CONTENT_HEIGHT = 60 // px
const COLLAPSE_THRESHOLD = 55 // px - auto-collapse when below this
const PREVIEW_MAX_HEIGHT = "100vh"

type PanelHeights = { tasks: number; files: number; agents: number; skills: number; plugins: number; hooks: number; lsp: number }

interface SectionHeaderProps {
  title: string
  icon: React.ElementType
  badge?: number
  detail?: React.ReactNode
  isOpen: boolean
  onToggle: () => void
}

function SectionHeader({
  title,
  icon: Icon,
  badge,
  detail,
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
      {detail && <div className="shrink-0">{detail}</div>}
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

interface RightPanelProps {
  moduleMode: "work" | "preview" | "git"
  onRequestPreviewMode?: () => void
  onRequestWorkMode?: () => void
  onPreviewFullscreenChange?: (isFullscreen: boolean) => void
}

function LazySectionFallback({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function RightPanel({
  moduleMode,
  onRequestPreviewMode,
  onRequestWorkMode,
  onPreviewFullscreenChange
}: RightPanelProps): React.JSX.Element {
  const { currentThreadId, pluginVersion, skillGenerationByThread, setSkillGenerationPhase } = useAppStore(
    useShallow((s) => ({
      currentThreadId: s.currentThreadId,
      pluginVersion: s.pluginVersion,
      // Subscribe to the whole map so we re-render when any thread's card changes
      skillGenerationByThread: s.skillGenerationByThread,
      setSkillGenerationPhase: s.setSkillGenerationPhase
    }))
  )
  // Derive the current thread's card state from the per-thread map
  const skillGenerationAgent = selectSkillGenerationAgent(
    { skillGenerationByThread } as Parameters<typeof selectSkillGenerationAgent>[0],
    currentThreadId
  )
  const threadState = useThreadState(currentThreadId)
  const streamData = useThreadStream(currentThreadId ?? "")
  const todos = threadState?.todos ?? []
  const workspaceFiles = threadState?.workspaceFiles ?? []
  const subagents = threadState?.subagents ?? []
  const containerRef = useRef<HTMLDivElement>(null)

  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewDiff, setPreviewDiff] = useState<CodeDiffPayload | null>(null)
  const [previewReloadToken, setPreviewReloadToken] = useState(0)
  const lastAppliedPreviewKeyRef = useRef<string | null>(null)
  const lastRecordedBatchKeyRef = useRef<string | null>(null)
  const lastAutoSwitchedBatchKeyRef = useRef<string | null>(null)
  const lastThreadIdRef = useRef<string | null>(null)
  const prevStreamLoadingRef = useRef(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [hooksOpen, setHooksOpen] = useState(false)
  const [lspOpen, setLspOpen] = useState(false)
  const [lspConfig, setLspConfig] = useState<LspConfig | null>(null)
  const [lspStatus, setLspStatus] = useState<LspStatus | null>(null)
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
    let cancelled = false

    const loadLspSummary = async (): Promise<void> => {
      try {
        const cfg = await window.api.lsp.getConfig()
        if (cancelled) return
        setLspConfig(cfg)

        const workspacePath = threadState?.workspacePath ?? null
        const currentStatus = await window.api.lsp.getStatus(workspacePath)
        if (!cancelled) {
          setLspStatus(currentStatus)
        }
      } catch (error) {
        console.error("[RightPanel] Failed to load LSP summary:", error)
      }
    }

    void loadLspSummary()
    const unsubscribe = window.api.lsp.onChanged(() => { void loadLspSummary() })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [currentThreadId, threadState?.workspacePath])

  // Auto-open agents panel when skill generation starts
  useEffect(() => {
    if (skillGenerationAgent.phase === "generating") {
      setAgentsOpen(true)
    }
  }, [skillGenerationAgent.phase])

  const lspHeaderStatus = useMemo(() => {
    if (!lspConfig) return null

    const statusText = !lspConfig.enabled
      ? "已禁用"
      : currentThreadId && !threadState?.workspacePath
        ? "未关联工作目录"
        : lspStatus?.statusText ?? "已停止"

    const statusClass = cn(
      "text-xs font-medium tabular-nums",
      lspStatus?.lifecycle === "ready"
        ? "text-green-500"
        : lspStatus?.lifecycle === "degraded"
          ? "text-amber-600 dark:text-amber-400"
          : lspStatus?.lifecycle === "starting" || lspStatus?.lifecycle === "importing"
            ? "text-sky-600 dark:text-sky-400"
            : lspStatus?.lifecycle === "error"
              ? "text-destructive"
              : "text-muted-foreground"
    )

    return <span className={statusClass}>{statusText}</span>
  }, [currentThreadId, lspConfig, lspStatus, threadState?.workspacePath])

  // Auto-clear only for "done" phase (3 s brief confirmation).
  // "error" is intentionally NOT auto-cleared — it stays visible so the user
  // can read the error, and must be dismissed manually via the ✕ button on the card.
  useEffect(() => {
    if (skillGenerationAgent.phase === "done") {
      const t = setTimeout(() => setSkillGenerationPhase(null), 3000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [skillGenerationAgent.phase, setSkillGenerationPhase])

  // Log skill generation errors to the console for easier diagnosis on Windows
  useEffect(() => {
    if (skillGenerationAgent.phase === "error") {
      console.error("[SkillGen] 技能生成失败:", skillGenerationAgent.errorText)
    }
  }, [skillGenerationAgent.phase, skillGenerationAgent.errorText])

  useEffect(() => {
    if (hooksOpen) {
      window.api.hooks.list().then(setHooks).catch(console.error)
    }
  }, [hooksOpen])

  const latestResourceEvent = useMemo(() => {
    const persisted = threadState?.messages ?? []
    const streaming = (streamData.messages as Array<{ id?: string; tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> }> | undefined) ?? []
    const all = [
      ...persisted.map((m) => ({ source: "persisted" as const, message: m })),
      ...streaming.map((m) => ({ source: "streaming" as const, message: m }))
    ]

    const completedToolCallIds = new Set<string>()
    for (const item of all) {
      const message = item.message as {
        role?: string
        type?: string
        tool_call_id?: string
      }
      if ((message.role === "tool" || message.type === "tool") && message.tool_call_id) {
        completedToolCallIds.add(message.tool_call_id)
      }
    }

    for (let i = all.length - 1; i >= 0; i--) {
      const current = all[i]
      const toolCalls = current.message?.tool_calls || []
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const tool = toolCalls[j] as { id?: string; name: string; args?: Record<string, unknown> }
        if (!tool.id || !completedToolCallIds.has(tool.id)) {
          continue
        }
        const event = buildPreviewEvent(tool, current.message?.id ?? `m-${i}`, j)
        if (event) {
          return { ...event, source: current.source }
        }
      }
    }
    return null
  }, [threadState?.messages, streamData.messages])

  const latestCompletedLlmBatch = useMemo(() => {
    const persisted = threadState?.messages ?? []
    const streaming = (streamData.messages as Array<{ id?: string; tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> }> | undefined) ?? []
    const all = [
      ...persisted.map((m) => ({ message: m })),
      ...streaming.map((m) => ({ message: m }))
    ]
    const completedToolCallIds = new Set<string>()
    for (const item of all) {
      const message = item.message as { role?: string; type?: string; tool_call_id?: string }
      if ((message.role === "tool" || message.type === "tool") && message.tool_call_id) {
        completedToolCallIds.add(message.tool_call_id)
      }
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const msg = all[i].message
      const toolCalls = msg?.tool_calls || []
      const files = new Set<string>()
      const toolIds: string[] = []
      for (const tool of toolCalls) {
        if (!tool?.id || !completedToolCallIds.has(tool.id)) continue
        const filePath = getToolCallFilePath(tool)
        if (filePath) {
          files.add(filePath)
          toolIds.push(tool.id)
        }
      }
      if (files.size > 0) {
        const messageId = msg?.id || `m-${i}`
        return {
          batchKey: `${messageId}:${toolIds.sort().join(",")}`,
          files: Array.from(files)
        }
      }
    }
    return null
  }, [threadState?.messages, streamData.messages])

  useEffect(() => {
    const wasLoading = prevStreamLoadingRef.current
    const isLoading = streamData.isLoading
    prevStreamLoadingRef.current = isLoading

    const applyPreviewUpdate = (switchToPreview: boolean): void => {
      if (!latestResourceEvent) return
      if (lastAppliedPreviewKeyRef.current === latestResourceEvent.key) return
      lastAppliedPreviewKeyRef.current = latestResourceEvent.key
      setPreviewPath(latestResourceEvent.path)
      setPreviewDiff(latestResourceEvent.codeDiff ?? null)
      setPreviewReloadToken((v) => v + 1)
      // For diff events, keep current panel and avoid auto-switching to preview.
      const isDiffPreview = Boolean(latestResourceEvent.codeDiff)
      if (switchToPreview && !isDiffPreview) {
        onRequestPreviewMode?.()
      }
    }

    // Render preview when this round finishes: true -> false
    if (!(wasLoading && !isLoading)) return
    if (
      latestCompletedLlmBatch?.files?.length &&
      lastAutoSwitchedBatchKeyRef.current !== latestCompletedLlmBatch.batchKey
    ) {
      lastAutoSwitchedBatchKeyRef.current = latestCompletedLlmBatch.batchKey
      // Never auto-open git panel. If user is already on git, only refresh preview data silently.
      applyPreviewUpdate(moduleMode !== "git")
      return
    }

    // For non-edit resource events, respect current panel choice:
    // if user stays on git panel, don't switch away; otherwise keep preview behavior.
    applyPreviewUpdate(moduleMode !== "git")
  }, [streamData.isLoading, latestResourceEvent, latestCompletedLlmBatch, onRequestPreviewMode, moduleMode])

  useEffect(() => {
    if (!currentThreadId) return
    if (lastThreadIdRef.current !== currentThreadId) {
      lastThreadIdRef.current = currentThreadId
      setPreviewPath(null)
      setPreviewDiff(null)
      lastAppliedPreviewKeyRef.current = null
      lastRecordedBatchKeyRef.current = null
      lastAutoSwitchedBatchKeyRef.current = null
      prevStreamLoadingRef.current = false
    }
  }, [currentThreadId])

  useEffect(() => {
    if (!currentThreadId) return
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadId === currentThreadId && previewPath) {
        setPreviewReloadToken((v) => v + 1)
      }
    })
    return cleanup
  }, [currentThreadId, previewPath])

  useEffect(() => {
    const cleanup = onOpenResourcePreview(({ threadId, filePath }) => {
      if (!currentThreadId || threadId !== currentThreadId) return
      setPreviewPath(filePath)
      setPreviewDiff(null)
      setPreviewReloadToken((v) => v + 1)
      onRequestPreviewMode?.()
    })
    return cleanup
  }, [currentThreadId, onRequestPreviewMode])

  useEffect(() => {
    if (moduleMode !== "preview" || !previewPath) {
      onPreviewFullscreenChange?.(false)
    }
  }, [moduleMode, previewPath, onPreviewFullscreenChange])

  useEffect(() => {
    if (!currentThreadId || !latestCompletedLlmBatch || latestCompletedLlmBatch.files.length === 0) return
    if (lastRecordedBatchKeyRef.current === latestCompletedLlmBatch.batchKey) return
    lastRecordedBatchKeyRef.current = latestCompletedLlmBatch.batchKey
    window.api.workspace.recordLlmModifiedFiles(currentThreadId, latestCompletedLlmBatch.files).catch((error) => {
      console.error("[RightPanel] Failed to record LLM modified files:", error)
    })
  }, [currentThreadId, latestCompletedLlmBatch])

  // Store content heights in pixels (null = auto/equal distribution)
  const [tasksHeight, setTasksHeight] = useState<number | null>(null)
  const [filesHeight, setFilesHeight] = useState<number | null>(null)
  const [agentsHeight, setAgentsHeight] = useState<number | null>(null)
  const [skillsHeight, setSkillsHeight] = useState<number | null>(null)
  const [pluginsHeight, setPluginsHeight] = useState<number | null>(null)
  const [hooksHeight, setHooksHeight] = useState<number | null>(null)
  const [lspHeight, setLspHeight] = useState<number | null>(null)

  // Track drag start heights
  const dragStartHeights = useRef<{
    tasks: number
    files: number
    agents: number
    skills: number
    plugins: number
    hooks: number
    lsp: number
  } | null>(null)

  // Calculate available content height
  const getAvailableContentHeight = useCallback(() => {
    if (moduleMode !== "work") return 0
    if (!containerRef.current) return 0
    const totalHeight = containerRef.current.clientHeight

    const openPanels = [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen, hooksOpen, lspOpen]
    let used = HEADER_HEIGHT * 7
    // Fixed visual gaps between section blocks
    used += SECTION_GAP * 6

    // Count handles between consecutive open panels
    let handles = 0
    let lastOpen = false
    for (const isOpen of openPanels) {
      if (isOpen && lastOpen) handles++
      lastOpen = isOpen
    }
    used += HANDLE_HEIGHT * handles

    return Math.max(0, totalHeight - used)
  }, [moduleMode, tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen, hooksOpen, lspOpen])

  // Get current heights for each panel's content area
  const getContentHeights = useCallback(() => {
    const available = getAvailableContentHeight()
    const openCount = [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen, hooksOpen, lspOpen].filter(Boolean).length

    if (openCount === 0) {
      return { tasks: 0, files: 0, agents: 0, skills: 0, plugins: 0, hooks: 0, lsp: 0 }
    }

    const defaultHeight = available / openCount

    return {
      tasks: tasksOpen ? (tasksHeight ?? defaultHeight) : 0,
      files: filesOpen ? (filesHeight ?? defaultHeight) : 0,
      agents: agentsOpen ? (agentsHeight ?? defaultHeight) : 0,
      skills: skillsOpen ? (skillsHeight ?? defaultHeight) : 0,
      plugins: pluginsOpen ? (pluginsHeight ?? defaultHeight) : 0,
      hooks: hooksOpen ? (hooksHeight ?? defaultHeight) : 0,
      lsp: lspOpen ? (lspHeight ?? defaultHeight) : 0
    }
  }, [
    getAvailableContentHeight,
    tasksOpen,
    filesOpen,
    agentsOpen,
    skillsOpen,
    pluginsOpen,
    hooksOpen,
    lspOpen,
    tasksHeight,
    filesHeight,
    agentsHeight,
    skillsHeight,
    pluginsHeight,
    hooksHeight,
    lspHeight
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

  // Handle resize between plugins and hooks
  const handlePluginsResize = useCallback(
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
        (agentsOpen ? start.agents : 0) +
        (skillsOpen ? start.skills : 0)
      const maxForPluginsAndHooks = available - usedByUpperPanels

      let newPluginsHeight = start.plugins + totalDelta
      let newHooksHeight = start.hooks - totalDelta

      if (newPluginsHeight < MIN_CONTENT_HEIGHT) {
        newPluginsHeight = MIN_CONTENT_HEIGHT
        newHooksHeight = start.hooks + (start.plugins - MIN_CONTENT_HEIGHT)
      }
      if (newHooksHeight < MIN_CONTENT_HEIGHT) {
        newHooksHeight = MIN_CONTENT_HEIGHT
        newPluginsHeight = start.plugins + (start.hooks - MIN_CONTENT_HEIGHT)
      }

      if (newPluginsHeight + newHooksHeight > maxForPluginsAndHooks) {
        const excess = newPluginsHeight + newHooksHeight - maxForPluginsAndHooks
        if (totalDelta > 0) {
          newHooksHeight = Math.max(MIN_CONTENT_HEIGHT, newHooksHeight - excess)
        } else {
          newPluginsHeight = Math.max(MIN_CONTENT_HEIGHT, newPluginsHeight - excess)
        }
      }

      setPluginsHeight(newPluginsHeight)
      setHooksHeight(newHooksHeight)

      if (newPluginsHeight < COLLAPSE_THRESHOLD) {
        setPluginsOpen(false)
      }
      if (newHooksHeight < COLLAPSE_THRESHOLD) {
        setHooksOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, tasksOpen, filesOpen, agentsOpen, skillsOpen]
  )

  // Handle resize between hooks and lsp
  const handleHooksResize = useCallback(
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
        (agentsOpen ? start.agents : 0) +
        (skillsOpen ? start.skills : 0) +
        (pluginsOpen ? start.plugins : 0)
      const maxForHooksAndLsp = available - usedByUpperPanels

      let newHooksHeight = start.hooks + totalDelta
      let newLspHeight = start.lsp - totalDelta

      if (newHooksHeight < MIN_CONTENT_HEIGHT) {
        newHooksHeight = MIN_CONTENT_HEIGHT
        newLspHeight = start.lsp + (start.hooks - MIN_CONTENT_HEIGHT)
      }
      if (newLspHeight < MIN_CONTENT_HEIGHT) {
        newLspHeight = MIN_CONTENT_HEIGHT
        newHooksHeight = start.hooks + (start.lsp - MIN_CONTENT_HEIGHT)
      }

      if (newHooksHeight + newLspHeight > maxForHooksAndLsp) {
        const excess = newHooksHeight + newLspHeight - maxForHooksAndLsp
        if (totalDelta > 0) {
          newLspHeight = Math.max(MIN_CONTENT_HEIGHT, newLspHeight - excess)
        } else {
          newHooksHeight = Math.max(MIN_CONTENT_HEIGHT, newHooksHeight - excess)
        }
      }

      setHooksHeight(newHooksHeight)
      setLspHeight(newLspHeight)

      if (newHooksHeight < COLLAPSE_THRESHOLD) {
        setHooksOpen(false)
      }
      if (newLspHeight < COLLAPSE_THRESHOLD) {
        setLspOpen(false)
      }
    },
    [getContentHeights, getAvailableContentHeight, tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen]
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
    setHooksHeight(null)
    setLspHeight(null)
  }, [tasksOpen, filesOpen, agentsOpen, skillsOpen, pluginsOpen, hooksOpen, lspOpen])

  // Calculate heights in an effect (refs can't be accessed during render)
  const [heights, setHeights] = useState<PanelHeights>({ tasks: 0, files: 0, agents: 0, skills: 0, plugins: 0, hooks: 0, lsp: 0 })
  useEffect(() => {
    setHeights(getContentHeights())
  }, [getContentHeights])

  const allPanelsClosed = moduleMode === "work" && !tasksOpen && !filesOpen && !agentsOpen && !skillsOpen && !pluginsOpen && !hooksOpen && !lspOpen

  return (
    <aside
      ref={containerRef}
      className={cn(
        "flex w-full flex-col bg-transparent overflow-hidden",
        allPanelsClosed ? "h-auto self-start" : "h-full"
      )}
    >
      {moduleMode === "preview" && (
        <div className="flex h-full min-h-0 flex-col border border-border/75 rounded-2xl bg-background">
          <div
            className="bg-background p-2 h-full min-h-0"
            style={{ height: PREVIEW_MAX_HEIGHT }}
          >
            {previewPath ? (
              <ResourcePreview
                key={`${previewPath}:${previewReloadToken}`}
                filePath={previewPath}
                codeDiff={previewDiff}
                workspacePath={threadState?.workspacePath ?? null}
                threadId={currentThreadId ?? ""}
                reloadToken={previewReloadToken}
                onReload={() => setPreviewReloadToken((v) => v + 1)}
                onFullscreenChange={onPreviewFullscreenChange}
                onHidePreview={onRequestWorkMode}
              />
            ) : (
              <div className="h-full min-h-0 flex items-center justify-center p-4">
                <div className="w-full max-w-sm rounded-2xl border border-border/70 bg-background-elevated/80 px-5 py-6 text-center shadow-sm">
                  <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl border border-border bg-muted/30">
                    <FileText className="size-5 text-muted-foreground" />
                  </div>
                  <div className="text-sm font-semibold text-foreground">暂无可预览文件</div>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    生成或编辑文件后会自动在这里展示预览。
                    也可以在工具调用里点击预览图标快速打开。
                  </p>
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={onRequestWorkMode}
                      className="inline-flex items-center justify-center rounded-md border border-border/80 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
                    >
                      返回工作目录
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {moduleMode === "git" && (
        <div className="flex h-full min-h-0 flex-col border border-border/75 rounded-2xl bg-white">
          <div className="bg-white p-2 h-full min-h-0">
            <Suspense fallback={<LazySectionFallback label="加载 Git 面板..." />}>
              <GitPanelView
                key={currentThreadId ?? "git-panel-empty-thread"}
                threadId={currentThreadId ?? ""}
                workspacePath={threadState?.workspacePath ?? null}
                onOpenFileFolder={async (filePath) => {
                  try {
                    const resolved = resolvePreviewPaths(filePath, threadState?.workspacePath ?? null)
                    const platform = await window.electron.ipcRenderer.invoke("get-platform")
                    const normalizedPath =
                      platform === "win32" ? resolved.fullPath.replace(/\//g, "\\") : resolved.fullPath
                    await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
                  } catch (error) {
                    console.error("[GitPanel] Failed to show item in folder:", error)
                  }
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {moduleMode === "work" && (
        <>
      {/* TASKS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
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
          badge={subagents.length + (skillGenerationAgent.phase !== null ? 1 : 0)}
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

      {/* Resize handle after PLUGINS */}
      {pluginsOpen && hooksOpen && <ResizeHandle onDrag={handlePluginsResize} />}

      {/* HOOKS */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="钩子"
          icon={Webhook}
          badge={hooks.filter((h) => h.enabled).length}
          isOpen={hooksOpen}
          onToggle={() => setHooksOpen((prev) => !prev)}
        />
        {hooksOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.hooks }}>
            <HooksContent hooks={hooks} onChange={() => window.api.hooks.list().then(setHooks).catch(console.error)} />
          </div>
        )}
      </div>

      {/* Resize handle after HOOKS */}
      {hooksOpen && lspOpen && <ResizeHandle onDrag={handleHooksResize} />}

      {/* LSP */}
      <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
        <SectionHeader
          title="LSP"
          icon={Code2}
          detail={lspHeaderStatus}
          isOpen={lspOpen}
          onToggle={() => setLspOpen((prev) => !prev)}
        />
        {lspOpen && (
          <div className="overflow-auto right-panel-scroll" style={{ height: heights.lsp }}>
            <LspPanel threadId={currentThreadId} embedded statusOnly />
          </div>
        )}
      </div>
        </>
      )}
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

const RESOURCE_PREVIEW_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "pdf",
  "doc",
  "docx",
  "md",
  "markdown",
  "mdx",
  "html",
  "htm"
])

function getPathExtension(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  return ext || ""
}

function isResourcePreviewPath(filePath: string): boolean {
  const ext = getPathExtension(filePath)
  return RESOURCE_PREVIEW_EXTENSIONS.has(ext)
}

function getToolCallFilePath(toolCall: { name: string; args?: Record<string, unknown> }): string | null {
  if (toolCall.name !== "write_file" && toolCall.name !== "edit_file") return null
  const raw = toolCall.args?.path ?? toolCall.args?.file_path
  if (typeof raw !== "string" || !raw.trim()) return null
  return raw
}

function isAbsolutePath(filePath: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(filePath)
}

function resolvePreviewPaths(filePath: string, workspacePath: string | null): {
  fullPath: string
  workspaceFilePath: string
  inWorkspace: boolean
} {
  const input = filePath.trim().replace(/\\/g, "/")
  if (!workspacePath) {
    return { fullPath: input, workspaceFilePath: input, inWorkspace: false }
  }

  const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  const fullPath = isAbsolutePath(input)
    ? input
    : `${ws}/${input.replace(/^\/+/, "")}`

  const inWorkspace = fullPath === ws || fullPath.startsWith(`${ws}/`)
  if (!inWorkspace) {
    return { fullPath, workspaceFilePath: input, inWorkspace: false }
  }

  const rel = fullPath.slice(ws.length).replace(/^\/+/, "")
  return {
    fullPath,
    workspaceFilePath: `/${rel}`,
    inWorkspace: true
  }
}

interface CodeDiffPayload {
  oldValue: string
  newValue: string
}

interface PreviewEvent {
  path: string
  key: string
  codeDiff?: CodeDiffPayload
}

function buildPreviewEvent(
  toolCall: { id?: string; name: string; args?: Record<string, unknown> },
  messageId: string,
  toolIndex: number
): PreviewEvent | null {
  const filePath = getToolCallFilePath(toolCall)
  if (!filePath) return null

  const ext = getPathExtension(filePath).toLowerCase()
  const markdownLike = ext === "md" || ext === "markdown" || ext === "mdx"
  const htmlLike = ext === "html" || ext === "htm"
  const typeInfo = getFileType(filePath.split(/[\\/]/).pop() || filePath)
  const codeLike = typeInfo.type === "code" && !markdownLike && !htmlLike

  const isResource = isResourcePreviewPath(filePath)
  if (!isResource && !codeLike) return null

  const key = `${messageId}:${toolCall.id ?? `t-${toolIndex}`}:${filePath}`

  if (!codeLike) {
    return { path: filePath, key }
  }

  const args = toolCall.args || {}
  const oldValue = ((args.old_string ?? args.old_str) as string | undefined) || ""
  const newValue =
    ((args.new_string ?? args.new_str ?? args.content) as string | undefined) || ""

  if (toolCall.name === "write_file") {
    return {
      path: filePath,
      key,
      codeDiff: { oldValue: "", newValue }
    }
  }

  return {
    path: filePath,
    key,
    codeDiff: { oldValue, newValue }
  }
}

function FilesContent(): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const threadState = useThreadState(currentThreadId)
  const workspaceFiles = threadState?.workspaceFiles ?? []
  const workspacePath = threadState?.workspacePath ?? null
  const setWorkspacePath = threadState?.setWorkspacePath
  const setWorkspaceFiles = threadState?.setWorkspaceFiles

  // Load workspace path and files for current thread
  useEffect(() => {
    let cancelled = false

    async function loadWorkspace(): Promise<void> {
      if (currentThreadId && setWorkspacePath && setWorkspaceFiles) {
        const path = await window.api.workspace.get(currentThreadId)
        if (cancelled) return
        setWorkspacePath(path)

        // If a folder is linked, load files from disk
        if (path) {
          const result = await window.api.workspace.loadFromDisk(currentThreadId)
          if (cancelled) return
          if (result.success && result.files) {
            setWorkspaceFiles(result.files)
          }
        }
      }
    }
    loadWorkspace()

    return () => { cancelled = true }
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


  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 bg-background/30">
        <span
          className="text-[10px] text-muted-foreground truncate flex-1"
          title={workspacePath || undefined}
        >
          {workspacePath ? workspacePath.split("/").pop() : "未关联文件夹"}
        </span>
      </div>

      {/* File tree or empty state */}
      {workspaceFiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4 flex-1">
          <FolderTree className="size-8 mb-2 opacity-50" />
          <span>暂无工作区文件</span>
          <span className="text-xs mt-1">
            {workspacePath
              ? `已关联 ${workspacePath.split("/").pop()}`
              : "请在工作区选择器中设置文件夹"}
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

function ResourcePreview({
  filePath,
  codeDiff,
  workspacePath,
  threadId,
  reloadToken,
  onReload,
  onFullscreenChange,
  onHidePreview
}: {
  filePath: string
  codeDiff?: CodeDiffPayload | null
  workspacePath: string | null
  threadId: string
  reloadToken: number
  onReload?: () => void
  onFullscreenChange?: (isFullscreen: boolean) => void
  onHidePreview?: () => void
}): React.JSX.Element {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [previewMode, setPreviewMode] = useState<"preview" | "source">("preview")
  const [copySuccess, setCopySuccess] = useState(false)
  const extension = getPathExtension(filePath).toLowerCase()
  const supportsSourceView =
    !codeDiff &&
    (extension === "md" ||
      extension === "markdown" ||
      extension === "mdx" ||
      extension === "html" ||
      extension === "htm")
  const previewFileType = useMemo(() => getFileType(fileName), [fileName])
  const canCopyContent = !codeDiff && (previewFileType.type === "code" || previewFileType.type === "text")

  const resolved = useMemo(
    () => resolvePreviewPaths(filePath, workspacePath),
    [filePath, workspacePath]
  )
  const fullPath = resolved.fullPath

  const openInFolder = useCallback(async () => {
    try {
      const platform = await window.electron.ipcRenderer.invoke("get-platform")
      const normalizedPath = platform === "win32" ? fullPath.replace(/\//g, "\\") : fullPath
      await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
    } catch (error) {
      console.error("[ResourcePreview] Failed to show item in folder:", error)
    }
  }, [fullPath])

  const toggleFullscreen = (): void => {
    setIsFullscreen((prev) => !prev)
  }

  const handleHidePreview = (): void => {
    setIsFullscreen(false)
    onFullscreenChange?.(false)
    onHidePreview?.()
  }

  const handleCopyFileContent = useCallback(async () => {
    if (!canCopyContent) {
      toast.error("当前文件类型不支持复制内容")
      return
    }

    try {
      const result = resolved.inWorkspace
        ? await window.api.workspace.readFile(threadId, resolved.workspaceFilePath)
        : await window.api.workspace.readExternalFile(resolved.fullPath)

      if (!result.success || result.content === undefined) {
        toast.error(result.error || "复制失败，请重试")
        return
      }

      await navigator.clipboard.writeText(result.content)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
      toast.success("文件内容已复制")
    } catch (error) {
      console.error("[ResourcePreview] Failed to copy file content:", error)
      toast.error("复制失败，请重试")
    }
  }, [canCopyContent, resolved, threadId])

  useEffect(() => {
    if (!isFullscreen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setIsFullscreen(false)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [isFullscreen])

  useEffect(() => {
    onFullscreenChange?.(isFullscreen)
  }, [isFullscreen, onFullscreenChange])

  useEffect(() => {
    return () => {
      onFullscreenChange?.(false)
    }
  }, [onFullscreenChange])

  return (
    <div className="rounded-xl border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 border-b border-border/70 bg-background-elevated/70 shrink-0">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold truncate" title={filePath}>
            {fileName}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {supportsSourceView ? (
            <div className="inline-flex items-center rounded-md border border-border bg-background text-[11px]">
              <button
                type="button"
                onClick={() => setPreviewMode("preview")}
                aria-pressed={previewMode === "preview"}
                className={cn(
                  "px-2 py-0.5 transition-colors",
                  previewMode === "preview"
                    ? "bg-background-interactive text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                预览
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode("source")}
                aria-pressed={previewMode === "source"}
                className={cn(
                  "border-l border-border px-2 py-0.5 transition-colors",
                  previewMode === "source"
                    ? "bg-background-interactive text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                源码
              </button>
            </div>
          ) : null}
          <button
            onClick={handleCopyFileContent}
            disabled={!canCopyContent}
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[11px] text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-background-interactive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={canCopyContent ? "复制文件内容" : "当前文件类型不支持复制"}
            aria-label={canCopyContent ? "复制文件内容" : "当前文件类型不支持复制"}
          >
            {copySuccess ? <Check className="size-3.5 text-status-nominal" /> : <Copy className="size-3.5" />}
          </button>
          <button
            onClick={onReload}
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
            title="刷新预览"
            aria-label="刷新预览"
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            onClick={toggleFullscreen}
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
            title={isFullscreen ? "缩小全屏" : "全屏预览"}
            aria-label={isFullscreen ? "缩小全屏" : "全屏预览"}
          >
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            onClick={handleHidePreview}
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
            title="隐藏预览并切换到工作目录"
            aria-label="隐藏预览并切换到工作目录"
          >
            <EyeOff className="size-3.5" />
          </button>
          <button
            onClick={openInFolder}
            className="inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
            title="打开文件所在文件夹"
            aria-label="打开文件所在文件夹"
          >
            <FolderOpen className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="overflow-y-auto overflow-x-hidden right-panel-scroll bg-background flex-1 min-h-0">
        {codeDiff && (
          <div className="p-2">
            <DiffDisplay oldValue={codeDiff.oldValue} newValue={codeDiff.newValue} />
          </div>
        )}

        {!codeDiff && (
          <Suspense fallback={<LazySectionFallback label="加载文件预览..." />}>
            <FileViewer
              threadId={threadId}
              filePath={resolved.inWorkspace ? resolved.workspaceFilePath : resolved.fullPath}
              externalFullPath={resolved.inWorkspace ? undefined : resolved.fullPath}
              htmlFillHeight
              reloadToken={reloadToken}
              previewMode={supportsSourceView ? previewMode : undefined}
            />
          </Suspense>
        )}
      </div>
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
    const wasExpanded = prevProps.expanded.has(prevProps.node.path)
    const isExpanded = nextProps.expanded.has(nextProps.node.path)
    return (
      prevProps.node === nextProps.node &&
      wasExpanded === isExpanded &&
      // Expanded nodes render children that need the latest Set reference
      (!isExpanded || prevProps.expanded === nextProps.expanded) &&
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

function SkillGenerationCard({
  phase,
  streamedText,
  errorText,
  onDismiss,
  onRetry
}: {
  phase: "generating" | "done" | "error"
  streamedText: string
  errorText: string
  /** Called when the user dismisses an error card. */
  onDismiss?: () => void
  /** Called when the user clicks the retry button on an error card. */
  onRetry?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const statusBadge = phase === "generating"
    ? { icon: Loader2, variant: "info" as const, label: "生成中", spin: true }
    : phase === "done"
      ? { icon: CheckCircle2, variant: "nominal" as const, label: "已完成", spin: false }
      : { icon: AlertCircle, variant: "critical" as const, label: "执行失败", spin: false }

  const StatusIcon = statusBadge.icon

  return (
    <div className={cn(
      "rounded-lg border bg-card text-card-foreground shadow-sm",
      phase === "generating" && "border-status-info/50"
    )}>
      {/* Header */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium truncate">
            <Sparkles className={cn(
              "size-4 shrink-0",
              phase === "generating" ? "text-status-info" : "text-muted-foreground"
            )} />
            <span className="truncate">技能草稿生成</span>
          </div>
          <Badge variant={statusBadge.variant} className="shrink-0">
            <StatusIcon className={cn("size-3 mr-1", statusBadge.spin && "animate-spin")} />
            {statusBadge.label}
          </Badge>
        </div>
        <Badge variant="outline" className="w-fit text-[10px] mt-1">
          SKILL-GEN
        </Badge>
      </div>

      {/* Body */}
      <div className="px-3 pb-3 space-y-2">
        {phase === "error" ? (
          <>
            <p className="text-xs text-destructive">{errorText}</p>
            <div className="flex items-center justify-end gap-2 pt-1">
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 transition-colors"
                >
                  <RotateCcw className="size-3" />
                  重试
                </button>
              )}
              {onDismiss && (
                <button
                  onClick={onDismiss}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <XCircle className="size-3" />
                  关闭
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {phase === "generating" ? "AI 正在分析对话并生成技能草稿…" : "草稿已生成，等待确认"}
            </p>
            {streamedText && (
              <div className="rounded border border-border overflow-hidden">
                <button
                  className="w-full flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/40 transition-colors"
                  onClick={() => setExpanded((v) => !v)}
                >
                  <span>查看生成内容</span>
                  {expanded
                    ? <ChevronDown className="size-3" />
                    : <ChevronRight className="size-3" />
                  }
                </button>
                {expanded && (
                  <pre className="px-2 py-1.5 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto border-t border-border">
                    {streamedText}
                  </pre>
                )}
              </div>
            )}
            {phase === "generating" && onRetry && (
              <div className="flex justify-end pt-1">
                <button
                  onClick={onRetry}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="size-3" />
                  重新生成
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function AgentsContent(): React.JSX.Element {
  const { currentThreadId, skillGenerationByThread, skillRetryContextByThread, setSkillGenerationPhase } = useAppStore(
    useShallow((s) => ({
      currentThreadId: s.currentThreadId,
      skillGenerationByThread: s.skillGenerationByThread,
      skillRetryContextByThread: s.skillRetryContextByThread,
      setSkillGenerationPhase: s.setSkillGenerationPhase
    }))
  )
  const skillGenerationAgent = selectSkillGenerationAgent(
    { skillGenerationByThread } as Parameters<typeof selectSkillGenerationAgent>[0],
    currentThreadId
  )
  const skillRetryContext = selectSkillRetryContext(
    { skillRetryContextByThread } as Parameters<typeof selectSkillRetryContext>[0],
    currentThreadId
  )
  const retryInFlightRef = useRef(false)
  const threadState = useThreadState(currentThreadId)
  const subagents = threadState?.subagents ?? []

  const hasSkillGen = skillGenerationAgent.phase !== null

  const handleRetry = useCallback((): void => {
    if (!currentThreadId || !skillRetryContext || retryInFlightRef.current) return
    retryInFlightRef.current = true
    void window.api.skillEvolution.retryGeneration(currentThreadId, skillRetryContext)
      .catch((err: unknown) => {
        console.error("[SkillGen] Retry IPC failed:", err)
        setSkillGenerationPhase("error", err instanceof Error ? err.message : "重试失败")
      })
      .finally(() => { retryInFlightRef.current = false })
  }, [currentThreadId, skillRetryContext, setSkillGenerationPhase])

  if (subagents.length === 0 && !hasSkillGen) {
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
      {/* Virtual skill generation card — shown above regular subagents */}
      {hasSkillGen && (
        <SkillGenerationCard
          phase={skillGenerationAgent.phase!}
          streamedText={skillGenerationAgent.streamedText}
          errorText={skillGenerationAgent.errorText}
          onDismiss={
            skillGenerationAgent.phase === "error"
              ? () => setSkillGenerationPhase(null)
              : undefined
          }
          onRetry={
            (skillGenerationAgent.phase === "error" || skillGenerationAgent.phase === "generating") && skillRetryContext
              ? handleRetry
              : undefined
          }
        />
      )}
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

const EVENT_BADGE_COLORS: Record<string, string> = {
  PreToolUse: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PostToolUse: "bg-green-500/15 text-green-600 dark:text-green-400",
  Stop: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Notification: "bg-purple-500/15 text-purple-600 dark:text-purple-400"
}

const EVENT_LABEL: Record<string, string> = {
  PreToolUse: "调用前",
  PostToolUse: "调用后",
  Stop: "停止时",
  Notification: "通知"
}

const TOOL_LABEL: Record<string, string> = {
  execute:          "执行命令",
  write_file:       "写入文件",
  edit_file:        "编辑文件",
  read_file:        "读取文件",
  memory_search:    "搜索记忆",
  memory_get:       "读取记忆",
  manage_scheduler: "调度任务",
  manage_skill:     "技能管理",
}

function HooksContent({ hooks, onChange }: { hooks: HookConfig[]; onChange: () => void }): React.JSX.Element {
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

  const handleToggle = async (hook: HookConfig): Promise<void> => {
    try {
      await window.api.hooks.setEnabled(hook.id, !hook.enabled)
      onChange()
    } catch (e) {
      console.error("[HooksContent] Failed to toggle hook:", e)
    }
  }

  const renderHookCard = (hook: HookConfig): React.JSX.Element => {
    const isPrompt = hook.type === "prompt"
    const summary = isPrompt ? (hook.prompt ?? "") : (hook.command ?? "")
    return (
    <div
      key={hook.id}
      className={cn("p-3 rounded-sm border border-border", !hook.enabled && "opacity-60")}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0", EVENT_BADGE_COLORS[hook.event] ?? "bg-muted text-muted-foreground")}>
          {EVENT_LABEL[hook.event] ?? hook.event}
        </span>
        {isPrompt && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-violet-500/15 text-violet-600 dark:text-violet-400">
            策略
          </span>
        )}
        {hook.matcher && hook.matcher !== "*" && (
          <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
            {TOOL_LABEL[hook.matcher] ?? hook.matcher}
          </span>
        )}
        <button
          className="ml-auto shrink-0"
          onClick={() => handleToggle(hook)}
          title={hook.enabled ? "点击禁用" : "点击启用"}
        >
          <Power className={cn("size-3", hook.enabled ? "text-status-nominal" : "text-muted-foreground")} />
        </button>
      </div>
      <p className={cn(
        "text-xs text-muted-foreground mt-1.5 break-all line-clamp-2",
        isPrompt ? "italic" : "font-mono"
      )}>{summary}</p>
    </div>
  )}

  return (
    <div className="p-3 space-y-2">
      {enabled.length > 0 && enabled.map(renderHookCard)}
      {disabled.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">已禁用</span>
            <Badge variant="outline" className="text-[10px] h-5">{disabled.length}</Badge>
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
