import { runAnalysisKey } from "../../shared/project-run-analysis"
import type {
  RunAnalysisData,
  RunAnalysisFeature,
  RunAnalysisFeatureTarget,
  RunAnalysisStageExportRequest,
  RunAnalysisPluginStages,
  StageTurnCounts,
  RunAnalysisMetrics,
  RunAnalysisRange,
  RunAnalysisMembership,
  RunAnalysisStage,
  RunAnalysisSessions,
  RunAnalysisSessionRequest
} from "../../shared/project-run-analysis"
import {
  projectModeMainAgentConversationFilter,
  mainAgentConversationAggs,
  readMainAgentConversations,
  stageBucketCodeFilterClause
} from "./dashboard-stage-buckets"
import { normalizeCodeStatsFromContainer } from "./dashboard-code-stats"
import { STAGE_DONE_LABEL } from "../../shared/harness-stage-bucket"
import { readDashboardTracePages } from "./dashboard-trace-pages"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Json = Record<string, unknown>
export type RunAnalysisQuery = (index: string, body: Json) => Promise<unknown>
export const RUN_ANALYSIS_PAGE_SIZE = 500
export const RUN_ANALYSIS_BATCH_SIZE = 200
const record = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {}
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const value = (v: unknown): number => number(record(v).value)
/** ES may return the exact hit count as a number or a value/relation object. */
function exactTotalHits(total: unknown): number | null {
  const count = typeof total === "number" ? total : record(total).value
  if (typeof total !== "number" && record(total).relation !== "eq") return null
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null
}
const iso = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null

/** Empty/missing indexed Skill arrays follow the existing project-mode attribution contract. */
export function noSkillMainConversationFilter(): Json {
  return {
    bool: {
      filter: [projectModeMainAgentConversationFilter()],
      must_not: [{ exists: { field: "usedSkills" } }]
    }
  }
}
const childFilter: Json = {
  bool: {
    should: [
      { term: { traceKind: "subagent" } },
      {
        bool: {
          must_not: [{ exists: { field: "traceKind" } }],
          filter: [
            {
              bool: {
                should: [
                  { exists: { field: "subagentKind" } },
                  { exists: { field: "subagentThreadId" } },
                  { exists: { field: "parentTraceId" } }
                ],
                minimum_should_match: 1
              }
            }
          ]
        }
      }
    ],
    minimum_should_match: 1
  }
}

/** Partition missing fields before querying: gateways may drop null object keys.
 * Each partition is disjoint and sequential; cursors contain only indexed strings.
 * At most three optional dimensions are used (feature/thread/kind => eight partitions).
 */
export async function forEachRunAnalysisBucket(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  sources: Json[],
  aggs: Json,
  consume: (bucket: Json) => void
): Promise<void> {
  const optional = sources.filter(
    (s) => record(record(Object.values(s)[0]).terms).missing_bucket === true
  )
  if (optional.length > 3) throw new Error("运行分析可空聚合维度过多")
  const partitions = 2 ** optional.length
  for (let mask = 0; mask < partitions; mask++) {
    const missing: Json = {}
    const scopedFilters = [...filters]
    const presentSources: Json[] = []
    for (const entry of sources) {
      const name = Object.keys(entry)[0]
      const terms = record(record(entry[name]).terms)
      const bit = optional.indexOf(entry)
      if (bit >= 0) {
        const exists = { exists: { field: terms.field } }
        if (mask & (1 << bit)) {
          scopedFilters.push({ bool: { must_not: [exists] } })
          missing[name] = null
          continue
        }
        scopedFilters.push(exists)
      }
      const presentTerms = { ...terms }
      delete presentTerms.missing_bucket
      presentSources.push({ [name]: { terms: presentTerms } })
    }
    if (!presentSources.length) {
      // A stage-only query with no stage field has one aggregate, no cursor.
      const raw = record(
        await query(index, {
          size: 0,
          track_total_hits: false,
          query: { bool: { filter: scopedFilters } },
          aggs: { missing: { filter: { match_all: {} }, aggs } }
        })
      )
      assertProjectModeResultComplete(raw)
      const bucket = record(record(raw.aggregations).missing)
      if (typeof bucket.doc_count !== "number") throw new Error("运行分析聚合缺失，请重试")
      if (bucket.doc_count > 0) consume({ ...bucket, key: missing })
      continue
    }
    await forEachPresentRunAnalysisBucket(
      query,
      index,
      scopedFilters,
      presentSources,
      aggs,
      (bucket) => {
        consume({ ...bucket, key: { ...record(bucket.key), ...missing } })
      }
    )
  }
}

