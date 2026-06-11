/**
 * Shared dashboard presentation pieces reused across panels (operations
 * overview + project-mode overview) so both render skill/tool rankings and the
 * code-adoption funnel in the exact same visual mode.
 */
/* eslint-disable react-refresh/only-export-components */
import { useState } from "react"
import { Search, X, Info } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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

// ─────────────────────────────────────────────────────────
// Tooltip hint
// ─────────────────────────────────────────────────────────

export function InfoHint({ content }: { content: React.ReactNode }): React.JSX.Element {
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

// ─────────────────────────────────────────────────────────
// Searchable ranking list (skill / tool usage)
// ─────────────────────────────────────────────────────────

export type RankingItem = {
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

export function highlightRankingName(name: string, query: string): React.ReactNode {
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

export function sumRankingCounts(items: RankingItem[]): number {
  return items.reduce((total, item) => total + item.count, 0)
}

export function SearchableRankingPanel({
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
  renderNameAddon,
  className
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
  className?: string
}): React.JSX.Element {
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
    <div
      className={`flex h-[340px] flex-col rounded-xl border border-border bg-card p-4 ${className ?? ""}`}
    >
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

// ─────────────────────────────────────────────────────────
// Code adoption funnel
// ─────────────────────────────────────────────────────────

export interface CodeAdoptionFunnelData {
  inclusiveEffectiveGeneratedLines: number
  effectiveGeneratedLines: number
  pushedEffectiveGeneratedLines: number
  adoptedLines: number
  pushedAdoptedLines: number
  inclusiveAdoptionRate: number | null
  measuredAdoptionRate: number | null
  pushedAdoptionRate: number | null
  /** 已 Commit 关联的原始生成行数（未做有效性去重）；「Commit 提交」口径 tab 的第一层基数。 */
  measuredGeneratedLines?: number
}

type FunnelSourceTab = "agent" | "commit"

type FunnelStage = {
  key: string
  label: string
  lines: number
  adoptedLines: number
  rate: number | null
  color: string
  /** 隐藏顶部采纳率百分比（用于「已提交」口径第一层，仅体现原始→有效收窄）。 */
  hideRate?: boolean
  /** 覆盖默认「生成 X / 采纳 Y」副标签。 */
  metricText?: string
  /** 覆盖默认 hover 提示。 */
  titleText?: string
}

// 代码采纳漏斗：真·漏斗形状（梯形逐级收窄）。
// 漏斗宽度 = 各级生成行数（全部生成 → 已 Commit → 已 Push），标签 = 各级采纳率（越靠后越高）。
// enableSourceTabs：开启后可在「Agent 生成 / Commit 提交」两种第一层口径间切换。
export function CodeAdoptionFunnel({
  data,
  className,
  enableSourceTabs = false
}: {
  data: CodeAdoptionFunnelData
  className?: string
  enableSourceTabs?: boolean
}): React.JSX.Element {
  const [sourceTab, setSourceTab] = useState<FunnelSourceTab>("commit")
  const activeTab: FunnelSourceTab = enableSourceTabs ? sourceTab : "agent"

  // 第一层随口径切换：Agent 生成 = 全部生成（含未提交的有效行）；
  // Commit 提交 = 已 Commit 关联的「原始」生成行数（measuredGeneratedLines）。二、三层不变。
  const measuredGeneratedLines = data.measuredGeneratedLines ?? 0
  const firstStage: FunnelStage =
    activeTab === "commit"
      ? {
          // 「已提交」口径第一层：体现「原始生成 → 有效生成」的收窄，不展示采纳率。
          key: "all",
          label: "Commit 原始生成",
          lines: measuredGeneratedLines,
          adoptedLines: data.adoptedLines,
          rate: null,
          color: "#06b6d4",
          hideRate: true,
          metricText: `原始 ${formatNumber(measuredGeneratedLines)} / 有效 ${formatNumber(data.effectiveGeneratedLines)}`,
          titleText: `Commit 原始生成：原始 ${formatExactNumber(measuredGeneratedLines)} 行 · 有效 ${formatExactNumber(data.effectiveGeneratedLines)} 行`
        }
      : {
          key: "all",
          label: "全部生成",
          lines: data.inclusiveEffectiveGeneratedLines,
          adoptedLines: data.adoptedLines,
          rate: data.inclusiveAdoptionRate,
          color: "#06b6d4"
        }
  const stages: FunnelStage[] = [
    firstStage,
    {
      key: "commit",
      label: "已 Commit",
      lines: data.effectiveGeneratedLines,
      adoptedLines: data.adoptedLines,
      rate: data.measuredAdoptionRate,
      color: "#3b82f6"
    },
    {
      key: "push",
      label: "已 Push",
      lines: data.pushedEffectiveGeneratedLines,
      adoptedLines: data.pushedAdoptedLines,
      rate: data.pushedAdoptionRate,
      color: "#6366f1"
    }
  ]
  const hasData = stages.some((s) => s.lines > 0)
  const BAND_H = 40
  // 各级生成行数量级可能相差很大（如全部生成 50k vs 已 Commit 6k）。
  // 直接线性映射会让后段塌缩成不可见的细条、整体退化成三角形。
  // 这里用平方根压缩比例，并设最小宽度下限，保证每段可见且仍“逐级收窄”。
  const maxScaled = Math.max(...stages.map((s) => Math.sqrt(Math.max(0, s.lines))), 1)
  const halfWidthOf = (lines: number): number =>
    Math.max(9, (Math.sqrt(Math.max(0, lines)) / maxScaled) * 50)

  return (
    <div
      className={`flex h-full flex-col rounded-xl border border-border bg-card p-4 ${className ?? ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">代码采纳漏斗</h3>
        {enableSourceTabs ? (
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border">
            {(
              [
                { id: "commit", label: "已提交" },
                { id: "agent", label: "全量生成" }
              ] as Array<{ id: FunnelSourceTab; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  activeTab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
                onClick={() => setSourceTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="mb-2 mt-1 text-[10px] leading-tight text-muted-foreground">
        {activeTab === "commit"
          ? "第一层为已 Commit 的原始 / 有效生成行数；已 Commit、已 Push 标签为采纳率"
          : "漏斗按各级生成行数依次收窄，标签为各级采纳率"}
      </p>
      {!hasData ? (
        <div className="flex flex-1 items-center justify-center py-6 text-xs text-muted-foreground">
          暂无代码生成数据
        </div>
      ) : (
        <div className="flex flex-1 items-center gap-2.5">
          {/* 漏斗形状：纯锥形，撑满左侧空间 */}
          <div className="flex flex-1 flex-col">
            {stages.map((s, i) => {
              const topHalf = halfWidthOf(s.lines)
              const next = stages[i + 1]
              const botHalf = next ? halfWidthOf(next.lines) : topHalf * 0.5
              const clip = `polygon(${50 - topHalf}% 0, ${50 + topHalf}% 0, ${50 + botHalf}% 100%, ${50 - botHalf}% 100%)`
              return (
                <div
                  key={s.key}
                  className="relative"
                  style={{ height: BAND_H }}
                  title={
                    s.titleText ??
                    `${s.label}：生成 ${formatExactNumber(s.lines)} 行 · 采纳 ${formatExactNumber(s.adoptedLines)} 行 · 采纳率 ${formatPercent(s.rate)}`
                  }
                >
                  <div
                    className="absolute inset-0"
                    style={{ clipPath: clip, background: s.color }}
                  />
                </div>
              )
            })}
          </div>
          {/* 右侧标签：百分比移到此处（带颜色），自身宽度紧贴右边 */}
          <div className="flex shrink-0 flex-col">
            {stages.map((s) => (
              <div key={s.key} className="flex flex-col justify-center" style={{ height: BAND_H }}>
                <div className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-foreground">
                  <span
                    className="inline-block size-2 shrink-0 rounded-sm"
                    style={{ background: s.color }}
                  />
                  {s.label}
                  {s.hideRate ? null : (
                    <span className="font-semibold" style={{ color: s.color }}>
                      {formatPercent(s.rate)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 whitespace-nowrap text-[10px] text-muted-foreground">
                  {s.metricText ?? `生成 ${formatNumber(s.lines)} / 采纳 ${formatNumber(s.adoptedLines)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Skill ranking panel (usage / code-adoption tabs)
// ─────────────────────────────────────────────────────────

export interface SkillRankingDatum {
  skill: string
  count: number
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
  bySkillAdoption,
  activeTab,
  onTabChange,
  onSkillClick,
  marketSkillKeys,
  pluginSkillKeys
}: {
  bySkillAdoption: SkillAdoptionRankingItem[]
  activeTab: SkillRankingTab
  onTabChange: (tab: SkillRankingTab) => void
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
  pluginSkillKeys: Set<string>
}): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [sortKey, setSortKey] = useState<SkillAdoptionSortKey>(DEFAULT_SKILL_ADOPTION_SORT)
  const trimmedQuery = query.trim()
  const sortedItems = sortSkillAdoptionItems(bySkillAdoption, sortKey)
  const visibleItems = filterSkillAdoptionItems(sortedItems, trimmedQuery)
  const maxValue = sortedItems.reduce((max, item) => {
    const value = getSkillAdoptionSortValue(item, sortKey) ?? 0
    return Math.max(max, value)
  }, 0)
  const totalAdoptedLines = bySkillAdoption.reduce((total, item) => total + item.adoptedLines, 0)
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
              <span className="font-semibold text-foreground">{bySkillAdoption.length}</span> 种
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

      {bySkillAdoption.length === 0 ? (
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

/**
 * Skill ranking panel with 使用排行 / 代码采纳 tabs, market/plugin tags and a
 * usage-stats tooltip. Decoupled from any specific dashboard data shape so it can
 * be shared by the platform overview and the project-mode overview.
 */
export function SkillRankingPanel({
  bySkill,
  bySkillAll,
  totalSkills,
  totalSkillCalls,
  bySkillAdoption,
  onSkillClick,
  marketSkillKeys,
  pluginSkillKeys
}: {
  bySkill: SkillRankingDatum[]
  bySkillAll: SkillRankingDatum[]
  totalSkills: number
  totalSkillCalls: number
  bySkillAdoption: SkillAdoptionRankingItem[]
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
  pluginSkillKeys: Set<string>
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SkillRankingTab>("usage")
  if (activeTab === "adoption") {
    return (
      <SkillAdoptionRankingPanel
        bySkillAdoption={bySkillAdoption}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSkillClick={onSkillClick}
        marketSkillKeys={marketSkillKeys}
        pluginSkillKeys={pluginSkillKeys}
      />
    )
  }

  const defaultItems: RankingItem[] = bySkill.map((item) => ({
    name: item.skill,
    count: item.count
  }))
  const searchItems: RankingItem[] = (bySkillAll.length > 0 ? bySkillAll : bySkill).map((item) => ({
    name: item.skill,
    count: item.count
  }))
  const totalKinds = searchItems.length > 0 ? searchItems.length : totalSkills
  const totalCalls = searchItems.length > 0 ? sumRankingCounts(searchItems) : totalSkillCalls

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

// ─────────────────────────────────────────────────────────
// Tool ranking panel (已过滤 / 全部 toggle)
// ─────────────────────────────────────────────────────────

export interface ToolRankingDatum {
  tool: string
  count: number
}

export function ToolRankingPanel({
  byTool,
  byToolAll,
  byToolFilteredAll,
  byToolAllFull,
  totalTools,
  totalToolCalls
}: {
  byTool: ToolRankingDatum[]
  byToolAll: ToolRankingDatum[]
  byToolFilteredAll: ToolRankingDatum[]
  byToolAllFull: ToolRankingDatum[]
  totalTools: number
  totalToolCalls: number
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const defaultItems: RankingItem[] = (showAll ? byToolAll : byTool).map((item) => ({
    name: item.tool,
    count: item.count
  }))
  const searchItems: RankingItem[] = (
    showAll
      ? byToolAllFull.length > 0
        ? byToolAllFull
        : byToolAll
      : byToolFilteredAll.length > 0
        ? byToolFilteredAll
        : byTool
  ).map((item) => ({ name: item.tool, count: item.count }))
  const totalKinds = searchItems.length > 0 ? searchItems.length : totalTools
  const totalCalls = searchItems.length > 0 ? sumRankingCounts(searchItems) : totalToolCalls

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
