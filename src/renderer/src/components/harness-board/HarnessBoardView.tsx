import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode
} from "react"
import { createPortal } from "react-dom"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleHelp,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Hammer,
  Info,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCcw,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShoppingBag,
  SkipForward,
  Trash2,
  Workflow,
  Zap,
  CircleCheckBig,
  TriangleAlert
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
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
import { KnowledgePreviewPanel } from "@/components/harness-board/KnowledgePreviewPanel"
import { KnowledgeDialog } from "@/components/harness-board/KnowledgeDialog"
import { createHarnessFeatureThread } from "@/lib/harness-feature-thread"
import { setPendingHarnessNextAction } from "@/lib/harness-next-action"
import { getHarnessRunNextAction } from "@/lib/harness-run-next-action"
import { buildUploaderIdCandidates } from "@/lib/skill-data-service"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  useAllStreamLoadingStates,
  useAllThreadStates,
  useThreadContext
} from "@/lib/thread-context"
import { toast } from "sonner"
import noSignalVideoUrl from "@/assets/harness-board/no-signal.mp4"
import { marketApi, type MarketItem } from "../../api/market"
import { formatTopUserOrgName } from "@/components/dashboard/use-dashboard"
import { UpdateVersionTooltip } from "@/components/customize/MarketPanel/MarketUpdateBadge"
import {
  getMarketPluginUpdateInfo,
  installMarketPluginUpdate,
  type MarketPluginUpdateInfo
} from "@/components/customize/MarketPanel/market-plugin-update"
import type {
  HarnessArtifact,
  HarnessArtifactType,
  HarnessDynamicWorkflowConfig,
  HarnessDynamicWorkflowNode,
  HarnessDynamicWorkflowTemplate,
  HarnessEventStatus,
  HarnessHookLogView,
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessKnowledgePreviewResult,
  HarnessProjectListItem,
  HarnessProjectMetadataUpdateInput,
  HarnessProjectReviewItem,
  HarnessProjectReviewResult,
  HarnessFeatureSummary,
  HarnessNodeStatus,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessDeployUnitMapping,
  HarnessDeployUnitSearchItem,
  HarnessLeanTokenConfig,
  HarnessSessionBinding,
  HarnessAdapterRegistryItem,
  HarnessBoardCompatibility,
  HarnessEnterpriseProjectDetailItem,
  HarnessEnterpriseProjectSearchItem,
  HarnessStatus,
  HarnessWorkflowNextAction,
  HarnessWorkflow,
  PluginMetadata,
  Thread,
  BuiltinRobotStatus,
  BuiltinRobotRemoteAccessOverview
} from "@/types"
import { HARNESS_SOURCE } from "../../../../shared/harness-board-types"

const harnessActionButtonClassName =
  "cursor-pointer group relative overflow-hidden rounded-md shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md"
const harnessPageHeaderClassName =
  "min-h-[50px] max-h-[80px] shrink-0 border-b border-border/80 bg-background/80 p-2 backdrop-blur-xl app-no-drag"
const harnessPageHeaderContentClassName = "flex h-full items-start justify-between gap-4"
const harnessPageHeaderActionsClassName = "flex shrink-0 items-center gap-2"
const harnessSurfaceClassName =
  "rounded-xl border border-border/80 bg-background-elevated/80 shadow-xs backdrop-blur"
const harnessKickerClassName =
  "text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"

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
const harnessDetailSecondaryButtonClassName = "w-[132px] gap-2 text-sm font-medium"
const harnessDetailPrimaryButtonClassName = "w-[112px] gap-2"
const harnessActionOverlayClassName =
  "pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-primary-foreground/10 to-primary-foreground/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
const harnessActionIconClassName =
  "relative flex size-4 items-center justify-center rounded-full bg-primary-foreground/15 ring-1 ring-primary-foreground/25 transition-transform duration-200 group-hover:scale-105"
const DELETED_PROJECT_NAME = "项目已删除"

const deletedProjectCompatibility: HarnessBoardCompatibility = {
  status: "missing-plugin",
  compatible: false,
  appApiVersion: 1,
  label: "项目已删除"
}
const harnessProjectCreateInputClassName =
  "bg-background text-foreground placeholder:text-muted-foreground/45"
const harnessProjectCreateSelectClassName =
  "min-w-0 overflow-hidden bg-background text-foreground data-[placeholder]:text-muted-foreground/45 [&>span]:min-w-0 [&>span]:truncate"
const harnessDialogContentClassName = "z-[60]"
const harnessDialogSelectContentClassName =
  "z-[70] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]"
const harnessProjectPopoverContentClassName =
  "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[70] origin-[var(--radix-popover-content-transform-origin)] w-[var(--radix-popover-trigger-width)] rounded-md border p-0 shadow-md outline-none"
const harnessNamePattern = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
const harnessNameRuleMessage = "仅支持中文、英文字母、数字、-、_"
const PROJECT_NAME_MAX_CHARS = 50
const PROJECT_CODE_MAX_CHARS = 15
const PROJECT_DESCRIPTION_MAX_CHARS = 100
const PROJECT_DIR_MAX_CHARS = 30
const HARNESS_SIDEBAR_PORTAL_ID = "harness-sidebar-portal"
const THREAD_UNREAD_STORAGE_KEY = "threads:unreadIds"
const SYSTEM_CONSTRAINT_UPDATE_KIND = "system-constraints-update"
const FEATURE_SESSION_INITIAL_VISIBLE_COUNT = 5
const FEATURE_SESSION_VISIBLE_INCREMENT = 8
const OTHER_ADAPTER_SCENARIO = "其他类别"
const ADAPTER_SELECT_PLACEHOLDER = "请选择已安装的支持项目模式的插件"
const PROJECT_STATUS_POLL_INTERVAL_MS = 60 * 1000
const CUSTOM_WORKFLOW_TEMPLATE_ID = "custom"
const ENTERPRISE_PROJECT_SEARCH_MIN_CHARS = 2
const DEPLOY_UNIT_SEARCH_MIN_CHARS = 3
const ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS = 300
const ENTERPRISE_PROJECT_DETAIL_QUERY_DEBOUNCE_MS = 160
type ProjectSidebarScrollIntent = "preserve" | "top" | null
const LEAN_TOKEN_VISIBLE_PREFIX_LENGTH = 6

const preventHarnessDialogOutsideClose: React.ComponentProps<
  typeof DialogContent