async function forEachPresentRunAnalysisBucket(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  sources: Json[],
  aggs: Json,
  consume: (bucket: Json) => void
): Promise<void> {
  let after: Json | undefined
  const cursors = new Set<string>()
  const keys = new Set<string>()
  const names = sources.map((s) => Object.keys(s)[0])
  for (;;) {
    const raw = record(
      await query(index, {
        size: 0,
        track_total_hits: false,
        query: { bool: { filter: filters } },
        aggs: {
          rows: {
            composite: { size: RUN_ANALYSIS_PAGE_SIZE, sources, ...(after ? { after } : {}) },
            aggs
          }
        }
      })
    )
    assertProjectModeResultComplete(raw)
    const page = record(record(raw.aggregations).rows)
    if (!Array.isArray(page.buckets) || Number(page.sum_other_doc_count) > 0)
      throw new Error("运行分析聚合缺失或截断，请重试")
    for (const item of page.buckets) {
      const bucket = record(item)
      const key = record(bucket.key)
      if (
        Object.keys(key).length !== names.length ||
        names.some((n) => !(n in key) || typeof key[n] !== "string")
      )
        throw new Error("运行分析聚合键不完整")
      const signature = JSON.stringify(names.map((n) => key[n]))
      if (keys.has(signature)) throw new Error("运行分析分页返回重复数据，请重试")
      keys.add(signature)
      consume(bucket)
    }
    if (!page.buckets.length) break
    if (page.after_key == null) {
      if (page.buckets.length >= RUN_ANALYSIS_PAGE_SIZE)
        throw new Error("运行分析分页游标缺失，请重试")
      break
    }
    const next = record(page.after_key)
    if (
      Object.keys(next).length !== names.length ||
      names.some((n) => !(n in next) || typeof next[n] !== "string")
    )
      throw new Error("运行分析分页游标不完整")
    const signature = JSON.stringify(names.map((n) => next[n]))
    if (cursors.has(signature)) throw new Error("运行分析分页游标未前进，请重试")
    cursors.add(signature)
    after = next
  }
}
const source = (name: string, field: string, missing = false): Json => ({
  [name]: { terms: { field, ...(missing ? { missing_bucket: true } : {}) } }
})
const featureSources = (prefix = ""): Json[] => [
  source("project", `${prefix}harnessProjectId`),
  source("feature", `${prefix}harnessFeatureSlug`, true)
]

function runAnalysisPairFilter(candidates: RunAnalysisFeatureTarget[], prefix = ""): Json {
  const grouped = new Map<string, (string | null)[]>()
  for (const key of candidates) {
    const slugs = grouped.get(key.projectId) ?? []
    slugs.push(key.featureSlug)
    grouped.set(key.projectId, slugs)
  }
  const should: Json[] = []
  for (const [project, values] of grouped) {
    const slugs = values.filter((v): v is string => v !== null)
    const features: Json[] = []
    for (let offset = 0; offset < slugs.length; offset += 1000)
      features.push({
        terms: { [`${prefix}harnessFeatureSlug`]: slugs.slice(offset, offset + 1000) }
      })
    if (values.includes(null))
      features.push({
        bool: { must_not: [{ exists: { field: `${prefix}harnessFeatureSlug` } }] }
      })
    should.push({
      bool: {
        filter: [
          { term: { [`${prefix}harnessProjectId`]: project } },
          { bool: { should: features, minimum_should_match: 1 } }
        ]
      }
    })
  }
  return { bool: { should, minimum_should_match: 1 } }
}

