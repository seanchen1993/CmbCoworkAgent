import React from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  DashboardProjectModeStageAnalysis,
  DashboardProjectModeStageMetrics,
  DashboardProjectModeStageRow
} from "./use-dashboard"
import {
  formatStageDuration as fmtDuration,
  resolveSlowestAvgStage,
  stageDurationShare
} from "./project-stage-analysis-view"

/**
 * 项目的阶段耗时分析。
 *
 * 要回答的问题是「跑插件慢在哪个阶段」，所以排版围绕一件事：**让「总耗时高」和
 * 「单轮慢」能被分开看**。
 *
 * 只给总耗时的话，排名基本等于轮次排名——DEV 阶段总是最高，因为轮次最多，看不出任何
 * 东西。真正有信息量的是平均每轮耗时，以及 P95（分辨「整体都慢」和「少数几轮拖长」，
 * 这两种的排查方向完全不同）。
 *
 * 表格默认按总耗时降序（后端已排好），但「平均每轮」那一列单独做了最慢标记，这样一眼
 * 能看出「总耗时第三、但单轮最慢」这种最值得查的阶段。
 */

function fmtCount(value: number): string {
  return value.toLocaleString("zh-CN")
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

/** 顶部四个总览数字。 */
function TotalStat({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2" title={hint}>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  )
}

/**
 * 阶段占总耗时的比例条。放在阶段名下面而不是单独一列，是因为比例本身不是要看的数字，
 * 它只是让「哪几个阶段吃掉了大部分时间」在扫视时立刻成形。
 */
function ShareBar({ share }: { share: number }): React.JSX.Element {
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary/60"
        style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }}
      />
    </div>
  )
}

