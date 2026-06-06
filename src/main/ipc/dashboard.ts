/**
 * Dashboard IPC Handlers
 *
 * Proxies Elasticsearch queries for the operations dashboard.
 * The renderer never connects to ES directly — all queries go through
 * these IPC handlers for security.
 */

import { ipcMain, dialog, BrowserWindow } from "electron"
import { getUserInfo } from "../storage"
import * as fs from "fs"
import AdmZip from "adm-zip"
import { buildTraceTree } from "../agent/trace/tree-builder"
import type {
  AgentTrace,
  TraceNode,
  TraceSkillEvalRecord,
  TraceTriggerSource
} from "../agent/trace/types"
import { buildSkillEvalTraceExtension } from "../agent/skill-eval/documents"
import {
  getSkillIdentifierLookupTerms,
  normalizeSkillQueryName,
  parseSkillNameVersionIdentifier
} from "../utils/skill-identifiers"
import {
  effectiveGeneratedLinesSumAgg,
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs,
  normalizeCodeStatsFromContainer,
  normalizeSkillCodeAdoptionBuckets,
  type DashboardCodeStats,
  type DashboardSkillCodeAdoptionStats
} from "./dashboard-code-stats"

// ─────────────────────────────────────────────────────────
// ES Configuration (from .env)
// ─────────────────────────────────────────────────────────

function getEsNodes(): string[] {
  const raw = import.meta.env.VITE_ES_NODES as string | undefined
  if (!raw) return []
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
}

function getEsAuth(): { username: string; password: string } | null {
  const username = import.meta.env.VITE_ES_USERNAME as string | undefined
  const password = import.meta.env.VITE_ES_PASSWORD as string | undefined
  if (!username || !password) return null
  return { username, password }
}

function getEsIndex(type: "trace" | "event" | "skillEval"): string {
  if (type === "trace") return (import.meta.env.VITE_ES_INDEX_TRACE as string) || "devclaw_trace"
  if (type === "skillEval") {
    return (import.meta.env.VITE_ES_INDEX_SKILL_EVAL as string) || "devclaw_skill_eval_record"
  }
  return (import.meta.env.VITE_ES_INDEX_EVENT as string) || "devclaw_event"
}

// ─────────────────────────────────────────────────────────
// ES HTTP helper
// ─────────────────────────────────────────────────────────

let nodeIndex = 0

function getErrorDetail(error: Error): string {
  const cause = error.cause
  if (!cause || typeof cause !== "object") return error.message

  const causeRecord = cause as Record<string, unknown>
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : ""
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : ""
  const causeDetail = [causeCode, causeMessage].filter(Boolean).join(" ")

  return causeDetail ? `${error.message}: ${causeDetail}` : error.message
}

function makeEsUnavailableError(nodes: string[], lastError: Error | null): Error {
  const detail = lastError ? getErrorDetail(lastError) : "unknown error"
  console.warn(`[Dashboard] All ${nodes.length} ES nodes failed. Last error:`, detail)
  return new Error("请检查网络连接后重试")
}

async function esQuery(
  index: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<unknown> {
  const nodes = getEsNodes()
  if (nodes.length === 0) throw new Error("ES_NODES not configured")

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  // Round-robin with fallback
  const startIdx = nodeIndex
  let lastError: Error | null = null

  for (let i = 0; i < nodes.length; i++) {
    const idx = (startIdx + i) % nodes.length
    const url = `${nodes[idx]}/${index}/_search`
    nodeIndex = (idx + 1) % nodes.length

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => "")
        throw new Error(`ES ${resp.status}: ${text.slice(0, 200)}`)
      }
      return await resp.json()
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      console.warn(`[Dashboard] ES node ${nodes[idx]} failed:`, getErrorDetail(lastError))
    }
  }

  throw makeEsUnavailableError(nodes, lastError)
}

// ─────────────────────────────────────────────────────────
// Query builders
// ─────────────────────────────────────────────────────────

interface TimeRange {
  from: string // ISO string
  to: string // ISO string
}

type Granularity = "day" | "week" | "month" | "custom"

interface DashboardAllUserItem {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

interface DashboardTraceDetail {
  traceId: string
  threadId: string
  startedAt: string
  endedAt?: string
  durationMs: number
  userMessage: string
  sapId?: string
  ystId?: string
  userName?: string
  orgName?: string
  userIp?: string
  modelId?: string
  modelName?: string
  outcome: string
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  usedSkills: string[]
  evolvedSkills: string[]
  triggerSource?: string
  nodes?: TraceNode[]
  rawAvailable: boolean
  rawError?: string
}

interface DashboardCommitDetail {
  eventId: string
  eventTime: string
  userName: string
  sapId?: string
  ystId?: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  userIp?: string
  repoPath?: string
  repositoryName?: string
  repositoryFullName?: string
  repositoryWebUrl?: string
  commitSha?: string
  commitUrl?: string
  pushed: boolean
  pushedAt?: string
  branch?: string
  filesChanged: number
  insertions: number
  deletions: number
  triggeredBy?: string
  threadId?: string
  usedSkills: string[]
  skillCount: number
  codeGeneratedLines: number
  codeEffectiveGeneratedLines: number
  codeAdoptedLines: number
  codeAdoptionRate: number | null
}

interface CommitAdoptionSummary {
  usedSkills: string[]
  generatedLines: number
  effectiveGeneratedLines: number
  adoptedLines: number
  adoptionRate: number | null
}

interface DashboardSkillDetail {
  stats: DashboardCodeStats
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  totalTraces: number
  traceViewMode?: TraceViewMode
  traceTriggerScope?: TraceTriggerScope
}

interface DashboardSkillEvalRun {
  traceId: string
  threadId: string
  startedAt: string
  endedAt: string
  userMessage: string
  skillName: string
  skillVersion?: string
  rawSkillName: string
  skillTaskId?: string
  skillTaskTraceIndex?: number
  evalSource?: "explicit" | "inherited_context"
  contextTraceIds: string[]
  skillEvalTraceIds: string[]
  contextTraceCount: number
  skillEvalTraceCount: number
  outcome: string
  processScore: number
  outcomeScore: number
  score: number
  outcomePass: boolean
  pass: boolean
  resultScore?: number
  resultPass: boolean
  totalToolCalls: number
  modelCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  promptInputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  peakInputTokens: number
  errorCount: number
  durationMs: number
  checks: Array<{
    name: string
    label: string
    ok: boolean
    weight: number
    detail?: Record<string, unknown>
  }>
  outcomeChecks: Array<{
    name: string
    label: string
    ok: boolean
    weight: number
    detail?: Record<string, unknown>
  }>
  resultChecks: Array<{
    name: string
    label: string
    ok: boolean
    weight: number
    detail?: Record<string, unknown>
  }>
  warnings: string[]
  outcomeWarnings: string[]
  resultWarnings: string[]
  resultIssues: string[]
  resultArtifacts: Array<{
    type: string
    label: string
    path?: string
    url?: string
    detail?: Record<string, unknown>
  }>
  resultGenerated: boolean
  traceDetail: DashboardTraceDetail
  traceDetails: DashboardTraceDetail[]
  evidence: {
    finalResponseLength: number
    changedFiles: number
    validationCommands: number
    artifactSignals: number
    dangerousCommands: number
    subagentRuns: number
    subagentCompleted: number
    subagentResultLength: number
    subagentFailed: number
    toolResultErrors: number
  }
}

interface DashboardSkillEvalSkillSummary {
  skillName: string
  skillVersion?: string
  runs: number
  resultEvaluatedRuns: number
  passRate: number
  resultPassRate: number
  averageScore: number
  averageProcessScore: number
  averageOutcomeScore: number
  averageResultScore: number
  averageToolCalls: number
  averageModelCalls: number
  averageInputTokens: number
  averageOutputTokens: number
  averagePromptInputTokens: number
  averageTotalTokens: number
  averagePeakInputTokens: number
  averageDurationMs: number
  validationRate: number
  outputSignalRate: number
  dangerRate: number
  failureCount: number
  lastRunAt: string
}

interface DashboardSkillEvalSummary {
  generatedAt: string
  totalTraceHits: number
  evaluatedTraceCount: number
  sampledTraceCount: number
  statTraceLimit: number
  recentTotal: number
  recentPage: number
  recentPageSize: number
  skillPage: number
  skillPageSize: number
  totalRuns: number
  resultEvaluatedRuns: number
  totalSkills: number
  passRate: number
  resultPassRate: number
  averageScore: number
  averageProcessScore: number
  averageOutcomeScore: number
  averageResultScore: number
  averageToolCalls: number
  averageModelCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalPromptInputTokens: number
  totalTokens: number
  averageInputTokens: number
  averageOutputTokens: number
  averagePromptInputTokens: number
  averageTotalTokens: number
  averagePeakInputTokens: number
  averageDurationMs: number
  skills: DashboardSkillEvalSkillSummary[]
  recent: DashboardSkillEvalRun[]
}

interface DashboardUserListItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  count: number
  lastActiveAt?: string
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
}

interface DashboardUserListData {
  items: DashboardUserListItem[]
  pageSize: number
  nextAfterKey?: Record<string, string | number>
  totalActiveUsers: number
}

interface DashboardUserDetail {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  totalCalls: number
  avgDurationMs: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  bySkill: Array<{ skill: string; count: number }>
  byModel: Array<{ model: string; count: number }>
  byOutcome: Array<{ outcome: string; count: number }>
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  /** 当前视图模式下的翻页总数：thread → 会话数；trace → trace 总数。 */
  total: number
  traceViewMode?: TraceViewMode
  traceTriggerScope?: TraceTriggerScope
}

interface EsSearchHit {
  _id?: string
  _source?: Record<string, unknown>
  sort?: Array<string | number>
}

interface EsAggregation {
  value?: number
  buckets?: unknown
  [key: string]: unknown
}

interface EsSearchResponse {
  hits?: {
    total?: number | { value?: number }
    hits?: EsSearchHit[]
  }
  aggregations?: Record<string, EsAggregation | undefined>
}

interface OrgFilterOptions {
  // 用户主动选择的 LV1 组织维度筛选（非权限过滤）。支持多选；空/未传表示全部。
  upperOrgLv1?: string | string[] | null
}

type UserStatsOptions = OrgFilterOptions

interface UserListOptions {
  pageSize?: number
  afterKey?: Record<string, string | number> | null
  keyword?: string | null
  upperOrgLv1?: string | null
}

interface UserDetailOptions {
  traceLimit?: number
  tracePage?: number
  tracePageSize?: number
  mode?: TraceViewMode
  viewMode?: TraceViewMode
  triggerScope?: TraceTriggerScope
}

type TraceViewMode = "thread" | "trace"
type TraceTriggerScope = "active" | "all"

interface TracePageOptions {
  page?: number
  pageSize?: number
  limit?: number
  mode?: TraceViewMode
  viewMode?: TraceViewMode
  triggerScope?: TraceTriggerScope
}

interface DashboardTraceExportPayload {
  skill: string
  range: TimeRange
  page: number
  pageSize: number
  totalTraces: number
  traces: DashboardTraceDetail[]
}

interface CommitDetailsOptions {
  page?: number
  pageSize?: number
  pushedOnly?: boolean
  upperOrgLv1?: string | null
  // 全局「室筛选」（多选 LV1，含「未归类」哨兵），与弹窗内部门搜索 AND 叠加。
  orgLv1List?: string[]
}

interface DashboardAccessContext {
  loggedIn: boolean
  unrestricted: boolean
  sapId: string
  ystId: string
  upperOrgLv1: string
}

interface DashboardSkillEvalOptions {
  limit?: number
  recentPage?: number
  recentPageSize?: number
  skillPage?: number
  skillPageSize?: number
  skillSearch?: string
  skillName?: string
  skillVersion?: string
  skillNames?: string[]
  defaultRecentToLatestSkill?: boolean
  recentOnly?: boolean
  listOnly?: boolean
  statsOnly?: boolean
}

const DISLIKE_TYPE_OPTIONS = [
  { id: "slow", label: "太慢了" },
  { id: "not_helpful", label: "内容不相关" },
  { id: "inaccurate", label: "信息不准确" },
  { id: "unclear", label: "表述不清楚" },
  { id: "unsafe", label: "包含不安全内容" },
  { id: "other", label: "其他原因" }
] as const

const DASHBOARD_ALLOWED_IDS_ENV = "VITE_DASHBOARD_ALLOWED_YST_IDS"
const DASHBOARD_UNRESTRICTED_IDS_ENV = "VITE_DASHBOARD_UNRESTRICTED_YST_IDS"

function splitEnvIds(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(/[,\n;\s]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  )
}

function deriveDashboardUpperOrgLv1(pathName?: string): string {
  const parts =
    typeof pathName === "string"
      ? pathName
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean)
      : []
  const itDeptIndex = parts.findIndex((part) => part.includes("信息技术部"))
  if (itDeptIndex < 0) return ""

  const lowerParts = parts.slice(itDeptIndex + 1)
  const startsWithTeam = lowerParts[0]?.includes("团队") ?? false
  return startsWithTeam ? (lowerParts[1] ?? "") : (lowerParts[2] ?? "")
}

function getDashboardUnrestrictedIds(): Set<string> {
  return splitEnvIds(import.meta.env[DASHBOARD_UNRESTRICTED_IDS_ENV] as string | undefined)
}

function getDashboardAllowedIds(): Set<string> {
  return splitEnvIds(import.meta.env[DASHBOARD_ALLOWED_IDS_ENV] as string | undefined)
}

function getDashboardAccessContext(): DashboardAccessContext {
  if (import.meta.env.DEV) {
    return {
      loggedIn: true,
      unrestricted: true,
      sapId: "dev",
      ystId: "dev",
      upperOrgLv1: ""
    }
  }

  const userInfo = getUserInfo()
  const sapId = userInfo?.sapId?.trim() ?? ""
  const ystId = userInfo?.ystId?.trim() ?? ""
  const loggedIn = Boolean(sapId || ystId)
  const unrestrictedIds = getDashboardUnrestrictedIds()

  return {
    loggedIn,
    unrestricted: loggedIn && [ystId, sapId].some((id) => Boolean(id && unrestrictedIds.has(id))),
    sapId,
    ystId,
    upperOrgLv1: deriveDashboardUpperOrgLv1(userInfo?.pathName)
  }
}

function requireDashboardAccess(): DashboardAccessContext {
  const access = getDashboardAccessContext()
  if (!access.loggedIn) throw new Error("请先登录后再查看运营面板")
  return access
}

function isDashboardProjectModeAllowed(): boolean {
  if (import.meta.env.DEV) return true
  const access = getDashboardAccessContext()
  if (!access.loggedIn || !access.ystId) return false
  return getDashboardAllowedIds().has(access.ystId)
}

function requireDashboardProjectModeAccess(): void {
  const access = getDashboardAccessContext()
  if (!access.loggedIn) throw new Error("请先登录后再查看项目运营面板")
  if (!access.ystId || !getDashboardAllowedIds().has(access.ystId)) {
    throw new Error("无项目运营面板访问权限")
  }
}

function buildNoAccessFilter(): Record<string, unknown> {
  return { term: { traceId: "__dashboard_no_access__" } }
}

function buildTraceAccessFilter(access: DashboardAccessContext): Record<string, unknown> | null {
  if (access.unrestricted) return null
  if (!access.upperOrgLv1) return buildNoAccessFilter()
  return buildUpperOrgLv1Filter(access.upperOrgLv1)
}

function appendOptionalFilter(
  filters: Record<string, unknown>[],
  filter: Record<string, unknown> | null
): void {
  if (filter) filters.push(filter)
}

function getCalendarInterval(granularity: Granularity, from: string, to: string): string {
  if (granularity === "day") return "hour"
  if (granularity === "custom") {
    const diffMs = new Date(to).getTime() - new Date(from).getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    if (diffDays <= 1) return "hour"
    if (diffDays <= 14) return "day"
    return "week"
  }
  return "day" // week or month → bucket by day
}

function timeRangeFilter(field: string, range: TimeRange): Record<string, unknown> {
  return { range: { [field]: { gte: range.from, lte: range.to } } }
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, "\\$&")
}

function safeExportFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .trim()

  return cleaned || "skill-traces"
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
}

function stringifyExportValue(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value

  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return item.toString()
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`
        if (typeof item === "symbol") return item.toString()
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]"
          seen.add(item)
        }
        return item
      },
      2
    )
  } catch {
    return String(value)
  }
}

function formatTraceExportMarkdown(
  payload: DashboardTraceExportPayload,
  exportedAt: string
): string {
  const lines: string[] = [
    `# Skill 会话历史 · ${escapeMarkdown(payload.skill || "-")}`,
    "",
    `- Skill: \`${escapeMarkdown(payload.skill || "-")}\``,
    `- Range: ${payload.range.from} 至 ${payload.range.to}`,
    `- Page: ${payload.page}`,
    `- Page Size: ${payload.pageSize}`,
    `- Total Traces: ${payload.totalTraces}`,
    `- Exported: ${exportedAt}`,
    ""
  ]

  for (const trace of payload.traces) {
    lines.push(`## Trace ${escapeMarkdown(trace.traceId || "-")}`, "")
    lines.push(`- Thread ID: \`${escapeMarkdown(trace.threadId || "-")}\``)
    lines.push(`- Time: ${trace.startedAt || "-"}`)
    lines.push(`- Outcome: ${trace.outcome || "-"}`)
    lines.push(`- Duration: ${Math.round(trace.durationMs || 0)}ms`)
    lines.push(`- Model: ${escapeMarkdown(trace.modelName || trace.modelId || "-")}`)
    lines.push(`- Tool Calls: ${trace.totalToolCalls}`)
    lines.push(
      `- Tokens: ${trace.totalTokens} (input ${trace.totalInputTokens}, output ${trace.totalOutputTokens})`
    )
    if (trace.userName || trace.sapId || trace.ystId) {
      lines.push(
        `- User: ${escapeMarkdown(trace.userName || "-")} / ${escapeMarkdown(trace.sapId || "-")} / ${escapeMarkdown(trace.ystId || "-")}`
      )
    }
    if (trace.usedSkills.length > 0) {
      lines.push(
        `- Skills: ${trace.usedSkills.map((skill) => `\`${escapeMarkdown(skill)}\``).join(", ")}`
      )
    }
    lines.push("")

    if (trace.userMessage.trim()) {
      lines.push("### User Message", "", trace.userMessage.trim(), "")
    }

    if (trace.nodes && trace.nodes.length > 0) {
      lines.push("### Trace Nodes", "")
      for (const node of trace.nodes) {
        lines.push(
          `#### ${escapeMarkdown(node.type)} · ${escapeMarkdown(node.name || node.id)}`,
          ""
        )
        const metadata = [
          `id: \`${escapeMarkdown(node.id)}\``,
          node.parentId ? `parent: \`${escapeMarkdown(node.parentId)}\`` : null,
          node.status ? `status: \`${escapeMarkdown(node.status)}\`` : null,
          `startedAt: ${node.startedAt}`,
          node.endedAt ? `endedAt: ${node.endedAt}` : null
        ].filter(Boolean)
        lines.push(`_${metadata.join(", ")}_`, "")
        if (node.input !== undefined) {
          lines.push("INPUT", "", "```json", stringifyExportValue(node.input), "```", "")
        }
        if (node.output !== undefined) {
          lines.push("OUTPUT", "", "```json", stringifyExportValue(node.output), "```", "")
        }
        if (node.metadata && Object.keys(node.metadata).length > 0) {
          lines.push("METADATA", "", "```json", stringifyExportValue(node.metadata), "```", "")
        }
      }
    } else {
      lines.push("### Trace Summary", "", "```json", stringifyExportValue(trace), "```", "")
    }
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function normalizeTraceExportPayload(value: unknown): DashboardTraceExportPayload {
  const payload = asRecord(value)
  const skill = asString(payload.skill).trim()
  const range = asRecord(payload.range)
  const traces = Array.isArray(payload.traces)
    ? payload.traces.map((trace) => trace as DashboardTraceDetail)
    : []
  const page = typeof payload.page === "number" ? payload.page : undefined
  const pageSize = typeof payload.pageSize === "number" ? payload.pageSize : undefined

  return {
    skill,
    range: {
      from: asString(range.from),
      to: asString(range.to)
    },
    page: clampLimit(page, 1, 1000),
    pageSize: clampLimit(pageSize, 10, 50),
    totalTraces: asNumber(payload.totalTraces, traces.length),
    traces
  }
}

/**
 * 过滤“有有效 ystId 的记录”：
 * - 字段存在
 * - 且不为空字符串
 */
function buildNonEmptyYstIdFilter(): Record<string, unknown> {
  return {
    bool: {
      must: [{ exists: { field: "ystId" } }],
      must_not: [{ term: { ystId: "" } }]
    }
  }
}

/**
 * 过滤“空用户记录”：
 * - ystId 为空字符串
 * - 或 ystId 字段不存在
 */
function buildEmptyYstIdFilter(): Record<string, unknown> {
  return {
    bool: {
      should: [{ term: { ystId: "" } }, { bool: { must_not: [{ exists: { field: "ystId" } }] } }],
      minimum_should_match: 1
    }
  }
}

function buildNonEmptySapIdFilter(): Record<string, unknown> {
  return {
    bool: {
      must: [{ exists: { field: "sapId" } }],
      must_not: [{ term: { sapId: "" } }]
    }
  }
}

function buildUserListSearchFilter(keyword: string): Record<string, unknown> | null {
  const normalizedKeyword = keyword.trim()
  if (!normalizedKeyword) return null

  const escaped = escapeWildcard(normalizedKeyword)
  const wildcardPattern = `*${escaped}*`
  const fields = ["userName", "username", "ystId"]
  const should = fields.flatMap((field) => [
    { term: { [field]: normalizedKeyword } },
    { term: { [`${field}.keyword`]: normalizedKeyword } },
    { wildcard: { [field]: wildcardPattern } },
    { wildcard: { [`${field}.keyword`]: wildcardPattern } }
  ])

  return {
    bool: {
      should,
      minimum_should_match: 1
    }
  }
}

/**
 * 统一构建技能命中条件：
 * 使用 prefix 兼容 `技能名-v版本` 这一类上报格式，避免宽泛 wildcard 扫描。
 */
function buildSkillUsageWildcardFilter(skillName: string): Record<string, unknown> {
  const versionPrefix = buildVersionPrefix(skillName)
  return {
    bool: {
      should: [
        { term: { usedSkills: skillName } },
        { term: { "usedSkills.keyword": skillName } },
        { prefix: { usedSkills: versionPrefix } },
        { prefix: { "usedSkills.keyword": versionPrefix } }
      ],
      minimum_should_match: 1
    }
  }
}

function buildVersionPrefix(skillName: string): string {
  return `${skillName}-v`
}

const SKILL_EVAL_STATS_PAGE_SIZE = 500
const SKILL_EVAL_STATS_TRACE_LIMIT = 2000
const SKILL_EVAL_RECENT_TASK_SCAN_MULTIPLIER = 12
const SKILL_EVAL_RECENT_TASK_SCAN_LIMIT = 2000
const SKILL_EVAL_STAT_CACHE_TTL_MS = 60_000
const SKILL_EVAL_STAT_CACHE_LIMIT = 30
const SKILL_EVAL_STATS_QUERY_TIMEOUT_MS = 45_000

function buildChatTriggeredTraceFilter(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { term: { triggerSource: "chat" } },
        { term: { "triggerSource.keyword": "chat" } },
        { bool: { must_not: { exists: { field: "triggerSource" } } } }
      ],
      minimum_should_match: 1
    }
  }
}

/**
 * 清洗技能名参数：
 * - 去重
 * - 去空值
 * - 限制最大数量，避免 filters 聚合过大
 */
function normalizeSkillQueryNames(skillNames?: string[]): string[] {
  if (!Array.isArray(skillNames)) return []
  return Array.from(
    new Set(
      skillNames.map((name) => normalizeSkillQueryName(String(name || "").trim())).filter(Boolean)
    )
  ).slice(0, 1000)
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(max, Math.floor(Number(limit))))
}

function normalizeTraceViewMode(value: unknown): TraceViewMode {
  return value === "trace" ? "trace" : "thread"
}

function normalizeTraceTriggerScope(value: unknown): TraceTriggerScope {
  return value === "all" ? "all" : "active"
}

function normalizeCommitDetailsOptions(
  value?: number | CommitDetailsOptions
): Required<CommitDetailsOptions> {
  if (typeof value === "number") {
    return {
      page: 1,
      pageSize: clampLimit(value, 20, 500),
      pushedOnly: false,
      upperOrgLv1: null,
      orgLv1List: []
    }
  }

  const page = clampLimit(value?.page, 1, 10_000)
  const pageSize = clampLimit(value?.pageSize, 20, 100)
  return {
    page,
    pageSize,
    pushedOnly: value?.pushedOnly === true,
    upperOrgLv1: normalizeUpperOrgLv1Option(value?.upperOrgLv1),
    orgLv1List: normalizeUpperOrgLv1List(value?.orgLv1List)
  }
}

function normalizeSkillEvalOptions(value?: DashboardSkillEvalOptions): {
  sampleLimit: number
  recentPage: number
  recentPageSize: number
  skillPage: number
  skillPageSize: number
  skillSearch: string
  skillName?: string
  skillVersion: string | undefined
  skillNames: string[]
  skillNamesProvided: boolean
  defaultRecentToLatestSkill: boolean
  recentOnly: boolean
  listOnly: boolean
  statsOnly: boolean
} {
  const skillName = typeof value?.skillName === "string" ? value.skillName.trim() : ""
  const skillVersion = typeof value?.skillVersion === "string" ? value.skillVersion.trim() : ""
  const skillSearch =
    typeof value?.skillSearch === "string" ? normalizeSkillQueryName(value.skillSearch) : ""
  const rawSkillNames = Array.isArray(value?.skillNames)
    ? value.skillNames.filter((item): item is string => typeof item === "string")
    : []
  const skillNames = normalizeSkillQueryNames(rawSkillNames).slice(0, 100)
  return {
    sampleLimit: clampLimit(value?.limit, 500, 2000),
    recentPage: clampLimit(value?.recentPage, 1, 10_000),
    recentPageSize: clampLimit(value?.recentPageSize, 10, 100),
    skillPage: clampLimit(value?.skillPage, 1, 10_000),
    skillPageSize: clampLimit(value?.skillPageSize, 10, 100),
    skillSearch,
    ...(skillName ? { skillName } : {}),
    skillVersion: skillName ? skillVersion || undefined : undefined,
    skillNames,
    skillNamesProvided: Array.isArray(value?.skillNames),
    defaultRecentToLatestSkill: value?.defaultRecentToLatestSkill === true,
    recentOnly: value?.recentOnly === true,
    listOnly: value?.listOnly === true,
    statsOnly: value?.statsOnly === true
  }
}

function skillEvalTraceSourceIncludes(): string[] {
  return [
    "_raw",
    "traceId",
    "threadId",
    "startedAt",
    "endedAt",
    "durationMs",
    "userMessage",
    "modelId",
    "modelName",
    "outcome",
    "totalToolCalls",
    "totalInputTokens",
    "totalOutputTokens",
    "totalTokens",
    "usedSkills"
  ]
}

type SkillEvalExactFilter = { skillName: string; skillVersion: string | undefined }
type SkillEvalNamesFilter = { skillNames: string[] }
type SkillEvalFilter = SkillEvalExactFilter | SkillEvalNamesFilter

function isSkillEvalExactFilter(filter?: SkillEvalFilter): filter is SkillEvalExactFilter {
  if (!filter || !("skillName" in filter)) return false
  return typeof filter.skillName === "string" && filter.skillName.length > 0
}

function skillEvalFilterCacheKey(skillFilter: SkillEvalFilter | undefined): string {
  if (!skillFilter) return "all"
  if (isSkillEvalExactFilter(skillFilter)) {
    return `skill:${skillVersionKey(skillFilter.skillName, skillFilter.skillVersion)}`
  }
  return `names:${skillFilter.skillNames.join("|")}`
}

function normalizeUserListOptions(value?: UserListOptions): Required<
  Omit<UserListOptions, "afterKey" | "keyword" | "upperOrgLv1">
> & {
  afterKey?: Record<string, string | number>
  keyword: string
  upperOrgLv1: string | null
} {
  const pageSize = clampLimit(value?.pageSize, 20, 100)
  const rawAfterKey = value?.afterKey
  const afterKey =
    rawAfterKey && typeof rawAfterKey === "object" && !Array.isArray(rawAfterKey)
      ? Object.fromEntries(
          Object.entries(rawAfterKey).filter(
            ([, item]) => typeof item === "string" || typeof item === "number"
          )
        )
      : undefined
  const keyword = typeof value?.keyword === "string" ? value.keyword.trim().slice(0, 100) : ""
  const upperOrgLv1 = normalizeUpperOrgLv1Option(value?.upperOrgLv1)
  return {
    pageSize,
    keyword,
    upperOrgLv1,
    ...(afterKey && Object.keys(afterKey).length > 0 ? { afterKey } : {})
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value).trim()
  return text ? text : undefined
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function skillVersionKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
}

function getFirstSkillFilterFromSummaries(
  skills: DashboardSkillEvalSkillSummary[]
): { skillName: string; skillVersion: string | undefined } | undefined {
  if (skills.length === 0) return undefined
  const skill = skills[0]
  return {
    skillName: skill.skillName,
    skillVersion: skill.skillVersion
  }
}

function hasAllowedSkillName(skillName: string, allowedSkillNames?: Set<string>): boolean {
  return !allowedSkillNames || allowedSkillNames.has(normalizeSkillQueryName(skillName))
}

function matchesSkillSearch(skillName: string, skillSearch: string): boolean {
  return (
    !skillSearch ||
    normalizeSkillQueryName(skillName).toLowerCase().includes(skillSearch.toLowerCase())
  )
}

function averageValue(total: number, count: number): number {
  if (count === 0) return 0
  return Number((total / count).toFixed(4))
}

function normalizeTraceTriggerSource(value: unknown): TraceTriggerSource {
  return value === "chat" ||
    value === "heartbeat" ||
    value === "scheduler_reminder" ||
    value === "scheduler_action" ||
    value === "memory_summarize" ||
    value === "optimizer"
    ? value
    : "chat"
}

function dashboardTraceSourceIncludes(): string[] {
  return [
    "_raw",
    "traceId",
    "threadId",
    "startedAt",
    "endedAt",
    "durationMs",
    "userMessage",
    "sapId",
    "ystId",
    "userName",
    "orgName",
    "userIp",
    "modelId",
    "modelName",
    "outcome",
    "totalToolCalls",
    "totalInputTokens",
    "totalOutputTokens",
    "totalTokens",
    "usedSkills",
    "evolvedSkills",
    "triggerSource"
  ]
}

function codeAdoptPushedAggs(): Record<string, unknown> {
  return {
    pushed_measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
    pushed_effective_generated_lines: effectiveGeneratedLinesSumAgg(),
    pushed_adopted_lines: { sum: { field: "properties.adoptedLineCount" } },
    pushed_commit_count: { cardinality: { field: "properties.commitSha" } }
  }
}

function summarizeTraceTokenUsage(modelCalls: AgentTrace["modelCalls"]): {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
} {
  if (!Array.isArray(modelCalls) || modelCalls.length === 0) {
    return { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }
  }
  return modelCalls.reduce(
    (acc, call) => {
      const input = call?.tokenUsage?.inputTokens ?? 0
      const output = call?.tokenUsage?.outputTokens ?? 0
      const total = call?.tokenUsage?.totalTokens ?? input + output
      acc.totalInputTokens += input
      acc.totalOutputTokens += output
      acc.totalTokens += total
      return acc
    },
    { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 }
  )
}