const completedNode = { term: { harnessNodeStatus: STAGE_DONE_LABEL } }
const unattributedSkill = { term: { hasCodeAttributedSkill: false } }

const mainTurnStatusAggs = {
  node_status_reported: {
    filter: { exists: { field: "harnessNodeStatus" } },
    aggs: { completed: { filter: completedNode } }
  },
  skill_attribution_reported: {
    filter: { exists: { field: "hasCodeAttributedSkill" } },
    aggs: { unattributed: { filter: unattributedSkill } }
  }
}

function readStageTurnCounts(main: Json): StageTurnCounts {
  const node = record(main.node_status_reported)
  const skill = record(main.skill_attribution_reported)
  return {
    conversationCount: number(main.doc_count),
    nodeStatusReported: number(node.doc_count),
    skillAttributionReported: number(skill.doc_count),
    completedNode: number(record(node.completed).doc_count),
    unattributedSkill: number(record(skill.unattributed).doc_count)
  }
}

export function groupRunAnalysisExportTargets(
  rows: RunAnalysisFeature[],
  targets: RunAnalysisStageExportRequest["targets"]
) {
  const available = new Map(
    rows.map((row) => [runAnalysisKey(row.projectId, row.featureSlug), row])
  )
  const plugins = new Map<string | null, RunAnalysisFeature[]>()
  for (const target of targets) {
    const key = runAnalysisKey(target.projectId, target.featureSlug)
    const row = available.get(key)
    if (!row || row.featureSlug !== target.featureSlug || row.adapterName !== target.adapterName)
      throw new Error("项目分析名单已变化，请刷新后重新导出")
    available.delete(key)
    const group = plugins.get(row.adapterName)
    if (group) group.push(row)
    else plugins.set(row.adapterName, [row])
  }
  return plugins
}

export async function fetchRunAnalysisPluginStages(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  targets: RunAnalysisFeatureTarget[],
  asOf: string
): Promise<RunAnalysisPluginStages["stages"]> {
  if (!Number.isFinite(Date.parse(asOf)))
    throw new Error("项目分析数据截至时间无效，请刷新后重新导出")
  // Keep legacy traces without a start timestamp in the same population as the feature list.
  const cutoff = { bool: { must_not: [{ range: { startedAt: { gt: asOf } } }] } }
  const stages: RunAnalysisPluginStages["stages"] = []
  for (let start = 0; start < targets.length; start += RUN_ANALYSIS_BATCH_SIZE) {
    const batch = targets.slice(start, start + RUN_ANALYSIS_BATCH_SIZE)
    await forEachRunAnalysisBucket(
      query,
      index,
      [...filters, cutoff, runAnalysisPairFilter(batch)],
      [...featureSources(), source("stage", "harnessNodeName", true)],
      mainAgentConversationAggs(mainTurnStatusAggs),
      (bucket) => {
        const key = record(bucket.key)
        stages.push({
          projectId: key.project as string,
          featureSlug: key.feature as string | null,
          nodeName: key.stage as string | null,
          ...readStageTurnCounts(readMainAgentConversations(bucket))
        })
      }
    )
  }
  return stages
}

