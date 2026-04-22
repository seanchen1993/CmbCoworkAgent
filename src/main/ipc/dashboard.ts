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
import { buildTraceTree } from "../agent/trace/tree-builder"
import type { AgentTrace, TraceNode } from "../agent/trace/types"

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

const ALLOWED_YST_IDS_RAW = (import.meta.env.VITE_DASHBOARD_ALLOWED_YST_IDS as string) || ""
const ALLOWED_YST_IDS = new Set(
  ALLOWED_YST_IDS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
)

// ─────────────────────────────────────────────────────────
// ES HTTP helper
// ─────────────────────────────────────────────────────────

let nodeIndex = 0

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
      console.warn(`[Dashboard] ES node ${nodes[idx]} failed:`, lastError.message)
    }
  }

  throw lastError ?? new Error("All ES nodes failed")
}

// ─────────────────────────────────────────────────────────
// Query builders
// ─────────────────────────────────────────────────────────

interface TimeRange {
  from: string  // ISO string
  to: string    // ISO string
}

type Granularity = "day" | "week" | "month" | "custom"

interface DashboardTraceDetail {
  traceId: string
  threadId: string
  startedAt: string
  endedAt?: string
  durationMs: number
  userMessage: string
  modelId?: string
  modelName?: string
  outcome: string
  totalToolCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  usedSkills: string[]
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
  userIp?: string
  repoPath?: string
  branch?: string
  filesChanged: number
  insertions: number
  deletions: number
  triggeredBy?: string
  threadId?: string
  usedSkills: string[]
  skillCount: number
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

interface UserStatsOptions {
  upperOrgLv1?: string | null
}

const DISLIKE_TYPE_OPTIONS = [
  { id: "slow", label: "太慢了" },
  { id: "not_helpful", label: "内容不相关" },
  { id: "inaccurate", label: "信息不准确" },
  { id: "unclear", label: "表述不清楚" },
  { id: "unsafe", label: "包含不安全内容" },
  { id: "other", label: "其他原因" }
] as const

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

function isDashboardAllowed(): boolean {
  if (import.meta.env.DEV) return true
  const userInfo = getUserInfo()
  const ystId = userInfo?.ystId?.trim()
  if (!ystId) return false
  return ALLOWED_YST_IDS.has(ystId)
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) return fallback
  return Math.max(1, Math.min(max, Math.floor(Number(limit))))
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
    usedSkills: Array.isArray(candidate.usedSkills) ? candidate.usedSkills : asStringArray(source.usedSkills)
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
      modelId: trace.modelId || asOptionalString(source.modelId),
      modelName: trace.modelName || asOptionalString(source.modelName),
      outcome: trace.outcome || asString(source.outcome, "unknown"),
      totalToolCalls: asNumber(trace.totalToolCalls, asNumber(source.totalToolCalls)),
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      usedSkills: Array.isArray(trace.usedSkills) ? trace.usedSkills : asStringArray(source.usedSkills),
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
    modelId: asOptionalString(source.modelId),
    modelName: asOptionalString(source.modelName),
    outcome: asString(source.outcome, "unknown"),
    totalToolCalls: asNumber(source.totalToolCalls),
    totalInputTokens: fallbackInputTokens,
    totalOutputTokens: fallbackOutputTokens,
    totalTokens: asNumber(source.totalTokens, fallbackInputTokens + fallbackOutputTokens),
    usedSkills: asStringArray(source.usedSkills),
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
    userIp: asOptionalString(source.userIp),
    repoPath: asOptionalString(properties.repoPath),
    branch: asOptionalString(properties.branch),
    filesChanged: asNumber(properties.filesChanged),
    insertions: asNumber(properties.insertions),
    deletions: asNumber(properties.deletions),
    triggeredBy: asOptionalString(properties.triggeredBy),
    threadId: asOptionalString(properties.threadId),
    usedSkills,
    skillCount: asNumber(properties.skillCount, usedSkills.length)
  }
}

// ─────────────────────────────────────────────────────────
// Dashboard data fetchers
// ─────────────────────────────────────────────────────────

