/**
 * Operations Dashboard
 *
 * Operations overview and skill evaluation dashboard.
 */
import {
  isValidElement,
  memo,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import "katex/dist/katex.min.css"
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  Download,
  ExternalLink,
  Search,
  X,
  User,
  Users,
  CircleAlert,
  Building2,
  Info,
  Bot,
  Send,
  Database
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn, formatRelativeTime, truncate } from "@/lib/utils"
import {
  formatTopUserOrgName,
  useDashboard,
  type DashboardCommitDetailsData,
  type DashboardSkillEvalRun,
  type DashboardSkillEvalSummary,
  type DashboardSkillDetail,
  type DashboardTraceTriggerScope,
  type DashboardTraceViewMode,
  type DashboardUserDetail,
  type DashboardUserListData,
  type DashboardUserListItem,
  type DashboardProjectModeFeature,
  type DashboardProjectModeData,
  type DashboardProjectModeProject,
  type DashboardProjectModeTracesData,
  type DashboardTraceDetail,
  type Granularity,
  type OverviewData,
  type TimeRange
} from "./use-dashboard"
import { OverviewPanel } from "./panels/OverviewPanel"
import { ProjectModePanel } from "./panels/ProjectModePanel"
import { ModelPanel } from "./panels/ModelPanel"
import { UserPanel } from "./panels/UserPanel"
import { ProductivityPanel } from "./panels/ProductivityPanel"
import { FeedbackPanel } from "./panels/FeedbackPanel"
import { TraceExplorer, TraceHistoryDialog, TraceTriggerScopeToggle } from "./TraceHistoryDialog"
import { CommitDetailsDialog } from "./CommitDetailsDialog"
import { UncommittedCodeDialog } from "./UncommittedCodeDialog"
import { marketApi, type MarketItem } from "../../api/market"
import {
  buildMarketSkillKeySet,
  buildMarketSkillMap,
  getMarketSkillItem,
  normalizeMarketSkillKey
} from "./skill-market"
import {
  buildUploaderIdCandidates,
  getUploaderIdCandidates,
  normalizeUploaderProfileField,
  parseUploaderIdentity,
  type UploaderProfileInfo
} from "../../lib/skill-data-service"

type UserInfoLite = {
  sapId?: string
  ystId?: string
}

const SKILL_EVAL_DOC_URL = "https://doc.cmbchina.com/f/v?id=_41lRJE"

// ─────────────────────────────────────────────────────────
// Time control bar
// ─────────────────────────────────────────────────────────

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "day", label: "日" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "custom", label: "自定义" }
]
const CUSTOM_RANGE_MAX_DAYS = 31
const MS_PER_DAY = 24 * 60 * 60 * 1000

type SkillUploaderExportInfo = {
  sapId: string
  userName: string
  orgName: string
}

type SkillUploaderProfile = UploaderProfileInfo & {
  upperOrgLv0?: string
  upperOrgLv1?: string
}

type DashboardExcelSheet = {
  name: string
  header: string[]
  rows: (string | number)[][]
}

type DashboardAnalysisScope = "platform" | "project"

type DashboardAnalysisMessage = {
  id: string
  role: "user" | "assistant"
  content: string
}

type DashboardAnalysisAgentResponse = {
  success: boolean
  data?: {
    content?: string
    modelName?: string
    toolCallCount?: number
  }
  error?: string
}

function formatRangeLabel(from: string, to: string, granularity: Granularity): string {
  const f = new Date(from)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const fmtDate = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (granularity === "day") return fmtDate(f)
  if (granularity === "custom") return `${fmtDate(f)} ~ ${fmtDate(new Date(to))}`
  if (granularity === "week") {
    const t = new Date(to)
    return `${fmtDate(f)} ~ ${fmtDate(t)}`
  }
  // month
  return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`
}

function formatDateInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDaysToDateInput(value: string, days: number): string {
  const date = new Date(value + "T00:00:00")
  date.setDate(date.getDate() + days)
  return formatDateInputValue(date)
}

function summarizeCodeStatsForAnalysis(stats: DashboardProjectModeData["summary"]["codeStats"]) {
  if (!stats) return null
  return {
    generatedLines: stats.generatedLines,
    measuredGeneratedLines: stats.measuredGeneratedLines,
    effectiveGeneratedLines: stats.effectiveGeneratedLines,
    unmeasuredGeneratedLines: stats.unmeasuredGeneratedLines,
    inclusiveEffectiveGeneratedLines: stats.inclusiveEffectiveGeneratedLines,
    adoptedLines: stats.adoptedLines,
    measuredAdoptionRate: stats.measuredAdoptionRate,
    inclusiveAdoptionRate: stats.inclusiveAdoptionRate,
    pushedEffectiveGeneratedLines: stats.pushedEffectiveGeneratedLines,
    pushedAdoptedLines: stats.pushedAdoptedLines,
    pushedAdoptionRate: stats.pushedAdoptionRate,
    inclusivePushedAdoptionRate: stats.inclusivePushedAdoptionRate,
    pushedCommitCount: stats.pushedCommitCount
  }
}

function buildDashboardAnalysisPanelSnapshot({
  scope,
  overview,
  projectMode
}: {
  scope: DashboardAnalysisScope
  overview: OverviewData | null
  projectMode: DashboardProjectModeData | null
}): Record<string, unknown> {
  if (scope === "project") {
    const summary = projectMode?.summary
    return {
      scope,
      summary: summary
        ? {
            projectCount: summary.projectCount,
            featureCount: summary.featureCount,
            activeProjectCount: summary.activeProjectCount,
            conversationCount: summary.conversationCount,
            totalToolCalls: summary.totalToolCalls,
            totalInputTokens: summary.totalInputTokens,
            totalOutputTokens: summary.totalOutputTokens,
            totalTokens: summary.totalTokens,
            skillCallCount: summary.skillCallCount,
            distinctSkillCount: summary.distinctSkillCount,
            codeStats: summarizeCodeStatsForAnalysis(summary.codeStats),
            skillCodeStats: summarizeCodeStatsForAnalysis(summary.skillCodeStats ?? null)
          }
        : null,
      topSkills: projectMode?.topSkills.slice(0, 10) ?? [],
      topUsers: projectMode?.analytics.topUsers.slice(0, 10) ?? [],
      topAdapters: projectMode?.analytics.byAdapter.slice(0, 10) ?? [],
      topSkillAdoption: projectMode?.bySkillAdoption.slice(0, 10) ?? []
    }
  }

  return {
    scope,
    summary: overview
      ? {
          totalCalls: overview.totalCalls,
          activeUsers: overview.activeUsers,
          avgDurationMs: overview.avgDurationMs,
          inputTokens: overview.inputTokens,
          outputTokens: overview.outputTokens,
          totalSkills: overview.totalSkills,
          totalSkillCalls: overview.totalSkillCalls,
          totalTools: overview.totalTools,
          totalToolCalls: overview.totalToolCalls,
          codeGeneratedLines: overview.codeGeneratedLines,
          codeMeasuredGeneratedLines: overview.codeMeasuredGeneratedLines,
          codeEffectiveGeneratedLines: overview.codeEffectiveGeneratedLines,
          codeUnmeasuredGeneratedLines: overview.codeUnmeasuredGeneratedLines,
          codeInclusiveEffectiveGeneratedLines: overview.codeInclusiveEffectiveGeneratedLines,
          codeAdoptedLines: overview.codeAdoptedLines,
          codeMeasuredAdoptionRate: overview.codeMeasuredAdoptionRate,
          codeInclusiveAdoptionRate: overview.codeInclusiveAdoptionRate,
          codePushedEffectiveGeneratedLines: overview.codePushedEffectiveGeneratedLines,
          codePushedAdoptedLines: overview.codePushedAdoptedLines,
          codePushedAdoptionRate: overview.codePushedAdoptionRate,
          codeInclusivePushedAdoptionRate: overview.codeInclusivePushedAdoptionRate,
          codePushedCommitCount: overview.codePushedCommitCount
        }
      : null,
    topSkills: overview?.bySkill.slice(0, 10) ?? [],
    topTools: overview?.byTool.slice(0, 10) ?? [],
    topSkillAdoption: overview?.bySkillAdoption.slice(0, 10) ?? [],
    recentTrend: overview?.trend.slice(-10) ?? []
  }
}

function normalizeDashboardMarkdown(content: string): string {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr: string) => `\n$$\n${expr.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr: string) => `$${expr.trim()}$`)
}

function getMarkdownLanguageLabel(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className || "")
  return match?.[1] ?? null
}

function getMarkdownNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(getMarkdownNodeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node))
    return getMarkdownNodeText(node.props.children)
  return ""
}

function DashboardAnalysisMarkdown({ content }: { content: string }): React.JSX.Element {
  const markdown = useMemo(() => normalizeDashboardMarkdown(content), [content])
  const components = useMemo<Components>(
    () => ({
      table({ node: _node, children, ...props }) {
        return (
          <div className="streaming-markdown-table-wrap">
            <table {...props}>{children}</table>
          </div>
        )
      },
      pre({ children }) {
        return <>{children}</>
      },
      code({ node: _node, className, children, ...props }) {
        const rawCode = getMarkdownNodeText(children)
        const language = getMarkdownLanguageLabel(className)
        const isBlock = !!language || rawCode.includes("\n")

        if (isBlock) {
          return (
            <div className="streaming-markdown-code-block">
              <div className="streaming-markdown-code-header">
                <span className="streaming-markdown-code-language">{language || "text"}</span>
              </div>
              <pre className="streaming-markdown-code-pre">
                <code className={className}>{children}</code>
              </pre>
            </div>
          )
        }

        return (
          <code className="streaming-markdown-inline-code" {...props}>
            {children}
          </code>
        )
      }
    }),
    []
  )

  return (
    <div className="streaming-markdown !text-[13px] !leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], rehypeHighlight]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

function DashboardAnalysisDrawer({
  open,
  scope,
  range,
  upperOrgLv1,
  panelSnapshot,
  onClose
}: {
  open: boolean
  scope: DashboardAnalysisScope
  range: TimeRange
  upperOrgLv1: string[]
  panelSnapshot: Record<string, unknown>
  onClose: () => void
}): React.JSX.Element | null {
  const scopeLabel = scope === "project" ? "项目运营概览" : "平台运营概览"
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<DashboardAnalysisMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "可以问我代码采纳率口径，或让我分析“生成了但没有提交”的人群。我是独立的运营指标分析 Agent，会使用默认模型并通过只读 ES DSL 安全门控查询数据。"
    }
  ])

  const appendMessage = useCallback((message: Omit<DashboardAnalysisMessage, "id">) => {
    setMessages((prev) => [
      ...prev,
      {
        ...message,
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    ])
  }, [])

  const runQuestion = useCallback(
    async (question: string) => {
      const normalized = question.trim()
      if (!normalized || loading) return
      appendMessage({ role: "user", content: normalized })
      setInput("")

      setLoading(true)
      try {
        const history = messages
          .filter((message) => message.id !== "welcome")
          .map((message) => ({ role: message.role, content: message.content }))
        const result = (await window.api.dashboard.analysisAgent({
          question: normalized,
          messages: history,
          context: {
            scope,
            range,
            upperOrgLv1,
            panelSnapshot
          }
        })) as DashboardAnalysisAgentResponse
        appendMessage({
          role: "assistant",
          content: result.success
            ? result.data?.content || "没有生成有效分析结果，请换个问题重试。"
            : `分析失败：${result.error ?? "未知错误"}`
        })
      } catch (error) {
        appendMessage({
          role: "assistant",
          content: `分析失败：${error instanceof Error ? error.message : String(error)}`
        })
      } finally {
        setLoading(false)
      }
    },
    [appendMessage, loading, messages, panelSnapshot, range, scope, upperOrgLv1]
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/40 backdrop-blur-[1px]">
      <section className="flex h-full w-full max-w-[520px] flex-col border-l border-border bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Bot className="size-4" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">运营指标分析 Agent</h2>
                <p className="text-[11px] text-muted-foreground">
                  {scopeLabel} · {formatRangeLabel(range.from, range.to, "custom")}
                </p>
              </div>
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" className="size-8 p-0" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={loading}
              onClick={() => void runQuestion("解释代码采纳率口径")}
            >
              <Info className="size-3.5" />
              采纳率口径
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={loading}
              onClick={() =>
                void runQuestion("为什么很多代码生成了却没有提交？这些代码是谁生成的？")
              }
            >
              <Database className="size-3.5" />
              未提交人群
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs leading-5",
                  message.role === "user"
                    ? "ml-8 border-primary/30 bg-primary/5 text-foreground"
                    : "mr-8 border-border bg-muted/40 text-foreground"
                )}
              >
                <div className="mb-1 text-[10px] font-medium text-muted-foreground">
                  {message.role === "user" ? "你" : "Agent"}
                </div>
                {message.role === "assistant" ? (
                  <DashboardAnalysisMarkdown content={message.content} />
                ) : (
                  <div className="whitespace-pre-wrap">{message.content}</div>
                )}
              </div>
            ))}
            {loading && (
              <div className="mr-8 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在调用独立 Agent 分析...
              </div>
            )}
          </div>
        </ScrollArea>

        <form
          className="border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void runQuestion(input)
          }}
        >
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="问：为什么很多代码生成了却没有提交？"
              className="min-h-20 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-primary"
            />
            <Button
              type="submit"
              size="sm"
              className="self-end gap-1.5"
              disabled={loading || !input.trim()}
            >
              <Send className="size-3.5" />
              发送
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function resolveSkillUploaderExportInfo(
  item: MarketItem | null,
  uploaderProfiles: Record<string, SkillUploaderProfile>
): SkillUploaderExportInfo {
  if (!item?.user_id) return { sapId: "", userName: "", orgName: "" }

  const parsed = parseUploaderIdentity(item.user_id)
  const profileCandidates = getUploaderIdCandidates(item.user_id)
  const profile = profileCandidates.map((candidate) => uploaderProfiles[candidate]).find(Boolean)

  return {
    sapId:
      normalizeUploaderProfileField(profile?.sapId) ||
      normalizeUploaderProfileField(parsed?.sapId) ||
      item.user_id.trim(),
    userName:
      normalizeUploaderProfileField(profile?.userName) ||
      normalizeUploaderProfileField(parsed?.userName),
    orgName:
      formatTopUserOrgName(
        normalizeUploaderProfileField(profile?.orgName),
        normalizeUploaderProfileField(profile?.upperOrgLv1),
        normalizeUploaderProfileField(profile?.upperOrgLv0)
      ) || normalizeUploaderProfileField(parsed?.orgName)
  }
}

function isUploadedByCurrentUser(item: MarketItem, currentUserCandidates: Set<string>): boolean {
  if (!item.user_id || currentUserCandidates.size === 0) return false
  return getUploaderIdCandidates(item.user_id).some((candidate) =>
    currentUserCandidates.has(candidate)
  )
}

function getMarketSkillQueryNames(item: MarketItem): string[] {
  return [item.name, item.filename].map((value) => value?.trim() || "").filter(Boolean)
}

function TimeControlBar({
  granularity,
  range,
  onGranularityChange,
  onNavigate,
  onCustomRange,
  onRefresh,
  loading,
  orgFilter
}: {
  granularity: Granularity
  range: { from: string; to: string }
  onGranularityChange: (g: Granularity) => void
  onNavigate: (dir: "prev" | "next") => void
  onCustomRange: (from: string, to: string) => void
  onRefresh: () => void
  loading: boolean
  orgFilter?: ReactNode
}) {
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [customRangeError, setCustomRangeError] = useState("")
  const customToMax = customFrom ? addDaysToDateInput(customFrom, CUSTOM_RANGE_MAX_DAYS - 1) : ""

  const handleCustomConfirm = (): void => {
    if (!customFrom || !customTo) return

    const fromDate = new Date(customFrom + "T00:00:00")
    const toDate = new Date(customTo + "T00:00:00")
    if (toDate < fromDate) {
      setCustomRangeError("结束日期不能早于开始日期")
      return
    }

    const selectedDays = Math.floor((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY) + 1
    if (selectedDays > CUSTOM_RANGE_MAX_DAYS) {
      setCustomRangeError(`自定义范围最多选择 ${CUSTOM_RANGE_MAX_DAYS} 天`)
      return
    }

    setCustomRangeError("")
    onCustomRange(
      new Date(customFrom + "T00:00:00").toISOString(),
      new Date(customTo + "T23:59:59.999").toISOString()
    )
    setShowDatePicker(false)
  }

  return (
    <div className="flex items-center gap-3 px-6 py-3 border-b border-border bg-background/80 backdrop-blur-sm">
      {/* Granularity tabs */}
      <div className="flex items-center rounded-lg border border-border overflow-hidden">
        {GRANULARITY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              granularity === opt.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
            onClick={() => {
              if (opt.value === "custom") {
                setShowDatePicker(true)
                onGranularityChange("custom")
              } else {
                setShowDatePicker(false)
                onGranularityChange(opt.value)
              }
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Navigation arrows (not for custom) */}
      {granularity !== "custom" && (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("prev")}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-xs text-foreground font-medium min-w-[140px] text-center">
            {formatRangeLabel(range.from, range.to, granularity)}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => onNavigate("next")}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Custom date picker */}
      {granularity === "custom" && showDatePicker && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => {
                setCustomFrom(e.target.value)
                setCustomRangeError("")
              }}
              className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
            />
            <span className="text-xs text-muted-foreground">~</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              max={customToMax || undefined}
              onChange={(e) => {
                setCustomTo(e.target.value)
                setCustomRangeError("")
              }}
              className="h-7 px-2 text-xs border border-border rounded bg-background text-foreground"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleCustomConfirm}
            >
              确认
            </Button>
          </div>
          {customRangeError ? (
            <span className="text-[11px] leading-none text-destructive">{customRangeError}</span>
          ) : null}
        </div>
      )}

      {granularity === "custom" && !showDatePicker && (
        <span className="text-xs text-foreground font-medium">
          {formatRangeLabel(range.from, range.to, granularity)}
          <button className="ml-2 text-primary underline" onClick={() => setShowDatePicker(true)}>
            修改
          </button>
        </span>
      )}

      {/* 室筛选：紧跟日期控件之后 */}
      {orgFilter}

      {/* Spacer + Refresh */}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        刷新
      </Button>
    </div>
  )
}