export function runAnalysisMetricAggs(range: RunAnalysisRange): Json {
  return {
    first_execution: { min: { field: "startedAt" } },
    last_execution: { max: { field: "startedAt" } },
    last_end: { max: { field: "endedAt" } },
    ...mainAgentConversationAggs({
      duration: { stats: { field: "durationMs" } },
      ...mainTurnStatusAggs
    }),
    no_skill: { filter: noSkillMainConversationFilter() },
    tool_calls: { stats: { field: "totalToolCalls" } },
    model_calls: { stats: { field: "modelCallCount" } },
    classified: { filter: { exists: { field: "traceKind" } } },
    children: {
      filter: childFilter,
      aggs: { identified: { filter: { exists: { field: "subagentThreadId" } } } }
    },
    selected_range: { filter: { range: { startedAt: { gte: range.from, lte: range.to } } } }
  }
}
export function emptyRunAnalysisMetrics(): RunAnalysisMetrics {
  return {
    traceCount: 0,
    conversationCount: 0,
    noSkillConversationCount: 0,
    completedNodeConversationCount: 0,
    unattributedSkillConversationCount: 0,
    firstExecutedAt: null,
    lastExecutedAt: null,
    lastEndedAt: null,
    executionSpanMs: null,
    totalDurationMs: null,
    toolCalls: null,
    modelCalls: null,
    toolReportedTraceCount: 0,
    modelReportedTraceCount: 0,
    subagentCount: 0,
    subagentTurns: 0,
    subagentIdentifiedTraceCount: 0,
    subagentClassifiedTraceCount: 0,
    subagentKinds: {},
    executedInRange: false
  }
}
export function readRunAnalysisMetrics(bucket: Json): RunAnalysisMetrics {
  const main = readMainAgentConversations(bucket),
    duration = record(main.duration)
  const turns = readStageTurnCounts(main)
  const start = record(bucket.first_execution).value,
    end = record(bucket.last_end).value
  const tool = record(bucket.tool_calls),
    model = record(bucket.model_calls)
  return {
    ...emptyRunAnalysisMetrics(),
    traceCount: number(bucket.doc_count),
    conversationCount: number(main.doc_count),
    noSkillConversationCount: number(record(bucket.no_skill).doc_count),
    completedNodeConversationCount:
      turns.conversationCount && !turns.nodeStatusReported ? null : turns.completedNode,
    unattributedSkillConversationCount:
      turns.conversationCount && !turns.skillAttributionReported ? null : turns.unattributedSkill,
    firstExecutedAt: iso(start),
    lastExecutedAt: iso(record(bucket.last_execution).value),
    lastEndedAt: iso(end),
    executionSpanMs:
      typeof start === "number" && typeof end === "number" && end >= start ? end - start : null,
    totalDurationMs: number(duration.count) > 0 ? number(duration.sum) : null,
    toolCalls: number(tool.count) > 0 ? number(tool.sum) : null,
    modelCalls: number(model.count) > 0 ? number(model.sum) : null,
    toolReportedTraceCount: number(tool.count),
    modelReportedTraceCount: number(model.count),
    subagentTurns: number(record(bucket.children).doc_count),
    subagentIdentifiedTraceCount: number(record(record(bucket.children).identified).doc_count),
    subagentClassifiedTraceCount: number(record(bucket.classified).doc_count),
    executedInRange: number(record(bucket.selected_range).doc_count) > 0
  }
}

export interface RunAnalysisScope {
  eventIndex: string
  traceIndex: string
  snapshotFilters: Json[]
  traceFilters: Json[]
  codeFilters: Json[]
  codeAggs: Json
  range: RunAnalysisRange
  membership: RunAnalysisMembership
}

const SNAPSHOT_FIELDS = [
  "eventTime",
  "userName",
  "upperOrgLv1",
  ...[
    "projectId",
    "name",
    "projectCode",
    "projectFromLean",
    "systemName",
    "adapterName",
    "adapterVersion",
    "creatorUserName",
    "creatorUpperOrgLv1",
    "lifecycleCreatedAt",
    "lifecycleStatus",
    "featureCount",
    "workflowStageNames",
    "features.slug",
    "features.title",
    "features.currentNodeId",
    "features.currentNodeStatusLabel",
    "features.overallStatusLabel"
  ].map((f) => `properties.${f}`)
]