async function fetchOverview(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
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
      by_skill: { terms: { field: "usedSkills",  size: 20 } },
      by_tool: {
        terms: {
          field: "toolNames",
          size: 20,
          exclude: [
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
        }
      },
      by_tool_all: {
        terms: { field: "toolNames", size: 20 }
      },
      trend: {
        date_histogram: { field: "startedAt", calendar_interval: interval, time_zone: "Asia/Shanghai" },
        aggs: {
          users: { cardinality: { field: "sapId" } }
        }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchModelStats(range: TimeRange, granularity: Granularity): Promise<unknown> {
  void granularity
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
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
  if (upperOrgLv1 === "") {
    return {
      bool: {
        should: [
          { term: { upperOrgLv1: "" } },
          { bool: { must_not: [{ exists: { field: "upperOrgLv1" } }] } }
        ],
        minimum_should_match: 1
      }
    }
  }

  return { term: { upperOrgLv1 } }
}

async function fetchUserStats(range: TimeRange, granularity: Granularity, opts?: UserStatsOptions): Promise<unknown> {
  void granularity
  const selectedUpperOrgLv1 = opts?.upperOrgLv1 ?? null
  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      top_users: {
        terms: { field: "sapId", size: 50 },
        aggs: {
          user_name: { terms: { field: "userName",  size: 1 } },
          org_name:  { terms: { field: "orgName",   size: 1 } },
          upper_org_lv1: { terms: { field: "upperOrgLv1", size: 1, missing: "" } }
        }
      },
      by_org: selectedUpperOrgLv1 !== null
        ? {
            filter: buildUpperOrgLv1Filter(selectedUpperOrgLv1),
            aggs: {
              items: { terms: { field: "orgName", size: 30, missing: "" } }
            }
          }
        : {
            terms: { field: "upperOrgLv1", size: 30, missing: "" }
          },
      by_version: {
        terms: { field: "appVersion", size: 20 },
        aggs: { unique_users: { cardinality: { field: "sapId" } } }
      }
    }
  }
  return esQuery(getEsIndex("trace"), body)
}

async function fetchProductivity(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("eventTime", range),
          { term: { "eventName": "git.commit.created" } }
        ]
      }
    },
    aggs: {
      commit_trend: {
        date_histogram: { field: "eventTime", calendar_interval: interval, time_zone: "Asia/Shanghai" }
      },
      total_insertions: { sum: { field: "properties.insertions" } },
      total_deletions: { sum: { field: "properties.deletions" } },
      total_files_changed: { sum: { field: "properties.filesChanged" } },
      active_users: { cardinality: { field: "sapId" } },
      total_commits: { value_count: { field: "eventId" } }
    }
  }
  return esQuery(getEsIndex("event"), body)
}

async function fetchFeedback(range: TimeRange, granularity: Granularity): Promise<unknown> {
  const interval = getCalendarInterval(granularity, range.from, range.to)
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
  limit = 10
): Promise<DashboardTraceDetail[]> {
  const size = clampLimit(limit, 10, 10)
  const body = {
    size,
    sort: [{ startedAt: { order: "desc" } }],
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          { term: { usedSkills: skill } }
        ]
      }
    },
    _source: {
      includes: [
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
  }
  const raw = await esQuery(getEsIndex("trace"), body) as EsSearchResponse
  return (raw.hits?.hits ?? []).map(normalizeTraceDetail)
}

