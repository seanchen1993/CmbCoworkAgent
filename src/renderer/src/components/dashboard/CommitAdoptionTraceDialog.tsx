import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, GitCommit, Info, Loader2, MessagesSquare } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type {
  DashboardCommitAdoptionEvents,
  DashboardCommitAdoptionPair,
  DashboardCommitDetail,
  DashboardLocalGenAdoptionLines
} from "./use-dashboard"

const TRACE_COLSPAN = 7

const VERDICT_META: Record<string, { label: string; cls: string; hint: string }> = {
  committed: {
    label: "已采纳",
    cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    hint: "提交版命中了部分生成行，采纳 = 命中的有效行数"
  },
  deleted: {
    label: "已删除",
    cls: "bg-muted text-muted-foreground",
    hint: "生成后文件在该 commit 被删除，采纳计 0"
  },
  skipped_large: {
    label: "超大跳过",
    cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    hint: "基线超 2 万行，未参与逐行测量（有效/采纳为空）"
  }
}

function verdictMeta(verdict: string | null): { label: string; cls: string; hint: string } {
  if (verdict && VERDICT_META[verdict]) return VERDICT_META[verdict]
  return {
    label: verdict || "未知",
    cls: "bg-muted text-muted-foreground",
    hint: "未知结论"
  }
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return `${(value * 100).toFixed(1)}%`
}

function formatLines(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return Math.round(value).toLocaleString()
}

