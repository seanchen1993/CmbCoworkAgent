import { useState } from "react"
import {
  Boxes,
  Layers,
  Activity,
  MessagesSquare,
  Wrench,
  Cpu,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  Plug,
  CircleAlert,
  Code2,
  Gauge
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  CodeAdoptionFunnel,
  SearchableRankingPanel,
  type CodeAdoptionFunnelData,
  type RankingItem
} from "./dashboard-shared"
import type {
  DashboardProjectModeData,
  DashboardProjectModeProject,
  DashboardProjectModeSkillCount
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

function CompatibilityBadge({
  compatible,
  status
}: {
  compatible?: boolean
  status?: string
}): React.JSX.Element {
  if (compatible === undefined) return <span className="text-muted-foreground">—</span>
  return (
    <Badge variant={compatible ? "nominal" : "warning"} className="normal-case tracking-normal">
      {compatible ? "兼容" : status || "不兼容"}
    </Badge>
  )
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
                {project.hasError && (
                  <CircleAlert
                    className="size-3.5 shrink-0 text-status-critical"
                    aria-label="探测异常"
                  />
                )}
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
        <td className="px-3 py-2">
          <CompatibilityBadge
            compatible={project.compatible}
            status={project.compatibilityStatus}
          />
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{formatNumber(project.featureCount)}</td>
        <td className="px-3 py-2 text-right font-medium tabular-nums">
          {formatNumber(project.conversationCount)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {formatPercent(project.codeStats?.measuredAdoptionRate)}
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
                      {formatNumber(project.codeStats?.effectiveGeneratedLines ?? 0)}
                    </span>
                  </span>
                  <span>
                    采纳行数{" "}
                    <span className="font-medium text-foreground">
                      {formatNumber(project.codeStats?.adoptedLines ?? 0)}
                    </span>
                  </span>
                  <span>
                    采纳率{" "}
                    <span className="font-medium text-foreground">
                      {formatPercent(project.codeStats?.measuredAdoptionRate)}
                    </span>
                  </span>
                </div>
              </div>

              {/* 功能状态 */}
              {project.features.length === 0 ? (
                <div className="text-xs text-muted-foreground">该项目暂无功能记录</div>
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

export function ProjectModePanel({
  data,
  loading,
  error,
  onOpenTraces
}: {
  data: DashboardProjectModeData | null
  loading: boolean
  error: string | null
  onOpenTraces: (project: DashboardProjectModeProject) => void
}): React.JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)

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
  const skillItems: RankingItem[] = (data?.topSkills ?? []).map((item) => ({
    name: item.skill,
    count: item.count
  }))

  return (
    <div className="space-y-6">
      {/* 概览卡片（左）+ 代码采纳漏斗（右），与平台运营概览一致 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">项目运营概览</h2>
        <div className="grid grid-cols-[minmax(0,1fr)_240px] gap-3">
          <div className="grid grid-cols-2 gap-3 content-start md:grid-cols-3 xl:grid-cols-5">
            <StatCard
              icon={Boxes}
              label="项目总数"
              value={formatNumber(summary?.projectCount ?? 0)}
              color="bg-blue-500"
            />
            <StatCard
              icon={Layers}
              label="功能总数"
              value={formatNumber(summary?.featureCount ?? 0)}
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
              icon={Wrench}
              label="工具调用"
              value={formatNumber(summary?.totalToolCalls ?? 0)}
              color="bg-amber-500"
            />
            <StatCard
              icon={Cpu}
              label="Token"
              value={formatCompact(summary?.totalTokens ?? 0)}
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

      {/* Skill 使用排行，与平台运营概览同款 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">技能使用</h2>
        <SearchableRankingPanel
          title="Skill 使用"
          totalKinds={summary?.distinctSkillCount ?? 0}
          totalCalls={summary?.skillCallCount ?? 0}
          defaultItems={skillItems}
          searchItems={skillItems}
          searchPlaceholder="搜索 Skill 名称"
          emptyLabel="暂无 Skill 数据"
          emptySearchLabel="未找到匹配的 Skill"
          barColorClassName="bg-blue-500"
        />
      </section>

      {/* Adapter distribution */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">插件列表</h2>
        <div className="rounded-xl border border-border bg-card">
          {adapters.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无数据</div>
          ) : (
            <div className="divide-y divide-border">
              {adapters.map((adapter) => (
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
                      对话{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(adapter.conversationCount)}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Project list */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">项目列表</h2>
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
                <th className="px-3 py-2 text-left font-medium">适配器</th>
                <th className="px-3 py-2 text-left font-medium">生命周期</th>
                <th className="px-3 py-2 text-left font-medium">兼容性</th>
                <th className="px-3 py-2 text-right font-medium">功能数</th>
                <th className="px-3 py-2 text-right font-medium">对话数</th>
                <th className="px-3 py-2 text-right font-medium">采纳率</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
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
              {projects.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                    暂无项目模式数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