/** Snapshot inventory is complete and independent of the currently displayed list page. */
export async function fetchRunAnalysis(
  scope: RunAnalysisScope,
  query: RunAnalysisQuery
): Promise<RunAnalysisData> {
  const queryStartedAt = new Date().toISOString()
  const projects = new Map<string, Json>()
  const rows = new Map<string, RunAnalysisFeature>()
  const base = (projectId: string, slug: string | null): RunAnalysisFeature => {
    const snapshot = projects.get(projectId)
    if (!snapshot) throw new Error("运行分析返回范围外项目")
    const p = record(snapshot.properties)
    return {
      ...emptyRunAnalysisMetrics(),
      projectId,
      projectName: text(p.name) ?? projectId,
      projectCode: text(p.projectCode),
      projectFromLean: typeof p.projectFromLean === "boolean" ? p.projectFromLean : null,
      systemName: text(p.systemName),
      adapterName: text(p.adapterName),
      adapterVersion: text(p.adapterVersion),
      creator: text(p.creatorUserName) ?? text(snapshot.userName),
      room: text(p.creatorUpperOrgLv1) ?? text(snapshot.upperOrgLv1),
      projectCreatedAt: text(p.lifecycleCreatedAt),
      lifecycleStatus: text(p.lifecycleStatus),
      snapshotAt: text(snapshot.eventTime),
      projectSubagentCount: 0,
      snapshotFeatureCount:
        typeof p.featureCount === "number"
          ? number(p.featureCount)
          : Array.isArray(p.features)
            ? p.features.filter((f) => text(record(f).slug)).length
            : 0,
      featureSlug: slug,
      featureTitle: slug ?? "未归因特性",
      currentStage: null,
      currentStatus: null,
      featureStatus: null,
      inSnapshot: false,
      codeStats: null,
      harnessAdoptedLines: 0,
      vibeAdoptedLines: 0,
      vibeAdoptedShare: null
    }
  }
  const get = (project: string, feature: string | null): RunAnalysisFeature => {
    const key = runAnalysisKey(project, feature)
    let row = rows.get(key)
    if (!row) {
      row = base(project, feature)
      rows.set(key, row)
    }
    return row
  }
  await forEachRunAnalysisBucket(
    query,
    scope.eventIndex,
    scope.snapshotFilters,
    [source("project", "properties.projectId")],
    {
      snapshot: {
        top_hits: { size: 1, sort: [{ eventTime: "desc" }], _source: { includes: SNAPSHOT_FIELDS } }
      }
    },
    (bucket) => {
      const id = text(record(bucket.key).project)
      const hits = record(record(bucket.snapshot).hits).hits
      if (!id || !Array.isArray(hits) || hits.length !== 1)
        throw new Error("运行分析项目快照不完整")
      const snapshot = record(record(hits[0])._source)
      if (record(snapshot.properties).projectId !== id) throw new Error("运行分析快照ID不匹配")
      projects.set(id, snapshot)
      const features = record(snapshot.properties).features
      if (Array.isArray(features))
        for (const raw of features) {
          const feature = record(raw),
            slug = text(feature.slug)
          if (!slug) continue
          const row = get(id, slug)
          Object.assign(row, {
            featureTitle: text(feature.title) ?? slug,
            currentStage: text(feature.currentNodeId),
            currentStatus: text(feature.currentNodeStatusLabel),
            featureStatus: text(feature.overallStatusLabel),
            inSnapshot: true
          })
        }
    }
  )
  const ids = [...projects.keys()]
  const projectThreadCounts = new Map<string, number>()
  for (let offset = 0; offset < ids.length; offset += RUN_ANALYSIS_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + RUN_ANALYSIS_BATCH_SIZE)
    const traceFilters: Json[] = [...scope.traceFilters, { terms: { harnessProjectId: batch } }]
    const eventFilters: Json[] = [
      ...scope.codeFilters,
      { terms: { "properties.harnessProjectId": batch } }
    ]
    if (scope.membership === "executed") {
      const candidates: RunAnalysisFeatureTarget[] = []
      await forEachRunAnalysisBucket(
        query,
        scope.traceIndex,
        [...traceFilters, { range: { startedAt: { gte: scope.range.from, lte: scope.range.to } } }],
        featureSources(),
        {},
        (b) => {
          const key = record(b.key)
          if (typeof key.project !== "string" || !batch.includes(key.project))
            throw new Error("执行名单超出项目范围")
          candidates.push({ projectId: key.project, featureSlug: key.feature as string | null })
        }
      )
      if (!candidates.length) continue
      traceFilters.push(runAnalysisPairFilter(candidates))
      eventFilters.push(runAnalysisPairFilter(candidates, "properties."))
    }
    const allowed = new Set(batch)
    const identify = (bucket: Json): RunAnalysisFeature => {
      const key = record(bucket.key),
        id = text(key.project),
        slug = key.feature === null ? null : text(key.feature)
      if (!id || !allowed.has(id) || (key.feature !== null && !slug))
        throw new Error("运行分析聚合超出请求范围")
      return get(id, slug)
    }
    let hasChildren = false
    // Two independent scalar aggregations in flight at most; batches are sequential.
    await Promise.all([
      forEachRunAnalysisBucket(
        query,
        scope.traceIndex,
        traceFilters,
        featureSources(),
        runAnalysisMetricAggs(scope.range),
        (b) => {
          const metrics = readRunAnalysisMetrics(b)
          Object.assign(identify(b), metrics)
          hasChildren ||= metrics.subagentTurns > 0
        }
      ),
      forEachRunAnalysisBucket(
        query,
        scope.eventIndex,
        eventFilters,
        featureSources("properties."),
        {
          ...scope.codeAggs,
          harness: {
            filter: stageBucketCodeFilterClause("plugin_constrained"),
            aggs: { adopted: { sum: { field: "properties.adoptedLineCount" } } }
          },
          vibe: {
            filter: stageBucketCodeFilterClause("vibecoding"),
            aggs: { adopted: { sum: { field: "properties.adoptedLineCount" } } }
          }
        },
        (b) => {
          const row = identify(b)
          row.codeStats = normalizeCodeStatsFromContainer(b)
          row.harnessAdoptedLines = value(record(b.harness).adopted)
          row.vibeAdoptedLines = value(record(b.vibe).adopted)
          const total = row.harnessAdoptedLines + row.vibeAdoptedLines
          row.vibeAdoptedShare = total > 0 ? row.vibeAdoptedLines / total : null
        }
      )
    ])
    // No child documents in this batch: avoid all optional-field inventory partitions.
    if (!hasChildren) continue
    // Exact distinct thread inventory, no cardinality estimates and no trace bodies.
    const threads = new Map<string, Set<string>>()
    const projectThreads = new Map<string, Set<string>>()
    await forEachRunAnalysisBucket(
      query,
      scope.traceIndex,
      [...traceFilters, childFilter],
      [
        ...featureSources(),
        source("thread", "subagentThreadId", true),
        source("kind", "subagentKind", true)
      ],
      {},
      (b) => {
        const row = identify(b),
          key = record(b.key),
          thread = text(key.thread)
        if (thread) {
          const id = runAnalysisKey(row.projectId, row.featureSlug)
          const set = threads.get(id) ?? new Set<string>()
          set.add(thread)
          threads.set(id, set)
          row.subagentCount = set.size
          const projectSet = projectThreads.get(row.projectId) ?? new Set<string>()
          projectSet.add(thread)
          projectThreads.set(row.projectId, projectSet)
        }
        const kind = text(key.kind) ?? "未记录类型"
        row.subagentKinds[kind] = (row.subagentKinds[kind] ?? 0) + number(b.doc_count)
      }
    )
    for (const [id, set] of projectThreads) projectThreadCounts.set(id, set.size)
  }
  const populated = new Set([...rows.values()].map((row) => row.projectId))
  for (const id of ids) if (!populated.has(id)) get(id, null)
  for (const row of rows.values())
    row.projectSubagentCount = projectThreadCounts.get(row.projectId) ?? 0
  const allRows = [...rows.values()]
  const selected =
    scope.membership === "executed" ? allRows.filter((r) => r.executedInRange) : allRows
  const selectedProjects = new Set(selected.map((row) => row.projectId))
  const workflowStageNamesByProject = Object.fromEntries(
    [...selectedProjects].map((id) => {
      const names = record(projects.get(id)?.properties).workflowStageNames
      return [id, Array.isArray(names) ? names.filter((name) => text(name) !== null) : []]
    })
  )
  return {
    rows: selected,
    workflowStageNamesByProject,
    projectCount: selectedProjects.size,
    featureCount: selected.filter((r) => r.featureSlug !== null).length,
    range: scope.range,
    membership: scope.membership,
    dataAsOf: new Date().toISOString(),
    queryStartedAt
  }
}

