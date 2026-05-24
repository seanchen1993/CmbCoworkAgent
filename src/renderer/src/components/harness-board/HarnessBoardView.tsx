import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  AlertCircle,
  ArrowLeft,
  Archive,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  FileText,
  FolderOpen,
  GitBranch,
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
  Workflow
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
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TabbedPanel } from "@/components/tabs"
import { ThreadListItem } from "@/components/sidebar/ThreadSidebar"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  useAllStreamLoadingStates,
  useAllThreadStates,
  useThreadContext
} from "@/lib/thread-context"
import { toast } from "sonner"
import type {
  HarnessArtifact,
  HarnessHookLogView,
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadataUpdateInput,
  HarnessFeatureSummary,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessSessionBinding,
  HarnessAdapterRegistryItem,
  HarnessStatus,
  Thread
} from "@/types"
import { HARNESS_SOURCE } from "../../../../shared/harness-board-types"

const harnessActionButtonClassName =
  "cursor-pointer group relative overflow-hidden rounded-md shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md"
const harnessActionOverlayClassName =
  "pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-primary-foreground/10 to-primary-foreground/25 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
const harnessActionIconClassName =
  "relative flex size-4 items-center justify-center rounded-full bg-primary-foreground/15 ring-1 ring-primary-foreground/25 transition-transform duration-200 group-hover:scale-105"
const harnessNamePattern = /^[\u4e00-\u9fffA-Za-z0-9]+$/u
const harnessNameRuleMessage = "仅支持中文、英文字母和数字，不允许空格或特殊符号"

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
    description: "",
    product: {
      code: "",
      name: ""
    },
    workspace: {
      path: ""
    }
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
  initialSessionThreadId?: string
}