function parseRawTrace(raw: unknown): { trace?: AgentTrace; error?: string } {
  if (raw === undefined || raw === null) return { error: "该 trace 缺少 _raw 字段" }
  if (typeof raw === "string") {
    try {
      return { trace: JSON.parse(raw) as AgentTrace }
    } catch (e) {
      return { error: `解析 _raw 失败：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return { trace: raw as AgentTrace }
  return { error: "_raw 字段格式不受支持" }
}

function normalizeParsedTrace(
  trace: AgentTrace,
  source: Record<string, unknown>,
  hit: EsSearchHit
): AgentTrace {
  const candidate = trace as Partial<AgentTrace>
  const startedAt = candidate.startedAt || asString(source.startedAt)
  const endedAt = candidate.endedAt || asString(source.endedAt, startedAt)
  const outcome = asString(candidate.outcome, asString(source.outcome, "unknown"))
  const safeOutcome = (
    outcome === "success" || outcome === "error" || outcome === "cancelled" || outcome === "unknown"
      ? outcome
      : "unknown"
  ) as AgentTrace["outcome"]

  return {
    ...trace,
    traceId: candidate.traceId || asString(source.traceId, hit._id ?? ""),
    threadId: candidate.threadId || asString(source.threadId),
    startedAt,
    endedAt,
    durationMs: asNumber(candidate.durationMs, asNumber(source.durationMs)),
    userMessage: candidate.userMessage || asString(source.userMessage),
    modelId: candidate.modelId || asString(source.modelId),
    modelName: candidate.modelName || asOptionalString(source.modelName),
    steps: Array.isArray(candidate.steps) ? candidate.steps : [],
    modelCalls: Array.isArray(candidate.modelCalls) ? candidate.modelCalls : undefined,
    nodes: Array.isArray(candidate.nodes) ? candidate.nodes : undefined,
    totalToolCalls: asNumber(candidate.totalToolCalls, asNumber(source.totalToolCalls)),
    outcome: safeOutcome,
    skillEval: candidate.skillEval,
    usedSkills: Array.isArray(candidate.usedSkills)
      ? candidate.usedSkills
      : asStringArray(source.usedSkills),
    evolvedSkills: Array.isArray(candidate.evolvedSkills)
      ? candidate.evolvedSkills
      : asStringArray(source.evolvedSkills),
    triggerSource: normalizeTraceTriggerSource(candidate.triggerSource || source.triggerSource)
  }
}

function getTotalHits(raw: EsSearchResponse, fallback: number): number {
  const total = raw.hits?.total
  if (typeof total === "number") return total
  if (total && typeof total === "object" && typeof total.value === "number") return total.value
  return fallback
}

function normalizeTraceDetail(hit: EsSearchHit): DashboardTraceDetail {
  const source = hit._source ?? {}
  const parsed = parseRawTrace(source._raw)

  if (parsed.trace) {
    const trace = normalizeParsedTrace(parsed.trace, source, hit)
    const usage = summarizeTraceTokenUsage(trace.modelCalls)
    const fallbackInputTokens = asNumber(source.totalInputTokens)
    const fallbackOutputTokens = asNumber(source.totalOutputTokens)
    const fallbackTotalTokens = asNumber(
      source.totalTokens,
      fallbackInputTokens + fallbackOutputTokens
    )
    const totalInputTokens = usage.totalInputTokens || fallbackInputTokens
    const totalOutputTokens = usage.totalOutputTokens || fallbackOutputTokens
    const totalTokens =
      usage.totalTokens || fallbackTotalTokens || totalInputTokens + totalOutputTokens
    let nodes: TraceNode[] | undefined
    let rawError: string | undefined
    try {
      nodes = buildTraceTree(trace)
    } catch (e) {
      rawError = `解析 trace 树失败：${e instanceof Error ? e.message : String(e)}`
    }

    return {
      traceId: trace.traceId || asString(source.traceId, hit._id ?? ""),
      threadId: trace.threadId || asString(source.threadId),
      startedAt: trace.startedAt || asString(source.startedAt),
      endedAt: trace.endedAt || asOptionalString(source.endedAt),
      durationMs: asNumber(trace.durationMs, asNumber(source.durationMs)),
      userMessage: trace.userMessage || asString(source.userMessage),
      sapId: asOptionalString(source.sapId),
      ystId: asOptionalString(source.ystId),
      userName: asOptionalString(source.userName),
      orgName: asOptionalString(source.orgName),
      userIp: asOptionalString(source.userIp),
      modelId: trace.modelId || asOptionalString(source.modelId),
      modelName: trace.modelName || asOptionalString(source.modelName),
      outcome: trace.outcome || asString(source.outcome, "unknown"),
      totalToolCalls: asNumber(trace.totalToolCalls, asNumber(source.totalToolCalls)),
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      usedSkills: Array.isArray(trace.usedSkills)
        ? trace.usedSkills
        : asStringArray(source.usedSkills),
      evolvedSkills: Array.isArray(trace.evolvedSkills)
        ? trace.evolvedSkills
        : asStringArray(source.evolvedSkills),
      triggerSource: normalizeTraceTriggerSource(trace.triggerSource || source.triggerSource),
      ...(nodes ? { nodes } : {}),
      rawAvailable: !rawError,
      ...(rawError ? { rawError } : {})
    }
  }

  const fallbackInputTokens = asNumber(source.totalInputTokens)
  const fallbackOutputTokens = asNumber(source.totalOutputTokens)
  return {
    traceId: asString(source.traceId, hit._id ?? ""),
    threadId: asString(source.threadId),
    startedAt: asString(source.startedAt),
    endedAt: asOptionalString(source.endedAt),
    durationMs: asNumber(source.durationMs),
    userMessage: asString(source.userMessage),
    sapId: asOptionalString(source.sapId),
    ystId: asOptionalString(source.ystId),
    userName: asOptionalString(source.userName),
    orgName: asOptionalString(source.orgName),
    userIp: asOptionalString(source.userIp),
    modelId: asOptionalString(source.modelId),
    modelName: asOptionalString(source.modelName),
    outcome: asString(source.outcome, "unknown"),
    totalToolCalls: asNumber(source.totalToolCalls),
    totalInputTokens: fallbackInputTokens,
    totalOutputTokens: fallbackOutputTokens,
    totalTokens: asNumber(source.totalTokens, fallbackInputTokens + fallbackOutputTokens),
    usedSkills: asStringArray(source.usedSkills),
    evolvedSkills: asStringArray(source.evolvedSkills),
    triggerSource: normalizeTraceTriggerSource(source.triggerSource),
    rawAvailable: false,
    rawError: parsed.error
  }
}

function traceToDashboardTraceDetail(trace: AgentTrace): DashboardTraceDetail {
  const usage = summarizeTraceTokenUsage(trace.modelCalls)
  let nodes: TraceNode[] | undefined
  let rawError: string | undefined
  try {
    nodes = buildTraceTree(trace)
  } catch (e) {
    rawError = `解析 trace 树失败：${e instanceof Error ? e.message : String(e)}`
  }

  return {
    traceId: trace.traceId,
    threadId: trace.threadId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: asNumber(trace.durationMs),
    userMessage: trace.userMessage,
    modelId: trace.modelId,
    ...(trace.modelName ? { modelName: trace.modelName } : {}),
    outcome: trace.outcome,
    totalToolCalls: asNumber(trace.totalToolCalls),
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens || usage.totalInputTokens + usage.totalOutputTokens,
    usedSkills: Array.isArray(trace.usedSkills) ? trace.usedSkills : [],
    evolvedSkills: Array.isArray(trace.evolvedSkills) ? trace.evolvedSkills : [],
    triggerSource: normalizeTraceTriggerSource(trace.triggerSource),
    ...(nodes ? { nodes } : {}),
    rawAvailable: !rawError,
    ...(rawError ? { rawError } : {})
  }
}

function normalizeCommitDetail(hit: EsSearchHit): DashboardCommitDetail {
  const source = hit._source ?? {}
  const properties = asRecord(source.properties)
  const usedSkills = asStringArray(properties.usedSkills)
  return {
    eventId: asString(source.eventId, hit._id ?? ""),
    eventTime: asString(source.eventTime),
    userName: asString(source.userName, "unknown"),
    sapId: asOptionalString(source.sapId),
    ystId: asOptionalString(source.ystId),
    orgName: asOptionalString(source.orgName),
    upperOrgLv0: asOptionalString(source.upperOrgLv0),
    upperOrgLv1: asOptionalString(source.upperOrgLv1),
    userIp: asOptionalString(source.userIp),
    repoPath: asOptionalString(properties.repoPath),
    repositoryName: asOptionalString(properties.repositoryName),
    repositoryFullName: asOptionalString(properties.repositoryFullName),
    repositoryWebUrl: asOptionalString(properties.repositoryWebUrl),
    commitSha: asOptionalString(properties.commitSha),
    commitUrl: asOptionalString(properties.commitUrl),
    pushed: properties.pushed === true,
    pushedAt: asOptionalString(properties.pushedAt),
    branch: asOptionalString(properties.branch),
    filesChanged: asNumber(properties.filesChanged),
    insertions: asNumber(properties.insertions),
    deletions: asNumber(properties.deletions),
    triggeredBy: asOptionalString(properties.triggeredBy),
    threadId: asOptionalString(properties.threadId),
    usedSkills,
    skillCount: asNumber(properties.skillCount, usedSkills.length),
    codeGeneratedLines: 0,
    codeEffectiveGeneratedLines: 0,
    codeAdoptedLines: 0,
    codeAdoptionRate: null
  }
}

function normalizeSkillList(skills: string[]): string[] {
  return Array.from(new Set(skills.map((skill) => skill.trim()).filter(Boolean)))
}

async function fetchCommitAdoptionMap(
  commitShas: string[]
): Promise<Map<string, CommitAdoptionSummary>> {
  const normalizedCommitShas = normalizeSkillList(commitShas).slice(0, 100)
  if (normalizedCommitShas.length === 0) return new Map()

  // NOTE: deliberately NO time-range filter here. The `commitSha` terms clause is
  // already a precise, globally-unique selector for the exact commits in the
  // visible (eventTime-filtered) list. A `code_adopt` event is timestamped at
  // *commit* time but carries `generatedAt` = the *generation* time, which can
  // predate the commit by up to the attribution window (≈7 days). Filtering by
  // `generatedAt` within the commit-list range would drop adoption rows for any
  // commit whose code was generated before the window started — making the
  // commit show up in the list with an empty 采纳率. Matching on commitSha alone
  // is both correct and safe.
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          { term: { eventName: "code_adopt" } },
          { exists: { field: "properties.adoptedLineCount" } },
          { exists: { field: "properties.generatedLineCount" } },
          { exists: { field: "properties.effectiveGeneratedLineCount" } },
          { terms: { "properties.commitSha": normalizedCommitShas } }
        ]
      }
    },
    aggs: {
      by_commit: {
        terms: { field: "properties.commitSha", size: normalizedCommitShas.length },
        aggs: {
          by_skill: { terms: { field: "properties.usedSkills", size: 50 } },
          generated_lines: { sum: { field: "properties.generatedLineCount" } },
          effective_generated_lines: effectiveGeneratedLinesSumAgg(),
          adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
        }
      }
    }
  }

  const raw = asRecord(await esQuery(getEsIndex("event"), body))
  const buckets = asRecord(asRecord(raw.aggregations).by_commit).buckets
  if (!Array.isArray(buckets)) return new Map()

  const result = new Map<string, CommitAdoptionSummary>()
  for (const bucket of buckets) {
    const record = asRecord(bucket)
    const commitSha = asString(record.key)
    if (!commitSha) continue

    const skillBuckets = asRecord(record.by_skill).buckets
    const skills = Array.isArray(skillBuckets)
      ? normalizeSkillList(skillBuckets.map((skillBucket) => asString(asRecord(skillBucket).key)))
      : []
    const generatedLines = asNumber(asRecord(record.generated_lines).value)
    const effectiveGeneratedLines = asNumber(asRecord(record.effective_generated_lines).value)
    const adoptedLines = asNumber(asRecord(record.adopted_lines).value)
    result.set(commitSha, {
      usedSkills: skills,
      generatedLines,
      effectiveGeneratedLines,
      adoptedLines,
      adoptionRate: effectiveGeneratedLines > 0 ? adoptedLines / effectiveGeneratedLines : null
    })
  }
  return result
}

// ─────────────────────────────────────────────────────────
// Dashboard data fetchers
// ─────────────────────────────────────────────────────────

async function fetchOverview(
  range: TimeRange,
  granularity: Granularity,
  opts?: OrgFilterOptions
): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤；orgFilterClause 是用户主动选择的 LV1 组织维度筛选。
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const rankingTopSize = 20
  const rankingSearchSize = 1000
  const filteredToolExcludes = FILTERED_TOOL_EXCLUDES
  const traceBody = {
    size: 0,
    query: {
      bool: {
        filter: [timeRangeFilter("startedAt", range), ...(orgFilterClause ? [orgFilterClause] : [])]
      }
    },
    aggs: {
      total_calls: { value_count: { field: "traceId" } },
      active_users: { cardinality: { field: "sapId" } },
      avg_duration: { avg: { field: "durationMs" } },
      total_input_tokens: { sum: { field: "totalInputTokens" } },
      total_output_tokens: { sum: { field: "totalOutputTokens" } },
      total_skills: { cardinality: { field: "usedSkills" } },
      total_tools: { cardinality: { field: "toolNames" } },
      total_skill_calls: { value_count: { field: "usedSkills" } },
      total_tool_calls: { value_count: { field: "toolNames" } },
      by_skill: { terms: { field: "usedSkills", size: rankingTopSize } },
      by_skill_all: { terms: { field: "usedSkills", size: rankingSearchSize } },
      by_tool: {
        terms: {
          field: "toolNames",
          size: rankingTopSize,
          exclude: filteredToolExcludes
        }
      },
      by_tool_filtered_all: {
        terms: {
          field: "toolNames",
          size: rankingSearchSize,
          exclude: filteredToolExcludes
        }
      },
      by_tool_all: {
        terms: { field: "toolNames", size: rankingTopSize }
      },
      by_tool_all_full: {
        terms: { field: "toolNames", size: rankingSearchSize }
      },
      trend: {
        date_histogram: {
          field: "startedAt",
          calendar_interval: interval,
          time_zone: "Asia/Shanghai"
        },
        aggs: {
          users: { cardinality: { field: "sapId" } }
        }
      }
    }
  }
  const codeGenFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_gen" } },
    timeRangeFilter("eventTime", range),
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
  const codeAdoptFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_adopt" } },
    { exists: { field: "properties.adoptedLineCount" } },
    { exists: { field: "properties.generatedLineCount" } },
    { exists: { field: "properties.effectiveGeneratedLineCount" } },
    timeRangeFilter("properties.generatedAt", range),
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
  const codeAdoptPushedFilters: Record<string, unknown>[] = [
    ...codeAdoptFilters,
    { term: { "properties.pushed": true } }
  ]
  const codeBody = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: {
      code_gen: {
        filter: { bool: { filter: codeGenFilters } },
        aggs: {
          generated_lines: { sum: { field: "properties.lineCount" } },
          deleted_lines: { sum: { field: "properties.deletedLineCount" } }
        }
      },
      code_adopt_measured: {
        filter: { bool: { filter: codeAdoptFilters } },
        aggs: {
          measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
          effective_generated_lines: effectiveGeneratedLinesSumAgg(),
          adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
        }
      },
      code_adopt_pushed: {
        filter: { bool: { filter: codeAdoptPushedFilters } },
        aggs: codeAdoptPushedAggs()
      },
      by_skill_adoption: {
        terms: { field: "properties.usedSkills", size: rankingSearchSize },
        aggs: {
          code_gen: {
            filter: { bool: { filter: codeGenFilters } },
            aggs: {
              generated_lines: { sum: { field: "properties.lineCount" } },
              deleted_lines: { sum: { field: "properties.deletedLineCount" } }
            }
          },
          code_adopt_measured: {
            filter: { bool: { filter: codeAdoptFilters } },
            aggs: {
              measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
              effective_generated_lines: effectiveGeneratedLinesSumAgg(),
              adopted_lines: { sum: { field: "properties.adoptedLineCount" } },
              commit_count: { cardinality: { field: "properties.commitSha" } }
            }
          },
          code_adopt_pushed: {
            filter: { bool: { filter: codeAdoptPushedFilters } },
            aggs: codeAdoptPushedAggs()
          }
        }
      }
    }
  }

  const [traceRaw, codeRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody),
    esQuery(getEsIndex("event"), codeBody)
  ])
  const codeStats = normalizeCodeStatsFromAggs(codeRaw)
  const skillCodeAdoption = normalizeSkillCodeAdoptionBuckets(codeRaw)
  const traceRecord = asRecord(traceRaw)
  return {
    ...traceRecord,
    aggregations: {
      ...asRecord(traceRecord.aggregations),
      code_generated_lines: { value: codeStats.generatedLines },
      code_deleted_lines: { value: codeStats.deletedLines },
      code_effective_generated_lines: { value: codeStats.effectiveGeneratedLines },
      code_measured_generated_lines: { value: codeStats.measuredGeneratedLines },
      code_unmeasured_generated_lines: { value: codeStats.unmeasuredGeneratedLines },
      code_inclusive_effective_generated_lines: {
        value: codeStats.inclusiveEffectiveGeneratedLines
      },
      code_adopted_lines: { value: codeStats.adoptedLines },
      code_pushed_measured_generated_lines: { value: codeStats.pushedMeasuredGeneratedLines },
      code_pushed_effective_generated_lines: { value: codeStats.pushedEffectiveGeneratedLines },
      code_pushed_adopted_lines: { value: codeStats.pushedAdoptedLines },
      code_pushed_commit_count: { value: codeStats.pushedCommitCount },
      code_by_skill_adoption: {
        buckets: skillCodeAdoption.map((item) => ({
          key: item.skill,
          generated_lines: { value: item.generatedLines },
          measured_generated_lines: { value: item.measuredGeneratedLines },
          effective_generated_lines: { value: item.effectiveGeneratedLines },
          unmeasured_generated_lines: { value: item.unmeasuredGeneratedLines },
          inclusive_effective_generated_lines: { value: item.inclusiveEffectiveGeneratedLines },
          adopted_lines: { value: item.adoptedLines },
          measured_adoption_rate: { value: item.measuredAdoptionRate },
          inclusive_adoption_rate: { value: item.inclusiveAdoptionRate },
          commit_count: { value: item.commitCount },
          pushed_measured_generated_lines: { value: item.pushedMeasuredGeneratedLines },
          pushed_effective_generated_lines: { value: item.pushedEffectiveGeneratedLines },
          pushed_adopted_lines: { value: item.pushedAdoptedLines },
          pushed_adoption_rate: { value: item.pushedAdoptionRate },
          pushed_commit_count: { value: item.pushedCommitCount }
        }))
      }
    }
  }
}

async function fetchModelStats(
  range: TimeRange,
  granularity: Granularity,
  opts?: OrgFilterOptions
): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤；orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  void granularity
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [timeRangeFilter("startedAt", range), ...(orgFilterClause ? [orgFilterClause] : [])]
      }
    },
    aggs: {
      by_model: {
        terms: { field: "modelName", size: 30 },
        aggs: {
          total_input_tokens: { sum: { field: "totalInputTokens" } },
          total_output_tokens: { sum: { field: "totalOutputTokens" } }
        }
      },
      by_tier: {
        terms: { field: "routing.resolvedTier", size: 5 }
      },
      by_layer: {
        terms: { field: "routing.decidedByLayer", size: 10 }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

function buildUpperOrgLv1Filter(upperOrgLv1: string): Record<string, unknown> {
  return { term: { upperOrgLv1 } }
}

// 单个室文本 → LV1/LV0 模糊匹配子句（含精确 term + 通配 wildcard）。
function buildSingleOrgLevelClause(orgLevel: string): Record<string, unknown> {
  const escaped = escapeWildcard(orgLevel)
  const wildcardPattern = `*${escaped}*`
  return {
    bool: {
      should: ["upperOrgLv1", "upperOrgLv0"].flatMap((field) => [
        { term: { [field]: orgLevel } },
        { term: { [`${field}.keyword`]: orgLevel } },
        { wildcard: { [field]: wildcardPattern } },
        { wildcard: { [`${field}.keyword`]: wildcardPattern } }
      ]),
      minimum_should_match: 1
    }
  }
}

// 「部门查询」按逗号（中/英文）拆分为多个室 token；ES 与 dev mock 共用此规则。
function splitOrgQueryTokens(orgLevel: string): string[] {
  const tokens = orgLevel
    .split(/[，,]/)
    .map((token) => token.trim())
    .filter(Boolean)
  return tokens.length > 0 ? tokens : [orgLevel]
}

// 判断单个 token 是否代表「未归类」（空/缺失 LV1）。
function isUnclassifiedOrgToken(token: string): boolean {
  return token === DASHBOARD_UNCLASSIFIED_LABEL || token === DASHBOARD_UNCLASSIFIED_ORG
}

// 「部门查询」支持逗号（中/英文）分隔的多个室：来自顶部全局「室筛选」的回填或用户手输，
// 各 token 之间按 OR 叠加。「未归类」token 走空/缺失 LV1 的专用子句。
function buildOrgLevelMatchFilter(orgLevel: string): Record<string, unknown> {
  const clauses = splitOrgQueryTokens(orgLevel).map((token) =>
    isUnclassifiedOrgToken(token) ? buildUnclassifiedOrgClause() : buildSingleOrgLevelClause(token)
  )
  if (clauses.length === 1) return clauses[0]
  return { bool: { should: clauses, minimum_should_match: 1 } }
}

function normalizeUpperOrgLv1Option(upperOrgLv1?: string | null): string | null {
  if (typeof upperOrgLv1 !== "string") return null
  const normalized = upperOrgLv1.trim()
  return normalized ? normalized : null
}

// 「未归类」哨兵：代表 upperOrgLv1 为空或缺失的记录（前后端约定一致）。
const DASHBOARD_UNCLASSIFIED_ORG = "__unclassified__"
// 「未归类」回填到「部门查询」文本框时使用的展示标签，需与渲染层 orgOptionLabel 一致。
const DASHBOARD_UNCLASSIFIED_LABEL = "（未归类）"
// fetchOrgOptions 内部用来给「字段缺失」的文档归桶的临时 key（不外泄）。
const DASHBOARD_ORG_MISSING_BUCKET = "__org_missing__"

// 将单个或多个 LV1 组织值统一规整为去重、去空的数组。
function normalizeUpperOrgLv1List(value?: string | string[] | null): string[] {
  const raw = Array.isArray(value) ? value : value != null ? [value] : []
  const cleaned = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(cleaned))
}

// upperOrgLv1 为空或缺失的匹配子句（「未归类」）。
function buildUnclassifiedOrgClause(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { bool: { must_not: { exists: { field: "upperOrgLv1" } } } },
        { term: { upperOrgLv1: "" } }
      ],
      minimum_should_match: 1
    }
  }
}

// 多选 LV1 组织筛选 → terms 过滤；空数组返回 null（表示全部，不过滤）。
// 列表含「未归类」哨兵时，额外 OR 上「空/缺失 upperOrgLv1」的匹配。
function buildUpperOrgLv1ListFilter(list: string[]): Record<string, unknown> | null {
  if (list.length === 0) return null
  const includeUnclassified = list.includes(DASHBOARD_UNCLASSIFIED_ORG)
  const realOrgs = list.filter((value) => value !== DASHBOARD_UNCLASSIFIED_ORG)
  const clauses: Record<string, unknown>[] = []
  if (realOrgs.length > 0) clauses.push({ terms: { upperOrgLv1: realOrgs } })
  if (includeUnclassified) clauses.push(buildUnclassifiedOrgClause())
  if (clauses.length === 0) return null
  if (clauses.length === 1) return clauses[0]
  return { bool: { should: clauses, minimum_should_match: 1 } }
}

function buildNonEmptyOrgLevelFilter(
  field: "upperOrgLv0" | "upperOrgLv1"
): Record<string, unknown> {
  return {
    bool: {
      must: [{ exists: { field } }],
      must_not: [{ term: { [field]: "" } }]
    }
  }
}

function buildOrgDistributionAgg(
  selectedOrgs: string[],
  metric: "pv" | "uv"
): Record<string, unknown> {
  // 仅选中单个 LV1 时下钻到 LV0 分布，否则按 LV1 分组（多选时限定在所选集合内）。
  const field = selectedOrgs.length === 1 ? "upperOrgLv0" : "upperOrgLv1"
  const terms: Record<string, unknown> = { field, size: 30, missing: "" }
  const aggs = metric === "uv" ? { unique_users: { cardinality: { field: "sapId" } } } : undefined

  if (metric === "uv") {
    terms.order = { unique_users: "desc" }
  }

  const items = aggs ? { terms, aggs } : { terms }
  const filters = [buildNonEmptyOrgLevelFilter(field)]
  const listFilter = buildUpperOrgLv1ListFilter(selectedOrgs)
  if (listFilter) {
    filters.push(listFilter)
  }

  return {
    filter: { bool: { filter: filters } },
    aggs: { items }
  }
}

async function fetchUserStats(
  range: TimeRange,
  granularity: Granularity,
  opts?: UserStatsOptions
): Promise<unknown> {
  requireDashboardAccess()
  void granularity
  const selectedOrgs = normalizeUpperOrgLv1List(opts?.upperOrgLv1)
  // 统计指标不做组织级数据权限过滤，仅保留用户主动选择的组织（LV1）多选维度。
  // 统计指标计入全部触发来源（含定时任务/心跳等后台触发，均视为真人参与）。
  // triggerSource 仅用于 trace 分析页的「主动触发/全部」切换，不在统计口径里过滤。
  const queryFilters = [timeRangeFilter("startedAt", range)]
  const orgFilterClause = buildUpperOrgLv1ListFilter(selectedOrgs)
  if (orgFilterClause) {
    queryFilters.push(orgFilterClause)
  }

  const body = {
    size: 0,
    query: { bool: { filter: queryFilters } },
    aggs: {
      top_users: {
        terms: { field: "sapId", size: 50 },
        aggs: {
          latest_user_info: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: [
                  "userName",
                  "orgName",
                  "upperOrgLv0",
                  "upperOrgLv1",
                  "appVersion",
                  "startedAt"
                ]
              }
            }
          }
        }
      },
      by_org: buildOrgDistributionAgg(selectedOrgs, "pv"),
      by_org_pv: buildOrgDistributionAgg(selectedOrgs, "pv"),
      by_org_uv: buildOrgDistributionAgg(selectedOrgs, "uv"),
      by_version: {
        terms: { field: "appVersion", size: 20 },
        aggs: {
          unique_users: { cardinality: { field: "sapId" } },
          users: {
            terms: { field: "sapId", size: 200 },
            aggs: {
              latest_user_info: {
                top_hits: {
                  size: 1,
                  sort: [{ startedAt: { order: "desc" } }],
                  _source: {
                    includes: [
                      "userName",
                      "orgName",
                      "upperOrgLv0",
                      "upperOrgLv1",
                      "appVersion",
                      "startedAt"
                    ]
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

function getLatestHitSource(
  bucket: Record<string, unknown>,
  aggName: string
): Record<string, unknown> {
  const agg = asRecord(bucket[aggName])
  const hitsWrapper = asRecord(agg.hits)
  const hits = hitsWrapper.hits
  if (!Array.isArray(hits) || hits.length === 0) return {}
  return asRecord(asRecord(hits[0])._source)
}

function normalizeUserListBucket(bucket: Record<string, unknown>): DashboardUserListItem {
  const source = getLatestHitSource(bucket, "latest_user_info")
  const key = asRecord(bucket.key)
  const sapId =
    typeof bucket.key === "string" ? bucket.key : asString(key.sap_id, asString(source.sapId))
  const totalInputTokens = asNumber(asRecord(bucket.total_input_tokens).value)
  const totalOutputTokens = asNumber(asRecord(bucket.total_output_tokens).value)
  const totalTokens = asNumber(
    asRecord(bucket.total_tokens).value,
    totalInputTokens + totalOutputTokens
  )
  return {
    sapId,
    ystId: asOptionalString(source.ystId),
    userName: asString(source.userName, sapId || "unknown"),
    orgName: asOptionalString(source.orgName),
    upperOrgLv0: asOptionalString(source.upperOrgLv0),
    upperOrgLv1: asOptionalString(source.upperOrgLv1),
    count: asNumber(bucket.doc_count),
    lastActiveAt: asOptionalString(source.startedAt),
    avgDurationMs: asNumber(asRecord(bucket.avg_duration).value),
    totalToolCalls: asNumber(asRecord(bucket.total_tool_calls).value),
    totalInputTokens,
    totalOutputTokens,
    totalTokens
  }
}

async function fetchUserList(
  range: TimeRange,
  options?: UserListOptions
): Promise<DashboardUserListData> {
  requireDashboardAccess()
  const { pageSize, afterKey, keyword, upperOrgLv1 } = normalizeUserListOptions(options)
  const offsetValue = Number(afterKey?.offset ?? 0)
  const offset = Number.isFinite(offsetValue) && offsetValue > 0 ? Math.floor(offsetValue) : 0
  const aggregationSize = Math.min(offset + pageSize, 10_000)
  const shardSize = Math.min(Math.max(aggregationSize * 3, 100), 50_000)
  // 用户列表属于统计/目录数据，不做组织级数据权限过滤，仅保留用户主动选择的组织维度。
  // 统计口径计入全部触发来源；triggerSource 仅用于 trace 分析页切换，不在此过滤。
  const filters = [timeRangeFilter("startedAt", range), buildNonEmptySapIdFilter()]
  if (upperOrgLv1 !== null) {
    filters.push(buildOrgLevelMatchFilter(upperOrgLv1))
  }
  const searchFilter = buildUserListSearchFilter(keyword)
  if (searchFilter) filters.push(searchFilter)

  const body = {
    size: 0,
    query: {
      bool: {
        filter: filters
      }
    },
    aggs: {
      total_active_users: { cardinality: { field: "sapId" } },
      users: {
        terms: {
          field: "sapId",
          size: aggregationSize,
          shard_size: shardSize,
          order: { _count: "desc" }
        },
        aggs: {
          latest_user_info: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: [
                  "startedAt",
                  "sapId",
                  "ystId",
                  "userName",
                  "orgName",
                  "upperOrgLv0",
                  "upperOrgLv1"
                ]
              }
            }
          },
          avg_duration: { avg: { field: "durationMs" } },
          total_tool_calls: { sum: { field: "totalToolCalls" } },
          total_input_tokens: { sum: { field: "totalInputTokens" } },
          total_output_tokens: { sum: { field: "totalOutputTokens" } },
          total_tokens: { sum: { field: "totalTokens" } }
        }
      }
    }
  }

  const raw = asRecord(await esQuery(getEsIndex("trace"), body))
  const aggs = asRecord(raw.aggregations)
  const usersAgg = asRecord(aggs.users)
  const allBuckets = Array.isArray(usersAgg.buckets) ? usersAgg.buckets : []
  const buckets = allBuckets.slice(offset, offset + pageSize)
  const totalActiveUsers = asNumber(asRecord(aggs.total_active_users).value)
  const nextOffset = offset + pageSize
  const hasMoreBuckets = asNumber(usersAgg.sum_other_doc_count) > 0
  return {
    items: buckets
      .map((bucket) => normalizeUserListBucket(asRecord(bucket)))
      .filter((item) => item.sapId),
    pageSize,
    ...(hasMoreBuckets && nextOffset < 10_000 ? { nextAfterKey: { offset: nextOffset } } : {}),
    totalActiveUsers
  }
}

function normalizeTermsBucketList(
  rawBuckets: unknown,
  keyName: "skill" | "model" | "outcome"
): Array<Record<typeof keyName, string> & { count: number }> {
  if (!Array.isArray(rawBuckets)) return []
  return rawBuckets.map((bucket) => {
    const record = asRecord(bucket)
    return {
      [keyName]: asString(record.key, "unknown"),
      count: asNumber(record.doc_count)
    } as Record<typeof keyName, string> & { count: number }
  })
}

// ── 会话（thread）列表分页：用户页 / 技能页 thread 视图共用同一套逻辑 ──
// 会话按最近活跃时间倒序取桶后切片分页；该上限同时约束 terms 桶数与可翻到的
// 最深页（page * pageSize ≤ 上限）。单用户 / 单技能的会话量有界，300 足够。
const MAX_THREAD_LIST_BUCKETS = 300
// 每个会话在列表里展开渲染的 trace 数上限。会话内 trace 通常很少；超大会话的
// 完整还原由「Thread 对话还原」抽屉（fetchThreadTraces）负责，列表无需全量。
const THREAD_LIST_TRACES_PER_THREAD = 50

/** 当前页所需的 terms 桶数（取到第 page 页末尾，封顶 MAX_THREAD_LIST_BUCKETS）。 */
function threadListBucketsNeeded(page: number, pageSize: number): number {
  return Math.min(page * pageSize, MAX_THREAD_LIST_BUCKETS)
}

/**
 * 「按会话分页」的聚合定义：按 threadId 分桶（按最近活跃倒序）、每桶回带该会话
 * 的 trace（升序、最多 THREAD_LIST_TRACES_PER_THREAD 条）。用户页与技能页 thread
 * 视图共用，保证两边口径完全一致。
 */
function threadListAgg(bucketsNeeded: number): Record<string, unknown> {
  return {
    total_threads: { cardinality: { field: "threadId" } },
    by_thread: {
      terms: {
        field: "threadId",
        size: bucketsNeeded,
        order: { latest_started_at: "desc" }
      },
      aggs: {
        latest_started_at: { max: { field: "startedAt" } },
        traces: {
          top_hits: {
            size: THREAD_LIST_TRACES_PER_THREAD,
            sort: [{ startedAt: { order: "asc" } }],
            _source: { includes: dashboardTraceSourceIncludes() }
          }
        }
      }
    }
  }
}

/**
 * 解析 threadListAgg 的结果容器（含 total_threads + by_thread），按当前页切片，
 * 并把当页每个会话的全部 trace 摊平返回，交给客户端按 thread 归组（每组完整、不跨页）。
 */
function parseThreadListContainer(
  container: Record<string, unknown>,
  page: number,
  pageSize: number
): { traces: DashboardTraceDetail[]; totalThreads: number } {
  const totalThreads = Math.min(
    asNumber(asRecord(container.total_threads).value),
    MAX_THREAD_LIST_BUCKETS
  )
  const buckets = asRecord(container.by_thread).buckets
  const fromBucket = (page - 1) * pageSize
  const selected = Array.isArray(buckets) ? buckets.slice(fromBucket, fromBucket + pageSize) : []
  const traces = selected.flatMap((bucket) => {
    const hits = asRecord(asRecord(asRecord(bucket).traces).hits).hits
    return Array.isArray(hits) ? hits.map((hit) => normalizeTraceDetail(hit as EsSearchHit)) : []
  })
  return { traces, totalThreads }
}

async function fetchUserDetail(
  sapId: string,
  range: TimeRange,
  options?: UserDetailOptions
): Promise<DashboardUserDetail> {
  const access = requireDashboardAccess()
  const normalizedSapId = sapId.trim()
  if (!normalizedSapId) throw new Error("sapId is required")
  const traceViewMode = normalizeTraceViewMode(options?.viewMode ?? options?.mode)
  const tracePageSize = clampLimit(options?.tracePageSize ?? options?.traceLimit, 10, 50)
  const tracePage = clampLimit(options?.tracePage, 1, 1000)
  const triggerScope = normalizeTraceTriggerScope(options?.triggerScope)
  // 统计指标（顶层聚合）按该用户全量计算，不做组织级权限过滤；
  // 组织级权限作用于返回的会话/trace 明细（thread 模式经 thread_list 的 filter 聚合，
  // trace 模式经 post_filter），避免跨组织读取对话内容。
  const traceAccessFilter = buildTraceAccessFilter(access)
  const baseFilter = [
    timeRangeFilter("startedAt", range),
    { term: { sapId: normalizedSapId } },
    ...(triggerScope === "active" ? [buildChatTriggeredTraceFilter()] : [])
  ]
  // 两种视图共用的全量统计聚合（与列表口径隔离）。
  const statsAggs: Record<string, unknown> = {
    latest_user_info: {
      top_hits: {
        size: 1,
        sort: [{ startedAt: { order: "desc" } }],
        _source: {
          includes: ["sapId", "ystId", "userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
        }
      }
    },
    total_calls: { value_count: { field: "traceId" } },
    avg_duration: { avg: { field: "durationMs" } },
    total_tool_calls: { sum: { field: "totalToolCalls" } },
    total_input_tokens: { sum: { field: "totalInputTokens" } },
    total_output_tokens: { sum: { field: "totalOutputTokens" } },
    total_tokens: { sum: { field: "totalTokens" } },
    by_skill: { terms: { field: "usedSkills", size: 10 } },
    by_model: { terms: { field: "modelName", size: 10 } },
    by_outcome: { terms: { field: "outcome", size: 10 } }
  }

  // 列表：
  // - thread 视图：按会话分页，每页返回若干「完整会话」（与技能页共用 threadListAgg）。
  // - trace 视图：按 trace 时间（startedAt 倒序）直接分页，一条 trace 一行。
  const body =
    traceViewMode === "thread"
      ? {
          size: 0,
          query: { bool: { filter: baseFilter } },
          aggs: {
            ...statsAggs,
            thread_list: {
              filter: traceAccessFilter ?? { match_all: {} },
              aggs: threadListAgg(threadListBucketsNeeded(tracePage, tracePageSize))
            }
          }
        }
      : {
          // trace 视图：按 trace 时间（startedAt 倒序）直接分页，一条 trace 一行。
          // 用顶层 hits + post_filter：支持深翻页（max_result_window），且 post_filter
          // 只裁剪命中列表与 hits.total（统计聚合仍为全量），与组织数据权限语义一致。
          track_total_hits: true,
          from: (tracePage - 1) * tracePageSize,
          size: tracePageSize,
          sort: [{ startedAt: { order: "desc" } }],
          query: { bool: { filter: baseFilter } },
          ...(traceAccessFilter ? { post_filter: traceAccessFilter } : {}),
          aggs: statsAggs,
          _source: { includes: dashboardTraceSourceIncludes() }
        }

  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const rawRecord = asRecord(raw)
  const aggs = asRecord(rawRecord.aggregations)
  const userInfo = getLatestHitSource(aggs, "latest_user_info")
  const totalInputTokens = asNumber(asRecord(aggs.total_input_tokens).value)
  const totalOutputTokens = asNumber(asRecord(aggs.total_output_tokens).value)
  const totalTokens = asNumber(
    asRecord(aggs.total_tokens).value,
    totalInputTokens + totalOutputTokens
  )
  // 统计指标：调用次数取自全量聚合。
  const totalCalls = asNumber(asRecord(aggs.total_calls).value)

  // 列表与翻页总数（按当前视图模式）：
  // thread → 会话数；trace → 受权限过滤的 trace 总数（post_filter 后的 hits.total）。
  let traces: DashboardTraceDetail[]
  let total: number
  if (traceViewMode === "thread") {
    const parsed = parseThreadListContainer(asRecord(aggs.thread_list), tracePage, tracePageSize)
    traces = parsed.traces
    total = parsed.totalThreads
  } else {
    const hits = raw.hits?.hits ?? []
    traces = hits.map(normalizeTraceDetail)
    total = getTotalHits(raw, hits.length)
  }

  return {
    sapId: asString(userInfo.sapId, normalizedSapId),
    ystId: asOptionalString(userInfo.ystId),
    userName: asString(userInfo.userName, normalizedSapId),
    orgName: asOptionalString(userInfo.orgName),
    upperOrgLv0: asOptionalString(userInfo.upperOrgLv0),
    upperOrgLv1: asOptionalString(userInfo.upperOrgLv1),
    totalCalls,
    avgDurationMs: asNumber(asRecord(aggs.avg_duration).value),
    totalToolCalls: asNumber(asRecord(aggs.total_tool_calls).value),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    bySkill: normalizeTermsBucketList(
      asRecord(aggs.by_skill).buckets,
      "skill"
    ) as DashboardUserDetail["bySkill"],
    byModel: normalizeTermsBucketList(
      asRecord(aggs.by_model).buckets,
      "model"
    ) as DashboardUserDetail["byModel"],
    byOutcome: normalizeTermsBucketList(
      asRecord(aggs.by_outcome).buckets,
      "outcome"
    ) as DashboardUserDetail["byOutcome"],
    traces,
    tracePage,
    tracePageSize,
    total,
    traceViewMode,
    traceTriggerScope: triggerScope
  }
}

async function fetchSkillUsageSummary(
  range: TimeRange,
  granularity: Granularity,
  skillNames?: string[]
): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤。
  const traceAccessFilter = null
  void granularity
  // 模式 A：前端传入技能名列表，使用 filters 精确按“技能维度”统计。
  // 这样可以直接得到每个技能的用户数，避免按版本桶二次合并带来的误差。
  const normalizedSkillNames = normalizeSkillQueryNames(skillNames)
  if (normalizedSkillNames.length > 0) {
    const filters = Object.fromEntries(
      normalizedSkillNames.map((skillName) => [skillName, buildSkillUsageWildcardFilter(skillName)])
    )
    // 统计口径计入全部触发来源；triggerSource 仅用于 trace 分析页切换，不在此过滤。
    const body = {
      size: 0,
      query: {
        bool: {
          filter: [
            timeRangeFilter("startedAt", range),
            ...(traceAccessFilter ? [traceAccessFilter] : [])
          ]
        }
      },
      aggs: {
        by_skill: {
          filters: { filters },
          aggs: {
            unique_users: {
              filter: buildNonEmptyYstIdFilter(),
              aggs: {
                count: { cardinality: { field: "ystId" } }
              }
            }
          }
        }
      }
    }
    return esQuery(getEsIndex("trace"), body)
  }

  // 模式 B：兼容旧调用方，保留 terms 聚合结构。
  // 统计口径计入全部触发来源；triggerSource 仅用于 trace 分析页切换，不在此过滤。
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          ...(traceAccessFilter ? [traceAccessFilter] : [])
        ]
      }
    },
    aggs: {
      by_skill: {
        terms: { field: "usedSkills", size: 1000 },
        aggs: {
          unique_users: { cardinality: { field: "ystId" } }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchSkillEvalSummary(
  range: TimeRange,
  options?: DashboardSkillEvalOptions
): Promise<DashboardSkillEvalSummary> {
  const {
    sampleLimit,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    skillSearch,
    skillName,
    skillVersion,
    skillNames,
    skillNamesProvided,
    defaultRecentToLatestSkill,
    recentOnly,
    listOnly,
    statsOnly
  } = normalizeSkillEvalOptions(options)
  const recentFrom = (recentPage - 1) * recentPageSize
  const skillNamesFilter: SkillEvalNamesFilter | undefined =
    skillNames.length > 0 ? { skillNames } : undefined
  const allowedSkillNames = skillNames.length > 0 ? new Set(skillNames) : undefined
  const explicitRecentFilter: SkillEvalExactFilter | undefined = skillName
    ? { skillName, skillVersion }
    : undefined

  if (statsOnly && !explicitRecentFilter) {
    throw new Error("statsOnly requires skillName")
  }
  if (skillNamesProvided && skillNames.length === 0) {
    return buildSkillEvalSummaryFromRuns({
      sampleRuns: [],
      totalTraceHits: 0,
      sampledTraceCount: 0,
      recentTotal: 0,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize,
      allowedSkillNames: new Set()
    })
  }

  let recentSkillFilter = explicitRecentFilter ?? skillNamesFilter

  // statsOnly is intentionally handled before recentOnly; if both flags are
  // present, the lightweight stats-only path wins and does not fetch recent runs.
  if (statsOnly && explicitRecentFilter) {
    const statsResult = await fetchSkillEvalStatRecords(range, explicitRecentFilter, sampleLimit)
    const statsRuns = skillEvalStoredRecordsToDashboardRuns(
      statsResult.records,
      undefined,
      explicitRecentFilter,
      allowedSkillNames
    )
    return buildSkillEvalSummaryFromRuns({
      sampleRuns: statsRuns,
      recentRuns: [],
      totalTraceHits: statsResult.totalRecordHits,
      sampledTraceCount: statsResult.records.length,
      recentTotal: 0,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize,
      recentSkillFilter: explicitRecentFilter,
      allowedSkillNames
    })
  }

  if (recentOnly && explicitRecentFilter) {
    const [statsResult, recentResult] = await Promise.all([
      fetchSkillEvalStatRecords(range, explicitRecentFilter, sampleLimit),
      fetchSkillEvalRecordPage(range, explicitRecentFilter, recentFrom, recentPageSize, true)
    ])
    const statsRuns = skillEvalStoredRecordsToDashboardRuns(
      statsResult.records,
      undefined,
      explicitRecentFilter,
      allowedSkillNames
    )
    return buildSkillEvalSummaryFromRuns({
      sampleRuns: statsRuns,
      recentRuns: recentResult.runs,
      totalTraceHits: statsResult.totalRecordHits,
      sampledTraceCount: statsResult.records.length,
      recentTotal: recentResult.totalRecordHits,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize,
      recentSkillFilter: explicitRecentFilter,
      allowedSkillNames
    })
  }

  if (!explicitRecentFilter && defaultRecentToLatestSkill) {
    const skillList = await fetchSkillEvalRecordSkillList(
      range,
      skillNamesFilter,
      allowedSkillNames,
      skillPage,
      skillPageSize,
      skillSearch
    )
    if (listOnly) {
      return buildSkillEvalListOnlySummary({
        skillList,
        recentPage,
        recentPageSize,
        skillPage,
        skillPageSize
      })
    }
    recentSkillFilter = getFirstSkillFilterFromSummaries(skillList.skills) ?? skillNamesFilter
    const [statsResult, recentResult] = await Promise.all([
      fetchSkillEvalStatRecords(range, recentSkillFilter, sampleLimit),
      fetchSkillEvalRecordPage(range, recentSkillFilter, recentFrom, recentPageSize, true)
    ])
    const focusedSampleRuns = skillEvalStoredRecordsToDashboardRuns(
      statsResult.records,
      undefined,
      isSkillEvalExactFilter(recentSkillFilter) ? recentSkillFilter : undefined,
      allowedSkillNames
    )
    const summary = buildSkillEvalSummaryFromRuns({
      sampleRuns: focusedSampleRuns,
      recentRuns: recentResult.runs,
      totalTraceHits: statsResult.totalRecordHits,
      sampledTraceCount: statsResult.records.length,
      recentTotal: recentResult.totalRecordHits,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize,
      ...(isSkillEvalExactFilter(recentSkillFilter) ? { recentSkillFilter } : {}),
      allowedSkillNames,
      skillList: skillList.skills
    })
    return {
      ...summary,
      totalTraceHits: skillList.totalTraceHits,
      totalSkills: skillList.totalSkills
    }
  }

  const skillListPromise = !explicitRecentFilter
    ? fetchSkillEvalRecordSkillList(
        range,
        skillNamesFilter,
        allowedSkillNames,
        skillPage,
        skillPageSize,
        skillSearch
      )
    : undefined
  if (listOnly && skillListPromise) {
    const skillList = await skillListPromise
    return buildSkillEvalListOnlySummary({
      skillList,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize
    })
  }

  const [statsResult, recentResult, skillList] = await Promise.all([
    fetchSkillEvalStatRecords(range, recentSkillFilter, sampleLimit),
    fetchSkillEvalRecordPage(range, recentSkillFilter, recentFrom, recentPageSize, true),
    skillListPromise ?? Promise.resolve(undefined)
  ])
  const sampleRuns = skillEvalStoredRecordsToDashboardRuns(
    statsResult.records,
    undefined,
    isSkillEvalExactFilter(recentSkillFilter) ? recentSkillFilter : undefined,
    allowedSkillNames
  )
  const summary = buildSkillEvalSummaryFromRuns({
    sampleRuns,
    recentRuns: recentResult.runs,
    totalTraceHits: statsResult.totalRecordHits,
    sampledTraceCount: statsResult.records.length,
    recentTotal: recentResult.totalRecordHits,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    ...(isSkillEvalExactFilter(recentSkillFilter) ? { recentSkillFilter } : {}),
    allowedSkillNames,
    ...(skillList ? { skillList: skillList.skills } : {})
  })

  return skillList
    ? {
        ...summary,
        totalTraceHits: skillList.totalTraceHits,
        totalSkills: skillList.totalSkills
      }
    : summary
}

type SkillEvalRecordPageResult = {
  records: TraceSkillEvalRecord[]
  runs: DashboardSkillEvalRun[]
  totalRecordHits: number
}

type SkillEvalStatRecordResult = { records: TraceSkillEvalRecord[]; totalRecordHits: number }

function skillEvalRecordSourceIncludes(): string[] {
  return [
    "id",
    "traceId",
    "threadId",
    "rawSkillName",
    "skillName",
    "skillVersion",
    "skillTaskId",
    "skillTaskTraceIndex",
    "evalSource",
    "contextTraceIds",
    "skillEvalTraceIds",
    "contextTraceCount",
    "skillEvalTraceCount",
    "startedAt",
    "endedAt",
    "startedDate",
    "startedMonth",
    "ystId",
    "sapId",
    "userName",
    "orgName",
    "originOrgId",
    "upperOrgLv0",
    "upperOrgLv1",
    "upperOrgLv2",
    "upperOrgLv3",
    "appVersion",
    "skillAuthor",
    "userMessage",
    "modelId",
    "modelName",
    "outcome",
    "score",
    "processScore",
    "outcomeScore",
    "resultScore",
    "processWeight",
    "outcomeWeight",
    "pass",
    "passNumeric",
    "outcomePass",
    "outcomePassNumeric",
    "resultPass",
    "resultPassNumeric",
    "resultStatus",
    "durationMs",
    "totalToolCalls",
    "modelCallCount",
    "errorCount",
    "totalInputTokens",
    "totalOutputTokens",
    "promptInputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "peakInputTokens",
    "totalTokensIncludesCache",
    "failedProcessChecks",
    "failedOutcomeChecks",
    "failedResultChecks",
    "failedProcessCheckCount",
    "totalProcessCheckCount",
    "failedOutcomeCheckCount",
    "totalOutcomeCheckCount",
    "failedResultCheckCount",
    "totalResultCheckCount",
    "warningTags",
    "checks",
    "outcomeChecks",
    "resultChecks",
    "warnings",
    "outcomeWarnings",
    "resultWarnings",
    "resultIssues",
    "artifacts",
    "evidence"
  ]
}

function skillEvalRecordQuery(
  range: TimeRange,
  skillFilter?: SkillEvalFilter
): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [timeRangeFilter("startedAt", range)]
  if (isSkillEvalExactFilter(skillFilter)) {
    filter.push(
      buildSkillEvalRecordExactSkillFilter(skillFilter.skillName, skillFilter.skillVersion)
    )
  } else if (skillFilter?.skillNames && skillFilter.skillNames.length > 0) {
    filter.push(buildSkillEvalRecordSkillNamesFilter(skillFilter.skillNames))
  }
  return { bool: { filter } }
}

function buildSkillEvalRecordExactSkillFilter(
  skillName: string,
  skillVersion?: string
): Record<string, unknown> {
  const must: Record<string, unknown>[] = [keywordShouldFilter("skillName", skillName)]
  if (skillVersion) must.push(keywordShouldFilter("skillVersion", skillVersion))
  return { bool: { must } }
}

function buildSkillEvalRecordSkillNamesFilter(skillNames: string[]): Record<string, unknown> {
  return {
    bool: {
      should: skillNames.map((skillName) => keywordShouldFilter("skillName", skillName)),
      minimum_should_match: 1
    }
  }
}

function keywordShouldFilter(field: string, value: string): Record<string, unknown> {
  return {
    bool: {
      should: [{ term: { [field]: value } }, { term: { [field + ".keyword"]: value } }],
      minimum_should_match: 1
    }
  }
}

function parseSkillEvalRecordHit(hit: EsSearchHit): TraceSkillEvalRecord | null {
  const source = hit._source ?? {}
  const traceId = asString(source.traceId)
  const rawSkillName = asString(source.rawSkillName)
  const parsed = parseSkillNameVersionIdentifier(
    rawSkillName || asString(source.skillName),
    "unknown"
  )
  const skillName = asString(source.skillName, parsed.skillName)
  if (!traceId || !skillName) return null

  const skillVersion = asOptionalString(source.skillVersion) ?? parsed.skillVersion
  const startedAt = asString(source.startedAt)
  const endedAt = asString(source.endedAt, startedAt)
  const outcome = normalizeTraceOutcome(source.outcome)
  const pass = asBoolean(source.pass, asNumber(source.passNumeric) === 1)
  const outcomePass = asBoolean(source.outcomePass, asNumber(source.outcomePassNumeric) === 1)
  const resultPass = asBoolean(source.resultPass, asNumber(source.resultPassNumeric) === 1)
  const resultStatus = normalizeResultStatus(
    source.resultStatus,
    source.resultScore,
    source.resultPass
  )
  const skillAuthor = asOptionalString(source.skillAuthor)
  const record: TraceSkillEvalRecord = {
    id: asString(source.id, hit._id ?? traceId + ":" + (rawSkillName || skillName)),
    traceId,
    threadId: asString(source.threadId),
    rawSkillName: rawSkillName || (skillVersion ? skillName + "-" + skillVersion : skillName),
    skillName,
    ...(skillVersion ? { skillVersion } : {}),
    skillTaskId: asString(
      source.skillTaskId,
      asString(source.threadId) + ":" + (rawSkillName || skillName) + ":" + traceId
    ),
    skillTaskTraceIndex: asNumber(source.skillTaskTraceIndex),
    evalSource: normalizeEvalSource(source.evalSource),
    contextTraceIds: asStringArray(source.contextTraceIds),
    skillEvalTraceIds: asStringArray(source.skillEvalTraceIds),
    contextTraceCount: asNumber(source.contextTraceCount, 1),
    skillEvalTraceCount: asNumber(source.skillEvalTraceCount, 1),
    startedAt,
    endedAt,
    startedDate: asString(source.startedDate),
    startedMonth: asString(source.startedMonth),
    ystId: asString(source.ystId),
    sapId: asString(source.sapId),
    userName: asString(source.userName),
    orgName: asString(source.orgName),
    originOrgId: asString(source.originOrgId),
    upperOrgLv0: asString(source.upperOrgLv0),
    upperOrgLv1: asString(source.upperOrgLv1),
    upperOrgLv2: asString(source.upperOrgLv2),
    upperOrgLv3: asString(source.upperOrgLv3),
    appVersion: asString(source.appVersion),
    ...(skillAuthor ? { skillAuthor } : {}),
    userMessage: asString(source.userMessage),
    modelId: asString(source.modelId),
    modelName: asString(source.modelName),
    outcome,
    score: normalizeStoredScore(source.score),
    processScore: normalizeStoredScore(source.processScore),
    outcomeScore: normalizeStoredScore(source.outcomeScore),
    ...(source.resultScore !== undefined
      ? { resultScore: normalizeStoredScore(source.resultScore) }
      : {}),
    processWeight: asNumber(source.processWeight, 0.4),
    outcomeWeight: asNumber(source.outcomeWeight, 0.6),
    pass,
    passNumeric: pass ? 1 : 0,
    outcomePass,
    outcomePassNumeric: outcomePass ? 1 : 0,
    resultPass,
    resultPassNumeric: resultPass ? 1 : 0,
    resultStatus,
    durationMs: asNumber(source.durationMs),
    totalToolCalls: asNumber(source.totalToolCalls),
    modelCallCount: asNumber(source.modelCallCount),
    errorCount: asNumber(source.errorCount),
    totalInputTokens: asNumber(source.totalInputTokens),
    totalOutputTokens: asNumber(source.totalOutputTokens),
    totalTokens: asNumber(source.totalTokens),
    promptInputTokens: asNumber(source.promptInputTokens),
    cacheReadTokens: asNumber(source.cacheReadTokens),
    cacheCreationTokens: asNumber(source.cacheCreationTokens),
    peakInputTokens: asNumber(source.peakInputTokens),
    totalTokensIncludesCache: normalizeTotalTokensIncludesCache(source.totalTokensIncludesCache),
    failedProcessChecks: asStringArray(source.failedProcessChecks),
    failedOutcomeChecks: asStringArray(source.failedOutcomeChecks),
    failedResultChecks: asStringArray(source.failedResultChecks),
    failedProcessCheckCount: asNumber(source.failedProcessCheckCount),
    totalProcessCheckCount: asNumber(source.totalProcessCheckCount),
    failedOutcomeCheckCount: asNumber(source.failedOutcomeCheckCount),
    totalOutcomeCheckCount: asNumber(source.totalOutcomeCheckCount),
    failedResultCheckCount: asNumber(source.failedResultCheckCount),
    totalResultCheckCount: asNumber(source.totalResultCheckCount),
    warningTags: asStringArray(source.warningTags) as TraceSkillEvalRecord["warningTags"],
    checks: parseTraceSkillEvalChecks(source.checks, "process"),
    outcomeChecks: parseTraceSkillEvalChecks(source.outcomeChecks, "outcome"),
    resultChecks: parseTraceSkillEvalChecks(source.resultChecks, "result"),
    warnings: asStringArray(source.warnings),
    outcomeWarnings: asStringArray(source.outcomeWarnings),
    resultWarnings: asStringArray(source.resultWarnings),
    resultIssues: asStringArray(source.resultIssues),
    artifacts: parseTraceSkillEvalArtifacts(source.artifacts),
    evidence: parseTraceSkillEvalEvidence(source.evidence)
  }

  if (record.contextTraceIds.length === 0) record.contextTraceIds = [traceId]
  if (record.skillEvalTraceIds.length === 0) record.skillEvalTraceIds = [traceId]
  if (record.contextTraceCount <= 0) record.contextTraceCount = record.contextTraceIds.length || 1
  if (record.skillEvalTraceCount <= 0)
    record.skillEvalTraceCount = record.skillEvalTraceIds.length || 1
  return record
}

function normalizeTraceOutcome(value: unknown): AgentTrace["outcome"] {
  const outcome = asString(value, "unknown")
  return outcome === "success" ||
    outcome === "error" ||
    outcome === "cancelled" ||
    outcome === "unknown"
    ? outcome
    : "unknown"
}

function normalizeEvalSource(value: unknown): TraceSkillEvalRecord["evalSource"] {
  return value === "inherited_context" ? "inherited_context" : "explicit"
}

function normalizeResultStatus(
  value: unknown,
  resultScore: unknown,
  resultPass: unknown
): TraceSkillEvalRecord["resultStatus"] {
  if (value === "evaluated" || value === "skipped" || value === "failed") return value
  return resultScore !== undefined || resultPass !== undefined ? "evaluated" : "skipped"
}

function normalizeTotalTokensIncludesCache(
  value: unknown
): TraceSkillEvalRecord["totalTokensIncludesCache"] {
  return value === "true" || value === "false" || value === "mixed" ? value : "false"
}

function normalizeStoredScore(value: unknown): number {
  return asNumber(value)
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true") return true
    if (normalized === "false") return false
  }
  return fallback
}

function parseTraceSkillEvalChecks(
  value: unknown,
  fallbackCategory: TraceSkillEvalRecord["checks"][number]["category"]
): TraceSkillEvalRecord["checks"] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = asRecord(item)
      const name = asString(record.name)
      if (!name) return null
      const category = asString(record.category, fallbackCategory)
      return {
        name,
        label: asString(record.label, name),
        category:
          category === "process" || category === "outcome" || category === "result"
            ? category
            : fallbackCategory,
        ok: asBoolean(record.ok),
        weight: asNumber(record.weight, 1),
        ...(record.detail && typeof record.detail === "object"
          ? { detail: asRecord(record.detail) }
          : {})
      }
    })
    .filter((item): item is TraceSkillEvalRecord["checks"][number] => Boolean(item))
}

function parseTraceSkillEvalArtifacts(value: unknown): TraceSkillEvalRecord["artifacts"] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = asRecord(item)
      const label = asString(record.label)
      if (!label) return null
      const type = asString(record.type, "other")
      return {
        type:
          type === "response" ||
          type === "file" ||
          type === "command" ||
          type === "screenshot" ||
          type === "log" ||
          type === "other"
            ? type
            : "other",
        label
      }
    })
    .filter((item): item is TraceSkillEvalRecord["artifacts"][number] => Boolean(item))
}

function parseTraceSkillEvalEvidence(value: unknown): TraceSkillEvalRecord["evidence"] {
  const evidence = asRecord(value)
  return {
    finalResponseLength: asNumber(evidence.finalResponseLength),
    changedFiles: asNumber(evidence.changedFiles),
    validationCommands: asNumber(evidence.validationCommands),
    artifactSignals: asNumber(evidence.artifactSignals),
    dangerousCommands: asNumber(evidence.dangerousCommands),
    subagentRuns: asNumber(evidence.subagentRuns),
    subagentCompleted: asNumber(evidence.subagentCompleted),
    subagentFailed: asNumber(evidence.subagentFailed),
    subagentResultLength: asNumber(evidence.subagentResultLength),
    toolResultErrors: asNumber(evidence.toolResultErrors)
  }
}

async function fetchSkillEvalRecordPage(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  from: number,
  size: number,
  includeTraceDetails: boolean
): Promise<SkillEvalRecordPageResult> {
  const scanSize = Math.min(
    SKILL_EVAL_RECENT_TASK_SCAN_LIMIT,
    Math.max(size, (from + size) * SKILL_EVAL_RECENT_TASK_SCAN_MULTIPLIER)
  )
  const body = {
    track_total_hits: true,
    from: 0,
    size: scanSize,
    sort: [{ startedAt: { order: "desc" } }, { id: { order: "desc", unmapped_type: "keyword" } }],
    query: skillEvalRecordQuery(range, skillFilter),
    _source: { includes: skillEvalRecordSourceIncludes() },
    aggs: {
      task_count: {
        cardinality: { field: "skillTaskId", precision_threshold: 40000 }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("skillEval"), body, {
    timeoutMs: SKILL_EVAL_STATS_QUERY_TIMEOUT_MS
  })) as EsSearchResponse
  const records = parseSkillEvalRecordHits(raw)
  const scannedTaskRuns = aggregateSkillEvalTaskRuns(
    skillEvalStoredRecordsToDashboardRuns(records, undefined, skillFilter)
  ).sort(compareSkillEvalRunsByStartedAtDesc)
  const pageTaskRuns = scannedTaskRuns.slice(from, from + size)
  const pageTaskKeys = new Set(pageTaskRuns.map(skillEvalTaskKey))
  const pageRecords = records.filter((record) => pageTaskKeys.has(skillEvalRecordTaskKey(record)))
  const traceDetails = includeTraceDetails
    ? await fetchTraceDetailsForSkillEvalRecords(pageRecords)
    : undefined
  const pageRuns = aggregateSkillEvalTaskRuns(
    skillEvalStoredRecordsToDashboardRuns(pageRecords, traceDetails, skillFilter)
  )
    .sort(compareSkillEvalRunsByStartedAtDesc)
    .slice(0, size)
  const taskCount = asNumber(asRecord(asRecord(raw.aggregations).task_count).value)

  return {
    records: pageRecords,
    runs: pageRuns,
    totalRecordHits: Math.max(taskCount, scannedTaskRuns.length)
  }
}

async function fetchSkillEvalStatRecords(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  recordLimit = SKILL_EVAL_STATS_TRACE_LIMIT
): Promise<SkillEvalStatRecordResult> {
  const cached = getCachedSkillEvalStatRecords(range, skillFilter, recordLimit)
  if (cached) return cached

  const records: TraceSkillEvalRecord[] = []
  const maxRecords = Math.max(1, recordLimit)
  let totalRecordHits = 0
  let loadedHits = 0
  let searchAfter: Array<string | number> | undefined

  while (records.length < maxRecords) {
    const body: Record<string, unknown> = {
      track_total_hits: loadedHits === 0,
      size: Math.min(SKILL_EVAL_STATS_PAGE_SIZE, maxRecords - records.length),
      sort: [{ startedAt: { order: "desc" } }, { id: { order: "desc", unmapped_type: "keyword" } }],
      query: skillEvalRecordQuery(range, skillFilter),
      _source: { includes: skillEvalRecordSourceIncludes() }
    }
    if (searchAfter) body.search_after = searchAfter
    const raw = (await esQuery(getEsIndex("skillEval"), body, {
      timeoutMs: SKILL_EVAL_STATS_QUERY_TIMEOUT_MS
    })) as EsSearchResponse
    const hits = raw.hits?.hits ?? []
    const hitCount = hits.length
    if (loadedHits === 0) totalRecordHits = getTotalHits(raw, hitCount)
    if (hitCount === 0) break

    for (const record of parseSkillEvalRecordHits(raw)) {
      if (records.length >= maxRecords) break
      records.push(record)
    }
    loadedHits += hitCount
    searchAfter = hits[hitCount - 1]?.sort
    if (
      loadedHits >= totalRecordHits ||
      hitCount < SKILL_EVAL_STATS_PAGE_SIZE ||
      records.length >= maxRecords
    ) {
      break
    }
  }

  const result = { records, totalRecordHits }
  setCachedSkillEvalStatRecords(range, skillFilter, recordLimit, result)
  return result
}

const skillEvalStatRecordCache = new Map<
  string,
  { expiresAt: number; result: SkillEvalStatRecordResult }
>()

function getCachedSkillEvalStatRecords(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  recordLimit: number
): SkillEvalStatRecordResult | undefined {
  const key = skillEvalStatRecordCacheKey(range, skillFilter, recordLimit)
  const cached = skillEvalStatRecordCache.get(key)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    skillEvalStatRecordCache.delete(key)
    return undefined
  }
  skillEvalStatRecordCache.delete(key)
  skillEvalStatRecordCache.set(key, cached)
  return cached.result
}

function setCachedSkillEvalStatRecords(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  recordLimit: number,
  result: SkillEvalStatRecordResult
): void {
  const key = skillEvalStatRecordCacheKey(range, skillFilter, recordLimit)
  skillEvalStatRecordCache.set(key, {
    expiresAt: Date.now() + SKILL_EVAL_STAT_CACHE_TTL_MS,
    result
  })
  while (skillEvalStatRecordCache.size > SKILL_EVAL_STAT_CACHE_LIMIT) {
    const oldestKey = skillEvalStatRecordCache.keys().next().value
    if (!oldestKey) break
    skillEvalStatRecordCache.delete(oldestKey)
  }
}

function skillEvalStatRecordCacheKey(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  recordLimit: number
): string {
  return [
    range.from,
    range.to,
    Math.max(1, recordLimit),
    skillEvalFilterCacheKey(skillFilter)
  ].join("\u0001")
}

function parseSkillEvalRecordHits(raw: EsSearchResponse): TraceSkillEvalRecord[] {
  const records: TraceSkillEvalRecord[] = []
  for (const hit of raw.hits?.hits ?? []) {
    const record = parseSkillEvalRecordHit(hit)
    if (record) records.push(record)
  }
  return records
}

async function fetchTraceDetailsForSkillEvalRecords(
  records: TraceSkillEvalRecord[]
): Promise<Map<string, DashboardTraceDetail>> {
  const traceIds = Array.from(
    new Set(
      records
        .flatMap((record) => [
          record.traceId,
          // Current window semantics keep these arrays equal; the context fallback is for
          // a future split where context traces can be wider than scored eval traces.
          ...(record.skillEvalTraceIds.length > 0
            ? record.skillEvalTraceIds
            : record.contextTraceIds)
        ])
        .filter(Boolean)
    )
  )
  if (traceIds.length === 0) return new Map()
  const limitedTraceIds = traceIds.slice(0, 500)
  if (traceIds.length > limitedTraceIds.length) {
    console.warn(
      "[Dashboard] skill eval trace detail ids truncated: " +
        traceIds.length +
        " -> " +
        limitedTraceIds.length
    )
  }
  const body = {
    track_total_hits: false,
    size: limitedTraceIds.length,
    query: {
      bool: {
        should: [
          { ids: { values: limitedTraceIds } },
          { terms: { traceId: limitedTraceIds } },
          { terms: { "traceId.keyword": limitedTraceIds } }
        ],
        minimum_should_match: 1
      }
    },
    _source: { includes: skillEvalTraceSourceIncludes() }
  }
  const raw = (await esQuery(getEsIndex("trace"), body, {
    timeoutMs: SKILL_EVAL_STATS_QUERY_TIMEOUT_MS
  })) as EsSearchResponse
  const details = new Map<string, DashboardTraceDetail>()
  for (const hit of raw.hits?.hits ?? []) {
    const detail = normalizeTraceDetail(hit)
    if (detail.traceId) details.set(detail.traceId, detail)
  }
  return details
}

function skillEvalStoredRecordsToDashboardRuns(
  records: TraceSkillEvalRecord[],
  traceDetails?: Map<string, DashboardTraceDetail>,
  skillFilter?: SkillEvalFilter,
  allowedSkillNames?: Set<string>
): DashboardSkillEvalRun[] {
  return records
    .filter((record) => {
      if (isSkillEvalExactFilter(skillFilter) && !isSameSkillVersion(record, skillFilter)) {
        return false
      }
      return hasAllowedSkillName(record.skillName, allowedSkillNames)
    })
    .map((record) => {
      const fallbackTraceDetail = fallbackTraceDetailFromSkillEvalRecord(record)
      const traceDetail = traceDetails?.get(record.traceId) ?? fallbackTraceDetail
      // Current window semantics keep these arrays equal; the context fallback is for
      // a future split where context traces can be wider than scored eval traces.
      const orderedTraceIds = Array.from(
        new Set([
          ...(record.skillEvalTraceIds.length > 0
            ? record.skillEvalTraceIds
            : record.contextTraceIds),
          record.traceId
        ])
      )
      const traceDetailList = orderedTraceIds
        .map((traceId) =>
          traceId === record.traceId ? traceDetail : (traceDetails?.get(traceId) ?? undefined)
        )
        .filter((detail): detail is DashboardTraceDetail => Boolean(detail))
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      return skillEvalRecordToDashboardRun(record, traceDetail, traceDetailList)
    })
}

function fallbackTraceDetailFromSkillEvalRecord(
  record: TraceSkillEvalRecord
): DashboardTraceDetail {
  return {
    traceId: record.traceId,
    threadId: record.threadId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    userMessage: record.userMessage,
    sapId: record.sapId || undefined,
    ystId: record.ystId || undefined,
    userName: record.userName || undefined,
    orgName: record.orgName || undefined,
    modelId: record.modelId || undefined,
    modelName: record.modelName || undefined,
    outcome: record.outcome,
    totalToolCalls: record.totalToolCalls,
    totalInputTokens: record.totalInputTokens,
    totalOutputTokens: record.totalOutputTokens,
    totalTokens: record.totalTokens,
    usedSkills: [record.rawSkillName],
    evolvedSkills: [],
    triggerSource: "chat",
    rawAvailable: false,
    rawError: "未在 trace 索引中找到原始 trace 详情"
  }
}

async function fetchSkillEvalRecordSkillList(
  range: TimeRange,
  skillFilter?: SkillEvalFilter,
  allowedSkillNames?: Set<string>,
  page = 1,
  pageSize = 10,
  skillSearch = ""
): Promise<{
  skills: DashboardSkillEvalSkillSummary[]
  totalTraceHits: number
  totalSkills: number
}> {
  const normalizedPage = clampLimit(page, 1, 10_000)
  const normalizedPageSize = clampLimit(pageSize, 10, 100)
  const skillFrom = (normalizedPage - 1) * normalizedPageSize
  const bucketSize =
    allowedSkillNames || skillSearch ? 10_000 : Math.min(10_000, skillFrom + normalizedPageSize)
  const body = {
    track_total_hits: true,
    size: 0,
    query: skillEvalRecordQuery(range, skillFilter),
    aggs: {
      ...(!allowedSkillNames && !skillSearch
        ? { skill_count: { cardinality: { field: "rawSkillName" } } }
        : {}),
      by_skill: {
        terms: { field: "rawSkillName", size: bucketSize, order: { _count: "desc" } },
        aggs: {
          latest_record: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: ["startedAt", "rawSkillName", "skillName", "skillVersion"]
              }
            }
          },
          pass_count: { sum: { field: "passNumeric" } },
          result_evaluated_runs: { filter: keywordShouldFilter("resultStatus", "evaluated") },
          result_pass_count: { sum: { field: "resultPassNumeric" } },
          avg_score: { avg: { field: "score" } },
          avg_process_score: { avg: { field: "processScore" } },
          avg_outcome_score: { avg: { field: "outcomeScore" } },
          avg_result_score: { avg: { field: "resultScore" } },
          avg_tool_calls: { avg: { field: "totalToolCalls" } },
          avg_model_calls: { avg: { field: "modelCallCount" } },
          avg_input_tokens: { avg: { field: "totalInputTokens" } },
          avg_output_tokens: { avg: { field: "totalOutputTokens" } },
          avg_prompt_input_tokens: { avg: { field: "promptInputTokens" } },
          avg_total_tokens: { avg: { field: "totalTokens" } },
          avg_peak_input_tokens: { avg: { field: "peakInputTokens" } },
          avg_duration_ms: { avg: { field: "durationMs" } },
          validation_runs: { filter: { range: { "evidence.validationCommands": { gt: 0 } } } },
          output_signal_runs: {
            filter: {
              bool: {
                should: [
                  { range: { "evidence.changedFiles": { gt: 0 } } },
                  { range: { "evidence.artifactSignals": { gt: 0 } } },
                  { range: { "evidence.finalResponseLength": { gte: 20 } } }
                ],
                minimum_should_match: 1
              }
            }
          },
          danger_runs: { filter: { range: { "evidence.dangerousCommands": { gt: 0 } } } }
        }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("skillEval"), body, {
    timeoutMs: SKILL_EVAL_STATS_QUERY_TIMEOUT_MS
  })) as EsSearchResponse
  const allSkills = parseSkillEvalRecordSkillList(raw, allowedSkillNames, skillSearch)
  return {
    skills: allSkills.slice(skillFrom, skillFrom + normalizedPageSize),
    totalTraceHits: getTotalHits(raw, 0),
    totalSkills:
      allowedSkillNames || skillSearch
        ? allSkills.length
        : asNumber(raw.aggregations?.skill_count?.value, allSkills.length)
  }
}

function parseSkillEvalRecordSkillList(
  raw: EsSearchResponse,
  allowedSkillNames?: Set<string>,
  skillSearch = ""
): DashboardSkillEvalSkillSummary[] {
  const buckets = raw.aggregations?.by_skill?.buckets
  if (!Array.isArray(buckets)) return []
  return buckets
    .map((bucket) => {
      const record = asRecord(bucket)
      const runs = asNumber(record.doc_count)
      if (runs <= 0) return null
      const rawSkill = asString(record.key)
      const latestSource = getLatestHitSource(record, "latest_record")
      const parsed = parseSkillNameVersionIdentifier(rawSkill || asString(latestSource.skillName))
      const skillName = asString(latestSource.skillName, parsed.skillName)
      const skillVersion = asOptionalString(latestSource.skillVersion) ?? parsed.skillVersion
      if (!hasAllowedSkillName(skillName, allowedSkillNames)) return null
      if (!matchesSkillSearch(skillName, skillSearch)) return null
      const passCount = metricValue(record, "pass_count")
      const resultPassCount = metricValue(record, "result_pass_count")
      const resultEvaluatedRuns = bucketDocCount(record, "result_evaluated_runs")
      return {
        skillName,
        ...(skillVersion ? { skillVersion } : {}),
        runs,
        resultEvaluatedRuns,
        passRate: averageValue(passCount, runs),
        resultPassRate: averageValue(resultPassCount, resultEvaluatedRuns),
        averageScore: averageStoredScoreMetric(record, "avg_score"),
        averageProcessScore: averageStoredScoreMetric(record, "avg_process_score"),
        averageOutcomeScore: averageStoredScoreMetric(record, "avg_outcome_score"),
        averageResultScore: averageStoredScoreMetric(record, "avg_result_score"),
        averageToolCalls: metricValue(record, "avg_tool_calls"),
        averageModelCalls: metricValue(record, "avg_model_calls"),
        averageInputTokens: metricValue(record, "avg_input_tokens"),
        averageOutputTokens: metricValue(record, "avg_output_tokens"),
        averagePromptInputTokens: metricValue(record, "avg_prompt_input_tokens"),
        averageTotalTokens: metricValue(record, "avg_total_tokens"),
        averagePeakInputTokens: metricValue(record, "avg_peak_input_tokens"),
        averageDurationMs: metricValue(record, "avg_duration_ms"),
        validationRate: averageValue(bucketDocCount(record, "validation_runs"), runs),
        outputSignalRate: averageValue(bucketDocCount(record, "output_signal_runs"), runs),
        dangerRate: averageValue(bucketDocCount(record, "danger_runs"), runs),
        failureCount: Math.max(0, runs - passCount),
        lastRunAt: asString(latestSource.startedAt)
      }
    })
    .filter((item): item is DashboardSkillEvalSkillSummary => Boolean(item))
}

function metricValue(bucket: Record<string, unknown>, name: string): number {
  return asNumber(asRecord(bucket[name]).value)
}

function bucketDocCount(bucket: Record<string, unknown>, name: string): number {
  return asNumber(asRecord(bucket[name]).doc_count)
}

function averageStoredScoreMetric(bucket: Record<string, unknown>, name: string): number {
  return averageValue(metricValue(bucket, name), 100)
}

function skillEvalRecordTaskKey(record: TraceSkillEvalRecord): string {
  return record.skillTaskId || [record.threadId, record.rawSkillName, record.traceId].join(":")
}

function skillEvalTaskKey(run: DashboardSkillEvalRun): string {
  return run.skillTaskId || [run.threadId, run.rawSkillName, run.traceId].join(":")
}

function compareSkillEvalRunsByStartedAtDesc(
  left: DashboardSkillEvalRun,
  right: DashboardSkillEvalRun
): number {
  return (
    new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime() ||
    right.traceId.localeCompare(left.traceId)
  )
}

function aggregateSkillEvalTaskRuns(runs: DashboardSkillEvalRun[]): DashboardSkillEvalRun[] {
  const byTask = new Map<string, DashboardSkillEvalRun[]>()
  for (const run of runs) {
    const key = skillEvalTaskKey(run)
    const bucket = byTask.get(key) ?? []
    bucket.push(run)
    byTask.set(key, bucket)
  }

  return [...byTask.values()].map((taskRuns) => {
    const sorted = [...taskRuns].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
    )
    const first = sorted[0]
    const latest = sorted[sorted.length - 1]
    const latestResult = [...sorted].reverse().find((run) => run.resultGenerated)
    if (sorted.length === 1) return latest

    const sum = (selector: (run: DashboardSkillEvalRun) => number): number =>
      sorted.reduce((total, run) => total + selector(run), 0)
    const any = (selector: (run: DashboardSkillEvalRun) => boolean): boolean =>
      sorted.some((run) => selector(run))

    return {
      ...latest,
      startedAt: first.startedAt,
      endedAt: latest.endedAt,
      traceId: latest.traceId,
      userMessage: first.userMessage || latest.userMessage,
      evalSource: any((run) => run.evalSource === "explicit") ? "explicit" : latest.evalSource,
      skillTaskId: skillEvalTaskKey(latest),
      skillTaskTraceIndex: sorted.length - 1,
      pass: latest.pass,
      outcomePass: latest.outcomePass,
      resultPass: latestResult?.resultPass ?? latest.resultPass,
      score: latest.score,
      processScore: latest.processScore,
      outcomeScore: latest.outcomeScore,
      ...(latestResult?.resultScore !== undefined ? { resultScore: latestResult.resultScore } : {}),
      totalToolCalls: sum((run) => run.totalToolCalls),
      modelCallCount: sum((run) => run.modelCallCount),
      totalInputTokens: sum((run) => run.totalInputTokens),
      totalOutputTokens: sum((run) => run.totalOutputTokens),
      promptInputTokens: sum((run) => run.promptInputTokens),
      totalTokens: sum((run) => run.totalTokens),
      cacheReadTokens: sum((run) => run.cacheReadTokens),
      cacheCreationTokens: sum((run) => run.cacheCreationTokens),
      peakInputTokens: Math.max(...sorted.map((run) => run.peakInputTokens)),
      errorCount: sum((run) => run.errorCount),
      durationMs: sum((run) => run.durationMs),
      warnings: Array.from(new Set(sorted.flatMap((run) => run.warnings))),
      outcomeWarnings: Array.from(new Set(sorted.flatMap((run) => run.outcomeWarnings))),
      resultWarnings: Array.from(new Set(sorted.flatMap((run) => run.resultWarnings))),
      resultIssues: Array.from(new Set(sorted.flatMap((run) => run.resultIssues))),
      resultArtifacts: sorted.flatMap((run) => run.resultArtifacts),
      resultGenerated: latestResult !== undefined,
      evidence: {
        finalResponseLength: latest.evidence.finalResponseLength,
        changedFiles: sum((run) => run.evidence.changedFiles),
        validationCommands: sum((run) => run.evidence.validationCommands),
        artifactSignals: sum((run) => run.evidence.artifactSignals),
        dangerousCommands: sum((run) => run.evidence.dangerousCommands),
        subagentRuns: sum((run) => run.evidence.subagentRuns),
        subagentCompleted: sum((run) => run.evidence.subagentCompleted),
        subagentResultLength: sum((run) => run.evidence.subagentResultLength),
        subagentFailed: sum((run) => run.evidence.subagentFailed),
        toolResultErrors: sum((run) => run.evidence.toolResultErrors)
      }
    }
  })
}

function buildSkillEvalSummaryFromRuns({
  sampleRuns,
  recentRuns,
  totalTraceHits = sampleRuns.length,
  sampledTraceCount = sampleRuns.length,
  recentTotal = sampleRuns.length,
  recentPage = 1,
  recentPageSize = 10,
  skillPage = 1,
  skillPageSize = 10,
  allowedSkillNames,
  skillList
}: {
  sampleRuns: DashboardSkillEvalRun[]
  recentRuns?: DashboardSkillEvalRun[]
  totalTraceHits?: number
  sampledTraceCount?: number
  recentTotal?: number
  recentPage?: number
  recentPageSize?: number
  skillPage?: number
  skillPageSize?: number
  recentSkillFilter?: { skillName: string; skillVersion: string | undefined }
  allowedSkillNames?: Set<string>
  skillList?: DashboardSkillEvalSkillSummary[]
}): DashboardSkillEvalSummary {
  const filteredSampleRuns = aggregateSkillEvalTaskRuns(
    sampleRuns.filter((run) => hasAllowedSkillName(run.skillName, allowedSkillNames))
  )
  const grouped = skillList ? undefined : new Map<string, DashboardSkillEvalRun[]>()
  const evaluatedTraceIds = new Set<string>()

  for (const run of filteredSampleRuns) {
    if (grouped) {
      const key = skillVersionKey(run.skillName, run.skillVersion)
      const bucket = grouped.get(key) ?? []
      bucket.push(run)
      grouped.set(key, bucket)
    }
    if (run.traceId) evaluatedTraceIds.add(run.traceId)
  }

  const recentSourceRuns = recentRuns ? aggregateSkillEvalTaskRuns(recentRuns) : filteredSampleRuns
  const sortedRecentRuns = recentSourceRuns
    .filter((run) => hasAllowedSkillName(run.skillName, allowedSkillNames))
    .sort(compareSkillEvalRunsByStartedAtDesc)

  const skills = skillList ?? summarizeSkillEvalRunBuckets(grouped ?? new Map())
  const totalRuns = filteredSampleRuns.length
  const normalizedRecentPage = clampLimit(recentPage, 1, 10_000)
  const normalizedRecentPageSize = clampLimit(recentPageSize, 10, 100)
  const normalizedSkillPage = clampLimit(skillPage, 1, 10_000)
  const normalizedSkillPageSize = clampLimit(skillPageSize, 10, 100)
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / normalizedRecentPageSize))
  const effectiveRecentPage = Math.min(normalizedRecentPage, recentTotalPages)
  const totals = summarizeSkillEvalRunTotals(filteredSampleRuns)

  return {
    generatedAt: new Date().toISOString(),
    totalTraceHits,
    evaluatedTraceCount: evaluatedTraceIds.size,
    sampledTraceCount,
    statTraceLimit: SKILL_EVAL_STATS_TRACE_LIMIT,
    recentTotal,
    recentPage: effectiveRecentPage,
    recentPageSize: normalizedRecentPageSize,
    skillPage: normalizedSkillPage,
    skillPageSize: normalizedSkillPageSize,
    totalRuns,
    resultEvaluatedRuns: totals.resultEvaluatedRuns,
    totalSkills: skills.length,
    passRate: averageValue(totals.passCount, totalRuns),
    resultPassRate: averageValue(totals.resultPassCount, totals.resultEvaluatedRuns),
    averageScore: averageValue(totals.score, totalRuns),
    averageProcessScore: averageValue(totals.processScore, totalRuns),
    averageOutcomeScore: averageValue(totals.outcomeScore, totalRuns),
    averageResultScore: averageValue(totals.resultScore, totals.resultEvaluatedRuns),
    averageToolCalls: averageValue(totals.toolCalls, totalRuns),
    averageModelCalls: averageValue(totals.modelCalls, totalRuns),
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalPromptInputTokens: totals.promptInputTokens,
    totalTokens: totals.totalTokens,
    averageInputTokens: averageValue(totals.inputTokens, totalRuns),
    averageOutputTokens: averageValue(totals.outputTokens, totalRuns),
    averagePromptInputTokens: averageValue(totals.promptInputTokens, totalRuns),
    averageTotalTokens: averageValue(totals.totalTokens, totalRuns),
    averagePeakInputTokens: averageValue(totals.peakInputTokens, totalRuns),
    averageDurationMs: averageValue(totals.durationMs, totalRuns),
    skills,
    recent: sortedRecentRuns
  }
}

function summarizeSkillEvalRunBuckets(
  grouped: Map<string, DashboardSkillEvalRun[]>
): DashboardSkillEvalSkillSummary[] {
  return [...grouped.values()]
    .map((runs) => {
      const latest = runs.reduce(
        (max, run) =>
          new Date(run.startedAt).getTime() > new Date(max.startedAt).getTime() ? run : max,
        runs[0]
      )
      const totals = summarizeSkillEvalRunTotals(runs)
      return {
        skillName: latest.skillName,
        ...(latest.skillVersion ? { skillVersion: latest.skillVersion } : {}),
        runs: runs.length,
        resultEvaluatedRuns: totals.resultEvaluatedRuns,
        passRate: averageValue(totals.passCount, runs.length),
        resultPassRate: averageValue(totals.resultPassCount, totals.resultEvaluatedRuns),
        averageScore: averageValue(totals.score, runs.length),
        averageProcessScore: averageValue(totals.processScore, runs.length),
        averageOutcomeScore: averageValue(totals.outcomeScore, runs.length),
        averageResultScore: averageValue(totals.resultScore, totals.resultEvaluatedRuns),
        averageToolCalls: averageValue(totals.toolCalls, runs.length),
        averageModelCalls: averageValue(totals.modelCalls, runs.length),
        averageInputTokens: averageValue(totals.inputTokens, runs.length),
        averageOutputTokens: averageValue(totals.outputTokens, runs.length),
        averagePromptInputTokens: averageValue(totals.promptInputTokens, runs.length),
        averageTotalTokens: averageValue(totals.totalTokens, runs.length),
        averagePeakInputTokens: averageValue(totals.peakInputTokens, runs.length),
        averageDurationMs: averageValue(totals.durationMs, runs.length),
        validationRate: averageValue(totals.validationCount, runs.length),
        outputSignalRate: averageValue(totals.outputSignalCount, runs.length),
        dangerRate: averageValue(totals.dangerCount, runs.length),
        failureCount: runs.length - totals.passCount,
        lastRunAt: latest.startedAt
      }
    })
    .sort((a, b) => b.runs - a.runs || b.averageResultScore - a.averageResultScore)
}

function summarizeSkillEvalRunTotals(runs: DashboardSkillEvalRun[]): {
  passCount: number
  resultPassCount: number
  resultEvaluatedRuns: number
  score: number
  processScore: number
  outcomeScore: number
  resultScore: number
  toolCalls: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  promptInputTokens: number
  totalTokens: number
  peakInputTokens: number
  durationMs: number
  validationCount: number
  outputSignalCount: number
  dangerCount: number
} {
  return runs.reduce(
    (acc, run) => {
      acc.passCount += run.pass ? 1 : 0
      if (run.resultGenerated) {
        acc.resultEvaluatedRuns += 1
        acc.resultPassCount += run.resultPass ? 1 : 0
        acc.resultScore += run.resultScore ?? 0
      }
      acc.score += run.score
      acc.processScore += run.processScore
      acc.outcomeScore += run.outcomeScore
      acc.toolCalls += run.totalToolCalls
      acc.modelCalls += run.modelCallCount
      acc.inputTokens += run.totalInputTokens
      acc.outputTokens += run.totalOutputTokens
      acc.promptInputTokens += run.promptInputTokens
      acc.totalTokens += run.totalTokens
      acc.peakInputTokens += run.peakInputTokens
      acc.durationMs += run.durationMs
      acc.validationCount += run.evidence.validationCommands > 0 ? 1 : 0
      acc.outputSignalCount +=
        run.evidence.changedFiles > 0 ||
        run.evidence.artifactSignals > 0 ||
        run.evidence.finalResponseLength >= 20
          ? 1
          : 0
      acc.dangerCount += run.evidence.dangerousCommands > 0 ? 1 : 0
      return acc
    },
    {
      passCount: 0,
      resultPassCount: 0,
      resultEvaluatedRuns: 0,
      score: 0,
      processScore: 0,
      outcomeScore: 0,
      resultScore: 0,
      toolCalls: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      promptInputTokens: 0,
      totalTokens: 0,
      peakInputTokens: 0,
      durationMs: 0,
      validationCount: 0,
      outputSignalCount: 0,
      dangerCount: 0
    }
  )
}

function buildSkillEvalListOnlySummary({
  skillList,
  recentPage,
  recentPageSize,
  skillPage,
  skillPageSize
}: {
  skillList: {
    skills: DashboardSkillEvalSkillSummary[]
    totalTraceHits: number
    totalSkills: number
  }
  recentPage: number
  recentPageSize: number
  skillPage: number
  skillPageSize: number
}): DashboardSkillEvalSummary {
  return {
    ...buildSkillEvalSummaryFromRuns({
      sampleRuns: [],
      recentRuns: [],
      totalTraceHits: skillList.totalTraceHits,
      sampledTraceCount: 0,
      recentTotal: 0,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize,
      skillList: skillList.skills
    }),
    totalTraceHits: skillList.totalTraceHits,
    totalSkills: skillList.totalSkills,
    skills: skillList.skills
  }
}

function isSameSkillVersion(
  record: { skillName: string; skillVersion?: string },
  filter: { skillName: string; skillVersion: string | undefined }
): boolean {
  if (record.skillName !== filter.skillName) return false
  return filter.skillVersion ? (record.skillVersion ?? undefined) === filter.skillVersion : true
}

function skillEvalRecordToDashboardRun(
  record: TraceSkillEvalRecord,
  traceDetail: DashboardTraceDetail,
  traceDetails: DashboardTraceDetail[] = [traceDetail]
): DashboardSkillEvalRun {
  const processScore = record.processScore / 100
  const outcomeScore = record.outcomeScore / 100
  const score = record.score / 100
  const resultScore = record.resultScore !== undefined ? record.resultScore / 100 : undefined

  return {
    traceId: record.traceId,
    threadId: record.threadId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    userMessage: record.userMessage,
    skillName: record.skillName,
    ...(record.skillVersion ? { skillVersion: record.skillVersion } : {}),
    rawSkillName: record.rawSkillName,
    skillTaskId: record.skillTaskId,
    skillTaskTraceIndex: record.skillTaskTraceIndex,
    evalSource: record.evalSource,
    contextTraceIds: [...record.contextTraceIds],
    skillEvalTraceIds: [...record.skillEvalTraceIds],
    contextTraceCount: record.contextTraceCount,
    skillEvalTraceCount: record.skillEvalTraceCount,
    outcome: record.outcome,
    processScore,
    outcomeScore,
    score,
    outcomePass: record.outcomePass,
    pass: record.pass,
    ...(resultScore !== undefined ? { resultScore } : {}),
    resultPass: Boolean(record.resultPass),
    totalToolCalls: record.totalToolCalls,
    modelCallCount: record.modelCallCount,
    totalInputTokens: record.totalInputTokens,
    totalOutputTokens: record.totalOutputTokens,
    promptInputTokens: record.promptInputTokens,
    totalTokens: record.totalTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    peakInputTokens: record.peakInputTokens,
    errorCount: record.errorCount,
    durationMs: record.durationMs,
    checks: record.checks ?? [],
    outcomeChecks: record.outcomeChecks ?? [],
    resultChecks: record.resultChecks ?? [],
    warnings: record.warnings ?? [],
    outcomeWarnings: record.outcomeWarnings ?? [],
    resultWarnings: record.resultWarnings ?? [],
    resultIssues: record.resultIssues ?? [],
    resultArtifacts: record.artifacts ?? [],
    resultGenerated: record.resultStatus === "evaluated",
    traceDetail,
    traceDetails,
    evidence: {
      finalResponseLength: record.evidence.finalResponseLength ?? 0,
      changedFiles: record.evidence.changedFiles ?? 0,
      validationCommands: record.evidence.validationCommands ?? 0,
      artifactSignals: record.evidence.artifactSignals ?? 0,
      dangerousCommands: record.evidence.dangerousCommands ?? 0,
      subagentRuns: record.evidence.subagentRuns ?? 0,
      subagentCompleted: record.evidence.subagentCompleted ?? 0,
      subagentResultLength: record.evidence.subagentResultLength ?? 0,
      subagentFailed: record.evidence.subagentFailed ?? 0,
      toolResultErrors: record.evidence.toolResultErrors ?? 0
    }
  }
}

async function fetchSkillUserStats(
  range: TimeRange,
  granularity: Granularity,
  skillName: string
): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤。
  const traceAccessFilter = null
  void granularity
  const escapedSkillName = escapeWildcard(skillName)
  const wildcardPattern = `${escapedSkillName}**`
  const skillFilter = buildSkillUsageWildcardFilter(skillName)
  const body = {
    size: 0,
    // 统计口径计入全部触发来源；triggerSource 仅用于 trace 分析页切换，不在此过滤。
    query: {
      bool: {
        must: [
          timeRangeFilter("startedAt", range),
          ...(traceAccessFilter ? [traceAccessFilter] : []),
          { exists: { field: "ystId" } },
          { bool: { must_not: { term: { ystId: "" } } } }
        ],
        should: [
          { wildcard: { usedSkills: wildcardPattern } },
          { wildcard: { "usedSkills.keyword": wildcardPattern } }
        ],
        minimum_should_match: 1
      }
    },
    aggs: {
      // 非空 ystId 的去重用户数（用于“使用用户数”展示）
      unique_users_count: { cardinality: { field: "ystId" } },
      // 非空 ystId 的调用总次数（主查询已经过滤了非空用户）
      total_calls: { value_count: { field: "traceId" } },
      // 额外统计空用户调用次数：
      // 通过 global 聚合跳出主查询（主查询已过滤非空用户），
      // 然后重新套用 时间范围 + 技能命中 + 空用户 条件。
      empty_user_calls: {
        global: {},
        aggs: {
          filtered: {
            filter: {
              bool: {
                must: [
                  timeRangeFilter("startedAt", range),
                  ...(traceAccessFilter ? [traceAccessFilter] : []),
                  skillFilter,
                  buildEmptyYstIdFilter()
                ]
              }
            }
          }
        }
      },
      // 非空 ystId 的 Top 用户明细表
      top_users: {
        terms: { field: "ystId", size: 100 },
        aggs: {
          latest_user_info: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: ["userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
              }
            }
          },
          user_name: { terms: { field: "userName", size: 1 } },
          org_name: { terms: { field: "orgName", size: 1 } }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchUserProfilesBySapIds(sapIds: string[]): Promise<unknown> {
  requireDashboardAccess()
  const sanitizedSapIds = Array.from(new Set(sapIds.map((id) => id.trim()).filter(Boolean))).slice(
    0,
    500
  )

  if (sanitizedSapIds.length === 0) {
    return {
      aggregations: {
        by_sap: { buckets: [] }
      }
    }
  }

  const includeShouldFilters = sanitizedSapIds.flatMap((id) => {
    const escaped = escapeWildcard(id)
    const wildcardPattern = `*${escaped}*`
    return [
      { term: { sapId: id } },
      { term: { "sapId.keyword": id } },
      { wildcard: { sapId: wildcardPattern } },
      { wildcard: { "sapId.keyword": wildcardPattern } }
    ]
  })

  // 用户资料查询属于目录/统计数据，不做组织级数据权限过滤。
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: includeShouldFilters,
              minimum_should_match: 1
            }
          }
        ]
      }
    },
    aggs: {
      by_sap: {
        terms: {
          field: "sapId",
          size: Math.min(Math.max(sanitizedSapIds.length * 5, 100), 2000)
        },
        aggs: {
          latest_user_info: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: ["userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
              }
            }
          },
          user_name: { terms: { field: "userName", size: 1 } },
          org_name: { terms: { field: "orgName", size: 1 } }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function queryAllUser(): Promise<DashboardAllUserItem[]> {
  const users: DashboardAllUserItem[] = []
  let afterKey: Record<string, string> | undefined

  do {
    const body = {
      size: 0,
      query: {
        bool: {
          filter: [buildNonEmptySapIdFilter()]
        }
      },
      aggs: {
        by_sap: {
          composite: {
            size: 1000,
            sources: [{ sapId: { terms: { field: "sapId" } } }],
            ...(afterKey ? { after: afterKey } : {})
          },
          aggs: {
            latest_user_info: {
              top_hits: {
                size: 1,
                sort: [{ startedAt: { order: "desc" } }],
                _source: {
                  includes: ["userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
                }
              }
            },
            user_name: { terms: { field: "userName", size: 1 } },
            org_name: { terms: { field: "orgName", size: 1 } }
          }
        }
      }
    }

    const response = (await esQuery(getEsIndex("trace"), body)) as {
      aggregations?: {
        by_sap?: {
          after_key?: Record<string, string>
          buckets?: Array<{
            key?: { sapId?: string }
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

    for (const bucket of response.aggregations?.by_sap?.buckets ?? []) {
      const sapId = String(bucket.key?.sapId || "").trim()
      if (!sapId) continue
      const latestUserInfo = bucket.latest_user_info?.hits?.hits?.[0]?._source
      users.push({
        sapId,
        userName: latestUserInfo?.userName ?? bucket.user_name?.buckets?.[0]?.key ?? "",
        orgName: latestUserInfo?.orgName ?? bucket.org_name?.buckets?.[0]?.key ?? "",
        upperOrgLv0: latestUserInfo?.upperOrgLv0 ?? "",
        upperOrgLv1: latestUserInfo?.upperOrgLv1 ?? ""
      })
    }

    afterKey = response.aggregations?.by_sap?.after_key
  } while (afterKey)

  return users
}

// 返回时间范围内出现过的 LV1 组织列表，用于运营面板顶部的全量组织筛选下拉。
async function fetchOrgOptions(range: TimeRange): Promise<string[]> {
  requireDashboardAccess()
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [timeRangeFilter("startedAt", range)]
      }
    },
    aggs: {
      // missing 把「字段缺失」的文档归到 DASHBOARD_ORG_MISSING_BUCKET；空串("")会单独成桶。
      orgs: { terms: { field: "upperOrgLv1", size: 500, missing: DASHBOARD_ORG_MISSING_BUCKET } }
    }
  }
  const raw = await esQuery(getEsIndex("trace"), body)
  const rawBuckets = asRecord(asRecord(asRecord(raw).aggregations).orgs).buckets
  const buckets = Array.isArray(rawBuckets) ? rawBuckets : []
  const orgs: string[] = []
  let hasUnclassified = false
  for (const bucket of buckets) {
    const record = asRecord(bucket)
    const key = asString(record.key).trim()
    const docCount = asNumber(record.doc_count)
    if (!key || key === DASHBOARD_ORG_MISSING_BUCKET) {
      // 空串 或 字段缺失 → 计入「未归类」
      if (docCount > 0) hasUnclassified = true
      continue
    }
    orgs.push(key)
  }
  const sorted = Array.from(new Set(orgs)).sort((a, b) => a.localeCompare(b, "zh-CN"))
  // 「未归类」固定排在最后，方便区分。
  if (hasUnclassified) sorted.push(DASHBOARD_UNCLASSIFIED_ORG)
  return sorted
}

async function fetchProductivity(
  range: TimeRange,
  granularity: Granularity,
  opts?: OrgFilterOptions
): Promise<unknown> {
  requireDashboardAccess()
  const interval = getCalendarInterval(granularity, range.from, range.to)
  // orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const filters = [
    timeRangeFilter("eventTime", range),
    { term: { eventName: "git.commit.created" } },
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
  const body = {
    size: 0,
    query: {
      bool: {
        filter: filters
      }
    },
    aggs: {
      commit_trend: {
        date_histogram: {
          field: "eventTime",
          calendar_interval: interval,
          time_zone: "Asia/Shanghai"
        }
      },
      total_files_changed: { sum: { field: "properties.filesChanged" } },
      active_users: { cardinality: { field: "sapId" } },
      total_commits: { value_count: { field: "eventId" } }
    }
  }

  // 新增 / 删除行数改为统计 Agent 生成的代码量（code_gen 事件），
  // 而非直接取 git commit 的 insertions / deletions。
  const codeGenFilters = [
    { term: { eventName: "code_gen" } },
    timeRangeFilter("eventTime", range),
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
  const codeBody = {
    size: 0,
    query: { bool: { filter: codeGenFilters } },
    aggs: {
      code_generated_lines: { sum: { field: "properties.lineCount" } },
      code_deleted_lines: { sum: { field: "properties.deletedLineCount" } }
    }
  }

  const [commitRaw, codeRaw] = await Promise.all([
    esQuery(getEsIndex("event"), body),
    esQuery(getEsIndex("event"), codeBody)
  ])
  const commitRecord = asRecord(commitRaw)
  const codeAggs = asRecord(asRecord(codeRaw).aggregations)
  return {
    ...commitRecord,
    aggregations: {
      ...asRecord(commitRecord.aggregations),
      total_insertions: { value: asRecord(codeAggs.code_generated_lines).value ?? 0 },
      total_deletions: { value: asRecord(codeAggs.code_deleted_lines).value ?? 0 }
    }
  }
}

async function fetchFeedback(
  range: TimeRange,
  granularity: Granularity,
  opts?: OrgFilterOptions
): Promise<unknown> {
  requireDashboardAccess()
  const interval = getCalendarInterval(granularity, range.from, range.to)
  // orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const dislikeTypeFilters = Object.fromEntries(
    DISLIKE_TYPE_OPTIONS.map((item) => [
      item.id,
      {
        bool: {
          filter: [
            { term: { eventName: "message.feedback.dislike.submit" } },
            {
              bool: {
                should: [
                  { term: { "properties.dislikeType": item.id } },
                  { term: { "properties.feedbackId": item.id } }
                ],
                minimum_should_match: 1
              }
            }
          ]
        }
      }
    ])
  )

  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("eventTime", range),
          ...(orgFilterClause ? [orgFilterClause] : []),
          {
            terms: {
              eventName: ["message.feedback.like", "message.feedback.dislike.submit"]
            }
          }
        ]
      }
    },
    aggs: {
      total_likes: {
        filter: { term: { eventName: "message.feedback.like" } },
        aggs: {
          unique_users: { cardinality: { field: "sapId" } }
        }
      },
      total_dislikes: {
        filter: { term: { eventName: "message.feedback.dislike.submit" } },
        aggs: {
          unique_users: { cardinality: { field: "sapId" } }
        }
      },
      dislike_by_type: {
        filters: {
          filters: dislikeTypeFilters
        }
      },
      trend: {
        date_histogram: {
          field: "eventTime",
          calendar_interval: interval,
          time_zone: "Asia/Shanghai"
        },
        aggs: {
          likes: {
            filter: { term: { eventName: "message.feedback.like" } }
          },
          dislikes: {
            filter: { term: { eventName: "message.feedback.dislike.submit" } }
          }
        }
      },
      recent_dislike_comments: {
        filter: {
          bool: {
            filter: [
              { term: { eventName: "message.feedback.dislike.submit" } },
              { exists: { field: "properties.dislikeText" } }
            ]
          }
        },
        aggs: {
          latest: {
            top_hits: {
              size: 20,
              sort: [{ eventTime: { order: "desc" } }],
              _source: {
                includes: [
                  "eventTime",
                  "properties.dislikeType",
                  "properties.dislikeTypeLabel",
                  "properties.dislikeText"
                ]
              }
            }
          }
        }
      }
    }
  }

  return esQuery(getEsIndex("event"), body)
}

async function fetchSkillRecentTraces(
  skill: string,
  range: TimeRange,
  limit = 10,
  page = 1,
  mode: TraceViewMode = "trace",
  triggerScope: TraceTriggerScope = "active"
): Promise<{
  traces: DashboardTraceDetail[]
  total: number
  page: number
  pageSize: number
  mode: TraceViewMode
}> {
  const access = requireDashboardAccess()
  const normalizedMode = normalizeTraceViewMode(mode)
  const normalizedTriggerScope = normalizeTraceTriggerScope(triggerScope)
  const size = clampLimit(limit, 10, normalizedMode === "thread" ? 30 : 50)
  const currentPage = clampLimit(page, 1, 1000)
  const filters = [timeRangeFilter("startedAt", range), buildSkillUsageWildcardFilter(skill)]
  // trace 聊天明细列表：按 lv1 组织做数据权限过滤。
  appendOptionalFilter(filters, buildTraceAccessFilter(access))
  if (normalizedTriggerScope === "active") {
    filters.splice(1, 0, buildChatTriggeredTraceFilter())
  }
  const sourceIncludes = dashboardTraceSourceIncludes()

  if (normalizedMode === "thread") {
    // 与用户页 thread 视图共用同一套「按会话分页 + 完整会话」逻辑：每页 size 个完整会话，
    // 每会话最多 THREAD_LIST_TRACES_PER_THREAD 条，封顶 MAX_THREAD_LIST_BUCKETS 个会话。
    const body = {
      size: 0,
      query: {
        bool: { filter: filters }
      },
      aggs: threadListAgg(threadListBucketsNeeded(currentPage, size))
    }
    const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
    const aggs = asRecord((raw as unknown as Record<string, unknown>).aggregations)
    const { traces, totalThreads } = parseThreadListContainer(aggs, currentPage, size)
    return {
      traces,
      total: totalThreads,
      page: currentPage,
      pageSize: size,
      mode: normalizedMode
    }
  }

  const body = {
    track_total_hits: true,
    from: (currentPage - 1) * size,
    size,
    sort: [{ startedAt: { order: "desc" } }],
    query: {
      bool: {
        filter: filters
      }
    },
    _source: {
      includes: sourceIncludes
    }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  return {
    traces: (raw.hits?.hits ?? []).map(normalizeTraceDetail),
    total: getTotalHits(raw, raw.hits?.hits?.length ?? 0),
    page: currentPage,
    pageSize: size,
    mode: normalizedMode
  }
}

// 单个 thread 的完整 trace 列表，用于「Thread 对话还原」抽屉展开时还原完整会话。
// 与 fetchSkillRecentTraces 的 thread 概览不同，这里：
// - 仅按 threadId 精确匹配，不做时间窗裁剪（避免丢掉 thread 开头早于所选时间范围的 trace）；
// - 不做 skill / 主动触发过滤（还原真实完整会话）；
// - 仍保留组织级数据权限过滤；
// - 按 startedAt 升序返回（从首条到末条），上限 MAX_THREAD_TRACES 防止单 thread 过大撑爆查询。
const MAX_THREAD_TRACES = 200

async function fetchThreadTraces(threadId: string): Promise<DashboardTraceDetail[]> {
  const access = requireDashboardAccess()
  const trimmed = threadId?.trim?.() ?? ""
  if (!trimmed) return []
  const filters: Record<string, unknown>[] = [{ term: { threadId: trimmed } }]
  appendOptionalFilter(filters, buildTraceAccessFilter(access))
  const body = {
    track_total_hits: false,
    size: MAX_THREAD_TRACES,
    sort: [{ startedAt: { order: "asc" } }],
    query: { bool: { filter: filters } },
    _source: { includes: dashboardTraceSourceIncludes() }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  return (raw.hits?.hits ?? []).map(normalizeTraceDetail)
}

async function fetchSkillCodeStats(skill: string, range: TimeRange): Promise<DashboardCodeStats> {
  requireDashboardAccess()
  const skillTerms = getSkillIdentifierLookupTerms(skill)
  const codeGenFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_gen" } },
    timeRangeFilter("eventTime", range),
    { terms: { "properties.usedSkills": skillTerms } }
  ]
  const codeAdoptFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_adopt" } },
    { exists: { field: "properties.adoptedLineCount" } },
    { exists: { field: "properties.generatedLineCount" } },
    { exists: { field: "properties.effectiveGeneratedLineCount" } },
    timeRangeFilter("properties.generatedAt", range),
    { terms: { "properties.usedSkills": skillTerms } }
  ]
  const codeAdoptPushedFilters: Record<string, unknown>[] = [
    ...codeAdoptFilters,
    { term: { "properties.pushed": true } }
  ]
  const body = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: {
      code_gen: {
        filter: { bool: { filter: codeGenFilters } },
        aggs: {
          generated_lines: { sum: { field: "properties.lineCount" } },
          deleted_lines: { sum: { field: "properties.deletedLineCount" } }
        }
      },
      code_adopt_measured: {
        filter: { bool: { filter: codeAdoptFilters } },
        aggs: {
          measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
          effective_generated_lines: effectiveGeneratedLinesSumAgg(),
          adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
        }
      },
      code_adopt_pushed: {
        filter: { bool: { filter: codeAdoptPushedFilters } },
        aggs: codeAdoptPushedAggs()
      }
    }
  }
  const raw = await esQuery(getEsIndex("event"), body)
  return normalizeCodeStatsFromAggs(raw)
}

async function fetchSkillDetail(
  skill: string,
  range: TimeRange,
  options?: number | TracePageOptions
): Promise<DashboardSkillDetail> {
  const pageOptions = typeof options === "number" ? { limit: options } : options
  const traceViewMode = normalizeTraceViewMode(pageOptions?.viewMode ?? pageOptions?.mode)
  const traceTriggerScope = normalizeTraceTriggerScope(pageOptions?.triggerScope)
  const tracePageSize = clampLimit(
    pageOptions?.pageSize ?? pageOptions?.limit,
    10,
    traceViewMode === "thread" ? 30 : 50
  )
  const tracePage = clampLimit(pageOptions?.page, 1, 1000)
  const [stats, tracePageData] = await Promise.all([
    fetchSkillCodeStats(skill, range),
    fetchSkillRecentTraces(skill, range, tracePageSize, tracePage, traceViewMode, traceTriggerScope)
  ])
  return {
    stats,
    traces: tracePageData.traces,
    tracePage: tracePageData.page,
    tracePageSize: tracePageData.pageSize,
    totalTraces: tracePageData.total,
    traceViewMode: tracePageData.mode,
    traceTriggerScope
  }
}

async function fetchCommitDetails(
  range: TimeRange,
  options?: number | CommitDetailsOptions
): Promise<{
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
}> {
  requireDashboardAccess()
  const { page, pageSize, pushedOnly, upperOrgLv1, orgLv1List } =
    normalizeCommitDetailsOptions(options)
  const filters: Record<string, unknown>[] = [
    timeRangeFilter("eventTime", range),
    { term: { eventName: "git.commit.created" } }
  ]
  if (pushedOnly) {
    filters.push({ term: { "properties.pushed": true } })
  }
  // 全局「室筛选」（多选 LV1，含未归类）
  appendOptionalFilter(filters, buildUpperOrgLv1ListFilter(orgLv1List))
  // 弹窗内的部门搜索（单值，模糊匹配 LV1/LV0）
  if (upperOrgLv1 !== null) {
    filters.push(buildOrgLevelMatchFilter(upperOrgLv1))
  }
  const body = {
    track_total_hits: true,
    from: (page - 1) * pageSize,
    size: pageSize,
    sort: [{ eventTime: { order: "desc" } }],
    query: {
      bool: {
        filter: filters
      }
    },
    _source: {
      includes: [
        "eventId",
        "eventTime",
        "eventName",
        "userName",
        "userIp",
        "sapId",
        "ystId",
        "orgName",
        "upperOrgLv0",
        "upperOrgLv1",
        "properties.repoPath",
        "properties.repositoryName",
        "properties.repositoryFullName",
        "properties.repositoryWebUrl",
        "properties.commitSha",
        "properties.commitUrl",
        "properties.pushed",
        "properties.pushedAt",
        "properties.branch",
        "properties.filesChanged",
        "properties.insertions",
        "properties.deletions",
        "properties.triggeredBy",
        "properties.threadId",
        "properties.usedSkills",
        "properties.skillCount"
      ]
    }
  }
  const raw = (await esQuery(getEsIndex("event"), body)) as EsSearchResponse
  const hits = raw.hits?.hits ?? []
  const items = hits.map(normalizeCommitDetail)
  const adoptionMap = await fetchCommitAdoptionMap(
    items.map((item) => item.commitSha ?? "").filter(Boolean)
  )
  return {
    total: getTotalHits(raw, hits.length),
    page,
    pageSize,
    pushedOnly,
    items: items.map((item) => {
      const adoption = item.commitSha ? adoptionMap.get(item.commitSha) : undefined
      const adoptedSkills = adoption?.usedSkills ?? []
      return {
        ...item,
        usedSkills: adoptedSkills,
        skillCount: adoptedSkills.length,
        codeGeneratedLines: adoption?.generatedLines ?? 0,
        codeEffectiveGeneratedLines: adoption?.effectiveGeneratedLines ?? 0,
        codeAdoptedLines: adoption?.adoptedLines ?? 0,
        codeAdoptionRate: adoption?.adoptionRate ?? null
      }
    })
  }
}

// ─────────────────────────────────────────────────────────
// Dev mock data
// ─────────────────────────────────────────────────────────

function makeMockOrgOptions(): string[] {
  return ["测试 1 部", "开发二部", "平台三部", DASHBOARD_UNCLASSIFIED_ORG]
}

function getMockOrgScale(opts?: OrgFilterOptions): number {
  const selectedOrgs = normalizeUpperOrgLv1List(opts?.upperOrgLv1)
  if (selectedOrgs.length === 0) return 1

  const weights = new Map<string, number>([
    ["测试 1 部", 0.62],
    ["开发二部", 0.22],
    ["平台三部", 0.16],
    [DASHBOARD_UNCLASSIFIED_ORG, 0.04]
  ])
  return Math.min(
    1,
    selectedOrgs.reduce((sum, org) => sum + (weights.get(org) ?? 0), 0)
  )
}

function scaleMockMetricNumber(value: number, scale: number): number {
  if (!Number.isFinite(value) || scale >= 0.999) return value
  if (scale <= 0) return 0
  return Math.max(1, Math.round(value * scale))
}

function shouldScaleMockMetric(key: string, path: string[]): boolean {
  if (key === "doc_count") return true
  if (key !== "value") return false
  const parentKey = path[path.length - 1] ?? ""
  return !/rate/i.test(parentKey)
}

function scaleMockDashboardValue(value: unknown, scale: number, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      scaleMockDashboardValue(item, scale, [...path, String(index)])
    )
  }
  if (value === null || typeof value !== "object") return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      typeof child === "number" && shouldScaleMockMetric(key, path)
        ? scaleMockMetricNumber(child, scale)
        : scaleMockDashboardValue(child, scale, [...path, key])
  }
  return result
}

function scaleMockDashboardResponse<T>(response: T, opts?: OrgFilterOptions): T {
  const scale = getMockOrgScale(opts)
  if (scale >= 0.999) return response
  return scaleMockDashboardValue(response, scale) as T
}

/**
 * 深度缩放任意已解析对象里的计数型数字（跳过 *rate 比率字段），用于项目模式 mock
 * 这类返回结构与原始 ES 桶不同（字段为 conversationCount/tokens 等）的聚合块。
 */
function deepScaleMockMetrics<T>(value: T, scale: number): T {
  if (scale >= 0.999) return value
  if (Array.isArray(value)) {
    return value.map((item) => deepScaleMockMetrics(item, scale)) as unknown as T
  }
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      typeof child === "number" && !/rate/i.test(key)
        ? scaleMockMetricNumber(child, scale)
        : deepScaleMockMetrics(child, scale)
  }
  return out as T
}

/**
 * 给 DEV mock 项目按下标确定性地分配一个 LV1 室，使「室筛选」在 mock 下也能
 * 真实改变项目列表（与生产快照按 upperOrgLv1 过滤的语义一致）。
 */
function mockProjectOrgAt(index: number): string {
  const orgs = makeMockOrgOptions()
  return orgs[index % orgs.length]
}

function mockProjectMatchesOrg(org: string, selectedOrgs: string[]): boolean {
  if (selectedOrgs.length === 0) return true
  return selectedOrgs.some((sel) =>
    sel === DASHBOARD_UNCLASSIFIED_ORG ? org === DASHBOARD_UNCLASSIFIED_ORG : sel === org
  )
}

function makeMockOverview(range: TimeRange, opts?: OrgFilterOptions): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  // Align buckets to calendar boundaries, same as ES calendar_interval
  const buckets: Date[] = []
  if (diffDays <= 1) {
    // hour-aligned buckets
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else if (diffDays <= 14) {
    // day-aligned buckets
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else {
    // week-aligned buckets (Monday)
    const start = new Date(from)
    const day = start.getDay()
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  }

  const trend = buckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: Math.floor(30 + Math.random() * 80),
    users: { value: Math.floor(5 + Math.random() * 20) }
  }))

  return scaleMockDashboardResponse(
    {
      aggregations: {
        total_calls: { value: 1247 },
        active_users: { value: 38 },
        avg_duration: { value: 4320 },
        total_input_tokens: { value: 2_340_000 },
        total_output_tokens: { value: 890_000 },
        total_skills: { value: 20 },
        total_tools: { value: 27 },
        total_skill_calls: { value: 2022 },
        total_tool_calls: { value: 6538 },
        code_generated_lines: { value: 4820 },
        code_deleted_lines: { value: 930 },
        code_measured_generated_lines: { value: 3900 },
        code_effective_generated_lines: { value: 3720 },
        code_unmeasured_generated_lines: { value: 920 },
        code_inclusive_effective_generated_lines: { value: 4640 },
        code_adopted_lines: { value: 2860 },
        code_pushed_measured_generated_lines: { value: 2500 },
        code_pushed_effective_generated_lines: { value: 2360 },
        code_pushed_adopted_lines: { value: 1880 },
        code_pushed_commit_count: { value: 21 },
        by_skill: {
          buckets: [
            { key: "代码审查", doc_count: 312 },
            { key: "需求分析", doc_count: 278 },
            { key: "文档生成", doc_count: 245 },
            { key: "单元测试", doc_count: 198 },
            { key: "SQL优化", doc_count: 167 },
            { key: "plugin-release-note-v1.0.0", doc_count: 156 },
            { key: "接口设计", doc_count: 143 },
            { key: "日志分析", doc_count: 121 },
            { key: "数据清洗", doc_count: 98 },
            { key: "性能诊断", doc_count: 87 },
            { key: "安全扫描", doc_count: 62 },
            { key: "代码重构", doc_count: 54 },
            { key: "异常排查", doc_count: 49 },
            { key: "接口联调", doc_count: 44 },
            { key: "依赖升级", doc_count: 38 },
            { key: "配置检查", doc_count: 33 },
            { key: "发布诊断", doc_count: 29 },
            { key: "性能优化", doc_count: 24 },
            { key: "埋点分析", doc_count: 18 },
            { key: "前端走查", doc_count: 13 },
            { key: "脚本生成", doc_count: 9 }
          ]
        },
        by_skill_all: {
          buckets: [
            { key: "代码审查", doc_count: 312 },
            { key: "需求分析", doc_count: 278 },
            { key: "文档生成", doc_count: 245 },
            { key: "单元测试", doc_count: 198 },
            { key: "SQL优化", doc_count: 167 },
            { key: "plugin-release-note-v1.0.0", doc_count: 156 },
            { key: "接口设计", doc_count: 143 },
            { key: "日志分析", doc_count: 121 },
            { key: "数据清洗", doc_count: 98 },
            { key: "性能诊断", doc_count: 87 },
            { key: "安全扫描", doc_count: 62 },
            { key: "代码重构", doc_count: 54 },
            { key: "异常排查", doc_count: 49 },
            { key: "接口联调", doc_count: 44 },
            { key: "依赖升级", doc_count: 38 },
            { key: "配置检查", doc_count: 33 },
            { key: "发布诊断", doc_count: 29 },
            { key: "性能优化", doc_count: 24 },
            { key: "埋点分析", doc_count: 18 },
            { key: "前端走查", doc_count: 13 },
            { key: "脚本生成", doc_count: 9 },
            { key: "冒烟测试", doc_count: 8 },
            { key: "链路排查", doc_count: 7 },
            { key: "Schema 校验", doc_count: 6 },
            { key: "接口 Mock", doc_count: 5 },
            { key: "灰度检查", doc_count: 4 }
          ]
        },
        code_by_skill_adoption: {
          buckets: [
            {
              key: "代码审查",
              generated_lines: { value: 850 },
              measured_generated_lines: { value: 760 },
              effective_generated_lines: { value: 700 },
              unmeasured_generated_lines: { value: 90 },
              inclusive_effective_generated_lines: { value: 790 },
              adopted_lines: { value: 511 },
              measured_adoption_rate: { value: 511 / 700 },
              inclusive_adoption_rate: { value: 511 / 790 },
              pushed_measured_generated_lines: { value: 520 },
              pushed_effective_generated_lines: { value: 490 },
              pushed_adopted_lines: { value: 380 },
              pushed_adoption_rate: { value: 380 / 490 },
              pushed_commit_count: { value: 8 },
              commit_count: { value: 18 }
            },
            {
              key: "单元测试",
              generated_lines: { value: 620 },
              measured_generated_lines: { value: 620 },
              effective_generated_lines: { value: 560 },
              unmeasured_generated_lines: { value: 0 },
              inclusive_effective_generated_lines: { value: 560 },
              adopted_lines: { value: 470 },
              measured_adoption_rate: { value: 470 / 560 },
              inclusive_adoption_rate: { value: 470 / 560 },
              pushed_measured_generated_lines: { value: 420 },
              pushed_effective_generated_lines: { value: 380 },
              pushed_adopted_lines: { value: 340 },
              pushed_adoption_rate: { value: 340 / 380 },
              pushed_commit_count: { value: 6 },
              commit_count: { value: 12 }
            },
            {
              key: "SQL优化",
              generated_lines: { value: 460 },
              measured_generated_lines: { value: 360 },
              effective_generated_lines: { value: 330 },
              unmeasured_generated_lines: { value: 100 },
              inclusive_effective_generated_lines: { value: 430 },
              adopted_lines: { value: 260 },
              measured_adoption_rate: { value: 260 / 330 },
              inclusive_adoption_rate: { value: 260 / 430 },
              pushed_measured_generated_lines: { value: 200 },
              pushed_effective_generated_lines: { value: 180 },
              pushed_adopted_lines: { value: 140 },
              pushed_adoption_rate: { value: 140 / 180 },
              pushed_commit_count: { value: 3 },
              commit_count: { value: 7 }
            },
            {
              key: "plugin-release-note-v1.0.0",
              generated_lines: { value: 410 },
              measured_generated_lines: { value: 360 },
              effective_generated_lines: { value: 340 },
              unmeasured_generated_lines: { value: 50 },
              inclusive_effective_generated_lines: { value: 390 },
              adopted_lines: { value: 255 },
              measured_adoption_rate: { value: 255 / 340 },
              inclusive_adoption_rate: { value: 255 / 390 },
              pushed_measured_generated_lines: { value: 260 },
              pushed_effective_generated_lines: { value: 245 },
              pushed_adopted_lines: { value: 180 },
              pushed_adoption_rate: { value: 180 / 245 },
              pushed_commit_count: { value: 4 },
              commit_count: { value: 9 }
            },
            {
              key: "接口设计",
              generated_lines: { value: 380 },
              measured_generated_lines: { value: 0 },
              effective_generated_lines: { value: 0 },
              unmeasured_generated_lines: { value: 380 },
              inclusive_effective_generated_lines: { value: 380 },
              adopted_lines: { value: 0 },
              measured_adoption_rate: { value: null },
              inclusive_adoption_rate: { value: 0 },
              pushed_measured_generated_lines: { value: 0 },
              pushed_effective_generated_lines: { value: 0 },
              pushed_adopted_lines: { value: 0 },
              pushed_adoption_rate: { value: null },
              pushed_commit_count: { value: 0 },
              commit_count: { value: 0 }
            }
          ]
        },
        by_tool: {
          buckets: [
            { key: "git_workflow", doc_count: 412 },
            { key: "browser_playwright", doc_count: 356 },
            { key: "manage_skill", doc_count: 298 },
            { key: "manage_scheduler", doc_count: 241 },
            { key: "web_search", doc_count: 198 },
            { key: "db_query", doc_count: 163 },
            { key: "create_pr", doc_count: 134 },
            { key: "run_tests", doc_count: 112 },
            { key: "search_code", doc_count: 98 },
            { key: "notify", doc_count: 76 },
            { key: "query_logs", doc_count: 68 },
            { key: "schema_check", doc_count: 59 },
            { key: "open_preview", doc_count: 53 },
            { key: "analyze_diff", doc_count: 47 },
            { key: "format_code", doc_count: 42 },
            { key: "lint_fix", doc_count: 36 },
            { key: "dependency_audit", doc_count: 31 },
            { key: "deploy_check", doc_count: 26 },
            { key: "trace_lookup", doc_count: 19 },
            { key: "ticket_update", doc_count: 12 }
          ]
        },
        by_tool_filtered_all: {
          buckets: [
            { key: "git_workflow", doc_count: 412 },
            { key: "browser_playwright", doc_count: 356 },
            { key: "manage_skill", doc_count: 298 },
            { key: "manage_scheduler", doc_count: 241 },
            { key: "web_search", doc_count: 198 },
            { key: "db_query", doc_count: 163 },
            { key: "create_pr", doc_count: 134 },
            { key: "run_tests", doc_count: 112 },
            { key: "search_code", doc_count: 98 },
            { key: "notify", doc_count: 76 },
            { key: "query_logs", doc_count: 68 },
            { key: "schema_check", doc_count: 59 },
            { key: "open_preview", doc_count: 53 },
            { key: "analyze_diff", doc_count: 47 },
            { key: "format_code", doc_count: 42 },
            { key: "lint_fix", doc_count: 36 },
            { key: "dependency_audit", doc_count: 31 },
            { key: "deploy_check", doc_count: 26 },
            { key: "trace_lookup", doc_count: 19 },
            { key: "ticket_update", doc_count: 12 },
            { key: "mcp_sqlQuery", doc_count: 11 },
            { key: "browser_visualDiff", doc_count: 9 },
            { key: "workflow_template", doc_count: 7 }
          ]
        },
        by_tool_all: {
          buckets: [
            { key: "read_file", doc_count: 1823 },
            { key: "write_file", doc_count: 1245 },
            { key: "execute", doc_count: 987 },
            { key: "grep", doc_count: 876 },
            { key: "glob", doc_count: 654 },
            { key: "git_workflow", doc_count: 412 },
            { key: "browser_playwright", doc_count: 356 },
            { key: "manage_skill", doc_count: 298 },
            { key: "edit_file", doc_count: 267 },
            { key: "manage_scheduler", doc_count: 241 },
            { key: "web_search", doc_count: 198 },
            { key: "list_directory", doc_count: 187 },
            { key: "db_query", doc_count: 163 },
            { key: "task", doc_count: 156 },
            { key: "task_output", doc_count: 148 },
            { key: "create_pr", doc_count: 134 },
            { key: "search_tool", doc_count: 128 },
            { key: "run_tests", doc_count: 112 },
            { key: "search_code", doc_count: 98 },
            { key: "code_exec", doc_count: 92 }
          ]
        },
        by_tool_all_full: {
          buckets: [
            { key: "read_file", doc_count: 1823 },
            { key: "write_file", doc_count: 1245 },
            { key: "execute", doc_count: 987 },
            { key: "grep", doc_count: 876 },
            { key: "glob", doc_count: 654 },
            { key: "git_workflow", doc_count: 412 },
            { key: "browser_playwright", doc_count: 356 },
            { key: "manage_skill", doc_count: 298 },
            { key: "edit_file", doc_count: 267 },
            { key: "manage_scheduler", doc_count: 241 },
            { key: "web_search", doc_count: 198 },
            { key: "list_directory", doc_count: 187 },
            { key: "db_query", doc_count: 163 },
            { key: "task", doc_count: 156 },
            { key: "task_output", doc_count: 148 },
            { key: "create_pr", doc_count: 134 },
            { key: "search_tool", doc_count: 128 },
            { key: "run_tests", doc_count: 112 },
            { key: "search_code", doc_count: 98 },
            { key: "code_exec", doc_count: 92 },
            { key: "prepare_save_code_exec_tool", doc_count: 81 },
            { key: "notify", doc_count: 76 },
            { key: "query_logs", doc_count: 68 },
            { key: "schema_check", doc_count: 59 },
            { key: "open_preview", doc_count: 53 }
          ]
        },
        trend: { buckets: trend }
      }
    },
    opts
  )
}

function makeMockModelStats(opts?: OrgFilterOptions): unknown {
  return scaleMockDashboardResponse(
    {
      aggregations: {
        by_model: {
          buckets: [
            {
              key: "claude-sonnet-4-6",
              doc_count: 620,
              success_count: { doc_count: 578 },
              avg_duration: { value: 3800 },
              total_input_tokens: { value: 1_200_000 },
              total_output_tokens: { value: 430_000 }
            },
            {
              key: "claude-opus-4-6",
              doc_count: 280,
              success_count: { doc_count: 265 },
              avg_duration: { value: 8200 },
              total_input_tokens: { value: 780_000 },
              total_output_tokens: { value: 310_000 }
            },
            {
              key: "claude-haiku-4-5",
              doc_count: 347,
              success_count: { doc_count: 259 },
              avg_duration: { value: 1100 },
              total_input_tokens: { value: 360_000 },
              total_output_tokens: { value: 150_000 }
            }
          ]
        },
        by_tier: {
          buckets: [
            { key: "high", doc_count: 280 },
            { key: "medium", doc_count: 620 },
            { key: "low", doc_count: 347 }
          ]
        },
        by_layer: {
          buckets: [
            { key: "user_explicit", doc_count: 210 },
            { key: "skill_override", doc_count: 390 },
            { key: "auto_routing", doc_count: 647 }
          ]
        }
      }
    },
    opts
  )
}

function makeMockUserStats(range: TimeRange, opts?: UserStatsOptions): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  const selectedOrgs = normalizeUpperOrgLv1List(opts?.upperOrgLv1)
  const hasSelectedOrgs = selectedOrgs.length > 0
  const selectedUpperOrgLv1 = selectedOrgs.length === 1 ? selectedOrgs[0] : null

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000))
      trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000))
      trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: 0,
    users: { value: Math.floor(3 + Math.random() * 15) }
  }))

  const allLv1OrgBuckets = [
    { key: "测试 1 部", doc_count: 748, unique_users: { value: 60 } },
    { key: "开发二部", doc_count: 245, unique_users: { value: 20 } },
    { key: "平台三部", doc_count: 189, unique_users: { value: 15 } }
  ]
  const byOrgBuckets =
    selectedUpperOrgLv1 === "测试 1 部"
      ? [
          { key: "测试 1 组", doc_count: 430, unique_users: { value: 36 } },
          { key: "测试 2 组", doc_count: 318, unique_users: { value: 24 } }
        ]
      : selectedUpperOrgLv1 === "开发二部"
        ? [{ key: "开发三组", doc_count: 245, unique_users: { value: 20 } }]
        : selectedUpperOrgLv1 === "平台三部"
          ? [{ key: "平台一组", doc_count: 189, unique_users: { value: 15 } }]
          : hasSelectedOrgs
            ? allLv1OrgBuckets.filter((bucket) => selectedOrgs.includes(bucket.key))
            : allLv1OrgBuckets

  const makeOrgAgg = (buckets: typeof byOrgBuckets): Record<string, unknown> => {
    const docCount = buckets.reduce((sum, bucket) => sum + bucket.doc_count, 0)
    return { doc_count: docCount, items: { buckets } }
  }
  const byOrgPv = makeOrgAgg(byOrgBuckets)
  const byOrgUv = makeOrgAgg(byOrgBuckets)

  const allTopUserBuckets = [
    {
      key: "10010001",
      doc_count: 142,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "张三",
                orgName: "测试 1 组",
                upperOrgLv1: "测试 1 部",
                upperOrgLv0: "测试 1 组",
                appVersion: "1.3.0"
              }
            }
          ]
        }
      }
    },
    {
      key: "10010002",
      doc_count: 118,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "李四",
                orgName: "测试 2 组",
                upperOrgLv1: "测试 1 部",
                upperOrgLv0: "测试 2 组",
                appVersion: "1.2.5"
              }
            }
          ]
        }
      }
    },
    {
      key: "10010003",
      doc_count: 97,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "王五",
                orgName: "开发三组",
                upperOrgLv1: "开发二部",
                upperOrgLv0: "开发三组",
                appVersion: "1.3.0"
              }
            }
          ]
        }
      }
    },
    {
      key: "10010004",
      doc_count: 85,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "赵六",
                orgName: "测试 1 组",
                upperOrgLv1: "测试 1 部",
                upperOrgLv0: "测试 1 组",
                appVersion: "1.2.0"
              }
            }
          ]
        }
      }
    },
    {
      key: "10010005",
      doc_count: 73,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "钱七",
                orgName: "平台一组",
                upperOrgLv1: "平台三部",
                upperOrgLv0: "平台一组",
                appVersion: "1.3.0"
              }
            }
          ]
        }
      }
    },
    {
      key: "10010006",
      doc_count: 61,
      latest_user_info: {
        hits: {
          hits: [
            {
              sort: ["2026-04-21T10:00:00.000Z"],
              _source: {
                userName: "孙八",
                orgName: "开发三组",
                upperOrgLv1: "开发二部",
                upperOrgLv0: "开发三组",
                appVersion: "1.1.8"
              }
            }
          ]
        }
      }
    }
  ]
  const topUserBuckets = !hasSelectedOrgs
    ? allTopUserBuckets
    : allTopUserBuckets.filter((bucket) =>
        selectedOrgs.includes(bucket.latest_user_info.hits.hits[0]._source.upperOrgLv1)
      )

  const byVersionBuckets = !hasSelectedOrgs
    ? [
        { key: "1.3.0", doc_count: 512, unique_users: { value: 98 } },
        { key: "1.2.5", doc_count: 298, unique_users: { value: 62 } },
        { key: "1.2.0", doc_count: 187, unique_users: { value: 41 } },
        { key: "1.1.x", doc_count: 143, unique_users: { value: 28 } },
        { key: "1.0.x", doc_count: 107, unique_users: { value: 19 } }
      ]
    : [
        {
          key: "1.3.0",
          doc_count: Math.max(12, byOrgBuckets[0]?.doc_count ?? 0),
          unique_users: { value: Math.max(3, topUserBuckets.length) }
        },
        {
          key: "1.2.5",
          doc_count: Math.max(
            6,
            Math.floor((byOrgBuckets[1]?.doc_count ?? byOrgBuckets[0]?.doc_count ?? 0) * 0.4)
          ),
          unique_users: { value: Math.max(1, Math.ceil(topUserBuckets.length / 2)) }
        }
      ]

  return {
    aggregations: {
      top_users: {
        buckets: topUserBuckets
      },
      by_org: byOrgPv,
      by_org_pv: byOrgPv,
      by_org_uv: byOrgUv,
      by_version: {
        buckets: byVersionBuckets
      },
      user_trend: { buckets: trend }
    }
  }
}

function makeMockSkillUsageSummary(range: TimeRange): unknown {
  const overview = makeMockOverview(range) as {
    aggregations?: { by_skill?: { buckets?: Array<{ key: string; doc_count: number }> } }
  }
  return {
    aggregations: {
      by_skill: {
        buckets: (overview.aggregations?.by_skill?.buckets ?? []).map((bucket) => ({
          ...bucket,
          unique_users: { value: Math.max(1, Math.floor(bucket.doc_count * 0.35)) }
        }))
      }
    }
  }
}

function makeMockSkillEvalSummary(
  range: TimeRange,
  options?: DashboardSkillEvalOptions
): DashboardSkillEvalSummary {
  const {
    sampleLimit,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    skillSearch,
    skillName,
    skillVersion,
    skillNames,
    skillNamesProvided,
    defaultRecentToLatestSkill,
    listOnly,
    statsOnly
  } = normalizeSkillEvalOptions(options)
  const skills = ["代码审查-v1.0.0", "单元测试-v1.1.0", "SQL优化-v2.0.0", "前端走查-v1.3.0"]
  const filteredSkills = skillName
    ? skills.filter((skill) => {
        const parsed = parseMockSkillIdentifier(skill)
        return (
          parsed.skillName === skillName &&
          (skillVersion ? parsed.skillVersion === skillVersion : true)
        )
      })
    : skillNames.length > 0
      ? skills.filter((skill) => skillNames.includes(parseMockSkillIdentifier(skill).skillName))
      : skillNamesProvided
        ? []
        : skills

  const traces = filteredSkills.flatMap((skill) =>
    Array.from({ length: 8 }, (_, index) => makeMockAgentTrace(skill, range, index))
  )
  const records = traces.flatMap((trace) => trace.skillEval?.records ?? [])
  const traceDetails = new Map(
    traces.map((trace) => [trace.traceId, traceToDashboardTraceDetail(trace)] as const)
  )
  const allowedSkillNames = skillNames.length > 0 ? new Set(skillNames) : undefined
  const explicitFilter: SkillEvalExactFilter | undefined = skillName
    ? { skillName, skillVersion }
    : undefined
  const namesFilter: SkillEvalNamesFilter | undefined =
    skillNames.length > 0 ? { skillNames } : undefined
  const baseFilter = explicitFilter ?? namesFilter
  const allRuns = skillEvalStoredRecordsToDashboardRuns(
    records,
    traceDetails,
    baseFilter,
    allowedSkillNames
  )
    .filter((run) => matchesSkillSearch(run.skillName, skillSearch))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())

  const allSkillList = buildSkillEvalSummaryFromRuns({
    sampleRuns: allRuns,
    recentRuns: [],
    totalTraceHits: allRuns.length,
    sampledTraceCount: allRuns.length,
    recentTotal: 0,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    allowedSkillNames
  }).skills
  const skillFrom = (skillPage - 1) * skillPageSize
  const skillList = {
    skills: allSkillList.slice(skillFrom, skillFrom + skillPageSize),
    totalTraceHits: allRuns.length,
    totalSkills: allSkillList.length
  }
  if (listOnly) {
    return buildSkillEvalListOnlySummary({
      skillList,
      recentPage,
      recentPageSize,
      skillPage,
      skillPageSize
    })
  }

  const latestFilter =
    !explicitFilter && defaultRecentToLatestSkill
      ? getFirstSkillFilterFromSummaries(skillList.skills)
      : undefined
  const recentFilter = explicitFilter ?? latestFilter
  const filteredRuns = filterSkillEvalRunsByFilter(allRuns, recentFilter)
  const sampleRuns = filteredRuns.slice(0, sampleLimit)
  const recentFrom = (recentPage - 1) * recentPageSize
  const recentRuns = statsOnly ? [] : filteredRuns.slice(recentFrom, recentFrom + recentPageSize)
  const summary = buildSkillEvalSummaryFromRuns({
    sampleRuns,
    recentRuns,
    totalTraceHits: filteredRuns.length,
    sampledTraceCount: sampleRuns.length,
    recentTotal: statsOnly ? 0 : filteredRuns.length,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    ...(recentFilter ? { recentSkillFilter: recentFilter } : {}),
    allowedSkillNames,
    ...(!explicitFilter ? { skillList: skillList.skills } : {})
  })

  return !explicitFilter
    ? {
        ...summary,
        totalTraceHits: skillList.totalTraceHits,
        totalSkills: skillList.totalSkills
      }
    : summary
}

function filterSkillEvalRunsByFilter(
  runs: DashboardSkillEvalRun[],
  filter?: SkillEvalFilter
): DashboardSkillEvalRun[] {
  if (isSkillEvalExactFilter(filter)) {
    return runs.filter((run) => isSameSkillVersion(run, filter))
  }
  if (filter?.skillNames && filter.skillNames.length > 0) {
    const allowed = new Set(filter.skillNames)
    return runs.filter((run) => allowed.has(normalizeSkillQueryName(run.skillName)))
  }
  return runs
}

function parseMockSkillIdentifier(skill: string): { skillName: string; skillVersion?: string } {
  const match = skill.match(/^(.*?)-(v\d+(?:\.\d+){0,3})$/)
  if (!match) return { skillName: skill }
  return { skillName: match[1], skillVersion: match[2] }
}

function makeMockSkillUserStats(range: TimeRange, skillName: string): unknown {
  const userStats = makeMockUserStats(range) as {
    aggregations?: {
      top_users?: {
        buckets?: Array<{
          key: string
          doc_count: number
          user_name?: { buckets?: Array<{ key: string }> }
          org_name?: { buckets?: Array<{ key: string }> }
        }>
      }
    }
  }
  const topUsers = userStats.aggregations?.top_users?.buckets ?? []
  const offset = Math.abs(Array.from(skillName).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)) % 7
  const picked = topUsers.slice(0, Math.max(3, 6 - offset))
  const totalCalls = picked.reduce((sum, item) => sum + item.doc_count, 0)
  // 模拟环境下给出一个小比例空用户调用，便于前端联调空用户行展示。
  const emptyUserCalls = Math.floor(totalCalls * 0.08)

  return {
    aggregations: {
      total_calls: { value: totalCalls },
      total_users: { value: picked.length },
      unique_users_count: { value: picked.length },
      empty_user_calls: { filtered: { doc_count: emptyUserCalls } },
      top_users: { buckets: picked }
    }
  }
}

function makeMockUserProfilesBySapIds(sapIds: string[]): unknown {
  const userStats = makeMockUserStats({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString()
  }) as {
    aggregations?: {
      top_users?: {
        buckets?: Array<{
          key: string
          user_name?: { buckets?: Array<{ key: string }> }
          org_name?: { buckets?: Array<{ key: string }> }
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

  const fallbackBuckets = userStats.aggregations?.top_users?.buckets ?? []
  const fallbackMap = new Map(
    fallbackBuckets.map((bucket) => {
      const latestUserInfo = bucket.latest_user_info?.hits?.hits?.[0]?._source
      return [
        bucket.key,
        {
          userName: latestUserInfo?.userName ?? bucket.user_name?.buckets?.[0]?.key ?? bucket.key,
          orgName: latestUserInfo?.orgName ?? bucket.org_name?.buckets?.[0]?.key ?? "",
          upperOrgLv0: latestUserInfo?.upperOrgLv0 ?? "",
          upperOrgLv1: latestUserInfo?.upperOrgLv1 ?? ""
        }
      ]
    })
  )

  const buckets = Array.from(new Set(sapIds.map((id) => id.trim()).filter(Boolean))).map(
    (sapId) => {
      const fallback = fallbackMap.get(sapId)
      return {
        key: sapId,
        doc_count: 1,
        latest_user_info: {
          hits: {
            hits: [
              {
                _source: {
                  userName: fallback?.userName ?? `用户${sapId.slice(-4)}`,
                  orgName: fallback?.orgName ?? "未知部门",
                  upperOrgLv0: fallback?.upperOrgLv0 ?? "",
                  upperOrgLv1: fallback?.upperOrgLv1 ?? ""
                }
              }
            ]
          }
        },
        user_name: { buckets: [{ key: fallback?.userName ?? `用户${sapId.slice(-4)}` }] },
        org_name: { buckets: [{ key: fallback?.orgName ?? "未知部门" }] }
      }
    }
  )

  return {
    aggregations: {
      by_sap: { buckets }
    }
  }
}

function makeMockAllUsers(): DashboardAllUserItem[] {
  return Array.from({ length: 80 }, (_, index) => {
    const user = makeMockDashboardUser(index)
    return {
      sapId: user.sapId,
      userName: user.userName,
      orgName: user.orgName || "",
      upperOrgLv0: user.upperOrgLv0 || "",
      upperOrgLv1: user.upperOrgLv1 || ""
    }
  })
}

function makeMockDashboardUser(index: number): DashboardUserListItem {
  const names = ["张三", "李四", "王五", "赵六", "钱七", "孙八", "周九", "吴十"]
  const orgs = [
    { orgName: "测试 1 组", upperOrgLv1: "测试 1 部", upperOrgLv0: "测试 1 组" },
    { orgName: "测试 2 组", upperOrgLv1: "测试 1 部", upperOrgLv0: "测试 2 组" },
    { orgName: "开发三组", upperOrgLv1: "开发二部", upperOrgLv0: "开发三组" },
    { orgName: "平台一组", upperOrgLv1: "平台三部", upperOrgLv0: "平台一组" }
  ]
  const org = orgs[index % orgs.length]
  const count = Math.max(3, 150 - index * 3)
  const totalInputTokens = count * (820 + (index % 7) * 120)
  const totalOutputTokens = count * (240 + (index % 5) * 80)
  return {
    sapId: `10010${String(index + 1).padStart(3, "0")}`,
    ystId: `2743${String(index + 1).padStart(3, "0")}`,
    userName: names[index % names.length],
    ...org,
    count,
    lastActiveAt: new Date(Date.now() - index * 42 * 60 * 1000).toISOString(),
    avgDurationMs: 4200 + (index % 9) * 650,
    totalToolCalls: count * (2 + (index % 4)),
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens
  }
}

function makeMockUserList(_range: TimeRange, options?: UserListOptions): DashboardUserListData {
  const { pageSize, afterKey, keyword, upperOrgLv1 } = normalizeUserListOptions(options)
  const normalizedKeyword = keyword.toLowerCase()
  // 与 ES 路径一致：「部门查询」按逗号拆分多个室，命中任一即保留（含「未归类」）。
  const orgTokens = upperOrgLv1 !== null ? splitOrgQueryTokens(upperOrgLv1) : []
  const allUsers = Array.from({ length: 64 }, (_, index) => makeMockDashboardUser(index)).filter(
    (user) => {
      if (orgTokens.length > 0) {
        const matched = orgTokens.some((token) => {
          if (isUnclassifiedOrgToken(token)) return !user.upperOrgLv1
          const lower = token.toLowerCase()
          return [user.upperOrgLv1, user.upperOrgLv0].some((value) =>
            String(value || "")
              .toLowerCase()
              .includes(lower)
          )
        })
        if (!matched) return false
      }
      if (!normalizedKeyword) return true
      return [user.userName, user.ystId, user.sapId].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(normalizedKeyword)
      )
    }
  )
  const afterOffset = Number(afterKey?.offset ?? 0)
  const afterSapId = typeof afterKey?.sap_id === "string" ? afterKey.sap_id : ""
  const startIndex =
    Number.isFinite(afterOffset) && afterOffset > 0
      ? Math.floor(afterOffset)
      : afterSapId
        ? Math.max(0, allUsers.findIndex((item) => item.sapId === afterSapId) + 1)
        : 0
  const items = allUsers.slice(startIndex, startIndex + pageSize)
  const hasNext = startIndex + pageSize < allUsers.length
  return {
    items,
    pageSize,
    ...(hasNext ? { nextAfterKey: { offset: startIndex + pageSize } } : {}),
    totalActiveUsers: allUsers.length
  }
}

function makeMockUserDetail(
  sapId: string,
  range: TimeRange,
  options?: UserDetailOptions
): DashboardUserDetail {
  const index = Math.max(0, Number(sapId.slice(-3)) - 1)
  const user = makeMockDashboardUser(Number.isFinite(index) ? index : 0)
  const traceViewMode = normalizeTraceViewMode(options?.viewMode ?? options?.mode)
  const tracePageSize = clampLimit(options?.tracePageSize ?? options?.traceLimit, 10, 50)
  const tracePage = clampLimit(options?.tracePage, 1, 1000)
  const baseTraces = makeMockSkillRecentTraces("代码审查", range, 10)
  // 列表按会话（thread）分页：每页 tracePageSize 个完整会话，每个会话内含若干 trace。
  const tracesPerThread = 3
  const totalThreads = Math.min(
    MAX_THREAD_LIST_BUCKETS,
    Math.max(1, Math.floor(user.count / tracesPerThread))
  )
  let traces: DashboardTraceDetail[]
  let total: number
  if (traceViewMode === "trace") {
    // trace 视图：按时间倒序的扁平 trace 分页。
    total = user.count
    const startIndex = (tracePage - 1) * tracePageSize
    traces = Array.from(
      { length: Math.max(0, Math.min(tracePageSize, total - startIndex)) },
      (_, traceIndex) => {
        const mockIndex = startIndex + traceIndex
        const trace = baseTraces[mockIndex % baseTraces.length]
        return {
          ...trace,
          traceId: `mock-trace-${sapId}-${mockIndex}`,
          threadId: `mock-thread-${sapId}-${Math.floor(mockIndex / tracesPerThread)}`,
          sapId,
          ystId: user.ystId,
          userName: user.userName,
          orgName: user.orgName,
          userIp: `10.0.1.${20 + (mockIndex % 200)}`,
          startedAt: new Date(
            new Date(range.to).getTime() - mockIndex * 35 * 60 * 1000
          ).toISOString()
        }
      }
    )
  } else {
    total = totalThreads
    const startThread = (tracePage - 1) * tracePageSize
    const threadCountThisPage = Math.max(0, Math.min(tracePageSize, totalThreads - startThread))
    traces = Array.from({ length: threadCountThisPage }).flatMap((_, threadIndex) => {
      const threadOrdinal = startThread + threadIndex
      const threadId = `mock-thread-${sapId}-${threadOrdinal}`
      const threadStartMs = new Date(range.to).getTime() - threadOrdinal * 3 * 60 * 60 * 1000
      return Array.from({ length: tracesPerThread }, (_, traceIndex) => {
        const trace = baseTraces[(threadOrdinal + traceIndex) % baseTraces.length]
        return {
          ...trace,
          traceId: `${threadId}-${traceIndex}`,
          threadId,
          sapId,
          ystId: user.ystId,
          userName: user.userName,
          orgName: user.orgName,
          userIp: `10.0.1.${20 + (threadOrdinal % 200)}`,
          startedAt: new Date(threadStartMs + traceIndex * 8 * 60 * 1000).toISOString()
        }
      })
    })
  }
  return {
    sapId,
    ystId: user.ystId,
    userName: user.userName,
    orgName: user.orgName,
    upperOrgLv0: user.upperOrgLv0,
    upperOrgLv1: user.upperOrgLv1,
    totalCalls: user.count,
    avgDurationMs: user.avgDurationMs,
    totalToolCalls: user.totalToolCalls,
    totalInputTokens: user.totalInputTokens,
    totalOutputTokens: user.totalOutputTokens,
    totalTokens: user.totalTokens,
    bySkill: [
      { skill: "代码审查", count: Math.floor(user.count * 0.34) },
      { skill: "单元测试", count: Math.floor(user.count * 0.22) },
      { skill: "SQL优化", count: Math.floor(user.count * 0.15) }
    ],
    byModel: [
      { model: "GPT-5.4", count: Math.floor(user.count * 0.6) },
      { model: "Claude Sonnet", count: Math.floor(user.count * 0.28) },
      { model: "Gemini Pro", count: Math.floor(user.count * 0.12) }
    ],
    byOutcome: [
      { outcome: "success", count: Math.floor(user.count * 0.86) },
      { outcome: "error", count: Math.floor(user.count * 0.1) },
      { outcome: "cancelled", count: Math.max(0, user.count - Math.floor(user.count * 0.96)) }
    ],
    traces,
    tracePage,
    tracePageSize,
    total,
    traceViewMode,
    traceTriggerScope: normalizeTraceTriggerScope(options?.triggerScope)
  }
}

function makeMockProjectMode(range: TimeRange, opts?: OrgFilterOptions): DashboardProjectModeData {
  const allProjects: ProjectModeProjectView[] = [
    {
      projectId: "proj-cmb-cowork",
      name: "CmbCowork Agent",
      description: "桌面 AI Agent 主项目",
      systemName: "智能研发平台",
      workspacePath: "/Users/demo/projects/cmbCowork",
      adapterName: "claude-code",
      adapterVersion: "1.4.2",
      lifecycleStatus: "active",
      compatible: true,
      compatibilityStatus: "compatible",
      featureCount: 3,
      conversationCount: 128,
      hasError: false,
      topSkills: [
        { skill: "代码审查", count: 40 },
        { skill: "单元测试", count: 25 },
        { skill: "SQL优化", count: 12 }
      ],
      codeStats: makeDashboardCodeStats({
        generatedLines: 5200,
        deletedLines: 800,
        measuredGeneratedLines: 4800,
        effectiveGeneratedLines: 4200,
        adoptedLines: 3100,
        pushedMeasuredGeneratedLines: 4000,
        pushedEffectiveGeneratedLines: 3600,
        pushedAdoptedLines: 2700,
        pushedCommitCount: 42
      }),
      features: [
        {
          slug: "harness-board",
          title: "运营看板",
          location: "src/main/harness-board",
          statusLabel: "进行中",
          currentNodeStatusLabel: "实现中",
          summary: "新增项目模式看板 tab"
        },
        {
          slug: "code-adoption",
          title: "代码采纳追踪",
          location: "src/main/services",
          statusLabel: "已完成",
          currentNodeStatusLabel: "已合并",
          summary: "采纳率统计上线"
        },
        {
          slug: "skill-eval",
          title: "技能评估",
          location: "src/main/agent/skill-eval",
          statusLabel: "待评审",
          currentNodeStatusLabel: "评审中",
          summary: "离线 trace 评估流水线"
        }
      ]
    },
    {
      projectId: "proj-payment-core",
      name: "支付核心系统",
      description: "支付清结算重构",
      systemName: "支付平台",
      workspacePath: "/Users/demo/projects/payment-core",
      adapterName: "claude-code",
      adapterVersion: "1.4.0",
      lifecycleStatus: "active",
      compatible: false,
      compatibilityStatus: "outdated",
      featureCount: 2,
      conversationCount: 47,
      hasError: false,
      topSkills: [
        { skill: "代码审查", count: 18 },
        { skill: "重构助手", count: 9 }
      ],
      codeStats: makeDashboardCodeStats({
        generatedLines: 2100,
        deletedLines: 300,
        measuredGeneratedLines: 1900,
        effectiveGeneratedLines: 1700,
        adoptedLines: 900,
        pushedMeasuredGeneratedLines: 1500,
        pushedEffectiveGeneratedLines: 1300,
        pushedAdoptedLines: 700,
        pushedCommitCount: 11
      }),
      features: [
        {
          slug: "settlement",
          title: "清结算重构",
          statusLabel: "进行中",
          currentNodeStatusLabel: "开发中",
          summary: "拆分清算与结算链路"
        },
        {
          slug: "refund",
          title: "退款流程",
          statusLabel: "阻塞",
          currentNodeStatusLabel: "等待依赖",
          summary: "依赖账务系统接口"
        }
      ]
    },
    {
      projectId: "proj-risk-engine",
      name: "风控引擎",
      systemName: "风险管理平台",
      adapterName: "codex",
      adapterVersion: "0.9.1",
      lifecycleStatus: "paused",
      compatible: true,
      compatibilityStatus: "compatible",
      featureCount: 1,
      conversationCount: 0,
      hasError: true,
      topSkills: [],
      codeStats: null,
      features: [
        {
          slug: "rule-dsl",
          title: "规则 DSL",
          statusLabel: "暂停",
          currentNodeStatusLabel: "—",
          summary: "探测进程返回异常"
        }
      ]
    },
    {
      projectId: "proj-legacy-portal",
      name: "门户旧版迁移",
      description: "旧门户下线",
      systemName: "统一门户",
      adapterName: "claude-code",
      adapterVersion: "1.3.5",
      lifecycleStatus: "archived",
      compatible: true,
      compatibilityStatus: "compatible",
      featureCount: 1,
      conversationCount: 12,
      hasError: false,
      topSkills: [{ skill: "代码审查", count: 6 }],
      codeStats: makeDashboardCodeStats({
        generatedLines: 900,
        deletedLines: 1500,
        measuredGeneratedLines: 850,
        effectiveGeneratedLines: 700,
        adoptedLines: 520,
        pushedMeasuredGeneratedLines: 700,
        pushedEffectiveGeneratedLines: 600,
        pushedAdoptedLines: 450,
        pushedCommitCount: 8
      }),
      features: [
        {
          slug: "portal-migrate",
          title: "门户迁移",
          statusLabel: "已归档",
          currentNodeStatusLabel: "已下线",
          summary: "迁移完成并归档"
        }
      ]
    }
  ]
  void range
  // 额外填充若干进行中项目，便于在 DEV 模式演示项目列表的分页/搜索交互。
  for (let i = 1; i <= 12; i++) {
    allProjects.push({
      projectId: `proj-demo-${i}`,
      name: `示例项目 ${i}`,
      systemName: "示例平台",
      adapterName: "claude-code",
      adapterVersion: "1.4.2",
      lifecycleStatus: "active",
      compatible: true,
      compatibilityStatus: "compatible",
      featureCount: (i % 3) + 1,
      conversationCount: (i * 7) % 90,
      hasError: false,
      topSkills: [{ skill: "代码审查", count: (i * 3) % 20 }],
      codeStats: null,
      features: [
        {
          slug: `demo-${i}-feature`,
          title: `示例特性 ${i}`,
          statusLabel: "进行中",
          currentNodeStatusLabel: "开发中",
          summary: "演示用占位特性"
        }
      ]
    })
  }
  const mockCreators: Array<
    Pick<
      ProjectModeProjectView,
      | "creatorSapId"
      | "creatorYstId"
      | "creatorUserName"
      | "creatorOrgName"
      | "creatorUpperOrgLv0"
      | "creatorUpperOrgLv1"
    >
  > = [
    {
      creatorSapId: "10010001",
      creatorYstId: "383331",
      creatorUserName: "张三",
      creatorOrgName: "测试 1 组",
      creatorUpperOrgLv1: "测试 1 部",
      creatorUpperOrgLv0: "测试 1 组"
    },
    {
      creatorSapId: "10010002",
      creatorYstId: "231855",
      creatorUserName: "李四",
      creatorOrgName: "开发三组",
      creatorUpperOrgLv1: "开发二部",
      creatorUpperOrgLv0: "开发三组"
    },
    {
      creatorSapId: "10010003",
      creatorYstId: "280631",
      creatorUserName: "王五",
      creatorOrgName: "平台一组",
      creatorUpperOrgLv1: "平台三部",
      creatorUpperOrgLv0: "平台一组"
    }
  ]
  allProjects.forEach((project, index) => {
    Object.assign(project, mockCreators[index % mockCreators.length])
  })
  // 「室筛选」：按下标分配的室过滤项目列表，使 mock 下切换室也能真实改变数据。
  const selectedOrgs = normalizeUpperOrgLv1List(opts?.upperOrgLv1)
  const projects = allProjects.filter((_, i) =>
    mockProjectMatchesOrg(mockProjectOrgAt(i), selectedOrgs)
  )
  // 聚合块（token/工具/技能/采纳明细等）按室权重缩放，与其它面板口径一致。
  const aggScale = getMockOrgScale(opts)
  const featureCount = projects.reduce((sum, p) => sum + p.featureCount, 0)
  const conversationCount = projects.reduce((sum, p) => sum + p.conversationCount, 0)
  const activeProjectCount = projects.filter((p) => p.conversationCount > 0).length
  const projectCounts = buildProjectModeProjectCounts(projects)
  const projectPage = makeMockProjectModeProjectPage(projects, {
    status: "active",
    page: 1,
    pageSize: PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE,
    keyword: ""
  })
  return {
    summary: {
      projectCount: projects.length,
      featureCount,
      activeProjectCount,
      conversationCount,
      totalToolCalls: scaleMockMetricNumber(1842, aggScale),
      totalInputTokens: scaleMockMetricNumber(7_200_000, aggScale),
      totalOutputTokens: scaleMockMetricNumber(2_450_000, aggScale),
      totalTokens: scaleMockMetricNumber(9_650_000, aggScale),
      skillCallCount: scaleMockMetricNumber(312, aggScale),
      distinctSkillCount: 14,
      codeStats: makeDashboardCodeStats({
        generatedLines: scaleMockMetricNumber(7300, aggScale),
        deletedLines: scaleMockMetricNumber(1100, aggScale),
        measuredGeneratedLines: scaleMockMetricNumber(6700, aggScale),
        effectiveGeneratedLines: scaleMockMetricNumber(5900, aggScale),
        adoptedLines: scaleMockMetricNumber(4000, aggScale),
        pushedMeasuredGeneratedLines: scaleMockMetricNumber(5500, aggScale),
        pushedEffectiveGeneratedLines: scaleMockMetricNumber(4900, aggScale),
        pushedAdoptedLines: scaleMockMetricNumber(3400, aggScale),
        pushedCommitCount: scaleMockMetricNumber(53, aggScale)
      })
    },
    adapters: deepScaleMockMetrics(
      [
        {
          name: "claude-code",
          version: "1.4.2",
          projectCount: 1,
          featureCount: 3,
          conversationCount: 128,
          codeStats: makeDashboardCodeStats({
            generatedLines: 5200,
            deletedLines: 800,
            measuredGeneratedLines: 4800,
            effectiveGeneratedLines: 4200,
            adoptedLines: 3100,
            pushedMeasuredGeneratedLines: 4000,
            pushedEffectiveGeneratedLines: 3600,
            pushedAdoptedLines: 2700,
            pushedCommitCount: 42
          })
        },
        {
          name: "claude-code",
          version: "1.4.0",
          projectCount: 1,
          featureCount: 2,
          conversationCount: 47,
          codeStats: makeDashboardCodeStats({
            generatedLines: 1800,
            deletedLines: 200,
            measuredGeneratedLines: 1600,
            effectiveGeneratedLines: 1400,
            adoptedLines: 900,
            pushedMeasuredGeneratedLines: 1200,
            pushedEffectiveGeneratedLines: 1000,
            pushedAdoptedLines: 650,
            pushedCommitCount: 14
          })
        },
        {
          name: "codex",
          version: "0.9.1",
          projectCount: 1,
          featureCount: 1,
          conversationCount: 0,
          codeStats: null
        }
      ],
      aggScale
    ),
    topSkills: deepScaleMockMetrics(
      [
        { skill: "代码审查", count: 58 },
        { skill: "单元测试", count: 31 },
        { skill: "重构助手", count: 22 },
        { skill: "SQL优化", count: 15 }
      ],
      aggScale
    ),
    tools: deepScaleMockMetrics(
      {
        byTool: [
          { tool: "git_workflow", count: 142 },
          { tool: "manage_skill", count: 88 },
          { tool: "manage_scheduler", count: 61 },
          { tool: "db_query", count: 44 },
          { tool: "create_pr", count: 33 }
        ],
        byToolAll: [
          { tool: "git_workflow", count: 142 },
          { tool: "execute", count: 120 },
          { tool: "read_file", count: 96 },
          { tool: "manage_skill", count: 88 }
        ],
        byToolFilteredAll: [
          { tool: "git_workflow", count: 142 },
          { tool: "manage_skill", count: 88 },
          { tool: "manage_scheduler", count: 61 },
          { tool: "db_query", count: 44 },
          { tool: "create_pr", count: 33 }
        ],
        byToolAllFull: [
          { tool: "git_workflow", count: 142 },
          { tool: "execute", count: 120 },
          { tool: "read_file", count: 96 },
          { tool: "manage_skill", count: 88 }
        ],
        totalTools: 23,
        totalToolCalls: 1842
      },
      aggScale
    ),
    analytics: buildProjectModeMockAnalytics(projects),
    bySkillAdoption: deepScaleMockMetrics(
      [
        {
          skill: "代码审查",
          commitCount: 24,
          ...makeDashboardCodeStats({
            generatedLines: 3200,
            deletedLines: 400,
            measuredGeneratedLines: 3000,
            effectiveGeneratedLines: 2600,
            adoptedLines: 2000,
            pushedMeasuredGeneratedLines: 2400,
            pushedEffectiveGeneratedLines: 2100,
            pushedAdoptedLines: 1600,
            pushedCommitCount: 20
          })
        },
        {
          skill: "单元测试",
          commitCount: 12,
          ...makeDashboardCodeStats({
            generatedLines: 1800,
            deletedLines: 200,
            measuredGeneratedLines: 1700,
            effectiveGeneratedLines: 1500,
            adoptedLines: 800,
            pushedMeasuredGeneratedLines: 1200,
            pushedEffectiveGeneratedLines: 1050,
            pushedAdoptedLines: 600,
            pushedCommitCount: 9
          })
        },
        {
          skill: "重构助手",
          commitCount: 7,
          ...makeDashboardCodeStats({
            generatedLines: 1100,
            deletedLines: 900,
            measuredGeneratedLines: 1000,
            effectiveGeneratedLines: 820,
            adoptedLines: 500,
            pushedMeasuredGeneratedLines: 760,
            pushedEffectiveGeneratedLines: 640,
            pushedAdoptedLines: 380,
            pushedCommitCount: 6
          })
        }
      ],
      aggScale
    ),
    projectCounts,
    projectPage,
    projects
  }
}

function makeMockProjectModeProjectPage(
  projects: ProjectModeProjectView[],
  options?: ProjectModeProjectPageOptions
): ProjectModeProjectPageData {
  return sliceProjectModeProjects(projects, options)
}

function makeMockProjectModeProjects(
  range: TimeRange,
  options?: ProjectModeProjectPageOptions
): ProjectModeProjectPageData {
  return makeMockProjectModeProjectPage(makeMockProjectMode(range, options).projects, options)
}

function makeMockProjectModeTraces(
  projectId: string,
  range: TimeRange,
  options?: ProjectModeTracesOptions
): DashboardProjectModeTracesData {
  const traceViewMode = normalizeTraceViewMode(options?.viewMode ?? options?.mode)
  const tracePageSize = clampLimit(
    options?.tracePageSize ?? options?.pageSize ?? options?.limit,
    10,
    50
  )
  const tracePage = clampLimit(options?.tracePage ?? options?.page, 1, 1000)
  const traceTriggerScope = normalizeTraceTriggerScope(options?.triggerScope)
  const traces = makeMockSkillRecentTraces("项目模式", range, 10).map((trace, index) => ({
    ...trace,
    traceId: `${projectId}-${trace.traceId}-${index}`
  }))

  if (traceViewMode === "trace") {
    const from = (tracePage - 1) * tracePageSize
    return {
      traces: traces.slice(from, from + tracePageSize),
      tracePage,
      tracePageSize,
      total: traces.length,
      traceViewMode,
      traceTriggerScope
    }
  }

  const grouped = new Map<string, DashboardTraceDetail[]>()
  for (const trace of traces) {
    const threadId = trace.threadId || "unknown-thread"
    grouped.set(threadId, [...(grouped.get(threadId) ?? []), trace])
  }
  const groups = [...grouped.entries()]
    .map(([threadId, threadTraces]) => {
      const sorted = [...threadTraces].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      const latestStartedAt = sorted.reduce(
        (latest, trace) => (trace.startedAt > latest ? trace.startedAt : latest),
        sorted[0]?.startedAt ?? ""
      )
      return { threadId, latestStartedAt, traces: sorted }
    })
    .sort((a, b) => b.latestStartedAt.localeCompare(a.latestStartedAt))
  const from = (tracePage - 1) * tracePageSize

  return {
    traces: groups.slice(from, from + tracePageSize).flatMap((group) => group.traces),
    tracePage,
    tracePageSize,
    total: groups.length,
    traceViewMode,
    traceTriggerScope
  }
}

function makeMockProductivity(range: TimeRange, opts?: OrgFilterOptions): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000))
      trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000))
      trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: Math.floor(2 + Math.random() * 12)
  }))

  return scaleMockDashboardResponse(
    {
      aggregations: {
        commit_trend: { buckets: trend },
        // Agent 生成 / 删除的代码行数（来自 code_gen 事件），非 git commit 原始行数
        total_insertions: { value: 9240 },
        total_deletions: { value: 2180 },
        total_files_changed: { value: 892 },
        total_commits: { value: 187 },
        active_users: { value: 24 }
      }
    },
    opts
  )
}

function makeMockFeedback(
  range: TimeRange,
  granularity: Granularity,
  opts?: OrgFilterOptions
): unknown {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const from = new Date(range.from)
  const to = new Date(range.to)

  const buckets: Date[] = []
  if (interval === "hour") {
    const start = new Date(from)
    start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else if (interval === "day") {
    const start = new Date(from)
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  } else {
    const start = new Date(from)
    const day = start.getDay()
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
    start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 7 * 24 * 60 * 60 * 1000)) {
      buckets.push(new Date(t))
    }
  }

  const trend = buckets.map((t) => {
    const likes = Math.floor(5 + Math.random() * 20)
    const dislikes = Math.floor(2 + Math.random() * 12)
    return {
      key_as_string: t.toISOString(),
      key: t.getTime(),
      doc_count: likes + dislikes,
      likes: { doc_count: likes },
      dislikes: { doc_count: dislikes }
    }
  })

  const dislikeByType = {
    slow: { doc_count: 58 },
    not_helpful: { doc_count: 74 },
    inaccurate: { doc_count: 39 },
    unclear: { doc_count: 46 },
    unsafe: { doc_count: 11 },
    other: { doc_count: 27 }
  }

  const recentComments = [
    {
      eventTime: new Date(to.getTime() - 10 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "other",
        dislikeTypeLabel: "其他原因",
        dislikeText: "希望能支持更精细的输出格式控制。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 25 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "inaccurate",
        dislikeTypeLabel: "信息不准确",
        dislikeText: "依赖版本建议和项目实际不一致。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 40 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "slow",
        dislikeTypeLabel: "太慢了",
        dislikeText: "等待响应时间偏长，尤其在长上下文里。"
      }
    },
    {
      eventTime: new Date(to.getTime() - 55 * 60 * 1000).toISOString(),
      properties: {
        dislikeType: "unclear",
        dislikeTypeLabel: "表述不清楚",
        dislikeText: "可以多给一步一步的解释。"
      }
    }
  ]

  return scaleMockDashboardResponse(
    {
      aggregations: {
        total_likes: {
          doc_count: 386,
          unique_users: { value: 132 }
        },
        total_dislikes: {
          doc_count: 255,
          unique_users: { value: 96 }
        },
        dislike_by_type: { buckets: dislikeByType },
        trend: { buckets: trend },
        recent_dislike_comments: {
          doc_count: recentComments.length,
          latest: {
            hits: {
              hits: recentComments.map((item) => ({
                _source: item
              }))
            }
          }
        }
      }
    },
    opts
  )
}

function makeMockAgentTrace(skill: string, range: TimeRange, index: number): AgentTrace {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const spanMs = Math.max(60_000, to.getTime() - from.getTime())
  const offsetMs = Math.min(spanMs - 1, (index + 1) * 35 * 60 * 1000)
  const startedAt = new Date(to.getTime() - offsetMs)
  const endedAt = new Date(startedAt.getTime() + (index + 2) * 28_000)
  const traceId = `mock-trace-${skill}-${index + 1}`.replace(/\s+/g, "-")
  const threadId =
    index < 3
      ? "mock-thread-skill-review-flow"
      : index < 5
        ? "mock-thread-market-publish-flow"
        : `mock-thread-${index + 1}`
  const threadMessages = [
    `请使用 ${skill} 帮我审查这次 dashboard trace 展示改动。`,
    "继续，把刚才提到的分页边界和空数据状态也一起看一下。",
    "再确认一下 Thread 维度下多条 trace 的聊天还原是否清楚。",
    `用 ${skill} 看下这个 Skill 发布到市场前还有没有说明遗漏。`,
    "继续检查应用市场最近 trace 弹窗的展示口径。",
    `请使用 ${skill} 帮我分析这次变更，并给出可执行建议。`
  ]
  const userMessage = threadMessages[index] ?? threadMessages[5]
  const assistantSummary =
    [
      `已完成 ${skill} 审查：主要建议是把 trace 详情先展示成对话，再保留执行树作为辅助信息。`,
      "已补充检查分页边界：Thread 模式需要限制聚合上限，Trace 模式保留原分页更稳。",
      "Thread 维度下的多 trace 展示是清楚的：左侧按会话折叠，右侧展示当前 trace 的问答。",
      `已检查 ${skill} 市场发布说明，建议补充适用场景、输入要求和失败排查说明。`,
      "最近 trace 弹窗建议默认 Thread 维度，并提供 Trace 维度切换，便于运营快速浏览。",
      `已完成 ${skill} 分析，结论包含风险点、建议修改和验证方式。`
    ][index] ?? `已完成 ${skill} 分析。`
  const repeatedReadFileToolCalls = [
    "src/renderer/src/components/dashboard/TraceHistoryDialog.tsx",
    "src/renderer/src/components/trace/TraceConversation.tsx",
    "src/main/ipc/dashboard.ts",
    "src/preload/index.ts",
    "src/preload/index.d.ts",
    "src/renderer/src/components/customize/MarketPanel.tsx"
  ].map((path, toolIndex) => ({
    name: "read_file",
    args: { path },
    result: `读取 ${path}，命中 ${80 + toolIndex * 17} 行内容`,
    durationMs: 260 + toolIndex * 45
  }))
  const mixedToolCalls = [
    {
      name: "rg",
      args: { pattern: "TraceConversation", path: "src/renderer/src" },
      result: "匹配 4 个文件，共 9 处",
      durationMs: 180
    },
    {
      name: "read_file",
      args: { path: "src/renderer/src/components/trace/TraceConversation.tsx" },
      result: "读取到对话组件和工具卡片实现",
      durationMs: 310
    },
    {
      name: "edit_file",
      args: {
        path: "src/renderer/src/components/trace/TraceConversation.tsx",
        summary: "调整工具调用卡片位置"
      },
      result: "替换 2 个 JSX 块",
      durationMs: 960
    },
    {
      name: "execute",
      args: { command: "npm run typecheck" },
      result: "typecheck:web passed",
      durationMs: 4200
    }
  ]
  const toolCalls =
    index === 0
      ? repeatedReadFileToolCalls
      : index === 1
        ? mixedToolCalls
        : [
            {
              name: "read_file",
              args: { path: "src/example.ts" },
              result: "读取到 120 行内容",
              durationMs: 420
            },
            {
              name: "grep",
              args: { pattern: "TODO", path: "src" },
              result: "匹配 3 处",
              durationMs: 310
            }
          ]

  const trace: AgentTrace = {
    traceId,
    threadId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    userMessage,
    modelId: "custom:minmax2.7",
    modelName: "MiniMax-M2.7",
    userName: ["张三", "李四", "王五"][index] ?? "张三",
    sapId: `1001000${index + 1}`,
    ystId: `27435${index + 1}`,
    orgName: ["科技部", "零售一部", "风险管理部"][index] ?? "科技部",
    steps: [
      {
        index: 0,
        startedAt: startedAt.toISOString(),
        assistantText: `我会先定位和 ${skill} 相关的上下文，再整理问题和建议。`,
        toolCalls: toolCalls.slice(0, Math.ceil(toolCalls.length / 2))
      },
      {
        index: 1,
        startedAt: new Date(startedAt.getTime() + 12_000).toISOString(),
        assistantText: assistantSummary,
        toolCalls: toolCalls.slice(Math.ceil(toolCalls.length / 2))
      }
    ],
    modelCalls: [
      {
        messageId: `mock-message-${index + 1}`,
        startedAt: startedAt.toISOString(),
        inputMessages: [{ role: "user", content: userMessage }],
        outputMessage: {
          role: "assistant",
          content: assistantSummary
        },
        toolCalls: [],
        tokenUsage: {
          inputTokens: 3200 + index * 500,
          outputTokens: 900 + index * 160,
          totalTokens: 4100 + index * 660
        }
      }
    ],
    totalToolCalls: toolCalls.length,
    outcome: index === 2 ? "error" : "success",
    ...(index === 2 ? { errorMessage: "Mock trace 用于展示异常状态" } : {}),
    appVersion: "0.3.6",
    usedSkills: [skill],
    evolvedSkills: index % 2 === 0 ? [skill] : [],
    triggerSource: "chat",
    metadata: {
      workspacePath: "/Users/demo/projects/cmbCowork"
    }
  }
  const skillEval = buildSkillEvalTraceExtension(trace, {
    skillAuthorByRawName: { [skill]: "Mock Skill Author" },
    windowContextByRawName: {
      [skill]: {
        skillTaskId: [trace.threadId, skill, trace.traceId].join(":"),
        skillTaskTraceIndex: 0,
        contextTraceIds: [trace.traceId],
        skillEvalTraceIds: [trace.traceId],
        contextTraceCount: 1,
        skillEvalTraceCount: 1
      }
    },
    evalRawSkillNames: trace.usedSkills
  })
  return skillEval ? { ...trace, skillEval } : trace
}

function makeMockSkillRecentTraces(
  skill: string,
  range: TimeRange,
  limit = 10
): DashboardTraceDetail[] {
  return Array.from({ length: clampLimit(limit, 10, 10) }, (_, index) => {
    const trace = makeMockAgentTrace(skill, range, index)
    const usage = summarizeTraceTokenUsage(trace.modelCalls)
    return {
      traceId: trace.traceId,
      threadId: trace.threadId,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      durationMs: trace.durationMs,
      userMessage: trace.userMessage,
      sapId: `100100${String(index + 1).padStart(2, "0")}`,
      ystId: `2743${String(50 + index).padStart(2, "0")}`,
      userName: ["张三", "李四", "王五"][index % 3],
      orgName: ["测试 1 组", "测试 2 组", "开发三组"][index % 3],
      userIp: `10.0.0.${20 + index}`,
      modelId: trace.modelId,
      modelName: trace.modelName,
      outcome: trace.outcome,
      totalToolCalls: trace.totalToolCalls,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalTokens: usage.totalTokens,
      usedSkills: trace.usedSkills,
      evolvedSkills: trace.evolvedSkills,
      triggerSource: trace.triggerSource,
      nodes: buildTraceTree(trace),
      rawAvailable: true
    }
  })
}

function makeMockThreadTraces(threadId: string): DashboardTraceDetail[] {
  const now = Date.now()
  const range: TimeRange = {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString()
  }
  const all = makeMockSkillRecentTraces("auto-code-workflow-v1.0.0", range, 10)
  const matched = all.filter((trace) => trace.threadId === threadId)
  const list = matched.length > 0 ? matched : all
  return [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

function makeMockSkillCodeStats(skill: string): DashboardCodeStats {
  const seed = Array.from(skill).reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const generatedLines = 680 + (seed % 360)
  const deletedLines = 80 + (seed % 90)
  const measuredGeneratedLines = Math.max(0, generatedLines - 120)
  const effectiveGeneratedLines = Math.max(0, measuredGeneratedLines - 30)
  const adoptedLines = Math.round(effectiveGeneratedLines * (0.62 + (seed % 18) / 100))
  return makeDashboardCodeStats({
    generatedLines,
    deletedLines,
    effectiveGeneratedLines,
    measuredGeneratedLines,
    adoptedLines
  })
}

function makeMockSkillDetail(
  skill: string,
  range: TimeRange,
  options?: number | TracePageOptions
): DashboardSkillDetail {
  const pageOptions = typeof options === "number" ? { limit: options } : options
  const traceViewMode = normalizeTraceViewMode(pageOptions?.viewMode ?? pageOptions?.mode)
  const tracePageSize = clampLimit(
    pageOptions?.pageSize ?? pageOptions?.limit,
    10,
    traceViewMode === "thread" ? 30 : 50
  )
  const tracePage = clampLimit(pageOptions?.page, 1, 1000)
  const totalTraces = traceViewMode === "thread" ? 30 : 64
  const startIndex = (tracePage - 1) * tracePageSize
  const baseTraces = makeMockSkillRecentTraces(skill, range, 10)
  const traces = Array.from(
    { length: Math.max(0, Math.min(tracePageSize, totalTraces - startIndex)) },
    (_, traceIndex) => {
      const trace = baseTraces[traceIndex % baseTraces.length]
      const mockIndex = startIndex + traceIndex
      return {
        ...trace,
        traceId: `${trace.traceId}-skill-page-${tracePage}-${traceIndex}`,
        startedAt: new Date(new Date(range.to).getTime() - mockIndex * 35 * 60 * 1000).toISOString()
      }
    }
  )
  return {
    stats: makeMockSkillCodeStats(skill),
    traces,
    tracePage,
    tracePageSize,
    totalTraces,
    traceViewMode
  }
}

function makeMockCommitDetails(
  range: TimeRange,
  options?: number | CommitDetailsOptions
): {
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
} {
  const { page, pageSize, pushedOnly, upperOrgLv1 } = normalizeCommitDetailsOptions(options)
  const from = new Date(range.from)
  const to = new Date(range.to)
  const spanMs = Math.max(60_000, to.getTime() - from.getTime())
  const allItems = Array.from({ length: 240 }, (_, index): DashboardCommitDetail => {
    const eventTime = new Date(to.getTime() - Math.min(spanMs - 1, index * 42 * 60 * 1000))
    const pushed = index % 3 !== 1
    const repoName = `cmb-${index % 3}`
    const commitSha = `mock${String(index + 1).padStart(36, "0")}`
    return {
      eventId: `mock-commit-event-${index + 1}`,
      eventTime: eventTime.toISOString(),
      userName: ["张三", "李四", "王五", "赵六"][index % 4],
      sapId: `100100${String(index + 1).padStart(2, "0")}`,
      ystId: `2743${String(50 + index).padStart(2, "0")}`,
      orgName: ["科技部", "零售一部", "风险管理部"][index % 3],
      upperOrgLv1: ["信息研发部", "零售金融部", "风险平台部"][index % 3],
      upperOrgLv0: index % 4 === 0 ? "" : ["架构工具组", "渠道研发组", "风控研发组"][index % 3],
      userIp: `10.0.0.${20 + index}`,
      repoPath: `/Users/demo/projects/${repoName}`,
      repositoryName: repoName,
      repositoryFullName: `demo/${repoName}`,
      repositoryWebUrl: `https://git.example.internal/demo/${repoName}`,
      commitSha,
      commitUrl: pushed
        ? `https://git.example.internal/demo/${repoName}/commit/${commitSha}`
        : undefined,
      pushed,
      pushedAt: pushed ? new Date(eventTime.getTime() + 30 * 60 * 1000).toISOString() : undefined,
      branch: index % 2 === 0 ? "feature/smart-model-routing" : "fix/dashboard-detail",
      filesChanged: 2 + (index % 6),
      insertions: 18 + index * 7,
      deletions: 4 + index * 3,
      triggeredBy: index % 4 === 0 ? "auto-push" : "manual",
      threadId: `mock-thread-${(index % 5) + 1}`,
      usedSkills: index % 2 === 0 ? ["代码审查-v1.0.0"] : ["需求分析-v1.0.0", "接口设计-v1.0.0"],
      skillCount: index % 2 === 0 ? 1 : 2,
      codeGeneratedLines: 30 + index * 2,
      codeEffectiveGeneratedLines: 24 + index,
      codeAdoptedLines: 12 + (index % 18),
      codeAdoptionRate: (12 + (index % 18)) / (24 + index)
    }
  })
  const filteredItems = allItems.filter((item) => {
    if (pushedOnly && !item.pushed) return false
    if (upperOrgLv1 !== null) {
      const normalizedUpperOrgLv1 = upperOrgLv1.toLowerCase()
      const orgMatched = [item.upperOrgLv1, item.upperOrgLv0].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(normalizedUpperOrgLv1)
      )
      if (!orgMatched) return false
    }
    return true
  })
  const start = (page - 1) * pageSize
  return {
    total: filteredItems.length,
    page,
    pageSize,
    pushedOnly,
    items: filteredItems.slice(start, start + pageSize)
  }
}

