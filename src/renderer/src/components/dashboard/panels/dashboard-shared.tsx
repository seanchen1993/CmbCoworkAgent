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
import { hasMarketSkill } from "../skill-market"
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
// 代码采纳 tooltip 说明（平台运营概览 / 项目运营概览 共用）
// ─────────────────────────────────────────────────────────

/** 代码采纳各级 tooltip 所需的行数明细（OverviewData 与 DashboardCodeStats 都可映射到此结构）。 */
export interface CodeStatsTooltipData {
  adoptedLines: number
  effectiveGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  measuredGeneratedLines: number
  pushedAdoptedLines: number
  pushedEffectiveGeneratedLines: number
  pushedMeasuredGeneratedLines: number
  pushedCommitCount: number
}

function TooltipRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}

export function GeneratedLinesTooltip(): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium text-foreground">代码生成行数说明</div>
      <div className="text-muted-foreground">当前按 agent 写入或编辑的非空行统计。</div>
      <div className="text-muted-foreground">空行和仅包含空白字符的行不会计入。</div>
      <div className="text-muted-foreground">
        该指标表示原始生成量，包含后续被 agent 自己改写的中间稿。
      </div>
      <div className="text-muted-foreground">
        以下文件不纳入统计：非代码文件（如
        Markdown、JSON、YAML、.properties、图片等）、锁文件（package-lock.json、pnpm-lock.yaml、yarn.lock）、压缩/构建产物（.min.js/.min.css、.map）、依赖与构建目录（node_modules、dist、build
        等）。
      </div>
    </div>
  )
}

export function PushedAdoptionTooltip({ data }: { data: CodeStatsTooltipData }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">入库采纳率（已 Push 采纳率）</div>
      <div className="space-y-1 text-[11px]">
        <TooltipRow
          label="已 Push 采纳行数"
          value={`${formatExactNumber(data.pushedAdoptedLines)} 行`}
        />
        <TooltipRow
          label="已 Push 有效生成行数"
          value={`${formatExactNumber(data.pushedEffectiveGeneratedLines)} 行`}
        />
        <TooltipRow
          label="已 Push 原始生成行数"
          value={`${formatExactNumber(data.pushedMeasuredGeneratedLines)} 行`}
        />
        <TooltipRow
          label="已 Push Commit 数"
          value={`${formatExactNumber(data.pushedCommitCount)} 次`}
        />
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / 已 Push 有效生成行数。</div>
        <div>仅统计通过应用成功 Push 后的 commit。</div>
      </div>
    </div>
  )
}

export function MeasuredAdoptionTooltip({
  data
}: {
  data: CodeStatsTooltipData
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">提交采纳率（已 Commit 采纳率）</div>
      <div className="space-y-1 text-[11px]">
        <TooltipRow label="采纳行数" value={`${formatExactNumber(data.adoptedLines)} 行`} />
        <TooltipRow
          label="已测量有效生成行数"
          value={`${formatExactNumber(data.effectiveGeneratedLines)} 行`}
        />
        <TooltipRow
          label="已测量原始生成行数"
          value={`${formatExactNumber(data.measuredGeneratedLines)} 行`}
        />
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / 已测量有效生成行数。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
        <div>口径等同组织级工具的「代码入库率」，可横向对比。</div>
      </div>
    </div>
  )
}

export function InclusiveAdoptionTooltip({
  data
}: {
  data: CodeStatsTooltipData
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">
        总量提交采纳率（相对全部有效生成）
      </div>
      <div className="space-y-1 text-[11px]">
        <TooltipRow label="采纳行数" value={`${formatExactNumber(data.adoptedLines)} 行`} />
        <TooltipRow
          label="已测量有效生成行数"
          value={`${formatExactNumber(data.effectiveGeneratedLines)} 行`}
        />
        <TooltipRow
          label="未提交生成行数"
          value={`${formatExactNumber(data.unmeasuredGeneratedLines)} 行`}
        />
        <TooltipRow
          label="含未提交分母"
          value={`${formatExactNumber(data.inclusiveEffectiveGeneratedLines)} 行`}
        />
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>已测量有效生成行数已剔除被 agent 自己改写的中间稿部分。</div>
        <div>
          分母合计通常小于「代码生成行数」：已提交部分已扣除被 agent
          改写覆盖/回退的中间稿，未提交部分尚未测量、仍按原始行数计入。
        </div>
      </div>
    </div>
  )
}

