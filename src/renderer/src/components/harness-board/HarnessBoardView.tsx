import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  AlertCircle,
  ArrowLeft,
  Archive,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleHelp,
  FileText,
  FolderOpen,
  GitBranch,
  Info,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  SkipForward,
  Workflow,
  Zap
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { TabbedPanel } from "@/components/tabs"
import { ThreadListItem } from "@/components/sidebar/ThreadSidebar"
import { createHarnessFeatureThread } from "@/lib/harness-feature-thread"
import { getHarnessRunNextAction } from "@/lib/harness-run-next-action"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  useAllStreamLoadingStates,
  useAllThreadStates,
  useThreadContext
} from "@/lib/thread-context"
import { toast } from "sonner"
import { marketApi, type MarketItem } from "../../api/market"
import { UpdateVersionTooltip } from "@/components/customize/MarketPanel/MarketUpdateBadge"
import {
  getMarketPluginUpdateInfo,
  installMarketPluginUpdate,
  type MarketPluginUpdateInfo
} from "@/components/customize/MarketPanel/market-plugin-update"
import type {
  HarnessArtifact,
  HarnessArtifactType,
  HarnessEventStatus,
  HarnessHookLogView,
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadataUpdateInput,
  HarnessFeatureSummary,
  HarnessNodeStatus,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessSessionBinding,
  HarnessAdapterRegistryItem,
  HarnessBoardCompatibility,
  HarnessStatus,
  HarnessWorkflowNextAction,
  HarnessWorkflow,
  PluginMetadata,
  Thread
} from "@/types"
import { HARNESS_SOURCE } from "../../../../shared/harness-board-types"

const harnessActionButtonClassName =
  "cursor-pointer group relative overflow-hidden rounded-md shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md"
const harnessPageHeaderClassName =
  "h-[106px] shrink-0 border-b border-border bg-background/90 px-6 py-4 app-no-drag"
const harnessPageHeaderContentClassName =
  "flex h-full items-start justify-between gap-4"
const harnessPageHeaderActionsClassName = "flex shrink-0 items-center gap-2"

const NODE_STATUS_LABELS: Record<HarnessNodeStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "阻断",
  warning: "警告",
  error: "错误",
  skipped: "跳过",
  archived: "已归档",
  unknown: "未知"
}
const harnessDetailRefreshButtonClassName = "w-[84px] gap-2"
const harnessDetailPrimaryButtonClassName = "w-[112px] gap-2"
const harnessActionOverlayClassName =
  "pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-primary-foreground/10 to-primary-foreground/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
const harnessActionIconClassName =
  "relative flex size-4 items-center justify-center rounded-full bg-primary-foreground/15 ring-1 ring-primary-foreground/25 transition-transform duration-200 group-hover:scale-105"
const harnessProjectCreateInputClassName =
  "bg-background text-foreground placeholder:text-muted-foreground/45"
const harnessProjectCreateSelectClassName =
  "min-w-0 overflow-hidden bg-background text-foreground data-[placeholder]:text-muted-foreground/45 [&>span]:min-w-0 [&>span]:truncate"
const harnessDialogContentClassName = "z-[60]"
const harnessDialogSelectContentClassName =
  "z-[70] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]"
const harnessNamePattern = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
const harnessNameRuleMessage = "仅支持中文、英文字母、数字、-、_"
const HARNESS_SIDEBAR_PORTAL_ID = "harness-sidebar-portal"
const THREAD_UNREAD_STORAGE_KEY = "threads:unreadIds"
const OTHER_ADAPTER_SCENARIO = "其他类别"
const ADAPTER_SELECT_PLACEHOLDER = "请选择已安装的支持项目模式的插件"
const PROJECT_STATUS_POLL_INTERVAL_MS = 10000

const preventHarnessDialogOutsideClose: React.ComponentProps<typeof DialogContent>["onPointerDownOutside"] =
  (event) => {
    event.preventDefault()
  }

function areHarnessValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function mergeProjectDetailsIfChanged(
  current: Record<string, HarnessProjectDetailViewModel>,
  details: Record<string, HarnessProjectDetailViewModel>
): Record<string, HarnessProjectDetailViewModel> {
  let changed = false
  const next = { ...current }
  for (const [projectId, detail] of Object.entries(details)) {
    if (areHarnessValuesEqual(current[projectId], detail)) continue
    next[projectId] = detail
    changed = true
  }
  return changed ? next : current
}

function cleanIpcError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/, "")
}

function createEmptyProjectMetadataForm(adapterId = ""): HarnessProjectMetadataUpdateInput {
  return {
    adapterId,
    adapterType: "plugin",
    name: "",
    projectCode: "",
    projectDir: "",
    description: "",
    systemId: "",
    systemName: "",
    workspacePath: ""
  }
}

function createEmptyProjectForm(adapterId = ""): HarnessProjectCreateInput {
  return createEmptyProjectMetadataForm(adapterId)
}

interface SystemGroup {
  systemCode: string
  systemName: string
  projects: HarnessProjectListItem[]
}

interface SelectedFeature {
  projectId: string
  slug: string
  activeSessionThreadId?: string
}

type ProjectFeatureSessionGroupSection = "current" | "project" | "other"

interface ProjectFeatureSessionGroup {
  key: string
  project: HarnessProjectListItem
  slug: string
  title: string
  sessions: HarnessSessionBinding[]
  section: ProjectFeatureSessionGroupSection
}

interface GitPanelFileChange {
  path: string
  diff: string
  additions: number
  deletions: number
}

interface GitPanelDiffState {
  success: boolean
  isGitRepo?: boolean
  files: GitPanelFileChange[]
  changedFilesTotal?: number
  omittedFileCount?: number
  error?: string
}

interface AdapterScenarioGroup {
  useScenario: string
  adapters: HarnessAdapterRegistryItem[]
}

interface WorkspaceChangeGroup {
  key: string
  workspacePath: string
  sessions: Array<{
    binding: HarnessSessionBinding
  }>
  representativeThreadId: string
}

interface WorkspaceChangeState {
  status: "loading" | "ready" | "error"
  files: GitPanelFileChange[]
  changedFilesTotal: number
  omittedFileCount: number
  error?: string
}

type ThreadWorkspaceStateMap = Record<
  string,
  {
    workspacePath?: string | null
    scheduledTaskLoading?: boolean
    pendingApproval?: unknown
    pendingUserInput?: unknown
  } | undefined
>

interface HarnessFeatureThreadMetadata {
  projectId: string
  slug: string
  source: string
}

interface HarnessSessionIndex {
  byProject: Map<string, HarnessSessionBinding[]>
  byProjectSlug: Map<string, Map<string, HarnessSessionBinding[]>>
}

function getWorkspaceName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")
}

function resolveWorkspaceFilePath(filePath: string, workspacePath: string): string {
  const input = filePath.trim().replace(/\\/g, "/")
  if (!input) return workspacePath
  if (isAbsoluteFilePath(input)) return input

  const workspaceRoot = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  return `${workspaceRoot}/${input.replace(/^\/+/, "")}`
}

function resolveProjectRootPath(project: Pick<HarnessProjectListItem, "workspacePath" | "projectDir">): string {
  return resolveWorkspaceFilePath(project.projectDir, project.workspacePath)
}

async function openPathInFileManager(targetPath: string, fallbackError: string): Promise<void> {
  try {
    const platform = await window.electron.ipcRenderer.invoke("get-platform")
    const normalizedPath = platform === "win32" ? targetPath.replace(/\//g, "\\") : targetPath
    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
    if (result && typeof result === "object" && "success" in result && !result.success) {
      const error = "error" in result && typeof result.error === "string" ? result.error : fallbackError
      toast.error(error)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : fallbackError)
  }
}

function normalizeWorkspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function getThreadWorkspacePath(thread: Thread | null | undefined): string | null {
  return normalizeWorkspacePath(thread?.metadata?.workspacePath)
}

function sanitizeHarnessNameInput(value: string): string {
  return value.replace(/\s+/g, "")
}

function readThreadHarnessFeature(thread: Thread): HarnessFeatureThreadMetadata | null {
  const harnessFeature = thread.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") return null

  const metadata = harnessFeature as Record<string, unknown>
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId.trim() : ""
  const slug = typeof metadata.slug === "string" ? metadata.slug.trim() : ""
  if (!projectId || !slug) return null

  const source =
    typeof metadata.source === "string" && metadata.source.trim()
      ? metadata.source
      : HARNESS_SOURCE
  return { projectId, slug, source }
}

function toSessionTimestamp(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function buildHarnessSessionIndex(threads: Thread[]): HarnessSessionIndex {
  const byProject = new Map<string, HarnessSessionBinding[]>()
  const byProjectSlug = new Map<string, Map<string, HarnessSessionBinding[]>>()

  for (const thread of threads) {
    const metadata = readThreadHarnessFeature(thread)
    if (!metadata) continue

    const session: HarnessSessionBinding = {
      projectId: metadata.projectId,
      slug: metadata.slug,
      threadId: thread.thread_id,
      source: metadata.source,
      createdAt: toSessionTimestamp(thread.created_at),
      lastActiveAt: toSessionTimestamp(thread.updated_at)
    }

    let projectSessions = byProject.get(metadata.projectId)
    if (!projectSessions) {
      projectSessions = []
      byProject.set(metadata.projectId, projectSessions)
    }
    projectSessions.push(session)

    const slugMap = byProjectSlug.get(metadata.projectId) ?? new Map<string, HarnessSessionBinding[]>()
    let slugSessions = slugMap.get(metadata.slug)
    if (!slugSessions) {
      slugSessions = []
      slugMap.set(metadata.slug, slugSessions)
    }
    slugSessions.push(session)
    byProjectSlug.set(metadata.projectId, slugMap)
  }

  const sortSessions = (sessions: HarnessSessionBinding[]): void => {
    sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }
  for (const sessions of byProject.values()) sortSessions(sessions)
  for (const slugMap of byProjectSlug.values()) {
    for (const sessions of slugMap.values()) sortSessions(sessions)
  }

  return { byProject, byProjectSlug }
}

function getProjectSessions(index: HarnessSessionIndex, projectId: string): HarnessSessionBinding[] {
  return index.byProject.get(projectId) ?? []
}

function getFeatureSessions(index: HarnessSessionIndex, projectId: string, slug: string): HarnessSessionBinding[] {
  return index.byProjectSlug.get(projectId)?.get(slug) ?? []
}

function getProjectFeatureGroupSectionLabel(
  previousSection: ProjectFeatureSessionGroupSection | undefined,
  section: ProjectFeatureSessionGroupSection,
  hasSelectedFeature: boolean
): string | null {
  if (!previousSection || previousSection === section) return null
  if (hasSelectedFeature && previousSection === "current" && section === "project") {
    return "同项目其他特性会话"
  }
  if (hasSelectedFeature && section === "other") {
    return "其他项目特性会话"
  }
  if (section === "other") {
    return "其他特性会话"
  }
  return null
}

function withDerivedRunSessions(
  detail: HarnessRunDetailViewModel | null,
  sessions: HarnessSessionBinding[]
): HarnessRunDetailViewModel | null {
  return detail ? { ...detail, sessions } : null
}

function getHarnessSidebarPortalNode(): HTMLElement | null {
  return document.getElementById(HARNESS_SIDEBAR_PORTAL_ID)
}

function useHarnessSidebarPortalNode(): HTMLElement | null {
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(() => getHarnessSidebarPortalNode())

  useLayoutEffect(() => {
    const syncPortalNode = (): void => {
      const next = getHarnessSidebarPortalNode()
      setPortalNode((current) => (current === next ? current : next))
    }

    syncPortalNode()
    const observer = new MutationObserver(syncPortalNode)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return portalNode
}

function createUnboundRunDetail(
  detail: HarnessProjectDetailViewModel,
  slug: string,
  sessions: HarnessSessionBinding[]
): HarnessRunDetailViewModel {
  return {
    project: {
      projectId: detail.project.projectId,
      name: detail.project.name,
      projectCode: detail.project.projectCode,
      projectDir: detail.project.projectDir,
      systemId: detail.project.systemId,
      workspacePath: detail.project.workspacePath,
      projectRootPath: detail.project.projectRootPath
    },
    adapterSnapshot: {
      mode: "run",
      mock: false
    },
    workflow: detail.workflow,
    run: {
      id: slug,
      kind: "feature",
      slug,
      title: slug,
      hookLogRefs: [],
      watchRefs: [],
      currentNodeId: "",
      nodes: [],
      unmatchedHooks: []
    },
    sessions
  }
}

function workflowForProjectRun(
  detail: HarnessProjectDetailViewModel,
  run: HarnessFeatureSummary
): HarnessWorkflow {
  const workflowId = run.workflowId?.trim()
  return workflowId ? detail.dynamicWorkflows?.[workflowId] ?? detail.workflow : detail.workflow
}

function featureSessionKey(projectId: string, slug: string, threadId: string): string {
  return `${projectId}\u0000${slug}\u0000${threadId}`
}

async function getLatestSessionWorkspacePath(
  sessions: HarnessSessionBinding[],
  threadsById: Map<string, Thread>,
  threadStates: ThreadWorkspaceStateMap
): Promise<string | null> {
  const sortedSessions = [...sessions].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))

  // First pass: check all sync sources (thread state + metadata) before making any IPC calls.
  for (const session of sortedSessions) {
    const statePath = normalizeWorkspacePath(threadStates[session.threadId]?.workspacePath)
    if (statePath) return statePath

    const metadataPath = getThreadWorkspacePath(threadsById.get(session.threadId))
    if (metadataPath) return metadataPath
  }

  // Second pass: fall back to a single persisted workspace lookup for the latest session.
  const latest = sortedSessions[0]
  if (latest) {
    try {
      const persistedPath = normalizeWorkspacePath(await window.api.workspace.get(latest.threadId))
      if (persistedPath) return persistedPath
    } catch {
      // Persisted workspace lookup is unavailable — return null.
    }
  }

  return null
}

interface CreateHarnessSessionParams {
  projectId: string
  slug: string
  nextAction?: HarnessWorkflowNextAction
  sessions: HarnessSessionBinding[]
  threadsById: Map<string, Thread>
  threadStates: ThreadWorkspaceStateMap
  createThread: (
    config: {
      workspacePath: string | null
      harnessFeature: { projectId: string; slug: string; source: string }
    },
    options?: { preserveView?: boolean }
  ) => Promise<Thread>
}

async function createHarnessSession(params: CreateHarnessSessionParams): Promise<Thread> {
  const { projectId, slug, nextAction, sessions, threadsById, threadStates, createThread } = params
  const workspacePath = await getLatestSessionWorkspacePath(sessions, threadsById, threadStates)
  return createHarnessFeatureThread({ projectId, slug, workspacePath, nextAction, createThread })
}

function metadataRequiredMissing(form: HarnessProjectMetadataUpdateInput): boolean {
  return [
    form.adapterId,
    form.adapterType,
    form.name,
    form.projectCode,
    form.projectDir,
    form.description,
    form.systemId,
    form.systemName,
    form.workspacePath
  ].some((value) => !value.trim())
}

function getHarnessNameError(label: string, value: string): string | null {
  if (!value.trim()) return null
  return harnessNamePattern.test(value) ? null : `${label}${harnessNameRuleMessage}`
}

function getProjectMetadataNameError(form: HarnessProjectMetadataUpdateInput): string | null {
  return (
    getHarnessNameError("项目名称", form.name) ??
    getHarnessNameError("项目编号", form.projectCode) ??
    getHarnessNameError("项目文件夹", form.projectDir)
  )
}

function metadataNameInvalid(form: HarnessProjectMetadataUpdateInput): boolean {
  return getProjectMetadataNameError(form) !== null
}

function toProjectMetadataForm(project: HarnessProjectListItem): HarnessProjectMetadataUpdateInput {
  return {
    adapterId: project.harnessAdapter.id,
    adapterType: project.harnessAdapter.type,
    name: project.name,
    projectCode: project.projectCode,
    projectDir: project.projectDir,
    description: project.description,
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath
  }
}

function getThreadTitle(thread: Thread): string {
  const title = thread.title?.trim()
  return title || thread.thread_id
}

function HarnessBreadcrumb({
  project,
  featureTitle,
  sessionTitle,
  onBack,
  onProjectList,
  onProject,
  onFeature
}: {
  project?: Pick<HarnessProjectListItem, "name"> | null
  featureTitle?: string | null
  sessionTitle?: string | null
  onBack?: () => void
  onProjectList: () => void
  onProject?: () => void
  onFeature?: () => void
}): React.JSX.Element {
  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {onBack && (
        <button
          type="button"
          className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title="返回"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </button>
      )}
      <button
        type="button"
        className="shrink-0 cursor-pointer rounded-sm px-1 py-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onProjectList}
      >
        项目列表
      </button>
      {project && (
        <>
          <span className="shrink-0">/</span>
          {onProject ? (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate rounded-sm px-1 py-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onProject}
            >
              {project.name}
            </button>
          ) : (
            <span className="min-w-0 truncate rounded-sm px-1 py-0.5 text-foreground">
              {project.name}
            </span>
          )}
        </>
      )}
      {featureTitle && (
        <>
          <span className="shrink-0">/</span>
          {onFeature ? (
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate rounded-sm px-1 py-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onFeature}
            >
              {featureTitle}
            </button>
          ) : (
            <span className="min-w-0 truncate rounded-sm px-1 py-0.5 text-foreground">
              {featureTitle}
            </span>
          )}
        </>
      )}
      {sessionTitle && (
        <>
          <span className="shrink-0">/</span>
          <span className="min-w-0 truncate rounded-sm px-1 py-0.5 text-foreground">
            {sessionTitle}
          </span>
        </>
      )}
    </nav>
  )
}

