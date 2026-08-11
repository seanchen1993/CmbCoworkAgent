/**
 * 研发效能面板
 *
 * 三个指标各一张卡：系统可扩展性、AI 编码有效性、算力产出效能。
 * 范围在后端固定为「项目模式 + 已绑定精益项目」，前端不提供口径开关——
 * 关掉开关会让同一个标题下的数字换一个含义。
 */
import React, { useMemo } from "react"
import { AlertCircle, Info, Loader2, TrendingUp } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  DashboardEfficiencyChangeKind,
  DashboardEfficiencyChangeKindStats,
  DashboardEfficiencyData
} from "../use-dashboard"
import { ProjectMetricsSection } from "./ProjectMetricsSection"

// ─────────────────────────────────────────────────────────
// 目标线
// ─────────────────────────────────────────────────────────

/** 新增（绿地）代码入库采纳率目标。 */
const NEW_ADOPTION_TARGET = 0.9
/** 存量（棕地）迭代代码入库采纳率目标。 */
const LEGACY_ADOPTION_TARGET = 0.85

const CHANGE_KIND_LABELS: Record<DashboardEfficiencyChangeKind, string> = {
  new: "新增功能代码",
  legacy: "存量迭代代码",
  unclassified: "未分类（历史数据）"
}

const CHANGE_KIND_TARGETS: Partial<Record<DashboardEfficiencyChangeKind, number>> = {
  new: NEW_ADOPTION_TARGET,
  legacy: LEGACY_ADOPTION_TARGET
}

// ─────────────────────────────────────────────────────────
// 格式化
// ─────────────────────────────────────────────────────────