export function InclusivePushedAdoptionTooltip({
  data
}: {
  data: CodeStatsTooltipData
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-foreground">
        总量入库采纳率（已 Push 真实入库率）
      </div>
      <div className="space-y-1 text-[11px]">
        <TooltipRow
          label="已 Push 采纳行数"
          value={`${formatExactNumber(data.pushedAdoptedLines)} 行`}
        />
        <TooltipRow
          label="已测量有效生成行数"
          value={`${formatExactNumber(data.effectiveGeneratedLines)} 行`}
        />
        <TooltipRow
          label="未提交生成行数"
          value={`${formatExactNumber(data.unmeasuredGeneratedLines)} 行`}
        />
        <TooltipRow
          label="含未提交分母"
          value={`${formatExactNumber(data.inclusiveEffectiveGeneratedLines)} 行`}
        />
      </div>
      <div className="space-y-0.5 text-[10px] text-muted-foreground">
        <div>采纳率 = 已 Push 采纳行数 / (已测量有效生成行数 + 未提交生成行数)。</div>
        <div>Agent 有效产出中最终真实推送入库的比例，分母含未提交，口径最严。</div>
        <div>
          分母合计通常小于「代码生成行数」：已提交部分已扣除被 agent
          改写覆盖/回退的中间稿，未提交部分尚未测量、仍按原始行数计入。
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Searchable ranking list (skill / tool usage)
// ─────────────────────────────────────────────────────────

export type RankingItem = {
  id?: string
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
  renderNameAddon?: (item: RankingItem) => React.ReactNode
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
                ? searchItems.findIndex(
                    (candidate) => (candidate.id ?? candidate.name) === (item.id ?? item.name)
                  ) + 1
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
                        {renderNameAddon?.(item)}
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
                    key={item.id ?? item.name}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onItemClick(item.name)}
                  >
                    {content}
                  </button>
                )
              }

              return (
                <div key={item.id ?? item.name} className="flex items-center gap-2">
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
  /** 已 Push 采纳行 ÷ 有效生成总量（总量口径 · 入库）。 */
  inclusivePushedAdoptionRate: number | null
  /** 已 Commit 关联的原始生成行数（未做有效性去重）。 */
  measuredGeneratedLines?: number
}

type FunnelScopeTab = "total" | "commit"

type FunnelStage = {
  key: string
  label: string
  /** 当前漏斗段顶部宽度依据。 */
  topBasis: number
  /** 当前漏斗段底部宽度依据。 */
  bottomBasis: number
  /** 该口径下「生成」分母行数（副标签展示）。 */
  generatedLines: number
  adoptedLines: number
  rate: number | null
  color: string
}

const FUNNEL_COMMIT_COLOR = "#3b82f6"
const FUNNEL_PUSH_COLOR = "#6366f1"

