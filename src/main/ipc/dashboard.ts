/**
 * Dashboard IPC Handlers
 *
 * Proxies Elasticsearch queries for the operations dashboard.
 * The renderer never connects to ES directly — all queries go through
 * these IPC handlers for security.
 */

import { ipcMain, dialog, BrowserWindow } from "electron"
import * as fs from "fs"
import AdmZip from "adm-zip"
import { buildTraceTree } from "../agent/trace/tree-builder"
import type { AgentTrace, TraceNode, TraceTriggerSource } from "../agent/trace/types"
import { getUserInfo } from "../storage"
import { getSkillIdentifierLookupTerms } from "../utils/skill-identifiers"
import {
  effectiveGeneratedLinesSumAgg,
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs,
  normalizeSkillCodeAdoptionBuckets,
  type DashboardCodeStats
} from "./dashboard-code-stats"

// ─────────────────────────────────────────────────────────
// ES Configuration (from .env)
// ─────────────────────────────────────────────────────────

function getEsNodes(): string[] {
  const raw = import.meta.env.VITE_ES_NODES as string | undefined
  if (!raw) return []
  return raw.split(",").map((n) => n.trim()).filter(Boolean)
}

function getEsAuth(): { username: string; password: string } | null {
  const username = import.meta.env.VITE_ES_USERNAME as string | undefined
  const password = import.meta.env.VITE_ES_PASSWORD as string | undefined
  if (!username || !password) return null
  return { username, password }
}

function getEsIndex(type: "trace" | "event"): string {
  if (type === "trace") return (import.meta.env.VITE_ES_INDEX_TRACE as string) || "devclaw_trace"
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

async function esQuery(index: string, body: Record<string, unknown>): Promise<unknown> {
  const nodes = getEsNodes()
  if (nodes.length === 0) throw new Error("ES_NODES not configured")

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers["Authorization"] = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
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
        signal: AbortSignal.timeout(15_000)
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
  from: string  // ISO string
  to: string    // ISO string
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
  totalTraces: number
  traceTriggerScope?: TraceTriggerScope
}

interface EsSearchHit {
  _id?: string
  _source?: Record<string, unknown>
}

interface EsSearchResponse {
  hits?: {
    total?: number | { value?: number }
    hits?: EsSearchHit[]
  }
}

interface OrgFilterOptions {
  // 用户主动选择的 LV1 组织维度筛选（非权限过滤）。null/未传表示全部。
  upperOrgLv1?: string | null
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
}

interface DashboardAccessContext {
  loggedIn: boolean
  unrestricted: boolean
  sapId: string
  ystId: string
  upperOrgLv1: string
}

const DISLIKE_TYPE_OPTIONS = [
  { id: "slow", label: "太慢了" },
  { id: "not_helpful", label: "内容不相关" },
  { id: "inaccurate", label: "信息不准确" },
  { id: "unclear", label: "表述不清楚" },
  { id: "unsafe", label: "包含不安全内容" },
  { id: "other", label: "其他原因" }
] as const

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
  const parts = typeof pathName === "string"
    ? pathName.split("/").map((part) => part.trim()).filter(Boolean)
    : []
  const itDeptIndex = parts.findIndex((part) => part.includes("信息技术部"))
  if (itDeptIndex < 0) return ""

  const lowerParts = parts.slice(itDeptIndex + 1)
  const startsWithTeam = lowerParts[0]?.includes("团队") ?? false
  return startsWithTeam ? lowerParts[1] ?? "" : lowerParts[2] ?? ""
}

