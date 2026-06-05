import { useState } from "react"
import {
  Boxes,
  Layers,
  Activity,
  MessagesSquare,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Plug,
  Code2,
  Gauge,
  Search,
  X
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  CodeAdoptionFunnel,
  SkillRankingPanel,
  ToolRankingPanel,
  type CodeAdoptionFunnelData
} from "./dashboard-shared"
import type {
  DashboardProjectModeData,
  DashboardProjectModeAdapter,
  DashboardProjectModeProject,
  DashboardProjectModeSkillCount,
  DashboardProjectModeToolUsage,
  DashboardCodeStats
} from "../use-dashboard"

const EMPTY_FUNNEL_DATA: CodeAdoptionFunnelData = {
  inclusiveEffectiveGeneratedLines: 0,
  effectiveGeneratedLines: 0,
  pushedEffectiveGeneratedLines: 0,
  adoptedLines: 0,
  pushedAdoptedLines: 0,
  inclusiveAdoptionRate: null,
  measuredAdoptionRate: null,
  pushedAdoptionRate: null
}

const EMPTY_TOOL_USAGE: DashboardProjectModeToolUsage = {
  byTool: [],
  byToolAll: [],
  byToolFilteredAll: [],
  byToolAllFull: [],
  totalTools: 0,
  totalToolCalls: 0
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
}): React.JSX.Element {
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold leading-tight text-foreground">{value}</div>
        {sub && <div className="whitespace-nowrap text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

function lifecycleLabel(status?: string): string {
  switch (status) {
    case "active":
      return "进行中"
    case "paused":
      return "已暂停"
    case "archived":
      return "已归档"
    case "completed":
      return "已完成"
    default:
      return status || "—"
  }
}

function ProjectRow({
  project,
  expanded,
  onToggle,
  onOpenTraces
}: {
  project: DashboardProjectModeProject
  expanded: boolean
  onToggle: () => void
  onOpenTraces: () => void
}): React.JSX.Element {
  const codeStats = project.codeStats
  const adoptionLineLabel = codeStats
    ? `${formatNumber(codeStats.adoptedLines)} / ${formatNumber(codeStats.effectiveGeneratedLines)} 行`
    : "—"
  const pushedAdoptionLineLabel = codeStats
    ? `${formatNumber(codeStats.pushedAdoptedLines)} / ${formatNumber(codeStats.pushedEffectiveGeneratedLines)} 行`
    : "—"

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-foreground">{project.name}</span>
              </div>
              {project.systemName && (
                <div className="truncate text-[10px] text-muted-foreground">
                  {project.systemName}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {project.adapterName ? (
            <span>
              {project.adapterName}
              {project.adapterVersion ? (
                <span className="text-[10px] text-muted-foreground/70">
                  {" "}
                  {project.adapterVersion}
                </span>
              ) : null}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {lifecycleLabel(project.lifecycleStatus)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(project.featureCount)}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">
          {formatNumber(project.conversationCount)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="font-medium">{formatPercent(codeStats?.measuredAdoptionRate)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{adoptionLineLabel}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="font-medium">{formatPercent(codeStats?.pushedAdoptionRate)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {pushedAdoptionLineLabel}
          </div>
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            className="text-xs text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            disabled={project.conversationCount === 0}
            onClick={(event) => {
              event.stopPropagation()
              onOpenTraces()
            }}
          >
            查看对话
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={8} className="px-3 py-3">
            <div className="space-y-3">
              {/* 常用技能 + 采纳明细 */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">常用技能：</span>
                  {project.topSkills.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <SkillChips skills={project.topSkills} />
                  )}
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>
                    生成行数{" "}
                    <span className="font-medium text-foreground">
                      {formatNumber(codeStats?.effectiveGeneratedLines ?? 0)}
                    </span>
                  </span>
                  <span>
                    采纳行数{" "}
                    <span className="font-medium text-foreground">
                      {formatNumber(codeStats?.adoptedLines ?? 0)}
                    </span>
                  </span>
                  <span>
                    已Commit采纳率{" "}
                    <span className="font-medium text-foreground">
                      {formatPercent(codeStats?.measuredAdoptionRate)}
                    </span>
                  </span>
                  <span>
                    已Push采纳率{" "}
                    <span className="font-medium text-foreground">
                      {formatPercent(codeStats?.pushedAdoptionRate)}
                    </span>
                    <span className="ml-1 text-muted-foreground/80">
                      ({pushedAdoptionLineLabel})
                    </span>
                  </span>
                </div>
              </div>

              {/* 特性状态 */}
              {project.features.length === 0 ? (
                <div className="text-xs text-muted-foreground">该项目暂无特性记录</div>
              ) : (
                <div className="space-y-2">
                  {project.features.map((feature) => (
                    <div
                      key={feature.slug}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs"
                    >
                      <span className="font-medium text-foreground">{feature.title}</span>
                      {feature.statusLabel && (
                        <Badge variant="outline" className="normal-case tracking-normal">
                          {feature.statusLabel}
                        </Badge>
                      )}
                      {feature.currentNodeStatusLabel && (
                        <span className="text-muted-foreground">
                          当前节点：{feature.currentNodeStatusLabel}
                        </span>
                      )}
                      {feature.summary && (
                        <span className="truncate text-muted-foreground" title={feature.summary}>
                          · {feature.summary}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SkillChips({ skills }: { skills: DashboardProjectModeSkillCount[] }): React.JSX.Element {
  return (
    <>
      {skills.map((item) => (
        <Badge key={item.skill} variant="outline" className="normal-case tracking-normal">
          {item.skill} · {formatNumber(item.count)}
        </Badge>
      ))}
    </>
  )
}

const PROJECT_PAGE_SIZE = 10
const ADAPTER_PAGE_SIZE = 10

type ProjectListTab = "active" | "archived"

/**
 * 项目列表：进行中 / 已归档双 tab + 项目名搜索 + 客户端分页。
 * 项目快照随使用累积可能很多，因此默认只看「进行中」，并支持搜索定位与翻页。
 */
function ProjectListSection({
  projects,
  loading,
  onOpenTraces
}: {
  projects: DashboardProjectModeProject[]
  loading: boolean
  onOpenTraces: (project: DashboardProjectModeProject) => void
}): React.JSX.Element {
  const [tab, setTab] = useState<ProjectListTab>("active")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const activeProjects = projects.filter((p) => p.lifecycleStatus !== "archived")
  const archivedProjects = projects.filter((p) => p.lifecycleStatus === "archived")
  const tabProjects = tab === "archived" ? archivedProjects : activeProjects

  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? tabProjects.filter(
        (p) =>
          p.name.toLowerCase().includes(trimmed) ||
          (p.systemName ?? "").toLowerCase().includes(trimmed)
      )
    : tabProjects

  const totalPages = Math.max(1, Math.ceil(filtered.length / PROJECT_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = filtered.slice(
    (currentPage - 1) * PROJECT_PAGE_SIZE,
    currentPage * PROJECT_PAGE_SIZE
  )

  const switchTab = (next: ProjectListTab): void => {
    setTab(next)
    setPage(1)
    setExpandedId(null)
  }
  const changeQuery = (value: string): void => {
    setQuery(value)
    setPage(1)
  }

  const tabs: Array<{ id: ProjectListTab; label: string; count: number }> = [
    { id: "active", label: "进行中", count: activeProjects.length },
    { id: "archived", label: "已归档", count: archivedProjects.length }
  ]

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-foreground">项目列表</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        项目、插件、项目状态、特性数为当前状态；对话数、已Commit/已Push采纳率及展开行的技能与采纳明细按所选时间范围统计。
      </p>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center overflow-hidden rounded-md border border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => switchTab(t.id)}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <div className="relative w-full max-w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="搜索项目名称"
            className="h-8 rounded-md border-border bg-background pl-8 pr-8 text-xs"
          />
          {query ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => changeQuery("")}
              aria-label="清空搜索"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          loading && "opacity-70"
        )}
      >
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">项目</th>
              <th className="px-3 py-2 text-left font-medium">插件</th>
              <th className="px-3 py-2 text-left font-medium">项目状态</th>
              <th className="px-3 py-2 text-right font-medium">特性数</th>
              <th className="px-3 py-2 text-right font-medium">对话数</th>
              <th className="px-3 py-2 text-right font-medium">已Commit采纳率</th>
              <th className="px-3 py-2 text-right font-medium">已Push采纳率</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((project) => (
              <ProjectRow
                key={project.projectId}
                project={project}
                expanded={expandedId === project.projectId}
                onToggle={() =>
                  setExpandedId((prev) => (prev === project.projectId ? null : project.projectId))
                }
                onOpenTraces={() => onOpenTraces(project)}
              />
            ))}
            {pageItems.length > 0 &&
              Array.from({ length: PROJECT_PAGE_SIZE - pageItems.length }).map((_, i) => (
                <tr key={`filler-${i}`} aria-hidden className="border-b border-border/50">
                  <td colSpan={8} className="h-[49px]" />
                </tr>
              ))}
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  {trimmed
                    ? "未找到匹配的项目"
                    : tab === "archived"
                      ? "暂无已归档项目"
                      : "暂无进行中项目"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {filtered.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>共 {formatNumber(filtered.length)} 个</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                第 {currentPage} / {totalPages} 页
              </span>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={currentPage >= totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

type AdapterListMode = "byName" | "byVersion"

function adoptionRate(adopted: number, generated: number): number | null {
  return generated > 0 ? adopted / generated : null
}

/** 合并同名插件不同版本的代码采纳明细，按行数累加后重算采纳率。 */
function mergeCodeStats(
  items: Array<DashboardCodeStats | null | undefined>
): DashboardCodeStats | null {
  const valid = items.filter((s): s is DashboardCodeStats => Boolean(s))
  if (valid.length === 0) return null
  const sum = (pick: (s: DashboardCodeStats) => number): number =>
    valid.reduce((acc, s) => acc + pick(s), 0)
  const generatedLines = sum((s) => s.generatedLines)
  const deletedLines = sum((s) => s.deletedLines)
  const effectiveGeneratedLines = sum((s) => s.effectiveGeneratedLines)
  const measuredGeneratedLines = sum((s) => s.measuredGeneratedLines)
  const unmeasuredGeneratedLines = sum((s) => s.unmeasuredGeneratedLines)
  const inclusiveEffectiveGeneratedLines = sum((s) => s.inclusiveEffectiveGeneratedLines)
  const adoptedLines = sum((s) => s.adoptedLines)
  const pushedMeasuredGeneratedLines = sum((s) => s.pushedMeasuredGeneratedLines)
  const pushedEffectiveGeneratedLines = sum((s) => s.pushedEffectiveGeneratedLines)
  const pushedAdoptedLines = sum((s) => s.pushedAdoptedLines)
  const pushedCommitCount = sum((s) => s.pushedCommitCount)
  const measuredAdoptionRate = adoptionRate(adoptedLines, effectiveGeneratedLines)
  return {
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines,
    adoptedLines,
    pushedMeasuredGeneratedLines,
    pushedEffectiveGeneratedLines,
    pushedAdoptedLines,
    pushedCommitCount,
    measuredAdoptionRate,
    inclusiveAdoptionRate: adoptionRate(adoptedLines, inclusiveEffectiveGeneratedLines),
    pushedAdoptionRate: adoptionRate(pushedAdoptedLines, pushedEffectiveGeneratedLines),
    adoptionRate: measuredAdoptionRate
  }
}

/** 按插件名聚合：累加项目/特性/对话数，合并代码采纳明细。 */
function aggregateAdaptersByName(
  adapters: DashboardProjectModeAdapter[]
): DashboardProjectModeAdapter[] {
  const map = new Map<string, DashboardProjectModeAdapter[]>()
  for (const adapter of adapters) {
    const list = map.get(adapter.name)
    if (list) list.push(adapter)
    else map.set(adapter.name, [adapter])
  }
  const result: DashboardProjectModeAdapter[] = []
  for (const [name, group] of map) {
    result.push({
      name,
      version: undefined,
      projectCount: group.reduce((acc, a) => acc + a.projectCount, 0),
      featureCount: group.reduce((acc, a) => acc + a.featureCount, 0),
      conversationCount: group.reduce((acc, a) => acc + a.conversationCount, 0),
      codeStats: mergeCodeStats(group.map((a) => a.codeStats))
    })
  }
  return result
}

function AdapterListSection({
  adapters
}: {
  adapters: DashboardProjectModeAdapter[]
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [mode, setMode] = useState<AdapterListMode>("byName")
  const versionCount = adapters.length
  const aggregatedByName = aggregateAdaptersByName(adapters)
  const baseList = mode === "byName" ? aggregatedByName : adapters
  const sortedAdapters = [...baseList].sort(
    (a, b) =>
      b.projectCount - a.projectCount ||
      b.conversationCount - a.conversationCount ||
      a.name.localeCompare(b.name) ||
      (a.version ?? "").localeCompare(b.version ?? "")
  )
  const totalPages = Math.max(1, Math.ceil(sortedAdapters.length / ADAPTER_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = sortedAdapters.slice(
    (currentPage - 1) * ADAPTER_PAGE_SIZE,
    currentPage * ADAPTER_PAGE_SIZE
  )

  const modeTabs: Array<{ id: AdapterListMode; label: string; count: number }> = [
    { id: "byName", label: "按插件", count: aggregatedByName.length },
    { id: "byVersion", label: "按版本", count: versionCount }
  ]

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-foreground">插件列表</h2>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {mode === "byName"
          ? "按插件名聚合同名插件的多个版本；按项目数降序排列，项目数为当前状态，对话数、已Commit/已Push采纳率按所选时间范围统计。"
          : "按插件版本展开；按项目数降序排列，项目数为当前状态，对话数、已Commit/已Push采纳率按所选时间范围统计。"}
      </p>
      <div className="mb-3 flex items-center overflow-hidden rounded-md border border-border w-fit">
        {modeTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              mode === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              setMode(t.id)
              setPage(1)
            }}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card">
        {sortedAdapters.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无数据</div>
        ) : (
          <>
            <div className="divide-y divide-border">
              {pageItems.map((adapter) => (
                <div
                  key={`${adapter.name}@${adapter.version ?? ""}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Plug className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium text-foreground">{adapter.name}</span>
                    {adapter.version && (
                      <Badge variant="outline" className="normal-case tracking-normal">
                        {adapter.version}
                      </Badge>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                    <span>
                      项目{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(adapter.projectCount)}
                      </span>
                    </span>
                    <span>
                      特性{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(adapter.featureCount)}
                      </span>
                    </span>
                    <span>
                      对话{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(adapter.conversationCount)}
                      </span>
                    </span>
                    <span>
                      已Commit采纳率{" "}
                      <span className="font-medium text-foreground">
                        {formatPercent(adapter.codeStats?.measuredAdoptionRate)}
                      </span>
                    </span>
                    <span>
                      已Push采纳率{" "}
                      <span className="font-medium text-foreground">
                        {formatPercent(adapter.codeStats?.pushedAdoptionRate)}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <span>共 {formatNumber(sortedAdapters.length)} 个</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  上一页
                </button>
                <span>
                  第 {currentPage} / {totalPages} 页
                </span>
                <button
                  type="button"
                  className="rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

export function ProjectModePanel({
  data,
  loading,
  error,
  onOpenTraces,
  onSkillClick,
  marketSkillKeys = new Set(),
  pluginSkillKeys = new Set()
}: {
  data: DashboardProjectModeData | null
  loading: boolean
  error: string | null
  onOpenTraces: (project: DashboardProjectModeProject) => void
  onSkillClick?: (skill: string) => void
  marketSkillKeys?: Set<string>
  pluginSkillKeys?: Set<string>
}): React.JSX.Element {
  if (loading && !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  const summary = data?.summary
  const adapters = data?.adapters ?? []
  const projects = data?.projects ?? []
  const funnelData: CodeAdoptionFunnelData = summary?.codeStats ?? EMPTY_FUNNEL_DATA
  const topSkills = data?.topSkills ?? []
  const bySkillAdoption = data?.bySkillAdoption ?? []
  const tools = data?.tools ?? EMPTY_TOOL_USAGE
  const archivedProjects = projects.filter((p) => p.lifecycleStatus === "archived")
  const archivedCount = archivedProjects.length
  const archivedFeatureCount = archivedProjects.reduce((sum, p) => sum + p.featureCount, 0)

  return (
    <div className="space-y-6">
      {/* 概览卡片（左）+ 代码采纳漏斗（右），与平台运营概览一致 */}
      <section>
        <h2 className="mb-1 text-sm font-semibold text-foreground">项目运营概览</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">项目总数 / 特性总数</span>{" "}
          为当前状态（项目快照实时统计，不随时间范围变化）；其余指标按
          <span className="font-medium text-foreground">所选时间范围</span>统计。
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
          <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-3 xl:grid-cols-5">
            <StatCard
              icon={Boxes}
              label="项目总数"
              value={formatNumber(summary?.projectCount ?? 0)}
              sub={archivedCount > 0 ? `当前状态 · 含 ${archivedCount} 已归档` : "当前状态"}
              color="bg-blue-500"
            />
            <StatCard
              icon={Layers}
              label="特性总数"
              value={formatNumber(summary?.featureCount ?? 0)}
              sub={
                archivedFeatureCount > 0
                  ? `当前状态 · 含 ${archivedFeatureCount} 已归档`
                  : "当前状态"
              }
              color="bg-indigo-500"
            />
            <StatCard
              icon={Activity}
              label="活跃项目"
              value={formatNumber(summary?.activeProjectCount ?? 0)}
              sub="时间范围内有对话"
              color="bg-emerald-500"
            />
            <StatCard
              icon={MessagesSquare}
              label="项目对话数"
              value={formatNumber(summary?.conversationCount ?? 0)}
              color="bg-violet-500"
            />
            <StatCard
              icon={ArrowDownToLine}
              label="输入 Token"
              value={formatCompact(summary?.totalInputTokens ?? 0)}
              color="bg-amber-500"
            />
            <StatCard
              icon={ArrowUpFromLine}
              label="输出 Token"
              value={formatCompact(summary?.totalOutputTokens ?? 0)}
              color="bg-rose-500"
            />
            <StatCard
              icon={Code2}
              label="代码生成行数"
              value={formatNumber(summary?.codeStats?.generatedLines ?? 0)}
              color="bg-sky-500"
            />
            <StatCard
              icon={Gauge}
              label="已Commit采纳率"
              value={formatPercent(summary?.codeStats?.measuredAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatNumber(summary.codeStats.adoptedLines)} / ${formatNumber(summary.codeStats.effectiveGeneratedLines)} 行`
                  : "暂无代码生成数据"
              }
              color="bg-indigo-500"
            />
            <StatCard
              icon={Gauge}
              label="已 Push 采纳率"
              value={formatPercent(summary?.codeStats?.pushedAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatNumber(summary.codeStats.pushedAdoptedLines)} / ${formatNumber(summary.codeStats.pushedEffectiveGeneratedLines)} 行`
                  : "暂无已 Push 数据"
              }
              color="bg-teal-500"
            />
            <StatCard
              icon={Gauge}
              label="含未提交采纳率"
              value={formatPercent(summary?.codeStats?.inclusiveAdoptionRate)}
              sub={
                summary?.codeStats
                  ? `${formatNumber(summary.codeStats.adoptedLines)} / ${formatNumber(summary.codeStats.inclusiveEffectiveGeneratedLines)} 行`
                  : "暂无代码生成数据"
              }
              color="bg-cyan-500"
            />
          </div>
          <CodeAdoptionFunnel data={funnelData} />
        </div>
      </section>

      {/* Project list */}
      <ProjectListSection projects={projects} loading={loading} onOpenTraces={onOpenTraces} />

      {/* Skill / Tool 使用排行，与平台运营概览同款 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">技能 / 工具使用</h2>
        <div className="grid grid-cols-2 gap-3">
          <SkillRankingPanel
            bySkill={topSkills}
            bySkillAll={topSkills}
            totalSkills={summary?.distinctSkillCount ?? 0}
            totalSkillCalls={summary?.skillCallCount ?? 0}
            bySkillAdoption={bySkillAdoption}
            onSkillClick={onSkillClick}
            marketSkillKeys={marketSkillKeys}
            pluginSkillKeys={pluginSkillKeys}
          />
          <ToolRankingPanel
            byTool={tools.byTool}
            byToolAll={tools.byToolAll}
            byToolFilteredAll={tools.byToolFilteredAll}
            byToolAllFull={tools.byToolAllFull}
            totalTools={tools.totalTools}
            totalToolCalls={tools.totalToolCalls}
          />
        </div>
      </section>

      {/* Adapter distribution */}
      <AdapterListSection adapters={adapters} />
    </div>
  )
}
