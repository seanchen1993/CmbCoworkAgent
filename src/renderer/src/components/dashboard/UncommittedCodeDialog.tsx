import { useCallback, useEffect, useState } from "react"
import { ChevronLeft, Info, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

// ── 类型（与主进程 dashboard.ts / preload d.ts 对齐）──────────────────
interface UncommittedRankingItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  generatedLines: number
  measuredGeneratedLines: number
  uncommittedLines: number
  uncommittedRate: number | null
}

interface UncommittedRankingData {
  items: UncommittedRankingItem[]
  totalGeneratedLines: number
  totalMeasuredGeneratedLines: number
  totalUncommittedLines: number
  limit: number
}

interface UncommittedDetailBreakdown {
  key: string
  gens: number
  lines: number
}

interface UncommittedDetailSample {
  eventId: string
  eventTime: string
  tool?: string
  language?: string
  lineCount: number
  fileHint?: string
  threadId?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  modelName?: string
}

interface UncommittedDetailData {
  sapId: string
  userName: string
  scannedGens: number
  scanCapped: boolean
  uncommittedGens: number
  uncommittedLines: number
  byTool: UncommittedDetailBreakdown[]
  byLanguage: UncommittedDetailBreakdown[]
  byProject: UncommittedDetailBreakdown[]
  byThread: UncommittedDetailBreakdown[]
  samples: UncommittedDetailSample[]
}

interface UncommittedScope {
  upperOrgLv1?: string[]
  projectMode?: boolean
  usedSkillsOnly?: boolean
}

// ── 工具函数 ────────────────────────────────────────────────────────
function formatLines(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0"
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "-"
  return `${(value * 100).toFixed(1)}%`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || "-"
  return date.toLocaleString()
}

function orgLabel(item: { upperOrgLv1?: string; upperOrgLv0?: string; orgName?: string }): string {
  const lv1 = item.upperOrgLv1?.trim() ?? ""
  const lv0 = item.upperOrgLv0?.trim() ?? ""
  if (lv1 && lv0) return `${lv1}/${lv0}`
  if (lv1) return lv1
  return item.orgName?.trim() || "-"
}

