import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  memo,
  lazy,
  Suspense
} from "react"
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
  Check,
  ShieldCheck,
  Eye,
  PackageOpen
} from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useAppStore, selectSkillGenerationAgent, selectSkillRetryContext } from "@/lib/store"
import { useShallow } from "zustand/react/shallow"
import {
  useThreadActions,
  useThreadStateSelector,
  useThreadStream,
  type CoordinatorWorkerView
} from "@/lib/thread-context"
import { getFileType } from "@/lib/file-types"
import { getToolLabel } from "@/lib/tool-labels"
import {
  hasLoadedWorkspaceFiles,
  continueWorkspaceFilesDeduped,
  getWorkspaceFilePathRevision,
  loadWorkspaceFilesDeduped,
  markWorkspaceFilesStale,
  normalizeWorkspaceFileKey,
  readWorkspacePathWithFallback,
  subscribeWorkspaceFilePathChanges,
  subscribeWorkspaceFileResults
} from "@/lib/workspace-file-load"
import { WorkspaceFileRequestFence } from "@/lib/workspace-file-request-fence"
import {
  buildWorkspaceFileTreeProjection,
  getWorkspaceFileTreeProjection,
  type WorkspaceFileTreeFile,
  type WorkspaceFileTreeNode
} from "@/lib/workspace-file-tree-projection"
import { Badge } from "@/components/ui/badge"
import { emitOpenResourcePreview, onOpenResourcePreview } from "@/lib/resource-preview-events"
import { marketApi, type MarketItem } from "@/api/market"
import type { Todo, SkillMetadata, PluginMetadata, LspConfig, LspStatus } from "@/types"
import { SubagentCard } from "@/components/panels/SubagentPanel"
import { LspPanel } from "@/components/customize/LspPanel"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import {
  ensureDisabledSkillsChangedInvalidationSource,
  ensureSkillsChangedInvalidationSource,
  ensureWorkspaceHooksChangedInvalidationSource,
  getGlobalHookCatalogRevision,
  getPluginCatalogRevision,
  getSkillCatalogRevision,
  getWorkspaceHookCatalogRevision,
  readMarketSkillCatalogCache,
  readPluginCatalogCache,
  readSkillCatalogCache,
  revalidateMarketSkillCatalog,
  revalidatePluginCatalog,
  revalidateSkillCatalog,
  subscribeGlobalHookCatalogInvalidation,
  subscribePluginCatalogInvalidation,
  subscribeSkillCatalogInvalidation,
  subscribeWorkspaceHookCatalogInvalidation
} from "@/lib/app-catalog-cache"
import { getHookCatalogIdentity } from "@/lib/hook-catalog-identity"
import {
  getRightPanelSkillProjection,
  getRightPanelSkillProjectionAsync,
  type RightPanelSkillGroupProjection,
  type RightPanelSkillProjection,
  type RightPanelSkillTreeNode
} from "@/components/panels/right-panel-skill-projection"
import {
  RIGHT_PANEL_INITIAL_RENDER_ITEMS,
  RIGHT_PANEL_RENDER_PAGE_ITEMS,
  selectRightPanelPrioritizedWindow,
  selectRightPanelWindow
} from "@/components/panels/right-panel-render-window"
import {
  ensureHarnessPluginRunArtifactPreviewAuthorization,
  getHarnessPluginRunArtifactsSnapshot,
  isHarnessPluginRunArtifactGrantFresh,
  subscribeHarnessPluginRunArtifacts,
  resolveHarnessPluginRunArtifactPath,
  type HarnessPluginRunArtifactPreviewAuthorization,
  type HarnessPluginRunArtifactsContext
} from "@/lib/harness-plugin-run-artifacts"
import {
  getSystemConstraintsLoadCounts,
  SystemConstraintsPanel
} from "@/components/panels/SystemConstraintsPanel"
import {
  createCompletedResourceProjector,
  getPathExtension,
  type ResourceMessage
} from "@/lib/latest-completed-resource"

type HookConfig = Awaited<ReturnType<typeof window.api.hooks.list>>[number]
type PluginHookMetadata = Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]
type SkillHookMetadata = Awaited<ReturnType<typeof window.api.hooks.skills.list>>[number]
type RightPanelSkillMarketInfo = Pick<MarketItem, "name" | "chinese_name">
type DisplayHook = HookConfig & {
  source: "global" | "workspace" | "plugin" | "skill"
  pluginId?: string
  pluginName?: string
  skillName?: string
  skillPath?: string
  hookPath?: string
}