export async function fetchRunAnalysisStages(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  range: RunAnalysisRange
): Promise<RunAnalysisStage[]> {
  const rows: RunAnalysisStage[] = []
  await forEachRunAnalysisBucket(
    query,
    index,
    filters,
    [source("stage", "harnessNodeName", true)],
    runAnalysisMetricAggs(range),
    (b) => {
      rows.push({ ...readRunAnalysisMetrics(b), nodeName: text(record(b.key).stage) })
    }
  )
  return rows
}

export function runAnalysisSessionMetricFilters(
  metric: RunAnalysisSessionRequest["metric"]
): Json[] {
  if (metric === "completedNode") return [projectModeMainAgentConversationFilter(), completedNode]
  if (metric === "unattributedSkill")
    return [projectModeMainAgentConversationFilter(), unattributedSkill]
  return metric === "noSkill"
    ? [noSkillMainConversationFilter()]
    : metric === "main"
      ? [projectModeMainAgentConversationFilter()]
      : metric === "subagent"
        ? [childFilter]
        : []
}

export function runAnalysisAttributionFilters(request: RunAnalysisSessionRequest): Json[] {
  return [
    request.featureSlug === null
      ? { bool: { must_not: [{ exists: { field: "harnessFeatureSlug" } }] } }
      : { term: { harnessFeatureSlug: request.featureSlug } },
    ...(request.nodeName === undefined
      ? []
      : request.nodeName === null
        ? [{ bool: { must_not: [{ exists: { field: "harnessNodeName" } }] } }]
        : [{ term: { harnessNodeName: request.nodeName } }])
  ]
}