// ─────────────────────────────────────────────────────────
// Project Mode (Harness Board) dashboard
// ─────────────────────────────────────────────────────────

/** Event name written by HarnessStatusReporter for project snapshots. */
const HARNESS_PROJECT_SNAPSHOT_EVENT = "harness.project.snapshot"

/**
 * ES 默认 index.max_result_window。基于 from+size 的深翻页一旦 from+size 超过它就会
 * 报 "Result window is too large"，所以翻页深度必须按 pageSize 钳制在此窗口内。
 */
const ES_MAX_RESULT_WINDOW = 10000

/** Built-in file/system/meta tools excluded from the "已过滤" tool ranking. */
const FILTERED_TOOL_EXCLUDES = [
  // Claude Code 内置文件 / 系统工具
  "execute",
  "read_file",
  "write_file",
  "glob",
  "grep",
  "list_directory",
  "task",
  "task_output",
  "ls",
  "edit_file",
  // 工具搜索 / 元工具
  "search_tool",
  "inspect_tool",
  "invoke_deferred_tool",
  // 内置代码执行辅助
  "code_exec",
  "prepare_save_code_exec_tool",
  "save_code_exec_tool",
  // 内置任务管理
  "write_todos"
]

interface ProjectModeFeatureView {
  slug: string
  title: string
  location?: string
  statusLabel?: string
  currentNodeStatusLabel?: string
  summary?: string
}