function getDashboardUnrestrictedIds(): Set<string> {
  return splitEnvIds(import.meta.env[DASHBOARD_UNRESTRICTED_IDS_ENV] as string | undefined)
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

function buildNoAccessFilter(): Record<string, unknown> {
  return { term: { traceId: "__dashboard_no_access__" } }
}

function buildTraceAccessFilter(access: DashboardAccessContext): Record<string, unknown> | null {
  if (access.unrestricted) return null
  if (!access.upperOrgLv1) return buildNoAccessFilter()
  return buildUpperOrgLv1Filter(access.upperOrgLv1)
}

function appendOptionalFilter(filters: Record<string, unknown>[], filter: Record<string, unknown> | null): void {
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

function formatTraceExportMarkdown(payload: DashboardTraceExportPayload, exportedAt: string): string {
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
    lines.push(`- Tokens: ${trace.totalTokens} (input ${trace.totalInputTokens}, output ${trace.totalOutputTokens})`)
    if (trace.userName || trace.sapId || trace.ystId) {
      lines.push(
        `- User: ${escapeMarkdown(trace.userName || "-")} / ${escapeMarkdown(trace.sapId || "-")} / ${escapeMarkdown(trace.ystId || "-")}`
      )
    }
    if (trace.usedSkills.length > 0) {
      lines.push(`- Skills: ${trace.usedSkills.map((skill) => `\`${escapeMarkdown(skill)}\``).join(", ")}`)
    }
    lines.push("")

    if (trace.userMessage.trim()) {
      lines.push("### User Message", "", trace.userMessage.trim(), "")
    }

    if (trace.nodes && trace.nodes.length > 0) {
      lines.push("### Trace Nodes", "")
      for (const node of trace.nodes) {
        lines.push(`#### ${escapeMarkdown(node.type)} · ${escapeMarkdown(node.name || node.id)}`, "")
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
 * 使用 wildcard 兼容 `技能名-版本` 这一类上报格式。
 */
function buildSkillUsageWildcardFilter(skillName: string): Record<string, unknown> {
  const escapedSkillName = escapeWildcard(skillName)
  const wildcardPattern = `${escapedSkillName}**`
  return {
    bool: {
      should: [
        { wildcard: { usedSkills: wildcardPattern } },
        { wildcard: { "usedSkills.keyword": wildcardPattern } }
      ],
      minimum_should_match: 1
    }
  }
}

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
      skillNames
        .map((name) => String(name || "").trim())
        .filter(Boolean)
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

function normalizeCommitDetailsOptions(value?: number | CommitDetailsOptions): Required<CommitDetailsOptions> {
  if (typeof value === "number") {
    return {
      page: 1,
      pageSize: clampLimit(value, 20, 500),
      pushedOnly: false,
      upperOrgLv1: null
    }
  }

  const page = clampLimit(value?.page, 1, 10_000)
  const pageSize = clampLimit(value?.pageSize, 20, 100)
  return {
    page,
    pageSize,
    pushedOnly: value?.pushedOnly === true,
    upperOrgLv1: normalizeUpperOrgLv1Option(value?.upperOrgLv1)
  }
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

function normalizeTraceTriggerSource(value: unknown): TraceTriggerSource {
  return (
    value === "chat" ||
    value === "heartbeat" ||
    value === "scheduler_reminder" ||
    value === "scheduler_action" ||
    value === "memory_summarize" ||
    value === "optimizer"
  ) ? value : "chat"
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

function normalizeParsedTrace(trace: AgentTrace, source: Record<string, unknown>, hit: EsSearchHit): AgentTrace {
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
    usedSkills: Array.isArray(candidate.usedSkills) ? candidate.usedSkills : asStringArray(source.usedSkills),
    evolvedSkills: Array.isArray(candidate.evolvedSkills) ? candidate.evolvedSkills : asStringArray(source.evolvedSkills),
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
    const fallbackTotalTokens = asNumber(source.totalTokens, fallbackInputTokens + fallbackOutputTokens)
    const totalInputTokens = usage.totalInputTokens || fallbackInputTokens
    const totalOutputTokens = usage.totalOutputTokens || fallbackOutputTokens
    const totalTokens = usage.totalTokens || fallbackTotalTokens || totalInputTokens + totalOutputTokens
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
      usedSkills: Array.isArray(trace.usedSkills) ? trace.usedSkills : asStringArray(source.usedSkills),
      evolvedSkills: Array.isArray(trace.evolvedSkills) ? trace.evolvedSkills : asStringArray(source.evolvedSkills),
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
  commitShas: string[],
  range: TimeRange
): Promise<Map<string, CommitAdoptionSummary>> {
  const normalizedCommitShas = normalizeSkillList(commitShas).slice(0, 100)
  if (normalizedCommitShas.length === 0) return new Map()

  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          { term: { eventName: "code_adopt" } },
          { exists: { field: "properties.adoptedLineCount" } },
          { exists: { field: "properties.generatedLineCount" } },
          { exists: { field: "properties.effectiveGeneratedLineCount" } },
          timeRangeFilter("properties.generatedAt", range),
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

async function fetchOverview(range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤；orgFilterClause 是用户主动选择的 LV1 组织维度筛选。
  const orgFilter = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)
  const orgFilterClause = orgFilter !== null ? buildUpperOrgLv1Filter(orgFilter) : null
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const rankingTopSize = 20
  const rankingSearchSize = 1000
  const filteredToolExcludes = [
    // Claude Code 内置文件 / 系统工具
    "execute", "read_file", "write_file", "glob", "grep",
    "list_directory", "task", "task_output",
    "ls", "edit_file",
    // 工具搜索 / 元工具
    "search_tool", "inspect_tool", "invoke_deferred_tool",
    // 内置代码执行辅助
    "code_exec", "prepare_save_code_exec_tool", "save_code_exec_tool",
    // 内置任务管理
    "write_todos"
  ]
  const traceBody = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range), ...(orgFilterClause ? [orgFilterClause] : [])] } },
    aggs: {
      total_calls:        { value_count: { field: "traceId" } },
      active_users:       { cardinality: { field: "sapId" } },
      avg_duration:       { avg: { field: "durationMs" } },
      total_input_tokens: { sum: { field: "totalInputTokens" } },
      total_output_tokens:{ sum: { field: "totalOutputTokens" } },
      total_skills:       { cardinality: { field: "usedSkills" } },
      total_tools:        { cardinality: { field: "toolNames" } },
      total_skill_calls:  { value_count: { field: "usedSkills" } },
      total_tool_calls:   { value_count: { field: "toolNames" } },
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
        date_histogram: { field: "startedAt", calendar_interval: interval, time_zone: "Asia/Shanghai" },
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
        should: [
          { bool: { filter: codeGenFilters } },
          { bool: { filter: codeAdoptFilters } }
        ],
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
      code_inclusive_effective_generated_lines: { value: codeStats.inclusiveEffectiveGeneratedLines },
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

async function fetchModelStats(range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions): Promise<unknown> {
  requireDashboardAccess()
  // 统计指标不做组织级数据权限过滤；orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilter = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)
  const orgFilterClause = orgFilter !== null ? buildUpperOrgLv1Filter(orgFilter) : null
  void granularity
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range), ...(orgFilterClause ? [orgFilterClause] : [])] } },
    aggs: {
      by_model: {
        terms: { field: "modelName", size: 30 },
        aggs: {
          total_input_tokens:  { sum: { field: "totalInputTokens" } },
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

function buildOrgLevelMatchFilter(orgLevel: string): Record<string, unknown> {
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

function normalizeUpperOrgLv1Option(upperOrgLv1?: string | null): string | null {
  if (typeof upperOrgLv1 !== "string") return null
  const normalized = upperOrgLv1.trim()
  return normalized ? normalized : null
}

// 将单个或多个 LV1 组织值统一规整为去重、去空的数组。
function normalizeUpperOrgLv1List(value?: string | string[] | null): string[] {
  const raw = Array.isArray(value) ? value : value != null ? [value] : []
  const cleaned = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(cleaned))
}

// 多选 LV1 组织筛选 → terms 过滤；空数组返回 null（表示全部，不过滤）。
function buildUpperOrgLv1ListFilter(list: string[]): Record<string, unknown> | null {
  if (list.length === 0) return null
  return { terms: { upperOrgLv1: list } }
}

function buildNonEmptyOrgLevelFilter(field: "upperOrgLv0" | "upperOrgLv1"): Record<string, unknown> {
  return {
    bool: {
      must: [{ exists: { field } }],
      must_not: [{ term: { [field]: "" } }]
    }
  }
}

function buildOrgDistributionAgg(
  selectedUpperOrgLv1: string | null,
  metric: "pv" | "uv"
): Record<string, unknown> {
  const field = selectedUpperOrgLv1 !== null ? "upperOrgLv0" : "upperOrgLv1"
  const terms: Record<string, unknown> = { field, size: 30, missing: "" }
  const aggs = metric === "uv" ? { unique_users: { cardinality: { field: "sapId" } } } : undefined

  if (metric === "uv") {
    terms.order = { unique_users: "desc" }
  }

  const items = aggs ? { terms, aggs } : { terms }
  const filters = [buildNonEmptyOrgLevelFilter(field)]
  if (selectedUpperOrgLv1 !== null) {
    filters.push(buildUpperOrgLv1Filter(selectedUpperOrgLv1))
  }

  return {
    filter: { bool: { filter: filters } },
    aggs: { items }
  }
}

async function fetchUserStats(range: TimeRange, granularity: Granularity, opts?: UserStatsOptions): Promise<unknown> {
  requireDashboardAccess()
  void granularity
  const selectedUpperOrgLv1 = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)
  // 统计指标不做组织级数据权限过滤，仅保留用户主动选择的组织维度。
  const queryFilters = [timeRangeFilter("startedAt", range), buildChatTriggeredTraceFilter()]
  if (selectedUpperOrgLv1 !== null) {
    queryFilters.push(buildUpperOrgLv1Filter(selectedUpperOrgLv1))
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
                includes: ["userName", "orgName", "upperOrgLv0", "upperOrgLv1", "appVersion", "startedAt"]
              }
            }
          }
        }
      },
      by_org: buildOrgDistributionAgg(selectedUpperOrgLv1, "pv"),
      by_org_pv: buildOrgDistributionAgg(selectedUpperOrgLv1, "pv"),
      by_org_uv: buildOrgDistributionAgg(selectedUpperOrgLv1, "uv"),
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