function formatTime(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function pairRate(pair: DashboardCommitAdoptionPair): number | null {
  const effective = pair.effectiveGeneratedLineCount
  const adopted = pair.adoptedLineCount
  if (effective === null || adopted === null || effective <= 0) return null
  return adopted / effective
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

function SkillChips({ skills }: { skills: string[] }): React.JSX.Element {
  if (skills.length === 0) return <span className="text-[11px] text-muted-foreground">—</span>
  const visible = skills.slice(0, 2)
  const hidden = skills.length - visible.length
  return (
    <div className="flex max-w-[160px] flex-wrap gap-1">
      {visible.map((skill) => (
        <span
          key={skill}
          className="max-w-[80px] truncate rounded-full border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-300"
          title={skill}
        >
          {skill}
        </span>
      ))}
      {hidden > 0 ? (
        <span
          className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          title={skills.join(", ")}
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  )
}

function VerdictBadge({ verdict }: { verdict: string | null }): React.JSX.Element {
  const meta = verdictMeta(verdict)
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex cursor-help items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.cls}`}
          >
            {meta.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{meta.hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function LocalLinesPanel({
  loading,
  error,
  data
}: {
  loading: boolean
  error: string | null
  data: DashboardLocalGenAdoptionLines | null
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> 正在本地重建逐行采纳…
      </div>
    )
  }
  if (error) {
    return <div className="px-2 py-3 text-xs text-destructive">{error}</div>
  }
  if (!data || !data.available) {
    return (
      <div className="px-2 py-3 text-xs text-muted-foreground">
        {data?.reason ?? "本地无法逐行还原"}
        <div className="mt-1 text-[10px] text-muted-foreground/80">
          逐行仅对当前机器近 7 天、且文件仍在该 commit 中的生成可用。
        </div>
      </div>
    )
  }
  const generated = data.generatedLineCount ?? 0
  const matched = data.matchedLineCount ?? 0
  const unmatched = Math.max(0, generated - matched)
  return (
    <div className="space-y-2 px-2 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground" title={data.relPath}>
          {data.relPath}
        </span>
        <span>生成 {generated} 行</span>
        <span className="text-emerald-600 dark:text-emerald-400">命中采纳 {matched} 行</span>
        {unmatched > 0 ? <span>未进入该 commit {unmatched} 行（原文未留存，仅计数）</span> : null}
      </div>
      <div className="max-h-[320px] overflow-auto rounded-md border border-border bg-muted/20">
        <div className="min-w-max font-mono text-[11px] leading-relaxed">
          {(data.lines ?? []).map((line) => (
            <div key={line.lineNumber} className={line.adopted ? "flex bg-emerald-500/15" : "flex"}>
              <span className="w-10 shrink-0 select-none px-2 text-right text-muted-foreground/60">
                {line.lineNumber}
              </span>
              <span
                className={`whitespace-pre px-2 ${line.adopted ? "text-emerald-700 dark:text-emerald-300" : "text-foreground/80"}`}
              >
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      </div>
      {data.truncated ? (
        <div className="text-[10px] text-muted-foreground">文件较大，已截断展示前 4000 行。</div>
      ) : null}
    </div>
  )
}

function TracePairRow({
  pair,
  commitSha,
  onViewThread
}: {
  pair: DashboardCommitAdoptionPair
  commitSha: string
  onViewThread?: (threadId: string) => void
}): React.JSX.Element {
  const rate = pairRate(pair)
  const orphan = !pair.file && !pair.generatedAt
  const canTrace = Boolean(commitSha && pair.genEventId)
  const threadId = pair.threadId
  const [expanded, setExpanded] = useState(false)
  const [localData, setLocalData] = useState<DashboardLocalGenAdoptionLines | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [fetched, setFetched] = useState(false)

  const toggle = (): void => {
    const next = !expanded
    setExpanded(next)
    if (!next || fetched || !canTrace) return
    const api = window.api?.adoption
    if (!api || typeof api.commitLines !== "function") {
      setLocalError("当前环境不支持本地逐行溯源")
      setFetched(true)
      return
    }
    setLocalLoading(true)
    setLocalError(null)
    api
      .commitLines(commitSha, [pair.genEventId])
      .then((res) => {
        if (!res.success) throw new Error(res.error ?? "本地逐行读取失败")
        const list = (res.data as DashboardLocalGenAdoptionLines[]) ?? []
        setLocalData(list[0] ?? null)
      })
      .catch((e) => setLocalError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setLocalLoading(false)
        setFetched(true)
      })
  }

  return (
    <>
      <tr className="border-b border-border/60 align-top hover:bg-muted/20">
        <td className="max-w-[200px] px-3 py-2">
          <div className="flex items-start gap-1.5">
            <button
              type="button"
              className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              disabled={!canTrace}
              onClick={toggle}
              title={canTrace ? "本地逐行对账" : "无法逐行溯源"}
              aria-label="展开逐行"
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </button>
            <div className="min-w-0">
              <div
                className="truncate font-mono text-xs text-foreground"
                title={pair.file ?? undefined}
              >
                {pair.file ?? "—"}
              </div>
              <div
                className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                title={pair.genEventId}
              >
                {orphan ? "无配对 gen 事件" : pair.genEventId}
              </div>
            </div>
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
          <div>{pair.tool ?? "—"}</div>
          {pair.language ? <div className="text-[10px]">{pair.language}</div> : null}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-xs">
          <div className="tabular-nums text-foreground">
            生成 {formatLines(pair.generatedLineCount)}
            <span className="mx-1 text-muted-foreground/60">→</span>
            有效 {formatLines(pair.effectiveGeneratedLineCount)}
            <span className="mx-1 text-muted-foreground/60">→</span>
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              采纳 {formatLines(pair.adoptedLineCount)}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            单条采纳率 {formatPercent(rate)}
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-2">
          <VerdictBadge verdict={pair.verdict} />
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
          <div>{pair.measureSource ?? "—"}</div>
          <div className="mt-0.5">{pair.pushed ? "已 Push" : "未 Push"}</div>
        </td>
        <td className="px-3 py-2">
          <SkillChips skills={pair.usedSkills} />
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
          <div title={pair.generatedAt ?? undefined}>生成 {formatTime(pair.generatedAt)}</div>
          <div title={pair.measuredAt ?? undefined}>测量 {formatTime(pair.measuredAt)}</div>
          {threadId ? (
            onViewThread ? (
              <button
                type="button"
                className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-blue-600 transition-colors hover:underline dark:text-blue-400"
                title={`查看会话还原 · ${threadId}`}
                onClick={() => onViewThread(threadId)}
              >
                <MessagesSquare className="size-3 shrink-0" />
                <span className="truncate">会话 {threadId}</span>
              </button>
            ) : (
              <div className="mt-0.5 truncate font-mono" title={threadId}>
                会话 {threadId}
              </div>
            )
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border/60 bg-muted/10">
          <td colSpan={TRACE_COLSPAN} className="px-3 pb-3">
            <LocalLinesPanel loading={localLoading} error={localError} data={localData} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

function ReconciliationBar({
  data,
  commit
}: {
  data: DashboardCommitAdoptionEvents
  commit: DashboardCommitDetail
}): React.JSX.Element {
  const recon = data.reconciliation
  // 面板该 commit 采纳率与对账率对比（按四舍五入后的百分比判定是否一致）。
  const panelRate = commit.codeAdoptionRate
  const mismatch = useMemo(() => {
    const a = recon.rate
    const b = panelRate
    if (a === null && b === null) return false
    if (a === null || b === null) return true
    return Math.abs(a - b) > 0.0005
  }, [recon.rate, panelRate])

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-muted/10 px-5 py-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">
        对账 Σ采纳 {formatLines(recon.sumAdopted)} / Σ有效 {formatLines(recon.sumEffective)} ={" "}
        <span className="text-emerald-600 dark:text-emerald-400">{formatPercent(recon.rate)}</span>
      </span>
      <span className={mismatch ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
        面板该 commit 采纳率 {formatPercent(panelRate)}
        {mismatch ? "（与对账值不一致，请核对超大/删除等条目）" : "（一致）"}
      </span>
      <span className="ml-auto inline-flex items-center gap-1">
        共 {data.pairs.length} 条事件
        <HeaderHint hint="一行 = 一个 code_adopt 事件，按 genEventId 关联其 code_gen 元数据。超大跳过(commitSha 为空)不计入本 commit。" />
      </span>
    </div>
  )
}

/**
 * 单条 commit 的采纳「溯源」弹窗：把面板上的采纳率拆解为底层 `code_gen` ↔
 * `code_adopt` 事件逐条展示并对账。云端事件仅含元数据（叶子文件名/行数/结论），
 * 不含代码内容或逐行 diff。
 */
export function CommitAdoptionTraceDialog({
  commit,
  onOpenChange,
  onViewThread
}: {
  commit: DashboardCommitDetail | null
  onOpenChange: (open: boolean) => void
  /** 点击某条事件关联会话时回调（threadId），由上层复用会话还原弹窗。 */
  onViewThread?: (threadId: string) => void
}): React.JSX.Element {
  const commitSha = commit?.commitSha ?? ""
  const [data, setData] = useState<DashboardCommitAdoptionEvents | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // 关闭时（commitSha 为空）不在 effect 内重置 state——遗留数据在弹窗关闭时不可见，
    // 下次以新 commitSha 打开会在 load() 内刷新。
    if (!commitSha) return
    let cancelled = false
    // 所有 setState 收进 async 回调内（而非同步 effect 体），避免 set-state-in-effect 级联渲染。
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      setData(null)
      try {
        const api = window.api?.dashboard
        const res: { success: boolean; data?: unknown; error?: string } =
          api && typeof api.commitAdoptionEvents === "function"
            ? await api.commitAdoptionEvents(commitSha)
            : { success: false, error: "当前环境不支持采纳溯源" }
        if (cancelled) return
        if (!res.success) throw new Error(res.error ?? "获取采纳事件失败")
        setData((res.data as DashboardCommitAdoptionEvents) ?? null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [commitSha])

  const pairs = data?.pairs ?? []

  return (
    <Dialog open={Boolean(commit)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[78vh] max-w-[1080px] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <GitCommit className="size-4 text-muted-foreground" />
            采纳溯源
          </DialogTitle>
          <DialogDescription className="truncate font-mono">
            {commit?.repositoryName ? `${commit.repositoryName} · ` : ""}
            {commitSha ? commitSha.slice(0, 12) : "—"}
          </DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {commit && data ? <ReconciliationBar data={data} commit={commit} /> : null}
            {pairs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
                该 commit 暂无关联的采纳事件
              </div>
            ) : (
              <ScrollArea className="min-h-0 flex-1" orientation="both">
                <div className="min-w-max">
                  <table className="min-w-[1040px] w-full text-left">
                    <thead className="sticky top-0 z-10 bg-background">
                      <tr className="border-b border-border text-[11px] text-muted-foreground">
                        <th className="whitespace-nowrap px-3 py-2 font-medium">文件 / gen 事件</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">工具</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">
                          <span className="inline-flex items-center gap-1">
                            生成 → 有效 → 采纳
                            <HeaderHint hint="有效 = 扣除被后续编辑 supersede 的行；采纳 = 提交版命中的有效行。" />
                          </span>
                        </th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">结论</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">来源 / Push</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">关联 Skill</th>
                        <th className="whitespace-nowrap px-3 py-2 font-medium">时间 / 会话</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((pair, index) => (
                        <TracePairRow
                          key={`${pair.genEventId}-${index}`}
                          pair={pair}
                          commitSha={commitSha}
                          onViewThread={onViewThread}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </ScrollArea>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