interface ProjectModeSkillCount {
  skill: string
  count: number
}

interface ProjectModeToolCount {
  tool: string
  count: number
}

interface ProjectModeToolUsage {
  byTool: ProjectModeToolCount[]
  byToolAll: ProjectModeToolCount[]
  byToolFilteredAll: ProjectModeToolCount[]
  byToolAllFull: ProjectModeToolCount[]
  totalTools: number
  totalToolCalls: number
}

interface ProjectModeTopUser {
  sapId: string
  ystId?: string
  userName: string
  orgName: string
  count: number
}

interface ProjectModeOrgDistributionItem {
  key: string
  org: string
  count: number
  children: ProjectModeOrgDistributionItem[]
}

interface ProjectModeAdapterShareItem {
  name: string
  count: number
}

interface ProjectModeAnalytics {
  topUsers: ProjectModeTopUser[]
  byOrg: ProjectModeOrgDistributionItem[]
  byAdapter: ProjectModeAdapterShareItem[]
}

interface ProjectModeProjectView {
  projectId: string
  name: string
  description?: string
  systemName?: string
  workspacePath?: string
  adapterName?: string
  adapterVersion?: string
  creatorSapId?: string
  creatorYstId?: string
  creatorUserName?: string
  creatorOrgName?: string
  creatorUpperOrgLv0?: string
  creatorUpperOrgLv1?: string
  lifecycleStatus?: string
  compatible?: boolean
  compatibilityStatus?: string
  featureCount: number
  conversationCount: number
  hasError: boolean
  features: ProjectModeFeatureView[]
  topSkills: ProjectModeSkillCount[]
  codeStats: DashboardCodeStats | null
}