async function fetchCommitDetails(
  range: TimeRange,
  limit = 50
): Promise<{ total: number; items: DashboardCommitDetail[] }> {
  const size = clampLimit(limit, 50, 500)
  const body = {
    track_total_hits: true,
    size,
    sort: [{ eventTime: { order: "desc" } }],
    query: {
      bool: {
        filter: [
          timeRangeFilter("eventTime", range),
          { term: { eventName: "git.commit.created" } }
        ]
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
        "properties.repoPath",
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
  return {
    total: getTotalHits(raw, hits.length),
    items: hits.map(normalizeCommitDetail)
  }
}

// ─────────────────────────────────────────────────────────
// Dev mock data
// ─────────────────────────────────────────────────────────

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
      by_skill: {
        buckets: [
          { key: "代码审查",     doc_count: 312 },
          { key: "需求分析",     doc_count: 278 },
          { key: "文档生成",     doc_count: 245 },
          { key: "单元测试",     doc_count: 198 },
          { key: "SQL优化",      doc_count: 167 },
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
  const selectedUpperOrgLv1 = opts?.upperOrgLv1 ?? null

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
        { key: "零售金融", doc_count: 748 },
        { key: "公司金融", doc_count: 245 },
        { key: "风险管理", doc_count: 189 },
        { key: "科技管理", doc_count: 65 }
      ]
    : selectedUpperOrgLv1 === "零售金融"
      ? [
          { key: "零售一部", doc_count: 430 },
          { key: "零售二部", doc_count: 318 }
        ]
      : selectedUpperOrgLv1 === "公司金融"
        ? [
            { key: "企业金融部", doc_count: 245 }
          ]
        : selectedUpperOrgLv1 === "风险管理"
          ? [
              { key: "风险管理部", doc_count: 189 }
            ]
          : selectedUpperOrgLv1 === "科技管理"
            ? [
                { key: "科技部", doc_count: 65 }
              ]
            : []

  return {
    aggregations: {
      top_users: {
        buckets: [
          { key: "10010001", doc_count: 142, user_name: { buckets: [{ key: "张三", doc_count: 142 }] }, org_name: { buckets: [{ key: "零售一部", doc_count: 142 }] }, upper_org_lv1: { buckets: [{ key: "零售金融", doc_count: 142 }] }, success_count: { doc_count: 130 } },
          { key: "10010002", doc_count: 118, user_name: { buckets: [{ key: "李四", doc_count: 118 }] }, org_name: { buckets: [{ key: "零售二部", doc_count: 118 }] }, upper_org_lv1: { buckets: [{ key: "零售金融", doc_count: 118 }] }, success_count: { doc_count: 110 } },
          { key: "10010003", doc_count: 97,  user_name: { buckets: [{ key: "王五", doc_count: 97  }] }, org_name: { buckets: [{ key: "企业金融部", doc_count: 97  }] }, upper_org_lv1: { buckets: [{ key: "公司金融", doc_count: 97 }] }, success_count: { doc_count: 89  } },
          { key: "10010004", doc_count: 85,  user_name: { buckets: [{ key: "赵六", doc_count: 85  }] }, org_name: { buckets: [{ key: "零售一部", doc_count: 85  }] }, upper_org_lv1: { buckets: [{ key: "零售金融", doc_count: 85 }] }, success_count: { doc_count: 72  } },
          { key: "10010005", doc_count: 73,  user_name: { buckets: [{ key: "钱七", doc_count: 73  }] }, org_name: { buckets: [{ key: "风险管理部", doc_count: 73  }] }, upper_org_lv1: { buckets: [{ key: "风险管理", doc_count: 73 }] }, success_count: { doc_count: 68  } },
          { key: "10010006", doc_count: 61,  user_name: { buckets: [{ key: "孙八", doc_count: 61  }] }, org_name: { buckets: [{ key: "科技部",    doc_count: 61  }] }, upper_org_lv1: { buckets: [{ key: "科技管理", doc_count: 61 }] }, success_count: { doc_count: 55  } }
        ]
      },
      by_org: selectedUpperOrgLv1 === null
        ? {
            buckets: byOrgBuckets
          }
        : {
            doc_count: byOrgBuckets.reduce((sum, bucket) => sum + bucket.doc_count, 0),
            items: { buckets: byOrgBuckets }
          },
      by_version: {
        buckets: [
          { key: "1.3.0", doc_count: 512, unique_users: { value: 98 } },
          { key: "1.2.5", doc_count: 298, unique_users: { value: 62 } },
          { key: "1.2.0", doc_count: 187, unique_users: { value: 41 } },
          { key: "1.1.x", doc_count: 143, unique_users: { value: 28 } },
          { key: "1.0.x", doc_count: 107, unique_users: { value: 19 } }
        ]
      },
      user_trend: { buckets: trend }
    }
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
      total_insertions:   { value: 14820 },
      total_deletions:    { value: 6430 },
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

  return {
    traceId,
    threadId: `mock-thread-${index + 1}`,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    userMessage: `请使用 ${skill} 帮我分析这次变更，并给出可执行建议。`,
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
        toolCalls: [
          {
            name: "read_file",
            args: { path: "src/example.ts" },
            result: "读取到 120 行内容",
            durationMs: 420
          }
        ]
      },
      {
        index: 1,
        startedAt: new Date(startedAt.getTime() + 12_000).toISOString(),
        assistantText: `已完成 ${skill} 分析，结论包含风险点、建议修改和验证方式。`,
        toolCalls: [
          {
            name: "grep",
            args: { pattern: "TODO", path: "src" },
            result: "匹配 3 处",
            durationMs: 310
          }
        ]
      }
    ],
    modelCalls: [
      {
        messageId: `mock-message-${index + 1}`,
        startedAt: startedAt.toISOString(),
        inputMessages: [
          { role: "user", content: `请使用 ${skill} 帮我分析这次变更，并给出可执行建议。` }
        ],
        outputMessage: {
          role: "assistant",
          content: `已完成 ${skill} 分析。`
        },
        toolCalls: [],
        tokenUsage: {
          inputTokens: 3200 + index * 500,
          outputTokens: 900 + index * 160,
          totalTokens: 4100 + index * 660
        }
      }
    ],
    totalToolCalls: 2,
    outcome: index === 2 ? "error" : "success",
    ...(index === 2 ? { errorMessage: "Mock trace 用于展示异常状态" } : {}),
    appVersion: "0.3.6",
    usedSkills: [skill],
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
      modelId: trace.modelId,
      modelName: trace.modelName,
      outcome: trace.outcome,
      totalToolCalls: trace.totalToolCalls,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalTokens: usage.totalTokens,
      usedSkills: trace.usedSkills,
      nodes: buildTraceTree(trace),
      rawAvailable: true
    }
  })
}

