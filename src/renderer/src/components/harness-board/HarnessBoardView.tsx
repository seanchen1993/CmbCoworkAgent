import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  FileText,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
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
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
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
  HarnessSkillRegistryItem,
  HarnessStatus,
  Thread
} from "@/types"

const emptyProjectMetadataForm: HarnessProjectMetadataUpdateInput = {
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

const emptyProjectForm: HarnessProjectCreateInput = {
  skillId: "",
  ...emptyProjectMetadataForm
}

interface SystemGroup {
  systemCode: string
  systemName: string
  projects: HarnessProjectListItem[]
}

interface SelectedFeature {
  projectId: string
  slug: string
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
  workspacePath: string | null
  sessions: Array<{
    binding: HarnessSessionBinding
  }>
  representativeThreadId: string | null
}

interface WorkspaceChangeState {
  status: "loading" | "ready" | "error"
  files: GitPanelFileChange[]
  changedFilesTotal: number
  omittedFileCount: number
  error?: string
}

function getWorkspaceName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function getThreadWorkspacePath(thread: Thread | null | undefined): string | null {
  const workspacePath = thread?.metadata?.workspacePath
  return typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : null
}

function metadataRequiredMissing(form: HarnessProjectMetadataUpdateInput): boolean {
  return [
    form.name,
    form.projectCode,
    form.description,
    form.product.code,
    form.product.name,
    form.workspace.path
  ].some((value) => !value.trim())
}

function createRequiredMissing(form: HarnessProjectCreateInput): boolean {
  return !form.skillId.trim() || metadataRequiredMissing(form)
}

function toProjectMetadataForm(project: HarnessProjectListItem): HarnessProjectMetadataUpdateInput {
  return {
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

function formatSessionTime(value: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  })
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

function progressPercent(run: HarnessFeatureSummary): number {
  if (run.position.totalNodes <= 0) return 0
  return Math.min(100, Math.round((run.position.progressIndex / run.position.totalNodes) * 100))
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
  registry: HarnessSkillRegistryItem[]
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectCreateInput) => void
  onPickWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">Skill 绑定</div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Skill / Plugin *
              <Select
                value={form.skillId}
                onValueChange={(skillId) => onChange({ ...form, skillId })}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="选择 skill / plugin" />
                </SelectTrigger>
                <SelectContent>
                  {registry.map((skill) => (
                    <SelectItem key={skill.id} value={skill.id}>
                      {skill.name} · {skill.version}
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
                  placeholder="评论能力改造"
                  className="bg-background"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编号 *
                <Input
                  value={form.projectCode}
                  onChange={(event) => onChange({ ...form, projectCode: event.target.value })}
                  placeholder="TN5C24"
                  className="bg-background"
                />
              </label>
              <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目描述 *
                <Input
                  value={form.description}
                  onChange={(event) => onChange({ ...form, description: event.target.value })}
                  placeholder="支持评论创建、列表刷新和权限校验"
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
                  placeholder="LF39.18"
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
                  placeholder="WE运营管理平台"
                  className="bg-background"
                />
              </label>
              <div className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                技能工作区 *
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={form.workspace.path}
                    onChange={(event) =>
                      onChange({ ...form, workspace: { path: event.target.value } })
                    }
                    placeholder="/Users/sixinjian/CmbCoworkAgent"
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
          <Button onClick={onSubmit} disabled={creating || createRequiredMissing(form)} className="gap-2">
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
  project,
  form,
  error,
  onOpenChange,
  onChange,
  onPickWorkspace,
  onSubmit
}: {
  open: boolean
  saving: boolean
  project: HarnessProjectListItem | null
  form: HarnessProjectMetadataUpdateInput
  error: string | null
  onOpenChange: (open: boolean) => void
  onChange: (form: HarnessProjectMetadataUpdateInput) => void
  onPickWorkspace: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">不可修改</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目 ID
                <Input value={project?.projectId ?? ""} disabled className="bg-background" />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Skill / Plugin
                <Input value={project?.skill.name ?? ""} disabled className="bg-background" />
              </label>
            </div>
          </section>

          <section className="rounded-md border border-border bg-muted/30 p-3">
            <div className="mb-3 text-sm font-semibold">项目信息</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称 *
                <Input
                  value={form.name}
                  onChange={(event) => onChange({ ...form, name: event.target.value })}
                  placeholder="评论能力改造"
                  className="bg-background"
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编号 *
                <Input
                  value={form.projectCode}
                  onChange={(event) => onChange({ ...form, projectCode: event.target.value })}
                  placeholder="TN5C24"
                  className="bg-background"
                />
              </label>
              <label className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目描述 *
                <Input
                  value={form.description}
                  onChange={(event) => onChange({ ...form, description: event.target.value })}
                  placeholder="支持评论创建、列表刷新和权限校验"
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
                  placeholder="LF39.18"
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
                  placeholder="WE运营管理平台"
                  className="bg-background"
                />
              </label>
              <div className="col-span-2 grid gap-1.5 text-xs font-medium text-muted-foreground">
                技能工作区 *
                <div className="flex min-w-0 gap-2">
                  <Input
                    value={form.workspace.path}
                    onChange={(event) =>
                      onChange({ ...form, workspace: { path: event.target.value } })
                    }
                    placeholder="/Users/sixinjian/CmbCoworkAgent"
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
          <Button onClick={onSubmit} disabled={saving || metadataRequiredMissing(form)} className="gap-2">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            保存
          </Button>
        </DialogFooter>
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
  onOpen
}: {
  run: HarnessFeatureSummary
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="grid w-full gap-2 rounded-md border border-border bg-background px-3 py-3 text-left transition-all hover:-translate-y-px hover:border-primary/50 hover:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{run.title}</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">{run.slug}</div>
        </div>
        <StatusPill status={run.overallStatus} />
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{run.summary.text}</div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-status-info" style={{ width: `${progressPercent(run)}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{run.position.currentNodeLabel ?? run.position.currentNodeId}</span>
        <span className="shrink-0">
          {run.position.progressIndex}/{run.position.totalNodes}
        </span>
      </div>
    </button>
  )
}

function ProjectCard({
  project,
  detail,
  loading,
  expanded,
  archiving,
  onEditProject,
  onArchiveProject,
  onToggleFeatures,
  onOpenFeature
}: {
  project: HarnessProjectListItem
  detail?: HarnessProjectDetailViewModel
  loading: boolean
  expanded: boolean
  archiving: boolean
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onToggleFeatures: () => void
  onOpenFeature: (projectId: string, slug: string) => void
}): React.JSX.Element {
  const runs = detail?.runs ?? []
  const activeCount = runs.filter((run) => run.overallStatus.uiKind === "active").length
  const archived = project.lifecycle.status === "archived"
  const featureButtonLabel = expanded
    ? "收起 feature"
    : detail
      ? "展开 feature"
      : "加载 feature"

  return (
    <article
      className={cn(
        "w-[420px] flex-none overflow-hidden rounded-md border border-border border-t-[3px] shadow-sm",
        archived ? "border-t-muted-foreground/50 bg-muted/20" : "border-t-status-info bg-background"
      )}
    >
      <div className="p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-base font-semibold">{project.name}</h2>
              <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {project.projectCode}
              </span>
              {archived && (
                <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  已归档
                </span>
              )}
            </div>
            <div className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {project.description}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
              {project.skill.name}
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
            Feature 数
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
            <strong className="mt-1 block truncate text-sm text-foreground" title={project.workspacePath}>
              {getWorkspaceName(project.workspacePath)}
            </strong>
          </div>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4 w-full justify-center gap-2"
          onClick={onToggleFeatures}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          {loading && expanded ? "读取中" : featureButtonLabel}
        </Button>
      </div>

      {expanded && (
        <div className="grid gap-2 border-t border-border bg-muted/30 p-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              读取 feature 列表
            </div>
          ) : runs.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-background px-3 py-5 text-sm text-muted-foreground">
              当前项目还没有 feature。skill 创建 feature 后会出现在这里。
            </div>
          ) : (
            runs.map((run) => (
              <FeatureCard
                key={run.slug}
                run={run}
                onOpen={() => onOpenFeature(project.projectId, run.slug)}
              />
            ))
          )}
        </div>
      )}
    </article>
  )
}