type ProjectModeProjectStatus = "active" | "archived"

interface ProjectModeProjectCounts {
  total: number
  active: number
  archived: number
  totalFeatureCount: number
  activeFeatureCount: number
  archivedFeatureCount: number
}

interface ProjectModeProjectPageData {
  projects: ProjectModeProjectView[]
  total: number
  page: number
  pageSize: number
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
}

interface ProjectModeProjectPageOptions extends OrgFilterOptions {
  status?: ProjectModeProjectStatus | null
  page?: number
  pageSize?: number
  keyword?: string | null
  adapterName?: string | null
  creatorKeyword?: string | null
  creatorOrgKeyword?: string | null
}

interface ProjectModeAdapterView {
  name: string
  version?: string
  projectCount: number
  featureCount: number
  conversationCount: number
  codeStats: DashboardCodeStats | null
}

interface DashboardProjectModeData {
  summary: {
    projectCount: number
    featureCount: number
    activeProjectCount: number
    conversationCount: number
    totalToolCalls: number
    totalInputTokens: number
    totalOutputTokens: number
    totalTokens: number
    skillCallCount: number
    distinctSkillCount: number
    codeStats: DashboardCodeStats | null
  }
  adapters: ProjectModeAdapterView[]
  topSkills: ProjectModeSkillCount[]
  bySkillAdoption: DashboardSkillCodeAdoptionStats[]
  tools: ProjectModeToolUsage
  analytics: ProjectModeAnalytics
  projectCounts: ProjectModeProjectCounts
  projectPage: ProjectModeProjectPageData
  projects: ProjectModeProjectView[]
}