const threadFields = ["rootThreadId", "parentThreadId", "threadId"] as const

function conversationThreadId(source: Json): string | null {
  for (const field of threadFields) {
    const id = text(source[field])?.trim()
    if (id && id !== "unknown-thread") return id
  }
  return null
}

/** Cursor paging for drilldowns: only lightweight headers, matching the counted metric. */
export async function fetchRunAnalysisSessions(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  request: RunAnalysisSessionRequest
): Promise<RunAnalysisSessions> {
  if (
    request.after &&
    (request.after.length !== 2 ||
      request.after.some((v) => v !== null && typeof v !== "string" && typeof v !== "number"))
  )
    throw new Error("会话游标无效")
  const raw = record(
    await query(index, {
      size: 50,
      track_total_hits: true,
      query: {
        bool: {
          filter: [...filters, ...runAnalysisSessionMetricFilters(request.metric)]
        }
      },
      sort: [{ startedAt: { order: "desc", missing: "_last" } }, { traceId: "asc" }],
      ...(request.after ? { search_after: request.after } : {}),
      _source: {
        includes: [
          "traceId",
          ...threadFields,
          "startedAt",
          "endedAt",
          "durationMs",
          "harnessNodeName",
          "userName",
          "usedSkills"
        ]
      }
    })
  )
  assertProjectModeResultComplete(raw)
  const hits = record(raw.hits)
  const total = exactTotalHits(hits.total)
  if (!Array.isArray(hits.hits) || total === null) throw new Error("运行分析会话未完整返回")
  const items = hits.hits.map(record)
  const next = items.length === 50 ? items[items.length - 1].sort : null
  if (
    items.length === 50 &&
    (!Array.isArray(next) ||
      next.length !== 2 ||
      JSON.stringify(next) === JSON.stringify(request.after))
  )
    throw new Error("运行分析会话游标缺失或未前进")
  return {
    total,
    after: Array.isArray(next) ? next : null,
    rows: items.map((item) => {
      const s = record(item._source)
      if (!text(s.traceId)) throw new Error("会话缺少标识")
      return {
        traceId: text(s.traceId)!,
        threadId: conversationThreadId(s),
        startedAt: text(s.startedAt),
        endedAt: text(s.endedAt),
        durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
        nodeName: text(s.harnessNodeName),
        userName: text(s.userName),
        usedSkills: Array.isArray(s.usedSkills)
          ? s.usedSkills.filter((v): v is string => !!text(v))
          : []
      }
    })
  }
}