const FileViewer = lazy(() =>
  import("@/components/tabs/FileViewer").then((m) => ({ default: m.FileViewer }))
)
const GitPanelView = lazy(() =>
  import("@/components/panels/GitPanelView").then((m) => ({ default: m.GitPanelView }))
)
const BrowserPanel = lazy(() =>
  import("@/components/browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel }))
)

const HEADER_HEIGHT = 52 // px
const HANDLE_HEIGHT = 6 // px
const SECTION_GAP = 8 // px
const MIN_CONTENT_HEIGHT = 60 // px
const COLLAPSE_THRESHOLD = 55 // px - auto-collapse when below this
const PREVIEW_MAX_HEIGHT = "100vh"
const RIGHT_PANEL_SYNC_SKILL_PROJECTION_LIMIT = 256
const RIGHT_PANEL_HOOK_SCOPE = "right-panel"
const RIGHT_PANEL_GLOBAL_SUMMARY_SCOPE = "right-panel-global-summary"
const RIGHT_PANEL_HOOK_SUMMARY_SCOPE = "right-panel-hook-summary"
const RIGHT_PANEL_HOOK_REFRESH_DEBOUNCE_MS = 50

interface CatalogHeaderValue {
  total: number
  enabled?: number
  truncated: boolean
  truncatedReasons: string[]
}

interface HeaderSummaryState {
  value: CatalogHeaderValue | null
  loading: boolean
  error: boolean
}

interface HookDetailState {
  key: string
  hooks: DisplayHook[]
  truncated: boolean
}

type PanelHeights = {
  tasks: number
  files: number
  pluginRunArtifacts: number
  systemConstraints: number
  agents: number
  skills: number
  plugins: number
  hooks: number
  lsp: number
}

interface SectionHeaderProps {
  title: string
  icon: React.ElementType
  badge?: number | null
  badgeTitle?: string
  badgeTruncated?: boolean
  detail?: React.ReactNode
  loading?: boolean
  error?: boolean
  isOpen: boolean
  onToggle: () => void
}

function SectionHeader({
  title,
  icon: Icon,
  badge,
  badgeTitle,
  badgeTruncated = false,
  detail,
  loading = false,
  error = false,
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
      {detail != null && <div className="shrink-0">{detail}</div>}
      {badge !== undefined && badge !== null && (
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={badgeTitle}
        >
          {badge}
          {badgeTruncated ? "+" : ""}
        </span>
      )}
      {loading && (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label={`${title}摘要加载中`}
        />
      )}
      {!loading && error && (
        <AlertCircle
          className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-label={`${title}摘要加载失败`}
        />
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
      let frame: number | null = null
      let latestDelta = 0

      const flushDrag = (): void => {
        frame = null
        onDrag(latestDelta)
      }

      const scheduleDrag = (delta: number): void => {
        latestDelta = delta
        if (frame === null) {
          frame = window.requestAnimationFrame(flushDrag)
        }
      }

      const handleMouseMove = (e: MouseEvent): void => {
        // Calculate total delta from drag start
        const totalDelta = e.clientY - startYRef.current
        scheduleDrag(totalDelta)
      }

      const handleMouseUp = (): void => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
          onDrag(latestDelta)
        }
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
  threadId?: string | null
  moduleMode: "work" | "preview" | "git" | "browser"
  showSystemConstraints?: boolean
  onRequestPreviewMode?: () => void
  onRequestWorkMode?: () => void
  onRequestBrowserMode?: () => void
  onPreviewFullscreenChange?: (isFullscreen: boolean) => void
  onBrowserFullscreenChange?: (isFullscreen: boolean) => void
}

interface PreviewExternalAuthorization {
  threadId: string
  filePath: string
  grant: string
  expiresAt?: number
  projectId?: string
  slug?: string
}

function toHarnessArtifactPreviewAuthorization(
  authorization: PreviewExternalAuthorization
): HarnessPluginRunArtifactPreviewAuthorization | null {
  if (
    typeof authorization.expiresAt !== "number" ||
    !Number.isFinite(authorization.expiresAt) ||
    !authorization.projectId ||
    !authorization.slug
  ) {
    return null
  }
  return {
    grant: authorization.grant,
    expiresAt: authorization.expiresAt,
    projectId: authorization.projectId,
    slug: authorization.slug,
    filePath: authorization.filePath
  }
}

function previewExternalAuthorizationIdentity(
  authorization: PreviewExternalAuthorization
): string {
  return [
    authorization.threadId,
    authorization.projectId ?? "",
    authorization.slug ?? "",
    authorization.filePath
  ].join("\u0000")
}

function LazySectionFallback({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

const RightPanelStreamEffects = memo(function RightPanelStreamEffects({
  threadId,
  moduleMode,
  onApplyPreview
}: {
  threadId: string
  moduleMode: RightPanelProps["moduleMode"]
  onApplyPreview: (path: string, switchToPreview: boolean) => void
}): null {
  const streamData = useThreadStream(threadId)
  const persistedMessages = useThreadStateSelector(threadId, (state) => state.messages) ?? []
  const [projectCompletedResources] = useState(() => createCompletedResourceProjector())
  const previousLoadingRef = useRef(false)
  const lastAppliedPreviewKeyRef = useRef<string | null>(null)
  const lastRecordedBatchKeyRef = useRef<string | null>(null)
  const lastAutoSwitchedBatchKeyRef = useRef<string | null>(null)
  const { latestResourceEvent, latestCompletedLlmBatch } = projectCompletedResources(
    persistedMessages,
    (streamData.messages as ResourceMessage[] | undefined) ?? []
  )

  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    const isLoading = streamData.isLoading
    previousLoadingRef.current = isLoading
    if (!(wasLoading && !isLoading) || !latestResourceEvent) return

    const applyPreviewUpdate = (switchToPreview: boolean): void => {
      if (lastAppliedPreviewKeyRef.current === latestResourceEvent.key) return
      lastAppliedPreviewKeyRef.current = latestResourceEvent.key
      onApplyPreview(latestResourceEvent.path, switchToPreview)
    }
    if (
      latestCompletedLlmBatch?.files.length &&
      lastAutoSwitchedBatchKeyRef.current !== latestCompletedLlmBatch.batchKey
    ) {
      lastAutoSwitchedBatchKeyRef.current = latestCompletedLlmBatch.batchKey
      applyPreviewUpdate(moduleMode !== "git" && moduleMode !== "browser")
      return
    }
    applyPreviewUpdate(moduleMode !== "git" && moduleMode !== "browser")
  }, [
    latestCompletedLlmBatch,
    latestResourceEvent,
    moduleMode,
    onApplyPreview,
    streamData.isLoading
  ])

  useEffect(() => {
    if (!latestCompletedLlmBatch?.files.length) return
    if (lastRecordedBatchKeyRef.current === latestCompletedLlmBatch.batchKey) return
    lastRecordedBatchKeyRef.current = latestCompletedLlmBatch.batchKey
    window.api.workspace
      .recordLlmModifiedFiles(threadId, latestCompletedLlmBatch.files)
      .catch((error) => {
        console.error("[RightPanel] Failed to record LLM modified files:", error)
      })
  }, [latestCompletedLlmBatch, threadId])

  return null
})

export function RightPanel({
  threadId,
  moduleMode,
  showSystemConstraints = false,
  onRequestPreviewMode,
  onRequestWorkMode,
  onRequestBrowserMode,
  onPreviewFullscreenChange,
  onBrowserFullscreenChange
}: RightPanelProps): React.JSX.Element {
  const {
    currentThreadId: storeCurrentThreadId,
    pluginVersion,
    rightPanelWorkRequest,
    skillGenerationByThread,
    setSkillGenerationPhase
  } = useAppStore(
    useShallow((s) => ({
      currentThreadId: s.currentThreadId,
      pluginVersion: s.pluginVersion,
      rightPanelWorkRequest: s.rightPanelWorkRequest,
      // Subscribe to the whole map so we re-render when any thread's card changes
      skillGenerationByThread: s.skillGenerationByThread,
      setSkillGenerationPhase: s.setSkillGenerationPhase
    }))
  )
  const currentThreadId = threadId ?? storeCurrentThreadId
  const pluginRunArtifacts = useSyncExternalStore(
    subscribeHarnessPluginRunArtifacts,
    getHarnessPluginRunArtifactsSnapshot,
    getHarnessPluginRunArtifactsSnapshot
  )
  const activePluginRunArtifacts = useMemo(
    () =>
      currentThreadId && pluginRunArtifacts?.threadIds.includes(currentThreadId)
        ? pluginRunArtifacts
        : null,
    [currentThreadId, pluginRunArtifacts]
  )
  const canMutateCurrentThreadState = currentThreadId === storeCurrentThreadId
  // Derive the current thread's card state from the per-thread map
  const skillGenerationAgent = selectSkillGenerationAgent(
    { skillGenerationByThread } as Parameters<typeof selectSkillGenerationAgent>[0],
    currentThreadId
  )
  const todos = useThreadStateSelector(currentThreadId, (state) => state.todos) ?? []
  const workspaceFiles =
    useThreadStateSelector(currentThreadId, (state) => state.workspaceFiles) ?? []
  const subagents = useThreadStateSelector(currentThreadId, (state) => state.subagents) ?? []
  const coordinatorWorkers =
    useThreadStateSelector(currentThreadId, (state) => state.coordinatorWorkers) ?? []
  const workspacePath = useThreadStateSelector(currentThreadId, (state) => state.workspacePath)
  const gitContext = useThreadStateSelector(currentThreadId, (state) => state.gitContext)
  const harnessAgentmdLoadStatus = useThreadStateSelector(
    currentThreadId,
    (state) => state.harnessAgentmdLoadStatus
  )
  const systemConstraintCounts = getSystemConstraintsLoadCounts(
    showSystemConstraints ? harnessAgentmdLoadStatus : null
  )
  const runningSubagentIdsRef = useRef<Set<string>>(new Set())
  const runningCoordinatorWorkerRunKeysRef = useRef<Set<string>>(new Set())
  const handledWorkRequestIdsRef = useRef<Set<number>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const previewThreadIdRef = useRef<string | null>(null)
  const [previewExternalAuthorization, setPreviewExternalAuthorization] =
    useState<PreviewExternalAuthorization | null>(null)
  const previewExternalAuthorizationRef = useRef<PreviewExternalAuthorization | null>(null)
  const previewExternalGrantRefreshPromiseRef = useRef<{
    identity: string
    marker: object
    promise: Promise<PreviewExternalAuthorization>
  } | null>(null)
  const replacePreviewExternalAuthorization = useCallback(
    (authorization: PreviewExternalAuthorization | null): void => {
      previewExternalAuthorizationRef.current = authorization
      setPreviewExternalAuthorization(authorization)
    },
    []
  )
  const resolveCurrentExternalPreviewGrant = useCallback(async (): Promise<string> => {
    const current = previewExternalAuthorizationRef.current
    if (!current) throw new Error("当前外部文件预览没有可信来源授权")
    const renewable = toHarnessArtifactPreviewAuthorization(current)
    if (!renewable) return current.grant
    if (
      isHarnessPluginRunArtifactGrantFresh(
        renewable.grant,
        renewable.expiresAt
      )
    ) {
      return renewable.grant
    }

    const identity = previewExternalAuthorizationIdentity(current)
    let pending = previewExternalGrantRefreshPromiseRef.current
    if (!pending || pending.identity !== identity) {
      const marker = {}
      const promise = (async (): Promise<PreviewExternalAuthorization> => {
        try {
          const refreshed = await ensureHarnessPluginRunArtifactPreviewAuthorization(
            renewable,
            (input) => window.api.harnessBoard.refreshRunArtifactGrant(input)
          )
          const latest = previewExternalAuthorizationRef.current
          if (!latest || previewExternalAuthorizationIdentity(latest) !== identity) {
            throw new Error("产物预览已切换，已忽略过期授权续签")
          }
          const next = {
            ...latest,
            grant: refreshed.grant,
            expiresAt: refreshed.expiresAt
          }
          replacePreviewExternalAuthorization(next)
          return next
        } finally {
          if (previewExternalGrantRefreshPromiseRef.current?.marker === marker) {
            previewExternalGrantRefreshPromiseRef.current = null
          }
        }
      })()
      pending = { identity, marker, promise }
      previewExternalGrantRefreshPromiseRef.current = pending
    }
    return (await pending.promise).grant
  }, [replacePreviewExternalAuthorization])
  const [previewReloadToken, setPreviewReloadToken] = useState(0)
  const lastThreadIdRef = useRef<string | null>(null)
  // A thread switch renders before its cleanup effect runs. Gate the preview
  // synchronously so the new thread never receives the previous thread's path
  // or external capability during that transition frame.
  const previewPathForCurrentThread =
    currentThreadId && previewThreadIdRef.current === currentThreadId ? previewPath : null
  const previewExternalAuthorizationForCurrentThread =
    previewPathForCurrentThread &&
    previewExternalAuthorization?.threadId === currentThreadId &&
    previewExternalAuthorization.filePath === previewPathForCurrentThread
      ? previewExternalAuthorization
      : null
  const [tasksOpen, setTasksOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [pluginRunArtifactsOpen, setPluginRunArtifactsOpen] = useState(false)
  const [systemConstraintsOpen, setSystemConstraintsOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [hooksOpen, setHooksOpen] = useState(false)
  const [lspOpen, setLspOpen] = useState(false)
  const [lspConfig, setLspConfig] = useState<LspConfig | null>(null)
  const [lspStatus, setLspStatus] = useState<LspStatus | null>(null)
  const [skills, setSkills] = useState<SkillMetadata[]>(
    () => readSkillCatalogCache()?.rightPanelSkills ?? []
  )
  const [marketSkillMap, setMarketSkillMap] = useState<Record<string, RightPanelSkillMarketInfo>>(
    () => readMarketSkillCatalogCache()?.skillMap ?? {}
  )
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(
    () => readSkillCatalogCache()?.disabledSkillIds ?? new Set()
  )
  const [skillSummary, setSkillSummary] = useState<HeaderSummaryState>(() => {
    const snapshot = readSkillCatalogCache()
    return {
      value: snapshot
        ? {
            total: snapshot.total,
            enabled: snapshot.rightPanelEnabledSkillCount,
            truncated: snapshot.truncated,
            truncatedReasons: snapshot.truncatedReasons
          }
        : null,
      loading: false,
      error: false
    }
  })
  const [plugins, setPlugins] = useState<PluginMetadata[]>(
    () => readPluginCatalogCache()?.plugins ?? []
  )
  const [pluginSummary, setPluginSummary] = useState<HeaderSummaryState>(() => {
    const snapshot = readPluginCatalogCache()
    return {
      value: snapshot
        ? {
            total: snapshot.total,
            truncated: snapshot.truncated,
            truncatedReasons: snapshot.truncatedReasons
          }
        : null,
      loading: false,
      error: false
    }
  })
  const [, setHookCatalogRevision] = useState(0)
  const currentGlobalHookWorkerRevision =
    `${getSkillCatalogRevision(pluginVersion)}:${getPluginCatalogRevision(pluginVersion)}:` +
    `${getGlobalHookCatalogRevision()}`
  const currentHookWorkerRevision =
    `${currentGlobalHookWorkerRevision}:${getWorkspaceHookCatalogRevision(workspacePath)}`
  const currentHookCatalogKey = useMemo(
    () =>
      JSON.stringify([
        currentHookWorkerRevision,
        workspacePath ? normalizeWorkspaceFileKey(workspacePath) : ""
      ]),
    [currentHookWorkerRevision, workspacePath]
  )
  const [hookSummary, setHookSummary] = useState<HeaderSummaryState & { key: string }>({
    key: "",
    value: null,
    loading: false,
    error: false
  })
  const [globalHookSummary, setGlobalHookSummary] = useState<HeaderSummaryState>({
    value: null,
    loading: false,
    error: false
  })
  const [hookDetail, setHookDetail] = useState<HookDetailState>({
    key: "",
    hooks: [],
    truncated: false
  })
  const [lspConfigLoading, setLspConfigLoading] = useState(false)
  const [lspConfigError, setLspConfigError] = useState(false)
  const skillsCatalogRequestIdRef = useRef(0)
  const pluginCatalogRequestIdRef = useRef(0)
  const hooksCatalogRequestIdRef = useRef(0)
  const globalSummaryRequestIdRef = useRef(0)
  const hookSummaryRequestIdRef = useRef(0)
  const globalSummaryPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const lspConfigRequestIdRef = useRef(0)

  useEffect(() => {
    setHookDetail({ key: currentHookCatalogKey, hooks: [], truncated: false })
  }, [currentHookCatalogKey])

  useEffect(() => {
    setLspStatus(null)
  }, [lspOpen, workspacePath])

  const loadSkillCatalog = useCallback(async (): Promise<void> => {
    const requestId = ++skillsCatalogRequestIdRef.current
    try {
      const snapshot = await revalidateSkillCatalog(pluginVersion)
      if (requestId !== skillsCatalogRequestIdRef.current) return
      setSkills(snapshot.rightPanelSkills)
      setDisabledSkills(snapshot.disabledSkillIds)
      setSkillSummary({
        value: {
          total: snapshot.total,
          enabled: snapshot.rightPanelEnabledSkillCount,
          truncated: snapshot.truncated,
          truncatedReasons: snapshot.truncatedReasons
        },
        loading: false,
        error: false
      })
    } catch (error) {
      console.error("[RightPanel] Failed to load skills:", error)
    }
  }, [pluginVersion])

  useEffect(() => {
    if (!skillsOpen) return undefined
    if (moduleMode !== "work") return undefined
    void loadSkillCatalog()
    return () => {
      skillsCatalogRequestIdRef.current += 1
    }
  }, [loadSkillCatalog, moduleMode, skillsOpen])

  useEffect(() => {
    ensureSkillsChangedInvalidationSource((listener) => window.api.skills.onChanged(listener))
    ensureDisabledSkillsChangedInvalidationSource((listener) =>
      window.api.hooks.onChanged(listener)
    )
    ensureWorkspaceHooksChangedInvalidationSource((listener) =>
      window.api.hooks.workspace.onChanged(listener)
    )
  }, [])

  useEffect(() => {
    if (!skillsOpen) return undefined
    if (moduleMode !== "work") return undefined
    const unsubscribe = subscribeSkillCatalogInvalidation(() => {
      void loadSkillCatalog()
    })
    return unsubscribe
  }, [loadSkillCatalog, moduleMode, skillsOpen])

  const loadPluginCatalog = useCallback(async (): Promise<void> => {
    const requestId = ++pluginCatalogRequestIdRef.current
    try {
      const snapshot = await revalidatePluginCatalog(pluginVersion)
      if (requestId !== pluginCatalogRequestIdRef.current) return
      setPlugins(snapshot.plugins)
      setPluginSummary({
        value: {
          total: snapshot.total,
          truncated: snapshot.truncated,
          truncatedReasons: snapshot.truncatedReasons
        },
        loading: false,
        error: false
      })
    } catch (error) {
      console.error("[RightPanel] Failed to load plugins:", error)
    }
  }, [pluginVersion])

  useEffect(() => {
    if (!pluginsOpen) return undefined
    if (moduleMode !== "work") return undefined
    void loadPluginCatalog()
    return () => {
      pluginCatalogRequestIdRef.current += 1
    }
  }, [loadPluginCatalog, moduleMode, pluginsOpen])

  useEffect(() => {
    if (!pluginsOpen) return undefined
    if (moduleMode !== "work") return undefined
    return subscribePluginCatalogInvalidation(() => {
      void loadPluginCatalog()
    })
  }, [loadPluginCatalog, moduleMode, pluginsOpen])

  useEffect(() => {
    if (!skillsOpen) return undefined
    if (moduleMode !== "work") return undefined
    let cancelled = false

    const loadMarketSkills = async (): Promise<void> => {
      try {
        const snapshot = await revalidateMarketSkillCatalog(async () => {
          const response = await marketApi.getSkills()
          if (!response.success || !response.data) {
            throw new Error(response.error || "Failed to load market skills")
          }
          return response.data
        })
        if (!cancelled) setMarketSkillMap(snapshot.skillMap)
      } catch (error) {
        console.warn("[RightPanel] Failed to load market skills:", error)
      }
    }

    void loadMarketSkills()

    return () => {
      cancelled = true
    }
  }, [moduleMode, skillsOpen])

  const refreshLspConfig = useCallback(async (): Promise<void> => {
    const requestId = ++lspConfigRequestIdRef.current
    setLspConfigLoading(true)
    setLspConfigError(false)
    try {
      const config = await window.api.lsp.getConfig()
      if (requestId !== lspConfigRequestIdRef.current) return
      setLspConfig(config)
      setLspConfigLoading(false)
    } catch (error) {
      if (requestId !== lspConfigRequestIdRef.current) return
      console.error("[RightPanel] Failed to load LSP config summary:", error)
      setLspConfigLoading(false)
      setLspConfigError(true)
    }
  }, [])

  useEffect(() => {
    if (moduleMode !== "work") return undefined
    const timer = window.setTimeout(() => void refreshLspConfig(), 0)
    const unsubscribe = window.api.lsp.onChanged(() => void refreshLspConfig())
    return () => {
      window.clearTimeout(timer)
      lspConfigRequestIdRef.current += 1
      unsubscribe()
    }
  }, [moduleMode, refreshLspConfig])

  const handleLspSummaryChange = useCallback(
    ({ config, status }: { config: LspConfig; status: LspStatus | null }): void => {
      setLspConfig(config)
      setLspConfigLoading(false)
      setLspConfigError(false)
      const expectedProjectRoot = config.enabled ? (workspacePath ?? null) : null
      const matchesWorkspace =
        status !== null &&
        ((status.projectRoot === null && expectedProjectRoot === null) ||
          (status.projectRoot !== null &&
            expectedProjectRoot !== null &&
            normalizeWorkspaceFileKey(status.projectRoot) ===
              normalizeWorkspaceFileKey(expectedProjectRoot)))
      setLspStatus(matchesWorkspace ? status : null)
    },
    [workspacePath]
  )

  // Auto-open agents panel when skill generation starts
  useEffect(() => {
    if (skillGenerationAgent.phase === "generating") {
      setAgentsOpen(true)
    }
  }, [skillGenerationAgent.phase])

  useEffect(() => {
    setSystemConstraintsOpen(false)
  }, [currentThreadId])

  useEffect(() => {
    if (!showSystemConstraints) return
    if (rightPanelWorkRequest?.target !== "systemConstraints") return
    if (rightPanelWorkRequest.threadId !== currentThreadId) return
    if (handledWorkRequestIdsRef.current.has(rightPanelWorkRequest.id)) return
    handledWorkRequestIdsRef.current.add(rightPanelWorkRequest.id)
    setSystemConstraintsOpen(true)
  }, [currentThreadId, rightPanelWorkRequest, showSystemConstraints])

  // Auto-open once when an ordinary task subagent starts.
  useEffect(() => {
    const runningIds = new Set(
      subagents.filter((subagent) => subagent.status === "running").map((subagent) => subagent.id)
    )
    const hasNewRunning = Array.from(runningIds).some(
      (id) => !runningSubagentIdsRef.current.has(id)
    )

    if (hasNewRunning) {
      setAgentsOpen(true)
    }

    runningSubagentIdsRef.current = runningIds
  }, [subagents])

  // Auto-open once when an async coordinator worker starts or continues.
  useEffect(() => {
    const runningKeys = new Set(
      coordinatorWorkers
        .filter((worker) => worker.status === "running")
        .map(
          (worker) =>
            `${worker.worker_id}:${worker.turns ?? 0}:${worker.last_started_at ?? worker.created_at}`
        )
    )
    const hasNewRunning = Array.from(runningKeys).some(
      (key) => !runningCoordinatorWorkerRunKeysRef.current.has(key)
    )

    if (hasNewRunning) {
      setAgentsOpen(true)
    }

    runningCoordinatorWorkerRunKeysRef.current = runningKeys
  }, [coordinatorWorkers])

  const lspHeaderStatus = useMemo(() => {
    if (!lspConfig) return null

    const expectedProjectRoot = lspConfig.enabled ? (workspacePath ?? null) : null
    const statusMatchesWorkspace =
      lspStatus !== null &&
      ((lspStatus.projectRoot === null && expectedProjectRoot === null) ||
        (lspStatus.projectRoot !== null &&
          expectedProjectRoot !== null &&
          normalizeWorkspaceFileKey(lspStatus.projectRoot) ===
            normalizeWorkspaceFileKey(expectedProjectRoot)))
    const currentStatus = statusMatchesWorkspace ? lspStatus : null

    const statusText = !lspConfig.enabled
      ? "已禁用"
      : currentThreadId && !workspacePath
        ? "未关联工作目录"
        : (currentStatus?.statusText ?? "已启用")

    const statusClass = cn(
      "text-xs font-medium tabular-nums",
      currentStatus?.lifecycle === "ready"
        ? "text-green-500"
        : currentStatus?.lifecycle === "degraded"
          ? "text-amber-600 dark:text-amber-400"
          : currentStatus?.lifecycle === "starting" || currentStatus?.lifecycle === "importing"
            ? "text-sky-600 dark:text-sky-400"
            : currentStatus?.lifecycle === "error"
              ? "text-destructive"
              : "text-muted-foreground"
    )

    return <span className={statusClass}>{statusText}</span>
  }, [currentThreadId, lspConfig, lspStatus, workspacePath])

  // Auto-clear only for "done" phase (3 s brief confirmation).
  // "error" is intentionally NOT auto-cleared — it stays visible so the user
  // can read the error, and must be dismissed manually via the ✕ button on the card.
  useEffect(() => {
    if (canMutateCurrentThreadState && skillGenerationAgent.phase === "done") {
      const t = setTimeout(() => setSkillGenerationPhase(null), 3000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [canMutateCurrentThreadState, skillGenerationAgent.phase, setSkillGenerationPhase])

  // Log skill generation errors to the console for easier diagnosis on Windows
  useEffect(() => {
    if (skillGenerationAgent.phase === "error") {
      console.error("[SkillGen] 技能生成失败:", skillGenerationAgent.errorText)
    }
  }, [skillGenerationAgent.phase, skillGenerationAgent.errorText])

  const refreshGlobalCatalogSummary = useCallback(async (): Promise<void> => {
    const requestId = ++globalSummaryRequestIdRef.current
    setSkillSummary((previous) => ({ ...previous, loading: true, error: false }))
    setPluginSummary((previous) => ({ ...previous, loading: true, error: false }))
    setGlobalHookSummary((previous) => ({ ...previous, loading: true, error: false }))
    try {
      const page = await window.api.hooks.catalog.read({
        requestScope: RIGHT_PANEL_GLOBAL_SUMMARY_SCOPE,
        revision: currentGlobalHookWorkerRevision,
        limit: 1
      })
      if (requestId !== globalSummaryRequestIdRef.current) return
      setSkillSummary({
        value: {
          total: page.relatedSummary.skillEntries,
          enabled: page.relatedSummary.enabledSkillEntries,
          truncated: page.relatedSummary.skillTruncated,
          truncatedReasons: page.relatedSummary.skillTruncatedReasons
        },
        loading: false,
        error: false
      })
      setPluginSummary({
        value: {
          total: page.relatedSummary.pluginEntries,
          truncated: page.relatedSummary.pluginTruncated,
          truncatedReasons: page.relatedSummary.pluginTruncatedReasons
        },
        loading: false,
        error: false
      })
      setGlobalHookSummary({
        value: {
          total: page.totalEntries,
          enabled: page.enabledEntries,
          truncated: page.truncated,
          truncatedReasons: page.truncatedReasons
        },
        loading: false,
        error: false
      })
    } catch (error) {
      if (requestId !== globalSummaryRequestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      if (/cancel|supersed|HOOK_CATALOG_CANCELLED/i.test(message)) return
      console.error("[RightPanel] Failed to load global catalog summary:", error)
      setSkillSummary((previous) => ({ ...previous, loading: false, error: true }))
      setPluginSummary((previous) => ({ ...previous, loading: false, error: true }))
      setGlobalHookSummary((previous) => ({ ...previous, loading: false, error: true }))
    }
  }, [currentGlobalHookWorkerRevision])

  useEffect(() => {
    if (moduleMode !== "work") return undefined
    const promise = refreshGlobalCatalogSummary()
    globalSummaryPromiseRef.current = promise
    return () => {
      globalSummaryRequestIdRef.current += 1
      void window.api.hooks.catalog.cancel(RIGHT_PANEL_GLOBAL_SUMMARY_SCOPE).catch(() => undefined)
    }
  }, [moduleMode, refreshGlobalCatalogSummary])

  const refreshWorkspaceHookSummary = useCallback(async (): Promise<void> => {
    if (!workspacePath) return
    const requestId = ++hookSummaryRequestIdRef.current
    const key = currentHookCatalogKey
    setHookSummary((previous) => ({
      key,
      value: previous.key === key ? previous.value : null,
      loading: true,
      error: false
    }))
    await globalSummaryPromiseRef.current
    if (requestId !== hookSummaryRequestIdRef.current) return
    try {
      const page = await window.api.hooks.catalog.read({
        requestScope: RIGHT_PANEL_HOOK_SUMMARY_SCOPE,
        workspacePath,
        revision: currentHookWorkerRevision,
        limit: 1
      })
      if (requestId !== hookSummaryRequestIdRef.current) return
      setHookSummary({
        key,
        value: {
          total: page.totalEntries,
          enabled: page.enabledEntries,
          truncated: page.truncated,
          truncatedReasons: page.truncatedReasons
        },
        loading: false,
        error: false
      })
    } catch (error) {
      if (requestId !== hookSummaryRequestIdRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      if (/cancel|supersed|HOOK_CATALOG_CANCELLED/i.test(message)) return
      console.error("[RightPanel] Failed to load workspace hook summary:", error)
      setHookSummary((previous) =>
        previous.key === key ? { ...previous, loading: false, error: true } : previous
      )
    }
  }, [currentHookCatalogKey, currentHookWorkerRevision, workspacePath])

  useEffect(() => {
    if (moduleMode !== "work" || !workspacePath) return undefined
    void refreshWorkspaceHookSummary()
    return () => {
      hookSummaryRequestIdRef.current += 1
      void window.api.hooks.catalog.cancel(RIGHT_PANEL_HOOK_SUMMARY_SCOPE).catch(() => undefined)
    }
  }, [moduleMode, refreshWorkspaceHookSummary, workspacePath])

  const loadHooks = useCallback(async (): Promise<void> => {
    const requestId = ++hooksCatalogRequestIdRef.current
    const key = currentHookCatalogKey
    setHookDetail((previous) =>
      previous.key === key ? previous : { key, hooks: [], truncated: false }
    )
    try {
      await globalSummaryPromiseRef.current
      if (requestId !== hooksCatalogRequestIdRef.current) return
      const globalHooks: HookConfig[] = []
      const workspaceHooks: HookConfig[] = []
      const pluginHooks: PluginHookMetadata[] = []
      const skillHooks: SkillHookMetadata[] = []
      let cursor: string | undefined
      let truncated = false
      const truncatedReasons = new Set<string>()
      let totalEntries = 0
      let enabledEntries = 0
      do {
        const previousCursor = cursor
        const page = await window.api.hooks.catalog.read({
          requestScope: RIGHT_PANEL_HOOK_SCOPE,
          ...(workspacePath ? { workspacePath } : {}),
          revision: currentHookWorkerRevision,
          ...(cursor ? { cursor } : {}),
          limit: RIGHT_PANEL_INITIAL_RENDER_ITEMS
        })
        if (requestId !== hooksCatalogRequestIdRef.current) return
        globalHooks.push(...page.globalHooks)
        workspaceHooks.push(...page.workspaceHooks)
        pluginHooks.push(...page.pluginHooks)
        skillHooks.push(...page.skillHooks)
        truncated ||= page.truncated
        for (const reason of page.truncatedReasons) truncatedReasons.add(reason)
        totalEntries = page.totalEntries
        enabledEntries = page.enabledEntries
        cursor = page.nextCursor
        if (cursor && cursor === previousCursor) {
          truncated = true
          truncatedReasons.add("cursor-no-progress")
          console.warn("[RightPanel] Hook catalog cursor made no progress")
          break
        }
      } while (cursor)

      const nextHooks: DisplayHook[] = [
        ...globalHooks.map((hook): DisplayHook => ({ ...hook, source: "global" })),
        ...workspaceHooks.map((hook): DisplayHook => ({ ...hook, source: "workspace" })),
        ...skillHooks.map(
          (hook: SkillHookMetadata): DisplayHook => ({
            ...hook,
            source: "skill",
            skillName: hook.skillName,
            skillPath: hook.skillPath,
            hookPath: hook.hookPath
          })
        ),
        ...pluginHooks.map(
          (hook: PluginHookMetadata): DisplayHook => ({
            ...hook,
            source: "plugin",
            pluginId: hook.pluginId,
            pluginName: hook.pluginName,
            hookPath: hook.hookPath
          })
        )
      ]
      setHookDetail({ key, hooks: nextHooks, truncated })
      setHookSummary({
        key,
        value: {
          total: totalEntries,
          enabled: enabledEntries,
          truncated,
          truncatedReasons: [...truncatedReasons]
        },
        loading: false,
        error: false
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/cancel|supersed|HOOK_CATALOG_CANCELLED/i.test(message)) return
      console.error("[RightPanel] Failed to load hooks:", error)
    }
  }, [currentHookCatalogKey, currentHookWorkerRevision, workspacePath])

  useEffect(() => {
    if (!hooksOpen) return undefined
    if (moduleMode !== "work") return undefined
    const timer = window.setTimeout(
      () => void loadHooks(),
      RIGHT_PANEL_HOOK_REFRESH_DEBOUNCE_MS
    )
    return () => {
      window.clearTimeout(timer)
      hooksCatalogRequestIdRef.current += 1
      void window.api.hooks.catalog.cancel(RIGHT_PANEL_HOOK_SCOPE).catch(() => undefined)
    }
  }, [hooksOpen, loadHooks, moduleMode])

  useEffect(() => {
    const advanceRevision = (): void => {
      setHookCatalogRevision((revision) => revision + 1)
    }
    const unsubscribes = [
      subscribeGlobalHookCatalogInvalidation(advanceRevision),
      subscribeSkillCatalogInvalidation(advanceRevision),
      subscribePluginCatalogInvalidation(advanceRevision)
    ]
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!workspacePath) return undefined
    const workspaceKey = normalizeWorkspaceFileKey(workspacePath)
    return subscribeWorkspaceHookCatalogInvalidation((data) => {
      if (normalizeWorkspaceFileKey(data.workspacePath) === workspaceKey) {
        setHookCatalogRevision((revision) => revision + 1)
      }
    })
  }, [workspacePath])

  const applyStreamPreview = useCallback(
    (path: string, switchToPreview: boolean): void => {
      if (!currentThreadId) return
      previewThreadIdRef.current = currentThreadId
      setPreviewPath(path)
      previewExternalGrantRefreshPromiseRef.current = null
      replacePreviewExternalAuthorization(null)
      setPreviewReloadToken((version) => version + 1)
      if (!switchToPreview) return
      if (isHtmlPreviewPath(path)) {
        onRequestBrowserMode?.()
      } else {
        onRequestPreviewMode?.()
      }
    },
    [
      currentThreadId,
      onRequestBrowserMode,
      onRequestPreviewMode,
      replacePreviewExternalAuthorization
    ]
  )

  useEffect(() => {
    if (lastThreadIdRef.current !== currentThreadId) {
      lastThreadIdRef.current = currentThreadId
      previewThreadIdRef.current = null
      setPreviewPath(null)
      previewExternalGrantRefreshPromiseRef.current = null
      replacePreviewExternalAuthorization(null)
    }
  }, [currentThreadId, replacePreviewExternalAuthorization])

  useEffect(() => {
    if (!currentThreadId) return
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      if (data.threadIds.includes(currentThreadId) && previewPathForCurrentThread) {
        setPreviewReloadToken((v) => v + 1)
      }
    })
    return cleanup
  }, [currentThreadId, previewPathForCurrentThread])

  useEffect(() => {
    const cleanup = onOpenResourcePreview(
      ({
        threadId,
        filePath,
        externalPreviewGrant,
        externalPreviewGrantExpiresAt,
        externalPreviewProjectId,
        externalPreviewSlug
      }) => {
        if (!currentThreadId || threadId !== currentThreadId) return
        previewThreadIdRef.current = threadId
        setPreviewPath(filePath)
        previewExternalGrantRefreshPromiseRef.current = null
        replacePreviewExternalAuthorization(
          externalPreviewGrant
            ? {
                threadId,
                filePath,
                grant: externalPreviewGrant,
                expiresAt: externalPreviewGrantExpiresAt,
                projectId: externalPreviewProjectId,
                slug: externalPreviewSlug
              }
            : null
        )
        setPreviewReloadToken((v) => v + 1)
        if (isHtmlPreviewPath(filePath) && !externalPreviewGrant) {
          onRequestBrowserMode?.()
        } else {
          onRequestPreviewMode?.()
        }
      }
    )
    return cleanup
  }, [
    currentThreadId,
    onRequestBrowserMode,
    onRequestPreviewMode,
    replacePreviewExternalAuthorization
  ])

  useEffect(() => {
    if (moduleMode !== "preview" || !previewPathForCurrentThread) {
      onPreviewFullscreenChange?.(false)
    }
  }, [moduleMode, previewPathForCurrentThread, onPreviewFullscreenChange])

  useEffect(() => {
    if (moduleMode !== "browser") onBrowserFullscreenChange?.(false)
  }, [moduleMode, onBrowserFullscreenChange])

  // Store content heights in pixels (null = auto/equal distribution)
  const [tasksHeight, setTasksHeight] = useState<number | null>(null)
  const [filesHeight, setFilesHeight] = useState<number | null>(null)
  const [pluginRunArtifactsHeight, setPluginRunArtifactsHeight] = useState<number | null>(null)
  const [systemConstraintsHeight, setSystemConstraintsHeight] = useState<number | null>(null)
  const [agentsHeight, setAgentsHeight] = useState<number | null>(null)
  const [skillsHeight, setSkillsHeight] = useState<number | null>(null)
  const [pluginsHeight, setPluginsHeight] = useState<number | null>(null)
  const [hooksHeight, setHooksHeight] = useState<number | null>(null)
  const [lspHeight, setLspHeight] = useState<number | null>(null)

  // Track drag start heights
  const dragStartHeights = useRef<{
    tasks: number
    files: number
    pluginRunArtifacts: number
    systemConstraints: number
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

    const openPanels = [
      tasksOpen,
      filesOpen,
      Boolean(activePluginRunArtifacts && pluginRunArtifactsOpen),
      showSystemConstraints && systemConstraintsOpen,
      agentsOpen,
      skillsOpen,
      pluginsOpen,
      hooksOpen,
      lspOpen
    ]
    const sectionCount = (showSystemConstraints ? 8 : 7) + (activePluginRunArtifacts ? 1 : 0)
    let used = HEADER_HEIGHT * sectionCount
    // Fixed visual gaps between section blocks
    used += SECTION_GAP * (sectionCount - 1)

    // Count handles between consecutive open panels
    let handles = 0
    let lastOpen = false
    for (const isOpen of openPanels) {
      if (isOpen && lastOpen) handles++
      lastOpen = isOpen
    }
    used += HANDLE_HEIGHT * handles

    return Math.max(0, totalHeight - used)
  }, [
    moduleMode,
    tasksOpen,
    filesOpen,
    activePluginRunArtifacts,
    pluginRunArtifactsOpen,
    showSystemConstraints,
    systemConstraintsOpen,
    agentsOpen,
    skillsOpen,
    pluginsOpen,
    hooksOpen,
    lspOpen
  ])

  // Get current heights for each panel's content area
  const getContentHeights = useCallback(() => {
    const available = getAvailableContentHeight()
    const openCount = [
      tasksOpen,
      filesOpen,
      Boolean(activePluginRunArtifacts && pluginRunArtifactsOpen),
      showSystemConstraints && systemConstraintsOpen,
      agentsOpen,
      skillsOpen,
      pluginsOpen,
      hooksOpen,
      lspOpen
    ].filter(Boolean).length

    if (openCount === 0) {
      return {
        tasks: 0,
        files: 0,
        pluginRunArtifacts: 0,
        systemConstraints: 0,
        agents: 0,
        skills: 0,
        plugins: 0,
        hooks: 0,
        lsp: 0
      }
    }

    const defaultHeight = available / openCount

    return {
      tasks: tasksOpen ? (tasksHeight ?? defaultHeight) : 0,
      files: filesOpen ? (filesHeight ?? defaultHeight) : 0,
      pluginRunArtifacts:
        activePluginRunArtifacts && pluginRunArtifactsOpen
          ? (pluginRunArtifactsHeight ?? defaultHeight)
          : 0,
      systemConstraints:
        showSystemConstraints && systemConstraintsOpen
          ? (systemConstraintsHeight ?? defaultHeight)
          : 0,
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
    activePluginRunArtifacts,
    pluginRunArtifactsOpen,
    showSystemConstraints,
    systemConstraintsOpen,
    agentsOpen,
    skillsOpen,
    pluginsOpen,
    hooksOpen,
    lspOpen,
    tasksHeight,
    filesHeight,
    pluginRunArtifactsHeight,
    systemConstraintsHeight,
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
    [
      getContentHeights,
      getAvailableContentHeight,
      tasksOpen,
      filesOpen,
      agentsOpen,
      skillsOpen,
      pluginsOpen
    ]
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
    setPluginRunArtifactsHeight(null)
    setSystemConstraintsHeight(null)
    setAgentsHeight(null)
    setSkillsHeight(null)
    setPluginsHeight(null)
    setHooksHeight(null)
    setLspHeight(null)
  }, [
    tasksOpen,
    filesOpen,
    pluginRunArtifactsOpen,
    systemConstraintsOpen,
    agentsOpen,
    skillsOpen,
    pluginsOpen,
    hooksOpen,
    lspOpen
  ])

  // Calculate heights in an effect (refs can't be accessed during render)
  const [heights, setHeights] = useState<PanelHeights>({
    tasks: 0,
    files: 0,
    pluginRunArtifacts: 0,
    systemConstraints: 0,
    agents: 0,
    skills: 0,
    plugins: 0,
    hooks: 0,
    lsp: 0
  })
  useEffect(() => {
    setHeights(getContentHeights())
  }, [getContentHeights])

  const allPanelsClosed =
    moduleMode === "work" &&
    !tasksOpen &&
    !filesOpen &&
    !(activePluginRunArtifacts && pluginRunArtifactsOpen) &&
    !(showSystemConstraints && systemConstraintsOpen) &&
    !agentsOpen &&
    !skillsOpen &&
    !pluginsOpen &&
    !hooksOpen &&
    !lspOpen
  const browserPreviewUrl = useMemo(() => {
    if (!previewPathForCurrentThread || !isHtmlPreviewPath(previewPathForCurrentThread)) {
      return null
    }
    return previewPathForCurrentThread
  }, [previewPathForCurrentThread])

  const handleOpenGitFileFolder = useCallback(
    async (filePath: string): Promise<void> => {
      try {
        const resolved = resolvePreviewPaths(filePath, workspacePath ?? null)
        const platform = await window.electron.ipcRenderer.invoke("get-platform")
        const normalizedPath =
          platform === "win32" ? resolved.fullPath.replace(/\//g, "\\") : resolved.fullPath
        await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
      } catch (error) {
        console.error("[GitPanel] Failed to show item in folder:", error)
      }
    },
    [workspacePath]
  )

  const hookSummaryValue = workspacePath
    ? hookSummary.key === currentHookCatalogKey
      ? hookSummary.value
      : null
    : globalHookSummary.value
  const hookSummaryLoading = workspacePath
    ? hookSummary.key !== currentHookCatalogKey || hookSummary.loading
    : globalHookSummary.loading
  const hookSummaryError = workspacePath
    ? hookSummary.key === currentHookCatalogKey && hookSummary.error
    : globalHookSummary.error
  const currentHookDetail =
    hookDetail.key === currentHookCatalogKey
      ? hookDetail
      : { key: currentHookCatalogKey, hooks: [], truncated: false }
  const workspaceFileSummaryReady = Boolean(
    currentThreadId &&
      workspacePath &&
      hasLoadedWorkspaceFiles(currentThreadId, workspacePath)
  )
  const workspaceFileBadge =
    workspacePath && workspaceFileSummaryReady ? workspaceFiles.length : null
  const workspaceFileDetail = !workspacePath
    ? "未关联"
    : workspaceFileBadge === null
      ? "待加载"
      : null
  const previewExternalGrant =
    previewExternalAuthorizationForCurrentThread?.grant ?? null

  return (
    <aside
      ref={containerRef}
      className={cn(
        "flex w-full flex-col bg-transparent overflow-hidden border-l",
        allPanelsClosed ? "h-auto self-start" : "h-full"
      )}
    >
      {currentThreadId && (
        <RightPanelStreamEffects
          key={currentThreadId}
          threadId={currentThreadId}
          moduleMode={moduleMode}
          onApplyPreview={applyStreamPreview}
        />
      )}
      {moduleMode === "browser" && (
        <div className="flex h-full min-h-0 flex-col bg-background">
          <Suspense fallback={<LazySectionFallback label="加载 Browser..." />}>
            <BrowserPanel
              threadId={currentThreadId ?? null}
              workspacePath={workspacePath ?? null}
              initialUrl={browserPreviewUrl}
              reloadToken={previewReloadToken}
              onFullscreenChange={onBrowserFullscreenChange}
            />
          </Suspense>
        </div>
      )}

      {moduleMode === "preview" && (
        <div className="flex h-full min-h-0 flex-col  rounded-2xl bg-background">
          <div className="bg-background h-full min-h-0" style={{ height: PREVIEW_MAX_HEIGHT }}>
            {previewPathForCurrentThread ? (
              <ResourcePreview
                key={`${currentThreadId}:${previewPathForCurrentThread}:${previewReloadToken}`}
                filePath={previewPathForCurrentThread}
                workspacePath={workspacePath ?? null}
                threadId={currentThreadId ?? ""}
                externalPreviewGrant={previewExternalGrant ?? undefined}
                resolveExternalPreviewGrant={
                  previewExternalAuthorizationForCurrentThread
                    ? resolveCurrentExternalPreviewGrant
                    : undefined
                }
                reloadToken={previewReloadToken}
                onReload={() => setPreviewReloadToken((v) => v + 1)}
                onFullscreenChange={onPreviewFullscreenChange}
                onHidePreview={onRequestWorkMode}
              />
            ) : (
              <div className="flex h-full min-h-0 overflow-y-auto bg-[radial-gradient(circle_at_12%_0%,rgba(234,179,8,0.11),transparent_34%),radial-gradient(circle_at_100%_100%,rgba(14,116,144,0.08),transparent_42%),#fcfcfb]">
                <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-4 py-5">
                  <div className="mb-3">
                    <div className="mb-3 flex size-12 items-center justify-center rounded-xl border border-stone-200/80 bg-white text-stone-700 shadow-[0_8px_24px_rgba(41,37,36,0.08)]">
                      <FileText className="size-7" strokeWidth={1.7} />
                    </div>
                    <p className="text-[10px] font-semibold tracking-[0.18em] text-stone-500">
                      FILE PREVIEW
                    </p>
                    <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-stone-900">
                      从一个文件开始预览
                    </h2>
                    <p className="mt-2 text-xs leading-5 text-stone-600">
                      生成或编辑文件后，新的可预览内容会自动在这里展示。
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-stone-200/90 bg-white/90 shadow-[0_14px_38px_rgba(41,37,36,0.06)]">
                    <div className="border-b border-stone-100 px-4 py-3">
                      <p className="text-xs font-semibold text-stone-800">预览使用提示</p>
                      <p className="mt-0.5 text-[11px] text-stone-500">
                        把文件查看、跳转和验证集中到同一处。
                      </p>
                    </div>

                    <div className="divide-y divide-stone-100">
                      <div className="flex gap-3 px-4 py-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-700">
                          <Eye className="size-3.5" strokeWidth={1.8} />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-stone-800">在工具调用里快速打开</p>
                          <p className="mt-1 text-[11px] leading-4 text-stone-500">
                            点击预览图标，就能把对应文件直接切到这里查看完整内容。
                          </p>
                        </div>
                      </div>

                      <div className="flex gap-3 px-4 py-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                          <Sparkles className="size-3.5" strokeWidth={1.8} />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-stone-800">生成后自动接管预览区</p>
                          <p className="mt-1 text-[11px] leading-4 text-stone-500">
                            当任务产出新的可预览文件时，这里会自动更新，不需要手动切换。
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-stone-500">准备好后，回到工作区继续生成内容。</p>
                    <button
                      type="button"
                      onClick={onRequestWorkMode}
                      className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-stone-200/90 bg-white px-4 text-xs font-medium text-stone-700 shadow-[0_8px_20px_rgba(41,37,36,0.06)] transition-[transform,background-color,color,box-shadow] hover:bg-stone-50 hover:text-stone-900 hover:shadow-[0_12px_28px_rgba(41,37,36,0.1)] active:scale-[0.98]"
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
                workspacePath={workspacePath ?? null}
                initialGitContext={gitContext ?? null}
                onOpenFileFolder={handleOpenGitFileFolder}
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
                <TasksContent threadId={currentThreadId} />
              </div>
            )}
          </div>

          {/* Resize handle after TASKS */}
          {tasksOpen && (filesOpen || (!showSystemConstraints && agentsOpen)) && (
            <ResizeHandle onDrag={handleTasksResize} />
          )}

          {/* FILES */}
          <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
            <SectionHeader
              title="文件"
              icon={FolderTree}
              badge={workspaceFileBadge}
              badgeTitle={
                workspaceFileBadge === null ? undefined : `已加载 ${workspaceFileBadge} 项`
              }
              detail={
                workspaceFileDetail ? (
                  <span className="text-xs text-muted-foreground">{workspaceFileDetail}</span>
                ) : undefined
              }
              isOpen={filesOpen}
              onToggle={() => setFilesOpen((prev) => !prev)}
            />
            {filesOpen && (
              <div className="overflow-auto right-panel-scroll" style={{ height: heights.files }}>
                <FilesContent threadId={currentThreadId} />
              </div>
            )}
          </div>

          {activePluginRunArtifacts && (
            <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
              <SectionHeader
                title="插件运行产物"
                icon={PackageOpen}
                badge={activePluginRunArtifacts.files.length}
                badgeTitle={
                  activePluginRunArtifacts.truncated
                    ? `仅展示前 ${activePluginRunArtifacts.files.length} 项`
                    : `共 ${activePluginRunArtifacts.files.length} 项`
                }
                badgeTruncated={activePluginRunArtifacts.truncated}
                isOpen={pluginRunArtifactsOpen}
                onToggle={() => setPluginRunArtifactsOpen((prev) => !prev)}
              />
              {pluginRunArtifactsOpen && (
                <div
                  className="overflow-auto right-panel-scroll"
                  style={{ height: heights.pluginRunArtifacts }}
                >
                  <PluginRunArtifactsContent
                    key={JSON.stringify([
                      activePluginRunArtifacts.projectId,
                      activePluginRunArtifacts.slug,
                      activePluginRunArtifacts.projectRootPath,
                      currentThreadId
                    ])}
                    context={activePluginRunArtifacts}
                    threadId={currentThreadId}
                  />
                </div>
              )}
            </div>
          )}

          {/* Resize handle after FILES */}
          {!showSystemConstraints && filesOpen && agentsOpen && (
            <ResizeHandle onDrag={handleFilesResize} />
          )}

          {showSystemConstraints && (
            <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
              <SectionHeader
                title="系统约束"
                icon={ShieldCheck}
                detail={
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {systemConstraintCounts.loaded}/{systemConstraintCounts.total}
                  </span>
                }
                isOpen={systemConstraintsOpen}
                onToggle={() => setSystemConstraintsOpen((prev) => !prev)}
              />
              {systemConstraintsOpen && (
                <div
                  className="overflow-auto right-panel-scroll"
                  style={{ height: heights.systemConstraints }}
                >
                  <SystemConstraintsPanel state={harnessAgentmdLoadStatus} />
                </div>
              )}
            </div>
          )}

          {/* AGENTS */}
          <div className="flex flex-col shrink-0 border border-border/75 rounded-2xl bg-background/95 mt-2">
            <SectionHeader
              title="代理"
              icon={GitBranch}
              badge={
                subagents.length +
                coordinatorWorkers.length +
                (skillGenerationAgent.phase !== null ? 1 : 0)
              }
              isOpen={agentsOpen}
              onToggle={() => setAgentsOpen((prev) => !prev)}
            />
            {agentsOpen && (
              <div className="overflow-auto right-panel-scroll" style={{ height: heights.agents }}>
                <AgentsContent threadId={currentThreadId} />
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
              badge={skillSummary.value?.enabled ?? null}
              badgeTitle={
                skillSummary.value
                  ? `已启用 ${skillSummary.value.enabled ?? 0}，共 ${skillSummary.value.total}`
                  : undefined
              }
              badgeTruncated={skillSummary.value?.truncated}
              loading={skillSummary.loading || (!skillSummary.value && !skillSummary.error)}
              error={skillSummary.error}
              isOpen={skillsOpen}
              onToggle={() => setSkillsOpen((prev) => !prev)}
            />
            {skillsOpen && (
              <div className="overflow-auto right-panel-scroll" style={{ height: heights.skills }}>
                <SkillsContent
                  skills={skills}
                  disabledSkills={disabledSkills}
                  marketSkillMap={marketSkillMap}
                  threadId={currentThreadId}
                />
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
              badge={pluginSummary.value?.total ?? null}
              badgeTitle={
                pluginSummary.value ? `已安装 ${pluginSummary.value.total} 个插件` : undefined
              }
              badgeTruncated={pluginSummary.value?.truncated}
              loading={
                pluginSummary.loading || (!pluginSummary.value && !pluginSummary.error)
              }
              error={pluginSummary.error}
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
              badge={hookSummaryValue?.enabled ?? null}
              badgeTitle={
                hookSummaryValue
                  ? `已启用 ${hookSummaryValue.enabled ?? 0}，共 ${hookSummaryValue.total}`
                  : undefined
              }
              badgeTruncated={hookSummaryValue?.truncated}
              loading={hookSummaryLoading}
              error={hookSummaryError}
              isOpen={hooksOpen}
              onToggle={() => setHooksOpen((prev) => !prev)}
            />
            {hooksOpen && (
              <div className="overflow-auto right-panel-scroll" style={{ height: heights.hooks }}>
                <HooksContent
                  hooks={currentHookDetail.hooks}
                  truncated={currentHookDetail.truncated}
                />
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
              loading={lspConfigLoading || (!lspConfig && !lspConfigError)}
              error={lspConfigError}
              isOpen={lspOpen}
              onToggle={() => setLspOpen((prev) => !prev)}
            />
            {lspOpen && (
              <div className="overflow-auto right-panel-scroll" style={{ height: heights.lsp }}>
                <LspPanel
                  threadId={currentThreadId}
                  embedded
                  statusOnly
                  onSummaryChange={handleLspSummaryChange}
                />
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

function TasksContent({ threadId }: { threadId: string | null }): React.JSX.Element {
  const todos = useThreadStateSelector(threadId, (state) => state.todos) ?? []
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

function isHtmlPreviewPath(filePath: string): boolean {
  const ext = getPathExtension(filePath)
  return ext === "html" || ext === "htm"
}
function isAbsolutePath(filePath: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(filePath)
}

function resolvePreviewPaths(
  filePath: string,
  workspacePath: string | null
): {
  fullPath: string
  workspaceFilePath: string
  inWorkspace: boolean
} {
  const input = filePath.trim().replace(/\\/g, "/")
  if (!workspacePath) {
    return { fullPath: input, workspaceFilePath: input, inWorkspace: false }
  }

  const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  const fullPath = isAbsolutePath(input) ? input : `${ws}/${input.replace(/^\/+/, "")}`

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

function FilesContent({ threadId }: { threadId: string | null }): React.JSX.Element {
  const workspaceFiles = useThreadStateSelector(threadId, (state) => state.workspaceFiles) ?? []
  const workspacePath = useThreadStateSelector(threadId, (state) => state.workspacePath)
  const threadActions = useThreadActions(threadId)
  const setWorkspacePath = threadActions?.setWorkspacePath
  const setWorkspaceFiles = threadActions?.setWorkspaceFiles
  const [scanState, setScanState] = useState<{ threadId: string; count: number } | null>(null)
  const [loadBoundary, setLoadBoundary] = useState<{
    threadId: string
    workspacePath: string
    truncated: boolean
    continuationAvailable: boolean
  } | null>(null)
  const [continuationLoading, setContinuationLoading] = useState(false)
  const continuationControllerRef = useRef<AbortController | null>(null)
  const requestFenceRef = useRef(new WorkspaceFileRequestFence())
  const workspaceKey = workspacePath ? normalizeWorkspaceFileKey(workspacePath) : ""
  requestFenceRef.current.observe(threadId, workspacePath)
  const scanProgress = scanState?.threadId === threadId ? scanState.count : null

  // Load workspace path and files for current thread
  useEffect(() => {
    let cancelled = false
    const scanController = new AbortController()
    const requestToken = requestFenceRef.current.begin(threadId, workspacePath)
    const isCurrentRequest = (): boolean =>
      !cancelled && requestFenceRef.current.isCurrent(requestToken)

    async function loadWorkspace(): Promise<void> {
      if (threadId && setWorkspacePath && setWorkspaceFiles) {
        const path =
          workspacePath ??
          (await readWorkspacePathWithFallback({
            read: () => window.api.workspace.get(threadId),
            getFallback: () => workspacePath,
            signal: scanController.signal
          }))
        if (!isCurrentRequest()) return

        if (!path) return
        if (!workspacePath) {
          // Publishing the resolved path changes the normalized request key.
          // Let the next keyed effect own the scan instead of continuing under
          // the pathless epoch and racing a later workspace selection.
          setWorkspacePath(path)
          return
        }

        if (hasLoadedWorkspaceFiles(threadId, path)) {
          // A cached tree may have missed changes while its watcher was evicted.
          // Re-arm the watcher and refresh once only when it had to be recreated.
          const watcherResult = await window.api.workspace.ensureWatching(threadId)
          if (!isCurrentRequest()) return
          if (watcherResult.success && watcherResult.restarted) {
            markWorkspaceFilesStale(threadId, path)
          }
        }

        // Reuse the path-level cached tree (including its files array), or
        // share an in-flight scan. A recreated watcher invalidates the cache
        // above because changes may have been missed while it was evicted.
        setScanState({ threadId, count: 0 })
        const result = await loadWorkspaceFilesDeduped(threadId, path, {
          signal: scanController.signal,
          onProgress: (loadedCount) => {
            if (isCurrentRequest()) setScanState({ threadId, count: loadedCount })
          }
        })
        if (!isCurrentRequest()) return
        // Guard against writing a stale scan (workspace switched mid-load):
        // only accept results that match the path we resolved.
        if (
          result.success &&
          result.files &&
          result.workspacePath &&
          normalizeWorkspaceFileKey(result.workspacePath) === requestToken.workspaceKey
        ) {
          setWorkspaceFiles(result.files)
          setLoadBoundary({
            threadId,
            workspacePath: path,
            truncated: result.truncated === true,
            continuationAvailable: result.continuationAvailable === true
          })
        }
        setScanState(null)
      }
    }
    void loadWorkspace().catch((error) => {
      if (isCurrentRequest() && (!(error instanceof Error) || error.name !== "AbortError")) {
        console.error("[FilesContent] Failed to load workspace files:", error)
      }
      if (isCurrentRequest()) setScanState(null)
    })

    return () => {
      cancelled = true
      requestFenceRef.current.invalidate(requestToken)
      scanController.abort()
      continuationControllerRef.current?.abort()
      continuationControllerRef.current = null
      setContinuationLoading(false)
      setScanState(null)
    }
    // The normalized workspace key is part of the lifecycle: switching A -> B
    // within one thread invalidates every late A read/scan/continuation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, workspaceKey])

  useEffect(() => {
    if (!threadId || !workspacePath) return
    const workspaceKey = normalizeWorkspaceFileKey(workspacePath)
    return subscribeWorkspaceFileResults((publishedKey, _files, result) => {
      if (publishedKey !== workspaceKey || !result) return
      if (
        result.workspacePath &&
        normalizeWorkspaceFileKey(result.workspacePath) !== workspaceKey
      ) {
        return
      }
      setLoadBoundary({
        threadId,
        workspacePath,
        truncated: result.truncated === true,
        continuationAvailable: result.continuationAvailable === true
      })
    })
  }, [threadId, workspacePath])

  const handleContinueWorkspace = useCallback(async (): Promise<void> => {
    if (!threadId || !workspacePath || !setWorkspaceFiles || continuationLoading) return
    const controller = new AbortController()
    const requestToken = requestFenceRef.current.begin(threadId, workspacePath)
    continuationControllerRef.current?.abort()
    continuationControllerRef.current = controller
    setContinuationLoading(true)
    setScanState({ threadId, count: workspaceFiles.length })
    try {
      const result = await continueWorkspaceFilesDeduped(threadId, workspacePath, {
        onProgress: (count) => {
          if (
            !controller.signal.aborted &&
            requestFenceRef.current.isCurrent(requestToken)
          ) {
            setScanState({ threadId, count })
          }
        }
      })
      if (
        controller.signal.aborted ||
        !requestFenceRef.current.isCurrent(requestToken)
      ) {
        return
      }
      if (result.success) {
        setWorkspaceFiles(result.files)
        setLoadBoundary({
          threadId,
          workspacePath,
          truncated: result.truncated === true,
          continuationAvailable: result.continuationAvailable === true
        })
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        console.error("[FilesContent] Failed to continue workspace scan:", error)
      }
    } finally {
      if (continuationControllerRef.current === controller) {
        requestFenceRef.current.invalidate(requestToken)
        continuationControllerRef.current = null
        setContinuationLoading(false)
        setScanState(null)
      }
    }
  }, [continuationLoading, setWorkspaceFiles, threadId, workspaceFiles.length, workspacePath])

  const currentLoadBoundary =
    loadBoundary?.threadId === threadId && loadBoundary.workspacePath === workspacePath
      ? loadBoundary
      : null

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
      {workspaceFiles.length === 0 && scanProgress !== null ? (
        <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4 flex-1">
          <Loader2 className="size-7 mb-2 animate-spin opacity-60" />
          <span>正在加载工作区文件</span>
          <span className="text-xs mt-1 tabular-nums">已扫描 {scanProgress} 项</span>
        </div>
      ) : workspaceFiles.length === 0 ? (
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
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="py-1 overflow-auto flex-1">
            <FileTree files={workspaceFiles} threadId={threadId} />
          </div>
          {currentLoadBoundary?.truncated && (
            <div className="shrink-0 border-t border-border/50 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  目录较大，当前已加载 {workspaceFiles.length} 项
                </span>
                {currentLoadBoundary.continuationAvailable && (
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-1 hover:bg-muted/50 disabled:cursor-wait disabled:opacity-60"
                    disabled={continuationLoading}
                    onClick={() => void handleContinueWorkspace()}
                  >
                    {continuationLoading && <Loader2 className="size-3 animate-spin" />}
                    {continuationLoading ? "加载中" : "继续加载"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PluginRunArtifactsContent({
  context,
  threadId
}: {
  context: HarnessPluginRunArtifactsContext
  threadId: string | null
}): React.JSX.Element {
  const [visibleArtifactCount, setVisibleArtifactCount] = useState(
    RIGHT_PANEL_INITIAL_RENDER_ITEMS
  )
  const previewGrantRef = useRef<{ grant: string; expiresAt: number } | null>(null)
  const grantRefreshPromiseRef = useRef<Promise<{
    grant: string
    expiresAt: number
  }> | null>(null)
  const artifactActionGenerationRef = useRef(0)
  useEffect(() => {
    const mountedGeneration = artifactActionGenerationRef.current
    return () => {
      if (artifactActionGenerationRef.current === mountedGeneration) {
        artifactActionGenerationRef.current += 1
      }
    }
  }, [])
  if (
    context.previewGrant &&
    typeof context.previewGrantExpiresAt === "number" &&
    Number.isFinite(context.previewGrantExpiresAt) &&
    (!previewGrantRef.current ||
      context.previewGrant !== previewGrantRef.current.grant ||
      context.previewGrantExpiresAt > previewGrantRef.current.expiresAt)
  ) {
    previewGrantRef.current = {
      grant: context.previewGrant,
      expiresAt: context.previewGrantExpiresAt
    }
  }
  const visibleArtifacts = useMemo(
    () => selectRightPanelWindow(context.files, visibleArtifactCount),
    [context.files, visibleArtifactCount]
  )

  const getCurrentPreviewGrant = useCallback(
    async (filePath: string): Promise<{ grant: string; expiresAt: number }> => {
      const current = previewGrantRef.current
      if (
        current &&
        isHarnessPluginRunArtifactGrantFresh(current.grant, current.expiresAt)
      ) {
        return current
      }

      if (!grantRefreshPromiseRef.current) {
        const refresh = (async (): Promise<{ grant: string; expiresAt: number }> => {
          try {
            const result = await window.api.harnessBoard.refreshRunArtifactGrant({
              projectId: context.projectId,
              slug: context.slug,
              filePath
            })
            if (!result.success) throw new Error(result.error)
            const next = { grant: result.grant, expiresAt: result.expiresAt }
            previewGrantRef.current = next
            return next
          } finally {
            grantRefreshPromiseRef.current = null
          }
        })()
        grantRefreshPromiseRef.current = refresh
      }

      return await grantRefreshPromiseRef.current
    },
    [context.projectId, context.slug]
  )

  const openArtifact = useCallback(
    async (artifact: HarnessPluginRunArtifactsContext["files"][number]): Promise<void> => {
      if (!threadId) return
      const actionGeneration = artifactActionGenerationRef.current
      const filePath = resolveHarnessPluginRunArtifactPath(
        context.projectRootPath,
        artifact.path
      )
      if (!filePath) {
        toast.error("产物路径超出项目目录，已阻止打开")
        return
      }
      let previewAuthorization: { grant: string; expiresAt: number }
      try {
        previewAuthorization = await getCurrentPreviewGrant(filePath)
      } catch (error) {
        if (artifactActionGenerationRef.current !== actionGeneration) return
        toast.error(error instanceof Error ? error.message : "产物预览授权续签失败")
        return
      }
      // A near-expiry renewal can outlive this project/feature/thread surface.
      // The keyed remount plus generation fence prevents its continuation from
      // revealing or reopening an artifact that belongs to the previous view.
      if (artifactActionGenerationRef.current !== actionGeneration) return

      if (artifact.artifactType === "directory") {
        try {
          const result = await window.api.harnessBoard.revealRunArtifact({
            grant: previewAuthorization.grant,
            filePath
          })
          if (
            artifactActionGenerationRef.current === actionGeneration &&
            !result.success
          ) {
            toast.error(result.error)
          }
        } catch (error) {
          if (artifactActionGenerationRef.current !== actionGeneration) return
          toast.error(error instanceof Error ? error.message : "无法打开产物位置")
        }
        return
      }

      emitOpenResourcePreview({
        threadId,
        filePath,
        externalPreviewGrant: previewAuthorization.grant,
        externalPreviewGrantExpiresAt: previewAuthorization.expiresAt,
        externalPreviewProjectId: context.projectId,
        externalPreviewSlug: context.slug
      })
    },
    [context.projectRootPath, getCurrentPreviewGrant, threadId]
  )

  if (context.files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
        <PackageOpen className="mb-2 size-8 opacity-50" />
        <span>暂无已生成的插件运行产物</span>
      </div>
    )
  }

  return (
    <div className="select-none py-1">
      {visibleArtifacts.map((artifact) => {
        const fileName = artifact.path.split(/[\\/]/).pop() || artifact.path
        const isDirectory = artifact.artifactType === "directory"
        return (
          <button
            key={artifact.path}
            type="button"
            className="group flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-background-interactive focus-visible:bg-background-interactive focus-visible:outline-none"
            title={artifact.path}
            onClick={() => void openArtifact(artifact)}
          >
            <span className="mt-0.5 shrink-0">
              <FileIcon name={fileName} isDir={isDirectory} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{fileName}</span>
              <span className="mt-0.5 block break-all font-mono text-[10px] leading-4 text-muted-foreground">
                {artifact.path}
              </span>
            </span>
            {isDirectory ? (
              <FolderOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : (
              <Eye className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        )
      })}
      {visibleArtifacts.length < context.files.length && (
        <button
          type="button"
          className="mx-3 my-2 w-[calc(100%-1.5rem)] rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-background-interactive hover:text-foreground"
          onClick={() =>
            setVisibleArtifactCount((count) => count + RIGHT_PANEL_RENDER_PAGE_ITEMS)
          }
        >
          再显示 {Math.min(
            RIGHT_PANEL_RENDER_PAGE_ITEMS,
            context.files.length - visibleArtifacts.length
          )} 项
        </button>
      )}
      {context.truncated && (
        <div className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
          产物较多，仅展示前 {context.files.length} 项
        </div>
      )}
    </div>
  )
}

function ResourcePreview({
  filePath,
  workspacePath,
  threadId,
  externalPreviewGrant,
  resolveExternalPreviewGrant,
  reloadToken,
  onReload,
  onFullscreenChange,
  onHidePreview
}: {
  filePath: string
  workspacePath: string | null
  threadId: string
  externalPreviewGrant?: string
  resolveExternalPreviewGrant?: () => Promise<string>
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
    extension === "md" ||
    extension === "markdown" ||
    extension === "mdx"
  const previewFileType = useMemo(() => getFileType(fileName), [fileName])

  const resolved = useMemo(
    () => resolvePreviewPaths(filePath, workspacePath),
    [filePath, workspacePath]
  )
  const isCopyableText = previewFileType.type === "code" || previewFileType.type === "text"
  const canCopyContent =
    isCopyableText && (resolved.inWorkspace || Boolean(externalPreviewGrant))
  const copyUnavailableReason = isCopyableText
    ? "外部文件未获得可信来源授权"
    : "当前文件类型不支持复制"
  const fullPath = resolved.fullPath

  const openInFolder = useCallback(async () => {
    try {
      if (externalPreviewGrant) {
        const grant = resolveExternalPreviewGrant
          ? await resolveExternalPreviewGrant()
          : externalPreviewGrant
        const result = await window.api.harnessBoard.revealRunArtifact({
          grant,
          filePath: fullPath
        })
        if (!result.success) throw new Error(result.error)
        return
      }
      const platform = await window.electron.ipcRenderer.invoke("get-platform")
      const normalizedPath = platform === "win32" ? fullPath.replace(/\//g, "\\") : fullPath
      await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
    } catch (error) {
      console.error("[ResourcePreview] Failed to show item in folder:", error)
    }
  }, [externalPreviewGrant, fullPath, resolveExternalPreviewGrant])

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
      toast.error(
        resolved.inWorkspace ? "当前文件类型不支持复制内容" : "外部文件未获得可信来源授权"
      )
      return
    }

    try {
      const requestToken =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const lane = `right-panel-copy:${threadId}`
      const source = resolved.inWorkspace
        ? { threadId, filePath: resolved.workspaceFilePath }
        : {
            externalGrant: resolveExternalPreviewGrant
              ? await resolveExternalPreviewGrant()
              : externalPreviewGrant!,
            filePath: resolved.fullPath
          }
      const chunks: string[] = []
      let totalBytes = 0
      let offset = 0
      let pageCount = 0
      let complete = false
      try {
        while (pageCount < 64) {
          const page = await window.api.workspace.readFilePreview({
            source,
            offset,
            lane,
            requestToken
          })
          if (!page.success) throw new Error(page.error || "复制失败，请重试")
          pageCount += 1
          totalBytes += page.contentBytes
          if (totalBytes > 1024 * 1024) {
            throw new Error("文件超过 1MiB，无法一次复制全部内容")
          }
          chunks.push(page.content)
          if (!page.hasMore || page.nextOffset === null) {
            complete = true
            break
          }
          if (page.nextOffset <= offset) throw new Error("文件分页游标未推进")
          offset = page.nextOffset
        }
        if (!complete) throw new Error("文件行数过多，超过复制分页上限")
        await navigator.clipboard.writeText(chunks.join(""))
      } finally {
        void window.api.workspace.cancelFilePreview({ lanePrefix: lane, requestToken })
      }
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 2000)
      toast.success("文件内容已复制")
    } catch (error) {
      console.error("[ResourcePreview] Failed to copy file content:", error)
      toast.error("复制失败，请重试")
    }
  }, [
    canCopyContent,
    externalPreviewGrant,
    resolveExternalPreviewGrant,
    resolved,
    threadId
  ])

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
    <div className="border border-border/70 overflow-hidden bg-background flex flex-col min-h-0 h-full">
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
            title={canCopyContent ? "复制文件内容" : copyUnavailableReason}
            aria-label={canCopyContent ? "复制文件内容" : copyUnavailableReason}
          >
            {copySuccess ? (
              <Check className="size-3.5 text-status-nominal" />
            ) : (
              <Copy className="size-3.5" />
            )}
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
        <Suspense fallback={<LazySectionFallback label="加载文件预览..." />}>
          <FileViewer
            threadId={threadId}
            filePath={resolved.inWorkspace ? resolved.workspaceFilePath : resolved.fullPath}
            externalFullPath={resolved.inWorkspace ? undefined : resolved.fullPath}
            externalPreviewGrant={externalPreviewGrant}
            resolveExternalPreviewGrant={resolveExternalPreviewGrant}
            htmlFillHeight
            reloadToken={reloadToken}
            previewMode={supportsSourceView ? previewMode : undefined}
          />
        </Suspense>
      </div>
    </div>
  )
}

// ============ File Tree Components ============

interface FileInfo extends WorkspaceFileTreeFile {}
type TreeNode = WorkspaceFileTreeNode

// File arrays are shared by every task on the same physical workspace. Cache
// their immutable tree structure too, so switching tasks or reopening the
// panel does not rebuild/sort a 50k-file tree.
const fileTreeCache = new WeakMap<FileInfo[], TreeNode[]>()

function FileTree({
  files,
  threadId
}: {
  files: FileInfo[]
  threadId: string | null
}): React.JSX.Element {
  const openFile = useThreadActions(threadId)?.openFile
  const workspacePath = useThreadStateSelector(threadId, (state) => state.workspacePath) ?? ""
  const projectedTree = getWorkspaceFileTreeProjection(files)?.tree ?? fileTreeCache.get(files)
  const [fallbackProjection, setFallbackProjection] = useState<{
    files: FileInfo[]
    tree: TreeNode[]
  } | null>(null)
  const tree =
    projectedTree ?? (fallbackProjection?.files === files ? fallbackProjection.tree : null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (projectedTree) return
    let cancelled = false
    void buildWorkspaceFileTreeProjection(files).then((projection) => {
      if (cancelled) return
      fileTreeCache.set(files, projection.tree)
      setFallbackProjection({ files, tree: projection.tree })
    })
    return () => {
      cancelled = true
    }
  }, [files, projectedTree])

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

  if (!tree) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        正在整理文件树
      </div>
    )
  }

  return (
    <div className="select-none">
      <FileTreeNodeList
        nodes={tree}
        depth={0}
        expanded={expanded}
        onToggle={toggleExpand}
        openFile={openFile}
        workspacePath={workspacePath}
      />
    </div>
  )
}

const FILE_TREE_NODE_PAGE_SIZE = 200

function FileTreeNodeList({
  nodes,
  depth,
  expanded,
  onToggle,
  openFile,
  workspacePath
}: {
  nodes: TreeNode[]
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  openFile?: (path: string, name: string) => void
  workspacePath: string
}): React.JSX.Element {
  const nodesPageKey = `${nodes.length}:${nodes[0]?.path ?? ""}:${nodes.at(-1)?.path ?? ""}`
  const [pageState, setPageState] = useState({ nodesPageKey, requestedPage: 0 })
  const requestedPage = pageState.nodesPageKey === nodesPageKey ? pageState.requestedPage : 0
  const pageCount = Math.max(1, Math.ceil(nodes.length / FILE_TREE_NODE_PAGE_SIZE))
  const page = Math.min(requestedPage, pageCount - 1)
  const pageStart = page * FILE_TREE_NODE_PAGE_SIZE
  const pageEnd = Math.min(pageStart + FILE_TREE_NODE_PAGE_SIZE, nodes.length)
  const visibleNodes = nodes.slice(pageStart, pageEnd)
  return (
    <>
      {visibleNodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={depth}
          expanded={expanded}
          onToggle={onToggle}
          openFile={openFile}
          workspacePath={workspacePath}
        />
      ))}
      {pageCount > 1 ? (
        <div
          className="flex items-center justify-between gap-2 py-1.5 pr-3 text-[11px] text-muted-foreground"
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          <button
            type="button"
            disabled={page === 0}
            className="hover:text-foreground disabled:opacity-35"
            onClick={() => setPageState({ nodesPageKey, requestedPage: Math.max(0, page - 1) })}
          >
            上一页
          </button>
          <span className="tabular-nums">
            {pageStart + 1}-{pageEnd} / {nodes.length}
          </span>
          <button
            type="button"
            disabled={page >= pageCount - 1}
            className="hover:text-foreground disabled:opacity-35"
            onClick={() =>
              setPageState({
                nodesPageKey,
                requestedPage: Math.min(pageCount - 1, page + 1)
              })
            }
          >
            下一页
          </button>
        </div>
      ) : null}
    </>
  )
}

const FileTreeNode = memo(
  function FileTreeNode({
    node,
    depth,
    expanded,
    onToggle,
    openFile,
    workspacePath
  }: {
    node: TreeNode
    depth: number
    expanded: Set<string>
    onToggle: (path: string) => void
    openFile?: (path: string, name: string) => void
    workspacePath: string
  }): React.JSX.Element {
    useSyncExternalStore(
      useCallback(
        (listener) =>
          node.is_dir || !workspacePath
            ? () => undefined
            : subscribeWorkspaceFilePathChanges(workspacePath, node.path, listener),
        [node.is_dir, node.path, workspacePath]
      ),
      useCallback(
        () =>
          node.is_dir || !workspacePath
            ? 0
            : getWorkspaceFilePathRevision(workspacePath, node.path),
        [node.is_dir, node.path, workspacePath]
      ),
      () => 0
    )
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
          {!node.is_dir && node.file?.size !== undefined && (
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {formatSize(node.file.size)}
            </span>
          )}
        </div>

        {/* Children */}
        {node.is_dir && isExpanded && (
          <FileTreeNodeList
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            openFile={openFile}
            workspacePath={workspacePath}
          />
        )}
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
      prevProps.workspacePath === nextProps.workspacePath &&
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

  const statusBadge =
    phase === "generating"
      ? { icon: Loader2, variant: "info" as const, label: "生成中", spin: true }
      : phase === "done"
        ? { icon: CheckCircle2, variant: "nominal" as const, label: "已完成", spin: false }
        : { icon: AlertCircle, variant: "critical" as const, label: "执行失败", spin: false }

  const StatusIcon = statusBadge.icon

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm",
        phase === "generating" && "border-status-info/50"
      )}
    >
      {/* Header */}
      <div className="p-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium truncate">
            <Sparkles
              className={cn(
                "size-4 shrink-0",
                phase === "generating" ? "text-status-info" : "text-muted-foreground"
              )}
            />
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
                  {expanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
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

function AgentsContent({ threadId }: { threadId: string | null }): React.JSX.Element {
  const {
    currentThreadId: storeCurrentThreadId,
    skillGenerationByThread,
    skillRetryContextByThread,
    setSkillGenerationPhase
  } = useAppStore(
    useShallow((s) => ({
      currentThreadId: s.currentThreadId,
      skillGenerationByThread: s.skillGenerationByThread,
      skillRetryContextByThread: s.skillRetryContextByThread,
      setSkillGenerationPhase: s.setSkillGenerationPhase
    }))
  )
  const skillGenerationAgent = selectSkillGenerationAgent(
    { skillGenerationByThread } as Parameters<typeof selectSkillGenerationAgent>[0],
    threadId
  )
  const skillRetryContext = selectSkillRetryContext(
    { skillRetryContextByThread } as Parameters<typeof selectSkillRetryContext>[0],
    threadId
  )
  const canMutateCurrentThreadState = threadId === storeCurrentThreadId
  const retryInFlightRef = useRef(false)
  const subagents = useThreadStateSelector(threadId, (state) => state.subagents) ?? []
  const coordinatorWorkers =
    useThreadStateSelector(threadId, (state) => state.coordinatorWorkers) ?? []
  const hasRunningCoordinatorWorker = coordinatorWorkers.some(
    (worker) => worker.status === "running"
  )
  const [sharedNowMs, setSharedNowMs] = useState(() => Date.now())

  const hasSkillGen = skillGenerationAgent.phase !== null

  const handleRetry = useCallback((): void => {
    if (!threadId || !canMutateCurrentThreadState || !skillRetryContext || retryInFlightRef.current)
      return
    retryInFlightRef.current = true
    void window.api.skillEvolution
      .retryGeneration(threadId, skillRetryContext)
      .catch((err: unknown) => {
        console.error("[SkillGen] Retry IPC failed:", err)
        setSkillGenerationPhase("error", err instanceof Error ? err.message : "重试失败")
      })
      .finally(() => {
        retryInFlightRef.current = false
      })
  }, [canMutateCurrentThreadState, threadId, skillRetryContext, setSkillGenerationPhase])

  useEffect(() => {
    if (!hasRunningCoordinatorWorker) return
    const timer = window.setInterval(() => setSharedNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunningCoordinatorWorker])

  if (subagents.length === 0 && coordinatorWorkers.length === 0 && !hasSkillGen) {
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
            canMutateCurrentThreadState && skillGenerationAgent.phase === "error"
              ? () => setSkillGenerationPhase(null)
              : undefined
          }
          onRetry={
            canMutateCurrentThreadState &&
            (skillGenerationAgent.phase === "error" ||
              skillGenerationAgent.phase === "generating") &&
            skillRetryContext
              ? handleRetry
              : undefined
          }
        />
      )}
      {subagents.map((agent) => (
        <SubagentCard key={agent.id} subagent={agent} threadId={threadId} />
      ))}
      {coordinatorWorkers.map((worker) => (
        <CoordinatorWorkerCard
          key={worker.worker_id}
          worker={worker}
          threadId={threadId ?? undefined}
          nowMs={sharedNowMs}
        />
      ))}
    </div>
  )
}

function CoordinatorWorkerCard({
  worker,
  threadId,
  nowMs
}: {
  worker: CoordinatorWorkerView
  threadId?: string
  nowMs: number
}): React.JSX.Element {
  const isRunning = worker.status === "running"
  const [detailsOpen, setDetailsOpen] = useState(false)
  const openWorkerFocusView = useAppStore((state) => state.openWorkerFocusView)
  const roleLabel = worker.role === "implementer" ? "实现者" : "验证者"
  const workload = worker.workload ?? (worker.role === "verifier" ? "verify" : "write")
  const ownedFiles = worker.owned_files ?? []
  const workloadLabel = workload === "read_only" ? "只读" : workload === "verify" ? "验证" : "写入"
  const statusMeta = getCoordinatorWorkerStatusMeta(worker.status)
  const startedAtMs = safeDateMs(worker.last_started_at ?? worker.created_at)
  const completedAtMs = isRunning
    ? nowMs
    : deriveCoordinatorWorkerCompletedAtMs(worker, startedAtMs)
  const durationMs = isRunning
    ? Math.max(0, nowMs - startedAtMs)
    : (worker.duration_ms ?? Math.max(0, completedAtMs - startedAtMs))
  const activityAgoMs = worker.last_activity_at
    ? Math.max(0, nowMs - safeDateMs(worker.last_activity_at))
    : null
  const activityLabel =
    isRunning && activityAgoMs !== null ? `${formatCompactElapsed(activityAgoMs)}无新工具` : null
  const StatusIcon = statusMeta.icon

  const openWorkerFile = useCallback(
    (filePath?: string) => {
      if (!threadId || !filePath) return
      const resolvedPath = resolveCoordinatorWorkerPreviewPath(worker.parent_thread_id, filePath)
      if (!resolvedPath) {
        toast.error("Worker 结果路径无效，已阻止打开")
        return
      }
      emitOpenResourcePreview({
        threadId,
        filePath: resolvedPath
      })
    },
    [threadId, worker.parent_thread_id]
  )

  const tokenLabel = formatCoordinatorWorkerTokenUsage(worker.token_usage)
  const hasAnyFile = Boolean(worker.result_path || worker.report_path)
  const canOpenToolStream = Boolean(threadId && worker.worker_thread_id)
  const openWorkerStream = useCallback((): void => {
    if (!threadId || !worker.worker_thread_id) return
    openWorkerFocusView({
      threadId,
      workerId: worker.worker_id,
      workerThreadId: worker.worker_thread_id,
      role: worker.role,
      description: worker.description,
      status: worker.status
    })
  }, [
    openWorkerFocusView,
    threadId,
    worker.description,
    worker.role,
    worker.status,
    worker.worker_id,
    worker.worker_thread_id
  ])

  return (
    <div
      className={cn(
        "group overflow-hidden rounded-xl border bg-background/95 text-xs shadow-sm transition-colors",
        isRunning
          ? "border-sky-300/80 shadow-sky-500/10"
          : worker.status === "completed"
            ? "border-border/80"
            : worker.status === "failed"
              ? "border-red-300/70"
              : "border-border/70"
      )}
    >
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <div
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
                isRunning
                  ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/35 dark:text-sky-300"
                  : worker.status === "failed"
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-300"
                    : "border-stone-200 bg-stone-50 text-stone-700 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-300"
              )}
            >
              <StatusIcon className={cn("size-4", statusMeta.iconClass)} />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {roleLabel}
                </span>
                <span className="rounded-md border border-border/70 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {worker.turns} 轮
                </span>
                <span className="rounded-md border border-border/70 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {workloadLabel}
                </span>
              </div>
              <div className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
                {worker.description}
              </div>
            </div>
          </div>
          <Badge className={cn("shrink-0 rounded-md border px-2 py-0.5", statusMeta.badgeClass)}>
            {statusMeta.label}
          </Badge>
        </div>
      </div>

      <div className="px-3 py-3">
        {canOpenToolStream && (
          <button
            type="button"
            onClick={openWorkerStream}
            className={cn(
              "mb-3 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
              "border-slate-200/90 bg-gradient-to-b from-white to-slate-50/90 text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]",
              "hover:border-slate-300 hover:from-white hover:to-slate-100 hover:shadow-[0_4px_14px_rgba(15,23,42,0.08)]",
              "dark:border-slate-700/80 dark:from-slate-900 dark:to-slate-950 dark:text-slate-100 dark:hover:border-slate-600"
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-sky-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-sky-300">
                <Code2 className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold leading-none">打开工具流</span>
                <span className="mt-1 block truncate text-[10px] text-slate-500 dark:text-slate-400">
                  查看消息、工具参数和执行结果
                </span>
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 dark:text-slate-500" />
          </button>
        )}

        <div className="rounded-lg border border-border/55 bg-muted/20 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 font-medium text-foreground/90">
              <Code2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {worker.last_tool_name
                  ? getToolLabel(worker.last_tool_name, { showToolName: false })
                  : "等待工具调用"}
              </span>
            </span>
            <span className="shrink-0 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {worker.tool_call_count} 次
            </span>
          </div>
          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            <div className="truncate">
              <span className="text-foreground/70">状态：</span>
              {activityLabel || compactInline(worker.last_event || statusMeta.label)}
            </div>
            <div className="truncate">
              <span className="text-foreground/70">耗时：</span>
              {formatCompactElapsed(durationMs)}
            </div>
            {(worker.summary || worker.error || worker.result_path || worker.report_path) && (
              <div className="truncate">
                <span className="text-foreground/70">
                  {worker.status === "failed" || worker.status === "cancelled"
                    ? "结果："
                    : "摘要："}
                </span>
                {compactInline(
                  worker.error || worker.summary || worker.result_path || worker.report_path || ""
                )}
              </div>
            )}
            {tokenLabel && (
              <div className="truncate">
                <span className="text-foreground/70">Token：</span>
                {tokenLabel}
              </div>
            )}
          </div>
        </div>

        {(hasAnyFile || ownedFiles.length > 0 || tokenLabel) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {worker.result_path && (
              <button
                type="button"
                onClick={() => openWorkerFile(worker.result_path)}
                className="rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                结果
              </button>
            )}
            {worker.report_path && (
              <button
                type="button"
                onClick={() => openWorkerFile(worker.report_path)}
                className="rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                报告
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              className="rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              {detailsOpen ? "收起细节" : "更多信息"}
            </button>
          </div>
        )}
      </div>

      {detailsOpen && (
        <div className="mx-3 mb-3 space-y-1 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="truncate">
            <span className="text-foreground/70">Worker：</span>
            {worker.worker_id}
          </div>
          <div className="truncate">
            <span className="text-foreground/70">Thread：</span>
            {worker.worker_thread_id}
          </div>
          {ownedFiles.length > 0 && (
            <div className="line-clamp-2">
              <span className="text-foreground/70">Owned files：</span>
              {ownedFiles.join(", ")}
            </div>
          )}
          {worker.result_path && (
            <div className="truncate">
              <span className="text-foreground/70">Result：</span>
              {worker.result_path}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getCoordinatorWorkerStatusMeta(status: CoordinatorWorkerView["status"]): {
  label: string
  icon: React.ElementType
  iconClass: string
  badgeClass: string
} {
  if (status === "running") {
    return {
      label: "运行中",
      icon: Loader2,
      iconClass: "animate-spin text-blue-600 dark:text-blue-400",
      badgeClass: "bg-blue-500/10 text-blue-700 hover:bg-blue-500/10 dark:text-blue-300"
    }
  }
  if (status === "completed") {
    return {
      label: "已完成",
      icon: CheckCircle2,
      iconClass: "text-stone-600 dark:text-stone-300",
      badgeClass:
        "border-stone-200 bg-stone-100 text-stone-700 hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/65 dark:text-stone-300"
    }
  }
  if (status === "failed") {
    return {
      label: "失败",
      icon: AlertCircle,
      iconClass: "text-red-600 dark:text-red-400",
      badgeClass: "bg-red-500/10 text-red-700 hover:bg-red-500/10 dark:text-red-300"
    }
  }
  return {
    label: "已取消",
    icon: XCircle,
    iconClass: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground hover:bg-muted"
  }
}

function formatCoordinatorWorkerTokenUsage(
  usage: CoordinatorWorkerView["token_usage"] | undefined
): string {
  if (!usage) return ""
  const total = usage.total_tokens
  const input = usage.input_tokens
  const output = usage.output_tokens
  const parts = [
    typeof total === "number" ? `总 ${total}` : "",
    typeof input === "number" ? `输入 ${input}` : "",
    typeof output === "number" ? `输出 ${output}` : ""
  ].filter(Boolean)
  return parts.join("，")
}

function resolveCoordinatorWorkerPreviewPath(
  threadId: string,
  filePath: string
): string | undefined {
  const normalized = filePath.trim().replace(/\\/g, "/")
  if (!normalized) return undefined
  if (isAbsolutePath(normalized) || normalized.split("/").includes("..")) return undefined
  const coordinatorReportsPrefix = `.cmbdevclaw/coordinator/${threadId}/reports/`
  if (normalized.startsWith(".cmbdevclaw/")) {
    return normalized.startsWith(coordinatorReportsPrefix) ? normalized : undefined
  }
  if (normalized.startsWith("reports/") || normalized === "state.json") {
    return `.cmbdevclaw/coordinator/${threadId}/${normalized}`
  }
  return undefined
}

function compactInline(value: string): string {
  const compacted = value.replace(/\s+/g, " ").trim()
  if (compacted.length <= 96) return compacted
  return `${compacted.slice(0, 46)}...${compacted.slice(-32)}`
}

function safeDateMs(value: string | undefined): number {
  if (!value) return Date.now()
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function deriveCoordinatorWorkerCompletedAtMs(
  worker: CoordinatorWorkerView,
  startedAtMs: number
): number {
  if (worker.finished_at) return safeDateMs(worker.finished_at)
  if (worker.last_activity_at) return safeDateMs(worker.last_activity_at)
  if (worker.updated_at) return safeDateMs(worker.updated_at)
  if (typeof worker.duration_ms === "number" && Number.isFinite(worker.duration_ms)) {
    return startedAtMs + Math.max(0, worker.duration_ms)
  }
  return startedAtMs
}

function formatCompactElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "刚刚"
  if (ms < 1000) return "刚刚"

  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes} 分钟` : `${minutes}分${remainingSeconds}秒`
  }

  const hours = Math.floor(minutes / 60)
  return `${hours} 小时+`
}

function normalizeRightPanelSkillName(value?: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
}

function resolveRightPanelSkillMarketInfo(
  skill: SkillMetadata,
  marketSkillMap: Record<string, RightPanelSkillMarketInfo>
): RightPanelSkillMarketInfo | undefined {
  if (skill.pluginId || skill.pluginName) return undefined
  if (skill.source !== "user") return undefined
  return marketSkillMap[normalizeRightPanelSkillName(skill.name)]
}

function getRightPanelSkillDisplayName(
  skill: SkillMetadata,
  marketSkillMap: Record<string, RightPanelSkillMarketInfo>
): string {
  const marketInfo = resolveRightPanelSkillMarketInfo(skill, marketSkillMap)
  if (!marketInfo) return skill.name

  const marketChinese = marketInfo.chinese_name?.trim()
  if (marketChinese) return marketChinese

  const metadataChinese = skill.metadata?.chinese_name?.trim()
  return metadataChinese || skill.name
}

function SkillsContent({
  skills,
  disabledSkills,
  marketSkillMap,
  threadId
}: {
  skills: SkillMetadata[]
  disabledSkills: Set<string>
  marketSkillMap: Record<string, RightPanelSkillMarketInfo>
  threadId?: string | null
}): React.JSX.Element {
  const [asyncProjectionState, setAsyncProjectionState] = useState<{
    skills: SkillMetadata[]
    disabledSkills: Set<string>
    projection: RightPanelSkillProjection | null
  }>({ skills: [], disabledSkills: new Set(), projection: null })
  const synchronousProjection =
    skills.length <= RIGHT_PANEL_SYNC_SKILL_PROJECTION_LIMIT
      ? getRightPanelSkillProjection(skills, disabledSkills)
      : null
  const projection =
    synchronousProjection ??
    (asyncProjectionState.skills === skills &&
    asyncProjectionState.disabledSkills === disabledSkills
      ? asyncProjectionState.projection
      : null)
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<Set<string>>(new Set())
  const [visibleTreeNodeCounts, setVisibleTreeNodeCounts] = useState<Map<string, number>>(new Map())
  const previewGrantGenerationRef = useRef(0)

  useEffect(() => {
    return () => {
      previewGrantGenerationRef.current += 1
      void window.api.skills.cancelPreviewGrant().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (skills.length <= RIGHT_PANEL_SYNC_SKILL_PROJECTION_LIMIT) {
      return undefined
    }

    void getRightPanelSkillProjectionAsync(skills, disabledSkills).then((nextProjection) => {
      if (!cancelled) {
        setAsyncProjectionState({ skills, disabledSkills, projection: nextProjection })
      }
    })
    return () => {
      cancelled = true
    }
  }, [disabledSkills, skills])

  const toggleTreeNode = useCallback((nodeKey: string) => {
    setExpandedTreeNodes((prev) => {
      const next = new Set(prev)
      if (next.has(nodeKey)) next.delete(nodeKey)
      else next.add(nodeKey)
      return next
    })
  }, [])
  const openSkillPreview = useCallback(
    async (skill: SkillMetadata): Promise<void> => {
      if (!threadId) {
        toast.error("当前线程不可用，无法预览技能文件")
        return
      }
      if (!skill.path) {
        toast.error("未找到技能文件路径")
        return
      }
      if (!skill.id) {
        toast.error("技能身份不完整，无法安全预览")
        return
      }
      const generation = previewGrantGenerationRef.current + 1
      previewGrantGenerationRef.current = generation
      try {
        const authorized = await window.api.skills.requestPreviewGrant({
          id: skill.id,
          name: skill.name,
          source: skill.source,
          ...(skill.pluginId ? { pluginId: skill.pluginId } : {})
        })
        if (generation !== previewGrantGenerationRef.current) return
        if (!authorized.success) {
          toast.error(authorized.error || "技能文件未获得可信来源授权")
          return
        }
        emitOpenResourcePreview({
          threadId,
          filePath: authorized.filePath,
          externalPreviewGrant: authorized.grant
        })
      } catch (error) {
        if (generation !== previewGrantGenerationRef.current) return
        console.error("[RightPanel] Failed to authorize skill preview:", error)
        toast.error("技能预览授权失败")
      }
    },
    [threadId]
  )

  if (!projection) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="size-6 animate-spin opacity-60" />
        <span>正在整理技能目录…</span>
      </div>
    )
  }

  if (projection.enabled.length + projection.disabled.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Sparkles className="size-8 mb-2 opacity-50" />
        <span>暂无技能</span>
      </div>
    )
  }

  const renderSkillTree = (
    group: RightPanelSkillGroupProjection,
    disabled: boolean,
    rootScopeKey: string
  ): React.JSX.Element | null => {
    if (group.skills.length === 0) return null

    const renderNodes = (nodes: RightPanelSkillTreeNode[], scopeKey: string): React.JSX.Element => {
      const visibleCount = visibleTreeNodeCounts.get(scopeKey) ?? RIGHT_PANEL_INITIAL_RENDER_ITEMS
      const visibleNodes = selectRightPanelWindow(nodes, visibleCount)
      const remainingCount = Math.max(0, nodes.length - visibleNodes.length)
      return (
        <div className="space-y-2">
          {visibleNodes.map((node) => {
            const childCount = node.children.reduce((sum, child) => sum + child.skillCount, 0)
            const childrenExpanded = expandedTreeNodes.has(node.key)
            const displayName = node.skill
              ? getRightPanelSkillDisplayName(node.skill, marketSkillMap)
              : node.label
            return (
              <div key={node.key} className="space-y-2">
                {node.skill ? (
                  <div
                    className={cn("p-3 rounded-sm border border-border", disabled && "opacity-60")}
                  >
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      <Sparkles
                        className={cn(
                          "size-3.5 shrink-0",
                          disabled ? "text-muted-foreground" : "text-amber-500"
                        )}
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          disabled && "text-muted-foreground line-through"
                        )}
                      >
                        {displayName}
                      </span>
                      <IconPopoverButton
                        icon={<Eye className="size-3.5" />}
                        popoverContent="可以预览完整信息"
                        aria-label="预览完整技能信息"
                        className="shrink-0 rounded-md p-1"
                        stopPropagation
                        onClick={() => {
                          if (!node.skill) return
                          void openSkillPreview(node.skill)
                        }}
                      />
                      {(node.skill.pluginName || node.skill.pluginId) && (
                        <div className="mt-1 flex min-w-0 items-center gap-1">
                          <Badge
                            variant="outline"
                            className="min-w-0 max-w-full text-[10px] h-4 px-1.5 border-violet-300/70 bg-violet-500/10 text-violet-700 dark:border-violet-500/30 dark:text-violet-300"
                            title={`来自插件：${node.skill.pluginName ?? node.skill.pluginId}`}
                          >
                            <span className="truncate">插件</span>
                          </Badge>
                        </div>
                      )}

                      {childCount > 0 && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0 gap-1">
                          <Folder className="mr-1 size-2.5" />
                          {childCount}
                        </Badge>
                      )}
                      {disabled && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                          已禁用
                        </Badge>
                      )}
                    </div>

                    {node.skill.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {node.skill.description}
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    className="flex min-h-9 w-full items-center gap-2 rounded-sm border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/35"
                    onClick={() => toggleTreeNode(node.key)}
                    title={node.title ?? node.label}
                  >
                    {childrenExpanded ? (
                      <ChevronDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0" />
                    )}
                    <Folder className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{node.label}</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                      {node.skillCount}
                    </Badge>
                  </button>
                )}

                {node.skill && node.children.length > 0 && (
                  <button
                    className="ml-3 flex min-h-7 w-[calc(100%-0.75rem)] items-center gap-2 rounded-sm border border-dashed border-border/60 bg-muted/15 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/30"
                    onClick={() => toggleTreeNode(node.key)}
                  >
                    {childrenExpanded ? (
                      <ChevronDown className="size-3 shrink-0" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0" />
                    )}
                    <Folder className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">子技能</span>
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                      {childCount}
                    </Badge>
                  </button>
                )}

                {node.children.length > 0 && childrenExpanded && (
                  <div className="ml-3 border-l border-border/60 pl-2">
                    {renderNodes(node.children, node.key)}
                  </div>
                )}
              </div>
            )
          })}
          {remainingCount > 0 && (
            <button
              type="button"
              className="w-full rounded-sm border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/35"
              onClick={() => {
                setVisibleTreeNodeCounts((current) => {
                  const next = new Map(current)
                  next.set(scopeKey, visibleCount + RIGHT_PANEL_RENDER_PAGE_ITEMS)
                  return next
                })
              }}
            >
              继续显示（剩余 {remainingCount} 项）
            </button>
          )}
        </div>
      )
    }

    return renderNodes(group.tree, rootScopeKey)
  }

  const renderSceneGroup = (
    title: string,
    group: RightPanelSkillGroupProjection,
    isDisabledGroup: boolean
  ): React.JSX.Element | null => {
    if (group.skills.length === 0) return null
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
            {title}
          </span>
          <Badge variant="outline" className="text-[10px] h-5">
            {group.skills.length}
          </Badge>
        </div>
        {renderSkillTree(
          group,
          isDisabledGroup,
          `${isDisabledGroup ? "disabled" : "enabled"}:${title}`
        )}
      </div>
    )
  }

  const renderStatusSection = (
    title: string,
    sectionSkills: SkillMetadata[],
    generalGroup: RightPanelSkillGroupProjection,
    programmingGroup: RightPanelSkillGroupProjection,
    isDisabledGroup: boolean,
    defaultOpen: boolean
  ): React.JSX.Element | null => {
    if (sectionSkills.length === 0) return null
    const content = (
      <div className="space-y-3 pt-2">
        {renderSceneGroup("通用场景", generalGroup, isDisabledGroup)}
        {renderSceneGroup("编程场景", programmingGroup, isDisabledGroup)}
      </div>
    )

    if (isDisabledGroup) {
      return (
        <details
          className="rounded-sm border border-border/70 bg-muted/20 px-2 py-2"
          open={defaultOpen}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
            <span>{title}</span>
            <Badge variant="outline" className="text-[10px] h-5">
              {sectionSkills.length}
            </Badge>
          </summary>
          {content}
        </details>
      )
    }

    return (
      <div className="rounded-sm border border-emerald-200/70 bg-emerald-50/35 px-2 py-2 dark:border-emerald-900/40 dark:bg-emerald-950/10">
        <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
          <span>{title}</span>
          <Badge variant="outline" className="text-[10px] h-5">
            {sectionSkills.length}
          </Badge>
        </div>
        {content}
      </div>
    )
  }

  return (
    <div className="p-3 space-y-2">
      {renderStatusSection(
        "已启用技能",
        projection.enabled,
        projection.enabledGeneral,
        projection.enabledProgramming,
        false,
        true
      )}
      {renderStatusSection(
        "已禁用技能",
        projection.disabled,
        projection.disabledGeneral,
        projection.disabledProgramming,
        true,
        false
      )}
    </div>
  )
}

function PluginsContent({ plugins }: { plugins: PluginMetadata[] }): React.JSX.Element {
  const [visiblePluginCount, setVisiblePluginCount] = useState(RIGHT_PANEL_INITIAL_RENDER_ITEMS)
  const pluginWindow = useMemo(
    () =>
      selectRightPanelPrioritizedWindow(plugins, visiblePluginCount, (plugin) => plugin.enabled),
    [plugins, visiblePluginCount]
  )

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Puzzle className="size-8 mb-2 opacity-50" />
        <span>暂无插件</span>
        <span className="text-xs mt-1">在自定义面板中安装插件</span>
      </div>
    )
  }

  const renderPluginCard = (plugin: PluginMetadata): React.JSX.Element => (
    <div
      key={plugin.id}
      className={cn("p-3 rounded-sm border border-border", !plugin.enabled && "opacity-60")}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Puzzle
          className={cn(
            "size-3.5 shrink-0",
            plugin.enabled ? "text-primary" : "text-muted-foreground"
          )}
        />
        <span className={cn("flex-1 truncate", !plugin.enabled && "text-muted-foreground")}>
          {plugin.name}
        </span>
        <Power
          className={cn(
            "size-3 shrink-0",
            plugin.enabled ? "text-status-nominal" : "text-muted-foreground"
          )}
        />
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
        {(plugin.hookCount ?? 0) > 0 && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Webhook className="size-2.5" />
            {plugin.hookCount ?? 0} hooks
          </span>
        )}
      </div>
    </div>
  )

  return (
    <div className="p-3 space-y-2">
      {pluginWindow.enabled.length > 0 && pluginWindow.enabled.map(renderPluginCard)}
      {pluginWindow.disabled.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground tracking-wider font-medium">
              已禁用
            </span>
            <Badge variant="outline" className="text-[10px] h-5">
              {pluginWindow.disabledCount}
            </Badge>
          </div>
          {pluginWindow.disabled.map(renderPluginCard)}
        </div>
      )}
      {pluginWindow.remainingCount > 0 && (
        <button
          type="button"
          className="w-full rounded-sm border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/35"
          onClick={() => setVisiblePluginCount((count) => count + RIGHT_PANEL_RENDER_PAGE_ITEMS)}
        >
          继续显示（剩余 {pluginWindow.remainingCount} 项）
        </button>
      )}
    </div>
  )
}

// Only the events the runtime actually emits (SUPPORTED_HOOK_EVENTS in src/main/hooks/types.ts).
// Adding rows here for unsupported events is dead UI and misleads readers.
const EVENT_BADGE_COLORS: Record<string, string> = {
  PreToolUse: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PostToolUse: "bg-green-500/15 text-green-600 dark:text-green-400",
  PreSkillUse: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PostSkillUse: "bg-green-500/15 text-green-600 dark:text-green-400",
  UserPromptSubmit: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  SessionStart: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  SessionEnd: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  Stop: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  Notification: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  SubagentStop: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
}

const EVENT_LABEL: Record<string, string> = {
  PreToolUse: "调用前",
  PostToolUse: "调用后",
  PreSkillUse: "技能前",
  PostSkillUse: "技能后",
  UserPromptSubmit: "提交",
  SessionStart: "会话始",
  SessionEnd: "会话终",
  Stop: "停止",
  Notification: "通知",
  SubagentStop: "子停止"
}

const TOOL_LABEL: Record<string, string> = {
  execute: "执行命令",
  write_file: "写入文件",
  edit_file: "编辑文件",
  read_file: "读取文件",
  memory_search: "搜索记忆",
  memory_get: "读取记忆",
  manage_scheduler: "调度任务",
  manage_skill: "技能管理"
}

type HookSourceGroup = {
  key: string
  sourceLabel: string
  title: string
  detail?: string
  fullPath?: string
  badgeClassName: string
  priority: number
  hooks: DisplayHook[]
}

function getHookSummary(hook: DisplayHook): string {
  if (hook.type === "prompt") return hook.prompt ?? ""
  if (hook.type === "http") return hook.url ?? ""
  return hook.command ?? ""
}

function getCompactPath(pathValue?: string): string | undefined {
  if (!pathValue) return undefined
  const normalized = pathValue.replace(/\\/g, "/").replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length <= 2) return normalized
  return parts.slice(-2).join("/")
}

function getHookSourcePath(hook: DisplayHook): string | undefined {
  return hook.hookPath ?? hook.hookSourcePath
}

function getHookSourceGroupInfo(hook: DisplayHook): Omit<HookSourceGroup, "hooks"> {
  const sourcePath = getHookSourcePath(hook)
  const compactPath = getCompactPath(sourcePath)

  if (hook.source === "workspace") {
    return {
      key: `workspace:${sourcePath ?? "current"}`,
      sourceLabel: "工作区",
      title: compactPath ?? "当前工作区",
      fullPath: sourcePath,
      badgeClassName: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      priority: 0
    }
  }

  if (hook.source === "global") {
    return {
      key: "global",
      sourceLabel: "全局",
      title: "全局 hooks.json",
      detail: compactPath,
      fullPath: sourcePath,
      badgeClassName: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      priority: 1
    }
  }

  if (hook.source === "plugin") {
    const title = hook.pluginName ?? hook.pluginId ?? compactPath ?? "未命名插件"
    return {
      key: `plugin:${hook.pluginId ?? hook.pluginName ?? sourcePath ?? "unknown"}`,
      sourceLabel: "插件",
      title,
      detail: compactPath,
      fullPath: sourcePath,
      badgeClassName: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
      priority: 2
    }
  }

  const isPluginSkillHook = Boolean(hook.pluginName || hook.pluginId)
  const skillTitle = hook.skillName ?? compactPath ?? "未命名技能"
  const pluginLabel = hook.pluginName ?? hook.pluginId
  return {
    key: `${isPluginSkillHook ? "plugin-skill" : "skill"}:${
      hook.pluginId ?? hook.pluginName ?? ""
    }:${hook.skillPath ?? hook.skillName ?? sourcePath ?? "unknown"}`,
    sourceLabel: isPluginSkillHook ? "插件技能" : "技能",
    title: isPluginSkillHook && pluginLabel ? `${pluginLabel} · ${skillTitle}` : skillTitle,
    detail: compactPath,
    fullPath: sourcePath,
    badgeClassName: isPluginSkillHook
      ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
      : "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    priority: isPluginSkillHook ? 3 : 4
  }
}

function buildHookSourceGroups(hooks: DisplayHook[]): HookSourceGroup[] {
  const groups = new Map<string, HookSourceGroup>()

  for (const hook of hooks) {
    const info = getHookSourceGroupInfo(hook)
    const existing = groups.get(info.key)
    if (existing) {
      existing.hooks.push(hook)
    } else {
      groups.set(info.key, { ...info, hooks: [hook] })
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.priority - b.priority || a.title.localeCompare(b.title, "zh-Hans-CN")
  )
}

function HooksContent({
  hooks,
  truncated
}: {
  hooks: DisplayHook[]
  truncated: boolean
}): React.JSX.Element {
  const [visibleHookCount, setVisibleHookCount] = useState(RIGHT_PANEL_INITIAL_RENDER_ITEMS)
  const hookWindow = useMemo(
    () => selectRightPanelPrioritizedWindow(hooks, visibleHookCount, (hook) => hook.enabled),
    [hooks, visibleHookCount]
  )
  const enabledGroups = useMemo(() => buildHookSourceGroups(hookWindow.enabled), [hookWindow])
  const disabledGroups = useMemo(() => buildHookSourceGroups(hookWindow.disabled), [hookWindow])

  if (hooks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-4">
        <Webhook className="size-8 mb-2 opacity-50" />
        <span>暂无钩子</span>
        <span className="text-xs mt-1">在自定义面板、插件、技能或工作区中添加钩子</span>
      </div>
    )
  }

  const handleToggle = async (hook: DisplayHook): Promise<void> => {
    try {
      if (hook.source !== "global") return
      await window.api.hooks.setEnabled(hook.id, !hook.enabled)
    } catch (e) {
      console.error("[HooksContent] Failed to toggle hook:", e)
    }
  }

  const renderHookCard = (hook: DisplayHook): React.JSX.Element => {
    const isPrompt = hook.type === "prompt"
    const isWorkspaceHook = hook.source === "workspace"
    const isGlobalHook = hook.source === "global"
    const isPluginHook = hook.source === "plugin"
    const isSkillHook = hook.source === "skill"
    // A plugin-owned skill hook: source="skill" but with pluginName / pluginId set.
    // Show its origin (plugin → skill) so users can tell it apart from a stand-alone skill hook.
    const isPluginSkillHook = isSkillHook && Boolean(hook.pluginName || hook.pluginId)
    const summary = getHookSummary(hook)
    const ownerLabel = isPluginHook
      ? hook.pluginName
      : isPluginSkillHook && hook.skillName
        ? `${hook.pluginName ?? hook.pluginId} · ${hook.skillName}`
        : isSkillHook
          ? hook.skillName
          : undefined
    const readonlyTitle = isWorkspaceHook
      ? "工作区 Hook 由工作区配置管理"
      : isPluginHook
        ? "插件 Hook 请在插件详情页管理"
        : isSkillHook
          ? "技能 Hook 请在技能目录或技能管理页管理"
          : ""
    return (
      <div
        key={getHookCatalogIdentity(hook)}
        className={cn(
          "min-w-0 overflow-hidden p-3 rounded-sm border border-border",
          !hook.enabled && "opacity-60"
        )}
      >
        <div className="flex min-w-0 items-start gap-2 text-sm">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "max-w-full truncate text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0",
                EVENT_BADGE_COLORS[hook.event] ?? "bg-muted text-muted-foreground"
              )}
              title={hook.event}
            >
              {EVENT_LABEL[hook.event] ?? hook.event}
            </span>
            {isGlobalHook && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-sky-500/15 text-sky-600 dark:text-sky-400">
                全局
              </span>
            )}
            {isWorkspaceHook && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                工作区
              </span>
            )}
            {isPluginHook && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-violet-500/15 text-violet-600 dark:text-violet-400">
                插件
              </span>
            )}
            {isPluginSkillHook && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-violet-500/15 text-violet-600 dark:text-violet-400"
                title={`插件 ${hook.pluginName ?? hook.pluginId} 中的技能`}
              >
                插件
              </span>
            )}
            {isSkillHook && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                技能
              </span>
            )}
            {isPrompt && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-violet-500/15 text-violet-600 dark:text-violet-400">
                策略
              </span>
            )}
            {ownerLabel && (
              <span
                className="min-w-0 max-w-[120px] truncate text-[10px] text-muted-foreground"
                title={ownerLabel}
              >
                {ownerLabel}
              </span>
            )}
            {hook.matcher && hook.matcher !== "*" && (
              <span
                className="min-w-0 max-w-[140px] truncate text-[10px] text-muted-foreground font-mono"
                title={hook.matcher}
              >
                {TOOL_LABEL[hook.matcher] ?? hook.matcher}
              </span>
            )}
          </div>
          {!isGlobalHook ? (
            <span
              className="text-[10px] text-muted-foreground shrink-0 leading-5"
              title={readonlyTitle}
            >
              只读
            </span>
          ) : (
            <button
              className="shrink-0 leading-5"
              onClick={() => handleToggle(hook)}
              title={hook.enabled ? "点击禁用" : "点击启用"}
            >
              <Power
                className={cn(
                  "size-3",
                  hook.enabled ? "text-status-nominal" : "text-muted-foreground"
                )}
              />
            </button>
          )}
        </div>
        <p
          className={cn(
            "min-w-0 overflow-hidden text-xs text-muted-foreground mt-1.5 break-words line-clamp-2",
            isPrompt ? "italic" : "font-mono"
          )}
          title={summary}
        >
          {summary}
        </p>
      </div>
    )
  }

  const renderHookGroup = (group: HookSourceGroup): React.JSX.Element => {
    return (
      <details
        key={group.key}
        className="group/source space-y-2 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
        open
      >
        <summary
          className="flex cursor-pointer list-none items-center justify-between gap-2 px-1"
          title={group.fullPath}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open/source:rotate-90" />
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                group.badgeClassName
              )}
            >
              {group.sourceLabel}
            </span>
            <span className="min-w-0 truncate text-xs font-medium text-foreground/90">
              {group.title}
            </span>
          </div>
          <Badge
            variant="outline"
            className="h-5 shrink-0 text-[10px]"
            title={`${group.hooks.length} 个 Hook`}
          >
            {group.hooks.length}
          </Badge>
        </summary>
        {group.detail && group.detail !== group.title && (
          <div
            className="min-w-0 truncate px-6 text-[10px] text-muted-foreground"
            title={group.fullPath}
          >
            {group.detail}
          </div>
        )}
        <div className="space-y-2">{group.hooks.map(renderHookCard)}</div>
      </details>
    )
  }

  return (
    <div className="p-3 space-y-2">
      {truncated && (
        <div className="rounded-sm border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
          钩子目录过大，已按安全上限显示部分结果。
        </div>
      )}
      {enabledGroups.map(renderHookGroup)}
      {disabledGroups.length > 0 && (
        <details
          className="group/disabled rounded-sm border border-border/70 bg-muted/20 px-2 py-2"
          open={enabledGroups.length === 0}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="size-3 shrink-0 transition-transform group-open/disabled:rotate-90" />
              <span>已禁用</span>
            </span>
            <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
              {hookWindow.disabledCount}
            </Badge>
          </summary>
          <div className="space-y-2 pt-2">{disabledGroups.map(renderHookGroup)}</div>
        </details>
      )}
      {hookWindow.remainingCount > 0 && (
        <button
          type="button"
          className="w-full rounded-sm border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/35"
          onClick={() => setVisibleHookCount((count) => count + RIGHT_PANEL_RENDER_PAGE_ITEMS)}
        >
          继续显示（剩余 {hookWindow.remainingCount} 项）
        </button>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