function getLatestHitSource(bucket: Record<string, unknown>, aggName: string): Record<string, unknown> {
  const agg = asRecord(bucket[aggName])
  const hitsWrapper = asRecord(agg.hits)
  const hits = hitsWrapper.hits
  if (!Array.isArray(hits) || hits.length === 0) return {}
  return asRecord(asRecord(hits[0])._source)
}

function normalizeUserListBucket(bucket: Record<string, unknown>): DashboardUserListItem {
  const source = getLatestHitSource(bucket, "latest_user_info")
  const key = asRecord(bucket.key)
  const sapId = typeof bucket.key === "string" ? bucket.key : asString(key.sap_id, asString(source.sapId))
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

async function fetchUserList(range: TimeRange, options?: UserListOptions): Promise<DashboardUserListData> {
  requireDashboardAccess()
  const { pageSize, afterKey, keyword, upperOrgLv1 } = normalizeUserListOptions(options)
  const offsetValue = Number(afterKey?.offset ?? 0)
  const offset = Number.isFinite(offsetValue) && offsetValue > 0 ? Math.floor(offsetValue) : 0
  const aggregationSize = Math.min(offset + pageSize, 10_000)
  const shardSize = Math.min(Math.max(aggregationSize * 3, 100), 50_000)
  // 用户列表属于统计/目录数据，不做组织级数据权限过滤，仅保留用户主动选择的组织维度。
  const filters = [
    timeRangeFilter("startedAt", range),
    buildChatTriggeredTraceFilter(),
    buildNonEmptySapIdFilter()
  ]
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
    items: buckets.map((bucket) => normalizeUserListBucket(asRecord(bucket))).filter((item) => item.sapId),
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

async function fetchUserDetail(
  sapId: string,
  range: TimeRange,
  options?: UserDetailOptions
): Promise<DashboardUserDetail> {
  const access = requireDashboardAccess()
  const normalizedSapId = sapId.trim()
  if (!normalizedSapId) throw new Error("sapId is required")
  const tracePageSize = clampLimit(options?.tracePageSize ?? options?.traceLimit, 10, 50)
  const tracePage = clampLimit(options?.tracePage, 1, 1000)
  const triggerScope = normalizeTraceTriggerScope(options?.triggerScope)
  // 统计指标（聚合）按该用户全量计算，不做组织级权限过滤；
  // 组织级权限仅通过 post_filter 作用于返回的 trace 聊天明细命中，避免跨组织读取对话内容。
  const traceAccessFilter = buildTraceAccessFilter(access)
  const body = {
    track_total_hits: true,
    from: (tracePage - 1) * tracePageSize,
    size: tracePageSize,
    sort: [{ startedAt: { order: "desc" } }],
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          { term: { sapId: normalizedSapId } },
          ...(triggerScope === "active" ? [buildChatTriggeredTraceFilter()] : [])
        ]
      }
    },
    ...(traceAccessFilter ? { post_filter: traceAccessFilter } : {}),
    aggs: {
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
    },
    _source: {
      includes: dashboardTraceSourceIncludes()
    }
  }

  const raw = await esQuery(getEsIndex("trace"), body) as EsSearchResponse
  const rawRecord = asRecord(raw)
  const aggs = asRecord(rawRecord.aggregations)
  const userInfo = getLatestHitSource(aggs, "latest_user_info")
  const totalInputTokens = asNumber(asRecord(aggs.total_input_tokens).value)
  const totalOutputTokens = asNumber(asRecord(aggs.total_output_tokens).value)
  const totalTokens = asNumber(asRecord(aggs.total_tokens).value, totalInputTokens + totalOutputTokens)
  // 统计指标：调用次数取自聚合（全量）；trace 列表分页用 post_filter 后的命中总数。
  const totalCalls = asNumber(asRecord(aggs.total_calls).value)
  const totalTraces = getTotalHits(raw, raw.hits?.hits?.length ?? 0)

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
    bySkill: normalizeTermsBucketList(asRecord(aggs.by_skill).buckets, "skill") as DashboardUserDetail["bySkill"],
    byModel: normalizeTermsBucketList(asRecord(aggs.by_model).buckets, "model") as DashboardUserDetail["byModel"],
    byOutcome: normalizeTermsBucketList(asRecord(aggs.by_outcome).buckets, "outcome") as DashboardUserDetail["byOutcome"],
    traces: (raw.hits?.hits ?? []).map(normalizeTraceDetail),
    tracePage,
    tracePageSize,
    totalTraces,
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
    const body = {
      size: 0,
      query: { bool: { filter: [timeRangeFilter("startedAt", range), buildChatTriggeredTraceFilter(), ...(traceAccessFilter ? [traceAccessFilter] : [])] } },
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
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range), buildChatTriggeredTraceFilter(), ...(traceAccessFilter ? [traceAccessFilter] : [])] } },
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
    query: {
      bool: {
        must: [
          timeRangeFilter("startedAt", range),
          buildChatTriggeredTraceFilter(),
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
                  buildChatTriggeredTraceFilter(),
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
  const sanitizedSapIds = Array.from(
    new Set(
      sapIds
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ).slice(0, 500)

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
        filter: [timeRangeFilter("startedAt", range), buildNonEmptyOrgLevelFilter("upperOrgLv1")]
      }
    },
    aggs: {
      orgs: { terms: { field: "upperOrgLv1", size: 200 } }
    }
  }
  const raw = await esQuery(getEsIndex("trace"), body)
  const rawBuckets = asRecord(asRecord(asRecord(raw).aggregations).orgs).buckets
  const orgs = (Array.isArray(rawBuckets) ? rawBuckets : [])
    .map((bucket) => asString(asRecord(bucket).key).trim())
    .filter(Boolean)
  return Array.from(new Set(orgs)).sort((a, b) => a.localeCompare(b, "zh-CN"))
}