// 「未归类」哨兵，需与后端 DASHBOARD_UNCLASSIFIED_ORG 保持一致。
const ORG_UNCLASSIFIED = "__unclassified__"
const orgOptionLabel = (org: string): string => (org === ORG_UNCLASSIFIED ? "（未归类）" : org)

// 进入活跃用户列表时，把顶部全局「室筛选」（多选）回填进「部门查询」文本框。
// 多选用中文逗号连接，后端 buildOrgLevelMatchFilter 会按逗号拆分并 OR 匹配。
const buildDepartmentPrefill = (orgList: string[]): string => orgList.map(orgOptionLabel).join("，")

function InfoHint({ content }: { content: ReactNode }): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-label="查看部门查询说明"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function OrgFilterBar({
  value,
  options,
  loading,
  onChange
}: {
  value: string[]
  options: string[]
  loading: boolean
  onChange: (orgList: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selectedSet = new Set(value)

  const toggleOrg = (org: string): void => {
    if (selectedSet.has(org)) {
      onChange(value.filter((item) => item !== org))
    } else {
      onChange([...value, org])
    }
  }

  const triggerLabel =
    value.length === 0
      ? "全部"
      : value.length === 1
        ? orgOptionLabel(value[0])
        : `已选 ${value.length} 个室`

  return (
    <div className="flex items-center gap-2">
      <Building2 className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">室筛选</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-[240px] justify-between gap-1 text-xs font-normal"
            disabled={loading && options.length === 0}
          >
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {triggerLabel}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-1">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-muted/60"
            onClick={() => onChange([])}
          >
            <span
              className={
                value.length === 0 ? "font-medium text-foreground" : "text-muted-foreground"
              }
            >
              全部
            </span>
            {value.length === 0 && <Check className="size-3.5 text-primary" />}
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="max-h-64 overflow-y-auto pr-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                暂无可选室
              </div>
            ) : (
              options.map((org) => {
                const checked = selectedSet.has(org)
                return (
                  <button
                    key={org}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                    onClick={() => toggleOrg(org)}
                  >
                    <span className={cn("truncate", checked && "font-medium text-foreground")}>
                      {orgOptionLabel(org)}
                    </span>
                    {checked && <Check className="size-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange([])}
        >
          <X className="size-3.5" />
          清除
        </Button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Main Dashboard View
// ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

function formatPercent(value: number | null): string {
  if (value === null) return "—"
  return `${(value * 100).toFixed(2)}%`
}

const EMPTY_SKILL_DETAIL: DashboardSkillDetail = {
  stats: {
    generatedLines: 0,
    deletedLines: 0,
    effectiveGeneratedLines: 0,
    measuredGeneratedLines: 0,
    unmeasuredGeneratedLines: 0,
    inclusiveEffectiveGeneratedLines: 0,
    adoptedLines: 0,
    pushedMeasuredGeneratedLines: 0,
    pushedEffectiveGeneratedLines: 0,
    pushedAdoptedLines: 0,
    pushedCommitCount: 0,
    measuredAdoptionRate: null,
    inclusiveAdoptionRate: null,
    pushedAdoptionRate: null,
    inclusivePushedAdoptionRate: null,
    adoptionRate: null
  },
  traces: [],
  tracePage: 1,
  tracePageSize: 10,
  totalTraces: 0
}

const USER_LIST_PAGE_SIZE = 20
const USER_LIST_EXPORT_PAGE_SIZE = 100
const USER_LIST_EXPORT_MAX_PAGES = 100
const USER_TRACE_PAGE_SIZE = 10
const SKILL_TRACE_PAGE_SIZE = 10
const PROJECT_TRACE_PAGE_SIZE = 10
const PROJECT_TRACE_TRIGGER_SCOPE: DashboardTraceTriggerScope = "active"

type DashboardSubPage =
  | { kind: "main" }
  | { kind: "user-list" }
  | {
      kind: "user-detail"
      sapId: string
      backTo: "main" | "user-list"
      // true: 入口来自「项目运营概览」，Trace 分析只统计项目模式数据。
      projectMode?: boolean
    }

type DashboardMainTab = "overview" | "skill-eval" | "project-mode"

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return String(Math.round(tokens))
}

function formatSkillEvalTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return `${Math.round(value)}`
}

function formatSkillEvalPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatSkillEvalScore(value: number): string {
  return `${Math.round(value * 100)}分`
}

function formatDateTime(iso?: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("zh-CN")
}

function formatDateOnly(iso?: string): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString("zh-CN")
}

async function fetchAllActiveUsersForExport(range: TimeRange): Promise<DashboardUserListItem[]> {
  const users: DashboardUserListItem[] = []
  let afterKey: Record<string, string | number> | undefined

  for (let page = 0; page < USER_LIST_EXPORT_MAX_PAGES; page++) {
    const result = await window.api.dashboard.userList(range, {
      pageSize: USER_LIST_EXPORT_PAGE_SIZE,
      afterKey: afterKey ?? null,
      keyword: null
    })

    if (!result.success) {
      throw new Error(result.error ?? "获取活跃用户列表失败")
    }

    const data = result.data
    if (!data) break
    users.push(...data.items)

    if (!data.nextAfterKey) break
    afterKey = data.nextAfterKey
  }

  return users
}

function buildProjectModeCodeRows(
  stats: DashboardProjectModeProject["codeStats"]
): (string | number)[][] {
  if (!stats) return []
  return [
    ["代码生成行数", stats.generatedLines],
    ["代码删除行数", stats.deletedLines],
    ["代码已测量原始生成行数", stats.measuredGeneratedLines],
    ["代码已测量有效生成行数", stats.effectiveGeneratedLines],
    ["代码未提交生成行数", stats.unmeasuredGeneratedLines],
    ["代码含未提交分母行数", stats.inclusiveEffectiveGeneratedLines],
    ["代码采纳行数", stats.adoptedLines],
    ["总量提交采纳率（相对全部有效生成）", formatPercent(stats.inclusiveAdoptionRate)],
    ["提交采纳率（已 Commit 采纳率）", formatPercent(stats.measuredAdoptionRate)],
    ["代码已 Push 原始生成行数", stats.pushedMeasuredGeneratedLines],
    ["代码已 Push 有效生成行数", stats.pushedEffectiveGeneratedLines],
    ["代码已 Push 采纳行数", stats.pushedAdoptedLines],
    ["代码已 Push Commit 数", stats.pushedCommitCount],
    ["入库采纳率（已 Push 采纳率）", formatPercent(stats.pushedAdoptionRate)],
    ["总量入库采纳率（已 Push 真实入库率）", formatPercent(stats.inclusivePushedAdoptionRate)]
  ]
}

function flattenProjectModeOrgRows(
  items: DashboardProjectModeData["analytics"]["byOrg"],
  parent = ""
): (string | number)[][] {
  return items.flatMap((item) => [
    [parent ? `${parent}/${item.org}` : item.org, item.count],
    ...flattenProjectModeOrgRows(item.children ?? [], parent ? `${parent}/${item.org}` : item.org)
  ])
}

function outcomeLabel(outcome: string): string {
  if (outcome === "success") return "成功"
  if (outcome === "error") return "失败"
  if (outcome === "cancelled") return "已取消"
  return outcome || "未知"
}

type SkillEvalCheckItem = DashboardSkillEvalRun["checks"][number]

function detailValue(detail: Record<string, unknown> | undefined, key: string): unknown {
  return detail && Object.prototype.hasOwnProperty.call(detail, key) ? detail[key] : undefined
}

function formatCheckDetailValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "0"
    return value.map((item) => formatCheckDetailValue(item)).join("、")
  }
  if (typeof value === "boolean") return value ? "是" : "否"
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === "string") return value || "空"
  if (value === null || value === undefined) return "无"
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function checkRuleLines(check: SkillEvalCheckItem): string[] {
  const detail = check.detail
  const value = (key: string) => formatCheckDetailValue(detailValue(detail, key))

  switch (check.name) {
    case "step_budget_reasonable":
      return ["步骤数 <= " + value("max") + " 通过", "当前步骤数：" + value("steps")]
    case "tool_budget_reasonable":
      return ["工具调用数 <= " + value("max") + " 通过", "当前工具调用：" + value("totalToolCalls")]
    case "no_repeated_tool_calls":
      return [
        "连续相同工具调用不超过 " + value("maxConsecutiveSameCall") + " 次",
        "当前重复次数：" + value("repeatedToolCalls")
      ]
    case "input_tokens_reasonable":
      return [
        "平均 Prompt 输入 <= " + value("max") + " 通过",
        "当前平均输入：" + value("averagePromptInputTokens")
      ]
    case "peak_input_tokens_reasonable":
      return [
        "最高单次输入 <= " + value("max") + " 通过",
        "当前峰值输入：" + value("peakInputTokens")
      ]
    case "run_completed_successfully":
      return ["trace outcome 必须是 success", "当前 outcome：" + value("outcome")]
    case "final_response_present":
      return ["能提取到最终回复文本即通过", "当前回复长度：" + value("responseLength")]
    case "terminal_message_success":
      return [
        "终止消息节点有输出内容即通过",
        "当前输出长度：" + value("terminalOutputLength"),
        "终止状态：" + value("terminalStatus")
      ]
    case "no_tool_result_errors":
      return ["工具结果错误数为 0 即通过", "当前错误数：" + value("toolResultErrors")]
    case "final_response_substantive":
      return [
        "最终响应长度 >= " + value("min") + " 字即通过",
        "当前响应长度：" + value("responseLength")
      ]
    case "has_output_signal":
      return [
        "有文件改动、工具产物信号，或最终响应达到实质长度即通过",
        "改动文件：" + value("changedFiles"),
        "工具产物信号：" + value("artifactSignals"),
        "最终响应长度：" + value("finalResponseLength")
      ]
    case "has_validation_signal":
      return [
        "没有文件改动时不要求验证；有文件改动时需检测到验证命令",
        "是否需要验证：" + value("validationNeeded"),
        "验证命令：" + value("validationCommands")
      ]
    case "no_dangerous_commands":
      return ["未检测到高风险命令即通过", "高风险命令：" + value("dangerousCommands")]
    default:
      return detail
        ? Object.entries(detail).map(([key, item]) => key + "：" + formatCheckDetailValue(item))
        : ["暂无详细判定数据"]
  }
}

function SkillEvalCheckBadge({
  check,
  prefix
}: {
  check: SkillEvalCheckItem
  prefix?: string
}): React.JSX.Element {
  return (
    <Badge
      variant={check.ok ? "nominal" : "warning"}
      className="inline-flex items-center gap-1 normal-case tracking-normal"
    >
      <span>{prefix ? prefix + check.label : check.label}</span>
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              <CircleAlert className="size-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80 text-xs leading-relaxed">
            <div className="space-y-1">
              <div className="font-medium text-foreground">{check.label}</div>
              <div>状态：{check.ok ? "通过" : "未通过"}</div>
              <div>权重：{check.weight}</div>
              {checkRuleLines(check).map((line, index) => (
                <div key={check.name + ":" + index}>{line}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </Badge>
  )
}

function UserMetricCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold leading-tight text-foreground">{value}</div>
      {sub ? <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

function UserListPage({
  data,
  loading,
  error,
  canGoPrevious,
  canGoNext,
  onBack,
  onRefresh,
  onPrevious,
  onNext,
  searchValue,
  searchKeyword,
  departmentValue,
  departmentFilter,
  onSearchValueChange,
  onDepartmentValueChange,
  onSearch,
  onClearSearch,
  onClearDepartment,
  onUserClick
}: {
  data: DashboardUserListData | null
  loading: boolean
  error: string | null
  canGoPrevious: boolean
  canGoNext: boolean
  onBack: () => void
  onRefresh: () => void
  onPrevious: () => void
  onNext: () => void
  searchValue: string
  searchKeyword: string
  departmentValue: string
  departmentFilter: string
  onSearchValueChange: (value: string) => void
  onDepartmentValueChange: (value: string) => void
  onSearch: () => void
  onClearSearch: () => void
  onClearDepartment: () => void
  onUserClick: (user: DashboardUserListItem) => void
}): React.JSX.Element {
  const hasSearchKeyword = searchKeyword.trim().length > 0
  const hasDepartmentFilter = departmentFilter.trim().length > 0

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
            <ChevronLeft className="size-4" />
            返回面板
          </Button>
          <div>
            <h2 className="text-sm font-semibold text-foreground">活跃用户列表</h2>
            <p className="text-xs text-muted-foreground">
              共 {formatNumber(data?.totalActiveUsers ?? 0)} 位活跃用户
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          刷新
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Users className="size-4" />
            用户明细
          </div>
          <form
            className="flex flex-1 items-center justify-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              onSearch()
            }}
          >
            <InfoHint
              content={
                <div className="space-y-1">
                  <div>支持按室 / 部门名称模糊查询。</div>
                  <div className="text-muted-foreground">多个用逗号分隔，命中其中任一即显示。</div>
                </div>
              }
            />
            <div className="relative w-full max-w-[220px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={departmentValue}
                onChange={(event) => onDepartmentValueChange(event.target.value)}
                aria-label="按 Lv1 或 Lv0 部门筛选"
                placeholder="部门查询"
                className="h-8 pl-8 pr-8 text-xs"
              />
              {departmentValue && (
                <button
                  type="button"
                  onClick={onClearDepartment}
                  className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="清空部门筛选"
                  title="清空"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <div className="relative w-full max-w-[280px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchValue}
                onChange={(event) => onSearchValueChange(event.target.value)}
                aria-label="按用户名或 ystId 查询"
                placeholder="用户查询"
                className="h-8 pl-8 pr-8 text-xs"
              />
              {searchValue && (
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="absolute right-2 top-1/2 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="清空用户查询"
                  title="清空"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={loading}>
              查询
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPrevious}
              disabled={!canGoPrevious || loading}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={onNext}
              disabled={!canGoNext || loading}
            >
              下一页
              <ChevronRight className="size-3.5" />
            </Button>
          </form>
        </div>

        {loading && !data ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-64 items-center justify-center px-6 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">用户</th>
                  <th className="px-3 py-2 text-left font-medium">部门</th>
                  <th className="px-3 py-2 text-right font-medium">调用次数</th>
                  <th className="px-3 py-2 text-right font-medium">工具调用</th>
                  <th className="px-3 py-2 text-right font-medium">Token</th>
                  <th className="px-3 py-2 text-left font-medium">最近活跃</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((user) => (
                  <tr
                    key={user.sapId}
                    className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/30"
                    onClick={() => onUserClick(user)}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {user.userName || user.sapId}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {user.sapId}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {user.upperOrgLv1 && user.upperOrgLv0
                        ? `${user.upperOrgLv1}/${user.upperOrgLv0}`
                        : user.orgName || "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatNumber(user.count)}</td>
                    <td className="px-3 py-2 text-right">{formatNumber(user.totalToolCalls)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatCompactTokens(user.totalTokens)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(user.lastActiveAt)}
                    </td>
                  </tr>
                ))}
                {(data?.items ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                      {hasSearchKeyword ? "未找到匹配用户" : "当前时间范围内暂无活跃用户"}
                      {hasDepartmentFilter ? `（部门：${departmentFilter}）` : ""}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function UserDetailPage({
  data,
  loading,
  error,
  tracePage,
  traceViewMode,
  traceTriggerScope,
  projectMode = false,
  onBack,
  onTracePrevious,
  onTraceNext,
  onTraceViewModeChange,
  onTraceTriggerScopeChange,
  loadThreadTraces
}: {
  data: DashboardUserDetail | null
  loading: boolean
  error: string | null
  tracePage: number
  traceViewMode: DashboardTraceViewMode
  traceTriggerScope: DashboardTraceTriggerScope
  projectMode?: boolean
  onBack: () => void
  onTracePrevious: () => void
  onTraceNext: () => void
  onTraceViewModeChange: (mode: DashboardTraceViewMode) => void
  onTraceTriggerScopeChange: (scope: DashboardTraceTriggerScope) => void
  loadThreadTraces?: (threadId: string) => Promise<DashboardTraceDetail[]>
}): React.JSX.Element {
  const tracePageSize = data?.tracePageSize ?? USER_TRACE_PAGE_SIZE
  // 列表翻页总数按当前视图模式：thread → 会话数；trace → trace 总数。
  const total = data?.total ?? 0
  const canTracePrevious = tracePage > 1 && !loading
  const canTraceNext = Boolean(data) && tracePage * tracePageSize < total && !loading
  const traceTitle =
    traceViewMode === "thread"
      ? `会话记录（第 ${tracePage} 页）`
      : `Trace 记录（第 ${tracePage} 页）`
  const traceSubtitle =
    traceViewMode === "thread"
      ? `共 ${formatNumber(total)} 个会话，选择记录定位到对话`
      : `共 ${formatNumber(total)} 条，选择记录定位到对话`

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack}>
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            用户 Trace 分析
            {projectMode ? (
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                仅项目模式
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground">
            {data ? `${data.userName || data.sapId} · ${data.sapId}` : "加载用户信息中"}
          </p>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : data ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-violet-500">
                <User className="size-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">
                  {data.userName || data.sapId}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {data.sapId}
                  {data.ystId ? ` · ${data.ystId}` : ""}
                  {data.upperOrgLv1 || data.upperOrgLv0 || data.orgName
                    ? ` · ${data.upperOrgLv1 && data.upperOrgLv0 ? `${data.upperOrgLv1}/${data.upperOrgLv0}` : data.orgName}`
                    : ""}
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-5 gap-3">
              <UserMetricCard label="调用次数" value={formatNumber(data.totalCalls)} />
              <UserMetricCard label="平均耗时" value={formatDuration(data.avgDurationMs)} />
              <UserMetricCard label="工具调用" value={formatNumber(data.totalToolCalls)} />
              <UserMetricCard
                label="输入 Token"
                value={formatCompactTokens(data.totalInputTokens)}
              />
              <UserMetricCard
                label="输出 Token"
                value={formatCompactTokens(data.totalOutputTokens)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">常用 Skill</h3>
              <div className="space-y-2">
                {data.bySkill.map((item) => (
                  <div key={item.skill} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-foreground">{item.skill}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.bySkill.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">常用模型</h3>
              <div className="space-y-2">
                {data.byModel.map((item) => (
                  <div key={item.model} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-foreground">{item.model}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.byModel.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-3 text-xs font-medium text-muted-foreground">执行结果</h3>
              <div className="space-y-2">
                {data.byOutcome.map((item) => (
                  <div
                    key={item.outcome}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="truncate text-foreground">{outcomeLabel(item.outcome)}</span>
                    <span className="font-medium">{formatNumber(item.count)}</span>
                  </div>
                ))}
                {data.byOutcome.length === 0 && (
                  <div className="text-xs text-muted-foreground">暂无数据</div>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <TraceExplorer
              traces={data.traces}
              loading={loading}
              title={traceTitle}
              subtitle={traceSubtitle}
              viewMode={traceViewMode}
              onViewModeChange={onTraceViewModeChange}
              loadThreadTraces={loadThreadTraces}
              headerRight={
                <div className="flex items-center gap-2">
                  <TraceTriggerScopeToggle
                    value={traceTriggerScope}
                    onChange={onTraceTriggerScopeChange}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onTracePrevious}
                    disabled={!canTracePrevious}
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={onTraceNext}
                    disabled={!canTraceNext}
                  >
                    下一页
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              }
              emptyText="当前时间范围内没有该用户的 trace"
              showCodeStats={false}
              className="h-[560px]"
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DashboardTabBar({
  activeTab,
  onChange,
  projectModeAllowed,
  rightContent
}: {
  activeTab: DashboardMainTab
  onChange: (tab: DashboardMainTab) => void
  projectModeAllowed: boolean
  rightContent?: ReactNode
}): React.JSX.Element {
  const tabs: Array<{ id: DashboardMainTab; label: string }> = [
    { id: "overview", label: "平台运营概览" },
    ...(projectModeAllowed ? ([{ id: "project-mode", label: "项目运营概览" }] as const) : [])
    // 技能评估 tab 暂时隐藏（仅移除入口，skill-eval 相关逻辑/内容/类型均保留，需要时取消注释即可恢复）
    // { id: "skill-eval", label: "技能评估" }
  ]

  return (
    <div className="flex items-center gap-1 border-b border-border px-6 pt-4">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
      {rightContent ? <div className="ml-auto flex items-center pb-2">{rightContent}</div> : null}
    </div>
  )
}

const SkillEvalStatTile = memo(function SkillEvalStatTile({
  label,
  value
}: {
  label: string
  value: string | number
}): React.JSX.Element {
  return (
    <div className="border border-border bg-background px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  )
})

function skillEvalVersionLabel(skillName: string, skillVersion?: string): string {
  return skillVersion ? `${skillName} ${skillVersion}` : `${skillName} 未标版本`
}

function skillEvalKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
}

function getLatestSkillEvalKey(data: DashboardSkillEvalSummary | null): string | null {
  if (!data) return null

  if (data.skills.length > 0) {
    const firstSkill = data.skills[0]
    return skillEvalKey(firstSkill.skillName, firstSkill.skillVersion)
  }

  const latestRun = data.recent[0]
  return latestRun ? skillEvalKey(latestRun.skillName, latestRun.skillVersion) : null
}

function skillEvalFilterForKey(
  skillByKey: Map<string, DashboardSkillEvalSummary["skills"][number]>,
  key: string | null
): { skillName?: string; skillVersion?: string } | undefined {
  if (!key) return undefined
  const skill = skillByKey.get(key)
  if (!skill) return undefined
  return {
    skillName: skill.skillName,
    ...(skill.skillVersion ? { skillVersion: skill.skillVersion } : {})
  }
}

const SkillEvalSkillRow = memo(function SkillEvalSkillRow({
  skill,
  active,
  skillKey,
  onSelect
}: {
  skill: DashboardSkillEvalSummary["skills"][number]
  active: boolean
  skillKey: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  const handleClick = useCallback(() => {
    onSelect(skillKey)
  }, [onSelect, skillKey])
  const statsStateLabel = skill.statsFailed ? "!" : "—"
  const statsStateTitle = skill.statsFailed ? "统计加载失败" : "统计加载中"
  const renderStatsValue = (value: string): string =>
    skill.statsPending || skill.statsFailed ? statsStateLabel : value

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`grid w-full grid-cols-[4px_minmax(96px,1fr)_42px_50px_48px_48px_54px] items-center gap-2 border-b border-border px-4 py-3 text-left text-sm transition-colors hover:bg-muted/35 ${
        active
          ? "bg-primary/12 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.22)]"
          : ""
      }`}
      aria-current={active ? "true" : undefined}
    >
      <span className={`h-8 rounded-full ${active ? "bg-primary" : "bg-transparent"}`} />
      <div className="min-w-0">
        <div className={`truncate font-medium ${active ? "text-foreground" : "text-foreground"}`}>
          {skill.skillName}
        </div>
        <div
          className={`mt-0.5 text-[11px] ${active ? "text-foreground/70" : "text-muted-foreground"}`}
        >
          {skill.skillVersion ?? "未标版本"} · {formatRelativeTime(skill.lastRunAt)}
        </div>
      </div>
      <div
        className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
      >
        {renderStatsValue(formatNumber(skill.runs))}
      </div>
      <div
        className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
        title={skill.statsPending || skill.statsFailed ? statsStateTitle : undefined}
      >
        {renderStatsValue(formatSkillEvalPercent(skill.passRate))}
      </div>
      <div
        className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
        title={skill.statsPending || skill.statsFailed ? statsStateTitle : undefined}
      >
        {renderStatsValue(formatSkillEvalScore(skill.averageOutcomeScore))}
      </div>
      <div
        className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
        title={skill.statsPending || skill.statsFailed ? statsStateTitle : undefined}
      >
        {renderStatsValue(formatSkillEvalScore(skill.averageScore))}
      </div>
      <div
        className={`text-right text-xs tabular-nums ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
        title={skill.statsPending || skill.statsFailed ? statsStateTitle : undefined}
      >
        {renderStatsValue(formatSkillEvalTokens(skill.averageTotalTokens))}
      </div>
    </button>
  )
})

const SkillEvalRunRow = memo(function SkillEvalRunRow({
  run,
  onOpenTrace
}: {
  run: DashboardSkillEvalRun
  onOpenTrace: (run: DashboardSkillEvalRun) => void
}): React.JSX.Element {
  const warnings = useMemo(
    () => [...run.warnings, ...run.outcomeWarnings, ...run.resultWarnings].slice(0, 2),
    [run.outcomeWarnings, run.resultWarnings, run.warnings]
  )
  const checks = useMemo(
    () => [...run.checks, ...run.outcomeChecks],
    [run.checks, run.outcomeChecks]
  )
  const cacheTokens = run.cacheReadTokens + run.cacheCreationTokens
  const handleClick = useCallback(() => {
    onOpenTrace(run)
  }, [onOpenTrace, run])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/35"
    >
      <div className="flex items-start gap-3">
        {run.pass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-nominal" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{run.skillName}</span>
            {run.skillVersion && <Badge variant="outline">{run.skillVersion}</Badge>}
            <Badge variant={run.pass ? "nominal" : "critical"}>
              {formatSkillEvalScore(run.score)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(run.startedAt)}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground" title={run.userMessage}>
            {truncate(run.userMessage, 140)}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>工具 {run.totalToolCalls}</span>
            <span>模型调用 {run.modelCallCount}</span>
            <span title="非缓存输入 Token">输入 {formatSkillEvalTokens(run.totalInputTokens)}</span>
            {cacheTokens > 0 && (
              <span title="缓存读取 + 缓存写入 Token">
                缓存输入 {formatSkillEvalTokens(cacheTokens)}
              </span>
            )}
            <span title="输入 + 缓存读取 + 缓存写入">
              Prompt {formatSkillEvalTokens(run.promptInputTokens)}
            </span>
            <span>输出 {formatSkillEvalTokens(run.totalOutputTokens)}</span>
            <span title="单次模型调用看到的最大输入 Token">
              峰值输入 {formatSkillEvalTokens(run.peakInputTokens)}
            </span>
            <span>错误 {run.errorCount}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{outcomeLabel(run.outcome)}</span>
            <span title={run.traceId}>链路 {run.traceId.slice(0, 8)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="normal-case tracking-normal">
              过程 {formatSkillEvalScore(run.processScore)}
            </Badge>
            <Badge
              variant={run.outcomePass === false ? "warning" : "nominal"}
              className="normal-case tracking-normal"
            >
              结束 {formatSkillEvalScore(run.outcomeScore)}
            </Badge>
            <Badge
              variant={run.resultGenerated ? (run.resultPass ? "nominal" : "warning") : "outline"}
              className="normal-case tracking-normal"
            >
              结果 {run.resultGenerated ? formatSkillEvalScore(run.resultScore ?? 0) : "待生成"}
            </Badge>
            <Badge variant="outline" className="normal-case tracking-normal">
              Token {formatSkillEvalTokens(run.totalTokens)}
            </Badge>
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{warnings.join(" · ")}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checks.map((check) => (
              <SkillEvalCheckBadge key={check.name} check={check} />
            ))}
            {run.resultChecks.map((check) => (
              <SkillEvalCheckBadge key={`result:${check.name}`} check={check} prefix="结果: " />
            ))}
          </div>
          {run.resultGenerated ? (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>最终响应 {run.evidence.finalResponseLength} 字</span>
              <span>产物信号 {run.evidence.artifactSignals}</span>
              <span>改动文件 {run.evidence.changedFiles}</span>
              <span>验证动作 {run.evidence.validationCommands}</span>
              {run.evidence.subagentRuns > 0 && (
                <>
                  <span>子 agent {run.evidence.subagentRuns}</span>
                  <span>子结果 {run.evidence.subagentResultLength} 字</span>
                  <span>子失败 {run.evidence.subagentFailed}</span>
                </>
              )}
              <span>风险命令 {run.evidence.dangerousCommands}</span>
              <span>结果错误 {run.evidence.toolResultErrors}</span>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-muted-foreground">
              通用结果评估会在新运行结束后异步生成
            </div>
          )}
          {run.resultIssues.length > 0 && (
            <div className="mt-2 text-[11px] text-status-critical">
              {run.resultIssues.slice(0, 3).join(" · ")}
            </div>
          )}
          {run.resultArtifacts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {run.resultArtifacts.slice(0, 6).map((artifact, index) => (
                <Badge
                  key={`${artifact.type}:${artifact.path ?? artifact.url ?? index}`}
                  variant="outline"
                  className="normal-case tracking-normal"
                  title={artifact.path ?? artifact.url ?? JSON.stringify(artifact.detail ?? {})}
                >
                  {artifact.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-[11px] text-muted-foreground" title={run.traceId}>
          详情
        </div>
      </div>
    </button>
  )
})

const SkillEvalRunSummary = memo(function SkillEvalRunSummary({
  run
}: {
  run: DashboardSkillEvalRun
}): React.JSX.Element {
  const warnings = useMemo(
    () => [...run.warnings, ...run.outcomeWarnings, ...run.resultWarnings].slice(0, 3),
    [run.outcomeWarnings, run.resultWarnings, run.warnings]
  )
  const checks = useMemo(
    () => [...run.checks, ...run.outcomeChecks],
    [run.checks, run.outcomeChecks]
  )
  const cacheTokens = run.cacheReadTokens + run.cacheCreationTokens

  return (
    <div className="border-b border-border bg-background px-5 py-4">
      <div className="flex items-start gap-3">
        {run.pass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-status-nominal" />
        ) : (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-status-critical" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{run.skillName}</span>
            {run.skillVersion && <Badge variant="outline">{run.skillVersion}</Badge>}
            <Badge variant={run.pass ? "nominal" : "critical"}>
              {formatSkillEvalScore(run.score)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {formatRelativeTime(run.startedAt)}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground" title={run.userMessage}>
            {truncate(run.userMessage, 180)}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>工具 {run.totalToolCalls}</span>
            <span>模型调用 {run.modelCallCount}</span>
            <span title="非缓存输入 Token">输入 {formatSkillEvalTokens(run.totalInputTokens)}</span>
            {cacheTokens > 0 && (
              <span title="缓存读取 + 缓存写入 Token">
                缓存输入 {formatSkillEvalTokens(cacheTokens)}
              </span>
            )}
            <span title="输入 + 缓存读取 + 缓存写入">
              Prompt {formatSkillEvalTokens(run.promptInputTokens)}
            </span>
            <span>输出 {formatSkillEvalTokens(run.totalOutputTokens)}</span>
            <span title="单次模型调用看到的最大输入 Token">
              峰值输入 {formatSkillEvalTokens(run.peakInputTokens)}
            </span>
            <span>错误 {run.errorCount}</span>
            <span>{formatDuration(run.durationMs)}</span>
            <span>{outcomeLabel(run.outcome)}</span>
            <span title={run.traceId}>链路 {run.traceId.slice(0, 8)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline" className="normal-case tracking-normal">
              过程 {formatSkillEvalScore(run.processScore)}
            </Badge>
            <Badge
              variant={run.outcomePass === false ? "warning" : "nominal"}
              className="normal-case tracking-normal"
            >
              结束 {formatSkillEvalScore(run.outcomeScore)}
            </Badge>
            <Badge
              variant={run.resultGenerated ? (run.resultPass ? "nominal" : "warning") : "outline"}
              className="normal-case tracking-normal"
            >
              结果 {run.resultGenerated ? formatSkillEvalScore(run.resultScore ?? 0) : "待生成"}
            </Badge>
            <Badge variant="outline" className="normal-case tracking-normal">
              Token {formatSkillEvalTokens(run.totalTokens)}
            </Badge>
          </div>
          {warnings.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-warning">
              <AlertCircle className="size-3.5" />
              <span>{warnings.join(" · ")}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {checks.map((check) => (
              <SkillEvalCheckBadge key={check.name} check={check} />
            ))}
            {run.resultChecks.map((check) => (
              <SkillEvalCheckBadge key={`result:${check.name}`} check={check} prefix="结果: " />
            ))}
          </div>
          {run.resultGenerated ? (
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>最终响应 {run.evidence.finalResponseLength} 字</span>
              <span>产物信号 {run.evidence.artifactSignals}</span>
              <span>改动文件 {run.evidence.changedFiles}</span>
              <span>验证动作 {run.evidence.validationCommands}</span>
              {run.evidence.subagentRuns > 0 && (
                <>
                  <span>子 agent {run.evidence.subagentRuns}</span>
                  <span>子结果 {run.evidence.subagentResultLength} 字</span>
                  <span>子失败 {run.evidence.subagentFailed}</span>
                </>
              )}
              <span>风险命令 {run.evidence.dangerousCommands}</span>
              <span>结果错误 {run.evidence.toolResultErrors}</span>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-muted-foreground">
              通用结果评估会在新运行结束后异步生成
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

const SkillEvalDashboardPanel = memo(function SkillEvalDashboardPanel({
  data,
  loading,
  range,
  mineOnly,
  mineSkillCount,
  mineSkillsLoading,
  skillSearch,
  onSkillSearchChange,
  onRecentPageChange,
  onSkillPageChange,
  onMineOnlyChange,
  onOpenTrace,
  selectedSkillKey,
  onSelectedSkillKeyChange
}: {
  data: DashboardSkillEvalSummary | null
  loading: boolean
  range: TimeRange
  mineOnly: boolean
  mineSkillCount: number
  mineSkillsLoading: boolean
  skillSearch: string
  onSkillSearchChange: (value: string) => void
  onRecentPageChange: (page: number, key: string | null) => void
  onSkillPageChange: (page: number) => void
  onMineOnlyChange: (mineOnly: boolean) => void
  onOpenTrace: (run: DashboardSkillEvalRun) => void
  selectedSkillKey: string | null
  onSelectedSkillKeyChange: (key: string | null) => void
}): React.JSX.Element {
  const skillByKey = useMemo(
    () =>
      new Map(
        (data?.skills ?? []).map((skill) => [
          skillEvalKey(skill.skillName, skill.skillVersion),
          skill
        ])
      ),
    [data]
  )

  const handleAllRunsClick = useCallback(() => {
    onSelectedSkillKeyChange(null)
    onRecentPageChange(1, null)
  }, [onRecentPageChange, onSelectedSkillKeyChange])

  const handleSkillSelect = useCallback(
    (key: string) => {
      onSelectedSkillKeyChange(key)
      onRecentPageChange(1, key)
    },
    [onRecentPageChange, onSelectedSkillKeyChange]
  )

  if ((loading || mineSkillsLoading) && !data) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {mineSkillsLoading ? "正在加载我的技能列表..." : "加载中..."}
      </div>
    )
  }
  if (!data)
    return <div className="py-8 text-center text-sm text-muted-foreground">暂无评估数据</div>

  const recentPage = Math.max(1, data.recentPage)
  const recentPageSize = Math.max(1, data.recentPageSize)
  const recentTotal = Math.max(0, data.recentTotal)
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / recentPageSize))
  const canGoPrevious = recentPage > 1
  const canGoNext = recentPage < recentTotalPages
  const skillPage = Math.max(1, data.skillPage)
  const skillPageSize = Math.max(1, data.skillPageSize)
  const totalSkills = Math.max(0, data.totalSkills)
  const skillTotalPages = Math.max(1, Math.ceil(totalSkills / skillPageSize))
  const canGoPreviousSkillPage = skillPage > 1
  const canGoNextSkillPage = skillPage < skillTotalPages
  const selectedSkill = selectedSkillKey ? (skillByKey.get(selectedSkillKey) ?? null) : null
  const filteredRuns = data.recent
  const selectedRunTotal = selectedSkill?.runs ?? data.totalRuns
  const selectedTotalTokens = selectedSkill
    ? selectedSkill.averageTotalTokens * selectedSkill.runs
    : data.totalTokens
  const selectedResultRecords = selectedSkill ? selectedSkill.runs : data.totalRuns
  const selectedTotalLabel = selectedSkill
    ? `${formatNumber(selectedRunTotal)} 条`
    : `${formatNumber(recentTotal)} 条`
  const selectedAverageToolCalls = selectedSkill?.averageToolCalls ?? data.averageToolCalls
  const selectedAverageModelCalls = selectedSkill?.averageModelCalls ?? data.averageModelCalls
  const selectedAverageTotalTokens = selectedSkill?.averageTotalTokens ?? data.averageTotalTokens
  const selectedAverageDurationMs = selectedSkill?.averageDurationMs ?? data.averageDurationMs
  const scopeLabel = mineOnly ? "我的技能" : "全部技能"
  const statSampleLabel =
    data.sampledTraceCount > 0
      ? `统计基于最新 ${formatNumber(data.sampledTraceCount)} 条样本${
          data.statTraceLimit > 0 && data.sampledTraceCount >= data.statTraceLimit
            ? `（上限 ${formatNumber(data.statTraceLimit)}）`
            : ""
        }`
      : loading
        ? "统计样本加载中"
        : "暂无统计样本"

  return (
    <div className="grid min-h-[720px] grid-cols-[minmax(420px,520px)_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <aside className="flex min-h-0 flex-col border-r border-border">
        <div className="grid grid-cols-2 gap-2 border-b border-border p-4">
          <div className="col-span-2 rounded-md border border-border bg-muted/25 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">当前统计口径</div>
            <div className="mt-0.5 truncate text-xs font-medium text-foreground">
              {selectedSkill
                ? `${skillEvalVersionLabel(selectedSkill.skillName, selectedSkill.skillVersion)} · ${scopeLabel} · 范围统计`
                : `${scopeLabel} · 范围统计`}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {statSampleLabel}
            </div>
          </div>
          <SkillEvalStatTile label="运行次数" value={selectedRunTotal} />
          <SkillEvalStatTile label="技能数" value={selectedSkill ? 1 : data.totalSkills} />
          <SkillEvalStatTile
            label="通过率"
            value={formatSkillEvalPercent(selectedSkill?.passRate ?? data.passRate)}
          />
          <SkillEvalStatTile
            label="平均分"
            value={formatSkillEvalScore(selectedSkill?.averageScore ?? data.averageScore)}
          />
          <SkillEvalStatTile
            label="过程分"
            value={formatSkillEvalScore(
              selectedSkill?.averageProcessScore ?? data.averageProcessScore ?? data.averageScore
            )}
          />
          <SkillEvalStatTile
            label="结束分"
            value={formatSkillEvalScore(
              selectedSkill?.averageOutcomeScore ?? data.averageOutcomeScore ?? data.averageScore
            )}
          />
          <SkillEvalStatTile
            label="结果分"
            value={formatSkillEvalScore(
              selectedSkill?.averageResultScore ?? data.averageResultScore
            )}
          />
          <SkillEvalStatTile label="结果记录" value={selectedResultRecords} />
          <SkillEvalStatTile label="总 Token" value={formatSkillEvalTokens(selectedTotalTokens)} />
          <SkillEvalStatTile
            label="平均峰值输入"
            value={formatSkillEvalTokens(
              selectedSkill?.averagePeakInputTokens ?? data.averagePeakInputTokens
            )}
          />
        </div>
        <div className="grid grid-cols-[4px_minmax(96px,1fr)_42px_50px_48px_48px_54px] gap-2 border-b border-border px-4 py-2 text-[11px] font-medium text-muted-foreground">
          <span />
          <span>技能</span>
          <span className="text-right">次数</span>
          <span className="text-right">通过率</span>
          <span className="text-right">结束</span>
          <span className="text-right">分数</span>
          <span className="text-right">Token</span>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="border-b border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onMineOnlyChange(false)}
                className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                  !mineOnly
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/35"
                }`}
              >
                全部技能
              </button>
              <button
                type="button"
                onClick={() => onMineOnlyChange(true)}
                className={`rounded-md border px-3 py-2 text-xs transition-colors ${
                  mineOnly
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted/35"
                }`}
              >
                我的技能
              </button>
            </div>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={skillSearch}
                onChange={(event) => onSkillSearchChange(event.target.value)}
                placeholder="搜索技能名"
                className="h-7 pl-8 pr-2 text-xs"
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                技能 {formatNumber(totalSkills)} 个 · 第 {formatNumber(skillPage)} /{" "}
                {formatNumber(skillTotalPages)} 页
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-1.5"
                  onClick={() => onSkillPageChange(skillPage - 1)}
                  disabled={!canGoPreviousSkillPage || loading || mineSkillsLoading}
                  aria-label="上一页技能"
                >
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-1.5"
                  onClick={() => onSkillPageChange(skillPage + 1)}
                  disabled={!canGoNextSkillPage || loading || mineSkillsLoading}
                  aria-label="下一页技能"
                >
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </div>
            {mineOnly ? (
              <div className="mt-2 truncate text-[11px] text-muted-foreground">
                {mineSkillsLoading
                  ? "正在加载我的技能列表..."
                  : mineSkillCount === 0
                    ? "您还没有上传过技能"
                    : `已按我上传的 ${formatNumber(mineSkillCount)} 个技能查询`}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleAllRunsClick}
            className={`w-full border-b border-border px-4 py-2 text-left text-xs transition-colors hover:bg-muted/35 ${
              selectedSkillKey === null
                ? "bg-primary/12 font-medium text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.22)]"
                : "text-muted-foreground"
            }`}
            aria-current={selectedSkillKey === null ? "true" : undefined}
          >
            全部运行
          </button>
          {data.skills.map((skill) => {
            const key = skillEvalKey(skill.skillName, skill.skillVersion)
            return (
              <SkillEvalSkillRow
                key={key}
                skill={skill}
                active={selectedSkillKey === key}
                skillKey={key}
                onSelect={handleSkillSelect}
              />
            )
          })}
        </ScrollArea>
      </aside>

      <main className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-sm font-medium text-foreground">
              {selectedSkill
                ? skillEvalVersionLabel(selectedSkill.skillName, selectedSkill.skillVersion)
                : "最近运行"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              共 {selectedTotalLabel} · 当前页 {formatNumber(filteredRuns.length)} 条 · 第{" "}
              {formatNumber(recentPage)} / {formatNumber(recentTotalPages)} 页
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              查询范围：{formatDateOnly(range.from)} ~ {formatDateOnly(range.to)}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-2 text-[11px] text-muted-foreground">
              <span>平均工具 {selectedAverageToolCalls.toFixed(1)}</span>
              <span>平均模型调用 {selectedAverageModelCalls.toFixed(1)}</span>
              <span>平均 Token {formatSkillEvalTokens(selectedAverageTotalTokens)}</span>
              <span>平均耗时 {formatDuration(selectedAverageDurationMs)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onRecentPageChange(recentPage - 1, selectedSkillKey)}
                disabled={!canGoPrevious || loading}
              >
                <ChevronLeft className="size-3.5" />
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onRecentPageChange(recentPage + 1, selectedSkillKey)}
                disabled={!canGoNext || loading}
              >
                下一页
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {loading || mineSkillsLoading ? (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {mineSkillsLoading ? "正在加载我的技能列表" : "加载中"}
            </div>
          ) : filteredRuns.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              暂无评估记录
            </div>
          ) : (
            filteredRuns.map((run) => (
              <SkillEvalRunRow
                key={`${run.traceId}:${run.rawSkillName}`}
                run={run}
                onOpenTrace={onOpenTrace}
              />
            ))
          )}
        </ScrollArea>
      </main>
    </div>
  )
})

export function DashboardView(): React.JSX.Element {
  const {
    granularity,
    range,
    selectedOrgLv1List,
    orgOptions,
    loading,
    userStatsLoading,
    skillEvalLoading,
    error,
    overview,
    modelStats,
    userStats,
    productivity,
    feedback,
    skillEval,
    projectMode,
    projectModeLoading,
    projectModeError,
    projectModeProjectPages,
    projectModeProjectPageLoading,
    projectModeProjectPageError,
    fetchProjectMode,
    fetchProjectModeProjectPage,
    changeGranularity,
    navigate,
    setCustomRange,
    refresh,
    fetchSkillEvalPage,
    clearSkillEval,
    setOrgFilter,
    drillDownUserOrg,
    resetUserOrgDrilldown
  } = useDashboard()

  const [exporting, setExporting] = useState(false)
  const [activeMainTab, setActiveMainTab] = useState<DashboardMainTab>("overview")
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [analysisAgentAllowed, setAnalysisAgentAllowed] = useState(false)
  // 「生成但未提交分析」下钻权限：管理员 + unrestricted 名单内（后者仅本室数据，由主进程过滤）。
  const [uncommittedAnalysisAllowed, setUncommittedAnalysisAllowed] = useState(false)
  // 「指标分析」入口默认隐藏：在标题栏右侧的隐藏热区连续点三下才显形（不完全移除功能）。
  const [analysisEntryRevealed, setAnalysisEntryRevealed] = useState(false)
  const analysisRevealClicksRef = useRef(0)
  const analysisRevealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleAnalysisRevealHotspotClick = useCallback(() => {
    if (analysisRevealTimerRef.current) clearTimeout(analysisRevealTimerRef.current)
    analysisRevealClicksRef.current += 1
    if (analysisRevealClicksRef.current >= 3) {
      analysisRevealClicksRef.current = 0
      setAnalysisEntryRevealed(true)
      return
    }
    // 连续点击窗口：超过 600ms 未继续点击则重置计数。
    analysisRevealTimerRef.current = setTimeout(() => {
      analysisRevealClicksRef.current = 0
    }, 600)
  }, [])
  const [projectModeAllowed, setProjectModeAllowed] = useState(false)
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<DashboardSkillDetail | null>(null)
  const [skillTracePage, setSkillTracePage] = useState(1)
  const [skillTracesLoading, setSkillTracesLoading] = useState(false)
  const [skillTracesError, setSkillTracesError] = useState<string | null>(null)
  const [skillTraceViewMode, setSkillTraceViewMode] = useState<DashboardTraceViewMode>("thread")
  const [skillTraceTriggerScope, setSkillTraceTriggerScope] =
    useState<DashboardTraceTriggerScope>("active")
  const [skillTraceExporting, setSkillTraceExporting] = useState(false)
  const [skillEvalTraceRun, setSkillEvalTraceRun] = useState<DashboardSkillEvalRun | null>(null)
  const [skillEvalSelectedSkillKey, setSkillEvalSelectedSkillKey] = useState<
    string | null | undefined
  >(undefined)
  const [projectTraceProject, setProjectTraceProject] =
    useState<DashboardProjectModeProject | null>(null)
  const [projectTraceFeature, setProjectTraceFeature] =
    useState<DashboardProjectModeFeature | null>(null)
  const [projectTraceData, setProjectTraceData] = useState<DashboardProjectModeTracesData | null>(
    null
  )
  const [projectTracePage, setProjectTracePage] = useState(1)
  const [projectTraceViewMode, setProjectTraceViewMode] = useState<DashboardTraceViewMode>("thread")
  const [projectTracesLoading, setProjectTracesLoading] = useState(false)
  const [projectTracesError, setProjectTracesError] = useState<string | null>(null)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitScopeLabel, setCommitScopeLabel] = useState("当前范围")
  const [commitDetailsRange, setCommitDetailsRange] = useState<TimeRange | null>(null)
  const [commitDetails, setCommitDetails] = useState<DashboardCommitDetailsData | null>(null)
  const [commitDetailsLoading, setCommitDetailsLoading] = useState(false)
  const [commitDetailsError, setCommitDetailsError] = useState<string | null>(null)
  const [commitDepartmentValue, setCommitDepartmentValue] = useState("")
  const [commitUserValue, setCommitUserValue] = useState("")
  // 「全部生成」漏斗首层下钻：生成但未提交分析弹窗。projectMode 区分平台概览 / 项目概览口径。
  const [uncommittedOpen, setUncommittedOpen] = useState(false)
  const [uncommittedProjectMode, setUncommittedProjectMode] = useState(false)
  // 仅 Skill 生成口径（对应「插件约束生成」漏斗下钻）。
  const [uncommittedUsedSkillsOnly, setUncommittedUsedSkillsOnly] = useState(false)

  useEffect(() => {
    let cancelled = false

    window.api.dashboard
      .isProjectModeAllowed()
      .then((allowed) => {
        if (cancelled) return
        setProjectModeAllowed(allowed)
        if (!allowed) {
          setActiveMainTab((current) => (current === "project-mode" ? "overview" : current))
        }
      })
      .catch(() => {
        if (cancelled) return
        setProjectModeAllowed(false)
        setActiveMainTab((current) => (current === "project-mode" ? "overview" : current))
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    window.api.dashboard
      .isAnalysisAgentAllowed()
      .then((allowed) => {
        if (cancelled) return
        setAnalysisAgentAllowed(allowed)
        if (!allowed) setAnalysisOpen(false)
      })
      .catch(() => {
        if (cancelled) return
        setAnalysisAgentAllowed(false)
        setAnalysisOpen(false)
      })

    window.api.dashboard
      .isUncommittedAnalysisAllowed()
      .then((allowed) => {
        if (cancelled) return
        setUncommittedAnalysisAllowed(allowed)
      })
      .catch(() => {
        if (cancelled) return
        setUncommittedAnalysisAllowed(false)
      })

    return () => {
      cancelled = true
    }
  }, [])
  const [commitDepartmentFilter, setCommitDepartmentFilter] = useState("")
  const [commitUserFilter, setCommitUserFilter] = useState("")
  // 项目模式·特性级关联 Commit 弹窗（复用 CommitDetailsDialog，独立于平台级 Commit 明细）。
  const [featureCommitScope, setFeatureCommitScope] = useState<{
    projectId: string
    featureSlug: string
    label: string
  } | null>(null)
  const [featureCommitData, setFeatureCommitData] = useState<DashboardCommitDetailsData | null>(
    null
  )
  const [featureCommitLoading, setFeatureCommitLoading] = useState(false)
  const [featureCommitError, setFeatureCommitError] = useState<string | null>(null)
  const [featureCommitDeptValue, setFeatureCommitDeptValue] = useState("")
  const [featureCommitDeptFilter, setFeatureCommitDeptFilter] = useState("")
  const [featureCommitUserValue, setFeatureCommitUserValue] = useState("")
  const [featureCommitUserFilter, setFeatureCommitUserFilter] = useState("")
  const [subPage, setSubPage] = useState<DashboardSubPage>({ kind: "main" })
  const [userList, setUserList] = useState<DashboardUserListData | null>(null)
  const [userListLoading, setUserListLoading] = useState(false)
  const [userListError, setUserListError] = useState<string | null>(null)
  const [userListSearchValue, setUserListSearchValue] = useState("")
  const [userListSearchKeyword, setUserListSearchKeyword] = useState("")
  const [userListDepartmentValue, setUserListDepartmentValue] = useState("")
  const [userListDepartmentFilter, setUserListDepartmentFilter] = useState("")
  const userListScopeRef = useRef("")
  const [userListAfterKey, setUserListAfterKey] = useState<
    Record<string, string | number> | undefined
  >()
  const [userListBackStack, setUserListBackStack] = useState<
    Array<Record<string, string | number> | undefined>
  >([])
  const [userDetail, setUserDetail] = useState<DashboardUserDetail | null>(null)
  const [userDetailLoading, setUserDetailLoading] = useState(false)
  const [userDetailError, setUserDetailError] = useState<string | null>(null)
  const [userDetailTracePage, setUserDetailTracePage] = useState(1)
  const [userDetailTraceViewMode, setUserDetailTraceViewMode] =
    useState<DashboardTraceViewMode>("thread")
  const [userDetailTraceTriggerScope, setUserDetailTraceTriggerScope] =
    useState<DashboardTraceTriggerScope>("active")
  const [marketSkillKeys, setMarketSkillKeys] = useState<Set<string>>(new Set())
  const [pluginSkillKeys, setPluginSkillKeys] = useState<Set<string>>(new Set())
  const [marketSkillMap, setMarketSkillMap] = useState<Map<string, MarketItem>>(new Map())
  const [skillUploaderProfiles, setSkillUploaderProfiles] = useState<
    Record<string, SkillUploaderProfile>
  >({})
  const [marketSkillsLoading, setMarketSkillsLoading] = useState(true)
  const [currentUserUploadCandidatesLoading, setCurrentUserUploadCandidatesLoading] = useState(true)
  const [currentUserUploadCandidates, setCurrentUserUploadCandidates] = useState<string[]>([])
  const [skillEvalMineOnly, setSkillEvalMineOnly] = useState(false)
  const [skillEvalSearch, setSkillEvalSearch] = useState("")
  const [debouncedSkillEvalSearch, setDebouncedSkillEvalSearch] = useState("")
  const currentUserUploadCandidateSet = useMemo(
    () => new Set(currentUserUploadCandidates),
    [currentUserUploadCandidates]
  )
  const myUploadedSkillEvalScope = useMemo(() => {
    const names = new Set<string>()
    let count = 0

    for (const item of marketSkillMap.values()) {
      if (!isUploadedByCurrentUser(item, currentUserUploadCandidateSet)) continue
      count += 1
      for (const name of getMarketSkillQueryNames(item)) {
        names.add(name)
      }
    }

    return {
      names: Array.from(names),
      count
    }
  }, [currentUserUploadCandidateSet, marketSkillMap])
  const myUploadedSkillNames = myUploadedSkillEvalScope.names
  const myUploadedSkillCount = myUploadedSkillEvalScope.count
  const myUploadedSkillNamesKey = useMemo(
    () => myUploadedSkillNames.join("\u0001"),
    [myUploadedSkillNames]
  )
  const skillEvalSearchQuery = debouncedSkillEvalSearch.trim()
  const skillEvalOrgScopeKey = selectedOrgLv1List.join("\u0001")
  const skillEvalScopeKey = skillEvalMineOnly
    ? `mine:${myUploadedSkillNamesKey}:${skillEvalSearchQuery}`
    : `all:${skillEvalSearchQuery}`
  const skillEvalScopeOptions = useMemo(
    () => ({
      ...(skillEvalSearchQuery ? { skillSearch: skillEvalSearchQuery } : {}),
      ...(skillEvalMineOnly ? { skillNames: myUploadedSkillNames } : {})
    }),
    [myUploadedSkillNames, skillEvalMineOnly, skillEvalSearchQuery]
  )
  const skillEvalSkillByKey = useMemo(
    () =>
      new Map(
        (skillEval?.skills ?? []).map((skill) => [
          skillEvalKey(skill.skillName, skill.skillVersion),
          skill
        ])
      ),
    [skillEval]
  )
  const latestSkillEvalKey = useMemo(() => getLatestSkillEvalKey(skillEval), [skillEval])
  const mineSkillsLoading =
    skillEvalMineOnly && (marketSkillsLoading || currentUserUploadCandidatesLoading)
  const effectiveSkillEvalSelectedSkillKey =
    skillEvalSelectedSkillKey === undefined ? latestSkillEvalKey : skillEvalSelectedSkillKey

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSkillEvalSearch(skillEvalSearch)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [skillEvalSearch])

  useEffect(() => {
    setSkillEvalSelectedSkillKey(undefined)
    clearSkillEval()
  }, [clearSkillEval, range.from, range.to, skillEvalScopeKey, skillEvalOrgScopeKey])

  useEffect(() => {
    if (skillEvalSelectedSkillKey === undefined || skillEvalSelectedSkillKey === null || !skillEval)
      return
    const selectedSkillStillExists = skillEvalSkillByKey.has(skillEvalSelectedSkillKey)
    if (!selectedSkillStillExists) {
      setSkillEvalSelectedSkillKey(undefined)
    }
  }, [skillEval, skillEvalSelectedSkillKey, skillEvalSkillByKey])

  useEffect(() => {
    if (activeMainTab !== "skill-eval" || skillEval || skillEvalLoading || mineSkillsLoading) return
    void fetchSkillEvalPage(1, {
      defaultRecentToLatestSkill: true,
      listFirst: true,
      deferPageStats: true,
      ...skillEvalScopeOptions
    })
  }, [
    activeMainTab,
    fetchSkillEvalPage,
    mineSkillsLoading,
    skillEval,
    skillEvalLoading,
    skillEvalScopeOptions
  ])

  // 项目模式 tab 懒加载：进入 tab 时拉取，时间范围 / 室筛选变化时重拉。
  useEffect(() => {
    if (activeMainTab !== "project-mode" || !projectModeAllowed) return
    void fetchProjectMode(range, granularity, selectedOrgLv1List)
  }, [activeMainTab, fetchProjectMode, granularity, projectModeAllowed, range, selectedOrgLv1List])

  useEffect(() => {
    if (
      activeMainTab !== "skill-eval" ||
      skillEvalSelectedSkillKey !== undefined ||
      !effectiveSkillEvalSelectedSkillKey ||
      !skillEval
    ) {
      return
    }
    setSkillEvalSelectedSkillKey(effectiveSkillEvalSelectedSkillKey)
  }, [activeMainTab, effectiveSkillEvalSelectedSkillKey, skillEval, skillEvalSelectedSkillKey])

  useEffect(() => {
    let cancelled = false

    async function loadUploaderProfiles(items: MarketItem[]): Promise<void> {
      const uploaderIds = Array.from(
        new Set(
          items
            .map((item) => {
              const parsed = parseUploaderIdentity(item.user_id)
              return parsed?.sapId || item.user_id?.trim() || ""
            })
            .filter(Boolean)
            .flatMap((id) => buildUploaderIdCandidates(id))
        )
      )

      if (uploaderIds.length === 0) {
        if (!cancelled) setSkillUploaderProfiles({})
        return
      }

      if (typeof window.api?.dashboard?.userProfiles !== "function") {
        if (!cancelled) {
          setSkillUploaderProfiles(
            Object.fromEntries(
              uploaderIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
            )
          )
        }
        return
      }

      try {
        const response = await window.api.dashboard.userProfiles(uploaderIds)
        if (!response.success || !response.data) {
          throw new Error(response.error || "获取上传用户信息失败")
        }

        const buckets =
          (
            response.data as {
              aggregations?: {
                by_sap?: {
                  buckets?: Array<{
                    key?: string
                    user_name?: { buckets?: Array<{ key?: string }> }
                    org_name?: { buckets?: Array<{ key?: string }> }
                    latest_user_info?: {
                      hits?: {
                        hits?: Array<{
                          _source?: {
                            userName?: string
                            orgName?: string
                            upperOrgLv0?: string
                            upperOrgLv1?: string
                          }
                        }>
                      }
                    }
                  }>
                }
              }
            }
          ).aggregations?.by_sap?.buckets ?? []

        const profileBySapId: Record<string, SkillUploaderProfile> = {}
        for (const bucket of buckets) {
          const sapId = bucket.key?.trim()
          if (!sapId) continue
          const latestUserInfo = bucket.latest_user_info?.hits?.hits?.[0]?._source
          profileBySapId[sapId] = {
            sapId,
            userName: latestUserInfo?.userName ?? bucket.user_name?.buckets?.[0]?.key ?? "",
            orgName: latestUserInfo?.orgName ?? bucket.org_name?.buckets?.[0]?.key ?? "",
            upperOrgLv0: latestUserInfo?.upperOrgLv0 ?? "",
            upperOrgLv1: latestUserInfo?.upperOrgLv1 ?? ""
          }
        }

        const profileEntries = Object.entries(profileBySapId)
        const nextMap: Record<string, SkillUploaderProfile> = {}
        for (const rawId of uploaderIds) {
          nextMap[rawId] = profileBySapId[rawId] ||
            profileEntries.find(([sapId]) => sapId.includes(rawId))?.[1] || {
              sapId: rawId,
              userName: "",
              orgName: ""
            }
        }

        if (!cancelled) setSkillUploaderProfiles(nextMap)
      } catch (error) {
        console.warn("[Dashboard] Failed to load marketplace skill uploader profiles:", error)
        if (!cancelled) {
          setSkillUploaderProfiles(
            Object.fromEntries(
              uploaderIds.map((sapId) => [sapId, { sapId, userName: "", orgName: "" }])
            )
          )
        }
      }
    }

    async function loadMarketSkills(): Promise<void> {
      if (!cancelled) setMarketSkillsLoading(true)
      try {
        const result = await marketApi.getSkills()
        if (cancelled) return
        if (result.success && result.data) {
          setMarketSkillKeys(buildMarketSkillKeySet(result.data))
          setMarketSkillMap(buildMarketSkillMap(result.data))
          void loadUploaderProfiles(result.data)
          return
        }
        console.warn("[Dashboard] Failed to load marketplace skills:", result.error)
      } catch (error) {
        if (!cancelled) {
          console.warn("[Dashboard] Failed to load marketplace skills:", error)
        }
      } finally {
        if (!cancelled) setMarketSkillsLoading(false)
      }
    }

    void loadMarketSkills()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadPluginSkills(): Promise<void> {
      if (typeof window.api?.skills?.listPlugins !== "function") return

      try {
        const pluginSkills = await window.api.skills.listPlugins()
        if (cancelled) return

        const keys = new Set<string>()
        const mockPluginSkills = import.meta.env.DEV
          ? [
              {
                name: "plugin-release-note",
                relativePath: "plugin-release-note",
                id: "mock-plugin/plugin-release-note"
              }
            ]
          : []
        for (const skill of [...pluginSkills, ...mockPluginSkills]) {
          const candidates = [skill.name, skill.relativePath, skill.id]
          for (const candidate of candidates) {
            const key = normalizeMarketSkillKey(candidate?.replace(/^plugin:[^/]+\//, ""))
            if (key) keys.add(key)
          }
        }
        setPluginSkillKeys(keys)
      } catch (error) {
        if (!cancelled) {
          console.warn("[Dashboard] Failed to load plugin skills:", error)
          setPluginSkillKeys(new Set())
        }
      }
    }

    void loadPluginSkills()

    return () => {
      cancelled = true
    }
  }, [])

  const loadSkillDetailPage = useCallback(
    async (
      skill: string,
      page: number,
      traceViewMode = skillTraceViewMode,
      triggerScope = skillTraceTriggerScope
    ) => {
      setSelectedSkill(skill)
      setSkillDialogOpen(true)
      setSkillTracePage(page)
      setSkillTraceViewMode(traceViewMode)
      setSkillTraceTriggerScope(triggerScope)
      if (page === 1) setSkillDetail(null)
      setSkillTracesError(null)
      setSkillTracesLoading(true)
      try {
        const result = await window.api.dashboard.skillDetail(skill, range, {
          page,
          pageSize: SKILL_TRACE_PAGE_SIZE,
          mode: traceViewMode,
          triggerScope
        })
        if (!result.success) throw new Error(result.error ?? "获取 Skill 详情失败")
        setSkillDetail(result.data ?? EMPTY_SKILL_DETAIL)
      } catch (e) {
        setSkillTracesError(e instanceof Error ? e.message : String(e))
      } finally {
        setSkillTracesLoading(false)
      }
    },
    [range, skillTraceViewMode, skillTraceTriggerScope]
  )

  const handleSkillClick = useCallback(
    async (skill: string) => {
      await loadSkillDetailPage(skill, 1)
    },
    [loadSkillDetailPage]
  )

  const handleSkillTracePageChange = useCallback(
    (page: number) => {
      if (!selectedSkill) return
      void loadSkillDetailPage(selectedSkill, page)
    },
    [loadSkillDetailPage, selectedSkill]
  )

  const handleSkillEvalTraceOpen = useCallback((run: DashboardSkillEvalRun) => {
    setSkillEvalTraceRun(run)
  }, [])

  const skillEvalTraceExplorerTraces = useMemo<DashboardSkillDetail["traces"]>(() => {
    if (!skillEvalTraceRun) return []
    const fallbackTrace = skillEvalTraceRun.traceDetail ?? {
      traceId: skillEvalTraceRun.traceId,
      threadId: skillEvalTraceRun.threadId,
      startedAt: skillEvalTraceRun.startedAt,
      endedAt: skillEvalTraceRun.endedAt,
      durationMs: skillEvalTraceRun.durationMs,
      userMessage: skillEvalTraceRun.userMessage,
      outcome: skillEvalTraceRun.outcome,
      totalToolCalls: skillEvalTraceRun.totalToolCalls,
      modelCallCount: skillEvalTraceRun.modelCallCount,
      totalInputTokens: skillEvalTraceRun.totalInputTokens,
      totalOutputTokens: skillEvalTraceRun.totalOutputTokens,
      totalTokens: skillEvalTraceRun.totalTokens,
      usedSkills: [skillEvalTraceRun.rawSkillName],
      evolvedSkills: [],
      rawAvailable: false,
      rawError: "该评估记录缺少完整 trace 详情"
    }
    const traceDetails = skillEvalTraceRun.traceDetails ?? []
    const hasCurrentTrace = traceDetails.some(
      (trace) => trace.traceId === skillEvalTraceRun.traceId
    )
    const traces = hasCurrentTrace ? traceDetails : [...traceDetails, fallbackTrace]
    return traces
      .filter(
        (trace, index, list) => list.findIndex((item) => item.traceId === trace.traceId) === index
      )
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
  }, [skillEvalTraceRun])

  const getSkillEvalFilterForKey = useCallback(
    (key: string | null) => {
      const filter = skillEvalFilterForKey(skillEvalSkillByKey, key) ?? {}
      return {
        ...filter,
        ...(skillEvalSearchQuery ? { skillSearch: skillEvalSearchQuery } : {}),
        ...(skillEvalMineOnly ? { skillNames: myUploadedSkillNames } : {})
      }
    },
    [myUploadedSkillNames, skillEvalMineOnly, skillEvalSearchQuery, skillEvalSkillByKey]
  )

  const handleSkillEvalPageChange = useCallback(
    (page: number, key: string | null) => {
      const filter = getSkillEvalFilterForKey(key)
      void fetchSkillEvalPage(page, {
        ...filter,
        skillPage: skillEval?.skillPage ?? 1,
        ...(filter.skillName ? { recentOnly: true } : {})
      })
    },
    [fetchSkillEvalPage, getSkillEvalFilterForKey, skillEval?.skillPage]
  )

  const handleSkillEvalSkillPageChange = useCallback(
    (page: number) => {
      setSkillEvalSelectedSkillKey(undefined)
      void fetchSkillEvalPage(1, {
        skillPage: page,
        defaultRecentToLatestSkill: true,
        listFirst: true,
        deferPageStats: true,
        ...(skillEvalSearchQuery ? { skillSearch: skillEvalSearchQuery } : {}),
        ...(skillEvalMineOnly ? { skillNames: myUploadedSkillNames } : {})
      })
    },
    [fetchSkillEvalPage, myUploadedSkillNames, skillEvalMineOnly, skillEvalSearchQuery]
  )

  const handleSkillEvalMineOnlyChange = useCallback((mineOnly: boolean) => {
    setSkillEvalMineOnly(mineOnly)
  }, [])

  const handleSkillEvalSearchChange = useCallback((value: string) => {
    setSkillEvalSearch(value)
  }, [])

  const handleRefresh = useCallback(() => {
    refresh()
    if (activeMainTab === "skill-eval") {
      setSkillEvalSelectedSkillKey(undefined)
      clearSkillEval()
    }
    if (activeMainTab === "project-mode") {
      void fetchProjectMode(range, granularity, selectedOrgLv1List)
    }
  }, [
    activeMainTab,
    clearSkillEval,
    fetchProjectMode,
    granularity,
    range,
    refresh,
    selectedOrgLv1List
  ])

  const handleProjectOpenTraces = useCallback(
    (project: DashboardProjectModeProject, feature?: DashboardProjectModeFeature) => {
      setProjectTraceProject(project)
      setProjectTraceFeature(feature ?? null)
      setProjectTraceData(null)
      setProjectTracesError(null)
      setProjectTracePage(1)
      setProjectTraceViewMode("thread")
    },
    []
  )

  useEffect(() => {
    if (!projectTraceProject) return
    let cancelled = false
    const currentProject = projectTraceProject
    const currentFeature = projectTraceFeature

    async function loadProjectTraces(): Promise<void> {
      setProjectTracesLoading(true)
      setProjectTracesError(null)
      try {
        const res = await window.api.dashboard.projectModeTraces(currentProject.projectId, range, {
          tracePage: projectTracePage,
          tracePageSize: PROJECT_TRACE_PAGE_SIZE,
          mode: projectTraceViewMode,
          triggerScope: PROJECT_TRACE_TRIGGER_SCOPE,
          ...(currentFeature?.slug ? { featureSlug: currentFeature.slug } : {})
        })
        if (!res.success) throw new Error(res.error ?? "获取项目对话失败")
        const rawData = res.data
        const data = Array.isArray(rawData)
          ? {
              traces: rawData as DashboardTraceDetail[],
              tracePage: projectTracePage,
              tracePageSize: PROJECT_TRACE_PAGE_SIZE,
              total: rawData.length,
              traceViewMode: projectTraceViewMode,
              traceTriggerScope: PROJECT_TRACE_TRIGGER_SCOPE
            }
          : (rawData ?? {
              traces: [],
              tracePage: projectTracePage,
              tracePageSize: PROJECT_TRACE_PAGE_SIZE,
              total: 0,
              traceViewMode: projectTraceViewMode,
              traceTriggerScope: PROJECT_TRACE_TRIGGER_SCOPE
            })
        if (!cancelled) setProjectTraceData(data)
      } catch (e) {
        if (!cancelled) setProjectTracesError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setProjectTracesLoading(false)
      }
    }

    void loadProjectTraces()
    return () => {
      cancelled = true
    }
  }, [projectTraceFeature, projectTracePage, projectTraceProject, projectTraceViewMode, range])

  useEffect(() => {
    let cancelled = false

    async function loadCurrentUserUploadCandidates(): Promise<void> {
      if (!cancelled) setCurrentUserUploadCandidatesLoading(true)
      try {
        if (typeof window.api?.models?.getUserInfo !== "function") {
          if (!cancelled) setCurrentUserUploadCandidates([])
          return
        }
        const userInfo = (await window.api.models.getUserInfo()) as UserInfoLite | null
        const normalizedIds = [userInfo?.sapId, userInfo?.ystId]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
        const candidates = Array.from(
          new Set(normalizedIds.flatMap((id) => buildUploaderIdCandidates(id)))
        )
        if (!cancelled) setCurrentUserUploadCandidates(candidates)
      } catch (error) {
        console.warn("[Dashboard] Failed to load current user upload candidates:", error)
        if (!cancelled) setCurrentUserUploadCandidates([])
      } finally {
        if (!cancelled) setCurrentUserUploadCandidatesLoading(false)
      }
    }

    void loadCurrentUserUploadCandidates()
    const unsubscribeLogin = window.electron?.ipcRenderer?.on?.("notify-login-msg", () => {
      void loadCurrentUserUploadCandidates()
    })

    return () => {
      cancelled = true
      unsubscribeLogin?.()
    }
  }, [])

  const handleSkillTracePrevious = useCallback(() => {
    if (!selectedSkill || skillTracePage <= 1) return
    void loadSkillDetailPage(selectedSkill, skillTracePage - 1)
  }, [loadSkillDetailPage, selectedSkill, skillTracePage])

  const handleSkillTraceNext = useCallback(() => {
    if (!selectedSkill || !skillDetail) return
    const pageSize = skillDetail.tracePageSize || SKILL_TRACE_PAGE_SIZE
    if (skillTracePage * pageSize >= skillDetail.totalTraces) return
    void loadSkillDetailPage(selectedSkill, skillTracePage + 1)
  }, [loadSkillDetailPage, selectedSkill, skillDetail, skillTracePage])

  const handleSkillTraceViewModeChange = useCallback(
    (mode: DashboardTraceViewMode) => {
      if (!selectedSkill) {
        setSkillTraceViewMode(mode)
        return
      }
      void loadSkillDetailPage(selectedSkill, 1, mode, skillTraceTriggerScope)
    },
    [loadSkillDetailPage, selectedSkill, skillTraceTriggerScope]
  )

  const handleSkillTraceTriggerScopeChange = useCallback(
    (scope: DashboardTraceTriggerScope) => {
      if (!selectedSkill) {
        setSkillTraceTriggerScope(scope)
        return
      }
      void loadSkillDetailPage(selectedSkill, 1, skillTraceViewMode, scope)
    },
    [loadSkillDetailPage, selectedSkill, skillTraceViewMode]
  )

  const handleSkillTraceExport = useCallback(async () => {
    if (!selectedSkill || !skillDetail || skillDetail.traces.length === 0) return
    setSkillTraceExporting(true)
    try {
      const result = await window.api.dashboard.exportSkillTraces({
        skill: selectedSkill,
        range,
        page: skillTracePage,
        pageSize: skillDetail.tracePageSize || SKILL_TRACE_PAGE_SIZE,
        totalTraces: skillDetail.totalTraces,
        traces: skillDetail.traces
      })
      if (!result.success && !result.canceled) {
        window.alert(result.error || "导出会话记录失败")
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "导出会话记录失败")
    } finally {
      setSkillTraceExporting(false)
    }
  }, [range, selectedSkill, skillDetail, skillTracePage])

  const loadUserList = useCallback(
    async (
      afterKey?: Record<string, string | number>,
      backStack: Array<Record<string, string | number> | undefined> = [],
      keyword = "",
      upperOrgLv1 = userListDepartmentFilter
    ) => {
      setUserListLoading(true)
      setUserListError(null)
      const normalizedKeyword = keyword.trim()
      const normalizedDepartment = upperOrgLv1.trim()
      try {
        const result = await window.api.dashboard.userList(range, {
          pageSize: USER_LIST_PAGE_SIZE,
          afterKey: afterKey ?? null,
          keyword: normalizedKeyword || null,
          upperOrgLv1: normalizedDepartment || null
        })
        if (!result.success) throw new Error(result.error ?? "获取用户列表失败")
        setUserList(
          result.data ?? { items: [], pageSize: USER_LIST_PAGE_SIZE, totalActiveUsers: 0 }
        )
        userListScopeRef.current = `${range.from}|${range.to}|${normalizedKeyword}|${normalizedDepartment}`
        setUserListAfterKey(afterKey)
        setUserListBackStack(backStack)
      } catch (e) {
        setUserListError(e instanceof Error ? e.message : String(e))
      } finally {
        setUserListLoading(false)
      }
    },
    [range, userListDepartmentFilter]
  )

  const loadUserDetail = useCallback(
    async (
      sapId: string,
      tracePage = 1,
      viewMode: DashboardTraceViewMode = "thread",
      triggerScope: DashboardTraceTriggerScope = "active",
      projectMode = false
    ) => {
      setUserDetailLoading(true)
      setUserDetailError(null)
      try {
        const result = await window.api.dashboard.userDetail(sapId, range, {
          tracePage,
          tracePageSize: USER_TRACE_PAGE_SIZE,
          mode: viewMode,
          triggerScope,
          projectMode
        })
        if (!result.success) throw new Error(result.error ?? "获取用户详情失败")
        setUserDetail(result.data ?? null)
      } catch (e) {
        setUserDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        setUserDetailLoading(false)
      }
    },
    [range]
  )

  const openUserList = useCallback(() => {
    // 带入顶部全局「室筛选」：自动回填到「部门查询」，用户可自行编辑/清空。
    const departmentPrefill = buildDepartmentPrefill(selectedOrgLv1List)
    setSubPage({ kind: "user-list" })
    setUserList(null)
    setUserListSearchValue("")
    setUserListSearchKeyword("")
    setUserListDepartmentValue(departmentPrefill)
    setUserListDepartmentFilter(departmentPrefill)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
  }, [selectedOrgLv1List])

  const openUserDetail = useCallback(
    (sapId: string, backTo?: "main" | "user-list", projectMode = false) => {
      const normalizedSapId = sapId.trim()
      if (!normalizedSapId) return
      const fallbackBackTo = subPage.kind === "user-list" ? "user-list" : "main"
      setSubPage({
        kind: "user-detail",
        sapId: normalizedSapId,
        backTo: backTo ?? fallbackBackTo,
        projectMode
      })
      setUserDetail(null)
      setUserDetailTracePage(1)
      setUserDetailTraceViewMode("thread")
      setUserDetailTraceTriggerScope("active")
    },
    [subPage.kind]
  )

  const handleUserListNext = useCallback(() => {
    if (!userList?.nextAfterKey) return
    void loadUserList(
      userList.nextAfterKey,
      [...userListBackStack, userListAfterKey],
      userListSearchKeyword,
      userListDepartmentFilter
    )
  }, [
    loadUserList,
    userList?.nextAfterKey,
    userListAfterKey,
    userListBackStack,
    userListSearchKeyword,
    userListDepartmentFilter
  ])

  const handleUserListPrevious = useCallback(() => {
    if (userListBackStack.length === 0) return
    const nextStack = userListBackStack.slice(0, -1)
    const previousAfterKey = userListBackStack[userListBackStack.length - 1]
    void loadUserList(previousAfterKey, nextStack, userListSearchKeyword, userListDepartmentFilter)
  }, [loadUserList, userListBackStack, userListSearchKeyword, userListDepartmentFilter])

  const handleUserListSearch = useCallback(() => {
    const keyword = userListSearchValue.trim()
    const upperOrgLv1 = userListDepartmentValue.trim()
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (keyword === userListSearchKeyword && upperOrgLv1 === userListDepartmentFilter) {
      void loadUserList(undefined, [], keyword, upperOrgLv1)
      return
    }
    setUserListSearchKeyword(keyword)
    setUserListDepartmentFilter(upperOrgLv1)
  }, [
    loadUserList,
    userListDepartmentFilter,
    userListDepartmentValue,
    userListSearchKeyword,
    userListSearchValue
  ])

  const handleUserListDepartmentClear = useCallback(() => {
    setUserListDepartmentValue("")
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (!userListDepartmentFilter) {
      void loadUserList(undefined, [], userListSearchKeyword, "")
      return
    }
    setUserListDepartmentFilter("")
  }, [loadUserList, userListDepartmentFilter, userListSearchKeyword])

  const handleUserListSearchClear = useCallback(() => {
    setUserListSearchValue("")
    setUserList(null)
    setUserListAfterKey(undefined)
    setUserListBackStack([])
    if (!userListSearchKeyword) {
      void loadUserList(undefined, [], "")
      return
    }
    setUserListSearchKeyword("")
  }, [loadUserList, userListSearchKeyword])

  const handleUserDetailBack = useCallback(() => {
    if (subPage.kind === "user-detail" && subPage.backTo === "user-list") {
      setSubPage({ kind: "user-list" })
      return
    }
    setSubPage({ kind: "main" })
  }, [subPage])

  const handleUserTracePrevious = useCallback(() => {
    setUserDetailTracePage((prev) => Math.max(1, prev - 1))
  }, [])

  const handleUserTraceNext = useCallback(() => {
    if (!userDetail) return
    setUserDetailTracePage((prev) => {
      const pageSize = userDetail.tracePageSize || USER_TRACE_PAGE_SIZE
      return prev * pageSize < userDetail.total ? prev + 1 : prev
    })
  }, [userDetail])

  const handleUserTraceViewModeChange = useCallback((mode: DashboardTraceViewMode) => {
    setUserDetailTraceViewMode(mode)
    setUserDetailTracePage(1)
  }, [])

  const handleUserTraceTriggerScopeChange = useCallback((scope: DashboardTraceTriggerScope) => {
    setUserDetailTraceTriggerScope(scope)
    setUserDetailTracePage(1)
  }, [])

  const handleProjectTracePrevious = useCallback(() => {
    setProjectTracePage((prev) => Math.max(1, prev - 1))
  }, [])

  const handleProjectTraceNext = useCallback(() => {
    if (!projectTraceData) return
    setProjectTracePage((prev) => {
      const pageSize = projectTraceData.tracePageSize || PROJECT_TRACE_PAGE_SIZE
      return prev * pageSize < projectTraceData.total ? prev + 1 : prev
    })
  }, [projectTraceData])

  const handleProjectTraceViewModeChange = useCallback((mode: DashboardTraceViewMode) => {
    setProjectTraceData(null)
    setProjectTraceViewMode(mode)
    setProjectTracePage(1)
  }, [])

  const loadProjectThreadTraces = useCallback(
    async (threadId: string): Promise<DashboardTraceDetail[]> => {
      const res = await window.api.dashboard.threadTraces(threadId, { scope: "project" })
      return res.success && Array.isArray(res.data) ? res.data : []
    },
    []
  )

  const subPageDetailSapId = subPage.kind === "user-detail" ? subPage.sapId : null
  const subPageDetailProjectMode =
    subPage.kind === "user-detail" ? Boolean(subPage.projectMode) : false

  useEffect(() => {
    if (subPage.kind === "user-list") {
      const currentScope = `${range.from}|${range.to}|${userListSearchKeyword}|${userListDepartmentFilter}`
      if (!userList || userListScopeRef.current !== currentScope) {
        void loadUserList(undefined, [], userListSearchKeyword, userListDepartmentFilter)
      }
    } else if (subPageDetailSapId) {
      void loadUserDetail(
        subPageDetailSapId,
        userDetailTracePage,
        userDetailTraceViewMode,
        userDetailTraceTriggerScope,
        subPageDetailProjectMode
      )
    }
  }, [
    range,
    subPage.kind,
    subPageDetailSapId,
    subPageDetailProjectMode,
    loadUserList,
    loadUserDetail,
    userList,
    userListSearchKeyword,
    userListDepartmentFilter,
    userDetailTracePage,
    userDetailTraceViewMode,
    userDetailTraceTriggerScope
  ])

  const loadCommitDetails = useCallback(
    async (
      targetRange: TimeRange,
      scopeLabel: string,
      page = 1,
      pushedOnly = false,
      upperOrgLv1 = commitDepartmentFilter,
      userKeyword = commitUserFilter
    ) => {
      setCommitScopeLabel(scopeLabel)
      setCommitDetailsRange(targetRange)
      setCommitDialogOpen(true)
      setCommitDetails(null)
      setCommitDetailsError(null)
      setCommitDetailsLoading(true)
      const normalizedDepartment = upperOrgLv1.trim()
      const normalizedUser = userKeyword.trim()
      try {
        const result = await window.api.dashboard.commitDetails(targetRange, {
          page,
          pageSize: 20,
          pushedOnly,
          upperOrgLv1: normalizedDepartment || null,
          userKeyword: normalizedUser || null,
          // 带入顶部全局「室筛选」
          orgLv1List: selectedOrgLv1List
        })
        if (!result.success) throw new Error(result.error ?? "获取 Commit 明细失败")
        setCommitDetails(result.data ?? { total: 0, page, pageSize: 20, pushedOnly, items: [] })
      } catch (e) {
        setCommitDetailsError(e instanceof Error ? e.message : String(e))
      } finally {
        setCommitDetailsLoading(false)
      }
    },
    [commitDepartmentFilter, commitUserFilter, selectedOrgLv1List]
  )

  const reloadCommitDetails = useCallback(
    (
      page: number,
      pushedOnly: boolean,
      upperOrgLv1 = commitDepartmentFilter,
      userKeyword = commitUserFilter
    ) => {
      if (!commitDetailsRange) return
      void loadCommitDetails(
        commitDetailsRange,
        commitScopeLabel,
        page,
        pushedOnly,
        upperOrgLv1,
        userKeyword
      )
    },
    [
      commitDepartmentFilter,
      commitDetailsRange,
      commitScopeLabel,
      commitUserFilter,
      loadCommitDetails
    ]
  )

  const handleCommitFilterSearch = useCallback(() => {
    const upperOrgLv1 = commitDepartmentValue.trim()
    const userKeyword = commitUserValue.trim()
    setCommitDepartmentFilter(upperOrgLv1)
    setCommitUserFilter(userKeyword)
    reloadCommitDetails(1, commitDetails?.pushedOnly ?? false, upperOrgLv1, userKeyword)
  }, [commitDepartmentValue, commitDetails?.pushedOnly, commitUserValue, reloadCommitDetails])

  const handleCommitDepartmentClear = useCallback(() => {
    setCommitDepartmentValue("")
    setCommitDepartmentFilter("")
    reloadCommitDetails(1, commitDetails?.pushedOnly ?? false, "", commitUserFilter)
  }, [commitDetails?.pushedOnly, commitUserFilter, reloadCommitDetails])

  const handleCommitUserClear = useCallback(() => {
    setCommitUserValue("")
    setCommitUserFilter("")
    reloadCommitDetails(1, commitDetails?.pushedOnly ?? false, commitDepartmentFilter, "")
  }, [commitDepartmentFilter, commitDetails?.pushedOnly, reloadCommitDetails])

  const handleCommitExternalOpen = useCallback((url: string) => {
    if (!url) return
    void window.electron.openExternal(url)
  }, [])

  const handleSkillEvalDocOpen = useCallback(() => {
    void window.electron.openExternal(SKILL_EVAL_DOC_URL)
  }, [])

  const handleCommitTotalClick = useCallback(() => {
    setCommitDepartmentValue("")
    setCommitDepartmentFilter("")
    setCommitUserValue("")
    setCommitUserFilter("")
    void loadCommitDetails(
      range,
      `当前范围 · ${formatRangeLabel(range.from, range.to, granularity)}`,
      1,
      false,
      "",
      ""
    )
  }, [loadCommitDetails, range, granularity])

  const handleCommitBucketClick = useCallback(
    (bucket: { from: string; to: string; label: string }) => {
      setCommitDepartmentValue("")
      setCommitDepartmentFilter("")
      setCommitUserValue("")
      setCommitUserFilter("")
      void loadCommitDetails(
        { from: bucket.from, to: bucket.to },
        `时间桶 · ${bucket.label}`,
        1,
        false,
        "",
        ""
      )
    },
    [loadCommitDetails]
  )

  const loadFeatureCommits = useCallback(
    async (
      scope: { projectId: string; featureSlug: string; label: string },
      page = 1,
      pushedOnly = false,
      upperOrgLv1 = featureCommitDeptFilter,
      userKeyword = featureCommitUserFilter
    ) => {
      setFeatureCommitData(null)
      setFeatureCommitError(null)
      setFeatureCommitLoading(true)
      const normalizedDepartment = upperOrgLv1.trim()
      const normalizedUser = userKeyword.trim()
      try {
        // featureSlug 为空 = 项目级（聚合该项目全部特性的 commit）；否则按单特性圈定。
        const commitOptions = {
          page,
          pageSize: 20,
          pushedOnly,
          upperOrgLv1: normalizedDepartment || null,
          userKeyword: normalizedUser || null,
          orgLv1List: selectedOrgLv1List
        }
        const result = scope.featureSlug
          ? await window.api.dashboard.projectModeFeatureCommits(
              scope.projectId,
              scope.featureSlug,
              range,
              commitOptions
            )
          : await window.api.dashboard.projectModeProjectCommits(
              scope.projectId,
              range,
              commitOptions
            )
        if (!result.success) throw new Error(result.error ?? "获取 Commit 明细失败")
        setFeatureCommitData(result.data ?? { total: 0, page, pageSize: 20, pushedOnly, items: [] })
      } catch (e) {
        setFeatureCommitError(e instanceof Error ? e.message : String(e))
      } finally {
        setFeatureCommitLoading(false)
      }
    },
    [featureCommitDeptFilter, featureCommitUserFilter, range, selectedOrgLv1List]
  )

  const handleProjectOpenFeatureCommits = useCallback(
    (project: DashboardProjectModeProject, feature: DashboardProjectModeFeature) => {
      if (!feature.slug) return
      const scope = {
        projectId: project.projectId,
        featureSlug: feature.slug,
        label: `${project.name} · ${feature.title}`
      }
      setFeatureCommitDeptValue("")
      setFeatureCommitDeptFilter("")
      setFeatureCommitUserValue("")
      setFeatureCommitUserFilter("")
      setFeatureCommitScope(scope)
      void loadFeatureCommits(scope, 1, false, "", "")
    },
    [loadFeatureCommits]
  )

  const handleProjectOpenProjectCommits = useCallback(
    (project: DashboardProjectModeProject, pushedOnly = false) => {
      const scope = {
        projectId: project.projectId,
        featureSlug: "",
        label: project.name
      }
      setFeatureCommitDeptValue("")
      setFeatureCommitDeptFilter("")
      setFeatureCommitUserValue("")
      setFeatureCommitUserFilter("")
      setFeatureCommitScope(scope)
      void loadFeatureCommits(scope, 1, pushedOnly, "", "")
    },
    [loadFeatureCommits]
  )

  const reloadFeatureCommits = useCallback(
    (
      page: number,
      pushedOnly: boolean,
      upperOrgLv1 = featureCommitDeptFilter,
      userKeyword = featureCommitUserFilter
    ) => {
      if (!featureCommitScope) return
      void loadFeatureCommits(featureCommitScope, page, pushedOnly, upperOrgLv1, userKeyword)
    },
    [featureCommitDeptFilter, featureCommitScope, featureCommitUserFilter, loadFeatureCommits]
  )

  const handleFeatureCommitFilterSearch = useCallback(() => {
    const upperOrgLv1 = featureCommitDeptValue.trim()
    const userKeyword = featureCommitUserValue.trim()
    setFeatureCommitDeptFilter(upperOrgLv1)
    setFeatureCommitUserFilter(userKeyword)
    reloadFeatureCommits(1, featureCommitData?.pushedOnly ?? false, upperOrgLv1, userKeyword)
  }, [
    featureCommitData?.pushedOnly,
    featureCommitDeptValue,
    featureCommitUserValue,
    reloadFeatureCommits
  ])

  const handleFeatureCommitDepartmentClear = useCallback(() => {
    setFeatureCommitDeptValue("")
    setFeatureCommitDeptFilter("")
    reloadFeatureCommits(1, featureCommitData?.pushedOnly ?? false, "", featureCommitUserFilter)
  }, [featureCommitData?.pushedOnly, featureCommitUserFilter, reloadFeatureCommits])

  const handleFeatureCommitUserClear = useCallback(() => {
    setFeatureCommitUserValue("")
    setFeatureCommitUserFilter("")
    reloadFeatureCommits(1, featureCommitData?.pushedOnly ?? false, featureCommitDeptFilter, "")
  }, [featureCommitData?.pushedOnly, featureCommitDeptFilter, reloadFeatureCommits])

  const handleExport = useCallback(async () => {
    if (!overview && !modelStats && !userStats && !productivity) return
    setExporting(true)
    try {
      const sheets: DashboardExcelSheet[] = []

      // 1. Overview summary
      if (overview) {
        sheets.push({
          name: "使用概览",
          header: ["指标", "值"],
          rows: [
            ["调用总次数", overview.totalCalls],
            ["活跃用户数", overview.activeUsers],
            ["平均耗时", formatDuration(overview.avgDurationMs)],
            ["输入 Token", overview.inputTokens],
            ["输出 Token", overview.outputTokens],
            ["代码生成行数", overview.codeGeneratedLines],
            ["代码已测量原始生成行数", overview.codeMeasuredGeneratedLines],
            ["代码已测量有效生成行数", overview.codeEffectiveGeneratedLines],
            ["代码未提交生成行数", overview.codeUnmeasuredGeneratedLines],
            ["代码含未提交分母行数", overview.codeInclusiveEffectiveGeneratedLines],
            ["代码删除行数", overview.codeDeletedLines],
            ["代码采纳行数", overview.codeAdoptedLines],
            [
              "总量提交采纳率（相对全部有效生成）",
              formatPercent(overview.codeInclusiveAdoptionRate)
            ],
            ["提交采纳率（已 Commit 采纳率）", formatPercent(overview.codeMeasuredAdoptionRate)],
            ["代码已 Push 原始生成行数", overview.codePushedMeasuredGeneratedLines],
            ["代码已 Push 有效生成行数", overview.codePushedEffectiveGeneratedLines],
            ["代码已 Push 采纳行数", overview.codePushedAdoptedLines],
            ["代码已 Push Commit 数", overview.codePushedCommitCount],
            ["入库采纳率（已 Push 采纳率）", formatPercent(overview.codePushedAdoptionRate)],
            [
              "总量入库采纳率（已 Push 真实入库率）",
              formatPercent(overview.codeInclusivePushedAdoptionRate)
            ],
            ["Skill 种类数", overview.totalSkills],
            ["Skill 调用次数", overview.totalSkillCalls],
            ["Tool 种类数", overview.totalTools],
            ["Tool 调用次数", overview.totalToolCalls]
          ]
        })

        // Trend
        if (overview.trend.length > 0) {
          sheets.push({
            name: "调用量趋势",
            header: ["时间", "调用次数", "活跃用户"],
            rows: overview.trend.map((t) => [t.time, t.count, t.users])
          })
        }

        // Skill ranking
        const exportSkills = overview.bySkillAll.length > 0 ? overview.bySkillAll : overview.bySkill
        if (exportSkills.length > 0) {
          sheets.push({
            name: "Skill使用排行",
            header: [
              "排名",
              "Skill",
              "调用次数",
              "应用市场是否存在",
              "Skill中文名称",
              "上传用户ID",
              "上传用户名称",
              "上传用户完整机构",
              "是否精品",
              "是否认证"
            ],
            rows: [
              ["Skill 种类数", overview.totalSkills, "", "", "", "", "", "", "", ""],
              ["Skill 调用次数", overview.totalSkillCalls, "", "", "", "", "", "", "", ""],
              ["", "", "", "", "", "", "", "", "", ""],
              ...exportSkills.map((s, i) => {
                const marketItem = getMarketSkillItem(marketSkillMap, s.skill)
                const uploaderInfo = resolveSkillUploaderExportInfo(
                  marketItem,
                  skillUploaderProfiles
                )
                const existsInMarket = Boolean(marketItem)
                return [
                  i + 1,
                  s.skill,
                  s.count,
                  existsInMarket ? "是" : "否",
                  existsInMarket ? marketItem?.chinese_name?.trim() || "" : "",
                  uploaderInfo.sapId,
                  uploaderInfo.userName,
                  uploaderInfo.orgName,
                  existsInMarket ? (marketItem?.featured === "精品" ? "是" : "否") : "",
                  existsInMarket ? (marketItem?.tag === "认证" ? "是" : "否") : ""
                ]
              })
            ]
          })
        }

        // Tool ranking (filtered)
        const exportFilteredTools =
          overview.byToolFilteredAll.length > 0 ? overview.byToolFilteredAll : overview.byTool
        if (exportFilteredTools.length > 0) {
          sheets.push({
            name: "Tool使用排行(已过滤)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...exportFilteredTools.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }

        // Tool ranking (all)
        const exportAllTools =
          overview.byToolAllFull.length > 0 ? overview.byToolAllFull : overview.byToolAll
        if (exportAllTools.length > 0) {
          sheets.push({
            name: "Tool使用排行(全部)",
            header: ["排名", "Tool", "调用次数"],
            rows: [
              ["Tool 种类数", overview.totalTools, ""],
              ["Tool 调用次数", overview.totalToolCalls, ""],
              ["", "", ""],
              ...exportAllTools.map((t, i) => [i + 1, t.tool, t.count])
            ]
          })
        }
      }

      // 2. Model stats
      if (modelStats) {
        if (modelStats.byModel.length > 0) {
          sheets.push({
            name: "模型使用统计",
            header: ["模型", "调用次数", "输入Token", "输出Token", "总Token"],
            rows: modelStats.byModel.map((m) => [
              m.model,
              m.count,
              m.inputTokens,
              m.outputTokens,
              m.inputTokens + m.outputTokens
            ])
          })
        }
        if (modelStats.byTier.length > 0) {
          sheets.push({
            name: "分流统计",
            header: ["Tier", "调用次数"],
            rows: modelStats.byTier.map((t) => [t.tier, t.count])
          })
        }
        if (modelStats.byLayer.length > 0) {
          sheets.push({
            name: "路由决策层",
            header: ["决策层", "命中次数"],
            rows: modelStats.byLayer.map((l) => [l.layer, l.count])
          })
        }
      }

      // 3. User stats
      if (userStats) {
        if (userStats.topUsers.length > 0) {
          sheets.push({
            name: "用户使用排行",
            header: ["排名", "SAP ID", "用户名", "部门", "调用次数"],
            rows: userStats.topUsers.map((u, i) => [
              i + 1,
              u.sapId,
              u.userName,
              u.orgName || "—",
              u.count
            ])
          })
        }
        if (userStats.byOrg.length > 0) {
          const drilledOrg = selectedOrgLv1List.length === 1 ? selectedOrgLv1List[0] : null
          sheets.push({
            name: drilledOrg ? `${drilledOrg}下级部门分布` : "一级部门分布",
            header: ["部门", "调用次数"],
            rows: userStats.byOrg.map((o) => [o.org, o.count])
          })
        }
        if (userStats.byVersion.length > 0) {
          sheets.push({
            name: "版本分布",
            header: ["版本", "调用次数"],
            rows: userStats.byVersion.map((v) => [v.version, v.count])
          })
        }
      }

      // 4. Productivity
      if (productivity) {
        sheets.push({
          name: "生产力概览",
          header: ["指标", "值"],
          rows: [
            ["Commit 总数", productivity.totalCommits],
            ["新增行数(Agent生成)", productivity.totalInsertions],
            ["删除行数(Agent生成)", productivity.totalDeletions],
            ["文件变更数", productivity.totalFilesChanged],
            ["活跃用户数", productivity.activeUsers],
            ["人均 Commit", Number(productivity.avgCommitsPerUser.toFixed(1))]
          ]
        })
        if (productivity.commitTrend.length > 0) {
          sheets.push({
            name: "Commit趋势",
            header: ["时间", "Commit数"],
            rows: productivity.commitTrend.map((c) => [c.time, c.count])
          })
        }
      }

      const activeUsers = await fetchAllActiveUsersForExport(range)
      sheets.push({
        name: "活跃用户列表",
        header: [
          "排名",
          "SAP ID",
          "YST ID",
          "用户名",
          "部门",
          "一级部门",
          "下级部门",
          "调用次数",
          "工具调用",
          "输入Token",
          "输出Token",
          "总Token",
          "平均耗时",
          "最近活跃"
        ],
        rows: activeUsers.map((user, index) => [
          index + 1,
          user.sapId,
          user.ystId || "",
          user.userName || "",
          user.upperOrgLv1 && user.upperOrgLv0
            ? `${user.upperOrgLv1}/${user.upperOrgLv0}`
            : user.orgName || "",
          user.upperOrgLv1 || "",
          user.upperOrgLv0 || "",
          user.count,
          user.totalToolCalls,
          user.totalInputTokens,
          user.totalOutputTokens,
          user.totalTokens,
          formatDuration(user.avgDurationMs),
          formatDateTime(user.lastActiveAt)
        ])
      })

      if (sheets.length === 0) return

      const result = await window.api.dashboard.exportExcel(sheets, {
        fileName: "平台运营概览数据"
      })
      if (result.success) {
        console.log("[Dashboard] Exported to:", result.filePath)
      } else if (!result.canceled && result.error) {
        console.error("[Dashboard] Export failed:", result.error)
      }
    } finally {
      setExporting(false)
    }
  }, [
    overview,
    modelStats,
    userStats,
    productivity,
    range,
    selectedOrgLv1List,
    marketSkillMap,
    skillUploaderProfiles
  ])

  const handleProjectModeExport = useCallback(async () => {
    if (!projectMode) return
    setExporting(true)
    try {
      const sheets: DashboardExcelSheet[] = []
      const summary = projectMode.summary
      const codeStats = summary.codeStats

      sheets.push({
        name: "项目运营概览",
        header: ["指标", "值"],
        rows: [
          ["项目总数", summary.projectCount],
          ["特性总数", summary.featureCount],
          ["活跃项目数", summary.activeProjectCount],
          ["项目对话数", summary.conversationCount],
          ["输入 Token", summary.totalInputTokens],
          ["输出 Token", summary.totalOutputTokens],
          ["总 Token", summary.totalTokens],
          ["Skill 种类数", summary.distinctSkillCount],
          ["Skill 调用次数", summary.skillCallCount],
          ["Tool 调用次数", summary.totalToolCalls],
          ...buildProjectModeCodeRows(codeStats)
        ]
      })

      const skillCodeStats = summary.skillCodeStats
      if (skillCodeStats) {
        sheets.push({
          name: "AutoBizDevOps约束生成",
          header: ["指标", "值"],
          rows: buildProjectModeCodeRows(skillCodeStats)
        })
      }

      if (projectMode.analytics.topUsers.length > 0) {
        sheets.push({
          name: "项目用户分析",
          header: ["排名", "SAP ID", "YST ID", "用户名", "部门", "项目对话数"],
          rows: projectMode.analytics.topUsers.map((user, index) => [
            index + 1,
            user.sapId,
            user.ystId || "",
            user.userName,
            user.orgName || "—",
            user.count
          ])
        })
      }

      if (projectMode.analytics.byOrg.length > 0) {
        sheets.push({
          name: "项目部门分布",
          header: ["部门", "项目数"],
          rows: flattenProjectModeOrgRows(projectMode.analytics.byOrg)
        })
      }

      if (projectMode.analytics.byAdapter.length > 0) {
        sheets.push({
          name: "项目插件占比",
          header: ["插件", "项目数"],
          rows: projectMode.analytics.byAdapter.map((adapter) => [adapter.name, adapter.count])
        })
      }

      if (projectMode.adapters.length > 0) {
        sheets.push({
          name: "项目插件统计",
          header: [
            "插件",
            "版本",
            "项目数",
            "特性数",
            "对话数",
            "提交采纳率",
            "入库采纳率",
            "总量提交采纳率",
            "总量入库采纳率"
          ],
          rows: projectMode.adapters.map((adapter) => [
            adapter.name,
            adapter.version || "",
            adapter.projectCount,
            adapter.featureCount,
            adapter.conversationCount,
            formatPercent(adapter.codeStats?.measuredAdoptionRate ?? null),
            formatPercent(adapter.codeStats?.pushedAdoptionRate ?? null),
            formatPercent(adapter.codeStats?.inclusiveAdoptionRate ?? null),
            formatPercent(adapter.codeStats?.inclusivePushedAdoptionRate ?? null)
          ])
        })
      }

      if (projectMode.topSkills.length > 0) {
        sheets.push({
          name: "项目Skill使用排行",
          header: [
            "排名",
            "Skill",
            "调用次数",
            "应用市场是否存在",
            "Skill中文名称",
            "上传用户ID",
            "上传用户名称",
            "上传用户完整机构",
            "是否精品",
            "是否认证"
          ],
          rows: projectMode.topSkills.map((skill, index) => {
            const marketItem = getMarketSkillItem(marketSkillMap, skill.skill)
            const uploaderInfo = resolveSkillUploaderExportInfo(marketItem, skillUploaderProfiles)
            const existsInMarket = Boolean(marketItem)
            return [
              index + 1,
              skill.skill,
              skill.count,
              existsInMarket ? "是" : "否",
              existsInMarket ? marketItem?.chinese_name?.trim() || "" : "",
              uploaderInfo.sapId,
              uploaderInfo.userName,
              uploaderInfo.orgName,
              existsInMarket ? (marketItem?.featured === "精品" ? "是" : "否") : "",
              existsInMarket ? (marketItem?.tag === "认证" ? "是" : "否") : ""
            ]
          })
        })
      }

      if (projectMode.bySkillAdoption.length > 0) {
        sheets.push({
          name: "项目Skill采纳排行",
          header: [
            "Skill",
            "提交采纳率",
            "入库采纳率",
            "总量提交采纳率",
            "总量入库采纳率",
            "生成行数",
            "有效生成行数",
            "采纳行数",
            "已Push有效生成行数",
            "已Push采纳行数",
            "已Push Commit数"
          ],
          rows: projectMode.bySkillAdoption.map((skill) => [
            skill.skill,
            formatPercent(skill.measuredAdoptionRate),
            formatPercent(skill.pushedAdoptionRate),
            formatPercent(skill.inclusiveAdoptionRate),
            formatPercent(skill.inclusivePushedAdoptionRate),
            skill.generatedLines,
            skill.effectiveGeneratedLines,
            skill.adoptedLines,
            skill.pushedEffectiveGeneratedLines,
            skill.pushedAdoptedLines,
            skill.pushedCommitCount
          ])
        })
      }

      const exportFilteredTools =
        projectMode.tools.byToolFilteredAll.length > 0
          ? projectMode.tools.byToolFilteredAll
          : projectMode.tools.byTool
      if (exportFilteredTools.length > 0) {
        sheets.push({
          name: "项目Tool使用排行(已过滤)",
          header: ["排名", "Tool", "调用次数"],
          rows: exportFilteredTools.map((tool, index) => [index + 1, tool.tool, tool.count])
        })
      }

      const exportAllTools =
        projectMode.tools.byToolAllFull.length > 0
          ? projectMode.tools.byToolAllFull
          : projectMode.tools.byToolAll
      if (exportAllTools.length > 0) {
        sheets.push({
          name: "项目Tool使用排行(全部)",
          header: ["排名", "Tool", "调用次数"],
          rows: exportAllTools.map((tool, index) => [index + 1, tool.tool, tool.count])
        })
      }

      if (sheets.length === 0) return

      const result = await window.api.dashboard.exportExcel(sheets, {
        fileName: "项目运营概览数据"
      })
      if (result.success) {
        console.log("[Dashboard] Project mode exported to:", result.filePath)
      } else if (!result.canceled && result.error) {
        console.error("[Dashboard] Project mode export failed:", result.error)
      }
    } finally {
      setExporting(false)
    }
  }, [projectMode, range, selectedOrgLv1List, marketSkillMap, skillUploaderProfiles])

  const projectTraces = projectTraceData?.traces ?? []
  const projectTracePageSize = projectTraceData?.tracePageSize ?? PROJECT_TRACE_PAGE_SIZE
  const projectTraceTotal = projectTraceData?.total ?? 0
  const canProjectTracePrevious = projectTracePage > 1 && !projectTracesLoading
  const canProjectTraceNext =
    Boolean(projectTraceData) &&
    projectTracePage * projectTracePageSize < projectTraceTotal &&
    !projectTracesLoading
  const projectTraceScopeLabel = projectTraceFeature ? "特性" : "项目"
  const projectTraceTitle =
    projectTraceViewMode === "thread"
      ? `${projectTraceScopeLabel}会话（第 ${projectTracePage} 页）`
      : `${projectTraceScopeLabel} Trace（第 ${projectTracePage} 页）`
  const projectTraceSubtitle =
    projectTraceViewMode === "thread"
      ? `共 ${formatNumber(projectTraceTotal)} 个会话，选择记录定位到对话`
      : `共 ${formatNumber(projectTraceTotal)} 条，选择记录定位到对话`
  const projectTraceDialogTitle = projectTraceFeature
    ? `特性对话 · ${projectTraceProject?.name ?? "-"} · ${projectTraceFeature.title}`
    : `项目对话 · ${projectTraceProject?.name ?? "-"}`
  const projectTraceDialogSubtitle = projectTraceFeature
    ? "该特性在项目模式下的对话记录，选择记录定位到会话"
    : "该项目模式下的对话记录，选择记录定位到会话"
  const analysisScope: DashboardAnalysisScope =
    activeMainTab === "project-mode" && projectModeAllowed ? "project" : "platform"
  const analysisPanelSnapshot = useMemo(
    () =>
      buildDashboardAnalysisPanelSnapshot({
        scope: analysisScope,
        overview,
        projectMode
      }),
    [analysisScope, overview, projectMode]
  )

  return (
    <div className="flex flex-col h-full">
      <TimeControlBar
        granularity={granularity}
        range={range}
        onGranularityChange={changeGranularity}
        onNavigate={navigate}
        onCustomRange={setCustomRange}
        onRefresh={handleRefresh}
        loading={loading}
        orgFilter={
          subPage.kind === "main" ? (
            <OrgFilterBar
              value={selectedOrgLv1List}
              options={orgOptions}
              loading={loading}
              onChange={setOrgFilter}
            />
          ) : null
        }
      />

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {subPage.kind === "main" && (
        <DashboardTabBar
          activeTab={activeMainTab}
          onChange={setActiveMainTab}
          projectModeAllowed={projectModeAllowed}
          rightContent={
            activeMainTab === "skill-eval" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-primary hover:text-primary"
                onClick={handleSkillEvalDocOpen}
              >
                <ExternalLink className="size-3.5" />
                了解技能评估与自进化
              </Button>
            ) : analysisAgentAllowed &&
              (activeMainTab === "overview" || activeMainTab === "project-mode") ? (
              analysisEntryRevealed ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={() => setAnalysisOpen(true)}
                  disabled={activeMainTab === "project-mode" && !projectModeAllowed}
                >
                  <Bot className="size-3.5" /> 指标分析
                </Button>
              ) : (
                // 隐藏入口：在「指标分析」按钮原位置放一个不可见热区，连续点三下才显形。
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  onClick={handleAnalysisRevealHotspotClick}
                  className="h-7 w-16 cursor-default opacity-0"
                />
              )
            ) : null
          }
        />
      )}

      {subPage.kind === "user-list" ? (
        <ScrollArea className="flex-1">
          <UserListPage
            data={userList}
            loading={userListLoading}
            error={userListError}
            canGoPrevious={userListBackStack.length > 0}
            canGoNext={Boolean(userList?.nextAfterKey)}
            onBack={() => setSubPage({ kind: "main" })}
            onRefresh={() =>
              loadUserList(
                userListAfterKey,
                userListBackStack,
                userListSearchKeyword,
                userListDepartmentFilter
              )
            }
            onPrevious={handleUserListPrevious}
            onNext={handleUserListNext}
            searchValue={userListSearchValue}
            searchKeyword={userListSearchKeyword}
            departmentValue={userListDepartmentValue}
            departmentFilter={userListDepartmentFilter}
            onSearchValueChange={setUserListSearchValue}
            onDepartmentValueChange={setUserListDepartmentValue}
            onSearch={handleUserListSearch}
            onClearSearch={handleUserListSearchClear}
            onClearDepartment={handleUserListDepartmentClear}
            onUserClick={(user) => openUserDetail(user.sapId, "user-list")}
          />
        </ScrollArea>
      ) : subPage.kind === "user-detail" ? (
        <ScrollArea className="flex-1">
          <UserDetailPage
            data={userDetail}
            loading={userDetailLoading}
            error={userDetailError}
            tracePage={userDetailTracePage}
            traceViewMode={userDetail?.traceViewMode ?? userDetailTraceViewMode}
            traceTriggerScope={userDetail?.traceTriggerScope ?? userDetailTraceTriggerScope}
            projectMode={subPage.kind === "user-detail" ? Boolean(subPage.projectMode) : false}
            onBack={handleUserDetailBack}
            onTracePrevious={handleUserTracePrevious}
            onTraceNext={handleUserTraceNext}
            onTraceViewModeChange={handleUserTraceViewModeChange}
            onTraceTriggerScopeChange={handleUserTraceTriggerScopeChange}
            loadThreadTraces={subPage.projectMode ? loadProjectThreadTraces : undefined}
          />
        </ScrollArea>
      ) : (
        <ScrollArea className="flex-1">
          {activeMainTab === "skill-eval" ? (
            <div className="space-y-6 p-6">
              <SkillEvalDashboardPanel
                data={skillEval}
                loading={skillEvalLoading}
                range={range}
                mineOnly={skillEvalMineOnly}
                mineSkillCount={myUploadedSkillCount}
                mineSkillsLoading={mineSkillsLoading}
                skillSearch={skillEvalSearch}
                onSkillSearchChange={handleSkillEvalSearchChange}
                onRecentPageChange={handleSkillEvalPageChange}
                onSkillPageChange={handleSkillEvalSkillPageChange}
                onMineOnlyChange={handleSkillEvalMineOnlyChange}
                onOpenTrace={handleSkillEvalTraceOpen}
                selectedSkillKey={effectiveSkillEvalSelectedSkillKey}
                onSelectedSkillKeyChange={setSkillEvalSelectedSkillKey}
              />
            </div>
          ) : activeMainTab === "project-mode" && projectModeAllowed ? (
            <div className="space-y-6 p-6">
              <ProjectModePanel
                data={projectMode}
                loading={projectModeLoading}
                error={projectModeError}
                headerAction={
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={handleProjectModeExport}
                    disabled={exporting || projectModeLoading || !projectMode}
                  >
                    {exporting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    导出Excel
                  </Button>
                }
                projectPages={projectModeProjectPages}
                projectPageLoading={projectModeProjectPageLoading}
                projectPageError={projectModeProjectPageError}
                onProjectPageChange={fetchProjectModeProjectPage}
                onOpenTraces={handleProjectOpenTraces}
                onOpenFeatureCommits={handleProjectOpenFeatureCommits}
                onOpenProjectCommits={handleProjectOpenProjectCommits}
                onSkillClick={handleSkillClick}
                onUserClick={(sapId) => openUserDetail(sapId, "main", true)}
                onFunnelFirstStageClick={
                  uncommittedAnalysisAllowed
                    ? () => {
                        setUncommittedProjectMode(true)
                        setUncommittedUsedSkillsOnly(false)
                        setUncommittedOpen(true)
                      }
                    : undefined
                }
                onSkillFunnelFirstStageClick={
                  uncommittedAnalysisAllowed
                    ? () => {
                        setUncommittedProjectMode(true)
                        setUncommittedUsedSkillsOnly(true)
                        setUncommittedOpen(true)
                      }
                    : undefined
                }
                marketSkillKeys={marketSkillKeys}
                pluginSkillKeys={pluginSkillKeys}
              />
            </div>
          ) : (
            <div className="space-y-6 p-6">
              {/* Overview */}
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-foreground">使用概览</h2>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={handleExport}
                    disabled={exporting || loading}
                  >
                    {exporting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    导出Excel
                  </Button>
                </div>
                <OverviewPanel
                  data={overview}
                  loading={loading}
                  onSkillClick={handleSkillClick}
                  onActiveUsersClick={openUserList}
                  onFunnelFirstStageClick={
                    uncommittedAnalysisAllowed
                      ? () => {
                          setUncommittedProjectMode(false)
                          setUncommittedUsedSkillsOnly(false)
                          setUncommittedOpen(true)
                        }
                      : undefined
                  }
                  marketSkillKeys={marketSkillKeys}
                  pluginSkillKeys={pluginSkillKeys}
                />
              </section>

              {/* Productivity */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">生产力指标</h2>
                <ProductivityPanel
                  data={productivity}
                  loading={loading}
                  onCommitTotalClick={handleCommitTotalClick}
                  onCommitBucketClick={handleCommitBucketClick}
                />
              </section>

              {/* User Analysis */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">用户分析</h2>
                <UserPanel
                  data={userStats}
                  loading={loading || userStatsLoading}
                  onDrillDownOrg={drillDownUserOrg}
                  onResetOrgDrilldown={resetUserOrgDrilldown}
                  onUserClick={(sapId) => openUserDetail(sapId, "main")}
                />
              </section>

              {/* Model Analysis */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">模型分析</h2>
                <ModelPanel data={modelStats} loading={loading} />
              </section>

              {/* Feedback */}
              <section>
                <h2 className="mb-3 text-sm font-semibold text-foreground">点赞 / 点踩反馈</h2>
                <FeedbackPanel data={feedback} loading={loading} />
              </section>
            </div>
          )}
        </ScrollArea>
      )}
      <TraceHistoryDialog
        open={skillDialogOpen}
        onOpenChange={(open) => {
          setSkillDialogOpen(open)
          if (!open) setSkillTracePage(1)
        }}
        skill={selectedSkill}
        traces={skillDetail?.traces ?? []}
        codeStats={skillDetail?.stats ?? null}
        tracePage={skillTracePage}
        tracePageSize={skillDetail?.tracePageSize ?? SKILL_TRACE_PAGE_SIZE}
        totalTraces={skillDetail?.totalTraces ?? skillDetail?.traces.length}
        traceViewMode={skillDetail?.traceViewMode ?? skillTraceViewMode}
        traceTriggerScope={skillDetail?.traceTriggerScope ?? skillTraceTriggerScope}
        onTraceViewModeChange={handleSkillTraceViewModeChange}
        onTraceTriggerScopeChange={handleSkillTraceTriggerScopeChange}
        onTracePrevious={handleSkillTracePrevious}
        onTraceNext={handleSkillTraceNext}
        onExportPage={handleSkillTraceExport}
        exporting={skillTraceExporting}
        loading={skillTracesLoading}
        error={skillTracesError}
        onPageChange={handleSkillTracePageChange}
      />
      <Dialog
        open={Boolean(skillEvalTraceRun)}
        onOpenChange={(open) => {
          if (!open) setSkillEvalTraceRun(null)
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="truncate text-base">
              技能评估详情 ·{" "}
              {skillEvalTraceRun
                ? skillEvalVersionLabel(skillEvalTraceRun.skillName, skillEvalTraceRun.skillVersion)
                : "-"}
            </DialogTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {skillEvalTraceRun
                ? [
                    formatRelativeTime(skillEvalTraceRun.startedAt),
                    ...(skillEvalTraceExplorerTraces.length > 1
                      ? [
                          skillEvalTraceExplorerTraces.length + " 轮",
                          "当前链路 " + skillEvalTraceRun.traceId
                        ]
                      : ["链路 " + skillEvalTraceRun.traceId])
                  ].join(" · ")
                : ""}
            </p>
          </DialogHeader>
          {skillEvalTraceRun && <SkillEvalRunSummary run={skillEvalTraceRun} />}
          <TraceExplorer
            traces={skillEvalTraceExplorerTraces}
            codeStats={null}
            title={skillEvalTraceExplorerTraces.length > 1 ? "多轮执行步骤详情" : "执行步骤详情"}
            emptyText="该评估记录没有可展示的 trace 步骤"
            showCodeStats={false}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(projectTraceProject)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectTraceProject(null)
            setProjectTraceFeature(null)
            setProjectTraceData(null)
            setProjectTracePage(1)
            setProjectTraceViewMode("thread")
            setProjectTracesLoading(false)
            setProjectTracesError(null)
          }
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-[1080px] grid-rows-none flex-col gap-0 p-0">
          <DialogHeader className="border-b border-border px-5 py-4">
            <DialogTitle className="truncate text-base">{projectTraceDialogTitle}</DialogTitle>
            <p className="mt-1 text-[11px] text-muted-foreground">{projectTraceDialogSubtitle}</p>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <TraceExplorer
              traces={projectTraces}
              loading={projectTracesLoading}
              error={projectTracesError}
              title={projectTraceTitle}
              subtitle={projectTraceSubtitle}
              viewMode={projectTraceViewMode}
              onViewModeChange={handleProjectTraceViewModeChange}
              loadThreadTraces={loadProjectThreadTraces}
              headerRight={
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleProjectTracePrevious}
                    disabled={!canProjectTracePrevious}
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={handleProjectTraceNext}
                    disabled={!canProjectTraceNext}
                  >
                    下一页
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              }
              emptyText={`该${projectTraceScopeLabel}在当前时间范围内没有对话`}
              showCodeStats={false}
              className="h-full"
            />
          </div>
        </DialogContent>
      </Dialog>
      <UncommittedCodeDialog
        open={uncommittedOpen}
        onOpenChange={setUncommittedOpen}
        range={range}
        scope={{
          upperOrgLv1: selectedOrgLv1List,
          projectMode: uncommittedProjectMode,
          usedSkillsOnly: uncommittedUsedSkillsOnly
        }}
      />
      <CommitDetailsDialog
        open={commitDialogOpen}
        onOpenChange={setCommitDialogOpen}
        scopeLabel={commitScopeLabel}
        data={commitDetails}
        loading={commitDetailsLoading}
        error={commitDetailsError}
        onPageChange={(page) => reloadCommitDetails(page, commitDetails?.pushedOnly ?? false)}
        onPushedOnlyChange={(pushedOnly) => reloadCommitDetails(1, pushedOnly)}
        departmentValue={commitDepartmentValue}
        userValue={commitUserValue}
        onDepartmentValueChange={setCommitDepartmentValue}
        onUserValueChange={setCommitUserValue}
        onSearch={handleCommitFilterSearch}
        onClearDepartment={handleCommitDepartmentClear}
        onClearUser={handleCommitUserClear}
        onOpenExternal={handleCommitExternalOpen}
      />
      <CommitDetailsDialog
        open={Boolean(featureCommitScope)}
        onOpenChange={(open) => {
          if (!open) setFeatureCommitScope(null)
        }}
        scopeLabel={featureCommitScope?.label ?? ""}
        threadScope="project"
        data={featureCommitData}
        loading={featureCommitLoading}
        error={featureCommitError}
        onPageChange={(page) => reloadFeatureCommits(page, featureCommitData?.pushedOnly ?? false)}
        onPushedOnlyChange={(pushedOnly) => reloadFeatureCommits(1, pushedOnly)}
        departmentValue={featureCommitDeptValue}
        userValue={featureCommitUserValue}
        onDepartmentValueChange={setFeatureCommitDeptValue}
        onUserValueChange={setFeatureCommitUserValue}
        onSearch={handleFeatureCommitFilterSearch}
        onClearDepartment={handleFeatureCommitDepartmentClear}
        onClearUser={handleFeatureCommitUserClear}
        onOpenExternal={handleCommitExternalOpen}
      />
      <DashboardAnalysisDrawer
        open={analysisAgentAllowed && analysisOpen}
        scope={analysisScope}
        range={range}
        upperOrgLv1={selectedOrgLv1List}
        panelSnapshot={analysisPanelSnapshot}
        onClose={() => setAnalysisOpen(false)}
      />
    </div>
  )
}