function makeMockCommitDetails(range: TimeRange, limit = 200): { total: number; items: DashboardCommitDetail[] } {
  const from = new Date(range.from)
  const to = new Date(range.to)
  const spanMs = Math.max(60_000, to.getTime() - from.getTime())
  const count = Math.min(clampLimit(limit, 200, 500), 18)
  const items = Array.from({ length: count }, (_, index): DashboardCommitDetail => {
    const eventTime = new Date(to.getTime() - Math.min(spanMs - 1, index * 42 * 60 * 1000))
    return {
      eventId: `mock-commit-event-${index + 1}`,
      eventTime: eventTime.toISOString(),
      userName: ["张三", "李四", "王五", "赵六"][index % 4],
      sapId: `100100${String(index + 1).padStart(2, "0")}`,
      ystId: `2743${String(50 + index).padStart(2, "0")}`,
      orgName: ["科技部", "零售一部", "风险管理部"][index % 3],
      userIp: `10.0.0.${20 + index}`,
      repoPath: `/Users/demo/projects/cmb-${index % 3}`,
      branch: index % 2 === 0 ? "feature/smart-model-routing" : "fix/dashboard-detail",
      filesChanged: 2 + (index % 6),
      insertions: 18 + index * 7,
      deletions: 4 + index * 3,
      triggeredBy: index % 4 === 0 ? "auto-push" : "manual",
      threadId: `mock-thread-${(index % 5) + 1}`,
      usedSkills: index % 2 === 0 ? ["代码审查-v1.0.0"] : ["需求分析-v1.0.0", "接口设计-v1.0.0"],
      skillCount: index % 2 === 0 ? 1 : 2
    }
  })
  return { total: 240, items }
}

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

export function registerDashboardHandlers(_ipcMain: typeof ipcMain): void {
  // Check if current user is allowed to see the dashboard
  _ipcMain.handle("dashboard:isAllowed", async () => {
    return isDashboardAllowed()
  })

  _ipcMain.handle(
    "dashboard:overview",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOverview(range) }
      try {
        return { success: true, data: await fetchOverview(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] overview error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:modelStats",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockModelStats() }
      try {
        return { success: true, data: await fetchModelStats(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] modelStats error:", e)
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
    "dashboard:productivity",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProductivity(range) }
      try {
        return { success: true, data: await fetchProductivity(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] productivity error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:feedback",
    async (_, range: TimeRange, granularity: Granularity) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockFeedback(range, granularity) }
      try {
        return { success: true, data: await fetchFeedback(range, granularity) }
      } catch (e) {
        console.error("[Dashboard] feedback error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:skillRecentTraces",
    async (_, skill: string, range: TimeRange, limit?: number) => {
      if (!isDashboardAllowed()) return { success: false, error: "无运营面板访问权限" }
      if (import.meta.env.DEV) return { success: true, data: makeMockSkillRecentTraces(skill, range, limit) }
      try {
        return { success: true, data: await fetchSkillRecentTraces(skill, range, limit) }
      } catch (e) {
        console.error("[Dashboard] skillRecentTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:commitDetails",
    async (_, range: TimeRange, limit?: number) => {
      if (!isDashboardAllowed()) return { success: false, error: "无运营面板访问权限" }
      if (import.meta.env.DEV) return { success: true, data: makeMockCommitDetails(range, limit) }
      try {
        return { success: true, data: await fetchCommitDetails(range, limit) }
      } catch (e) {
        console.error("[Dashboard] commitDetails error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

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