async function fetchProductivity(range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions): Promise<unknown> {
  requireDashboardAccess()
  const interval = getCalendarInterval(granularity, range.from, range.to)
  // orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilter = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)
  const orgFilterClause = orgFilter !== null ? buildUpperOrgLv1Filter(orgFilter) : null
  const filters = [
    timeRangeFilter("eventTime", range),
    { term: { "eventName": "git.commit.created" } },
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
        date_histogram: { field: "eventTime", calendar_interval: interval, time_zone: "Asia/Shanghai" }
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

async function fetchFeedback(range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions): Promise<unknown> {
  requireDashboardAccess()
  const interval = getCalendarInterval(granularity, range.from, range.to)
  // orgFilterClause 为用户主动选择的 LV1 组织维度筛选。
  const orgFilter = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)
  const orgFilterClause = orgFilter !== null ? buildUpperOrgLv1Filter(orgFilter) : null
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
              eventName: [
                "message.feedback.like",
                "message.feedback.dislike.submit"
              ]
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
): Promise<{ traces: DashboardTraceDetail[]; total: number; page: number; pageSize: number; mode: TraceViewMode }> {
  const access = requireDashboardAccess()
  const normalizedMode = normalizeTraceViewMode(mode)
  const normalizedTriggerScope = normalizeTraceTriggerScope(triggerScope)
  const size = clampLimit(limit, 10, normalizedMode === "thread" ? 30 : 50)
  const currentPage = clampLimit(page, 1, 1000)
  const filters = [
    timeRangeFilter("startedAt", range),
    buildSkillUsageWildcardFilter(skill)
  ]
  // trace 聊天明细列表：按 lv1 组织做数据权限过滤。
  appendOptionalFilter(filters, buildTraceAccessFilter(access))
  if (normalizedTriggerScope === "active") {
    filters.splice(1, 0, buildChatTriggeredTraceFilter())
  }
  const sourceIncludes = dashboardTraceSourceIncludes()

  if (normalizedMode === "thread") {
    const maxThreadBuckets = 30
    const requestedBuckets = Math.min(currentPage * size, maxThreadBuckets)
    const fromBucket = (currentPage - 1) * size
    const tracesPerThread = 5
    const body = {
      size: 0,
      query: {
        bool: { filter: filters }
      },
      aggs: {
        total_threads: { cardinality: { field: "threadId" } },
        by_thread: {
          terms: {
            field: "threadId",
            size: requestedBuckets,
            order: { latest_started_at: "desc" }
          },
          aggs: {
            latest_started_at: { max: { field: "startedAt" } },
            latest_traces: {
              top_hits: {
                size: tracesPerThread,
                sort: [{ startedAt: { order: "desc" } }],
                _source: { includes: sourceIncludes }
              }
            }
          }
        }
      }
    }
    const raw = await esQuery(getEsIndex("trace"), body) as EsSearchResponse
    const aggs = asRecord((raw as unknown as Record<string, unknown>).aggregations)
    const buckets = asRecord(aggs.by_thread).buckets
    const selectedBuckets = Array.isArray(buckets) ? buckets.slice(fromBucket, fromBucket + size) : []
    const traces = selectedBuckets.flatMap((bucket) => {
      const latestHits = asRecord(asRecord(bucket).latest_traces)
      const rawHits = asRecord(latestHits.hits).hits
      return Array.isArray(rawHits) ? rawHits.map((hit) => normalizeTraceDetail(hit as EsSearchHit)) : []
    })
    return {
      traces,
      total: Math.min(asNumber(asRecord(aggs.total_threads).value), maxThreadBuckets),
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
  const raw = await esQuery(getEsIndex("trace"), body) as EsSearchResponse
  return {
    traces: (raw.hits?.hits ?? []).map(normalizeTraceDetail),
    total: getTotalHits(raw, raw.hits?.hits?.length ?? 0),
    page: currentPage,
    pageSize: size,
    mode: normalizedMode
  }
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
        should: [
          { bool: { filter: codeGenFilters } },
          { bool: { filter: codeAdoptFilters } }
        ],
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
): Promise<{ total: number; page: number; pageSize: number; pushedOnly: boolean; items: DashboardCommitDetail[] }> {
  requireDashboardAccess()
  const { page, pageSize, pushedOnly, upperOrgLv1 } = normalizeCommitDetailsOptions(options)
  const filters: Record<string, unknown>[] = [
    timeRangeFilter("eventTime", range),
    { term: { eventName: "git.commit.created" } }
  ]
  if (pushedOnly) {
    filters.push({ term: { "properties.pushed": true } })
  }
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
  const raw = await esQuery(getEsIndex("event"), body) as EsSearchResponse
  const hits = raw.hits?.hits ?? []
  const items = hits.map(normalizeCommitDetail)
  const adoptionMap = await fetchCommitAdoptionMap(
    items.map((item) => item.commitSha ?? "").filter(Boolean),
    range
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
  return ["测试 1 部", "开发二部", "平台三部"]
}

function makeMockOverview(range: TimeRange): unknown {
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

  return {
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
          { key: "代码审查",     doc_count: 312 },
          { key: "需求分析",     doc_count: 278 },
          { key: "文档生成",     doc_count: 245 },
          { key: "单元测试",     doc_count: 198 },
          { key: "SQL优化",      doc_count: 167 },
          { key: "plugin-release-note-v1.0.0", doc_count: 156 },
          { key: "接口设计",     doc_count: 143 },
          { key: "日志分析",     doc_count: 121 },
          { key: "数据清洗",     doc_count: 98  },
          { key: "性能诊断",     doc_count: 87  },
          { key: "安全扫描",     doc_count: 62  },
          { key: "代码重构",     doc_count: 54  },
          { key: "异常排查",     doc_count: 49  },
          { key: "接口联调",     doc_count: 44  },
          { key: "依赖升级",     doc_count: 38  },
          { key: "配置检查",     doc_count: 33  },
          { key: "发布诊断",     doc_count: 29  },
          { key: "性能优化",     doc_count: 24  },
          { key: "埋点分析",     doc_count: 18  },
          { key: "前端走查",     doc_count: 13  },
          { key: "脚本生成",     doc_count: 9   }
        ]
      },
      by_skill_all: {
        buckets: [
          { key: "代码审查",     doc_count: 312 },
          { key: "需求分析",     doc_count: 278 },
          { key: "文档生成",     doc_count: 245 },
          { key: "单元测试",     doc_count: 198 },
          { key: "SQL优化",      doc_count: 167 },
          { key: "plugin-release-note-v1.0.0", doc_count: 156 },
          { key: "接口设计",     doc_count: 143 },
          { key: "日志分析",     doc_count: 121 },
          { key: "数据清洗",     doc_count: 98  },
          { key: "性能诊断",     doc_count: 87  },
          { key: "安全扫描",     doc_count: 62  },
          { key: "代码重构",     doc_count: 54  },
          { key: "异常排查",     doc_count: 49  },
          { key: "接口联调",     doc_count: 44  },
          { key: "依赖升级",     doc_count: 38  },
          { key: "配置检查",     doc_count: 33  },
          { key: "发布诊断",     doc_count: 29  },
          { key: "性能优化",     doc_count: 24  },
          { key: "埋点分析",     doc_count: 18  },
          { key: "前端走查",     doc_count: 13  },
          { key: "脚本生成",     doc_count: 9   },
          { key: "冒烟测试",     doc_count: 8   },
          { key: "链路排查",     doc_count: 7   },
          { key: "Schema 校验",  doc_count: 6   },
          { key: "接口 Mock",    doc_count: 5   },
          { key: "灰度检查",     doc_count: 4   }
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
          { key: "git_workflow",       doc_count: 412 },
          { key: "browser_playwright", doc_count: 356 },
          { key: "manage_skill",       doc_count: 298 },
          { key: "manage_scheduler",   doc_count: 241 },
          { key: "web_search",         doc_count: 198 },
          { key: "db_query",           doc_count: 163 },
          { key: "create_pr",          doc_count: 134 },
          { key: "run_tests",          doc_count: 112 },
          { key: "search_code",        doc_count: 98  },
          { key: "notify",             doc_count: 76  },
          { key: "query_logs",         doc_count: 68  },
          { key: "schema_check",       doc_count: 59  },
          { key: "open_preview",       doc_count: 53  },
          { key: "analyze_diff",       doc_count: 47  },
          { key: "format_code",        doc_count: 42  },
          { key: "lint_fix",           doc_count: 36  },
          { key: "dependency_audit",   doc_count: 31  },
          { key: "deploy_check",       doc_count: 26  },
          { key: "trace_lookup",       doc_count: 19  },
          { key: "ticket_update",      doc_count: 12  }
        ]
      },
      by_tool_filtered_all: {
        buckets: [
          { key: "git_workflow",       doc_count: 412 },
          { key: "browser_playwright", doc_count: 356 },
          { key: "manage_skill",       doc_count: 298 },
          { key: "manage_scheduler",   doc_count: 241 },
          { key: "web_search",         doc_count: 198 },
          { key: "db_query",           doc_count: 163 },
          { key: "create_pr",          doc_count: 134 },
          { key: "run_tests",          doc_count: 112 },
          { key: "search_code",        doc_count: 98  },
          { key: "notify",             doc_count: 76  },
          { key: "query_logs",         doc_count: 68  },
          { key: "schema_check",       doc_count: 59  },
          { key: "open_preview",       doc_count: 53  },
          { key: "analyze_diff",       doc_count: 47  },
          { key: "format_code",        doc_count: 42  },
          { key: "lint_fix",           doc_count: 36  },
          { key: "dependency_audit",   doc_count: 31  },
          { key: "deploy_check",       doc_count: 26  },
          { key: "trace_lookup",       doc_count: 19  },
          { key: "ticket_update",      doc_count: 12  },
          { key: "mcp_sqlQuery",       doc_count: 11  },
          { key: "browser_visualDiff", doc_count: 9   },
          { key: "workflow_template",  doc_count: 7   }
        ]
      },
      by_tool_all: {
        buckets: [
          { key: "read_file",          doc_count: 1823 },
          { key: "write_file",         doc_count: 1245 },
          { key: "execute",            doc_count: 987  },
          { key: "grep",               doc_count: 876  },
          { key: "glob",               doc_count: 654  },
          { key: "git_workflow",       doc_count: 412  },
          { key: "browser_playwright", doc_count: 356  },
          { key: "manage_skill",       doc_count: 298  },
          { key: "edit_file",          doc_count: 267  },
          { key: "manage_scheduler",   doc_count: 241  },
          { key: "web_search",         doc_count: 198  },
          { key: "list_directory",     doc_count: 187  },
          { key: "db_query",           doc_count: 163  },
          { key: "task",               doc_count: 156  },
          { key: "task_output",        doc_count: 148  },
          { key: "create_pr",          doc_count: 134  },
          { key: "search_tool",        doc_count: 128  },
          { key: "run_tests",          doc_count: 112  },
          { key: "search_code",        doc_count: 98   },
          { key: "code_exec",          doc_count: 92   }
        ]
      },
      by_tool_all_full: {
        buckets: [
          { key: "read_file",                  doc_count: 1823 },
          { key: "write_file",                 doc_count: 1245 },
          { key: "execute",                    doc_count: 987  },
          { key: "grep",                       doc_count: 876  },
          { key: "glob",                       doc_count: 654  },
          { key: "git_workflow",               doc_count: 412  },
          { key: "browser_playwright",         doc_count: 356  },
          { key: "manage_skill",               doc_count: 298  },
          { key: "edit_file",                  doc_count: 267  },
          { key: "manage_scheduler",           doc_count: 241  },
          { key: "web_search",                 doc_count: 198  },
          { key: "list_directory",             doc_count: 187  },
          { key: "db_query",                   doc_count: 163  },
          { key: "task",                       doc_count: 156  },
          { key: "task_output",                doc_count: 148  },
          { key: "create_pr",                  doc_count: 134  },
          { key: "search_tool",                doc_count: 128  },
          { key: "run_tests",                  doc_count: 112  },
          { key: "search_code",                doc_count: 98   },
          { key: "code_exec",                  doc_count: 92   },
          { key: "prepare_save_code_exec_tool",doc_count: 81   },
          { key: "notify",                     doc_count: 76   },
          { key: "query_logs",                 doc_count: 68   },
          { key: "schema_check",               doc_count: 59   },
          { key: "open_preview",               doc_count: 53   }
        ]
      },
      trend: { buckets: trend }
    }
  }
}

function makeMockModelStats(): unknown {
  return {
    aggregations: {
      by_model: {
        buckets: [
          { key: "claude-sonnet-4-6", doc_count: 620, success_count: { doc_count: 578 }, avg_duration: { value: 3800 }, total_input_tokens: { value: 1_200_000 }, total_output_tokens: { value: 430_000 } },
          { key: "claude-opus-4-6",   doc_count: 280, success_count: { doc_count: 265 }, avg_duration: { value: 8200 }, total_input_tokens: { value: 780_000 },  total_output_tokens: { value: 310_000 } },
          { key: "claude-haiku-4-5",  doc_count: 347, success_count: { doc_count: 259 }, avg_duration: { value: 1100 }, total_input_tokens: { value: 360_000 },  total_output_tokens: { value: 150_000 } }
        ]
      },
      by_tier: {
        buckets: [
          { key: "high",   doc_count: 280 },
          { key: "medium", doc_count: 620 },
          { key: "low",    doc_count: 347 }
        ]
      },
      by_layer: {
        buckets: [
          { key: "user_explicit",   doc_count: 210 },
          { key: "skill_override",  doc_count: 390 },
          { key: "auto_routing",    doc_count: 647 }
        ]
      }
    }
  }
}

function makeMockUserStats(range: TimeRange, opts?: UserStatsOptions): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  const selectedUpperOrgLv1 = normalizeUpperOrgLv1Option(opts?.upperOrgLv1)

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from); start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from); start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: 0,
    users: { value: Math.floor(3 + Math.random() * 15) }
  }))

  const byOrgBuckets = selectedUpperOrgLv1 === null
    ? [
        { key: "测试 1 部", doc_count: 748, unique_users: { value: 60 } },
        { key: "开发二部", doc_count: 245, unique_users: { value: 20 } },
        { key: "平台三部", doc_count: 189, unique_users: { value: 15 } }
      ]
    : selectedUpperOrgLv1 === "测试 1 部"
      ? [
          { key: "测试 1 组", doc_count: 430, unique_users: { value: 36 } },
          { key: "测试 2 组", doc_count: 318, unique_users: { value: 24 } }
        ]
      : selectedUpperOrgLv1 === "开发二部"
        ? [
            { key: "开发三组", doc_count: 245, unique_users: { value: 20 } }
          ]
        : selectedUpperOrgLv1 === "平台三部"
          ? [
              { key: "平台一组", doc_count: 189, unique_users: { value: 15 } }
            ]
          : []

  const makeOrgAgg = (buckets: typeof byOrgBuckets): Record<string, unknown> => {
    const docCount = buckets.reduce((sum, bucket) => sum + bucket.doc_count, 0)
    return { doc_count: docCount, items: { buckets } }
  }
  const byOrgPv = makeOrgAgg(byOrgBuckets)
  const byOrgUv = makeOrgAgg(byOrgBuckets)

  const allTopUserBuckets = [
    { key: "10010001", doc_count: 142, latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "张三", orgName: "测试 1 组", upperOrgLv1: "测试 1 部", upperOrgLv0: "测试 1 组", appVersion: "1.3.0" } }] } } },
    { key: "10010002", doc_count: 118, latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "李四", orgName: "测试 2 组", upperOrgLv1: "测试 1 部", upperOrgLv0: "测试 2 组", appVersion: "1.2.5" } }] } } },
    { key: "10010003", doc_count: 97,  latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "王五", orgName: "开发三组", upperOrgLv1: "开发二部", upperOrgLv0: "开发三组", appVersion: "1.3.0" } }] } } },
    { key: "10010004", doc_count: 85,  latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "赵六", orgName: "测试 1 组", upperOrgLv1: "测试 1 部", upperOrgLv0: "测试 1 组", appVersion: "1.2.0" } }] } } },
    { key: "10010005", doc_count: 73,  latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "钱七", orgName: "平台一组", upperOrgLv1: "平台三部", upperOrgLv0: "平台一组", appVersion: "1.3.0" } }] } } },
    { key: "10010006", doc_count: 61,  latest_user_info: { hits: { hits: [{ sort: ["2026-04-21T10:00:00.000Z"], _source: { userName: "孙八", orgName: "开发三组", upperOrgLv1: "开发二部", upperOrgLv0: "开发三组", appVersion: "1.1.8" } }] } } }
  ]
  const topUserBuckets = selectedUpperOrgLv1 === null
    ? allTopUserBuckets
    : allTopUserBuckets.filter((bucket) => bucket.latest_user_info.hits.hits[0]._source.upperOrgLv1 === selectedUpperOrgLv1)

  const byVersionBuckets = selectedUpperOrgLv1 === null
    ? [
        { key: "1.3.0", doc_count: 512, unique_users: { value: 98 } },
        { key: "1.2.5", doc_count: 298, unique_users: { value: 62 } },
        { key: "1.2.0", doc_count: 187, unique_users: { value: 41 } },
        { key: "1.1.x", doc_count: 143, unique_users: { value: 28 } },
        { key: "1.0.x", doc_count: 107, unique_users: { value: 19 } }
      ]
    : [
        { key: "1.3.0", doc_count: Math.max(12, byOrgBuckets[0]?.doc_count ?? 0), unique_users: { value: Math.max(3, topUserBuckets.length) } },
        { key: "1.2.5", doc_count: Math.max(6, Math.floor((byOrgBuckets[1]?.doc_count ?? byOrgBuckets[0]?.doc_count ?? 0) * 0.4)), unique_users: { value: Math.max(1, Math.ceil(topUserBuckets.length / 2)) } }
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
  const offset = Math.abs(
    Array.from(skillName).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  ) % 7
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

  const buckets = Array.from(
    new Set(
      sapIds
        .map((id) => id.trim())
        .filter(Boolean)
    )
  ).map((sapId) => {
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
  })

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
  const normalizedUpperOrgLv1 = upperOrgLv1?.toLowerCase() ?? null
  const allUsers = Array.from({ length: 64 }, (_, index) => makeMockDashboardUser(index)).filter((user) => {
    if (
      normalizedUpperOrgLv1 !== null &&
      ![user.upperOrgLv1, user.upperOrgLv0].some((value) =>
        String(value || "").toLowerCase().includes(normalizedUpperOrgLv1)
      )
    ) return false
    if (!normalizedKeyword) return true
    return [user.userName, user.ystId, user.sapId].some((value) =>
      String(value || "").toLowerCase().includes(normalizedKeyword)
    )
  })
  const afterOffset = Number(afterKey?.offset ?? 0)
  const afterSapId = typeof afterKey?.sap_id === "string" ? afterKey.sap_id : ""
  const startIndex = Number.isFinite(afterOffset) && afterOffset > 0
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

function makeMockUserDetail(sapId: string, range: TimeRange, options?: UserDetailOptions): DashboardUserDetail {
  const index = Math.max(0, Number(sapId.slice(-3)) - 1)
  const user = makeMockDashboardUser(Number.isFinite(index) ? index : 0)
  const tracePageSize = clampLimit(options?.tracePageSize ?? options?.traceLimit, 10, 50)
  const tracePage = clampLimit(options?.tracePage, 1, 1000)
  const totalTraces = user.count
  const startIndex = (tracePage - 1) * tracePageSize
  const baseTraces = makeMockSkillRecentTraces("代码审查", range, 10)
  const traces = Array.from(
    { length: Math.max(0, Math.min(tracePageSize, totalTraces - startIndex)) },
    (_, traceIndex) => {
      const trace = baseTraces[traceIndex % baseTraces.length]
      const mockIndex = startIndex + traceIndex
      return {
        ...trace,
        traceId: `${trace.traceId}-page-${tracePage}-${traceIndex}`,
        sapId,
        ystId: user.ystId,
        userName: user.userName,
        orgName: user.orgName,
        userIp: `10.0.1.${20 + (mockIndex % 200)}`,
        startedAt: new Date(new Date(range.to).getTime() - mockIndex * 35 * 60 * 1000).toISOString()
      }
    }
  )
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
    totalTraces,
    traceTriggerScope: normalizeTraceTriggerScope(options?.triggerScope)
  }
}

