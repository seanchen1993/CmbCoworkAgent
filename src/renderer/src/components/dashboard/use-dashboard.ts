/**
 * Dashboard data fetching hook
 */
import { useState, useEffect, useCallback, useRef } from "react"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month" | "custom"

export interface TimeRange {
  from: string
  to: string
}

export interface OverviewData {
  totalCalls: number
  activeUsers: number
  avgDurationMs: number
  inputTokens: number
  outputTokens: number
  totalSkills: number
  totalTools: number
  totalSkillCalls: number
  totalToolCalls: number
  trend: Array<{ time: string; count: number; users: number }>
  bySkill: Array<{ skill: string; count: number }>
  byTool: Array<{ tool: string; count: number }>
  byToolAll: Array<{ tool: string; count: number }>
}

export interface ModelStatsData {
  byModel: Array<{
    model: string
    count: number
    inputTokens: number
    outputTokens: number
  }>
  byTier: Array<{ tier: string; count: number }>
  byLayer: Array<{ layer: string; count: number }>
}

export interface UserStatsData {
  topUsers: Array<{
    sapId: string
    userName: string
    orgName: string
    count: number
  }>
  byOrg: Array<{ org: string; count: number }>
  byVersion: Array<{ version: string; count: number }>
  userTrend: Array<{ time: string; users: number }>
}

export interface ProductivityData {
  commitTrend: Array<{ time: string; count: number }>
  totalInsertions: number
  totalDeletions: number
  totalFilesChanged: number
  totalCommits: number
  activeUsers: number
  avgCommitsPerUser: number
}

export interface FeedbackData {
  totalLikes: number
  totalDislikes: number
  totalLikeUsers: number
  totalDislikeUsers: number
  totalFeedbacks: number
  likeRate: number
  dislikeRate: number
  byDislikeType: Array<{
    type: string
    label: string
    count: number
  }>
  trend: Array<{
    time: string
    likes: number
    dislikes: number
  }>
  recentComments: Array<{
    time: string
    type: string
    typeLabel: string
    text: string
  }>
}