interface DashboardProjectModeTracesData {
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  total: number
  traceViewMode: TraceViewMode
  traceTriggerScope: TraceTriggerScope
}

/** Time-range filter over the trace index, plus an `exists harnessProjectId` clause. */
function projectModeTraceFilters(
  range: TimeRange,
  orgFilterClause: Record<string, unknown> | null
): Record<string, unknown>[] {
  return [
    timeRangeFilter("startedAt", range),
    { exists: { field: "harnessProjectId" } },
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
}

/** Build the `name@version` key used to merge adapter rows across snapshot + usage. */
function adapterKey(name: string, version?: string): string {
  return `${name}@@${version ?? ""}`
}

function normalizeProjectModeProjectStatus(value?: string | null): ProjectModeProjectStatus {
  return value === "archived" ? "archived" : "active"
}

function normalizeProjectModeKeyword(value?: string | null): string {
  return String(value ?? "").trim()
}

function normalizeProjectModeAdapterName(value?: string | null): string {
  return String(value ?? "").trim()
}

function normalizeProjectModeCreatorKeyword(value?: string | null): string {
  return String(value ?? "").trim()
}

function normalizeProjectModeCreatorOrgKeyword(value?: string | null): string {
  return String(value ?? "").trim()
}

function isProjectModeNumericKeyword(value: string): boolean {
  return /^\d+$/.test(value)
}

function projectMatchesStatus(
  project: ProjectModeProjectView,
  status: ProjectModeProjectStatus
): boolean {
  return status === "archived"
    ? project.lifecycleStatus === "archived"
    : project.lifecycleStatus !== "archived"
}

function projectMatchesKeyword(project: ProjectModeProjectView, keyword: string): boolean {
  if (!keyword) return true
  const normalized = keyword.toLocaleLowerCase("zh-CN")
  return (
    project.name.toLocaleLowerCase("zh-CN").includes(normalized) ||
    (project.systemName ?? "").toLocaleLowerCase("zh-CN").includes(normalized)
  )
}

function projectMatchesAdapterName(project: ProjectModeProjectView, adapterName: string): boolean {
  if (!adapterName) return true
  return project.adapterName === adapterName
}

function projectMatchesCreatorKeyword(
  project: ProjectModeProjectView,
  creatorKeyword: string
): boolean {
  if (!creatorKeyword) return true
  if (isProjectModeNumericKeyword(creatorKeyword)) {
    return [project.creatorSapId, project.creatorYstId].some((value) => value === creatorKeyword)
  }
  const normalized = creatorKeyword.toLocaleLowerCase("zh-CN")
  return (project.creatorUserName ?? "").toLocaleLowerCase("zh-CN").includes(normalized)
}

function projectMatchesCreatorOrgKeyword(
  project: ProjectModeProjectView,
  creatorOrgKeyword: string
): boolean {
  if (!creatorOrgKeyword) return true
  const normalized = creatorOrgKeyword.toLocaleLowerCase("zh-CN")
  return [project.creatorUpperOrgLv1, project.creatorUpperOrgLv0, project.creatorOrgName].some(
    (value) => (value ?? "").toLocaleLowerCase("zh-CN").includes(normalized)
  )
}

function compareProjectByName(a: ProjectModeProjectView, b: ProjectModeProjectView): number {
  return (
    a.name.localeCompare(b.name, "zh-CN", { numeric: true }) ||
    (a.systemName ?? "").localeCompare(b.systemName ?? "", "zh-CN", { numeric: true }) ||
    a.projectId.localeCompare(b.projectId)
  )
}

function buildProjectModeProjectCounts(
  projects: ProjectModeProjectView[]
): ProjectModeProjectCounts {
  let active = 0
  let archived = 0
  let activeFeatureCount = 0
  let archivedFeatureCount = 0
  for (const project of projects) {
    if (project.lifecycleStatus === "archived") {
      archived += 1
      archivedFeatureCount += project.featureCount
    } else {
      active += 1
      activeFeatureCount += project.featureCount
    }
  }
  return {
    total: projects.length,
    active,
    archived,
    totalFeatureCount: activeFeatureCount + archivedFeatureCount,
    activeFeatureCount,
    archivedFeatureCount
  }
}

function formatProjectModeOrgName(
  orgName?: string,
  upperOrgLv1?: string,
  upperOrgLv0?: string
): string {
  if (upperOrgLv1 && upperOrgLv0) return `${upperOrgLv1}/${upperOrgLv0}`
  if (upperOrgLv1) return upperOrgLv1
  return orgName || "—"
}

function sortedProjectModeDistribution<
  T extends { count: number; key?: string; org?: string; name?: string }
>(items: T[]): T[] {
  return items.sort((a, b) => {
    const leftName = a.org ?? a.name ?? a.key ?? ""
    const rightName = b.org ?? b.name ?? b.key ?? ""
    return b.count - a.count || leftName.localeCompare(rightName, "zh-CN", { numeric: true })
  })
}

function buildProjectModeMockAnalytics(projects: ProjectModeProjectView[]): ProjectModeAnalytics {
  const userMap = new Map<string, ProjectModeTopUser>()
  const orgMap = new Map<string, ProjectModeOrgDistributionItem>()
  const adapterMap = new Map<string, ProjectModeAdapterShareItem>()

  for (const project of projects) {
    const sapId = project.creatorSapId || project.creatorYstId || "unknown"
    const user = userMap.get(sapId) ?? {
      sapId,
      ystId: project.creatorYstId,
      userName: project.creatorUserName || sapId,
      orgName: formatProjectModeOrgName(
        project.creatorOrgName,
        project.creatorUpperOrgLv1,
        project.creatorUpperOrgLv0
      ),
      count: 0
    }
    user.count += project.conversationCount
    userMap.set(sapId, user)

    const upperKey = project.creatorUpperOrgLv1 || project.creatorOrgName || "未知部门"
    const lowerKey = project.creatorUpperOrgLv0 || project.creatorOrgName || upperKey
    const upper = orgMap.get(upperKey) ?? {
      key: upperKey,
      org: upperKey,
      count: 0,
      children: []
    }
    upper.count += 1
    let lower = upper.children.find((item) => item.key === lowerKey)
    if (!lower) {
      lower = { key: lowerKey, org: lowerKey, count: 0, children: [] }
      upper.children.push(lower)
    }
    lower.count += 1
    orgMap.set(upperKey, upper)

    const adapterName = project.adapterName || "未知插件"
    const adapter = adapterMap.get(adapterName) ?? { name: adapterName, count: 0 }
    adapter.count += 1
    adapterMap.set(adapterName, adapter)
  }

  for (const item of orgMap.values()) sortedProjectModeDistribution(item.children)

  return {
    topUsers: [...userMap.values()].sort(
      (a, b) => b.count - a.count || a.userName.localeCompare(b.userName, "zh-CN")
    ),
    byOrg: sortedProjectModeDistribution([...orgMap.values()]),
    byAdapter: sortedProjectModeDistribution([...adapterMap.values()])
  }
}

function sliceProjectModeProjects(
  projects: ProjectModeProjectView[],
  options?: ProjectModeProjectPageOptions
): {
  projects: ProjectModeProjectView[]
  total: number
  page: number
  pageSize: number
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
} {
  const status = normalizeProjectModeProjectStatus(options?.status)
  const keyword = normalizeProjectModeKeyword(options?.keyword)
  const adapterName = normalizeProjectModeAdapterName(options?.adapterName)
  const creatorKeyword = normalizeProjectModeCreatorKeyword(options?.creatorKeyword)
  const creatorOrgKeyword = normalizeProjectModeCreatorOrgKeyword(options?.creatorOrgKeyword)
  const page = clampLimit(options?.page, 1, 10_000)
  const pageSize = clampLimit(options?.pageSize, 10, 100)
  const filtered = projects
    .filter((project) => projectMatchesStatus(project, status))
    .filter((project) => projectMatchesKeyword(project, keyword))
    .filter((project) => projectMatchesAdapterName(project, adapterName))
    .filter((project) => projectMatchesCreatorKeyword(project, creatorKeyword))
    .filter((project) => projectMatchesCreatorOrgKeyword(project, creatorOrgKeyword))
    .sort(compareProjectByName)
  const total = filtered.length
  const start = (page - 1) * pageSize
  return {
    projects: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    status,
    keyword,
    adapterName,
    creatorKeyword,
    creatorOrgKeyword
  }
}

/** Parse one harness.project.snapshot hit into a project view (no per-range usage yet). */
function parseProjectModeSnapshotHit(hit: unknown): ProjectModeProjectView | null {
  const source = asRecord(asRecord(hit)._source)
  const props = asRecord(source.properties)
  const projectId = asString(props.projectId)
  if (!projectId) return null
  const rawFeatures = Array.isArray(props.features) ? props.features : []
  const features: ProjectModeFeatureView[] = rawFeatures.map((entry) => {
    const f = asRecord(entry)
    return {
      slug: asString(f.slug),
      title: asString(f.title, asString(f.slug)),
      location: asOptionalString(f.location),
      statusLabel: asOptionalString(f.overallStatusLabel),
      currentNodeStatusLabel: asOptionalString(f.currentNodeStatusLabel),
      summary: asOptionalString(f.summary)
    }
  })
  return {
    projectId,
    name: asString(props.name, projectId),
    description: asOptionalString(props.description),
    systemName: asOptionalString(props.systemName),
    workspacePath: asOptionalString(props.workspacePath),
    adapterName: asOptionalString(props.adapterName),
    adapterVersion: asOptionalString(props.adapterVersion),
    creatorSapId: asOptionalString(props.creatorSapId) ?? asOptionalString(source.sapId),
    creatorYstId: asOptionalString(props.creatorYstId) ?? asOptionalString(source.ystId),
    creatorUserName: asOptionalString(props.creatorUserName) ?? asOptionalString(source.userName),
    creatorOrgName: asOptionalString(props.creatorOrgName) ?? asOptionalString(source.orgName),
    creatorUpperOrgLv0:
      asOptionalString(props.creatorUpperOrgLv0) ?? asOptionalString(source.upperOrgLv0),
    creatorUpperOrgLv1:
      asOptionalString(props.creatorUpperOrgLv1) ?? asOptionalString(source.upperOrgLv1),
    lifecycleStatus: asOptionalString(props.lifecycleStatus),
    compatible: typeof props.compatible === "boolean" ? props.compatible : undefined,
    compatibilityStatus: asOptionalString(props.compatibilityStatus),
    featureCount: asNumber(props.featureCount, features.length),
    conversationCount: 0,
    hasError: typeof props.error === "string" && props.error.length > 0,
    features,
    topSkills: [],
    codeStats: null
  }
}

/** Snapshot-index filter: snapshot event + optional LV1 org（快照顶层带 upperOrgLv1）。 */
function projectModeSnapshotFilters(
  orgFilterClause: Record<string, unknown> | null
): Record<string, unknown>[] {
  return [
    { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } },
    ...(orgFilterClause ? [orgFilterClause] : [])
  ]
}