function makeMockProductivity(range: TimeRange): unknown {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const diffMs = to.getTime() - from.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)

  const trendBuckets: Date[] = []
  if (diffDays <= 1) {
    const start = new Date(from); start.setMinutes(0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  } else {
    const start = new Date(from); start.setHours(0, 0, 0, 0)
    for (let t = new Date(start); t <= to; t = new Date(t.getTime() + 24 * 60 * 60 * 1000)) trendBuckets.push(new Date(t))
  }

  const trend = trendBuckets.map((t) => ({
    key_as_string: t.toISOString(),
    key: t.getTime(),
    doc_count: Math.floor(2 + Math.random() * 12)
  }))

  return {
    aggregations: {
      commit_trend: { buckets: trend },
      // Agent 生成 / 删除的代码行数（来自 code_gen 事件），非 git commit 原始行数
      total_insertions:   { value: 9240 },
      total_deletions:    { value: 2180 },
      total_files_changed:{ value: 892 },
      total_commits:      { value: 187 },
      active_users:       { value: 24 }
    }
  }
}

function makeMockFeedback(range: TimeRange, granularity: Granularity): unknown {
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

  return {
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
  }
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
  const assistantSummary = [
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
      args: { path: "src/renderer/src/components/trace/TraceConversation.tsx", summary: "调整工具调用卡片位置" },
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

  return {
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
        inputMessages: [
          { role: "user", content: userMessage }
        ],
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
}

function makeMockSkillRecentTraces(skill: string, range: TimeRange, limit = 10): DashboardTraceDetail[] {
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
  const tracePageSize = clampLimit(pageOptions?.pageSize ?? pageOptions?.limit, 10, traceViewMode === "thread" ? 30 : 50)
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
): { total: number; page: number; pageSize: number; pushedOnly: boolean; items: DashboardCommitDetail[] } {
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
      commitUrl: pushed ? `https://git.example.internal/demo/${repoName}/commit/${commitSha}` : undefined,
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
        String(value || "").toLowerCase().includes(normalizedUpperOrgLv1)
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
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDashboardHandlers(_ipcMain: typeof ipcMain): void {
  _ipcMain.handle("dashboard:isAllowed", async () => {
    return getDashboardAccessContext().loggedIn
  })

  _ipcMain.handle(
    "dashboard:overview",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOverview(range) }
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
      if (import.meta.env.DEV) return { success: true, data: makeMockModelStats() }
      try {
        return { success: true, data: await fetchModelStats(range, granularity, opts) }
      } catch (e) {
        console.error("[Dashboard] modelStats error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:orgOptions",
    async (_, range: TimeRange) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOrgOptions() }
      try {
        return { success: true, data: await fetchOrgOptions(range) }
      } catch (e) {
        console.error("[Dashboard] orgOptions error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

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

  _ipcMain.handle(
    "dashboard:userList",
    async (_, range: TimeRange, options?: UserListOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockUserList(range, options) }
      try {
        return { success: true, data: await fetchUserList(range, options) }
      } catch (e) {
        console.error("[Dashboard] userList error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:userDetail",
    async (_, sapId: string, range: TimeRange, options?: UserDetailOptions) => {
      const normalizedSapId = sapId?.trim?.() ?? ""
      if (!normalizedSapId) return { success: false, error: "sapId is required" }
      if (import.meta.env.DEV) return { success: true, data: makeMockUserDetail(normalizedSapId, range, options) }
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

  _ipcMain.handle(
    "dashboard:userProfiles",
    async (_, sapIds: string[]) => {
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
    }
  )

  _ipcMain.handle(
    "dashboard:queryAllUser",
    async () => {
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockAllUsers() }
      }
      try {
        return { success: true, data: await queryAllUser() }
      } catch (e) {
        console.error("[Dashboard] queryAllUser error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:productivity",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProductivity(range) }
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
      if (import.meta.env.DEV) return { success: true, data: makeMockFeedback(range, granularity) }
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
    async (_, skill: string, range: TimeRange, limit?: number, mode?: TraceViewMode, triggerScope?: TraceTriggerScope) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockSkillRecentTraces(skill, range, limit) }
      try {
        return { success: true, data: (await fetchSkillRecentTraces(skill, range, limit, 1, normalizeTraceViewMode(mode), normalizeTraceTriggerScope(triggerScope))).traces }
      } catch (e) {
        console.error("[Dashboard] skillRecentTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:marketSkillRecentTraces",
    async (_, skill: string, range: TimeRange, limit?: number, mode?: TraceViewMode, triggerScope?: TraceTriggerScope) => {
      const trimmedSkill = skill?.trim?.() ?? ""
      if (!trimmedSkill) return { success: false, error: "skill is required" }
      if (import.meta.env.DEV) return { success: true, data: makeMockSkillRecentTraces(trimmedSkill, range, limit) }
      try {
        return { success: true, data: (await fetchSkillRecentTraces(trimmedSkill, range, limit, 1, normalizeTraceViewMode(mode), normalizeTraceTriggerScope(triggerScope))).traces }
      } catch (e) {
        console.error("[Dashboard] marketSkillRecentTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillDetail",
    async (_, skill: string, range: TimeRange, options?: number | TracePageOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockSkillDetail(skill, range, options) }
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
    async (
      _,
      sheets: Array<{ name: string; header: string[]; rows: (string | number)[][] }>
    ) => {
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