/** Read exactly the selected trace after all scope/metric filters, independent of thread length. */
export async function fetchRunAnalysisTrace<T>(
  query: RunAnalysisQuery,
  index: string,
  filters: Json[],
  request: RunAnalysisSessionRequest & { traceId: string },
  sourceIncludes: string[],
  normalize: (hit: Json) => T
): Promise<T> {
  if (!request.traceId?.trim()) throw new Error("Trace ID is required")
  const raw = record(
    await query(index, {
      size: 2,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            ...filters,
            ...runAnalysisSessionMetricFilters(request.metric),
            { term: { traceId: request.traceId } }
          ]
        }
      },
      _source: { includes: sourceIncludes }
    })
  )
  assertProjectModeResultComplete(raw)
  const hits = record(raw.hits)
  if (!Array.isArray(hits.hits) || hits.hits.length !== 1 || exactTotalHits(hits.total) !== 1)
    throw new Error("未找到该口径下唯一的完整会话记录")
  return normalize(record(hits.hits[0]))
}

/** Resolve the selected round under its original metric, then read its thread under the same project/room access. */
export async function fetchRunAnalysisThread<T extends { traceId: string }>(input: {
  query: RunAnalysisQuery
  index: string
  projectFilters: Json[]
  request: RunAnalysisSessionRequest & { traceId: string }
  sourceIncludes: string[]
  normalize: (hit: Json) => T
  isResponseTooLarge: (error: unknown) => boolean
}): Promise<T[]> {
  const { query, index, request, projectFilters } = input
  const threadId = await fetchRunAnalysisTrace(
    query,
    index,
    [...projectFilters, ...runAnalysisAttributionFilters(request)],
    request,
    [...threadFields],
    (hit) => conversationThreadId(record(hit._source))
  )
  const selection = threadId
    ? {
        bool: {
          should: threadFields.map((field) => ({ term: { [field]: threadId } })),
          minimum_should_match: 1
        }
      }
    : { term: { traceId: request.traceId } }
  const traces = new Map<string, T>()
  for await (const hits of readDashboardTracePages({
    filters: [...projectFilters, selection],
    sourceIncludes: input.sourceIncludes,
    query: (body) => query(index, body),
    isResponseTooLarge: input.isResponseTooLarge
  })) {
    for (const hit of hits) {
      const trace = input.normalize(hit)
      traces.set(trace.traceId, trace)
    }
  }
  if (!traces.has(request.traceId)) throw new Error("所选轮次已变化，请刷新会话列表后重试")
  return [...traces.values()]
}