function HeaderHint({ hint }: { hint: string }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0 cursor-help align-middle">
            <Info className="size-3 text-muted-foreground/70" aria-label={hint} />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ── 二级详情：单个用户的「为什么没提交」分解 ──────────────────────────
function BreakdownTable({
  title,
  hint,
  rows,
  emptyLabel
}: {
  title: string
  hint?: string
  rows: UncommittedDetailBreakdown[]
  emptyLabel: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-1 text-xs font-semibold text-foreground">
        {title}
        {hint ? <HeaderHint hint={hint} /> : null}
      </div>
      {rows.length === 0 ? (
        <div className="py-3 text-center text-[11px] text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-foreground" title={row.key}>
                {row.key}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatLines(row.lines)} 行 · {row.gens} 次
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const SAMPLE_PAGE_SIZE = 30

function DetailView({
  detail,
  loading,
  error
}: {
  detail: UncommittedDetailData | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  // 样本列表客户端分页：全量样本已随详情一次性返回，这里只控制可见条数。
  // 切换用户时由父组件通过 key 重挂载本组件来重置回第一页。
  const [visibleSamples, setVisibleSamples] = useState(SAMPLE_PAGE_SIZE)

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-10 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在精确反查未提交生成…
      </div>
    )
  }
  if (error) {
    return <div className="py-10 text-center text-sm text-destructive">{error}</div>
  }
  if (!detail) return <div />

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
          <div className="text-[10px] text-muted-foreground">未提交生成</div>
          <div className="text-base font-bold text-foreground">{detail.uncommittedGens} 次</div>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
          <div className="text-[10px] text-muted-foreground">未提交行数</div>
          <div className="text-base font-bold text-foreground">
            {formatLines(detail.uncommittedLines)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
            扫描生成数
            <HeaderHint hint="为还原未提交明细，按时间倒序最多扫描该用户最近 2000 次生成；超过 2000 时仅基于最近 2000 次采样统计，不影响榜单总量。" />
          </div>
          <div className="text-base font-bold text-foreground">{detail.scannedGens}</div>
        </div>
      </div>

      {detail.scanCapped ? (
        <div className="rounded-md bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          该用户生成量较大，明细基于「最近 {detail.scannedGens} 次生成」采样，非全量。
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <BreakdownTable
          title="按工具"
          hint="未提交生成所用的写入工具分布。"
          rows={detail.byTool}
          emptyLabel="无未提交生成"
        />
        <BreakdownTable
          title="按语言/文件类型"
          hint="某类文件（如临时脚本、文档）系统性不提交时会在此突出。"
          rows={detail.byLanguage}
          emptyLabel="无未提交生成"
        />
        <BreakdownTable
          title="按项目/特性"
          hint="某个项目或特性整体被放弃时会在此突出。非项目模式归为「非项目模式」。"
          rows={detail.byProject}
          emptyLabel="无未提交生成"
        />
        <BreakdownTable
          title="按会话"
          hint="集中在少数会话通常意味着探索性/草稿会话，本就不打算提交。"
          rows={detail.byThread}
          emptyLabel="无会话信息"
        />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
          未提交生成样本（共 {detail.samples.length} 条）
        </div>
        {detail.samples.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-muted-foreground">无未提交生成</div>
        ) : (
          <>
            <div className="divide-y divide-border">
              {detail.samples.slice(0, visibleSamples).map((sample) => (
                <div
                  key={sample.eventId}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-foreground" title={sample.fileHint}>
                      {sample.fileHint || sample.tool || "(未知文件)"}
                    </div>
                    <div className="truncate text-muted-foreground">
                      {[sample.tool, sample.language, sample.harnessFeatureSlug, sample.modelName]
                        .filter(Boolean)
                        .join(" · ") || "-"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-muted-foreground">
                    <div className="tabular-nums text-foreground">
                      {formatLines(sample.lineCount)} 行
                    </div>
                    <div>{formatTime(sample.eventTime)}</div>
                  </div>
                </div>
              ))}
            </div>
            {visibleSamples < detail.samples.length ? (
              <button
                type="button"
                className="w-full border-t border-border py-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                onClick={() =>
                  setVisibleSamples((count) =>
                    Math.min(count + SAMPLE_PAGE_SIZE, detail.samples.length)
                  )
                }
              >
                加载更多（剩余 {detail.samples.length - visibleSamples} 条）
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// ── 主弹窗：榜单（A）+ 点击进入二级详情（B）──────────────────────────
export function UncommittedCodeDialog({
  open,
  onOpenChange,
  range,
  scope
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  range: { from: string; to: string }
  scope?: UncommittedScope
}): React.JSX.Element {
  const [ranking, setRanking] = useState<UncommittedRankingData | null>(null)
  const [rankingLoading, setRankingLoading] = useState(false)
  const [rankingError, setRankingError] = useState<string | null>(null)

  const [selected, setSelected] = useState<UncommittedRankingItem | null>(null)
  const [detail, setDetail] = useState<UncommittedDetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const scopeOptions = {
    upperOrgLv1: scope?.upperOrgLv1 ?? null,
    projectMode: scope?.projectMode,
    usedSkillsOnly: scope?.usedSkillsOnly
  }

  // 弹窗打开时加载榜单（A）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRanking(null)
    setRankingError(null)
    setSelected(null)
    setDetail(null)
    setRankingLoading(true)
    window.api.dashboard
      .uncommittedRanking(range, scopeOptions)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setRanking((result.data as UncommittedRankingData) ?? null)
        } else {
          setRankingError(result.error ?? "加载失败")
        }
      })
      .catch((e) => {
        if (!cancelled) setRankingError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setRankingLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    range.from,
    range.to,
    scope?.projectMode,
    scope?.usedSkillsOnly,
    (scope?.upperOrgLv1 ?? []).join("")
  ])

  // 点击某用户 → 加载二级详情（B）。
  const openDetail = useCallback(
    (item: UncommittedRankingItem) => {
      setSelected(item)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(true)
      window.api.dashboard
        .uncommittedDetail(item.sapId, range, scopeOptions)
        .then((result) => {
          if (result.success) {
            setDetail((result.data as UncommittedDetailData) ?? null)
          } else {
            setDetailError(result.error ?? "加载失败")
          }
        })
        .catch((e) => {
          setDetailError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => setDetailLoading(false))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      range.from,
      range.to,
      scope?.projectMode,
      scope?.usedSkillsOnly,
      (scope?.upperOrgLv1 ?? []).join("")
    ]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-[920px] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            {selected ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(null)}
              >
                <ChevronLeft className="size-4" />
                返回榜单
              </button>
            ) : null}
            <span className="font-semibold text-foreground">
              {selected ? `${selected.userName} · 未提交代码明细` : "生成但未提交分析"}
              {scope?.usedSkillsOnly ? (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  · 仅 Skill 生成
                </span>
              ) : null}
            </span>
            <HeaderHint hint="第一层「全部生成 → 已 Commit」缺口的下钻。时间口径同外部事件筛选框；范围含当天时自动排除最近 2 小时的在途生成。榜单为聚合近似（生成行数 − 已测量行数）；点击某人进入二级详情，用 genEventId 精确反查其未提交的生成并按维度归因。" />
          </DialogTitle>
          <DialogDescription className="sr-only">生成但未提交代码分析</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 px-5 py-4">
          {selected ? (
            <DetailView
              key={selected.sapId}
              detail={detail}
              loading={detailLoading}
              error={detailError}
            />
          ) : rankingLoading ? (
            <div className="flex flex-1 items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              正在聚合榜单…
            </div>
          ) : rankingError ? (
            <div className="py-10 text-center text-sm text-destructive">{rankingError}</div>
          ) : !ranking || ranking.items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无未提交生成数据
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
                  <div className="text-[10px] text-muted-foreground">总生成行数</div>
                  <div className="text-base font-bold text-foreground">
                    {formatLines(ranking.totalGeneratedLines)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
                  <div className="text-[10px] text-muted-foreground">已测量（提交）行数</div>
                  <div className="text-base font-bold text-foreground">
                    {formatLines(ranking.totalMeasuredGeneratedLines)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-2 text-center">
                  <div className="text-[10px] text-muted-foreground">未提交行数（近似）</div>
                  <div className="text-base font-bold text-amber-600 dark:text-amber-400">
                    {formatLines(ranking.totalUncommittedLines)}
                  </div>
                </div>
              </div>

              <p className="text-[10px] leading-relaxed text-muted-foreground">
                未提交 = 生成行数 − 已测量（进 commit
                的有效生成）行数，时间口径同上方事件筛选框；若所选范围包含当天，会自动排除最近 2
                小时的在途生成（刚生成还没来得及提交）。称「近似」是因为它按行数聚合归人，而非逐条
                genEventId
                反查——少数生成的提交若落在所选时间窗口外会被误记为未提交。点击某用户进入二级详情即用
                genEventId 精确反查，定位其「为什么没提交」。
              </p>

              <div className="overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1.8fr_1fr_1fr_0.9fr] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[10px] font-medium text-muted-foreground">
                  <span>用户 / 部门</span>
                  <span className="text-right">生成行数</span>
                  <span className="text-right">未提交</span>
                  <span className="text-right">未提交率</span>
                </div>
                <div className="divide-y divide-border">
                  {ranking.items.map((item) => (
                    <button
                      key={item.sapId}
                      type="button"
                      className="grid w-full grid-cols-[1.8fr_1fr_1fr_0.9fr] items-center gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-muted/40"
                      onClick={() => openDetail(item)}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{item.userName}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {orgLabel(item)}
                        </div>
                      </div>
                      <span className="text-right tabular-nums text-foreground">
                        {formatLines(item.generatedLines)}
                      </span>
                      <span className="text-right font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                        {formatLines(item.uncommittedLines)}
                      </span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {formatPercent(item.uncommittedRate)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