function SystemSection({
  group,
  detailsByProjectId,
  loadingDetailIds,
  expandedProjectIds,
  archivingProjectId,
  onEditProject,
  onArchiveProject,
  onToggleProject,
  onOpenFeature
}: {
  group: SystemGroup
  detailsByProjectId: Record<string, HarnessProjectDetailViewModel>
  loadingDetailIds: Set<string>
  expandedProjectIds: Set<string>
  archivingProjectId: string | null
  onEditProject: (project: HarnessProjectListItem) => void
  onArchiveProject: (project: HarnessProjectListItem) => void
  onToggleProject: (projectId: string) => void
  onOpenFeature: (projectId: string, slug: string) => void
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
              expanded={expandedProjectIds.has(project.projectId)}
              archiving={archivingProjectId === project.projectId}
              onEditProject={onEditProject}
              onArchiveProject={onArchiveProject}
              onToggleFeatures={() => onToggleProject(project.projectId)}
              onOpenFeature={onOpenFeature}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function ArtifactLine({ artifact }: { artifact: HarnessArtifact }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[18px_minmax(140px,1fr)_90px_minmax(160px,1.5fr)] items-start gap-3 border-t border-border px-3 py-3 text-sm">
      <FileText className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate font-medium">{artifact.label}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {artifact.path ?? artifact.kind}
        </div>
      </div>
      <StatusPill status={artifact.status} />
      <div className="min-w-0 text-xs leading-5 text-muted-foreground">
        <div className="truncate">{artifact.summary ?? "-"}</div>
        {artifact.validation && <div className="truncate">{artifact.validation.message}</div>}
      </div>
    </div>
  )
}

function HookLine({ hook }: { hook: HarnessHookLogView }): React.JSX.Element {
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
          {hook.event && <div className="truncate">{hook.event}</div>}
        </div>
      </div>
    </div>
  )
}