function formatPercent(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(digits)}%`
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return formatCount(value)
}

function formatTokensPerLine(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return value >= 100 ? formatCount(value) : value.toFixed(1)
}

// ─────────────────────────────────────────────────────────
// 基础件
// ─────────────────────────────────────────────────────────

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="text-muted-foreground hover:text-foreground">
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[360px] text-xs leading-relaxed">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function MetricCard({
  title,
  hint,
  children
}: {
  title: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint ? <Hint>{hint}</Hint> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function EmptyValue({ reason }: { reason: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-6">
      <div className="text-2xl font-semibold tabular-nums text-muted-foreground">—</div>
      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{reason}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 指标 2：AI 编码有效性
// ─────────────────────────────────────────────────────────

function AdoptionBucket({
  stats
}: {
  stats: DashboardEfficiencyChangeKindStats
}): React.JSX.Element {
  const target = CHANGE_KIND_TARGETS[stats.changeKind]
  const rate = stats.inclusivePushedAdoptionRate
  const hasData = stats.inclusiveEffectiveGeneratedLines > 0
  const met = target !== undefined && rate !== null ? rate >= target : null

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{CHANGE_KIND_LABELS[stats.changeKind]}</div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          met === null ? "text-foreground" : met ? "text-emerald-600" : "text-amber-600"
        )}
      >
        {hasData ? formatPercent(rate) : "—"}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {target !== undefined ? `目标 > ${formatPercent(target, 0)}` : "无目标线"}
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <div>入库采纳 {formatCount(stats.pushedAdoptedLines)} 行</div>
        <div>有效生成 {formatCount(stats.inclusiveEffectiveGeneratedLines)} 行</div>
      </div>
    </div>
  )
}

/**
 * 新增行占比分布。用来看 0.7 这条阈值是切在分布的稀疏处还是密集处——
 * 切在密集处意味着两桶的划分对阈值极其敏感，微调就会大幅搬运数据。
 */
function NewRatioHistogram({
  bins
}: {
  bins: DashboardEfficiencyData["adoption"]["newRatioHistogram"]
}): React.JSX.Element | null {
  const max = useMemo(() => bins.reduce((acc, bin) => Math.max(acc, bin.docCount), 0), [bins])
  if (bins.length === 0 || max === 0) return null

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <span>新增行占比分布</span>
        <Hint>
          每次生成的新增行占比分布。0.7 是当前的分桶阈值。如果阈值正好落在分布密集处，
          说明两桶划分对阈值很敏感，微调阈值会大幅改变结果——此时应该按分布的稀疏处重新定阈值。
        </Hint>
      </div>
      <div className="mt-2 flex h-16 items-end gap-px">
        {bins.map((bin) => (
          <div
            key={bin.from}
            className="group relative flex-1"
            title={`[${bin.from.toFixed(2)}, ${(bin.from + 0.05).toFixed(2)}) · ${formatCount(bin.docCount)} 次`}
          >
            <div
              className={cn(
                "w-full rounded-sm",
                bin.from >= 0.7 ? "bg-emerald-500/60" : "bg-amber-500/60"
              )}
              style={{ height: `${Math.max(2, (bin.docCount / max) * 64)}px` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>0（全是改写）</span>
        <span>0.7 阈值</span>
        <span>1（纯新增）</span>
      </div>
    </div>
  )
}

function AdoptionCard({
  adoption
}: {
  adoption: DashboardEfficiencyData["adoption"]
}): React.JSX.Element {
  return (
    <MetricCard
      title="AI 编码有效性"
      hint={
        <div className="space-y-1.5">
          <div>入库采纳率 = 已 Push 采纳行 ÷ 全部有效生成行（含未提交）。</div>
          <div>
            新增 / 存量按每次生成的新增行占比划分，阈值 0.7：净删除越多越偏存量。分桶信息在
            生成时算好并随采纳事件一起上报，不是事后按 diff 反推的。
          </div>
          <div>
            分母含 14 天归因窗口外未拿到采纳判定的生成行，这部分只进分母不进分子，
            所以这里的采纳率是偏保守的下界。
          </div>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {adoption.byChangeKind.map((stats) => (
          <AdoptionBucket key={stats.changeKind} stats={stats} />
        ))}
      </div>

      <NewRatioHistogram bins={adoption.newRatioHistogram} />
    </MetricCard>
  )
}

// ─────────────────────────────────────────────────────────
// 指标 3：算力产出效能
// ─────────────────────────────────────────────────────────

/**
 * 单行成本里输入 / 输出各占多少。用的是同一个分母（入库采纳行），
 * 所以两条的每行数相加恰好等于卡片主数值。
 */
function PerLineSplit({
  label,
  perLine,
  share,
  barClassName
}: {
  label: string
  perLine: number | null
  share: number | null
  barClassName: string
}): React.JSX.Element {
  return (
    <div className="min-w-[104px]">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {formatTokensPerLine(perLine)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">/行</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", barClassName)}
          style={{ width: `${Math.min(100, Math.max(0, (share ?? 0) * 100))}%` }}
        />
      </div>
      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
        {formatPercent(share, 1)}
      </div>
    </div>
  )
}

function ComputeCard({
  compute
}: {
  compute: DashboardEfficiencyData["compute"]
}): React.JSX.Element {
  const { totalTokens, totalInputTokens, totalOutputTokens, pushedAdoptedLines } = compute
  // 单行成本的输入/输出拆分：同一个分母，所以两条相加恰好等于上面的总数。
  const inputPerLine = pushedAdoptedLines > 0 ? totalInputTokens / pushedAdoptedLines : null
  const outputPerLine = pushedAdoptedLines > 0 ? totalOutputTokens / pushedAdoptedLines : null
  const inputShare = totalTokens > 0 ? totalInputTokens / totalTokens : null
  const outputShare = totalTokens > 0 ? totalOutputTokens / totalTokens : null
  // 缓存读取是 trace 完成时从 modelCalls 拍平上来的，早于该字段的历史 trace 没有，
  // 所以为 0 时按「未采集」处理而不是当成「没命中缓存」。
  const cacheAvailable = compute.cacheReadTokens > 0
  const cacheShare =
    cacheAvailable && totalInputTokens > 0 ? compute.cacheReadTokens / totalInputTokens : null

  return (
    <MetricCard
      title="算力产出效能"
      hint={
        <div className="space-y-1.5">
          <div>单行入库代码 Token 数 = Σ totalTokens ÷ Σ 已 Push 采纳行。</div>
          <div>
            输入 token 已包含缓存读取（适配器把 cache_read / cache_creation 折进了 input_tokens），
            所以缓存命中率越高这个数越大，而实际花费越低。对外引用时务必带上这个口径说明。
          </div>
          <div>Token 只统计主流程，不含 subagent，避免重复计数。</div>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-4 rounded-md border border-border bg-background p-3">
        <div>
          <div className="text-xs text-muted-foreground">单行入库代码 Token 数</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">
            {formatTokensPerLine(compute.tokensPerAdoptedLine)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatCompact(totalTokens)} tokens ÷ {formatCount(pushedAdoptedLines)} 行
          </div>
        </div>

        <div className="flex gap-8">
          <PerLineSplit
            label="其中输入"
            perLine={inputPerLine}
            share={inputShare}
            barClassName="bg-sky-500"
          />
          <PerLineSplit
            label="其中输出"
            perLine={outputPerLine}
            share={outputShare}
            barClassName="bg-violet-500"
          />
        </div>
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="text-xs text-muted-foreground">输入 Token</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums text-foreground">
            {formatCompact(compute.totalInputTokens)}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="text-xs text-muted-foreground">输出 Token</dt>
          <dd className="mt-1 text-lg font-medium tabular-nums text-foreground">
            {formatCompact(compute.totalOutputTokens)}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>其中缓存读取</span>
            <Hint>
              缓存读取的单价约为标准输入的 1/10，但在总 token 里通常占大头，是输入 token
              的子集而非额外的量。
              {cacheAvailable
                ? ""
                : " 该值是 trace 完成时从 modelCalls 拍平上来的，早于此字段的历史 trace 没有这项数据。"}
            </Hint>
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums text-foreground">
            {cacheAvailable ? (
              <>
                {formatCompact(compute.cacheReadTokens)}
                {cacheShare !== null ? (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {formatPercent(cacheShare, 0)}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-base font-normal text-muted-foreground">未采集</span>
            )}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background p-3">
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>产码会话占比</span>
            <Hint>
              产生过代码的会话 ÷ 全部会话。问答、评审类会话同样消耗算力但不产码，
              这个比例说明分子里有多少被它们稀释。
            </Hint>
          </dt>
          <dd className="mt-1 text-lg font-medium tabular-nums text-foreground">
            {formatPercent(compute.codeProducingTraceRatio, 1)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {formatCount(compute.codeProducingTraceCount)}/{formatCount(compute.traceCount)}
            </span>
          </dd>
        </div>
      </dl>

      {compute.tokenTotalsConsistent ? null : (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Token 自检未通过：总数 {formatCompact(totalTokens)} 与输入 + 输出{" "}
            {formatCompact(totalInputTokens + totalOutputTokens)} 对不上。 常见原因是求和时把缓存
            token 又加了一遍——而输入 token 本身已经含缓存。 上面的单行数值不要对外引用。
          </span>
        </div>
      )}
    </MetricCard>
  )
}

// ─────────────────────────────────────────────────────────
// 面板
// ─────────────────────────────────────────────────────────

export function EfficiencyPanel({
  data,
  loading,
  error,
  range,
  upperOrgLv1,
  projectMetricRefreshKey
}: {
  data: DashboardEfficiencyData | null
  loading: boolean
  error: string | null
  range: { from: string; to: string }
  upperOrgLv1: string[]
  projectMetricRefreshKey: number
}): React.JSX.Element {
  return (
    <div className="space-y-4 px-6 py-4">
      <ProjectMetricsSection
        range={range}
        upperOrgLv1={upperOrgLv1}
        refreshKey={projectMetricRefreshKey}
      />

      {loading && !data ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载现有研发效能指标
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-border text-sm text-muted-foreground">
          暂无现有研发效能数据
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>统计范围：项目模式 · 已绑定精益项目</span>
            <span>·</span>
            <span>{formatCount(data.meta.projectCount)} 个项目</span>
            {data.meta.truncated ? (
              <>
                <span>·</span>
                <span className="text-amber-600">项目数超过上限，以下为截断后的子集</span>
              </>
            ) : null}
          </div>

          <MetricCard
            title="系统可扩展性"
            hint="交付周期变化量 ÷ 系统规模变化量。目标是斜率 ≈ 0，即系统规模增长不拖慢单位交付。"
          >
            <EmptyValue reason={data.scalability.pendingReason} />
            <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <TrendingUp className="mt-0.5 size-3.5 shrink-0" />
              <span>
                待接入两项数据：内网项目管理平台的需求特性（提出时间 / 交付时间，先走手工导入），
                以及仓库规模的客户端采集。两项齐备后此处出两点差分斜率，并在样本足够时附回归斜率与置信区间。
              </span>
            </div>
          </MetricCard>

          <AdoptionCard adoption={data.adoption} />
          <ComputeCard compute={data.compute} />
        </>
      )}
    </div>
  )
}
