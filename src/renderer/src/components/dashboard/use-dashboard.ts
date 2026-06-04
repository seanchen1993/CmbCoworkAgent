/**
 * Dashboard data fetching hook
 */
import { useState, useEffect, useCallback, useRef } from "react"
import type { SkillAdoptionRankingItem } from "./skill-adoption-ranking"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month" | "custom"
export type DashboardTraceViewMode = "thread" | "trace"
export type DashboardTraceTriggerScope = "active" | "all"

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
  codeGeneratedLines: number
  codeDeletedLines: number
  codeEffectiveGeneratedLines: number
  codeMeasuredGeneratedLines: number
  codeUnmeasuredGeneratedLines: number
  codeInclusiveEffectiveGeneratedLines: number
  codeAdoptedLines: number
  codePushedMeasuredGeneratedLines: number
  codePushedEffectiveGeneratedLines: number
  codePushedAdoptedLines: number
  codePushedCommitCount: number
  codeMeasuredAdoptionRate: number | null
  codeInclusiveAdoptionRate: number | null
  codePushedAdoptionRate: number | null
  codeAdoptionRate: number | null
  totalSkills: number
  totalTools: number
  totalSkillCalls: number
  totalToolCalls: number
  trend: Array<{ time: string; count: number; users: number }>
  bySkill: Array<{ skill: string; count: number }>
  bySkillAll: Array<{ skill: string; count: number }>
  bySkillAdoption: SkillAdoptionRankingItem[]
  byTool: Array<{ tool: string; count: number }>
  byToolAll: Array<{ tool: string; count: number }>
  byToolFilteredAll: Array<{ tool: string; count: number }>
  byToolAllFull: Array<{ tool: string; count: number }>
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
  byOrg: Array<{ key: string; org: string; count: number }>
  byOrgPv: Array<{ key: string; org: string; count: number }>
  byOrgUv: Array<{ key: string; org: string; count: number }>
  byVersion: Array<{ version: string; count: number }>
  latestVersion: string
  versionUsers: Array<{
    sapId: string
    userName: string
    orgName: string
    version: string
    collectionTime: string
  }>
  userVersionUsage: Array<{
    sapId: string
    userName: string
    orgName: string
    version: string
    collectionTime: string
    isLatestVersion: boolean
  }>
  userTrend: Array<{ time: string; users: number }>
  selectedUpperOrgLv1: string | null
}

type ParsedTopUser = UserStatsData["topUsers"][number]

export interface DashboardTraceNode {
  id: string
  type: "trace" | "llm" | "tool" | "tool_result" | "message" | "error" | "cancel"
  parentId: string | null
  name?: string
  status?: "running" | "success" | "error" | "cancelled" | "unknown"
  startedAt: string
  endedAt?: string
  input?: unknown
  output?: unknown
  metadata?: Record<string, unknown>
}

export interface DashboardTraceDetail {
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
  nodes?: DashboardTraceNode[]
  rawAvailable: boolean
  rawError?: string
}