type ProjectModeSnapshotAdapterCount = {
  name: string
  version?: string
  projectCount: number
  featureCount: number
}

type ProjectModeSnapshotAggs = {
  projectCount: number
  featureCount: number
  counts: ProjectModeProjectCounts
  adapters: Map<string, ProjectModeSnapshotAdapterCount>
  byOrg: ProjectModeOrgDistributionItem[]
}

function projectModeFirstNonEmptyFieldScript(
  fields: string[],
  missing = "未知部门"
): Record<string, unknown> {
  return {
    source: `
      for (def field : params.fields) {
        if (doc.containsKey(field) && doc[field].size() > 0) {
          def value = doc[field].value;
          if (value != null && value.toString().length() > 0) {
            return value;
          }
        }
      }
      return params.missing;
    `,
    params: { fields, missing }
  }
}

function parseProjectModeOrgDistributionBuckets(raw: unknown): ProjectModeOrgDistributionItem[] {
  if (!Array.isArray(raw)) return []
  const items = raw
    .map((bucket) => {
      const b = asRecord(bucket)
      const key = asString(b.key, "未知部门")
      const childBuckets = asRecord(b.by_lower_org).buckets
      return {
        key,
        org: key,
        count: asNumber(asRecord(b.project_count).value, asNumber(b.doc_count)),
        children: parseProjectModeOrgDistributionBuckets(childBuckets)
      }
    })
    .filter((item) => item.key.trim())
  return sortedProjectModeDistribution(items)
}

function buildProjectModeAdapterShare(
  adapters: ProjectModeAdapterView[]
): ProjectModeAdapterShareItem[] {
  const map = new Map<string, ProjectModeAdapterShareItem>()
  for (const adapter of adapters) {
    const name = adapter.name || "未知插件"
    const item = map.get(name) ?? { name, count: 0 }
    item.count += adapter.projectCount
    map.set(name, item)
  }
  return sortedProjectModeDistribution([...map.values()])
}

/**
 * 总览所需的快照口径全部用 size:0 聚合，不再回拉项目文档：项目总数 / 特性总数、
 * 进行中·已归档拆分、各插件(name→version)的项目数与特性数。快照为确定性 _id upsert
 * （每项目一条），故 cardinality / sum 即为去重后的口径。
 */
async function fetchProjectModeSnapshotAggs(
  opts?: OrgFilterOptions
): Promise<ProjectModeSnapshotAggs> {
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const projectCountAgg = { cardinality: { field: "properties.projectId" } }
  const featureSumAgg = { sum: { field: "properties.featureCount" } }
  const body = {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: projectModeSnapshotFilters(orgFilterClause) } },
    aggs: {
      project_count: projectCountAgg,
      feature_total: featureSumAgg,
      archived: {
        filter: { term: { "properties.lifecycleStatus": "archived" } },
        aggs: { project_count: projectCountAgg, feature_total: featureSumAgg }
      },
      by_adapter: {
        terms: { field: "properties.adapterName", size: 200 },
        aggs: {
          project_count: projectCountAgg,
          feature_total: featureSumAgg,
          by_version: {
            terms: { field: "properties.adapterVersion", size: 50 },
            aggs: { project_count: projectCountAgg, feature_total: featureSumAgg }
          }
        }
      },
      by_creator_org: {
        terms: {
          script: projectModeFirstNonEmptyFieldScript([
            "properties.creatorUpperOrgLv1",
            "upperOrgLv1",
            "properties.creatorOrgName",
            "orgName"
          ]),
          size: 100,
          order: { project_count: "desc" }
        },
        aggs: {
          project_count: projectCountAgg,
          by_lower_org: {
            terms: {
              script: projectModeFirstNonEmptyFieldScript([
                "properties.creatorUpperOrgLv0",
                "properties.creatorOrgName",
                "upperOrgLv0",
                "orgName"
              ]),
              size: 100,
              order: { project_count: "desc" }
            },
            aggs: { project_count: projectCountAgg }
          }
        }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("event"), body)) as EsSearchResponse
  const aggs = asRecord(raw.aggregations)
  const projectCount = asNumber(asRecord(aggs.project_count).value)
  const featureCount = asNumber(asRecord(aggs.feature_total).value)
  const archived = asRecord(aggs.archived)
  const archivedCount = asNumber(asRecord(archived.project_count).value)
  const archivedFeatureCount = asNumber(asRecord(archived.feature_total).value)
  const activeCount = Math.max(0, projectCount - archivedCount)
  const activeFeatureCount = Math.max(0, featureCount - archivedFeatureCount)

  const adapters = new Map<string, ProjectModeSnapshotAdapterCount>()
  const adapterBuckets = asRecord(aggs.by_adapter).buckets
  if (Array.isArray(adapterBuckets)) {
    for (const bucket of adapterBuckets) {
      const b = asRecord(bucket)
      const name = asString(b.key)
      if (!name) continue
      const versions = asRecord(b.by_version).buckets
      const versionList = Array.isArray(versions) ? versions : []
      if (versionList.length === 0) {
        adapters.set(adapterKey(name), {
          name,
          version: undefined,
          projectCount: asNumber(asRecord(b.project_count).value),
          featureCount: asNumber(asRecord(b.feature_total).value)
        })
        continue
      }
      for (const vb of versionList) {
        const v = asRecord(vb)
        const version = asOptionalString(v.key)
        adapters.set(adapterKey(name, version), {
          name,
          version,
          projectCount: asNumber(asRecord(v.project_count).value),
          featureCount: asNumber(asRecord(v.feature_total).value)
        })
      }
    }
  }

  return {
    projectCount,
    featureCount,
    counts: {
      total: projectCount,
      active: activeCount,
      archived: archivedCount,
      totalFeatureCount: featureCount,
      activeFeatureCount,
      archivedFeatureCount
    },
    adapters,
    byOrg: parseProjectModeOrgDistributionBuckets(asRecord(aggs.by_creator_org).buckets)
  }
}

/** Escape ES wildcard metacharacters in user keyword input. */
function escapeEsWildcard(value: string): string {
  return value.replace(/([*?\\])/g, "\\$1")
}

function buildProjectModeExactFieldShould(
  fields: string[],
  value: string
): Record<string, unknown>[] {
  return fields.flatMap((field) => [
    { term: { [field]: value } },
    { term: { [`${field}.keyword`]: value } }
  ])
}

function buildProjectModeFuzzyFieldShould(
  fields: string[],
  value: string
): Record<string, unknown>[] {
  const wildcardPattern = `*${escapeEsWildcard(value)}*`
  return fields.flatMap((field) => [
    { term: { [field]: value } },
    { term: { [`${field}.keyword`]: value } },
    { wildcard: { [field]: wildcardPattern } },
    { wildcard: { [`${field}.keyword`]: wildcardPattern } }
  ])
}

function buildProjectModeCreatorSearchFilter(
  creatorKeyword: string
): Record<string, unknown> | null {
  if (!creatorKeyword) return null
  const should = isProjectModeNumericKeyword(creatorKeyword)
    ? buildProjectModeExactFieldShould(
        ["properties.creatorSapId", "properties.creatorYstId", "sapId", "ystId"],
        creatorKeyword
      )
    : buildProjectModeFuzzyFieldShould(["properties.creatorUserName", "userName"], creatorKeyword)
  return { bool: { should, minimum_should_match: 1 } }
}

function buildProjectModeCreatorOrgSearchFilter(
  creatorOrgKeyword: string
): Record<string, unknown> | null {
  if (!creatorOrgKeyword) return null
  return {
    bool: {
      should: buildProjectModeFuzzyFieldShould(
        [
          "properties.creatorUpperOrgLv1",
          "properties.creatorUpperOrgLv0",
          "properties.creatorOrgName",
          "upperOrgLv1",
          "upperOrgLv0",
          "orgName"
        ],
        creatorOrgKeyword
      ),
      minimum_should_match: 1
    }
  }
}

/**
 * 列表分页交给 ES：状态(term) + 关键词(wildcard，按 keyword 原值匹配) + 名称排序 + from/size，
 * collapse(projectId) 兜底去重；total 用 cardinality 取去重后的项目数。返回的项目尚未带本期指标。
 */