function StageArtifactPanel({ node }: { node: HarnessRunNode }): React.JSX.Element {
  return (
    <section className="rounded-md border border-border bg-background">
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
          {node.artifacts.map((artifact) => <ArtifactLine key={artifact.id} artifact={artifact} />)}
        </div>
      )}
    </section>
  )
}

function FeatureSessionsPanel({
  sessions,
  threadsById,
  busy,
  error,
  onCreateSession,
  onOpenSession
}: {
  sessions: HarnessSessionBinding[]
  threadsById: Map<string, Thread>
  busy: "create" | null
  error: string | null
  onCreateSession: () => void
  onOpenSession: (threadId: string) => void
}): React.JSX.Element {
  return (
    <section className="rounded-md border border-border bg-background">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">关联会话</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="gap-2"
            onClick={onCreateSession}
            disabled={busy !== null}
          >
            {busy === "create" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageSquarePlus className="size-4" />
            )}
            发起新会话
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-border bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
          {error}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          当前 feature 还没有关联会话。
        </div>
      ) : (
        <div className="max-h-64 divide-y divide-border overflow-y-auto">
          {sessions.map((session) => {
            const thread = threadsById.get(session.threadId) ?? null
            const workspacePath = getThreadWorkspacePath(thread)
            return (
              <div key={session.threadId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{thread?.title || session.threadId}</div>
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{session.threadId}</span>
                    <span className="shrink-0">更新 {formatSessionTime(session.lastActiveAt)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {workspacePath ? getWorkspaceName(workspacePath) : "未配置工作区"}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-2"
                  onClick={() => onOpenSession(session.threadId)}
                >
                  打开
                  <ArrowUpRight className="size-4" />
                </Button>
              </div>
            )
          })}
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
      const key = workspacePath ? `workspace:${workspacePath}` : "missing-workspace"
      const existing = map.get(key)
      const item = { binding }

      if (existing) {
        existing.sessions.push(item)
        if (!existing.representativeThreadId && workspacePath) {
          existing.representativeThreadId = binding.threadId
        }
        continue
      }

      map.set(key, {
        key,
        workspacePath,
        sessions: [item],
        representativeThreadId: workspacePath ? binding.threadId : null
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
    if (!group.workspacePath || !group.representativeThreadId) {
      setChangesByGroup((current) => ({
        ...current,
        [group.key]: {
          status: "error",
          files: [],
          changedFilesTotal: 0,
          omittedFileCount: 0,
          error: "该会话未配置工作区"
        }
      }))
      return
    }

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
          error: error instanceof Error ? error.message : String(error)
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
          status: group.workspacePath ? "loading" : "error",
          files: [],
          changedFilesTotal: 0,
          omittedFileCount: 0,
          error: group.workspacePath ? undefined : "该会话未配置工作区"
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
        {sessions.length > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground">{visibleChangedFiles} files</span>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          当前 feature 还没有关联会话，暂无代码变更。
        </div>
      ) : (
        <div className="divide-y divide-border">
          {groups.map((group) => {
            const state = changesByGroup[group.key]

            return (
              <div key={group.key} className="px-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {group.workspacePath ? getWorkspaceName(group.workspacePath) : "未配置工作区"}
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

function FeatureDetailPage({
  detail,
  loading,
  onBack
}: {
  detail: HarnessRunDetailViewModel | null
  loading: boolean
  onBack: () => void
}): React.JSX.Element {
  const defaultNodeId = useMemo(() => {
    if (!detail) return null
    return detail.run.nodes.find((node) => node.status.isCurrent)?.id ?? detail.run.nodes[0]?.id ?? null
  }, [detail])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(defaultNodeId)

  useEffect(() => {
    if (!detail) {
      setSelectedNodeId(null)
      return
    }
    setSelectedNodeId((current) => {
      if (current && detail.run.nodes.some((node) => node.id === current)) {
        return current
      }
      return defaultNodeId
    })
  }, [defaultNodeId, detail])

  const effectiveSelectedNodeId = selectedNodeId ?? defaultNodeId
  const selectedNode =
    detail?.run.nodes.find((node) => node.id === effectiveSelectedNodeId) ?? detail?.run.nodes[0] ?? null
  const { createThread, selectThread, threads } = useAppStore()
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.thread_id, thread])), [threads])
  const [sessionBusy, setSessionBusy] = useState<"create" | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const handleCreateSession = async (): Promise<void> => {
    if (!detail || sessionBusy) return
    setSessionBusy("create")
    setSessionError(null)
    try {
      const title = `Feature: ${detail.run.title}`
      const thread = await createThread({
        title,
        workspacePath: detail.project.workspacePath,
        harnessFeature: {
          projectId: detail.project.projectId,
          slug: detail.run.slug
        }
      })
      await window.api.harnessBoard.linkSession({
        projectId: detail.project.projectId,
        slug: detail.run.slug,
        threadId: thread.thread_id
      })
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSessionBusy(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/90 px-6 app-no-drag">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
            <ArrowLeft className="size-4" />
            返回
          </Button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <Workflow className="size-4 shrink-0 text-status-info" />
              <h1 className="truncate text-base font-semibold">
                {detail?.run.title ?? "Feature 详情"}
              </h1>
              {detail?.adapterSnapshot.mock && (
                <span className="shrink-0 rounded border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[11px] text-status-warning">
                  Mock
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {detail ? `${detail.project.name} · ${detail.run.slug}` : "加载中"}
            </div>
          </div>
        </div>
      </div>

      {loading || !detail ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" />
          读取 feature 详情
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_340px] gap-5 p-6">
            <div className="min-w-0 space-y-4">
              <div className="-mx-1 overflow-x-auto pb-2">
                <div className="flex w-max gap-3 px-1">
                  {detail.run.nodes.map((node) => {
                    const selected = effectiveSelectedNodeId === node.id
                    return (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => setSelectedNodeId(node.id)}
                        aria-pressed={selected}
                        title={node.label}
                        className={cn(
                          "w-[220px] flex-none rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          selected
                            ? "border-status-info bg-status-info/10 shadow-sm"
                            : node.status.isCurrent
                              ? "border-status-info/45 bg-status-info/5 hover:border-status-info"
                              : "border-border bg-background hover:border-primary/45"
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {statusIcon(node.status)}
                          <span className="truncate text-sm font-medium">{node.label}</span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{node.group}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {selectedNode ? (
                <StageArtifactPanel node={selectedNode} />
              ) : (
                <section className="rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                  暂无阶段数据。
                </section>
              )}

              <FeatureSessionsPanel
                sessions={detail.sessions}
                threadsById={threadsById}
                busy={sessionBusy}
                error={sessionError}
                onCreateSession={() => void handleCreateSession()}
                onOpenSession={(threadId) => void selectThread(threadId)}
              />
            </div>

            <aside className="min-w-0 space-y-4">
              <FeatureWorkspaceChangesPanel sessions={detail.sessions} threadsById={threadsById} />

              <section className="rounded-md border border-border bg-background">
                <div className="border-b border-border px-3 py-3 text-sm font-semibold">Hook 事件</div>
                {selectedNode && selectedNode.hooks.length > 0 ? (
                  <div className="max-h-64 overflow-y-auto">
                    {selectedNode.hooks.map((hook) => <HookLine key={hook.hookId} hook={hook} />)}
                  </div>
                ) : (
                  <div className="px-3 py-6 text-sm text-muted-foreground">
                    当前阶段暂无 Hook 事件。
                  </div>
                )}
              </section>
            </aside>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

export function HarnessBoardView(): React.JSX.Element {
  const [projects, setProjects] = useState<HarnessProjectListItem[]>([])
  const [detailsByProjectId, setDetailsByProjectId] = useState<Record<string, HarnessProjectDetailViewModel>>({})
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set())
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set())
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null)
  const [runDetail, setRunDetail] = useState<HarnessRunDetailViewModel | null>(null)
  const [skillRegistry, setSkillRegistry] = useState<HarnessSkillRegistryItem[]>([])
  const [query, setQuery] = useState("")
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingRun, setLoadingRun] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<HarnessProjectCreateInput>(emptyProjectForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<HarnessProjectListItem | null>(null)
  const [editForm, setEditForm] = useState<HarnessProjectMetadataUpdateInput>(emptyProjectMetadataForm)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [archivingProjectId, setArchivingProjectId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadProjectDetail = useCallback(async (projectId: string) => {
    setLoadingDetailIds((current) => new Set(current).add(projectId))
    try {
      const detail = await window.api.harnessBoard.getProjectDetail(projectId)
      setDetailsByProjectId((current) => ({ ...current, [projectId]: detail }))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
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
      setSkillRegistry(registry)
      setForm((current) => ({
        ...current,
        skillId: current.skillId || registry[0]?.id || ""
      }))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingProjects(false)
    }
  }, [])

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
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoadingRun(false))
  }, [selectedFeature])

  useEffect(() => {
    return window.api.harnessBoard.onWatchRefsChanged((event) => {
      const projectMatch = event.scopeKey.match(/^project:(.+)$/)
      if (projectMatch && expandedProjectIds.has(projectMatch[1])) {
        void loadProjectDetail(projectMatch[1])
      }
      if (
        selectedFeature &&
        event.scopeKey === `run:${selectedFeature.projectId}:${selectedFeature.slug}`
      ) {
        void window.api.harnessBoard
          .getRunDetail(selectedFeature.projectId, selectedFeature.slug)
          .then(setRunDetail)
      }
    })
  }, [expandedProjectIds, loadProjectDetail, selectedFeature])

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
          project.skill.name,
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

  const handleToggleProject = useCallback(
    (projectId: string) => {
      const shouldLoad =
        !expandedProjectIds.has(projectId) &&
        !detailsByProjectId[projectId] &&
        !loadingDetailIds.has(projectId)

      setExpandedProjectIds((current) => {
        const next = new Set(current)
        if (next.has(projectId)) {
          next.delete(projectId)
        } else {
          next.add(projectId)
        }
        return next
      })

      if (shouldLoad) {
        void loadProjectDetail(projectId)
      }
    },
    [detailsByProjectId, expandedProjectIds, loadProjectDetail, loadingDetailIds]
  )

  const handleSubmit = async (): Promise<void> => {
    setFormError(null)
    if (createRequiredMissing(form)) {
      setFormError("所有字段均为必填")
      return
    }
    setCreating(true)
    try {
      await window.api.harnessBoard.createProject(form)
      setDialogOpen(false)
      setForm({ ...emptyProjectForm, skillId: skillRegistry[0]?.id || "" })
      await loadProjects()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
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
      if (expandedProjectIds.has(projectId)) {
        void loadProjectDetail(projectId)
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error))
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
        await loadProjects()
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setArchivingProjectId(null)
      }
    },
    [archivingProjectId, loadProjects]
  )

  if (selectedFeature) {
    return (
      <FeatureDetailPage
        detail={runDetail}
        loading={loadingRun}
        onBack={() => setSelectedFeature(null)}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background/90 px-6 py-4 app-no-drag">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mt-1 flex items-center gap-2">
              <Workflow className="size-5 text-status-info" />
              <h1 className="truncate text-xl font-semibold">项目看板</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => void loadProjects()}>
              {loadingProjects ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
            <Button size="sm" className="gap-2" onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" />
              新建项目
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
          <Search className="size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目、产品、skill 或已加载 feature"
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
                <Button className="mt-4 gap-2" onClick={() => setDialogOpen(true)}>
                  <Plus className="size-4" />
                  新建项目
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
                    expandedProjectIds={expandedProjectIds}
                    archivingProjectId={archivingProjectId}
                    onEditProject={handleEditProject}
                    onArchiveProject={(project) => void handleArchiveProject(project)}
                    onToggleProject={handleToggleProject}
                    onOpenFeature={(projectId, slug) => setSelectedFeature({ projectId, slug })}
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
                        expandedProjectIds={expandedProjectIds}
                        archivingProjectId={archivingProjectId}
                        onEditProject={handleEditProject}
                        onArchiveProject={(project) => void handleArchiveProject(project)}
                        onToggleProject={handleToggleProject}
                        onOpenFeature={(projectId, slug) => setSelectedFeature({ projectId, slug })}
                      />
                    ))
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </main>
      </ScrollArea>

      <ProjectFormDialog
        open={dialogOpen}
        creating={creating}
        form={form}
        registry={skillRegistry}
        error={formError}
        onOpenChange={setDialogOpen}
        onChange={setForm}
        onPickWorkspace={() => void handlePickWorkspace()}
        onSubmit={() => void handleSubmit()}
      />
      <ProjectEditDialog
        open={editingProject !== null}
        saving={savingEdit}
        project={editingProject}
        form={editForm}
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
    </div>
  )
}