>["onPointerDownOutside"] = (event) => {
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

function normalizeEnterpriseProjectCode(value: string): string {
  return value.trim()
}

function createEmptyProjectMetadataForm(adapterId = ""): HarnessProjectMetadataUpdateInput {
  return {
    adapterId,
    adapterType: "plugin",
    name: "",
    projectCode: "",
    projectFromLean: false,
    projectDir: "",
    description: "",
    systemId: "",
    systemName: "",
    workspacePath: "",
    sessionWorkspacePath: ""
  }
}

function createEmptyProjectForm(adapterId = ""): HarnessProjectCreateInput {
  return createEmptyProjectMetadataForm(adapterId)
}

function createEmptyDeployUnitMapping(): HarnessDeployUnitMapping {
  return {
    deployUnitIdMapping: "",
    deployUnitId: "",
    localRepoPath: "",
    description: ""
  }
}

function maskLeanToken(value: string): string {
  if (value.length <= LEAN_TOKEN_VISIBLE_PREFIX_LENGTH) return value
  return `${value.slice(0, LEAN_TOKEN_VISIBLE_PREFIX_LENGTH)}${"*".repeat(value.length - LEAN_TOKEN_VISIBLE_PREFIX_LENGTH)}`
}

function buildDeployUnitMappingSavePayload(mappings: HarnessDeployUnitMapping[]): {
  mappings: HarnessDeployUnitMapping[]
  error: string | null
} {
  // Keep row-specific feedback in the renderer; the main process canonicalizes and assigns IDs.
  const seen = new Set<string>()
  const payload: HarnessDeployUnitMapping[] = []

  for (let index = 0; index < mappings.length; index += 1) {
    const row = mappings[index]
    const deployUnitId = row.deployUnitId.trim()
    const localRepoPath = row.localRepoPath.trim()
    const description = row.description?.trim() || ""
    if (!deployUnitId && !localRepoPath && !description) continue
    if (!deployUnitId) {
      return { mappings: [], error: `第 ${index + 1} 行发布单元 ID 不能为空` }
    }
    if (!localRepoPath) {
      return { mappings: [], error: `第 ${index + 1} 行代码库路径不能为空` }
    }
    if (seen.has(deployUnitId)) {
      return { mappings: [], error: `发布单元 ID 重复：${deployUnitId}` }
    }
    seen.add(deployUnitId)
    payload.push({
      deployUnitIdMapping: row.deployUnitIdMapping,
      deployUnitId,
      localRepoPath,
      ...(description ? { description } : {})
    })
  }

  return { mappings: payload, error: null }
}

interface SystemGroup {
  systemCode: string
  systemName: string
  projects: HarnessProjectListItem[]
}

interface HarnessBoardStats {
  totalProjects: number
  activeProjects: number
  archivedProjects: number
  totalSystems: number
  activeSystems: number
  totalFeatures: number
  activeFeatures: number
  completedFeatures: number
  riskFeatures: number
  incompatibleProjects: number
}

type HarnessProjectPhaseTone = "done" | "upcoming"

interface HarnessProjectPhaseStep {
  id: string
  order: number
  title: string
  statusLabel: string
  tone: HarnessProjectPhaseTone
}

const ENTERPRISE_PROJECT_PHASE_SEQUENCE = [
  "计划中",
  "开发中",
  "ST中",
  "ST完成",
  "UAT业务审核",
  "上线中",
  "上线完成",
  "结项中",
  "结项完成"
] as const

function buildEnterpriseProjectPhaseSteps(currentPhaseStatus: string): HarnessProjectPhaseStep[] {
  const normalizedPhaseStatus = currentPhaseStatus.trim()
  const currentIndex = ENTERPRISE_PROJECT_PHASE_SEQUENCE.findIndex(
    (phaseStatus) => phaseStatus === normalizedPhaseStatus
  )

  return ENTERPRISE_PROJECT_PHASE_SEQUENCE.filter(
    (phaseStatus) => phaseStatus !== "上线中" && phaseStatus !== "结项中"
  ).map((phaseStatus, index) => {
    const completed = currentIndex !== -1 && index <= currentIndex

    return {
      id: `enterprise-phase-${index + 1}`,
      order: index + 1,
      title: phaseStatus,
      statusLabel: completed ? "已完成" : "未完成",
      tone: completed ? "done" : "upcoming"
    }
  })
}

interface SelectedFeature {
  projectId: string
  slug: string
  activeSessionThreadId?: string
  deleted?: boolean
}

interface SelectedProjectSession {
  projectId: string
  threadId: string
  deleted?: boolean
}

type PendingProjectAction = {
  type: "archive" | "delete"
  project: HarnessProjectListItem
} | null

type ProjectFeatureSessionGroupSection = "current" | "project" | "other"
type ProjectFeatureSidebarProject = Omit<HarnessProjectListItem, "lifecycle"> & {
  lifecycle: {
    status: HarnessProjectListItem["lifecycle"]["status"] | "deleted"
  }
}

interface ProjectFeatureSessionGroup {
  key: string
  project: ProjectFeatureSidebarProject
  slug: string
  title: string
  sessions: HarnessSessionBinding[]
  section: ProjectFeatureSessionGroupSection
  deleted?: boolean
}

interface ProjectSessionProjectGroup {
  key: string
  project: ProjectFeatureSidebarProject
  section: ProjectFeatureSessionGroupSection
  projectSessions: HarnessProjectSessionBinding[]
  featureGroups: ProjectFeatureSessionGroup[]
  deleted?: boolean
}

type EnterpriseProjectDetailCacheEntry =
  | { kind: "hit"; project: HarnessEnterpriseProjectDetailItem }
  | { kind: "miss" }

type ProjectReviewState =
  | { kind: "idle" }
  | { kind: "loading"; projectCode: string }
  | { kind: "loaded"; projectCode: string; result: HarnessProjectReviewResult }
  | { kind: "error"; projectCode: string; message: string }

type GitChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

interface GitChangedFileSummary {
  path: string
  previousPath?: string
  status?: GitChangedFileStatus
}

interface GitChangedFilesSummaryState {
  success: boolean
  isGitRepo?: boolean
  files: GitChangedFileSummary[]
  changedFilesTotal?: number
  omittedFileCount?: number
  error?: string
}

interface AdapterScenarioGroup {
  useScenario: string
  adapters: HarnessAdapterRegistryItem[]
}

interface HarnessMarketUploaderProfile {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
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
  files: GitChangedFileSummary[]
  changedFilesTotal: number
  omittedFileCount: number
  error?: string
}

type ThreadWorkspaceStateMap = Record<
  string,
  | {
      workspacePath?: string | null
      scheduledTaskLoading?: boolean
      pendingApproval?: unknown
      pendingUserInput?: unknown
      contextReminder?: { pending?: boolean }
    }
  | undefined
>

interface HarnessFeatureThreadMetadata {
  projectId: string
  slug: string
  source: string
}

interface HarnessProjectSessionMetadata {
  projectId: string
  kind: string
  label: string
}

interface HarnessProjectSessionBinding {
  projectId: string
  kind: string
  label: string
  threadId: string
  createdAt: string
  lastActiveAt: string
}

interface HarnessSessionIndex {
  byProject: Map<string, HarnessSessionBinding[]>
  byProjectSlug: Map<string, Map<string, HarnessSessionBinding[]>>
  projectSessionsByProject: Map<string, HarnessProjectSessionBinding[]>
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

function resolveProjectRootPath(
  project: Pick<HarnessProjectListItem, "workspacePath" | "projectDir">
): string {
  return resolveWorkspaceFilePath(project.projectDir, project.workspacePath)
}

async function openPathInFileManager(targetPath: string, fallbackError: string): Promise<void> {
  try {
    const platform = await window.electron.ipcRenderer.invoke("get-platform")
    const normalizedPath = platform === "win32" ? targetPath.replace(/\//g, "\\") : targetPath
    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", normalizedPath)
    if (result && typeof result === "object" && "success" in result && !result.success) {
      const error =
        "error" in result && typeof result.error === "string" ? result.error : fallbackError
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

function sanitizeProjectDirFromProjectName(value: string): string {
  return value.replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/gu, "")
}

function readThreadHarnessFeature(thread: Thread): HarnessFeatureThreadMetadata | null {
  const harnessFeature = thread.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") return null

  const metadata = harnessFeature as Record<string, unknown>
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId.trim() : ""
  const slug = typeof metadata.slug === "string" ? metadata.slug.trim() : ""
  if (!projectId || !slug) return null

  const source =
    typeof metadata.source === "string" && metadata.source.trim() ? metadata.source : HARNESS_SOURCE
  return { projectId, slug, source }
}

function readThreadHarnessProjectSession(thread: Thread): HarnessProjectSessionMetadata | null {
  const harnessProjectSession = thread.metadata?.harnessProjectSession
  if (!harnessProjectSession || typeof harnessProjectSession !== "object") return null

  const metadata = harnessProjectSession as Record<string, unknown>
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId.trim() : ""
  const kind = typeof metadata.kind === "string" ? metadata.kind.trim() : ""
  if (!projectId || !kind) return null

  const label =
    typeof metadata.label === "string" && metadata.label.trim()
      ? metadata.label.trim()
      : getThreadTitle(thread)
  return { projectId, kind, label }
}

function readThreadHarnessProjectName(thread: Thread | null | undefined): string {
  const metadata = thread?.metadata
  const harnessFeature =
    metadata?.harnessFeature && typeof metadata.harnessFeature === "object"
      ? (metadata.harnessFeature as Record<string, unknown>)
      : null
  const harnessProjectSession =
    metadata?.harnessProjectSession && typeof metadata.harnessProjectSession === "object"
      ? (metadata.harnessProjectSession as Record<string, unknown>)
      : null
  const candidates = [
    harnessFeature?.projectName,
    harnessFeature?.name,
    harnessProjectSession?.projectName,
    harnessProjectSession?.name,
    metadata?.harnessProjectName,
    metadata?.projectName
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return DELETED_PROJECT_NAME
}

function makeDeletedProjectSidebarItem(
  projectId: string,
  name: string
): ProjectFeatureSidebarProject {
  return {
    projectId,
    name: name.trim() || DELETED_PROJECT_NAME,
    description: "",
    projectCode: "",
    projectFromLean: false,
    projectDir: "",
    systemId: "",
    systemName: "",
    workspacePath: "",
    harnessAdapter: {
      id: "",
      name: "",
      type: "plugin"
    },
    boardCompatibility: deletedProjectCompatibility,
    supportsDeployUnits: false,
    supportsSessionContextInjection: false,
    lifecycle: {
      status: "deleted"
    }
  }
}

function toSessionTimestamp(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString()
}

function buildHarnessSessionIndex(threads: Thread[]): HarnessSessionIndex {
  const byProject = new Map<string, HarnessSessionBinding[]>()
  const byProjectSlug = new Map<string, Map<string, HarnessSessionBinding[]>>()
  const projectSessionsByProject = new Map<string, HarnessProjectSessionBinding[]>()

  for (const thread of threads) {
    const projectSessionMetadata = readThreadHarnessProjectSession(thread)
    if (projectSessionMetadata) {
      const session: HarnessProjectSessionBinding = {
        projectId: projectSessionMetadata.projectId,
        kind: projectSessionMetadata.kind,
        label: projectSessionMetadata.label,
        threadId: thread.thread_id,
        createdAt: toSessionTimestamp(thread.created_at),
        lastActiveAt: toSessionTimestamp(thread.updated_at)
      }
      const projectSessions = projectSessionsByProject.get(projectSessionMetadata.projectId) ?? []
      projectSessions.push(session)
      projectSessionsByProject.set(projectSessionMetadata.projectId, projectSessions)
      continue
    }

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

    const slugMap =
      byProjectSlug.get(metadata.projectId) ?? new Map<string, HarnessSessionBinding[]>()
    let slugSessions = slugMap.get(metadata.slug)
    if (!slugSessions) {
      slugSessions = []
      slugMap.set(metadata.slug, slugSessions)
    }
    slugSessions.push(session)
    byProjectSlug.set(metadata.projectId, slugMap)
  }

  const sortSessions = <T extends { lastActiveAt: string }>(sessions: T[]): void => {
    sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
  }
  for (const sessions of byProject.values()) sortSessions(sessions)
  for (const sessions of projectSessionsByProject.values()) sortSessions(sessions)
  for (const slugMap of byProjectSlug.values()) {
    for (const sessions of slugMap.values()) sortSessions(sessions)
  }

  return { byProject, byProjectSlug, projectSessionsByProject }
}

function getProjectSessions(
  index: HarnessSessionIndex,
  projectId: string
): HarnessSessionBinding[] {
  return index.byProject.get(projectId) ?? []
}

function getFeatureSessions(
  index: HarnessSessionIndex,
  projectId: string,
  slug: string
): HarnessSessionBinding[] {
  return index.byProjectSlug.get(projectId)?.get(slug) ?? []
}

function getProjectLevelSessions(
  index: HarnessSessionIndex,
  projectId: string
): HarnessProjectSessionBinding[] {
  return index.projectSessionsByProject.get(projectId) ?? []
}

function getProjectFeatureGroupSectionLabel(
  previousSection: ProjectFeatureSessionGroupSection | undefined,
  section: ProjectFeatureSessionGroupSection,
  hasSelection: boolean
): string | null {
  if (!previousSection || previousSection === section) return null
  if (hasSelection && previousSection === "current" && section === "project") {
    return "当前项目"
  }
  if (hasSelection && section === "other") {
    return "其他项目会话"
  }
  if (section === "other") {
    return "其他项目会话"
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
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(() =>
    getHarnessSidebarPortalNode()
  )

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
      sessionWorkspacePath: detail.project.sessionWorkspacePath,
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
      skipNodeAvailable: false,
      selectedDeployUnits: [],
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
  const nodeIds = Array.isArray(run.nodeIds) ? run.nodeIds : []
  if (nodeIds.length === 0) return detail.workflow
  const nodesById = new Map(detail.workflow.nodes.map((node) => [node.id, node]))
  const nodes = nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is HarnessWorkflow["nodes"][number] => Boolean(node))
  return { ...detail.workflow, nodes }
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
  sessionWorkspacePath?: string | null
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
  const {
    projectId,
    slug,
    sessionWorkspacePath,
    nextAction,
    sessions,
    threadsById,
    threadStates,
    createThread
  } = params
  const configuredWorkspacePath = normalizeWorkspacePath(sessionWorkspacePath)
  const workspacePath =
    configuredWorkspacePath ??
    (await getLatestSessionWorkspacePath(sessions, threadsById, threadStates))
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

function getTextLengthError(label: string, value: string, maxChars: number): string | null {
  if (Array.from(value.trim()).length <= maxChars) return null
  return `${label}不能超过 ${maxChars} 字`
}

function getProjectMetadataNameError(form: HarnessProjectMetadataUpdateInput): string | null {
  return (
    getHarnessNameError("项目编号", form.projectCode) ??
    getHarnessNameError("项目文件夹", form.projectDir)
  )
}

function metadataNameInvalid(form: HarnessProjectMetadataUpdateInput): boolean {
  return getProjectMetadataNameError(form) !== null
}

function metadataLengthInvalid(
  form: HarnessProjectMetadataUpdateInput,
  options: { validateProjectDir?: boolean } = {}
): boolean {
  return (
    getTextLengthError("项目名称", form.name, PROJECT_NAME_MAX_CHARS) !== null ||
    getTextLengthError("项目编号", form.projectCode, PROJECT_CODE_MAX_CHARS) !== null ||
    getTextLengthError("项目描述", form.description, PROJECT_DESCRIPTION_MAX_CHARS) !== null ||
    (options.validateProjectDir === true &&
      getTextLengthError("项目文件夹", form.projectDir, PROJECT_DIR_MAX_CHARS) !== null)
  )
}

function toProjectMetadataForm(project: HarnessProjectListItem): HarnessProjectMetadataUpdateInput {
  return {
    adapterId: project.harnessAdapter.id,
    adapterType: project.harnessAdapter.type,
    name: project.name,
    projectCode: project.projectCode,
    projectFromLean: project.projectFromLean ?? false,
    projectDir: project.projectDir,
    description: project.description,
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    sessionWorkspacePath: project.sessionWorkspacePath ?? ""
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

function StatusPill({
  status,
  tooltip
}: {
  status: HarnessStatus
  tooltip?: string | null
}): React.JSX.Element {
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
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-80">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function isAdapterLoadedStatus(status?: HarnessStatus | null): status is HarnessStatus {
  return status?.uiKind === "ok" && status.label.trim().endsWith("已加载")
}

function AdapterLoadedTag({ status }: { status: HarnessStatus }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[11px] font-medium",
              statusTone(status)
            )}
            aria-label={status.label}
          >
            <Hammer className="size-3.5" />
            已加载
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-80">
          {status.label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ProjectPluginUpdateButton({
  pluginUpdateInfo,
  updatingPlugin,
  onClick
}: {
  pluginUpdateInfo: MarketPluginUpdateInfo
  updatingPlugin: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <UpdateVersionTooltip
      typeLabel="插件"
      installedVersion={pluginUpdateInfo.installedVersion}
      currentVersion={pluginUpdateInfo.currentVersion}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="market-update-bounce h-7 gap-1 rounded-lg border-[#78d7cb] bg-[#e5fbf7] px-3 text-xs text-[#0f766e] hover:bg-[#d4f7f0] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={updatingPlugin}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {updatingPlugin ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
        {updatingPlugin ? "更新中" : "可更新"}
      </Button>
    </UpdateVersionTooltip>
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

function isProgressCompletedNodeStatus(status: HarnessNodeStatus): boolean {
  return status === "done" || status === "skipped" || status === "archived"
}

function progressIndexFromCurrentNodeId(
  nodes: Array<{ id: string }>,
  currentNodeId: string,
  currentNodeStatus: HarnessNodeStatus
): number {
  const index = nodes.findIndex((node) => node.id === currentNodeId)
  if (index < 0) return 0
  return index + (isProgressCompletedNodeStatus(currentNodeStatus) ? 1 : 0)
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

function currentNodeStatusFromNodes(
  nodes: Array<{ id: string; nodeStatus: HarnessNodeStatus }>,
  currentNodeId: string
): HarnessNodeStatus {
  return nodes.find((node) => node.id === currentNodeId)?.nodeStatus ?? "unknown"
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
  currentNodeId: string,
  currentNodeStatus: HarnessNodeStatus
): number {
  const progressIndex = progressIndexFromCurrentNodeId(
    workflowNodes,
    currentNodeId,
    currentNodeStatus
  )
  const coveredNodeCount = Math.max(0, Math.min(progressIndex, workflowNodes.length))
  const completedNodeIds = new Set(workflowNodes.slice(0, coveredNodeCount).map((node) => node.id))
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

function ProjectDirTip(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="项目文件夹说明"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="z-[70] max-w-72">
          保存项目文档、详细设计等插件运行产物
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function SessionWorkspacePathTip(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="会话工作区提示"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="z-[70] max-w-72">
          当前项目会话默认工作区
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ReleaseUnitIdTip(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="发布单元 ID 提示"
            className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="z-[70] max-w-72">
          发布单元 ID，样例：LF39.18_AutoService
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
    uiKind:
      compatibility.status === "invalid-board-config" ||
      compatibility.status === "invalid-api-version"
        ? "error"
        : "warning"
  }
}

function boardCompatibilityMessage(
  compatibility?: HarnessBoardCompatibility | null
): string | null {
  if (!compatibility || compatibility.compatible || compatibility.status === "missing-plugin")
    return null
  return compatibility.message || "插件看板协议与当前 APP 不兼容。"
}

function findSelectedAdapter(
  registry: HarnessAdapterRegistryItem[],
  adapterId: string
): HarnessAdapterRegistryItem | null {
  if (!adapterId) return null
  const exactMatch = registry.find((adapter) => adapter.id === adapterId)
  if (exactMatch) return exactMatch

  const nameMatches = registry.filter(
    (adapter) => adapter.type === "plugin" && adapter.name === adapterId
  )
  return nameMatches.length === 1 ? nameMatches[0] : null
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

function buildHarnessBoardStats(
  projects: HarnessProjectListItem[],
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
): HarnessBoardStats {
  const allSystems = new Set<string>()
  const activeSystems = new Set<string>()
  let totalFeatures = 0
  let activeFeatures = 0
  let completedFeatures = 0
  let riskFeatures = 0
  let incompatibleProjects = 0

  for (const project of projects) {
    allSystems.add(project.systemId)
    if (project.lifecycle.status !== "archived") {
      activeSystems.add(project.systemId)
    }
    if (boardCompatibilityMessage(project.boardCompatibility)) {
      incompatibleProjects += 1
    }

    const runs = detailsByProjectId[project.projectId]?.runs ?? []
    totalFeatures += runs.length
    for (const run of runs) {
      switch (run.overallStatus.uiKind) {
        case "active":
          activeFeatures += 1
          break
        case "done":
        case "ok":
          completedFeatures += 1
          break
        case "warning":
        case "blocked":
        case "error":
          riskFeatures += 1
          break
        default:
          break
      }
    }
  }

  return {
    totalProjects: projects.length,
    activeProjects: projects.filter((project) => project.lifecycle.status !== "archived").length,
    archivedProjects: projects.filter((project) => project.lifecycle.status === "archived").length,
    totalSystems: allSystems.size,
    activeSystems: activeSystems.size,
    totalFeatures,
    activeFeatures,
    completedFeatures,
    riskFeatures,
    incompatibleProjects
  }
}

function HarnessMetricCard({
  label,
  value,
  hint,
  icon,
  tone = "neutral"
}: {
  label: string
  value: ReactNode
  hint: string
  icon: ReactNode
  tone?: "neutral" | "info" | "nominal" | "warning"
}): React.JSX.Element {
  return (
    <div className="w-[150px] group relative overflow-hidden rounded-md border border-border/75 bg-background/80 px-2 py-1.5 shadow-sm transition-colors duration-200 hover:border-primary/25 hover:bg-background">
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 h-0.5 opacity-80",
          tone === "info" && "bg-status-info",
          tone === "nominal" && "bg-status-nominal",
          tone === "warning" && "bg-status-warning",
          tone === "neutral" && "bg-border-emphasis"
        )}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            {label}
          </div>
          <div className="mt-0.5 text-base font-semibold tracking-tight text-foreground">
            {value}
          </div>
          <div className="truncate text-[10px] text-muted-foreground" title={hint}>
            {hint}
          </div>
        </div>
        <div
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/35",
            tone === "info" && "border-status-info/25 text-status-info",
            tone === "nominal" && "border-status-nominal/25 text-status-nominal",
            tone === "warning" && "border-status-warning/25 text-status-warning",
            tone === "neutral" && "border-border text-muted-foreground"
          )}
        >
          {icon}
        </div>
      </div>
    </div>
  )
}

function HarnessBoardOverview({
  stats,
  query,
  visibleProjectCount
}: {
  stats: HarnessBoardStats
  query: string
  visibleProjectCount: number
}): React.JSX.Element {
  const trimmedQuery = query.trim()
  const completionRate =
    stats.totalFeatures > 0 ? Math.round((stats.completedFeatures / stats.totalFeatures) * 100) : 0

  return (
    <section className={cn(harnessSurfaceClassName, "overflow-hidden p-3 -mt-2")}>
      <div className="flex justify-between items-center">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-status-info/20 bg-status-info/10 text-status-info">
              <Workflow className="size-3.5" />
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
              项目协作看板
            </h1>
          </div>
          <p className="mt-1 max-w-xl text-[11px] leading-4 text-muted-foreground">
            聚合项目、特性和风险状态，帮助快速定位当前最值得推进的项目。
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {trimmedQuery ? (
              <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-primary">
                当前筛选：{trimmedQuery}
              </span>
            ) : (
              <span className="rounded-full border border-border/80 bg-background/70 px-2.5 py-0.5">
                展示全部项目
              </span>
            )}
            <span className="rounded-full border border-border/80 bg-background/70 px-2.5 py-0.5">
              匹配 {visibleProjectCount} / {stats.totalProjects}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <HarnessMetricCard
            label="活跃项目"
            value={stats.activeProjects}
            hint={`${stats.activeSystems} 个活跃系统 · ${stats.archivedProjects} 个归档`}
            icon={<Workflow className="size-4" />}
            tone="info"
          />
          <HarnessMetricCard
            label="特性总量"
            value={stats.totalFeatures}
            hint={`${stats.activeFeatures} 个正在推进`}
            icon={<CircleDashed className="size-4" />}
            tone="neutral"
          />
          <HarnessMetricCard
            label="完成率"
            value={`${completionRate}%`}
            hint={`${stats.completedFeatures} / ${stats.totalFeatures || 0} 个特性已完成`}
            icon={<CheckCircle2 className="size-4" />}
            tone="nominal"
          />
          <HarnessMetricCard
            label="需关注"
            value={stats.riskFeatures + stats.incompatibleProjects}
            hint={`${stats.riskFeatures} 个风险特性 · ${stats.incompatibleProjects} 个插件提醒`}
            icon={<ShieldAlert className="size-4" />}
            tone="warning"
          />
        </div>
      </div>
    </section>
  )
}

function HarnessProjectPhaseFlow({
  steps
}: {
  steps: HarnessProjectPhaseStep[]
}): React.JSX.Element {
  return (
    <section className="w-full shrink-0 rounded-2xl border border-border/80 bg-background-elevated/80 p-3 shadow-sx">
      <div className="mb-2 flex">
        <span className="text-sm">项目流程</span>
        <span className="ml-2 shrink-0 rounded border border-border bg-blue-200/50 px-1.5 py-0.5 text-[10px] text-blue-600">
          来自精益之星
        </span>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-6">
          {steps.map((step, index) => {
            const isDone = step.tone === "done"
            const isLast = index === steps.length - 1

            return (
              <div key={step.id} className="relative min-w-0">
                {!isLast && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-[calc(100%-0px)] top-1/2 z-20 hidden -translate-y-1/2 min-[1198px]:flex"
                  >
                    <div
                      className={cn(
                        "flex h-7 w-6 items-center justify-center",
                        isDone && "text-status-nominal",
                        step.tone === "upcoming" && "text-muted-foreground"
                      )}
                    >
                      <ArrowRight className="size-4" strokeWidth={2.6} />
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  className={cn(
                    "relative z-10 flex w-full min-w-0 items-center gap-4 rounded-xl border px-2 py-2 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isDone
                      ? "border-status-nominal/20 bg-status-nominal/[0.04]"
                      : "border-border/100 bg-background/100 hover:border-status-info/20 hover:bg-background"
                  )}
                  title={`${step.title} ${step.statusLabel}`}
                >
                  <div
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all duration-200",
                      isDone && "bg-status-nominal text-white",
                      step.tone === "upcoming" && "bg-gray-200 text-muted-foreground"
                    )}
                  >
                    {isDone ? <Check className="size-3.5" /> : step.order}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-[11px] font-semibold tracking-tight",
                        isDone && "text-status-nominal",
                        step.tone === "upcoming" && "text-foreground"
                      )}
                    >
                      {step.title}
                    </div>
                    <div
                      className={cn(
                        "mt-0.5 text-[10px]",
                        isDone && "text-status-nominal/80",
                        step.tone === "upcoming" && "text-muted-foreground"
                      )}
                    >
                      {step.statusLabel}
                    </div>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function HarnessProjectStageStatusPanel({
  projectCode,
  reviewState,
  onOpenLeanTokenSettings
}: {
  projectCode: string
  reviewState: ProjectReviewState
  onOpenLeanTokenSettings: () => void
}): React.JSX.Element {
  return (
    <section
      className={
        "flex h-full min-h-0 flex-col overflow-hidden p-3 bg-background-elevated/80 shadow-sm ml-2 rounded-xl"
      }
    >
      <div className="flex items-center justify-between gap-3 px-1 py-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold">项目度量信息</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pr-1">
        <ProjectReviewSummary
          projectCode={projectCode}
          reviewState={reviewState}
          onOpenLeanTokenSettings={onOpenLeanTokenSettings}
        />
      </div>
    </section>
  )
}

function isProjectModeMarketPlugin(item: MarketItem): boolean {
  return item.project_mode_supported === true
}

function makeMissingMarketPluginCompatibility(): HarnessBoardCompatibility {
  return {
    status: "missing-plugin",
    compatible: false,
    appApiVersion: 1,
    label: ""
  }
}

function marketPluginToAdapter(
  item: MarketItem,
  uploaderProfiles: Record<string, HarnessMarketUploaderProfile>
): HarnessAdapterRegistryItem | null {
  const name = normalizeAdapterMarketName(item.name)
  if (!name) return null

  const uploaderProfile = resolveHarnessMarketUploaderProfile(uploaderProfiles, item.user_id)
  return {
    id: name,
    name,
    version: item.version?.trim() || "",
    type: "plugin",
    description: item.description?.trim() || "",
    useScenario: normalizeAdapterUseScenario(item.category),
    ...(uploaderProfile?.userName ? { developerName: uploaderProfile.userName } : {}),
    ...(uploaderProfile?.sapId ? { developerSapId: uploaderProfile.sapId } : {}),
    ...(uploaderProfile?.orgName ? { organizationName: uploaderProfile.orgName } : {}),
    boardCompatibility: makeMissingMarketPluginCompatibility()
  }
}

function resolveHarnessMarketUploaderProfile(
  profiles: Record<string, HarnessMarketUploaderProfile>,
  userId?: string | null
): HarnessMarketUploaderProfile | null {
  const normalizedUserId = userId?.trim()
  if (!normalizedUserId) return null

  const directProfile = profiles[normalizedUserId]
  if (directProfile) return directProfile

  const candidates = buildUploaderIdCandidates(normalizedUserId)
  for (const candidate of candidates) {
    const profile = profiles[candidate]
    if (profile) return profile
  }

  return (
    Object.values(profiles).find((profile) =>
      candidates.some((candidate) => profile.sapId.includes(candidate))
    ) ?? null
  )
}

function applyMarketAdapterDisplayData(
  registry: HarnessAdapterRegistryItem[],
  marketPlugins: MarketItem[],
  installedPlugins: PluginMetadata[],
  uploaderProfiles: Record<string, HarnessMarketUploaderProfile> = {}
): HarnessAdapterRegistryItem[] {
  const marketByName = buildMarketPluginMap(marketPlugins)
  const installedByName = buildInstalledPluginMap(installedPlugins)
  const adapterNames = new Set<string>()

  const installedAdapters = registry.map((adapter) => {
    const adapterName = normalizeAdapterMarketName(adapter.name)
    if (adapterName) adapterNames.add(adapterName)
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

    const uploaderProfile = resolveHarnessMarketUploaderProfile(
      uploaderProfiles,
      marketPlugin.user_id
    )

    return {
      ...fallback,
      version: installedVersion,
      description: marketPlugin.description?.trim() || "",
      useScenario: normalizeAdapterUseScenario(marketPlugin.category),
      ...(uploaderProfile?.userName ? { developerName: uploaderProfile.userName } : {}),
      ...(uploaderProfile?.sapId ? { developerSapId: uploaderProfile.sapId } : {}),
      ...(uploaderProfile?.orgName ? { organizationName: uploaderProfile.orgName } : {})
    }
  })

  const missingMarketAdapters: HarnessAdapterRegistryItem[] = []
  for (const marketPlugin of marketPlugins) {
    if (!isProjectModeMarketPlugin(marketPlugin)) continue
    const name = normalizeAdapterMarketName(marketPlugin.name)
    if (!name || adapterNames.has(name) || installedByName.has(name)) continue
    const adapter = marketPluginToAdapter(marketPlugin, uploaderProfiles)
    if (!adapter) continue
    adapterNames.add(name)
    missingMarketAdapters.push(adapter)
  }

  return installedAdapters.concat(missingMarketAdapters)
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

async function loadHarnessMarketPluginUploaderProfiles(
  marketPlugins: MarketItem[]
): Promise<Record<string, HarnessMarketUploaderProfile>> {
  const rawUserIds = Array.from(
    new Set(marketPlugins.map((item) => item.user_id?.trim() || "").filter(Boolean))
  )
  if (rawUserIds.length === 0) return {}

  if (typeof window.api?.dashboard?.queryAllUser !== "function") return {}

  try {
    const response = await window.api.dashboard.queryAllUser()
    if (!response.success || !response.data) {
      throw new Error(response.error || "获取全量用户信息失败")
    }

    const allUsers = response.data.filter((user) => user.sapId?.trim())
    const nextMap: Record<string, HarnessMarketUploaderProfile> = {}
    for (const rawUserId of rawUserIds) {
      const lookupIds = buildUploaderIdCandidates(rawUserId)
      const target = allUsers.find((user) =>
        lookupIds.some((lookupId) => user.sapId.includes(lookupId))
      )
      if (!target) continue
      nextMap[rawUserId] = {
        sapId: target.sapId,
        userName: target.userName,
        orgName: formatTopUserOrgName(
          target.orgName || "",
          target.upperOrgLv1 || "",
          target.upperOrgLv0 || ""
        ),
        upperOrgLv0: target.upperOrgLv0,
        upperOrgLv1: target.upperOrgLv1
      }
    }
    return nextMap
  } catch (error) {
    console.warn("[HarnessBoard] Failed to load plugin uploader profiles:", error)
    return {}
  }
}

function scheduleHarnessAdapterDisplayRefresh(task: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(task, { timeout: 1000 })
    return
  }
  window.setTimeout(task, 0)
}

function groupAdaptersByUseScenario(
  registry: HarnessAdapterRegistryItem[]
): AdapterScenarioGroup[] {
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
    adapter.developerSapId,
    adapter.organizationName
  ]
    .filter(Boolean)
    .join(" ")
}

function AdapterPublisherInfo({
  adapter,
  className
}: {
  adapter: HarnessAdapterRegistryItem
  className?: string
}): React.JSX.Element | null {
  if (!adapter.developerName && !adapter.developerSapId && !adapter.organizationName) return null
  const developerLabel = [
    adapter.developerName,
    adapter.developerSapId ? `（${adapter.developerSapId}）` : ""
  ]
    .filter(Boolean)
    .join("")

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 text-xs font-normal leading-5 text-muted-foreground",
        className
      )}
    >
      {developerLabel && (
        <span className="min-w-0 truncate" title={developerLabel}>
          {developerLabel}
        </span>
      )}
      {developerLabel && adapter.organizationName && (
        <span className="shrink-0 text-muted-foreground/50">/</span>
      )}
      {adapter.organizationName && (
        <span className="min-w-0 truncate" title={adapter.organizationName}>
          {adapter.organizationName}
        </span>
      )}
    </span>
  )
}

function AdapterOptionHeader({
  adapter
}: {
  adapter: HarnessAdapterRegistryItem
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{formatAdapterSelectLabel(adapter)}</span>
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

function AdapterInstallButton({
  adapter,
  installingPluginNames,
  onInstallPlugin
}: {
  adapter: HarnessAdapterRegistryItem
  installingPluginNames: Set<string>
  onInstallPlugin: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
}): React.JSX.Element {
  const installing = installingPluginNames.has(adapter.name)
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="h-7 shrink-0 gap-1.5 px-2 text-xs"
      disabled={installing}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void onInstallPlugin(adapter)
      }}
    >
      {installing ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <ShoppingBag className="size-3.5" />
      )}
      安装
    </Button>
  )
}

function AdapterSelectItem({
  adapter,
  installingPluginNames,
  onInstallPlugin
}: {
  adapter: HarnessAdapterRegistryItem
  installingPluginNames: Set<string>
  onInstallPlugin: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
}): React.JSX.Element {
  const compatibilityMessage = boardCompatibilityMessage(adapter.boardCompatibility)
  if (adapter.boardCompatibility.status === "missing-plugin") {
    return (
      <div
        key={adapter.id}
        className="flex min-w-0 items-start justify-between gap-3 rounded-sm px-2 py-2 pl-4 pr-2 text-sm"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <AdapterOptionHeader adapter={adapter} />
          <AdapterPublisherInfo adapter={adapter} />
          {adapter.description && (
            <span
              className="line-clamp-2 whitespace-normal break-words text-xs leading-5 text-muted-foreground"
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
        <AdapterInstallButton
          adapter={adapter}
          installingPluginNames={installingPluginNames}
          onInstallPlugin={onInstallPlugin}
        />
      </div>
    )
  }

  return (
    <SelectItem
      key={adapter.id}
      value={adapter.id}
      textValue={formatAdapterSelectText(adapter)}
      disabled={!adapter.boardCompatibility.compatible}
      className="group py-2 pl-4 pr-10"
    >
      <span className="flex min-w-0 max-w-[calc(var(--radix-select-trigger-width)-3rem)] flex-col gap-1">
        <AdapterOptionHeader adapter={adapter} />
        <AdapterPublisherInfo
          adapter={adapter}
          className="group-focus:text-accent-foreground group-data-[highlighted]:text-accent-foreground"
        />
        {adapter.description && (
          <span
            className="line-clamp-2 whitespace-normal break-words text-xs leading-5 text-muted-foreground group-focus:text-accent-foreground group-data-[highlighted]:text-accent-foreground"
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

function AdapterSelectGroups({
  registry,
  installingPluginNames,
  onInstallPlugin
}: {
  registry: HarnessAdapterRegistryItem[]
  installingPluginNames: Set<string>
  onInstallPlugin: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
}): React.JSX.Element {
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
              <AdapterSelectItem
                key={adapter.id}
                adapter={adapter}
                installingPluginNames={installingPluginNames}
                onInstallPlugin={onInstallPlugin}
              />
            ))}
          </SelectGroup>
          {index < groups.length - 1 && <SelectSeparator />}
        </Fragment>
      ))}
    </>
  )
}

function EnterpriseProjectSearchInput({
  value,
  searchField,
  searchLabel,
  normalizeValue,
  onValueChange,
  onSelect,
  ariaInvalid,
  portalContainer
}: {
  value: string
  searchField: "name" | "code"
  searchLabel: string
  normalizeValue?: (value: string) => string
  onValueChange: (value: string) => void
  onSelect: (project: HarnessEnterpriseProjectSearchItem) => void
  ariaInvalid?: boolean
  portalContainer?: HTMLElement | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [projects, setProjects] = useState<HarnessEnterpriseProjectSearchItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState("")
  const requestIdRef = useRef(0)
  const keyword = searchKeyword.trim()
  const shouldShowPopover =
    open &&
    (loading ||
      projects.length > 0 ||
      (keyword.length > 0 && keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS))

  const clearSearchState = useCallback(() => {
    setSearchKeyword("")
    setLoading(false)
    setProjects([])
    setHasMore(false)
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!searchKeyword || value.trim() === searchKeyword.trim()) return
    clearSearchState()
  }, [clearSearchState, searchKeyword, value])

  useEffect(() => {
    const nextRequestId = requestIdRef.current + 1
    requestIdRef.current = nextRequestId

    if (!keyword || keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS) {
      setLoading(false)
      setProjects([])
      setHasMore(false)
      return
    }

    let canceled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      window.api.harnessBoard
        .searchEnterpriseProjects({ keyword, field: searchField })
        .then((result) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setProjects(result.projects)
          setHasMore(result.hasMore)
          setOpen(result.projects.length > 0)
        })
        .catch((error) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setProjects([])
          setHasMore(false)
          setOpen(false)
          toast.error(cleanIpcError(error))
        })
        .finally(() => {
          if (!canceled && requestIdRef.current === nextRequestId) setLoading(false)
        })
    }, ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [keyword, searchField])

  const handleSelect = (project: HarnessEnterpriseProjectSearchItem): void => {
    clearSearchState()
    onSelect(project)
  }

  return (
    <Popover
      open={shouldShowPopover}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true)
          return
        }
        clearSearchState()
      }}
    >
      <PopoverAnchor asChild>
        <Input
          value={value}
          onChange={(event) => {
            const nextValue = normalizeValue
              ? normalizeValue(event.target.value)
              : event.target.value
            setSearchKeyword(nextValue)
            onValueChange(nextValue)
            setOpen(true)
          }}
          onFocus={() => {
            if (searchKeyword.trim()) setOpen(true)
          }}
          placeholder={`输入${searchLabel}搜索`}
          className={harnessProjectCreateInputClassName}
          aria-autocomplete="list"
          aria-invalid={ariaInvalid ? true : undefined}
        />
      </PopoverAnchor>
      <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
        <PopoverPrimitive.Content
          data-slot="popover-content"
          align="start"
          sideOffset={4}
          className={harnessProjectPopoverContentClassName}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="max-h-72 overflow-hidden py-1 text-sm">
            {keyword.length < ENTERPRISE_PROJECT_SEARCH_MIN_CHARS ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                继续输入{searchLabel}以搜索
              </div>
            ) : loading ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                搜索项目...
              </div>
            ) : projects.length > 0 ? (
              <>
                <div className="max-h-60 overscroll-y-contain overflow-y-auto py-1">
                  {projects.map((project) => (
                    <button
                      key={`${project.projectCode}:${project.projectName}`}
                      type="button"
                      className="group grid w-full cursor-pointer gap-1.5 px-2 py-2 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                      onClick={() => handleSelect(project)}
                    >
                      <span className="flex min-w-0 items-center gap-2 text-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                        <span className="shrink-0 font-mono">{project.projectCode || "-"}</span>
                        <span className="min-w-0 truncate">{project.projectName || "-"}</span>
                      </span>
                      <span className="truncate text-xs leading-5 text-muted-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                        项目经理：{project.pm || "-"}
                      </span>
                    </button>
                  ))}
                </div>
                {hasMore && (
                  <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                    仅显示前 15 条，请输入更精确的关键词
                  </div>
                )}
              </>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  )
}

function DeployUnitSearchInput({
  value,
  onValueChange,
  onSelect
}: {
  value: string
  onValueChange: (value: string) => void
  onSelect: (deployUnit: HarnessDeployUnitSearchItem) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [deployUnits, setDeployUnits] = useState<HarnessDeployUnitSearchItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState("")
  const requestIdRef = useRef(0)
  const keyword = searchKeyword.trim()
  const shouldShowPopover =
    open &&
    (loading ||
      deployUnits.length > 0 ||
      (keyword.length > 0 && keyword.length < DEPLOY_UNIT_SEARCH_MIN_CHARS))

  const clearSearchState = useCallback(() => {
    setSearchKeyword("")
    setLoading(false)
    setDeployUnits([])
    setHasMore(false)
    setOpen(false)
  }, [])

  useEffect(() => {
    if (!searchKeyword || value.trim() === searchKeyword.trim()) return
    clearSearchState()
  }, [clearSearchState, searchKeyword, value])

  useEffect(() => {
    const nextRequestId = requestIdRef.current + 1
    requestIdRef.current = nextRequestId

    if (!keyword || keyword.length < DEPLOY_UNIT_SEARCH_MIN_CHARS) {
      setLoading(false)
      setDeployUnits([])
      setHasMore(false)
      return
    }

    let canceled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      window.api.harnessBoard
        .searchDeployUnits({ keyword })
        .then((result) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setDeployUnits(result.deployUnits)
          setHasMore(result.hasMore)
          setOpen(result.deployUnits.length > 0)
        })
        .catch((error) => {
          if (canceled || requestIdRef.current !== nextRequestId) return
          setDeployUnits([])
          setHasMore(false)
          setOpen(false)
          toast.error(cleanIpcError(error))
        })
        .finally(() => {
          if (!canceled && requestIdRef.current === nextRequestId) setLoading(false)
        })
    }, ENTERPRISE_PROJECT_SEARCH_DEBOUNCE_MS)

    return () => {
      canceled = true
      window.clearTimeout(timer)
    }
  }, [keyword])

  const handleSelect = (deployUnit: HarnessDeployUnitSearchItem): void => {
    clearSearchState()
    onSelect(deployUnit)
  }

  return (
    <Popover
      open={shouldShowPopover}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true)
          return
        }
        clearSearchState()
      }}
    >
      <PopoverAnchor asChild>
        <Input
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value
            setSearchKeyword(nextValue)
            onValueChange(nextValue)
            setOpen(true)
          }}
          onFocus={() => {
            if (searchKeyword.trim()) setOpen(true)
          }}
          placeholder="输入发布单元 ID 搜索"
          className={harnessProjectCreateInputClassName}
          aria-autocomplete="list"
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={harnessProjectPopoverContentClassName}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="max-h-72 overflow-hidden py-1 text-sm">
          {keyword.length < DEPLOY_UNIT_SEARCH_MIN_CHARS ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              继续输入发布单元 ID 以搜索
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              搜索发布单元...
            </div>
          ) : deployUnits.length > 0 ? (
            <>
              <div className="max-h-60 overscroll-y-contain overflow-y-auto py-1">
                {deployUnits.map((deployUnit) => (
                  <button
                    key={deployUnit.deployUnit}
                    type="button"
                    className="group grid w-full cursor-pointer gap-1.5 px-2 py-2 text-left outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                    onClick={() => handleSelect(deployUnit)}
                  >
                    <span className="truncate text-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                      {deployUnit.deployUnit}
                    </span>
                    <span className="truncate text-xs leading-5 text-muted-foreground group-hover:text-accent-foreground group-focus-visible:text-accent-foreground">
                      负责人：{deployUnit.ownerName || "-"}/{deployUnit.ownerId || "-"}
                    </span>
                  </button>
                ))}
              </div>
              {hasMore && (
                <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                  仅显示前 20 条，请输入更精确的关键词
                </div>
              )}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ProjectFormDialog({
  open,
  creating,
  form,
  registry,
  installingPluginNames,
  error,
  onOpenChange,
  onChange,
  onInstallPlugin,
  onPickWorkspace,
  onPickSessionWorkspace,
  onSubmit
}: {
  open: boolean
  creating: boolean
  form: HarnessProjectCreateInput
  registry: HarnessAdapterRegistryItem[]
  installingPluginNames: Set<string>
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectCreateInput) => void
  onInstallPlugin: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
  onPickWorkspace: () => void
  onPickSessionWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const [dialogPortalContainer, setDialogPortalContainer] = useState<HTMLDivElement | null>(null)
  const projectCodeError = getHarnessNameError("项目编号", form.projectCode)
  const projectDirError = getHarnessNameError("项目文件夹", form.projectDir)
  const projectNameLengthError = getTextLengthError("项目名称", form.name, PROJECT_NAME_MAX_CHARS)
  const projectCodeLengthError = getTextLengthError(
    "项目编号",
    form.projectCode,
    PROJECT_CODE_MAX_CHARS
  )
  const projectDescriptionLengthError = getTextLengthError(
    "项目描述",
    form.description,
    PROJECT_DESCRIPTION_MAX_CHARS
  )
  const projectDirLengthError = getTextLengthError(
    "项目文件夹",
    form.projectDir,
    PROJECT_DIR_MAX_CHARS
  )
  const projectCodeValidationError = projectCodeError ?? projectCodeLengthError
  const projectDirValidationError = projectDirError ?? projectDirLengthError
  const selectedAdapter = findSelectedAdapter(registry, form.adapterId)
  const selectedAdapterMessage = boardCompatibilityMessage(selectedAdapter?.boardCompatibility)
  const projectRootPath = form.workspacePath.trim()
  const projectDir = form.projectDir.trim()
  const projectCreatePathHint =
    projectRootPath && projectDir ? `将在 ${projectRootPath} 下创建文件夹: ${projectDir}` : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={setDialogPortalContainer}
        className={cn(
          harnessDialogContentClassName,
          "top-8 grid max-h-[calc(100vh-4rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] translate-y-0 overflow-visible"
        )}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto py-1 pr-1">
          <div className="grid gap-4">
            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">选择插件</div>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <Select
                  value={form.adapterId}
                  onValueChange={(adapterId) =>
                    onChange({ ...form, adapterId, adapterType: "plugin" })
                  }
                >
                  <SelectTrigger className={harnessProjectCreateSelectClassName}>
                    <AdapterSelectedValue adapter={selectedAdapter} />
                  </SelectTrigger>
                  <SelectContent className={harnessDialogSelectContentClassName}>
                    <AdapterSelectGroups
                      registry={registry}
                      installingPluginNames={installingPluginNames}
                      onInstallPlugin={onInstallPlugin}
                    />
                  </SelectContent>
                </Select>
                {selectedAdapterMessage && (
                  <span className="text-status-warning">{selectedAdapterMessage}</span>
                )}
              </label>
            </section>

            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">项目信息</div>
              <div className="grid grid-cols-2 items-start gap-3">
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目编号 *
                  <EnterpriseProjectSearchInput
                    value={form.projectCode}
                    searchField="code"
                    searchLabel="项目编号"
                    normalizeValue={sanitizeHarnessNameInput}
                    onValueChange={(projectCode) =>
                      onChange({ ...form, projectCode, projectFromLean: false })
                    }
                    onSelect={(project) => {
                      const shouldSyncProjectDir =
                        !form.projectDir ||
                        form.projectDir === sanitizeProjectDirFromProjectName(form.name)
                      onChange({
                        ...form,
                        name: project.projectName,
                        projectCode: project.projectCode,
                        projectFromLean: true,
                        systemId: project.systemId || form.systemId,
                        systemName: project.systemName || form.systemName,
                        projectDir: shouldSyncProjectDir
                          ? sanitizeProjectDirFromProjectName(project.projectName)
                          : form.projectDir
                      })
                    }}
                    portalContainer={dialogPortalContainer}
                    ariaInvalid={projectCodeValidationError ? true : undefined}
                  />
                  {projectCodeValidationError && (
                    <span className="text-status-critical">{projectCodeValidationError}</span>
                  )}
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目名称 *
                  <EnterpriseProjectSearchInput
                    value={form.name}
                    searchField="name"
                    searchLabel="项目名称"
                    onValueChange={(name) => {
                      const shouldSyncProjectDir =
                        !form.projectDir ||
                        form.projectDir === sanitizeProjectDirFromProjectName(form.name)
                      onChange({
                        ...form,
                        name,
                        projectFromLean: false,
                        projectDir: shouldSyncProjectDir
                          ? sanitizeProjectDirFromProjectName(name)
                          : form.projectDir
                      })
                    }}
                    onSelect={(project) => {
                      const shouldSyncProjectDir =
                        !form.projectDir ||
                        form.projectDir === sanitizeProjectDirFromProjectName(form.name)
                      onChange({
                        ...form,
                        name: project.projectName,
                        projectCode: project.projectCode,
                        projectFromLean: true,
                        systemId: project.systemId || form.systemId,
                        systemName: project.systemName || form.systemName,
                        projectDir: shouldSyncProjectDir
                          ? sanitizeProjectDirFromProjectName(project.projectName)
                          : form.projectDir
                      })
                    }}
                    portalContainer={dialogPortalContainer}
                    ariaInvalid={projectNameLengthError ? true : undefined}
                  />
                  {projectNameLengthError && (
                    <span className="text-status-critical">{projectNameLengthError}</span>
                  )}
                </label>
                <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目描述 *
                  <Input
                    value={form.description}
                    onChange={(event) => onChange({ ...form, description: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                    aria-invalid={projectDescriptionLengthError ? true : undefined}
                  />
                  {projectDescriptionLengthError && (
                    <span className="text-status-critical">{projectDescriptionLengthError}</span>
                  )}
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
                    onChange={(event) => onChange({ ...form, systemId: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  系统名称 *
                  <Input
                    value={form.systemName}
                    onChange={(event) => onChange({ ...form, systemName: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                  />
                </label>
              </div>
            </section>

            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">工作区配置</div>
              <div className="grid gap-3">
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
                    <span className="flex items-center gap-1.5">
                      <span>项目文件夹 *</span>
                      <ProjectDirTip />
                    </span>
                    <Input
                      value={form.projectDir}
                      onChange={(event) =>
                        onChange({
                          ...form,
                          projectDir: sanitizeHarnessNameInput(event.target.value)
                        })
                      }
                      placeholder="请输入"
                      className={harnessProjectCreateInputClassName}
                      aria-invalid={projectDirValidationError ? true : undefined}
                    />
                    {projectDirValidationError && (
                      <span className="text-status-critical">{projectDirValidationError}</span>
                    )}
                  </label>
                </div>
                <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>会话工作区路径</span>
                    <SessionWorkspacePathTip />
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <Input
                      value={form.sessionWorkspacePath ?? ""}
                      readOnly
                      placeholder="未配置"
                      className={harnessProjectCreateInputClassName}
                    />
                    {(form.sessionWorkspacePath ?? "").trim() && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="shrink-0 gap-2"
                        onClick={() => onChange({ ...form, sessionWorkspacePath: "" })}
                      >
                        <Trash2 className="size-4" />
                        清空
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 gap-2"
                      onClick={onPickSessionWorkspace}
                    >
                      <FolderOpen className="size-4" />
                      选择
                    </Button>
                  </div>
                </div>
              </div>
              {projectCreatePathHint && (
                <div
                  className="mt-3 max-w-full break-all text-xs leading-relaxed text-muted-foreground"
                  title={projectCreatePathHint}
                >
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
              metadataLengthInvalid(form, { validateProjectDir: true }) ||
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
  installingPluginNames,
  error,
  onOpenChange,
  onChange,
  onInstallPlugin,
  onPickSessionWorkspace,
  onSubmit
}: {
  open: boolean
  saving: boolean
  form: HarnessProjectMetadataUpdateInput
  registry: HarnessAdapterRegistryItem[]
  installingPluginNames: Set<string>
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectMetadataUpdateInput) => void
  onInstallPlugin: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
  onPickSessionWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const [dialogPortalContainer, setDialogPortalContainer] = useState<HTMLDivElement | null>(null)
  const projectCodeError = getHarnessNameError("项目编号", form.projectCode)
  const projectDirError = getHarnessNameError("项目文件夹", form.projectDir)
  const projectNameLengthError = getTextLengthError("项目名称", form.name, PROJECT_NAME_MAX_CHARS)
  const projectCodeLengthError = getTextLengthError(
    "项目编号",
    form.projectCode,
    PROJECT_CODE_MAX_CHARS
  )
  const projectDescriptionLengthError = getTextLengthError(
    "项目描述",
    form.description,
    PROJECT_DESCRIPTION_MAX_CHARS
  )
  const projectCodeValidationError = projectCodeError ?? projectCodeLengthError
  const selectedAdapter = findSelectedAdapter(registry, form.adapterId)
  const selectedAdapterMessage = boardCompatibilityMessage(selectedAdapter?.boardCompatibility)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={setDialogPortalContainer}
        className={cn(
          harnessDialogContentClassName,
          "top-8 grid max-h-[calc(100vh-4rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] translate-y-0 overflow-visible"
        )}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto py-1 pr-1">
          <div className="grid gap-4">
            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">选择插件</div>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                <Select
                  value={form.adapterId}
                  onValueChange={(adapterId) =>
                    onChange({ ...form, adapterId, adapterType: "plugin" })
                  }
                >
                  <SelectTrigger className={harnessProjectCreateSelectClassName}>
                    <AdapterSelectedValue adapter={selectedAdapter} />
                  </SelectTrigger>
                  <SelectContent className={harnessDialogSelectContentClassName}>
                    <AdapterSelectGroups
                      registry={registry}
                      installingPluginNames={installingPluginNames}
                      onInstallPlugin={onInstallPlugin}
                    />
                  </SelectContent>
                </Select>
                {selectedAdapterMessage && (
                  <span className="text-status-warning">{selectedAdapterMessage}</span>
                )}
              </label>
            </section>

            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">项目信息</div>
              <div className="grid grid-cols-2 items-start gap-3">
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目编号 *
                  <EnterpriseProjectSearchInput
                    value={form.projectCode}
                    searchField="code"
                    searchLabel="项目编号"
                    normalizeValue={sanitizeHarnessNameInput}
                    onValueChange={(projectCode) =>
                      onChange({ ...form, projectCode, projectFromLean: false })
                    }
                    onSelect={(project) =>
                      onChange({
                        ...form,
                        name: project.projectName,
                        projectCode: project.projectCode,
                        projectFromLean: true,
                        systemId: project.systemId || form.systemId,
                        systemName: project.systemName || form.systemName
                      })
                    }
                    portalContainer={dialogPortalContainer}
                    ariaInvalid={projectCodeValidationError ? true : undefined}
                  />
                  {projectCodeValidationError && (
                    <span className="text-status-critical">{projectCodeValidationError}</span>
                  )}
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目名称 *
                  <EnterpriseProjectSearchInput
                    value={form.name}
                    searchField="name"
                    searchLabel="项目名称"
                    onValueChange={(name) => onChange({ ...form, name, projectFromLean: false })}
                    onSelect={(project) =>
                      onChange({
                        ...form,
                        name: project.projectName,
                        projectCode: project.projectCode,
                        projectFromLean: true,
                        systemId: project.systemId || form.systemId,
                        systemName: project.systemName || form.systemName
                      })
                    }
                    portalContainer={dialogPortalContainer}
                    ariaInvalid={projectNameLengthError ? true : undefined}
                  />
                  {projectNameLengthError && (
                    <span className="text-status-critical">{projectNameLengthError}</span>
                  )}
                </label>
                <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                  项目描述 *
                  <Input
                    value={form.description}
                    onChange={(event) => onChange({ ...form, description: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                    aria-invalid={projectDescriptionLengthError ? true : undefined}
                  />
                  {projectDescriptionLengthError && (
                    <span className="text-status-critical">{projectDescriptionLengthError}</span>
                  )}
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
                    onChange={(event) => onChange({ ...form, systemId: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  系统名称 *
                  <Input
                    value={form.systemName}
                    onChange={(event) => onChange({ ...form, systemName: event.target.value })}
                    placeholder="请输入"
                    className={harnessProjectCreateInputClassName}
                  />
                </label>
              </div>
            </section>

            <section className="rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-3 text-sm font-semibold">工作区配置</div>
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <span>项目根路径 *</span>
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
                      <ProjectDirTip />
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
                    {projectDirError && (
                      <span className="text-status-critical">{projectDirError}</span>
                    )}
                  </div>
                </div>
                <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>会话工作区路径</span>
                    <SessionWorkspacePathTip />
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <Input
                      value={form.sessionWorkspacePath ?? ""}
                      readOnly
                      placeholder="未配置"
                      className={harnessProjectCreateInputClassName}
                    />
                    {(form.sessionWorkspacePath ?? "").trim() && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="shrink-0 gap-2"
                        onClick={() => onChange({ ...form, sessionWorkspacePath: "" })}
                      >
                        <Trash2 className="size-4" />
                        清空
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 gap-2"
                      onClick={onPickSessionWorkspace}
                    >
                      <FolderOpen className="size-4" />
                      选择
                    </Button>
                  </div>
                </div>
              </div>
            </section>

            {error && (
              <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
                {error}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              saving ||
              metadataRequiredMissing(form) ||
              metadataNameInvalid(form) ||
              metadataLengthInvalid(form)
            }
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

interface DynamicWorkflowNodeGroup {
  key: string
  label: string
  nodes: HarnessDynamicWorkflowNode[]
}

function defaultWorkflowTemplateId(config: HarnessDynamicWorkflowConfig | null): string {
  return config?.templates[0]?.id ?? ""
}

function isCustomWorkflowTemplate(
  template: HarnessDynamicWorkflowTemplate | null | undefined
): boolean {
  return template?.templateType === CUSTOM_WORKFLOW_TEMPLATE_ID
}

function selectedWorkflowTemplate(
  config: HarnessDynamicWorkflowConfig | null,
  templateId: string
): HarnessDynamicWorkflowTemplate | null {
  return config?.templates.find((template) => template.id === templateId) ?? null
}

function requiredWorkflowNodeIds(
  config: HarnessDynamicWorkflowConfig | null,
  templateId: string
): Set<string> {
  const template = selectedWorkflowTemplate(config, templateId)
  return new Set(template && isCustomWorkflowTemplate(template) ? template.requiredNodes : [])
}

function ensureRequiredWorkflowNodes(
  selectedNodeIds: Set<string>,
  config: HarnessDynamicWorkflowConfig | null,
  templateId: string
): Set<string> {
  const requiredNodeIds = requiredWorkflowNodeIds(config, templateId)
  if (requiredNodeIds.size === 0) return selectedNodeIds

  const next = new Set(selectedNodeIds)
  for (const nodeId of requiredNodeIds) next.add(nodeId)
  return next
}

function orderedSelectedWorkflowNodeIds(
  config: HarnessDynamicWorkflowConfig | null,
  selectedNodeIds: Set<string>
): string[] {
  return config?.nodes.filter((node) => selectedNodeIds.has(node.id)).map((node) => node.id) ?? []
}

function groupDynamicWorkflowNodes(
  nodes: HarnessDynamicWorkflowNode[]
): DynamicWorkflowNodeGroup[] {
  const groups: DynamicWorkflowNodeGroup[] = []
  const groupsByKey = new Map<string, DynamicWorkflowNodeGroup>()
  const ungroupedNodes: HarnessDynamicWorkflowNode[] = []

  for (const node of nodes) {
    const label = node.group?.trim()
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
  if (groups.length === 0 && ungroupedNodes.length > 0) {
    groups.push({ key: "all", label: "节点", nodes: ungroupedNodes })
  }

  return groups
}

function WorkflowTemplateCard({
  template,
  selected,
  onSelect
}: {
  template: HarnessDynamicWorkflowTemplate
  selected: boolean
  onSelect: (templateId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex min-h-[56px] w-full cursor-pointer items-center rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5 text-foreground shadow-sm"
          : "border-border bg-background hover:border-primary/40 hover:bg-muted/30"
      )}
      onClick={() => onSelect(template.id)}
    >
      <span className="flex w-full min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold">{template.label}</span>
        <CheckCircle2
          className={cn(
            "mt-0.5 size-4 shrink-0",
            selected ? "text-primary" : "text-muted-foreground/30"
          )}
        />
      </span>
    </button>
  )
}

function WorkflowNodeSelector({
  config,
  title,
  readOnly,
  requiredNodeIds,
  selectedNodeIds,
  onToggleNode
}: {
  config: HarnessDynamicWorkflowConfig
  title: string
  readOnly: boolean
  requiredNodeIds: Set<string>
  selectedNodeIds: Set<string>
  onToggleNode: (nodeId: string, checked: boolean) => void
}): React.JSX.Element {
  const selectedCount = orderedSelectedWorkflowNodeIds(config, selectedNodeIds).length

  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {selectedCount}/{config.nodes.length}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2">
        {groupDynamicWorkflowNodes(config.nodes).map((group) => (
          <div key={group.key} className="space-y-1.5 py-1.5">
            <div className="text-[11px] font-semibold text-muted-foreground/80">{group.label}</div>
            <div className="grid gap-1">
              {group.nodes.map((node) => {
                const checked = selectedNodeIds.has(node.id)
                const required = requiredNodeIds.has(node.id)
                return (
                  <label
                    key={node.id}
                    className={cn(
                      "flex min-w-0 items-start gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                      readOnly || required
                        ? "text-muted-foreground"
                        : "cursor-pointer hover:bg-muted/60"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={readOnly || required}
                      className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
                      onChange={(event) => onToggleNode(node.id, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-foreground">{node.label}</span>
                        {required && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">必选</span>
                        )}
                      </span>
                      {node.description && (
                        <span className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-xs leading-5 text-muted-foreground">
                          {node.description}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
        {config.nodes.length === 0 && (
          <div className="py-5 text-center text-sm text-muted-foreground">暂无可选节点</div>
        )}
      </div>
    </div>
  )
}

function FeatureCreateTabTrigger({
  value,
  disabled,
  tooltip,
  children
}: {
  value: string
  disabled: boolean
  tooltip?: string
  children: ReactNode
}): React.JSX.Element {
  const trigger = (
    <TabsTrigger value={value} disabled={disabled} className="w-full min-w-0 text-xs sm:text-sm">
      <span className="truncate">{children}</span>
    </TabsTrigger>
  )

  if (!disabled || !tooltip) return trigger

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex w-full min-w-0 cursor-not-allowed">{trigger}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="z-[70] max-w-72">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

function FeatureCreateDialog({
  mode,
  project,
  featureName,
  workflowConfig,
  workflowLoading,
  workflowTemplate,
  selectedWorkflowNodeIds,
  agentsReadyDeployUnits,
  localAgentmdDeployUnitMappings,
  publicConstraintsSyncAvailable,
  syncingPublicConstraints,
  deployUnitMappings,
  deployUnitMappingsLoading,
  selectedDeployUnitIds,
  creating,
  error,
  onOpenChange,
  onChange,
  onWorkflowTemplateChange,
  onWorkflowNodeToggle,
  onDeployUnitToggle,
  onOpenDeployUnitSettings,
  onSyncPublicConstraints,
  onSubmit
}: {
  mode: "create" | "edit"
  project: HarnessProjectListItem | null
  featureName: string
  workflowConfig: HarnessDynamicWorkflowConfig | null
  workflowLoading: boolean
  workflowTemplate: string
  selectedWorkflowNodeIds: Set<string>
  agentsReadyDeployUnits: string[]
  localAgentmdDeployUnitMappings: string[]
  publicConstraintsSyncAvailable: boolean
  syncingPublicConstraints: boolean
  deployUnitMappings: HarnessDeployUnitMapping[]
  deployUnitMappingsLoading: boolean
  selectedDeployUnitIds: Set<string>
  creating: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (featureName: string) => void
  onWorkflowTemplateChange: (templateId: string) => void
  onWorkflowNodeToggle: (nodeId: string, checked: boolean) => void
  onDeployUnitToggle: (deployUnitIdMapping: string, checked: boolean) => void
  onOpenDeployUnitSettings: () => void
  onSyncPublicConstraints: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const editing = mode === "edit"
  const featureNameError = getHarnessNameError("特性名称", featureName)
  const selectedTemplate = selectedWorkflowTemplate(workflowConfig, workflowTemplate)
  const customWorkflowSelected = isCustomWorkflowTemplate(selectedTemplate)
  const customRequiredNodeIds = requiredWorkflowNodeIds(workflowConfig, workflowTemplate)
  const selectedTemplateNodeIds = new Set(selectedTemplate?.nodes ?? [])
  const agentsReadyDeployUnitIds = new Set(agentsReadyDeployUnits)
  const localAgentmdDeployUnitMappingIds = new Set(localAgentmdDeployUnitMappings)
  const supportsSessionContextInjection = project?.supportsSessionContextInjection === true
  const selectableDeployUnitMappings = deployUnitMappings.filter((mapping) =>
    mapping.deployUnitIdMapping.trim()
  )
  const selectedDeployUnitCount = selectableDeployUnitMappings.filter((mapping) =>
    selectedDeployUnitIds.has(mapping.deployUnitIdMapping)
  ).length
  const sessionContextProviderName =
    project?.harnessAdapter.name.trim() || project?.harnessAdapter.id.trim() || "插件"
  const sessionContextStatusText = supportsSessionContextInjection
    ? `由 ${sessionContextProviderName} 加载会话工作区及所选发布单元的系统约束`
    : "由 CMBDevClaw 加载会话工作区及所选发布单元的系统约束"
  const workflowTabDisabled = editing || (!workflowLoading && !workflowConfig)
  const defaultTab = "deploy-units"
  const workflowPanel = workflowLoading ? (
    <div className="flex min-h-32 items-center justify-center rounded-md border border-border bg-background text-sm text-muted-foreground">
      <Loader2 className="mr-2 size-4 animate-spin" />
      加载工作流
    </div>
  ) : workflowConfig ? (
    <section className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="选择要使用的工作流">
        {workflowConfig.templates.map((template) => (
          <WorkflowTemplateCard
            key={template.id}
            template={template}
            selected={template.id === workflowTemplate}
            onSelect={onWorkflowTemplateChange}
          />
        ))}
      </div>
      {selectedTemplate && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
          {selectedTemplate.description || "插件未提供流程说明。"}
        </div>
      )}
      {selectedTemplate && (
        <WorkflowNodeSelector
          config={workflowConfig}
          title={customWorkflowSelected ? "节点选择（自定义）" : "包含节点"}
          readOnly={!customWorkflowSelected}
          requiredNodeIds={customWorkflowSelected ? customRequiredNodeIds : new Set()}
          selectedNodeIds={
            customWorkflowSelected ? selectedWorkflowNodeIds : selectedTemplateNodeIds
          }
          onToggleNode={onWorkflowNodeToggle}
        />
      )}
    </section>
  ) : (
    <div className="rounded-md border border-dashed border-border bg-background px-3 py-4 text-sm text-muted-foreground">
      插件暂不支持动态工作流。
    </div>
  )
  const deployUnitPanel = (
    <section className="grid gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto min-w-0 px-0 py-0 text-xs"
            disabled={creating}
            onClick={onOpenDeployUnitSettings}
          >
            需要配置发布单元？
          </Button>
          {publicConstraintsSyncAvailable && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-w-0 px-0 py-0 text-xs"
              disabled={syncingPublicConstraints || creating}
              onClick={onSyncPublicConstraints}
            >
              {syncingPublicConstraints && <Loader2 className="mr-1 size-3 animate-spin" />}
              拉取最新公共系统约束
            </Button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="text-xs text-muted-foreground">已选择 {selectedDeployUnitCount} 个</div>
        </div>
      </div>
      {deployUnitMappingsLoading ? (
        <div className="flex min-h-20 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载发布单元
        </div>
      ) : selectableDeployUnitMappings.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-background px-3 py-4 text-sm text-muted-foreground">
          没有已配置的发布单元
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
          {selectableDeployUnitMappings.map((mapping) => {
            const checked = selectedDeployUnitIds.has(mapping.deployUnitIdMapping)
            const publicAgentmdSupported = agentsReadyDeployUnitIds.has(mapping.deployUnitId.trim())
            const localAgentmdSupported = localAgentmdDeployUnitMappingIds.has(
              mapping.deployUnitIdMapping
            )
            const showPublicAgentmdTag = supportsSessionContextInjection && publicAgentmdSupported
            const showLocalAgentmdTag =
              localAgentmdSupported && (!supportsSessionContextInjection || !publicAgentmdSupported)
            return (
              <label
                key={mapping.deployUnitIdMapping}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded-sm border border-transparent px-2 py-1.5 text-sm transition-colors hover:bg-muted/60"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={(event) =>
                    onDeployUnitToggle(mapping.deployUnitIdMapping, event.target.checked)
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {mapping.deployUnitId}
                    </span>
                    {showPublicAgentmdTag && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-status-nominal/30 bg-status-nominal/10 px-1.5 py-0.5 text-[11px] font-medium text-status-nominal">
                            <CheckCircle2 className="size-3" />
                            公共系统约束
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="z-[70] max-w-72">
                          由插件加载该发布单元的公共系统约束
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {showLocalAgentmdTag && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-300">
                            <CheckCircle2 className="size-3" />
                            本地系统约束
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="z-[70] max-w-72">
                          {supportsSessionContextInjection
                            ? "由插件加载该路径下的 AGENTS.md"
                            : "由 CMBDevClaw 加载该路径下的 AGENTS.md"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {mapping.localRepoPath}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      )}
      <div className="text-xs text-muted-foreground">{sessionContextStatusText}</div>
    </section>
  )

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          harnessDialogContentClassName,
          "max-h-[calc(100vh-2rem)] w-[min(42rem,calc(100vw-2rem))] max-w-2xl overflow-x-hidden overflow-y-auto"
        )}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>{editing ? "编辑绑定的发布单元" : "创建特性"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid min-w-0 gap-4 py-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (syncingPublicConstraints) return
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
              autoFocus={!editing}
              disabled={creating || editing}
              aria-invalid={featureNameError ? true : undefined}
            />
            {featureNameError && <span className="text-status-critical">{featureNameError}</span>}
          </label>
          <TooltipProvider delayDuration={150}>
            <Tabs
              key={`${project?.projectId ?? "none"}-${defaultTab}-${workflowTabDisabled ? "workflow-disabled" : "workflow-enabled"}`}
              defaultValue={defaultTab}
              className="grid gap-3"
            >
              <TabsList className="grid w-full grid-cols-2">
                <FeatureCreateTabTrigger
                  value="deploy-units"
                  disabled={false}
                  tooltip="插件暂不支持"
                >
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span className="truncate">选择要开发的发布单元</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          aria-label="发布单元说明"
                          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Info className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="z-[70] max-w-72 text-xs leading-5">
                        选择后将会在上下文注入选中的发布单元约束，并将对应代码库路径提供给大模型
                      </TooltipContent>
                    </Tooltip>
                  </span>
                </FeatureCreateTabTrigger>
                <FeatureCreateTabTrigger
                  value="workflow"
                  disabled={workflowTabDisabled}
                  tooltip={editing ? "工作流创建后不可修改" : "插件暂不支持"}
                >
                  选择要使用的工作流
                </FeatureCreateTabTrigger>
              </TabsList>
              <TabsContent value="deploy-units" className="mt-0">
                {deployUnitPanel}
              </TabsContent>
              <TabsContent value="workflow" className="mt-0">
                {workflowPanel}
              </TabsContent>
            </Tabs>
          </TooltipProvider>
          {error && (
            <div className="min-w-0 max-w-full whitespace-pre-wrap rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical [overflow-wrap:anywhere]">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                creating ||
                syncingPublicConstraints ||
                (!editing && workflowLoading) ||
                !featureName.trim() ||
                featureNameError !== null
              }
              className="gap-2"
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                <Pencil className="size-4" />
              ) : (
                <Plus className="size-4" />
              )}
              {editing ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProjectModeSettingsPanel({
  mappings,
  loading,
  saving,
  dirty,
  error,
  leanToken,
  leanTokenLoading,
  leanTokenSaving,
  leanTokenDirty,
  leanTokenError,
  onAdd,
  onRemove,
  onChange,
  onPickPath,
  onSave,
  onLeanTokenChange,
  onSaveLeanToken,
  onOpenLeanToken
}: {
  mappings: HarnessDeployUnitMapping[]
  loading: boolean
  saving: boolean
  dirty: boolean
  error: string | null
  leanToken: string
  leanTokenLoading: boolean
  leanTokenSaving: boolean
  leanTokenDirty: boolean
  leanTokenError: string | null
  onAdd: () => void
  onRemove: (index: number) => void
  onChange: (index: number, mapping: HarnessDeployUnitMapping) => void
  onPickPath: (index: number) => void
  onSave: () => void
  onLeanTokenChange: (value: string) => void
  onSaveLeanToken: () => void
  onOpenLeanToken: () => void
}): React.JSX.Element {
  const [replacingLeanToken, setReplacingLeanToken] = useState(false)
  const wasLeanTokenDirtyRef = useRef(leanTokenDirty)
  const hasStoredLeanToken = leanToken.length > 0
  const showStoredLeanTokenMask = hasStoredLeanToken && !leanTokenDirty && !replacingLeanToken
  const leanTokenInputValue = showStoredLeanTokenMask
    ? maskLeanToken(leanToken)
    : replacingLeanToken && !leanTokenDirty
      ? ""
      : leanToken

  useEffect(() => {
    if (wasLeanTokenDirtyRef.current && !leanTokenDirty) {
      setReplacingLeanToken(false)
    }
    wasLeanTokenDirtyRef.current = leanTokenDirty
  }, [leanTokenDirty])

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border bg-background shadow-sm">
        <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">本地工程配置</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              配置本地工程路径以及对应的发布单元。该配置用于 1.注入公共系统约束
              2.便捷选择代码工作路径
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={onSave}
              disabled={loading || saving || !dirty}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              保存
            </Button>
          </div>
        </div>

        <div className="space-y-4 p-4">
          {error && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中
            </div>
          ) : mappings.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-10 text-center">
              <div className="text-sm font-medium text-foreground">暂无发布单元映射</div>
              <div className="mt-1 text-xs text-muted-foreground">
                添加后即可在项目模式中选择对应代码库。
              </div>
              <Button type="button" variant="secondary" className="mt-4 gap-2" onClick={onAdd}>
                <Plus className="size-4" />
                添加发布单元
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[minmax(150px,0.8fr)_minmax(180px,1fr)_minmax(220px,1.2fr)_132px_40px] gap-2 px-1 text-xs font-medium text-muted-foreground">
                <div className="flex min-w-0 items-center gap-1">
                  <span>发布单元</span>
                  <ReleaseUnitIdTip />
                </div>
                <div>描述</div>
                <div>本机代码库路径</div>
                <div />
              </div>
              {mappings.map((mapping, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(150px,0.8fr)_minmax(180px,1fr)_minmax(220px,1.2fr)_132px_40px] items-center gap-2"
                >
                  <DeployUnitSearchInput
                    value={mapping.deployUnitId}
                    onValueChange={(deployUnitId) => onChange(index, { ...mapping, deployUnitId })}
                    onSelect={(deployUnit) =>
                      onChange(index, {
                        ...mapping,
                        deployUnitId: deployUnit.deployUnit,
                        description: deployUnit.deployUnitName
                      })
                    }
                  />
                  <Input
                    value={mapping.description || ""}
                    onChange={(event) =>
                      onChange(index, { ...mapping, description: event.target.value })
                    }
                    placeholder="请输入描述（选填）"
                    className={harnessProjectCreateInputClassName}
                  />
                  <Input
                    value={mapping.localRepoPath}
                    readOnly
                    placeholder="请选择本机代码库路径"
                    className={harnessProjectCreateInputClassName}
                    title={mapping.localRepoPath}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="gap-2"
                    onClick={() => onPickPath(index)}
                  >
                    <FolderOpen className="size-4" />
                    选择路径
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemove(index)}
                    title="删除映射"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" className="gap-2" onClick={onAdd}>
                <Plus className="size-4" />
                添加发布单元
              </Button>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-md border border-border bg-background shadow-sm">
        <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">精益平台 token 配置</h2>
            <div className="mt-1 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">用于查询精益平台相关接口</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto shrink-0 px-0 py-0 text-xs"
                onClick={onOpenLeanToken}
              >
                获取精益平台 token
              </Button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={onSaveLeanToken}
              disabled={leanTokenLoading || leanTokenSaving || !leanTokenDirty}
            >
              {leanTokenSaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              保存
            </Button>
          </div>
        </div>
        <div className="space-y-4 p-4">
          {leanTokenError && (
            <div className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
              {leanTokenError}
            </div>
          )}
          {leanTokenLoading ? (
            <div className="flex min-h-[92px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中
            </div>
          ) : (
            <label className="block space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={leanTokenInputValue}
                  readOnly={showStoredLeanTokenMask}
                  onChange={(event) => onLeanTokenChange(event.target.value)}
                  placeholder="请输入 sk-ai-xFu...."
                  className={harnessProjectCreateInputClassName}
                />
                {showStoredLeanTokenMask && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => setReplacingLeanToken(true)}
                  >
                    重新输入
                  </Button>
                )}
                {replacingLeanToken && !leanTokenDirty && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => setReplacingLeanToken(false)}
                  >
                    取消
                  </Button>
                )}
              </div>
            </label>
          )}
        </div>
      </section>
    </div>
  )
}

function ProjectActionConfirmDialog({
  action,
  busy,
  onOpenChange,
  onConfirm
}: {
  action: PendingProjectAction
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const projectName = action?.project.name ?? ""
  const isDelete = action?.type === "delete"
  const title = isDelete ? "删除项目" : "归档项目"
  const description = isDelete
    ? `永久删除项目「${projectName}」，会保留项目文件夹。`
    : `归档项目「${projectName}」？`

  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(harnessDialogContentClassName, "max-w-md")}
        onPointerDownOutside={preventHarnessDialogOutsideClose}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            variant={isDelete ? "destructive" : "warning"}
            onClick={onConfirm}
            disabled={busy}
            className="gap-2"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : isDelete ? (
              <Trash2 className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            {busy ? "处理中" : title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProjectActionMenu({
  project,
  archiving,
  deleting,
  onEdit,
  onArchive,
  onDelete
}: {
  project: HarnessProjectListItem
  archiving: boolean
  deleting: boolean
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}): React.JSX.Element {
  const archived = project.lifecycle.status === "archived"
  const busy = archiving || deleting
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
            archived || busy
              ? "cursor-not-allowed text-muted-foreground opacity-60"
              : "text-status-critical hover:bg-status-critical/10"
          )}
          disabled={archived || busy}
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
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            busy
              ? "cursor-not-allowed text-muted-foreground opacity-60"
              : "text-status-critical hover:bg-status-critical/10"
          )}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            setOpen(false)
            onDelete()
          }}
        >
          {deleting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4 text-muted-foreground" />
          )}
          删除项目
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
  const progressIndex = progressIndexFromCurrentNodeId(
    workflowNodes,
    run.currentNodeId,
    run.currentNodeStatus
  )
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
        <span className="truncate">
          {currentNodeLabel} · {nodeStatusLabel}
        </span>
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
    <div className="flex min-w-0 items-center">
      {children}
      <span className="text-xs mx-1 text-gray-500 max-w-[100px] truncate">
        / {project.projectCode}
      </span>
      {project.projectFromLean && (
        <span className="shrink-0 rounded border border-border bg-blue-200/50 px-1.5 py-0.5 text-[10px] text-blue-600">
          精益之星
        </span>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  detail,
  loading,
  archiving,
  deleting,
  pluginUpdateInfo,
  updatingPlugin,
  onEditProject,
  onArchiveProject,
  onDeleteProject,
  onUpdatePlugin,
  onProjectVisible,
  onOpenProject
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  loading: boolean
  archiving: boolean
  deleting: boolean
  pluginUpdateInfo?: MarketPluginUpdateInfo | null
  updatingPlugin: boolean
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onDeleteProject: (project: HarnessProjectListItem) => void
  onUpdatePlugin: (project: HarnessProjectListItem, updateInfo: MarketPluginUpdateInfo) => void
  onProjectVisible: (project: HarnessProjectListItem) => void
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLElement | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project
  const projectCode = project.projectCode.trim()
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"
  const detailError = detail?.error?.trim()
  const pluginCompatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
  const pluginCompatibilityStatus = boardCompatibilityStatus(project.boardCompatibility)
  const archivedStatus: HarnessStatus = { label: "已归档", uiKind: "archived" }
  const projectRootPath = resolveProjectRootPath(project)

  useEffect(() => {
    if (archived || !projectCode) return
    const element = cardRef.current
    if (!element) return

    if (typeof IntersectionObserver === "undefined") {
      onProjectVisible(projectRef.current)
      return
    }

    let visible = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (visible || !entries.some((entry) => entry.isIntersecting)) return
        visible = true
        onProjectVisible(projectRef.current)
        observer.disconnect()
      },
      { root: null, rootMargin: "0px", threshold: 0.01 }
    )
    observer.observe(element)

    return () => observer.disconnect()
  }, [archived, onProjectVisible, projectCode])

  const doneCount = runs.filter(
    (run) => run.overallStatus.uiKind === "done" || run.overallStatus.uiKind === "ok"
  ).length
  const riskCount = runs.filter(
    (run) =>
      run.overallStatus.uiKind === "warning" ||
      run.overallStatus.uiKind === "blocked" ||
      run.overallStatus.uiKind === "error"
  ).length
  const projectStatus = pluginCompatibilityMessage
    ? pluginCompatibilityStatus
    : detail?.projectState

  return (
    <article
      ref={cardRef}
      role="button"
      tabIndex={0}
      className={cn(
        "mt-2 group relative w-[360px] flex-none cursor-pointer overflow-hidden rounded-xl border border-border/80 bg-background-elevated/90 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_18px_45px_rgb(41_37_36/0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        archived && "bg-muted/45 opacity-85"
      )}
      onClick={() => onOpenProject(project.projectId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpenProject(project.projectId)
        }
      }}
    >
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-x-0 top-0 h-1",
          archived
            ? "bg-muted-foreground/45"
            : riskCount > 0 || pluginCompatibilityMessage
              ? "bg-status-warning"
              : activeCount > 0
                ? "bg-status-info"
                : "bg-status-nominal"
        )}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-14 -top-16 size-36 rounded-full bg-primary/10 opacity-0 blur-3xl transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="relative p-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="flex">
            <div className="min-w-0">
              <ProjectBadgeRow project={project}>
                <h2 className="truncate text-[15px] font-semibold max-w-[150px]">{project.name}</h2>
              </ProjectBadgeRow>
              <div className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                {project.description}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ProjectActionMenu
              project={project}
              archiving={archiving}
              deleting={deleting}
              onEdit={() => onEditProject(project)}
              onArchive={() => onArchiveProject(project)}
              onDelete={() => onDeleteProject(project)}
            />
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-border/70 bg-muted/25 p-2.5">
          {archived ? (
            <div className="flex min-h-[48px] flex-wrap items-center gap-1.5">
              {pluginCompatibilityMessage && (
                <StatusPill
                  status={pluginCompatibilityStatus}
                  tooltip={pluginCompatibilityMessage}
                />
              )}
              <StatusPill status={archivedStatus} />
            </div>
          ) : pluginCompatibilityMessage ? (
            <div className="flex min-h-[48px] items-center">
              <StatusPill status={pluginCompatibilityStatus} tooltip={pluginCompatibilityMessage} />
            </div>
          ) : detailError && detail?.projectState ? (
            <div className="flex min-h-[48px] items-center">
              <StatusPill status={detail.projectState} tooltip={detailError} />
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5">
              <div className="min-w-0 text-[11px] text-muted-foreground">
                特性
                <strong className="mt-0.5 block text-sm text-foreground">
                  {loading || !detail ? "-" : runs.length}
                </strong>
              </div>
              <div className="min-w-0 text-[11px] text-muted-foreground">
                进行中
                <strong className="mt-0.5 block text-sm text-status-info">
                  {loading || !detail ? "-" : activeCount}
                </strong>
              </div>
              <div className="min-w-0 text-[11px] text-muted-foreground">
                完成
                <strong className="mt-0.5 block text-sm text-status-nominal">
                  {loading || !detail ? "-" : doneCount}
                </strong>
              </div>
              <div className="min-w-0 text-[11px] text-muted-foreground">
                风险
                <strong className="mt-0.5 block text-sm text-status-warning">
                  {loading || !detail ? "-" : riskCount}
                </strong>
              </div>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-1">
            <FolderOpen className="size-3 shrink-0" />
            <span className="truncate" title={projectRootPath}>
              {getWorkspaceName(projectRootPath)}
            </span>
            {/*<span*/}
            {/*  className="max-w-28 truncate rounded-full border border-border/80 bg-muted/70 px-2.5 py-1 text-[11px] text-muted-foreground"*/}
            {/*  title={project.harnessAdapter.name}*/}
            {/*>*/}
            {/*  {project.harnessAdapter.name}*/}
            {/*</span>*/}
          </div>
          {pluginUpdateInfo ? (
            <ProjectPluginUpdateButton
              pluginUpdateInfo={pluginUpdateInfo}
              updatingPlugin={updatingPlugin}
              onClick={() => onUpdatePlugin(project, pluginUpdateInfo)}
            />
          ) : projectStatus ? (
            isAdapterLoadedStatus(projectStatus) ? (
              <AdapterLoadedTag status={projectStatus} />
            ) : (
              <StatusPill
                status={projectStatus}
                tooltip={detail?.error ?? pluginCompatibilityMessage}
              />
            )
          ) : null}
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
  deletingProjectId,
  pluginUpdateInfoByProjectId,
  updatingPluginNames,
  onEditProject,
  onArchiveProject,
  onDeleteProject,
  onUpdateProjectPlugin,
  onProjectVisible,
  onOpenProject
}: {
  group: SystemGroup
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
  loadingDetailIds: Set<string>
  archivingProjectId: string | null
  deletingProjectId: string | null
  pluginUpdateInfoByProjectId: Map<string, MarketPluginUpdateInfo>
  updatingPluginNames: Set<string>
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onDeleteProject: (project: HarnessProjectListItem) => void
  onUpdateProjectPlugin: (
    project: HarnessProjectListItem,
    updateInfo: MarketPluginUpdateInfo
  ) => void
  onProjectVisible: (project: HarnessProjectListItem) => void
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const featureCount = group.projects.reduce(
    (count, project) => count + (detailsByProjectId[project.projectId]?.runs.length ?? 0),
    0
  )
  const activeFeatureCount = group.projects.reduce(
    (count, project) =>
      count +
      (detailsByProjectId[project.projectId]?.runs.filter(
        (run) => run.overallStatus.uiKind === "active"
      ).length ?? 0),
    0
  )
  const riskFeatureCount = group.projects.reduce(
    (count, project) =>
      count +
      (detailsByProjectId[project.projectId]?.runs.filter(
        (run) =>
          run.overallStatus.uiKind === "warning" ||
          run.overallStatus.uiKind === "blocked" ||
          run.overallStatus.uiKind === "error"
      ).length ?? 0),
    0
  )

  return (
    <section className={cn(harnessSurfaceClassName, "space-y-4 overflow-hidden p-4")}>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className={"flex space-x-2 items-center"}>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight">
              {group.systemCode}
            </h2>
            <div className="mt-1 truncate text-sm text-muted-foreground">{group.systemName}</div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border border-border/80 bg-background/70 px-3 py-1">
            {group.projects.length} 个项目
          </span>
          <span className="rounded-full border border-border/80 bg-background/70 px-3 py-1">
            {featureCount} 个特性
          </span>
          <span className="rounded-full border border-status-info/25 bg-status-info/10 px-3 py-1 text-status-info">
            {activeFeatureCount} 进行中
          </span>
          {riskFeatureCount > 0 && (
            <span className="rounded-full border border-status-warning/30 bg-status-warning/10 px-3 py-1 text-status-warning">
              {riskFeatureCount} 需关注
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 rounded-full border border-border/80 bg-background/70 px-2.5 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {expanded ? "收起" : "展开"}
          </Button>
        </div>
      </div>
      <div className={cn("-mx-2 pb-1", expanded ? "overflow-visible" : "overflow-x-auto")}>
        <div className={cn("flex gap-4 px-2 pb-1", expanded ? "w-full flex-wrap" : "w-max")}>
          {group.projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              detail={detailsByProjectId[project.projectId]}
              loading={loadingDetailIds.has(project.projectId)}
              archiving={archivingProjectId === project.projectId}
              deleting={deletingProjectId === project.projectId}
              pluginUpdateInfo={pluginUpdateInfoByProjectId.get(project.projectId)}
              updatingPlugin={updatingPluginNames.has(project.harnessAdapter.name)}
              onEditProject={onEditProject}
              onArchiveProject={onArchiveProject}
              onDeleteProject={onDeleteProject}
              onUpdatePlugin={onUpdateProjectPlugin}
              onProjectVisible={onProjectVisible}
              onOpenProject={onOpenProject}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function ArchivedProjectsTable({
  projects,
  detailsByProjectId,
  onOpenProject
}: {
  projects: HarnessProjectListItem[]
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const archivedStatus: HarnessStatus = { label: "已归档", uiKind: "archived" }

  if (projects.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
        暂无归档项目。
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 ">
      <div className="max-h-[476px] overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <tr className="border-b border-border/70 text-left text-[11px] text-muted-foreground">
              <th className="px-3 py-2 font-medium w-[24%]">项目</th>
              <th className="px-3 py-2 font-medium w-[14%]">项目编号</th>
              <th className="px-3 py-2 font-medium w-[24%]">所属系统</th>
              <th className="px-3 py-2 font-medium w-[18%]">工作区</th>
              <th className="px-3 py-2 font-medium w-[10%]">特性</th>
              <th className="px-3 py-2 font-medium w-[10%]">状态</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const detail = detailsByProjectId[project.projectId]
              const projectRootPath = resolveProjectRootPath(project)

              return (
                <tr
                  key={project.projectId}
                  role="button"
                  tabIndex={0}
                  className="h-11 cursor-pointer border-b border-border/60 text-foreground transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none last:border-b-0"
                  onClick={() => onOpenProject(project.projectId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onOpenProject(project.projectId)
                    }
                  }}
                >
                  <td className="px-3 py-0 align-middle">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">{project.name}</span>
                      {project.projectFromLean && (
                        <span className="shrink-0 rounded border border-border bg-blue-200/50 px-1.5 py-0.5 text-[10px] text-blue-600">
                          精益之星
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-0 align-middle text-muted-foreground">
                    <span className="block truncate" title={project.projectCode}>
                      {project.projectCode || "-"}
                    </span>
                  </td>
                  <td className="px-3 py-0 align-middle text-muted-foreground">
                    <span
                      className="block truncate"
                      title={`${project.systemId} ${project.systemName}`}
                    >
                      {project.systemId || "-"} / {project.systemName || "-"}
                    </span>
                  </td>
                  <td className="px-3 py-0 align-middle text-muted-foreground">
                    <span className="block truncate" title={projectRootPath}>
                      {getWorkspaceName(projectRootPath)}
                    </span>
                  </td>
                  <td className="px-3 py-0 align-middle text-muted-foreground">
                    {detail ? detail.runs.length : "-"}
                  </td>
                  <td className="px-3 py-0 align-middle">
                    <StatusPill status={archivedStatus} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
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
        const error =
          "error" in result && typeof result.error === "string" ? result.error : "无法打开产物位置"
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
        <div className="truncate font-medium" title={artifact.artifactLabel}>
          {artifact.artifactLabel}
        </div>
      </div>
      <StatusPill status={artifact.status} />
      <div className="min-w-0 text-xs leading-5 text-muted-foreground">
        <div className="truncate" title={artifactSummary}>
          {artifactSummary}
        </div>
        {artifact.validation && (
          <div className="truncate" title={artifact.validation.message}>
            {artifact.validation.message}
          </div>
        )}
      </div>
      <div className="col-span-3 min-w-0 rounded border border-border/70 bg-muted/30 px-2 py-1.5">
        {displayPaths.length > 0 ? (
          displayPaths.map((p) => {
            const canOpen = artifactCanOpenInFileManager(
              p,
              artifact.artifactType,
              artifact.status,
              artifact.exists
            )
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
            <div className="truncate font-medium" title={hook.eventId}>
              {hook.eventId}
            </div>
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
                <span key={item} className="truncate font-mono text-[11px]" title={item}>
                  {item}
                </span>
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
    <section className={cn(harnessSurfaceClassName, "shrink-0 overflow-hidden")}>
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">阶段产物</div>
          </div>
        </div>
        <span className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
          {node.artifacts.length}
        </span>
      </div>
      {node.artifacts.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground">
          当前阶段暂无产物。
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
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
  chatSurface = "harness-project",
  readOnlyReason,
  hasPendingGitDiffNotice,
  onHarnessSessionCreated,
  onRequestOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange
}: {
  threadId: string | null
  chatSurface?: "harness-project" | "harness-feature-session"
  readOnlyReason?: string | null
  hasPendingGitDiffNotice?: boolean
  onHarnessSessionCreated?: (threadId: string) => void
  onRequestOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-background w-full">
      {threadId ? (
        <div className="flex min-h-0 flex-1 w-full">
          <TabbedPanel
            threadId={threadId}
            showTabBar={false}
            hasPendingGitDiffNotice={hasPendingGitDiffNotice}
            chatSurface={chatSurface}
            hideWelcomeSkillTabs
            readOnlyReason={readOnlyReason}
            onRequestOpenGitPanel={onRequestOpenGitPanel}
            onDismissGitChangeNotice={onDismissGitChangeNotice}
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

function FeatureDeployUnitsPanel({
  deployUnits
}: {
  deployUnits: HarnessDeployUnitMapping[]
}): React.JSX.Element {
  return (
    <section className={cn(harnessSurfaceClassName, "overflow-hidden bg-white")}>
      <div className="flex min-w-0 items-center gap-2 border-b border-border/70 px-4 py-3 text-sm font-semibold">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">当前特性绑定的发布单元</span>
      </div>
      {deployUnits?.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">当前特性没有绑定发布单元。</div>
      ) : (
        <div className="divide-y divide-border/70">
          {deployUnits?.map((deployUnit) => (
            <div key={deployUnit.deployUnitIdMapping} className="px-4 py-3">
              <div className="truncate text-sm font-medium" title={deployUnit.deployUnitId}>
                {deployUnit.deployUnitId}
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={deployUnit.localRepoPath}
                >
                  {deployUnit.localRepoPath}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0"
                  title="打开代码库路径"
                  onClick={() =>
                    void openPathInFileManager(deployUnit.localRepoPath, "无法打开代码库路径")
                  }
                >
                  <FolderOpen className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
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
  const refreshRequestIdsRef = useRef(new Map<string, number>())

  const refreshGroup = useCallback(async (group: WorkspaceChangeGroup): Promise<void> => {
    const requestId = (refreshRequestIdsRef.current.get(group.key) ?? 0) + 1
    refreshRequestIdsRef.current.set(group.key, requestId)
    const isLatestRequest = (): boolean => refreshRequestIdsRef.current.get(group.key) === requestId

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
      const state: GitChangedFilesSummaryState =
        await window.api.workspace.getGitChangedFilesSummary(group.representativeThreadId)
      if (!isLatestRequest()) return
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
      if (!isLatestRequest()) return
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
    <section className={cn(harnessSurfaceClassName, "overflow-hidden")}>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Git 变更</span>
        </div>
        {groups.length > 0 && (
          <span className="shrink-0 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
            {visibleChangedFiles} files
          </span>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          当前特性还没有关联会话，暂无代码变更。
        </div>
      ) : groups.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">暂无可展示的代码变更。</div>
      ) : (
        <div className="divide-y divide-border/70">
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
                    onClick={() =>
                      void openPathInFileManager(group.workspacePath, "无法打开会话路径")
                    }
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
                        <span className="truncate" title={file.path}>
                          {file.path}
                        </span>
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

const PROJECT_REVIEW_HEADERS: Array<[keyof HarnessProjectReviewItem, string]> = [
  ["title", "标题"],
  ["type", "类型"],
  ["start_time", "开始时间"],
  ["end_time", "结束时间"],
  ["creator", "发起人"],
  ["members", "参与成员"]
]

function buildLeanstarProjectReviewUrl(projectCode: string): string {
  return (import.meta.env.VITE_LEANSTAR_PROJECT_REVIEW_URL_TEMPLATE?.trim() || "").replace(
    "{projectCode}",
    encodeURIComponent(projectCode)
  )
}

function ProjectReviewCard({ review }: { review: HarnessProjectReviewItem }): React.JSX.Element {
  return (
    <article className="min-w-0 rounded-lg border border-border/70 bg-muted/[0.18] px-3 py-2.5">
      <div className="border-b border-border/70 pb-2">
        <div className="flex items-center gap-2 justify-between">
          <div className="line-clamp-2 text-sm font-semibold leading-5 text-foreground flex-1">
            {review.title || "-"}
          </div>
          <CircleCheckBig className="size-4 shrink-0 text-green-500" />
        </div>
      </div>
      <dl className="grid gap-1.5 pt-2 text-xs leading-5">
        {PROJECT_REVIEW_HEADERS.filter(([key]) => key !== "title").map(([key, label]) => (
          <div key={key} className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 whitespace-normal break-words font-medium text-foreground [overflow-wrap:anywhere]">
              {review[key] || "-"}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

function ProjectReviewSummary({
  projectCode,
  reviewState,
  onOpenLeanTokenSettings
}: {
  projectCode: string
  reviewState: ProjectReviewState
  onOpenLeanTokenSettings: () => void
}): React.JSX.Element {
  const normalizedProjectCode = normalizeEnterpriseProjectCode(projectCode)
  const openReviewPage = useCallback((): void => {
    void window.electron
      .openExternal(buildLeanstarProjectReviewUrl(normalizedProjectCode))
      .catch((error) => {
        toast.error(cleanIpcError(error))
      })
  }, [normalizedProjectCode])

  const isCurrentProject =
    reviewState.kind === "loaded" || reviewState.kind === "loading" || reviewState.kind === "error"
      ? reviewState.projectCode === normalizedProjectCode
      : false
  const result = reviewState.kind === "loaded" && isCurrentProject ? reviewState.result : null
  const reviews = result?.reviews ?? []
  const hasReviewResult = Boolean(result?.tokenConfigured)
  const metricBoxClassName = "rounded-lg border border-border/70 bg-muted/[0.18] px-3 py-2.5"

  return (
    <div className="space-y-3 text-xs mt-2">
      {hasReviewResult && (
        <div className="flex items-center">
          {reviews.length > 0 ? (
            <div className="flex items-start gap-1.5 text-status-nominal">
              <CheckCircle2 className="size-3.5 text-status-nominal" aria-label="存在评审记录" />
              <span>已有项目评审流程，请确认详设文档已存在。</span>
            </div>
          ) : (
            <div className="flex items-start gap-1.5 text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>在进入 ST 流程之前发起评审并上传文档以避免 NC</span>
            </div>
          )}
        </div>
      )}
      <section className="">
        <div className="mt-1">
          {!normalizedProjectCode ? (
            <div className={cn(metricBoxClassName, "leading-5 text-muted-foreground")}>-</div>
          ) : !isCurrentProject || reviewState.kind === "loading" ? (
            <div
              className={cn(metricBoxClassName, "flex items-center gap-1.5 text-muted-foreground")}
            >
              <Loader2 className="size-3 animate-spin" />
              查询中
            </div>
          ) : reviewState.kind === "error" ? (
            <div className={cn(metricBoxClassName, "leading-5 text-status-warning")}>
              {reviewState.message}
            </div>
          ) : result && !result.tokenConfigured ? (
            <button
              type="button"
              className={cn(
                metricBoxClassName,
                "w-full text-left font-medium text-status-warning underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
              onClick={onOpenLeanTokenSettings}
            >
              请配置精益平台 token
            </button>
          ) : reviews.length === 0 ? (
            <button
              type="button"
              className={cn(
                metricBoxClassName,
                "w-full text-left font-medium text-primary/85 underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              )}
              onClick={openReviewPage}
            >
              发起项目评审流程
            </button>
          ) : (
            <div className="space-y-2">
              {reviews.map((review, index) => (
                <ProjectReviewCard key={`${review.title}:${index}`} review={review} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function ProjectConstraintSyncPanel({
  registry,
  syncingAdapterIds,
  syncedPaths,
  expandedAdapterIds,
  knowledgePreviews,
  loadingKnowledgePreviewAdapterIds,
  selectedKnowledgePreviewPaths,
  onSync,
  onToggleKnowledgePreview,
  onRefreshKnowledgePreview,
  onSelectKnowledgePreviewPath
}: {
  registry: HarnessAdapterRegistryItem[]
  syncingAdapterIds: Set<string>
  syncedPaths: Record<string, string>
  expandedAdapterIds: Set<string>
  knowledgePreviews: Record<string, HarnessKnowledgePreviewResult>
  loadingKnowledgePreviewAdapterIds: Set<string>
  selectedKnowledgePreviewPaths: Record<string, string | null>
  onSync: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
  onToggleKnowledgePreview: (adapter: HarnessAdapterRegistryItem) => void
  onRefreshKnowledgePreview: (adapter: HarnessAdapterRegistryItem) => void | Promise<void>
  onSelectKnowledgePreviewPath: (adapter: HarnessAdapterRegistryItem, path: string | null) => void
}): React.JSX.Element {
  const adapters = registry.filter((adapter) => adapter.boardCompatibility.compatible)

  return (
    <section className="rounded-md border border-border bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">拉取公共系统约束</h2>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto min-w-0 px-0 py-0 text-xs"
          onClick={() => {
            void window.electron.openExternal("https://doc.cmbchina.com/f/v?id=zfGMOW")
          }}
        >
          知识库使用指引
        </Button>
      </div>
      <div className="space-y-3 p-4">
        {adapters.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
            暂无支持项目模式的插件。
          </div>
        ) : (
          adapters.map((adapter) => {
            const syncing = syncingAdapterIds.has(adapter.id)
            const disabled = syncing || !adapter.pullKnowledgeAvailable
            const syncedPath = syncedPaths[adapter.id]
            const expanded = expandedAdapterIds.has(adapter.id)
            return (
              <div
                key={adapter.id}
                className="min-w-0 rounded-md border border-border bg-muted/20 px-4 py-3"
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  className="flex min-w-0 cursor-pointer items-center justify-between gap-4 rounded-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onToggleKnowledgePreview(adapter)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    onToggleKnowledgePreview(adapter)
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <AdapterOptionHeader adapter={adapter} />
                      {adapter.useScenario && (
                        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {adapter.useScenario}
                        </span>
                      )}
                    </div>
                    <AdapterPublisherInfo adapter={adapter} className="mt-1" />
                    {adapter.description && (
                      <div
                        className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground"
                        title={adapter.description}
                      >
                        {adapter.description}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {syncedPath && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        title={syncedPath}
                        onClick={(event) => {
                          event.stopPropagation()
                          void openPathInFileManager(syncedPath, "无法打开项目约束目录")
                        }}
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title={expanded ? "收起知识库预览" : "展开知识库预览"}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleKnowledgePreview(adapter)
                      }}
                    >
                      {expanded ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="gap-2"
                      disabled={disabled}
                      title={
                        adapter.pullKnowledgeAvailable
                          ? "拉取最新公共系统约束"
                          : "插件未配置 pull_knowledge"
                      }
                      onClick={(event) => {
                        event.stopPropagation()
                        void onSync(adapter)
                      }}
                    >
                      {syncing ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      拉取最新约束
                    </Button>
                  </div>
                </div>
                {expanded && (
                  <KnowledgePreviewPanel
                    preview={knowledgePreviews[adapter.id] ?? null}
                    loading={loadingKnowledgePreviewAdapterIds.has(adapter.id)}
                    selectedPath={selectedKnowledgePreviewPaths[adapter.id] ?? null}
                    onSelectPath={(path) => onSelectKnowledgePreviewPath(adapter, path)}
                    onRefresh={() => onRefreshKnowledgePreview(adapter)}
                  />
                )}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

function ProjectDetailPage({
  project,
  detail,
  enterpriseProjectDetail,
  pluginUpdateInfo,
  updatingPlugin,
  projectReviewState,
  loading,
  creatingFeature,
  creatingSystemConstraintUpdate,
  leanToken,
  leanTokenLoading,
  onBackToList,
  onCreateFeature,
  onOpenSystemConstraintUpdate,
  onRefresh,
  onEditProject,
  onUpdatePlugin,
  onOpenLeanTokenSettings,
  onOpenFeature
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  enterpriseProjectDetail?: EnterpriseProjectDetailCacheEntry
  pluginUpdateInfo?: MarketPluginUpdateInfo | null
  updatingPlugin: boolean
  projectReviewState: ProjectReviewState
  loading: boolean
  creatingFeature: boolean
  creatingSystemConstraintUpdate: boolean
  leanToken: string
  leanTokenLoading: boolean
  onBackToList: () => void
  onCreateFeature: (project: HarnessProjectListItem) => void
  onOpenSystemConstraintUpdate: (
    project: HarnessProjectListItem,
    config: NonNullable<HarnessProjectDetailViewModel["systemConstraintUpdate"]>
  ) => void
  onRefresh: (projectId: string) => void
  onEditProject: (project: HarnessProjectListItem) => void
  onUpdatePlugin: (project: HarnessProjectListItem, updateInfo: MarketPluginUpdateInfo) => void
  onOpenLeanTokenSettings: () => void
  onOpenFeature: (projectId: string, slug: string) => void
}): React.JSX.Element {
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"
  const phaseSteps = buildEnterpriseProjectPhaseSteps(
    enterpriseProjectDetail?.kind === "hit" ? enterpriseProjectDetail.project.phaseStatus : ""
  )
  const pluginCompatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
  const projectStatus = detail?.projectState
  const projectRootPath = resolveProjectRootPath(project)
  const hasProjectCode = project.projectCode.trim().length > 0
  const hasLeanToken = leanToken.trim().length > 0
  const canOpenSystemConstraintUpdate = hasProjectCode && hasLeanToken && !leanTokenLoading
  const openProjectWorkspaceInFileManager = useCallback((): void => {
    void openPathInFileManager(projectRootPath, "无法打开项目工作区")
  }, [projectRootPath])

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-br from-background via-background to-muted/70">
      <div className={cn(harnessPageHeaderClassName, "mb-0")}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="min-w-0 space-y-2">
            <HarnessBreadcrumb
              project={project}
              onBack={onBackToList}
              onProjectList={onBackToList}
            />
          </div>
          <div className={cn(harnessPageHeaderActionsClassName, "mt-0")}>
            {detail?.systemConstraintUpdate && (
              <TooltipProvider delayDuration={80}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={harnessDetailSecondaryButtonClassName}
                        onClick={() => {
                          if (detail.systemConstraintUpdate && canOpenSystemConstraintUpdate) {
                            onOpenSystemConstraintUpdate(project, detail.systemConstraintUpdate)
                          }
                        }}
                        disabled={creatingSystemConstraintUpdate || !canOpenSystemConstraintUpdate}
                      >
                        {creatingSystemConstraintUpdate ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCcw className="size-4" />
                        )}
                        知识库沉淀
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {!hasProjectCode
                      ? "请先编辑项目信息，填写项目编号"
                      : !hasLeanToken
                        ? "请先配置精益平台token"
                        : leanTokenLoading
                          ? "正在加载配置..."
                          : "沉淀本项目的变更，更新知识库"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <Button
              variant="ghost"
              size="sm"
              className={harnessDetailSecondaryButtonClassName}
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
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
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

      <div className="min-h-0 flex-1 overflow-hidden">
        <main className="flex h-full min-h-0 w-full flex-col gap-4 p-2">
          {pluginCompatibilityMessage && (
            <div className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning/10 px-4 py-3 text-sm text-status-warning shadow-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <div>{pluginCompatibilityMessage}</div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full min-h-0 flex-col gap-2">
              <section className={cn(harnessSurfaceClassName, "overflow-hidden p-3")}>
                <div className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-status-info/20 bg-status-info/10 text-status-info">
                    <Workflow className="size-4" />
                  </div>
                  <h2
                    className="max-w-56 shrink-0 truncate text-sm font-semibold"
                    title={project.name}
                  >
                    {project.name}
                  </h2>
                  {pluginUpdateInfo ? (
                    <ProjectPluginUpdateButton
                      pluginUpdateInfo={pluginUpdateInfo}
                      updatingPlugin={updatingPlugin}
                      onClick={() => onUpdatePlugin(project, pluginUpdateInfo)}
                    />
                  ) : projectStatus ? (
                    isAdapterLoadedStatus(projectStatus) ? (
                      <AdapterLoadedTag status={projectStatus} />
                    ) : (
                      <StatusPill
                        status={projectStatus}
                        tooltip={detail?.error ?? pluginCompatibilityMessage}
                      />
                    )
                  ) : (
                    <span className="shrink-0 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                      {loading ? "同步中" : "暂无状态"}
                    </span>
                  )}
                  <span className="shrink-0 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                    系统编号{" "}
                    <strong className="font-medium text-foreground">
                      {project.systemId || "-"}
                    </strong>
                  </span>
                  <span
                    className="shrink-0 max-w-48 truncate rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground"
                    title={project.systemName}
                  >
                    系统名称{" "}
                    <strong className="font-medium text-foreground">
                      {project.systemName || "-"}
                    </strong>
                  </span>
                  <span
                    className="shrink-0 max-w-52 truncate rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground"
                    title={projectRootPath}
                  >
                    工作区{" "}
                    <strong className="font-medium text-foreground">
                      {getWorkspaceName(projectRootPath)}
                    </strong>
                  </span>
                  <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[11px] text-muted-foreground">
                    特性{" "}
                    <strong className="font-medium text-foreground">
                      {loading || !detail ? "-" : runs.length}
                    </strong>
                  </span>
                  <span className="shrink-0 rounded-full border border-border/70 bg-muted/35 px-2 py-0.5 text-[11px] text-muted-foreground">
                    进行中{" "}
                    <strong className="font-medium text-foreground">
                      {loading || !detail ? "-" : activeCount}
                    </strong>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto size-7 shrink-0"
                    title="打开项目工作区"
                    aria-label="打开项目工作区"
                    onClick={openProjectWorkspaceInFileManager}
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>
              </section>
              <HarnessProjectPhaseFlow steps={phaseSteps} />

              <div className="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row  mb-1">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col ">
                  <div className=" flex min-h-0 flex-1 flex-col rounded-2xl border border-border/80  p-4 shadow-sm bg-background-elevated/80 ">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="mt-1 text-base font-semibold">特性列表</div>
                      </div>
                      <div className="rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                        {loading || !detail ? "读取中" : `${runs.length} 个特性`}
                      </div>
                    </div>
                    {loading || !detail ? (
                      <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border/80 text-sm text-muted-foreground">
                        <Loader2 className="mr-2 size-4 animate-spin text-status-info" />
                        读取项目详情
                      </div>
                    ) : detail.error ? (
                      <div className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning/10 px-3 py-3 text-sm text-status-warning">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        <div>{detail.error}</div>
                      </div>
                    ) : runs.length === 0 ? (
                      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border/80 bg-gradient-to-br from-background via-background/95 to-muted/35 px-6 py-12 text-center shadow-sm">
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full bg-status-info/10 blur-2xl"
                        />
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute -bottom-12 left-8 size-32 rounded-full bg-primary/10 blur-3xl"
                        />
                        <div className="relative flex max-w-md flex-col items-center">
                          <div className="flex size-14 items-center justify-center rounded-2xl border border-status-info/20 bg-status-info/10 text-status-info shadow-sm">
                            <Workflow className="size-6" />
                          </div>
                          <div className="mt-4 text-base font-semibold text-foreground">
                            当前项目还没有特性
                          </div>
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            从一个清晰的 feature
                            开始拆解工作，创建后就可以在这里持续跟踪阶段、产物和协作会话。
                          </p>
                          {!archived && (
                            <Button
                              type="button"
                              size="sm"
                              className={cn("mt-5 gap-2", harnessActionButtonClassName)}
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
                    ) : (
                      <ScrollArea className="min-h-0 flex-1">
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 pr-2">
                          {runs.map((run) => (
                            <FeatureCard
                              key={run.slug}
                              run={run}
                              workflowNodes={workflowForProjectRun(detail, run).nodes}
                              onOpen={() => onOpenFeature(project.projectId, run.slug)}
                            />
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                </div>
                <aside className="w-full shrink-0 xl:w-[360px]">
                  <HarnessProjectStageStatusPanel
                    projectCode={project.projectCode}
                    reviewState={projectReviewState}
                    onOpenLeanTokenSettings={onOpenLeanTokenSettings}
                  />
                </aside>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function ProjectSessionPage({
  project,
  thread,
  deleted,
  onBackToList,
  onBackToProject,
  hasPendingGitDiffNotice,
  onRequestOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange
}: {
  project: ProjectFeatureSidebarProject
  thread: Thread | null
  deleted?: boolean
  onBackToList: () => void
  onBackToProject: () => void
  hasPendingGitDiffNotice?: boolean
  onRequestOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
}): React.JSX.Element {
  const title = thread ? getThreadTitle(thread) : "项目会话"
  const readOnlyReason = deleted ? "所属项目已删除，当前会话只读。" : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={harnessPageHeaderClassName}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="min-w-0 space-y-2">
            <HarnessBreadcrumb
              project={project as HarnessProjectListItem}
              sessionTitle={title}
              onBack={onBackToProject}
              onProjectList={onBackToList}
              onProject={deleted ? undefined : onBackToProject}
            />
            <div className="flex min-w-0 items-center gap-2">
              <Workflow className="size-4 shrink-0 text-status-info" />
              <h1 className="truncate text-base font-semibold">{title}</h1>
            </div>
            <div className="truncate text-xs text-muted-foreground">{project.name}</div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden p-6">
        <FeatureConversationPanel
          threadId={thread?.thread_id ?? null}
          chatSurface="harness-feature-session"
          readOnlyReason={readOnlyReason}
          hasPendingGitDiffNotice={hasPendingGitDiffNotice}
          onRequestOpenGitPanel={onRequestOpenGitPanel}
          onDismissGitChangeNotice={onDismissGitChangeNotice}
          onThreadGitStatusChange={onThreadGitStatusChange}
        />
      </div>
    </div>
  )
}

function RemoteFeatureAccessPanel({
  projectId,
  featureSlug,
  onOpenThread
}: {
  projectId: string
  featureSlug: string
  onOpenThread: (threadId: string) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<BuiltinRobotStatus | null>(null)
  const [remoteAccess, setRemoteAccess] = useState<BuiltinRobotRemoteAccessOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const threads = useAppStore((state) => state.threads)

  useEffect(() => {
    let active = true
    const refreshRemoteAccess = (): void => {
      void window.api.builtinRobot
        .getRemoteAccess()
        .then((next) => {
          if (active) setRemoteAccess(next)
        })
        .catch(() => {
          if (active) setRemoteAccess(null)
        })
    }
    void Promise.all([
      window.api.builtinRobot.getStatus(),
      window.api.builtinRobot.getRemoteAccess()
    ])
      .then(([nextStatus, nextAccess]) => {
        if (!active) return
        setStatus(nextStatus)
        setRemoteAccess(nextAccess)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.builtinRobot.onStatus((next) => {
      if (!active) return
      setStatus(next)
      refreshRemoteAccess()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const featureGrant = remoteAccess?.featureGrants.find(
    (grant) => grant.projectId === projectId && grant.featureSlug === featureSlug
  )
  const enabled = featureGrant?.state === "active"
  const routeAvailable = remoteAccess?.routeAvailable === true
  const relatedSessions =
    remoteAccess?.threadGrants.filter((grant) => {
      if (grant.state !== "active") return false
      const thread = threads.find((candidate) => candidate.thread_id === grant.threadId)
      const harnessFeature = thread?.metadata?.harnessFeature
      if (!harnessFeature || typeof harnessFeature !== "object" || Array.isArray(harnessFeature)) {
        return false
      }
      const binding = harnessFeature as Record<string, unknown>
      return binding.projectId === projectId && binding.slug === featureSlug
    }) ?? []
  const availabilityText = !status
    ? "正在读取远程访问状态…"
    : !status.settings.enabled
      ? "内置统一机器人未启用"
      : !routeAvailable
        ? (remoteAccess?.routeReason ?? "招乎连接尚未就绪")
        : enabled
          ? "已允许从招乎在此 Feature 下新建会话"
          : "尚未开放从招乎新建会话"

  const toggleFeatureCreation = async (nextEnabled: boolean): Promise<void> => {
    if (busy || (!nextEnabled && !enabled) || (nextEnabled && !routeAvailable)) return
    setBusy(true)
    try {
      const next = await window.api.builtinRobot.setFeatureRemoteAccess(
        projectId,
        featureSlug,
        nextEnabled
      )
      setRemoteAccess(next)
      toast.success(
        nextEnabled ? "已允许从招乎在此 Feature 下新建会话" : "已关闭此 Feature 的远程新建会话权限"
      )
    } catch (error) {
      toast.error(cleanIpcError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-md border border-border bg-background">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">Feature 远程新建会话</span>
        </div>
        <Switch
          aria-label="允许从招乎在此 Feature 下新建会话"
          checked={enabled}
          disabled={busy || (!enabled && !routeAvailable)}
          onCheckedChange={(checked) => void toggleFeatureCreation(checked)}
        />
      </div>
      <div className="space-y-3 p-3">
        <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <span
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              enabled ? "bg-emerald-500" : "bg-amber-500"
            )}
          />
          <span>{availabilityText}</span>
        </div>
        {relatedSessions.length === 0 ? (
          <p className="rounded border border-dashed px-2.5 py-3 text-xs text-muted-foreground">
            当前没有已接入的会话。打开上方开关后，可在招乎通过 /会话 选择此 Feature 并新建会话。
          </p>
        ) : (
          <div className="space-y-2">
            {relatedSessions.map((grant) => (
              <div key={grant.grantId} className="rounded border px-2.5 py-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{grant.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => onOpenThread(grant.threadId)}
                  >
                    <ExternalLink className="mr-1 size-3" /> 打开会话
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] leading-4 text-muted-foreground">
          此开关只控制新建权限；关闭后，下方已经接入的会话仍由各自的会话开关管理。
        </p>
      </div>
    </section>
  )
}

function FeatureDetailPage({
  detail,
  loading,
  unbound,
  projectDeleted,
  activeSessionThreadId,
  isViewingSession,
  hasPendingGitDiffNotice,
  fallbackProjectName,
  fallbackFeatureTitle,
  onBackToList,
  onBackToProject,
  onEditDeployUnits,
  onRefresh,
  onActiveSessionChange,
  onSessionViewChange,
  onActiveSessionThreadChange,
  onRequestOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange
}: {
  detail: HarnessRunDetailViewModel | null
  loading: boolean
  unbound?: boolean
  projectDeleted?: boolean
  activeSessionThreadId?: string
  isViewingSession: boolean
  hasPendingGitDiffNotice?: boolean
  fallbackProjectName?: string
  fallbackFeatureTitle?: string
  onBackToList: () => void
  onBackToProject: () => void
  onEditDeployUnits: () => void
  onRefresh: () => void | Promise<void>
  onActiveSessionChange?: (threadId: string) => void
  onSessionViewChange?: (viewing: boolean) => void
  onActiveSessionThreadChange?: (threadId: string | null) => void
  onRequestOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
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
    detail?.run.nodes.find((node) => node.id === effectiveSelectedNodeId) ??
    detail?.run.nodes[0] ??
    null
  const completedArtifactCount =
    selectedNode?.artifacts?.filter((artifact) => artifact.artifactStatus === "generated").length ??
    0
  const selectedNodeHooks = useMemo(
    () => [...(selectedNode?.hooks ?? [])].sort((a, b) => (b.ts || "").localeCompare(a.ts || "")),
    [selectedNode]
  )
  const featureCurrentNodeStatus = detail
    ? currentNodeStatusFromNodes(detail.run.nodes, detail.run.currentNodeId)
    : "unknown"
  const featureProgressTotal = detail?.workflow.nodes.length || detail?.run.nodes.length || 0
  const featureProgressIndex = detail
    ? progressIndexFromCurrentNodeId(
        detail.workflow.nodes.length > 0 ? detail.workflow.nodes : detail.run.nodes,
        detail.run.currentNodeId,
        featureCurrentNodeStatus
      )
    : 0
  const featureProgressPercent = progressPercentFromValues(
    featureProgressIndex,
    featureProgressTotal
  )
  const featureOverallStatus = detail?.run.overallStatus ??
    selectedNode?.status ?? { label: "读取中", uiKind: "unknown" as const }
  const nodeGroups = useMemo(() => groupStageNodes(detail?.run.nodes ?? []), [detail])
  const selectedGroup =
    nodeGroups.length > 0
      ? (nodeGroups.find(
          (group) => selectedNode && group.nodes.some((node) => node.id === selectedNode.id)
        ) ??
        nodeGroups.find((group) => group.nodes.some((node) => node.id === defaultNodeId)) ??
        nodeGroups[0])
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
  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.thread_id, thread])),
    [threads]
  )
  const [sessionBusy, setSessionBusy] = useState<"create" | null>(null)
  const [skippingNodeId, setSkippingNodeId] = useState<string | null>(null)
  const [selectedSessionState, setSelectedSessionState] = useState<{
    detailKey: string
    threadId: string | null
  }>({ detailKey: "", threadId: null })
  const [activeDetailTab, setActiveDetailTab] = useState<"feature" | "session">(() =>
    isViewingSession && activeSessionThreadId ? "session" : "feature"
  )
  const projectInteractionDisabled = Boolean(unbound || projectDeleted)

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
        ? (activeSessionThreadId ?? null)
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
    void onRefresh()
  }

  const handleHookSessionSelect = useCallback(
    (threadId: string): void => {
      if (!detail || !threadId) return
      setSelectedSessionState({ detailKey, threadId })
      onActiveSessionChange?.(threadId)
      setActiveDetailTab("session")
      onSessionViewChange?.(true)
    },
    [detail, detailKey, onActiveSessionChange, onSessionViewChange]
  )

  useEffect(() => {
    if (!activeSessionThreadIdForView) return
    void selectThread(activeSessionThreadIdForView, { preserveView: true })
  }, [activeSessionThreadIdForView, selectThread])

  const handleCreateSession = useCallback(async (): Promise<void> => {
    if (!detail || sessionBusy || projectInteractionDisabled) return
    setSessionBusy("create")
    try {
      const thread = await createHarnessSession({
        projectId: detail.project.projectId,
        slug: detail.run.slug,
        sessionWorkspacePath: detail.project.sessionWorkspacePath,
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
    projectInteractionDisabled,
    sessionBusy,
    threadsById
  ])

  const handleContextReminderSessionCreated = useCallback(
    (threadId: string): void => {
      if (!threadId) return
      setSelectedSessionState({ detailKey, threadId })
      onActiveSessionChange?.(threadId)
      setActiveDetailTab("session")
      onSessionViewChange?.(true)
    },
    [detailKey, onActiveSessionChange, onSessionViewChange]
  )

  const canSkipNode = useCallback(
    (node: HarnessRunNode | null): boolean =>
      Boolean(
        detail &&
        node &&
        detail.run.skipNodeAvailable &&
        !projectInteractionDisabled &&
        node.id === detail.run.currentNodeId &&
        node.status.uiKind !== "done"
      ),
    [detail, projectInteractionDisabled]
  )

  const handleSkipNode = useCallback(
    async (node: HarnessRunNode): Promise<void> => {
      if (!detail || !canSkipNode(node) || skippingNodeId) return
      const nodeId = node.id
      setSkippingNodeId(nodeId)
      setSelectedNodeId(nodeId)
      try {
        await window.api.harnessBoard.skipNode({
          projectId: detail.project.projectId,
          slug: detail.run.slug,
          nodeId
        })
        toast.success("已跳过当前节点")
        await onRefresh()
      } catch (error) {
        toast.error(cleanIpcError(error))
      } finally {
        setSkippingNodeId(null)
      }
    },
    [canSkipNode, detail, onRefresh, skippingNodeId]
  )

  const renderStageNodeStrip = (): React.JSX.Element | null => {
    if (!detail) return null
    if (detail.run.nodes.length === 0) return null

    const renderStageNodeButton = (node: HarnessRunNode): React.JSX.Element => {
      const selected = effectiveSelectedNodeId === node.id
      const skippable = canSkipNode(node)
      const skipping = skippingNodeId === node.id
      return (
        <div
          key={node.id}
          title={node.label}
          className={cn(
            "group/node flex h-[104px] min-w-0  flex-col rounded-xl border bg-background/75  transition-all duration-200",
            selected
              ? "border-status-info/35 shadow-md ring-1 ring-status-info/10"
              : "border-border/80 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-background/85 hover:shadow-md"
          )}
        >
          <button
            type="button"
            onClick={() => {
              setSelectedNodeId(node.id)
            }}
            aria-pressed={selected}
            className={cn(
              "flex min-h-0 w-full flex-1 cursor-pointer flex-col justify-between gap-2 rounded-t-xl px-2.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <span className="flex min-w-0 items-start gap-2">
              <span className="mt-0.5 shrink-0">{statusIcon(node.status)}</span>
              <span className="min-w-0 flex-1">
                <span className="block line-clamp-2 text-[12px] font-semibold leading-[1.35]">
                  {node.label}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {node.status.label}
                </span>
              </span>
            </span>
            <div className="flex items-center justify-between">
              <span className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                <span className="rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5">
                  {node.artifacts.length} 产物
                </span>
                <span className="rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5">
                  {node.hooks.length} 事件
                </span>
              </span>
              <div
                className={cn(
                  "mt-auto flex  items-end ",
                  skippable ? "border-t border-border/60" : "border-t border-transparent"
                )}
              >
                {skippable && (
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 w-full gap-1 rounded-md border-status-info/30 bg-background/95 px-2 text-[10px] shadow-sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleSkipNode(node)
                          }}
                          disabled={skippingNodeId !== null}
                        >
                          {skipping ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <SkipForward className="size-3" />
                          )}
                          跳过当前节点
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="z-[70] max-w-72">
                        跳过当前节点，不再产生对应阶段产物
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </button>
        </div>
      )
    }

    if (nodeGroups.length > 0 && selectedGroup) {
      return (
        <div className="space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {nodeGroups.map((group) => {
              const selected = selectedGroup.key === group.key
              const currentNode =
                group.nodes.find((node) => node.id === defaultNodeId) ?? group.nodes[0]
              const groupProgress = groupProgressIndex(
                group,
                detail.workflow.nodes,
                detail.run.currentNodeId,
                featureCurrentNodeStatus
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
                    "group/stage flex min-w-0 min-h-[96px] cursor-pointer flex-col gap-2 rounded-xl border px-3 py-3 text-left  transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-status-info/60 bg-status-info/10 shadow-md"
                      : "border-border/80 bg-background/70 hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-md"
                  )}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    {currentNode ? (
                      statusIcon(currentNode.status)
                    ) : (
                      <Circle className="size-4 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">
                        {group.label}
                      </span>
                      <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                        {currentNode?.label ?? "暂无节点"}
                      </span>
                    </div>
                  </div>
                  <ProgressBar progressIndex={groupProgress} totalNodes={group.nodes.length} />
                  <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                    <span className="truncate">{group.nodes.length} 个节点</span>
                    <span className="shrink-0">
                      {groupProgress}/{group.nodes.length}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>

          <section className={cn(harnessSurfaceClassName, "p-3")}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2.5">
              <div className="min-w-0">
                <div className={harnessKickerClassName}>Selected stage</div>
                <div className="mt-1 truncate text-sm font-semibold">{selectedGroup.label}</div>
              </div>
              <div className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                {selectedGroup.nodes.length} 个节点
              </div>
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-4">
              {selectedGroup.nodes.map((node) => renderStageNodeButton(node))}
            </div>
          </section>
        </div>
      )
    }

    return (
      <div className="grid grid-cols-3 gap-4">
        {detail.run.nodes.map((node) => renderStageNodeButton(node))}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-br from-background via-background to-muted/70">
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
              onBack={
                projectDeleted
                  ? onBackToList
                  : effectiveActiveDetailTab === "session"
                    ? handleBackToFeature
                    : onBackToProject
              }
              onProjectList={onBackToList}
              onProject={projectDeleted ? undefined : onBackToProject}
              onFeature={
                projectDeleted
                  ? undefined
                  : effectiveActiveDetailTab === "session"
                    ? handleBackToFeature
                    : undefined
              }
            />
          </div>
          {effectiveActiveDetailTab === "feature" && (
            <div className={cn(harnessPageHeaderActionsClassName, "pt-0")}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(harnessDetailSecondaryButtonClassName, "w-[176px]")}
                onClick={onEditDeployUnits}
                disabled={loading || !detail || projectInteractionDisabled}
              >
                <Pencil className="size-4" />
                编辑绑定的发布单元
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={harnessDetailRefreshButtonClassName}
                onClick={onRefresh}
                disabled={loading || !detail || projectInteractionDisabled}
              >
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                刷新
              </Button>
              <Button
                type="button"
                size="sm"
                className={cn(harnessDetailPrimaryButtonClassName, harnessActionButtonClassName)}
                onClick={() => void handleCreateSession()}
                disabled={loading || !detail || projectInteractionDisabled || sessionBusy !== null}
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
        <div className="flex min-h-0 flex-1 flex-col pt-3">
          <FeatureConversationPanel
            threadId={activeSessionThreadIdForView}
            readOnlyReason={projectDeleted ? "项目已删除，仅可查看历史会话" : null}
            hasPendingGitDiffNotice={hasPendingGitDiffNotice}
            onHarnessSessionCreated={handleContextReminderSessionCreated}
            onRequestOpenGitPanel={onRequestOpenGitPanel}
            onDismissGitChangeNotice={onDismissGitChangeNotice}
            onThreadGitStatusChange={onThreadGitStatusChange}
          />
        </div>
      ) : projectDeleted ? (
        <div className="flex w-full flex-1 items-center justify-center p-6">
          <div
            className={cn(
              harnessSurfaceClassName,
              "relative max-w-lg overflow-hidden px-7 py-8 text-center"
            )}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-14 -top-20 h-40 rounded-full bg-status-critical/10 blur-3xl"
            />
            <div className="relative mx-auto flex size-12 items-center justify-center rounded-2xl border border-status-critical/20 bg-status-critical/10 text-status-critical shadow-sm">
              <Archive className="size-5" />
            </div>
            <div className="relative mt-4 text-base font-semibold">项目已删除</div>
            <p className="relative mt-2 text-sm leading-6 text-muted-foreground">
              当前特性所属项目已不存在，右侧主视图不再允许发起新会话；仍可从左侧历史会话中查看已有上下文。
            </p>
          </div>
        </div>
      ) : loading || !detail ? (
        <div className="flex w-full flex-1 items-center justify-center p-6">
          <div
            className={cn(
              harnessSurfaceClassName,
              "flex min-h-[320px] w-full items-center justify-center text-muted-foreground"
            )}
          >
            <div className="flex items-center gap-3 rounded-full border border-border/70 bg-background/70 px-4 py-2 text-sm shadow-sm">
              <Loader2 className="size-4 animate-spin text-status-info" />
              正在读取特性详情
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden p-2">
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <section
              className={cn(harnessSurfaceClassName, "isolate relative mb-4 overflow-hidden p-4")}
            >
              <video
                aria-hidden="true"
                autoPlay
                className="pointer-events-none absolute -top-8 right-0 z-0 h-auto w-[340px] max-w-[78%] object-contain opacity-40 saturate-125 motion-reduce:hidden"
                loop
                muted
                playsInline
                preload="metadata"
                src={noSignalVideoUrl}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-20 -top-24 z-[1] size-60 rounded-full bg-status-info/10 blur-3xl"
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-24 left-10 z-[1] size-52 rounded-full bg-primary/10 blur-3xl"
              />
              <div className="relative z-10 min-w-0">
                <div className="min-w-0">
                  <div className={harnessKickerClassName}>Feature cockpit</div>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold tracking-tight">
                      {detail.run.title}
                    </h2>
                    <StatusPill status={featureOverallStatus} />
                    {unbound && (
                      <span className="rounded-full border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                        未绑定会话
                      </span>
                    )}
                    {detail.adapterSnapshot.mock && (
                      <span className="rounded-full border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                        Mock
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 max-w-3xl text-xs leading-5 text-muted-foreground">
                    {detail.run.source?.label ? `${detail.run.source.label}` : ""}
                  </p>
                  <div className="mt-3 max-w-xl">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                      <span>整体进度</span>
                      <span>{featureProgressPercent}%</span>
                    </div>
                    <ProgressBar
                      progressIndex={featureProgressIndex}
                      totalNodes={featureProgressTotal}
                    />
                  </div>
                </div>
              </div>
            </section>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-3">
                <section className={cn(harnessSurfaceClassName, "space-y-3 p-3")}>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2.5">
                    <div className="min-w-0">
                      <div className={harnessKickerClassName}>Execution timeline</div>
                      <div className="mt-1 text-sm font-semibold">阶段流程</div>
                    </div>
                    <div className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                      当前：{selectedNode?.label ?? "暂无阶段"}
                    </div>
                  </div>
                  {renderStageNodeStrip()}
                </section>

                {selectedNode ? (
                  <StageArtifactPanel
                    node={selectedNode}
                    workspacePath={detail.project.projectRootPath}
                  />
                ) : (
                  <section className="rounded-xl border border-dashed border-border/80 bg-background/80 px-3 py-8 text-center text-sm text-muted-foreground shadow-sm">
                    暂无阶段数据。
                  </section>
                )}
              </div>

              <aside className="min-w-0 space-y-4">
                <RemoteFeatureAccessPanel
                  projectId={detail.project.projectId}
                  featureSlug={detail.run.slug}
                  onOpenThread={handleHookSessionSelect}
                />
                <section className={cn(harnessSurfaceClassName, "p-3")}>
                  <div className={harnessKickerClassName}>Current stage</div>
                  <div className="mt-2.5 flex min-w-0 items-start gap-2.5">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-status-info/20 bg-status-info/10">
                      {selectedNode ? (
                        statusIcon(selectedNode.status)
                      ) : (
                        <Circle className="size-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">
                        {selectedNode?.label ?? "暂无阶段"}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {selectedNode?.status.label ?? "等待阶段数据"}
                      </div>
                    </div>
                    {selectedNode && <StatusPill status={selectedNode.status} />}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                    <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
                      产物(已完成/预期)
                      <strong className="mt-0.5 block text-sm text-foreground">
                        {completedArtifactCount}/{selectedNode?.artifacts?.length ?? 0}
                      </strong>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
                      事件
                      <strong className="mt-0.5 block text-sm text-foreground">
                        {selectedNodeHooks.length}
                      </strong>
                    </div>
                  </div>
                </section>
                <FeatureDeployUnitsPanel deployUnits={detail.run.selectedDeployUnits} />
                <FeatureWorkspaceChangesPanel
                  sessions={detail.sessions}
                  threadsById={threadsById}
                />

                <section className={cn(harnessSurfaceClassName, "overflow-hidden")}>
                  <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Workflow className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-semibold">运行事件</span>
                    </div>
                    <span className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                      {selectedNodeHooks.length}
                    </span>
                  </div>
                  {selectedNode && selectedNodeHooks.length > 0 ? (
                    <div className="max-h-72 overflow-y-auto">
                      {selectedNodeHooks.map((hook, index) => (
                        <HookLine
                          key={`${hook.ts || "hook"}-${hook.eventId}-${index}`}
                          hook={hook}
                          onSelectSession={handleHookSessionSelect}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="px-3 py-7 text-sm text-muted-foreground">
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
  selectedProjectId,
  selectedFeature,
  selectedProjectSession,
  isViewingSession,
  unreadIds,
  exportingThreadId,
  editingThreadId,
  editingTitle,
  scrollTopRef,
  scrollIntentRef,
  onToggleCollapse,
  onToggleAll,
  onCreateSession,
  onSelectProjectSession,
  onSelectSession,
  onRunFinished,
  onDeleteSession,
  onExportSession,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange
}: {
  groups: ProjectSessionProjectGroup[]
  collapsedKeys: Set<string>
  allCollapsed: boolean
  creatingSessionKey: string | null
  threadsById: Map<string, Thread>
  allThreadStates: ThreadWorkspaceStateMap
  allStreamLoadingStates: Record<string, boolean>
  selectedProjectId: string | null
  selectedFeature: SelectedFeature | null
  selectedProjectSession: SelectedProjectSession | null
  isViewingSession: boolean
  unreadIds: Set<string>
  exportingThreadId: string | null
  editingThreadId: string | null
  editingTitle: string
  scrollTopRef: MutableRefObject<number>
  scrollIntentRef: MutableRefObject<ProjectSidebarScrollIntent>
  onToggleCollapse: (key: string) => void
  onToggleAll: () => void
  onCreateSession: (
    project: ProjectFeatureSidebarProject,
    slug: string,
    sessions: HarnessSessionBinding[]
  ) => void
  onSelectProjectSession: (projectId: string, threadId: string, deleted?: boolean) => void
  onSelectSession: (projectId: string, slug: string, threadId: string, deleted?: boolean) => void
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
  const scrollAreaRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollRestoreRef = useRef<number | null>(null)
  const preserveScrollUntilRef = useRef(0)
  const [sessionVisibleCounts, setSessionVisibleCounts] = useState<Record<string, number>>({})
  const sessionCount = groups.reduce(
    (total, group) =>
      total +
      group.projectSessions.length +
      group.featureGroups.reduce((count, featureGroup) => count + featureGroup.sessions.length, 0),
    0
  )

  const getSidebarViewport = useCallback((): HTMLDivElement | null => {
    return scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])

  const captureSidebarScrollTop = useCallback((): void => {
    const viewport = getSidebarViewport()
    if (!viewport) return
    scrollTopRef.current = viewport.scrollTop
    pendingScrollRestoreRef.current = viewport.scrollTop > 0 ? viewport.scrollTop : null
    scrollIntentRef.current = "preserve"
    preserveScrollUntilRef.current = window.performance.now() + 2000
  }, [getSidebarViewport, scrollIntentRef, scrollTopRef])

  useLayoutEffect(() => {
    const viewport = getSidebarViewport()
    if (!viewport) return

    const scrollIntent = scrollIntentRef.current
    if (scrollIntent === "top") {
      viewport.scrollTop = 0
      scrollTopRef.current = 0
      pendingScrollRestoreRef.current = null
      scrollIntentRef.current = null
    } else if (scrollIntent === "preserve") {
      const targetScrollTop = pendingScrollRestoreRef.current ?? scrollTopRef.current
      if (targetScrollTop > 0) {
        const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
        const nextScrollTop = Math.min(targetScrollTop, maxScrollTop)
        if (Math.abs(viewport.scrollTop - nextScrollTop) > 1) {
          viewport.scrollTop = nextScrollTop
        }
      }
      pendingScrollRestoreRef.current = null
    }

    const handleScroll = (): void => {
      const pendingScrollTop = pendingScrollRestoreRef.current
      if (pendingScrollTop && pendingScrollTop > 0 && viewport.scrollTop === 0) return
      if (
        viewport.scrollTop === 0 &&
        scrollTopRef.current > 0 &&
        window.performance.now() < preserveScrollUntilRef.current
      ) {
        return
      }
      scrollTopRef.current = viewport.scrollTop
    }

    handleScroll()
    viewport.addEventListener("scroll", handleScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", handleScroll)
  }, [
    collapsedKeys,
    getSidebarViewport,
    groups,
    isViewingSession,
    scrollIntentRef,
    scrollTopRef,
    selectedFeature?.activeSessionThreadId,
    selectedFeature?.projectId,
    selectedFeature?.slug,
    selectedProjectId,
    selectedProjectSession?.threadId
  ])

  const renderThreadItem = (
    thread: Thread,
    hoverTitle: string,
    onSelect: () => void
  ): React.JSX.Element => {
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
        hoverTitle={hoverTitle}
        onSelect={() => {
          captureSidebarScrollTop()
          onSelect()
        }}
        onRunFinished={() => onRunFinished(thread.thread_id)}
        onDelete={() => onDeleteSession(thread)}
        onExport={() => void onExportSession(thread)}
        onStartEditing={() => onStartEditing(thread)}
        onSaveTitle={onSaveTitle}
        onCancelEditing={onCancelEditing}
        onEditingTitleChange={onEditingTitleChange}
      />
    )
  }

  const getVisibleSessionCount = (key: string, sessionCount: number): number => {
    const configuredCount = sessionVisibleCounts[key]
    if (typeof configuredCount !== "number") {
      return Math.min(FEATURE_SESSION_INITIAL_VISIBLE_COUNT, sessionCount)
    }

    return Math.min(Math.max(configuredCount, FEATURE_SESSION_INITIAL_VISIBLE_COUNT), sessionCount)
  }

  const expandSessions = (key: string, sessionCount: number): void => {
    setSessionVisibleCounts((current) => {
      const currentCount = current[key] ?? FEATURE_SESSION_INITIAL_VISIBLE_COUNT
      const nextCount = Math.min(currentCount + FEATURE_SESSION_VISIBLE_INCREMENT, sessionCount)
      return { ...current, [key]: nextCount }
    })
  }

  const collapseSessions = (key: string): void => {
    setSessionVisibleCounts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const renderSessionVisibilityControls = (
    key: string,
    visibleSessionCount: number,
    sessionCount: number
  ): React.JSX.Element | null => {
    const canExpandSessions = visibleSessionCount < sessionCount
    const canCollapseSessions = visibleSessionCount > FEATURE_SESSION_INITIAL_VISIBLE_COUNT

    if (!canExpandSessions && !canCollapseSessions) return null

    return (
      <div className="flex items-center gap-4 py-1 pl-3 pr-2 text-xs font-medium text-muted-foreground">
        {canExpandSessions && (
          <button
            type="button"
            className="rounded-sm text-left text-[11px] font-semibold tracking-[0.02em] text-primary/80 underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => expandSessions(key, sessionCount)}
          >
            展开显示
          </button>
        )}
        {canCollapseSessions && (
          <button
            type="button"
            className="rounded-sm text-left text-[11px] font-semibold tracking-[0.02em] text-primary/80 underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => collapseSessions(key)}
          >
            折叠显示
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">项目会话 {sessionCount}</span>
        {groups.length > 0 && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 shrink-0 cursor-pointer"
            title={allCollapsed ? "全部展开项目会话" : "全部收起项目会话"}
            onClick={onToggleAll}
          >
            {allCollapsed ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
          </Button>
        )}
      </div>
      <ScrollArea ref={scrollAreaRef} className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-2">
          {groups.map((group, index) => {
            const projectCollapsed = collapsedKeys.has(group.key)
            const projectSelected =
              selectedProjectId === group.project.projectId &&
              !selectedFeature &&
              !selectedProjectSession
            const sectionLabel = getProjectFeatureGroupSectionLabel(
              groups[index - 1]?.section,
              group.section,
              Boolean(selectedFeature || selectedProjectSession || selectedProjectId)
            )
            const hasUnreadSession =
              group.projectSessions.some((session) => unreadIds.has(session.threadId)) ||
              group.featureGroups.some((featureGroup) =>
                featureGroup.sessions.some((session) => unreadIds.has(session.threadId))
              )
            const projectArchived = group.project.lifecycle.status === "archived"
            const projectDeleted = group.deleted === true
            const groupSessionCount =
              group.projectSessions.length +
              group.featureGroups.reduce(
                (count, featureGroup) => count + featureGroup.sessions.length,
                0
              )

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
                    projectSelected
                      ? "bg-sidebar-accent/70 text-sidebar-accent-foreground"
                      : "hover:bg-sidebar-accent/40"
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <button
                      type="button"
                      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent/50"
                      title={projectCollapsed ? "展开项目会话" : "收起项目会话"}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleCollapse(group.key)
                      }}
                    >
                      {projectCollapsed ? (
                        <ChevronRight className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </button>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <Workflow className="size-4 shrink-0 text-muted-foreground" />
                      <span
                        className="min-w-0 flex-1 truncate text-xs font-semibold"
                        title={group.project.name}
                      >
                        {group.project.name}
                      </span>
                      {projectDeleted ? (
                        <span
                          className="shrink-0 rounded-sm border border-status-critical/30 bg-status-critical/10 px-2 py-0.5 text-[11px] font-medium leading-none text-status-critical"
                          title={`所属项目「${group.project.name}」已删除`}
                        >
                          已删除
                        </span>
                      ) : (
                        projectArchived && (
                          <span
                            className="shrink-0 rounded-sm border border-status-warning/30 bg-status-warning/15 px-2 py-0.5 text-[11px] font-medium leading-none text-status-warning"
                            title={`所属项目「${group.project.name}」已归档`}
                          >
                            已归档
                          </span>
                        )
                      )}
                      {hasUnreadSession && (
                        <span className="size-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </div>
                  </div>
                  <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
                    <span className="absolute right-1 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {groupSessionCount}
                    </span>
                  </span>
                </div>

                {!projectCollapsed && (
                  <div className="ml-4 space-y-1 border-l border-border/70 pl-2">
                    {(() => {
                      const projectSessionsKey = `project-sessions:${group.key}`
                      const visibleProjectSessionCount = getVisibleSessionCount(
                        projectSessionsKey,
                        group.projectSessions.length
                      )
                      const visibleProjectSessions = group.projectSessions.slice(
                        0,
                        visibleProjectSessionCount
                      )

                      return (
                        <>
                          {visibleProjectSessions.map((session) => {
                            const thread = threadsById.get(session.threadId)
                            if (!thread) return null
                            return renderThreadItem(thread, `所属项目：${group.project.name}`, () =>
                              onSelectProjectSession(
                                group.project.projectId,
                                thread.thread_id,
                                projectDeleted
                              )
                            )
                          })}
                          {renderSessionVisibilityControls(
                            projectSessionsKey,
                            visibleProjectSessionCount,
                            group.projectSessions.length
                          )}
                        </>
                      )
                    })()}
                    {group.featureGroups.map((featureGroup) => {
                      const featureCollapsed = collapsedKeys.has(featureGroup.key)
                      const featureSelected =
                        selectedFeature?.projectId === group.project.projectId &&
                        selectedFeature.slug === featureGroup.slug
                      const creatingSession = creatingSessionKey === featureGroup.key
                      const hasUnreadFeatureSession = featureGroup.sessions.some((session) =>
                        unreadIds.has(session.threadId)
                      )
                      const visibleSessionCount = getVisibleSessionCount(
                        featureGroup.key,
                        featureGroup.sessions.length
                      )
                      const visibleSessions = featureGroup.sessions.slice(0, visibleSessionCount)

                      return (
                        <div key={featureGroup.key} className="space-y-1">
                          <div
                            className={cn(
                              "group flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left transition-colors",
                              featureSelected
                                ? "bg-sidebar-accent/70 text-sidebar-accent-foreground"
                                : "hover:bg-sidebar-accent/40"
                            )}
                          >
                            <button
                              type="button"
                              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent/50"
                              title={featureCollapsed ? "展开特性会话" : "收起特性会话"}
                              onClick={(event) => {
                                event.stopPropagation()
                                onToggleCollapse(featureGroup.key)
                              }}
                            >
                              {featureCollapsed ? (
                                <ChevronRight className="size-3.5" />
                              ) : (
                                <ChevronDown className="size-3.5" />
                              )}
                            </button>
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                            <span
                              className="min-w-0 flex-1 truncate text-xs font-medium"
                              title={featureGroup.title}
                            >
                              {featureGroup.title}
                            </span>
                            {hasUnreadFeatureSession && (
                              <span className="size-2 rounded-full bg-blue-500 shrink-0" />
                            )}
                            <span className="relative ml-auto flex h-6 w-14 shrink-0 items-center justify-end overflow-hidden">
                              <span className="absolute right-1 text-[10px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                                {featureGroup.sessions.length}
                              </span>
                              <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="size-6 shrink-0 opacity-70 hover:bg-accent/20"
                                  title={projectDeleted ? "项目已删除，无法新增会话" : "新增会话"}
                                  disabled={creatingSession || projectDeleted}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (projectDeleted) return
                                    void onCreateSession(
                                      group.project,
                                      featureGroup.slug,
                                      featureGroup.sessions
                                    )
                                  }}
                                >
                                  {creatingSession ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <Plus className="size-3" />
                                  )}
                                </Button>
                              </span>
                            </span>
                          </div>
                          {!featureCollapsed && (
                            <div className="ml-4 space-y-1 border-l border-border/70 pl-2">
                              {featureGroup.sessions.length === 0 ? (
                                <div className="px-2 py-2 text-xs text-muted-foreground">
                                  暂无关联会话
                                </div>
                              ) : (
                                <>
                                  {visibleSessions.map((session) => {
                                    const thread = threadsById.get(session.threadId)
                                    if (!thread) return null
                                    return renderThreadItem(
                                      thread,
                                      `所属项目：${group.project.name} / ${featureGroup.title}`,
                                      () =>
                                        onSelectSession(
                                          group.project.projectId,
                                          session.slug,
                                          thread.thread_id,
                                          projectDeleted
                                        )
                                    )
                                  })}
                                  {renderSessionVisibilityControls(
                                    featureGroup.key,
                                    visibleSessionCount,
                                    featureGroup.sessions.length
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          {groups.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无项目会话</div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

interface HarnessBoardViewProps {
  hasPendingGitDiffNotice?: boolean
  onRequestOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
  onActiveSessionThreadChange?: (threadId: string | null) => void
}

export function HarnessBoardView({
  hasPendingGitDiffNotice,
  onRequestOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange,
  onActiveSessionThreadChange
}: HarnessBoardViewProps = {}): React.JSX.Element {
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [detailsByProjectId, setDetailsByProjectId] = useState<
    Record<string, HarnessProjectDetailViewModel>
  >({})
  const [enterpriseProjectDetailsByCode, setEnterpriseProjectDetailsByCode] = useState<
    Record<string, EnterpriseProjectDetailCacheEntry>
  >({})
  const [projectReviewState, setProjectReviewState] = useState<ProjectReviewState>({ kind: "idle" })
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set())
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null)
  const [selectedProjectSession, setSelectedProjectSession] =
    useState<SelectedProjectSession | null>(null)
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
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction>(null)
  const [confirmingProjectAction, setConfirmingProjectAction] = useState(false)
  const [featureDialogMode, setFeatureDialogMode] = useState<"create" | "edit">("create")
  const [featureDialogProject, setFeatureDialogProject] = useState<HarnessProjectListItem | null>(
    null
  )
  const [featureName, setFeatureName] = useState("")
  const [featureError, setFeatureError] = useState<string | null>(null)
  const [featureWorkflowConfig, setFeatureWorkflowConfig] =
    useState<HarnessDynamicWorkflowConfig | null>(null)
  const [featureWorkflowLoading, setFeatureWorkflowLoading] = useState(false)
  const [knowledgeDialogOpen, setKnowledgeDialogOpen] = useState(false)
  const [knowledgeDialogProject, setKnowledgeDialogProject] =
    useState<HarnessProjectListItem | null>(null)
  const [knowledgeDialogConfig, setKnowledgeDialogConfig] = useState<NonNullable<
    HarnessProjectDetailViewModel["systemConstraintUpdate"]
  > | null>(null)

  const [featureWorkflowTemplate, setFeatureWorkflowTemplate] = useState("")
  const [selectedWorkflowNodeIds, setSelectedWorkflowNodeIds] = useState<Set<string>>(new Set())
  const [featureAgentsReadyDeployUnits, setFeatureAgentsReadyDeployUnits] = useState<string[]>([])
  const [featureLocalAgentmdDeployUnitMappings, setFeatureLocalAgentmdDeployUnitMappings] =
    useState<string[]>([])
  const [selectedDeployUnitIds, setSelectedDeployUnitIds] = useState<Set<string>>(new Set())
  const [projectModeTab, setProjectModeTab] = useState("projects")
  const [syncingProjectConstraintAdapterIds, setSyncingProjectConstraintAdapterIds] = useState<
    Set<string>
  >(new Set())
  const [syncedProjectConstraintPaths, setSyncedProjectConstraintPaths] = useState<
    Record<string, string>
  >({})
  const [expandedKnowledgePreviewAdapterIds, setExpandedKnowledgePreviewAdapterIds] = useState<
    Set<string>
  >(new Set())
  const [loadingKnowledgePreviewAdapterIds, setLoadingKnowledgePreviewAdapterIds] = useState<
    Set<string>
  >(new Set())
  const [knowledgePreviewsByAdapterId, setKnowledgePreviewsByAdapterId] = useState<
    Record<string, HarnessKnowledgePreviewResult>
  >({})
  const [selectedKnowledgePreviewPaths, setSelectedKnowledgePreviewPaths] = useState<
    Record<string, string | null>
  >({})
  const [creatingFeatureProjectId, setCreatingFeatureProjectId] = useState<string | null>(null)
  const [updatingFeatureDeployUnits, setUpdatingFeatureDeployUnits] = useState(false)
  const [updatingPluginNames, setUpdatingPluginNames] = useState<Set<string>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deployUnitMappings, setDeployUnitMappings] = useState<HarnessDeployUnitMapping[]>([])
  const [deployUnitMappingsLoading, setDeployUnitMappingsLoading] = useState(true)
  const [deployUnitMappingsSaving, setDeployUnitMappingsSaving] = useState(false)
  const [deployUnitMappingsDirty, setDeployUnitMappingsDirty] = useState(false)
  const [deployUnitMappingsError, setDeployUnitMappingsError] = useState<string | null>(null)
  const [leanTokenConfig, setLeanTokenConfig] = useState<HarnessLeanTokenConfig>({ leanToken: "" })
  const [leanTokenLoading, setLeanTokenLoading] = useState(true)
  const [leanTokenSaving, setLeanTokenSaving] = useState(false)
  const [leanTokenDirty, setLeanTokenDirty] = useState(false)
  const [leanTokenError, setLeanTokenError] = useState<string | null>(null)
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
      return new Set(
        Array.isArray(arr) ? arr.filter((id): id is string => typeof id === "string") : []
      )
    } catch {
      return new Set()
    }
  })
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(null)
  const [sidebarThreadToDelete, setSidebarThreadToDelete] = useState<Thread | null>(null)
  const [creatingSidebarSessionKey, setCreatingSidebarSessionKey] = useState<string | null>(null)
  const [creatingProjectSessionProjectId, setCreatingProjectSessionProjectId] = useState<
    string | null
  >(null)
  const creatingFeatureRef = useRef(false)
  const projectsRef = useRef(projects)
  const enterpriseProjectDetailsByCodeRef = useRef(enterpriseProjectDetailsByCode)
  const enterpriseProjectDetailQueueRef = useRef<Set<string>>(new Set())
  const enterpriseProjectDetailPendingCodesRef = useRef<Set<string>>(new Set())
  const enterpriseProjectDetailTimerRef = useRef<number | null>(null)
  const selectedProjectIdRef = useRef(selectedProjectId)
  const selectedFeatureRef = useRef(selectedFeature)
  const selectedProjectSessionRef = useRef(selectedProjectSession)
  const currentThreadIdRef = useRef(currentThreadId)
  const isViewingSessionRef = useRef(isViewingSession)
  const projectSidebarScrollTopRef = useRef(0)
  const projectSidebarScrollIntentRef = useRef<ProjectSidebarScrollIntent>(null)
  const projectDetailsRefreshInFlightRef = useRef(false)
  const selectedProjectRefreshInFlightRef = useRef(false)
  const skipRunDetailLoadForSessionRef = useRef<string | null>(null)
  const loadProjectsRequestIdRef = useRef(0)
  const featureWorkflowRequestIdRef = useRef(0)
  projectsRef.current = projects
  enterpriseProjectDetailsByCodeRef.current = enterpriseProjectDetailsByCode
  selectedProjectIdRef.current = selectedProjectId
  selectedFeatureRef.current = selectedFeature
  selectedProjectSessionRef.current = selectedProjectSession
  currentThreadIdRef.current = currentThreadId
  isViewingSessionRef.current = isViewingSession

  const flushEnterpriseProjectDetailQueue = useCallback(() => {
    const queuedCodes = Array.from(enterpriseProjectDetailQueueRef.current)
    enterpriseProjectDetailQueueRef.current.clear()
    enterpriseProjectDetailTimerRef.current = null

    const cache = enterpriseProjectDetailsByCodeRef.current
    const pendingCodes = enterpriseProjectDetailPendingCodesRef.current
    const prjCodeList = queuedCodes.filter((code) => !cache[code] && !pendingCodes.has(code))
    if (prjCodeList.length === 0) return

    for (const code of prjCodeList) {
      pendingCodes.add(code)
    }

    window.api.harnessBoard
      .getEnterpriseProjectDetails({ prjCodeList })
      .then((result) => {
        const projectsByCode = new Map(
          result.projects.map((project) => [
            normalizeEnterpriseProjectCode(project.projectCode),
            project
          ])
        )
        setEnterpriseProjectDetailsByCode((current) => {
          const next = { ...current }
          for (const code of prjCodeList) {
            const project = projectsByCode.get(code)
            next[code] = project ? { kind: "hit", project } : { kind: "miss" }
          }
          return next
        })
      })
      .catch(() => {
        // Enterprise project details are auxiliary. Scroll-triggered failures should stay silent.
      })
      .finally(() => {
        for (const code of prjCodeList) {
          pendingCodes.delete(code)
        }
      })
  }, [])

  const scheduleEnterpriseProjectDetailQuery = useCallback(
    (projectCodes: string[]) => {
      const cache = enterpriseProjectDetailsByCodeRef.current
      const pendingCodes = enterpriseProjectDetailPendingCodesRef.current
      let shouldSchedule = false

      for (const projectCode of projectCodes) {
        const code = normalizeEnterpriseProjectCode(projectCode)
        if (!code || cache[code] || pendingCodes.has(code)) continue
        enterpriseProjectDetailQueueRef.current.add(code)
        shouldSchedule = true
      }

      if (!shouldSchedule || enterpriseProjectDetailTimerRef.current !== null) return

      enterpriseProjectDetailTimerRef.current = window.setTimeout(
        flushEnterpriseProjectDetailQueue,
        ENTERPRISE_PROJECT_DETAIL_QUERY_DEBOUNCE_MS
      )
    },
    [flushEnterpriseProjectDetailQueue]
  )

  useEffect(() => {
    return () => {
      if (enterpriseProjectDetailTimerRef.current !== null) {
        window.clearTimeout(enterpriseProjectDetailTimerRef.current)
      }
    }
  }, [])

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

  const handleProjectCardVisible = useCallback(
    (project: HarnessProjectListItem) => {
      if (project.lifecycle.status === "archived") return
      scheduleEnterpriseProjectDetailQuery([project.projectCode])
    },
    [scheduleEnterpriseProjectDetailQuery]
  )

  const loadDeployUnitMappings = useCallback(async (): Promise<void> => {
    setDeployUnitMappingsLoading(true)
    setDeployUnitMappingsError(null)
    try {
      const mappings = await window.api.harnessBoard.getDeployUnitMappings()
      setDeployUnitMappings(mappings)
      setDeployUnitMappingsDirty(false)
    } catch (error) {
      setDeployUnitMappingsError(cleanIpcError(error))
    } finally {
      setDeployUnitMappingsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDeployUnitMappings()
  }, [loadDeployUnitMappings])

  const loadLeanTokenConfig = useCallback(async (): Promise<void> => {
    setLeanTokenLoading(true)
    setLeanTokenError(null)
    try {
      const config = await window.api.harnessBoard.getLeanTokenConfig()
      setLeanTokenConfig(config)
      setLeanTokenDirty(false)
    } catch (error) {
      setLeanTokenError(cleanIpcError(error))
    } finally {
      setLeanTokenLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadLeanTokenConfig()
  }, [loadLeanTokenConfig])

  const handleAddDeployUnitMapping = useCallback((): void => {
    setDeployUnitMappings((current) => [...current, createEmptyDeployUnitMapping()])
    setDeployUnitMappingsDirty(true)
    setDeployUnitMappingsError(null)
  }, [])

  const handleRemoveDeployUnitMapping = useCallback((index: number): void => {
    setDeployUnitMappings((current) => current.filter((_, itemIndex) => itemIndex !== index))
    setDeployUnitMappingsDirty(true)
    setDeployUnitMappingsError(null)
  }, [])

  const handleChangeDeployUnitMapping = useCallback(
    (index: number, mapping: HarnessDeployUnitMapping): void => {
      setDeployUnitMappings((current) =>
        current.map((item, itemIndex) => (itemIndex === index ? mapping : item))
      )
      setDeployUnitMappingsDirty(true)
      setDeployUnitMappingsError(null)
    },
    []
  )

  const handlePickDeployUnitRepoPath = useCallback(async (index: number): Promise<void> => {
    const localRepoPath = await window.api.workspace.select()
    if (!localRepoPath) return
    setDeployUnitMappings((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, localRepoPath } : item))
    )
    setDeployUnitMappingsDirty(true)
    setDeployUnitMappingsError(null)
  }, [])

  const handleLeanTokenChange = useCallback((value: string): void => {
    setLeanTokenConfig({ leanToken: value })
    setLeanTokenDirty(true)
    setLeanTokenError(null)
  }, [])

  const handleOpenLeanToken = useCallback((): void => {
    void window.electron
      .openExternal(import.meta.env.VITE_LEANSTAR_PERSONAL_TOKEN_URL?.trim() || "")
      .catch((error) => {
        setLeanTokenError(cleanIpcError(error))
      })
  }, [])

  const handleSaveLeanTokenConfig = useCallback(async (): Promise<void> => {
    setLeanTokenSaving(true)
    setLeanTokenError(null)
    try {
      const saved = await window.api.harnessBoard.saveLeanTokenConfig(leanTokenConfig)
      setLeanTokenConfig(saved)
      setLeanTokenDirty(false)
      toast.success("配置已保存")
    } catch (error) {
      setLeanTokenError(cleanIpcError(error))
    } finally {
      setLeanTokenSaving(false)
    }
  }, [leanTokenConfig])

  const handleSaveDeployUnitMappings = useCallback(async (): Promise<void> => {
    const payload = buildDeployUnitMappingSavePayload(deployUnitMappings)
    if (payload.error) {
      setDeployUnitMappingsError(payload.error)
      return
    }

    setDeployUnitMappingsSaving(true)
    setDeployUnitMappingsError(null)
    try {
      const saved = await window.api.harnessBoard.saveDeployUnitMappings(payload.mappings)
      setDeployUnitMappings(saved)
      setDeployUnitMappingsDirty(false)
      toast.success("配置已保存")
    } catch (error) {
      setDeployUnitMappingsError(cleanIpcError(error))
    } finally {
      setDeployUnitMappingsSaving(false)
    }
  }, [deployUnitMappings])

  const handleProjectModeTabChange = useCallback(
    (nextTab: string): void => {
      if (projectModeTab === "settings" && nextTab !== "settings") {
        const payload = buildDeployUnitMappingSavePayload(deployUnitMappings)
        if (
          deployUnitMappingsDirty &&
          !deployUnitMappingsLoading &&
          !deployUnitMappingsSaving &&
          !payload.error
        ) {
          void handleSaveDeployUnitMappings()
        }
        if (leanTokenDirty && !leanTokenLoading && !leanTokenSaving) {
          void handleSaveLeanTokenConfig()
        }
      }
      setProjectModeTab(nextTab)
    },
    [
      handleSaveDeployUnitMappings,
      handleSaveLeanTokenConfig,
      projectModeTab,
      deployUnitMappings,
      deployUnitMappingsDirty,
      deployUnitMappingsLoading,
      deployUnitMappingsSaving,
      leanTokenDirty,
      leanTokenLoading,
      leanTokenSaving
    ]
  )

  const loadKnowledgePreview = useCallback(
    async (adapter: HarnessAdapterRegistryItem): Promise<void> => {
      if (loadingKnowledgePreviewAdapterIds.has(adapter.id)) return

      setLoadingKnowledgePreviewAdapterIds((current) => new Set(current).add(adapter.id))
      try {
        const preview = await window.api.harnessBoard.getKnowledgePreview(adapter.id)
        setKnowledgePreviewsByAdapterId((current) => ({
          ...current,
          [adapter.id]: preview
        }))
      } catch (error) {
        toast.error(cleanIpcError(error))
      } finally {
        setLoadingKnowledgePreviewAdapterIds((current) => {
          const next = new Set(current)
          next.delete(adapter.id)
          return next
        })
      }
    },
    [loadingKnowledgePreviewAdapterIds]
  )

  const handleToggleKnowledgePreview = useCallback(
    (adapter: HarnessAdapterRegistryItem): void => {
      const expanded = expandedKnowledgePreviewAdapterIds.has(adapter.id)
      setExpandedKnowledgePreviewAdapterIds((current) => {
        const next = new Set(current)
        if (expanded) {
          next.delete(adapter.id)
        } else {
          next.add(adapter.id)
        }
        return next
      })

      if (!expanded && !knowledgePreviewsByAdapterId[adapter.id]) {
        void loadKnowledgePreview(adapter)
      }
    },
    [expandedKnowledgePreviewAdapterIds, knowledgePreviewsByAdapterId, loadKnowledgePreview]
  )

  const handleSelectKnowledgePreviewPath = useCallback(
    (adapter: HarnessAdapterRegistryItem, path: string | null): void => {
      setSelectedKnowledgePreviewPaths((current) => ({
        ...current,
        [adapter.id]: path
      }))
    },
    []
  )

  const syncProjectConstraints = useCallback(
    async (adapter: HarnessAdapterRegistryItem): Promise<boolean> => {
      if (!adapter.pullKnowledgeAvailable) return false
      if (syncingProjectConstraintAdapterIds.has(adapter.id)) return false

      setSyncingProjectConstraintAdapterIds((current) => new Set(current).add(adapter.id))
      try {
        const result = await window.api.harnessBoard.syncProjectConstraints(adapter.id)
        const syncedPath = result.path
        if (syncedPath) {
          setSyncedProjectConstraintPaths((current) => ({
            ...current,
            [adapter.id]: syncedPath
          }))
        }
        toast.success(result.message || `已更新「${adapter.name}」项目约束`)
        return true
      } catch (error) {
        toast.error(cleanIpcError(error))
        return false
      } finally {
        setSyncingProjectConstraintAdapterIds((current) => {
          const next = new Set(current)
          next.delete(adapter.id)
          return next
        })
      }
    },
    [syncingProjectConstraintAdapterIds]
  )

  const handleSyncProjectConstraints = useCallback(
    async (adapter: HarnessAdapterRegistryItem): Promise<void> => {
      const synced = await syncProjectConstraints(adapter)
      if (!synced) return

      setExpandedKnowledgePreviewAdapterIds((current) => new Set(current).add(adapter.id))
      await loadKnowledgePreview(adapter)
    },
    [loadKnowledgePreview, syncProjectConstraints]
  )

  const refreshFeaturePublicConstraints = useCallback(
    async (projectId: string, requestId: number): Promise<void> => {
      try {
        const publicAgentmdDeployUnits =
          await window.api.harnessBoard.getPublicAgentmdDeployUnits(projectId)
        if (requestId !== featureWorkflowRequestIdRef.current) return
        setFeatureAgentsReadyDeployUnits(publicAgentmdDeployUnits)
      } catch {
        if (requestId !== featureWorkflowRequestIdRef.current) return
        setFeatureAgentsReadyDeployUnits([])
      }
    },
    []
  )

  const findAdapterForProject = useCallback(
    (project: HarnessProjectListItem): HarnessAdapterRegistryItem | null => {
      return (
        adapterRegistry.find(
          (adapter) =>
            adapter.id === project.harnessAdapter.id || adapter.name === project.harnessAdapter.name
        ) ?? null
      )
    },
    [adapterRegistry]
  )

  const handleSyncFeaturePublicConstraints = useCallback(async (): Promise<void> => {
    const project = featureDialogProject
    if (!project) return
    const adapter = findAdapterForProject(project)
    if (!adapter?.pullKnowledgeAvailable) {
      toast.error("当前插件不支持同步公共约束")
      return
    }
    const synced = await syncProjectConstraints(adapter)
    if (synced) {
      await refreshFeaturePublicConstraints(project.projectId, featureWorkflowRequestIdRef.current)
    }
  }, [
    featureDialogProject,
    findAdapterForProject,
    refreshFeaturePublicConstraints,
    syncProjectConstraints
  ])

  const loadProjectDetail = useCallback(
    async (projectId: string, options: { showLoading?: boolean; reportError?: boolean } = {}) => {
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
    },
    []
  )

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
        current &&
        (items.some((item) => item.projectId === current) ||
          (selectedFeatureRef.current?.deleted && selectedFeatureRef.current.projectId === current))
          ? current
          : null
      )
      scheduleHarnessAdapterDisplayRefresh(() => {
        if (requestId !== loadProjectsRequestIdRef.current) return
        void Promise.all([loadHarnessMarketPlugins(), loadHarnessInstalledPlugins()]).then(
          async ([marketPlugins, installedPlugins]) => {
            const uploaderProfiles = await loadHarnessMarketPluginUploaderProfiles(marketPlugins)
            if (requestId !== loadProjectsRequestIdRef.current) return
            setMarketPluginItems(marketPlugins)
            setAdapterRegistry(
              applyMarketAdapterDisplayData(
                registry,
                marketPlugins,
                installedPlugins,
                uploaderProfiles
              )
            )
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

  const handleInstallMarketPlugin = useCallback(
    async (adapter: HarnessAdapterRegistryItem): Promise<void> => {
      const pluginName = normalizeAdapterMarketName(adapter.name)
      if (!pluginName || updatingPluginNames.has(pluginName)) return

      const marketPlugin = marketPluginItems.find(
        (item) => normalizeAdapterMarketName(item.name) === pluginName
      )
      if (!marketPlugin) {
        toast.error("未找到市场插件信息")
        return
      }

      setUpdatingPluginNames((current) => new Set(current).add(pluginName))
      try {
        const response = await marketApi.downloadItem(
          marketPlugin.name,
          "plugin",
          false,
          false,
          marketPlugin
        )
        if (response.success) {
          toast.success(`已安装「${pluginName}」到插件`)
          bumpPluginVersion()
        } else {
          toast.error(response.error || "安装失败")
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "安装失败")
      } finally {
        setUpdatingPluginNames((current) => {
          const next = new Set(current)
          next.delete(pluginName)
          return next
        })
      }
    },
    [bumpPluginVersion, marketPluginItems, updatingPluginNames]
  )

  const refreshProjectDetailsInBackground = useCallback(async () => {
    if (selectedProjectIdRef.current || selectedFeatureRef.current) return
    if (projectDetailsRefreshInFlightRef.current) return

    const projectIds = projectsRef.current.map((project) => project.projectId)
    if (projectIds.length === 0) return

    projectDetailsRefreshInFlightRef.current = true
    try {
      const details = await window.api.harnessBoard.getProjectDetails(projectIds, {
        watchRefs: false
      })
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
    if (selectedFeature.deleted) {
      skipRunDetailLoadForSessionRef.current = null
      setRunDetail(null)
      setLoadingRun(false)
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
      if (
        currentFeature &&
        !currentFeature.deleted &&
        event.scopeKey === `run:${currentFeature.projectId}:${currentFeature.slug}`
      ) {
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

  const refreshSelectedRunDetail = useCallback(
    async (options: { rethrow?: boolean } = {}): Promise<void> => {
      if (!selectedFeature || selectedFeature.deleted) return
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
        await loadProjectDetail(selectedFeature.projectId, {
          showLoading: false,
          reportError: false
        })
      } catch (error) {
        setLoadError(cleanIpcError(error))
        if (options.rethrow) throw error
      } finally {
        setLoadingRun(false)
      }
    },
    [loadProjectDetail, selectedFeature]
  )

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

  const boardStats = useMemo(
    () => buildHarnessBoardStats(projects, detailsByProjectId),
    [detailsByProjectId, projects]
  )
  const archivedProjects = useMemo(
    () =>
      archivedSystemGroups
        .flatMap((group) => group.projects)
        .slice()
        .sort((left, right) =>
          `${left.systemId}:${left.name}`.localeCompare(`${right.systemId}:${right.name}`, "zh-CN")
        ),
    [archivedSystemGroups]
  )
  const archivedProjectCount = useMemo(() => archivedProjects.length, [archivedProjects])

  const visibleProjectCount = useMemo(
    () =>
      activeSystemGroups.reduce((count, group) => count + group.projects.length, 0) +
      archivedSystemGroups.reduce((count, group) => count + group.projects.length, 0),
    [activeSystemGroups, archivedSystemGroups]
  )

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

  const handlePickSessionWorkspace = async (): Promise<void> => {
    const sessionWorkspacePath = await window.api.workspace.select()
    if (sessionWorkspacePath) {
      setForm((current) => ({ ...current, sessionWorkspacePath }))
    }
  }

  const handlePickEditSessionWorkspace = async (): Promise<void> => {
    const sessionWorkspacePath = await window.api.workspace.select()
    if (sessionWorkspacePath) {
      setEditForm((current) => ({ ...current, sessionWorkspacePath }))
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

  const requestArchiveProject = useCallback(
    (project: HarnessProjectListItem): void => {
      if (archivingProjectId || confirmingProjectAction || project.lifecycle.status === "archived")
        return
      setPendingProjectAction({ type: "archive", project })
    },
    [archivingProjectId, confirmingProjectAction]
  )

  const requestDeleteProject = useCallback(
    (project: HarnessProjectListItem): void => {
      if (deletingProjectId || confirmingProjectAction) return
      setPendingProjectAction({ type: "delete", project })
    },
    [confirmingProjectAction, deletingProjectId]
  )

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
          setSelectedProjectSession(null)
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

  const handleDeleteProject = useCallback(
    async (project: HarnessProjectListItem): Promise<void> => {
      if (deletingProjectId) return

      setDeletingProjectId(project.projectId)
      setLoadError(null)
      try {
        await window.api.harnessBoard.deleteProject(project.projectId)
        setDetailsByProjectId((current) => {
          const next = { ...current }
          delete next[project.projectId]
          return next
        })
        if (selectedProjectId === project.projectId) {
          setSelectedProjectId(null)
          setSelectedProjectSession(null)
          setSelectedFeature(null)
          setIsViewingSession(false)
        }
        await loadProjects()
      } catch (error) {
        setLoadError(cleanIpcError(error))
      } finally {
        setDeletingProjectId(null)
      }
    },
    [deletingProjectId, loadProjects, selectedProjectId]
  )

  const handleConfirmProjectAction = useCallback((): void => {
    const action = pendingProjectAction
    if (!action || confirmingProjectAction) return

    setConfirmingProjectAction(true)
    void (async () => {
      try {
        if (action.type === "archive") {
          await handleArchiveProject(action.project)
        } else {
          await handleDeleteProject(action.project)
        }
      } finally {
        setConfirmingProjectAction(false)
        setPendingProjectAction(null)
      }
    })()
  }, [confirmingProjectAction, handleArchiveProject, handleDeleteProject, pendingProjectAction])

  const openFeatureCreateDialog = useCallback(
    (project: HarnessProjectListItem): void => {
      const compatibilityMessage = boardCompatibilityMessage(project.boardCompatibility)
      if (compatibilityMessage) {
        toast.warning(compatibilityMessage)
        return
      }
      const requestId = ++featureWorkflowRequestIdRef.current
      setFeatureDialogMode("create")
      setFeatureDialogProject(project)
      setFeatureName("")
      setFeatureError(null)
      setFeatureWorkflowConfig(null)
      setFeatureWorkflowTemplate("")
      setSelectedWorkflowNodeIds(new Set())
      setFeatureAgentsReadyDeployUnits([])
      setFeatureLocalAgentmdDeployUnitMappings([])
      setSelectedDeployUnitIds(new Set())
      setFeatureWorkflowLoading(true)

      void window.api.harnessBoard
        .getDynamicWorkflowConfig(project.projectId)
        .then((config) => {
          if (requestId !== featureWorkflowRequestIdRef.current) return
          const templateId = defaultWorkflowTemplateId(config)
          setFeatureWorkflowConfig(config)
          setFeatureWorkflowTemplate(templateId)
          setSelectedWorkflowNodeIds(requiredWorkflowNodeIds(config, templateId))
        })
        .catch(() => {
          if (requestId !== featureWorkflowRequestIdRef.current) return
          setFeatureWorkflowConfig(null)
          setFeatureWorkflowTemplate("")
          setSelectedWorkflowNodeIds(new Set())
        })
        .finally(() => {
          if (requestId === featureWorkflowRequestIdRef.current) {
            setFeatureWorkflowLoading(false)
          }
        })
      void refreshFeaturePublicConstraints(project.projectId, requestId)
      void window.api.harnessBoard
        .getLocalAgentmdDeployUnitMappings(deployUnitMappings)
        .then((deployUnitMappingIds) => {
          if (requestId !== featureWorkflowRequestIdRef.current) return
          setFeatureLocalAgentmdDeployUnitMappings(deployUnitMappingIds)
        })
        .catch(() => {
          if (requestId !== featureWorkflowRequestIdRef.current) return
          setFeatureLocalAgentmdDeployUnitMappings([])
        })
    },
    [refreshFeaturePublicConstraints, deployUnitMappings]
  )

  const handleFeatureDialogOpenChange = useCallback(
    (open: boolean): void => {
      if (!open && !creatingFeatureProjectId && !updatingFeatureDeployUnits) {
        featureWorkflowRequestIdRef.current += 1
        setFeatureDialogMode("create")
        setFeatureDialogProject(null)
        setFeatureName("")
        setFeatureError(null)
        setFeatureWorkflowConfig(null)
        setFeatureWorkflowLoading(false)
        setFeatureWorkflowTemplate("")
        setSelectedWorkflowNodeIds(new Set())
        setFeatureAgentsReadyDeployUnits([])
        setFeatureLocalAgentmdDeployUnitMappings([])
        setSelectedDeployUnitIds(new Set())
      }
    },
    [creatingFeatureProjectId, updatingFeatureDeployUnits]
  )

  const handleOpenDeployUnitSettings = useCallback((): void => {
    if (creatingFeatureProjectId || updatingFeatureDeployUnits) return
    handleFeatureDialogOpenChange(false)
    setSelectedProjectSession(null)
    setSelectedFeature(null)
    setSelectedProjectId(null)
    setIsViewingSession(false)
    setProjectModeTab("settings")
  }, [creatingFeatureProjectId, handleFeatureDialogOpenChange, updatingFeatureDeployUnits])

  const handleWorkflowTemplateChange = useCallback(
    (templateId: string): void => {
      setFeatureWorkflowTemplate(templateId)
      const template = selectedWorkflowTemplate(featureWorkflowConfig, templateId)
      if (isCustomWorkflowTemplate(template)) {
        setSelectedWorkflowNodeIds((current) =>
          ensureRequiredWorkflowNodes(current, featureWorkflowConfig, templateId)
        )
      }
    },
    [featureWorkflowConfig]
  )

  const handleWorkflowNodeToggle = useCallback(
    (nodeId: string, checked: boolean): void => {
      setSelectedWorkflowNodeIds((current) => {
        const requiredNodeIds = requiredWorkflowNodeIds(
          featureWorkflowConfig,
          featureWorkflowTemplate
        )
        if (requiredNodeIds.has(nodeId)) return current
        const next = new Set(current)
        if (checked) {
          next.add(nodeId)
        } else {
          next.delete(nodeId)
        }
        return next
      })
    },
    [featureWorkflowConfig, featureWorkflowTemplate]
  )

  const handleDeployUnitToggle = useCallback(
    (deployUnitIdMapping: string, checked: boolean): void => {
      setSelectedDeployUnitIds((current) => {
        const next = new Set(current)
        if (checked) {
          next.add(deployUnitIdMapping)
        } else {
          next.delete(deployUnitIdMapping)
        }
        return next
      })
    },
    []
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
    const supportsSessionContextInjection = featureDialogProject.supportsSessionContextInjection
    const sessionContextInjectionSource = supportsSessionContextInjection ? "plugin" : "cmbdevclaw"
    const selectedDeployUnits = deployUnitMappings.filter((mapping) =>
      selectedDeployUnitIds.has(mapping.deployUnitIdMapping)
    )
    const hasSelectedDeployUnits = selectedDeployUnits.length > 0
    if (hasSelectedDeployUnits && deployUnitMappingsDirty) {
      setFeatureError("发布单元路径配置尚未保存，请先保存后再创建特性")
      return
    }

    creatingFeatureRef.current = true
    setCreatingFeatureProjectId(featureDialogProject.projectId)
    setFeatureError(null)
    try {
      const selectedTemplate = selectedWorkflowTemplate(
        featureWorkflowConfig,
        featureWorkflowTemplate
      )
      const customWorkflowSelected = isCustomWorkflowTemplate(selectedTemplate)
      const workflowInput =
        featureWorkflowConfig && featureWorkflowTemplate
          ? {
              workflowTemplate: featureWorkflowTemplate,
              workflowConfig: featureWorkflowConfig,
              ...(customWorkflowSelected
                ? {
                    workflowNodes: orderedSelectedWorkflowNodeIds(
                      featureWorkflowConfig,
                      ensureRequiredWorkflowNodes(
                        selectedWorkflowNodeIds,
                        featureWorkflowConfig,
                        featureWorkflowTemplate
                      )
                    )
                  }
                : {})
            }
          : {}
      const result = await window.api.harnessBoard.createFeature({
        projectId: featureDialogProject.projectId,
        feature,
        sessionContextInjectionSource,
        ...(hasSelectedDeployUnits ? { selectedDeployUnits } : {}),
        ...workflowInput
      })

      setFeatureDialogProject(null)
      setFeatureName("")
      setSelectedDeployUnitIds(new Set())
      await loadProjectDetail(result.projectId)
      projectSidebarScrollIntentRef.current = "top"
      setSelectedProjectSession(null)
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
    featureWorkflowConfig,
    featureWorkflowTemplate,
    selectedWorkflowNodeIds,
    selectedDeployUnitIds,
    deployUnitMappings,
    deployUnitMappingsDirty,
    loadProjectDetail
  ])

  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.thread_id, thread])),
    [threads]
  )
  const harnessSessionIndex = useMemo(() => buildHarnessSessionIndex(threads), [threads])
  const selectedFeatureSessions = useMemo(
    () =>
      selectedFeature
        ? getFeatureSessions(harnessSessionIndex, selectedFeature.projectId, selectedFeature.slug)
        : [],
    [harnessSessionIndex, selectedFeature]
  )
  const runDetailWithSessions = useMemo(() => {
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
    const featureExists = selectedFeatureProjectDetail.runs.some(
      (run) => run.slug === selectedFeature.slug
    )
    return featureExists && !(isViewingSession && selectedFeature.activeSessionThreadId)
      ? null
      : createUnboundRunDetail(
          selectedFeatureProjectDetail,
          selectedFeature.slug,
          selectedFeatureSessions
        )
  }, [
    isViewingSession,
    runDetail,
    selectedFeature,
    selectedFeatureProjectDetail,
    selectedFeatureSessions
  ])
  const showingUnboundRunDetail =
    runDetailWithSessions !== null &&
    runDetail === null &&
    !(
      selectedFeature?.activeSessionThreadId &&
      isViewingSession &&
      selectedFeatureProjectDetail?.runs.some((run) => run.slug === selectedFeature.slug)
    )
  const selectedProject = selectedProjectId
    ? (projects.find((project) => project.projectId === selectedProjectId) ?? null)
    : null
  const openFeatureDeployUnitEditDialog = useCallback((): void => {
    if (!selectedProject || !runDetailWithSessions || selectedFeature?.deleted) return

    const requestId = ++featureWorkflowRequestIdRef.current
    setFeatureDialogMode("edit")
    setFeatureDialogProject(selectedProject)
    setFeatureName(runDetailWithSessions.run.slug)
    setFeatureError(null)
    setFeatureWorkflowConfig(null)
    setFeatureWorkflowLoading(false)
    setFeatureWorkflowTemplate("")
    setSelectedWorkflowNodeIds(new Set())
    setFeatureAgentsReadyDeployUnits([])
    setFeatureLocalAgentmdDeployUnitMappings([])
    setSelectedDeployUnitIds(
      new Set(
        runDetailWithSessions.run.selectedDeployUnits.map((mapping) => mapping.deployUnitIdMapping)
      )
    )

    void refreshFeaturePublicConstraints(selectedProject.projectId, requestId)
    void window.api.harnessBoard
      .getLocalAgentmdDeployUnitMappings(deployUnitMappings)
      .then((deployUnitMappingIds) => {
        if (requestId !== featureWorkflowRequestIdRef.current) return
        setFeatureLocalAgentmdDeployUnitMappings(deployUnitMappingIds)
      })
      .catch(() => {
        if (requestId !== featureWorkflowRequestIdRef.current) return
        setFeatureLocalAgentmdDeployUnitMappings([])
      })
  }, [
    deployUnitMappings,
    refreshFeaturePublicConstraints,
    runDetailWithSessions,
    selectedFeature?.deleted,
    selectedProject
  ])

  const handleSubmitFeatureDeployUnits = useCallback(async (): Promise<void> => {
    if (
      featureDialogMode !== "edit" ||
      !featureDialogProject ||
      !selectedFeature ||
      updatingFeatureDeployUnits
    ) {
      return
    }

    const selectedDeployUnits = deployUnitMappings.filter((mapping) =>
      selectedDeployUnitIds.has(mapping.deployUnitIdMapping)
    )
    if (selectedDeployUnits.length > 0 && deployUnitMappingsDirty) {
      setFeatureError("发布单元路径配置尚未保存，请先保存后再编辑绑定")
      return
    }

    setUpdatingFeatureDeployUnits(true)
    setFeatureError(null)
    try {
      await window.api.harnessBoard.updateFeatureDeployUnits({
        projectId: selectedFeature.projectId,
        featureId: selectedFeature.slug,
        selectedDeployUnits
      })
      try {
        await refreshSelectedRunDetail({ rethrow: true })
      } catch (error) {
        setFeatureError(`发布单元已保存，但刷新特性详情失败：${cleanIpcError(error)}`)
        return
      }
      featureWorkflowRequestIdRef.current += 1
      setFeatureDialogProject(null)
      setFeatureDialogMode("create")
      setFeatureName("")
      setSelectedDeployUnitIds(new Set())
      toast.success("已更新特性绑定的发布单元")
    } catch (error) {
      setFeatureError(cleanIpcError(error))
    } finally {
      setUpdatingFeatureDeployUnits(false)
    }
  }, [
    deployUnitMappings,
    deployUnitMappingsDirty,
    featureDialogMode,
    featureDialogProject,
    refreshSelectedRunDetail,
    selectedDeployUnitIds,
    selectedFeature,
    updatingFeatureDeployUnits
  ])
  const featureDialogSubmitting =
    featureDialogMode === "edit" ? updatingFeatureDeployUnits : creatingFeatureProjectId !== null
  const handleSubmitFeatureDialog = useCallback((): void => {
    if (featureDialogMode === "edit") {
      void handleSubmitFeatureDeployUnits()
      return
    }
    void handleSubmitFeature()
  }, [featureDialogMode, handleSubmitFeature, handleSubmitFeatureDeployUnits])
  const selectedProjectSessionThread = selectedProjectSession
    ? (threadsById.get(selectedProjectSession.threadId) ?? null)
    : null
  const selectedProjectSessionProject =
    selectedProject ??
    (selectedProjectSession
      ? makeDeletedProjectSidebarItem(
          selectedProjectSession.projectId,
          readThreadHarnessProjectName(selectedProjectSessionThread)
        )
      : null)
  const selectedProjectDetail = selectedProjectId
    ? detailsByProjectId[selectedProjectId]
    : undefined
  const selectedProjectCode = selectedProject
    ? normalizeEnterpriseProjectCode(selectedProject.projectCode)
    : ""
  const selectedProjectArchived = selectedProject?.lifecycle.status === "archived"
  const selectedEnterpriseProjectDetail =
    selectedProjectCode && !selectedProjectArchived
      ? enterpriseProjectDetailsByCode[selectedProjectCode]
      : undefined
  const projectActionBusy =
    confirmingProjectAction ||
    (pendingProjectAction?.type === "archive"
      ? archivingProjectId === pendingProjectAction.project.projectId
      : pendingProjectAction?.type === "delete"
        ? deletingProjectId === pendingProjectAction.project.projectId
        : false)

  useEffect(() => {
    if (!selectedProjectCode || selectedProjectArchived || selectedEnterpriseProjectDetail) return

    let canceled = false
    window.api.harnessBoard
      .getEnterpriseProjectDetails({ prjCodeList: [selectedProjectCode] })
      .then((result) => {
        if (canceled) return
        const project = result.projects.find(
          (item) => normalizeEnterpriseProjectCode(item.projectCode) === selectedProjectCode
        )
        setEnterpriseProjectDetailsByCode((current) => {
          const currentEntry = current[selectedProjectCode]
          if (currentEntry?.kind === "hit") return current
          if (!project && currentEntry) return current
          return {
            ...current,
            [selectedProjectCode]: project ? { kind: "hit", project } : { kind: "miss" }
          }
        })
      })
      .catch(() => {
        if (canceled) return
        setEnterpriseProjectDetailsByCode((current) =>
          current[selectedProjectCode]
            ? current
            : { ...current, [selectedProjectCode]: { kind: "miss" } }
        )
      })

    return () => {
      canceled = true
    }
  }, [selectedEnterpriseProjectDetail, selectedProjectArchived, selectedProjectCode])

  useEffect(() => {
    if (!selectedProjectCode) {
      setProjectReviewState({ kind: "idle" })
      return
    }

    let canceled = false
    setProjectReviewState({ kind: "loading", projectCode: selectedProjectCode })
    window.api.harnessBoard
      .getProjectReviews({ projectCode: selectedProjectCode })
      .then((result) => {
        if (canceled) return
        setProjectReviewState({ kind: "loaded", projectCode: selectedProjectCode, result })
      })
      .catch((error) => {
        if (canceled) return
        setProjectReviewState({
          kind: "error",
          projectCode: selectedProjectCode,
          message: cleanIpcError(error)
        })
      })

    return () => {
      canceled = true
    }
  }, [selectedProjectCode])

  const projectPluginUpdateInfoById = useMemo(() => {
    const marketPluginByName = buildMarketPluginMap(marketPluginItems)
    const next = new Map<string, MarketPluginUpdateInfo>()

    for (const project of projects) {
      const marketPlugin = marketPluginByName.get(
        normalizeAdapterMarketName(project.harnessAdapter.name)
      )
      const updateInfo = getMarketPluginUpdateInfo(marketPlugin)
      if (updateInfo) {
        next.set(project.projectId, updateInfo)
      }
    }

    return next
  }, [marketPluginItems, pluginVersion, projects])

  const openProjectDetail = useCallback(
    (projectId: string): void => {
      projectSidebarScrollIntentRef.current = "top"
      setSelectedProjectSession(null)
      setSelectedFeature(null)
      setSelectedProjectId(projectId)
      setIsViewingSession(false)
      if (!loadingDetailIds.has(projectId)) {
        void loadProjectDetail(
          projectId,
          detailsByProjectId[projectId] ? { showLoading: false, reportError: false } : {}
        )
      }
    },
    [detailsByProjectId, loadProjectDetail, loadingDetailIds]
  )

  const handleUpdateProjectPlugin = useCallback(
    async (project: HarnessProjectListItem, updateInfo: MarketPluginUpdateInfo): Promise<void> => {
      const pluginName = project.harnessAdapter.name
      if (updatingPluginNames.has(pluginName)) return

      setUpdatingPluginNames((current) => new Set(current).add(pluginName))
      try {
        const response = await installMarketPluginUpdate(updateInfo.item)
        if (response.success) {
          bumpPluginVersion()
          try {
            const refreshedRegistry = await window.api.harnessBoard.registry()
            const adapterNameCandidates = new Set(
              [
                project.harnessAdapter.name,
                updateInfo.itemName,
                updateInfo.item.name,
                updateInfo.item.id,
                updateInfo.item.chinese_name
              ]
                .map((value) => normalizeAdapterMarketName(value))
                .filter(Boolean)
            )
            const updatedAdapter = refreshedRegistry.find(
              (adapter) =>
                adapterNameCandidates.has(normalizeAdapterMarketName(adapter.name)) ||
                adapterNameCandidates.has(normalizeAdapterMarketName(adapter.id))
            )
            if (updatedAdapter?.pullKnowledgeAvailable) {
              await syncProjectConstraints(updatedAdapter)
            }
          } catch (syncError) {
            toast.error(`插件已更新，但自动拉取公共系统约束失败：${cleanIpcError(syncError)}`)
          }
          toast.success(
            `已为您更新并安装「${updateInfo.itemName}」到插件，请新开一个会话试试效果。`
          )
        } else {
          toast.error(response.error || "更新安装失败")
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新安装失败")
      } finally {
        setUpdatingPluginNames((current) => {
          const next = new Set(current)
          next.delete(pluginName)
          return next
        })
      }
    },
    [bumpPluginVersion, syncProjectConstraints, updatingPluginNames]
  )

  const openFeatureDetail = useCallback(
    (projectId: string, slug: string, activeSessionThreadId?: string, deleted?: boolean): void => {
      if (!activeSessionThreadId) {
        projectSidebarScrollIntentRef.current = "top"
      }
      setSelectedProjectSession(null)
      setSelectedProjectId(projectId)
      setSelectedFeature({ projectId, slug, activeSessionThreadId, deleted })
      setIsViewingSession(!!activeSessionThreadId)
      if (!deleted && !detailsByProjectId[projectId] && !loadingDetailIds.has(projectId)) {
        void loadProjectDetail(projectId)
      }
    },
    [detailsByProjectId, loadProjectDetail, loadingDetailIds]
  )

  const openProjectSession = useCallback(
    (projectId: string, threadId: string, deleted?: boolean): void => {
      setSelectedProjectId(projectId)
      setSelectedFeature(null)
      setSelectedProjectSession({ projectId, threadId, deleted })
      setIsViewingSession(true)
      if (!deleted && !detailsByProjectId[projectId] && !loadingDetailIds.has(projectId)) {
        void loadProjectDetail(projectId)
      }
    },
    [detailsByProjectId, loadProjectDetail, loadingDetailIds]
  )

  const handleBackToProjectList = useCallback((): void => {
    setSelectedProjectSession(null)
    setSelectedFeature(null)
    setSelectedProjectId(null)
    setIsViewingSession(false)
  }, [])

  const handleBackToProject = useCallback((): void => {
    const projectId =
      selectedProjectSessionRef.current?.projectId ??
      selectedFeatureRef.current?.projectId ??
      selectedProjectIdRef.current
    projectSidebarScrollIntentRef.current = "top"
    setSelectedProjectSession(null)
    setSelectedFeature(null)
    setIsViewingSession(false)
    if (projectId) {
      void loadProjectDetail(projectId, { showLoading: false, reportError: false })
    }
  }, [loadProjectDetail])

  const handleOpenSystemConstraintUpdate = useCallback(
    (
      project: HarnessProjectListItem,
      config: NonNullable<HarnessProjectDetailViewModel["systemConstraintUpdate"]>
    ): void => {
      if (creatingProjectSessionProjectId) return
      setKnowledgeDialogProject(project)
      setKnowledgeDialogConfig(config)
      setKnowledgeDialogOpen(true)
    },
    [creatingProjectSessionProjectId]
  )

  const handleKnowledgeDialogSubmit = useCallback(
    async (content: string): Promise<void> => {
      if (!knowledgeDialogProject || !knowledgeDialogConfig || creatingProjectSessionProjectId)
        return
      setCreatingProjectSessionProjectId(knowledgeDialogProject.projectId)
      try {
        const thread = await createThread(
          {
            workspacePath: knowledgeDialogConfig.knowledgePath ?? null,
            disableAgentsPrompt: true,
            harnessProjectSession: {
              projectId: knowledgeDialogProject.projectId,
              kind: SYSTEM_CONSTRAINT_UPDATE_KIND
            }
          },
          { preserveView: true }
        )
        setPendingHarnessNextAction(thread.thread_id, {
          ...knowledgeDialogConfig.nextAction,
          userMessage: content,
          preferredPlugin: {
            id: knowledgeDialogProject.harnessAdapter.id,
            name: knowledgeDialogProject.harnessAdapter.name
          }
        })
        setSelectedProjectId(knowledgeDialogProject.projectId)
        setSelectedFeature(null)
        setSelectedProjectSession({
          projectId: knowledgeDialogProject.projectId,
          threadId: thread.thread_id
        })
        setIsViewingSession(true)
        markRead(thread.thread_id)
        await selectThread(thread.thread_id, { preserveView: true })
      } catch (error) {
        toast.error(cleanIpcError(error))
      } finally {
        setCreatingProjectSessionProjectId(null)
        setKnowledgeDialogProject(null)
        setKnowledgeDialogConfig(null)
      }
    },
    [
      createThread,
      creatingProjectSessionProjectId,
      knowledgeDialogConfig,
      knowledgeDialogProject,
      markRead,
      selectThread
    ]
  )

  const projectSidebarGroups = useMemo<ProjectSessionProjectGroup[]>(() => {
    const groups: ProjectSessionProjectGroup[] = []
    // Group pinning is reserved for project/feature detail pages. Session selection
    // should only highlight/open the thread; otherwise read-only clicks and focus
    // reloads can look like project/feature activity and unexpectedly reorder groups.
    const pinnedFeature = selectedFeature && !isViewingSession ? selectedFeature : null
    const pinnedProjectId = pinnedFeature
      ? pinnedFeature.projectId
      : selectedProjectId && !selectedFeature && !selectedProjectSession && !isViewingSession
        ? selectedProjectId
        : null
    const knownProjectIds = new Set(projects.map((project) => project.projectId))
    const featureOrderByProject = new Map<string, Map<string, number>>()
    for (const [projectId, detail] of Object.entries(detailsByProjectId)) {
      featureOrderByProject.set(
        projectId,
        new Map(detail.runs.map((run, index) => [run.slug, index]))
      )
    }

    const makeFeatureGroups = (
      project: ProjectFeatureSidebarProject,
      sessionsBySlug: Map<string, HarnessSessionBinding[]>,
      section: ProjectFeatureSessionGroupSection,
      deleted = false
    ): ProjectFeatureSessionGroup[] =>
      Array.from(sessionsBySlug.entries())
        .map(([slug, sessions]) => ({
          key: `feature:${project.projectId}:${slug}`,
          project,
          slug,
          title: slug,
          sessions,
          section,
          ...(deleted ? { deleted: true } : {})
        }))
        .sort((a, b) => {
          const aPinned =
            pinnedFeature?.projectId === project.projectId && pinnedFeature.slug === a.slug
          const bPinned =
            pinnedFeature?.projectId === project.projectId && pinnedFeature.slug === b.slug
          if (aPinned !== bPinned) return aPinned ? -1 : 1

          // Keep feature group order independent from session updated_at. Message sends
          // should move the active session inside its group, not promote the whole feature.
          const order = featureOrderByProject.get(project.projectId)
          const aOrder = order?.get(a.slug) ?? Number.MAX_SAFE_INTEGER
          const bOrder = order?.get(b.slug) ?? Number.MAX_SAFE_INTEGER
          if (aOrder !== bOrder) return aOrder - bOrder
          return a.slug.localeCompare(b.slug, "zh-CN")
        })

    for (const project of projects) {
      const sessionsBySlug = new Map<string, HarnessSessionBinding[]>()
      for (const session of getProjectSessions(harnessSessionIndex, project.projectId)) {
        const sessions = sessionsBySlug.get(session.slug) ?? []
        sessions.push(session)
        sessionsBySlug.set(session.slug, sessions)
      }

      const projectSessions = getProjectLevelSessions(harnessSessionIndex, project.projectId)
      if (sessionsBySlug.size === 0 && projectSessions.length === 0) continue

      const section: ProjectFeatureSessionGroupSection =
        pinnedProjectId && project.projectId === pinnedProjectId ? "current" : "other"

      groups.push({
        key: `project:${project.projectId}`,
        project,
        section,
        projectSessions,
        featureGroups: makeFeatureGroups(project, sessionsBySlug, section)
      })
    }

    const unknownProjectIds = Array.from(
      new Set<string>([
        ...Array.from(harnessSessionIndex.byProjectSlug.keys()),
        ...Array.from(harnessSessionIndex.projectSessionsByProject.keys())
      ])
    ).sort((a, b) => a.localeCompare(b, "zh-CN"))

    for (const projectId of unknownProjectIds) {
      if (knownProjectIds.has(projectId)) continue
      const sessionsBySlug = harnessSessionIndex.byProjectSlug.get(projectId) ?? new Map()
      const projectSessions = getProjectLevelSessions(harnessSessionIndex, projectId)
      if (sessionsBySlug.size === 0 && projectSessions.length === 0) continue

      const firstProjectSessionThread = threadsById.get(projectSessions[0]?.threadId ?? "")
      const firstFeatureSessions = sessionsBySlug.values().next().value as
        | HarnessSessionBinding[]
        | undefined
      const firstFeatureThread = threadsById.get(firstFeatureSessions?.[0]?.threadId ?? "")
      const deletedProject = makeDeletedProjectSidebarItem(
        projectId,
        readThreadHarnessProjectName(firstProjectSessionThread ?? firstFeatureThread)
      )
      const section: ProjectFeatureSessionGroupSection =
        pinnedProjectId && projectId === pinnedProjectId ? "current" : "other"

      groups.push({
        key: `deleted-project:${projectId}`,
        project: deletedProject,
        section,
        projectSessions,
        featureGroups: makeFeatureGroups(deletedProject, sessionsBySlug, section, true),
        deleted: true
      })
    }

    if (!pinnedProjectId) return groups

    return groups
      .map((group, index) => {
        const priority = group.section === "current" ? 0 : group.section === "project" ? 1 : 2
        return { group, index, priority }
      })
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .map(({ group }) => group)
  }, [
    detailsByProjectId,
    harnessSessionIndex,
    isViewingSession,
    projects,
    selectedFeature,
    selectedProjectId,
    selectedProjectSession,
    threadsById
  ])

  // Automatic sidebar folding follows the same rule as group pinning: only
  // project/feature detail pages move the user's sidebar focus. Opening a
  // session should highlight the thread without collapsing unrelated groups.
  const autoCollapseFeature = selectedFeature && !isViewingSession ? selectedFeature : null
  const autoCollapseProjectId = autoCollapseFeature
    ? autoCollapseFeature.projectId
    : selectedProjectId && !selectedFeature && !selectedProjectSession && !isViewingSession
      ? selectedProjectId
      : null

  useEffect(() => {
    if (!autoCollapseProjectId) return

    setCollapsedFeatureKeys((current) => {
      const next = new Set(current)
      let changed = false

      for (const group of projectSidebarGroups) {
        const isCurrentProject = group.project.projectId === autoCollapseProjectId
        const currentFeatureGroup = autoCollapseFeature
          ? group.featureGroups.find(
              (featureGroup) => featureGroup.slug === autoCollapseFeature.slug
            )
          : null

        if (isCurrentProject) {
          if (next.delete(group.key)) changed = true
          if (currentFeatureGroup && next.delete(currentFeatureGroup.key)) changed = true
        } else if (!isCurrentProject && !next.has(group.key)) {
          next.add(group.key)
          changed = true
        }
      }

      return changed ? next : current
    })
  }, [
    autoCollapseFeature?.projectId,
    autoCollapseFeature?.slug,
    autoCollapseProjectId,
    projectSidebarGroups
  ])

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

  const confirmDeleteSidebarThread = useCallback(async (): Promise<void> => {
    if (!sidebarThreadToDelete) return
    try {
      const deletingThreadId = sidebarThreadToDelete.thread_id
      cleanupThread(sidebarThreadToDelete.thread_id)
      await deleteThread(sidebarThreadToDelete.thread_id)
      markRead(deletingThreadId)
      if (selectedProjectSessionRef.current?.threadId === deletingThreadId) {
        setSelectedProjectSession(null)
        setIsViewingSession(false)
      }
      setSidebarThreadToDelete(null)
    } catch (error) {
      toast.error(cleanIpcError(error))
      setSidebarThreadToDelete(null)
    }
  }, [cleanupThread, deleteThread, markRead, sidebarThreadToDelete])

  const handleCreateSidebarSession = useCallback(
    async (
      project: ProjectFeatureSidebarProject,
      slug: string,
      sessions: HarnessSessionBinding[]
    ): Promise<void> => {
      if (project.lifecycle.status === "deleted") return
      const key = `feature:${project.projectId}:${slug}`
      if (creatingSidebarSessionKey) return
      setCreatingSidebarSessionKey(key)
      try {
        const latestRunDetail = await window.api.harnessBoard.getRunDetail(project.projectId, slug)
        const thread = await createHarnessSession({
          projectId: project.projectId,
          slug,
          sessionWorkspacePath: project.sessionWorkspacePath,
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
        setSelectedProjectSession(null)
        setSelectedProjectId(project.projectId)
        setSelectedFeature({
          projectId: project.projectId,
          slug,
          activeSessionThreadId: thread.thread_id
        })
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
    [allThreadStates, createThread, creatingSidebarSessionKey, markRead, selectThread, threadsById]
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
    if (!viewing) {
      projectSidebarScrollIntentRef.current = "top"
    }
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
  const projectListSelected =
    selectedProjectId === null && selectedFeature === null && selectedProjectSession === null
  const sidebarPortal = sidebarPortalNode
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
            selectedProjectId={selectedProjectId}
            selectedFeature={selectedFeature}
            selectedProjectSession={selectedProjectSession}
            isViewingSession={isViewingSession}
            unreadIds={unreadIds}
            exportingThreadId={exportingThreadId}
            editingThreadId={editingThreadId}
            editingTitle={editingTitle}
            scrollTopRef={projectSidebarScrollTopRef}
            scrollIntentRef={projectSidebarScrollIntentRef}
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
            onSelectProjectSession={(projectId, threadId, deleted) => {
              openProjectSession(projectId, threadId, deleted)
              markRead(threadId)
              void selectThread(threadId, { preserveView: true })
            }}
            onSelectSession={(projectId, slug, threadId, deleted) => {
              openFeatureDetail(projectId, slug, threadId, deleted)
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

  const fallbackFeatureSummary = selectedFeatureProjectDetail?.runs.find(
    (run) => run.slug === selectedFeature?.slug
  )
  const featureDialogAdapter = useMemo(
    () => (featureDialogProject ? findAdapterForProject(featureDialogProject) : null),
    [featureDialogProject, findAdapterForProject]
  )
  const featurePublicConstraintsSyncing = featureDialogAdapter
    ? syncingProjectConstraintAdapterIds.has(featureDialogAdapter.id)
    : false

  useEffect(() => {
    if (selectedFeature) return
    onActiveSessionThreadChange?.(selectedProjectSession?.threadId ?? null)
  }, [onActiveSessionThreadChange, selectedFeature, selectedProjectSession?.threadId])

  if (selectedFeature) {
    const selectedFeatureDeleted = selectedFeature.deleted === true
    const selectedFeatureThread = threadsById.get(selectedFeature.activeSessionThreadId ?? "")
    return (
      <>
        <FeatureDetailPage
          detail={runDetailWithSessions}
          loading={loadingRun}
          unbound={showingUnboundRunDetail}
          projectDeleted={selectedFeatureDeleted}
          activeSessionThreadId={selectedFeature.activeSessionThreadId}
          isViewingSession={isViewingSession}
          hasPendingGitDiffNotice={hasPendingGitDiffNotice}
          fallbackProjectName={
            selectedFeatureDeleted
              ? readThreadHarnessProjectName(selectedFeatureThread)
              : (selectedFeatureProjectDetail?.project?.name ?? selectedProject?.name)
          }
          fallbackFeatureTitle={fallbackFeatureSummary?.title ?? selectedFeature.slug}
          onBackToList={handleBackToProjectList}
          onBackToProject={handleBackToProject}
          onEditDeployUnits={openFeatureDeployUnitEditDialog}
          onRefresh={refreshSelectedRunDetail}
          onActiveSessionChange={handleActiveSessionChange}
          onSessionViewChange={handleSessionViewChange}
          onActiveSessionThreadChange={onActiveSessionThreadChange}
          onRequestOpenGitPanel={onRequestOpenGitPanel}
          onDismissGitChangeNotice={onDismissGitChangeNotice}
          onThreadGitStatusChange={onThreadGitStatusChange}
        />
        <FeatureCreateDialog
          mode={featureDialogMode}
          project={featureDialogProject}
          featureName={featureName}
          workflowConfig={featureWorkflowConfig}
          workflowLoading={featureWorkflowLoading}
          workflowTemplate={featureWorkflowTemplate}
          selectedWorkflowNodeIds={selectedWorkflowNodeIds}
          agentsReadyDeployUnits={featureAgentsReadyDeployUnits}
          localAgentmdDeployUnitMappings={featureLocalAgentmdDeployUnitMappings}
          publicConstraintsSyncAvailable={featureDialogAdapter?.pullKnowledgeAvailable === true}
          syncingPublicConstraints={featurePublicConstraintsSyncing}
          deployUnitMappings={deployUnitMappings}
          deployUnitMappingsLoading={deployUnitMappingsLoading}
          selectedDeployUnitIds={selectedDeployUnitIds}
          creating={featureDialogSubmitting}
          error={featureError}
          onOpenChange={handleFeatureDialogOpenChange}
          onChange={setFeatureName}
          onWorkflowTemplateChange={handleWorkflowTemplateChange}
          onWorkflowNodeToggle={handleWorkflowNodeToggle}
          onDeployUnitToggle={handleDeployUnitToggle}
          onOpenDeployUnitSettings={handleOpenDeployUnitSettings}
          onSyncPublicConstraints={() => void handleSyncFeaturePublicConstraints()}
          onSubmit={handleSubmitFeatureDialog}
        />
        {sidebarDeleteDialog}
        {sidebarPortal}
      </>
    )
  }

  if (selectedProjectSession && selectedProjectSessionProject) {
    return (
      <>
        <ProjectSessionPage
          project={selectedProjectSessionProject}
          thread={selectedProjectSessionThread}
          deleted={selectedProjectSession.deleted}
          onBackToList={handleBackToProjectList}
          onBackToProject={handleBackToProject}
          hasPendingGitDiffNotice={hasPendingGitDiffNotice}
          onRequestOpenGitPanel={onRequestOpenGitPanel}
          onDismissGitChangeNotice={onDismissGitChangeNotice}
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
          enterpriseProjectDetail={selectedEnterpriseProjectDetail}
          pluginUpdateInfo={projectPluginUpdateInfoById.get(selectedProject.projectId)}
          updatingPlugin={updatingPluginNames.has(selectedProject.harnessAdapter.name)}
          projectReviewState={projectReviewState}
          loading={loadingDetailIds.has(selectedProject.projectId)}
          creatingFeature={creatingFeatureProjectId === selectedProject.projectId}
          creatingSystemConstraintUpdate={
            creatingProjectSessionProjectId === selectedProject.projectId
          }
          leanToken={leanTokenConfig.leanToken}
          leanTokenLoading={leanTokenLoading}
          onBackToList={handleBackToProjectList}
          onCreateFeature={openFeatureCreateDialog}
          onOpenSystemConstraintUpdate={(project, config) => {
            void handleOpenSystemConstraintUpdate(project, config)
          }}
          onRefresh={(projectId) => void loadProjectDetail(projectId)}
          onEditProject={handleEditProject}
          onUpdatePlugin={(project, updateInfo) => {
            void handleUpdateProjectPlugin(project, updateInfo)
          }}
          onOpenLeanTokenSettings={handleOpenDeployUnitSettings}
          onOpenFeature={openFeatureDetail}
        />
        <FeatureCreateDialog
          mode={featureDialogMode}
          project={featureDialogProject}
          featureName={featureName}
          workflowConfig={featureWorkflowConfig}
          workflowLoading={featureWorkflowLoading}
          workflowTemplate={featureWorkflowTemplate}
          selectedWorkflowNodeIds={selectedWorkflowNodeIds}
          agentsReadyDeployUnits={featureAgentsReadyDeployUnits}
          localAgentmdDeployUnitMappings={featureLocalAgentmdDeployUnitMappings}
          publicConstraintsSyncAvailable={featureDialogAdapter?.pullKnowledgeAvailable === true}
          syncingPublicConstraints={featurePublicConstraintsSyncing}
          deployUnitMappings={deployUnitMappings}
          deployUnitMappingsLoading={deployUnitMappingsLoading}
          selectedDeployUnitIds={selectedDeployUnitIds}
          creating={featureDialogSubmitting}
          error={featureError}
          onOpenChange={handleFeatureDialogOpenChange}
          onChange={setFeatureName}
          onWorkflowTemplateChange={handleWorkflowTemplateChange}
          onWorkflowNodeToggle={handleWorkflowNodeToggle}
          onDeployUnitToggle={handleDeployUnitToggle}
          onOpenDeployUnitSettings={handleOpenDeployUnitSettings}
          onSyncPublicConstraints={() => void handleSyncFeaturePublicConstraints()}
          onSubmit={handleSubmitFeatureDialog}
        />
        <ProjectEditDialog
          open={editingProject !== null}
          saving={savingEdit}
          form={editForm}
          registry={adapterRegistry}
          installingPluginNames={updatingPluginNames}
          error={editError}
          onOpenChange={(open) => {
            if (!open && !savingEdit) {
              setEditingProject(null)
            }
          }}
          onChange={setEditForm}
          onInstallPlugin={handleInstallMarketPlugin}
          onPickSessionWorkspace={() => void handlePickEditSessionWorkspace()}
          onSubmit={() => void handleSubmitEdit()}
        />
        <KnowledgeDialog
          open={knowledgeDialogOpen}
          onOpenChange={setKnowledgeDialogOpen}
          onSubmit={handleKnowledgeDialogSubmit}
          projectNumber={knowledgeDialogProject?.projectCode ?? ""}
          leanToken={leanTokenConfig.leanToken}
        />
        {sidebarDeleteDialog}
        {sidebarPortal}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-br from-background via-background to-muted/70">
      <div className={harnessPageHeaderClassName}>
        <div className={harnessPageHeaderContentClassName}>
          <div className="min-w-0">
            <div className="mt-2 flex w-[430px] max-w-[52vw] min-w-[260px] items-center gap-3 rounded-xl border border-border/80 bg-background-elevated/80 px-3 py-2 shadow-sm transition-colors focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/10">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目、系统编号或特性"
                aria-label="搜索项目、系统编号或特性"
                className="h-5 border-0 bg-transparent px-0 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
              />
            </div>
          </div>
          <div className={cn(harnessPageHeaderActionsClassName, "pt-2")}>
            <Button
              variant="ghost"
              size="sm"
              className={harnessDetailRefreshButtonClassName}
              onClick={() => void loadProjects()}
            >
              {loadingProjects ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
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
        <main className="w-full space-y-7 p-2">
          {loadError && (
            <div className="flex items-start gap-2 rounded-xl border border-status-critical/30 bg-status-critical/10 px-4 py-3 text-sm text-status-critical shadow-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>{loadError}</div>
            </div>
          )}

          <Tabs
            value={projectModeTab}
            onValueChange={handleProjectModeTabChange}
            className="space-y-6"
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="projects" className="gap-2">
                  <Workflow className="size-4" />
                  项目列表
                </TabsTrigger>
                <TabsTrigger value="settings" className="gap-2">
                  <Settings className="size-4" />
                  工程与精益配置
                </TabsTrigger>
                <TabsTrigger value="constraint-sync" className="gap-2">
                  <RefreshCw className="size-4" />
                  拉取公共系统约束
                </TabsTrigger>
              </TabsList>
              {projectModeTab === "projects" && (
                <div className="text-sm text-muted-foreground">{projects.length} 个项目</div>
              )}
            </div>

            <TabsContent value="projects" className="mt-0">
              {loadingProjects ? (
                <div
                  className={cn(
                    harnessSurfaceClassName,
                    "flex min-h-[320px] items-center justify-center text-muted-foreground"
                  )}
                >
                  <div className="flex items-center gap-3 rounded-full border border-border/70 bg-background/70 px-4 py-2 text-sm shadow-sm">
                    <Loader2 className="size-4 animate-spin text-status-info" />
                    正在同步项目看板
                  </div>
                </div>
              ) : projects.length === 0 ? (
                <div className="flex min-h-[360px] items-center justify-center">
                  <div
                    className={cn(
                      harnessSurfaceClassName,
                      "relative max-w-md overflow-hidden px-7 py-7 text-center"
                    )}
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-10 -top-24 h-48 rounded-full bg-status-info/10 blur-3xl"
                    />
                    <div className="relative mx-auto flex size-12 items-center justify-center rounded-2xl border border-status-info/20 bg-status-info/10 text-status-info shadow-sm">
                      <Workflow className="size-5" />
                    </div>
                    <div className="relative mt-4 text-base font-semibold">暂无项目</div>
                    <p className="relative mt-2 text-sm leading-6 text-muted-foreground">
                      新建第一个项目后，这里会自动聚合系统、特性进度和风险状态。
                    </p>
                    <Button
                      className={cn("relative mt-5 gap-2", harnessActionButtonClassName)}
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
                <div className="space-y-7">
                  {activeSystemGroups.length === 0 ? (
                    <div
                      className={cn(
                        harnessSurfaceClassName,
                        "border-dashed px-4 py-12 text-center text-sm text-muted-foreground"
                      )}
                    >
                      {query.trim() ? "没有匹配的活跃项目或 feature。" : "暂无活跃项目。"}
                    </div>
                  ) : (
                    <div>
                      {!loadingProjects && projects.length > 0 && (
                        <HarnessBoardOverview
                          stats={boardStats}
                          query={query}
                          visibleProjectCount={visibleProjectCount}
                        />
                      )}
                      <div className={"mt-2 space-y-2"}>
                        {activeSystemGroups.map((group) => (
                          <SystemSection
                            key={group.systemCode}
                            group={group}
                            detailsByProjectId={detailsByProjectId}
                            loadingDetailIds={loadingDetailIds}
                            archivingProjectId={archivingProjectId}
                            deletingProjectId={deletingProjectId}
                            pluginUpdateInfoByProjectId={projectPluginUpdateInfoById}
                            updatingPluginNames={updatingPluginNames}
                            onEditProject={handleEditProject}
                            onArchiveProject={requestArchiveProject}
                            onDeleteProject={requestDeleteProject}
                            onUpdateProjectPlugin={(project, updateInfo) =>
                              void handleUpdateProjectPlugin(project, updateInfo)
                            }
                            onProjectVisible={handleProjectCardVisible}
                            onOpenProject={openProjectDetail}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <section className={cn(harnessSurfaceClassName, "overflow-hidden p-3")}>
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className={harnessKickerClassName}>Archived lane</div>
                        <div className="mt-1 text-sm font-semibold">归档项目</div>
                      </div>
                      <div className="rounded-full border border-border/70 bg-background/70 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                        {archivedProjectCount} 个项目
                      </div>
                    </div>
                    <div className="mt-3">
                      {archivedProjects.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-border/70 bg-background/70 px-4 py-8 text-center text-sm text-muted-foreground">
                          {query.trim() ? "没有匹配的归档项目或 feature。" : "暂无归档项目。"}
                        </div>
                      ) : (
                        <ArchivedProjectsTable
                          projects={archivedProjects}
                          detailsByProjectId={detailsByProjectId}
                          onOpenProject={openProjectDetail}
                        />
                      )}
                    </div>
                  </section>
                </div>
              )}
            </TabsContent>

            <TabsContent value="settings" className="mt-0">
              <ProjectModeSettingsPanel
                mappings={deployUnitMappings}
                loading={deployUnitMappingsLoading}
                saving={deployUnitMappingsSaving}
                dirty={deployUnitMappingsDirty}
                error={deployUnitMappingsError}
                leanToken={leanTokenConfig.leanToken}
                leanTokenLoading={leanTokenLoading}
                leanTokenSaving={leanTokenSaving}
                leanTokenDirty={leanTokenDirty}
                leanTokenError={leanTokenError}
                onAdd={handleAddDeployUnitMapping}
                onRemove={handleRemoveDeployUnitMapping}
                onChange={handleChangeDeployUnitMapping}
                onPickPath={(index) => void handlePickDeployUnitRepoPath(index)}
                onSave={() => void handleSaveDeployUnitMappings()}
                onLeanTokenChange={handleLeanTokenChange}
                onSaveLeanToken={() => void handleSaveLeanTokenConfig()}
                onOpenLeanToken={handleOpenLeanToken}
              />
            </TabsContent>

            <TabsContent value="constraint-sync" className="mt-0">
              <ProjectConstraintSyncPanel
                registry={adapterRegistry}
                syncingAdapterIds={syncingProjectConstraintAdapterIds}
                syncedPaths={syncedProjectConstraintPaths}
                expandedAdapterIds={expandedKnowledgePreviewAdapterIds}
                knowledgePreviews={knowledgePreviewsByAdapterId}
                loadingKnowledgePreviewAdapterIds={loadingKnowledgePreviewAdapterIds}
                selectedKnowledgePreviewPaths={selectedKnowledgePreviewPaths}
                onSync={handleSyncProjectConstraints}
                onToggleKnowledgePreview={handleToggleKnowledgePreview}
                onRefreshKnowledgePreview={loadKnowledgePreview}
                onSelectKnowledgePreviewPath={handleSelectKnowledgePreviewPath}
              />
            </TabsContent>
          </Tabs>
        </main>
      </ScrollArea>

      <FeatureCreateDialog
        mode={featureDialogMode}
        project={featureDialogProject}
        featureName={featureName}
        workflowConfig={featureWorkflowConfig}
        workflowLoading={featureWorkflowLoading}
        workflowTemplate={featureWorkflowTemplate}
        selectedWorkflowNodeIds={selectedWorkflowNodeIds}
        agentsReadyDeployUnits={featureAgentsReadyDeployUnits}
        localAgentmdDeployUnitMappings={featureLocalAgentmdDeployUnitMappings}
        publicConstraintsSyncAvailable={featureDialogAdapter?.pullKnowledgeAvailable === true}
        syncingPublicConstraints={featurePublicConstraintsSyncing}
        deployUnitMappings={deployUnitMappings}
        deployUnitMappingsLoading={deployUnitMappingsLoading}
        selectedDeployUnitIds={selectedDeployUnitIds}
        creating={featureDialogSubmitting}
        error={featureError}
        onOpenChange={handleFeatureDialogOpenChange}
        onChange={setFeatureName}
        onWorkflowTemplateChange={handleWorkflowTemplateChange}
        onWorkflowNodeToggle={handleWorkflowNodeToggle}
        onDeployUnitToggle={handleDeployUnitToggle}
        onOpenDeployUnitSettings={handleOpenDeployUnitSettings}
        onSyncPublicConstraints={() => void handleSyncFeaturePublicConstraints()}
        onSubmit={handleSubmitFeatureDialog}
      />
      <ProjectFormDialog
        open={dialogOpen}
        creating={creating}
        form={form}
        registry={adapterRegistry}
        installingPluginNames={updatingPluginNames}
        error={formError}
        onOpenChange={handleCreateDialogOpenChange}
        onChange={setForm}
        onInstallPlugin={handleInstallMarketPlugin}
        onPickWorkspace={() => void handlePickWorkspace()}
        onPickSessionWorkspace={() => void handlePickSessionWorkspace()}
        onSubmit={() => void handleSubmit()}
      />
      <ProjectEditDialog
        open={editingProject !== null}
        saving={savingEdit}
        form={editForm}
        registry={adapterRegistry}
        installingPluginNames={updatingPluginNames}
        error={editError}
        onOpenChange={(open) => {
          if (!open && !savingEdit) {
            setEditingProject(null)
          }
        }}
        onChange={setEditForm}
        onInstallPlugin={handleInstallMarketPlugin}
        onPickSessionWorkspace={() => void handlePickEditSessionWorkspace()}
        onSubmit={() => void handleSubmitEdit()}
      />
      <ProjectActionConfirmDialog
        action={pendingProjectAction}
        busy={projectActionBusy}
        onOpenChange={(open) => {
          if (!open && !projectActionBusy) {
            setPendingProjectAction(null)
          }
        }}
        onConfirm={handleConfirmProjectAction}
      />
      <KnowledgeDialog
        open={knowledgeDialogOpen}
        onOpenChange={setKnowledgeDialogOpen}
        onSubmit={handleKnowledgeDialogSubmit}
        projectNumber={knowledgeDialogProject?.projectCode ?? ""}
        leanToken={leanTokenConfig.leanToken}
      />
      {sidebarDeleteDialog}
      {sidebarPortal}
    </div>
  )
}
