import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Search, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn, formatRelativeTime, truncate } from "@/lib/utils"
import type { SkillEvalRecord, SkillEvalSummary } from "../../../../shared/skill-eval-types"

function skillVersionKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
}

function skillVersionLabel(skillName: string, skillVersion?: string): string {
  return skillVersion ? `${skillName} ${skillVersion}` : `${skillName} 未标版本`
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return `${Math.round(value)}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function formatOutcome(outcome: string): string {
  switch (outcome) {
    case "success":
      return "成功"
    case "error":
      return "失败"
    case "cancelled":
      return "已取消"
    case "unknown":
      return "未知"
    default:
      return outcome
  }
}

function promptInputTokens(record: SkillEvalRecord): number {
  return num(
    record.promptInputTokens,
    num(record.totalInputTokens) + num(record.cacheReadTokens) + num(record.cacheCreationTokens)
  )
}

function peakInputTokens(record: SkillEvalRecord): number {
  return num(record.peakInputTokens, num(record.maxContextTokens))
}

function StatTile({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  )
}

function SkillRow({
  skill,
  active,
  onClick
}: {
  skill: SkillEvalSummary["skills"][number]
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_40px_48px_56px_50px_52px] items-center gap-2 border-b border-border px-4 py-3 text-left text-sm hover:bg-muted/35",
        active && "bg-muted/45"
      )}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{skill.skillName}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {skill.skillVersion ?? "未标版本"} · {formatRelativeTime(skill.lastRunAt)}
        </div>
      </div>
      <div className="text-right tabular-nums text-muted-foreground">{skill.runs}</div>
      <div className="text-right tabular-nums text-muted-foreground">{pct(skill.passRate)}</div>
      <div className="text-right tabular-nums text-muted-foreground">
        {pct(num(skill.averageOutcomeScore, skill.averageScore))}
      </div>
      <div className="text-right tabular-nums text-foreground">{pct(skill.averageScore)}</div>
      <div className="text-right tabular-nums text-muted-foreground">
        {formatTokens(num(skill.averageTotalTokens))}
      </div>
    </button>
  )
}

function RunRow({ record }: { record: SkillEvalRecord }): React.JSX.Element {
  const warnings = record.warnings ?? []
  const outcomeWarnings = record.outcomeWarnings ?? []
  const checks = record.checks ?? []
  const outcomeChecks = record.outcomeChecks ?? []
  const cacheTokens = num(record.cacheReadTokens) + num(record.cacheCreationTokens)
  const promptTokens = promptInputTokens(record)

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex items-start gap-3">
        {record.pass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-nominal" />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{record.skillName}</span>
            {record.skillVersion && <Badge variant="outline">{record.skillVersion}</Badge>}
            <Badge variant={record.pass ? "nominal" : "critical"}>{pct(record.score)}</Badge>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(record.startedAt)}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground" title={record.userMessage}>
            {truncate(record.userMessage, 140)}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>工具 {record.totalToolCalls}</span>
            <span>模型调用 {num(record.modelCallCount)}</span>
            <span title="非缓存输入 Token">输入 {formatTokens(num(record.totalInputTokens))}</span>
            {cacheTokens > 0 && (
              <span title="缓存读取 + 缓存写入 Token">缓存输入 {formatTokens(cacheTokens)}</span>
            )}
            <span title="输入 + 缓存读取 + 缓存写入">Prompt {formatTokens(promptTokens)}</span>
            <span>输出 {formatTokens(num(record.totalOutputTokens))}</span>
            <span title="单次模型调用看到的最大输入 Token">
              峰值输入 {formatTokens(peakInputTokens(record))}
            </span>
            <span>错误 {record.errorCount}</span>
            <span>{formatDuration(record.durationMs)}</span>
            <span>{formatOutcome(record.outcome)}</span>
            <span title={record.traceId}>链路 {record.traceId.slice(0, 8)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="normal-case tracking-normal">
              过程 {pct(num(record.processScore, record.score))}
            </Badge>
            <Badge
              variant={record.outcomePass === false ? "warning" : "outline"}
              className="normal-case tracking-normal"
            >
              成果 {pct(num(record.outcomeScore, record.score))}
            </Badge>
            <Badge variant="outline" className="normal-case tracking-normal">
              Token {formatTokens(num(record.totalTokens))}
            </Badge>
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{warnings.slice(0, 2).join(" · ")}</span>
            </div>
          )}
          {outcomeWarnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{outcomeWarnings.slice(0, 2).join(" · ")}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checks.map((check) => (
              <Badge
                key={check.name}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                {check.label}
              </Badge>
            ))}
            {outcomeChecks.map((check) => (
              <Badge
                key={`outcome:${check.name}`}
                variant={check.ok ? "nominal" : "warning"}
                className="normal-case tracking-normal"
              >
                {check.label}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function SkillEvalView(): React.JSX.Element {
  const [summary, setSummary] = useState<SkillEvalSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selectedSkillKey, setSelectedSkillKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.skillEval.summary({ limit: 120 })
      setSummary(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    return window.api.skillEval.onUpdated(() => {
      void load()
    })
  }, [load])

  const filteredSkills = useMemo(() => {
    const text = query.trim().toLowerCase()
    return (summary?.skills ?? []).filter((skill) => {
      if (!text) return true
      return `${skill.skillName} ${skill.skillVersion ?? ""}`.toLowerCase().includes(text)
    })
  }, [query, summary?.skills])

  const filteredRuns = useMemo(() => {
    const text = query.trim().toLowerCase()
    return (summary?.recent ?? []).filter((record) => {
      if (
        selectedSkillKey &&
        skillVersionKey(record.skillName, record.skillVersion) !== selectedSkillKey
      ) {
        return false
      }
      if (!text) return true
      return `${record.skillName} ${record.skillVersion ?? ""} ${record.userMessage}`
        .toLowerCase()
        .includes(text)
    })
  }, [query, selectedSkillKey, summary?.recent])

  const selectedSkill = useMemo(() => {
    if (!selectedSkillKey) return null
    return (
      (summary?.skills ?? []).find(
        (skill) => skillVersionKey(skill.skillName, skill.skillVersion) === selectedSkillKey
      ) ?? null
    )
  }, [selectedSkillKey, summary?.skills])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">Skill 评估</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            基于真实运行 trace 自动生成的 skill 质量结果
          </p>
        </div>
        <div className="relative w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 skill 或任务"
            className="h-9 w-full border border-border bg-background pl-8 pr-3 text-sm outline-none focus:border-ring"
          />
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </div>

      {error ? (
        <div className="m-6 border border-status-critical/30 bg-status-critical/10 p-4 text-sm text-status-critical">
          {error}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(420px,520px)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-border">
            <div className="grid grid-cols-2 gap-2 border-b border-border p-4">
              <StatTile label="运行次数" value={summary?.totalRuns ?? 0} />
              <StatTile label="Skill 数" value={summary?.totalSkills ?? 0} />
              <StatTile label="通过率" value={pct(summary?.passRate ?? 0)} />
              <StatTile label="平均分" value={pct(summary?.averageScore ?? 0)} />
              <StatTile
                label="过程分"
                value={pct(num(summary?.averageProcessScore ?? summary?.averageScore))}
              />
              <StatTile
                label="成果分"
                value={pct(num(summary?.averageOutcomeScore ?? summary?.averageScore))}
              />
              <StatTile label="总 Token" value={formatTokens(num(summary?.totalTokens))} />
              <StatTile
                label="平均峰值输入"
                value={formatTokens(num(summary?.averagePeakInputTokens))}
              />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_40px_48px_56px_50px_52px] gap-2 border-b border-border px-4 py-2 text-[11px] font-medium text-muted-foreground">
              <span>技能</span>
              <span className="text-right">次数</span>
              <span className="text-right">通过率</span>
              <span className="text-right">成果</span>
              <span className="text-right">分数</span>
              <span className="text-right">Token</span>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <button
                type="button"
                onClick={() => setSelectedSkillKey(null)}
                className={cn(
                  "w-full border-b border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-muted/35",
                  selectedSkillKey === null && "bg-muted/45 text-foreground"
                )}
              >
                全部运行
              </button>
              {filteredSkills.map((skill) => (
                <SkillRow
                  key={`${skill.skillName}:${skill.skillVersion ?? ""}`}
                  skill={skill}
                  active={selectedSkillKey === skillVersionKey(skill.skillName, skill.skillVersion)}
                  onClick={() =>
                    setSelectedSkillKey(skillVersionKey(skill.skillName, skill.skillVersion))
                  }
                />
              ))}
            </ScrollArea>
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  {selectedSkill
                    ? skillVersionLabel(selectedSkill.skillName, selectedSkill.skillVersion)
                    : "最近运行"}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {filteredRuns.length} 条记录
                </div>
              </div>
              <div className="flex gap-2 text-[11px] text-muted-foreground">
                <span>平均工具 {num(summary?.averageToolCalls).toFixed(1)}</span>
                <span>平均模型调用 {num(summary?.averageModelCalls).toFixed(1)}</span>
                <span>平均 Token {formatTokens(num(summary?.averageTotalTokens))}</span>
                <span>平均耗时 {formatDuration(summary?.averageDurationMs ?? 0)}</span>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              {loading ? (
                <div className="flex h-48 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  加载中
                </div>
              ) : filteredRuns.length === 0 ? (
                <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                  暂无评估记录
                </div>
              ) : (
                filteredRuns.map((record) => <RunRow key={record.id} record={record} />)
              )}
            </ScrollArea>
          </main>
        </div>
      )}
    </div>
  )
}