interface ProjectFeatureSessionGroup {
  key: string
  project: HarnessProjectListItem
  run: HarnessFeatureSummary
  sessions: HarnessSessionBinding[]
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

type ThreadWorkspaceStateMap = Record<string, { workspacePath?: string | null } | undefined>

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

function normalizeWorkspacePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function getThreadWorkspacePath(thread: Thread | null | undefined): string | null {
  return normalizeWorkspacePath(thread?.metadata?.workspacePath)
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
  titleSource: string
  sessions: HarnessSessionBinding[]
  threadsById: Map<string, Thread>
  threadStates: ThreadWorkspaceStateMap
  createThread: (
    config: {
      title: string
      workspacePath: string | null
      harnessFeature: { projectId: string; slug: string; source: string }
    },
    options?: { preserveView?: boolean }
  ) => Promise<Thread>
}

async function createHarnessSession(params: CreateHarnessSessionParams): Promise<Thread> {
  const { projectId, slug, titleSource, sessions, threadsById, threadStates, createThread } = params
  const workspacePath = await getLatestSessionWorkspacePath(sessions, threadsById, threadStates)
  const thread = await createThread(
    {
      title: `特性: ${titleSource}`,
      workspacePath,
      harnessFeature: { projectId, slug, source: HARNESS_SOURCE }
    },
    { preserveView: true }
  )
  await window.api.harnessBoard.linkSession({ projectId, slug, threadId: thread.thread_id })
  return thread
}

function metadataRequiredMissing(form: HarnessProjectMetadataUpdateInput): boolean {
  return [
    form.adapterId,
    form.adapterType,
    form.name,
    form.projectCode,
    form.description,
    form.product.code,
    form.product.name,
    form.workspace.path
  ].some((value) => !value.trim())
}

function getHarnessNameError(label: string, value: string): string | null {
  if (!value.trim()) return null
  return harnessNamePattern.test(value) ? null : `${label}${harnessNameRuleMessage}`
}

function getProjectMetadataNameError(form: HarnessProjectMetadataUpdateInput): string | null {
  return getHarnessNameError("项目名称", form.name) ?? getHarnessNameError("项目编号", form.projectCode)
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
    description: project.description,
    product: {
      code: project.productCode,
      name: project.productName
    },
    workspace: {
      path: project.workspacePath
    }
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

function StatusPill({ status }: { status: HarnessStatus }): React.JSX.Element {
  return (
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
}

function statusIcon(status: HarnessStatus): React.JSX.Element {
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">选择 Plugin </div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <Select
                value={form.adapterId}
                onValueChange={(adapterId) => onChange({ ...form, adapterId, adapterType: "plugin" })}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="请选择已安装的 AUTOBIZDEVOPS 插件" />
                </SelectTrigger>
                <SelectContent>
                  {registry.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.name} · {adapter.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">项目信息</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称 *
                <Input
                  value={form.name}
                  onChange={(event) => onChange({ ...form, name: event.target.value })}
                  placeholder="请输入"
                  className="bg-background"
                  aria-invalid={projectNameError ? true : undefined}
                />
                {projectNameError && <span className="text-status-critical">{projectNameError}</span>}
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编号 *
                <Input
                  value={form.projectCode}
                  onChange={(event) => onChange({ ...form, projectCode: event.target.value })}
                  placeholder="请输入"
                  className="bg-background"
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
                  className="bg-background"
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
                  value={form.product.code}
                  onChange={(event) =>
                    onChange({ ...form, product: { ...form.product, code: event.target.value } })
                  }
                  placeholder="请输入"
                  className="bg-background"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统名称 *
                <Input
                  value={form.product.name}
                  onChange={(event) =>
                    onChange({ ...form, product: { ...form.product, name: event.target.value } })
                  }
                  placeholder="请输入"
                  className="bg-background"
                />
              </label>
              <div className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目工作区 *
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={form.workspace.path}
                    readOnly
                    placeholder="请选择 AUTOBIZDEVOPS 插件工作区路径"
                    className="bg-background"
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
            </div>
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
            disabled={creating || metadataRequiredMissing(form) || metadataNameInvalid(form)}
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
  onPickWorkspace,
  onSubmit
}: {
  open: boolean
  saving: boolean
  form: HarnessProjectMetadataUpdateInput
  registry: HarnessAdapterRegistryItem[]
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectMetadataUpdateInput) => void
  onPickWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const projectNameError = getHarnessNameError("项目名称", form.name)
  const projectCodeError = getHarnessNameError("项目编号", form.projectCode)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">选择 Plugin </div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <Select
                value={form.adapterId}
                onValueChange={(adapterId) => onChange({ ...form, adapterId, adapterType: "plugin" })}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="请选择已安装的 AUTOBIZDEVOPS 插件" />
                </SelectTrigger>
                <SelectContent>
                  {registry.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.name} · {adapter.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">项目信息</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称 *
                <Input
                  value={form.name}
                  onChange={(event) => onChange({ ...form, name: event.target.value })}
                  placeholder="请输入"
                  className="bg-background"
                  aria-invalid={projectNameError ? true : undefined}
                />
                {projectNameError && <span className="text-status-critical">{projectNameError}</span>}
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编号 *
                <Input
                  value={form.projectCode}
                  onChange={(event) => onChange({ ...form, projectCode: event.target.value })}
                  placeholder="请输入"
                  className="bg-background"
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
                  className="bg-background"
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
                  value={form.product.code}
                  onChange={(event) =>
                    onChange({ ...form, product: { ...form.product, code: event.target.value } })
                  }
                  placeholder="请输入"
                  className="bg-background"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                系统名称 *
                <Input
                  value={form.product.name}
                  onChange={(event) =>
                    onChange({ ...form, product: { ...form.product, name: event.target.value } })
                  }
                  placeholder="请输入"
                  className="bg-background"
                />
              </label>
              <div className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目工作区 *
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={form.workspace.path}
                    readOnly
                    placeholder="请选择 AUTOBIZDEVOPS 插件工作区路径"
                    className="bg-background"
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
      <DialogContent className="max-w-md">
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
              onChange={(event) => onChange(event.target.value)}
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

  return (
    <button
      type="button"
      className="flex h-[112px] w-full flex-col gap-2 rounded-md border border-border bg-background px-3 py-3 text-left transition-all hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
        <span className="truncate">{currentNodeLabel}</span>
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
  const archived = project.lifecycle.status === "archived"
  return (
    <div className="flex min-w-0 items-center gap-2">
      {children}
      <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {project.projectCode}
      </span>
      {archived && (
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
          已归档
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
  onEditProject,
  onArchiveProject,
  onOpenProject
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  loading: boolean
  archiving: boolean
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onOpenProject: (projectId: string) => void
}): React.JSX.Element {
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"

  return (
    <article
      role="button"
      tabIndex={0}
      className={cn(
        "w-[420px] flex-none cursor-pointer overflow-hidden rounded-md border border-border border-t-[3px] shadow-sm transition-all hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
          <div className="flex shrink-0 items-center gap-1">
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
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
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
            工作区
            <strong
              className="mt-1 block truncate text-sm text-foreground"
              title={project.workspacePath}
            >
              {getWorkspaceName(project.workspacePath)}
            </strong>
          </div>
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
  onEditProject,
  onArchiveProject,
  onOpenProject
}: {
  group: SystemGroup
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
  loadingDetailIds: Set<string>
  archivingProjectId: string | null
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
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
      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="flex w-max gap-4 px-1">
          {group.projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              detail={detailsByProjectId[project.projectId]}
              loading={loadingDetailIds.has(project.projectId)}
              archiving={archivingProjectId === project.projectId}
              onEditProject={onEditProject}
              onArchiveProject={onArchiveProject}
              onOpenProject={onOpenProject}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function artifactCanOpenInFileManager(artifact: HarnessArtifact): boolean {
  if (!artifact.path) return false
  if (artifact.kind === "external" || artifact.kind === "virtual") return false
  return artifact.status.uiKind === "done" || artifact.status.uiKind === "ok" || artifact.exists === true
}

function ArtifactLine({
  artifact,
  workspacePath
}: {
  artifact: HarnessArtifact
  workspacePath: string
}): React.JSX.Element {
  const artifactPath = artifact.path ?? artifact.kind
  const artifactSummary = artifact.summary ?? "-"
  const canOpenArtifact = artifactCanOpenInFileManager(artifact)

  const openArtifactInFileManager = async (): Promise<void> => {
    if (!artifact.path) return
    try {
      const fullPath = resolveWorkspaceFilePath(artifact.path, workspacePath)
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
    <div className="grid grid-cols-[18px_minmax(140px,1fr)_90px_minmax(160px,1.5fr)_28px] items-start gap-x-3 gap-y-2 border-t border-border px-3 py-3 text-sm">
      <FileText className="row-span-2 mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate font-medium" title={artifact.label}>{artifact.label}</div>
      </div>
      <StatusPill status={artifact.status} />
      <div className="min-w-0 text-xs leading-5 text-muted-foreground">
        <div className="truncate" title={artifactSummary}>{artifactSummary}</div>
        {artifact.validation && (
          <div className="truncate" title={artifact.validation.message}>{artifact.validation.message}</div>
        )}
      </div>
      {canOpenArtifact ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title="在文件管理器中打开"
          onClick={() => void openArtifactInFileManager()}
        >
          <FolderOpen className="size-3.5" />
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      <div
        className="col-span-4 min-w-0 break-all rounded border border-border/70 bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-5 text-muted-foreground"
        title={artifactPath}
      >
        {artifactPath}
      </div>
    </div>
  )
}

function HookLine({ hook }: { hook: HarnessHookLogView }): React.JSX.Element {
  const metaItems = [
    hook.ts,
    hook.event,
    hook.decision ? `decision: ${hook.decision}` : "",
    typeof hook.exitCode === "number" ? `exit ${hook.exitCode}` : ""
  ].filter((item): item is string => Boolean(item))

  return (
    <div className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-2 border-t border-border px-3 py-3 text-sm">
      {statusIcon(hook.status)}
      <div className="min-w-0">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium" title={hook.label}>{hook.label}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground" title={hook.hookId}>
              {hook.hookId}
            </div>
          </div>
          <StatusPill status={hook.status} />
        </div>
        <div className="mt-2 min-w-0 text-xs leading-5 text-muted-foreground">
          <div className="break-words">{hook.summary}</div>
          {metaItems.length > 0 && (
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1">
              {metaItems.map((item) => (
                <span key={item} className="truncate font-mono text-[11px]" title={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
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
  threadId
}: {
  threadId: string | null
}): React.JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-background">
      {threadId ? (
        <div className="flex min-h-0 flex-1">
          <TabbedPanel threadId={threadId} showTabBar={false} hideWelcomeSkillTabs />
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
          <span className="truncate">代码变更</span>
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
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {getWorkspaceName(group.workspacePath)}
                  </div>
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background/90 px-6 py-4 app-no-drag">
        <div className="flex items-start justify-between gap-4">
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
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={() => onRefresh(project.projectId)}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            {!archived && (
              <Button
                size="sm"
                className={cn("gap-2", harnessActionButtonClassName)}
                onClick={() => onCreateFeature(project)}
                disabled={creatingFeature}
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
            <Button
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={() => onEditProject(project)}
            >
              <Pencil className="size-4" />
              编辑项目信息
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto max-w-7xl space-y-5 p-6">
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
                    <dd className="mt-1 truncate font-medium" title={project.productCode}>
                      {project.productCode}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">系统名称</dt>
                    <dd className="mt-1 truncate font-medium" title={project.productName}>
                      {project.productName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">工作区</dt>
                    <dd className="mt-1 truncate font-medium" title={project.workspacePath}>
                      {getWorkspaceName(project.workspacePath)}
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
                    <StatusPill status={detail.projectState} />
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
                        workflowNodes={detail.workflow.nodes}
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
  initialSessionThreadId,
  onBackToList,
  onBackToProject,
  onRefresh,
  onSessionLinked,
  onSessionViewChange
}: {
  detail: HarnessRunDetailViewModel | null
  loading: boolean
  initialSessionThreadId?: string
  onBackToList: () => void
  onBackToProject: () => void
  onRefresh: () => void
  onSessionLinked: () => Promise<void>
  onSessionViewChange?: (viewing: boolean) => void
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
  const [activeDetailTab, setActiveDetailTab] = useState<"feature" | "session">("feature")

  useEffect(() => {
    if (!detail) {
      setSelectedSessionState({ detailKey: "", threadId: null })
      return
    }

    const initialThreadId =
      initialSessionThreadId &&
      detail.sessions.some((session) => session.threadId === initialSessionThreadId)
        ? initialSessionThreadId
        : null
    const firstThreadId = initialThreadId ?? detail.sessions[0]?.threadId ?? null
    setSelectedSessionState((current) => {
      if (current.detailKey !== detailKey) {
        return { detailKey, threadId: firstThreadId }
      }
      if (initialThreadId && current.threadId !== initialThreadId) {
        return { detailKey, threadId: initialThreadId }
      }
      if (
        current.threadId &&
        detail.sessions.some((session) => session.threadId === current.threadId)
      ) {
        return current
      }
      return { detailKey, threadId: firstThreadId }
    })
  }, [detail, detailKey, initialSessionThreadId])

  useEffect(() => {
    setActiveDetailTab(initialSessionThreadId ? "session" : "feature")
  }, [detailKey, initialSessionThreadId])

  useEffect(() => {
    onSessionViewChange?.(activeDetailTab === "session")
  }, [activeDetailTab, onSessionViewChange])

  const selectedSessionThreadId =
    selectedSessionState.detailKey === detailKey ? selectedSessionState.threadId : null

  useEffect(() => {
    if (activeDetailTab !== "session") return
    if (!selectedSessionThreadId) return
    void selectThread(selectedSessionThreadId, { preserveView: true })
  }, [activeDetailTab, selectThread, selectedSessionThreadId])

  const handleCreateSession = useCallback(async (): Promise<void> => {
    if (!detail || sessionBusy) return
    setSessionBusy("create")
    try {
      const thread = await createHarnessSession({
        projectId: detail.project.projectId,
        slug: detail.run.slug,
        titleSource: detail.run.title,
        sessions: detail.sessions,
        threadsById,
        threadStates: allThreadStates,
        createThread
      })
      setSelectedSessionState({ detailKey, threadId: thread.thread_id })
      setActiveDetailTab("session")
      try {
        await onSessionLinked()
      } catch {
        // refresh failed but session already created — non-critical
      }
    } catch (error) {
      toast.error(cleanIpcError(error))
    } finally {
      setSessionBusy(null)
    }
  }, [allThreadStates, createThread, detail, detailKey, onSessionLinked, sessionBusy, threadsById])

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
            "w-[210px] rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            selected
              ? "border-status-info bg-status-info/10 shadow-sm"
              : "border-border bg-background hover:border-primary/45"
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {statusIcon(node.status)}
            <span className="truncate text-sm font-medium">{node.label}</span>
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
                      "flex h-[92px] w-[190px] flex-none flex-col gap-2 rounded-md border px-3 py-3 text-left transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
      <div className="shrink-0 border-b border-border bg-background/90 px-6 py-4 app-no-drag">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <HarnessBreadcrumb
              project={detail ? { name: detail.project.name } : null}
              featureTitle={detail?.run.title ?? "特性详情"}
              sessionTitle={
                activeDetailTab === "session" && selectedSessionThreadId
                  ? threadsById.get(selectedSessionThreadId)?.title
                  : undefined
              }
              onBack={activeDetailTab === "session" ? () => setActiveDetailTab("feature") : onBackToProject}
              onProjectList={onBackToList}
              onProject={onBackToProject}
              onFeature={activeDetailTab === "session" ? () => setActiveDetailTab("feature") : undefined}
            />
            <div className="flex min-w-0 items-center gap-2">
              <Workflow className="size-4 shrink-0 text-status-info" />
              <h1 className="truncate text-base font-semibold">
                {detail?.run.title ?? "特性详情"}
              </h1>
              {detail?.adapterSnapshot.mock && (
                <span className="shrink-0 rounded border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                  Mock
                </span>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {detail ? `${detail.project.name} · ${detail.run.slug}` : "加载中"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-2"
              onClick={onRefresh}
              disabled={loading || !detail}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            <Button
              type="button"
              size="sm"
              className={cn("gap-2", harnessActionButtonClassName)}
              onClick={() => void handleCreateSession()}
              disabled={loading || !detail || sessionBusy !== null}
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
        </div>
      </div>

      {loading || !detail ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" />
          读取特性详情
        </div>
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col overflow-hidden p-6">
          {activeDetailTab === "feature" ? (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-5">
                <div className="min-w-0 space-y-4">
                  {renderStageNodeStrip()}

                  {selectedNode ? (
                    <StageArtifactPanel node={selectedNode} workspacePath={detail.project.workspacePath} />
                  ) : (
                    <section className="rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                      暂无阶段数据。
                    </section>
                  )}
                </div>

                <aside className="min-w-0 space-y-4">
                  <FeatureWorkspaceChangesPanel sessions={detail.sessions} threadsById={threadsById} />

                  <section className="rounded-md border border-border bg-background">
                    <div className="border-b border-border px-3 py-3 text-sm font-semibold">Hook 事件</div>
                    {selectedNode && selectedNode.hooks.length > 0 ? (
                      <div className="max-h-64 overflow-y-auto">
                        {selectedNode.hooks.map((hook, index) => (
                          <HookLine key={`${hook.ts ?? "hook"}-${hook.hookId}-${index}`} hook={hook} />
                        ))}
                      </div>
                    ) : (
                      <div className="px-3 py-6 text-sm text-muted-foreground">
                        当前阶段暂无 Hook 事件。
                      </div>
                    )}
                  </section>
                </aside>
              </div>
            </div>
          ) : (
            <FeatureConversationPanel threadId={selectedSessionThreadId} />
          )}
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
  exportingThreadId,
  editingThreadId,
  editingTitle,
  onToggleCollapse,
  onToggleAll,
  onCreateSession,
  onSelectSession,
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
  exportingThreadId: string | null
  editingThreadId: string | null
  editingTitle: string
  onToggleCollapse: (key: string) => void
  onToggleAll: () => void
  onCreateSession: (project: HarnessProjectListItem, run: HarnessFeatureSummary, sessions: HarnessSessionBinding[]) => void
  onSelectSession: (projectId: string, slug: string, threadId: string) => void
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
          {groups.map((group) => {
            const isCollapsed = collapsedKeys.has(group.key)
            const selected =
              selectedFeature?.projectId === group.project.projectId &&
              selectedFeature.slug === group.run.slug
            const creatingSession = creatingSessionKey === group.key

            return (
              <div key={group.key} className="space-y-1">
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
                      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={group.run.title}>
                        {group.run.title}
                      </span>
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
                          void onCreateSession(group.project, group.run, group.sessions)
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

                        return (
                          <ThreadListItem
                            key={thread.thread_id}
                            thread={thread}
                            isLoading={isLoading}
                            hasPendingApproval={hasPendingApproval}
                            scheduledTaskLoading={scheduledTaskLoading}
                            isExporting={exportingThreadId === thread.thread_id}
                            isSelected={highlightThreadId === thread.thread_id}
                            isEditing={editingThreadId === thread.thread_id}
                            isUnread={false}
                            editingTitle={editingTitle}
                            hoverTitle={`所属项目：${group.project.name}`}
                            onSelect={() => onSelectSession(group.project.projectId, group.run.slug, thread.thread_id)}
                            onRunFinished={() => {}}
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

export function HarnessBoardView(): React.JSX.Element {
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [detailsByProjectId, setDetailsByProjectId] = useState<Record<string, HarnessProjectDetailViewModel>>({})
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set())
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null)
  const [isViewingSession, setIsViewingSession] = useState(false)
  const [runDetail, setRunDetail] = useState<HarnessRunDetailViewModel | null>(null)
  const [adapterRegistry, setAdapterRegistry] = useState<HarnessAdapterRegistryItem[]>([])
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const {
    threads,
    createThread,
    selectThread,
    updateThread,
    deleteThread
  } = useAppStore()
  const { cleanupThread } = useThreadContext()
  const allThreadStates = useAllThreadStates()
  const allStreamLoadingStates = useAllStreamLoadingStates()
  const [collapsedFeatureKeys, setCollapsedFeatureKeys] = useState<Set<string>>(new Set())
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState("")
  const [exportingThreadId, setExportingThreadId] = useState<string | null>(null)
  const [sidebarThreadToDelete, setSidebarThreadToDelete] = useState<Thread | null>(null)
  const [creatingSidebarSessionKey, setCreatingSidebarSessionKey] = useState<string | null>(null)
  const creatingFeatureRef = useRef(false)
  const selectedFeatureRef = useRef(selectedFeature)
  selectedFeatureRef.current = selectedFeature

  const loadProjectDetail = useCallback(async (projectId: string) => {
    setLoadingDetailIds((current) => new Set(current).add(projectId))
    setLoadError(null)
    try {
      const detail = await window.api.harnessBoard.getProjectDetail(projectId)
      setDetailsByProjectId((current) => ({ ...current, [projectId]: detail }))
    } catch (error) {
      setLoadError(cleanIpcError(error))
    } finally {
      setLoadingDetailIds((current) => {
        const next = new Set(current)
        next.delete(projectId)
        return next
      })
    }
  }, [])

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true)
    setLoadError(null)
    try {
      const [items, registry] = await Promise.all([
        window.api.harnessBoard.listProjects(),
        window.api.harnessBoard.registry()
      ])
      setProjects(items)
      setAdapterRegistry(registry)
      for (const item of items) {
        void loadProjectDetail(item.projectId)
      }
      setSelectedProjectId((current) =>
        current && items.some((item) => item.projectId === current) ? current : null
      )
    } catch (error) {
      setLoadError(cleanIpcError(error))
    } finally {
      setLoadingProjects(false)
    }
  }, [loadProjectDetail])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!selectedFeature) {
      setRunDetail(null)
      return
    }
    setLoadingRun(true)
    window.api.harnessBoard
      .getRunDetail(selectedFeature.projectId, selectedFeature.slug)
      .then(setRunDetail)
      .catch((error) => setLoadError(cleanIpcError(error)))
      .finally(() => setLoadingRun(false))
  }, [selectedFeature])

  useEffect(() => {
    return window.api.harnessBoard.onWatchRefsChanged((event) => {
      const projectMatch = event.scopeKey.match(/^project:(.+)$/)
      if (projectMatch) {
        void loadProjectDetail(projectMatch[1])
      }
      if (
        selectedFeature &&
        event.scopeKey === `run:${selectedFeature.projectId}:${selectedFeature.slug}`
      ) {
        const capturedProjectId = selectedFeature.projectId
        const capturedSlug = selectedFeature.slug
        void window.api.harnessBoard
          .getRunDetail(capturedProjectId, capturedSlug)
          .then((detail) => {
            const current = selectedFeatureRef.current
            if (
              current &&
              current.projectId === capturedProjectId &&
              current.slug === capturedSlug
            ) {
              setRunDetail(detail)
            }
          })
      }
    })
  }, [loadProjectDetail, selectedFeature])

  const refreshSelectedRunDetail = useCallback(async (): Promise<void> => {
    if (!selectedFeature) return
    const detail = await window.api.harnessBoard.getRunDetail(
      selectedFeature.projectId,
      selectedFeature.slug
    )
    setRunDetail(detail)
  }, [selectedFeature])

  const refreshSelectedFeatureSessionData = useCallback(async (): Promise<void> => {
    if (!selectedFeature) return
    await Promise.all([
      refreshSelectedRunDetail(),
      loadProjectDetail(selectedFeature.projectId)
    ])
  }, [loadProjectDetail, refreshSelectedRunDetail, selectedFeature])

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
          project.productCode,
          project.productName,
          project.harnessAdapter.name,
          ...(detail?.runs.map((run) => `${run.title} ${run.slug} ${run.summary.text}`) ?? [])
        ]
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(normalizedQuery)) continue
      }

      const targetMap = project.lifecycle.status === "archived" ? archivedMap : activeMap
      const existing = targetMap.get(project.productCode)
      if (existing) {
        existing.projects.push(project)
      } else {
        targetMap.set(project.productCode, {
          systemCode: project.productCode,
          systemName: project.productName,
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
      setForm((current) => ({ ...current, workspace: { path: workspacePath } }))
    }
  }

  const handlePickEditWorkspace = async (): Promise<void> => {
    const workspacePath = await window.api.workspace.select()
    if (workspacePath) {
      setEditForm((current) => ({ ...current, workspace: { path: workspacePath } }))
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
      void loadProjectDetail(projectId)
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
    const feature = featureName.trim()
    if (!feature) {
      setFeatureError("特性名称不能为空")
      return
    }
    const featureNameError = getHarnessNameError("特性名称", featureName)
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
      const thread = await createThread(
        {
          title: `特性: ${result.title || result.slug}`,
          workspacePath: result.workspacePath,
          harnessFeature: {
            projectId: result.projectId,
            slug: result.slug,
            source: HARNESS_SOURCE
          }
        },
        { preserveView: true }
      )
      await window.api.harnessBoard.linkSession({
        projectId: result.projectId,
        slug: result.slug,
        threadId: thread.thread_id
      })

      setFeatureDialogProject(null)
      setFeatureName("")
      await loadProjectDetail(result.projectId)
      setSelectedProjectId(result.projectId)
      setSelectedFeature({
        projectId: result.projectId,
        slug: result.slug,
        initialSessionThreadId: thread.thread_id
      })
    } catch (error) {
      setFeatureError(cleanIpcError(error))
    } finally {
      creatingFeatureRef.current = false
      setCreatingFeatureProjectId(null)
    }
  }, [
    createThread,
    featureDialogProject,
    featureName,
    loadProjectDetail
  ])

  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.thread_id, thread])), [threads])
  const threadIdSetRef = useRef<Set<string>>(new Set())
  const threadIdSet = useMemo(() => {
    const next = new Set(threads.map((t) => t.thread_id))
    const prev = threadIdSetRef.current
    if (prev.size === next.size && [...next].every((id) => prev.has(id))) {
      return prev
    }
    threadIdSetRef.current = next
    return next
  }, [threads])
  const selectedProject =
    selectedProjectId ? projects.find((project) => project.projectId === selectedProjectId) ?? null : null
  const selectedProjectDetail = selectedProjectId ? detailsByProjectId[selectedProjectId] : undefined

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

  const openFeatureDetail = useCallback(
    (projectId: string, slug: string, initialSessionThreadId?: string): void => {
      setSelectedProjectId(projectId)
      setSelectedFeature({ projectId, slug, initialSessionThreadId })
      setIsViewingSession(!!initialSessionThreadId)
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
    const visibleProjects = selectedProjectId
      ? projects.filter((project) => project.projectId === selectedProjectId)
      : projects

    for (const project of visibleProjects) {
      const detail = detailsByProjectId[project.projectId]
      if (!detail) continue

      for (const run of detail.runs) {
        if (
          selectedFeature &&
          (project.projectId !== selectedFeature.projectId || run.slug !== selectedFeature.slug)
        ) {
          continue
        }

        const sessions = (detail.sessionsBySlug[run.slug] ?? []).filter((session) =>
          threadIdSet.has(session.threadId)
        )
        if (!selectedProjectId && sessions.length === 0) continue
        groups.push({
          key: `${project.projectId}:${run.slug}`,
          project,
          run,
          sessions
        })
      }
    }

    return groups
  }, [detailsByProjectId, projects, selectedFeature, selectedProjectId, threadIdSet])

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
        const feature = sidebarThreadToDelete.metadata?.harnessFeature as Record<string, unknown> | undefined
        const projectId = typeof feature?.projectId === "string" ? feature.projectId : null
        setSidebarThreadToDelete(null)
        if (projectId) {
          await loadProjectDetail(projectId)
        }
        if (
          selectedFeature &&
          projectId === selectedFeature.projectId &&
          typeof feature?.slug === "string" &&
          feature.slug === selectedFeature.slug
        ) {
          await refreshSelectedRunDetail()
        }
      } catch (error) {
        toast.error(cleanIpcError(error))
        setSidebarThreadToDelete(null)
      }
    },
    [
      cleanupThread,
      deleteThread,
      loadProjectDetail,
      refreshSelectedRunDetail,
      selectedFeature,
      sidebarThreadToDelete
    ]
  )

  const handleCreateSidebarSession = useCallback(
    async (
      project: HarnessProjectListItem,
      run: HarnessFeatureSummary,
      sessions: HarnessSessionBinding[]
    ): Promise<void> => {
      const key = `${project.projectId}:${run.slug}`
      if (creatingSidebarSessionKey) return
      setCreatingSidebarSessionKey(key)
      try {
        const thread = await createHarnessSession({
          projectId: project.projectId,
          slug: run.slug,
          titleSource: run.title || run.slug,
          sessions,
          threadsById,
          threadStates: allThreadStates,
          createThread
        })
        await loadProjectDetail(project.projectId)
        openFeatureDetail(project.projectId, run.slug, thread.thread_id)
      } catch (error) {
        toast.error(cleanIpcError(error))
      } finally {
        setCreatingSidebarSessionKey(null)
      }
    },
    [allThreadStates, createThread, creatingSidebarSessionKey, loadProjectDetail, openFeatureDetail, threadsById]
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

  const sidebarPortalNode = document.getElementById("harness-sidebar-portal")
  const sidebarPortal =
    sidebarPortalNode
      ? createPortal(
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
            onCreateSession={(project, run, sessions) => {
              void handleCreateSidebarSession(project, run, sessions)
            }}
            onSelectSession={(projectId, slug, threadId) => {
              openFeatureDetail(projectId, slug, threadId)
              void selectThread(threadId, { preserveView: true })
            }}
            onDeleteSession={setSidebarThreadToDelete}
            onExportSession={(thread) => void handleExportSidebarThread(thread)}
            onStartEditing={(thread) => {
              setEditingThreadId(thread.thread_id)
              setEditingTitle(thread.title || "")
            }}
            onSaveTitle={saveSidebarThreadTitle}
            onCancelEditing={cancelSidebarThreadEditing}
            onEditingTitleChange={setEditingTitle}
          />,
          sidebarPortalNode
        )
      : null

  if (selectedFeature) {
    return (
      <>
        <FeatureDetailPage
          detail={runDetail}
          loading={loadingRun}
          initialSessionThreadId={selectedFeature.initialSessionThreadId}
          onBackToList={handleBackToProjectList}
          onBackToProject={handleBackToProject}
          onRefresh={() => void refreshSelectedRunDetail()}
          onSessionLinked={refreshSelectedFeatureSessionData}
          onSessionViewChange={handleSessionViewChange}
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
          onPickWorkspace={() => void handlePickEditWorkspace()}
          onSubmit={() => void handleSubmitEdit()}
        />
        {sidebarDeleteDialog}
        {sidebarPortal}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background/90 px-6 py-4 app-no-drag">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mt-1 flex items-center gap-2">
              <Workflow className="size-5 text-status-info" />
              <h1 className="truncate text-xl font-semibold">AUTOBIZDEVOPS项目</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => void loadProjects()}>
              {loadingProjects ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            <Button
              size="sm"
              className={cn("gap-2", harnessActionButtonClassName)}
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

        <div className="mt-4 flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目、系统编号或特性"
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
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
                    onEditProject={handleEditProject}
                    onArchiveProject={(project) => void handleArchiveProject(project)}
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
                        onEditProject={handleEditProject}
                        onArchiveProject={(project) => void handleArchiveProject(project)}
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
        onPickWorkspace={() => void handlePickEditWorkspace()}
        onSubmit={() => void handleSubmitEdit()}
      />
      {sidebarDeleteDialog}
      {sidebarPortal}
    </div>
  )
}