async function fetchProjectModeProjectPageHits(options?: ProjectModeProjectPageOptions): Promise<{
  projects: ProjectModeProjectView[]
  total: number
  page: number
  pageSize: number
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
}> {
  const status = normalizeProjectModeProjectStatus(options?.status)
  const keyword = normalizeProjectModeKeyword(options?.keyword)
  const adapterName = normalizeProjectModeAdapterName(options?.adapterName)
  const creatorKeyword = normalizeProjectModeCreatorKeyword(options?.creatorKeyword)
  const creatorOrgKeyword = normalizeProjectModeCreatorOrgKeyword(options?.creatorOrgKeyword)
  const pageSize = clampLimit(options?.pageSize, 10, 100)
  const maxPage = Math.max(1, Math.floor(ES_MAX_RESULT_WINDOW / pageSize))
  const page = clampLimit(options?.page, 1, maxPage)
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(options?.upperOrgLv1))

  const statusFilter: Record<string, unknown>[] =
    status === "archived"
      ? [{ term: { "properties.lifecycleStatus": "archived" } }]
      : [{ bool: { must_not: { term: { "properties.lifecycleStatus": "archived" } } } }]
  const keywordFilter: Record<string, unknown>[] = keyword
    ? [
        {
          bool: {
            should: [
              { wildcard: { "properties.name": { value: `*${escapeEsWildcard(keyword)}*` } } },
              {
                wildcard: { "properties.systemName": { value: `*${escapeEsWildcard(keyword)}*` } }
              }
            ],
            minimum_should_match: 1
          }
        }
      ]
    : []
  const adapterFilter: Record<string, unknown>[] = adapterName
    ? [{ term: { "properties.adapterName": adapterName } }]
    : []
  const creatorSearchFilter = buildProjectModeCreatorSearchFilter(creatorKeyword)
  const creatorOrgSearchFilter = buildProjectModeCreatorOrgSearchFilter(creatorOrgKeyword)

  const body = {
    track_total_hits: false,
    from: (page - 1) * pageSize,
    size: pageSize,
    query: {
      bool: {
        filter: [
          ...projectModeSnapshotFilters(orgFilterClause),
          ...statusFilter,
          ...keywordFilter,
          ...adapterFilter,
          ...(creatorSearchFilter ? [creatorSearchFilter] : []),
          ...(creatorOrgSearchFilter ? [creatorOrgSearchFilter] : [])
        ]
      }
    },
    sort: [{ "properties.name": { order: "asc" } }, { "properties.projectId": { order: "asc" } }],
    collapse: { field: "properties.projectId" },
    aggs: { distinct_projects: { cardinality: { field: "properties.projectId" } } },
    _source: {
      includes: [
        "eventTime",
        "userName",
        "sapId",
        "ystId",
        "orgName",
        "upperOrgLv0",
        "upperOrgLv1",
        "properties"
      ]
    }
  }
  const raw = (await esQuery(getEsIndex("event"), body)) as EsSearchResponse
  const hits = raw.hits?.hits ?? []
  const projects = hits
    .map((hit) => parseProjectModeSnapshotHit(hit))
    .filter((project): project is ProjectModeProjectView => project !== null)
  const total = asNumber(
    asRecord(asRecord(raw.aggregations).distinct_projects).value,
    projects.length
  )
  return {
    projects,
    total,
    page,
    pageSize,
    status,
    keyword,
    adapterName,
    creatorKeyword,
    creatorOrgKeyword
  }
}

/** Upper bound on the project set forwarded to the code-adoption query (ES terms cap is 65536). */
const PROJECT_MODE_PROJECT_ID_LIMIT = 5000
const PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE = 10

/** Convert a `terms usedSkills` bucket list into a {skill,count}[] ranking. */
function parseSkillCountBuckets(raw: unknown): ProjectModeSkillCount[] {
  if (!Array.isArray(raw)) return []
  const result: ProjectModeSkillCount[] = []
  for (const bucket of raw) {
    const b = asRecord(bucket)
    const skill = asString(b.key)
    if (skill) result.push({ skill, count: asNumber(b.doc_count) })
  }
  return result
}

/** Convert a `terms toolNames` bucket list into a {tool,count}[] ranking. */
function parseToolCountBuckets(raw: unknown): ProjectModeToolCount[] {
  if (!Array.isArray(raw)) return []
  const result: ProjectModeToolCount[] = []
  for (const bucket of raw) {
    const b = asRecord(bucket)
    const tool = asString(b.key)
    if (tool) result.push({ tool, count: asNumber(b.doc_count) })
  }
  return result
}

function parseProjectModeTopUserBuckets(raw: unknown): ProjectModeTopUser[] {
  if (!Array.isArray(raw)) return []
  const result: ProjectModeTopUser[] = []
  for (const bucket of raw) {
    const b = asRecord(bucket)
    const latestHits = asRecord(asRecord(b.latest_user_info).hits).hits
    const latestHit = Array.isArray(latestHits) ? asRecord(latestHits[0]) : {}
    const source = asRecord(latestHit._source)
    const sapId = asString(b.key, asString(source.sapId))
    if (!sapId) continue
    const ystId = asOptionalString(source.ystId)
    const userName = asString(source.userName, sapId)
    const orgName = formatProjectModeOrgName(
      asOptionalString(source.orgName),
      asOptionalString(source.upperOrgLv1),
      asOptionalString(source.upperOrgLv0)
    )
    result.push({
      sapId,
      ...(ystId ? { ystId } : {}),
      userName,
      orgName,
      count: asNumber(b.doc_count)
    })
  }
  return result
}

/** Aggregate project-mode usage from the trace index over the selected range. */
async function fetchProjectModeUsage(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<{
  conversationCount: number
  activeProjectCount: number
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  skillCallCount: number
  distinctSkillCount: number
  topSkills: ProjectModeSkillCount[]
  tools: ProjectModeToolUsage
  topUsers: ProjectModeTopUser[]
  adapters: Map<string, ProjectModeAdapterView>
}> {
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const body = {
    size: 0,
    query: { bool: { filter: projectModeTraceFilters(range, orgFilterClause) } },
    aggs: {
      conversation_count: { value_count: { field: "traceId" } },
      active_projects: { cardinality: { field: "harnessProjectId" } },
      total_tool_calls: { sum: { field: "totalToolCalls" } },
      total_input_tokens: { sum: { field: "totalInputTokens" } },
      total_output_tokens: { sum: { field: "totalOutputTokens" } },
      total_tokens: { sum: { field: "totalTokens" } },
      total_skill_calls: { value_count: { field: "usedSkills" } },
      distinct_skills: { cardinality: { field: "usedSkills" } },
      top_skills: { terms: { field: "usedSkills", size: 20 } },
      top_users: {
        terms: { field: "sapId", size: 10 },
        aggs: {
          latest_user_info: {
            top_hits: {
              size: 1,
              sort: [{ startedAt: { order: "desc" } }],
              _source: {
                includes: ["sapId", "ystId", "userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
              }
            }
          }
        }
      },
      total_tools: { cardinality: { field: "toolNames" } },
      tool_call_count: { value_count: { field: "toolNames" } },
      by_tool: { terms: { field: "toolNames", size: 20, exclude: FILTERED_TOOL_EXCLUDES } },
      by_tool_filtered_all: {
        terms: { field: "toolNames", size: 1000, exclude: FILTERED_TOOL_EXCLUDES }
      },
      by_tool_all: { terms: { field: "toolNames", size: 20 } },
      by_tool_all_full: { terms: { field: "toolNames", size: 1000 } },
      by_adapter: {
        terms: { field: "harnessAdapterName", size: 200 },
        aggs: { by_version: { terms: { field: "harnessAdapterVersion", size: 50 } } }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const aggs = asRecord(raw.aggregations)

  const totalInputTokens = asNumber(asRecord(aggs.total_input_tokens).value)
  const totalOutputTokens = asNumber(asRecord(aggs.total_output_tokens).value)
  const totalTokens = asNumber(
    asRecord(aggs.total_tokens).value,
    totalInputTokens + totalOutputTokens
  )

  const adapters = new Map<string, ProjectModeAdapterView>()
  const adapterBuckets = asRecord(aggs.by_adapter).buckets
  if (Array.isArray(adapterBuckets)) {
    for (const bucket of adapterBuckets) {
      const b = asRecord(bucket)
      const name = asString(b.key)
      if (!name) continue
      const rawVersions = asRecord(b.by_version).buckets
      const versions = Array.isArray(rawVersions) ? rawVersions : []
      if (versions.length === 0) {
        adapters.set(adapterKey(name), {
          name,
          version: undefined,
          projectCount: 0,
          featureCount: 0,
          conversationCount: asNumber(b.doc_count),
          codeStats: null
        })
        continue
      }
      for (const vb of versions) {
        const v = asRecord(vb)
        const version = asOptionalString(v.key)
        adapters.set(adapterKey(name, version), {
          name,
          version,
          projectCount: 0,
          featureCount: 0,
          conversationCount: asNumber(v.doc_count),
          codeStats: null
        })
      }
    }
  }

  return {
    conversationCount: asNumber(asRecord(aggs.conversation_count).value),
    activeProjectCount: asNumber(asRecord(aggs.active_projects).value),
    totalToolCalls: asNumber(asRecord(aggs.total_tool_calls).value),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    skillCallCount: asNumber(asRecord(aggs.total_skill_calls).value),
    distinctSkillCount: asNumber(asRecord(aggs.distinct_skills).value),
    topSkills: parseSkillCountBuckets(asRecord(aggs.top_skills).buckets),
    topUsers: parseProjectModeTopUserBuckets(asRecord(aggs.top_users).buckets),
    tools: {
      byTool: parseToolCountBuckets(asRecord(aggs.by_tool).buckets),
      byToolAll: parseToolCountBuckets(asRecord(aggs.by_tool_all).buckets),
      byToolFilteredAll: parseToolCountBuckets(asRecord(aggs.by_tool_filtered_all).buckets),
      byToolAllFull: parseToolCountBuckets(asRecord(aggs.by_tool_all_full).buckets),
      totalTools: asNumber(asRecord(aggs.total_tools).value),
      totalToolCalls: asNumber(asRecord(aggs.tool_call_count).value)
    },
    adapters
  }
}

async function fetchProjectModePageUsage(
  projectIds: string[],
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<{
  perProject: Map<string, number>
  perProjectSkills: Map<string, ProjectModeSkillCount[]>
}> {
  const perProject = new Map<string, number>()
  const perProjectSkills = new Map<string, ProjectModeSkillCount[]>()
  if (projectIds.length === 0) return { perProject, perProjectSkills }

  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          ...projectModeTraceFilters(range, orgFilterClause),
          { terms: { harnessProjectId: projectIds } }
        ]
      }
    },
    aggs: {
      by_project: {
        terms: { field: "harnessProjectId", size: Math.max(1, projectIds.length) },
        aggs: {
          skills: { terms: { field: "usedSkills", size: 10 } }
        }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const buckets = asRecord(asRecord(raw.aggregations).by_project).buckets
  if (!Array.isArray(buckets)) return { perProject, perProjectSkills }

  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const key = asString(b.key)
    if (!key) continue
    perProject.set(key, asNumber(b.doc_count))
    perProjectSkills.set(key, parseSkillCountBuckets(asRecord(b.skills).buckets))
  }

  return { perProject, perProjectSkills }
}

/**
 * Code-adoption stats for project mode.
 *
 * `code_gen` / `code_adopt` events carry top-level `upperOrgLv1` (buildEvent) plus
 * `properties.harnessProjectId` and the bound adapter, so adoption can be aggregated
 * directly by project / adapter / skill in one query — no traceId → project join and
 * no per-trace fan-out cap. The aggregate path passes the org clause via `extraFilters`
 * (filtering code events by org directly, no project-id enumeration); the per-page path
 * passes `projectIds` to scope to exactly the displayed projects.
 */
function buildProjectModeCodeAggs(
  projectIds: string[] | null,
  range: TimeRange,
  extraFilters: Record<string, unknown>[] = []
): {
  codeGenFilters: Record<string, unknown>[]
  codeAdoptFilters: Record<string, unknown>[]
  perBucketAggs: Record<string, unknown>
} {
  const projectFilters = projectIds
    ? [{ terms: { "properties.harnessProjectId": projectIds } }]
    : []
  const codeGenFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_gen" } },
    timeRangeFilter("eventTime", range),
    ...projectFilters,
    ...extraFilters
  ]
  const codeAdoptFilters: Record<string, unknown>[] = [
    { term: { eventName: "code_adopt" } },
    { exists: { field: "properties.adoptedLineCount" } },
    { exists: { field: "properties.generatedLineCount" } },
    { exists: { field: "properties.effectiveGeneratedLineCount" } },
    timeRangeFilter("properties.generatedAt", range),
    ...projectFilters,
    ...extraFilters
  ]
  const codeAdoptPushedFilters: Record<string, unknown>[] = [
    ...codeAdoptFilters,
    { term: { "properties.pushed": true } }
  ]
  const perBucketAggs = {
    code_gen: {
      filter: { bool: { filter: codeGenFilters } },
      aggs: {
        generated_lines: { sum: { field: "properties.lineCount" } },
        deleted_lines: { sum: { field: "properties.deletedLineCount" } }
      }
    },
    code_adopt_measured: {
      filter: { bool: { filter: codeAdoptFilters } },
      aggs: {
        measured_generated_lines: { sum: { field: "properties.generatedLineCount" } },
        effective_generated_lines: effectiveGeneratedLinesSumAgg(),
        adopted_lines: { sum: { field: "properties.adoptedLineCount" } },
        commit_count: { cardinality: { field: "properties.commitSha" } }
      }
    },
    code_adopt_pushed: {
      filter: { bool: { filter: codeAdoptPushedFilters } },
      aggs: codeAdoptPushedAggs()
    }
  }
  return { codeGenFilters, codeAdoptFilters, perBucketAggs }
}

/** Map a `terms` bucket list (project / skill) keyed by `key` → per-bucket code stats. */
function parseCodeStatsBucketsByKey(buckets: unknown): Map<string, DashboardCodeStats> {
  const map = new Map<string, DashboardCodeStats>()
  if (!Array.isArray(buckets)) return map
  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const key = asString(b.key)
    if (!key) continue
    map.set(key, normalizeCodeStatsFromContainer(b))
  }
  return map
}

/**
 * Map the nested `harnessAdapterName → harnessAdapterVersion` bucket tree → code
 * stats keyed by `adapterKey(name, version)`. Mirrors the usage-side adapter
 * merge: read version-level stats when versions exist, else the name-level bucket.
 */
function parseAdapterCodeStatsBuckets(buckets: unknown): Map<string, DashboardCodeStats> {
  const map = new Map<string, DashboardCodeStats>()
  if (!Array.isArray(buckets)) return map
  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const name = asString(b.key)
    if (!name) continue
    const rawVersions = asRecord(b.by_version).buckets
    const versions = Array.isArray(rawVersions) ? rawVersions : []
    if (versions.length === 0) {
      map.set(adapterKey(name), normalizeCodeStatsFromContainer(b))
      continue
    }
    for (const vb of versions) {
      const v = asRecord(vb)
      const version = asOptionalString(v.key)
      map.set(adapterKey(name, version), normalizeCodeStatsFromContainer(v))
    }
  }
  return map
}

/**
 * Code-adoption stats for project mode. Keep the page payload unchanged, but
 * split the ES DSL by aggregation dimension so one request no longer has to
 * hold overall + project + adapter + skill bucket trees at the same time.
 */
type ProjectModeCodeStatsResult = {
  overall: DashboardCodeStats
  byProject: Map<string, DashboardCodeStats>
  byAdapter: Map<string, DashboardCodeStats>
  bySkill: DashboardSkillCodeAdoptionStats[]
}

async function fetchProjectModeCodeAggs(
  projectIds: string[] | null,
  range: TimeRange,
  buildAggs: (
    perBucketAggs: Record<string, unknown>,
    scopedProjectIds: string[]
  ) => Record<string, unknown>,
  extraFilters: Record<string, unknown>[] = []
): Promise<unknown | null> {
  if (projectIds && projectIds.length === 0) return null
  const scopedProjectIds = projectIds?.slice(0, PROJECT_MODE_PROJECT_ID_LIMIT) ?? []
  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    projectIds ? scopedProjectIds : null,
    range,
    extraFilters
  )
  const body = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: buildAggs(perBucketAggs, scopedProjectIds)
  }
  return esQuery(getEsIndex("event"), body)
}

async function fetchProjectModeAggregateCodeStats(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<ProjectModeCodeStatsResult> {
  // code 事件自带顶层 upperOrgLv1，直接按室过滤即可，无需先枚举项目 id 再用 terms 圈定。
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const extraFilters = orgFilterClause ? [orgFilterClause] : []

  const [overallRaw, adapterRaw, skillRaw] = await Promise.all([
    fetchProjectModeCodeAggs(null, range, (perBucketAggs) => perBucketAggs, extraFilters),
    fetchProjectModeCodeAggs(
      null,
      range,
      (perBucketAggs) => ({
        by_adapter: {
          terms: { field: "properties.harnessAdapterName", size: 200 },
          aggs: {
            ...perBucketAggs,
            by_version: {
              terms: { field: "properties.harnessAdapterVersion", size: 50 },
              aggs: perBucketAggs
            }
          }
        }
      }),
      extraFilters
    ),
    fetchProjectModeCodeAggs(
      null,
      range,
      (perBucketAggs) => ({
        by_skill: {
          terms: { field: "properties.usedSkills", size: 1000 },
          aggs: perBucketAggs
        }
      }),
      extraFilters
    )
  ])

  const adapterAggs = asRecord(asRecord(adapterRaw).aggregations)
  const skillAggs = asRecord(asRecord(skillRaw).aggregations)
  return {
    overall: normalizeCodeStatsFromAggs(overallRaw),
    byProject: new Map<string, DashboardCodeStats>(),
    byAdapter: parseAdapterCodeStatsBuckets(asRecord(adapterAggs.by_adapter).buckets),
    bySkill: normalizeSkillCodeAdoptionBuckets({ aggregations: skillAggs }, "by_skill")
  }
}

async function fetchProjectModeProjectCodeStats(
  projectIds: string[],
  range: TimeRange
): Promise<Map<string, DashboardCodeStats>> {
  if (projectIds.length === 0) return new Map<string, DashboardCodeStats>()

  const raw = await fetchProjectModeCodeAggs(
    projectIds,
    range,
    (perBucketAggs, scopedProjectIds) => ({
      by_project: {
        terms: { field: "properties.harnessProjectId", size: Math.max(1, scopedProjectIds.length) },
        aggs: perBucketAggs
      }
    })
  )
  const projectAggs = asRecord(asRecord(raw).aggregations)
  return parseCodeStatsBucketsByKey(asRecord(projectAggs.by_project).buckets)
}

/** One list page: ES-paginated snapshot projects enriched with this-range usage / code. */
async function fetchProjectModeProjectPage(
  range: TimeRange,
  options?: ProjectModeProjectPageOptions
): Promise<ProjectModeProjectPageData> {
  requireDashboardAccess()
  const sliced = await fetchProjectModeProjectPageHits(options)
  const projectIds = sliced.projects.map((project) => project.projectId)
  const usage = await fetchProjectModePageUsage(projectIds, range, options)
  const codeByProject = await fetchProjectModeProjectCodeStats([...usage.perProject.keys()], range)
  return {
    ...sliced,
    projects: sliced.projects.map((project) => ({
      ...project,
      conversationCount: usage.perProject.get(project.projectId) ?? 0,
      topSkills: usage.perProjectSkills.get(project.projectId) ?? [],
      codeStats: codeByProject.get(project.projectId) ?? null
    }))
  }
}

/** Overview payload: snapshot aggregates + trace usage + code adoption + first list page. */
async function fetchProjectMode(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<DashboardProjectModeData> {
  requireDashboardAccess()
  // 总览与列表解耦：快照口径走 size:0 聚合、不回拉文档；列表第一页走 ES 分页。四条并行。
  const [snap, usage, code, projectPage] = await Promise.all([
    fetchProjectModeSnapshotAggs(opts),
    fetchProjectModeUsage(range, opts),
    fetchProjectModeAggregateCodeStats(range, opts),
    fetchProjectModeProjectPage(range, {
      ...opts,
      status: "active",
      page: 1,
      pageSize: PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE,
      keyword: ""
    })
  ])

  // Adapter rows: usage carries conversation counts, snapshot aggs carry project /
  // feature counts, code aggs carry adoption — union by adapterKey.
  const adapters = new Map<string, ProjectModeAdapterView>()
  for (const [key, view] of usage.adapters) adapters.set(key, { ...view })
  for (const [key, snapAdapter] of snap.adapters) {
    const existing = adapters.get(key)
    if (existing) {
      existing.projectCount += snapAdapter.projectCount
      existing.featureCount += snapAdapter.featureCount
    } else {
      adapters.set(key, {
        name: snapAdapter.name,
        version: snapAdapter.version,
        projectCount: snapAdapter.projectCount,
        featureCount: snapAdapter.featureCount,
        conversationCount: 0,
        codeStats: null
      })
    }
  }
  for (const [key, adapter] of adapters) {
    adapter.codeStats = code.byAdapter.get(key) ?? null
  }
  const adapterList = [...adapters.values()].sort(
    (a, b) =>
      b.projectCount - a.projectCount ||
      b.conversationCount - a.conversationCount ||
      a.name.localeCompare(b.name) ||
      (a.version ?? "").localeCompare(b.version ?? "")
  )

  return {
    summary: {
      projectCount: snap.projectCount,
      featureCount: snap.featureCount,
      activeProjectCount: usage.activeProjectCount,
      conversationCount: usage.conversationCount,
      totalToolCalls: usage.totalToolCalls,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalTokens: usage.totalTokens,
      skillCallCount: usage.skillCallCount,
      distinctSkillCount: usage.distinctSkillCount,
      codeStats: code.overall
    },
    adapters: adapterList,
    topSkills: usage.topSkills,
    bySkillAdoption: code.bySkill,
    tools: usage.tools,
    analytics: {
      topUsers: usage.topUsers,
      byOrg: snap.byOrg,
      byAdapter: buildProjectModeAdapterShare(adapterList)
    },
    projectCounts: snap.counts,
    projectPage,
    projects: projectPage.projects
  }
}

interface ProjectModeTracesOptions {
  limit?: number
  page?: number
  pageSize?: number
  tracePage?: number
  tracePageSize?: number
  mode?: TraceViewMode
  viewMode?: TraceViewMode
  triggerScope?: TraceTriggerScope
  featureSlug?: string
}

/** Project-mode traces for a single project (thread/trace pagination). */
async function fetchProjectModeTraces(
  projectId: string,
  range: TimeRange,
  options?: ProjectModeTracesOptions
): Promise<DashboardProjectModeTracesData> {
  const access = requireDashboardAccess()
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) throw new Error("projectId is required")
  const normalizedFeatureSlug = options?.featureSlug?.trim()
  const traceViewMode = normalizeTraceViewMode(options?.viewMode ?? options?.mode)
  const tracePageSize = clampLimit(
    options?.tracePageSize ?? options?.pageSize ?? options?.limit,
    10,
    50
  )
  // 深翻页用 from+size，必须保证 from+size ≤ max_result_window，否则 ES 直接报错。
  // 按 pageSize 动态收紧页数上限（pageSize=50 → 最多 200 页），避免运营面板翻到深页时 500。
  const maxTracePage = Math.max(1, Math.floor(ES_MAX_RESULT_WINDOW / tracePageSize))
  const tracePage = clampLimit(options?.tracePage ?? options?.page, 1, maxTracePage)
  const triggerScope = normalizeTraceTriggerScope(options?.triggerScope)
  const traceAccessFilter = buildTraceAccessFilter(access)
  const baseFilter = [
    timeRangeFilter("startedAt", range),
    { term: { harnessProjectId: normalizedProjectId } },
    ...(normalizedFeatureSlug ? [{ term: { harnessFeatureSlug: normalizedFeatureSlug } }] : []),
    ...(triggerScope === "active" ? [buildChatTriggeredTraceFilter()] : [])
  ]

  if (traceViewMode === "thread") {
    const body = {
      size: 0,
      query: {
        bool: { filter: baseFilter }
      },
      aggs: {
        thread_list: {
          filter: traceAccessFilter ?? { match_all: {} },
          aggs: threadListAgg(threadListBucketsNeeded(tracePage, tracePageSize))
        }
      }
    }
    const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
    const aggs = asRecord((raw as unknown as Record<string, unknown>).aggregations)
    const parsed = parseThreadListContainer(asRecord(aggs.thread_list), tracePage, tracePageSize)
    return {
      traces: parsed.traces,
      tracePage,
      tracePageSize,
      total: parsed.totalThreads,
      traceViewMode,
      traceTriggerScope: triggerScope
    }
  }

  const body = {
    track_total_hits: ES_MAX_RESULT_WINDOW,
    from: (tracePage - 1) * tracePageSize,
    size: tracePageSize,
    sort: [{ startedAt: { order: "desc" } }],
    query: {
      bool: { filter: baseFilter }
    },
    ...(traceAccessFilter ? { post_filter: traceAccessFilter } : {}),
    _source: { includes: dashboardTraceSourceIncludes() }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const hits = raw.hits?.hits ?? []
  return {
    traces: hits.map(normalizeTraceDetail),
    tracePage,
    tracePageSize,
    // from+size 只能触达前 max_result_window 条，故按相同上限收口 total，
    // 让前端算出的总页数与实际可翻到的深度一致。
    total: Math.min(getTotalHits(raw, hits.length), ES_MAX_RESULT_WINDOW),
    traceViewMode,
    traceTriggerScope: triggerScope
  }
}

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDashboardHandlers(_ipcMain: typeof ipcMain): void {
  _ipcMain.handle("dashboard:isAllowed", async () => {
    return getDashboardAccessContext().loggedIn
  })

  _ipcMain.handle("dashboard:isProjectModeAllowed", async () => {
    return isDashboardProjectModeAllowed()
  })

  _ipcMain.handle(
    "dashboard:projectMode",
    async (_, range: TimeRange, _granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProjectMode(range, opts) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectMode(range, opts) }
      } catch (e) {
        console.error("[Dashboard] projectMode error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:projectModeProjects",
    async (_, range: TimeRange, options?: ProjectModeProjectPageOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockProjectModeProjects(range, options) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeProjectPage(range, options) }
      } catch (e) {
        console.error("[Dashboard] projectModeProjects error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:projectModeTraces",
    async (_, projectId: string, range: TimeRange, options?: ProjectModeTracesOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockProjectModeTraces(projectId, range, options) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeTraces(projectId, range, options) }
      } catch (e) {
        console.error("[Dashboard] projectModeTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:overview",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOverview(range, opts) }
      try {
        return { success: true, data: await fetchOverview(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] overview error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:modelStats",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockModelStats(opts) }
      try {
        return { success: true, data: await fetchModelStats(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] modelStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:orgOptions", async (_, range: TimeRange) => {
    if (import.meta.env.DEV) return { success: true, data: makeMockOrgOptions() }
    try {
      return { success: true, data: await fetchOrgOptions(range) }
    } catch (e) {
      console.error("[Dashboard] orgOptions error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:userStats",
    async (_, range: TimeRange, granularity: Granularity, opts?: UserStatsOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockUserStats(range, opts) }
      try {
        return { success: true, data: await fetchUserStats(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] userStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:userList", async (_, range: TimeRange, options?: UserListOptions) => {
    if (import.meta.env.DEV) return { success: true, data: makeMockUserList(range, options) }
    try {
      return { success: true, data: await fetchUserList(range, options) }
    } catch (e) {
      console.error("[Dashboard] userList error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:userDetail",
    async (_, sapId: string, range: TimeRange, options?: UserDetailOptions) => {
      const normalizedSapId = sapId?.trim?.() ?? ""
      if (!normalizedSapId) return { success: false, error: "sapId is required" }
      if (import.meta.env.DEV)
        return { success: true, data: makeMockUserDetail(normalizedSapId, range, options) }
      try {
        return { success: true, data: await fetchUserDetail(normalizedSapId, range, options) }
      } catch (e) {
        console.error("[Dashboard] userDetail error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillUsageSummary",
    async (_, range: TimeRange, granularity: Granularity, skillNames?: string[]) => {
      // `skillNames` 为可选参数：传入后走更精确的 filters 聚合。
      if (import.meta.env.DEV) return { success: true, data: makeMockSkillUsageSummary(range) }
      try {
        return { success: true, data: await fetchSkillUsageSummary(range, granularity, skillNames) }
      } catch (e) {
        console.error("[Dashboard] skillUsageSummary error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillEvalSummary",
    async (_, range: TimeRange, options?: DashboardSkillEvalOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockSkillEvalSummary(range, options) }
      try {
        return { success: true, data: await fetchSkillEvalSummary(range, options) }
      } catch (e) {
        console.error("[Dashboard] skillEvalSummary error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillUserStats",
    async (_, range: TimeRange, granularity: Granularity, skillName: string) => {
      const trimmedSkillName = skillName?.trim?.() ?? ""
      if (!trimmedSkillName) {
        return { success: false, error: "skillName is required" }
      }
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockSkillUserStats(range, trimmedSkillName) }
      }
      try {
        return {
          success: true,
          data: await fetchSkillUserStats(range, granularity, trimmedSkillName)
        }
      } catch (e) {
        console.error("[Dashboard] skillUserStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:userProfiles", async (_, sapIds: string[]) => {
    const sanitizedSapIds = Array.isArray(sapIds)
      ? sapIds.filter((id): id is string => typeof id === "string")
      : []
    if (import.meta.env.DEV) {
      return { success: true, data: makeMockUserProfilesBySapIds(sanitizedSapIds) }
    }
    try {
      return { success: true, data: await fetchUserProfilesBySapIds(sanitizedSapIds) }
    } catch (e) {
      console.error("[Dashboard] userProfiles error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle("dashboard:queryAllUser", async () => {
    if (import.meta.env.DEV) {
      return { success: true, data: makeMockAllUsers() }
    }
    try {
      return { success: true, data: await queryAllUser() }
    } catch (e) {
      console.error("[Dashboard] queryAllUser error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:productivity",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProductivity(range, opts) }
      try {
        return { success: true, data: await fetchProductivity(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] productivity error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:feedback",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockFeedback(range, granularity, opts) }
      try {
        return { success: true, data: await fetchFeedback(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] feedback error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillRecentTraces",
    async (
      _,
      skill: string,
      range: TimeRange,
      limit?: number,
      mode?: TraceViewMode,
      triggerScope?: TraceTriggerScope
    ) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockSkillRecentTraces(skill, range, limit) }
      try {
        return {
          success: true,
          data: (
            await fetchSkillRecentTraces(
              skill,
              range,
              limit,
              1,
              normalizeTraceViewMode(mode),
              normalizeTraceTriggerScope(triggerScope)
            )
          ).traces
        }
      } catch (e) {
        console.error("[Dashboard] skillRecentTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:threadTraces", async (_, threadId: string) => {
    if (import.meta.env.DEV) return { success: true, data: makeMockThreadTraces(threadId) }
    try {
      return { success: true, data: await fetchThreadTraces(threadId) }
    } catch (e) {
      console.error("[Dashboard] threadTraces error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:marketSkillRecentTraces",
    async (
      _,
      skill: string,
      range: TimeRange,
      limit?: number,
      mode?: TraceViewMode,
      triggerScope?: TraceTriggerScope
    ) => {
      const trimmedSkill = skill?.trim?.() ?? ""
      if (!trimmedSkill) return { success: false, error: "skill is required" }
      if (import.meta.env.DEV)
        return { success: true, data: makeMockSkillRecentTraces(trimmedSkill, range, limit) }
      try {
        return {
          success: true,
          data: (
            await fetchSkillRecentTraces(
              trimmedSkill,
              range,
              limit,
              1,
              normalizeTraceViewMode(mode),
              normalizeTraceTriggerScope(triggerScope)
            )
          ).traces
        }
      } catch (e) {
        console.error("[Dashboard] marketSkillRecentTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillDetail",
    async (_, skill: string, range: TimeRange, options?: number | TracePageOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockSkillDetail(skill, range, options) }
      try {
        return { success: true, data: await fetchSkillDetail(skill, range, options) }
      } catch (e) {
        console.error("[Dashboard] skillDetail error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:commitDetails",
    async (_, range: TimeRange, options?: number | CommitDetailsOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockCommitDetails(range, options) }
      try {
        return { success: true, data: await fetchCommitDetails(range, options) }
      } catch (e) {
        console.error("[Dashboard] commitDetails error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:exportSkillTraces", async (event, rawPayload: unknown) => {
    try {
      const payload = normalizeTraceExportPayload(rawPayload)
      if (!payload.skill) return { success: false, error: "skill is required" }
      if (payload.traces.length === 0) return { success: false, error: "暂无可导出的会话记录" }

      const exportedAt = new Date().toISOString()
      const date = exportedAt.slice(0, 10)
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: "导出 Skill 会话历史",
        defaultPath: `${safeExportFileName(payload.skill)}-traces-page-${payload.page}-${date}.zip`,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      const zip = new AdmZip()
      zip.addFile("traces.md", Buffer.from(formatTraceExportMarkdown(payload, exportedAt), "utf-8"))
      zip.addFile(
        "traces.json",
        Buffer.from(`${stringifyExportValue({ version: 1, exportedAt, ...payload })}\n`, "utf-8")
      )
      zip.writeZip(result.filePath)

      return { success: true, filePath: result.filePath }
    } catch (e) {
      console.error("[Dashboard] exportSkillTraces error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:exportExcel",
    async (_, sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }>) => {
      try {
        // Dynamic import xlsx to avoid bundling issues
        const XLSX = await import("xlsx")

        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const wsData = [sheet.header, ...sheet.rows]
          const ws = XLSX.utils.aoa_to_sheet(wsData)

          // Auto-size columns based on content
          const colWidths = sheet.header.map((h, i) => {
            let maxLen = h.length
            for (const row of sheet.rows) {
              const cellLen = String(row[i] ?? "").length
              if (cellLen > maxLen) maxLen = cellLen
            }
            return { wch: Math.min(maxLen + 4, 40) }
          })
          ws["!cols"] = colWidths

          XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
        }

        const win = BrowserWindow.getFocusedWindow()
        const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
          title: "导出运营面板数据",
          defaultPath: `运营面板数据_${new Date().toISOString().slice(0, 10)}.xlsx`,
          filters: [{ name: "Excel", extensions: ["xlsx"] }]
        })

        if (result.canceled || !result.filePath) {
          return { success: false, canceled: true }
        }

        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" })
        fs.writeFileSync(result.filePath, buf)

        return { success: true, filePath: result.filePath }
      } catch (e) {
        console.error("[Dashboard] exportExcel error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
}