// 代码采纳漏斗：真·漏斗形状（梯形逐级收窄），两层 = 生成 → 已 Commit → 已 Push。
// 两个口径 tab 切换分母：
//   - 总量：分母 = 有效生成总量（含未提交）→ 总量提交采纳率 / 总量入库采纳率
//   - 提交：分母 = 各阶段已落库代码 → 提交采纳率 / 入库采纳率
// 每段宽度按「上一阶段留存量 → 当前阶段采纳量」绘制，标签为各级采纳率。
export function CodeAdoptionFunnel({
  data,
  className,
  onFirstStageClick
}: {
  data: CodeAdoptionFunnelData
  className?: string
  /** 点击总量口径首层下钻：分析「生成了但没提交」的人与原因。 */
  onFirstStageClick?: () => void
}): React.JSX.Element {
  const [scopeTab, setScopeTab] = useState<FunnelScopeTab>("total")

  const stages: FunnelStage[] =
    scopeTab === "total"
      ? [
          {
            key: "commit",
            label: "已 Commit",
            topBasis: data.inclusiveEffectiveGeneratedLines,
            bottomBasis: data.adoptedLines,
            generatedLines: data.inclusiveEffectiveGeneratedLines,
            adoptedLines: data.adoptedLines,
            rate: data.inclusiveAdoptionRate,
            color: FUNNEL_COMMIT_COLOR
          },
          {
            key: "push",
            label: "已 Push",
            topBasis: data.adoptedLines,
            bottomBasis: data.pushedAdoptedLines,
            generatedLines: data.inclusiveEffectiveGeneratedLines,
            adoptedLines: data.pushedAdoptedLines,
            rate: data.inclusivePushedAdoptionRate,
            color: FUNNEL_PUSH_COLOR
          }
        ]
      : [
          {
            key: "commit",
            label: "已 Commit",
            topBasis: data.effectiveGeneratedLines,
            bottomBasis: data.adoptedLines,
            generatedLines: data.effectiveGeneratedLines,
            adoptedLines: data.adoptedLines,
            rate: data.measuredAdoptionRate,
            color: FUNNEL_COMMIT_COLOR
          },
          {
            key: "push",
            label: "已 Push",
            topBasis: data.adoptedLines,
            bottomBasis: data.pushedAdoptedLines,
            generatedLines: data.pushedEffectiveGeneratedLines,
            adoptedLines: data.pushedAdoptedLines,
            rate: data.pushedAdoptionRate,
            color: FUNNEL_PUSH_COLOR
          }
        ]
  const hasData = stages.some((s) => s.generatedLines > 0 || s.adoptedLines > 0)
  const BAND_H = 48
  // 生成量与采纳量可能差异较大，用平方根压缩 + 最小宽度下限，保证每段可见。
  const maxScaled = Math.max(
    ...stages.flatMap((s) => [
      Math.sqrt(Math.max(0, s.topBasis)),
      Math.sqrt(Math.max(0, s.bottomBasis))
    ]),
    1
  )
  const halfWidthOf = (basis: number): number =>
    Math.max(9, (Math.sqrt(Math.max(0, basis)) / maxScaled) * 50)

  return (
    <div
      className={`flex h-full flex-col rounded-xl border border-border bg-card p-4 ${className ?? ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">代码采纳漏斗</h3>
        <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border">
          {(
            [
              { id: "total", label: "总量" },
              { id: "commit", label: "提交" }
            ] as Array<{ id: FunnelScopeTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                scopeTab === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => setScopeTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-2 mt-1 text-[10px] leading-tight text-muted-foreground">
        {scopeTab === "total"
          ? "总量口径：分母为有效生成总量（含未提交），漏斗按生成 → Commit → Push 收窄"
          : "提交口径：分母为各阶段已落库代码，漏斗按有效生成 → Commit → Push 收窄"}
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
              const topHalf = halfWidthOf(s.topBasis)
              const botHalf = halfWidthOf(s.bottomBasis)
              const clip = `polygon(${50 - topHalf}% 0, ${50 + topHalf}% 0, ${50 + botHalf}% 100%, ${50 - botHalf}% 100%)`
              const clickable = i === 0 && scopeTab === "total" && Boolean(onFirstStageClick)
              return (
                <div
                  key={s.key}
                  className={`relative ${clickable ? "cursor-pointer" : ""}`}
                  style={{ height: BAND_H }}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? onFirstStageClick : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            onFirstStageClick?.()
                          }
                        }
                      : undefined
                  }
                  title={
                    clickable
                      ? "点击分析「生成了但没提交」的人与原因"
                      : `${s.label}：生成 ${formatExactNumber(s.generatedLines)} 行 · 采纳 ${formatExactNumber(s.adoptedLines)} 行 · 采纳率 ${formatPercent(s.rate)}`
                  }
                >
                  <div
                    className={`absolute inset-0 transition-opacity ${clickable ? "hover:opacity-80" : ""}`}
                    style={{ clipPath: clip, background: s.color }}
                  />
                </div>
              )
            })}
          </div>
          {/* 右侧标签：百分比移到此处（带颜色），自身宽度紧贴右边 */}
          <div className="flex shrink-0 flex-col">
            {stages.map((s, i) => {
              const clickable = i === 0 && scopeTab === "total" && Boolean(onFirstStageClick)
              return (
                <div
                  key={s.key}
                  className="flex flex-col justify-center"
                  style={{ height: BAND_H }}
                >
                  <div
                    className={`flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-foreground ${
                      clickable ? "cursor-pointer hover:underline" : ""
                    }`}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? onFirstStageClick : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              onFirstStageClick?.()
                            }
                          }
                        : undefined
                    }
                    title={clickable ? "点击分析「生成了但没提交」的人与原因" : undefined}
                  >
                    <span
                      className="inline-block size-2 shrink-0 rounded-sm"
                      style={{ background: s.color }}
                    />
                    {s.label}
                    <span className="font-semibold" style={{ color: s.color }}>
                      {formatPercent(s.rate)}
                    </span>
                  </div>
                  <div className="mt-0.5 whitespace-nowrap text-[10px] text-muted-foreground">
                    采纳 {formatNumber(s.adoptedLines)} / 生成 {formatNumber(s.generatedLines)}
                  </div>
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
// Skill ranking panel (usage / code-adoption tabs)
// ─────────────────────────────────────────────────────────

export interface SkillRankingDatum {
  id?: string
  skill: string
  count: number
  sourceRef?: string
  isPlugin?: boolean
  pluginName?: string
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

function MarketSkillTag(): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-sm border border-status-nominal/25 bg-status-nominal/10 px-1 py-px text-[9px] font-medium leading-3 text-status-nominal">
      市场
    </span>
  )
}

function PluginSkillTag({ pluginName }: { pluginName?: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex max-w-[120px] shrink-0 items-center rounded-sm border border-status-info/25 bg-status-info/10 px-1 py-px text-[9px] font-medium leading-3 text-status-info"
      title={pluginName ? `Plugin · ${pluginName}` : "Plugin"}
    >
      <span className="truncate">{pluginName ? `Plugin · ${pluginName}` : "Plugin"}</span>
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
    sortKey === "pushedAdoptionRate" ||
    sortKey === "inclusivePushedAdoptionRate"
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
  marketSkillKeys
}: {
  bySkillAdoption: SkillAdoptionRankingItem[]
  activeTab: SkillRankingTab
  onTabChange: (tab: SkillRankingTab) => void
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
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
  const getItemKey = (item: SkillAdoptionRankingItem): string => item.id ?? item.sourceRef ?? item.skill

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
              const rank =
                sortedItems.findIndex((candidate) => getItemKey(candidate) === getItemKey(item)) + 1
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
                        {item.isPlugin ? <PluginSkillTag pluginName={item.pluginName} /> : null}
                      </div>
                      <span className="shrink-0 text-[11px] font-medium text-foreground">
                        {formatSkillAdoptionSortValue(item, sortKey)}
                      </span>
                    </div>
                    <div className="mb-1 truncate text-[10px] text-muted-foreground">
                      <span className="text-muted-foreground/70">提交口径</span> 提交{" "}
                      {formatNullablePercent(item.measuredAdoptionRate)}
                      <span className="mx-1 text-border">·</span>入库{" "}
                      {formatNullablePercent(item.pushedAdoptionRate)}
                      <span className="mx-1 text-border">|</span>
                      <span className="text-muted-foreground/70">总量口径</span> 提交{" "}
                      {formatNullablePercent(item.inclusiveAdoptionRate)}
                      <span className="mx-1 text-border">·</span>入库{" "}
                      {formatNullablePercent(item.inclusivePushedAdoptionRate)}
                    </div>
                    <div className="mb-1 truncate text-[10px] text-muted-foreground">
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
                    key={getItemKey(item)}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onSkillClick(item.skill)}
                  >
                    {content}
                  </button>
                )
              }

              return (
                <div key={getItemKey(item)} className="flex items-center gap-2">
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
  marketSkillKeys
}: {
  bySkill: SkillRankingDatum[]
  bySkillAll: SkillRankingDatum[]
  totalSkills: number
  totalSkillCalls: number
  bySkillAdoption: SkillAdoptionRankingItem[]
  onSkillClick?: (skill: string) => void
  marketSkillKeys: Set<string>
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
      />
    )
  }

  const defaultItems: RankingItem[] = bySkill.map((item) => ({
    id: item.id,
    name: item.skill,
    count: item.count
  }))
  const searchItems: RankingItem[] = (bySkillAll.length > 0 ? bySkillAll : bySkill).map((item) => ({
    id: item.id,
    name: item.skill,
    count: item.count
  }))
  const pluginSkillNames = new Map(
    [...bySkill, ...bySkillAll]
      .filter((item) => item.isPlugin)
      .map((item) => [item.id ?? item.skill, item.pluginName])
  )
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
      renderNameAddon={(item) => (
        <>
          {hasMarketSkill(marketSkillKeys, item.name) ? <MarketSkillTag /> : null}
          {pluginSkillNames.has(item.id ?? item.name) ? (
            <PluginSkillTag pluginName={pluginSkillNames.get(item.id ?? item.name)} />
          ) : null}
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