// ─────────────────────────────────────────────────────────
// Time helpers
// ─────────────────────────────────────────────────────────

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? 6 : day - 1 // Monday = 0
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfMonth(date: Date): Date {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

export function getDefaultRange(granularity: Granularity): TimeRange {
  const now = new Date()
  let from: Date
  switch (granularity) {
    case "day":
      from = startOfDay(now)
      break
    case "week":
      from = startOfWeek(now)
      break
    case "month":
      from = startOfMonth(now)
      break
    default:
      from = startOfDay(now)
  }
  return { from: from.toISOString(), to: now.toISOString() }
}

/** Navigate day/week/month forward or backward. Returns new range. */
export function navigateRange(
  granularity: Granularity,
  currentFrom: string,
  direction: "prev" | "next"
): TimeRange {
  const base = new Date(currentFrom)
  const delta = direction === "prev" ? -1 : 1
  const now = new Date()

  let from: Date
  let to: Date

  switch (granularity) {
    case "day": {
      from = new Date(base)
      from.setDate(from.getDate() + delta)
      from = startOfDay(from)
      to = new Date(from)
      to.setDate(to.getDate() + 1)
      to.setMilliseconds(-1)
      // Clamp to now
      if (to > now) to = now
      break
    }
    case "week": {
      from = new Date(base)
      from.setDate(from.getDate() + delta * 7)
      from = startOfWeek(from)
      to = new Date(from)
      to.setDate(to.getDate() + 7)
      to.setMilliseconds(-1)
      if (to > now) to = now
      break
    }
    case "month": {
      from = new Date(base)
      from.setMonth(from.getMonth() + delta)
      from = startOfMonth(from)
      to = new Date(from)
      to.setMonth(to.getMonth() + 1)
      to.setMilliseconds(-1)
      if (to > now) to = now
      break
    }
    default:
      return { from: currentFrom, to: now.toISOString() }
  }

  return { from: from.toISOString(), to: to.toISOString() }
}

// ─────────────────────────────────────────────────────────
// ES response parsers
// ─────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 根据粒度将 ES 返回的 ISO 时间串格式化为可读刻度 */
function formatTrendTime(isoStr: string, granularity: Granularity): string {
  const d = new Date(isoStr)
  if (isNaN(d.getTime())) return isoStr
  const mm  = String(d.getMonth() + 1).padStart(2, "0")
  const dd  = String(d.getDate()).padStart(2, "0")
  const hh  = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  if (granularity === "day") return `${hh}:${min}`
  if (granularity === "week" || granularity === "month") return `${mm}-${dd}`
  // custom：根据时间跨度自动选择
  return `${mm}-${dd} ${hh}:${min}`
}

function parseOverview(raw: any, granularity: Granularity): OverviewData {
  const aggs = raw?.aggregations ?? {}
  const totalCalls = aggs.total_calls?.value ?? 0
  const activeUsers = aggs.active_users?.value ?? 0
  const avgDurationMs = aggs.avg_duration?.value ?? 0
  const inputTokens = aggs.total_input_tokens?.value ?? 0
  const outputTokens = aggs.total_output_tokens?.value ?? 0
  const totalSkills = aggs.total_skills?.value ?? 0
  const totalTools = aggs.total_tools?.value ?? 0
  const totalSkillCalls = aggs.total_skill_calls?.value ?? 0
  const totalToolCalls = aggs.total_tool_calls?.value ?? 0

  const trend: OverviewData["trend"] = (aggs.trend?.buckets ?? []).map((b: any) => ({
    time: formatTrendTime(b.key_as_string ?? new Date(b.key).toISOString(), granularity),
    count: b.doc_count,
    users: b.users?.value ?? 0
  }))

  const bySkill: OverviewData["bySkill"] = (aggs.by_skill?.buckets ?? []).map((b: any) => ({
    skill: b.key || "unknown",
    count: b.doc_count
  }))

  const byTool: OverviewData["byTool"] = (aggs.by_tool?.buckets ?? []).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  const byToolAll: OverviewData["byToolAll"] = (aggs.by_tool_all?.buckets ?? []).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  return { totalCalls, activeUsers, avgDurationMs, inputTokens, outputTokens, totalSkills, totalTools, totalSkillCalls, totalToolCalls, trend, bySkill, byTool, byToolAll }
}

function parseModelStats(raw: any): ModelStatsData {
  const aggs = raw?.aggregations ?? {}

  const byModel: ModelStatsData["byModel"] = (aggs.by_model?.buckets ?? []).map((b: any) => ({
    model: b.key || "unknown",
    count: b.doc_count,
    inputTokens: b.total_input_tokens?.value ?? 0,
    outputTokens: b.total_output_tokens?.value ?? 0
  }))

  const byTier: ModelStatsData["byTier"] = (aggs.by_tier?.buckets ?? []).map((b: any) => ({
    tier: b.key,
    count: b.doc_count
  }))

  const byLayer: ModelStatsData["byLayer"] = (aggs.by_layer?.buckets ?? []).map((b: any) => ({
    layer: b.key,
    count: b.doc_count
  }))

  return { byModel, byTier, byLayer }
}

function parseUserStats(raw: any): UserStatsData {
  const aggs = raw?.aggregations ?? {}

  const topUsers: UserStatsData["topUsers"] = (aggs.top_users?.buckets ?? []).map((b: any) => ({
    sapId: b.key,
    userName: b.user_name?.buckets?.[0]?.key ?? b.key,
    orgName: b.org_name?.buckets?.[0]?.key ?? "",
    count: b.doc_count
  }))

  const byOrg: UserStatsData["byOrg"] = (aggs.by_org?.buckets ?? []).map((b: any) => ({
    org: b.key || "未知",
    count: b.doc_count
  }))

  const byVersion: UserStatsData["byVersion"] = (aggs.by_version?.buckets ?? []).map((b: any) => ({
    version: b.key || "未知",
    count: b.doc_count
  }))

  const userTrend: UserStatsData["userTrend"] = (aggs.user_trend?.buckets ?? []).map((b: any) => ({
    time: b.key_as_string ?? new Date(b.key).toISOString(),
    users: b.users?.value ?? 0
  }))

  return { topUsers, byOrg, byVersion, userTrend }
}

function parseProductivity(raw: any, granularity: Granularity): ProductivityData {
  const aggs = raw?.aggregations ?? {}
  const totalCommits = aggs.total_commits?.value ?? 0
  const activeUsers = aggs.active_users?.value ?? 0

  return {
    commitTrend: (aggs.commit_trend?.buckets ?? []).map((b: any) => ({
      time: formatTrendTime(b.key_as_string ?? new Date(b.key).toISOString(), granularity),
      count: b.doc_count
    })),
    totalInsertions: aggs.total_insertions?.value ?? 0,
    totalDeletions: aggs.total_deletions?.value ?? 0,
    totalFilesChanged: aggs.total_files_changed?.value ?? 0,
    totalCommits,
    activeUsers,
    avgCommitsPerUser: activeUsers > 0 ? totalCommits / activeUsers : 0
  }
}

const DISLIKE_TYPE_LABELS: Record<string, string> = {
  slow: "太慢了",
  not_helpful: "内容不相关",
  inaccurate: "信息不准确",
  unclear: "表述不清楚",
  unsafe: "包含不安全内容",
  other: "其他原因"
}

function formatCommentTime(isoStr: string): string {
  const d = new Date(isoStr)
  if (isNaN(d.getTime())) return isoStr
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  return `${mm}-${dd} ${hh}:${min}`
}

function parseFeedback(raw: any, granularity: Granularity): FeedbackData {
  const aggs = raw?.aggregations ?? {}
  const totalLikes = aggs.total_likes?.doc_count ?? 0
  const totalDislikes = aggs.total_dislikes?.doc_count ?? 0
  const totalLikeUsers = aggs.total_likes?.unique_users?.value ?? 0
  const totalDislikeUsers = aggs.total_dislikes?.unique_users?.value ?? 0
  const totalFeedbacks = totalLikes + totalDislikes

  const dislikeBuckets = aggs.dislike_by_type?.buckets ?? {}
  const byDislikeType: FeedbackData["byDislikeType"] = Object.entries(dislikeBuckets)
    .map(([type, value]) => ({
      type,
      label: DISLIKE_TYPE_LABELS[type] ?? type,
      count: (value as { doc_count?: number }).doc_count ?? 0
    }))
    .sort((a, b) => b.count - a.count)

  const trend: FeedbackData["trend"] = (aggs.trend?.buckets ?? []).map((b: any) => ({
    time: formatTrendTime(b.key_as_string ?? new Date(b.key).toISOString(), granularity),
    likes: b.likes?.doc_count ?? 0,
    dislikes: b.dislikes?.doc_count ?? 0
  }))

  const recentCommentsHits = aggs.recent_dislike_comments?.latest?.hits?.hits ?? []
  const recentComments: FeedbackData["recentComments"] = recentCommentsHits
    .map((hit: any) => {
      const source = hit?._source ?? {}
      const properties = source.properties ?? {}
      const text = String(properties.dislikeText ?? "").trim()
      const type = String(properties.dislikeType ?? properties.feedbackId ?? "other")
      const typeLabel = String(
        properties.dislikeTypeLabel ?? DISLIKE_TYPE_LABELS[type] ?? type
      )
      return {
        time: formatCommentTime(String(source.eventTime ?? "")),
        type,
        typeLabel,
        text
      }
    })
    .filter((item: { text: string }) => Boolean(item.text))

  return {
    totalLikes,
    totalDislikes,
    totalLikeUsers,
    totalDislikeUsers,
    totalFeedbacks,
    likeRate: totalFeedbacks > 0 ? totalLikes / totalFeedbacks : 0,
    dislikeRate: totalFeedbacks > 0 ? totalDislikes / totalFeedbacks : 0,
    byDislikeType,
    trend,
    recentComments
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────

export function useDashboard() {
  const [granularity, setGranularity] = useState<Granularity>("day")
  const [range, setRange] = useState<TimeRange>(() => getDefaultRange("day"))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [modelStats, setModelStats] = useState<ModelStatsData | null>(null)
  const [userStats, setUserStats] = useState<UserStatsData | null>(null)
  const [productivity, setProductivity] = useState<ProductivityData | null>(null)
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)

  const fetchIdRef = useRef(0)

  const fetchAll = useCallback(async (r: TimeRange, g: Granularity) => {
    const id = ++fetchIdRef.current
    setLoading(true)
    setError(null)

    try {
      const [ovRes, msRes, usRes, prRes, fbRes] = await Promise.all([
        window.api.dashboard.overview(r, g),
        window.api.dashboard.modelStats(r, g),
        window.api.dashboard.userStats(r, g),
        window.api.dashboard.productivity(r, g),
        window.api.dashboard.feedback(r, g)
      ])

      // Stale check
      if (id !== fetchIdRef.current) return

      if (!ovRes.success) throw new Error(ovRes.error ?? "获取概览数据失败")
      if (!msRes.success) throw new Error(msRes.error ?? "获取模型数据失败")
      if (!usRes.success) throw new Error(usRes.error ?? "获取用户数据失败")
      if (!prRes.success) throw new Error(prRes.error ?? "获取生产力数据失败")
      if (!fbRes.success) throw new Error(fbRes.error ?? "获取反馈数据失败")

      setOverview(parseOverview(ovRes.data, g))
      setModelStats(parseModelStats(msRes.data))
      setUserStats(parseUserStats(usRes.data))
      setProductivity(parseProductivity(prRes.data, g))
      setFeedback(parseFeedback(fbRes.data, g))
    } catch (e) {
      if (id !== fetchIdRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (id === fetchIdRef.current) setLoading(false)
    }
  }, [])

  // Auto-fetch on range/granularity change
  useEffect(() => {
    fetchAll(range, granularity)
  }, [range, granularity, fetchAll])

  const changeGranularity = useCallback((g: Granularity) => {
    setGranularity(g)
    if (g !== "custom") {
      setRange(getDefaultRange(g))
    }
  }, [])

  const navigate = useCallback(
    (direction: "prev" | "next") => {
      if (granularity === "custom") return
      setRange((r) => navigateRange(granularity, r.from, direction))
    },
    [granularity]
  )

  const setCustomRange = useCallback((from: string, to: string) => {
    setGranularity("custom")
    setRange({ from, to })
  }, [])

  const refresh = useCallback(() => {
    fetchAll(range, granularity)
  }, [fetchAll, range, granularity])

  return {
    granularity,
    range,
    loading,
    error,
    overview,
    modelStats,
    userStats,
    productivity,
    feedback,
    changeGranularity,
    navigate,
    setCustomRange,
    setRange,
    refresh
  }
}
