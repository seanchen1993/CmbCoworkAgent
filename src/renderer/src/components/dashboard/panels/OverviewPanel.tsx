import { useState } from "react"
import {
  Activity,
  Users,
  Clock,
  ArrowDownToLine,
  ArrowUpFromLine,
  Code2,
  Trash2,
  Gauge,
  Search,
  X,
  Info
} from "lucide-react"
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend
} from "recharts"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { OverviewData } from "../use-dashboard"
import { hasMarketSkill, normalizeMarketSkillKey } from "../skill-market"
import {
  DEFAULT_SKILL_ADOPTION_SORT,
  SKILL_ADOPTION_SORT_LABELS,
  filterSkillAdoptionItems,
  getSkillAdoptionSortValue,
  sortSkillAdoptionItems,
  type SkillAdoptionRankingItem,
  type SkillAdoptionSortKey
} from "../skill-adoption-ranking"

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
  tooltipContent,
  onClick
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  color: string
  tooltipContent?: React.ReactNode
  onClick?: () => void
}) {
  const className = `flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left ${
    onClick
      ? "cursor-pointer transition-colors hover:bg-muted/30"
      : tooltipContent
        ? "cursor-help"
        : ""
  }`
  const content = (
    <>
      <div className={`flex size-9 items-center justify-center rounded-lg ${color}`}>
        <Icon className="size-4 text-white" />
      </div>
      <div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="text-lg font-bold text-foreground leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </>
  )
  const card = onClick ? (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )

  if (!tooltipContent) return card

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent className="max-w-64">{tooltipContent}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

function formatPercent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toFixed(2)}%`
}

function formatExactNumber(n: number): string {
  return Math.round(n).toLocaleString("zh-CN")
}

function InclusiveAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">含未提交采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">未提交生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeUnmeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">含未提交分母</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeInclusiveEffectiveGeneratedLines)} 行
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function MeasuredAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已Commit采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已测量原始生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codeMeasuredGeneratedLines)} 行
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / 已测量有效生成行数。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
      </div>
    </div>
  )
}

function PushedAdoptionTooltip({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">已 Push 采纳率</div>
      <div className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 采纳行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedAdoptedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 有效生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedEffectiveGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push 原始生成行数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedMeasuredGeneratedLines)} 行
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">已 Push Commit 数</span>
          <span className="font-medium text-foreground">
            {formatExactNumber(data.codePushedCommitCount)} 次
          </span>
        </div>
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / 已 Push 有效生成行数。</div>
        <div>仅统计通过应用成功 Push 后的 commit。</div>
      </div>
    </div>
  )
}

function GeneratedLinesTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">代码生成行数说明</div>
      <div className="text-muted-foreground">当前按 agent 写入或编辑的非空行统计。</div>
      <div className="text-muted-foreground">空行和仅包含空白字符的行不会计入。</div>
      <div className="text-muted-foreground">
        该指标表示原始生成量，包含后续被 agent 自己改写的中间稿。
      </div>
    </div>
  )
}

function SkillUsageTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">Skill 使用统计说明</div>
      <div className="text-muted-foreground">
        当一次运行中读取到某个 Skill 的文件或目录时，会记为使用了该 Skill。
      </div>
      <div className="text-muted-foreground">若一条 trace 使用多个 Skill，会分别计入各自次数。</div>
      <div className="text-muted-foreground">
        展示名称会带 Skill 版本；若版本解析失败，默认显示为 v1.0.0。
      </div>
    </div>
  )
}

function InfoHint({ content }: { content: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-label="查看说明"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

type RankingItem = {
  name: string
  count: number
}

function normalizeRankingLookup(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
}

function matchesRankingQuery(name: string, query: string): boolean {
  const trimmed = query.trim()
  if (!trimmed) return true

  const rawQuery = trimmed.toLowerCase()
  const normalizedQuery = normalizeRankingLookup(trimmed)
  return (
    name.toLowerCase().includes(rawQuery) || normalizeRankingLookup(name).includes(normalizedQuery)
  )
}

function highlightRankingName(name: string, query: string): React.ReactNode {
  const trimmed = query.trim()
  if (!trimmed) return name

  const rawName = name.toLowerCase()
  const rawQuery = trimmed.toLowerCase()
  const matchIndex = rawName.indexOf(rawQuery)
  if (matchIndex === -1) return name

  return (
    <>
      {name.slice(0, matchIndex)}
      <mark className="rounded bg-primary/15 px-0.5 text-foreground">
        {name.slice(matchIndex, matchIndex + trimmed.length)}
      </mark>
      {name.slice(matchIndex + trimmed.length)}
    </>
  )
}

function sumRankingCounts(items: RankingItem[]): number {
  return items.reduce((total, item) => total + item.count, 0)
}

type SkillRankingTab = "usage" | "adoption"

function SkillRankingTabs({
  activeTab,
  onTabChange
}: {
  activeTab: SkillRankingTab
  onTabChange: (tab: SkillRankingTab) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center rounded-md border border-border overflow-hidden">
      <button
        type="button"
        className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
          activeTab === "usage"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted/50"
        }`}
        onClick={() => onTabChange("usage")}
      >
        使用排行
      </button>
      <button
        type="button"
        className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
          activeTab === "adoption"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted/50"
        }`}
        onClick={() => onTabChange("adoption")}
      >
        代码采纳
      </button>
    </div>
  )
}

function SearchableRankingPanel({
  title,
  totalKinds,
  totalCalls,
  defaultItems,
  searchItems,
  searchPlaceholder,
  emptyLabel,
  emptySearchLabel,
  barColorClassName,
  labelClassName,
  onItemClick,
  headerActions,
  titleTooltipContent,
  renderNameAddon
}: {
  title: string
  totalKinds: number
  totalCalls: number
  defaultItems: RankingItem[]
  searchItems: RankingItem[]
  searchPlaceholder: string
  emptyLabel: string
  emptySearchLabel: string
  barColorClassName: string
  labelClassName?: string
  onItemClick?: (name: string) => void
  headerActions?: React.ReactNode
  titleTooltipContent?: React.ReactNode
  renderNameAddon?: (name: string) => React.ReactNode
}) {
  const [query, setQuery] = useState("")
  const trimmedQuery = query.trim()
  const visibleItems = trimmedQuery
    ? searchItems.filter((item) => matchesRankingQuery(item.name, trimmedQuery))
    : defaultItems
  const maxCount = searchItems[0]?.count ?? defaultItems[0]?.count ?? 0
  const statusLabel = trimmedQuery
    ? `匹配 ${visibleItems.length} 项`
    : defaultItems.length > 0
      ? `Top ${defaultItems.length}`
      : "暂无排行"

  return (
    <div className="flex h-[340px] flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
            {titleTooltipContent ? <InfoHint content={titleTooltipContent} /> : null}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{totalKinds}</span> 种
            </span>
            <span className="text-border">|</span>
            <span>
              共 <span className="font-semibold text-foreground">{formatNumber(totalCalls)}</span>{" "}
              次调用
            </span>
          </div>
        </div>
        {headerActions}
      </div>

      <div className="mb-3 flex shrink-0 items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 rounded-md border-border bg-background pl-8 pr-8 text-xs"
          />
          {trimmedQuery ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {searchItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-4 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-4 text-center text-xs text-muted-foreground">
          {emptySearchLabel}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            {visibleItems.map((item, i) => {
              const pct = maxCount > 0 ? (item.count / maxCount) * 100 : 0
              const rank = trimmedQuery
                ? searchItems.findIndex((candidate) => candidate.name === item.name) + 1
                : i + 1
              const content = (
                <>
                  <span className="w-7 shrink-0 text-right text-[10px] text-muted-foreground">
                    {rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          title={item.name}
                          className={`min-w-0 truncate text-xs text-foreground ${labelClassName ?? ""}`}
                        >
                          {highlightRankingName(item.name, trimmedQuery)}
                        </span>
                        {renderNameAddon?.(item.name)}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {item.count}
                      </span>
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${barColorClassName}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </>
              )

              if (onItemClick) {
                return (
                  <button
                    key={item.name}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onItemClick(item.name)}
                  >
                    {content}
                  </button>
                )
              }

              return (
                <div key={item.name} className="flex items-center gap-2">
                  {content}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function formatNullablePercent(value: number | null): string {
  return value === null ? "—" : formatPercent(value)
}

function formatSkillAdoptionSortValue(
  item: SkillAdoptionRankingItem,
  sortKey: SkillAdoptionSortKey
): string {
  const value = getSkillAdoptionSortValue(item, sortKey)
  if (value === null) return "—"
  if (
    sortKey === "measuredAdoptionRate" ||
    sortKey === "inclusiveAdoptionRate" ||
    sortKey === "pushedAdoptionRate"
  )
    return formatPercent(value)
  if (sortKey === "commitCount" || sortKey === "pushedCommitCount")
    return `${formatNumber(value)} 次`
  return `${formatNumber(value)} 行`
}

function SkillAdoptionRankingPanel({
  data,
  activeTab,
  onTabChange,
  onSkillClick,
  marketSkillKeys,
  pluginSkillKeys
}: {
  data: OverviewData
  activeTab: SkillRankingTab
  onTabChange: (tab: SkillRankingTab) => void
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
  pluginSkillKeys: Set<string>
}) {
  const [query, setQuery] = useState("")
  const [sortKey, setSortKey] = useState<SkillAdoptionSortKey>(DEFAULT_SKILL_ADOPTION_SORT)
  const trimmedQuery = query.trim()
  const sortedItems = sortSkillAdoptionItems(data.bySkillAdoption, sortKey)
  const visibleItems = filterSkillAdoptionItems(sortedItems, trimmedQuery)
  const maxValue = sortedItems.reduce((max, item) => {
    const value = getSkillAdoptionSortValue(item, sortKey) ?? 0
    return Math.max(max, value)
  }, 0)
  const totalAdoptedLines = data.bySkillAdoption.reduce(
    (total, item) => total + item.adoptedLines,
    0
  )
  const statusLabel = trimmedQuery
    ? `匹配 ${visibleItems.length} 项`
    : `按 ${SKILL_ADOPTION_SORT_LABELS[sortKey]}`

  return (
    <div className="flex h-[340px] flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Skill 使用</h3>
            <InfoHint content={<SkillUsageTooltip />} />
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{data.bySkillAdoption.length}</span>{" "}
              种
            </span>
            <span className="text-border">|</span>
            <span>
              共{" "}
              <span className="font-semibold text-foreground">
                {formatNumber(totalAdoptedLines)}
              </span>{" "}
              行采纳
            </span>
          </div>
        </div>
        <SkillRankingTabs activeTab={activeTab} onTabChange={onTabChange} />
      </div>

      <div className="mb-3 flex shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Skill 名称，不限 Top 20"
            className="h-8 rounded-md border-border bg-background pl-8 pr-8 text-xs"
          />
          {trimmedQuery ? (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <select
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SkillAdoptionSortKey)}
          className="h-8 shrink-0 rounded-md border border-border bg-background px-2 text-[11px] text-foreground"
          aria-label="选择 Skill 代码采纳排序"
        >
          {(Object.keys(SKILL_ADOPTION_SORT_LABELS) as SkillAdoptionSortKey[]).map((key) => (
            <option key={key} value={key}>
              {SKILL_ADOPTION_SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </div>

      {data.bySkillAdoption.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-4 text-center text-xs text-muted-foreground">
          暂无 Skill 代码采纳数据
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-4 text-center text-xs text-muted-foreground">
          未找到匹配的 Skill
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            {visibleItems.map((item) => {
              const primaryValue = getSkillAdoptionSortValue(item, sortKey) ?? 0
              const pct = maxValue > 0 ? (primaryValue / maxValue) * 100 : 0
              const rank = sortedItems.findIndex((candidate) => candidate.skill === item.skill) + 1
              const content = (
                <>
                  <span className="w-7 shrink-0 text-right text-[10px] text-muted-foreground">
                    {rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span
                          title={item.skill}
                          className="min-w-0 truncate text-xs text-foreground"
                        >
                          {highlightRankingName(item.skill, trimmedQuery)}
                        </span>
                        {hasMarketSkill(marketSkillKeys, item.skill) ? <MarketSkillTag /> : null}
                        {hasPluginSkill(pluginSkillKeys, item.skill) ? <PluginSkillTag /> : null}
                      </div>
                      <span className="shrink-0 text-[11px] font-medium text-foreground">
                        {formatSkillAdoptionSortValue(item, sortKey)}
                      </span>
                    </div>
                    <div className="mb-1 truncate text-[10px] text-muted-foreground">
                      已Commit {formatNullablePercent(item.measuredAdoptionRate)}
                      <span className="mx-1 text-border">|</span>
                      含未提交 {formatNullablePercent(item.inclusiveAdoptionRate)}
                      <span className="mx-1 text-border">|</span>已 Push{" "}
                      {formatNullablePercent(item.pushedAdoptionRate)}
                      <span className="mx-1 text-border">|</span>
                      采纳 {formatNumber(item.adoptedLines)} 行
                      <span className="mx-1 text-border">|</span>
                      提交 {formatNumber(item.commitCount)} 次
                      <span className="mx-1 text-border">|</span>
                      Push {formatNumber(item.pushedCommitCount)} 次
                    </div>
                    <div className="h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-cyan-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </>
              )

              if (onSkillClick) {
                return (
                  <button
                    key={item.skill}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onSkillClick(item.skill)}
                  >
                    {content}
                  </button>
                )
              }

              return (
                <div key={item.skill} className="flex items-center gap-2">
                  {content}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function SkillRankingPanel({
  data,
  onSkillClick,
  marketSkillKeys,
  pluginSkillKeys
}: {
  data: OverviewData
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
  pluginSkillKeys: Set<string>
}) {
  const [activeTab, setActiveTab] = useState<SkillRankingTab>("usage")
  if (activeTab === "adoption") {
    return (
      <SkillAdoptionRankingPanel
        data={data}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSkillClick={onSkillClick}
        marketSkillKeys={marketSkillKeys}
        pluginSkillKeys={pluginSkillKeys}
      />
    )
  }

  const defaultItems: RankingItem[] = data.bySkill.map((item) => ({
    name: item.skill,
    count: item.count
  }))
  const searchItems: RankingItem[] = (
    data.bySkillAll.length > 0 ? data.bySkillAll : data.bySkill
  ).map((item) => ({
    name: item.skill,
    count: item.count
  }))
  const totalKinds = searchItems.length > 0 ? searchItems.length : data.totalSkills
  const totalCalls = searchItems.length > 0 ? sumRankingCounts(searchItems) : data.totalSkillCalls

  return (
    <SearchableRankingPanel
      title="Skill 使用"
      totalKinds={totalKinds}
      totalCalls={totalCalls}
      defaultItems={defaultItems}
      searchItems={searchItems}
      searchPlaceholder="搜索 Skill 名称，不限 Top 20"
      emptyLabel="暂无 Skill 数据"
      emptySearchLabel="未找到匹配的 Skill"
      barColorClassName="bg-blue-500"
      onItemClick={onSkillClick}
      headerActions={<SkillRankingTabs activeTab={activeTab} onTabChange={setActiveTab} />}
      titleTooltipContent={<SkillUsageTooltip />}
      renderNameAddon={(name) => (
        <>
          {hasMarketSkill(marketSkillKeys, name) ? <MarketSkillTag /> : null}
          {hasPluginSkill(pluginSkillKeys, name) ? <PluginSkillTag /> : null}
        </>
      )}
    />
  )
}

function hasPluginSkill(pluginSkillKeys: Set<string>, skillName: string): boolean {
  const key = normalizeMarketSkillKey(skillName)
  return Boolean(key && pluginSkillKeys.has(key))
}

function MarketSkillTag(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm border border-emerald-200 bg-emerald-50 px-1 py-px text-[9px] font-medium leading-3 text-emerald-700">
      市场
    </span>
  )
}

function PluginSkillTag(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm border border-sky-200 bg-sky-50 px-1 py-px text-[9px] font-medium leading-3 text-sky-700">
      Plugin
    </span>
  )
}

function ToolRankingPanel({ data }: { data: OverviewData }) {
  const [showAll, setShowAll] = useState(false)
  const defaultItems: RankingItem[] = (showAll ? data.byToolAll : data.byTool).map((item) => ({
    name: item.tool,
    count: item.count
  }))
  const searchItems: RankingItem[] = (
    showAll
      ? data.byToolAllFull.length > 0
        ? data.byToolAllFull
        : data.byToolAll
      : data.byToolFilteredAll.length > 0
        ? data.byToolFilteredAll
        : data.byTool
  ).map((item) => ({ name: item.tool, count: item.count }))
  const totalKinds = searchItems.length > 0 ? searchItems.length : data.totalTools
  const totalCalls = searchItems.length > 0 ? sumRankingCounts(searchItems) : data.totalToolCalls

  return (
    <SearchableRankingPanel
      title="Tool 使用"
      totalKinds={totalKinds}
      totalCalls={totalCalls}
      defaultItems={defaultItems}
      searchItems={searchItems}
      searchPlaceholder={showAll ? "搜索 Tool 名称（全部）" : "搜索 Tool 名称（已过滤）"}
      emptyLabel="暂无 Tool 数据"
      emptySearchLabel="未找到匹配的 Tool"
      barColorClassName="bg-violet-500"
      labelClassName="font-mono"
      headerActions={
        <div className="flex items-center rounded-md border border-border overflow-hidden">
          <button
            type="button"
            className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
              !showAll
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => setShowAll(false)}
          >
            已过滤
          </button>
          <button
            type="button"
            className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
              showAll
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => setShowAll(true)}
          >
            全部
          </button>
        </div>
      }
    />
  )
}

export function OverviewPanel({
  data,
  loading,
  onSkillClick,
  onActiveUsersClick,
  marketSkillKeys = new Set(),
  pluginSkillKeys = new Set()
}: {
  data: OverviewData | null
  loading: boolean
  onSkillClick?: (skill: string) => void
  onActiveUsersClick?: () => void
  marketSkillKeys?: Set<string>
  pluginSkillKeys?: Set<string>
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  const trendData = data.trend

  return (
    <div className="space-y-4">
      {/* Row 1: Core metrics */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          icon={Activity}
          label="调用总次数"
          value={formatNumber(data.totalCalls)}
          color="bg-blue-500"
        />
        <StatCard
          icon={Users}
          label="活跃用户数"
          value={String(data.activeUsers)}
          color="bg-violet-500"
          onClick={onActiveUsersClick}
        />
        <StatCard
          icon={Clock}
          label="平均耗时"
          value={formatDuration(data.avgDurationMs)}
          color="bg-amber-500"
        />
        <StatCard
          icon={ArrowDownToLine}
          label="输入 Token"
          value={formatNumber(data.inputTokens)}
          color="bg-sky-500"
        />
        <StatCard
          icon={ArrowUpFromLine}
          label="输出 Token"
          value={formatNumber(data.outputTokens)}
          color="bg-rose-500"
        />
      </div>

      {/* Row 2: Code adoption metrics */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          icon={Code2}
          label="代码生成行数"
          value={formatNumber(data.codeGeneratedLines)}
          color="bg-emerald-500"
          tooltipContent={<GeneratedLinesTooltip />}
        />
        <StatCard
          icon={Trash2}
          label="代码删除行数"
          value={formatNumber(data.codeDeletedLines)}
          color="bg-zinc-500"
        />
        <StatCard
          icon={Gauge}
          label="已 Push 采纳率"
          value={formatPercent(data.codePushedAdoptionRate)}
          sub={
            data.codePushedAdoptionRate === null
              ? "暂无已 Push 数据"
              : `${formatNumber(data.codePushedAdoptedLines)} / ${formatNumber(data.codePushedEffectiveGeneratedLines)} 行`
          }
          color="bg-indigo-500"
          tooltipContent={<PushedAdoptionTooltip data={data} />}
        />
        <StatCard
          icon={Gauge}
          label="已Commit采纳率"
          value={formatPercent(data.codeMeasuredAdoptionRate)}
          sub={
            data.codeMeasuredAdoptionRate === null
              ? "暂无测量数据"
              : `${formatNumber(data.codeAdoptedLines)} / ${formatNumber(data.codeEffectiveGeneratedLines)} 行`
          }
          color="bg-blue-500"
          tooltipContent={<MeasuredAdoptionTooltip data={data} />}
        />
        <StatCard
          icon={Gauge}
          label="含未提交采纳率"
          value={formatPercent(data.codeInclusiveAdoptionRate)}
          sub={
            data.codeInclusiveAdoptionRate === null
              ? "暂无代码生成数据"
              : `${formatNumber(data.codeAdoptedLines)} / ${formatNumber(data.codeInclusiveEffectiveGeneratedLines)} 行`
          }
          color="bg-cyan-500"
          tooltipContent={<InclusiveAdoptionTooltip data={data} />}
        />
      </div>

      {/* Skill & Tool Top rankings */}
      <div className="grid grid-cols-2 gap-3">
        <SkillRankingPanel
          data={data}
          onSkillClick={onSkillClick}
          marketSkillKeys={marketSkillKeys}
          pluginSkillKeys={pluginSkillKeys}
        />
        <ToolRankingPanel data={data} />
      </div>

      {/* Trend chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-xs font-medium text-muted-foreground mb-3">调用量趋势</h3>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              yAxisId="calls"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="users"
              orientation="right"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={{ stroke: "var(--color-border)" }}
              allowDecimals={false}
            />
            <RechartsTooltip
              formatter={(value, name) => [
                Number(value ?? 0).toLocaleString("zh-CN"),
                String(name)
              ]}
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              yAxisId="users"
              dataKey="users"
              name="活跃用户"
              fill="#8b5cf6"
              fillOpacity={0.75}
              barSize={18}
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId="calls"
              type="monotone"
              dataKey="count"
              name="调用次数"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