function StageRow({
  stage,
  totalDurationMs,
  slowestAvgNodeName
}: {
  stage: DashboardProjectModeStageRow
  totalDurationMs: number
  slowestAvgNodeName: string | null
}): React.JSX.Element {
  const { metrics } = stage
  const share = stageDurationShare(metrics.totalDurationMs, totalDurationMs)
  const isSlowestAvg = slowestAvgNodeName === stage.nodeName
  return (
    <tr className="border-b border-border/50 align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-foreground">{stage.nodeName}</div>
        <ShareBar share={share} />
        <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
          占总耗时 {(share * 100).toFixed(1)}%
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtCount(metrics.conversationCount)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtDuration(metrics.totalDurationMs)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        <span
          className={
            isSlowestAvg
              ? "rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive"
              : ""
          }
          title={isSlowestAvg ? "该项目单轮平均耗时最长的阶段" : undefined}
        >
          {fmtDuration(metrics.avgDurationMs)}
        </span>
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums"
        title={metrics.p95Available === false ? "新旧统计口径混合，暂不显示 P95" : undefined}
      >
        {metrics.p95Available === false ? "—" : fmtDuration(metrics.p95DurationMs)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {fmtTokens(metrics.runCost.inputTokens)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {fmtTokens(metrics.runCost.outputTokens)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtCount(metrics.runCost.modelCalls)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtCount(metrics.runCost.toolCalls)}</td>
      <td
        className="px-3 py-2 text-right tabular-nums"
        title="向用户请求补充信息的次数；≥ 表示仅覆盖部分记录，— 表示没有完整记录"
      >
        {metrics.runCost.userInputRequestDocs >=
        (metrics.runCost.traceDocs ?? metrics.conversationCount)
          ? fmtCount(metrics.runCost.userInputRequests)
          : metrics.runCost.userInputRequestDocs > 0
            ? `≥${fmtCount(metrics.runCost.userInputRequests)}`
            : "—"}
      </td>
    </tr>
  )
}

export function ProjectStageAnalysisDialog({
  open,
  onOpenChange,
  projectName,
  analysis,
  loading,
  error
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  analysis: DashboardProjectModeStageAnalysis | null
  loading: boolean
  error: string | null
}): React.JSX.Element {
  const total: DashboardProjectModeStageMetrics | null = analysis?.total ?? null
  const stages = analysis?.stages ?? []
  const slowestAvgNodeName = resolveSlowestAvgStage(stages)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-[1400px] flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">阶段耗时分析</DialogTitle>
          <DialogDescription className="truncate">{projectName}</DialogDescription>
        </DialogHeader>

        {/*
          口径说明放在最显眼的位置，不折叠也不塞进 tooltip：每轮从发起到结束的
          耗时不是阶段从进入到退出的自然历时，读错了就会得出错误结论。
        */}
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div>
            <span className="font-medium text-foreground">轮次与耗时：</span>
            只统计主动触发的主 Agent 会话。每轮从发起到结束的耗时按期间观察到的阶段变化拆分。
            <strong className="font-bold text-foreground">
              一轮经过多个阶段时，每个阶段各计 1 轮
            </strong>
            ，因此阶段轮次相加可能大于项目总轮次。旧记录仍按该轮开始时的阶段归属。
            这里统计的是会话工作时间，不是阶段从进入到退出的历时。
          </div>
          <div className="mt-1">
            <span className="font-medium text-foreground">调用与 Token：</span>
            汇总同一项目和时间范围内主、子 Agent 的调用。完整记录按每次调用开始时的阶段归属；
            历史或未完整记录按该轮开始时的阶段归属；无法确定阶段的计入「未归因」。Token
            只汇总模型已上报的用量。
          </div>
          <div className="mt-1">
            <span className="font-medium text-foreground">请求输入：</span>
            统计向用户请求补充信息的次数；「≥」表示仅覆盖部分记录，「—」表示没有可用的完整记录。
          </div>
          {analysis?.costAttribution && (
            <div className="mt-1">
              阶段归因覆盖：按调用开始阶段统计{" "}
              {fmtCount(analysis.costAttribution.callStartTraceCount)} 条记录； 按整轮开始阶段统计{" "}
              {fmtCount(analysis.costAttribution.turnStartTraceCount)} 条记录。
              {analysis.costAttribution.tokenUsageReportedCalls <
                analysis.costAttribution.modelCalls && " 部分模型调用未返回 Token 用量。"}
              {analysis.costAttribution.truncated &&
                " 阶段数量超出展示上限，以下阶段合计可能小于项目总计。"}
            </div>
          )}
          {analysis?.durationAttribution && (
            <div className="mt-1">
              轮次与耗时覆盖：按阶段变化拆分 {fmtCount(analysis.durationAttribution.splitTurnCount)}{" "}
              轮； 按开始阶段统计 {fmtCount(analysis.durationAttribution.legacyTurnCount)} 轮。
              {analysis.durationAttribution.truncated &&
                " 阶段数量超出展示上限，阶段合计可能小于项目总计。"}
            </div>
          )}
        </div>

        {loading && !analysis ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载阶段数据中...
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center py-16 text-sm text-destructive">
            {error}
          </div>
        ) : !total || stages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
            当前时间范围内该项目没有阶段统计数据
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              <TotalStat
                label="总轮次"
                value={fmtCount(total.conversationCount)}
                hint="主动触发的主 Agent 会话轮次"
              />
              <TotalStat
                label="Agent 总工作时长"
                value={fmtDuration(total.totalDurationMs)}
                hint="所有轮次耗时之和，不是项目的日历周期"
              />
              <TotalStat
                label="平均每轮"
                value={fmtDuration(total.avgDurationMs)}
                hint="总工作时长 / 总轮次"
              />
              <TotalStat
                label="P95 每轮"
                value={fmtDuration(total.p95DurationMs)}
                hint="95% 的轮次快于这个耗时。它远高于平均值，说明慢是由少数几轮造成的"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  <col className="w-[200px]" />
                  <col className="w-[72px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[96px]" />
                  <col className="w-[84px]" />
                  <col className="w-[84px]" />
                  <col className="w-[84px]" />
                </colgroup>
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr className="whitespace-nowrap border-b border-border text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">阶段</th>
                    <th className="px-3 py-2 text-right font-medium">轮次</th>
                    <th className="px-3 py-2 text-right font-medium">总耗时</th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title="单轮平均耗时。总耗时高往往只是因为轮次多，这一列才直接反映「模型工作时间长不长」"
                    >
                      平均每轮
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title="95% 的轮次快于此值。与平均值差距大，说明慢集中在少数几轮"
                    >
                      P95
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium"
                      title="模型上报的输入 Token，缓存按模型返回口径计入，不重复相加"
                    >
                      输入 Token
                    </th>
                    <th className="px-3 py-2 text-right font-medium" title="模型上报的输出 Token">
                      输出 Token
                    </th>
                    <th className="px-3 py-2 text-right font-medium">模型调用</th>
                    <th className="px-3 py-2 text-right font-medium">工具调用</th>
                    <th className="px-3 py-2 text-right font-medium">请求输入</th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map((stage) => (
                    <StageRow
                      key={stage.nodeName}
                      stage={stage}
                      totalDurationMs={total.totalDurationMs}
                      slowestAvgNodeName={slowestAvgNodeName}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