export interface DashboardCommitDetail {
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

export interface DashboardCommitDetailsData {
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
}

export interface DashboardCodeStats {
  generatedLines: number
  deletedLines: number
  effectiveGeneratedLines: number
  measuredGeneratedLines: number
  unmeasuredGeneratedLines: number
  inclusiveEffectiveGeneratedLines: number
  adoptedLines: number
  pushedMeasuredGeneratedLines: number
  pushedEffectiveGeneratedLines: number
  pushedAdoptedLines: number
  pushedCommitCount: number
  measuredAdoptionRate: number | null
  inclusiveAdoptionRate: number | null
  pushedAdoptionRate: number | null
  adoptionRate: number | null
}

export interface DashboardSkillDetail {
  stats: DashboardCodeStats
  traces: DashboardTraceDetail[]
  tracePage: number
  tracePageSize: number
  totalTraces: number
  traceViewMode?: DashboardTraceViewMode
  traceTriggerScope?: DashboardTraceTriggerScope
}

export interface DashboardUserListItem {
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

export interface DashboardUserListData {
  items: DashboardUserListItem[]
  pageSize: number
  nextAfterKey?: Record<string, string | number>
  totalActiveUsers: number
}

export interface DashboardUserDetail {
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
  traceViewMode?: DashboardTraceViewMode
  traceTriggerScope?: DashboardTraceTriggerScope
}

export interface ProductivityData {
  commitTrend: Array<{ time: string; count: number; from: string; to: string }>
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

export interface DashboardSkillEvalRun {
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
  traceDetail?: DashboardTraceDetail
  traceDetails?: DashboardTraceDetail[]
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

export interface DashboardSkillEvalSkillSummary {
  skillName: string
  skillVersion?: string
  statsPending?: boolean
  statsFailed?: boolean
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

export interface DashboardSkillEvalSummary {
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

export interface DashboardSkillEvalOptions {
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

const SKILL_EVAL_RECENT_PAGE_SIZE = 10
const SKILL_EVAL_SKILL_PAGE_SIZE = 10
const SKILL_EVAL_BACKGROUND_STATS_CONCURRENCY = 3
const SKILL_EVAL_BACKGROUND_STATS_LIMIT = 500

function dashboardSkillEvalKey(skillName?: string, skillVersion?: string): string {
  return `${skillName ?? ""}:${skillVersion ?? ""}`
}

function markSkillEvalStatsPending(summary: DashboardSkillEvalSummary): DashboardSkillEvalSummary {
  return {
    ...summary,
    skills: summary.skills.map((skill) => ({
      ...skill,
      statsPending: true,
      statsFailed: false
    }))
  }
}

function withSkillEvalDerivedTotals(summary: DashboardSkillEvalSummary): DashboardSkillEvalSummary {
  const loadedSkills = summary.skills.filter((skill) => !skill.statsPending && !skill.statsFailed)
  const totalRuns = loadedSkills.reduce((sum, skill) => sum + skill.runs, 0)
  if (totalRuns <= 0) {
    return {
      ...summary,
      totalRuns: 0,
      passRate: 0,
      resultEvaluatedRuns: 0,
      resultPassRate: 0,
      averageScore: 0,
      averageProcessScore: 0,
      averageOutcomeScore: 0,
      averageResultScore: 0,
      averageToolCalls: 0,
      averageModelCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalPromptInputTokens: 0,
      totalTokens: 0,
      averageInputTokens: 0,
      averageOutputTokens: 0,
      averagePromptInputTokens: 0,
      averageTotalTokens: 0,
      averagePeakInputTokens: 0,
      averageDurationMs: 0
    }
  }
  const weighted = (
    selector: (skill: DashboardSkillEvalSkillSummary) => number,
    denominatorSelector: (skill: DashboardSkillEvalSkillSummary) => number = (skill) => skill.runs
  ): number => {
    const denominator = loadedSkills.reduce((sum, skill) => sum + denominatorSelector(skill), 0)
    if (denominator <= 0) return 0
    return Number(
      (
        loadedSkills.reduce((sum, skill) => sum + selector(skill) * denominatorSelector(skill), 0) /
        denominator
      ).toFixed(4)
    )
  }
  const totalInputTokens = loadedSkills.reduce(
    (sum, skill) => sum + skill.averageInputTokens * skill.runs,
    0
  )
  const totalOutputTokens = loadedSkills.reduce(
    (sum, skill) => sum + skill.averageOutputTokens * skill.runs,
    0
  )
  const totalPromptInputTokens = loadedSkills.reduce(
    (sum, skill) => sum + skill.averagePromptInputTokens * skill.runs,
    0
  )
  const totalTokens = loadedSkills.reduce(
    (sum, skill) => sum + skill.averageTotalTokens * skill.runs,
    0
  )

  return {
    ...summary,
    totalRuns,
    resultEvaluatedRuns: loadedSkills.reduce((sum, skill) => sum + skill.resultEvaluatedRuns, 0),
    passRate: weighted((skill) => skill.passRate),
    resultPassRate: weighted(
      (skill) => skill.resultPassRate,
      (skill) => skill.resultEvaluatedRuns
    ),
    averageScore: weighted((skill) => skill.averageScore),
    averageProcessScore: weighted((skill) => skill.averageProcessScore),
    averageOutcomeScore: weighted((skill) => skill.averageOutcomeScore),
    averageResultScore: weighted(
      (skill) => skill.averageResultScore,
      (skill) => skill.resultEvaluatedRuns
    ),
    averageToolCalls: weighted((skill) => skill.averageToolCalls),
    averageModelCalls: weighted((skill) => skill.averageModelCalls),
    totalInputTokens: Math.round(totalInputTokens),
    totalOutputTokens: Math.round(totalOutputTokens),
    totalPromptInputTokens: Math.round(totalPromptInputTokens),
    totalTokens: Math.round(totalTokens),
    averageInputTokens: Number((totalInputTokens / totalRuns).toFixed(4)),
    averageOutputTokens: Number((totalOutputTokens / totalRuns).toFixed(4)),
    averagePromptInputTokens: Number((totalPromptInputTokens / totalRuns).toFixed(4)),
    averageTotalTokens: Number((totalTokens / totalRuns).toFixed(4)),
    averagePeakInputTokens: weighted((skill) => skill.averagePeakInputTokens),
    averageDurationMs: weighted((skill) => skill.averageDurationMs)
  }
}

function skillEvalSummaryToFilter(skill: DashboardSkillEvalSkillSummary): {
  skillName: string
  skillVersion?: string
} {
  return {
    skillName: skill.skillName,
    ...(skill.skillVersion ? { skillVersion: skill.skillVersion } : {})
  }
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

function getCurrentPeriodStart(granularity: Granularity, now = new Date()): Date | null {
  switch (granularity) {
    case "day":
      return startOfDay(now)
    case "week":
      return startOfWeek(now)
    case "month":
      return startOfMonth(now)
    default:
      return null
  }
}

export function getRefreshRange(range: TimeRange, granularity: Granularity): TimeRange {
  const currentPeriodStart = getCurrentPeriodStart(granularity)
  if (!currentPeriodStart) return range

  const currentFrom = currentPeriodStart.toISOString()
  if (range.from !== currentFrom) return range

  return {
    from: range.from,
    to: new Date().toISOString()
  }
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
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const min = String(d.getMinutes()).padStart(2, "0")
  if (granularity === "day") return `${hh}:${min}`
  if (granularity === "week" || granularity === "month") return `${mm}-${dd}`
  // custom：根据时间跨度自动选择
  return `${mm}-${dd} ${hh}:${min}`
}

function getTrendBucketInterval(
  granularity: Granularity,
  range: TimeRange
): "hour" | "day" | "week" {
  if (granularity === "day") return "hour"
  if (granularity === "custom") {
    const diffMs = new Date(range.to).getTime() - new Date(range.from).getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    if (diffDays <= 1) return "hour"
    if (diffDays <= 14) return "day"
    return "week"
  }
  return "day"
}

function getTrendBucketRange(
  bucketIso: string,
  granularity: Granularity,
  range: TimeRange
): TimeRange {
  const interval = getTrendBucketInterval(granularity, range)
  const bucketStart = new Date(bucketIso).getTime()
  const rangeFrom = new Date(range.from).getTime()
  const rangeTo = new Date(range.to).getTime()
  const durationMs =
    interval === "hour"
      ? 60 * 60 * 1000
      : interval === "day"
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000
  const from = Math.max(bucketStart, rangeFrom)
  const to = Math.min(bucketStart + durationMs - 1, rangeTo)
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString()
  }
}

function parseOverview(raw: any, granularity: Granularity): OverviewData {
  const aggs = raw?.aggregations ?? {}
  const totalCalls = aggs.total_calls?.value ?? 0
  const activeUsers = aggs.active_users?.value ?? 0
  const avgDurationMs = aggs.avg_duration?.value ?? 0
  const inputTokens = aggs.total_input_tokens?.value ?? 0
  const outputTokens = aggs.total_output_tokens?.value ?? 0
  const codeGeneratedLines = aggs.code_generated_lines?.value ?? 0
  const codeDeletedLines = aggs.code_deleted_lines?.value ?? 0
  const codeMeasuredGeneratedLines = aggs.code_measured_generated_lines?.value ?? 0
  const codeEffectiveGeneratedLines = aggs.code_effective_generated_lines?.value ?? 0
  const codeUnmeasuredGeneratedLines =
    aggs.code_unmeasured_generated_lines?.value ??
    Math.max(0, codeGeneratedLines - codeMeasuredGeneratedLines)
  const codeInclusiveEffectiveGeneratedLines =
    aggs.code_inclusive_effective_generated_lines?.value ??
    codeEffectiveGeneratedLines + codeUnmeasuredGeneratedLines
  const codeAdoptedLines = aggs.code_adopted_lines?.value ?? 0
  const codePushedMeasuredGeneratedLines = aggs.code_pushed_measured_generated_lines?.value ?? 0
  const codePushedEffectiveGeneratedLines = aggs.code_pushed_effective_generated_lines?.value ?? 0
  const codePushedAdoptedLines = aggs.code_pushed_adopted_lines?.value ?? 0
  const codePushedCommitCount = aggs.code_pushed_commit_count?.value ?? 0
  const codeMeasuredAdoptionRate =
    codeEffectiveGeneratedLines > 0 ? codeAdoptedLines / codeEffectiveGeneratedLines : null
  const codeInclusiveAdoptionRate =
    codeInclusiveEffectiveGeneratedLines > 0
      ? codeAdoptedLines / codeInclusiveEffectiveGeneratedLines
      : null
  const codePushedAdoptionRate =
    codePushedEffectiveGeneratedLines > 0
      ? codePushedAdoptedLines / codePushedEffectiveGeneratedLines
      : null
  const codeAdoptionRate = codeMeasuredAdoptionRate
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

  const bySkillAll: OverviewData["bySkillAll"] = (
    aggs.by_skill_all?.buckets ??
    aggs.by_skill?.buckets ??
    []
  ).map((b: any) => ({
    skill: b.key || "unknown",
    count: b.doc_count
  }))

  const bySkillAdoption: OverviewData["bySkillAdoption"] = (
    aggs.code_by_skill_adoption?.buckets ?? []
  ).map((b: any) => {
    const measuredAdoptionRate = b.measured_adoption_rate?.value
    const inclusiveAdoptionRate = b.inclusive_adoption_rate?.value
    const pushedAdoptionRate = b.pushed_adoption_rate?.value
    return {
      skill: b.key || "unknown",
      generatedLines: b.generated_lines?.value ?? 0,
      measuredGeneratedLines: b.measured_generated_lines?.value ?? 0,
      effectiveGeneratedLines: b.effective_generated_lines?.value ?? 0,
      unmeasuredGeneratedLines: b.unmeasured_generated_lines?.value ?? 0,
      inclusiveEffectiveGeneratedLines: b.inclusive_effective_generated_lines?.value ?? 0,
      adoptedLines: b.adopted_lines?.value ?? 0,
      pushedMeasuredGeneratedLines: b.pushed_measured_generated_lines?.value ?? 0,
      pushedEffectiveGeneratedLines: b.pushed_effective_generated_lines?.value ?? 0,
      pushedAdoptedLines: b.pushed_adopted_lines?.value ?? 0,
      pushedCommitCount: b.pushed_commit_count?.value ?? 0,
      measuredAdoptionRate: typeof measuredAdoptionRate === "number" ? measuredAdoptionRate : null,
      inclusiveAdoptionRate:
        typeof inclusiveAdoptionRate === "number" ? inclusiveAdoptionRate : null,
      pushedAdoptionRate: typeof pushedAdoptionRate === "number" ? pushedAdoptionRate : null,
      commitCount: b.commit_count?.value ?? 0
    }
  })

  const byTool: OverviewData["byTool"] = (aggs.by_tool?.buckets ?? []).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  const byToolAll: OverviewData["byToolAll"] = (aggs.by_tool_all?.buckets ?? []).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  const byToolFilteredAll: OverviewData["byToolFilteredAll"] = (
    aggs.by_tool_filtered_all?.buckets ??
    aggs.by_tool?.buckets ??
    []
  ).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  const byToolAllFull: OverviewData["byToolAllFull"] = (
    aggs.by_tool_all_full?.buckets ??
    aggs.by_tool_all?.buckets ??
    []
  ).map((b: any) => ({
    tool: b.key || "unknown",
    count: b.doc_count
  }))

  return {
    totalCalls,
    activeUsers,
    avgDurationMs,
    inputTokens,
    outputTokens,
    codeGeneratedLines,
    codeDeletedLines,
    codeEffectiveGeneratedLines,
    codeMeasuredGeneratedLines,
    codeUnmeasuredGeneratedLines,
    codeInclusiveEffectiveGeneratedLines,
    codeAdoptedLines,
    codePushedMeasuredGeneratedLines,
    codePushedEffectiveGeneratedLines,
    codePushedAdoptedLines,
    codePushedCommitCount,
    codeMeasuredAdoptionRate,
    codeInclusiveAdoptionRate,
    codePushedAdoptionRate,
    codeAdoptionRate,
    totalSkills,
    totalTools,
    totalSkillCalls,
    totalToolCalls,
    trend,
    bySkill,
    bySkillAll,
    bySkillAdoption,
    byTool,
    byToolAll,
    byToolFilteredAll,
    byToolAllFull
  }
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

function normalizeMetricValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? "") : ""
  return value == null ? "" : String(value)
}

function getLatestUserMetric(bucket: any, field: string): string {
  return normalizeMetricValue(bucket.latest_user_info?.hits?.hits?.[0]?._source?.[field])
}

function getLatestUserCollectionTime(bucket: any): string {
  const hit = bucket?.latest_user_info?.hits?.hits?.[0]
  return normalizeMetricValue(hit?._source?.startedAt) || normalizeMetricValue(hit?.sort?.[0])
}

function compareVersionLike(a: string, b: string): number {
  const aParts = a.match(/\d+|[a-zA-Z]+/g) ?? []
  const bParts = b.match(/\d+|[a-zA-Z]+/g) ?? []
  const len = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const aPart = aParts[i] ?? "0"
    const bPart = bParts[i] ?? "0"
    const aNum = /^\d+$/.test(aPart) ? Number(aPart) : null
    const bNum = /^\d+$/.test(bPart) ? Number(bPart) : null
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum
      continue
    }
    const compared = aPart.localeCompare(bPart)
    if (compared !== 0) return compared
  }
  return 0
}

export function formatTopUserOrgName(
  orgName: string,
  upperOrgLv1: string,
  upperOrgLv0: string
): string {
  const normalizedOrgName = orgName.trim()
  const normalizedUpperOrgLv1 = upperOrgLv1.trim()
  const normalizedUpperOrgLv0 = upperOrgLv0.trim()
  if (normalizedUpperOrgLv1 && normalizedUpperOrgLv0)
    return `${normalizedUpperOrgLv1}/${normalizedUpperOrgLv0}`
  if (normalizedUpperOrgLv1) return normalizedUpperOrgLv1
  return normalizedOrgName
}

function parseUserStats(raw: any, selectedUpperOrgLv1: string | null): UserStatsData {
  const aggs = raw?.aggregations ?? {}
  const getOrgBuckets = (agg: any): any[] =>
    Array.isArray(agg?.buckets) ? agg.buckets : (agg?.items?.buckets ?? [])
  const mapOrgBuckets = (buckets: any[], metric: "pv" | "uv"): UserStatsData["byOrg"] =>
    buckets
      .filter((b: any) => String(b.key ?? "").trim() !== "")
      .map((b: any) => ({
        key: String(b.key ?? ""),
        org: String(b.key ?? ""),
        count: metric === "uv" ? (b.unique_users?.value ?? b.doc_count ?? 0) : (b.doc_count ?? 0)
      }))
  const byOrgPvBuckets = getOrgBuckets(aggs.by_org_pv ?? aggs.by_org)
  const byOrgUvBuckets = getOrgBuckets(aggs.by_org_uv ?? aggs.by_org)

  const topUsers: UserStatsData["topUsers"] = (aggs.top_users?.buckets ?? []).map((b: any) => {
    const userName = getLatestUserMetric(b, "userName") || b.key
    const orgName = getLatestUserMetric(b, "orgName")
    const upperOrgLv1 = getLatestUserMetric(b, "upperOrgLv1")
    const upperOrgLv0 = getLatestUserMetric(b, "upperOrgLv0")
    return {
      sapId: b.key,
      userName,
      orgName: formatTopUserOrgName(orgName, upperOrgLv1, upperOrgLv0),
      count: b.doc_count
    }
  })

  const byOrgPv = mapOrgBuckets(byOrgPvBuckets, "pv")
  const byOrgUv = mapOrgBuckets(byOrgUvBuckets, "uv")
  const byOrg = byOrgPv

  const byVersion: UserStatsData["byVersion"] = (aggs.by_version?.buckets ?? []).map((b: any) => ({
    version: b.key || "未知",
    count: b.unique_users?.value ?? b.doc_count
  }))
  const latestVersion =
    byVersion
      .map((item) => item.version)
      .filter((version) => version && version !== "未知")
      .sort(compareVersionLike)
      .at(-1) ?? ""
  const versionUserBuckets: UserStatsData["versionUsers"] = (
    aggs.by_version?.buckets ?? []
  ).flatMap((versionBucket: any) =>
    (versionBucket.users?.buckets ?? []).map((userBucket: any) => {
      const userName = getLatestUserMetric(userBucket, "userName") || userBucket.key
      const orgName = getLatestUserMetric(userBucket, "orgName")
      const upperOrgLv1 = getLatestUserMetric(userBucket, "upperOrgLv1")
      const upperOrgLv0 = getLatestUserMetric(userBucket, "upperOrgLv0")
      const version = getLatestUserMetric(userBucket, "appVersion") || versionBucket.key || "未知"
      return {
        sapId: userBucket.key,
        userName,
        orgName: formatTopUserOrgName(orgName, upperOrgLv1, upperOrgLv0),
        version,
        collectionTime: getLatestUserCollectionTime(userBucket)
      }
    })
  )

  const fallbackVersionUsers: UserStatsData["versionUsers"] = topUsers.map((user) => {
    const bucket = (aggs.top_users?.buckets ?? []).find((item: any) => item.key === user.sapId)
    const version = getLatestUserMetric(bucket, "appVersion") || "未知"
    return {
      sapId: user.sapId,
      userName: user.userName,
      orgName: user.orgName,
      version,
      collectionTime: getLatestUserCollectionTime(bucket)
    }
  })
  const versionUsers = versionUserBuckets.length > 0 ? versionUserBuckets : fallbackVersionUsers

  const userVersionUsage: UserStatsData["userVersionUsage"] = versionUsers
    .map((user) => ({
      ...user,
      isLatestVersion: Boolean(latestVersion && user.version === latestVersion)
    }))
    .filter((user) => !user.isLatestVersion)

  const userTrend: UserStatsData["userTrend"] = (aggs.user_trend?.buckets ?? []).map((b: any) => ({
    time: b.key_as_string ?? new Date(b.key).toISOString(),
    users: b.users?.value ?? 0
  }))

  return {
    topUsers,
    byOrg,
    byOrgPv,
    byOrgUv,
    byVersion,
    latestVersion,
    versionUsers,
    userVersionUsage,
    userTrend,
    selectedUpperOrgLv1
  }
}

export function parseTopUsersFromAgg(raw: any): ParsedTopUser[] {
  const aggs = raw?.aggregations ?? {}
  return (aggs.top_users?.buckets ?? []).map((b: any) => {
    const userName = getLatestUserMetric(b, "userName") || b.user_name?.buckets?.[0]?.key || b.key
    const orgName = getLatestUserMetric(b, "orgName") || b.org_name?.buckets?.[0]?.key || ""
    const upperOrgLv1 = getLatestUserMetric(b, "upperOrgLv1")
    const upperOrgLv0 = getLatestUserMetric(b, "upperOrgLv0")
    return {
      sapId: b.key,
      userName,
      orgName: formatTopUserOrgName(orgName, upperOrgLv1, upperOrgLv0),
      count: b.doc_count
    }
  })
}

function parseProductivity(raw: any, granularity: Granularity, range: TimeRange): ProductivityData {
  const aggs = raw?.aggregations ?? {}
  const totalCommits = aggs.total_commits?.value ?? 0
  const activeUsers = aggs.active_users?.value ?? 0

  return {
    commitTrend: (aggs.commit_trend?.buckets ?? []).map((b: any) => {
      const iso = b.key_as_string ?? new Date(b.key).toISOString()
      const bucketRange = getTrendBucketRange(iso, granularity, range)
      return {
        time: formatTrendTime(iso, granularity),
        count: b.doc_count,
        from: bucketRange.from,
        to: bucketRange.to
      }
    }),
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
      const typeLabel = String(properties.dislikeTypeLabel ?? DISLIKE_TYPE_LABELS[type] ?? type)
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

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function parseSkillEvalChecks(raw: any): DashboardSkillEvalRun["checks"] {
  return Array.isArray(raw)
    ? raw.map((item: any) => ({
        name: String(item?.name ?? ""),
        label: String(item?.label ?? ""),
        ok: item?.ok === true,
        weight: numberValue(item?.weight),
        ...(item?.detail && typeof item.detail === "object"
          ? { detail: item.detail as Record<string, unknown> }
          : {})
      }))
    : []
}

function parseSkillEvalArtifacts(raw: any): DashboardSkillEvalRun["resultArtifacts"] {
  return Array.isArray(raw)
    ? raw.map((item: any) => ({
        type: String(item?.type ?? "other"),
        label: String(item?.label ?? "产物"),
        ...(item?.path ? { path: String(item.path) } : {}),
        ...(item?.url ? { url: String(item.url) } : {}),
        ...(item?.detail && typeof item.detail === "object"
          ? { detail: item.detail as Record<string, unknown> }
          : {})
      }))
    : []
}

function parseDashboardTraceDetail(raw: any): DashboardTraceDetail | undefined {
  if (!raw || typeof raw !== "object") return undefined
  return {
    traceId: String(raw.traceId ?? ""),
    threadId: String(raw.threadId ?? ""),
    startedAt: String(raw.startedAt ?? ""),
    endedAt: raw.endedAt ? String(raw.endedAt) : undefined,
    durationMs: numberValue(raw.durationMs),
    userMessage: String(raw.userMessage ?? ""),
    ...(raw.sapId ? { sapId: String(raw.sapId) } : {}),
    ...(raw.ystId ? { ystId: String(raw.ystId) } : {}),
    ...(raw.userName ? { userName: String(raw.userName) } : {}),
    ...(raw.orgName ? { orgName: String(raw.orgName) } : {}),
    ...(raw.userIp ? { userIp: String(raw.userIp) } : {}),
    ...(raw.modelId ? { modelId: String(raw.modelId) } : {}),
    ...(raw.modelName ? { modelName: String(raw.modelName) } : {}),
    outcome: String(raw.outcome ?? "unknown"),
    totalToolCalls: numberValue(raw.totalToolCalls),
    totalInputTokens: numberValue(raw.totalInputTokens),
    totalOutputTokens: numberValue(raw.totalOutputTokens),
    totalTokens: numberValue(raw.totalTokens),
    usedSkills: Array.isArray(raw.usedSkills) ? raw.usedSkills.map(String) : [],
    evolvedSkills: Array.isArray(raw.evolvedSkills) ? raw.evolvedSkills.map(String) : [],
    ...(raw.triggerSource ? { triggerSource: String(raw.triggerSource) } : {}),
    nodes: Array.isArray(raw.nodes) ? raw.nodes : undefined,
    rawAvailable: raw.rawAvailable === true,
    ...(raw.rawError ? { rawError: String(raw.rawError) } : {})
  }
}

function parseSkillEvalSummary(
  raw: any,
  options: DashboardSkillEvalOptions = {}
): DashboardSkillEvalSummary {
  const skills: DashboardSkillEvalSkillSummary[] = Array.isArray(raw?.skills)
    ? raw.skills.map((item: any) => ({
        skillName: String(item.skillName ?? "unknown"),
        ...(item.skillVersion ? { skillVersion: String(item.skillVersion) } : {}),
        ...(item.statsPending === true ? { statsPending: true } : {}),
        ...(item.statsFailed === true ? { statsFailed: true } : {}),
        runs: numberValue(item.runs),
        resultEvaluatedRuns: numberValue(item.resultEvaluatedRuns),
        passRate: numberValue(item.passRate),
        resultPassRate: numberValue(item.resultPassRate),
        averageScore: numberValue(item.averageScore),
        averageProcessScore: numberValue(item.averageProcessScore),
        averageOutcomeScore: numberValue(item.averageOutcomeScore),
        averageResultScore: numberValue(item.averageResultScore),
        averageToolCalls: numberValue(item.averageToolCalls),
        averageModelCalls: numberValue(item.averageModelCalls),
        averageInputTokens: numberValue(item.averageInputTokens),
        averageOutputTokens: numberValue(item.averageOutputTokens),
        averagePromptInputTokens: numberValue(item.averagePromptInputTokens),
        averageTotalTokens: numberValue(item.averageTotalTokens),
        averagePeakInputTokens: numberValue(item.averagePeakInputTokens),
        averageDurationMs: numberValue(item.averageDurationMs),
        validationRate: numberValue(item.validationRate),
        outputSignalRate: numberValue(item.outputSignalRate),
        dangerRate: numberValue(item.dangerRate),
        failureCount: numberValue(item.failureCount),
        lastRunAt: String(item.lastRunAt ?? "")
      }))
    : []

  const allRecent: DashboardSkillEvalRun[] = Array.isArray(raw?.recent)
    ? raw.recent.map((item: any) => ({
        traceId: String(item.traceId ?? ""),
        threadId: String(item.threadId ?? ""),
        startedAt: String(item.startedAt ?? ""),
        endedAt: String(item.endedAt ?? ""),
        userMessage: String(item.userMessage ?? ""),
        skillName: String(item.skillName ?? "unknown"),
        ...(item.skillVersion ? { skillVersion: String(item.skillVersion) } : {}),
        rawSkillName: String(item.rawSkillName ?? ""),
        ...(item.skillTaskId ? { skillTaskId: String(item.skillTaskId) } : {}),
        ...(item.skillTaskTraceIndex !== undefined
          ? { skillTaskTraceIndex: numberValue(item.skillTaskTraceIndex) }
          : {}),
        ...(item.evalSource === "explicit" || item.evalSource === "inherited_context"
          ? { evalSource: item.evalSource }
          : {}),
        contextTraceIds: Array.isArray(item.contextTraceIds)
          ? item.contextTraceIds.map(String)
          : [],
        skillEvalTraceIds: Array.isArray(item.skillEvalTraceIds)
          ? item.skillEvalTraceIds.map(String)
          : [],
        contextTraceCount: numberValue(item.contextTraceCount),
        skillEvalTraceCount: numberValue(item.skillEvalTraceCount),
        outcome: String(item.outcome ?? "unknown"),
        processScore: numberValue(item.processScore),
        outcomeScore: numberValue(item.outcomeScore),
        score: numberValue(item.score),
        outcomePass: item.outcomePass === true,
        pass: item.pass === true,
        ...(item.resultScore !== undefined ? { resultScore: numberValue(item.resultScore) } : {}),
        resultPass: item.resultPass === true,
        totalToolCalls: numberValue(item.totalToolCalls),
        modelCallCount: numberValue(item.modelCallCount),
        totalInputTokens: numberValue(item.totalInputTokens),
        totalOutputTokens: numberValue(item.totalOutputTokens),
        promptInputTokens: numberValue(item.promptInputTokens),
        totalTokens: numberValue(item.totalTokens),
        cacheReadTokens: numberValue(item.cacheReadTokens),
        cacheCreationTokens: numberValue(item.cacheCreationTokens),
        peakInputTokens: numberValue(item.peakInputTokens),
        errorCount: numberValue(item.errorCount),
        durationMs: numberValue(item.durationMs),
        checks: parseSkillEvalChecks(item.checks),
        outcomeChecks: parseSkillEvalChecks(item.outcomeChecks),
        resultChecks: parseSkillEvalChecks(item.resultChecks),
        warnings: Array.isArray(item.warnings) ? item.warnings.map(String) : [],
        outcomeWarnings: Array.isArray(item.outcomeWarnings)
          ? item.outcomeWarnings.map(String)
          : [],
        resultWarnings: Array.isArray(item.resultWarnings) ? item.resultWarnings.map(String) : [],
        resultIssues: Array.isArray(item.resultIssues) ? item.resultIssues.map(String) : [],
        resultArtifacts: parseSkillEvalArtifacts(item.resultArtifacts),
        resultGenerated: item.resultGenerated === true,
        traceDetail: parseDashboardTraceDetail(item.traceDetail),
        traceDetails: Array.isArray(item.traceDetails)
          ? item.traceDetails
              .map((trace: any) => parseDashboardTraceDetail(trace))
              .filter((trace: DashboardTraceDetail | undefined): trace is DashboardTraceDetail =>
                Boolean(trace)
              )
          : [],
        evidence: {
          finalResponseLength: numberValue(item.evidence?.finalResponseLength),
          changedFiles: numberValue(item.evidence?.changedFiles),
          validationCommands: numberValue(item.evidence?.validationCommands),
          artifactSignals: numberValue(item.evidence?.artifactSignals),
          dangerousCommands: numberValue(item.evidence?.dangerousCommands),
          subagentRuns: numberValue(item.evidence?.subagentRuns),
          subagentCompleted: numberValue(item.evidence?.subagentCompleted),
          subagentResultLength: numberValue(item.evidence?.subagentResultLength),
          subagentFailed: numberValue(item.evidence?.subagentFailed),
          toolResultErrors: numberValue(item.evidence?.toolResultErrors)
        }
      }))
    : []
  const hasBackendPagination =
    raw?.recentTotal !== undefined ||
    raw?.recentPage !== undefined ||
    raw?.recentPageSize !== undefined
  const hasBackendSkillPagination =
    raw?.totalSkills !== undefined ||
    raw?.skillPage !== undefined ||
    raw?.skillPageSize !== undefined
  const requestedPage = Math.max(1, numberValue(options.recentPage) || 1)
  const requestedPageSize = Math.max(
    1,
    numberValue(options.recentPageSize) || SKILL_EVAL_RECENT_PAGE_SIZE
  )
  const recentPageSize = hasBackendPagination
    ? Math.max(1, numberValue(raw?.recentPageSize) || requestedPageSize)
    : requestedPageSize
  const recentTotal = hasBackendPagination
    ? numberValue(raw?.recentTotal ?? allRecent.length)
    : allRecent.length
  const recentTotalPages = Math.max(1, Math.ceil(recentTotal / recentPageSize))
  const recentPage = hasBackendPagination
    ? Math.max(1, numberValue(raw?.recentPage) || requestedPage)
    : Math.min(requestedPage, recentTotalPages)
  const recentOffset = (recentPage - 1) * recentPageSize
  const recent = hasBackendPagination
    ? allRecent
    : allRecent.slice(recentOffset, recentOffset + recentPageSize)
  const requestedSkillPage = Math.max(1, numberValue(options.skillPage) || 1)
  const requestedSkillPageSize = Math.max(
    1,
    numberValue(options.skillPageSize) || SKILL_EVAL_SKILL_PAGE_SIZE
  )
  const skillPageSize = hasBackendSkillPagination
    ? Math.max(1, numberValue(raw?.skillPageSize) || requestedSkillPageSize)
    : requestedSkillPageSize
  const totalSkills = hasBackendSkillPagination
    ? numberValue(raw?.totalSkills ?? skills.length)
    : skills.length
  const skillTotalPages = Math.max(1, Math.ceil(totalSkills / skillPageSize))
  const skillPage = hasBackendSkillPagination
    ? Math.max(1, numberValue(raw?.skillPage) || requestedSkillPage)
    : Math.min(requestedSkillPage, skillTotalPages)

  return {
    generatedAt: String(raw?.generatedAt ?? ""),
    totalTraceHits: numberValue(raw?.totalTraceHits),
    evaluatedTraceCount: numberValue(raw?.evaluatedTraceCount),
    sampledTraceCount: numberValue(raw?.sampledTraceCount),
    statTraceLimit: numberValue(raw?.statTraceLimit),
    recentTotal,
    recentPage,
    recentPageSize,
    skillPage,
    skillPageSize,
    totalRuns: numberValue(raw?.totalRuns),
    resultEvaluatedRuns: numberValue(raw?.resultEvaluatedRuns),
    totalSkills,
    passRate: numberValue(raw?.passRate),
    resultPassRate: numberValue(raw?.resultPassRate),
    averageScore: numberValue(raw?.averageScore),
    averageProcessScore: numberValue(raw?.averageProcessScore),
    averageOutcomeScore: numberValue(raw?.averageOutcomeScore),
    averageResultScore: numberValue(raw?.averageResultScore),
    averageToolCalls: numberValue(raw?.averageToolCalls),
    averageModelCalls: numberValue(raw?.averageModelCalls),
    totalInputTokens: numberValue(raw?.totalInputTokens),
    totalOutputTokens: numberValue(raw?.totalOutputTokens),
    totalPromptInputTokens: numberValue(raw?.totalPromptInputTokens),
    totalTokens: numberValue(raw?.totalTokens),
    averageInputTokens: numberValue(raw?.averageInputTokens),
    averageOutputTokens: numberValue(raw?.averageOutputTokens),
    averagePromptInputTokens: numberValue(raw?.averagePromptInputTokens),
    averageTotalTokens: numberValue(raw?.averageTotalTokens),
    averagePeakInputTokens: numberValue(raw?.averagePeakInputTokens),
    averageDurationMs: numberValue(raw?.averageDurationMs),
    skills,
    recent
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function emptySkillEvalSummary(): DashboardSkillEvalSummary {
  return {
    generatedAt: new Date().toISOString(),
    totalTraceHits: 0,
    evaluatedTraceCount: 0,
    sampledTraceCount: 0,
    statTraceLimit: 0,
    recentTotal: 0,
    recentPage: 1,
    recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
    skillPage: 1,
    skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE,
    totalRuns: 0,
    resultEvaluatedRuns: 0,
    totalSkills: 0,
    passRate: 0,
    resultPassRate: 0,
    averageScore: 0,
    averageProcessScore: 0,
    averageOutcomeScore: 0,
    averageResultScore: 0,
    averageToolCalls: 0,
    averageModelCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalPromptInputTokens: 0,
    totalTokens: 0,
    averageInputTokens: 0,
    averageOutputTokens: 0,
    averagePromptInputTokens: 0,
    averageTotalTokens: 0,
    averagePeakInputTokens: 0,
    averageDurationMs: 0,
    skills: [],
    recent: []
  }
}

function mergeSkillEvalRecentOnly(
  current: DashboardSkillEvalSummary,
  next: DashboardSkillEvalSummary
): DashboardSkillEvalSummary {
  const updatedSkillByKey = new Map(
    next.skills.map((skill) => [dashboardSkillEvalKey(skill.skillName, skill.skillVersion), skill])
  )

  const merged = {
    ...current,
    generatedAt: next.generatedAt,
    evaluatedTraceCount: next.evaluatedTraceCount,
    sampledTraceCount: next.sampledTraceCount,
    statTraceLimit: next.statTraceLimit,
    recentTotal: next.recentTotal,
    recentPage: next.recentPage,
    recentPageSize: next.recentPageSize,
    skillPage: next.skillPage,
    skillPageSize: next.skillPageSize,
    recent: next.recent,
    skills: current.skills.map((skill) => {
      const updated = updatedSkillByKey.get(
        dashboardSkillEvalKey(skill.skillName, skill.skillVersion)
      )
      return updated ? { ...updated, statsPending: false, statsFailed: false } : skill
    })
  }
  return withSkillEvalDerivedTotals(merged)
}

function mergeSkillEvalSkillStats(
  current: DashboardSkillEvalSummary,
  next: DashboardSkillEvalSummary
): DashboardSkillEvalSummary {
  const updatedSkillByKey = new Map(
    next.skills.map((skill) => [dashboardSkillEvalKey(skill.skillName, skill.skillVersion), skill])
  )
  if (updatedSkillByKey.size === 0) return current

  const merged = {
    ...current,
    generatedAt: next.generatedAt,
    skills: current.skills.map((skill) => {
      const updated = updatedSkillByKey.get(
        dashboardSkillEvalKey(skill.skillName, skill.skillVersion)
      )
      return updated ? { ...updated, statsPending: false, statsFailed: false } : skill
    })
  }
  return withSkillEvalDerivedTotals(merged)
}

function markSkillEvalSkillStatsFailed(
  current: DashboardSkillEvalSummary,
  failedSkill: DashboardSkillEvalSkillSummary
): DashboardSkillEvalSummary {
  return {
    ...current,
    skills: current.skills.map((skill) =>
      dashboardSkillEvalKey(skill.skillName, skill.skillVersion) ===
      dashboardSkillEvalKey(failedSkill.skillName, failedSkill.skillVersion)
        ? { ...skill, statsPending: false, statsFailed: true }
        : skill
    )
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        await worker(items[currentIndex], currentIndex)
      }
    })
  )
}

async function loadSkillEvalSummarySafely(
  range: TimeRange,
  options: DashboardSkillEvalOptions = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    if (typeof window.api.dashboard.skillEvalSummary !== "function") {
      return { success: true, data: emptySkillEvalSummary() }
    }
    return await window.api.dashboard.skillEvalSummary(range, {
      limit: options.limit ?? 500,
      recentPage: options.recentPage ?? 1,
      recentPageSize: options.recentPageSize ?? SKILL_EVAL_RECENT_PAGE_SIZE,
      skillPage: options.skillPage ?? 1,
      skillPageSize: options.skillPageSize ?? SKILL_EVAL_SKILL_PAGE_SIZE,
      ...(options.skillSearch ? { skillSearch: options.skillSearch } : {}),
      ...(options.skillName ? { skillName: options.skillName } : {}),
      ...(options.skillVersion ? { skillVersion: options.skillVersion } : {}),
      ...(options.skillNames ? { skillNames: options.skillNames } : {}),
      ...(options.defaultRecentToLatestSkill ? { defaultRecentToLatestSkill: true } : {}),
      ...(options.recentOnly ? { recentOnly: true } : {}),
      ...(options.listOnly ? { listOnly: true } : {}),
      ...(options.statsOnly ? { statsOnly: true } : {})
    })
  } catch (error) {
    console.warn("[Dashboard] skillEvalSummary unavailable, using empty data:", error)
    return { success: true, data: emptySkillEvalSummary() }
  }
}

// ─────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────

export function useDashboard() {
  const [granularity, setGranularity] = useState<Granularity>("day")
  const [range, setRange] = useState<TimeRange>(() => getDefaultRange("day"))
  // 顶部「室筛选」支持多选 LV1 组织；空数组表示全部。
  const [selectedOrgLv1List, setSelectedOrgLv1List] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [userStatsLoading, setUserStatsLoading] = useState(false)
  const [skillEvalLoading, setSkillEvalLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [modelStats, setModelStats] = useState<ModelStatsData | null>(null)
  const [userStats, setUserStats] = useState<UserStatsData | null>(null)
  const [productivity, setProductivity] = useState<ProductivityData | null>(null)
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)
  const [skillEval, setSkillEval] = useState<DashboardSkillEvalSummary | null>(null)
  // 顶部全量组织（LV1）筛选可选项，随时间范围刷新。
  const [orgOptions, setOrgOptions] = useState<string[]>([])

  const fetchIdRef = useRef(0)
  const userStatsFetchIdRef = useRef(0)
  const skillEvalFetchIdRef = useRef(0)
  const orgOptionsFetchIdRef = useRef(0)

  const fetchAll = useCallback(async (r: TimeRange, g: Granularity, orgList: string[]) => {
    const id = ++fetchIdRef.current
    setLoading(true)
    setError(null)

    const orgOpts = { upperOrgLv1: orgList }
    try {
      const [ovRes, msRes, usRes, prRes, fbRes] = await Promise.all([
        window.api.dashboard.overview(r, g, orgOpts),
        window.api.dashboard.modelStats(r, g, orgOpts),
        window.api.dashboard.userStats(r, g, orgOpts),
        window.api.dashboard.productivity(r, g, orgOpts),
        window.api.dashboard.feedback(r, g, orgOpts)
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
      setProductivity(parseProductivity(prRes.data, g, r))
      // 仅选中单个组织时 userStats 进入 LV0 下钻视图，否则按 LV1 展示。
      setUserStats(parseUserStats(usRes.data, orgList.length === 1 ? orgList[0] : null))
      setFeedback(parseFeedback(fbRes.data, g))
    } catch (e) {
      if (id !== fetchIdRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (id === fetchIdRef.current) setLoading(false)
    }
  }, [])

  const fetchUserStatsOnly = useCallback(
    async (r: TimeRange, g: Granularity, orgLv1: string | null) => {
      const id = ++userStatsFetchIdRef.current
      setUserStatsLoading(true)
      setError(null)

      try {
        const result = await window.api.dashboard.userStats(r, g, { upperOrgLv1: orgLv1 })
        if (id !== userStatsFetchIdRef.current) return
        if (!result.success) throw new Error(result.error ?? "获取用户数据失败")
        setUserStats(parseUserStats(result.data, orgLv1))
      } catch (e) {
        if (id !== userStatsFetchIdRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === userStatsFetchIdRef.current) setUserStatsLoading(false)
      }
    },
    []
  )

  const fetchSkillEvalPage = useCallback(
    async (
      page: number,
      filter?: {
        skillName?: string
        skillVersion?: string
        skillNames?: string[]
        defaultRecentToLatestSkill?: boolean
        recentOnly?: boolean
        skillPage?: number
        skillSearch?: string
        listFirst?: boolean
        deferPageStats?: boolean
      }
    ) => {
      const id = ++skillEvalFetchIdRef.current
      setSkillEvalLoading(true)
      setError(null)

      try {
        const requestOptions: DashboardSkillEvalOptions = {
          recentPage: page,
          recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
          skillPage: filter?.skillPage ?? 1,
          skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE,
          ...(filter?.skillSearch ? { skillSearch: filter.skillSearch } : {}),
          ...(filter?.skillName ? { skillName: filter.skillName } : {}),
          ...(filter?.skillVersion ? { skillVersion: filter.skillVersion } : {}),
          ...(filter?.skillNames ? { skillNames: filter.skillNames } : {}),
          ...(filter?.defaultRecentToLatestSkill ? { defaultRecentToLatestSkill: true } : {}),
          ...(filter?.recentOnly ? { recentOnly: true } : {})
        }
        let listedSkillEval: DashboardSkillEvalSummary | null = null
        if (filter?.listFirst && !filter.skillName && !filter.recentOnly) {
          const listResult = await loadSkillEvalSummarySafely(range, {
            ...requestOptions,
            listOnly: true
          })
          if (id !== skillEvalFetchIdRef.current) return
          if (!listResult.success) throw new Error(listResult.error ?? "获取技能评估列表失败")
          const listSkillEval = parseSkillEvalSummary(listResult.data, {
            recentPage: page,
            recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
            skillPage: filter?.skillPage ?? 1,
            skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE
          })
          listedSkillEval = markSkillEvalStatsPending(listSkillEval)
          setSkillEval(listedSkillEval)
        }
        if (filter?.deferPageStats && listedSkillEval && !filter.skillName && !filter.recentOnly) {
          const selectedSkill = listedSkillEval.skills[0]
          if (!selectedSkill) {
            setSkillEvalLoading(false)
            return
          }
          const selectedFilter = skillEvalSummaryToFilter(selectedSkill)
          const selectedResult = await loadSkillEvalSummarySafely(range, {
            ...requestOptions,
            ...selectedFilter,
            recentOnly: true
          })
          if (id !== skillEvalFetchIdRef.current) return
          if (!selectedResult.success) {
            throw new Error(selectedResult.error ?? "获取当前技能评估数据失败")
          }
          const selectedSkillEval = parseSkillEvalSummary(selectedResult.data, {
            recentPage: page,
            recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
            skillPage: filter?.skillPage ?? 1,
            skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE
          })
          setSkillEval((current) =>
            current ? mergeSkillEvalRecentOnly(current, selectedSkillEval) : selectedSkillEval
          )
          // Close the blocking loading state once the list and selected skill are usable.
          // Remaining skills continue filling in through background requests.
          setSkillEvalLoading(false)

          const backgroundSkills = listedSkillEval.skills.slice(1)
          void runWithConcurrency(
            backgroundSkills,
            SKILL_EVAL_BACKGROUND_STATS_CONCURRENCY,
            async (skill) => {
              if (id !== skillEvalFetchIdRef.current) return
              const statsResult = await loadSkillEvalSummarySafely(range, {
                ...requestOptions,
                limit: SKILL_EVAL_BACKGROUND_STATS_LIMIT,
                ...skillEvalSummaryToFilter(skill),
                statsOnly: true
              })
              if (id !== skillEvalFetchIdRef.current) return
              if (!statsResult.success) {
                console.warn(
                  "[Dashboard] background skill stats failed:",
                  statsResult.error ?? skill.skillName
                )
                setSkillEval((current) =>
                  current ? markSkillEvalSkillStatsFailed(current, skill) : current
                )
                return
              }
              const statsSkillEval = parseSkillEvalSummary(statsResult.data, {
                recentPage: page,
                recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
                skillPage: filter?.skillPage ?? 1,
                skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE
              })
              if (statsSkillEval.skills.length === 0) {
                setSkillEval((current) =>
                  current ? markSkillEvalSkillStatsFailed(current, skill) : current
                )
                return
              }
              setSkillEval((current) =>
                current ? mergeSkillEvalSkillStats(current, statsSkillEval) : current
              )
            }
          )
          return
        }
        const result = await loadSkillEvalSummarySafely(range, requestOptions)
        if (id !== skillEvalFetchIdRef.current) return
        if (!result.success) throw new Error(result.error ?? "获取技能评估数据失败")
        const nextSkillEval = parseSkillEvalSummary(result.data, {
          recentPage: page,
          recentPageSize: SKILL_EVAL_RECENT_PAGE_SIZE,
          skillPage: filter?.skillPage ?? 1,
          skillPageSize: SKILL_EVAL_SKILL_PAGE_SIZE,
          ...(filter?.skillSearch ? { skillSearch: filter.skillSearch } : {})
        })
        setSkillEval((current) =>
          filter?.recentOnly && current
            ? mergeSkillEvalRecentOnly(current, nextSkillEval)
            : nextSkillEval
        )
      } catch (e) {
        if (id !== skillEvalFetchIdRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === skillEvalFetchIdRef.current) setSkillEvalLoading(false)
      }
    },
    [range]
  )

  // Auto-fetch on range / granularity / 室筛选 change
  useEffect(() => {
    fetchAll(range, granularity, selectedOrgLv1List)
  }, [range, granularity, selectedOrgLv1List, fetchAll])

  // 组织（LV1）可选项随时间范围刷新（与全量筛选解耦，始终返回全部 LV1）。
  useEffect(() => {
    const id = ++orgOptionsFetchIdRef.current
    void (async () => {
      try {
        const result = await window.api.dashboard.orgOptions(range)
        if (id !== orgOptionsFetchIdRef.current) return
        if (result.success) setOrgOptions(result.data ?? [])
      } catch {
        if (id === orgOptionsFetchIdRef.current) setOrgOptions([])
      }
    })()
  }, [range])

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
    const nextRange = getRefreshRange(range, granularity)
    if (nextRange.from !== range.from || nextRange.to !== range.to) {
      setRange(nextRange)
      return
    }
    fetchAll(range, granularity, selectedOrgLv1List)
  }, [fetchAll, range, granularity, selectedOrgLv1List])

  const clearSkillEval = useCallback(() => {
    ++skillEvalFetchIdRef.current
    setSkillEval(null)
    setSkillEvalLoading(false)
  }, [])

  // 室筛选（多选 LV1）：设置后由 effect 重新拉取所有面板数据。
  const setOrgFilter = useCallback((orgList: string[]) => {
    const normalized = Array.from(new Set(orgList.map((item) => item.trim()).filter(Boolean)))
    setSelectedOrgLv1List(normalized)
  }, [])

  // 用户分析面板内点击 LV1 柱状图下钻：切换室筛选为该单一组织，并刷新用户分析数据。
  const drillDownUserOrg = useCallback(
    (orgLv1: string) => {
      const normalizedOrgLv1 = orgLv1.trim()
      if (!normalizedOrgLv1) return
      setSelectedOrgLv1List([normalizedOrgLv1])
      fetchUserStatsOnly(range, granularity, normalizedOrgLv1)
    },
    [fetchUserStatsOnly, range, granularity]
  )


  const resetUserOrgDrilldown = useCallback(() => {
    setSelectedOrgLv1List([])
  }, [])

  return {
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
    changeGranularity,
    navigate,
    setCustomRange,
    setRange,
    refresh,
    fetchSkillEvalPage,
    clearSkillEval,
    setOrgFilter,
    drillDownUserOrg,
    resetUserOrgDrilldown
  }
}