function statusTone(status?: HarnessStatus): string {
  switch (status?.uiKind) {
    case "done":
    case "ok":
      return "border-status-nominal/35 bg-status-nominal/10 text-status-nominal"
    case "active":
      return "border-status-info/35 bg-status-info/10 text-status-info"
    case "warning":
    case "blocked":
      return "border-status-warning/40 bg-status-warning/10 text-status-warning"
    case "error":
      return "border-status-critical/40 bg-status-critical/10 text-status-critical"
    case "archived":
    case "skipped":
      return "border-border bg-muted text-muted-foreground"
    default:
      return "border-border bg-background text-muted-foreground"
  }
}

function StatusPill({ status, tooltip }: { status: HarnessStatus; tooltip?: string | null }): React.JSX.Element {
  const pill = (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center rounded border px-2 text-[11px] font-medium",
        statusTone(status)
      )}
      title={status.label}
    >
      <span className="truncate">{status.label}</span>
    </span>
  )

  if (!tooltip) return pill

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          {pill}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-80">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function statusIcon(status: HarnessStatus): React.JSX.Element {
  if (status.uiKind === "pending") {
    return <CircleDashed className="size-4 text-muted-foreground" />
  }
  if (status.uiKind === "done" || status.uiKind === "ok") {
    return <CheckCircle2 className="size-4 text-status-nominal" />
  }
  if (status.uiKind === "active") {
    return <Loader2 className="size-4 animate-spin text-status-info" />
  }
  if (status.uiKind === "warning" || status.uiKind === "blocked") {
    return <ShieldAlert className="size-4 text-status-warning" />
  }
  if (status.uiKind === "error") {
    return <AlertCircle className="size-4 text-status-critical" />
  }
  if (status.uiKind === "skipped") {
    return <SkipForward className="size-4 text-muted-foreground" />
  }
  if (status.uiKind === "archived") {
    return <Archive className="size-4 text-muted-foreground" />
  }
  if (status.uiKind === "unknown") {
    return <CircleHelp className="size-4 text-muted-foreground" />
  }
  return <Circle className="size-4 text-muted-foreground" />
}

function progressPercentFromValues(progressIndex: number, totalNodes: number): number {
  if (totalNodes <= 0) return 0
  const normalizedProgress = Math.max(0, Math.min(progressIndex, totalNodes))
  return Math.min(100, Math.round((normalizedProgress / totalNodes) * 100))
}

function progressIndexFromCurrentNodeId(nodes: Array<{ id: string }>, currentNodeId: string): number {
  const index = nodes.findIndex((node) => node.id === currentNodeId)
  return index >= 0 ? index + 1 : 0
}

function currentNodeLabelFromNodes(
  nodes: Array<{ id: string; label: string }>,
  currentNodeId: string
): string {
  return (nodes.find((node) => node.id === currentNodeId)?.label ?? currentNodeId) || "未知"
}

function currentNodeStatusLabel(run: HarnessFeatureSummary): string {
  return run.currentNodeStatusLabel?.trim() || NODE_STATUS_LABELS[run.currentNodeStatus] || "未知"
}

function ProgressBar({
  progressIndex,
  totalNodes
}: {
  progressIndex: number
  totalNodes: number
}): React.JSX.Element {
  return (
    <div className="mt-auto h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-status-info"
        style={{ width: `${progressPercentFromValues(progressIndex, totalNodes)}%` }}
      />
    </div>
  )
}

function groupProgressIndex(
  group: StageNodeGroup,
  workflowNodes: Array<{ id: string }>,
  currentNodeId: string
): number {
  const progressIndex = progressIndexFromCurrentNodeId(workflowNodes, currentNodeId)
  const coveredNodeCount = Math.max(0, Math.min(progressIndex, workflowNodes.length))
  const completedNodeIds = new Set(
    workflowNodes.slice(0, coveredNodeCount).map((node) => node.id)
  )
  return group.nodes.filter((node) => completedNodeIds.has(node.id)).length
}

interface StageNodeGroup {
  key: string
  label: string
  nodes: HarnessRunNode[]
}

function stageNodeGroupLabel(node: HarnessRunNode): string {
  return (node.group ?? "").trim()
}

function groupStageNodes(nodes: HarnessRunNode[]): StageNodeGroup[] {
  const groups: StageNodeGroup[] = []
  const groupsByKey = new Map<string, StageNodeGroup>()
  const ungroupedNodes: HarnessRunNode[] = []

  for (const node of nodes) {
    const label = stageNodeGroupLabel(node)
    if (!label) {
      ungroupedNodes.push(node)
      continue
    }

    const key = `group:${label}`
    const existing = groupsByKey.get(key)
    if (existing) {
      existing.nodes.push(node)
      continue
    }

    const group = { key, label, nodes: [node] }
    groupsByKey.set(key, group)
    groups.push(group)
  }

  if (groups.length > 0 && ungroupedNodes.length > 0) {
    groups.push({ key: "ungrouped", label: "未分组", nodes: ungroupedNodes })
  }

  return groups
}

function ProjectWorkspacePathTip(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="项目工作区提示"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="z-[70] max-w-72">
          项目产物路径，非代码仓库
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function boardCompatibilityStatus(compatibility: HarnessBoardCompatibility): HarnessStatus {
  if (compatibility.compatible) {
    return { label: compatibility.label || "兼容", uiKind: "ok" }
  }
  return {
    label: compatibility.label || "协议不兼容",
    uiKind: compatibility.status === "invalid-board-config" || compatibility.status === "invalid-api-version"
      ? "error"
      : "warning"
  }
}

function boardCompatibilityMessage(compatibility?: HarnessBoardCompatibility | null): string | null {
  if (!compatibility || compatibility.compatible) return null
  return compatibility.message || "插件看板协议与当前 APP 不兼容。"
}

function findSelectedAdapter(
  registry: HarnessAdapterRegistryItem[],
  adapterId: string
): HarnessAdapterRegistryItem | null {
  if (!adapterId) return null
  return registry.find((adapter) => adapter.id === adapterId) ?? null
}

function normalizeAdapterUseScenario(value?: string): string {
  const normalized = value?.trim()
  return normalized || OTHER_ADAPTER_SCENARIO
}

function normalizeAdapterMarketName(value?: string): string {
  return value?.trim() || ""
}

function buildMarketPluginMap(items: MarketItem[]): Map<string, MarketItem> {
  const map = new Map<string, MarketItem>()
  for (const item of items) {
    const name = normalizeAdapterMarketName(item.name)
    if (name) map.set(name, item)
  }
  return map
}

function buildInstalledPluginMap(items: PluginMetadata[]): Map<string, PluginMetadata> {
  const map = new Map<string, PluginMetadata>()
  for (const item of items) {
    const name = normalizeAdapterMarketName(item.name)
    if (name) map.set(name, item)
  }
  return map
}

function readMarketTextField(
  item: MarketItem,
  fieldNames: string[]
): string {
  const record = item as unknown as Record<string, unknown>
  for (const fieldName of fieldNames) {
    const value = record[fieldName]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ""
}

function applyMarketAdapterDisplayData(
  registry: HarnessAdapterRegistryItem[],
  marketPlugins: MarketItem[],
  installedPlugins: PluginMetadata[]
): HarnessAdapterRegistryItem[] {
  const marketByName = buildMarketPluginMap(marketPlugins)
  const installedByName = buildInstalledPluginMap(installedPlugins)

  return registry.map((adapter) => {
    const adapterName = normalizeAdapterMarketName(adapter.name)
    const installedPlugin = adapterName ? installedByName.get(adapterName) : undefined
    const installedVersion = installedPlugin?.version?.trim() || adapter.version?.trim() || ""
    const fallback: HarnessAdapterRegistryItem = {
      ...adapter,
      version: installedVersion,
      description: "",
      useScenario: OTHER_ADAPTER_SCENARIO
    }
    if (installedPlugin?.origin !== "market") return fallback

    const marketPlugin = adapterName ? marketByName.get(adapterName) : undefined
    if (!marketPlugin) return fallback

    return {
      ...fallback,
      version: installedVersion,
      description: marketPlugin.description?.trim() || "",
      useScenario: normalizeAdapterUseScenario(marketPlugin.category),
      developerName: readMarketTextField(marketPlugin, ["developerName", "developer", "managerName"]),
      organizationName: readMarketTextField(marketPlugin, [
        "organizationName",
        "organization",
        "orgName",
        "department",
        "managerDepartment"
      ])
    }
  })
}

async function loadHarnessMarketPlugins(): Promise<MarketItem[]> {
  try {
    const response = await marketApi.getPlugins({ allowMockOnError: false, silent: true })
    return response.success && response.data ? response.data : []
  } catch {
    return []
  }
}

async function loadHarnessInstalledPlugins(): Promise<PluginMetadata[]> {
  try {
    return await window.api.plugins.list()
  } catch {
    return []
  }
}

function scheduleHarnessAdapterDisplayRefresh(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: 1000 })
    return
  }
  window.setTimeout(task, 0)
}

function groupAdaptersByUseScenario(registry: HarnessAdapterRegistryItem[]): AdapterScenarioGroup[] {
  const groups = new Map<string, HarnessAdapterRegistryItem[]>()
  for (const adapter of registry) {
    const useScenario = normalizeAdapterUseScenario(adapter.useScenario)
    const adapters = groups.get(useScenario)
    if (adapters) {
      adapters.push(adapter)
    } else {
      groups.set(useScenario, [adapter])
    }
  }

  return Array.from(groups.entries())
    .map(([useScenario, adapters]) => ({ useScenario, adapters }))
    .sort((left, right) => {
      const leftIsOther = left.useScenario === OTHER_ADAPTER_SCENARIO
      const rightIsOther = right.useScenario === OTHER_ADAPTER_SCENARIO
      if (leftIsOther && rightIsOther) return 0
      if (leftIsOther) return 1
      if (rightIsOther) return -1
      return left.useScenario.localeCompare(right.useScenario)
    })
}

function formatAdapterSelectLabel(adapter: HarnessAdapterRegistryItem): string {
  return adapter.version ? `${adapter.name} · ${adapter.version}` : adapter.name
}

function formatAdapterSelectText(adapter: HarnessAdapterRegistryItem): string {
  return [
    formatAdapterSelectLabel(adapter),
    adapter.developerName,
    adapter.organizationName
  ].filter(Boolean).join(" ")
}

function AdapterPublisherInfo({
  adapter,
  className
}: {
  adapter: HarnessAdapterRegistryItem
  className?: string
}): React.JSX.Element | null {
  if (!adapter.developerName && !adapter.organizationName) return null

  return (
    <span
      className={cn(
        "ml-auto flex min-w-0 max-w-[52%] shrink-0 items-center justify-end gap-1 text-[11px] font-normal text-muted-foreground",
        className
      )}
    >
      {adapter.developerName && (
        <span className="min-w-0 truncate" title={`开发人员：${adapter.developerName}`}>
          开发人员：{adapter.developerName}
        </span>
      )}
      {adapter.developerName && adapter.organizationName && (
        <span className="shrink-0 text-muted-foreground/50">/</span>
      )}
      {adapter.organizationName && (
        <span className="min-w-0 truncate" title={`组织机构：${adapter.organizationName}`}>
          组织机构：{adapter.organizationName}
        </span>
      )}
    </span>
  )
}

function AdapterOptionHeader({
  adapter,
  infoClassName
}: {
  adapter: HarnessAdapterRegistryItem
  infoClassName?: string
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">
        {formatAdapterSelectLabel(adapter)}
      </span>
      <AdapterPublisherInfo adapter={adapter} className={infoClassName} />
    </span>
  )
}

function AdapterSelectedValue({
  adapter
}: {
  adapter: HarnessAdapterRegistryItem | null
}): React.JSX.Element {
  return (
    <SelectValue placeholder={ADAPTER_SELECT_PLACEHOLDER}>
      {adapter ? (
        <span className="block min-w-0 truncate text-left">
          <AdapterOptionHeader adapter={adapter} />
        </span>
      ) : undefined}
    </SelectValue>
  )
}

function AdapterSelectItem({ adapter }: { adapter: HarnessAdapterRegistryItem }): React.JSX.Element {
  const compatibilityMessage = boardCompatibilityMessage(adapter.boardCompatibility)
  return (
    <SelectItem
      key={adapter.id}
      value={adapter.id}
      textValue={formatAdapterSelectText(adapter)}
      disabled={!adapter.boardCompatibility.compatible}
      className="group py-2 pl-4 pr-10"
    >
      <span className="flex min-w-0 max-w-[calc(var(--radix-select-trigger-width)-3rem)] flex-col gap-1">
        <AdapterOptionHeader
          adapter={adapter}
          infoClassName="group-focus:text-accent-foreground group-data-[state=checked]:text-accent-foreground group-data-[highlighted]:text-accent-foreground"
        />
        {adapter.description && (
          <span
            className="line-clamp-2 whitespace-normal break-words text-xs leading-5 text-muted-foreground group-focus:text-accent-foreground group-data-[state=checked]:text-accent-foreground group-data-[highlighted]:text-accent-foreground"
            title={adapter.description}
          >
            {adapter.description}
          </span>
        )}
        {compatibilityMessage && (
          <span className="line-clamp-2 whitespace-normal break-words text-xs leading-5 text-status-warning">
            {compatibilityMessage}
          </span>
        )}
      </span>
    </SelectItem>
  )
}

