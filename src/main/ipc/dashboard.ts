/**
 * Dashboard IPC Handlers
 *
 * Proxies Elasticsearch queries for the operations dashboard.
 * The renderer never connects to ES directly — all queries go through
 * these IPC handlers for security.
 */

import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from "electron"
import { serialize } from "node:v8"
import { getUserInfo } from "../storage"
import { deriveUpperOrgLv1FromPath } from "../org-levels"
import * as fs from "fs"
import AdmZip from "adm-zip"
import { buildTraceTree } from "../agent/trace/tree-builder"
import {
  redactTraceDetailForDisplay,
  redactTraceSkillEvalRecordForDisplay
} from "../agent/trace/display-redaction"
import { TRACE_OBSERVABILITY_SCHEMA_VERSION } from "../agent/trace/types"
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
import { parsePluginSkillSourceRef } from "../utils/skill-source"
import {
  effectiveGeneratedLinesSumAgg,
  makeDashboardCodeStats,
  normalizeCodeStatsFromAggs,
  normalizeCodeStatsFromContainer,
  normalizeSkillCodeAdoptionBuckets,
  type DashboardCodeStats,
  type DashboardSkillCodeAdoptionStats
} from "./dashboard-code-stats"
import { countDevAssociatedFeatures, countDevStageConversations } from "./project-mode-metrics"
import {
  buildProjectModeOperationalAggs,
  parseProjectModeOperationalStats,
  type ProjectModeConstraintFileStat,
  type ProjectModeConstraintReadStats,
  type ProjectModeHookEventStat,
  type ProjectModeHookStats,
  type ProjectModeOperationalDetails,
  type ProjectModeOperationalStats
} from "./project-mode-operational-metrics"
import {
  buildChangeKindAggs,
  buildComputeEfficiency,
  buildNewRatioHistogramAgg,
  buildPendingScalability,
  computeUnmeasuredRatio,
  makeMockEfficiency,
  normalizeChangeKindBuckets,
  normalizeNewRatioHistogram,
  type DashboardEfficiencyData
} from "./dashboard-efficiency"
import {
  executeDashboardEsQuery,
  type DashboardEsIndexAlias,
  type DashboardEsQueryInput
} from "../services/dashboard-es-query"
import {
  runDashboardAnalysisAgent,
  type DashboardAnalysisAgentInput
} from "../services/dashboard-analysis-agent"
import {
  DASHBOARD_ES_FALLBACK_BYTE_LIMIT,
  DASHBOARD_ES_OUTPUT_BYTE_LIMIT,
  DASHBOARD_ES_RESPONSE_TOO_LARGE,
  DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS,
  DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_USER_DIRECTORY_MAX_ITEMS,
  DASHBOARD_USER_DIRECTORY_MAX_PAGES,
  DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT,
  DASHBOARD_USER_DIRECTORY_PAGE_SIZE,
  type DashboardEsProjection
} from "../services/dashboard-es-protocol"
import {
  isDashboardEsRequestCancelled,
  isDashboardEsWorkerUnavailable,
  queryDashboardEsInWorker
} from "../services/dashboard-es-client"
import {
  DashboardRequestCancelledError,
  DashboardRequestCoordinator,
  getDashboardRequestSignal,
  isDashboardRequestCancelled
} from "../services/dashboard-request-coordinator"
import { projectDashboardEsResponse } from "../services/dashboard-view-model-projection"
import {
  STAGE_BUCKET_LABELS,
  STAGE_DONE_LABEL,
  STAGE_IN_PROGRESS_LABEL,
  type StageBucket
} from "../../shared/harness-stage-bucket"
import { SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT } from "../services/system-constraint-read-reporter"
import type { ProjectMetricFilters, ProjectMetricListOptions } from "../../shared/project-metrics"
import {
  fetchProjectMetricProjects,
  fetchProjectMetricSummary,
  makeMockProjectMetricProjects,
  makeMockProjectMetricSummary
} from "./dashboard-project-metrics"

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

function getEsIndex(type: "trace" | "event" | "skillEval" | "projectFact"): string {
  if (type === "trace") return (import.meta.env.VITE_ES_INDEX_TRACE as string) || "devclaw_trace"
  if (type === "projectFact") {
    return (import.meta.env.VITE_ES_INDEX_PROJECT_INFO as string) || "devclaw_project_info"
  }
  if (type === "skillEval") {
    return (import.meta.env.VITE_ES_INDEX_SKILL_EVAL as string) || "devclaw_skill_eval_record"
  }
  return (import.meta.env.VITE_ES_INDEX_EVENT as string) || "devclaw_event"
}

// ─────────────────────────────────────────────────────────
// ES HTTP helper
// ─────────────────────────────────────────────────────────

let nodeIndex = 0
const dashboardRequestCoordinator = new DashboardRequestCoordinator()

function enforceDashboardIpcByteLimit<T>(label: string, value: T, byteLimit: number): T {
  if (serialize(value).byteLength <= byteLimit) return value
  const error = new Error(`${label} response exceeds the ${byteLimit} byte IPC limit`) as Error & {
    code?: string
  }
  error.code = DASHBOARD_ES_RESPONSE_TOO_LARGE
  throw error
}

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
  options?: {
    timeoutMs?: number
    outputByteLimit?: number
    projection?: DashboardEsProjection
  }
): Promise<unknown> {
  const nodes = getEsNodes()
  if (nodes.length === 0) throw new Error("ES_NODES not configured")

  const auth = getEsAuth()
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (auth) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  }

  // Round-robin is preserved, but response streaming, JSON parsing and recursive
  // normalization happen in the reusable Node worker. The worker also applies
  // input and output byte ceilings before the value can be cloned back to main.
  const startIdx = nodeIndex
  const orderedNodes = nodes.map((_, offset) => nodes[(startIdx + offset) % nodes.length])
  nodeIndex = (startIdx + 1) % nodes.length
  const signal = getDashboardRequestSignal()
  const path = `/${index}/_search`
  const bodyText = JSON.stringify(body)

  try {
    return await queryDashboardEsInWorker({
      nodes: orderedNodes,
      method: "POST",
      path,
      headers,
      bodyText,
      timeoutMs: options?.timeoutMs ?? 15_000,
      signal,
      outputByteLimit: options?.outputByteLimit,
      projection: options?.projection
    })
  } catch (error) {
    if (isDashboardEsRequestCancelled(error) || isDashboardRequestCancelled(error)) throw error
    if (!isDashboardEsWorkerUnavailable(error)) {
      throw makeEsUnavailableError(nodes, error instanceof Error ? error : new Error(String(error)))
    }

    // Packaging failures should not make a small dashboard query unusable. This
    // fallback is deliberately tiny so synchronous JSON.parse can never regain
    // the multi-megabyte main-process failure mode that the worker removes.
    console.warn("[Dashboard] ES worker unavailable; using bounded fallback:", error.message)
    const raw = await esQuerySmallFallback(
      orderedNodes,
      path,
      "POST",
      headers,
      bodyText,
      options?.timeoutMs ?? 15_000,
      signal
    )
    const value = options?.projection ? projectDashboardEsResponse(raw, options.projection) : raw
    const outputByteLimit = options?.outputByteLimit ?? DASHBOARD_ES_OUTPUT_BYTE_LIMIT
    if (serialize(value).byteLength > outputByteLimit) {
      const outputError = new Error(
        `Dashboard fallback response exceeds the ${outputByteLimit} byte limit`
      ) as Error & { code?: string }
      outputError.code = DASHBOARD_ES_RESPONSE_TOO_LARGE
      throw outputError
    }
    return value
  }
}

async function readBoundedFallbackBytes(
  response: Response,
  byteLimit: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    await response.body?.cancel().catch(() => undefined)
    const error = new Error(`Dashboard response exceeds the ${byteLimit} byte limit`) as Error & {
      code?: string
    }
    error.code = DASHBOARD_ES_RESPONSE_TOO_LARGE
    throw error
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DashboardRequestCancelledError()
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      totalBytes += value.byteLength
      if (totalBytes > byteLimit) {
        void reader.cancel().catch(() => undefined)
        const error = new Error(
          `Dashboard response exceeds the ${byteLimit} byte limit`
        ) as Error & { code?: string }
        error.code = DASHBOARD_ES_RESPONSE_TOO_LARGE
        throw error
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

async function esQuerySmallFallback(
  nodes: string[],
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  bodyText: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  let lastError: Error | null = null
  for (const node of nodes) {
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    const controller = new AbortController()
    const abort = (): void => controller.abort(new DashboardRequestCancelledError())
    signal?.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error("Dashboard ES request timed out")),
      timeoutMs
    )
    timeout.unref()
    try {
      const response = await fetch(`${node.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : bodyText,
        signal: controller.signal
      })
      if (!response.ok) {
        const bytes = await readBoundedFallbackBytes(response, 4 * 1024, signal).catch(
          () => new Uint8Array()
        )
        throw new Error(`ES ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 200)}`)
      }
      const bytes = await readBoundedFallbackBytes(
        response,
        DASHBOARD_ES_FALLBACK_BYTE_LIMIT,
        signal
      )
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch (error) {
      if (signal?.aborted) throw new DashboardRequestCancelledError()
      lastError = error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
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
  observabilitySchemaVersion?: number
  traceKind?: string
  executionMode?: string
  rootTraceId?: string
  rootThreadId?: string
  parentTraceId?: string
  parentThreadId?: string
  parentSpanId?: string
  linkType?: string
  subagentKind?: string
  subagentRunId?: string
  subagentThreadId?: string
  handoffAction?: string
  handoffSourceAgent?: string
  handoffTargetAgent?: string
  coordinatorWorkerId?: string
  coordinatorWorkerTurn?: number
  coordinatorWorkerRole?: string
  coordinatorWorkerWorkload?: string
  workflowRunId?: string
  workflowAgentIndex?: number
  workflowPhase?: string
  workflowAgentLabel?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  outcome: string
  totalToolCalls: number
  modelCallCount: number
  /** 本次 trace 中调用 request_user_input（向用户提问）的次数。 */
  userInputRequestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  /** 产生该 trace 的客户端 APP 版本。 */
  appVersion?: string
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
  /** 产生该 commit 代码的会话列表（优先取自采纳事件，可为多个）。 */
  threadIds: string[]
  usedSkills: string[]
  skillCount: number
  codeGeneratedLines: number
  codeEffectiveGeneratedLines: number
  codeAdoptedLines: number
  codeAdoptionRate: number | null
}

interface DashboardNonGitAdoptionReportItem {
  eventId: string
  eventTime: string
  generatedAt: string
  pushedAt?: string
  measuredAt?: string
  userName: string
  sapId?: string
  ystId?: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  userIp?: string
  source?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  genEventId?: string
  threadId?: string
  threadIds: string[]
  fileHint?: string
  tool?: string
  language?: string
  modelName?: string
  measureSource?: string
  verdict?: string
  pushed: boolean
  usedSkills: string[]
  generatedLineCount: number
  effectiveGeneratedLineCount: number
  adoptedLineCount: number
  adoptionRate: number | null
}

interface DashboardNonGitAdoptionReportsData {
  total: number
  page: number
  pageSize: number
  items: DashboardNonGitAdoptionReportItem[]
}

interface CommitAdoptionSummary {
  usedSkills: string[]
  generatedLines: number
  effectiveGeneratedLines: number
  adoptedLines: number
  adoptionRate: number | null
  /**
   * 产生该 commit 代码的会话 threadId 列表，取自 `code_adopt` 事件（即代码生成时
   * 所在的真实会话），而非 commit 事件自带的 threadId。一个 commit 的代码可能来自
   * 多个会话，这里保留全部。
   */
  threadIds: string[]
}

/**
 * 单条 commit 的采纳「溯源」：一行 = 一个 `code_adopt` 事件，并按 `genEventId`
 * 关联其 `code_gen` 元数据。gen 侧可能缺失（事件超出窗口/未上报）时为 null。
 */
interface CommitAdoptionEventPair {
  genEventId: string
  // gen 侧（云端 code_gen，仅元数据；缺失时为 null/空）
  file: string | null // gen.relativeHint（叶子文件名，云端不含完整路径）
  tool: string | null
  language: string | null
  usedSkills: string[]
  modelName: string | null
  generatedAt: string | null // gen.createdAt
  // adopt 侧（code_adopt）
  verdict: string | null
  /** 仅 verdict=superseded 时有值：作废原因（same_path_rewrite | agent_rm），供溯源展示。 */
  reason: string | null
  generatedLineCount: number | null
  effectiveGeneratedLineCount: number | null
  adoptedLineCount: number | null
  measureSource: string | null
  pushed: boolean
  measuredAt: string | null
  threadId: string | null
}

interface CommitAdoptionEvents {
  commitSha: string
  pairs: CommitAdoptionEventPair[]
  /**
   * 对账：sum 口径与面板 `fetchCommitAdoptionMap` 一致（仅累加三项行数齐全的 adopt
   * 行），故 `rate` 与面板该 commit 采纳率构造上一致。
   */
  reconciliation: {
    sumEffective: number
    sumAdopted: number
    rate: number | null
  }
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
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  codeStats: DashboardCodeStats | null
}

interface DashboardUserListData {
  items: DashboardUserListItem[]
  pageSize: number
  nextAfterKey?: Record<string, string | number>
  totalActiveUsers: number
}

// ── 评奖辅助看板 ───────────────────────────────────────────────
/**
 * 技能贡献奖候选（逐 Skill）：跨室使用数 + 整体 AI 代码入库率。
 * 由前端传入「个人构建」的 skill 名称集（取自应用市场 featured=个人），
 * 后端按名称（含所有版本）聚合，结果按 skillKey 回传，前端再挂构建者等展示字段。
 */
interface DashboardAwardSkillContribution {
  /** 归一化技能名（与传入名一致），供前端 join 市场展示字段。 */
  skillKey: string
  /** 使用过该技能的去重室（upperOrgLv1）数；评分标准①「跨 ≥2 室」。 */
  crossOrgCount: number
  /** 使用过该技能的去重用户数。 */
  userCount: number
  /** 该技能的调用（trace）数。 */
  callCount: number
  /** 该技能命中代码的整体入库统计（含 inclusivePushedAdoptionRate）。 */
  codeStats: DashboardCodeStats | null
}

/**
 * 技能应用奖榜（逐个人）：深度使用指标 + 个人 AI 代码入库率。
 * 不自动排名，前端各列可点排序。
 */
interface DashboardAwardUserApplication {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  /** 调用（trace）数。 */
  callCount: number
  /** 用过的去重技能种类数（cardinality of usedSkills）。 */
  skillCount: number
  /** 用技能的总次数（value_count of usedSkills，含同技能重复）。 */
  skillUsageCount: number
  /** 工具调用总数。 */
  toolCallCount: number
  /** 去重会话（threadId）数。 */
  threadCount: number
  /** 去重特性（harnessFeatureSlug）数。 */
  featureCount: number
  /** 个人入库统计（含 inclusivePushedAdoptionRate）。 */
  codeStats: DashboardCodeStats | null
}

/**
 * 团队标杆奖一行（室级或其下组级）：使用深度 + 代码产出，按 室(upperOrgLv1) → 组(upperOrgLv0) 两级。
 * 贡献技能数 / 技能试用覆盖室数依赖应用市场作者归属（ES 无该维度），由前端补，不在此结构。
 */
interface DashboardAwardTeamBenchmarkRow {
  /** 室（upperOrgLv1）。 */
  shi: string
  /** 组（upperOrgLv0）；室级行为空。 */
  group?: string
  /** 使用次数（trace 数）。 */
  usageCount: number
  /** 去重用户数。 */
  userCount: number
  /** 本行（室/组）人均使用次数 = usageCount / userCount。 */
  perCapitaUsage: number
  /** 总量人均使用次数（全员基线 = 总使用次数 / 总去重用户），每行相同。 */
  totalPerCapitaUsage: number
  /** 本行内使用次数超过「本行人均」的用户数。 */
  aboveAvgUserCount: number
  /** 技能使用次数（value_count usedSkills，含重复）。 */
  skillUsageCount: number
  /** 去重技能种类数（cardinality usedSkills）。 */
  distinctSkillsUsed: number
  /** 代码统计：代码提交量取 adoptedLines，提交率取 measuredAdoptionRate。 */
  codeStats: DashboardCodeStats | null
  /** 组级细分（仅室级行携带）。 */
  children?: DashboardAwardTeamBenchmarkRow[]
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
  /** 当前时间范围内该用户的代码生成、Commit 采纳与 Push 入库统计。 */
  codeStats: DashboardCodeStats | null
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
  // 仅统计绑定了企业（精益）项目的项目（snapshot.properties.projectFromLean === true）。
  // 全局开关；缺省/false 表示不筛选。
  fromLeanOnly?: boolean | null
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
  // 仅统计项目模式（存在 harnessProjectId）下的 trace，用于「项目运营概览」入口。
  projectMode?: boolean
}

// ── 「全部生成」漏斗首层下钻：生成但未提交分析 ────────────────────────
// 口径：code_gen 行数（Agent 生成）对比 code_adopt 已测量行数（最终进 commit 的有效生成）。
// 二者差额 = 「生成了但没进 commit」的近似量。方案 A 按用户聚合做榜单；方案 B 对
// 选中用户用 genEventId anti-join 精确定位其未提交的那批生成，并按 tool/语言/项目/会话
// 归类，作为「为什么没提交」的证据。
interface UncommittedScopeOptions {
  upperOrgLv1?: string | string[] | null
  /** 仅统计项目模式（带 properties.harnessProjectId）的生成。 */
  projectMode?: boolean
  /** 收窄到单个项目模式项目。 */
  projectId?: string | null
  /** 收窄到单个项目特性。 */
  featureSlug?: string | null
  /** 仅统计由 Skill 生成的代码（properties.usedSkills 非空），对应「插件约束生成」漏斗。 */
  usedSkillsOnly?: boolean
  /** 上报来源（properties.source）收窄：null/空=全部来源；原生哨兵=仅无 source 事件；其余=该 source。 */
  source?: string | null
  /** 榜单内按用户姓名 / sapId / ystId 查询。 */
  userKeyword?: string | null
}

interface UncommittedRankingItem {
  sapId: string
  ystId?: string
  userName: string
  orgName?: string
  upperOrgLv0?: string
  upperOrgLv1?: string
  /** code_gen 生成行数（lineCount 求和）。 */
  generatedLines: number
  /** code_adopt 已测量的原始生成行数（generatedLineCount 求和），与漏斗「已 Commit」同口径。 */
  measuredGeneratedLines: number
  /** 生成但未进 commit 的行数 = max(0, generated − measured)，等于漏斗 unmeasuredGeneratedLines。 */
  uncommittedLines: number
  /** uncommittedLines / generatedLines。 */
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
  /** 实际扫描到的 code_gen 数（受 scanCap 限制时为采样）。 */
  scannedGens: number
  /** 扫描是否被 scanCap 截断（true 表示明细基于「最近 N 次生成」的采样）。 */
  scanCapped: boolean
  uncommittedGens: number
  uncommittedLines: number
  byTool: UncommittedDetailBreakdown[]
  byLanguage: UncommittedDetailBreakdown[]
  byProject: UncommittedDetailBreakdown[]
  byThread: UncommittedDetailBreakdown[]
  samples: UncommittedDetailSample[]
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

interface DashboardUserTraceExportPayload {
  sapId: string
  ystId?: string
  userName: string
  range: TimeRange
  page: number
  pageSize: number
  totalItems: number
  viewMode: TraceViewMode
  triggerScope: TraceTriggerScope
  projectMode: boolean
  traces: DashboardTraceDetail[]
}

interface DashboardThreadTraceExport {
  threadId: string
  traces: DashboardTraceDetail[]
}

interface CommitDetailsOptions {
  page?: number
  pageSize?: number
  pushedOnly?: boolean
  upperOrgLv1?: string | null
  userKeyword?: string | null
  // 全局「室筛选」（多选 LV1，含「未归类」哨兵），与弹窗内部门搜索 AND 叠加。
  orgLv1List?: string[]
}

interface NonGitAdoptionReportsOptions {
  page?: number
  pageSize?: number
  upperOrgLv1?: string | null
  userKeyword?: string | null
  orgLv1List?: string[]
  projectMode?: boolean
  projectId?: string | null
  featureSlug?: string | null
  usedSkillsOnly?: boolean
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
  upperOrgLv1?: string | string[] | null
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
const TRACE_EVOLVER_REVIEW_ADMIN_IDS_ENV = "VITE_TRACE_EVOLVER_REVIEW_ADMIN_YST_IDS"
const DASHBOARD_AWARDS_ADMIN_IDS_ENV = "VITE_DASHBOARD_AWARDS_ADMIN_YST_IDS"
const DASHBOARD_SUSPECTED_TECHNICAL_DETAIL_IDS_ENV =
  "VITE_DASHBOARD_SUSPECTED_TECHNICAL_DETAIL_YST_IDS"
// 评奖辅助看板当前仅开放给这四个 ystId；env 可覆盖，留空则回退到此默认名单，
// 保证即使未配置环境变量也严格只对这四人可见。
const DASHBOARD_AWARDS_ADMIN_DEFAULT_IDS = "383331,280631,231855,231858"
const DASHBOARD_SKILL_EVAL_IDS_ENV = "VITE_DASHBOARD_SKILL_EVAL_YST_IDS"
// 技能评估 tab 白名单；env 可覆盖，留空则回退到此默认名单。
const DASHBOARD_SKILL_EVAL_DEFAULT_IDS = "383331"

function splitEnvIds(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(/[,\n;\s]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  )
}

function getDashboardUnrestrictedIds(): Set<string> {
  return splitEnvIds(import.meta.env[DASHBOARD_UNRESTRICTED_IDS_ENV] as string | undefined)
}

function getDashboardAllowedIds(): Set<string> {
  return splitEnvIds(import.meta.env[DASHBOARD_ALLOWED_IDS_ENV] as string | undefined)
}

function getTraceEvolverReviewAdminIds(): Set<string> {
  return splitEnvIds(import.meta.env[TRACE_EVOLVER_REVIEW_ADMIN_IDS_ENV] as string | undefined)
}

function getDashboardAwardsAdminIds(): Set<string> {
  const configured = String(
    (import.meta.env[DASHBOARD_AWARDS_ADMIN_IDS_ENV] as string | undefined) || ""
  ).trim()
  return splitEnvIds(configured || DASHBOARD_AWARDS_ADMIN_DEFAULT_IDS)
}

function getDashboardSkillEvalAllowedIds(): Set<string> {
  const configured = String(
    (import.meta.env[DASHBOARD_SKILL_EVAL_IDS_ENV] as string | undefined) || ""
  ).trim()
  return splitEnvIds(configured || DASHBOARD_SKILL_EVAL_DEFAULT_IDS)
}

function getDashboardSuspectedTechnicalDetailAllowedIds(): Set<string> {
  return splitEnvIds(
    import.meta.env[DASHBOARD_SUSPECTED_TECHNICAL_DETAIL_IDS_ENV] as string | undefined
  )
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
    upperOrgLv1: deriveUpperOrgLv1FromPath(userInfo?.pathName)
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
  return access.loggedIn
}

function isDashboardProjectModeAdmin(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  if (!access.loggedIn || !access.ystId) return false
  return getDashboardAllowedIds().has(access.ystId)
}

function requireDashboardProjectModeAccess(): DashboardAccessContext {
  const access = getDashboardAccessContext()
  if (!access.loggedIn) throw new Error("请先登录后再查看项目运营面板")
  return access
}

/** Project-list heuristic metric gate; production access comes only from encrypted .env. */
function isDashboardSuspectedTechnicalDetailAllowed(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  if (!access.loggedIn || !access.ystId) return false
  return getDashboardSuspectedTechnicalDetailAllowedIds().has(access.ystId)
}

// 评奖辅助看板（技能贡献奖 / 技能应用奖）的访问门禁：仅 DASHBOARD_AWARDS_ADMIN
// 名单内的 ystId 可见（默认仅四人）。DEV 直接放行便于本地预览。
function isDashboardAwardsAdmin(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  if (!access.loggedIn || !access.ystId) return false
  return getDashboardAwardsAdminIds().has(access.ystId)
}

function requireDashboardAwardsAccess(): DashboardAccessContext {
  const access = getDashboardAccessContext()
  if (import.meta.env.DEV) return access
  if (!access.loggedIn) throw new Error("请先登录后再查看评奖辅助看板")
  if (!access.ystId || !getDashboardAwardsAdminIds().has(access.ystId)) {
    throw new Error("无评奖辅助看板访问权限")
  }
  return access
}

// 技能评估 tab 的访问门禁：仅 DASHBOARD_SKILL_EVAL 白名单内的 ystId 可见。
// DEV 直接放行便于本地预览。
function isDashboardSkillEvalAllowed(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  if (!access.loggedIn || !access.ystId) return false
  return getDashboardSkillEvalAllowedIds().has(access.ystId)
}

function isDashboardAnalysisAgentAllowed(): boolean {
  return isTraceEvolverReviewAdmin()
}

function isTraceEvolverReviewAdmin(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  if (!access.loggedIn || !access.ystId) return false
  return getTraceEvolverReviewAdminIds().has(access.ystId)
}

function requireDashboardAnalysisAgentAccess(): void {
  const access = getDashboardAccessContext()
  if (!access.loggedIn) throw new Error("请先登录后再使用运营指标分析 Agent")
  if (!access.ystId || !getTraceEvolverReviewAdminIds().has(access.ystId)) {
    throw new Error("无运营指标分析 Agent 使用权限")
  }
}

// 「生成但未提交分析」（漏斗首层下钻）的访问门槛：
// - 管理员（VITE_TRACE_EVOLVER_REVIEW_ADMIN_YST_IDS）：可看全部数据；
// - 非管理员但在 VITE_DASHBOARD_UNRESTRICTED_YST_IDS 名单内：可看与自己 upperOrgLv1 相同的数据；
// - 其他普通登录用户：仅可看自己的数据。
interface UncommittedAnalysisAccess {
  admin: boolean
  selfOnly: boolean
  sapId: string
  ystId: string
  upperOrgLv1: string
}

function isDashboardUncommittedAnalysisAllowed(
  access: DashboardAccessContext = getDashboardAccessContext()
): boolean {
  if (import.meta.env.DEV) return true
  return access.loggedIn
}

function requireDashboardUncommittedAnalysisAccess(): UncommittedAnalysisAccess {
  const access = getDashboardAccessContext()
  if (import.meta.env.DEV) {
    return { admin: true, selfOnly: false, sapId: "dev", ystId: "dev", upperOrgLv1: "" }
  }
  if (!access.loggedIn) throw new Error("请先登录后再查看生成但未提交分析")
  const admin = Boolean(access.ystId) && getTraceEvolverReviewAdminIds().has(access.ystId)
  if (admin) {
    return {
      admin: true,
      selfOnly: false,
      sapId: access.sapId,
      ystId: access.ystId,
      upperOrgLv1: access.upperOrgLv1
    }
  }
  if (access.unrestricted && access.upperOrgLv1) {
    return {
      admin: false,
      selfOnly: false,
      sapId: access.sapId,
      ystId: access.ystId,
      upperOrgLv1: access.upperOrgLv1
    }
  }
  return {
    admin: false,
    selfOnly: true,
    sapId: access.sapId,
    ystId: access.ystId,
    upperOrgLv1: access.upperOrgLv1
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

function buildProjectModeAccessFilter(
  access: DashboardAccessContext
): Record<string, unknown> | null {
  if (isDashboardProjectModeAdmin(access)) return null
  if (!access.upperOrgLv1) return buildNoAccessFilter()
  return buildUpperOrgLv1Filter(access.upperOrgLv1)
}

function buildProjectModeOrgFilter(
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Record<string, unknown> | null {
  const filters: Record<string, unknown>[] = []
  appendOptionalFilter(filters, buildProjectModeAccessFilter(access))
  appendOptionalFilter(
    filters,
    buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  )
  if (filters.length === 0) return null
  if (filters.length === 1) return filters[0]
  return { bool: { filter: filters } }
}

function projectMetricAllowedRoomNames(access: DashboardAccessContext): string[] | null {
  if (isDashboardProjectModeAdmin(access)) return null
  const roomName = access.upperOrgLv1.trim()
  return roomName ? [roomName] : []
}

function getDashboardEsIndexByAlias(): Record<DashboardEsIndexAlias, string> {
  return {
    event: getEsIndex("event"),
    trace: getEsIndex("trace")
  }
}

function dashboardEsField(indexAlias: DashboardEsIndexAlias, field: string): string {
  return indexAlias === "event" ? `properties.${field}` : field
}

function buildDashboardEsQueryFilters(
  input: DashboardEsQueryInput,
  access: DashboardAccessContext
): Record<string, unknown>[] {
  const filters: Record<string, unknown>[] = []
  const projectId = input.context?.projectId?.trim() ?? ""
  const featureSlug = input.context?.featureSlug?.trim() ?? ""
  const projectScoped = input.context?.scope === "project" || Boolean(projectId || featureSlug)
  appendOptionalFilter(
    filters,
    projectScoped ? buildProjectModeAccessFilter(access) : buildTraceAccessFilter(access)
  )
  appendOptionalFilter(
    filters,
    buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(input.context?.upperOrgLv1))
  )

  if (projectScoped) {
    requireDashboardProjectModeAccess()
    const projectField = dashboardEsField(input.indexAlias, "harnessProjectId")
    const featureField = dashboardEsField(input.indexAlias, "harnessFeatureSlug")
    filters.push(
      projectId ? { term: { [projectField]: projectId } } : { exists: { field: projectField } }
    )
    if (featureSlug) filters.push({ term: { [featureField]: featureSlug } })
  }

  return filters
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
  const withoutControlCharacters = Array.from(value.trim(), (character) =>
    character.charCodeAt(0) <= 0x1f ? "-" : character
  ).join("")
  const cleaned = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/g, "-")
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

function appendTraceExportMarkdown(
  lines: string[],
  trace: DashboardTraceDetail,
  traceHeadingLevel = 2
): void {
  const traceHeading = "#".repeat(traceHeadingLevel)
  const sectionHeading = "#".repeat(traceHeadingLevel + 1)
  const nodeHeading = "#".repeat(traceHeadingLevel + 2)

  lines.push(`${traceHeading} Trace ${escapeMarkdown(trace.traceId || "-")}`, "")
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
    lines.push(`${sectionHeading} User Message`, "", trace.userMessage.trim(), "")
  }

  if (trace.nodes && trace.nodes.length > 0) {
    lines.push(`${sectionHeading} Trace Nodes`, "")
    for (const node of trace.nodes) {
      lines.push(
        `${nodeHeading} ${escapeMarkdown(node.type)} · ${escapeMarkdown(node.name || node.id)}`,
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
    lines.push(
      `${sectionHeading} Trace Summary`,
      "",
      "```json",
      stringifyExportValue(trace),
      "```",
      ""
    )
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
    appendTraceExportMarkdown(lines, trace)
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function traceExportThreadId(trace: DashboardTraceDetail): string {
  return trace.rootThreadId || trace.threadId || "unknown-thread"
}

function groupTraceExportThreads(traces: DashboardTraceDetail[]): DashboardThreadTraceExport[] {
  const grouped = new Map<string, DashboardTraceDetail[]>()
  for (const trace of traces) {
    const threadId = traceExportThreadId(trace)
    const threadTraces = grouped.get(threadId) ?? []
    threadTraces.push(trace)
    grouped.set(threadId, threadTraces)
  }
  return Array.from(grouped, ([threadId, threadTraces]) => ({ threadId, traces: threadTraces }))
}

function formatUserTraceExportMarkdown(
  payload: DashboardUserTraceExportPayload,
  exportedAt: string
): string {
  const viewLabel = payload.viewMode === "thread" ? "Thread" : "Trace"
  const totalLabel = payload.viewMode === "thread" ? "Threads" : "Traces"
  const lines: string[] = [
    `# 用户 ${viewLabel} 历史 · ${escapeMarkdown(payload.userName || payload.sapId)}`,
    "",
    `- User: ${escapeMarkdown(payload.userName || "-")}`,
    `- SAP ID: \`${escapeMarkdown(payload.sapId)}\``,
    ...(payload.ystId ? [`- YST ID: \`${escapeMarkdown(payload.ystId)}\``] : []),
    `- Range: ${payload.range.from} 至 ${payload.range.to}`,
    `- View Mode: ${viewLabel}`,
    `- Trigger Scope: ${payload.triggerScope}`,
    `- Project Mode: ${payload.projectMode ? "yes" : "no"}`,
    `- Page: ${payload.page}`,
    `- Page Size: ${payload.pageSize}`,
    `- Total ${totalLabel}: ${payload.totalItems}`,
    `- Exported: ${exportedAt}`,
    ""
  ]

  if (payload.viewMode === "thread") {
    for (const thread of groupTraceExportThreads(payload.traces)) {
      lines.push(`## Thread ${escapeMarkdown(thread.threadId)}`, "")
      for (const trace of thread.traces) {
        appendTraceExportMarkdown(lines, trace, 3)
      }
    }
  } else {
    for (const trace of payload.traces) {
      appendTraceExportMarkdown(lines, trace)
    }
  }

  return `${lines.join("\n").trimEnd()}\n`
}

function normalizeTraceExportPayload(value: unknown): DashboardTraceExportPayload {
  const payload = asRecord(value)
  const skill = asString(payload.skill).trim()
  const range = asRecord(payload.range)
  const traces = Array.isArray(payload.traces)
    ? payload.traces.map((trace) => redactTraceDetailForDisplay(trace as DashboardTraceDetail))
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

function normalizeUserTraceExportPayload(value: unknown): DashboardUserTraceExportPayload {
  const payload = asRecord(value)
  const range = asRecord(payload.range)
  const viewMode = normalizeTraceViewMode(payload.viewMode)
  const traces = Array.isArray(payload.traces)
    ? payload.traces.map((trace) => redactTraceDetailForDisplay(trace as DashboardTraceDetail))
    : []

  return {
    sapId: asString(payload.sapId).trim(),
    ystId: asOptionalString(payload.ystId)?.trim() || undefined,
    userName: asString(payload.userName).trim(),
    range: {
      from: asString(range.from),
      to: asString(range.to)
    },
    page: clampLimit(typeof payload.page === "number" ? payload.page : undefined, 1, 1000),
    pageSize: clampLimit(
      typeof payload.pageSize === "number" ? payload.pageSize : undefined,
      10,
      50
    ),
    totalItems: asNumber(
      payload.totalItems,
      viewMode === "thread" ? groupTraceExportThreads(traces).length : traces.length
    ),
    viewMode,
    triggerScope: normalizeTraceTriggerScope(payload.triggerScope),
    projectMode: payload.projectMode === true,
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

function buildVersionedSkillUsagePrefixFilter(skillName: string): Record<string, unknown> {
  const versionPrefix = buildVersionPrefix(skillName)
  return {
    bool: {
      should: [
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

/**
 * code 事件侧（`properties.usedSkills`）的技能命中过滤，匹配裸名或 `name-v*` 全部版本，
 * 与 trace 侧 buildSkillUsageWildcardFilter 同口径，用于评奖看板按技能聚合入库率。
 */
function buildEventSkillUsageWildcardFilter(skillName: string): Record<string, unknown> {
  const versionPrefix = buildVersionPrefix(skillName)
  return {
    bool: {
      should: [
        { term: { "properties.usedSkills": skillName } },
        { term: { "properties.usedSkills.keyword": skillName } },
        { prefix: { "properties.usedSkills": versionPrefix } },
        { prefix: { "properties.usedSkills.keyword": versionPrefix } }
      ],
      minimum_should_match: 1
    }
  }
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
      userKeyword: null,
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
    userKeyword: normalizeCommitUserKeyword(value?.userKeyword),
    orgLv1List: normalizeUpperOrgLv1List(value?.orgLv1List)
  }
}

function normalizeNonGitAdoptionReportsOptions(
  value?: NonGitAdoptionReportsOptions
): Required<NonGitAdoptionReportsOptions> {
  return {
    page: clampLimit(value?.page, 1, 10_000),
    pageSize: clampLimit(value?.pageSize, 20, 100),
    upperOrgLv1: normalizeUpperOrgLv1Option(value?.upperOrgLv1),
    userKeyword: normalizeCommitUserKeyword(value?.userKeyword),
    orgLv1List: normalizeUpperOrgLv1List(value?.orgLv1List),
    projectMode: value?.projectMode === true,
    projectId: typeof value?.projectId === "string" ? value.projectId.trim() : null,
    featureSlug: typeof value?.featureSlug === "string" ? value.featureSlug.trim() : null,
    usedSkillsOnly: value?.usedSkillsOnly === true
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
  upperOrgLv1List: string[]
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
    upperOrgLv1List: normalizeUpperOrgLv1List(value?.upperOrgLv1),
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

function asOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = asNumber(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function traceObservabilityDetailFields(
  trace: Partial<AgentTrace> | undefined,
  source: Record<string, unknown> = {}
): Partial<DashboardTraceDetail> {
  const field = <K extends keyof AgentTrace>(key: K): unknown =>
    trace?.[key] ?? source[key as string]
  const result: Partial<DashboardTraceDetail> = {}
  const observabilitySchemaVersion = asOptionalNumber(field("observabilitySchemaVersion"))
  if (observabilitySchemaVersion !== undefined) {
    result.observabilitySchemaVersion = observabilitySchemaVersion
  }

  const stringFields: Array<[keyof DashboardTraceDetail, keyof AgentTrace]> = [
    ["traceKind", "traceKind"],
    ["executionMode", "executionMode"],
    ["rootTraceId", "rootTraceId"],
    ["rootThreadId", "rootThreadId"],
    ["parentTraceId", "parentTraceId"],
    ["parentThreadId", "parentThreadId"],
    ["parentSpanId", "parentSpanId"],
    ["linkType", "linkType"],
    ["subagentKind", "subagentKind"],
    ["subagentRunId", "subagentRunId"],
    ["subagentThreadId", "subagentThreadId"],
    ["handoffAction", "handoffAction"],
    ["handoffSourceAgent", "handoffSourceAgent"],
    ["handoffTargetAgent", "handoffTargetAgent"],
    ["coordinatorWorkerId", "coordinatorWorkerId"],
    ["coordinatorWorkerRole", "coordinatorWorkerRole"],
    ["coordinatorWorkerWorkload", "coordinatorWorkerWorkload"],
    ["workflowRunId", "workflowRunId"],
    ["workflowPhase", "workflowPhase"],
    ["workflowAgentLabel", "workflowAgentLabel"],
    ["harnessProjectId", "harnessProjectId"],
    ["harnessFeatureSlug", "harnessFeatureSlug"],
    ["harnessNodeName", "harnessNodeName"],
    ["harnessNodeStatus", "harnessNodeStatus"]
  ]
  for (const [outKey, inKey] of stringFields) {
    const value = asOptionalString(field(inKey))
    if (value) (result as Record<string, unknown>)[outKey] = value
  }

  const coordinatorWorkerTurn = asOptionalNumber(field("coordinatorWorkerTurn"))
  if (coordinatorWorkerTurn !== undefined) result.coordinatorWorkerTurn = coordinatorWorkerTurn
  const workflowAgentIndex = asOptionalNumber(field("workflowAgentIndex"))
  if (workflowAgentIndex !== undefined) result.workflowAgentIndex = workflowAgentIndex
  return result
}

interface PluginSkillSourceBucket {
  id: string
  sourceRef: string
  skill: string
  pluginName: string
  count: number
}

function pluginSkillSourceId(pluginId: string, skill: string): string {
  return `plugin:${encodeURIComponent(pluginId)}/${encodeURIComponent(skill)}`
}

function parsePluginSkillSourceBuckets(raw: unknown): PluginSkillSourceBucket[] {
  const result = new Map<string, PluginSkillSourceBucket>()
  if (!Array.isArray(raw)) return []
  for (const bucket of raw) {
    const record = asRecord(bucket)
    const sourceRef = asString(record.key)
    const parsed = parsePluginSkillSourceRef(sourceRef)
    if (!parsed?.skill || !parsed.pluginId) continue
    const id = pluginSkillSourceId(parsed.pluginId, parsed.skill)
    const count = asNumber(record.doc_count)
    const existing = result.get(id)
    if (existing) {
      existing.count += count
    } else {
      result.set(id, {
        id,
        sourceRef,
        skill: parsed.skill,
        pluginName: parsed.pluginName || parsed.pluginId,
        count
      })
    }
  }
  return Array.from(result.values())
}

function subtractPluginSkillCountsBySkill(
  sourceBuckets: PluginSkillSourceBucket[]
): Map<string, number> {
  const result = new Map<string, number>()
  for (const bucket of sourceBuckets) {
    result.set(bucket.skill, (result.get(bucket.skill) ?? 0) + bucket.count)
  }
  return result
}

function combineSkillCountBuckets(
  usedSkillBuckets: unknown,
  sourceBucketsRaw: unknown,
  limit = Number.POSITIVE_INFINITY
): ProjectModeSkillCount[] {
  const pluginBuckets = parsePluginSkillSourceBuckets(sourceBucketsRaw)
  const pluginCountsBySkill = subtractPluginSkillCountsBySkill(pluginBuckets)
  const result: ProjectModeSkillCount[] = pluginBuckets.map((bucket) => ({
    id: bucket.id,
    sourceRef: bucket.sourceRef,
    skill: bucket.skill,
    count: bucket.count,
    isPlugin: true,
    pluginName: bucket.pluginName
  }))

  if (Array.isArray(usedSkillBuckets)) {
    for (const bucket of usedSkillBuckets) {
      const b = asRecord(bucket)
      const skill = asString(b.key)
      if (!skill) continue
      const count = Math.max(0, asNumber(b.doc_count) - (pluginCountsBySkill.get(skill) ?? 0))
      if (count > 0) result.push({ id: skill, skill, count })
    }
  }

  result.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill, "zh-CN"))
  return result.slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : result.length)
}

function subtractSkillCodeStats(
  item: DashboardSkillCodeAdoptionStats,
  subtract: DashboardSkillCodeAdoptionStats
): DashboardSkillCodeAdoptionStats {
  return {
    ...makeDashboardCodeStats({
      generatedLines: item.generatedLines - subtract.generatedLines,
      deletedLines: item.deletedLines - subtract.deletedLines,
      measuredGeneratedLines: item.measuredGeneratedLines - subtract.measuredGeneratedLines,
      effectiveGeneratedLines: item.effectiveGeneratedLines - subtract.effectiveGeneratedLines,
      adoptedLines: item.adoptedLines - subtract.adoptedLines,
      pushedMeasuredGeneratedLines:
        item.pushedMeasuredGeneratedLines - subtract.pushedMeasuredGeneratedLines,
      pushedEffectiveGeneratedLines:
        item.pushedEffectiveGeneratedLines - subtract.pushedEffectiveGeneratedLines,
      pushedAdoptedLines: item.pushedAdoptedLines - subtract.pushedAdoptedLines,
      pushedCommitCount: item.pushedCommitCount - subtract.pushedCommitCount
    }),
    id: item.id ?? item.skill,
    skill: item.skill,
    commitCount: Math.max(0, item.commitCount - subtract.commitCount)
  }
}

function addSkillCodeStats(
  item: DashboardSkillCodeAdoptionStats,
  add: DashboardSkillCodeAdoptionStats
): DashboardSkillCodeAdoptionStats {
  return {
    ...makeDashboardCodeStats({
      generatedLines: item.generatedLines + add.generatedLines,
      deletedLines: item.deletedLines + add.deletedLines,
      measuredGeneratedLines: item.measuredGeneratedLines + add.measuredGeneratedLines,
      effectiveGeneratedLines: item.effectiveGeneratedLines + add.effectiveGeneratedLines,
      adoptedLines: item.adoptedLines + add.adoptedLines,
      pushedMeasuredGeneratedLines:
        item.pushedMeasuredGeneratedLines + add.pushedMeasuredGeneratedLines,
      pushedEffectiveGeneratedLines:
        item.pushedEffectiveGeneratedLines + add.pushedEffectiveGeneratedLines,
      pushedAdoptedLines: item.pushedAdoptedLines + add.pushedAdoptedLines,
      pushedCommitCount: item.pushedCommitCount + add.pushedCommitCount
    }),
    id: item.id ?? item.skill,
    skill: item.skill,
    commitCount: item.commitCount + add.commitCount
  }
}

function hasPositiveCodeStats(item: DashboardSkillCodeAdoptionStats): boolean {
  return (
    item.generatedLines > 0 ||
    item.effectiveGeneratedLines > 0 ||
    item.adoptedLines > 0 ||
    item.pushedAdoptedLines > 0 ||
    item.commitCount > 0 ||
    item.pushedCommitCount > 0
  )
}

function combineSkillCodeAdoptionStats(
  usedSkillItems: DashboardSkillCodeAdoptionStats[],
  sourceItems: DashboardSkillCodeAdoptionStats[]
): DashboardSkillCodeAdoptionStats[] {
  const pluginItems = new Map<string, DashboardSkillCodeAdoptionStats>()
  const pluginStatsBySkill = new Map<string, DashboardSkillCodeAdoptionStats>()

  for (const sourceItem of sourceItems) {
    const parsed = parsePluginSkillSourceRef(sourceItem.skill)
    if (!parsed?.skill || !parsed.pluginId) continue
    const id = pluginSkillSourceId(parsed.pluginId, parsed.skill)
    const pluginItem: DashboardSkillCodeAdoptionStats = {
      ...sourceItem,
      id,
      sourceRef: sourceItem.skill,
      skill: parsed.skill,
      isPlugin: true,
      pluginName: parsed.pluginName || parsed.pluginId
    }
    const existingPlugin = pluginItems.get(id)
    if (existingPlugin) {
      const merged = addSkillCodeStats(existingPlugin, pluginItem)
      pluginItems.set(id, {
        ...merged,
        id,
        sourceRef: existingPlugin.sourceRef ?? pluginItem.sourceRef,
        skill: parsed.skill,
        isPlugin: true,
        pluginName: existingPlugin.pluginName ?? pluginItem.pluginName
      })
    } else {
      pluginItems.set(id, pluginItem)
    }
    const existingSkillStats = pluginStatsBySkill.get(parsed.skill)
    pluginStatsBySkill.set(
      parsed.skill,
      existingSkillStats ? addSkillCodeStats(existingSkillStats, pluginItem) : pluginItem
    )
  }

  const result = Array.from(pluginItems.values())
  for (const item of usedSkillItems) {
    const remaining = pluginStatsBySkill.has(item.skill)
      ? subtractSkillCodeStats(item, pluginStatsBySkill.get(item.skill)!)
      : { ...item, id: item.id ?? item.skill }
    if (hasPositiveCodeStats(remaining)) result.push(remaining)
  }

  result.sort(
    (a, b) =>
      b.adoptedLines - a.adoptedLines ||
      b.generatedLines - a.generatedLines ||
      a.skill.localeCompare(b.skill, "zh-CN")
  )
  return result
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
    value === "internal_notification" ||
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
    "observabilitySchemaVersion",
    "traceKind",
    "executionMode",
    "rootTraceId",
    "rootThreadId",
    "parentTraceId",
    "parentThreadId",
    "parentSpanId",
    "linkType",
    "subagentKind",
    "subagentRunId",
    "subagentThreadId",
    "handoffAction",
    "handoffSourceAgent",
    "handoffTargetAgent",
    "coordinatorWorkerId",
    "coordinatorWorkerTurn",
    "coordinatorWorkerRole",
    "coordinatorWorkerWorkload",
    "workflowRunId",
    "workflowAgentIndex",
    "workflowPhase",
    "workflowAgentLabel",
    "outcome",
    "totalToolCalls",
    "totalInputTokens",
    "totalOutputTokens",
    "totalTokens",
    "usedSkills",
    "evolvedSkills",
    "triggerSource",
    "harnessProjectId",
    "harnessFeatureSlug",
    "harnessNodeName",
    "harnessNodeStatus"
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

function codeSkillAdoptionBucketAggs(
  codeGenFilters: Record<string, unknown>[],
  codeAdoptFilters: Record<string, unknown>[],
  codeAdoptPushedFilters: Record<string, unknown>[]
): Record<string, unknown> {
  return {
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

/** 统计 trace 树中 request_user_input 工具节点的数量（向用户提问的次数）。 */
function countUserInputRequests(nodes: TraceNode[] | undefined): number {
  if (!Array.isArray(nodes)) return 0
  return nodes.filter((node) => node.type === "tool" && node.name === "request_user_input").length
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

    return redactTraceDetailForDisplay({
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
      ...traceObservabilityDetailFields(trace, source),
      outcome: trace.outcome || asString(source.outcome, "unknown"),
      totalToolCalls: asNumber(trace.totalToolCalls, asNumber(source.totalToolCalls)),
      modelCallCount: Array.isArray(trace.modelCalls)
        ? trace.modelCalls.length
        : asNumber(source.modelCallCount),
      userInputRequestCount: countUserInputRequests(nodes),
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      ...(trace.appVersion || source.appVersion
        ? { appVersion: asString(trace.appVersion || source.appVersion) }
        : {}),
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
    })
  }

  const fallbackInputTokens = asNumber(source.totalInputTokens)
  const fallbackOutputTokens = asNumber(source.totalOutputTokens)
  return redactTraceDetailForDisplay({
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
    ...traceObservabilityDetailFields(undefined, source),
    outcome: asString(source.outcome, "unknown"),
    totalToolCalls: asNumber(source.totalToolCalls),
    modelCallCount: asNumber(source.modelCallCount),
    userInputRequestCount: asNumber(source.userInputRequestCount),
    totalInputTokens: fallbackInputTokens,
    totalOutputTokens: fallbackOutputTokens,
    totalTokens: asNumber(source.totalTokens, fallbackInputTokens + fallbackOutputTokens),
    ...(source.appVersion ? { appVersion: asString(source.appVersion) } : {}),
    usedSkills: asStringArray(source.usedSkills),
    evolvedSkills: asStringArray(source.evolvedSkills),
    triggerSource: normalizeTraceTriggerSource(source.triggerSource),
    rawAvailable: false,
    rawError: parsed.error
  })
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

  return redactTraceDetailForDisplay({
    traceId: trace.traceId,
    threadId: trace.threadId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: asNumber(trace.durationMs),
    userMessage: trace.userMessage,
    modelId: trace.modelId,
    ...(trace.modelName ? { modelName: trace.modelName } : {}),
    ...traceObservabilityDetailFields(trace),
    outcome: trace.outcome,
    totalToolCalls: asNumber(trace.totalToolCalls),
    modelCallCount: Array.isArray(trace.modelCalls) ? trace.modelCalls.length : 0,
    userInputRequestCount: countUserInputRequests(nodes),
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens || usage.totalInputTokens + usage.totalOutputTokens,
    ...(trace.appVersion ? { appVersion: trace.appVersion } : {}),
    usedSkills: Array.isArray(trace.usedSkills) ? trace.usedSkills : [],
    evolvedSkills: Array.isArray(trace.evolvedSkills) ? trace.evolvedSkills : [],
    triggerSource: normalizeTraceTriggerSource(trace.triggerSource),
    ...(nodes ? { nodes } : {}),
    rawAvailable: !rawError,
    ...(rawError ? { rawError } : {})
  })
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
    threadIds: [],
    usedSkills,
    skillCount: asNumber(properties.skillCount, usedSkills.length),
    codeGeneratedLines: 0,
    codeEffectiveGeneratedLines: 0,
    codeAdoptedLines: 0,
    codeAdoptionRate: null
  }
}

function eventRootThreadId(properties: Record<string, unknown>): string | undefined {
  return asOptionalString(properties.rootThreadId) ?? asOptionalString(properties.threadId)
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
  // predate the commit by up to the attribution window (≈14 days). Filtering by
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
          // 该 commit 的代码可能来自多个子 Agent thread；会话历史按 rootThreadId 收束。
          by_thread: { terms: { field: "properties.rootThreadId", size: 50 } },
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
    const threadBuckets = asRecord(record.by_thread).buckets
    const threadIds = Array.isArray(threadBuckets)
      ? normalizeSkillList(
          threadBuckets.map((threadBucket) => asString(asRecord(threadBucket).key))
        )
      : []
    result.set(commitSha, {
      usedSkills: skills,
      generatedLines,
      effectiveGeneratedLines,
      adoptedLines,
      adoptionRate: effectiveGeneratedLines > 0 ? adoptedLines / effectiveGeneratedLines : null,
      threadIds
    })
  }
  return result
}

/** Join commit-detail rows with their per-commit adoption summary (skills, threads, adopted lines). */
function attachCommitAdoption(
  items: DashboardCommitDetail[],
  adoptionMap: Map<string, CommitAdoptionSummary>
): DashboardCommitDetail[] {
  return items.map((item) => {
    const adoption = item.commitSha ? adoptionMap.get(item.commitSha) : undefined
    const adoptedSkills = adoption?.usedSkills ?? []
    const adoptionThreadIds = adoption?.threadIds ?? []
    // 关联会话优先取自采纳事件（代码生成时所在的真实会话，可为多个）；
    // 采纳事件缺失时回退到 commit 自带 threadId。
    const threadIds =
      adoptionThreadIds.length > 0 ? adoptionThreadIds : item.threadId ? [item.threadId] : []
    return {
      ...item,
      threadId: threadIds[0] ?? item.threadId,
      threadIds,
      usedSkills: adoptedSkills,
      skillCount: adoptedSkills.length,
      codeGeneratedLines: adoption?.generatedLines ?? 0,
      codeEffectiveGeneratedLines: adoption?.effectiveGeneratedLines ?? 0,
      codeAdoptedLines: adoption?.adoptedLines ?? 0,
      codeAdoptionRate: adoption?.adoptionRate ?? null
    }
  })
}

/** Upper bound on adopt rows fetched for a single commit's 溯源 view. */
const COMMIT_ADOPTION_EVENTS_LIMIT = 500
/** ES terms clause cap when reverse-looking-up gen events by id. */
const GEN_LOOKUP_BATCH = 1000

/**
 * 单条 commit 的采纳溯源：拉该 commit 全部 `code_adopt`，再用 `genEventId` 反查
 * 配对 `code_gen` 元数据。每个 adopt 事件对应一行（含 verdict / 三项行数）。
 *
 * 刻意不加时间范围：`commitSha` 已是精确、全局唯一的选择子，而 `code_adopt` 以
 * commit 时刻打点却携带可能早于窗口的 `generatedAt`（同 `fetchCommitAdoptionMap`）。
 */
async function fetchCommitAdoptionEvents(commitSha: string): Promise<CommitAdoptionEvents> {
  requireDashboardAccess()
  const sha = commitSha?.trim?.() ?? ""
  const empty: CommitAdoptionEvents = {
    commitSha: sha,
    pairs: [],
    reconciliation: { sumEffective: 0, sumAdopted: 0, rate: null }
  }
  if (!sha) return empty

  // 1) 该 commit 的全部 code_adopt（一行 = 一次测量）。
  const adoptBody = {
    track_total_hits: false,
    size: COMMIT_ADOPTION_EVENTS_LIMIT,
    query: {
      bool: {
        filter: [{ term: { eventName: "code_adopt" } }, { term: { "properties.commitSha": sha } }]
      }
    },
    _source: {
      includes: [
        "properties.genEventId",
        "properties.verdict",
        "properties.reason",
        "properties.generatedLineCount",
        "properties.effectiveGeneratedLineCount",
        "properties.adoptedLineCount",
        "properties.measureSource",
        "properties.pushed",
        "properties.measuredAt",
        "properties.rootThreadId",
        "properties.threadId"
      ]
    }
  }
  const adoptRaw = (await esQuery(getEsIndex("event"), adoptBody)) as EsSearchResponse
  const adoptRows = (adoptRaw.hits?.hits ?? []).map((hit) =>
    asRecord(asRecord(hit._source).properties)
  )
  if (adoptRows.length === 0) return empty

  // 2) 反查配对 gen 的元数据（云端 code_gen 仅含叶子文件名/工具/技能等，无内容/路径）。
  const genIds = Array.from(
    new Set(adoptRows.map((row) => asString(row.genEventId)).filter(Boolean))
  )
  const genById = new Map<string, Record<string, unknown>>()
  // gen 元数据仅为展示增强（文件叶子名/工具/技能）。若反查失败（如 properties.eventId
  // 的 mapping 不支持精确 term），降级为「仅 adopt 行」，核心对账不受影响。
  try {
    for (let i = 0; i < genIds.length; i += GEN_LOOKUP_BATCH) {
      const batch = genIds.slice(i, i + GEN_LOOKUP_BATCH)
      const genBody = {
        track_total_hits: false,
        size: batch.length,
        query: {
          bool: {
            filter: [
              { term: { eventName: "code_gen" } },
              { terms: { "properties.eventId": batch } }
            ]
          }
        },
        _source: {
          includes: [
            "properties.eventId",
            "properties.relativeHint",
            "properties.tool",
            "properties.language",
            "properties.usedSkills",
            "properties.modelName",
            "properties.createdAt",
            // threadId is sourced from the paired gen (see pair assembly). A
            // code_adopt's threadId is just a copy of its gen's, so reading it
            // from gen lets producers (e.g. external reporters) carry it on
            // code_gen only. Falls back to the adopt row for unpaired gens.
            "properties.rootThreadId",
            "properties.threadId"
          ]
        }
      }
      const genRaw = (await esQuery(getEsIndex("event"), genBody)) as EsSearchResponse
      for (const hit of genRaw.hits?.hits ?? []) {
        const props = asRecord(asRecord(hit._source).properties)
        const id = asString(props.eventId)
        if (id) genById.set(id, props)
      }
    }
  } catch (e) {
    console.warn("[Dashboard] commitAdoptionEvents gen lookup failed (adopt-only fallback):", e)
  }

  // 3) 配对成行 + 对账（sum 口径镜像 fetchCommitAdoptionMap：仅累加三项齐全的行）。
  let sumEffective = 0
  let sumAdopted = 0
  const pairs: CommitAdoptionEventPair[] = adoptRows.map((adopt) => {
    const genEventId = asString(adopt.genEventId)
    const gen = genEventId ? genById.get(genEventId) : undefined
    const generatedLineCount =
      typeof adopt.generatedLineCount === "number" ? adopt.generatedLineCount : null
    const effectiveGeneratedLineCount =
      typeof adopt.effectiveGeneratedLineCount === "number"
        ? adopt.effectiveGeneratedLineCount
        : null
    const adoptedLineCount =
      typeof adopt.adoptedLineCount === "number" ? adopt.adoptedLineCount : null
    if (
      generatedLineCount !== null &&
      effectiveGeneratedLineCount !== null &&
      adoptedLineCount !== null
    ) {
      sumEffective += effectiveGeneratedLineCount
      sumAdopted += adoptedLineCount
    }
    return {
      genEventId,
      file: gen ? (asOptionalString(gen.relativeHint) ?? null) : null,
      tool: gen ? (asOptionalString(gen.tool) ?? null) : null,
      language: gen ? (asOptionalString(gen.language) ?? null) : null,
      usedSkills: gen ? normalizeSkillList(asStringArray(gen.usedSkills)) : [],
      modelName: gen ? (asOptionalString(gen.modelName) ?? null) : null,
      generatedAt: gen ? (asOptionalString(gen.createdAt) ?? null) : null,
      verdict: asOptionalString(adopt.verdict) ?? null,
      reason: asOptionalString(adopt.reason) ?? null,
      generatedLineCount,
      effectiveGeneratedLineCount,
      adoptedLineCount,
      measureSource: asOptionalString(adopt.measureSource) ?? null,
      pushed: adopt.pushed === true,
      measuredAt: asOptionalString(adopt.measuredAt) ?? null,
      // Prefer the paired gen's rootThreadId (source of truth for root session
      // display); fall back to the adopt row when there is no paired gen (e.g.
      // the "无配对 gen 事件" row) so its 会话 still renders.
      threadId: (gen ? eventRootThreadId(gen) : undefined) ?? eventRootThreadId(adopt) ?? null
    }
  })

  // 新近的测量排在前（按测量时间，缺失回退生成时间）。
  pairs.sort((a, b) => {
    const ta = Date.parse(a.measuredAt ?? a.generatedAt ?? "") || 0
    const tb = Date.parse(b.measuredAt ?? b.generatedAt ?? "") || 0
    return tb - ta
  })

  return {
    commitSha: sha,
    pairs,
    reconciliation: {
      sumEffective,
      sumAdopted,
      rate: sumEffective > 0 ? sumAdopted / sumEffective : null
    }
  }
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
      skill_source: { terms: { field: "skillSource", size: rankingSearchSize } },
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
        aggs: codeSkillAdoptionBucketAggs(codeGenFilters, codeAdoptFilters, codeAdoptPushedFilters)
      },
      by_skill_source_adoption: {
        terms: { field: "properties.skillSource", size: rankingSearchSize },
        aggs: codeSkillAdoptionBucketAggs(codeGenFilters, codeAdoptFilters, codeAdoptPushedFilters)
      },
      skill_source: { terms: { field: "properties.skillSource", size: rankingSearchSize } }
    }
  }

  const [traceRaw, codeRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody, {
      projection: { kind: "overview-trace", granularity },
      outputByteLimit: DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT
    }),
    esQuery(getEsIndex("event"), codeBody, {
      projection: { kind: "overview-code" },
      outputByteLimit: DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT
    })
  ])
  return enforceDashboardIpcByteLimit(
    "Dashboard overview",
    {
      ...asRecord(traceRaw),
      ...asRecord(codeRaw)
    },
    DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.overview
  )
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
      },
      smart_by_tier: {
        filter: {
          terms: { "routing.decidedByLayer": ["thread", "layer1", "layer2", "layer3"] }
        },
        aggs: {
          by_tier: {
            terms: { field: "routing.resolvedTier", size: 5 }
          }
        }
      }
    }
  }
  return enforceDashboardIpcByteLimit(
    "Dashboard model stats",
    await esQuery(getEsIndex("trace"), body, {
      projection: { kind: "model-stats" },
      outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    }),
    DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.modelStats
  )
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

function normalizeCommitUserKeyword(userKeyword?: string | null): string | null {
  if (typeof userKeyword !== "string") return null
  const normalized = userKeyword.trim()
  return normalized ? normalized : null
}

function buildCommitUserMatchFilter(userKeyword: string): Record<string, unknown> {
  const escaped = escapeWildcard(userKeyword)
  const wildcardPattern = `*${escaped}*`
  const fields = ["userName", "username", "sapId", "ystId"]
  const should = fields.flatMap((field) => [
    { term: { [field]: userKeyword } },
    { term: { [`${field}.keyword`]: userKeyword } },
    { wildcard: { [field]: wildcardPattern } },
    { wildcard: { [`${field}.keyword`]: wildcardPattern } }
  ])
  return { bool: { should, minimum_should_match: 1 } }
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
  return enforceDashboardIpcByteLimit(
    "Dashboard user stats",
    await esQuery(getEsIndex("trace"), body, {
      projection: {
        kind: "user-stats",
        selectedUpperOrgLv1: selectedOrgs.length === 1 ? selectedOrgs[0] : null
      },
      outputByteLimit: DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT
    }),
    DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.userStats
  )
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
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    codeStats: null
  }
}

async function fetchUserListCodeStats(
  sapIds: string[],
  range: TimeRange,
  upperOrgLv1: string | null,
  options?: { projectMode?: boolean }
): Promise<Map<string, DashboardCodeStats>> {
  const normalizedSapIds = Array.from(new Set(sapIds.map((sapId) => sapId.trim()).filter(Boolean)))
  if (normalizedSapIds.length === 0) return new Map()

  // Keep the per-user code metrics on the same time and department scope as the
  // platform overview. Restricting the event query to the visible page avoids a
  // large all-user aggregation on every list request.
  const orgFilter = upperOrgLv1 ? buildOrgLevelMatchFilter(upperOrgLv1) : null
  const scopeFilters: Record<string, unknown>[] = [
    ...(orgFilter ? [orgFilter] : []),
    ...(options?.projectMode ? [{ exists: { field: "properties.harnessProjectId" } }] : [])
  ]
  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    null,
    range,
    scopeFilters
  )
  const raw = asRecord(
    await esQuery(getEsIndex("event"), {
      size: 0,
      query: {
        bool: {
          filter: [{ terms: { sapId: normalizedSapIds } }],
          should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
          minimum_should_match: 1
        }
      },
      aggs: {
        users: {
          terms: { field: "sapId", size: normalizedSapIds.length },
          aggs: perBucketAggs
        }
      }
    })
  )

  const result = new Map<string, DashboardCodeStats>()
  const buckets = asRecord(asRecord(raw.aggregations).users).buckets
  for (const rawBucket of Array.isArray(buckets) ? buckets : []) {
    const bucket = asRecord(rawBucket)
    const sapId = asString(bucket.key)
    if (sapId) result.set(sapId, normalizeCodeStatsFromContainer(bucket))
  }
  return result
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
  const items = buckets
    .map((bucket) => normalizeUserListBucket(asRecord(bucket)))
    .filter((item) => item.sapId)
  const codeStatsBySapId = await fetchUserListCodeStats(
    items.map((item) => item.sapId),
    range,
    upperOrgLv1
  )
  const totalActiveUsers = asNumber(asRecord(aggs.total_active_users).value)
  const nextOffset = offset + pageSize
  const hasMoreBuckets = asNumber(usersAgg.sum_other_doc_count) > 0
  return {
    items: items.map((item) => ({
      ...item,
      codeStats: codeStatsBySapId.get(item.sapId) ?? null
    })),
    pageSize,
    ...(hasMoreBuckets && nextOffset < 10_000 ? { nextAfterKey: { offset: nextOffset } } : {}),
    totalActiveUsers
  }
}

// ── 生成但未提交分析（漏斗首层下钻）─────────────────────────────────
// 榜单返回的用户上限。terms 桶数取得更大，便于在内存里按「未提交行数」重排。
const UNCOMMITTED_RANKING_LIMIT = 50
// 方案 B 单用户扫描的 code_gen 上限；超过则明细退化为「最近 N 次生成」采样。
const UNCOMMITTED_DETAIL_SCAN_CAP = 2000
// anti-join 时 terms 查询单批 genEventId 数上限。
const UNCOMMITTED_ANTIJOIN_BATCH = 1000
// 方案 A composite 全量遍历的单页用户数。
const UNCOMMITTED_COMPOSITE_PAGE = 1000
// 安全上限：最多翻 200 页（20 万用户），防止异常情况下无限翻页。
const UNCOMMITTED_COMPOSITE_MAX_PAGES = 200

function buildUncommittedSelfUserFilter(
  access: UncommittedAnalysisAccess
): Record<string, unknown> {
  const should: Record<string, unknown>[] = []
  const sapId = access.sapId.trim()
  const ystId = access.ystId.trim()
  if (sapId) {
    should.push({ term: { sapId } }, { term: { "sapId.keyword": sapId } })
  }
  if (ystId) {
    should.push({ term: { ystId } }, { term: { "ystId.keyword": ystId } })
  }
  if (should.length === 0) return { term: { sapId: "__dashboard_no_access__" } }
  return { bool: { should, minimum_should_match: 1 } }
}

function uncommittedScopeFilters(
  options: UncommittedScopeOptions | undefined,
  access: UncommittedAnalysisAccess
): Record<string, unknown>[] {
  const filters: Record<string, unknown>[] = []
  // 数据权限与界面筛选 AND 叠加：普通用户锁本人，名单用户锁本室，管理员不加身份约束。
  if (access.selfOnly) {
    filters.push(buildUncommittedSelfUserFilter(access))
  } else if (!access.admin && access.upperOrgLv1) {
    filters.push(buildUpperOrgLv1Filter(access.upperOrgLv1))
  }
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(options?.upperOrgLv1))
  if (orgFilterClause) filters.push(orgFilterClause)
  const projectId = typeof options?.projectId === "string" ? options.projectId.trim() : ""
  const featureSlug = typeof options?.featureSlug === "string" ? options.featureSlug.trim() : ""
  if (projectId) {
    filters.push({ term: { "properties.harnessProjectId": projectId } })
  } else if (options?.projectMode || featureSlug) {
    filters.push({ exists: { field: "properties.harnessProjectId" } })
  }
  if (featureSlug) filters.push({ term: { "properties.harnessFeatureSlug": featureSlug } })
  // 「由 Skill 生成」口径：usedSkills 非空，与项目概览 skillCodeStats 一致。
  if (options?.usedSkillsOnly) filters.push({ exists: { field: "properties.usedSkills" } })
  // 上报来源收窄：与「生产效能代码指标」下拉同口径（原生=must_not exists source；其余=term）。
  // 顶层 filter 同时作用于 code_gen 与 code_adopt，二者均按令牌盖戳同一 properties.source。
  const sourceClause = buildCodeSourceFilterClause(options?.source)
  if (sourceClause) filters.push(sourceClause)
  const userKeyword = normalizeCommitUserKeyword(options?.userKeyword)
  if (userKeyword !== null) filters.push(buildCommitUserMatchFilter(userKeyword))
  return filters
}

/**
 * 方案 A：按用户聚合「生成但未提交」榜单（聚合近似）。
 *
 * 用 composite 聚合按 sapId 全量分页遍历，每个用户桶里用 filter 子聚合分别算
 * code_gen 生成量与 code_adopt 已测量量，内存里求差值。composite 无 300 桶上限，
 * 覆盖窗口内全部生成者。仍是近似口径——聚合级集合差，而非逐 genEventId 的精确
 * 反连接（精确口径见 fetchUncommittedDetail）。
 *
 * 时间口径与外部「事件筛选框」(range) 完全一致：code_gen 按 eventTime、code_adopt
 * 按 properties.generatedAt，与漏斗/概览同字段、同上下界。「已测量」口径与漏斗一致：
 * adoptedLineCount / generatedLineCount / effectiveGeneratedLineCount 都存在才算已测量；
 * 求和 generatedLineCount（原始生成行数），使「生成 − 已测量」严格等于漏斗的
 * unmeasuredGeneratedLines（见 dashboard-code-stats.ts）。
 */
async function fetchUncommittedRanking(
  range: TimeRange,
  options?: UncommittedScopeOptions
): Promise<UncommittedRankingData> {
  // 管理员可看全部；unrestricted 名单用户看本室；普通用户只看本人。
  const access = requireDashboardUncommittedAnalysisAccess()
  const scopeFilters = uncommittedScopeFilters(options, access)

  // 两类事件各自的过滤（用各自的时间字段）。同时用于「顶层 should 限定 composite
  // 只对窗口内有 gen 或 adopt 的用户建桶」+「桶内 filter 子聚合分别求和」。
  const genEventFilter = {
    bool: {
      filter: [{ term: { eventName: "code_gen" } }, timeRangeFilter("eventTime", range)]
    }
  }
  const adoptEventFilter = {
    bool: {
      filter: [
        { term: { eventName: "code_adopt" } },
        timeRangeFilter("properties.generatedAt", range),
        { exists: { field: "properties.adoptedLineCount" } },
        { exists: { field: "properties.generatedLineCount" } },
        { exists: { field: "properties.effectiveGeneratedLineCount" } }
      ]
    }
  }

  const items: UncommittedRankingItem[] = []
  let totalGeneratedLines = 0
  let totalMeasuredGeneratedLines = 0
  let totalUncommittedLines = 0
  let afterKey: Record<string, string> | undefined
  let pages = 0

  do {
    const body = {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [buildNonEmptySapIdFilter(), ...scopeFilters],
          should: [genEventFilter, adoptEventFilter],
          minimum_should_match: 1
        }
      },
      aggs: {
        by_sap: {
          composite: {
            size: UNCOMMITTED_COMPOSITE_PAGE,
            sources: [{ sapId: { terms: { field: "sapId" } } }],
            ...(afterKey ? { after: afterKey } : {})
          },
          aggs: {
            gen: {
              filter: genEventFilter,
              aggs: { gen_lines: { sum: { field: "properties.lineCount" } } }
            },
            adopt: {
              filter: adoptEventFilter,
              aggs: { measured_gen_lines: { sum: { field: "properties.generatedLineCount" } } }
            },
            latest_user_info: {
              top_hits: {
                size: 1,
                sort: [{ eventTime: { order: "desc" } }],
                _source: {
                  includes: ["sapId", "ystId", "userName", "orgName", "upperOrgLv0", "upperOrgLv1"]
                }
              }
            }
          }
        }
      }
    }

    const raw = asRecord(await esQuery(getEsIndex("event"), body))
    const bySap = asRecord(asRecord(raw.aggregations).by_sap)
    const buckets = Array.isArray(bySap.buckets) ? (bySap.buckets as unknown[]) : []
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket)
      const sapId = asString(asRecord(bucket.key).sapId)
      if (!sapId) continue
      const generatedLines = asNumber(asRecord(asRecord(bucket.gen).gen_lines).value)
      const measuredGeneratedLines = asNumber(
        asRecord(asRecord(bucket.adopt).measured_gen_lines).value
      )
      totalGeneratedLines += generatedLines
      totalMeasuredGeneratedLines += measuredGeneratedLines
      // 窗口内没有生成的用户不计入未提交榜（其 adopt 若有也是窗口外生成的归因）。
      if (generatedLines <= 0) continue
      const uncommittedLines = Math.max(0, generatedLines - measuredGeneratedLines)
      totalUncommittedLines += uncommittedLines
      const source = getLatestHitSource(bucket, "latest_user_info")
      items.push({
        sapId,
        ystId: asOptionalString(source.ystId),
        userName: asString(source.userName, sapId),
        orgName: asOptionalString(source.orgName),
        upperOrgLv0: asOptionalString(source.upperOrgLv0),
        upperOrgLv1: asOptionalString(source.upperOrgLv1),
        generatedLines,
        measuredGeneratedLines,
        uncommittedLines,
        uncommittedRate: generatedLines > 0 ? uncommittedLines / generatedLines : null
      })
    }

    const nextAfter = asRecord(bySap).after_key
    afterKey =
      nextAfter && typeof nextAfter === "object" ? (nextAfter as Record<string, string>) : undefined
    pages += 1
  } while (afterKey && pages < UNCOMMITTED_COMPOSITE_MAX_PAGES)

  items.sort((a, b) => b.uncommittedLines - a.uncommittedLines)

  return {
    items: items.slice(0, UNCOMMITTED_RANKING_LIMIT),
    totalGeneratedLines,
    totalMeasuredGeneratedLines,
    totalUncommittedLines,
    limit: UNCOMMITTED_RANKING_LIMIT
  }
}

function pushBreakdown(
  map: Map<string, { gens: number; lines: number }>,
  key: string,
  lines: number
): void {
  const entry = map.get(key) ?? { gens: 0, lines: 0 }
  entry.gens += 1
  entry.lines += lines
  map.set(key, entry)
}

function breakdownToSortedList(
  map: Map<string, { gens: number; lines: number }>,
  limit: number
): UncommittedDetailBreakdown[] {
  return Array.from(map.entries())
    .map(([key, value]) => ({ key, gens: value.gens, lines: value.lines }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, limit)
}

/**
 * 方案 B：对单个用户用 genEventId 做 anti-join，精确定位「生成了但没进 commit」
 * 的那批 code_gen，并按 tool/语言/项目/会话归类作为「为什么」的证据。
 *
 * 性能：只扫描该用户最近 UNCOMMITTED_DETAIL_SCAN_CAP 条 code_gen（一次降序查询），
 * 再用一批 terms 反查 code_adopt.genEventId 是否存在。扫描被截断时返回 scanCapped=true，
 * 明细按「最近 N 次生成」采样口径解读。
 */
async function fetchUncommittedDetail(
  sapId: string,
  range: TimeRange,
  options?: UncommittedScopeOptions
): Promise<UncommittedDetailData> {
  // 管理员可看全部；unrestricted 名单用户看本室；普通用户只看本人。
  const access = requireDashboardUncommittedAnalysisAccess()
  const normalizedSapId = sapId.trim()
  if (!normalizedSapId) throw new Error("sapId is required")
  const scopeFilters = uncommittedScopeFilters(options, access)

  // 1) 扫描该用户最近的 code_gen（降序，单次查询，封顶 scanCap）。时间口径同外部筛选框。
  const genBody = {
    size: UNCOMMITTED_DETAIL_SCAN_CAP,
    track_total_hits: true,
    query: {
      bool: {
        filter: [
          { term: { eventName: "code_gen" } },
          { term: { sapId: normalizedSapId } },
          timeRangeFilter("eventTime", range),
          ...scopeFilters
        ]
      }
    },
    sort: [{ eventTime: { order: "desc" } }],
    _source: {
      includes: [
        "eventTime",
        "userName",
        "properties.eventId",
        "properties.tool",
        "properties.language",
        "properties.lineCount",
        "properties.rootThreadId",
        "properties.threadId",
        "properties.harnessProjectId",
        "properties.harnessFeatureSlug",
        "properties.modelName",
        "properties.relativeHint"
      ]
    }
  }

  const genRaw = asRecord(await esQuery(getEsIndex("event"), genBody))
  const hitsWrapper = asRecord(genRaw.hits)
  const hits = Array.isArray(hitsWrapper.hits) ? (hitsWrapper.hits as unknown[]) : []
  const totalValue = asRecord(hitsWrapper.total).value
  const totalGens = typeof totalValue === "number" ? totalValue : asNumber(hitsWrapper.total)
  const scanCapped = totalGens > hits.length

  interface ScannedGen {
    eventId: string
    eventTime: string
    tool?: string
    language?: string
    lineCount: number
    threadId?: string
    harnessProjectId?: string
    harnessFeatureSlug?: string
    modelName?: string
    fileHint?: string
    userName?: string
  }

  const scanned: ScannedGen[] = []
  for (const raw of hits) {
    const source = asRecord(asRecord(raw)._source)
    const props = asRecord(source.properties)
    const eventId = asString(props.eventId)
    if (!eventId) continue
    scanned.push({
      eventId,
      eventTime: asString(source.eventTime),
      tool: asOptionalString(props.tool),
      language: asOptionalString(props.language),
      lineCount: asNumber(props.lineCount),
      threadId: eventRootThreadId(props),
      harnessProjectId: asOptionalString(props.harnessProjectId),
      harnessFeatureSlug: asOptionalString(props.harnessFeatureSlug),
      modelName: asOptionalString(props.modelName),
      fileHint: asOptionalString(props.relativeHint),
      userName: asOptionalString(source.userName)
    })
  }

  // 2) anti-join：批量反查哪些 genEventId 已有 code_adopt（即已被测量/提交）。
  const adoptedIds = new Set<string>()
  for (let i = 0; i < scanned.length; i += UNCOMMITTED_ANTIJOIN_BATCH) {
    const batch = scanned.slice(i, i + UNCOMMITTED_ANTIJOIN_BATCH).map((gen) => gen.eventId)
    if (batch.length === 0) continue
    const adoptBody = {
      size: batch.length,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            { term: { eventName: "code_adopt" } },
            { terms: { "properties.genEventId": batch } }
          ]
        }
      },
      _source: { includes: ["properties.genEventId"] }
    }
    const adoptRaw = asRecord(await esQuery(getEsIndex("event"), adoptBody))
    const adoptHits = asRecord(adoptRaw.hits).hits
    if (Array.isArray(adoptHits)) {
      for (const raw of adoptHits) {
        const genId = asString(asRecord(asRecord(asRecord(raw)._source).properties).genEventId)
        if (genId) adoptedIds.add(genId)
      }
    }
  }

  // 3) 差集 = 未提交的生成；按维度归类。
  const uncommitted = scanned.filter((gen) => !adoptedIds.has(gen.eventId))
  const byTool = new Map<string, { gens: number; lines: number }>()
  const byLanguage = new Map<string, { gens: number; lines: number }>()
  const byProject = new Map<string, { gens: number; lines: number }>()
  const byThread = new Map<string, { gens: number; lines: number }>()
  let uncommittedLines = 0
  for (const gen of uncommitted) {
    uncommittedLines += gen.lineCount
    pushBreakdown(byTool, gen.tool || "未知工具", gen.lineCount)
    pushBreakdown(byLanguage, gen.language || "未知语言", gen.lineCount)
    pushBreakdown(
      byProject,
      gen.harnessFeatureSlug || gen.harnessProjectId || "非项目模式",
      gen.lineCount
    )
    if (gen.threadId) pushBreakdown(byThread, gen.threadId, gen.lineCount)
  }

  // 返回全部未提交样本（≤ scanCap），由前端客户端分页；不额外发查询。
  const samples: UncommittedDetailSample[] = uncommitted.map((gen) => ({
    eventId: gen.eventId,
    eventTime: gen.eventTime,
    tool: gen.tool,
    language: gen.language,
    lineCount: gen.lineCount,
    fileHint: gen.fileHint,
    threadId: gen.threadId,
    harnessProjectId: gen.harnessProjectId,
    harnessFeatureSlug: gen.harnessFeatureSlug,
    modelName: gen.modelName
  }))

  return {
    sapId: normalizedSapId,
    userName: scanned.find((gen) => gen.userName)?.userName ?? normalizedSapId,
    scannedGens: scanned.length,
    scanCapped,
    uncommittedGens: uncommitted.length,
    uncommittedLines,
    byTool: breakdownToSortedList(byTool, 10),
    byLanguage: breakdownToSortedList(byLanguage, 10),
    byProject: breakdownToSortedList(byProject, 10),
    byThread: breakdownToSortedList(byThread, 10),
    samples
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
 * 「按会话分页」的聚合定义：按 rootThreadId 分桶（按最近活跃倒序）、每桶回带该会话
 * 的 trace（升序、最多 THREAD_LIST_TRACES_PER_THREAD 条）。用户页与技能页 thread
 * 视图共用，保证两边口径完全一致。历史数据需要回填 rootThreadId=threadId。
 */
function threadListAgg(bucketsNeeded: number): Record<string, unknown> {
  return {
    total_threads: { cardinality: { field: "rootThreadId" } },
    by_thread: {
      terms: {
        field: "rootThreadId",
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
  const access = options?.projectMode
    ? requireDashboardProjectModeAccess()
    : requireDashboardAccess()
  const normalizedSapId = sapId.trim()
  if (!normalizedSapId) throw new Error("sapId is required")
  const traceViewMode = normalizeTraceViewMode(options?.viewMode ?? options?.mode)
  const tracePageSize = clampLimit(options?.tracePageSize ?? options?.traceLimit, 10, 50)
  const tracePage = clampLimit(options?.tracePage, 1, 1000)
  const triggerScope = normalizeTraceTriggerScope(options?.triggerScope)
  // 统计指标（顶层聚合）按该用户全量计算，不做组织级权限过滤；
  // 组织级权限作用于返回的会话/trace 明细（thread 模式经 thread_list 的 filter 聚合，
  // trace 模式经 post_filter），避免跨组织读取对话内容。
  const traceAccessFilter = options?.projectMode
    ? buildProjectModeAccessFilter(access)
    : buildTraceAccessFilter(access)
  const baseFilter = [
    timeRangeFilter("startedAt", range),
    { term: { sapId: normalizedSapId } },
    ...(triggerScope === "active" ? [buildChatTriggeredTraceFilter()] : []),
    // 项目运营概览入口：仅统计项目模式（带 harnessProjectId）的 trace。
    ...(options?.projectMode ? [{ exists: { field: "harnessProjectId" } }] : [])
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

  const [raw, codeStatsBySapId] = await Promise.all([
    esQuery(getEsIndex("trace"), body) as Promise<EsSearchResponse>,
    fetchUserListCodeStats([normalizedSapId], range, null, {
      projectMode: options?.projectMode
    })
  ])
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
    codeStats: codeStatsBySapId.get(normalizedSapId) ?? null,
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
    upperOrgLv1List,
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
    const statsResult = await fetchSkillEvalStatRecords(
      range,
      explicitRecentFilter,
      upperOrgLv1List,
      sampleLimit
    )
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
      fetchSkillEvalStatRecords(range, explicitRecentFilter, upperOrgLv1List, sampleLimit),
      fetchSkillEvalRecordPage(
        range,
        explicitRecentFilter,
        upperOrgLv1List,
        recentFrom,
        recentPageSize,
        true
      )
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
      upperOrgLv1List,
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
      fetchSkillEvalStatRecords(range, recentSkillFilter, upperOrgLv1List, sampleLimit),
      fetchSkillEvalRecordPage(
        range,
        recentSkillFilter,
        upperOrgLv1List,
        recentFrom,
        recentPageSize,
        true
      )
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
        upperOrgLv1List,
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
    fetchSkillEvalStatRecords(range, recentSkillFilter, upperOrgLv1List, sampleLimit),
    fetchSkillEvalRecordPage(
      range,
      recentSkillFilter,
      upperOrgLv1List,
      recentFrom,
      recentPageSize,
      true
    ),
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
  skillFilter?: SkillEvalFilter,
  upperOrgLv1List: string[] = []
): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [timeRangeFilter("startedAt", range)]
  const orgFilterClause = buildUpperOrgLv1ListFilter(upperOrgLv1List)
  if (orgFilterClause) filter.push(orgFilterClause)
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
  upperOrgLv1List: string[],
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
    query: skillEvalRecordQuery(range, skillFilter, upperOrgLv1List),
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
    skillEvalStoredRecordsToDashboardRuns(pageRecords, traceDetails, skillFilter, undefined, true)
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
  upperOrgLv1List: string[],
  recordLimit = SKILL_EVAL_STATS_TRACE_LIMIT
): Promise<SkillEvalStatRecordResult> {
  const cached = getCachedSkillEvalStatRecords(range, skillFilter, upperOrgLv1List, recordLimit)
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
      query: skillEvalRecordQuery(range, skillFilter, upperOrgLv1List),
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
  setCachedSkillEvalStatRecords(range, skillFilter, upperOrgLv1List, recordLimit, result)
  return result
}

const skillEvalStatRecordCache = new Map<
  string,
  { expiresAt: number; result: SkillEvalStatRecordResult }
>()

function getCachedSkillEvalStatRecords(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  upperOrgLv1List: string[],
  recordLimit: number
): SkillEvalStatRecordResult | undefined {
  const key = skillEvalStatRecordCacheKey(range, skillFilter, upperOrgLv1List, recordLimit)
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
  upperOrgLv1List: string[],
  recordLimit: number,
  result: SkillEvalStatRecordResult
): void {
  const key = skillEvalStatRecordCacheKey(range, skillFilter, upperOrgLv1List, recordLimit)
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
  upperOrgLv1List: string[],
  recordLimit: number
): string {
  const sortedOrgList = [...upperOrgLv1List].sort()
  return [
    range.from,
    range.to,
    Math.max(1, recordLimit),
    skillEvalFilterCacheKey(skillFilter),
    sortedOrgList.join("\u0002")
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
  allowedSkillNames?: Set<string>,
  redactForDisplay = false
): DashboardSkillEvalRun[] {
  return records
    .filter((record) => {
      if (isSkillEvalExactFilter(skillFilter) && !isSameSkillVersion(record, skillFilter)) {
        return false
      }
      return hasAllowedSkillName(record.skillName, allowedSkillNames)
    })
    .map((rawRecord) => {
      const record = redactForDisplay ? redactTraceSkillEvalRecordForDisplay(rawRecord) : rawRecord
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
    modelCallCount: record.modelCallCount,
    userInputRequestCount: 0,
    totalInputTokens: record.totalInputTokens,
    totalOutputTokens: record.totalOutputTokens,
    totalTokens: record.totalTokens,
    ...(record.appVersion ? { appVersion: record.appVersion } : {}),
    usedSkills: [record.rawSkillName],
    evolvedSkills: [],
    triggerSource: "chat",
    rawAvailable: false,
    rawError: "未在 trace 索引中找到原始 trace 详情"
  }
}

async function fetchSkillEvalRecordSkillList(
  range: TimeRange,
  skillFilter: SkillEvalFilter | undefined,
  upperOrgLv1List: string[],
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
    query: skillEvalRecordQuery(range, skillFilter, upperOrgLv1List),
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
  const skillFilter = buildVersionedSkillUsagePrefixFilter(skillName)
  const body = {
    size: 0,
    // 统计口径计入全部触发来源；triggerSource 仅用于 trace 分析页切换，不在此过滤。
    query: {
      bool: {
        must: [
          timeRangeFilter("startedAt", range),
          ...(traceAccessFilter ? [traceAccessFilter] : []),
          { exists: { field: "ystId" } },
          { bool: { must_not: { term: { ystId: "" } } } },
          skillFilter
        ]
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
  return esQuery(getEsIndex("trace"), body, {
    projection: { kind: "user-directory" },
    outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
  })
}

function readUserDirectoryProjection(raw: unknown): {
  items: DashboardAllUserItem[]
  afterKey?: Record<string, string>
} {
  const record = asRecord(raw)
  const items = Array.isArray(record.items) ? (record.items as DashboardAllUserItem[]) : []
  const afterKey = asRecord(record.afterKey)
  return {
    items,
    ...(Object.keys(afterKey).length > 0 ? { afterKey: afterKey as Record<string, string> } : {})
  }
}

function estimatedUserDirectoryItemBytes(item: DashboardAllUserItem): number {
  return (
    64 +
    Buffer.byteLength(item.sapId, "utf8") +
    Buffer.byteLength(item.userName, "utf8") +
    Buffer.byteLength(item.orgName, "utf8") +
    Buffer.byteLength(item.upperOrgLv0 ?? "", "utf8") +
    Buffer.byteLength(item.upperOrgLv1 ?? "", "utf8")
  )
}

async function queryAllUser(): Promise<DashboardAllUserItem[]> {
  const users: DashboardAllUserItem[] = []
  let afterKey: Record<string, string> | undefined
  let estimatedBytes = 0
  let pageCount = 0

  do {
    pageCount += 1
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
            size: DASHBOARD_USER_DIRECTORY_PAGE_SIZE,
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

    const response = readUserDirectoryProjection(
      await esQuery(getEsIndex("trace"), body, {
        projection: { kind: "user-directory" },
        outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
      })
    )

    for (const item of response.items) {
      const itemBytes = estimatedUserDirectoryItemBytes(item)
      if (
        users.length >= DASHBOARD_USER_DIRECTORY_MAX_ITEMS ||
        estimatedBytes + itemBytes > DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT
      ) {
        return enforceDashboardIpcByteLimit(
          "Dashboard user directory",
          users,
          DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT
        )
      }
      users.push(item)
      estimatedBytes += itemBytes
    }

    afterKey = response.afterKey
  } while (afterKey && pageCount < DASHBOARD_USER_DIRECTORY_MAX_PAGES)

  return enforceDashboardIpcByteLimit(
    "Dashboard user directory",
    users,
    DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT
  )
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
    esQuery(getEsIndex("event"), body, {
      projection: { kind: "productivity-commit", granularity, range },
      outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    }),
    esQuery(getEsIndex("event"), codeBody, {
      projection: { kind: "productivity-code" },
      outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    })
  ])
  const commitRecord = asRecord(commitRaw)
  const codeRecord = asRecord(codeRaw)
  const totalCommits = asNumber(commitRecord.totalCommits)
  const activeUsers = asNumber(commitRecord.activeUsers)
  return enforceDashboardIpcByteLimit(
    "Dashboard productivity",
    {
      ...commitRecord,
      ...codeRecord,
      avgCommitsPerUser: activeUsers > 0 ? totalCommits / activeUsers : 0
    },
    DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.productivity
  )
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

// ─────────────────────────────────────────────────────────
// Advanced features (operations) — replaces the like/dislike feedback module.
//
// Two-tier model (core usage + value result) for advanced capabilities.
// Event-side metrics come from the `event` index by `eventName`
// (heartbeat.run.completed / memory.write.applied / skill.evolution.* /
// im.event.processed / hook.executed).
// Tool-call-based metrics (memory_search/get, java_lsp, code_exec, deferred
// tools) and post-evolution skill usage are REUSED from the `trace` index
// (`toolNames`, `evolvedSkills`) instead of double-emitting events for things
// traces already record.
// ─────────────────────────────────────────────────────────

type AdvFeatureTone = "good" | "bad" | "warn" | "neutral"

interface AdvFeatureItem {
  label: string
  count: number
  tone: AdvFeatureTone
}

interface AdvFeatureCard {
  key: string
  label: string
  value: number
  valueLabel: string
  hint: string
  items: AdvFeatureItem[]
}

interface AdvancedFeaturesResult {
  cards: AdvFeatureCard[]
  source: "es" | "mock"
}

interface AdvFeatureMetrics {
  hbActionable: number
  hbSilent: number
  hbError: number
  hbCancelled: number
  memSearch: number
  memGet: number
  memWrite: number
  lsp: number
  evoCandidates: number
  evoEmpty: number
  evoRunError: number
  evoAccepted: number
  evoRejected: number
  evoCloud: number
  cloudPublished: number
  proposalTriggered: number
  proposalAccepted: number
  evolvedTraces: number
  evolvedUsages: number
  imCompleted: number
  imCancelled: number
  imError: number
  hookTotal: number
  hookBlocked: number
  codeExec: number
  savedTool: number
  claudeCodeLaunches: number
}

function assembleAdvancedFeatureCards(
  m: AdvFeatureMetrics,
  source: "es" | "mock"
): AdvancedFeaturesResult {
  const hbTotal = m.hbActionable + m.hbSilent + m.hbError + m.hbCancelled
  const memTotal = m.memSearch + m.memGet + m.memWrite
  const imTotal = m.imCompleted + m.imCancelled + m.imError
  const progTotal = m.codeExec + m.savedTool

  return {
    source,
    cards: [
      {
        key: "optimizer",
        label: "自优化",
        value: m.evoAccepted + m.proposalAccepted + m.evoCloud,
        valueLabel: "总采纳数",
        hint: `本地沉淀采纳 ${m.evoAccepted + m.proposalAccepted} · 云端候选采纳 ${m.evoCloud}`,
        items: [
          { label: "优化候选审批发布次数", count: m.cloudPublished, tone: "good" },
          { label: "优化后技能使用次数", count: m.evolvedUsages, tone: "good" }
        ]
      },
      {
        key: "heartbeat",
        label: "心跳监控",
        value: hbTotal,
        valueLabel: "实际执行次数",
        hint: `有可执行产出 ${m.hbActionable} 次`,
        items: [
          { label: "有产出", count: m.hbActionable, tone: "good" },
          { label: "静默", count: m.hbSilent, tone: "neutral" },
          { label: "失败", count: m.hbError, tone: "bad" },
          { label: "取消", count: m.hbCancelled, tone: "warn" }
        ]
      },
      {
        key: "memory",
        label: "记忆管理",
        value: memTotal,
        valueLabel: "记忆操作次数",
        hint: `记忆写入 ${m.memWrite} 次`,
        items: [
          { label: "搜索", count: m.memSearch, tone: "neutral" },
          { label: "读取", count: m.memGet, tone: "neutral" },
          { label: "写入", count: m.memWrite, tone: "good" }
        ]
      },
      {
        key: "lsp",
        label: "Java LSP",
        value: m.lsp,
        valueLabel: "代码理解调用",
        hint: "Agent 用 LSP 精确理解代码",
        items: []
      },
      {
        key: "im",
        label: "内置统一机器人",
        value: imTotal,
        valueLabel: "处理消息数",
        hint: `成功完成 ${m.imCompleted} 条`,
        items: [
          { label: "已完成", count: m.imCompleted, tone: "good" },
          { label: "取消", count: m.imCancelled, tone: "warn" },
          { label: "错误/未知", count: m.imError, tone: "bad" }
        ]
      },
      {
        key: "hooks",
        label: "钩子 Hooks",
        value: m.hookTotal,
        valueLabel: "执行次数",
        hint: `拦截风险 ${m.hookBlocked} 次`,
        items: [
          { label: "执行", count: m.hookTotal, tone: "neutral" },
          { label: "拦截", count: m.hookBlocked, tone: "good" }
        ]
      },
      {
        key: "programmatic",
        label: "编程式工具",
        value: progTotal,
        valueLabel: "工具执行次数",
        hint: `code_exec ${m.codeExec} · 保存工具 ${m.savedTool}`,
        items: [
          { label: "code_exec", count: m.codeExec, tone: "neutral" },
          { label: "保存工具", count: m.savedTool, tone: "neutral" }
        ]
      },
      {
        key: "claudeCode",
        label: "Claude Code",
        value: m.claudeCodeLaunches,
        valueLabel: "启动次数",
        hint: `选择目录启动会话 ${m.claudeCodeLaunches} 次`,
        items: [{ label: "目录启动", count: m.claudeCodeLaunches, tone: "good" }]
      }
    ]
  }
}

async function fetchAdvancedFeatures(
  range: TimeRange,
  _granularity: Granularity,
  opts?: OrgFilterOptions
): Promise<AdvancedFeaturesResult> {
  requireDashboardAccess()
  const orgFilterClause = buildUpperOrgLv1ListFilter(normalizeUpperOrgLv1List(opts?.upperOrgLv1))
  const orgFilter = orgFilterClause ? [orgFilterClause] : []

  const eventBody = {
    size: 0,
    query: {
      bool: { filter: [timeRangeFilter("eventTime", range), ...orgFilter] }
    },
    aggs: {
      heartbeat: {
        filter: { term: { eventName: "heartbeat.run.completed" } },
        aggs: { by_outcome: { terms: { field: "properties.outcome", size: 10 } } }
      },
      memory_write: { filter: { term: { eventName: "memory.write.applied" } } },
      evo_run: {
        filter: { term: { eventName: "skill.evolution.run" } },
        aggs: { by_outcome: { terms: { field: "properties.outcome", size: 10 } } }
      },
      evo_accepted: { filter: { term: { eventName: "skill.evolution.accepted" } } },
      evo_rejected: { filter: { term: { eventName: "skill.evolution.rejected" } } },
      evo_cloud: { filter: { term: { eventName: "skill.evolution.cloud.accepted" } } },
      evo_published: { filter: { term: { eventName: "skill.evolution.cloud.published" } } },
      proposal_triggered: { filter: { term: { eventName: "skill.proposal.triggered" } } },
      proposal_accepted: { filter: { term: { eventName: "skill.proposal.accepted" } } },
      im: {
        filter: { term: { eventName: "im.event.processed" } },
        aggs: { by_outcome: { terms: { field: "properties.outcome", size: 10 } } }
      },
      hooks: {
        filter: { term: { eventName: "hook.executed" } },
        aggs: { blocked: { filter: { term: { "properties.blocked": true } } } }
      },
      claude_code_launches: {
        filter: {
          bool: {
            filter: [
              { term: { eventName: "workspace.launch.started" } },
              { term: { "properties.surface": "claude_code" } }
            ]
          }
        }
      }
    }
  }

  const traceBody = {
    size: 0,
    query: {
      bool: { filter: [timeRangeFilter("startedAt", range), ...orgFilter] }
    },
    aggs: {
      by_tool: {
        terms: {
          field: "toolNames",
          include: ["memory_search", "memory_get", "java_lsp", "code_exec", "save_code_exec_tool"],
          size: 10
        }
      },
      evolved_traces: { filter: { exists: { field: "evolvedSkills" } } },
      evolved_usages: { value_count: { field: "evolvedSkills" } }
    }
  }

  const [eventResRaw, traceResRaw] = await Promise.all([
    esQuery(getEsIndex("event"), eventBody, {
      projection: { kind: "advanced-event" },
      outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    }),
    esQuery(getEsIndex("trace"), traceBody, {
      projection: { kind: "advanced-trace" },
      outputByteLimit: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT
    })
  ])
  const metrics = {
    ...asRecord(eventResRaw),
    ...asRecord(traceResRaw)
  } as unknown as AdvFeatureMetrics

  return enforceDashboardIpcByteLimit(
    "Dashboard advanced features",
    assembleAdvancedFeatureCards(metrics, "es"),
    DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS.advancedFeatures
  )
}

function makeMockAdvancedFeatures(range: TimeRange): AdvancedFeaturesResult {
  const days = Math.max(
    1,
    Math.round(
      (new Date(range.to).getTime() - new Date(range.from).getTime()) / (24 * 60 * 60 * 1000)
    )
  )
  const k = (perDay: number): number => Math.round(perDay * days)

  const metrics: AdvFeatureMetrics = {
    hbActionable: k(6),
    hbSilent: k(30),
    hbError: k(1),
    hbCancelled: k(1),
    memSearch: k(40),
    memGet: k(22),
    memWrite: k(8),
    lsp: k(18),
    evoCandidates: k(3),
    evoEmpty: k(5),
    evoRunError: k(1),
    evoAccepted: k(2),
    evoRejected: k(1),
    evoCloud: k(2),
    cloudPublished: k(1),
    proposalTriggered: k(7),
    proposalAccepted: k(4),
    evolvedTraces: k(9),
    evolvedUsages: k(14),
    imCompleted: k(12),
    imCancelled: k(2),
    imError: k(1),
    hookTotal: k(140),
    hookBlocked: k(12),
    codeExec: k(9),
    savedTool: k(6),
    claudeCodeLaunches: k(11)
  }

  return assembleAdvancedFeatureCards(metrics, "mock")
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

// 单个 root thread 的完整 trace 列表，用于「Thread 对话还原」抽屉展开时还原完整会话。
// 与 fetchSkillRecentTraces 的 thread 概览不同，这里：
// - 按 threadId / rootThreadId / parentThreadId 精确匹配，不做时间窗裁剪
//   （避免丢掉 thread 开头早于所选时间范围的 trace，以及异步子 Agent trace）；
// - 不做 skill / 主动触发过滤（还原真实完整会话）；
// - 仍保留组织级数据权限过滤；
// - 按 startedAt 升序返回（从首条到末条），上限 MAX_THREAD_TRACES 防止单 thread 过大撑爆查询。
const MAX_THREAD_TRACES = 200

interface ThreadTracesOptions {
  scope?: "platform" | "project"
}

async function fetchThreadTraces(
  threadId: string,
  options?: ThreadTracesOptions
): Promise<DashboardTraceDetail[]> {
  const projectScoped = options?.scope === "project"
  const access = projectScoped ? requireDashboardProjectModeAccess() : requireDashboardAccess()
  const trimmed = threadId?.trim?.() ?? ""
  if (!trimmed) return []
  const filters: Record<string, unknown>[] = [
    {
      bool: {
        should: [
          { term: { threadId: trimmed } },
          { term: { rootThreadId: trimmed } },
          { term: { parentThreadId: trimmed } }
        ],
        minimum_should_match: 1
      }
    }
  ]
  appendOptionalFilter(
    filters,
    projectScoped ? buildProjectModeAccessFilter(access) : buildTraceAccessFilter(access)
  )
  const body = {
    track_total_hits: false,
    size: MAX_THREAD_TRACES,
    sort: [{ startedAt: { order: "asc" } }],
    query: { bool: { filter: filters } },
    _source: { includes: dashboardTraceSourceIncludes() }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const seen = new Set<string>()
  return (raw.hits?.hits ?? []).map(normalizeTraceDetail).filter((trace) => {
    const key = trace.traceId || `${trace.threadId}:${trace.startedAt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

// ── 评奖辅助看板 fetchers ───────────────────────────────────────
// 单批技能命名桶上限（避免聚合体过大）。个人技能数远小于此。
const AWARD_SKILL_CONTRIBUTION_LIMIT = 300
// 应用奖榜返回的个人数上限（多列展示、不自动排名，前端可自行排序/裁剪 Top10）。
const AWARD_USER_APPLICATION_LIMIT = 100

/**
 * 技能贡献奖：对给定「个人构建」技能名集，按技能聚合跨室数 / 使用人数 / 调用数（trace 侧）
 * 与整体入库统计（code 事件侧）。两侧均用 filters 命名桶单次聚合，避免逐技能查询。
 */
async function fetchAwardSkillContributions(
  range: TimeRange,
  skillNames: string[]
): Promise<DashboardAwardSkillContribution[]> {
  requireDashboardAwardsAccess()
  // 保留前端传入的原始名作为回传 key（供前端 join 市场展示字段），内部用归一化名建 ES 过滤。
  const seen = new Set<string>()
  const entries: Array<{ key: string; norm: string }> = []
  for (const raw of Array.isArray(skillNames) ? skillNames : []) {
    const key = String(raw || "").trim()
    if (!key || seen.has(key)) continue
    const norm = normalizeSkillQueryName(key)
    if (!norm) continue
    seen.add(key)
    entries.push({ key, norm })
    if (entries.length >= AWARD_SKILL_CONTRIBUTION_LIMIT) break
  }
  if (entries.length === 0) return []

  // trace 侧：每个技能一个命名 filter 桶，统计去重室 / 去重用户；调用数取桶 doc_count。
  const traceFilters: Record<string, unknown> = {}
  for (const { key, norm } of entries) traceFilters[key] = buildSkillUsageWildcardFilter(norm)
  const traceBody = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      by_skill: {
        filters: { filters: traceFilters },
        aggs: {
          cross_org: { cardinality: { field: "upperOrgLv1" } },
          users: { cardinality: { field: "ystId" } }
        }
      }
    }
  }

  // code 事件侧：每个技能一个命名 filter 桶，桶内复用 perBucketAggs 得入库统计。
  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    null,
    range,
    []
  )
  const eventFilters: Record<string, unknown> = {}
  for (const { key, norm } of entries) eventFilters[key] = buildEventSkillUsageWildcardFilter(norm)
  const eventBody = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: {
      by_skill: { filters: { filters: eventFilters }, aggs: perBucketAggs }
    }
  }

  const [traceRaw, eventRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody),
    esQuery(getEsIndex("event"), eventBody)
  ])

  const traceBuckets = asRecord(
    asRecord(asRecord(asRecord(traceRaw).aggregations).by_skill).buckets
  )
  const eventBuckets = asRecord(
    asRecord(asRecord(asRecord(eventRaw).aggregations).by_skill).buckets
  )

  return entries.map(({ key }) => {
    const tBucket = asRecord(traceBuckets[key])
    const eBucket = asRecord(eventBuckets[key])
    const codeStats =
      asNumber(eBucket.doc_count) > 0 ? normalizeCodeStatsFromContainer(eBucket) : null
    return {
      skillKey: key,
      crossOrgCount: asNumber(asRecord(tBucket.cross_org).value),
      userCount: asNumber(asRecord(tBucket.users).value),
      callCount: asNumber(tBucket.doc_count),
      codeStats
    }
  })
}

/**
 * 技能应用奖榜：按个人（ystId）聚合深度使用指标（trace 侧）+ 个人入库统计（code 事件侧）。
 * 不自动排名；trace 按调用数取前 N 人，code 入库按 ystId join。
 */
async function fetchAwardUserApplications(
  range: TimeRange
): Promise<DashboardAwardUserApplication[]> {
  requireDashboardAwardsAccess()

  const traceBody = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          { exists: { field: "ystId" } },
          { bool: { must_not: { term: { ystId: "" } } } }
        ]
      }
    },
    aggs: {
      users: {
        terms: { field: "ystId", size: AWARD_USER_APPLICATION_LIMIT, order: { _count: "desc" } },
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
          skill_count: { cardinality: { field: "usedSkills" } },
          skill_usage_total: { value_count: { field: "usedSkills" } },
          tool_calls: { sum: { field: "totalToolCalls" } },
          thread_count: { cardinality: { field: "threadId" } },
          feature_count: { cardinality: { field: "harnessFeatureSlug" } }
        }
      }
    }
  }

  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    null,
    range,
    []
  )
  const eventBody = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: {
      users: { terms: { field: "ystId", size: 2000 }, aggs: perBucketAggs }
    }
  }

  const [traceRaw, eventRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody),
    esQuery(getEsIndex("event"), eventBody)
  ])

  // 个人入库统计按 ystId 建索引，供 trace 用户榜 join。
  const codeByYst = new Map<string, DashboardCodeStats>()
  const eventUsers = asRecord(asRecord(asRecord(eventRaw).aggregations).users)
  const eventList = Array.isArray(eventUsers.buckets) ? eventUsers.buckets : []
  for (const b of eventList) {
    const bucket = asRecord(b)
    const yst = asString(bucket.key)
    if (!yst) continue
    codeByYst.set(yst, normalizeCodeStatsFromContainer(bucket))
  }

  const traceUsers = asRecord(asRecord(asRecord(traceRaw).aggregations).users)
  const traceList = Array.isArray(traceUsers.buckets) ? traceUsers.buckets : []
  return traceList
    .map((b): DashboardAwardUserApplication | null => {
      const bucket = asRecord(b)
      const yst = asString(bucket.key)
      if (!yst) return null
      const hits = asRecord(asRecord(bucket.latest_user_info).hits).hits
      const firstHit = asRecord(Array.isArray(hits) ? hits[0] : undefined)
      const src = asRecord(firstHit._source)
      return {
        sapId: asString(src.sapId),
        ystId: yst,
        userName: asString(src.userName),
        orgName: asOptionalString(src.orgName),
        upperOrgLv0: asOptionalString(src.upperOrgLv0),
        upperOrgLv1: asOptionalString(src.upperOrgLv1),
        callCount: asNumber(bucket.doc_count),
        skillCount: asNumber(asRecord(bucket.skill_count).value),
        skillUsageCount: asNumber(asRecord(bucket.skill_usage_total).value),
        toolCallCount: asNumber(asRecord(bucket.tool_calls).value),
        threadCount: asNumber(asRecord(bucket.thread_count).value),
        featureCount: asNumber(asRecord(bucket.feature_count).value),
        codeStats: codeByYst.get(yst) ?? null
      }
    })
    .filter((x): x is DashboardAwardUserApplication => x !== null)
}

/** 团队标杆奖：单个组织桶的 trace 侧指标聚合（室级与组级共用）。 */
function teamBenchmarkTraceMetricAggs(): Record<string, unknown> {
  return {
    usage_count: { value_count: { field: "traceId" } },
    user_count: { cardinality: { field: "ystId" } },
    skill_usage_count: { value_count: { field: "usedSkills" } },
    distinct_skills: { cardinality: { field: "usedSkills" } },
    // 各用户使用次数（doc_count），用于统计「超过人均次数的人数」。
    users: { terms: { field: "ystId", size: 5000 } }
  }
}

/**
 * 把一个组织桶（含 teamBenchmarkTraceMetricAggs）解析为标杆奖行的 trace 侧部分。
 * 本行内使用次数超过本行人均的用户计入 aboveAvgUserCount。
 */
function parseTeamBenchmarkTraceBucket(bucket: Record<string, unknown>): {
  usageCount: number
  userCount: number
  perCapitaUsage: number
  aboveAvgUserCount: number
  skillUsageCount: number
  distinctSkillsUsed: number
} {
  const usageCount = asNumber(asRecord(bucket.usage_count).value, asNumber(bucket.doc_count))
  const userCount = asNumber(asRecord(bucket.user_count).value)
  const perCapitaUsage = userCount > 0 ? usageCount / userCount : 0
  const userBuckets = asRecord(bucket.users).buckets
  const aboveAvgUserCount = Array.isArray(userBuckets)
    ? userBuckets.filter((u) => asNumber(asRecord(u).doc_count) > perCapitaUsage).length
    : 0
  return {
    usageCount,
    userCount,
    perCapitaUsage,
    aboveAvgUserCount,
    skillUsageCount: asNumber(asRecord(bucket.skill_usage_count).value),
    distinctSkillsUsed: asNumber(asRecord(bucket.distinct_skills).value)
  }
}

/** 组织桶 join key：室 或 室␀组。 */
function teamOrgKey(shi: string, group?: string): string {
  return group ? `${shi}\u0000${group}` : shi
}

const TEAM_BENCHMARK_SHI_LIMIT = 200
const TEAM_BENCHMARK_GROUP_LIMIT = 500

/**
 * 团队标杆奖：按 室(upperOrgLv1) → 组(upperOrgLv0) 两级聚合使用深度（trace 侧）+ 代码产出（event 侧）。
 * 「使用超过人均次数的人数」在服务端用各用户桶就地算出；贡献技能数/覆盖室数为市场口径，前端补。
 */
async function fetchAwardTeamBenchmark(
  range: TimeRange
): Promise<DashboardAwardTeamBenchmarkRow[]> {
  requireDashboardAwardsAccess()

  const traceBody = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          { exists: { field: "upperOrgLv1" } },
          { bool: { must_not: { term: { upperOrgLv1: "" } } } }
        ]
      }
    },
    aggs: {
      // 全员基线：总使用次数 / 总去重用户 → 总量人均使用次数。
      total_usage: { value_count: { field: "traceId" } },
      total_users: { cardinality: { field: "ystId" } },
      by_shi: {
        terms: { field: "upperOrgLv1", size: TEAM_BENCHMARK_SHI_LIMIT },
        aggs: {
          ...teamBenchmarkTraceMetricAggs(),
          by_group: {
            terms: { field: "upperOrgLv0", size: TEAM_BENCHMARK_GROUP_LIMIT },
            aggs: teamBenchmarkTraceMetricAggs()
          }
        }
      }
    }
  }

  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    null,
    range,
    []
  )
  const eventBody = {
    size: 0,
    query: {
      bool: {
        should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
        minimum_should_match: 1
      }
    },
    aggs: {
      by_shi: {
        terms: { field: "upperOrgLv1", size: TEAM_BENCHMARK_SHI_LIMIT },
        aggs: {
          ...perBucketAggs,
          by_group: {
            terms: { field: "upperOrgLv0", size: TEAM_BENCHMARK_GROUP_LIMIT },
            aggs: perBucketAggs
          }
        }
      }
    }
  }

  const [traceRaw, eventRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody),
    esQuery(getEsIndex("event"), eventBody)
  ])

  // 代码统计按 室 / 室␀组 建索引，供 trace 行 join。
  const codeByOrg = new Map<string, DashboardCodeStats>()
  const eventShiBuckets = asRecord(asRecord(asRecord(eventRaw).aggregations).by_shi).buckets
  for (const sb of Array.isArray(eventShiBuckets) ? eventShiBuckets : []) {
    const shiBucket = asRecord(sb)
    const shi = asString(shiBucket.key)
    if (!shi) continue
    codeByOrg.set(teamOrgKey(shi), normalizeCodeStatsFromContainer(shiBucket))
    const groupBuckets = asRecord(shiBucket.by_group).buckets
    for (const gb of Array.isArray(groupBuckets) ? groupBuckets : []) {
      const groupBucket = asRecord(gb)
      const group = asString(groupBucket.key)
      if (!group) continue
      codeByOrg.set(teamOrgKey(shi, group), normalizeCodeStatsFromContainer(groupBucket))
    }
  }

  const traceAggs = asRecord(asRecord(traceRaw).aggregations)
  const totalUsage = asNumber(asRecord(traceAggs.total_usage).value)
  const totalUsers = asNumber(asRecord(traceAggs.total_users).value)
  // 总量人均使用次数 = 全员总使用次数 / 全员去重用户数，仅作全局参考。
  const totalPerCapitaUsage = totalUsers > 0 ? totalUsage / totalUsers : 0

  const shiBuckets = asRecord(traceAggs.by_shi).buckets
  return (Array.isArray(shiBuckets) ? shiBuckets : [])
    .map((sb): DashboardAwardTeamBenchmarkRow | null => {
      const shiBucket = asRecord(sb)
      const shi = asString(shiBucket.key)
      if (!shi) return null
      const groupBuckets = asRecord(shiBucket.by_group).buckets
      const children = (Array.isArray(groupBuckets) ? groupBuckets : [])
        .map((gb): DashboardAwardTeamBenchmarkRow | null => {
          const groupBucket = asRecord(gb)
          const group = asString(groupBucket.key)
          if (!group) return null
          return {
            shi,
            group,
            ...parseTeamBenchmarkTraceBucket(groupBucket),
            totalPerCapitaUsage,
            codeStats: codeByOrg.get(teamOrgKey(shi, group)) ?? null
          }
        })
        .filter((x): x is DashboardAwardTeamBenchmarkRow => x !== null)
      return {
        shi,
        ...parseTeamBenchmarkTraceBucket(shiBucket),
        totalPerCapitaUsage,
        codeStats: codeByOrg.get(teamOrgKey(shi)) ?? null,
        children
      }
    })
    .filter((x): x is DashboardAwardTeamBenchmarkRow => x !== null)
}

/**
 * 团队标杆奖·技能试用覆盖室数：给定每个室「贡献技能名集」，返回该室技能被多少个去重室（upperOrgLv1）试用过。
 * 单次查询用命名 filter 桶（每室一桶，usedSkills 命中该室技能集），桶内 cardinality(upperOrgLv1)。
 */
async function fetchAwardTeamSkillCoverage(
  range: TimeRange,
  groups: Array<{ shi: string; skillNames: string[] }>
): Promise<Record<string, number>> {
  requireDashboardAwardsAccess()
  const filters: Record<string, unknown> = {}
  for (const g of Array.isArray(groups) ? groups : []) {
    const shi = String(g?.shi || "").trim()
    const names = Array.isArray(g?.skillNames) ? g.skillNames : []
    if (!shi || names.length === 0) continue
    const should = names.flatMap((raw) => {
      const norm = normalizeSkillQueryName(raw)
      if (!norm) return []
      const wildcard = `${escapeWildcard(norm)}**`
      return [
        { wildcard: { usedSkills: wildcard } },
        { wildcard: { "usedSkills.keyword": wildcard } }
      ]
    })
    if (should.length === 0) continue
    filters[shi] = { bool: { should, minimum_should_match: 1 } }
  }
  if (Object.keys(filters).length === 0) return {}

  const body = {
    size: 0,
    query: { bool: { filter: [timeRangeFilter("startedAt", range)] } },
    aggs: {
      by_shi: {
        filters: { filters },
        aggs: { covered_shi: { cardinality: { field: "upperOrgLv1" } } }
      }
    }
  }
  const raw = await esQuery(getEsIndex("trace"), body)
  const buckets = asRecord(asRecord(asRecord(asRecord(raw).aggregations).by_shi).buckets)
  const result: Record<string, number> = {}
  for (const shi of Object.keys(filters)) {
    result[shi] = asNumber(asRecord(asRecord(buckets[shi]).covered_shi).value)
  }
  return result
}

/** `_source` fields needed to render a Commit 明细 row (shared by commit-detail fetchers). */
const COMMIT_DETAIL_SOURCE_INCLUDES = [
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
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword, orgLv1List } =
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
  if (userKeyword !== null) {
    filters.push(buildCommitUserMatchFilter(userKeyword))
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
    _source: { includes: COMMIT_DETAIL_SOURCE_INCLUDES }
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
    items: attachCommitAdoption(items, adoptionMap)
  }
}

/** `_source` fields needed to render a 非 Git 仓库上报 row. */
const NON_GIT_ADOPTION_REPORT_SOURCE_INCLUDES = [
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
  "properties.source",
  "properties.genEventId",
  "properties.generatedAt",
  "properties.measuredAt",
  "properties.pushedAt",
  "properties.pushed",
  "properties.verdict",
  "properties.measureSource",
  "properties.generatedLineCount",
  "properties.effectiveGeneratedLineCount",
  "properties.adoptedLineCount",
  "properties.threadId",
  "properties.usedSkills",
  "properties.modelName",
  "properties.harnessProjectId",
  "properties.harnessFeatureSlug",
  "properties.harnessAdapterName",
  "properties.harnessAdapterVersion"
]

function buildMissingCommitShaFilter(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { bool: { must_not: [{ exists: { field: "properties.commitSha" } }] } },
        { term: { "properties.commitSha": "" } }
      ],
      minimum_should_match: 1
    }
  }
}

function buildExternalNonGitReportFilter(): Record<string, unknown> {
  return {
    bool: {
      should: [
        { exists: { field: "properties.source" } },
        { term: { "properties.measureSource": "external" } }
      ],
      minimum_should_match: 1
    }
  }
}

async function fetchCodeGenMetadataForNonGitReports(
  genEventIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const ids = normalizeSkillList(genEventIds).slice(0, GEN_LOOKUP_BATCH)
  const result = new Map<string, Record<string, unknown>>()
  if (ids.length === 0) return result

  try {
    const raw = (await esQuery(getEsIndex("event"), {
      track_total_hits: false,
      size: ids.length,
      query: {
        bool: {
          filter: [{ term: { eventName: "code_gen" } }, { terms: { "properties.eventId": ids } }]
        }
      },
      _source: {
        includes: [
          "properties.eventId",
          "properties.relativeHint",
          "properties.tool",
          "properties.language",
          "properties.modelName",
          "properties.threadId"
        ]
      }
    })) as EsSearchResponse

    for (const hit of raw.hits?.hits ?? []) {
      const props = asRecord(asRecord(hit._source).properties)
      const id = asString(props.eventId)
      if (id) result.set(id, props)
    }
  } catch (e) {
    console.warn("[Dashboard] nonGitAdoptionReports gen lookup failed:", e)
  }

  return result
}

function normalizeNonGitAdoptionReport(
  hit: EsSearchHit,
  genById: Map<string, Record<string, unknown>>
): DashboardNonGitAdoptionReportItem {
  const source = hit._source ?? {}
  const properties = asRecord(source.properties)
  const genEventId = asOptionalString(properties.genEventId)
  const gen = genEventId ? genById.get(genEventId) : undefined
  const generatedAt = asString(properties.generatedAt, asString(source.eventTime))
  const threadId =
    (gen ? asOptionalString(gen.threadId) : undefined) ?? asOptionalString(properties.threadId)
  const generatedLineCount = asNumber(properties.generatedLineCount)
  const effectiveGeneratedLineCount = asNumber(properties.effectiveGeneratedLineCount)
  const adoptedLineCount = asNumber(properties.adoptedLineCount)

  return {
    eventId: asString(source.eventId, hit._id ?? ""),
    eventTime: asString(source.eventTime, generatedAt),
    generatedAt,
    pushedAt: asOptionalString(properties.pushedAt),
    measuredAt: asOptionalString(properties.measuredAt),
    userName: asString(source.userName, "unknown"),
    sapId: asOptionalString(source.sapId),
    ystId: asOptionalString(source.ystId),
    orgName: asOptionalString(source.orgName),
    upperOrgLv0: asOptionalString(source.upperOrgLv0),
    upperOrgLv1: asOptionalString(source.upperOrgLv1),
    userIp: asOptionalString(source.userIp),
    source: asOptionalString(properties.source),
    harnessProjectId: asOptionalString(properties.harnessProjectId),
    harnessFeatureSlug: asOptionalString(properties.harnessFeatureSlug),
    harnessAdapterName: asOptionalString(properties.harnessAdapterName),
    harnessAdapterVersion: asOptionalString(properties.harnessAdapterVersion),
    genEventId,
    threadId,
    threadIds: threadId ? [threadId] : [],
    fileHint: gen ? asOptionalString(gen.relativeHint) : undefined,
    tool: gen ? asOptionalString(gen.tool) : undefined,
    language: gen ? asOptionalString(gen.language) : undefined,
    modelName:
      asOptionalString(properties.modelName) ?? (gen ? asOptionalString(gen.modelName) : undefined),
    measureSource: asOptionalString(properties.measureSource),
    verdict: asOptionalString(properties.verdict),
    pushed: asBoolean(properties.pushed),
    usedSkills: normalizeSkillList(asStringArray(properties.usedSkills)),
    generatedLineCount,
    effectiveGeneratedLineCount,
    adoptedLineCount,
    adoptionRate:
      effectiveGeneratedLineCount > 0 ? adoptedLineCount / effectiveGeneratedLineCount : null
  }
}

async function fetchNonGitAdoptionReports(
  range: TimeRange,
  options?: NonGitAdoptionReportsOptions
): Promise<DashboardNonGitAdoptionReportsData> {
  const opts = normalizeNonGitAdoptionReportsOptions(options)
  const access = opts.projectMode ? requireDashboardProjectModeAccess() : requireDashboardAccess()
  const filters: Record<string, unknown>[] = [
    { term: { eventName: "code_adopt" } },
    { exists: { field: "properties.adoptedLineCount" } },
    { exists: { field: "properties.generatedLineCount" } },
    { exists: { field: "properties.effectiveGeneratedLineCount" } },
    timeRangeFilter("properties.generatedAt", range),
    buildMissingCommitShaFilter(),
    buildExternalNonGitReportFilter()
  ]

  if (opts.projectMode) {
    appendOptionalFilter(
      filters,
      buildProjectModeOrgFilter({ upperOrgLv1: opts.orgLv1List }, access)
    )
    if (opts.projectId) {
      filters.push({ term: { "properties.harnessProjectId": opts.projectId } })
    } else {
      filters.push({ exists: { field: "properties.harnessProjectId" } })
    }
    if (opts.featureSlug) {
      filters.push({ term: { "properties.harnessFeatureSlug": opts.featureSlug } })
    }
  } else {
    appendOptionalFilter(filters, buildUpperOrgLv1ListFilter(opts.orgLv1List))
    if (opts.projectId) filters.push({ term: { "properties.harnessProjectId": opts.projectId } })
    if (opts.featureSlug) {
      filters.push({ term: { "properties.harnessFeatureSlug": opts.featureSlug } })
    }
  }

  if (opts.usedSkillsOnly) filters.push({ exists: { field: "properties.usedSkills" } })
  if (opts.upperOrgLv1 !== null) filters.push(buildOrgLevelMatchFilter(opts.upperOrgLv1))
  if (opts.userKeyword !== null) filters.push(buildCommitUserMatchFilter(opts.userKeyword))

  const raw = (await esQuery(getEsIndex("event"), {
    track_total_hits: true,
    from: (opts.page - 1) * opts.pageSize,
    size: opts.pageSize,
    sort: [
      { "properties.generatedAt": { order: "desc", missing: "_last" } },
      { eventTime: { order: "desc", missing: "_last" } }
    ],
    query: { bool: { filter: filters } },
    _source: { includes: NON_GIT_ADOPTION_REPORT_SOURCE_INCLUDES }
  })) as EsSearchResponse
  const hits = raw.hits?.hits ?? []
  const genById = await fetchCodeGenMetadataForNonGitReports(
    hits
      .map((hit) => asOptionalString(asRecord(asRecord(hit._source).properties).genEventId) ?? "")
      .filter(Boolean)
  )

  return {
    total: getTotalHits(raw, hits.length),
    page: opts.page,
    pageSize: opts.pageSize,
    items: hits.map((hit) => normalizeNonGitAdoptionReport(hit, genById))
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
        skill_source: {
          buckets: [
            {
              key: "plugin:demo-plugin/plugin-release-note-v1.0.0?name=Demo%20Plugin",
              doc_count: 156
            }
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
              inclusive_pushed_adoption_rate: { value: 380 / 790 },
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
              inclusive_pushed_adoption_rate: { value: 340 / 560 },
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
              inclusive_pushed_adoption_rate: { value: 140 / 430 },
              pushed_commit_count: { value: 3 },
              commit_count: { value: 7 }
            },
            {
              key: "plugin-release-note-v1.0.0",
              id: { value: "plugin:demo-plugin/plugin-release-note-v1.0.0" },
              source_ref: {
                value: "plugin:demo-plugin/plugin-release-note-v1.0.0?name=Demo%20Plugin"
              },
              is_plugin: { value: true },
              plugin_name: { value: "Demo Plugin" },
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
              inclusive_pushed_adoption_rate: { value: 180 / 390 },
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
              inclusive_pushed_adoption_rate: { value: 0 },
              pushed_commit_count: { value: 0 },
              commit_count: { value: 0 }
            }
          ]
        },
        code_skill_source: {
          buckets: [
            {
              key: "plugin:demo-plugin/plugin-release-note-v1.0.0?name=Demo%20Plugin",
              doc_count: 9
            }
          ]
        },
        by_tool: {
          buckets: [
            { key: "git_workflow", doc_count: 412 },
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
            { key: "premium", doc_count: 1_178 },
            { key: "economy", doc_count: 69 }
          ]
        },
        by_layer: {
          buckets: [
            { key: "pinned", doc_count: 1_110 },
            { key: "thread", doc_count: 42 },
            { key: "layer2", doc_count: 35 },
            { key: "layer3", doc_count: 31 },
            { key: "layer1", doc_count: 29 }
          ]
        },
        smart_by_tier: {
          doc_count: 137,
          by_tier: {
            buckets: [
              { key: "premium", doc_count: 68 },
              { key: "economy", doc_count: 69 }
            ]
          }
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
    allowedSkillNames,
    true
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
  const generatedLines = count * (5 + (index % 4))
  const measuredGeneratedLines = Math.round(generatedLines * (0.68 + (index % 3) * 0.06))
  const effectiveGeneratedLines = Math.round(measuredGeneratedLines * 0.92)
  const adoptedLines = Math.round(effectiveGeneratedLines * (0.64 + (index % 4) * 0.07))
  const pushedEffectiveGeneratedLines = Math.round(effectiveGeneratedLines * 0.78)
  const pushedAdoptedLines = Math.min(
    pushedEffectiveGeneratedLines,
    Math.round(adoptedLines * 0.72)
  )
  return {
    sapId: `10010${String(index + 1).padStart(3, "0")}`,
    ystId: `2743${String(index + 1).padStart(3, "0")}`,
    userName: names[index % names.length],
    ...org,
    count,
    lastActiveAt: new Date(Date.now() - index * 42 * 60 * 1000).toISOString(),
    avgDurationMs: 4200 + (index % 9) * 650,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    codeStats:
      index % 11 === 10
        ? null
        : makeDashboardCodeStats({
            generatedLines,
            deletedLines: Math.round(generatedLines * 0.08),
            measuredGeneratedLines,
            effectiveGeneratedLines,
            adoptedLines,
            pushedMeasuredGeneratedLines: Math.round(measuredGeneratedLines * 0.8),
            pushedEffectiveGeneratedLines,
            pushedAdoptedLines,
            pushedCommitCount: Math.max(1, Math.round(count / 12))
          })
  }
}

function makeMockUncommittedRanking(options?: UncommittedScopeOptions): UncommittedRankingData {
  const userKeyword = normalizeCommitUserKeyword(options?.userKeyword)?.toLowerCase() ?? ""
  const projectScoped = Boolean(options?.projectId?.trim() || options?.featureSlug?.trim())
  const skillScale = options?.usedSkillsOnly ? 0.62 : 1
  const projectScale = projectScoped ? 0.42 : 1
  let items: UncommittedRankingItem[] = Array.from({ length: 12 }, (_, index) => {
    const user = makeMockDashboardUser(index)
    const generatedLines = Math.round((1800 - index * 110) * skillScale * projectScale)
    const measuredGeneratedLines = Math.round(generatedLines * (0.4 + index * 0.03))
    const uncommittedLines = Math.max(0, generatedLines - measuredGeneratedLines)
    return {
      sapId: user.sapId,
      ystId: user.sapId,
      userName: user.userName,
      orgName: user.orgName,
      upperOrgLv0: user.upperOrgLv0,
      upperOrgLv1: user.upperOrgLv1,
      generatedLines,
      measuredGeneratedLines,
      uncommittedLines,
      uncommittedRate: generatedLines > 0 ? uncommittedLines / generatedLines : null
    }
  })
  if (projectScoped) items = items.slice(0, 8)
  if (userKeyword) {
    items = items.filter((item) =>
      [item.userName, item.sapId, item.ystId, item.orgName, item.upperOrgLv0, item.upperOrgLv1]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(userKeyword))
    )
  }
  items.sort((a, b) => b.uncommittedLines - a.uncommittedLines)
  return {
    items,
    totalGeneratedLines: items.reduce((sum, item) => sum + item.generatedLines, 0),
    totalMeasuredGeneratedLines: items.reduce((sum, item) => sum + item.measuredGeneratedLines, 0),
    totalUncommittedLines: items.reduce((sum, item) => sum + item.uncommittedLines, 0),
    limit: UNCOMMITTED_RANKING_LIMIT
  }
}

function makeMockUncommittedDetail(
  sapId: string,
  options?: UncommittedScopeOptions
): UncommittedDetailData {
  const tools = ["write_file", "str_replace", "edit_file"]
  const langs = ["ts", "tsx", "py", "md", "json"]
  const projectId = options?.projectId?.trim() || undefined
  const featureSlug = options?.featureSlug?.trim() || undefined
  const samples: UncommittedDetailSample[] = Array.from({ length: 48 }, (_, index) => ({
    eventId: `mock_gen_${sapId}_${index}`,
    eventTime: new Date(Date.now() - index * 3_600_000).toISOString(),
    tool: tools[index % tools.length],
    language: langs[index % langs.length],
    lineCount: 40 + (index % 5) * 25,
    fileHint: `module-${index % 6}.${langs[index % langs.length]}`,
    threadId: `thread_${index % 4}`,
    harnessProjectId: projectId ?? (index % 3 === 0 ? `mock-project-${index % 4}` : undefined),
    harnessFeatureSlug: featureSlug ?? (index % 3 === 0 ? `feature-${index % 3}` : undefined),
    modelName: "claude-opus-4-8"
  }))
  const byTool = new Map<string, { gens: number; lines: number }>()
  const byLanguage = new Map<string, { gens: number; lines: number }>()
  const byProject = new Map<string, { gens: number; lines: number }>()
  const byThread = new Map<string, { gens: number; lines: number }>()
  let uncommittedLines = 0
  for (const sample of samples) {
    uncommittedLines += sample.lineCount
    pushBreakdown(byTool, sample.tool || "未知工具", sample.lineCount)
    pushBreakdown(byLanguage, sample.language || "未知语言", sample.lineCount)
    pushBreakdown(
      byProject,
      sample.harnessFeatureSlug || sample.harnessProjectId || "非项目模式",
      sample.lineCount
    )
    if (sample.threadId) pushBreakdown(byThread, sample.threadId, sample.lineCount)
  }
  return {
    sapId,
    userName: sapId,
    scannedGens: 240,
    scanCapped: false,
    uncommittedGens: samples.length,
    uncommittedLines,
    byTool: breakdownToSortedList(byTool, 10),
    byLanguage: breakdownToSortedList(byLanguage, 10),
    byProject: breakdownToSortedList(byProject, 10),
    byThread: breakdownToSortedList(byThread, 10),
    samples
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
  const baseTraceGroups = groupMockTraceDetailsByThread(baseTraces)
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
        return namespaceMockTraceDetails([trace], `mock-trace-${sapId}-${mockIndex}`, {
          sapId,
          ystId: user.ystId,
          userName: user.userName,
          orgName: user.orgName,
          userIp: `10.0.1.${20 + (mockIndex % 200)}`,
          startedAt: () =>
            new Date(new Date(range.to).getTime() - mockIndex * 35 * 60 * 1000).toISOString()
        })[0]
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
      const sourceGroup = baseTraceGroups[threadOrdinal % baseTraceGroups.length]?.traces ?? []
      return namespaceMockTraceDetails(sourceGroup, threadId, {
        sapId,
        ystId: user.ystId,
        userName: user.userName,
        orgName: user.orgName,
        userIp: `10.0.1.${20 + (threadOrdinal % 200)}`,
        startedAt: (traceIndex) =>
          new Date(threadStartMs + traceIndex * 8 * 60 * 1000).toISOString()
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
    totalToolCalls: user.count * (2 + (index % 4)),
    totalInputTokens: user.totalInputTokens,
    totalOutputTokens: user.totalOutputTokens,
    totalTokens: user.totalTokens,
    codeStats: user.codeStats,
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

/** DEV mock helper: split a project's code stats across N features by descending weight. */
function splitMockCodeStatsAcrossFeatures(
  stats: DashboardCodeStats | null,
  count: number
): Array<DashboardCodeStats | null> {
  if (!stats || count <= 0) {
    return Array.from({ length: Math.max(0, count) }, () => null)
  }
  const weights = Array.from({ length: count }, (_, i) => count - i)
  const weightSum = weights.reduce((acc, w) => acc + w, 0)
  return weights.map((weight) => {
    const frac = weight / weightSum
    const scale = (value: number): number => Math.round(value * frac)
    return makeDashboardCodeStats({
      generatedLines: scale(stats.generatedLines),
      deletedLines: scale(stats.deletedLines),
      measuredGeneratedLines: scale(stats.measuredGeneratedLines),
      effectiveGeneratedLines: scale(stats.effectiveGeneratedLines),
      adoptedLines: scale(stats.adoptedLines),
      pushedMeasuredGeneratedLines: scale(stats.pushedMeasuredGeneratedLines),
      pushedEffectiveGeneratedLines: scale(stats.pushedEffectiveGeneratedLines),
      pushedAdoptedLines: scale(stats.pushedAdoptedLines),
      pushedCommitCount: scale(stats.pushedCommitCount)
    })
  })
}

/** DEV mock helper: derive a plausible stage×skill four-bucket split from a row's totals. */
function makeMockStageBuckets(
  codeStats: DashboardCodeStats | null,
  conversationCount: number
): DashboardStageBuckets {
  // Deterministic fractions across [plugin_constrained, vibecoding, unattributed].
  const fractions = [0.45, 0.45, 0.1]
  const [code0, code1, code2] = splitMockCodeStatsAcrossFeatures(codeStats, 3)
  const conv = fractions.map((f) => Math.round(conversationCount * f))
  return {
    pluginConstrained: { conversationCount: conv[0] ?? 0, codeStats: code0 ?? null },
    vibecoding: { conversationCount: conv[1] ?? 0, codeStats: code1 ?? null },
    unattributed: { conversationCount: conv[2] ?? 0, codeStats: code2 ?? null }
  }
}

/** DEV mock helper: deterministic feature telemetry, then merge it to project scope. */
function makeMockFeatureOperationalStats(
  projectId: string,
  featureSlug: string
): ProjectModeOperationalStats {
  const seed = `${projectId}/${featureSlug}`
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  const traceCount = 2 + (hash % 7)
  const successfulReadCount = traceCount * 2 + (hash % 5)
  const preToolUseCount = 3 + (hash % 11)
  const postToolUseCount = 2 + (hash % 7)
  return {
    systemConstraintReads: {
      traceCount,
      successfulReadCount,
      distinctFileCount: 2,
      filesTruncated: false,
      files: [
        { path: "sys/project.md", traceCount },
        { path: `sys/features/${featureSlug}.md`, traceCount: Math.max(1, traceCount - 1) }
      ]
    },
    hookExecutions: {
      executionCount: preToolUseCount + postToolUseCount,
      blockedCount: hash % 3,
      byEvent: [
        { event: "PreToolUse", count: preToolUseCount },
        { event: "PostToolUse", count: postToolUseCount }
      ]
    }
  }
}

/** DEV mock for the lazy detail endpoint; deliberately long enough to exercise both scroll areas. */
function makeMockProjectModeOperationalDetails(
  scope: ProjectModeOperationalDetailScope
): ProjectModeOperationalDetails {
  const scopeSeed = [scope.projectId, scope.featureSlug, scope.nodeName].filter(Boolean).join("/")
  const constraintFiles: ProjectModeConstraintFileStat[] = [
    { path: "sys/project.md", traceCount: 13 },
    ...Array.from({ length: 17 }, (_, index) => ({
      path: `sys/rules/${String(index + 1).padStart(2, "0")}-${scopeSeed || "project"}.md`,
      traceCount: Math.max(1, 12 - (index % 12))
    }))
  ]
  const hookEvents = [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "Notification"
  ].map((event, index) => ({ event, count: Math.max(1, 21 - index * 2) }))
  return { constraintFiles, hookEvents }
}

function mergeMockOperationalStats(
  items: Array<Pick<ProjectModeFeatureView, "systemConstraintReads" | "hookExecutions">>
): ProjectModeOperationalStats {
  const constraints = items
    .map((item) => item.systemConstraintReads)
    .filter((item): item is ProjectModeConstraintReadStats => Boolean(item))
  const hooks = items
    .map((item) => item.hookExecutions)
    .filter((item): item is ProjectModeHookStats => Boolean(item))

  const files = new Map<string, number>()
  for (const constraint of constraints) {
    for (const file of constraint.files) {
      files.set(file.path, (files.get(file.path) ?? 0) + file.traceCount)
    }
  }
  const hookEvents = new Map<string, number>()
  for (const hook of hooks) {
    for (const event of hook.byEvent) {
      hookEvents.set(event.event, (hookEvents.get(event.event) ?? 0) + event.count)
    }
  }

  return {
    systemConstraintReads:
      constraints.length > 0
        ? {
            traceCount: constraints.reduce((sum, item) => sum + item.traceCount, 0),
            successfulReadCount: constraints.reduce(
              (sum, item) => sum + item.successfulReadCount,
              0
            ),
            distinctFileCount: files.size,
            filesTruncated: constraints.some((item) => item.filesTruncated),
            files: [...files.entries()]
              .map(([path, traceCount]) => ({ path, traceCount }))
              .sort((a, b) => b.traceCount - a.traceCount || a.path.localeCompare(b.path))
          }
        : null,
    hookExecutions:
      hooks.length > 0
        ? {
            executionCount: hooks.reduce((sum, item) => sum + item.executionCount, 0),
            blockedCount: hooks.reduce((sum, item) => sum + item.blockedCount, 0),
            byEvent: [...hookEvents.entries()]
              .map(([event, count]) => ({ event, count }))
              .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event))
          }
        : null
  }
}

function makeMockProjectMode(range: TimeRange, opts?: OrgFilterOptions): DashboardProjectModeData {
  // stageBuckets is derived from each draft's totals after assembly (see below).
  const projectDrafts: Array<
    Omit<
      ProjectModeProjectView,
      "stageBuckets" | "devStageConversationCount" | "devAssociatedFeatureCount"
    >
  > = [
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
      systemConstraintEverLoadedSuccessfully: true,
      featureCount: 3,
      conversationCount: 128,
      hasError: false,
      topSkills: [
        { skill: "代码审查", count: 40 },
        { skill: "单元测试", count: 25 },
        { skill: "SQL优化", count: 12, isPlugin: true, pluginName: "SQL Copilot" }
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
      systemConstraintEverLoadedSuccessfully: false,
      featureCount: 2,
      conversationCount: 47,
      hasError: false,
      topSkills: [
        { skill: "代码审查", count: 18 },
        { skill: "重构助手", count: 9, isPlugin: true, pluginName: "Refactor Kit" }
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
      systemConstraintEverLoadedSuccessfully: false,
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
      systemConstraintEverLoadedSuccessfully: true,
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
    projectDrafts.push({
      projectId: `proj-demo-${i}`,
      name: `示例项目 ${i}`,
      systemName: "示例平台",
      adapterName: "claude-code",
      adapterVersion: "1.4.2",
      lifecycleStatus: "active",
      compatible: true,
      compatibilityStatus: "compatible",
      systemConstraintEverLoadedSuccessfully: i % 2 === 0,
      featureCount: (i % 3) + 1,
      conversationCount: (i * 7) % 90,
      hasError: false,
      topSkills: [
        {
          skill: i % 2 === 0 ? "重构助手" : "代码审查",
          count: (i * 3) % 20,
          ...(i % 2 === 0 ? { isPlugin: true, pluginName: "Refactor Kit" } : {})
        }
      ],
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
  // DEV：把项目级采纳明细按递减权重拆到各特性，让「下沉到 feature 级别」的采纳率/生成行数有 mock 数据可看。
  for (const project of projectDrafts) {
    const featureStats = splitMockCodeStatsAcrossFeatures(
      project.codeStats,
      project.features.length
    )
    project.features.forEach((feature, idx) => {
      feature.codeStats = featureStats[idx]
      const operational = makeMockFeatureOperationalStats(project.projectId, feature.slug)
      feature.systemConstraintReads = operational.systemConstraintReads
      feature.hookExecutions = operational.hookExecutions
    })
    const projectOperational = mergeMockOperationalStats(project.features)
    project.systemConstraintReads = projectOperational.systemConstraintReads
    project.hookExecutions = projectOperational.hookExecutions
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
  projectDrafts.forEach((project, index) => {
    Object.assign(project, mockCreators[index % mockCreators.length])
  })
  // 由各项目自身的代码/对话总量派生 stage×skill 三桶（DEV 演示用）。
  const allProjects: ProjectModeProjectView[] = projectDrafts.map((project, index) => {
    const devStageConversationCount = Math.round(project.conversationCount * 0.4)
    return {
      ...project,
      suspectedTechnicalDetailConversationCount: Math.round(project.conversationCount * 0.35),
      devStageConversationCount,
      devAssociatedFeatureCount:
        devStageConversationCount > 0
          ? Math.min(project.featureCount, Math.max(1, Math.ceil(devStageConversationCount / 10)))
          : 0,
      lifecycleCreatedAt:
        project.lifecycleCreatedAt ??
        new Date(Date.UTC(2026, 5, Math.max(1, 28 - index), 2, 0, 0)).toISOString(),
      stageBuckets: makeMockStageBuckets(project.codeStats, project.conversationCount)
    }
  })
  // 「室筛选」：按下标分配的室过滤项目列表，使 mock 下切换室也能真实改变数据。
  const selectedOrgs = normalizeUpperOrgLv1List(opts?.upperOrgLv1)
  // DEV：把偶数下标的 mock 项目视为「精益项目」，让「仅精益项目」开关在无 ES 时也能可见地筛选。
  const leanOnly = opts?.fromLeanOnly === true
  const orgProjects = allProjects.filter((_, i) =>
    mockProjectMatchesOrg(mockProjectOrgAt(i), selectedOrgs)
  )
  const projects = allProjects.filter(
    (_, i) => mockProjectMatchesOrg(mockProjectOrgAt(i), selectedOrgs) && (!leanOnly || i % 2 === 0)
  )
  // 写死的聚合块（token/工具/技能/采纳明细/漏斗）不是从项目列表算出来的，真实 ES 路径会按精益 id 集
  // 过滤这些块；mock 没有明细，故用「精益项目占比」整体缩放，让开关在 dev 里整屏联动而非只动计数卡片。
  const leanScale = orgProjects.length > 0 ? projects.length / orgProjects.length : 1
  // 聚合块（token/工具/技能/采纳明细等）按室权重缩放，与其它面板口径一致；叠加精益占比。
  const aggScale = getMockOrgScale(opts) * leanScale
  const featureCount = projects.reduce((sum, p) => sum + p.featureCount, 0)
  const conversationCount = projects.reduce((sum, p) => sum + p.conversationCount, 0)
  const activeProjectCount = projects.filter((p) => p.conversationCount > 0).length
  const projectCounts = buildProjectModeProjectCounts(projects)
  const projectPage = makeMockProjectModeProjectPage(projects, {
    status: "active",
    page: 1,
    pageSize: PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE,
    keyword: "",
    sortBy: "createdAt",
    sortOrder: "desc"
  })
  const summaryCodeStats = makeDashboardCodeStats({
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
      codeStats: summaryCodeStats,
      // 由 Skill 生成的代码（整体的子集，约六成）。
      skillCodeStats: makeDashboardCodeStats({
        generatedLines: scaleMockMetricNumber(4600, aggScale),
        deletedLines: scaleMockMetricNumber(700, aggScale),
        measuredGeneratedLines: scaleMockMetricNumber(4200, aggScale),
        effectiveGeneratedLines: scaleMockMetricNumber(3700, aggScale),
        adoptedLines: scaleMockMetricNumber(2700, aggScale),
        pushedMeasuredGeneratedLines: scaleMockMetricNumber(3500, aggScale),
        pushedEffectiveGeneratedLines: scaleMockMetricNumber(3100, aggScale),
        pushedAdoptedLines: scaleMockMetricNumber(2300, aggScale),
        pushedCommitCount: scaleMockMetricNumber(34, aggScale)
      })
    },
    adapters: deepScaleMockMetrics(
      (
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
        ] as Array<Omit<ProjectModeAdapterView, "stageBuckets">>
      ).map((adapter) => ({
        ...adapter,
        stageBuckets: makeMockStageBuckets(adapter.codeStats, adapter.conversationCount)
      })),
      aggScale
    ),
    topSkills: deepScaleMockMetrics(
      [
        { skill: "代码审查", count: 58 },
        { skill: "单元测试", count: 31 },
        { skill: "重构助手", count: 22, isPlugin: true, pluginName: "Refactor Kit" },
        { skill: "SQL优化", count: 15, isPlugin: true, pluginName: "SQL Copilot" }
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
          isPlugin: true,
          pluginName: "Refactor Kit",
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
    projects,
    // Mock filters the in-memory project list directly, so it is never id-cap truncated.
    leanTruncated: false,
    // 让 dev 模式下「生产效能代码指标」的 source 下拉有候选可选，便于联调 UI。
    availableSources: ["tag-platform", "data-platform"]
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

function makeMockProjectModeExportData(
  range: TimeRange,
  opts?: OrgFilterOptions
): ProjectModeExportData {
  const mock = makeMockProjectMode(range, opts)
  const archivedProjectTotal = mock.projects.filter(
    (project) => project.lifecycleStatus === "archived"
  ).length
  return {
    users: mock.analytics.topUsers,
    projects: mock.projects,
    projectTotal: mock.projects.length,
    activeProjectTotal: mock.projects.length - archivedProjectTotal,
    archivedProjectTotal,
    projectLimit: PROJECT_MODE_EXPORT_PROJECT_LIMIT,
    projectsTruncated: false
  }
}

const MOCK_PROJECT_THREAD_NODE_NAMES = [
  "Biz-需求分析",
  "Dev-行为规格",
  "Dev-代码实现",
  "Dev-单元测试"
]

/** Attach deterministic project-node attribution so the thread restore UI is testable in DEV. */
function attributeMockProjectThreadTraces(
  traces: DashboardTraceDetail[],
  projectId: string
): DashboardTraceDetail[] {
  const attributionByTraceId = new Map<
    string,
    { featureSlug: string; nodeName: string; nodeStatus: string }
  >()
  for (const [groupIndex, group] of groupMockTraceDetailsByThread(traces).entries()) {
    group.traces.forEach((trace, traceIndex) => {
      attributionByTraceId.set(trace.traceId, {
        featureSlug: `mock-feature-${groupIndex + 1}`,
        nodeName:
          MOCK_PROJECT_THREAD_NODE_NAMES[
            Math.min(traceIndex, MOCK_PROJECT_THREAD_NODE_NAMES.length - 1)
          ],
        nodeStatus:
          traceIndex < group.traces.length - 1 ? STAGE_DONE_LABEL : STAGE_IN_PROGRESS_LABEL
      })
    })
  }

  return traces.map((trace) => {
    const attribution = attributionByTraceId.get(trace.traceId)
    if (!attribution) return trace
    return {
      ...trace,
      harnessProjectId: projectId,
      harnessFeatureSlug: trace.harnessFeatureSlug ?? attribution.featureSlug,
      harnessNodeName: trace.harnessNodeName ?? attribution.nodeName,
      harnessNodeStatus: trace.harnessNodeStatus ?? attribution.nodeStatus
    }
  })
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
  const traces = attributeMockProjectThreadTraces(
    namespaceMockTraceDetails(makeMockSkillRecentTraces("项目模式", range, 10), projectId),
    projectId
  )

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

  const groups = groupMockTraceDetailsByThread(traces)
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

type MockTraceToolCall = AgentTrace["steps"][number]["toolCalls"][number]

function makeMockTraceWithConversation(args: {
  traceId: string
  threadId: string
  startedAt: Date
  durationMs: number
  userMessage: string
  assistantSummary: string
  initialReasoning?: string
  finalReasoning?: string
  toolCalls: MockTraceToolCall[]
  skill: string
  userIndex: number
  outcome?: AgentTrace["outcome"]
  errorMessage?: string
  observability?: Partial<
    Pick<
      AgentTrace,
      | "observabilitySchemaVersion"
      | "traceKind"
      | "executionMode"
      | "rootTraceId"
      | "rootThreadId"
      | "parentTraceId"
      | "parentThreadId"
      | "parentSpanId"
      | "linkType"
      | "subagentKind"
      | "subagentRunId"
      | "subagentThreadId"
      | "handoffAction"
      | "handoffSourceAgent"
      | "handoffTargetAgent"
      | "coordinatorWorkerId"
      | "coordinatorWorkerTurn"
      | "coordinatorWorkerRole"
      | "coordinatorWorkerWorkload"
      | "workflowRunId"
      | "workflowAgentIndex"
      | "workflowPhase"
      | "workflowAgentLabel"
    >
  >
}): AgentTrace {
  const endedAt = new Date(args.startedAt.getTime() + args.durationMs)
  const midpoint = Math.ceil(args.toolCalls.length / 2)
  const outcome = args.outcome ?? "success"
  const initialAssistantText = isSubagentMockTrace(args.observability)
    ? "我会按父 Agent 交付的子任务独立完成工具调用，并在结束时回传结果。"
    : "我会先拆解任务，再把需要交给子 Agent 的部分分派出去。"
  const finalStartedAt = new Date(Math.max(args.startedAt.getTime(), endedAt.getTime() - 1_000))
  const totalInputTokens = 3200 + args.userIndex * 420
  const totalOutputTokens = 900 + args.userIndex * 130
  const firstInputTokens = Math.floor(totalInputTokens * 0.55)
  const firstOutputTokens = Math.floor(totalOutputTokens * 0.25)

  return {
    traceId: args.traceId,
    threadId: args.threadId,
    observabilitySchemaVersion: TRACE_OBSERVABILITY_SCHEMA_VERSION,
    traceKind: "root",
    executionMode: "normal",
    rootTraceId: args.traceId,
    rootThreadId: args.threadId,
    ...(args.observability ?? {}),
    startedAt: args.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: args.durationMs,
    userMessage: args.userMessage,
    modelId: "custom:minmax2.7",
    modelName: "MiniMax-M2.7",
    userName: ["张三", "李四", "王五"][args.userIndex % 3] ?? "张三",
    sapId: `1001000${(args.userIndex % 8) + 1}`,
    ystId: `27435${(args.userIndex % 8) + 1}`,
    orgName: ["科技部", "零售一部", "风险管理部"][args.userIndex % 3] ?? "科技部",
    userIp: `10.0.0.${20 + args.userIndex}`,
    steps: [
      {
        index: 0,
        startedAt: args.startedAt.toISOString(),
        assistantText: initialAssistantText,
        toolCalls: args.toolCalls.slice(0, midpoint)
      },
      {
        index: 1,
        startedAt: finalStartedAt.toISOString(),
        assistantText: args.assistantSummary,
        toolCalls: args.toolCalls.slice(midpoint)
      }
    ],
    modelCalls: [
      {
        messageId: `mock-message-${args.traceId}-dispatch`,
        startedAt: args.startedAt.toISOString(),
        inputMessages: [{ role: "user", content: args.userMessage }],
        outputMessage: {
          role: "assistant",
          content: initialAssistantText,
          ...(args.initialReasoning ? { reasoning: args.initialReasoning } : {})
        },
        toolCalls: args.toolCalls.slice(0, midpoint),
        tokenUsage: {
          inputTokens: firstInputTokens,
          outputTokens: firstOutputTokens,
          totalTokens: firstInputTokens + firstOutputTokens
        }
      },
      {
        messageId: `mock-message-${args.traceId}-final`,
        startedAt: finalStartedAt.toISOString(),
        inputMessages: [{ role: "user", content: args.userMessage }],
        outputMessage: {
          role: "assistant",
          content: args.assistantSummary,
          ...(args.finalReasoning ? { reasoning: args.finalReasoning } : {})
        },
        toolCalls: args.toolCalls.slice(midpoint),
        tokenUsage: {
          inputTokens: totalInputTokens - firstInputTokens,
          outputTokens: totalOutputTokens - firstOutputTokens,
          totalTokens: totalInputTokens - firstInputTokens + totalOutputTokens - firstOutputTokens
        }
      }
    ],
    totalToolCalls: args.toolCalls.length,
    outcome,
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    appVersion: ["1.4.5", "1.4.4"][args.userIndex % 2] ?? "1.4.5",
    usedSkills: [args.skill],
    evolvedSkills: args.userIndex % 2 === 0 ? [args.skill] : [],
    triggerSource: "chat",
    metadata: {
      workspacePath: "/Users/demo/projects/cmbCowork"
    }
  }
}

function isSubagentMockTrace(observability: Partial<AgentTrace> | undefined): boolean {
  return observability?.traceKind === "subagent" || Boolean(observability?.subagentKind)
}

function makeMockDashboardTraceDetail(trace: AgentTrace, index: number): DashboardTraceDetail {
  return {
    ...traceToDashboardTraceDetail(trace),
    sapId: trace.sapId ?? `100100${String(index + 1).padStart(2, "0")}`,
    ystId: trace.ystId ?? `2743${String(50 + index).padStart(2, "0")}`,
    userName: trace.userName ?? ["张三", "李四", "王五"][index % 3],
    orgName: trace.orgName ?? ["测试 1 组", "测试 2 组", "开发三组"][index % 3],
    userIp: trace.userIp ?? `10.0.0.${20 + index}`
  }
}

function mockTraceGroupKey(trace: Pick<DashboardTraceDetail, "rootThreadId" | "threadId">): string {
  return trace.rootThreadId || trace.threadId || "unknown-thread"
}

function namespaceMockTraceDetails(
  traces: DashboardTraceDetail[],
  namespace: string,
  overrides?: Partial<Pick<DashboardTraceDetail, "sapId" | "ystId" | "userName" | "orgName">> & {
    userIp?: string | ((index: number, trace: DashboardTraceDetail) => string)
    startedAt?: (index: number, trace: DashboardTraceDetail) => string
  }
): DashboardTraceDetail[] {
  const traceIds = new Map<string, string>()
  const threadIds = new Map<string, string>()
  const mapTraceId = (id: string): string => {
    const existing = traceIds.get(id)
    if (existing) return existing
    const next = `${namespace}-${traceIds.size}-${id}`
    traceIds.set(id, next)
    return next
  }
  const mapThreadId = (id: string): string => {
    const existing = threadIds.get(id)
    if (existing) return existing
    const next = `${namespace}-${id}`
    threadIds.set(id, next)
    return next
  }

  for (const trace of traces) {
    mapTraceId(trace.traceId)
    mapThreadId(trace.threadId)
    if (trace.rootTraceId) mapTraceId(trace.rootTraceId)
    if (trace.parentTraceId) mapTraceId(trace.parentTraceId)
    if (trace.rootThreadId) mapThreadId(trace.rootThreadId)
    if (trace.parentThreadId) mapThreadId(trace.parentThreadId)
    if (trace.subagentThreadId) mapThreadId(trace.subagentThreadId)
  }

  return traces.map((trace, index) => ({
    ...trace,
    traceId: mapTraceId(trace.traceId),
    threadId: mapThreadId(trace.threadId),
    ...(trace.rootTraceId ? { rootTraceId: mapTraceId(trace.rootTraceId) } : {}),
    ...(trace.parentTraceId ? { parentTraceId: mapTraceId(trace.parentTraceId) } : {}),
    ...(trace.rootThreadId ? { rootThreadId: mapThreadId(trace.rootThreadId) } : {}),
    ...(trace.parentThreadId ? { parentThreadId: mapThreadId(trace.parentThreadId) } : {}),
    ...(trace.subagentThreadId ? { subagentThreadId: mapThreadId(trace.subagentThreadId) } : {}),
    ...(overrides?.startedAt ? { startedAt: overrides.startedAt(index, trace) } : {}),
    ...(overrides?.sapId ? { sapId: overrides.sapId } : {}),
    ...(overrides?.ystId ? { ystId: overrides.ystId } : {}),
    ...(overrides?.userName ? { userName: overrides.userName } : {}),
    ...(overrides?.orgName ? { orgName: overrides.orgName } : {}),
    ...(typeof overrides?.userIp === "function"
      ? { userIp: overrides.userIp(index, trace) }
      : overrides?.userIp
        ? { userIp: overrides.userIp }
        : {})
  }))
}

function groupMockTraceDetailsByThread(
  traces: DashboardTraceDetail[]
): Array<{ threadId: string; latestStartedAt: string; traces: DashboardTraceDetail[] }> {
  const grouped = new Map<string, DashboardTraceDetail[]>()
  for (const trace of traces) {
    const threadId = mockTraceGroupKey(trace)
    grouped.set(threadId, [...(grouped.get(threadId) ?? []), trace])
  }
  return [...grouped.entries()]
    .map(([threadId, threadTraces]) => {
      const sorted = [...threadTraces].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      const latestStartedAt = sorted.reduce(
        (latest, trace) => (trace.startedAt > latest ? trace.startedAt : latest),
        sorted[0]?.startedAt ?? ""
      )
      return { threadId, latestStartedAt, traces: sorted }
    })
    .sort((a, b) => b.latestStartedAt.localeCompare(a.latestStartedAt))
}

function findMockThreadGroupForThreadId(
  groups: Array<{ threadId: string; traces: DashboardTraceDetail[] }>,
  threadId: string
): { threadId: string; traces: DashboardTraceDetail[] } | undefined {
  return groups.find((group) => threadId === group.threadId || threadId.endsWith(group.threadId))
}

function namespaceMockThreadGroupForRequest(
  traces: DashboardTraceDetail[],
  requestedRootThreadId: string
): DashboardTraceDetail[] {
  return namespaceMockTraceDetails(traces, requestedRootThreadId).map((trace) => {
    const isRootTrace = trace.traceKind !== "subagent" && !trace.parentTraceId
    return {
      ...trace,
      rootThreadId: requestedRootThreadId,
      ...(isRootTrace ? { threadId: requestedRootThreadId } : {}),
      ...(trace.parentThreadId ? { parentThreadId: requestedRootThreadId } : {}),
      ...(trace.subagentThreadId ? { subagentThreadId: trace.threadId } : {})
    }
  })
}

function makeMockSubagentSessionTraces(skill: string, range: TimeRange): AgentTrace[] {
  const to = new Date(range.to)
  const baseStart = to.getTime() - 18 * 60 * 1000
  const isoStart = (offsetMs: number): Date => new Date(baseStart + offsetMs)

  const teamRootTraceId = "mock-root-agent-team-trace"
  const teamRootThreadId = "mock-root-agent-team-thread"
  const workflowRootTraceId = "mock-root-ultra-workflow-trace"
  const workflowRootThreadId = "mock-root-ultra-workflow-thread"
  const taskRootTraceId = "mock-root-task-agent-trace"
  const taskRootThreadId = "mock-root-task-agent-thread"

  return [
    makeMockTraceWithConversation({
      traceId: teamRootTraceId,
      threadId: teamRootThreadId,
      startedAt: isoStart(0),
      durationMs: 96_000,
      skill,
      userIndex: 0,
      userMessage: "用 Agent Team 模式优化运营面板 trace 会话展示，并让 worker 写一个最小改动。",
      assistantSummary:
        "我已启动实现 Worker 和校验 Verifier：实现 Worker 负责补展示字段，Verifier 检查 thread 聚合和工具调用统计。",
      initialReasoning:
        "这项任务同时涉及展示与统计口径，适合拆给实现 Worker 和校验 Verifier 并行处理。",
      finalReasoning:
        "两个 Worker 的职责已经分开，主 Agent 只需要汇总各自结果并保持同一 root thread 关联。",
      toolCalls: [
        {
          name: "start_worker",
          args: { role: "implementer", workload: "write", workerId: "frontend" },
          result: "worker frontend 已启动",
          durationMs: 420
        },
        {
          name: "start_worker",
          args: { role: "verifier", workload: "verify", workerId: "reviewer" },
          result: "worker reviewer 已启动",
          durationMs: 390
        }
      ],
      observability: {
        traceKind: "root",
        executionMode: "coordinator",
        rootTraceId: teamRootTraceId,
        rootThreadId: teamRootThreadId
      }
    }),
    makeMockTraceWithConversation({
      traceId: "mock-agent-team-worker-frontend-trace",
      threadId: "mock-agent-team-worker-frontend-thread",
      startedAt: isoStart(2 * 60 * 1000),
      durationMs: 122_000,
      skill,
      userIndex: 1,
      userMessage: "实现 Worker：补齐 TraceHistoryDialog 中子 Agent 展示 mock，并保持主会话收束。",
      assistantSummary:
        "实现完成：子 Agent trace 会以 Worker frontend 标签出现，并通过 rootThreadId 回到主会话。",
      finalReasoning:
        "展示所需字段已经存在，最小改动是补齐 mock 的父子关联，而不是改动 thread 聚合规则。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "src/renderer/src/components/dashboard/TraceHistoryDialog.tsx" },
          result: "读取子 Agent 标签和 thread 分组逻辑",
          durationMs: 260
        },
        {
          name: "edit_file",
          args: { path: "src/main/ipc/dashboard.ts", summary: "补 mock 子 Agent trace 字段" },
          result: "写入 rootTraceId/rootThreadId/parentTraceId/subagentKind",
          durationMs: 980
        },
        {
          name: "execute",
          args: { command: "npm run typecheck:node" },
          result: "typecheck:node passed",
          durationMs: 3600
        }
      ],
      observability: {
        traceKind: "subagent",
        executionMode: "coordinator",
        rootTraceId: teamRootTraceId,
        rootThreadId: teamRootThreadId,
        parentTraceId: teamRootTraceId,
        parentThreadId: teamRootThreadId,
        parentSpanId: "trace:root",
        linkType: "async_span_link",
        subagentKind: "coordinator_worker",
        subagentRunId: "frontend:turn:1",
        subagentThreadId: "mock-agent-team-worker-frontend-thread",
        handoffAction: "start_worker",
        handoffSourceAgent: "coordinator",
        handoffTargetAgent: "frontend",
        coordinatorWorkerId: "frontend",
        coordinatorWorkerTurn: 1,
        coordinatorWorkerRole: "implementer",
        coordinatorWorkerWorkload: "write"
      }
    }),
    makeMockTraceWithConversation({
      traceId: "mock-agent-team-worker-reviewer-trace",
      threadId: "mock-agent-team-worker-reviewer-thread",
      startedAt: isoStart(5 * 60 * 1000),
      durationMs: 78_000,
      skill,
      userIndex: 2,
      userMessage: "Verifier Worker：复核实现 Worker 的改动是否会破坏旧 mock 和 thread 分页。",
      assistantSummary:
        "复核通过：主会话左侧显示子 2，工具调用汇总包含两个 worker，未发现分页口径回退。",
      toolCalls: [
        {
          name: "rg",
          args: { pattern: "rootThreadId|subagentKind", path: "src/main/ipc/dashboard.ts" },
          result: "命中 mock 与真实归一化路径",
          durationMs: 180
        },
        {
          name: "execute",
          args: { command: "npx tsx tests/dashboard-root-thread-observability.spec.ts" },
          result: "PASS dashboard root-thread mock observability",
          durationMs: 1200
        }
      ],
      observability: {
        traceKind: "subagent",
        executionMode: "coordinator",
        rootTraceId: teamRootTraceId,
        rootThreadId: teamRootThreadId,
        parentTraceId: teamRootTraceId,
        parentThreadId: teamRootThreadId,
        parentSpanId: "trace:root",
        linkType: "async_span_link",
        subagentKind: "coordinator_worker",
        subagentRunId: "reviewer:turn:1",
        subagentThreadId: "mock-agent-team-worker-reviewer-thread",
        handoffAction: "start_worker",
        handoffSourceAgent: "coordinator",
        handoffTargetAgent: "reviewer",
        coordinatorWorkerId: "reviewer",
        coordinatorWorkerTurn: 1,
        coordinatorWorkerRole: "verifier",
        coordinatorWorkerWorkload: "verify"
      }
    }),
    makeMockTraceWithConversation({
      traceId: workflowRootTraceId,
      threadId: workflowRootThreadId,
      startedAt: isoStart(9 * 60 * 1000),
      durationMs: 72_000,
      skill,
      userIndex: 3,
      userMessage:
        "用 Ultra Workflow 模式走一遍需求拆解、实现和验证，并展示 workflow agent trace。",
      assistantSummary:
        "Ultra Workflow 已启动：规划、实现、验证三个阶段会以 workflow agent 子 trace 回挂到同一个 root thread。",
      toolCalls: [
        {
          name: "launch_workflow",
          args: { workflowRunId: "wf-smoke-001", phases: ["Plan", "Dev", "Verify"] },
          result: "workflow run wf-smoke-001 started",
          durationMs: 640
        }
      ],
      observability: {
        traceKind: "root",
        executionMode: "workflow",
        rootTraceId: workflowRootTraceId,
        rootThreadId: workflowRootThreadId,
        workflowRunId: "wf-smoke-001"
      }
    }),
    makeMockTraceWithConversation({
      traceId: "mock-ultra-workflow-dev-agent-trace",
      threadId: "mock-ultra-workflow-dev-agent-thread",
      startedAt: isoStart(11 * 60 * 1000),
      durationMs: 134_000,
      skill,
      userIndex: 4,
      userMessage: "Workflow Agent：在 Dev-代码实现 阶段补 trace mock 数据。",
      assistantSummary:
        "Dev Agent 已完成实现：写入 mock trace 组，展示为 Workflow Agent Dev-代码实现，并保留 phase 标签。",
      initialReasoning:
        "需要复用真实 workflow agent 的字段结构，才能同时验证 phase 标签与父子 trace 归并。",
      finalReasoning: "mock 已沿用真实字段结构，展示层无需为 DEV 数据增加特殊判断。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "src/main/ipc/dashboard.ts" },
          result: "定位 makeMockProjectModeTraces 和 makeMockSkillRecentTraces",
          durationMs: 300
        },
        {
          name: "edit_file",
          args: { path: "src/main/ipc/dashboard.ts", summary: "新增 workflow agent mock trace" },
          result: "写入 workflowRunId/workflowPhase/workflowAgentLabel",
          durationMs: 1140
        },
        {
          name: "execute",
          args: { command: "npm run typecheck:web" },
          result: "typecheck:web passed",
          durationMs: 4100
        }
      ],
      observability: {
        traceKind: "subagent",
        executionMode: "workflow",
        rootTraceId: workflowRootTraceId,
        rootThreadId: workflowRootThreadId,
        parentTraceId: workflowRootTraceId,
        parentThreadId: workflowRootThreadId,
        parentSpanId: "workflow:launch",
        linkType: "async_span_link",
        subagentKind: "workflow_agent",
        subagentRunId: "wf-smoke-001:a1",
        subagentThreadId: "mock-ultra-workflow-dev-agent-thread",
        handoffAction: "workflow_agent",
        handoffSourceAgent: "ultra_workflow",
        handoffTargetAgent: "Dev-代码实现",
        workflowRunId: "wf-smoke-001",
        workflowAgentIndex: 1,
        workflowPhase: "Dev-代码实现",
        workflowAgentLabel: "Dev 实现 Agent"
      }
    }),
    makeMockTraceWithConversation({
      traceId: "mock-ultra-workflow-verify-agent-trace",
      threadId: "mock-ultra-workflow-verify-agent-thread",
      startedAt: isoStart(14 * 60 * 1000),
      durationMs: 64_000,
      skill,
      userIndex: 5,
      userMessage: "Workflow Agent：在 Verify-质量门禁 阶段检查展示效果。",
      assistantSummary:
        "Verify Agent 已确认：Thread 对话还原显示主 1 / 子 2，工具调用总数来自 root + workflow agents。",
      toolCalls: [
        {
          name: "execute",
          args: { command: "npx tsx tests/subagent-tool-call-count-observability.spec.ts" },
          result: "PASS workflow subagent toolCallCount wiring",
          durationMs: 980
        }
      ],
      observability: {
        traceKind: "subagent",
        executionMode: "workflow",
        rootTraceId: workflowRootTraceId,
        rootThreadId: workflowRootThreadId,
        parentTraceId: workflowRootTraceId,
        parentThreadId: workflowRootThreadId,
        parentSpanId: "workflow:launch",
        linkType: "async_span_link",
        subagentKind: "workflow_agent",
        subagentRunId: "wf-smoke-001:a2",
        subagentThreadId: "mock-ultra-workflow-verify-agent-thread",
        handoffAction: "workflow_agent",
        handoffSourceAgent: "ultra_workflow",
        handoffTargetAgent: "Verify-质量门禁",
        workflowRunId: "wf-smoke-001",
        workflowAgentIndex: 2,
        workflowPhase: "Verify-质量门禁",
        workflowAgentLabel: "Verify 校验 Agent"
      }
    }),
    makeMockTraceWithConversation({
      traceId: taskRootTraceId,
      threadId: taskRootThreadId,
      startedAt: isoStart(17 * 60 * 1000),
      durationMs: 52_000,
      skill,
      userIndex: 6,
      userMessage: "用 deepagents task 子 Agent 读取代码并给出一句摘要。",
      assistantSummary: "Task 子 Agent 已完成读取和摘要，结果会作为 Task Agent 子 trace 展示。",
      toolCalls: [
        {
          name: "task",
          args: { description: "读取 TraceConversation 并摘要" },
          result: "task agent completed",
          durationMs: 560
        }
      ],
      observability: {
        traceKind: "root",
        executionMode: "normal",
        rootTraceId: taskRootTraceId,
        rootThreadId: taskRootThreadId
      }
    }),
    makeMockTraceWithConversation({
      traceId: "mock-task-agent-child-trace",
      threadId: "mock-task-agent-child-thread",
      // A Solo task is synchronous: it starts after the root task call and
      // completes before the root Agent can emit its final reply.
      startedAt: isoStart(17 * 60 * 1000 + 5_000),
      durationMs: 45_000,
      skill,
      userIndex: 7,
      userMessage: "Task Agent：读取 TraceConversation 并返回摘要。",
      assistantSummary:
        "已读取组件：对话还原会按角色展示用户、助手和工具调用，并显示 parent/root 标签。",
      finalReasoning:
        "Solo Task 是同步子调用，子 Agent 结果应嵌在 task 工具调用位置，并保留可展开的思考摘要。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "src/renderer/src/components/trace/TraceConversation.tsx" },
          result: "读取到 TraceThreadConversation 和 TraceContextPills",
          durationMs: 300
        }
      ],
      observability: {
        traceKind: "subagent",
        executionMode: "normal",
        rootTraceId: taskRootTraceId,
        rootThreadId: taskRootThreadId,
        parentTraceId: taskRootTraceId,
        parentThreadId: taskRootThreadId,
        parentSpanId: "tool:task",
        linkType: "parent_child",
        subagentKind: "task",
        subagentRunId: "task:trace-summary",
        subagentThreadId: "mock-task-agent-child-thread",
        handoffAction: "task",
        handoffSourceAgent: "main",
        handoffTargetAgent: "task"
      }
    })
  ]
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
  const baseToolCalls =
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
  // 每条 mock trace 追加 1~3 次 request_user_input（向用户提问），让「请求用户输入」指标可见。
  const userInputPrompts = [
    "需要确认工具卡片放在对话上方还是下方？",
    "是否同时调整 Trace 模式的分页上限？",
    "导出会话记录时要不要包含执行树？"
  ]
  const userInputToolCalls = Array.from({ length: (index % 3) + 1 }, (_, askIndex) => ({
    name: "request_user_input",
    args: { prompt: userInputPrompts[askIndex % userInputPrompts.length] },
    result: "用户已回复确认",
    durationMs: 12_000 + askIndex * 3_000
  }))
  const toolCalls = [...baseToolCalls, ...userInputToolCalls]

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
          content: assistantSummary,
          ...(index % 2 === 0
            ? {
                reasoning: "先结合用户目标和已读取的代码定位关键路径，再给出可验证、可执行的结论。"
              }
            : {})
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
    appVersion: ["1.4.4", "1.4.3"][index % 2] ?? "1.4.4",
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
  const count = clampLimit(limit, 10, 10)
  const linkedTraces = makeMockSubagentSessionTraces(skill, range)
  const ordinaryTraces = Array.from(
    { length: Math.max(0, count - linkedTraces.length) },
    (_, index) => makeMockAgentTrace(skill, range, index + linkedTraces.length)
  )
  return [...linkedTraces, ...ordinaryTraces]
    .slice(0, count)
    .map((trace, index) => makeMockDashboardTraceDetail(trace, index))
}

function makeMockThreadTraces(
  threadId: string,
  options?: ThreadTracesOptions
): DashboardTraceDetail[] {
  const now = Date.now()
  const range: TimeRange = {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString()
  }
  const base = makeMockSkillRecentTraces("auto-code-workflow-v1.0.0", range, 10)
  const groups = groupMockTraceDetailsByThread(base)
  const exactGroup = findMockThreadGroupForThreadId(groups, threadId)
  let traces: DashboardTraceDetail[]
  if (exactGroup) {
    traces =
      exactGroup.threadId === threadId
        ? exactGroup.traces
        : namespaceMockThreadGroupForRequest(exactGroup.traces, threadId)
  } else {
    // 真实环境 threadTraces(id) 只返回该会话的 trace；mock 同样把若干条 trace 归到
    // 同一个 rootThreadId，保证按 thread 视图时恰好是「单个完整会话」。
    const seed = Array.from(threadId).reduce((acc, char) => acc + char.charCodeAt(0), 0)
    const count = Math.min(base.length, 2 + (seed % 3))
    traces = namespaceMockTraceDetails(base.slice(0, count), threadId, {
      startedAt: (index) => new Date(now - (count - index) * 12 * 60 * 1000).toISOString()
    })
  }

  return options?.scope === "project"
    ? attributeMockProjectThreadTraces(traces, `mock-project-${threadId}`)
    : traces
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

function makeMockAwardSkillContributions(skillNames: string[]): DashboardAwardSkillContribution[] {
  const names = (Array.isArray(skillNames) ? skillNames : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean)
  const seedNames = names.length > 0 ? names : ["code-review", "spec-writer", "db-migrate"]
  return seedNames.map((name) => {
    const seed = Array.from(name).reduce((acc, c) => acc + c.charCodeAt(0), 0)
    return {
      skillKey: name,
      crossOrgCount: 1 + (seed % 4),
      userCount: 3 + (seed % 20),
      callCount: 40 + (seed % 260),
      codeStats: makeMockSkillCodeStats(name)
    }
  })
}

function makeMockAwardUserApplications(): DashboardAwardUserApplication[] {
  const orgs = ["研发一室", "研发二室", "平台室", "数据室"]
  return Array.from({ length: 12 }, (_, i) => {
    const seed = (i + 1) * 37
    return {
      sapId: `9000${10 + i}`,
      ystId: `8000${10 + i}`,
      userName: `用户${i + 1}`,
      orgName: orgs[i % orgs.length],
      upperOrgLv0: "研发部",
      upperOrgLv1: orgs[i % orgs.length],
      callCount: 320 - i * 18,
      skillCount: 3 + (seed % 9),
      skillUsageCount: 40 + (seed % 220),
      toolCallCount: 1800 - i * 90,
      threadCount: 60 - i * 3,
      featureCount: 14 - (i % 10),
      codeStats: makeMockSkillCodeStats(`user-${i}`)
    }
  })
}

function makeMockAwardTeamBenchmark(): DashboardAwardTeamBenchmarkRow[] {
  const shiList = ["研发一室", "研发二室", "平台室", "数据室"]
  const groupsByShi = ["A组", "B组", "C组"]
  return shiList.map((shi, i) => {
    const seed = (i + 1) * 53
    const makeRow = (
      label: string,
      group: string | undefined,
      scale: number
    ): DashboardAwardTeamBenchmarkRow => {
      const userCount = Math.max(1, Math.round((18 - i * 2) * scale))
      const usageCount = Math.round((520 - i * 60) * scale)
      const perCapitaUsage = userCount > 0 ? usageCount / userCount : 0
      return {
        shi,
        group,
        usageCount,
        userCount,
        perCapitaUsage,
        totalPerCapitaUsage: 26.5,
        aboveAvgUserCount: Math.max(1, Math.round(userCount * 0.38)),
        skillUsageCount: Math.round((780 - i * 80) * scale),
        distinctSkillsUsed: Math.max(1, Math.round((12 - i) * scale)),
        codeStats: makeMockSkillCodeStats(`team-${label}`)
      }
    }
    return {
      ...makeRow(shi, undefined, 1),
      children: groupsByShi.map((g, gi) =>
        makeRow(`${shi}-${g}`, g, 0.45 - gi * 0.1 + ((seed + gi) % 5) / 100)
      )
    }
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
  const baseTraceGroups = groupMockTraceDetailsByThread(baseTraces)
  const traces =
    traceViewMode === "thread"
      ? Array.from(
          { length: Math.max(0, Math.min(tracePageSize, totalTraces - startIndex)) },
          (_, threadIndex) => {
            const mockIndex = startIndex + threadIndex
            const sourceGroup = baseTraceGroups[mockIndex % baseTraceGroups.length]?.traces ?? []
            return namespaceMockTraceDetails(
              sourceGroup,
              `skill-page-${tracePage}-${threadIndex}`,
              {
                startedAt: (traceIndex) =>
                  new Date(
                    new Date(range.to).getTime() -
                      mockIndex * 35 * 60 * 1000 +
                      traceIndex * 5 * 60 * 1000
                  ).toISOString()
              }
            )
          }
        ).flat()
      : Array.from(
          { length: Math.max(0, Math.min(tracePageSize, totalTraces - startIndex)) },
          (_, traceIndex) => {
            const mockIndex = startIndex + traceIndex
            const trace = baseTraces[mockIndex % baseTraces.length]
            return namespaceMockTraceDetails(
              [trace],
              `skill-trace-page-${tracePage}-${traceIndex}`,
              {
                startedAt: () =>
                  new Date(new Date(range.to).getTime() - mockIndex * 35 * 60 * 1000).toISOString()
              }
            )[0]
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

function makeMockCommitAdoptionEvents(commitSha: string): CommitAdoptionEvents {
  const now = Date.now()
  const iso = (offsetMs: number): string => new Date(now - offsetMs).toISOString()
  const pairs: CommitAdoptionEventPair[] = [
    {
      genEventId: "g_mock_committed",
      file: "runtime.ts",
      tool: "edit_file",
      language: "ts",
      usedSkills: ["代码审查-v1.0.0"],
      modelName: "claude-opus-4-8",
      generatedAt: iso(9 * 60 * 1000),
      verdict: "committed",
      reason: null,
      generatedLineCount: 120,
      effectiveGeneratedLineCount: 110,
      adoptedLineCount: 88,
      measureSource: "git_commit",
      pushed: true,
      measuredAt: iso(6 * 60 * 1000),
      threadId: "mock-thread-1"
    },
    {
      genEventId: "g_mock_deleted",
      file: "scratch.ts",
      tool: "write_file",
      language: "ts",
      usedSkills: [],
      modelName: "claude-opus-4-8",
      generatedAt: iso(8 * 60 * 1000),
      verdict: "deleted",
      reason: null,
      generatedLineCount: 40,
      effectiveGeneratedLineCount: 40,
      adoptedLineCount: 0,
      measureSource: "git_commit",
      pushed: true,
      measuredAt: iso(6 * 60 * 1000),
      threadId: "mock-thread-1"
    },
    {
      genEventId: "g_mock_large",
      file: "generated-bundle.ts",
      tool: "write_file",
      language: "ts",
      usedSkills: ["需求分析-v1.0.0"],
      modelName: "claude-opus-4-8",
      generatedAt: iso(7 * 60 * 1000),
      verdict: "skipped_large",
      reason: null,
      generatedLineCount: 24000,
      effectiveGeneratedLineCount: null,
      adoptedLineCount: null,
      measureSource: "git_commit",
      pushed: true,
      measuredAt: iso(6 * 60 * 1000),
      threadId: "mock-thread-2"
    },
    {
      genEventId: "g_mock_orphan",
      file: null,
      tool: null,
      language: null,
      usedSkills: [],
      modelName: null,
      generatedAt: null,
      verdict: "committed",
      reason: null,
      generatedLineCount: 30,
      effectiveGeneratedLineCount: 30,
      adoptedLineCount: 21,
      measureSource: "git_commit",
      pushed: true,
      measuredAt: iso(5 * 60 * 1000),
      threadId: "mock-thread-2"
    },
    {
      genEventId: "g_mock_agent_rm",
      file: "AgentOperationList.tsx",
      tool: "write_file",
      language: "tsx",
      usedSkills: [],
      modelName: "claude-opus-4-8",
      generatedAt: iso(10 * 60 * 1000),
      verdict: "superseded",
      reason: "agent_rm",
      generatedLineCount: 64,
      effectiveGeneratedLineCount: 0,
      adoptedLineCount: 0,
      measureSource: "agent_file_op",
      pushed: false,
      measuredAt: iso(9 * 60 * 1000),
      threadId: "mock-thread-2"
    }
  ]
  let sumEffective = 0
  let sumAdopted = 0
  for (const pair of pairs) {
    if (
      pair.generatedLineCount !== null &&
      pair.effectiveGeneratedLineCount !== null &&
      pair.adoptedLineCount !== null
    ) {
      sumEffective += pair.effectiveGeneratedLineCount
      sumAdopted += pair.adoptedLineCount
    }
  }
  return {
    commitSha,
    pairs,
    reconciliation: {
      sumEffective,
      sumAdopted,
      rate: sumEffective > 0 ? sumAdopted / sumEffective : null
    }
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
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword } =
    normalizeCommitDetailsOptions(options)
  const from = new Date(range.from)
  const to = new Date(range.to)
  const spanMs = Math.max(60_000, to.getTime() - from.getTime())
  const allItems = Array.from({ length: 240 }, (_, index): DashboardCommitDetail => {
    const eventTime = new Date(to.getTime() - Math.min(spanMs - 1, index * 42 * 60 * 1000))
    const pushed = index % 3 !== 1
    const repoName = `cmb-${index % 3}`
    const commitSha = `mock${String(index + 1).padStart(36, "0")}`
    // 每 3 条造一个「跨多会话」的 commit，方便验证多会话展示。
    const threadIds =
      index % 3 === 0
        ? [`mock-thread-${(index % 5) + 1}`, `mock-thread-${((index + 2) % 5) + 1}`]
        : [`mock-thread-${(index % 5) + 1}`]
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
      threadId: threadIds[0],
      threadIds,
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
    if (!commitDetailMatchesUserKeyword(item, userKeyword)) return false
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

function commitDetailMatchesUserKeyword(
  item: DashboardCommitDetail,
  userKeyword: string | null
): boolean {
  if (userKeyword === null) return true
  const needle = userKeyword.toLowerCase()
  return [item.userName, item.sapId, item.ystId].some((value) =>
    String(value || "")
      .toLowerCase()
      .includes(needle)
  )
}

function makeMockNonGitAdoptionReports(
  range: TimeRange,
  options?: NonGitAdoptionReportsOptions
): DashboardNonGitAdoptionReportsData {
  const opts = normalizeNonGitAdoptionReportsOptions(options)
  const from = new Date(range.from)
  const to = new Date(range.to)
  const spanMs = Math.max(60_000, to.getTime() - from.getTime())
  const allItems = Array.from({ length: 72 }, (_, index): DashboardNonGitAdoptionReportItem => {
    const generatedAt = new Date(to.getTime() - Math.min(spanMs - 1, index * 58 * 60 * 1000))
    const pushedAt = new Date(generatedAt.getTime() + (2 + (index % 10)) * 60 * 60 * 1000)
    const generatedLineCount = 24 + (index % 11) * 4
    const effectiveGeneratedLineCount = generatedLineCount
    const adoptedLineCount = Math.max(0, generatedLineCount - 3 - (index % 7))
    const source = index % 2 === 0 ? "tag-platform" : "data-platform"
    const projectId = opts.projectId || `project-${(index % 3) + 1}`
    const featureSlug = opts.featureSlug || `feature-${(index % 4) + 1}`
    const threadId = `mock-external-thread-${(index % 6) + 1}`
    return {
      eventId: `mock-non-git-adopt-${index + 1}`,
      eventTime: pushedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      pushedAt: pushedAt.toISOString(),
      measuredAt: pushedAt.toISOString(),
      userName: ["张三", "李四", "王五", "赵六"][index % 4],
      sapId: `100200${String(index + 1).padStart(2, "0")}`,
      ystId: `3842${String(80 + index).padStart(2, "0")}`,
      orgName: ["标签开发部", "数据开发部", "风险平台部"][index % 3],
      upperOrgLv1: ["信息研发部", "零售金融部", "风险平台部"][index % 3],
      upperOrgLv0: ["标签组", "数据应用组", "风控研发组"][index % 3],
      userIp: `10.2.0.${20 + index}`,
      source,
      harnessProjectId: projectId,
      harnessFeatureSlug: featureSlug,
      harnessAdapterName: index % 2 === 0 ? "tag-codegen" : "data-codegen",
      harnessAdapterVersion: `1.${index % 4}.0`,
      genEventId: `mock-non-git-gen-${index + 1}`,
      threadId,
      threadIds: [threadId],
      fileHint: index % 2 === 0 ? "TagRule.java" : "MetricJob.sql",
      tool: "external_reporter",
      language: index % 2 === 0 ? "java" : "sql",
      modelName: "external-codegen",
      measureSource: "external",
      verdict: "committed",
      pushed: true,
      usedSkills: index % 2 === 0 ? ["标签开发-v1.0.0"] : ["数据开发-v1.0.0", "接口设计-v1.0.0"],
      generatedLineCount,
      effectiveGeneratedLineCount,
      adoptedLineCount,
      adoptionRate: adoptedLineCount / effectiveGeneratedLineCount
    }
  })
  const filtered = allItems.filter((item) => {
    if (opts.projectMode && !item.harnessProjectId) return false
    if (opts.projectId && item.harnessProjectId !== opts.projectId) return false
    if (opts.featureSlug && item.harnessFeatureSlug !== opts.featureSlug) return false
    if (opts.usedSkillsOnly && item.usedSkills.length === 0) return false
    if (opts.upperOrgLv1 !== null) {
      const needle = opts.upperOrgLv1.toLowerCase()
      const matched = [item.upperOrgLv1, item.upperOrgLv0].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(needle)
      )
      if (!matched) return false
    }
    if (opts.userKeyword !== null) {
      const needle = opts.userKeyword.toLowerCase()
      const matched = [item.userName, item.sapId, item.ystId].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(needle)
      )
      if (!matched) return false
    }
    return true
  })
  const start = (opts.page - 1) * opts.pageSize
  return {
    total: filtered.length,
    page: opts.page,
    pageSize: opts.pageSize,
    items: filtered.slice(start, start + opts.pageSize)
  }
}

/** DEV mock for one feature's Commit 明细: a deterministic slice of the platform commit mock. */
function makeMockProjectModeFeatureCommits(
  projectId: string,
  featureSlug: string,
  range: TimeRange,
  options?: number | CommitDetailsOptions
): {
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
} {
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword } =
    normalizeCommitDetailsOptions(options)
  // 用 projectId+featureSlug 的哈希派生「条数 + 起始偏移」，让每个特性拿到各不相同（且互不重叠）
  // 的 commit 窗口——真实后端按 harnessFeatureSlug 精确圈定，这里仅为 DEV 还原「每条 feature 只看自己的 commit」。
  const seed = `${projectId}/${featureSlug}`
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  const featureCommitCount = 4 + (hash % 9)
  const pool = makeMockCommitDetails(range, {
    page: 1,
    pageSize: 1000,
    pushedOnly: false,
    upperOrgLv1: null
  }).items
  const offset = pool.length > 0 ? (hash * 7) % pool.length : 0
  // 双倍拼接后再切片，避免窗口跨过数组末尾时长度不足。
  const featureItems = [...pool, ...pool].slice(offset, offset + featureCommitCount)
  const filtered = featureItems.filter((item) => {
    if (pushedOnly && !item.pushed) return false
    if (upperOrgLv1 !== null) {
      const needle = upperOrgLv1.toLowerCase()
      const matched = [item.upperOrgLv1, item.upperOrgLv0].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(needle)
      )
      if (!matched) return false
    }
    if (!commitDetailMatchesUserKeyword(item, userKeyword)) return false
    return true
  })
  const start = (page - 1) * pageSize
  return {
    total: filtered.length,
    page,
    pageSize,
    pushedOnly,
    items: filtered.slice(start, start + pageSize)
  }
}

/** DEV mock for a whole project's Commit 明细: a deterministic, larger slice keyed by projectId. */
function makeMockProjectModeProjectCommits(
  projectId: string,
  range: TimeRange,
  options?: number | CommitDetailsOptions
): {
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
} {
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword } =
    normalizeCommitDetailsOptions(options)
  let hash = 0
  for (let i = 0; i < projectId.length; i += 1) hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0
  const projectCommitCount = 12 + (hash % 28)
  const pool = makeMockCommitDetails(range, {
    page: 1,
    pageSize: 1000,
    pushedOnly: false,
    upperOrgLv1: null
  }).items
  const offset = pool.length > 0 ? (hash * 7) % pool.length : 0
  const projectItems = [...pool, ...pool].slice(offset, offset + projectCommitCount)
  const filtered = projectItems.filter((item) => {
    if (pushedOnly && !item.pushed) return false
    if (upperOrgLv1 !== null) {
      const needle = upperOrgLv1.toLowerCase()
      const matched = [item.upperOrgLv1, item.upperOrgLv0].some((value) =>
        String(value || "")
          .toLowerCase()
          .includes(needle)
      )
      if (!matched) return false
    }
    if (!commitDetailMatchesUserKeyword(item, userKeyword)) return false
    return true
  })
  const start = (page - 1) * pageSize
  return {
    total: filtered.length,
    page,
    pageSize,
    pushedOnly,
    items: filtered.slice(start, start + pageSize)
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
  /** This-range code adoption for the feature (sliced by harnessFeatureSlug); absent if no code data. */
  codeStats?: DashboardCodeStats | null
  /** This-range successful system-constraint reads, deduplicated across workflow stages. */
  systemConstraintReads?: ProjectModeConstraintReadStats | null
  /** This-range runtime hook executions attributed to the feature. */
  hookExecutions?: ProjectModeHookStats | null
}

interface ProjectModeSkillCount {
  id?: string
  skill: string
  sourceRef?: string
  count: number
  isPlugin?: boolean
  pluginName?: string
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
  /** 项目创建时间（快照 properties.lifecycleCreatedAt）；ISO 字符串。 */
  lifecycleCreatedAt?: string
  /** 生命周期最近变更时间（归档时间用此排序）；ISO 字符串。 */
  lifecycleUpdatedAt?: string
  compatible?: boolean
  compatibilityStatus?: string
  /** Whether at least one feature session has loaded its complete system-constraint set. */
  systemConstraintEverLoadedSuccessfully?: boolean
  featureCount: number
  conversationCount: number
  /** Forward-only count of main-Agent turns matching the technical-detail heuristic. */
  suspectedTechnicalDetailConversationCount?: number
  /** Conversations whose current workflow node belongs to the Dev group. */
  devStageConversationCount: number
  /** Distinct bound Features that contributed a Dev-stage conversation in the range. */
  devAssociatedFeatureCount: number
  hasError: boolean
  features: ProjectModeFeatureView[]
  topSkills: ProjectModeSkillCount[]
  codeStats: DashboardCodeStats | null
  /** This-range successful system-constraint reads, deduplicated across features/stages. */
  systemConstraintReads?: ProjectModeConstraintReadStats | null
  /** This-range runtime hook executions attributed to the project. */
  hookExecutions?: ProjectModeHookStats | null
  stageBuckets: DashboardStageBuckets
}

type ProjectModeProjectStatus = "active" | "archived"

/**
 * Sortable project-list columns.
 * - `featureCount` / `createdAt` / `archivedAt` are snapshot-doc fields → sorted
 *   cheaply in the paginated snapshot query. `archivedAt` (= lifecycle updateAt)
 *   is only meaningful on the「已归档」tab.
 * - `conversationCount` / `generatedLines` are per-range metrics on the trace /
 *   code indices → require the heavier metric-sort path, which is only enabled
 *   for the「进行中」(active) tab (archived projects accumulate; active are few).
 */
type ProjectModeProjectSortKey =
  | "featureCount"
  | "createdAt"
  | "conversationCount"
  | "generatedLines"
  | "archivedAt"
type ProjectModeProjectSortOrder = "asc" | "desc"

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
  sortBy: ProjectModeProjectSortKey | null
  sortOrder: ProjectModeProjectSortOrder
  /** Whether the current viewer may receive and see the heuristic metric. */
  showSuspectedTechnicalDetailMetric: boolean
  /**
   * True when more projects matched than the metric-sort enumeration cap
   * (`PROJECT_MODE_PROJECT_ID_LIMIT`), so the ranking + total only reflect the
   * first N projects. Always false on the snapshot-paginated path (it pages via
   * ES from/size + cardinality total, which the cap does not bound).
   */
  truncated: boolean
}

interface ProjectModeExportData {
  users: ProjectModeTopUser[]
  projects: ProjectModeProjectView[]
  projectTotal: number
  activeProjectTotal: number
  archivedProjectTotal: number
  projectLimit: number
  projectsTruncated: boolean
}

interface ProjectModeProjectPageOptions extends OrgFilterOptions {
  status?: ProjectModeProjectStatus | null
  page?: number
  pageSize?: number
  keyword?: string | null
  adapterName?: string | null
  /** 配合 adapterName 精确到插件版本（如「按版本」口径点击项目数）；空 = 不限版本。 */
  adapterVersion?: string | null
  creatorKeyword?: string | null
  creatorOrgKeyword?: string | null
  sortBy?: ProjectModeProjectSortKey | null
  sortOrder?: ProjectModeProjectSortOrder | null
}

/** One stage×skill bucket: its conversation count + code adoption stats. */
interface StageBucketStat {
  conversationCount: number
  codeStats: DashboardCodeStats | null
}

/**
 * Project-mode work split by the stage×skill attribution buckets
 * (see src/shared/harness-stage-bucket.ts). Complements the existing
 * Skill-usage口径 — here a turn/code event is bucketed by the workflow stage
 * status at turn time crossed with whether it carried a plugin Skill.
 */
interface DashboardStageBuckets {
  pluginConstrained: StageBucketStat
  vibecoding: StageBucketStat
  unattributed: StageBucketStat
}

function emptyStageBucketStat(): StageBucketStat {
  return { conversationCount: 0, codeStats: null }
}

function emptyStageBuckets(): DashboardStageBuckets {
  return {
    pluginConstrained: emptyStageBucketStat(),
    vibecoding: emptyStageBucketStat(),
    unattributed: emptyStageBucketStat()
  }
}

/** ES agg key for one bucket (shared between trace + code aggregations). */
function stageBucketAggKey(bucket: StageBucket): string {
  return `sb_${bucket}`
}

/**
 * Four named filter sub-aggs splitting code events by stage×skill, each wrapping
 * the same `perBucketAggs` (code_gen/code_adopt/pushed) so every bucket yields a
 * clean DashboardCodeStats via normalizeCodeStatsFromContainer — no cross-status
 * summing of adoption rates. `unattributed` is the complement of 进行中/已完成 and
 * so also captures events missing harnessNodeStatus (historical / unresolved).
 */
function stageBucketCodeAggs(perBucketAggs: Record<string, unknown>): Record<string, unknown> {
  const inProgress = { term: { "properties.harnessNodeStatus": STAGE_IN_PROGRESS_LABEL } }
  const done = { term: { "properties.harnessNodeStatus": STAGE_DONE_LABEL } }
  const hasSkill = { exists: { field: "properties.usedSkills" } }
  return {
    [stageBucketAggKey("plugin_constrained")]: {
      filter: { bool: { filter: [inProgress, hasSkill] } },
      aggs: perBucketAggs
    },
    // VibeCoding = 进行中但绕过插件（无 Skill）∪ 已完成后的自由产出。
    [stageBucketAggKey("vibecoding")]: {
      filter: {
        bool: {
          should: [{ bool: { filter: [inProgress], must_not: [hasSkill] } }, done],
          minimum_should_match: 1
        }
      },
      aggs: perBucketAggs
    },
    [stageBucketAggKey("unattributed")]: {
      filter: {
        bool: {
          must_not: [
            {
              terms: { "properties.harnessNodeStatus": [STAGE_IN_PROGRESS_LABEL, STAGE_DONE_LABEL] }
            }
          ]
        }
      },
      aggs: perBucketAggs
    }
  }
}

/**
 * Trace-side ES filter clause for one stage bucket（字段无 `properties.` 前缀，用于 trace 索引）。
 * 单一来源：既给 stageBucketTraceAggs 的分桶用，也给「查看对话」按桶过滤 trace 用。
 *  - 插件约束（Harness）= 进行中 + 有 Skill
 *  - VibeCoding        = 进行中但无 Skill ∪ 已完成（不论 Skill）
 *  - 未归因            = 其余状态 / 无状态
 */
function stageBucketTraceFilterClause(bucket: StageBucket): Record<string, unknown> {
  const inProgress = { term: { harnessNodeStatus: STAGE_IN_PROGRESS_LABEL } }
  const done = { term: { harnessNodeStatus: STAGE_DONE_LABEL } }
  const hasSkill = { exists: { field: "usedSkills" } }
  switch (bucket) {
    case "plugin_constrained":
      return { bool: { filter: [inProgress, hasSkill] } }
    case "vibecoding":
      return {
        bool: {
          should: [{ bool: { filter: [inProgress], must_not: [hasSkill] } }, done],
          minimum_should_match: 1
        }
      }
    case "unattributed":
      return {
        bool: {
          must_not: [{ terms: { harnessNodeStatus: [STAGE_IN_PROGRESS_LABEL, STAGE_DONE_LABEL] } }]
        }
      }
  }
}

/** Trace-side mirror of stageBucketCodeAggs (conversation counts, no perBucketAggs). */
function stageBucketTraceAggs(): Record<string, unknown> {
  return {
    [stageBucketAggKey("plugin_constrained")]: {
      filter: stageBucketTraceFilterClause("plugin_constrained")
    },
    [stageBucketAggKey("vibecoding")]: {
      filter: stageBucketTraceFilterClause("vibecoding")
    },
    [stageBucketAggKey("unattributed")]: {
      filter: stageBucketTraceFilterClause("unattributed")
    }
  }
}

/** Parse a container holding `sb_*` filter buckets → per-bucket code stats. */
function parseStageBucketCodeStats(container: unknown): Record<StageBucket, DashboardCodeStats> {
  const c = asRecord(container)
  const read = (bucket: StageBucket): DashboardCodeStats =>
    normalizeCodeStatsFromContainer(asRecord(c[stageBucketAggKey(bucket)]))
  return {
    plugin_constrained: read("plugin_constrained"),
    vibecoding: read("vibecoding"),
    unattributed: read("unattributed")
  }
}

/** Parse a container holding `sb_*` filter buckets → per-bucket conversation counts. */
function parseStageBucketConversations(container: unknown): Record<StageBucket, number> {
  const c = asRecord(container)
  const read = (bucket: StageBucket): number =>
    asNumber(asRecord(c[stageBucketAggKey(bucket)]).doc_count)
  return {
    plugin_constrained: read("plugin_constrained"),
    vibecoding: read("vibecoding"),
    unattributed: read("unattributed")
  }
}

/** Merge per-bucket conversation counts + code stats into DashboardStageBuckets. */
function buildStageBuckets(
  conv: Record<StageBucket, number> | undefined,
  code: Record<StageBucket, DashboardCodeStats> | undefined
): DashboardStageBuckets {
  const stat = (bucket: StageBucket): StageBucketStat => ({
    conversationCount: conv?.[bucket] ?? 0,
    codeStats: code?.[bucket] ?? null
  })
  return {
    pluginConstrained: stat("plugin_constrained"),
    vibecoding: stat("vibecoding"),
    unattributed: stat("unattributed")
  }
}

/** Fill the code-stats side of already-built (conversation-only) stage buckets. */
function withStageBucketsCode(
  conv: DashboardStageBuckets,
  code: Record<StageBucket, DashboardCodeStats> | undefined
): DashboardStageBuckets {
  return {
    pluginConstrained: {
      conversationCount: conv.pluginConstrained.conversationCount,
      codeStats: code?.plugin_constrained ?? null
    },
    vibecoding: {
      conversationCount: conv.vibecoding.conversationCount,
      codeStats: code?.vibecoding ?? null
    },
    unattributed: {
      conversationCount: conv.unattributed.conversationCount,
      codeStats: code?.unattributed ?? null
    }
  }
}

interface ProjectModeAdapterView {
  name: string
  version?: string
  projectCount: number
  featureCount: number
  conversationCount: number
  codeStats: DashboardCodeStats | null
  stageBuckets: DashboardStageBuckets
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
    skillCodeStats: DashboardCodeStats | null
  }
  adapters: ProjectModeAdapterView[]
  topSkills: ProjectModeSkillCount[]
  bySkillAdoption: DashboardSkillCodeAdoptionStats[]
  tools: ProjectModeToolUsage
  analytics: ProjectModeAnalytics
  projectCounts: ProjectModeProjectCounts
  projectPage: ProjectModeProjectPageData
  projects: ProjectModeProjectView[]
  /**
   * 「仅精益项目」开关下，精益项目 id 集超过 PROJECT_MODE_PROJECT_ID_LIMIT 被截断，
   * 遥测汇总（对话/代码等）可能不完整。开关关闭时恒为 false。
   */
  leanTruncated: boolean
  /**
   * 当前范围内出现过的外部上报来源（`properties.source` 去重值，字典序）。供「生产
   * 效能代码指标」的 source 下拉填充候选；原生事件不带 source、不入此列表。
   */
  availableSources?: string[]
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

/**
 * Project-list conversation count = user-initiated main-Agent turns only.
 *
 * Child traces inherit `triggerSource=chat` from their root turn, so the active-trigger
 * filter alone would still count coordinator workers / workflow agents / task agents.
 * Documents written before multi-Agent observability have no traceKind or parent fields;
 * treat those legacy records as root turns for backwards-compatible time ranges.
 */
function projectModeMainAgentConversationFilter(): Record<string, unknown> {
  return {
    bool: {
      filter: [
        buildChatTriggeredTraceFilter(),
        {
          bool: {
            should: [
              { term: { traceKind: "root" } },
              { term: { "traceKind.keyword": "root" } },
              {
                bool: {
                  must_not: [
                    { exists: { field: "traceKind" } },
                    { exists: { field: "parentTraceId" } },
                    { exists: { field: "subagentKind" } }
                  ]
                }
              }
            ],
            minimum_should_match: 1
          }
        }
      ]
    }
  }
}

/** Build the `name@version` key used to merge adapter rows across snapshot + usage. */
function adapterKey(name: string, version?: string): string {
  return `${name}@@${version ?? ""}`
}

function normalizeProjectModeProjectStatus(value?: string | null): ProjectModeProjectStatus {
  return value === "archived" ? "archived" : "active"
}

/**
 * Resolve the requested sort. `featureCount` is always honoured; the per-range
 * metric sorts are dropped (→ default createdAt-desc) on the archived tab, so
 * callers can blindly forward the user's choice without leaking the active-only rule.
 */
function normalizeProjectModeProjectSort(
  options: ProjectModeProjectPageOptions | undefined,
  status: ProjectModeProjectStatus
): { sortBy: ProjectModeProjectSortKey | null; sortOrder: ProjectModeProjectSortOrder } {
  const sortOrder: ProjectModeProjectSortOrder = options?.sortOrder === "asc" ? "asc" : "desc"
  const key = options?.sortBy
  if (key === "featureCount") return { sortBy: "featureCount", sortOrder }
  if (key === "createdAt") return { sortBy: "createdAt", sortOrder }
  if (key === "archivedAt" && status === "archived") return { sortBy: "archivedAt", sortOrder }
  if ((key === "conversationCount" || key === "generatedLines") && status !== "archived") {
    return { sortBy: key, sortOrder }
  }
  return { sortBy: "createdAt", sortOrder: "desc" }
}

function normalizeProjectModeKeyword(value?: string | null): string {
  return String(value ?? "").trim()
}

function normalizeProjectModeAdapterName(value?: string | null): string {
  return String(value ?? "").trim()
}

function normalizeProjectModeAdapterVersion(value?: string | null): string {
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

function projectMatchesAdapterVersion(
  project: ProjectModeProjectView,
  adapterVersion: string
): boolean {
  if (!adapterVersion) return true
  return project.adapterVersion === adapterVersion
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

/** Numeric value of a project for a given sort key (DEV mock only). */
function projectModeProjectSortValue(
  project: ProjectModeProjectView,
  sortBy: ProjectModeProjectSortKey
): number {
  if (sortBy === "conversationCount") return project.conversationCount
  if (sortBy === "generatedLines") return project.codeStats?.generatedLines ?? 0
  if (sortBy === "createdAt") {
    const t = project.lifecycleCreatedAt ? Date.parse(project.lifecycleCreatedAt) : NaN
    return Number.isNaN(t) ? 0 : t
  }
  if (sortBy === "archivedAt") {
    const t = project.lifecycleUpdatedAt ? Date.parse(project.lifecycleUpdatedAt) : NaN
    return Number.isNaN(t) ? 0 : t
  }
  return project.featureCount
}

function sliceProjectModeProjects(
  projects: ProjectModeProjectView[],
  options?: ProjectModeProjectPageOptions
): ProjectModeProjectPageData {
  const status = normalizeProjectModeProjectStatus(options?.status)
  const keyword = normalizeProjectModeKeyword(options?.keyword)
  const adapterName = normalizeProjectModeAdapterName(options?.adapterName)
  const adapterVersion = normalizeProjectModeAdapterVersion(options?.adapterVersion)
  const creatorKeyword = normalizeProjectModeCreatorKeyword(options?.creatorKeyword)
  const creatorOrgKeyword = normalizeProjectModeCreatorOrgKeyword(options?.creatorOrgKeyword)
  const { sortBy, sortOrder } = normalizeProjectModeProjectSort(options, status)
  const page = clampLimit(options?.page, 1, 10_000)
  const pageSize = clampLimit(options?.pageSize, 10, 100)
  const filtered = projects
    .filter((project) => projectMatchesStatus(project, status))
    .filter((project) => projectMatchesKeyword(project, keyword))
    .filter((project) => projectMatchesAdapterName(project, adapterName))
    .filter((project) => projectMatchesAdapterVersion(project, adapterVersion))
    .filter((project) => projectMatchesCreatorKeyword(project, creatorKeyword))
    .filter((project) => projectMatchesCreatorOrgKeyword(project, creatorOrgKeyword))
  const sorted = sortBy
    ? [...filtered].sort((a, b) => {
        const av = projectModeProjectSortValue(a, sortBy)
        const bv = projectModeProjectSortValue(b, sortBy)
        if (av !== bv) return sortOrder === "asc" ? av - bv : bv - av
        return compareProjectByName(a, b)
      })
    : filtered.sort(compareProjectByName)
  const total = sorted.length
  const start = (page - 1) * pageSize
  return {
    projects: sorted.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    status,
    keyword,
    adapterName,
    creatorKeyword,
    creatorOrgKeyword,
    sortBy,
    sortOrder,
    // DEV is intentionally open so the gated column can be previewed locally.
    showSuspectedTechnicalDetailMetric: true,
    // Mock paginates the in-memory list directly, so it is never cap-truncated.
    truncated: false
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
      summary: asOptionalString(f.summary),
      codeStats: null,
      systemConstraintReads: null,
      hookExecutions: null
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
    lifecycleCreatedAt: asOptionalString(props.lifecycleCreatedAt),
    lifecycleUpdatedAt: asOptionalString(props.lifecycleUpdatedAt),
    compatible: typeof props.compatible === "boolean" ? props.compatible : undefined,
    compatibilityStatus: asOptionalString(props.compatibilityStatus),
    systemConstraintEverLoadedSuccessfully:
      typeof props.systemConstraintEverLoadedSuccessfully === "boolean"
        ? props.systemConstraintEverLoadedSuccessfully
        : undefined,
    featureCount: asNumber(props.featureCount, features.length),
    conversationCount: 0,
    devStageConversationCount: 0,
    devAssociatedFeatureCount: 0,
    hasError: typeof props.error === "string" && props.error.length > 0,
    features,
    topSkills: [],
    codeStats: null,
    systemConstraintReads: null,
    hookExecutions: null,
    // Filled with real per-range buckets when the page enriches usage/code; the
    // snapshot hit alone carries no per-turn attribution.
    stageBuckets: emptyStageBuckets()
  }
}

/** Snapshot-index filter: snapshot event + optional LV1 org（快照顶层带 upperOrgLv1）。 */
function projectModeSnapshotFilters(
  orgFilterClause: Record<string, unknown> | null,
  fromLeanOnly = false
): Record<string, unknown>[] {
  return [
    { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } },
    ...(orgFilterClause ? [orgFilterClause] : []),
    // 「仅精益项目」全局开关：快照当前状态字段，self-healing，无需回填历史。
    ...(fromLeanOnly ? [{ term: { "properties.projectFromLean": true } }] : [])
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
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<ProjectModeSnapshotAggs> {
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const projectCountAgg = { cardinality: { field: "properties.projectId" } }
  const featureSumAgg = { sum: { field: "properties.featureCount" } }
  const body = {
    size: 0,
    track_total_hits: false,
    query: {
      bool: { filter: projectModeSnapshotFilters(orgFilterClause, opts?.fromLeanOnly === true) }
    },
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
/**
 * Build the shared snapshot-index filter set + normalized list options. Reused
 * by the paginated page query, the metric-sort id-set query, and the per-page
 * view-by-ids query so all three apply identical status/keyword/adapter/creator/
 * org filtering.
 */
function buildProjectModeProjectListFilters(
  options: ProjectModeProjectPageOptions | undefined,
  access: DashboardAccessContext
): {
  filters: Record<string, unknown>[]
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
} {
  const status = normalizeProjectModeProjectStatus(options?.status)
  const keyword = normalizeProjectModeKeyword(options?.keyword)
  const adapterName = normalizeProjectModeAdapterName(options?.adapterName)
  const adapterVersion = normalizeProjectModeAdapterVersion(options?.adapterVersion)
  const creatorKeyword = normalizeProjectModeCreatorKeyword(options?.creatorKeyword)
  const creatorOrgKeyword = normalizeProjectModeCreatorOrgKeyword(options?.creatorOrgKeyword)
  const orgFilterClause = buildProjectModeOrgFilter(options, access)

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
  const adapterVersionFilter: Record<string, unknown>[] = adapterVersion
    ? [{ term: { "properties.adapterVersion": adapterVersion } }]
    : []
  const creatorSearchFilter = buildProjectModeCreatorSearchFilter(creatorKeyword)
  const creatorOrgSearchFilter = buildProjectModeCreatorOrgSearchFilter(creatorOrgKeyword)

  const filters = [
    ...projectModeSnapshotFilters(orgFilterClause, options?.fromLeanOnly === true),
    ...statusFilter,
    ...keywordFilter,
    ...adapterFilter,
    ...adapterVersionFilter,
    ...(creatorSearchFilter ? [creatorSearchFilter] : []),
    ...(creatorOrgSearchFilter ? [creatorOrgSearchFilter] : [])
  ]
  return { filters, status, keyword, adapterName, creatorKeyword, creatorOrgKeyword }
}

async function fetchProjectModeProjectPageHits(
  options: ProjectModeProjectPageOptions | undefined,
  access: DashboardAccessContext
): Promise<{
  projects: ProjectModeProjectView[]
  total: number
  page: number
  pageSize: number
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
  truncated: boolean
}> {
  const { filters, status, keyword, adapterName, creatorKeyword, creatorOrgKeyword } =
    buildProjectModeProjectListFilters(options, access)
  const pageSize = clampLimit(options?.pageSize, 10, 100)
  const maxPage = Math.max(1, Math.floor(ES_MAX_RESULT_WINDOW / pageSize))
  const page = clampLimit(options?.page, 1, maxPage)
  const { sortBy, sortOrder } = normalizeProjectModeProjectSort(options, status)

  // `featureCount` / `createdAt` / `archivedAt` live in the snapshot doc and sort here; the
  // metric sorts are handled upstream by the metric-sort path.
  const sort =
    sortBy === "featureCount"
      ? [
          { "properties.featureCount": { order: sortOrder } },
          { "properties.projectId": { order: "asc" } }
        ]
      : sortBy === "createdAt"
        ? [
            { "properties.lifecycleCreatedAt": { order: sortOrder, missing: "_last" } },
            { "properties.projectId": { order: "asc" } }
          ]
        : sortBy === "archivedAt"
          ? [
              { "properties.lifecycleUpdatedAt": { order: sortOrder, missing: "_last" } },
              { "properties.projectId": { order: "asc" } }
            ]
          : [{ "properties.name": { order: "asc" } }, { "properties.projectId": { order: "asc" } }]

  const body = {
    track_total_hits: false,
    from: (page - 1) * pageSize,
    size: pageSize,
    query: {
      bool: {
        filter: filters
      }
    },
    sort,
    collapse: { field: "properties.projectId" },
    aggs: { distinct_projects: { cardinality: { field: "properties.projectId" } } },
    _source: { includes: PROJECT_MODE_SNAPSHOT_SOURCE_INCLUDES }
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
    creatorOrgKeyword,
    // Snapshot pagination (from/size + cardinality total) is not bounded by the
    // metric-sort enumeration cap, so this path is never truncated.
    truncated: false
  }
}

/** `_source` fields needed to build a ProjectModeProjectView from a snapshot hit. */
const PROJECT_MODE_SNAPSHOT_SOURCE_INCLUDES = [
  "eventTime",
  "userName",
  "sapId",
  "ystId",
  "orgName",
  "upperOrgLv0",
  "upperOrgLv1",
  "properties"
]

const PROJECT_MODE_EXPORT_SNAPSHOT_PAGE_SIZE = 500
const PROJECT_MODE_EXPORT_PROJECT_LIMIT = 2000
const PROJECT_MODE_EXPORT_PROJECT_ID_PAGE_SIZE = 1000

interface ProjectModeExportSnapshotResult {
  projects: ProjectModeProjectView[]
  total: number
  activeTotal: number
  archivedTotal: number
  truncated: boolean
}

async function fetchProjectModeExportSnapshotGroup(
  filters: Record<string, unknown>[],
  archived: boolean,
  limit: number
): Promise<{ projects: ProjectModeProjectView[]; total: number }> {
  const projects = new Map<string, ProjectModeProjectView>()
  const seenCursors = new Set<string>()
  let searchAfter: Array<string | number> | undefined
  let total = 0
  let firstPage = true

  while (true) {
    const remaining = Math.max(0, limit - projects.size)
    const pageSize = Math.min(PROJECT_MODE_EXPORT_SNAPSHOT_PAGE_SIZE, remaining)
    const body: Record<string, unknown> = {
      track_total_hits: firstPage,
      size: pageSize,
      query: {
        bool: {
          filter: [
            ...filters,
            archived
              ? { term: { "properties.lifecycleStatus": "archived" } }
              : { bool: { must_not: { term: { "properties.lifecycleStatus": "archived" } } } }
          ]
        }
      },
      sort: [
        { "properties.lifecycleCreatedAt": { order: "desc", missing: "_last" } },
        { "properties.projectId": { order: "asc" } }
      ],
      _source: { includes: PROJECT_MODE_SNAPSHOT_SOURCE_INCLUDES }
    }
    if (searchAfter) body.search_after = searchAfter

    const raw = (await esQuery(getEsIndex("event"), body)) as EsSearchResponse
    const hits = raw.hits?.hits ?? []
    if (firstPage) {
      total = getTotalHits(raw, hits.length)
      firstPage = false
    }
    if (pageSize === 0 || hits.length === 0) break

    for (const hit of hits) {
      const project = parseProjectModeSnapshotHit(hit)
      if (project) projects.set(project.projectId, project)
      if (projects.size >= limit) break
    }
    if (projects.size >= limit || hits.length < pageSize) break

    const nextSearchAfter = hits[hits.length - 1]?.sort
    if (!nextSearchAfter || nextSearchAfter.length === 0) {
      throw new Error("项目导出分页游标缺失，无法保证数据顺序")
    }
    const cursor = JSON.stringify(nextSearchAfter)
    if (seenCursors.has(cursor)) {
      throw new Error("项目导出分页游标重复，无法保证数据顺序")
    }
    seenCursors.add(cursor)
    searchAfter = nextSearchAfter
  }

  return { projects: [...projects.values()], total }
}

/**
 * Read at most the first 2,000 current project snapshots for export, ordered like
 * the workbook (non-archived first, then newest creation time). Exact matching
 * totals are returned separately so a truncated workbook remains explicit.
 */
async function fetchProjectModeExportSnapshotProjects(
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<ProjectModeExportSnapshotResult> {
  const filters = projectModeSnapshotFilters(
    buildProjectModeOrgFilter(opts, access),
    opts?.fromLeanOnly === true
  )
  const active = await fetchProjectModeExportSnapshotGroup(
    filters,
    false,
    PROJECT_MODE_EXPORT_PROJECT_LIMIT
  )
  const archived = await fetchProjectModeExportSnapshotGroup(
    filters,
    true,
    Math.max(0, PROJECT_MODE_EXPORT_PROJECT_LIMIT - active.projects.length)
  )
  const projects = [...active.projects, ...archived.projects]
  const total = active.total + archived.total
  return {
    projects,
    total,
    activeTotal: active.total,
    archivedTotal: archived.total,
    truncated: total > PROJECT_MODE_EXPORT_PROJECT_LIMIT
  }
}

/**
 * Resolve every matching project id only when the lean-project filter needs to
 * scope the full user analysis. This is intentionally independent from the
 * 2,000-row project worksheet limit.
 */
async function fetchProjectModeExportProjectIds(
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<string[]> {
  const filters = projectModeSnapshotFilters(
    buildProjectModeOrgFilter(opts, access),
    opts?.fromLeanOnly === true
  )
  const projectIds: string[] = []
  const seenCursors = new Set<string>()
  let after: Record<string, string | number> | undefined

  while (true) {
    const raw = (await esQuery(getEsIndex("event"), {
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: filters } },
      aggs: {
        projects: {
          composite: {
            size: PROJECT_MODE_EXPORT_PROJECT_ID_PAGE_SIZE,
            sources: [{ project_id: { terms: { field: "properties.projectId" } } }],
            ...(after ? { after } : {})
          }
        }
      }
    })) as EsSearchResponse
    const projectsAgg = asRecord(asRecord(raw.aggregations).projects)
    const buckets = projectsAgg.buckets
    if (!Array.isArray(buckets) || buckets.length === 0) break
    for (const bucket of buckets) {
      const projectId = asString(asRecord(asRecord(bucket).key).project_id)
      if (projectId) projectIds.push(projectId)
    }

    const nextAfter = Object.fromEntries(
      Object.entries(asRecord(projectsAgg.after_key)).filter(
        ([, value]) => typeof value === "string" || typeof value === "number"
      )
    ) as Record<string, string | number>
    if (Object.keys(nextAfter).length === 0) break
    const cursor = JSON.stringify(nextAfter)
    if (seenCursors.has(cursor)) {
      throw new Error("项目用户导出范围分页游标重复，无法保证全量数据")
    }
    seenCursors.add(cursor)
    after = nextAfter
  }

  return projectIds
}

/**
 * Resolve the full set of project ids matching the list filters (no
 * pagination). Lightweight — a single `terms` agg returning only the ids, capped
 * at PROJECT_MODE_PROJECT_ID_LIMIT. Used by the metric-sort path to rank the
 * whole (active) set before paginating in-app.
 */
async function fetchProjectModeFilteredProjectIds(
  filters: Record<string, unknown>[]
): Promise<{ ids: string[]; truncated: boolean }> {
  const raw = (await esQuery(getEsIndex("event"), {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: filters } },
    aggs: {
      ids: { terms: { field: "properties.projectId", size: PROJECT_MODE_PROJECT_ID_LIMIT } }
    }
  })) as EsSearchResponse
  const idsAgg = asRecord(asRecord(raw.aggregations).ids)
  const buckets = idsAgg.buckets
  if (!Array.isArray(buckets)) return { ids: [], truncated: false }
  const ids = buckets.map((bucket) => asString(asRecord(bucket).key)).filter(Boolean)
  // Snapshots are a deterministic one-doc-per-project upsert, so the terms agg's
  // `sum_other_doc_count` is exactly the number of matching projects that did not
  // fit under the cap. > 0 means the project set was truncated, so the caller's
  // ranking + total only cover the first PROJECT_MODE_PROJECT_ID_LIMIT projects.
  const truncated = asNumber(idsAgg.sum_other_doc_count) > 0
  return { ids, truncated }
}

/**
 * Per-project `原始生成行数` (Σ code_gen lineCount), keyed by harnessProjectId.
 * Mirrors how `codeStats.generatedLines` is computed but drops the adopt /
 * per-feature breakdown, so it stays cheap across the full active project set.
 */
async function fetchProjectModeGeneratedLinesByProject(
  projectIds: string[],
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (projectIds.length === 0) return result
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const raw = await fetchProjectModeCodeAggs(
    projectIds,
    range,
    (perBucketAggs, scopedProjectIds) => ({
      by_project: {
        terms: {
          field: "properties.harnessProjectId",
          size: Math.max(1, scopedProjectIds.length)
        },
        aggs: { code_gen: perBucketAggs.code_gen }
      }
    }),
    orgFilterClause ? [orgFilterClause] : []
  )
  const buckets = asRecord(asRecord(asRecord(raw).aggregations).by_project).buckets
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      const b = asRecord(bucket)
      const id = asString(b.key)
      if (!id) continue
      result.set(id, asNumber(asRecord(asRecord(b.code_gen).generated_lines).value))
    }
  }
  return result
}

/** Build project views for an explicit id set (one collapsed hit per project). */
async function fetchProjectModeProjectViewsByIds(
  projectIds: string[],
  filters: Record<string, unknown>[]
): Promise<Map<string, ProjectModeProjectView>> {
  const map = new Map<string, ProjectModeProjectView>()
  if (projectIds.length === 0) return map
  const raw = (await esQuery(getEsIndex("event"), {
    track_total_hits: false,
    size: projectIds.length,
    query: {
      bool: { filter: [...filters, { terms: { "properties.projectId": projectIds } }] }
    },
    collapse: { field: "properties.projectId" },
    _source: { includes: PROJECT_MODE_SNAPSHOT_SOURCE_INCLUDES }
  })) as EsSearchResponse
  for (const hit of raw.hits?.hits ?? []) {
    const view = parseProjectModeSnapshotHit(hit)
    if (view) map.set(view.projectId, view)
  }
  return map
}

/**
 * Metric-sort page (active tab only): rank the whole filtered active project set
 * by a per-range metric, then paginate in-app and fetch just the page's views.
 * Returns the same shape as `fetchProjectModeProjectPageHits` so the shared
 * enrichment in `fetchProjectModeProjectPage` applies unchanged.
 */
async function fetchProjectModeProjectPageMetricSorted(
  range: TimeRange,
  options: ProjectModeProjectPageOptions | undefined,
  access: DashboardAccessContext,
  sortBy: "conversationCount" | "generatedLines",
  sortOrder: ProjectModeProjectSortOrder
): Promise<{
  projects: ProjectModeProjectView[]
  total: number
  page: number
  pageSize: number
  status: ProjectModeProjectStatus
  keyword: string
  adapterName: string
  creatorKeyword: string
  creatorOrgKeyword: string
  truncated: boolean
}> {
  const { filters, status, keyword, adapterName, creatorKeyword, creatorOrgKeyword } =
    buildProjectModeProjectListFilters(options, access)
  const pageSize = clampLimit(options?.pageSize, 10, 100)
  const { ids: allIds, truncated } = await fetchProjectModeFilteredProjectIds(filters)
  const total = allIds.length
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  const page = clampLimit(options?.page, 1, maxPage)

  const metric =
    sortBy === "conversationCount"
      ? (await fetchProjectModePageUsage(allIds, range, options, access)).perProject
      : await fetchProjectModeGeneratedLinesByProject(allIds, range, options, access)

  const dir = sortOrder === "asc" ? 1 : -1
  const ordered = [...allIds].sort((a, b) => {
    const av = metric.get(a) ?? 0
    const bv = metric.get(b) ?? 0
    if (av !== bv) return (av - bv) * dir
    return a.localeCompare(b)
  })
  const pageIds = ordered.slice((page - 1) * pageSize, page * pageSize)
  const views = await fetchProjectModeProjectViewsByIds(pageIds, filters)
  const projects = pageIds
    .map((id) => views.get(id))
    .filter((project): project is ProjectModeProjectView => Boolean(project))

  return {
    projects,
    total,
    page,
    pageSize,
    status,
    keyword,
    adapterName,
    creatorKeyword,
    creatorOrgKeyword,
    truncated
  }
}

/**
 * Upper bound on the project set forwarded to the metric-sort / code-adoption
 * queries (ES terms cap is 65536; we stay well under it). When the snapshot
 * holds more matching projects than this, the metric-sort ranking + total are
 * computed over only the first `PROJECT_MODE_PROJECT_ID_LIMIT` projects — the
 * page data carries a `truncated` flag so the UI can warn that the list /
 * metrics are incomplete and the user should narrow the filter.
 */
const PROJECT_MODE_PROJECT_ID_LIMIT = 10000
const PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE = 10
/** Per-project cap on feature buckets returned by nested per-feature aggregations. */
const PROJECT_MODE_FEATURE_SLUG_LIMIT = 200

/** Composite map key pairing a project id with one of its feature slugs. */
function projectFeatureKey(projectId: string, featureSlug: string): string {
  return JSON.stringify([projectId, featureSlug])
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
    const rawKey = b.key
    const sapId =
      typeof rawKey === "string"
        ? rawKey
        : asString(asRecord(rawKey).sap_id, asString(source.sapId))
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
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext,
  // 「仅精益项目」时传入精益项目 id 集，按 harnessProjectId 圈定遥测；undefined=不筛选。
  // 空数组表示「无精益项目」，terms IN [] 命中 0 条，汇总即为 0（语义正确）。
  leanProjectIds?: string[]
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
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const body = {
    size: 0,
    query: {
      bool: {
        filter: [
          ...projectModeTraceFilters(range, orgFilterClause),
          ...(leanProjectIds ? [{ terms: { harnessProjectId: leanProjectIds } }] : [])
        ]
      }
    },
    aggs: {
      conversation_count: { value_count: { field: "traceId" } },
      active_projects: { cardinality: { field: "harnessProjectId" } },
      total_tool_calls: { sum: { field: "totalToolCalls" } },
      total_input_tokens: { sum: { field: "totalInputTokens" } },
      total_output_tokens: { sum: { field: "totalOutputTokens" } },
      total_tokens: { sum: { field: "totalTokens" } },
      total_skill_calls: { value_count: { field: "usedSkills" } },
      distinct_skills: { cardinality: { field: "usedSkills" } },
      top_skills: { terms: { field: "usedSkills", size: 1000 } },
      skill_source: { terms: { field: "skillSource", size: 1000 } },
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
        aggs: {
          by_version: {
            terms: { field: "harnessAdapterVersion", size: 50 },
            aggs: stageBucketTraceAggs()
          },
          ...stageBucketTraceAggs()
        }
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
          codeStats: null,
          stageBuckets: buildStageBuckets(parseStageBucketConversations(b), undefined)
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
          codeStats: null,
          stageBuckets: buildStageBuckets(parseStageBucketConversations(v), undefined)
        })
      }
    }
  }
  const topSkills = combineSkillCountBuckets(
    asRecord(aggs.top_skills).buckets,
    asRecord(aggs.skill_source).buckets,
    1000
  )

  return {
    conversationCount: asNumber(asRecord(aggs.conversation_count).value),
    activeProjectCount: asNumber(asRecord(aggs.active_projects).value),
    totalToolCalls: asNumber(asRecord(aggs.total_tool_calls).value),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    skillCallCount: asNumber(asRecord(aggs.total_skill_calls).value),
    distinctSkillCount: topSkills.length || asNumber(asRecord(aggs.distinct_skills).value),
    topSkills,
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

const PROJECT_MODE_EXPORT_USER_PAGE_SIZE = 1000

/**
 * All project-mode users for Excel export. Composite pagination avoids the
 * top-10 terms cap used by the on-screen ranking and keeps daily overview
 * requests lightweight.
 */
async function fetchProjectModeExportUsers(
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext,
  leanProjectIds?: string[]
): Promise<ProjectModeTopUser[]> {
  if (leanProjectIds && leanProjectIds.length === 0) return []

  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const users: ProjectModeTopUser[] = []
  const seenCursors = new Set<string>()
  let after: Record<string, string | number> | undefined

  while (true) {
    const composite: Record<string, unknown> = {
      size: PROJECT_MODE_EXPORT_USER_PAGE_SIZE,
      sources: [{ sap_id: { terms: { field: "sapId" } } }],
      ...(after ? { after } : {})
    }
    const raw = (await esQuery(getEsIndex("trace"), {
      size: 0,
      query: {
        bool: {
          filter: [
            ...projectModeTraceFilters(range, orgFilterClause),
            buildNonEmptySapIdFilter(),
            ...(leanProjectIds ? [{ terms: { harnessProjectId: leanProjectIds } }] : [])
          ]
        }
      },
      aggs: {
        users: {
          composite,
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
        }
      }
    })) as EsSearchResponse

    const usersAgg = asRecord(asRecord(raw.aggregations).users)
    const buckets = usersAgg.buckets
    if (!Array.isArray(buckets) || buckets.length === 0) break
    users.push(...parseProjectModeTopUserBuckets(buckets))

    const nextAfter = Object.fromEntries(
      Object.entries(asRecord(usersAgg.after_key)).filter(
        ([, value]) => typeof value === "string" || typeof value === "number"
      )
    ) as Record<string, string | number>
    if (Object.keys(nextAfter).length === 0) break
    const cursor = JSON.stringify(nextAfter)
    if (seenCursors.has(cursor)) {
      throw new Error("项目用户导出分页游标重复，无法保证全量数据")
    }
    seenCursors.add(cursor)
    after = nextAfter
  }

  return users.sort(
    (a, b) =>
      b.count - a.count ||
      a.userName.localeCompare(b.userName, "zh-CN", { numeric: true }) ||
      a.sapId.localeCompare(b.sapId)
  )
}

async function fetchProjectModePageUsage(
  projectIds: string[],
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<{
  perProject: Map<string, number>
  perProjectSuspectedTechnicalDetail: Map<string, number>
  perProjectDevStage: Map<string, number>
  perProjectDevAssociatedFeatures: Map<string, number>
  perProjectSkills: Map<string, ProjectModeSkillCount[]>
  perProjectStageConversations: Map<string, Record<StageBucket, number>>
}> {
  const includeSuspectedTechnicalDetail = isDashboardSuspectedTechnicalDetailAllowed(access)
  const perProject = new Map<string, number>()
  const perProjectSuspectedTechnicalDetail = new Map<string, number>()
  const perProjectDevStage = new Map<string, number>()
  const perProjectDevAssociatedFeatures = new Map<string, number>()
  const perProjectSkills = new Map<string, ProjectModeSkillCount[]>()
  const perProjectStageConversations = new Map<string, Record<StageBucket, number>>()
  if (projectIds.length === 0) {
    return {
      perProject,
      perProjectSuspectedTechnicalDetail,
      perProjectDevStage,
      perProjectDevAssociatedFeatures,
      perProjectSkills,
      perProjectStageConversations
    }
  }

  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
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
          main_agent_conversations: {
            filter: projectModeMainAgentConversationFilter(),
            ...(includeSuspectedTechnicalDetail
              ? {
                  aggs: {
                    suspected_technical_detail_supplements: {
                      filter: { term: { suspectedTechnicalDetailSupplement: true } }
                    }
                  }
                }
              : {})
          },
          skills: { terms: { field: "usedSkills", size: 100 } },
          skill_source: { terms: { field: "skillSource", size: 100 } },
          by_node: { terms: { field: "harnessNodeName", size: 100 } },
          by_feature: {
            terms: {
              field: "harnessFeatureSlug",
              size: PROJECT_MODE_FEATURE_SLUG_LIMIT
            },
            aggs: {
              by_node: {
                terms: { field: "harnessNodeName", size: PROJECT_MODE_FEATURE_SLUG_LIMIT }
              }
            }
          },
          ...stageBucketTraceAggs()
        }
      }
    }
  }
  const raw = (await esQuery(getEsIndex("trace"), body)) as EsSearchResponse
  const buckets = asRecord(asRecord(raw.aggregations).by_project).buckets
  if (!Array.isArray(buckets)) {
    return {
      perProject,
      perProjectSuspectedTechnicalDetail,
      perProjectDevStage,
      perProjectDevAssociatedFeatures,
      perProjectSkills,
      perProjectStageConversations
    }
  }

  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const key = asString(b.key)
    if (!key) continue
    const mainAgentConversations = asRecord(b.main_agent_conversations)
    perProject.set(key, asNumber(mainAgentConversations.doc_count))
    if (includeSuspectedTechnicalDetail) {
      perProjectSuspectedTechnicalDetail.set(
        key,
        asNumber(asRecord(mainAgentConversations.suspected_technical_detail_supplements).doc_count)
      )
    }
    perProjectDevStage.set(key, countDevStageConversations(asRecord(b.by_node).buckets))
    perProjectDevAssociatedFeatures.set(
      key,
      countDevAssociatedFeatures(asRecord(b.by_feature).buckets)
    )
    perProjectSkills.set(
      key,
      combineSkillCountBuckets(asRecord(b.skills).buckets, asRecord(b.skill_source).buckets, 10)
    )
    perProjectStageConversations.set(key, parseStageBucketConversations(b))
  }

  return {
    perProject,
    perProjectSuspectedTechnicalDetail,
    perProjectDevStage,
    perProjectDevAssociatedFeatures,
    perProjectSkills,
    perProjectStageConversations
  }
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

/** Same adapter bucket tree as parseAdapterCodeStatsBuckets, but reads the stage×skill sub-aggs. */
function parseAdapterStageBucketsBuckets(
  buckets: unknown
): Map<string, Record<StageBucket, DashboardCodeStats>> {
  const map = new Map<string, Record<StageBucket, DashboardCodeStats>>()
  if (!Array.isArray(buckets)) return map
  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const name = asString(b.key)
    if (!name) continue
    const rawVersions = asRecord(b.by_version).buckets
    const versions = Array.isArray(rawVersions) ? rawVersions : []
    if (versions.length === 0) {
      map.set(adapterKey(name), parseStageBucketCodeStats(b))
      continue
    }
    for (const vb of versions) {
      const v = asRecord(vb)
      const version = asOptionalString(v.key)
      map.set(adapterKey(name, version), parseStageBucketCodeStats(v))
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
  /** 仅由 Skill 生成的代码（code 事件带非空 usedSkills）整体汇总。 */
  skillOverall: DashboardCodeStats
  byProject: Map<string, DashboardCodeStats>
  byAdapter: Map<string, DashboardCodeStats>
  /** 每个 adapter 的 stage×skill 三桶代码拆分，键同 byAdapter。 */
  byAdapterStage: Map<string, Record<StageBucket, DashboardCodeStats>>
  bySkill: DashboardSkillCodeAdoptionStats[]
  /**
   * 当前项目模式范围内（org/时间过滤后）出现过的外部上报来源列表（`properties.source`
   * 的去重值，按字典序）。原生事件不带 source、不入此列表。供「生产效能代码指标」的
   * source 下拉填充候选。仅在未按 source 收窄（初始拉取）时有意义。
   */
  availableSources: string[]
}

/**
 * source 下拉的「Git仓库采纳」哨兵：选它表示只看不带 `properties.source` 的事件
 * （我方原生 code_gen/code_adopt）。必须与渲染层常量一致；真实外部来源不会取此字面量。
 */
const NATIVE_CODE_SOURCE = "__native__"

/**
 * 把 source 选择映射成 ES 过滤子句。空/未选 → 不过滤（全部来源）；原生哨兵 →
 * `must_not exists properties.source`；其余按字面量 term 匹配 `properties.source`。
 */
function buildCodeSourceFilterClause(
  source: string | null | undefined
): Record<string, unknown> | null {
  if (!source) return null
  if (source === NATIVE_CODE_SOURCE) {
    return { bool: { must_not: { exists: { field: "properties.source" } } } }
  }
  return { term: { "properties.source": source } }
}

/** 解析 overall 查询里的 `by_source` terms 聚合 → 去重、非空、字典序的来源列表。 */
function parseAvailableCodeSources(overallRaw: unknown): string[] {
  const buckets = asRecord(asRecord(asRecord(overallRaw).aggregations).by_source).buckets
  if (!Array.isArray(buckets)) return []
  const out = new Set<string>()
  for (const bucket of buckets) {
    const key = asString(asRecord(bucket).key).trim()
    if (key) out.add(key)
  }
  return [...out].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
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
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext,
  // 「仅精益项目」时传入精益项目 id 集，按 properties.harnessProjectId 圈定 code 事件。
  leanProjectIds?: string[],
  // 「生产效能代码指标」的 source 选择：空 → 全部；NATIVE_CODE_SOURCE → 仅原生；
  // 其余 → 仅该外部来源。仅收窄代码指标，不影响项目列表/对话数等其它面板维度。
  source?: string | null
): Promise<ProjectModeCodeStatsResult> {
  // code 事件自带顶层 upperOrgLv1，直接按室过滤即可，无需先枚举项目 id 再用 terms 圈定。
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  // 仅统计项目模式：code 事件需带 properties.harnessProjectId（与 trace 侧 exists harnessProjectId 对齐），
  // 否则会把平台全量代码事件也算进来，导致与「平台运营概览」数值一致。
  // 注意：source 枚举（by_source）必须用「不含 source 过滤」的 extraFilters，否则选定 source 后
  // 候选会塌缩成单值。统计口径才叠加 sourceClause（statExtraFilters / statSkillOnlyFilters）。
  const extraFilters = [
    ...(orgFilterClause ? [orgFilterClause] : []),
    { exists: { field: "properties.harnessProjectId" } },
    ...(leanProjectIds ? [{ terms: { "properties.harnessProjectId": leanProjectIds } }] : [])
  ]
  const sourceClause = buildCodeSourceFilterClause(source)
  const statExtraFilters = sourceClause ? [...extraFilters, sourceClause] : extraFilters
  // source 枚举只在「未按 source 收窄」时做：此时 statExtraFilters 不含 sourceClause，
  // overall 下挂的 by_source 才能看到全部来源；已选 source 时跳过（候选已由初始拉取填好）。
  const enumerateSources = sourceClause === null

  // 「由 Skill 生成的代码」口径：在整体过滤上再叠加 usedSkills 非空（与 by_skill 不同，
  // 这里用 filter 而非 terms，避免一段代码关联多个 skill 时被重复计数）。
  const skillOnlyFilters = [...statExtraFilters, { exists: { field: "properties.usedSkills" } }]

  const [overallRaw, skillOverallRaw, adapterRaw, skillRaw] = await Promise.all([
    fetchProjectModeCodeAggs(
      null,
      range,
      (perBucketAggs) => ({
        ...perBucketAggs,
        ...(enumerateSources
          ? { by_source: { terms: { field: "properties.source", size: 50 } } }
          : {})
      }),
      statExtraFilters
    ),
    fetchProjectModeCodeAggs(null, range, (perBucketAggs) => perBucketAggs, skillOnlyFilters),
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
              aggs: { ...perBucketAggs, ...stageBucketCodeAggs(perBucketAggs) }
            },
            ...stageBucketCodeAggs(perBucketAggs)
          }
        }
      }),
      statExtraFilters
    ),
    fetchProjectModeCodeAggs(
      null,
      range,
      (perBucketAggs) => ({
        by_skill: {
          terms: { field: "properties.usedSkills", size: 1000 },
          aggs: perBucketAggs
        },
        by_skill_source: {
          terms: { field: "properties.skillSource", size: 1000 },
          aggs: perBucketAggs
        },
        skill_source: { terms: { field: "properties.skillSource", size: 1000 } }
      }),
      statExtraFilters
    )
  ])

  const adapterAggs = asRecord(asRecord(adapterRaw).aggregations)
  const skillAggs = asRecord(asRecord(skillRaw).aggregations)
  return {
    overall: normalizeCodeStatsFromAggs(overallRaw),
    skillOverall: normalizeCodeStatsFromAggs(skillOverallRaw),
    byProject: new Map<string, DashboardCodeStats>(),
    byAdapter: parseAdapterCodeStatsBuckets(asRecord(adapterAggs.by_adapter).buckets),
    byAdapterStage: parseAdapterStageBucketsBuckets(asRecord(adapterAggs.by_adapter).buckets),
    bySkill: combineSkillCodeAdoptionStats(
      normalizeSkillCodeAdoptionBuckets({ aggregations: skillAggs }, "by_skill"),
      normalizeSkillCodeAdoptionBuckets({ aggregations: skillAggs }, "by_skill_source")
    ),
    availableSources: enumerateSources ? parseAvailableCodeSources(overallRaw) : []
  }
}

async function fetchProjectModeProjectMetrics(
  projectIds: string[],
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<{
  byProject: Map<string, DashboardCodeStats>
  byFeature: Map<string, DashboardCodeStats>
  byProjectStage: Map<string, Record<StageBucket, DashboardCodeStats>>
  operationalByProject: Map<string, ProjectModeOperationalStats>
  operationalByFeature: Map<string, ProjectModeOperationalStats>
}> {
  if (projectIds.length === 0) {
    return {
      byProject: new Map<string, DashboardCodeStats>(),
      byFeature: new Map(),
      byProjectStage: new Map(),
      operationalByProject: new Map(),
      operationalByFeature: new Map()
    }
  }

  // One event request carries code-adoption plus operational telemetry at both
  // project and feature scope. Constraint summary documents are emitted once
  // per Trace x stage, so the rollups cardinality-dedupe traceId instead of
  // adding stage doc_counts (which would double-count a Trace spanning stages).
  const scopedProjectIds = projectIds.slice(0, PROJECT_MODE_PROJECT_ID_LIMIT)
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const extraFilters = orgFilterClause ? [orgFilterClause] : []
  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    scopedProjectIds,
    range,
    extraFilters
  )
  const constraintFilters: Record<string, unknown>[] = [
    { term: { eventName: SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT } },
    timeRangeFilter("eventTime", range),
    { terms: { "properties.harnessProjectId": scopedProjectIds } },
    ...extraFilters
  ]
  const hookFilters: Record<string, unknown>[] = [
    { term: { eventName: "hook.executed" } },
    timeRangeFilter("eventTime", range),
    { terms: { "properties.harnessProjectId": scopedProjectIds } },
    ...extraFilters
  ]
  const projectOperationalAggs = buildProjectModeOperationalAggs(constraintFilters, hookFilters, {
    dedupeConstraintTraces: true,
    constraintFileLimit: 20,
    hookEventLimit: 32
  })
  const featureOperationalAggs = buildProjectModeOperationalAggs(constraintFilters, hookFilters, {
    dedupeConstraintTraces: true,
    constraintFileLimit: 10,
    hookEventLimit: 16
  })
  const raw = (await esQuery(getEsIndex("event"), {
    size: 0,
    query: {
      bool: {
        should: [
          { bool: { filter: codeGenFilters } },
          { bool: { filter: codeAdoptFilters } },
          { bool: { filter: constraintFilters } },
          { bool: { filter: hookFilters } }
        ],
        minimum_should_match: 1
      }
    },
    aggs: {
      by_project: {
        terms: { field: "properties.harnessProjectId", size: Math.max(1, scopedProjectIds.length) },
        aggs: {
          ...perBucketAggs,
          ...projectOperationalAggs,
          by_feature: {
            terms: {
              field: "properties.harnessFeatureSlug",
              size: PROJECT_MODE_FEATURE_SLUG_LIMIT
            },
            aggs: { ...perBucketAggs, ...featureOperationalAggs }
          },
          ...stageBucketCodeAggs(perBucketAggs)
        }
      }
    }
  })) as EsSearchResponse
  const projectAggs = asRecord(asRecord(raw).aggregations)
  const projectBuckets = asRecord(projectAggs.by_project).buckets
  const byProject = new Map<string, DashboardCodeStats>()
  const byFeature = new Map<string, DashboardCodeStats>()
  const byProjectStage = new Map<string, Record<StageBucket, DashboardCodeStats>>()
  const operationalByProject = new Map<string, ProjectModeOperationalStats>()
  const operationalByFeature = new Map<string, ProjectModeOperationalStats>()
  if (Array.isArray(projectBuckets)) {
    for (const bucket of projectBuckets) {
      const b = asRecord(bucket)
      const projectId = asString(b.key)
      if (!projectId) continue
      const hasProjectCodeEvents =
        asNumber(asRecord(b.code_gen).doc_count) > 0 ||
        asNumber(asRecord(b.code_adopt_measured).doc_count) > 0
      if (hasProjectCodeEvents) {
        byProject.set(projectId, normalizeCodeStatsFromContainer(b))
        byProjectStage.set(projectId, parseStageBucketCodeStats(b))
      }
      operationalByProject.set(projectId, parseProjectModeOperationalStats(b))
      const featureBuckets = asRecord(b.by_feature).buckets
      if (!Array.isArray(featureBuckets)) continue
      for (const featureBucket of featureBuckets) {
        const fb = asRecord(featureBucket)
        const slug = asString(fb.key)
        if (!slug) continue
        const key = projectFeatureKey(projectId, slug)
        const hasFeatureCodeEvents =
          asNumber(asRecord(fb.code_gen).doc_count) > 0 ||
          asNumber(asRecord(fb.code_adopt_measured).doc_count) > 0
        if (hasFeatureCodeEvents) {
          byFeature.set(key, normalizeCodeStatsFromContainer(fb))
        }
        operationalByFeature.set(key, parseProjectModeOperationalStats(fb))
      }
    }
  }
  return {
    byProject,
    byFeature,
    byProjectStage,
    operationalByProject,
    operationalByFeature
  }
}

/** Add this-range trace/code metrics to current project snapshots. */
async function enrichProjectModeProjectViews(
  projects: ProjectModeProjectView[],
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  access: DashboardAccessContext
): Promise<ProjectModeProjectView[]> {
  const projectIds = projects.map((project) => project.projectId)
  const includeSuspectedTechnicalDetail = isDashboardSuspectedTechnicalDetailAllowed(access)
  // Key code stats on the page's project ids (not just those with conversations)
  // so a project ranked high by 原始生成行数 still shows its adoption columns.
  const [usage, code] = await Promise.all([
    fetchProjectModePageUsage(projectIds, range, opts, access),
    fetchProjectModeProjectMetrics(projectIds, range, opts, access)
  ])
  return projects.map((project) => ({
    ...project,
    conversationCount: usage.perProject.get(project.projectId) ?? 0,
    ...(includeSuspectedTechnicalDetail
      ? {
          suspectedTechnicalDetailConversationCount:
            usage.perProjectSuspectedTechnicalDetail.get(project.projectId) ?? 0
        }
      : {}),
    devStageConversationCount: usage.perProjectDevStage.get(project.projectId) ?? 0,
    devAssociatedFeatureCount: usage.perProjectDevAssociatedFeatures.get(project.projectId) ?? 0,
    topSkills: usage.perProjectSkills.get(project.projectId) ?? [],
    codeStats: code.byProject.get(project.projectId) ?? null,
    systemConstraintReads:
      code.operationalByProject.get(project.projectId)?.systemConstraintReads ?? null,
    hookExecutions: code.operationalByProject.get(project.projectId)?.hookExecutions ?? null,
    stageBuckets: buildStageBuckets(
      usage.perProjectStageConversations.get(project.projectId),
      code.byProjectStage.get(project.projectId)
    ),
    features: project.features.map((feature) => {
      const key = projectFeatureKey(project.projectId, feature.slug)
      const operational = code.operationalByFeature.get(key)
      return {
        ...feature,
        codeStats: code.byFeature.get(key) ?? null,
        systemConstraintReads: operational?.systemConstraintReads ?? null,
        hookExecutions: operational?.hookExecutions ?? null
      }
    })
  }))
}

/** One list page: ES-paginated snapshot projects enriched with this-range usage / code. */
async function fetchProjectModeProjectPage(
  range: TimeRange,
  options?: ProjectModeProjectPageOptions,
  access: DashboardAccessContext = requireDashboardProjectModeAccess()
): Promise<ProjectModeProjectPageData> {
  const status = normalizeProjectModeProjectStatus(options?.status)
  const { sortBy, sortOrder } = normalizeProjectModeProjectSort(options, status)
  const metricSort = sortBy === "conversationCount" || sortBy === "generatedLines"

  // featureCount / default sort paginate the snapshot index directly; metric
  // sorts (active tab only) rank the full set first, then page.
  const sliced = metricSort
    ? await fetchProjectModeProjectPageMetricSorted(range, options, access, sortBy, sortOrder)
    : await fetchProjectModeProjectPageHits(options, access)
  return {
    ...sliced,
    sortBy,
    sortOrder,
    showSuspectedTechnicalDetailMetric: isDashboardSuspectedTechnicalDetailAllowed(access),
    projects: await enrichProjectModeProjectViews(sliced.projects, range, options, access)
  }
}

const PROJECT_MODE_EXPORT_PROJECT_BATCH_SIZE = 100

/** Fetch the full user-analysis and project-list datasets used by Excel export. */
async function fetchProjectModeExportData(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<ProjectModeExportData> {
  const access = requireDashboardProjectModeAccess()
  const snapshotResult = await fetchProjectModeExportSnapshotProjects(opts, access)
  const snapshots = snapshotResult.projects
  const leanProjectIds =
    opts?.fromLeanOnly === true
      ? snapshotResult.truncated
        ? await fetchProjectModeExportProjectIds(opts, access)
        : snapshots.map((project) => project.projectId)
      : undefined
  const usersPromise = fetchProjectModeExportUsers(range, opts, access, leanProjectIds)
  const projectsPromise = (async (): Promise<ProjectModeProjectView[]> => {
    const projects: ProjectModeProjectView[] = []
    for (
      let offset = 0;
      offset < snapshots.length;
      offset += PROJECT_MODE_EXPORT_PROJECT_BATCH_SIZE
    ) {
      const batch = snapshots.slice(offset, offset + PROJECT_MODE_EXPORT_PROJECT_BATCH_SIZE)
      projects.push(...(await enrichProjectModeProjectViews(batch, range, opts, access)))
    }
    return projects
  })()

  const [users, projects] = await Promise.all([usersPromise, projectsPromise])
  return {
    users,
    projects,
    projectTotal: snapshotResult.total,
    activeProjectTotal: snapshotResult.activeTotal,
    archivedProjectTotal: snapshotResult.archivedTotal,
    projectLimit: PROJECT_MODE_EXPORT_PROJECT_LIMIT,
    projectsTruncated: snapshotResult.truncated
  }
}

/** Upper bound on the commit-sha set collected for one feature's commit list. */
const PROJECT_MODE_FEATURE_COMMIT_SHA_LIMIT = 500

/**
 * Commit 明细 for a single project-mode feature.
 *
 * `git.commit.created` events carry no harness project/feature binding, so we
 * first resolve the feature's commit SHAs from its `code_adopt` events (which do
 * carry `harnessProjectId` + `harnessFeatureSlug` + `commitSha`), then page the
 * matching commits and join adoption — reusing the platform Commit 明细 plumbing.
 */
async function fetchProjectModeFeatureCommits(
  projectId: string,
  featureSlug: string,
  range: TimeRange,
  options?: number | CommitDetailsOptions
): Promise<{
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
}> {
  const access = requireDashboardProjectModeAccess()
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword, orgLv1List } =
    normalizeCommitDetailsOptions(options)
  const orgFilterClause = buildProjectModeOrgFilter({ upperOrgLv1: orgLv1List }, access)
  const normalizedProjectId = projectId.trim()
  const normalizedFeatureSlug = featureSlug.trim()
  const empty = { total: 0, page, pageSize, pushedOnly, items: [] as DashboardCommitDetail[] }
  if (!normalizedProjectId || !normalizedFeatureSlug) return empty

  // 1) 该特性关联的 commit sha 集合：取自带 commitSha 的 code_adopt 事件。
  //    按 generatedAt 落在所选时间范围内过滤，与特性级采纳明细（buildProjectModeCodeAggs）口径对齐。
  const shaRaw = asRecord(
    await esQuery(getEsIndex("event"), {
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { eventName: "code_adopt" } },
            { term: { "properties.harnessProjectId": normalizedProjectId } },
            { term: { "properties.harnessFeatureSlug": normalizedFeatureSlug } },
            { exists: { field: "properties.commitSha" } },
            timeRangeFilter("properties.generatedAt", range),
            ...(orgFilterClause ? [orgFilterClause] : [])
          ]
        }
      },
      aggs: {
        by_commit: {
          terms: { field: "properties.commitSha", size: PROJECT_MODE_FEATURE_COMMIT_SHA_LIMIT }
        }
      }
    })
  )
  const shaBuckets = asRecord(asRecord(shaRaw.aggregations).by_commit).buckets
  const commitShas = Array.isArray(shaBuckets)
    ? shaBuckets.map((bucket) => asString(asRecord(bucket).key)).filter(Boolean)
    : []
  if (commitShas.length === 0) return empty

  // 2) 拉取这些 sha 对应的 git.commit.created，并叠加 pushed / 部门 / 「室筛选」。
  const filters: Record<string, unknown>[] = [
    { term: { eventName: "git.commit.created" } },
    { terms: { "properties.commitSha": commitShas } }
  ]
  if (pushedOnly) filters.push({ term: { "properties.pushed": true } })
  appendOptionalFilter(filters, orgFilterClause)
  if (upperOrgLv1 !== null) filters.push(buildOrgLevelMatchFilter(upperOrgLv1))
  if (userKeyword !== null) filters.push(buildCommitUserMatchFilter(userKeyword))

  const raw = (await esQuery(getEsIndex("event"), {
    track_total_hits: true,
    from: (page - 1) * pageSize,
    size: pageSize,
    sort: [{ eventTime: { order: "desc" } }],
    query: { bool: { filter: filters } },
    _source: { includes: COMMIT_DETAIL_SOURCE_INCLUDES }
  })) as EsSearchResponse
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
    items: attachCommitAdoption(items, adoptionMap)
  }
}

/**
 * Commit 明细 for an entire project-mode project (all features aggregated).
 *
 * Same plumbing as {@link fetchProjectModeFeatureCommits} but resolves commit
 * SHAs by `harnessProjectId` only (no feature filter), so the project-level
 * adoption rate can drill straight into every commit's 采纳溯源.
 */
async function fetchProjectModeProjectCommits(
  projectId: string,
  range: TimeRange,
  options?: number | CommitDetailsOptions
): Promise<{
  total: number
  page: number
  pageSize: number
  pushedOnly: boolean
  items: DashboardCommitDetail[]
}> {
  const access = requireDashboardProjectModeAccess()
  const { page, pageSize, pushedOnly, upperOrgLv1, userKeyword, orgLv1List } =
    normalizeCommitDetailsOptions(options)
  const orgFilterClause = buildProjectModeOrgFilter({ upperOrgLv1: orgLv1List }, access)
  const normalizedProjectId = projectId.trim()
  const empty = { total: 0, page, pageSize, pushedOnly, items: [] as DashboardCommitDetail[] }
  if (!normalizedProjectId) return empty

  // 1) 该项目关联的 commit sha 集合：取自带 commitSha 的 code_adopt 事件（不按特性收窄）。
  const shaRaw = asRecord(
    await esQuery(getEsIndex("event"), {
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { eventName: "code_adopt" } },
            { term: { "properties.harnessProjectId": normalizedProjectId } },
            { exists: { field: "properties.commitSha" } },
            timeRangeFilter("properties.generatedAt", range),
            ...(orgFilterClause ? [orgFilterClause] : [])
          ]
        }
      },
      aggs: {
        by_commit: {
          terms: { field: "properties.commitSha", size: PROJECT_MODE_FEATURE_COMMIT_SHA_LIMIT }
        }
      }
    })
  )
  const shaBuckets = asRecord(asRecord(shaRaw.aggregations).by_commit).buckets
  const commitShas = Array.isArray(shaBuckets)
    ? shaBuckets.map((bucket) => asString(asRecord(bucket).key)).filter(Boolean)
    : []
  if (commitShas.length === 0) return empty

  // 2) 拉取这些 sha 对应的 git.commit.created，并叠加 pushed / 部门 / 「室筛选」。
  const filters: Record<string, unknown>[] = [
    { term: { eventName: "git.commit.created" } },
    { terms: { "properties.commitSha": commitShas } }
  ]
  if (pushedOnly) filters.push({ term: { "properties.pushed": true } })
  appendOptionalFilter(filters, orgFilterClause)
  if (upperOrgLv1 !== null) filters.push(buildOrgLevelMatchFilter(upperOrgLv1))
  if (userKeyword !== null) filters.push(buildCommitUserMatchFilter(userKeyword))

  const raw = (await esQuery(getEsIndex("event"), {
    track_total_hits: true,
    from: (page - 1) * pageSize,
    size: pageSize,
    sort: [{ eventTime: { order: "desc" } }],
    query: { bool: { filter: filters } },
    _source: { includes: COMMIT_DETAIL_SOURCE_INCLUDES }
  })) as EsSearchResponse
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
    items: attachCommitAdoption(items, adoptionMap)
  }
}

/**
 * 研发效能面板 payload.
 *
 * Scope is fixed rather than user-toggleable: project mode AND bound to a Lean
 * project. That is the premise the three metrics are defined against, so it is
 * applied here instead of being exposed as a filter the viewer could turn off
 * and silently change what the numbers mean.
 */
async function fetchDashboardEfficiency(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<DashboardEfficiencyData> {
  const access = requireDashboardProjectModeAccess()
  const orgFilterClause = buildProjectModeOrgFilter(opts, access)

  // Lean project ids come from the self-healing snapshot (the sole source of
  // truth for projectFromLean). An empty set is meaningful, not an error: it
  // means no Lean-bound projects matched, and every terms IN [] below then
  // aggregates to zero.
  const { ids: leanProjectIds, truncated } = await fetchProjectModeFilteredProjectIds(
    projectModeSnapshotFilters(orgFilterClause, true)
  )

  const codeExtraFilters = [
    ...(orgFilterClause ? [orgFilterClause] : []),
    { exists: { field: "properties.harnessProjectId" } },
    { terms: { "properties.harnessProjectId": leanProjectIds } }
  ]

  const [changeKindRaw, overallRaw, traceRaw, codeTraceRaw] = await Promise.all([
    // 指标 2 — adoption split by 新增 / 存量.
    fetchProjectModeCodeAggs(
      null,
      range,
      (perBucketAggs) => ({
        ...buildChangeKindAggs(perBucketAggs),
        ...buildNewRatioHistogramAgg()
      }),
      codeExtraFilters
    ),
    // Unsplit totals, used for the unmeasured-share credibility indicator.
    fetchProjectModeCodeAggs(null, range, (perBucketAggs) => perBucketAggs, codeExtraFilters),
    // 指标 3 numerator — tokens live on the trace index.
    esQuery(getEsIndex("trace"), {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            ...projectModeTraceFilters(range, orgFilterClause),
            { terms: { harnessProjectId: leanProjectIds } }
          ]
        }
      },
      aggs: {
        trace_count: { value_count: { field: "traceId" } },
        project_count: { cardinality: { field: "harnessProjectId" } },
        total_input_tokens: { sum: { field: "totalInputTokens" } },
        total_output_tokens: { sum: { field: "totalOutputTokens" } },
        total_tokens: { sum: { field: "totalTokens" } },
        // Flattened at trace-finish time (see summarizeTraceCacheTokens);
        // a part of the input total, not an addition to it.
        cache_read_tokens: { sum: { field: "cacheReadTokens" } }
      }
    }),
    // Traces that actually produced code, so the panel can show how much of the
    // token spend went to conversations that never wrote anything.
    esQuery(getEsIndex("event"), {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            { term: { eventName: "code_gen" } },
            timeRangeFilter("eventTime", range),
            ...codeExtraFilters
          ]
        }
      },
      aggs: { code_traces: { cardinality: { field: "properties.traceId" } } }
    })
  ])

  const overall = normalizeCodeStatsFromAggs(overallRaw)
  const traceAggs = asRecord(asRecord(traceRaw).aggregations)
  const codeTraceAggs = asRecord(asRecord(codeTraceRaw).aggregations)

  return {
    scalability: buildPendingScalability(),
    adoption: {
      overall,
      byChangeKind: normalizeChangeKindBuckets(changeKindRaw),
      newRatioHistogram: normalizeNewRatioHistogram(changeKindRaw),
      unmeasuredRatio: computeUnmeasuredRatio(overall)
    },
    compute: buildComputeEfficiency({
      totalInputTokens: asNumber(asRecord(traceAggs.total_input_tokens).value),
      totalOutputTokens: asNumber(asRecord(traceAggs.total_output_tokens).value),
      totalTokens: asNumber(asRecord(traceAggs.total_tokens).value),
      cacheReadTokens: asNumber(asRecord(traceAggs.cache_read_tokens).value),
      pushedAdoptedLines: overall.pushedAdoptedLines,
      traceCount: asNumber(asRecord(traceAggs.trace_count).value),
      codeProducingTraceCount: asNumber(asRecord(codeTraceAggs.code_traces).value)
    }),
    meta: {
      projectCount: asNumber(asRecord(traceAggs.project_count).value),
      truncated
    }
  }
}

/** Overview payload: snapshot aggregates + trace usage + code adoption + first list page. */
async function fetchProjectMode(
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<DashboardProjectModeData> {
  const access = requireDashboardProjectModeAccess()

  // 「仅精益项目」：先从自愈快照解析精益项目 id 集（projectFromLean 的唯一真源），仅用于圈定
  // 遥测汇总（trace / code）；快照聚合与项目列表各自按 projectFromLean term 直接过滤，无需 id 集。
  // id 集超过 PROJECT_MODE_PROJECT_ID_LIMIT 时截断，leanTruncated 透传给前端做守卫提示。空集表示
  // 无精益项目 → 遥测 terms IN [] 命中 0 条，汇总为 0（语义正确）。
  let leanProjectIds: string[] | undefined
  let leanTruncated = false
  if (opts?.fromLeanOnly === true) {
    const resolved = await fetchProjectModeFilteredProjectIds(
      projectModeSnapshotFilters(buildProjectModeOrgFilter(opts, access), true)
    )
    leanProjectIds = resolved.ids
    leanTruncated = resolved.truncated
  }

  // 总览与列表解耦：快照口径走 size:0 聚合、不回拉文档；列表第一页走 ES 分页。四条并行。
  const [snap, usage, code, projectPage] = await Promise.all([
    fetchProjectModeSnapshotAggs(opts, access),
    fetchProjectModeUsage(range, opts, access, leanProjectIds),
    fetchProjectModeAggregateCodeStats(range, opts, access, leanProjectIds),
    fetchProjectModeProjectPage(
      range,
      {
        ...opts,
        status: "active",
        page: 1,
        pageSize: PROJECT_MODE_DEFAULT_PROJECT_PAGE_SIZE,
        keyword: "",
        // 列表默认按创建时间降序；与渲染层初始排序态一致，避免首屏二次请求。
        sortBy: "createdAt",
        sortOrder: "desc"
      },
      access
    )
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
        codeStats: null,
        stageBuckets: emptyStageBuckets()
      })
    }
  }
  for (const [key, adapter] of adapters) {
    adapter.codeStats = code.byAdapter.get(key) ?? null
    adapter.stageBuckets = withStageBucketsCode(adapter.stageBuckets, code.byAdapterStage.get(key))
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
      codeStats: code.overall,
      skillCodeStats: code.skillOverall
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
    projects: projectPage.projects,
    leanTruncated,
    availableSources: code.availableSources
  }
}

/**
 * 「生产效能代码指标」按 source 局部换数：只重算两个子模块的整体 / Skill 代码采纳，
 * 不碰项目列表、对话数等其它维度。沿用 fetchProjectMode 的 org / 精益口径，叠加 source。
 */
async function fetchProjectModeCodeStatsBySource(
  range: TimeRange,
  opts: OrgFilterOptions | undefined,
  source: string | null | undefined
): Promise<{ codeStats: DashboardCodeStats; skillCodeStats: DashboardCodeStats }> {
  const access = requireDashboardProjectModeAccess()
  // 与 fetchProjectMode 一致：仅精益项目时先解析精益项目 id 集，用于圈定 code 事件。
  let leanProjectIds: string[] | undefined
  if (opts?.fromLeanOnly === true) {
    const resolved = await fetchProjectModeFilteredProjectIds(
      projectModeSnapshotFilters(buildProjectModeOrgFilter(opts, access), true)
    )
    leanProjectIds = resolved.ids
  }
  const code = await fetchProjectModeAggregateCodeStats(range, opts, access, leanProjectIds, source)
  return { codeStats: code.overall, skillCodeStats: code.skillOverall }
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
  /** Optional workflow stage name (group-label) to scope traces to a single stage. */
  nodeName?: string
  /** Optional node status (进行中/已完成/...) to further scope traces within a stage. */
  nodeStatus?: string
  /** Optional stage×skill bucket (插件约束（Harness）/ VibeCoding / 未归因) to scope traces. */
  stageBucket?: StageBucket
}

/** Project-mode traces for a single project (thread/trace pagination). */
async function fetchProjectModeTraces(
  projectId: string,
  range: TimeRange,
  options?: ProjectModeTracesOptions
): Promise<DashboardProjectModeTracesData> {
  const access = requireDashboardProjectModeAccess()
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) throw new Error("projectId is required")
  const normalizedFeatureSlug = options?.featureSlug?.trim()
  const normalizedNodeName = options?.nodeName?.trim()
  const normalizedNodeStatus = options?.nodeStatus?.trim()
  const stageBucket = options?.stageBucket
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
  const traceAccessFilter = buildProjectModeAccessFilter(access)
  const baseFilter = [
    timeRangeFilter("startedAt", range),
    { term: { harnessProjectId: normalizedProjectId } },
    ...(normalizedFeatureSlug ? [{ term: { harnessFeatureSlug: normalizedFeatureSlug } }] : []),
    ...(normalizedNodeName ? [harnessNodeNameTraceFilterClause(normalizedNodeName)] : []),
    ...(normalizedNodeStatus ? [{ term: { harnessNodeStatus: normalizedNodeStatus } }] : []),
    ...(stageBucket ? [stageBucketTraceFilterClause(stageBucket)] : []),
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
    // 与用户/技能详情的 trace 查询保持一致用布尔值；total 在下方用 Math.min 收口到
    // max_result_window，无需把数值塞进 track_total_hits（部分 ES 网关会因此 400）。
    track_total_hits: true,
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

/** Sub-row of a stage: conversations + code adoption for one node status (进行中/已完成/...). */
interface ProjectModeNodeStatus {
  status: string
  conversationCount: number
  codeStats: DashboardCodeStats | null
}

/** One workflow node (stage) breakdown row for a feature. */
interface ProjectModeFeatureNode {
  nodeName: string
  conversationCount: number
  codeStats: DashboardCodeStats | null
  systemConstraintReads?: ProjectModeConstraintReadStats | null
  hookExecutions?: ProjectModeHookStats | null
  /** Status-at-turn-time sub-breakdown within this stage (进行中/已完成/...). */
  byStatus: ProjectModeNodeStatus[]
  /** Stage×skill 三桶拆分（插件约束（Harness）/ VibeCoding / 未归因），口径同列表行。 */
  stageBuckets: DashboardStageBuckets
}

/** Merge per-status conversation counts + code stats into a sorted status sub-breakdown. */
function buildNodeStatusBreakdown(
  convByStatus: Map<string, number> | undefined,
  codeByStatus: Map<string, DashboardCodeStats> | undefined
): ProjectModeNodeStatus[] {
  const statuses = new Set<string>([
    ...(convByStatus?.keys() ?? []),
    ...(codeByStatus?.keys() ?? [])
  ])
  return [...statuses]
    .map((status) => ({
      status,
      conversationCount: convByStatus?.get(status) ?? 0,
      codeStats: codeByStatus?.get(status) ?? null
    }))
    .sort((a, b) => b.conversationCount - a.conversationCount)
}

/** terms-agg size for the status sub-bucket (only ~9 node statuses exist). */
const NODE_STATUS_TERMS_SIZE = 16

/**
 * Stage row name for turns/code events that carry no workflow-node attribution —
 * historical data from before node attribution shipped, or abnormal data missing
 * the field. Surfaced as a dedicated「未归因」stage via the terms-agg `missing`
 * bucket (reusing the shared stage×skill 未归因 label for口径一致性).
 */
const UNATTRIBUTED_NODE_NAME = STAGE_BUCKET_LABELS.unattributed

interface ProjectModeOperationalDetailScope {
  projectId: string
  featureSlug?: string
  nodeName?: string
}

const PROJECT_MODE_OPERATIONAL_DETAIL_PAGE_SIZE = 500

function harnessNodeNameEventFilterClause(nodeName: string): Record<string, unknown> {
  if (nodeName === UNATTRIBUTED_NODE_NAME) {
    return {
      bool: { must_not: { exists: { field: "properties.harnessNodeName" } } }
    }
  }
  return { term: { "properties.harnessNodeName": nodeName } }
}

async function fetchAllProjectModeConstraintFiles(
  filters: Record<string, unknown>[]
): Promise<ProjectModeConstraintFileStat[]> {
  const files: ProjectModeConstraintFileStat[] = []
  const seenAfterKeys = new Set<string>()
  let after: Record<string, unknown> | undefined

  for (;;) {
    const raw = (await esQuery(getEsIndex("event"), {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        items: {
          composite: {
            size: PROJECT_MODE_OPERATIONAL_DETAIL_PAGE_SIZE,
            sources: [
              {
                path: { terms: { field: "properties.constraintFiles" } }
              }
            ],
            ...(after ? { after } : {})
          },
          aggs: {
            trace_count: { cardinality: { field: "properties.traceId" } }
          }
        }
      }
    })) as EsSearchResponse
    const items = asRecord(asRecord(raw.aggregations).items)
    const buckets = items.buckets
    if (!Array.isArray(buckets) || buckets.length === 0) break

    for (const bucket of buckets) {
      const b = asRecord(bucket)
      const path = asString(asRecord(b.key).path)
      if (!path) continue
      const traceCount = asNumber(asRecord(b.trace_count).value)
      files.push({ path, traceCount: traceCount > 0 ? traceCount : asNumber(b.doc_count) })
    }

    const nextAfter = asRecord(items.after_key)
    if (Object.keys(nextAfter).length === 0) break
    const signature = JSON.stringify(nextAfter)
    if (seenAfterKeys.has(signature)) break
    seenAfterKeys.add(signature)
    after = nextAfter
  }

  return files.sort((a, b) => b.traceCount - a.traceCount || a.path.localeCompare(b.path))
}

async function fetchAllProjectModeHookEvents(
  filters: Record<string, unknown>[]
): Promise<ProjectModeHookEventStat[]> {
  const events: ProjectModeHookEventStat[] = []
  const seenAfterKeys = new Set<string>()
  let after: Record<string, unknown> | undefined

  for (;;) {
    const raw = (await esQuery(getEsIndex("event"), {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        items: {
          composite: {
            size: PROJECT_MODE_OPERATIONAL_DETAIL_PAGE_SIZE,
            sources: [
              {
                event: { terms: { field: "properties.event" } }
              }
            ],
            ...(after ? { after } : {})
          }
        }
      }
    })) as EsSearchResponse
    const items = asRecord(asRecord(raw.aggregations).items)
    const buckets = items.buckets
    if (!Array.isArray(buckets) || buckets.length === 0) break

    for (const bucket of buckets) {
      const b = asRecord(bucket)
      const event = asString(asRecord(b.key).event)
      if (event) events.push({ event, count: asNumber(b.doc_count) })
    }

    const nextAfter = asRecord(items.after_key)
    if (Object.keys(nextAfter).length === 0) break
    const signature = JSON.stringify(nextAfter)
    if (seenAfterKeys.has(signature)) break
    seenAfterKeys.add(signature)
    after = nextAfter
  }

  return events.sort((a, b) => b.count - a.count || a.event.localeCompare(b.event))
}

/** Complete operational lists are fetched lazily so the project list query stays compact. */
async function fetchProjectModeOperationalDetails(
  scope: ProjectModeOperationalDetailScope,
  range: TimeRange,
  opts?: OrgFilterOptions
): Promise<ProjectModeOperationalDetails> {
  const access = requireDashboardProjectModeAccess()
  const projectId = typeof scope?.projectId === "string" ? scope.projectId.trim() : ""
  const featureSlug = typeof scope?.featureSlug === "string" ? scope.featureSlug.trim() : ""
  const nodeName = typeof scope?.nodeName === "string" ? scope.nodeName.trim() : ""
  if (!projectId) return { constraintFiles: [], hookEvents: [] }

  const orgFilterClause = buildProjectModeOrgFilter(opts, access)
  const contextFilters: Record<string, unknown>[] = [
    ...(orgFilterClause ? [orgFilterClause] : []),
    { term: { "properties.harnessProjectId": projectId } },
    ...(featureSlug ? [{ term: { "properties.harnessFeatureSlug": featureSlug } }] : []),
    ...(nodeName ? [harnessNodeNameEventFilterClause(nodeName)] : [])
  ]
  const constraintFilters: Record<string, unknown>[] = [
    { term: { eventName: SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT } },
    timeRangeFilter("eventTime", range),
    ...contextFilters
  ]
  const hookFilters: Record<string, unknown>[] = [
    { term: { eventName: "hook.executed" } },
    timeRangeFilter("eventTime", range),
    ...contextFilters
  ]
  const [constraintFiles, hookEvents] = await Promise.all([
    fetchAllProjectModeConstraintFiles(constraintFilters),
    fetchAllProjectModeHookEvents(hookFilters)
  ])
  return { constraintFiles, hookEvents }
}

/**
 * Trace filter clause scoping to one stage by name. The 未归因 stage is the
 * terms-agg `missing` bucket, so it matches docs *without* a harnessNodeName
 * rather than a literal value — mirror that here with `must_not exists`.
 */
function harnessNodeNameTraceFilterClause(nodeName: string): Record<string, unknown> {
  if (nodeName === UNATTRIBUTED_NODE_NAME) {
    return { bool: { must_not: { exists: { field: "harnessNodeName" } } } }
  }
  return { term: { harnessNodeName: nodeName } }
}

/** Trace-side `by_node` agg (conversations per stage) with nested status + stage-bucket sub-aggs. */
function traceNodeStatusAgg(): Record<string, unknown> {
  return {
    by_node: {
      terms: {
        field: "harnessNodeName",
        size: PROJECT_MODE_FEATURE_SLUG_LIMIT,
        missing: UNATTRIBUTED_NODE_NAME
      },
      aggs: {
        by_status: { terms: { field: "harnessNodeStatus", size: NODE_STATUS_TERMS_SIZE } },
        ...stageBucketTraceAggs()
      }
    }
  }
}

/** Event-side `by_node` agg (code stats per stage) with nested status + stage-bucket sub-aggs carrying the same code stats. */
function codeNodeStatusAgg(perBucketAggs: Record<string, unknown>): Record<string, unknown> {
  return {
    by_node: {
      terms: {
        field: "properties.harnessNodeName",
        size: PROJECT_MODE_FEATURE_SLUG_LIMIT,
        missing: UNATTRIBUTED_NODE_NAME
      },
      aggs: {
        ...perBucketAggs,
        by_status: {
          terms: { field: "properties.harnessNodeStatus", size: NODE_STATUS_TERMS_SIZE },
          aggs: perBucketAggs
        },
        ...stageBucketCodeAggs(perBucketAggs)
      }
    }
  }
}

/**
 * Feature-stage event aggregation shared by code-adoption, successful system-
 * constraint reads and hook executions. Keeping all event-side metrics under
 * one `by_node` tree avoids an extra ES request (or a per-read event scan) when
 * the user expands a feature's stage breakdown.
 */
function featureNodeEventAgg(
  perBucketAggs: Record<string, unknown>,
  codeGenFilters: Record<string, unknown>[],
  codeAdoptFilters: Record<string, unknown>[],
  constraintFilters: Record<string, unknown>[],
  hookFilters: Record<string, unknown>[]
): Record<string, unknown> {
  const codeEventFilter = {
    bool: {
      should: [{ bool: { filter: codeGenFilters } }, { bool: { filter: codeAdoptFilters } }],
      minimum_should_match: 1
    }
  }
  return {
    by_node: {
      terms: {
        field: "properties.harnessNodeName",
        size: PROJECT_MODE_FEATURE_SLUG_LIMIT,
        missing: UNATTRIBUTED_NODE_NAME
      },
      aggs: {
        ...perBucketAggs,
        // Scope status rows to code events. Otherwise hook/constraint documents
        // would create misleading zero-code status rows in the existing UI.
        code_status_scope: {
          filter: codeEventFilter,
          aggs: {
            by_status: {
              terms: { field: "properties.harnessNodeStatus", size: NODE_STATUS_TERMS_SIZE },
              aggs: perBucketAggs
            }
          }
        },
        ...stageBucketCodeAggs(perBucketAggs),
        ...buildProjectModeOperationalAggs(constraintFilters, hookFilters)
      }
    }
  }
}

/** Parse a trace `by_node` agg container → per-node conversation totals + per-status + per-stage-bucket sub-maps. */
function parseTraceNodeBuckets(aggregations: unknown): {
  conversationByNode: Map<string, number>
  convStatusByNode: Map<string, Map<string, number>>
  convStageByNode: Map<string, Record<StageBucket, number>>
} {
  const conversationByNode = new Map<string, number>()
  const convStatusByNode = new Map<string, Map<string, number>>()
  const convStageByNode = new Map<string, Record<StageBucket, number>>()
  const buckets = asRecord(asRecord(aggregations).by_node).buckets
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      const b = asRecord(bucket)
      const nodeName = asString(b.key)
      if (!nodeName) continue
      conversationByNode.set(nodeName, asNumber(b.doc_count))
      convStageByNode.set(nodeName, parseStageBucketConversations(b))
      const statusMap = new Map<string, number>()
      const statusBuckets = asRecord(b.by_status).buckets
      if (Array.isArray(statusBuckets)) {
        for (const sb of statusBuckets) {
          const s = asRecord(sb)
          const status = asString(s.key)
          if (status) statusMap.set(status, asNumber(s.doc_count))
        }
      }
      if (statusMap.size > 0) convStatusByNode.set(nodeName, statusMap)
    }
  }
  return { conversationByNode, convStatusByNode, convStageByNode }
}

/** Parse an event `by_node` agg container → per-node code stats + per-status + per-stage-bucket sub-maps. */
function parseCodeNodeBuckets(aggregations: unknown): {
  codeByNode: Map<string, DashboardCodeStats>
  codeStatusByNode: Map<string, Map<string, DashboardCodeStats>>
  codeStageByNode: Map<string, Record<StageBucket, DashboardCodeStats>>
} {
  const codeByNode = new Map<string, DashboardCodeStats>()
  const codeStatusByNode = new Map<string, Map<string, DashboardCodeStats>>()
  const codeStageByNode = new Map<string, Record<StageBucket, DashboardCodeStats>>()
  const buckets = asRecord(asRecord(aggregations).by_node).buckets
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      const b = asRecord(bucket)
      const nodeName = asString(b.key)
      if (!nodeName) continue
      const scopedCodeEvents = asRecord(b.code_status_scope)
      // The combined feature query also contains constraint/hook-only buckets.
      // Do not turn those into misleading all-zero code stats. Legacy callers
      // have no code_status_scope and retain their original parsing behavior.
      if (!("code_status_scope" in b) || asNumber(scopedCodeEvents.doc_count) > 0) {
        codeByNode.set(nodeName, normalizeCodeStatsFromContainer(b))
        codeStageByNode.set(nodeName, parseStageBucketCodeStats(b))
      }
      const statusMap = new Map<string, DashboardCodeStats>()
      const scopedStatusBuckets = asRecord(scopedCodeEvents.by_status).buckets
      const statusBuckets = Array.isArray(scopedStatusBuckets)
        ? scopedStatusBuckets
        : asRecord(b.by_status).buckets
      if (Array.isArray(statusBuckets)) {
        for (const sb of statusBuckets) {
          const s = asRecord(sb)
          const status = asString(s.key)
          if (status) statusMap.set(status, normalizeCodeStatsFromContainer(s))
        }
      }
      if (statusMap.size > 0) codeStatusByNode.set(nodeName, statusMap)
    }
  }
  return { codeByNode, codeStatusByNode, codeStageByNode }
}

/** Parse the non-code metrics carried by the combined feature-stage event agg. */
function parseFeatureOperationalNodeBuckets(aggregations: unknown): {
  constraintReadsByNode: Map<string, ProjectModeConstraintReadStats>
  hookExecutionsByNode: Map<string, ProjectModeHookStats>
} {
  const constraintReadsByNode = new Map<string, ProjectModeConstraintReadStats>()
  const hookExecutionsByNode = new Map<string, ProjectModeHookStats>()
  const buckets = asRecord(asRecord(aggregations).by_node).buckets
  if (!Array.isArray(buckets)) return { constraintReadsByNode, hookExecutionsByNode }

  for (const bucket of buckets) {
    const b = asRecord(bucket)
    const nodeName = asString(b.key)
    if (!nodeName) continue
    const operational = parseProjectModeOperationalStats(b)
    if (operational.systemConstraintReads) {
      constraintReadsByNode.set(nodeName, operational.systemConstraintReads)
    }
    if (operational.hookExecutions) {
      hookExecutionsByNode.set(nodeName, operational.hookExecutions)
    }
  }

  return { constraintReadsByNode, hookExecutionsByNode }
}

/** Merge parsed trace + event node maps into the sorted stage breakdown (with status sub-rows). */
function buildFeatureNodeBreakdown(
  trace: ReturnType<typeof parseTraceNodeBuckets>,
  code: ReturnType<typeof parseCodeNodeBuckets>,
  operational?: ReturnType<typeof parseFeatureOperationalNodeBuckets>
): ProjectModeFeatureNode[] {
  const nodeNames = new Set<string>([
    ...trace.conversationByNode.keys(),
    ...code.codeByNode.keys(),
    ...(operational?.constraintReadsByNode.keys() ?? []),
    ...(operational?.hookExecutionsByNode.keys() ?? [])
  ])
  return (
    [...nodeNames]
      .map((nodeName) => ({
        nodeName,
        conversationCount: trace.conversationByNode.get(nodeName) ?? 0,
        codeStats: code.codeByNode.get(nodeName) ?? null,
        systemConstraintReads: operational?.constraintReadsByNode.get(nodeName) ?? null,
        hookExecutions: operational?.hookExecutionsByNode.get(nodeName) ?? null,
        byStatus: buildNodeStatusBreakdown(
          trace.convStatusByNode.get(nodeName),
          code.codeStatusByNode.get(nodeName)
        ),
        stageBuckets: buildStageBuckets(
          trace.convStageByNode.get(nodeName),
          code.codeStageByNode.get(nodeName)
        )
      }))
      // Conversation-busiest stage first; 未归因（历史/异常数据）always pinned last.
      .sort((a, b) => {
        const aUn = a.nodeName === UNATTRIBUTED_NODE_NAME ? 1 : 0
        const bUn = b.nodeName === UNATTRIBUTED_NODE_NAME ? 1 : 0
        if (aUn !== bUn) return aUn - bUn
        return b.conversationCount - a.conversationCount
      })
  )
}

/**
 * Per-stage (workflow node) breakdown for one feature: conversation count (trace
 * index, grouped by harnessNodeName) + code adoption (event index, grouped by
 * properties.harnessNodeName, scoped to the feature). Forward-only — only turns that
 * ran after node attribution shipped carry a harnessNodeName, so older conversations
 * do not appear here.
 */
async function fetchProjectModeFeatureNodes(
  projectId: string,
  featureSlug: string,
  range: TimeRange
): Promise<ProjectModeFeatureNode[]> {
  const access = requireDashboardProjectModeAccess()
  const normalizedProjectId = projectId.trim()
  const normalizedFeatureSlug = featureSlug.trim()
  if (!normalizedProjectId || !normalizedFeatureSlug) return []

  // 1) conversations per stage (+ status sub-breakdown) — trace index.
  const traceAccessFilter = buildProjectModeAccessFilter(access)
  const traceBody = {
    size: 0,
    query: {
      bool: {
        filter: [
          timeRangeFilter("startedAt", range),
          { term: { harnessProjectId: normalizedProjectId } },
          { term: { harnessFeatureSlug: normalizedFeatureSlug } },
          ...(traceAccessFilter ? [traceAccessFilter] : [])
        ]
      }
    },
    aggs: traceNodeStatusAgg()
  }
  // 2) Code adoption + operational telemetry share one event-side by-stage
  // aggregation. Mirror fetchProjectModeProjectMetrics' org/access filter so
  // a non-admin never sees another org's events for this project+feature.
  const orgFilterClause = buildProjectModeOrgFilter(undefined, access)
  const eventContextFilters: Record<string, unknown>[] = [
    ...(orgFilterClause ? [orgFilterClause] : []),
    { term: { "properties.harnessProjectId": normalizedProjectId } },
    { term: { "properties.harnessFeatureSlug": normalizedFeatureSlug } }
  ]
  const { codeGenFilters, codeAdoptFilters, perBucketAggs } = buildProjectModeCodeAggs(
    null,
    range,
    eventContextFilters
  )
  const constraintFilters: Record<string, unknown>[] = [
    { term: { eventName: SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT } },
    timeRangeFilter("eventTime", range),
    ...eventContextFilters
  ]
  const hookFilters: Record<string, unknown>[] = [
    { term: { eventName: "hook.executed" } },
    timeRangeFilter("eventTime", range),
    ...eventContextFilters
  ]
  const eventBody = {
    size: 0,
    query: {
      bool: {
        should: [
          { bool: { filter: codeGenFilters } },
          { bool: { filter: codeAdoptFilters } },
          { bool: { filter: constraintFilters } },
          { bool: { filter: hookFilters } }
        ],
        minimum_should_match: 1
      }
    },
    aggs: featureNodeEventAgg(
      perBucketAggs,
      codeGenFilters,
      codeAdoptFilters,
      constraintFilters,
      hookFilters
    )
  }

  // Trace and event indices are independent; query them concurrently so adding
  // operational metrics does not add another serial round trip to stage expand.
  const [traceRaw, eventRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), traceBody) as Promise<EsSearchResponse>,
    esQuery(getEsIndex("event"), eventBody) as Promise<EsSearchResponse>
  ])
  const traceParsed = parseTraceNodeBuckets(traceRaw.aggregations)
  const eventAggregations = eventRaw.aggregations
  const codeParsed = parseCodeNodeBuckets(eventAggregations)
  const operationalParsed = parseFeatureOperationalNodeBuckets(eventAggregations)

  // 3) union of stages seen in either index; keep conversation-busiest first.
  return buildFeatureNodeBreakdown(traceParsed, codeParsed, operationalParsed)
}

/** DEV mock: a deterministic per-node breakdown derived from project/feature seed. */
function makeMockProjectModeFeatureNodes(
  projectId: string,
  featureSlug: string
): ProjectModeFeatureNode[] {
  const seed = `${projectId}/${featureSlug}`
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const nodeNames = ["Dev-行为规格", "Dev-技术设计", "Dev-代码实现", "Dev-单元测试"]
  const baseGenerated = 120 + (h % 240)
  const base = makeDashboardCodeStats({
    generatedLines: baseGenerated,
    deletedLines: 0,
    measuredGeneratedLines: baseGenerated,
    effectiveGeneratedLines: baseGenerated,
    adoptedLines: Math.round(baseGenerated * 0.62),
    pushedMeasuredGeneratedLines: baseGenerated,
    pushedEffectiveGeneratedLines: baseGenerated,
    pushedAdoptedLines: Math.round(baseGenerated * 0.5),
    pushedCommitCount: 3
  })
  const split = splitMockCodeStatsAcrossFeatures(base, nodeNames.length)
  const nodes: ProjectModeFeatureNode[] = nodeNames.map((nodeName, i) => {
    // Unsigned shift (>>>) so a high-bit seed never yields a negative count; +1 so
    // every mock stage shows a non-empty status sub-breakdown.
    const conversationCount = 1 + ((h >>> (i * 4)) % 8)
    const codeStats = split[i] ?? null
    const inProgress = Math.ceil(conversationCount / 2)
    // Split the stage's code stats across its two statuses so the mock shows the
    // full four-rate breakdown (with numerator/denominator) under each status.
    const statusSplit = codeStats ? splitMockCodeStatsAcrossFeatures(codeStats, 2) : []
    const successfulReadCount = conversationCount * 2 + i
    return {
      nodeName,
      conversationCount,
      codeStats,
      systemConstraintReads: {
        traceCount: conversationCount,
        successfulReadCount,
        distinctFileCount: 2,
        filesTruncated: false,
        files: [
          { path: "sys/project.md", traceCount: conversationCount },
          { path: `sys/stages/${i + 1}.md`, traceCount: Math.max(1, conversationCount - 1) }
        ]
      },
      hookExecutions: {
        executionCount: conversationCount * 3,
        blockedCount: i === 2 ? 1 : 0,
        byEvent: [
          { event: "PreToolUse", count: conversationCount * 2 },
          { event: "PostToolUse", count: conversationCount }
        ]
      },
      byStatus: [
        { status: "进行中", conversationCount: inProgress, codeStats: statusSplit[0] ?? null },
        {
          status: "已完成",
          conversationCount: conversationCount - inProgress,
          codeStats: statusSplit[1] ?? null
        }
      ].filter((s) => s.conversationCount > 0),
      stageBuckets: makeMockStageBuckets(codeStats, conversationCount)
    }
  })
  // A 未归因 stage for historical/abnormal data with no node attribution: no status
  // sub-rows, and (per classifyHarnessStageBucket) all of it falls into the
  // unattributed stage×skill bucket since these turns carry no stage status.
  const unattributedConversations = 1 + (h % 4)
  const unattributedCode = split[0] ?? null
  nodes.push({
    nodeName: UNATTRIBUTED_NODE_NAME,
    conversationCount: unattributedConversations,
    codeStats: unattributedCode,
    systemConstraintReads: null,
    hookExecutions: null,
    byStatus: [],
    stageBuckets: {
      pluginConstrained: { conversationCount: 0, codeStats: null },
      vibecoding: { conversationCount: 0, codeStats: null },
      unattributed: { conversationCount: unattributedConversations, codeStats: unattributedCode }
    }
  })
  return nodes
}

/** Cross-user aggregate for a single plugin (adapter), surfaced in the plugin list. */
interface DashboardPluginAggregate {
  adapterName: string
  conversationCount: number
  projectCount: number
  codeStats: DashboardCodeStats | null
  byNode: ProjectModeFeatureNode[]
}

/**
 * Aggregate one plugin's project-mode usage across users: conversations + distinct
 * projects (trace index) and code adoption (event index), both overall and per
 * workflow node (stage). Keyed on harnessAdapterName so it merges plugin versions.
 */
async function fetchPluginAggregate(
  adapterName: string,
  range: TimeRange
): Promise<DashboardPluginAggregate> {
  const access = requireDashboardProjectModeAccess()
  const normalizedAdapterName = adapterName.trim()
  const empty: DashboardPluginAggregate = {
    adapterName: normalizedAdapterName,
    conversationCount: 0,
    projectCount: 0,
    codeStats: null,
    byNode: []
  }
  if (!normalizedAdapterName) return empty

  const orgFilterClause = buildProjectModeOrgFilter(undefined, access)
  // Event side mirrors fetchProjectModeAggregateCodeStats: only project-mode code
  // events (those carrying properties.harnessProjectId), scoped to this adapter.
  const adapterEventFilters = [
    ...(orgFilterClause ? [orgFilterClause] : []),
    { exists: { field: "properties.harnessProjectId" } },
    { term: { "properties.harnessAdapterName": normalizedAdapterName } }
  ]

  const [traceRaw, overallCodeRaw, nodeCodeRaw] = await Promise.all([
    esQuery(getEsIndex("trace"), {
      size: 0,
      query: {
        bool: {
          filter: [
            ...projectModeTraceFilters(range, orgFilterClause),
            { term: { harnessAdapterName: normalizedAdapterName } }
          ]
        }
      },
      aggs: {
        conversation_count: { value_count: { field: "traceId" } },
        project_count: { cardinality: { field: "harnessProjectId" } },
        ...traceNodeStatusAgg()
      }
    }) as Promise<EsSearchResponse>,
    fetchProjectModeCodeAggs(null, range, (perBucketAggs) => perBucketAggs, adapterEventFilters),
    fetchProjectModeCodeAggs(null, range, codeNodeStatusAgg, adapterEventFilters)
  ])

  const traceAggs = asRecord(traceRaw.aggregations)
  const conversationCount = asNumber(asRecord(traceAggs.conversation_count).value)
  const projectCount = asNumber(asRecord(traceAggs.project_count).value)
  const traceParsed = parseTraceNodeBuckets(traceAggs)
  const codeStats = overallCodeRaw ? normalizeCodeStatsFromAggs(overallCodeRaw) : null
  const codeParsed = parseCodeNodeBuckets(asRecord(nodeCodeRaw).aggregations)
  const byNode = buildFeatureNodeBreakdown(traceParsed, codeParsed)

  return { adapterName: normalizedAdapterName, conversationCount, projectCount, codeStats, byNode }
}

/** DEV mock: a deterministic plugin aggregate derived from the adapter name seed. */
function makeMockPluginAggregate(adapterName: string): DashboardPluginAggregate {
  const byNode = makeMockProjectModeFeatureNodes(adapterName, "plugin-aggregate")
  const conversationCount = byNode.reduce((sum, n) => sum + n.conversationCount, 0)
  const codeStats = makeDashboardCodeStats({
    generatedLines: 800,
    deletedLines: 0,
    measuredGeneratedLines: 800,
    effectiveGeneratedLines: 800,
    adoptedLines: 520,
    pushedMeasuredGeneratedLines: 800,
    pushedEffectiveGeneratedLines: 800,
    pushedAdoptedLines: 410,
    pushedCommitCount: 12
  })
  return { adapterName, conversationCount, projectCount: 3, codeStats, byNode }
}

// ─────────────────────────────────────────────────────────
// IPC Registration
// ─────────────────────────────────────────────────────────

type DashboardRequestHandler<TArgs extends unknown[], TResult> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => TResult | Promise<TResult>

function registerLatestDashboardHandler<TArgs extends unknown[], TResult>(
  target: typeof ipcMain,
  channel: string,
  handler: DashboardRequestHandler<TArgs, TResult>,
  resolveFamily: (...args: TArgs) => string = () => channel
): void {
  target.handle(channel, async (event, ...rawArgs) => {
    const args = rawArgs as TArgs
    const family = resolveFamily(...args)
    try {
      return await dashboardRequestCoordinator.run(event.sender, family, () =>
        Promise.resolve(handler(event, ...args))
      )
    } catch (error) {
      if (isDashboardRequestCancelled(error) || isDashboardEsRequestCancelled(error)) {
        return { success: false, cancelled: true, error: "Request cancelled" }
      }
      throw error
    }
  })
}

function getSkillEvalRequestFamily(options?: DashboardSkillEvalOptions): string {
  const mode = options?.listOnly
    ? "list"
    : options?.statsOnly
      ? "stats"
      : options?.recentOnly
        ? "recent"
        : "full"
  const skillNames = options?.skillNames
    ?.slice(0, 16)
    .map((name) => name.slice(0, 64))
    .join(",")
  const skill = (skillNames || options?.skillName?.trim() || "all").slice(0, 256)
  const version = (options?.skillVersion?.trim() || "all").slice(0, 64)
  return `dashboard:skillEvalSummary:${mode}:${skill}:${version}`
}

type DashboardUserProfilesFamily =
  | "dashboard-market"
  | "project-mode-market"
  | "harness-market"
  | "customize-market"

interface DashboardUserProfilesOptions {
  family?: DashboardUserProfilesFamily
}

const DASHBOARD_USER_PROFILES_FAMILIES = new Set<DashboardUserProfilesFamily>([
  "dashboard-market",
  "project-mode-market",
  "harness-market",
  "customize-market"
])

function getUserProfilesRequestFamily(options?: DashboardUserProfilesOptions): string {
  const family = options?.family
  return `dashboard:userProfiles:${
    family && DASHBOARD_USER_PROFILES_FAMILIES.has(family) ? family : "default"
  }`
}

function logDashboardRequestError(label: string, error: unknown): void {
  if (isDashboardRequestCancelled(error) || isDashboardEsRequestCancelled(error)) return
  console.error(`[Dashboard] ${label} error:`, error)
}

export function registerDashboardHandlers(_ipcMain: typeof ipcMain): void {
  _ipcMain.handle("dashboard:cancelRequests", (event, families?: unknown) => {
    const sanitizedFamilies = Array.isArray(families)
      ? families
          .filter((family): family is string => typeof family === "string")
          .map((family) => family.trim())
          .filter((family) => family.length > 0 && family.length <= 512)
          .slice(0, 32)
      : undefined
    return {
      cancelled: dashboardRequestCoordinator.cancel(event.sender.id, sanitizedFamilies)
    }
  })

  _ipcMain.handle("dashboard:isAllowed", async () => {
    return getDashboardAccessContext().loggedIn
  })

  _ipcMain.handle("dashboard:isProjectModeAllowed", async () => {
    return isDashboardProjectModeAllowed()
  })

  _ipcMain.handle("dashboard:isAnalysisAgentAllowed", async () => {
    return isDashboardAnalysisAgentAllowed()
  })

  _ipcMain.handle("dashboard:isTraceEvolverReviewAdmin", async () => {
    return isTraceEvolverReviewAdmin()
  })

  _ipcMain.handle("dashboard:isUncommittedAnalysisAllowed", async () => {
    return isDashboardUncommittedAnalysisAllowed()
  })

  _ipcMain.handle("dashboard:isAwardsAdmin", async () => {
    return isDashboardAwardsAdmin()
  })

  _ipcMain.handle("dashboard:isSkillEvalAllowed", async () => {
    return isDashboardSkillEvalAllowed()
  })

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:esQuery",
    async (_, input: DashboardEsQueryInput) => {
      try {
        const access = requireDashboardAccess()
        const result = await executeDashboardEsQuery(input, {
          nodes: getEsNodes(),
          auth: getEsAuth(),
          indexByAlias: getDashboardEsIndexByAlias(),
          injectedFilters: buildDashboardEsQueryFilters(input, access),
          access: {
            sapId: access.sapId,
            ystId: access.ystId,
            unrestricted: access.unrestricted
          },
          signal: getDashboardRequestSignal()
        })
        return { success: true, data: result }
      } catch (e) {
        logDashboardRequestError("esQuery", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:analysisAgent", async (_, input: DashboardAnalysisAgentInput) => {
    try {
      requireDashboardAnalysisAgentAccess()
      const access = requireDashboardAccess()
      const result = await runDashboardAnalysisAgent(input, {
        executeQuery: (queryInput) =>
          executeDashboardEsQuery(queryInput, {
            nodes: getEsNodes(),
            auth: getEsAuth(),
            indexByAlias: getDashboardEsIndexByAlias(),
            injectedFilters: buildDashboardEsQueryFilters(queryInput, access),
            access: {
              sapId: access.sapId,
              ystId: access.ystId,
              unrestricted: access.unrestricted
            }
          })
      })
      return { success: true, data: result }
    } catch (e) {
      console.error("[Dashboard] analysisAgent error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectMode",
    async (_, range: TimeRange, _granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProjectMode(range, opts) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectMode(range, opts) }
      } catch (e) {
        logDashboardRequestError("projectMode", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:efficiency",
    async (_, range: TimeRange, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockEfficiency() }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchDashboardEfficiency(range, opts) }
      } catch (e) {
        logDashboardRequestError("efficiency", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectMetricSummary",
    async (_, filters: ProjectMetricFilters) => {
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockProjectMetricSummary(filters) }
      }
      try {
        const access = requireDashboardProjectModeAccess()
        return {
          success: true,
          data: await fetchProjectMetricSummary(filters, {
            query: esQuery,
            eventIndex: getEsIndex("event"),
            traceIndex: getEsIndex("trace"),
            factIndex: getEsIndex("projectFact"),
            allowedRoomNames: projectMetricAllowedRoomNames(access)
          })
        }
      } catch (e) {
        logDashboardRequestError("projectMetricSummary", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectMetricProjects",
    async (_, filters: ProjectMetricFilters, options?: ProjectMetricListOptions) => {
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockProjectMetricProjects(filters, options) }
      }
      try {
        const access = requireDashboardProjectModeAccess()
        return {
          success: true,
          data: await fetchProjectMetricProjects(filters, options ?? {}, {
            query: esQuery,
            eventIndex: getEsIndex("event"),
            traceIndex: getEsIndex("trace"),
            factIndex: getEsIndex("projectFact"),
            allowedRoomNames: projectMetricAllowedRoomNames(access)
          })
        }
      } catch (e) {
        logDashboardRequestError("projectMetricProjects", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectModeCodeStats",
    async (_, range: TimeRange, opts: OrgFilterOptions | undefined, source: string | null) => {
      if (import.meta.env.DEV) {
        const mock = makeMockProjectMode(range, opts)
        return {
          success: true,
          data: { codeStats: mock.summary.codeStats, skillCodeStats: mock.summary.skillCodeStats }
        }
      }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeCodeStatsBySource(range, opts, source) }
      } catch (e) {
        logDashboardRequestError("projectModeCodeStats", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectModeProjects",
    async (_, range: TimeRange, options?: ProjectModeProjectPageOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockProjectModeProjects(range, options) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeProjectPage(range, options) }
      } catch (e) {
        logDashboardRequestError("projectModeProjects", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:projectModeExportData",
    async (_, range: TimeRange, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockProjectModeExportData(range, opts) }
      }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeExportData(range, opts) }
      } catch (e) {
        console.error("[Dashboard] projectModeExportData error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectModeTraces",
    async (_, projectId: string, range: TimeRange, options?: ProjectModeTracesOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockProjectModeTraces(projectId, range, options) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchProjectModeTraces(projectId, range, options) }
      } catch (e) {
        logDashboardRequestError("projectModeTraces", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectModeFeatureNodes",
    async (_, projectId: string, featureSlug: string, range: TimeRange) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockProjectModeFeatureNodes(projectId, featureSlug) }
      try {
        requireDashboardProjectModeAccess()
        return {
          success: true,
          data: await fetchProjectModeFeatureNodes(projectId, featureSlug, range)
        }
      } catch (e) {
        logDashboardRequestError("projectModeFeatureNodes", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    (projectId, featureSlug) =>
      `dashboard:projectModeFeatureNodes:${projectId.slice(0, 128)}:${featureSlug.slice(0, 128)}`
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:projectModeOperationalDetails",
    async (
      _,
      scope: ProjectModeOperationalDetailScope,
      range: TimeRange,
      opts?: OrgFilterOptions
    ) => {
      if (import.meta.env.DEV) {
        return {
          success: true,
          data: makeMockProjectModeOperationalDetails(scope ?? { projectId: "" })
        }
      }
      try {
        requireDashboardProjectModeAccess()
        return {
          success: true,
          data: await fetchProjectModeOperationalDetails(scope, range, opts)
        }
      } catch (e) {
        logDashboardRequestError("projectModeOperationalDetails", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    (scope) =>
      `dashboard:projectModeOperationalDetails:${(scope?.projectId ?? "").slice(0, 128)}:${(scope?.featureSlug ?? "").slice(0, 128)}:${(scope?.nodeName ?? "").slice(0, 128)}`
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:pluginAggregate",
    async (_, adapterName: string, range: TimeRange) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockPluginAggregate(adapterName) }
      try {
        requireDashboardProjectModeAccess()
        return { success: true, data: await fetchPluginAggregate(adapterName, range) }
      } catch (e) {
        logDashboardRequestError("pluginAggregate", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    (adapterName) => `dashboard:pluginAggregate:${adapterName.slice(0, 256)}`
  )

  _ipcMain.handle(
    "dashboard:projectModeFeatureCommits",
    async (
      _,
      projectId: string,
      featureSlug: string,
      range: TimeRange,
      options?: number | CommitDetailsOptions
    ) => {
      if (import.meta.env.DEV)
        return {
          success: true,
          data: makeMockProjectModeFeatureCommits(projectId, featureSlug, range, options)
        }
      try {
        return {
          success: true,
          data: await fetchProjectModeFeatureCommits(projectId, featureSlug, range, options)
        }
      } catch (e) {
        console.error("[Dashboard] projectModeFeatureCommits error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:projectModeProjectCommits",
    async (_, projectId: string, range: TimeRange, options?: number | CommitDetailsOptions) => {
      if (import.meta.env.DEV)
        return {
          success: true,
          data: makeMockProjectModeProjectCommits(projectId, range, options)
        }
      try {
        return {
          success: true,
          data: await fetchProjectModeProjectCommits(projectId, range, options)
        }
      } catch (e) {
        console.error("[Dashboard] projectModeProjectCommits error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:overview",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockOverview(range, opts) }
      try {
        return { success: true, data: await fetchOverview(range, granularity, opts) }
      } catch (e) {
        logDashboardRequestError("overview", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:modelStats",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockModelStats(opts) }
      try {
        return { success: true, data: await fetchModelStats(range, granularity, opts) }
      } catch (e) {
        logDashboardRequestError("modelStats", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(_ipcMain, "dashboard:orgOptions", async (_, range: TimeRange) => {
    if (import.meta.env.DEV) return { success: true, data: makeMockOrgOptions() }
    try {
      return { success: true, data: await fetchOrgOptions(range) }
    } catch (e) {
      logDashboardRequestError("orgOptions", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:userStats",
    async (_, range: TimeRange, granularity: Granularity, opts?: UserStatsOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockUserStats(range, opts) }
      try {
        return { success: true, data: await fetchUserStats(range, granularity, opts) }
      } catch (e) {
        logDashboardRequestError("userStats", e)
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
    "dashboard:uncommittedRanking",
    async (_, range: TimeRange, options?: UncommittedScopeOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockUncommittedRanking(options) }
      try {
        return { success: true, data: await fetchUncommittedRanking(range, options) }
      } catch (e) {
        console.error("[Dashboard] uncommittedRanking error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle(
    "dashboard:uncommittedDetail",
    async (_, sapId: string, range: TimeRange, options?: UncommittedScopeOptions) => {
      const normalizedSapId = sapId?.trim?.() ?? ""
      if (!normalizedSapId) return { success: false, error: "sapId is required" }
      if (import.meta.env.DEV)
        return { success: true, data: makeMockUncommittedDetail(normalizedSapId, options) }
      try {
        return {
          success: true,
          data: await fetchUncommittedDetail(normalizedSapId, range, options)
        }
      } catch (e) {
        console.error("[Dashboard] uncommittedDetail error:", e)
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

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:skillEvalSummary",
    async (_, range: TimeRange, options?: DashboardSkillEvalOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockSkillEvalSummary(range, options) }
      try {
        return { success: true, data: await fetchSkillEvalSummary(range, options) }
      } catch (e) {
        logDashboardRequestError("skillEvalSummary", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    (_range, options) => getSkillEvalRequestFamily(options)
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
    "dashboard:awardsSkillContributions",
    async (_, range: TimeRange, skillNames: string[]) => {
      if (import.meta.env.DEV) {
        return { success: true, data: makeMockAwardSkillContributions(skillNames) }
      }
      try {
        return { success: true, data: await fetchAwardSkillContributions(range, skillNames) }
      } catch (e) {
        console.error("[Dashboard] awardsSkillContributions error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:awardsUserApplications", async (_, range: TimeRange) => {
    if (import.meta.env.DEV) {
      return { success: true, data: makeMockAwardUserApplications() }
    }
    try {
      return { success: true, data: await fetchAwardUserApplications(range) }
    } catch (e) {
      console.error("[Dashboard] awardsUserApplications error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle("dashboard:awardsTeamBenchmark", async (_, range: TimeRange) => {
    if (import.meta.env.DEV) {
      return { success: true, data: makeMockAwardTeamBenchmark() }
    }
    try {
      return { success: true, data: await fetchAwardTeamBenchmark(range) }
    } catch (e) {
      console.error("[Dashboard] awardsTeamBenchmark error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:awardsTeamSkillCoverage",
    async (_, range: TimeRange, groups: Array<{ shi: string; skillNames: string[] }>) => {
      if (import.meta.env.DEV) {
        const result: Record<string, number> = {}
        for (const g of Array.isArray(groups) ? groups : []) {
          const shi = String(g?.shi || "").trim()
          if (shi) result[shi] = 1 + (shi.length % 4)
        }
        return { success: true, data: result }
      }
      try {
        return { success: true, data: await fetchAwardTeamSkillCoverage(range, groups) }
      } catch (e) {
        console.error("[Dashboard] awardsTeamSkillCoverage error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:userProfiles",
    async (_, sapIds: string[], options?: DashboardUserProfilesOptions) => {
      void options
      const sanitizedSapIds = Array.isArray(sapIds)
        ? Array.from(
            new Set(
              sapIds
                .filter((id): id is string => typeof id === "string")
                .map((id) => id.trim())
                .filter(Boolean)
            )
          ).slice(0, 500)
        : []
      if (import.meta.env.DEV) {
        const projected = projectDashboardEsResponse(
          makeMockUserProfilesBySapIds(sanitizedSapIds),
          { kind: "user-directory" }
        )
        return { success: true, data: readUserDirectoryProjection(projected).items }
      }
      try {
        const data = readUserDirectoryProjection(
          await fetchUserProfilesBySapIds(sanitizedSapIds)
        ).items
        return { success: true, data }
      } catch (e) {
        logDashboardRequestError("userProfiles", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    (_sapIds, options) => getUserProfilesRequestFamily(options)
  )

  registerLatestDashboardHandler(_ipcMain, "dashboard:queryAllUser", async () => {
    if (import.meta.env.DEV) {
      return { success: true, data: makeMockAllUsers() }
    }
    try {
      return { success: true, data: await queryAllUser() }
    } catch (e) {
      logDashboardRequestError("queryAllUser", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:productivity",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockProductivity(range, opts) }
      try {
        return { success: true, data: await fetchProductivity(range, granularity, opts) }
      } catch (e) {
        logDashboardRequestError("productivity", e)
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

  registerLatestDashboardHandler(
    _ipcMain,
    "dashboard:advancedFeatures",
    async (_, range: TimeRange, granularity: Granularity, opts?: OrgFilterOptions) => {
      if (import.meta.env.DEV) return { success: true, data: makeMockAdvancedFeatures(range) }
      try {
        return { success: true, data: await fetchAdvancedFeatures(range, granularity, opts) }
      } catch (e) {
        logDashboardRequestError("advancedFeatures", e)
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

  _ipcMain.handle(
    "dashboard:threadTraces",
    async (_, threadId: string, options?: ThreadTracesOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockThreadTraces(threadId, options) }
      try {
        return { success: true, data: await fetchThreadTraces(threadId, options) }
      } catch (e) {
        console.error("[Dashboard] threadTraces error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

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

  _ipcMain.handle(
    "dashboard:nonGitAdoptionReports",
    async (_, range: TimeRange, options?: NonGitAdoptionReportsOptions) => {
      if (import.meta.env.DEV)
        return { success: true, data: makeMockNonGitAdoptionReports(range, options) }
      try {
        return { success: true, data: await fetchNonGitAdoptionReports(range, options) }
      } catch (e) {
        console.error("[Dashboard] nonGitAdoptionReports error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  _ipcMain.handle("dashboard:commitAdoptionEvents", async (_, commitSha: string) => {
    const sha = commitSha?.trim?.() ?? ""
    if (!sha) return { success: false, error: "commitSha is required" }
    if (import.meta.env.DEV) return { success: true, data: makeMockCommitAdoptionEvents(sha) }
    try {
      return { success: true, data: await fetchCommitAdoptionEvents(sha) }
    } catch (e) {
      console.error("[Dashboard] commitAdoptionEvents error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

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

  _ipcMain.handle("dashboard:exportUserTraces", async (event, rawPayload: unknown) => {
    try {
      const payload = normalizeUserTraceExportPayload(rawPayload)
      if (!payload.sapId) return { success: false, error: "sapId is required" }
      if (payload.traces.length === 0) return { success: false, error: "暂无可导出的会话记录" }

      const exportedAt = new Date().toISOString()
      const date = exportedAt.slice(0, 10)
      const viewLabel = payload.viewMode === "thread" ? "threads" : "traces"
      const displayName = payload.userName || payload.sapId
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: `导出用户 ${payload.viewMode === "thread" ? "Thread" : "Trace"} 历史`,
        defaultPath: `${safeExportFileName(`${displayName}-${payload.sapId}`)}-${viewLabel}-page-${payload.page}-${date}.zip`,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }]
      })

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true }
      }

      const zip = new AdmZip()
      zip.addFile(
        `${viewLabel}.md`,
        Buffer.from(formatUserTraceExportMarkdown(payload, exportedAt), "utf-8")
      )
      const commonPayload = {
        version: 1,
        exportedAt,
        exportType: payload.viewMode,
        user: {
          sapId: payload.sapId,
          ...(payload.ystId ? { ystId: payload.ystId } : {}),
          userName: payload.userName
        },
        range: payload.range,
        page: payload.page,
        pageSize: payload.pageSize,
        totalItems: payload.totalItems,
        triggerScope: payload.triggerScope,
        projectMode: payload.projectMode
      }
      const data =
        payload.viewMode === "thread"
          ? { ...commonPayload, threads: groupTraceExportThreads(payload.traces) }
          : { ...commonPayload, traces: payload.traces }
      zip.addFile(`${viewLabel}.json`, Buffer.from(`${stringifyExportValue(data)}\n`, "utf-8"))
      zip.writeZip(result.filePath)

      return { success: true, filePath: result.filePath }
    } catch (e) {
      console.error("[Dashboard] exportUserTraces error:", e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  _ipcMain.handle(
    "dashboard:exportExcel",
    async (
      _,
      sheets: Array<{
        name: string
        header: string[]
        rows: (string | number)[][]
        summaryRows?: (string | number)[][]
      }>,
      options?: { fileName?: string }
    ) => {
      try {
        // Dynamic import xlsx to avoid bundling issues
        const XLSX = await import("xlsx")

        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const summaryRows = sheet.summaryRows ?? []
          const wsData = [
            ...summaryRows,
            ...(summaryRows.length > 0 ? [[]] : []),
            sheet.header,
            ...sheet.rows
          ]
          const ws = XLSX.utils.aoa_to_sheet(wsData)

          // Auto-size columns based on content
          const colWidths = sheet.header.map((h, i) => {
            let maxLen = h.length
            for (const row of [...summaryRows, ...sheet.rows]) {
              const cellLen = String(row[i] ?? "").length
              if (cellLen > maxLen) maxLen = cellLen
            }
            return { wch: Math.min(maxLen + 4, 40) }
          })
          ws["!cols"] = colWidths

          XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
        }

        const win = BrowserWindow.getFocusedWindow()
        const exportName = safeExportFileName(options?.fileName || "运营面板数据")
        const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
          title: "导出运营面板数据",
          defaultPath: `${exportName}_${new Date().toISOString().slice(0, 10)}.xlsx`,
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