function AdapterSelectGroups({ registry }: { registry: HarnessAdapterRegistryItem[] }): React.JSX.Element {
  const groups = groupAdaptersByUseScenario(registry)
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group.useScenario}>
          <SelectGroup>
            <SelectLabel className="px-2 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
              {group.useScenario}
            </SelectLabel>
            {group.adapters.map((adapter) => (
              <AdapterSelectItem key={adapter.id} adapter={adapter} />
            ))}
          </SelectGroup>
          {index < groups.length - 1 && <SelectSeparator />}
        </Fragment>
      ))}
    </>
  )
}

function ProjectFormDialog({
  open,
  creating,
  form,
  registry,
  error,
  onOpenChange,
  onChange,
  onPickWorkspace,
  onSubmit
}: {
  open: boolean
  creating: boolean
  form: HarnessProjectCreateInput
  registry: HarnessAdapterRegistryItem[]
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectCreateInput) => void
  onPickWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const projectNameError = getHarnessNameError("项目名称", form.name)
  const projectCodeError = getHarnessNameError("项目编号", form.projectCode)
  const projectDirError = getHarnessNameError("项目文件夹", form.projectDir)
  const selectedAdapter = findSelectedAdapter(registry, form.adapterId)
  const selectedAdapterMessage = boardCompatibilityMessage(selectedAdapter?.boardCompatibility)
  const projectRootPath = form.workspacePath.trim()
  const projectDir = form.projectDir.trim()
  const projectCreatePathHint =
    projectRootPath && projectDir ? `将在 ${projectRootPath} 下创建文件夹: ${projectDir} ` : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(harnessDialogContentClassName, "max-w-3xl")}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">选择插件</div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <Select
                value={form.adapterId}
                onValueChange={(adapterId) => onChange({ ...form, adapterId, adapterType: "plugin" })}
              >
                <SelectTrigger className={harnessProjectCreateSelectClassName}>
                  <AdapterSelectedValue adapter={selectedAdapter} />
                </SelectTrigger>
                <SelectContent className={harnessDialogSelectContentClassName}>
                  <AdapterSelectGroups registry={registry} />
                </SelectContent>
              </Select>
              {selectedAdapterMessage && (
                <span className="text-status-warning">{selectedAdapterMessage}</span>
              )}
            </label>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">项目信息</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称 *
                <Input
                  value={form.name}
                  onChange={(event) => {
                    const name = sanitizeHarnessNameInput(event.target.value)
                    const shouldSyncProjectDir = !form.projectDir || form.projectDir === form.name
                    onChange({
                      ...form,
                      name,
                      projectDir: shouldSyncProjectDir ? name : form.projectDir
                    })
                  }}
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                  aria-invalid={projectNameError ? true : undefined}
                />
                {projectNameError && <span className="text-status-critical">{projectNameError}</span>}
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编号 *
                <Input
                  value={form.projectCode}
                  onChange={(event) =>
                    onChange({ ...form, projectCode: sanitizeHarnessNameInput(event.target.value) })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                  aria-invalid={projectCodeError ? true : undefined}
                />
                {projectCodeError && <span className="text-status-critical">{projectCodeError}</span>}
              </label>
              <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目描述 *
                <Input
                  value={form.description}
                  onChange={(event) => onChange({ ...form, description: event.target.value })}
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">主办系统</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统编号 *
                <Input
                  value={form.systemId}
                  onChange={(event) =>
                    onChange({ ...form, systemId: event.target.value })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统名称 *
                <Input
                  value={form.systemName}
                  onChange={(event) =>
                    onChange({ ...form, systemName: event.target.value })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">工作区配置</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span>项目根路径 *</span>
                  <ProjectWorkspacePathTip />
                </div>
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={form.workspacePath}
                    readOnly
                    placeholder="请选择项目根路径"
                    className={harnessProjectCreateInputClassName}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0 gap-2"
                    onClick={onPickWorkspace}
                  >
                    <FolderOpen className="size-4" />
                    选择
                  </Button>
                </div>
              </div>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目文件夹 *
                <Input
                  value={form.projectDir}
                  onChange={(event) =>
                    onChange({ ...form, projectDir: sanitizeHarnessNameInput(event.target.value) })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                  aria-invalid={projectDirError ? true : undefined}
                />
                {projectDirError && <span className="text-status-critical">{projectDirError}</span>}
              </label>
            </div>
            {projectCreatePathHint && (
              <div className="mt-3 truncate text-xs text-muted-foreground" title={projectCreatePathHint}>
                {projectCreatePathHint}
              </div>
            )}
          </section>

          {error && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
            取消
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              creating ||
              metadataRequiredMissing(form) ||
              metadataNameInvalid(form) ||
              !selectedAdapter?.boardCompatibility.compatible
            }
            className="gap-2"
          >
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProjectEditDialog({
  open,
  saving,
  form,
  registry,
  error,
  onOpenChange,
  onChange,
  onSubmit
}: {
  open: boolean
  saving: boolean
  form: HarnessProjectMetadataUpdateInput
  registry: HarnessAdapterRegistryItem[]
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectMetadataUpdateInput) => void
  onSubmit: () => void
}): React.JSX.Element {
  const projectNameError = getHarnessNameError("项目名称", form.name)
  const projectCodeError = getHarnessNameError("项目编号", form.projectCode)
  const projectDirError = getHarnessNameError("项目文件夹", form.projectDir)
  const selectedAdapter = findSelectedAdapter(registry, form.adapterId)
  const selectedAdapterMessage = boardCompatibilityMessage(selectedAdapter?.boardCompatibility)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(harnessDialogContentClassName, "max-w-3xl")}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">选择插件</div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <Select
                value={form.adapterId}
                onValueChange={(adapterId) => onChange({ ...form, adapterId, adapterType: "plugin" })}
              >
                <SelectTrigger className={harnessProjectCreateSelectClassName}>
                  <AdapterSelectedValue adapter={selectedAdapter} />
                </SelectTrigger>
                <SelectContent className={harnessDialogSelectContentClassName}>
                  <AdapterSelectGroups registry={registry} />
                </SelectContent>
              </Select>
              {selectedAdapterMessage && (
                <span className="text-status-warning">{selectedAdapterMessage}</span>
              )}
            </label>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">项目信息</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称 *
                <Input
                  value={form.name}
                  onChange={(event) =>
                    onChange({ ...form, name: sanitizeHarnessNameInput(event.target.value) })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                  aria-invalid={projectNameError ? true : undefined}
                />
                {projectNameError && <span className="text-status-critical">{projectNameError}</span>}
              </label>
              <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <label htmlFor="harness-edit-project-code">项目编号 *</label>
                <Input
                  id="harness-edit-project-code"
                  value={form.projectCode}
                  onChange={(event) =>
                    onChange({ ...form, projectCode: sanitizeHarnessNameInput(event.target.value) })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                  aria-invalid={projectCodeError ? true : undefined}
                />
                {projectCodeError && <span className="text-status-critical">{projectCodeError}</span>}
              </div>
              <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目描述 *
                <Input
                  value={form.description}
                  onChange={(event) => onChange({ ...form, description: event.target.value })}
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">主办系统</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统编号 *
                <Input
                  value={form.systemId}
                  onChange={(event) =>
                    onChange({ ...form, systemId: event.target.value })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统名称 *
                <Input
                  value={form.systemName}
                  onChange={(event) =>
                    onChange({ ...form, systemName: event.target.value })
                  }
                  placeholder="请输入"
                  className={harnessProjectCreateInputClassName}
                />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">工作区配置</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span>项目根目录 *</span>
                  <ProjectWorkspacePathTip />
                </div>
                <Input
                  value={form.workspacePath}
                  readOnly
                  aria-readonly="true"
                  placeholder="请选择项目根路径"
                  className="bg-muted text-muted-foreground"
                />
              </div>
              <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <label htmlFor="harness-edit-project-dir">项目文件夹 *</label>
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="项目文件夹修改提示"
                          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Info className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="z-[70] max-w-72">
                        项目文件夹创建后不可修改
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Input
                  id="harness-edit-project-dir"
                  value={form.projectDir}
                  readOnly
                  aria-readonly="true"
                  placeholder="项目文件夹"
                  className="bg-muted text-muted-foreground"
                  aria-invalid={projectDirError ? true : undefined}
                />
                {projectDirError && <span className="text-status-critical">{projectDirError}</span>}
              </div>
            </div>
          </section>

          {error && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={onSubmit}
            disabled={saving || metadataRequiredMissing(form) || metadataNameInvalid(form)}
            className="gap-2"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FeatureCreateDialog({
  project,
  featureName,
  creating,
  error,
  onOpenChange,
  onChange,
  onSubmit
}: {
  project: HarnessProjectListItem | null
  featureName: string
  creating: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (featureName: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  const featureNameError = getHarnessNameError("特性名称", featureName)

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(harnessDialogContentClassName, "max-w-md")}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>创建特性</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4 py-1"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            特性名称 *
            <Input
              value={featureName}
              onChange={(event) => onChange(sanitizeHarnessNameInput(event.target.value))}
              placeholder="请输入特性名称"
              className="bg-background"
              autoFocus
              aria-invalid={featureNameError ? true : undefined}
            />
            {featureNameError && <span className="text-status-critical">{featureNameError}</span>}
          </label>
          {error && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={creating || !featureName.trim() || featureNameError !== null}
              className="gap-2"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProjectActionMenu({
  project,
  archiving,
  onEdit,
  onArchive
}: {
  project: HarnessProjectListItem
  archiving: boolean
  onEdit: () => void
  onArchive: () => void
}): React.JSX.Element {
  const archived = project.lifecycle.status === "archived"
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8"
          aria-label="项目操作"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-48 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-background-interactive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(false)
            onEdit()
          }}
        >
          <Pencil className="size-4 text-muted-foreground" />
          编辑项目
        </button>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            archived || archiving
              ? "cursor-not-allowed text-muted-foreground opacity-60"
              : "text-status-critical hover:bg-status-critical/10"
          )}
          disabled={archived || archiving}
          onClick={(event) => {
            event.stopPropagation()
            setOpen(false)
            onArchive()
          }}
        >
          {archiving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Archive className="size-4 text-muted-foreground" />
          )}
          {archived ? "已归档" : "归档项目"}
        </button>
      </PopoverContent>
    </Popover>
  )
}

function FeatureCard({
  run,
  workflowNodes,
  onOpen
}: {
  run: HarnessFeatureSummary
  workflowNodes: Array<{ id: string; label: string }>
  onOpen: () => void
}): React.JSX.Element {
  const progressIndex = progressIndexFromCurrentNodeId(workflowNodes, run.currentNodeId)
  const totalNodes = workflowNodes.length
  const currentNodeLabel = currentNodeLabelFromNodes(workflowNodes, run.currentNodeId)
  const nodeStatusLabel = currentNodeStatusLabel(run)

  return (
    <button
      type="button"
      className="flex h-[112px] w-full cursor-pointer flex-col gap-2 rounded-md border border-border bg-background px-3 py-3 text-left transition-all hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{run.title}</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{run.slug}</div>
        </div>
        <StatusPill status={run.overallStatus} />
      </div>
      <ProgressBar progressIndex={progressIndex} totalNodes={totalNodes} />
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{currentNodeLabel} · {nodeStatusLabel}</span>
        <span className="shrink-0">
          {progressIndex}/{totalNodes}
        </span>
      </div>
    </button>
  )
}

function ProjectBadgeRow({
  project,
  children
}: {
  project: HarnessProjectListItem
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {children}
      <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {project.projectCode}
      </span>
    </div>
  )
}

function ProjectCard({
  project,
  detail,
  loading,
  archiving,
  pluginUpdateInfo,
  updatingPlugin,
  onEditProject,
  onArchiveProject,
  onUpdatePlugin,
  onOpenProject
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  loading: boolean
  archiving: boolean
  pluginUpdateInfo?: MarketPluginUpdateInfo | null
  updatingPlugin: boolean
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onUpdatePlugin: (project: HarnessProjectListItem, updateInfo: MarketPluginUpdateInfo) => void
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"
  const detailError = detail?.error?.trim()
  const pluginCompatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
  const pluginCompatibilityStatus = boardCompatibilityStatus(project.boardCompatibility)
  const archivedStatus: HarnessStatus = { label: "已归档", uiKind: "archived" }
  const projectRootPath = resolveProjectRootPath(project)

  return (
    <article
      role="button"
      tabIndex={0}
      className={cn(
        "h-full w-full min-w-0 cursor-pointer overflow-hidden rounded-md border border-border border-t-[3px] shadow-sm transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        archived ? "border-t-muted-foreground/50 bg-muted/20" : "border-t-status-info bg-background"
      )}
      onClick={() => onOpenProject(project.projectId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpenProject(project.projectId)
        }
      }}
    >
      <div className="p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <ProjectBadgeRow project={project}>
              <h2 className="truncate text-base font-semibold">{project.name}</h2>
            </ProjectBadgeRow>
            <div className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {project.description}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex items-center gap-1">
              <span className="rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {project.harnessAdapter.name}
              </span>
              <ProjectActionMenu
                project={project}
                archiving={archiving}
                onEdit={() => onEditProject(project)}
                onArchive={() => onArchiveProject(project)}
              />
            </div>
            {pluginUpdateInfo && (
              <UpdateVersionTooltip
                typeLabel="插件"
                installedVersion={pluginUpdateInfo.installedVersion}
                currentVersion={pluginUpdateInfo.currentVersion}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="market-update-bounce h-7 px-3 gap-1 text-xs cursor-pointer rounded-lg text-[#0f766e] border-[#78d7cb] bg-[#e5fbf7] hover:bg-[#d4f7f0] disabled:cursor-not-allowed disabled:opacity-70"
                  disabled={updatingPlugin}
                  onClick={(event) => {
                    event.stopPropagation()
                    onUpdatePlugin(project, pluginUpdateInfo)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {updatingPlugin ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Zap className="size-3" />
                  )}
                  {updatingPlugin ? "更新中" : "可更新"}
                </Button>
              </UpdateVersionTooltip>
            )}
          </div>
        </div>

        <div className="mt-4 border-t border-border pt-3">
          {archived ? (
            <div className="flex min-h-[44px] flex-wrap items-center gap-2">
              {pluginCompatibilityMessage && (
                <StatusPill status={pluginCompatibilityStatus} tooltip={pluginCompatibilityMessage} />
              )}
              <StatusPill status={archivedStatus} />
            </div>
          ) : pluginCompatibilityMessage ? (
            <div className="flex min-h-[44px] items-center">
              <StatusPill status={pluginCompatibilityStatus} tooltip={pluginCompatibilityMessage} />
            </div>
          ) : detailError && detail?.projectState ? (
            <div className="flex min-h-[44px] items-center">
              <StatusPill status={detail.projectState} tooltip={detailError} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="min-w-0 text-xs text-muted-foreground">
                 特性数
                <strong className="mt-1 block text-sm text-foreground">
                  {loading || !detail ? "-" : runs.length}
                </strong>
              </div>
              <div className="min-w-0 text-xs text-muted-foreground">
                进行中
                <strong className="mt-1 block text-sm text-foreground">
                  {loading || !detail ? "-" : activeCount}
                </strong>
              </div>
              <div className="min-w-0 text-xs text-muted-foreground">
                项目文件夹
                <strong
                  className="mt-1 block truncate text-sm text-foreground"
                  title={projectRootPath}
                >
                  {getWorkspaceName(projectRootPath)}
                </strong>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function SystemSection({
  group,
  detailsByProjectId,
  loadingDetailIds,
  archivingProjectId,
  pluginUpdateInfoByProjectId,
  updatingPluginProjectIds,
  onEditProject,
  onArchiveProject,
  onUpdateProjectPlugin,
  onOpenProject
}: {
  group: SystemGroup
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
  loadingDetailIds: Set<string>
  archivingProjectId: string | null
  pluginUpdateInfoByProjectId: Map<string, MarketPluginUpdateInfo>
  updatingPluginProjectIds: Set<string>
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onUpdateProjectPlugin: (
    project: HarnessProjectListItem,
    updateInfo: MarketPluginUpdateInfo
  ) => void
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex min-w-0 items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="mt-1 truncate text-lg font-semibold">{group.systemCode}</h2>
          <div className="mt-1 truncate text-xs text-muted-foreground">{group.systemName}</div>
        </div>
        <div className="shrink-0 text-sm text-muted-foreground">{group.projects.length} 个项目</div>
      </div>
      <div className="-mx-1 pb-1">
        <div className="grid gap-4 px-1 md:grid-cols-2 2xl:grid-cols-3">
          {group.projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              detail={detailsByProjectId[project.projectId]}
              loading={loadingDetailIds.has(project.projectId)}
              archiving={archivingProjectId === project.projectId}
              pluginUpdateInfo={pluginUpdateInfoByProjectId.get(project.projectId)}
              updatingPlugin={updatingPluginProjectIds.has(project.projectId)}
              onEditProject={onEditProject}
              onArchiveProject={onArchiveProject}
              onUpdatePlugin={onUpdateProjectPlugin}
              onOpenProject={onOpenProject}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function artifactCanOpenInFileManager(
  path: string | null,
  artifactType: HarnessArtifactType,
  status: HarnessStatus,
  exists?: boolean
): boolean {
  if (!path) return false
  if (artifactType === "external" || artifactType === "virtual") return false
  return status.uiKind === "done" || status.uiKind === "ok" || exists === true
}

function ArtifactLine({
  artifact,
  workspacePath
}: {
  artifact: HarnessArtifact
  workspacePath: string
}): React.JSX.Element {
  const displayPaths: string[] = (() => {
    if (artifact.paths && artifact.paths.length > 0) return artifact.paths
    if (artifact.path) return [artifact.path]
    return []
  })()
  const artifactSummary = artifact.summary ?? "-"

  const openArtifactInFileManager = async (targetPath: string): Promise<void> => {
    try {
      const fullPath = resolveWorkspaceFilePath(targetPath, workspacePath)
      const platform = await window.electron.ipcRenderer.invoke("get-platform")
      const normalizedPath = platform === "win32" ? fullPath.replace(/\//g, "\\") : fullPath
      const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
      if (result && typeof result === "object" && "success" in result && !result.success) {
        const error = "error" in result && typeof result.error === "string" ? result.error : "无法打开产物位置"
        toast.error(error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法打开产物位置")
    }
  }

  return (
    <div className="grid grid-cols-[18px_minmax(140px,1fr)_90px_minmax(160px,1.5fr)] items-start gap-x-3 gap-y-2 border-t border-border px-3 py-3 text-sm">
      <FileText className="row-span-2 mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate font-medium" title={artifact.artifactLabel}>{artifact.artifactLabel}</div>
      </div>
      <StatusPill status={artifact.status} />
      <div className="min-w-0 text-xs leading-5 text-muted-foreground">
        <div className="truncate" title={artifactSummary}>{artifactSummary}</div>
        {artifact.validation && (
          <div className="truncate" title={artifact.validation.message}>{artifact.validation.message}</div>
        )}
      </div>
      <div className="col-span-3 min-w-0 rounded border border-border/70 bg-muted/30 px-2 py-1.5">
        {displayPaths.length > 0 ? (
          displayPaths.map((p) => {
            const canOpen = artifactCanOpenInFileManager(p, artifact.artifactType, artifact.status, artifact.exists)
            return (
              <div key={p} className="flex items-center gap-1">
                <span
                  className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-muted-foreground"
                  title={p}
                >
                  {p}
                </span>
                {canOpen && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-5 w-5 shrink-0"
                    title="在文件管理器中打开"
                    onClick={() => void openArtifactInFileManager(p)}
                  >
                    <FolderOpen className="size-3" />
                  </Button>
                )}
              </div>
            )
          })
        ) : (
          <span className="break-all font-mono text-[11px] leading-5 text-muted-foreground">
            {artifact.artifactType}
          </span>
        )}
      </div>
    </div>
  )
}

function HookLine({
  hook,
  onSelectSession
}: {
  hook: HarnessHookLogView
  onSelectSession?: (threadId: string) => void
}): React.JSX.Element {
  const status = eventStatusDisplay(hook.eventStatus)
  const canSelectSession = Boolean(hook.sessionId && onSelectSession)
  const metaItems = [hook.ts].filter((item): item is string => Boolean(item))

  return (
    <button
      type="button"
      className={cn(
        "grid min-w-0 w-full grid-cols-[18px_minmax(0,1fr)] gap-2 border-t border-border px-3 py-3 text-left text-sm",
        canSelectSession
          ? "cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
          : "cursor-default"
      )}
      disabled={!canSelectSession}
      onClick={() => {
        if (!hook.sessionId) return
        onSelectSession?.(hook.sessionId)
      }}
      title={canSelectSession ? "跳转到对应会话" : undefined}
    >
      {statusIcon(status)}
      <div className="min-w-0">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium" title={hook.eventId}>{hook.eventId}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground" title={hook.eventStatus}>
              {hook.eventStatus}
            </div>
          </div>
          <StatusPill status={status} />
        </div>
        <div className="mt-2 min-w-0 text-xs leading-5 text-muted-foreground">
          <div className="break-words">{hook.message}</div>
          {metaItems.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1">
              {metaItems.map((item) => (
                <span key={item} className="truncate font-mono text-[11px]" title={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}

function eventStatusDisplay(eventStatus: HarnessEventStatus): HarnessStatus {
  switch (eventStatus) {
    case "success":
      return { label: "通过", uiKind: "ok" }
    case "blocked":
      return { label: "阻断", uiKind: "blocked" }
    case "skipped":
      return { label: "跳过", uiKind: "pending" }
    case "error":
      return { label: "异常", uiKind: "blocked" }
    default:
      return { label: "未知", uiKind: "unknown" }
  }
}

function StageArtifactPanel({
  node,
  workspacePath
}: {
  node: HarnessRunNode
  workspacePath: string
}): React.JSX.Element {
  return (
    <section className="shrink-0 rounded-md border border-border bg-background">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">阶段产物</div>
          </div>
        </div>
      </div>
      {node.artifacts.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          当前阶段暂无产物。
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {node.artifacts.map((artifact) => (
            <ArtifactLine key={artifact.id} artifact={artifact} workspacePath={workspacePath} />
          ))}
        </div>
      )}
    </section>
  )
}

function FeatureConversationPanel({
  threadId,
  hasPendingGitDiffNotice,
  onHarnessSessionCreated,
  onRequestOpenGitPanel,
  onThreadGitStatusChange
}: {
  threadId: string | null
  hasPendingGitDiffNotice?: boolean
  onHarnessSessionCreated?: (threadId: string) => void
  onRequestOpenGitPanel?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
      {threadId ? (
        <div className="flex min-h-0 flex-1">
          <TabbedPanel
            threadId={threadId}
            showTabBar={false}
            hasPendingGitDiffNotice={hasPendingGitDiffNotice}
            chatSurface="harness-project"
            hideWelcomeSkillTabs
            onRequestOpenGitPanel={onRequestOpenGitPanel}
            onThreadGitStatusChange={onThreadGitStatusChange}
            onHarnessSessionCreated={onHarnessSessionCreated}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          从左侧特性工作区选择会话，或发起新会话。
        </div>
      )}
    </section>
  )
}

function FeatureWorkspaceChangesPanel({
  sessions,
  threadsById
}: {
  sessions: HarnessSessionBinding[]
  threadsById: Map<string, Thread>
}): React.JSX.Element {
  const groups = useMemo<WorkspaceChangeGroup[]>(() => {
    const map = new Map<string, WorkspaceChangeGroup>()

    for (const binding of sessions) {
      const thread = threadsById.get(binding.threadId) ?? null
      const workspacePath = getThreadWorkspacePath(thread)
      if (!workspacePath) continue

      const key = `workspace:${workspacePath}`
      const existing = map.get(key)
      const item = { binding }

      if (existing) {
        existing.sessions.push(item)
        if (!existing.representativeThreadId) {
          existing.representativeThreadId = binding.threadId
        }
        continue
      }

      map.set(key, {
        key,
        workspacePath,
        sessions: [item],
        representativeThreadId: binding.threadId
      })
    }

    return Array.from(map.values())
  }, [sessions, threadsById])

  const groupsByThreadId = useMemo(() => {
    const map = new Map<string, WorkspaceChangeGroup>()
    for (const group of groups) {
      for (const session of group.sessions) {
        map.set(session.binding.threadId, group)
      }
    }
    return map
  }, [groups])

  const [changesByGroup, setChangesByGroup] = useState<Record<string, WorkspaceChangeState>>({})

  const openWorkspacePathInFileManager = useCallback(async (workspacePath: string): Promise<void> => {
    try {
      const platform = await window.electron.ipcRenderer.invoke("get-platform")
      const normalizedPath = platform === "win32" ? workspacePath.replace(/\//g, "\\") : workspacePath
      const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
      if (result && typeof result === "object" && "success" in result && !result.success) {
        const error = "error" in result && typeof result.error === "string" ? result.error : "无法打开会话路径"
        toast.error(error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法打开会话路径")
    }
  }, [])

  const refreshGroup = useCallback(async (group: WorkspaceChangeGroup): Promise<void> => {
    setChangesByGroup((current) => ({
      ...current,
      [group.key]: {
        status: "loading",
        files: current[group.key]?.files ?? [],
        changedFilesTotal: current[group.key]?.changedFilesTotal ?? 0,
        omittedFileCount: current[group.key]?.omittedFileCount ?? 0
      }
    }))

    try {
      const state: GitPanelDiffState = await window.api.workspace.getGitPanelDiffs(group.representativeThreadId)
      if (!state.success) {
        setChangesByGroup((current) => ({
          ...current,
          [group.key]: {
            status: "error",
            files: [],
            changedFilesTotal: 0,
            omittedFileCount: 0,
            error: state.error || "无法读取该工作区的 Git 变更"
          }
        }))
        return
      }

      setChangesByGroup((current) => ({
        ...current,
        [group.key]: {
          status: "ready",
          files: state.files,
          changedFilesTotal: state.changedFilesTotal ?? state.files.length,
          omittedFileCount: state.omittedFileCount ?? 0
        }
      }))
    } catch (error) {
      setChangesByGroup((current) => ({
        ...current,
        [group.key]: {
          status: "error",
          files: [],
          changedFilesTotal: 0,
          omittedFileCount: 0,
          error: cleanIpcError(error)
        }
      }))
    }
  }, [])

  useEffect(() => {
    if (groups.length === 0) {
      setChangesByGroup({})
      return
    }

    setChangesByGroup((current) => {
      const next: Record<string, WorkspaceChangeState> = {}
      for (const group of groups) {
        next[group.key] = current[group.key] ?? {
          status: "loading",
          files: [],
          changedFilesTotal: 0,
          omittedFileCount: 0
        }
      }
      return next
    })

    for (const group of groups) {
      void refreshGroup(group)
    }
  }, [groups, refreshGroup])

  useEffect(() => {
    if (groupsByThreadId.size === 0) return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const cleanup = window.api.workspace.onFilesChanged((data) => {
      const group = groupsByThreadId.get(data.threadId)
      if (!group) return
      const existing = timers.get(group.key)
      if (existing) {
        clearTimeout(existing)
      }
      timers.set(
        group.key,
        setTimeout(() => {
          timers.delete(group.key)
          void refreshGroup(group)
        }, 120)
      )
    })

    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      cleanup()
    }
  }, [groupsByThreadId, refreshGroup])

  const visibleChangedFiles = groups.reduce(
    (total, group) => total + (changesByGroup[group.key]?.changedFilesTotal ?? 0),
    0
  )

  return (
    <section className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Git 变更</span>
        </div>
        {groups.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{visibleChangedFiles} files</span>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          当前特性还没有关联会话，暂无代码变更。
        </div>
      ) : groups.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          暂无可展示的代码变更。
        </div>
      ) : (
        <div className="divide-y divide-border">
          {groups.map((group) => {
            const state = changesByGroup[group.key]

            return (
              <div key={group.key} className="px-3 py-3">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" title={group.workspacePath}>
                      {getWorkspaceName(group.workspacePath)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    title="打开会话路径"
                    onClick={() => void openWorkspacePathInFileManager(group.workspacePath)}
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>

                {!state || state.status === "loading" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在读取 Git 变更
                  </div>
                ) : state.status === "error" ? (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 px-2.5 py-2 text-xs text-status-warning">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{state.error}</span>
                  </div>
                ) : state.files.length === 0 ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-status-nominal" />
                    当前工作区没有 Git 变更
                  </div>
                ) : (
                  <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {state.files.map((file) => (
                      <div
                        key={file.path}
                        className="flex min-w-0 items-center gap-2 rounded border border-border/70 px-2 py-1.5 text-xs"
                      >
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate" title={file.path}>{file.path}</span>
                      </div>
                    ))}
                    {state.omittedFileCount > 0 && (
                      <div className="text-xs text-muted-foreground">
                        还有 {state.omittedFileCount} 个文件未展示。
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ProjectDetailPage({
  project,
  detail,
  loading,
  creatingFeature,
  onBackToList,
  onCreateFeature,
  onRefresh,
  onEditProject,
  onOpenFeature
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  loading: boolean
  creatingFeature: boolean
  onBackToList: () => void
  onCreateFeature: (project: HarnessProjectListItem) => void
  onRefresh: (projectId: string) => void
  onEditProject: (project: HarnessProjectListItem) => void
  onOpenFeature: (projectId: string, slug: string) => void
}): React.JSX.Element {
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"
  const pluginCompatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
  const projectRootPath = resolveProjectRootPath(project)
  const openProjectWorkspaceInFileManager = useCallback((): void => {
    void openPathInFileManager(projectRootPath, "无法打开项目工作区")
  }, [projectRootPath])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={harnessPageHeaderClassName}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="min-w-0 space-y-2">
            <HarnessBreadcrumb
              project={project}
              onBack={onBackToList}
              onProjectList={onBackToList}
            />
            <ProjectBadgeRow project={project}>
              <Workflow className="size-5 shrink-0 text-status-info" />
              <h1 className="truncate text-xl font-semibold">{project.name}</h1>
            </ProjectBadgeRow>
          </div>
          <div className={harnessPageHeaderActionsClassName}>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={() => onEditProject(project)}
            >
              <Pencil className="size-4" />
              编辑项目信息
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={harnessDetailRefreshButtonClassName}
              onClick={() => onRefresh(project.projectId)}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            {!archived && (
              <Button
                size="sm"
                className={cn(harnessDetailPrimaryButtonClassName, harnessActionButtonClassName)}
                onClick={() => onCreateFeature(project)}
                disabled={creatingFeature || !!pluginCompatibilityMessage}
                title={pluginCompatibilityMessage || undefined}
              >
                <span aria-hidden="true" className={harnessActionOverlayClassName} />
                <span className={harnessActionIconClassName}>
                  {creatingFeature ? (
                    <Loader2 className="size-2.5 animate-spin" />
                  ) : (
                    <Plus className="size-2.5" />
                  )}
                </span>
                <span className="relative">新建特性</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto max-w-7xl space-y-5 p-6">
          {pluginCompatibilityMessage && (
            <div className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-3 text-sm text-status-warning">
              {pluginCompatibilityMessage}
            </div>
          )}
          <section className="rounded-md border border-border bg-background">
            <div className="grid grid-cols-[minmax(260px,0.36fr)_minmax(0,1fr)] gap-0">
              <aside className="border-r border-border p-4">
                <div className="text-sm font-semibold">项目基础信息</div>
                <dl className="mt-4 grid gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">项目名称</dt>
                    <dd className="mt-1 truncate font-medium" title={project.name}>{project.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">系统编号</dt>
                    <dd className="mt-1 truncate font-medium" title={project.systemId}>
                      {project.systemId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">系统名称</dt>
                    <dd className="mt-1 truncate font-medium" title={project.systemName}>
                      {project.systemName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">项目文件夹</dt>
                    <dd className="mt-1 flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-medium" title={projectRootPath}>
                        {getWorkspaceName(projectRootPath)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0"
                        title="打开项目工作区"
                        aria-label="打开项目工作区"
                        onClick={openProjectWorkspaceInFileManager}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
                  <div>
                    特性数
                    <strong className="mt-1 block text-sm text-foreground">
                      {loading || !detail ? "-" : runs.length}
                    </strong>
                  </div>
                  <div>
                    进行中
                    <strong className="mt-1 block text-sm text-foreground">
                      {loading || !detail ? "-" : activeCount}
                    </strong>
                  </div>
                </div>
                {detail?.projectState && (
                  <div className="mt-4">
                    <StatusPill status={detail.projectState} tooltip={detail.error} />
                  </div>
                )}
              </aside>

              <div className="min-w-0 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold">特性列表</div>
                  <div className="text-xs text-muted-foreground">
                    {loading || !detail ? "读取中" : `${runs.length} 个特性`}
                  </div>
                </div>

                {loading || !detail ? (
                  <div className="flex min-h-[260px] items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    读取项目详情
                  </div>
                ) : detail.error ? (
                  <div className="rounded-md border border-status-warning/30 bg-status-warning/10 px-3 py-3 text-sm text-status-warning">
                    {detail.error}
                  </div>
                ) : runs.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
                    当前项目还没有特性。
                  </div>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                    {runs.map((run) => (
                      <FeatureCard
                        key={run.slug}
                        run={run}
                        workflowNodes={workflowForProjectRun(detail, run).nodes}
                        onOpen={() => onOpenFeature(project.projectId, run.slug)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      </ScrollArea>
    </div>
  )
}

function FeatureDetailPage({
  detail,
  loading,
  unbound,
  activeSessionThreadId,
  isViewingSession,
  hasPendingGitDiffNotice,
  fallbackProjectName,
  fallbackFeatureTitle,
  fallbackFeatureSlug,
  onBackToList,
  onBackToProject,
  onRefresh,
  onActiveSessionChange,
  onSessionViewChange,
  onActiveSessionThreadChange,
  onRequestOpenGitPanel,
  onThreadGitStatusChange
}: {
  detail: HarnessRunDetailViewModel | null
  loading: boolean
  unbound?: boolean
  activeSessionThreadId?: string
  isViewingSession: boolean
  hasPendingGitDiffNotice?: boolean
  fallbackProjectName?: string
  fallbackFeatureTitle?: string
  fallbackFeatureSlug?: string
  onBackToList: () => void
  onBackToProject: () => void
  onRefresh: () => void
  onActiveSessionChange?: (threadId: string) => void
  onSessionViewChange?: (viewing: boolean) => void
  onActiveSessionThreadChange?: (threadId: string | null) => void
  onRequestOpenGitPanel?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
}): React.JSX.Element {
  const defaultNodeId = useMemo(() => {
    if (!detail) return null
    const currentNodeId = detail.run.currentNodeId
    if (currentNodeId && detail.run.nodes.some((node) => node.id === currentNodeId)) {
      return currentNodeId
    }
    return detail.run.nodes[0]?.id ?? null
  }, [detail])
  const detailKey = detail ? `${detail.project.projectId}:${detail.run.slug}` : ""
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const groupButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    setSelectedNodeId(defaultNodeId)
  }, [defaultNodeId, detail])

  const effectiveSelectedNodeId = selectedNodeId ?? defaultNodeId
  const selectedNode =
    detail?.run.nodes.find((node) => node.id === effectiveSelectedNodeId) ?? detail?.run.nodes[0] ?? null
  const selectedNodeHooks = useMemo(
    () => [...(selectedNode?.hooks ?? [])].sort((a, b) => (b.ts || "").localeCompare(a.ts || "")),
    [selectedNode]
  )
  const nodeGroups = useMemo(() => groupStageNodes(detail?.run.nodes ?? []), [detail])
  const selectedGroup = nodeGroups.length > 0
    ? nodeGroups.find((group) => selectedNode && group.nodes.some((node) => node.id === selectedNode.id)) ??
      nodeGroups.find((group) => group.nodes.some((node) => node.id === defaultNodeId)) ??
      nodeGroups[0]
    : null
  const selectedGroupKey = selectedGroup?.key ?? null

  useEffect(() => {
    if (!selectedGroupKey) return
    const frame = window.requestAnimationFrame(() => {
      groupButtonRefs.current[selectedGroupKey]?.scrollIntoView({
        block: "nearest",
        inline: "center"
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedGroupKey])

  const createThread = useAppStore((s) => s.createThread)
  const selectThread = useAppStore((s) => s.selectThread)
  const threads = useAppStore((s) => s.threads)
  const allThreadStates = useAllThreadStates()
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.thread_id, thread])), [threads])
  const [sessionBusy, setSessionBusy] = useState<"create" | null>(null)
  const [selectedSessionState, setSelectedSessionState] = useState<{
    detailKey: string
    threadId: string | null
  }>({ detailKey: "", threadId: null })
  const [activeDetailTab, setActiveDetailTab] = useState<"feature" | "session">(() =>
    isViewingSession && activeSessionThreadId ? "session" : "feature"
  )

  useEffect(() => {
    if (!detail) {
      setSelectedSessionState({ detailKey: "", threadId: null })
      return
    }

    const activeThreadId =
      activeSessionThreadId &&
      detail.sessions.some((session) => session.threadId === activeSessionThreadId)
        ? activeSessionThreadId
        : null
    const firstThreadId = activeThreadId ?? detail.sessions[0]?.threadId ?? null
    setSelectedSessionState((current) => {
      if (current.detailKey !== detailKey) {
        return { detailKey, threadId: firstThreadId }
      }
      if (activeThreadId && current.threadId !== activeThreadId) {
        return { detailKey, threadId: activeThreadId }
      }
      if (
        current.threadId &&
        detail.sessions.some((session) => session.threadId === current.threadId)
      ) {
        return current
      }
      return { detailKey, threadId: firstThreadId }
    })
  }, [activeSessionThreadId, detail, detailKey])

  useEffect(() => {
    setActiveDetailTab(isViewingSession && activeSessionThreadId ? "session" : "feature")
  }, [activeSessionThreadId, detailKey, isViewingSession])

  const selectedSessionThreadId =
    detail && selectedSessionState.detailKey === detailKey
      ? selectedSessionState.threadId
      : isViewingSession
        ? activeSessionThreadId ?? null
        : null
  const activeSessionThreadIdForView =
    activeDetailTab === "session" ? selectedSessionThreadId : null
  const effectiveActiveDetailTab = activeSessionThreadIdForView ? "session" : "feature"

  useEffect(() => {
    onActiveSessionThreadChange?.(activeSessionThreadIdForView)
  }, [activeSessionThreadIdForView, onActiveSessionThreadChange])

  const handleBackToFeature = (): void => {
    setActiveDetailTab("feature")
    onSessionViewChange?.(false)
    onRefresh()
  }

  const handleHookSessionSelect = useCallback((threadId: string): void => {
    if (!detail || !threadId) return
    setSelectedSessionState({ detailKey, threadId })
    onActiveSessionChange?.(threadId)
    setActiveDetailTab("session")
    onSessionViewChange?.(true)
  }, [detail, detailKey, onActiveSessionChange, onSessionViewChange])

  useEffect(() => {
    if (!activeSessionThreadIdForView) return
    void selectThread(activeSessionThreadIdForView, { preserveView: true })
  }, [activeSessionThreadIdForView, selectThread])

  const handleCreateSession = useCallback(async (): Promise<void> => {
    if (!detail || sessionBusy || unbound) return
    setSessionBusy("create")
    try {
      const thread = await createHarnessSession({
        projectId: detail.project.projectId,
        slug: detail.run.slug,
        nextAction: getHarnessRunNextAction(detail),
        sessions: detail.sessions,
        threadsById,
        threadStates: allThreadStates,
        createThread
      })
      setSelectedSessionState({ detailKey, threadId: thread.thread_id })
      onActiveSessionChange?.(thread.thread_id)
      setActiveDetailTab("session")
    } catch (error) {
      toast.error(cleanIpcError(error))
    } finally {
      setSessionBusy(null)
    }
  }, [
    allThreadStates,
    createThread,
    detail,
    detailKey,
    onActiveSessionChange,
    sessionBusy,
    threadsById,
    unbound
  ])

  const handleContextReminderSessionCreated = useCallback((threadId: string): void => {
    if (!threadId) return
    setSelectedSessionState({ detailKey, threadId })
    onActiveSessionChange?.(threadId)
    setActiveDetailTab("session")
    onSessionViewChange?.(true)
  }, [detailKey, onActiveSessionChange, onSessionViewChange])

  const renderStageNodeStrip = (): React.JSX.Element | null => {
    if (!detail) return null
    if (detail.run.nodes.length === 0) return null

    const renderStageNodeButton = (node: HarnessRunNode): React.JSX.Element => {
      const selected = effectiveSelectedNodeId === node.id
      return (
        <button
          key={node.id}
          type="button"
          onClick={() => {
            setSelectedNodeId(node.id)
          }}
          aria-pressed={selected}
          title={node.label}
          className={cn(
            "w-[210px] cursor-pointer rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            selected
              ? "border-status-info bg-status-info/10 shadow-sm"
              : "border-border bg-background hover:border-primary/45"
          )}
        >
          <div className="flex min-w-0 items-start gap-1.5">
            <span className="mt-0.5 shrink-0">{statusIcon(node.status)}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{node.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {node.status.label}
              </span>
            </span>
          </div>
        </button>
      )
    }

    if (nodeGroups.length > 0 && selectedGroup) {
      return (
        <div className="space-y-3">
          <div className="-mx-1 overflow-x-auto pb-2">
            <div className="flex w-max gap-3 px-1">
              {nodeGroups.map((group) => {
                const selected = selectedGroup.key === group.key
                const currentNode =
                  group.nodes.find((node) => node.id === defaultNodeId) ??
                  group.nodes[0]
                const groupProgress = groupProgressIndex(
                  group,
                  detail.workflow.nodes,
                  detail.run.currentNodeId
                )

                return (
                  <button
                    key={group.key}
                    ref={(element) => {
                      groupButtonRefs.current[group.key] = element
                    }}
                    type="button"
                    onClick={() => {
                      if (currentNode) setSelectedNodeId(currentNode.id)
                    }}
                    aria-pressed={selected}
                    title={group.label}
                    className={cn(
                      "flex h-[92px] w-[190px] flex-none cursor-pointer flex-col gap-2 rounded-md border px-3 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      selected
                        ? "border-status-info bg-status-info/10 shadow-sm"
                        : "border-border bg-background hover:border-primary/50 hover:shadow-sm"
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {currentNode ? statusIcon(currentNode.status) : <Circle className="size-4 text-muted-foreground" />}
                      <span className="truncate text-sm font-medium">{group.label}</span>
                    </div>
                    <ProgressBar progressIndex={groupProgress} totalNodes={group.nodes.length} />
                    <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      <span className="truncate">进度</span>
                      <span className="shrink-0">
                        {groupProgress}/{group.nodes.length}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="truncate text-sm font-semibold">{selectedGroup.label}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedGroup.nodes.map((node) => renderStageNodeButton(node))}
            </div>
          </section>
        </div>
      )
    }

    return (
      <div className="flex flex-wrap gap-2">
        {detail.run.nodes.map((node) => renderStageNodeButton(node))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={harnessPageHeaderClassName}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="min-w-0 space-y-2">
            <HarnessBreadcrumb
              project={
                detail
                  ? { name: detail.project.name }
                  : fallbackProjectName
                    ? { name: fallbackProjectName }
                    : null
              }
              featureTitle={detail?.run.title ?? fallbackFeatureTitle ?? "特性详情"}
              sessionTitle={
                activeSessionThreadIdForView
                  ? threadsById.get(activeSessionThreadIdForView)?.title
                  : undefined
              }
              onBack={effectiveActiveDetailTab === "session" ? handleBackToFeature : onBackToProject}
              onProjectList={onBackToList}
              onProject={onBackToProject}
              onFeature={effectiveActiveDetailTab === "session" ? handleBackToFeature : undefined}
            />
            <div className="flex min-w-0 items-center gap-2">
              <Workflow className="size-4 shrink-0 text-status-info" />
              <h1 className="truncate text-base font-semibold">
                {detail?.run.title ?? fallbackFeatureTitle ?? "特性详情"}
              </h1>
              {detail?.adapterSnapshot.mock && (
                <span className="shrink-0 rounded border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                  Mock
                </span>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {detail
                ? `${detail.project.name} · ${detail.run.slug}`
                : fallbackProjectName && fallbackFeatureSlug
                  ? `${fallbackProjectName} · ${fallbackFeatureSlug}`
                  : "加载中"}
            </div>
          </div>
          {effectiveActiveDetailTab === "feature" && (
            <div className={harnessPageHeaderActionsClassName}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={harnessDetailRefreshButtonClassName}
                onClick={onRefresh}
                disabled={loading || !detail || unbound}
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                刷新
              </Button>
              <Button
                type="button"
                size="sm"
                className={cn(harnessDetailPrimaryButtonClassName, harnessActionButtonClassName)}
                onClick={() => void handleCreateSession()}
                disabled={loading || !detail || unbound || sessionBusy !== null}
              >
                <span aria-hidden="true" className={harnessActionOverlayClassName} />
                <span className={harnessActionIconClassName}>
                  {sessionBusy === "create" ? (
                    <Loader2 className="size-2.5 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="size-2.5" />
                  )}
                </span>
                <span className="relative">{sessionBusy === "create" ? "创建中" : "新增会话"}</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      {activeSessionThreadIdForView ? (
        <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden p-6">
          <FeatureConversationPanel
            threadId={activeSessionThreadIdForView}
            hasPendingGitDiffNotice={hasPendingGitDiffNotice}
            onHarnessSessionCreated={handleContextReminderSessionCreated}
            onRequestOpenGitPanel={onRequestOpenGitPanel}
            onThreadGitStatusChange={onThreadGitStatusChange}
          />
        </div>
      ) : loading || !detail ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" />
          读取特性详情
        </div>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden p-6">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-5">
              <div className="min-w-0 space-y-4">
                {renderStageNodeStrip()}

                {selectedNode ? (
                  <StageArtifactPanel node={selectedNode} workspacePath={detail.project.projectRootPath} />
                ) : (
                  <section className="rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                    暂无阶段数据。
                  </section>
                )}
              </div>

              <aside className="min-w-0 space-y-4">
                <FeatureWorkspaceChangesPanel sessions={detail.sessions} threadsById={threadsById} />

                <section className="rounded-md border border-border bg-background">
                  <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-3 text-sm font-semibold">
                    <Workflow className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">运行事件</span>
                  </div>
                  {selectedNode && selectedNodeHooks.length > 0 ? (
                    <div className="max-h-64 overflow-y-auto">
                      {selectedNodeHooks.map((hook, index) => (
                        <HookLine
                          key={`${hook.ts || "hook"}-${hook.eventId}-${index}`}
                          hook={hook}
                          onSelectSession={handleHookSessionSelect}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-6 text-sm text-muted-foreground">
                      当前阶段暂无运行事件。
                    </div>
                  )}
                </section>
              </aside>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectFeatureSidebar({
  groups,
  collapsedKeys,
  allCollapsed,
  creatingSessionKey,
  threadsById,
  allThreadStates,
  allStreamLoadingStates,
  selectedFeature,
  isViewingSession,
  unreadIds,
  exportingThreadId,
  editingThreadId,
  editingTitle,
  onToggleCollapse,
  onToggleAll,
  onCreateSession,
  onSelectSession,
  onRunFinished,
  onDeleteSession,
  onExportSession,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange
}: {
  groups: ProjectFeatureSessionGroup[]
  collapsedKeys: Set<string>
  allCollapsed: boolean
  creatingSessionKey: string | null
  threadsById: Map<string, Thread>
  allThreadStates: ThreadWorkspaceStateMap
  allStreamLoadingStates: Record<string, boolean>
  selectedFeature: SelectedFeature | null
  isViewingSession: boolean
  unreadIds: Set<string>
  exportingThreadId: string | null
  editingThreadId: string | null
  editingTitle: string
  onToggleCollapse: (key: string) => void
  onToggleAll: () => void
  onCreateSession: (
    project: HarnessProjectListItem,
    slug: string,
    sessions: HarnessSessionBinding[]
  ) => void
  onSelectSession: (projectId: string, slug: string, threadId: string) => void
  onRunFinished: (threadId: string) => void
  onDeleteSession: (thread: Thread) => void
  onExportSession: (thread: Thread) => void
  onStartEditing: (thread: Thread) => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
}): React.JSX.Element {
  const { currentThreadId } = useAppStore()
  const highlightThreadId = isViewingSession ? currentThreadId : null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">特性会话 {groups.length}</span>
        {groups.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 cursor-pointer"
            title={allCollapsed ? "全部展开特性会话" : "全部收起特性会话"}
            onClick={onToggleAll}
          >
            {allCollapsed ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-2">
          {groups.map((group, index) => {
            const isCollapsed = collapsedKeys.has(group.key)
            const selected =
              selectedFeature?.projectId === group.project.projectId &&
              selectedFeature.slug === group.slug
            const creatingSession = creatingSessionKey === group.key
            const sectionLabel = getProjectFeatureGroupSectionLabel(
              groups[index - 1]?.section,
              group.section,
              !!selectedFeature
            )
            const hasUnreadSession = group.sessions.some((session) =>
              unreadIds.has(session.threadId)
            )
            const projectArchived = group.project.lifecycle.status === "archived"

            return (
              <div key={group.key} className="space-y-1">
                {sectionLabel && (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-[10px] text-muted-foreground/70">
                    <span className="h-px flex-1 bg-border/70" />
                    <span className="shrink-0">{sectionLabel}</span>
                    <span className="h-px flex-1 bg-border/70" />
                  </div>
                )}
                <div
                  className={cn(
                    "group flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left transition-colors",
                    selected ? "bg-sidebar-accent/70 text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/40"
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <button
                      type="button"
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent/50"
                      title={isCollapsed ? "展开会话" : "收起会话"}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleCollapse(group.key)
                      }}
                    >
                      {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </button>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Workflow className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={group.title}>
                        {group.title}
                      </span>
                      {projectArchived && (
                        <span
                          className="shrink-0 rounded-sm border border-status-warning/30 bg-status-warning/15 px-2 py-0.5 text-[11px] font-medium leading-none text-status-warning"
                          title={`所属项目「${group.project.name}」已归档`}
                        >
                          已归档
                        </span>
                      )}
                      {hasUnreadSession && <span className="size-2 rounded-full bg-blue-500 shrink-0" />}
                    </div>
                  </div>
                  <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
                    <span className="absolute right-1 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {group.sessions.length}
                    </span>
                    <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0 opacity-70 hover:bg-accent/20"
                        title="新增会话"
                        disabled={creatingSession}
                        onClick={(event) => {
                          event.stopPropagation()
                          void onCreateSession(group.project, group.slug, group.sessions)
                        }}
                      >
                        {creatingSession ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                      </Button>
                    </span>
                  </span>
                </div>

                {!isCollapsed && (
                  <div className="ml-4 space-y-1 border-l border-border/70 pl-2">
                    {group.sessions.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">暂无关联会话</div>
                    ) : (
                      group.sessions.map((session) => {
                        const thread = threadsById.get(session.threadId)
                        if (!thread) return null
                        const threadState = allThreadStates[thread.thread_id]
                        const isLoading = allStreamLoadingStates[thread.thread_id] ?? false
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
                            hasContextReminder={hasContextReminder}
                            scheduledTaskLoading={scheduledTaskLoading}
                            isExporting={exportingThreadId === thread.thread_id}
                            isSelected={highlightThreadId === thread.thread_id}
                            isEditing={editingThreadId === thread.thread_id}
                            isUnread={unreadIds.has(thread.thread_id)}
                            hasPendingUserInput={hasPendingUserInput}
                            editingTitle={editingTitle}
                            hoverTitle={`所属项目：${group.project.name} / ${group.title}`}
                            onSelect={() => onSelectSession(group.project.projectId, session.slug, thread.thread_id)}
                            onRunFinished={() => onRunFinished(thread.thread_id)}
                            onDelete={() => onDeleteSession(thread)}
                            onExport={() => void onExportSession(thread)}
                            onStartEditing={() => onStartEditing(thread)}
                            onSaveTitle={onSaveTitle}
                            onCancelEditing={onCancelEditing}
                            onEditingTitleChange={onEditingTitleChange}
                          />
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {groups.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无特性会话</div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

interface HarnessBoardViewProps {
  hasPendingGitDiffNotice?: boolean
  onRequestOpenGitPanel?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
  onActiveSessionThreadChange?: (threadId: string | null) => void
}

export function HarnessBoardView({
  hasPendingGitDiffNotice,
  onRequestOpenGitPanel,
  onThreadGitStatusChange,
  onActiveSessionThreadChange
}: HarnessBoardViewProps = {}): React.JSX.Element {
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [detailsByProjectId, setDetailsByProjectId] = useState<Record<string, HarnessProjectDetailViewModel>>({})
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set())
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null)
  const [isViewingSession, setIsViewingSession] = useState(false)
  const [runDetail, setRunDetail] = useState<HarnessRunDetailViewModel | null>(null)
  const [adapterRegistry, setAdapterRegistry] = useState<HarnessAdapterRegistryItem[]>([])
  const [marketPluginItems, setMarketPluginItems] = useState<MarketItem[]>([])
  const [query, setQuery] = useState("")
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingRun, setLoadingRun] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<HarnessProjectCreateInput>(() => createEmptyProjectForm())
  const [formError, setFormError] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<HarnessProjectListItem | null>(null)
  const [editForm, setEditForm] = useState<HarnessProjectMetadataUpdateInput>(() =>
    createEmptyProjectMetadataForm()
  )
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [archivingProjectId, setArchivingProjectId] = useState<string | null>(null)
  const [featureDialogProject, setFeatureDialogProject] = useState<HarnessProjectListItem | null>(null)
  const [featureName, setFeatureName] = useState("")
  const [featureError, setFeatureError] = useState<string | null>(null)
  const [creatingFeatureProjectId, setCreatingFeatureProjectId] = useState<string | null>(null)
  const [updatingPluginProjectIds, setUpdatingPluginProjectIds] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const {
    threads,
    currentThreadId,
    createThread,
    selectThread,
    updateThread,
    deleteThread,
    pluginVersion,
    bumpPluginVersion
  } = useAppStore()
  const { cleanupThread } = useThreadContext()
  const allThreadStates = useAllThreadStates()
  const allStreamLoadingStates = useAllStreamLoadingStates()
  const [collapsedFeatureKeys, setCollapsedFeatureKeys] = useState<Set<string>>(new Set())
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(THREAD_UNREAD_STORAGE_KEY) || "[]")
      return new Set(Array.isArray(arr) ? arr.filter((id): id is string => typeof id === "string") : [])
    } catch {
      return new Set()
    }
  })
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(null)
  const [sidebarThreadToDelete, setSidebarThreadToDelete] = useState<Thread | null>(null)
  const [creatingSidebarSessionKey, setCreatingSidebarSessionKey] = useState<string | null>(null)
  const creatingFeatureRef = useRef(false)
  const projectsRef = useRef(projects)
  const selectedProjectIdRef = useRef(selectedProjectId)
  const selectedFeatureRef = useRef(selectedFeature)
  const currentThreadIdRef = useRef(currentThreadId)
  const isViewingSessionRef = useRef(isViewingSession)
  const projectDetailsRefreshInFlightRef = useRef(false)
  const selectedProjectRefreshInFlightRef = useRef(false)
  const skipRunDetailLoadForSessionRef = useRef<string | null>(null)
  const loadProjectsRequestIdRef = useRef(0)
  projectsRef.current = projects
  selectedProjectIdRef.current = selectedProjectId
  selectedFeatureRef.current = selectedFeature
  currentThreadIdRef.current = currentThreadId
  isViewingSessionRef.current = isViewingSession

  const persistUnread = useCallback((ids: Set<string>) => {
    localStorage.setItem(THREAD_UNREAD_STORAGE_KEY, JSON.stringify([...ids]))
  }, [])

  const handleRunFinished = useCallback(
    (threadId: string) => {
      if (threadId === currentThreadIdRef.current && isViewingSessionRef.current) return
      setUnreadIds((current) => {
        if (current.has(threadId)) return current
        const next = new Set(current)
        next.add(threadId)
        persistUnread(next)
        return next
      })
    },
    [persistUnread]
  )

  const markRead = useCallback(
    (threadId: string) => {
      setUnreadIds((current) => {
        if (!current.has(threadId)) return current
        const next = new Set(current)
        next.delete(threadId)
        persistUnread(next)
        return next
      })
    },
    [persistUnread]
  )

  const loadProjectDetail = useCallback(async (
    projectId: string,
    options: { showLoading?: boolean; reportError?: boolean } = {}
  ) => {
    const showLoading = options.showLoading !== false
    const reportError = options.reportError ?? showLoading
    if (showLoading) {
      setLoadingDetailIds((current) => new Set(current).add(projectId))
    }
    if (reportError) {
      setLoadError(null)
    }
    try {
      const detail = await window.api.harnessBoard.getProjectDetail(projectId)
      setDetailsByProjectId((current) =>
        areHarnessValuesEqual(current[projectId], detail)
          ? current
          : { ...current, [projectId]: detail }
      )
    } catch (error) {
      if (reportError) {
        setLoadError(cleanIpcError(error))
      }
    } finally {
      if (showLoading) {
        setLoadingDetailIds((current) => {
          const next = new Set(current)
          next.delete(projectId)
          return next
        })
      }
    }
  }, [])

  const loadProjects = useCallback(async () => {
    const requestId = ++loadProjectsRequestIdRef.current
    setLoadingProjects(true)
    setLoadError(null)
    try {
      const [items, registry] = await Promise.all([
        window.api.harnessBoard.listProjects(),
        window.api.harnessBoard.registry()
      ])
      if (requestId !== loadProjectsRequestIdRef.current) return
      setProjects(items)
      setAdapterRegistry(applyMarketAdapterDisplayData(registry, [], []))
      const allProjectIds = items.map((item) => item.projectId)
      if (allProjectIds.length > 0) {
        const details = await window.api.harnessBoard.getProjectDetails(allProjectIds)
        if (requestId !== loadProjectsRequestIdRef.current) return
        setDetailsByProjectId((current) => mergeProjectDetailsIfChanged(current, details))
      }
      setSelectedProjectId((current) =>
        current && items.some((item) => item.projectId === current) ? current : null
      )
      scheduleHarnessAdapterDisplayRefresh(() => {
        if (requestId !== loadProjectsRequestIdRef.current) return
        void Promise.all([loadHarnessMarketPlugins(), loadHarnessInstalledPlugins()]).then(
          ([marketPlugins, installedPlugins]) => {
            if (requestId !== loadProjectsRequestIdRef.current) return
            setMarketPluginItems(marketPlugins)
            setAdapterRegistry(applyMarketAdapterDisplayData(registry, marketPlugins, installedPlugins))
          }
        )
      })
    } catch (error) {
      if (requestId !== loadProjectsRequestIdRef.current) return
      setLoadError(cleanIpcError(error))
    } finally {
      if (requestId === loadProjectsRequestIdRef.current) {
        setLoadingProjects(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects, pluginVersion])

  const refreshProjectDetailsInBackground = useCallback(async () => {
    if (selectedProjectIdRef.current || selectedFeatureRef.current) return
    if (projectDetailsRefreshInFlightRef.current) return

    const projectIds = projectsRef.current.map((project) => project.projectId)
    if (projectIds.length === 0) return

    projectDetailsRefreshInFlightRef.current = true
    try {
      const details = await window.api.harnessBoard.getProjectDetails(projectIds, { watchRefs: false })
      setDetailsByProjectId((current) => mergeProjectDetailsIfChanged(current, details))
    } catch {
      // Background refresh should not replace stable on-screen state with a transient global error.
    } finally {
      projectDetailsRefreshInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshProjectDetailsInBackground()
    }, PROJECT_STATUS_POLL_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [refreshProjectDetailsInBackground])

  const refreshSelectedProjectDetailInBackground = useCallback(async () => {
    const projectId = selectedProjectIdRef.current
    if (!projectId || selectedFeatureRef.current) return
    if (selectedProjectRefreshInFlightRef.current) return

    selectedProjectRefreshInFlightRef.current = true
    try {
      await loadProjectDetail(projectId, { showLoading: false, reportError: false })
    } finally {
      selectedProjectRefreshInFlightRef.current = false
    }
  }, [loadProjectDetail])

  useEffect(() => {
    if (!selectedProjectId || selectedFeature) return
    const timer = window.setInterval(() => {
      void refreshSelectedProjectDetailInBackground()
    }, PROJECT_STATUS_POLL_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [refreshSelectedProjectDetailInBackground, selectedFeature, selectedProjectId])

  const selectedFeatureProjectDetail = selectedFeature
    ? detailsByProjectId[selectedFeature.projectId]
    : undefined

  useEffect(() => {
    if (!selectedFeature) {
      skipRunDetailLoadForSessionRef.current = null
      setRunDetail(null)
      return
    }
    const activeSessionThreadId = selectedFeature.activeSessionThreadId
    const skipRunDetailKey = activeSessionThreadId
      ? featureSessionKey(selectedFeature.projectId, selectedFeature.slug, activeSessionThreadId)
      : null
    const pendingSkipRunDetailKey = skipRunDetailLoadForSessionRef.current
    if (pendingSkipRunDetailKey && pendingSkipRunDetailKey !== skipRunDetailKey) {
      skipRunDetailLoadForSessionRef.current = null
    }
    if (skipRunDetailKey && pendingSkipRunDetailKey === skipRunDetailKey) {
      skipRunDetailLoadForSessionRef.current = null
      setRunDetail((currentDetail) =>
        currentDetail &&
        currentDetail.project.projectId === selectedFeature.projectId &&
        currentDetail.run.slug === selectedFeature.slug
          ? currentDetail
          : null
      )
      setLoadingRun(false)
      return
    }
    if (
      selectedFeatureProjectDetail &&
      !selectedFeatureProjectDetail.runs.some((run) => run.slug === selectedFeature.slug)
    ) {
      setRunDetail(null)
      setLoadingRun(false)
      return
    }
    if (
      runDetail &&
      runDetail.project.projectId === selectedFeature.projectId &&
      runDetail.run.slug === selectedFeature.slug
    ) {
      return
    }
    let cancelled = false
    setRunDetail(null)
    setLoadingRun(true)
    window.api.harnessBoard
      .getRunDetail(selectedFeature.projectId, selectedFeature.slug)
      .then((detail) => {
        if (!cancelled) setRunDetail(detail)
      })
      .catch((error) => {
        if (!cancelled) setLoadError(cleanIpcError(error))
      })
      .finally(() => {
        if (!cancelled) setLoadingRun(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedFeature, selectedFeatureProjectDetail])

  useEffect(() => {
    return window.api.harnessBoard.onWatchRefsChanged((event) => {
      const currentFeature = selectedFeatureRef.current
      const projectMatch = event.scopeKey.match(/^project:(.+)$/)
      if (projectMatch) {
        if (!currentFeature) {
          void loadProjectDetail(projectMatch[1], { showLoading: false, reportError: false })
        }
        return
      }
      if (currentFeature && event.scopeKey === `run:${currentFeature.projectId}:${currentFeature.slug}`) {
        const capturedProjectId = currentFeature.projectId
        const capturedSlug = currentFeature.slug
        void window.api.harnessBoard
          .getRunDetail(capturedProjectId, capturedSlug)
          .then((detail) => {
            const current = selectedFeatureRef.current
            if (
              current &&
              current.projectId === capturedProjectId &&
              current.slug === capturedSlug
            ) {
              setRunDetail((currentDetail) =>
                areHarnessValuesEqual(currentDetail, detail) ? currentDetail : detail
              )
            }
          })
      }
    })
  }, [loadProjectDetail])

  const refreshSelectedRunDetail = useCallback(async (): Promise<void> => {
    if (!selectedFeature) return
    setLoadingRun(true)
    setLoadError(null)
    try {
      const detail = await window.api.harnessBoard.getRunDetail(
        selectedFeature.projectId,
        selectedFeature.slug
      )
      setRunDetail((currentDetail) =>
        areHarnessValuesEqual(currentDetail, detail) ? currentDetail : detail
      )
      await loadProjectDetail(selectedFeature.projectId, { showLoading: false, reportError: false })
    } catch (error) {
      setLoadError(cleanIpcError(error))
    } finally {
      setLoadingRun(false)
    }
  }, [loadProjectDetail, selectedFeature])

  const { activeSystemGroups, archivedSystemGroups } = useMemo<{
    activeSystemGroups: SystemGroup[]
    archivedSystemGroups: SystemGroup[]
  }>(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const activeMap = new Map<string, SystemGroup>()
    const archivedMap = new Map<string, SystemGroup>()

    for (const project of projects) {
      if (normalizedQuery) {
        const detail = detailsByProjectId[project.projectId]
        const haystack = [
          project.name,
          project.description,
          project.projectCode,
          project.projectDir,
          project.systemId,
          project.systemName,
          project.harnessAdapter.name,
          ...(detail?.runs.map((run) => `${run.title} ${run.slug} ${run.summary.text}`) ?? [])
        ]
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(normalizedQuery)) continue
      }

      const targetMap = project.lifecycle.status === "archived" ? archivedMap : activeMap
      const existing = targetMap.get(project.systemId)
      if (existing) {
        existing.projects.push(project)
      } else {
        targetMap.set(project.systemId, {
          systemCode: project.systemId,
          systemName: project.systemName,
          projects: [project]
        })
      }
    }

    return {
      activeSystemGroups: Array.from(activeMap.values()),
      archivedSystemGroups: Array.from(archivedMap.values())
    }
  }, [detailsByProjectId, projects, query])

  const resetCreateForm = useCallback(() => {
    setForm(createEmptyProjectForm())
    setFormError(null)
  }, [])

  const openCreateDialog = useCallback(() => {
    setForm(createEmptyProjectForm())
    setFormError(null)
    setDialogOpen(true)
  }, [])

  const handleCreateDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openCreateDialog()
        return
      }
      if (!creating) {
        setDialogOpen(false)
        resetCreateForm()
      }
    },
    [creating, openCreateDialog, resetCreateForm]
  )

  const handlePickWorkspace = async (): Promise<void> => {
    const workspacePath = await window.api.workspace.select()
    if (workspacePath) {
      setForm((current) => ({ ...current, workspacePath }))
    }
  }

  const handleSubmit = async (): Promise<void> => {
    setFormError(null)
    if (metadataRequiredMissing(form)) {
      setFormError("所有字段均为必填")
      return
    }
    const nameError = getProjectMetadataNameError(form)
    if (nameError) {
      setFormError(nameError)
      return
    }
    const selectedAdapter = findSelectedAdapter(adapterRegistry, form.adapterId)
    const compatibilityMessage = boardCompatibilityMessage(selectedAdapter?.boardCompatibility)
    if (compatibilityMessage) {
      setFormError(compatibilityMessage)
      return
    }
    setCreating(true)
    try {
      await window.api.harnessBoard.createProject(form)
      setDialogOpen(false)
      resetCreateForm()
      await loadProjects()
    } catch (error) {
      setFormError(cleanIpcError(error))
    } finally {
      setCreating(false)
    }
  }

  const handleEditProject = useCallback((project: HarnessProjectListItem) => {
    setEditingProject(project)
    setEditForm(toProjectMetadataForm(project))
    setEditError(null)
  }, [])

  const handleSubmitEdit = async (): Promise<void> => {
    if (!editingProject) return
    setEditError(null)
    if (metadataRequiredMissing(editForm)) {
      setEditError("所有字段均为必填")
      return
    }
    const nameError = getProjectMetadataNameError(editForm)
    if (nameError) {
      setEditError(nameError)
      return
    }

    setSavingEdit(true)
    try {
      await window.api.harnessBoard.updateProject(editingProject.projectId, editForm)
      const projectId = editingProject.projectId
      setEditingProject(null)
      setDetailsByProjectId((current) => {
        const next = { ...current }
        delete next[projectId]
        return next
      })
      await loadProjects()
    } catch (error) {
      setEditError(cleanIpcError(error))
    } finally {
      setSavingEdit(false)
    }
  }

  const handleArchiveProject = useCallback(
    async (project: HarnessProjectListItem): Promise<void> => {
      if (archivingProjectId || project.lifecycle.status === "archived") return
      const confirmed = window.confirm(`归档项目「${project.name}」？`)
      if (!confirmed) return

      setArchivingProjectId(project.projectId)
      setLoadError(null)
      try {
        await window.api.harnessBoard.archiveProject(project.projectId)
        setDetailsByProjectId((current) => {
          const next = { ...current }
          delete next[project.projectId]
          return next
        })
        if (selectedProjectId === project.projectId) {
          setSelectedProjectId(null)
          setSelectedFeature(null)
        }
        await loadProjects()
      } catch (error) {
        setLoadError(cleanIpcError(error))
      } finally {
        setArchivingProjectId(null)
      }
    },
    [archivingProjectId, loadProjects, selectedProjectId]
  )

  const openFeatureCreateDialog = useCallback((project: HarnessProjectListItem): void => {
    const compatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
    if (compatibilityMessage) {
      toast.warning(compatibilityMessage)
      return
    }
    setFeatureDialogProject(project)
    setFeatureName("")
    setFeatureError(null)
  }, [])

  const handleFeatureDialogOpenChange = useCallback(
    (open: boolean): void => {
      if (!open && !creatingFeatureProjectId) {
        setFeatureDialogProject(null)
        setFeatureName("")
        setFeatureError(null)
      }
    },
    [creatingFeatureProjectId]
  )

  const handleSubmitFeature = useCallback(async (): Promise<void> => {
    if (!featureDialogProject || creatingFeatureRef.current) return
    const feature = sanitizeHarnessNameInput(featureName).trim()
    if (!feature) {
      setFeatureError("特性名称不能为空")
      return
    }
    const featureNameError = getHarnessNameError("特性名称", feature)
    if (featureNameError) {
      setFeatureError(featureNameError)
      return
    }

    creatingFeatureRef.current = true
    setCreatingFeatureProjectId(featureDialogProject.projectId)
    setFeatureError(null)
    try {
      const result = await window.api.harnessBoard.createFeature({
        projectId: featureDialogProject.projectId,
        feature
      })

      setFeatureDialogProject(null)
      setFeatureName("")
      await loadProjectDetail(result.projectId)
      setSelectedProjectId(result.projectId)
      setSelectedFeature({
        projectId: result.projectId,
        slug: result.slug
      })
      setIsViewingSession(false)
    } catch (error) {
      setFeatureError(cleanIpcError(error))
    } finally {
      creatingFeatureRef.current = false
      setCreatingFeatureProjectId(null)
    }
  }, [
    featureDialogProject,
    featureName,
    loadProjectDetail
  ])

  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.thread_id, thread])), [threads])
  const harnessSessionIndex = useMemo(() => buildHarnessSessionIndex(threads), [threads])
  const selectedFeatureSessions = useMemo(
    () =>
      selectedFeature
        ? getFeatureSessions(harnessSessionIndex, selectedFeature.projectId, selectedFeature.slug)
        : [],
    [harnessSessionIndex, selectedFeature]
  )
  const runDetailWithSessions = useMemo(
    () => {
      if (
        runDetail &&
        selectedFeature &&
        runDetail.project.projectId === selectedFeature.projectId &&
        runDetail.run.slug === selectedFeature.slug
      ) {
        return withDerivedRunSessions(runDetail, selectedFeatureSessions)
      }
      if (!selectedFeature || !selectedFeatureProjectDetail) {
        return null
      }
      const featureExists = selectedFeatureProjectDetail.runs.some((run) => run.slug === selectedFeature.slug)
      return featureExists && !(isViewingSession && selectedFeature.activeSessionThreadId)
        ? null
        : createUnboundRunDetail(selectedFeatureProjectDetail, selectedFeature.slug, selectedFeatureSessions)
    },
    [isViewingSession, runDetail, selectedFeature, selectedFeatureProjectDetail, selectedFeatureSessions]
  )
  const showingUnboundRunDetail =
    runDetailWithSessions !== null &&
    runDetail === null &&
    !(
      selectedFeature?.activeSessionThreadId &&
      isViewingSession &&
      selectedFeatureProjectDetail?.runs.some((run) => run.slug === selectedFeature.slug)
    )
  const selectedProject =
    selectedProjectId ? projects.find((project) => project.projectId === selectedProjectId) ?? null : null
  const selectedProjectDetail = selectedProjectId ? detailsByProjectId[selectedProjectId] : undefined
  const projectPluginUpdateInfoById = useMemo(() => {
    const marketPluginByName = buildMarketPluginMap(marketPluginItems)
    const next = new Map<string, MarketPluginUpdateInfo>()

    for (const project of projects) {
      const marketPlugin = marketPluginByName.get(normalizeAdapterMarketName(project.harnessAdapter.name))
      const updateInfo = getMarketPluginUpdateInfo(marketPlugin)
      if (updateInfo) {
        next.set(project.projectId, updateInfo)
      }
    }

    return next
  }, [marketPluginItems, pluginVersion, projects])

  const openProjectDetail = useCallback(
    (projectId: string): void => {
      setSelectedFeature(null)
      setSelectedProjectId(projectId)
      if (!detailsByProjectId[projectId] && !loadingDetailIds.has(projectId)) {
        void loadProjectDetail(projectId)
      }
    },
    [detailsByProjectId, loadProjectDetail, loadingDetailIds]
  )

  const handleUpdateProjectPlugin = useCallback(
    async (project: HarnessProjectListItem, updateInfo: MarketPluginUpdateInfo): Promise<void> => {
      if (updatingPluginProjectIds.has(project.projectId)) return

      setUpdatingPluginProjectIds((current) => new Set(current).add(project.projectId))
      try {
        const response = await installMarketPluginUpdate(updateInfo.item)
        if (response.success) {
          toast.success(`已为您更新并安装「${updateInfo.itemName}」到插件，请新开一个会话试试效果。`)
          bumpPluginVersion()
        } else {
          toast.error(response.error || "更新安装失败")
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新安装失败")
      } finally {
        setUpdatingPluginProjectIds((current) => {
          const next = new Set(current)
          next.delete(project.projectId)
          return next
        })
      }
    },
    [bumpPluginVersion, updatingPluginProjectIds]
  )

  const openFeatureDetail = useCallback(
    (projectId: string, slug: string, activeSessionThreadId?: string): void => {
      setSelectedProjectId(projectId)
      setSelectedFeature({ projectId, slug, activeSessionThreadId })
      setIsViewingSession(!!activeSessionThreadId)
      if (!detailsByProjectId[projectId] && !loadingDetailIds.has(projectId)) {
        void loadProjectDetail(projectId)
      }
    },
    [detailsByProjectId, loadProjectDetail, loadingDetailIds]
  )

  const handleBackToProjectList = useCallback((): void => {
    setSelectedFeature(null)
    setSelectedProjectId(null)
    setIsViewingSession(false)
  }, [])

  const handleBackToProject = useCallback((): void => {
    setSelectedFeature(null)
    setIsViewingSession(false)
  }, [])

  const projectSidebarGroups = useMemo<ProjectFeatureSessionGroup[]>(() => {
    const groups: ProjectFeatureSessionGroup[] = []
    const activeProjectId = selectedFeature?.projectId ?? selectedProjectId

    for (const project of projects) {
      const sessionsBySlug = new Map<string, HarnessSessionBinding[]>()
      for (const session of getProjectSessions(harnessSessionIndex, project.projectId)) {
        const sessions = sessionsBySlug.get(session.slug) ?? []
        sessions.push(session)
        sessionsBySlug.set(session.slug, sessions)
      }

      for (const [slug, sessions] of sessionsBySlug) {
        const section: ProjectFeatureSessionGroupSection =
          selectedFeature && project.projectId === selectedFeature.projectId && slug === selectedFeature.slug
            ? "current"
            : activeProjectId && project.projectId === activeProjectId
              ? "project"
              : "other"

        groups.push({
          key: `${project.projectId}:${slug}`,
          project,
          slug,
          title: slug,
          sessions,
          section
        })
      }
    }

    if (!activeProjectId) return groups

    return groups
      .map((group, index) => {
        const priority = group.section === "current" ? 0 : group.section === "project" ? 1 : 2
        return { group, index, priority }
      })
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .map(({ group }) => group)
  }, [harnessSessionIndex, projects, selectedFeature, selectedProjectId])

  const allFeatureGroupsCollapsed =
    projectSidebarGroups.length > 0 &&
    projectSidebarGroups.every((group) => collapsedFeatureKeys.has(group.key))

  const toggleAllFeatureGroups = useCallback(() => {
    setCollapsedFeatureKeys((current) => {
      const next = new Set(current)
      if (allFeatureGroupsCollapsed) {
        for (const group of projectSidebarGroups) {
          next.delete(group.key)
        }
      } else {
        for (const group of projectSidebarGroups) {
          next.add(group.key)
        }
      }
      return next
    })
  }, [allFeatureGroupsCollapsed, projectSidebarGroups])

  const saveSidebarThreadTitle = useCallback(async (): Promise<void> => {
    if (editingThreadId && editingTitle.trim()) {
      await updateThread(editingThreadId, { title: editingTitle.trim() })
    } else if (editingThreadId) {
      toast.warning("会话标题不能为空")
      return
    }
    setEditingThreadId(null)
    setEditingTitle("")
  }, [editingThreadId, editingTitle, updateThread])

  const cancelSidebarThreadEditing = useCallback((): void => {
    setEditingThreadId(null)
    setEditingTitle("")
  }, [])

  const handleExportSidebarThread = useCallback(
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

  const confirmDeleteSidebarThread = useCallback(
    async (): Promise<void> => {
      if (!sidebarThreadToDelete) return
      try {
        cleanupThread(sidebarThreadToDelete.thread_id)
        await deleteThread(sidebarThreadToDelete.thread_id)
        markRead(sidebarThreadToDelete.thread_id)
        setSidebarThreadToDelete(null)
      } catch (error) {
        toast.error(cleanIpcError(error))
        setSidebarThreadToDelete(null)
      }
    },
    [
      cleanupThread,
      deleteThread,
      markRead,
      sidebarThreadToDelete
    ]
  )

  const handleCreateSidebarSession = useCallback(
    async (
      project: HarnessProjectListItem,
      slug: string,
      sessions: HarnessSessionBinding[]
    ): Promise<void> => {
      const key = `${project.projectId}:${slug}`
      if (creatingSidebarSessionKey) return
      setCreatingSidebarSessionKey(key)
      try {
        const latestRunDetail = await window.api.harnessBoard.getRunDetail(project.projectId, slug)
        const thread = await createHarnessSession({
          projectId: project.projectId,
          slug,
          nextAction: getHarnessRunNextAction(latestRunDetail),
          sessions,
          threadsById,
          threadStates: allThreadStates,
          createThread
        })
        skipRunDetailLoadForSessionRef.current = featureSessionKey(
          project.projectId,
          slug,
          thread.thread_id
        )
        setSelectedProjectId(project.projectId)
        setSelectedFeature({ projectId: project.projectId, slug, activeSessionThreadId: thread.thread_id })
        setRunDetail((currentDetail) =>
          areHarnessValuesEqual(currentDetail, latestRunDetail) ? currentDetail : latestRunDetail
        )
        setIsViewingSession(true)
        markRead(thread.thread_id)
        await selectThread(thread.thread_id, { preserveView: true })
      } catch (error) {
        toast.error(cleanIpcError(error))
      } finally {
        setCreatingSidebarSessionKey(null)
      }
    },
    [
      allThreadStates,
      createThread,
      creatingSidebarSessionKey,
      markRead,
      selectThread,
      threadsById
    ]
  )

  const sidebarDeleteDialog = (
    <Dialog
      open={!!sidebarThreadToDelete}
      onOpenChange={(open) => {
        if (!open) setSidebarThreadToDelete(null)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>确认删除会话</DialogTitle>
          <DialogDescription>
            {`确定要删除「${sidebarThreadToDelete ? getThreadTitle(sidebarThreadToDelete) : ""}」吗？删除后不可恢复。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSidebarThreadToDelete(null)}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => void confirmDeleteSidebarThread()}>
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  const handleSessionViewChange = useCallback((viewing: boolean): void => {
    setIsViewingSession(viewing)
  }, [])

  const handleActiveSessionChange = useCallback((threadId: string): void => {
    setSelectedFeature((current) => {
      if (!current) return current
      if (current.activeSessionThreadId === threadId) return current
      return { ...current, activeSessionThreadId: threadId }
    })
    setIsViewingSession(true)
  }, [])

  const sidebarPortalNode = useHarnessSidebarPortalNode()
  const projectListSelected = selectedProjectId === null && selectedFeature === null
  const sidebarPortal =
    sidebarPortalNode
      ? createPortal(
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="px-2 pb-2">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full justify-start gap-2 text-sm font-semibold",
                  projectListSelected && "bg-muted"
                )}
                aria-current={projectListSelected ? "page" : undefined}
                onClick={handleBackToProjectList}
              >
                <div className="flex size-5 items-center justify-center rounded-full bg-muted-foreground/15">
                  <Workflow className="size-3" />
                </div>
                <span className="text-muted-foreground">项目列表</span>
              </Button>
            </div>
            <ProjectFeatureSidebar
              groups={projectSidebarGroups}
              collapsedKeys={collapsedFeatureKeys}
              allCollapsed={allFeatureGroupsCollapsed}
              creatingSessionKey={creatingSidebarSessionKey}
              threadsById={threadsById}
              allThreadStates={allThreadStates}
              allStreamLoadingStates={allStreamLoadingStates}
              selectedFeature={selectedFeature}
              isViewingSession={isViewingSession}
              unreadIds={unreadIds}
              exportingThreadId={exportingThreadId}
              editingThreadId={editingThreadId}
              editingTitle={editingTitle}
              onToggleCollapse={(key) =>
                setCollapsedFeatureKeys((current) => {
                  const next = new Set(current)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              onToggleAll={toggleAllFeatureGroups}
              onCreateSession={(project, slug, sessions) => {
                void handleCreateSidebarSession(project, slug, sessions)
              }}
              onSelectSession={(projectId, slug, threadId) => {
                openFeatureDetail(projectId, slug, threadId)
                markRead(threadId)
                void selectThread(threadId, { preserveView: true })
              }}
              onRunFinished={handleRunFinished}
              onDeleteSession={setSidebarThreadToDelete}
              onExportSession={(thread) => void handleExportSidebarThread(thread)}
              onStartEditing={(thread) => {
                setEditingThreadId(thread.thread_id)
                setEditingTitle(thread.title || "")
              }}
              onSaveTitle={saveSidebarThreadTitle}
              onCancelEditing={cancelSidebarThreadEditing}
              onEditingTitleChange={setEditingTitle}
            />
          </div>,
          sidebarPortalNode
        )
      : null

  const fallbackFeatureSummary =
    selectedFeatureProjectDetail?.runs.find((run) => run.slug === selectedFeature?.slug)

  useEffect(() => {
    if (selectedFeature) return
    onActiveSessionThreadChange?.(null)
  }, [onActiveSessionThreadChange, selectedFeature])

  if (selectedFeature) {
    return (
      <>
        <FeatureDetailPage
          detail={runDetailWithSessions}
          loading={loadingRun}
          unbound={showingUnboundRunDetail}
          activeSessionThreadId={selectedFeature.activeSessionThreadId}
          isViewingSession={isViewingSession}
          hasPendingGitDiffNotice={hasPendingGitDiffNotice}
          fallbackProjectName={selectedFeatureProjectDetail?.project?.name ?? selectedProject?.name}
          fallbackFeatureTitle={fallbackFeatureSummary?.title ?? selectedFeature.slug}
          fallbackFeatureSlug={fallbackFeatureSummary?.slug ?? selectedFeature.slug}
          onBackToList={handleBackToProjectList}
          onBackToProject={handleBackToProject}
          onRefresh={() => void refreshSelectedRunDetail()}
          onActiveSessionChange={handleActiveSessionChange}
          onSessionViewChange={handleSessionViewChange}
          onActiveSessionThreadChange={onActiveSessionThreadChange}
          onRequestOpenGitPanel={onRequestOpenGitPanel}
          onThreadGitStatusChange={onThreadGitStatusChange}
        />
        {sidebarDeleteDialog}
        {sidebarPortal}
      </>
    )
  }

  if (selectedProject) {
    return (
      <>
        <ProjectDetailPage
          project={selectedProject}
          detail={selectedProjectDetail}
          loading={loadingDetailIds.has(selectedProject.projectId)}
          creatingFeature={creatingFeatureProjectId === selectedProject.projectId}
          onBackToList={handleBackToProjectList}
          onCreateFeature={openFeatureCreateDialog}
          onRefresh={(projectId) => void loadProjectDetail(projectId)}
          onEditProject={handleEditProject}
          onOpenFeature={openFeatureDetail}
        />
        <FeatureCreateDialog
          project={featureDialogProject}
          featureName={featureName}
          creating={creatingFeatureProjectId !== null}
          error={featureError}
          onOpenChange={handleFeatureDialogOpenChange}
          onChange={setFeatureName}
          onSubmit={() => void handleSubmitFeature()}
        />
        <ProjectEditDialog
          open={editingProject !== null}
          saving={savingEdit}
          form={editForm}
          registry={adapterRegistry}
          error={editError}
          onOpenChange={(open) => {
            if (!open && !savingEdit) {
              setEditingProject(null)
            }
          }}
          onChange={setEditForm}
          onSubmit={() => void handleSubmitEdit()}
        />
        {sidebarDeleteDialog}
        {sidebarPortal}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={harnessPageHeaderClassName}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="flex w-[360px] max-w-[48vw] min-w-[220px] items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目、系统编号或特性"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className={harnessPageHeaderActionsClassName}>
            <Button
              variant="ghost"
              size="sm"
              className={harnessDetailRefreshButtonClassName}
              onClick={() => void loadProjects()}
            >
              {loadingProjects ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            <Button
              size="sm"
              className={cn(harnessDetailPrimaryButtonClassName, harnessActionButtonClassName)}
              onClick={openCreateDialog}
            >
              <span aria-hidden="true" className={harnessActionOverlayClassName} />
              <span className={harnessActionIconClassName}>
                <Plus className="size-2.5" />
              </span>
              <span className="relative">新建项目</span>
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto max-w-7xl space-y-7 p-6">
          {loadError && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-4 py-3 text-sm text-status-critical">
              {loadError}
            </div>
          )}

          {loadingProjects ? (
            <div className="flex min-h-[320px] items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin" />
              加载中
            </div>
          ) : projects.length === 0 ? (
            <div className="flex min-h-[360px] items-center justify-center">
              <div className="max-w-md rounded-md border border-border bg-background px-6 py-5 text-center shadow-sm">
                <div className="mx-auto flex size-11 items-center justify-center rounded-md bg-status-info/10 text-status-info">
                  <Workflow className="size-5" />
                </div>
                <div className="mt-3 text-sm font-semibold">暂无项目</div>
                <Button
                  className={cn("mt-4 gap-2", harnessActionButtonClassName)}
                  onClick={openCreateDialog}
                >
                  <span aria-hidden="true" className={harnessActionOverlayClassName} />
                  <span className={harnessActionIconClassName}>
                    <Plus className="size-2.5" />
                  </span>
                  <span className="relative">新建项目</span>
                </Button>
              </div>
            </div>
          ) : (
            <>
              {activeSystemGroups.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
                  {query.trim() ? "没有匹配的活跃项目或 feature。" : "暂无活跃项目。"}
                </div>
              ) : (
                activeSystemGroups.map((group) => (
                  <SystemSection
                    key={group.systemCode}
                    group={group}
                    detailsByProjectId={detailsByProjectId}
                    loadingDetailIds={loadingDetailIds}
                    archivingProjectId={archivingProjectId}
                    pluginUpdateInfoByProjectId={projectPluginUpdateInfoById}
                    updatingPluginProjectIds={updatingPluginProjectIds}
                    onEditProject={handleEditProject}
                    onArchiveProject={(project) => void handleArchiveProject(project)}
                    onUpdateProjectPlugin={(project, updateInfo) =>
                      void handleUpdateProjectPlugin(project, updateInfo)
                    }
                    onOpenProject={openProjectDetail}
                  />
                ))
              )}

              <Tabs defaultValue="archived" className="border-t border-border pt-6">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <TabsList>
                    <TabsTrigger value="archived" className="gap-2">
                      <Archive className="size-4" />
                      归档项目
                    </TabsTrigger>
                  </TabsList>
                  <div className="text-sm text-muted-foreground">
                    {archivedSystemGroups.reduce((count, group) => count + group.projects.length, 0)} 个项目
                  </div>
                </div>
                <TabsContent value="archived" className="mt-4 space-y-6">
                  {archivedSystemGroups.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border bg-background px-4 py-10 text-center text-sm text-muted-foreground">
                      {query.trim() ? "没有匹配的归档项目或 feature。" : "暂无归档项目。"}
                    </div>
                  ) : (
                    archivedSystemGroups.map((group) => (
                      <SystemSection
                        key={group.systemCode}
                        group={group}
                        detailsByProjectId={detailsByProjectId}
                        loadingDetailIds={loadingDetailIds}
                        archivingProjectId={archivingProjectId}
                        pluginUpdateInfoByProjectId={projectPluginUpdateInfoById}
                        updatingPluginProjectIds={updatingPluginProjectIds}
                        onEditProject={handleEditProject}
                        onArchiveProject={(project) => void handleArchiveProject(project)}
                        onUpdateProjectPlugin={(project, updateInfo) =>
                          void handleUpdateProjectPlugin(project, updateInfo)
                        }
                        onOpenProject={openProjectDetail}
                      />
                    ))
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </main>
      </ScrollArea>

      <FeatureCreateDialog
        project={featureDialogProject}
        featureName={featureName}
        creating={creatingFeatureProjectId !== null}
        error={featureError}
        onOpenChange={handleFeatureDialogOpenChange}
        onChange={setFeatureName}
        onSubmit={() => void handleSubmitFeature()}
      />
      <ProjectFormDialog
        open={dialogOpen}
        creating={creating}
        form={form}
        registry={adapterRegistry}
        error={formError}
        onOpenChange={handleCreateDialogOpenChange}
        onChange={setForm}
        onPickWorkspace={() => void handlePickWorkspace()}
        onSubmit={() => void handleSubmit()}
      />
      <ProjectEditDialog
        open={editingProject !== null}
        saving={savingEdit}
        form={editForm}
        registry={adapterRegistry}
        error={editError}
        onOpenChange={(open) => {
          if (!open && !savingEdit) {
            setEditingProject(null)
          }
        }}
        onChange={setEditForm}
        onSubmit={() => void handleSubmitEdit()}
      />
      {sidebarDeleteDialog}
      {sidebarPortal}
    </div>
  )
}
