import { z } from "zod"
import {
  resolveOperationsPeriod,
  type OperationsFeatureContribution,
  type OperationsMetrics,
  type OperationsPeriod,
  type OperationsPeriodSummary,
  type OperationsPerson,
  type OperationsProjectContext,
  type ProjectOperationsPeriodData,
  type ProjectOperationsPeriodInput
} from "../../shared/project-operations-period"
import { computeAdoptionRate, normalizeCodeStatsFromContainer } from "./dashboard-code-stats"
import {
  mainAgentConversationAggs,
  readMainAgentConversations,
  stageBucketCodeFilterClause,
  stageBucketTraceAggs
} from "./dashboard-stage-buckets"
import {
  forEachRunAnalysisBucket,
  readRunAnalysisMetrics,
  runAnalysisMetricAggs,
  RUN_ANALYSIS_BATCH_SIZE,
  type RunAnalysisQuery
} from "./project-run-analysis"

type Json = Record<string, unknown>
const record = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {}
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const number = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
const value = (v: unknown): number => number(record(v).value)
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/)
const inputSchema = z
  .object({
    period: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("week"), anchorDate: z.string() }).strict(),
      z.object({ kind: z.literal("month"), month: z.string().regex(/^\d{4}-\d{2}$/) }).strict()
    ]),
    upperOrgLv1: z.string().trim().min(1).max(256),
    person: z
      .object({ idType: z.enum(["sapId", "ystId"]), id: identifier })
      .strict()
      .optional()
  })
  .strict()

export function parseProjectOperationsPeriodInput(raw: unknown): ProjectOperationsPeriodInput {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw new Error("请选择一个室和有效的统计周期，人员须使用工号标识")
  resolveOperationsPeriod(parsed.data.period)
  return parsed.data
}

interface PeriodScope {
  eventIndex: string
  traceIndex: string
  /** Built by the IPC handler from the current user's authorization and selected room. */
  accessFilters: Json[]
  signal?: AbortSignal
  now?: Date
}

const periodFilter = (field: string, period: OperationsPeriod, asOf?: string): Json => ({
  range: { [field]: { gte: period.from, lt: period.toExclusive, ...(asOf ? { lte: asOf } : {}) } }
})
const sum = (field: string): Json => ({ sum: { field } })

/** A generation cohort: later measured/committed code still belongs to its generation period. */
export function buildOperationsPeriodCodeQuery(period: OperationsPeriod, dataAsOf: string) {
  const generated = [
    { term: { eventName: "code_gen" } },
    {
      bool: {
        should: [
          periodFilter("properties.createdAt", period, dataAsOf),
          {
            bool: {
              must_not: [{ exists: { field: "properties.createdAt" } }],
              filter: [periodFilter("eventTime", period)]
            }
          }
        ],
        minimum_should_match: 1
      }
    }
  ]
  const adopted = [
    { term: { eventName: "code_adopt" } },
    periodFilter("properties.generatedAt", period, dataAsOf),
    ...["adoptedLineCount", "generatedLineCount", "effectiveGeneratedLineCount"].map((field) => ({
      exists: { field: `properties.${field}` }
    }))
  ]
  const pushed = [
    ...adopted,
    { term: { "properties.pushed": true } },
    // Old records without a push timestamp remain current-state observations.
    {
      bool: {
        should: [
          { range: { "properties.pushedAt": { lte: dataAsOf } } },
          { bool: { must_not: [{ exists: { field: "properties.pushedAt" } }] } }
        ],
        minimum_should_match: 1
      }
    }
  ]
  return {
    filters: [
      { range: { eventTime: { lte: dataAsOf } } },
      {
        bool: {
          should: [{ bool: { filter: generated } }, { bool: { filter: adopted } }],
          minimum_should_match: 1
        }
      }
    ],
    aggs: {
      code_gen: {
        filter: { bool: { filter: generated } },
        aggs: {
          generated_lines: sum("properties.lineCount"),
          deleted_lines: sum("properties.deletedLineCount")
        }
      },
      code_adopt_measured: {
        filter: { bool: { filter: adopted } },
        aggs: {
          measured_generated_lines: sum("properties.generatedLineCount"),
          effective_generated_lines: sum("properties.effectiveGeneratedLineCount"),
          adopted_lines: sum("properties.adoptedLineCount")
        }
      },
      code_adopt_pushed: {
        filter: { bool: { filter: pushed } },
        aggs: {
          pushed_measured_generated_lines: sum("properties.generatedLineCount"),
          pushed_effective_generated_lines: sum("properties.effectiveGeneratedLineCount"),
          pushed_adopted_lines: sum("properties.adoptedLineCount")
        }
      },
      harness: {
        filter: {
          bool: { filter: [...adopted, stageBucketCodeFilterClause("plugin_constrained")] }
        },
        aggs: { adopted: sum("properties.adoptedLineCount") }
      },
      vibe: {
        filter: { bool: { filter: [...adopted, stageBucketCodeFilterClause("vibecoding")] } },
        aggs: { adopted: sum("properties.adoptedLineCount") }
      }
    }
  }
}

export function emptyOperationsMetrics(): OperationsMetrics {
  return {
    traceCount: 0,
    conversationCount: 0,
    noSkillConversationCount: 0,
    harnessConversationCount: 0,
    vibeConversationCount: 0,
    durationMs: null,
    toolCalls: null,
    modelCalls: null,
    toolReportedTraceCount: 0,
    modelReportedTraceCount: 0,
    knowledgeReadCount: null,
    knowledgeReadSummaryCount: 0,
    code: null,
    harnessAdoptedLines: 0,
    vibeAdoptedLines: 0
  }
}

function combineMetrics(
  rows: OperationsMetrics[],
  reconcileGenerationCohort = false
): OperationsMetrics {
  const result = emptyOperationsMetrics()
  for (const row of rows) {
    for (const key of [
      "traceCount",
      "conversationCount",
      "noSkillConversationCount",
      "harnessConversationCount",
      "vibeConversationCount",
      "toolReportedTraceCount",
      "modelReportedTraceCount",
      "knowledgeReadSummaryCount",
      "harnessAdoptedLines",
      "vibeAdoptedLines"
    ] as const)
      result[key] += row[key]
    for (const key of ["durationMs", "toolCalls", "modelCalls", "knowledgeReadCount"] as const)
      if (row[key] !== null) result[key] = (result[key] ?? 0) + row[key]
    if (row.code) {
      result.code ??= {
        generatedLines: 0,
        measuredGeneratedLines: 0,
        measuredEffectiveGeneratedLines: 0,
        effectiveGeneratedLines: 0,
        adoptedLines: 0,
        pushedAdoptedLines: 0,
        adoptionRate: null,
        pushedAdoptionRate: null
      }
      for (const key of [
        "generatedLines",
        "measuredGeneratedLines",
        "measuredEffectiveGeneratedLines",
        "effectiveGeneratedLines",
        "adoptedLines",
        "pushedAdoptedLines"
      ] as const)
        result.code[key] += row.code[key]
    }
  }
  if (result.code) {
    // A generation and its later adoption can have different SAP/YST field coverage.
    // Reconcile raw identity partitions of one person/feature before summing features;
    // otherwise the same generation is counted as both measured and unmeasured.
    if (reconcileGenerationCohort) {
      result.code.effectiveGeneratedLines =
        result.code.measuredEffectiveGeneratedLines +
        Math.max(0, result.code.generatedLines - result.code.measuredGeneratedLines)
    }
    result.code.adoptionRate = computeAdoptionRate(
      result.code.adoptedLines,
      result.code.effectiveGeneratedLines
    )
    result.code.pushedAdoptionRate = computeAdoptionRate(
      result.code.pushedAdoptedLines,
      result.code.effectiveGeneratedLines
    )
  }
  return result
}

export function summarizeOperationsContributions(
  rows: OperationsFeatureContribution[]
): OperationsPeriodSummary {
  return {
    ...combineMetrics(rows.map((r) => r.metrics)),
    projectCount: new Set(rows.map((r) => r.projectId)).size,
    featureCount: new Set(
      rows
        .filter((r) => r.featureSlug !== null)
        .map((r) => JSON.stringify([r.projectId, r.featureSlug]))
    ).size,
    personCount: new Set(rows.flatMap((r) => (r.personKey ? [r.personKey] : []))).size
  }
}

interface RawContribution {
  projectId: string
  featureSlug: string | null
  sapId: string | null
  ystId: string | null
  name: string | null
  metrics: OperationsMetrics
}

function identitySources(prefix: string): Json[] {
  return [
    { project: { terms: { field: `${prefix}harnessProjectId` } } },
    { feature: { terms: { field: `${prefix}harnessFeatureSlug`, missing_bucket: true } } },
    { sapId: { terms: { field: "sapId", missing_bucket: true } } },
    { ystId: { terms: { field: "ystId", missing_bucket: true } } }
  ]
}

function latestName(b: Json): string | null {
  const hits = record(record(b.identity).hits).hits
  return Array.isArray(hits) ? text(record(record(hits[0])._source).userName) : null
}

/** Complete paged room/person metrics, with no dependency on a report UI or an LLM. */
export async function fetchProjectOperationsPeriod(
  raw: unknown,
  scope: PeriodScope,
  query: RunAnalysisQuery
): Promise<ProjectOperationsPeriodData> {
  const input = parseProjectOperationsPeriodInput(raw)
  const period = resolveOperationsPeriod(input.period)
  const dataAsOf = (scope.now ?? new Date()).toISOString()
  if (Date.parse(period.from) > Date.parse(dataAsOf)) throw new Error("所选统计周期尚未开始")
  const checkedQuery: RunAnalysisQuery = async (index, body) => {
    scope.signal?.throwIfAborted()
    const data = await query(index, body)
    scope.signal?.throwIfAborted()
    return data
  }
  const rawRows: RawContribution[] = []
  const collect = (b: Json, metrics: OperationsMetrics) => {
    const key = record(b.key),
      projectId = text(key.project)
    if (!projectId) throw new Error("周期统计缺少项目标识")
    rawRows.push({
      projectId,
      featureSlug: text(key.feature),
      sapId: text(key.sapId),
      ystId: text(key.ystId),
      name: latestName(b),
      metrics
    })
  }
  const range = { from: period.from, to: period.toExclusive }
  const traceAggs = {
    ...runAnalysisMetricAggs(range),
    ...mainAgentConversationAggs({
      duration: { stats: { field: "durationMs" } },
      ...stageBucketTraceAggs()
    })
  }
  const codeQuery = buildOperationsPeriodCodeQuery(period, dataAsOf)
  const knowledgeReadFilter = {
    bool: {
      filter: [
        { term: { eventName: "harness.system_constraint.read_summary" } },
        periodFilter("eventTime", period),
        { range: { eventTime: { lte: dataAsOf } } },
        { exists: { field: "properties.successfulReadCount" } }
      ]
    }
  }
  const identity = (time: string): Json => ({
    top_hits: { size: 1, sort: [{ [time]: "desc" }], _source: { includes: ["userName"] } }
  })
  // At most two independent paged queries in flight. All optional key partitions are disjoint.
  await Promise.all([
    forEachRunAnalysisBucket(
      checkedQuery,
      scope.traceIndex,
      [
        ...scope.accessFilters,
        { exists: { field: "harnessProjectId" } },
        periodFilter("startedAt", period),
        { range: { startedAt: { lte: dataAsOf } } }
      ],
      identitySources(""),
      { ...traceAggs, identity: identity("startedAt") },
      (b) => {
        const main = readMainAgentConversations(b)
        if (typeof b.doc_count !== "number" || typeof main.doc_count !== "number")
          throw new Error("周期对话统计返回不完整")
        const m = readRunAnalysisMetrics(b)
        collect(b, {
          ...emptyOperationsMetrics(),
          traceCount: m.traceCount,
          conversationCount: m.conversationCount,
          noSkillConversationCount: m.noSkillConversationCount,
          harnessConversationCount: number(record(main.sb_plugin_constrained).doc_count),
          vibeConversationCount: number(record(main.sb_vibecoding).doc_count),
          durationMs: m.totalDurationMs,
          toolCalls: m.toolCalls,
          modelCalls: m.modelCalls,
          toolReportedTraceCount: m.toolReportedTraceCount,
          modelReportedTraceCount: m.modelReportedTraceCount
        })
      }
    ),
    forEachRunAnalysisBucket(
      checkedQuery,
      scope.eventIndex,
      [
        ...scope.accessFilters,
        { exists: { field: "properties.harnessProjectId" } },
        {
          bool: {
            should: [{ bool: { filter: codeQuery.filters } }, knowledgeReadFilter],
            minimum_should_match: 1
          }
        }
      ],
      identitySources("properties."),
      {
        ...codeQuery.aggs,
        knowledge_reads: {
          filter: knowledgeReadFilter,
          aggs: { calls: sum("properties.successfulReadCount") }
        },
        identity: identity("eventTime")
      },
      (b) => {
        if (
          ["code_gen", "code_adopt_measured", "code_adopt_pushed", "knowledge_reads"].some(
            (key) => typeof record(b[key]).doc_count !== "number"
          )
        )
          throw new Error("周期代码统计返回不完整")
        const code = normalizeCodeStatsFromContainer(b)
        const hasCode =
          number(record(b.code_gen).doc_count) + number(record(b.code_adopt_measured).doc_count) > 0
        const knowledgeReads = record(b.knowledge_reads)
        collect(b, {
          ...emptyOperationsMetrics(),
          code: hasCode
            ? {
                generatedLines: code.generatedLines,
                measuredGeneratedLines: code.measuredGeneratedLines,
                measuredEffectiveGeneratedLines: code.effectiveGeneratedLines,
                effectiveGeneratedLines: code.inclusiveEffectiveGeneratedLines,
                adoptedLines: code.adoptedLines,
                pushedAdoptedLines: code.pushedAdoptedLines,
                adoptionRate: code.inclusiveAdoptionRate,
                pushedAdoptionRate: code.inclusivePushedAdoptionRate
              }
            : null,
          knowledgeReadCount:
            number(knowledgeReads.doc_count) > 0 ? value(knowledgeReads.calls) : null,
          knowledgeReadSummaryCount: number(knowledgeReads.doc_count),
          harnessAdoptedLines: value(record(b.harness).adopted),
          vibeAdoptedLines: value(record(b.vibe).adopted)
        })
      }
    )
  ])

  // Reconcile only observed stable-ID pairs. Names never merge two people.
  const sapByYst = new Map<string, Set<string>>()
  for (const r of rawRows)
    if (r.sapId && r.ystId) {
      const ids = sapByYst.get(r.ystId) ?? new Set<string>()
      ids.add(r.sapId)
      sapByYst.set(r.ystId, ids)
    }
  const people = new Map<string, OperationsPerson>()
  const groups = new Map<string, OperationsFeatureContribution[]>()
  for (const r of rawRows) {
    const paired = r.ystId ? sapByYst.get(r.ystId) : undefined
    const sapId = r.sapId ?? (paired?.size === 1 ? [...paired][0] : null)
    const personKey = sapId ? `sap:${sapId}` : r.ystId && !paired ? `yst:${r.ystId}` : null
    if (personKey) {
      const person = people.get(personKey) ?? { key: personKey, sapId, ystIds: [], name: r.name }
      if (r.ystId && !person.ystIds.includes(r.ystId)) person.ystIds.push(r.ystId)
      person.name ??= r.name
      people.set(personKey, person)
    }
    const key = JSON.stringify([r.projectId, r.featureSlug, personKey])
    const group = groups.get(key) ?? []
    group.push({
      projectId: r.projectId,
      featureSlug: r.featureSlug,
      personKey,
      metrics: r.metrics
    })
    groups.set(key, group)
  }
  let contributions = [...groups.values()].map((rows) => ({
    ...rows[0],
    metrics: combineMetrics(
      rows.map((r) => r.metrics),
      true
    )
  }))
  if (input.person) {
    const { idType, id } = input.person
    const candidates = [...people.values()].filter((p) =>
      idType === "sapId" ? p.sapId === id : p.ystIds.includes(id)
    )
    if (candidates.length > 1) throw new Error("人员标识存在冲突，请使用 SAP 工号选择人员")
    contributions = contributions.filter((r) => r.personKey === candidates[0]?.key)
  }
  contributions.sort((a, b) =>
    JSON.stringify([a.projectId, a.featureSlug, a.personKey]).localeCompare(
      JSON.stringify([b.projectId, b.featureSlug, b.personKey])
    )
  )
  const projectIds = [...new Set(contributions.map((r) => r.projectId))]
  const projects = new Map<string, OperationsProjectContext>()
  for (let offset = 0; offset < projectIds.length; offset += RUN_ANALYSIS_BATCH_SIZE) {
    const batch = projectIds.slice(offset, offset + RUN_ANALYSIS_BATCH_SIZE)
    await forEachRunAnalysisBucket(
      checkedQuery,
      scope.eventIndex,
      [
        ...scope.accessFilters,
        { term: { eventName: "harness.project.snapshot" } },
        { terms: { "properties.projectId": batch } }
      ],
      [{ project: { terms: { field: "properties.projectId" } } }],
      {
        snapshot: {
          top_hits: {
            size: 1,
            sort: [{ eventTime: "desc" }],
            _source: {
              includes: [
                "eventTime",
                "properties.projectId",
                "properties.name",
                "properties.projectFromLean",
                "properties.lifecycleStatus",
                "properties.features.slug",
                "properties.features.title",
                "properties.features.currentNodeId",
                "properties.features.currentNodeStatusLabel"
              ]
            }
          }
        }
      },
      (b) => {
        const hits = record(record(b.snapshot).hits).hits
        const snapshot = Array.isArray(hits) ? record(record(hits[0])._source) : {}
        const p = record(snapshot.properties),
          id = text(p.projectId)
        if (!id || !batch.includes(id) || id !== record(b.key).project)
          throw new Error("周期项目快照范围不匹配")
        projects.set(id, {
          projectId: id,
          name: text(p.name) ?? id,
          fromLean: typeof p.projectFromLean === "boolean" ? p.projectFromLean : null,
          lifecycleStatus: text(p.lifecycleStatus),
          snapshotAt: text(snapshot.eventTime),
          features: Array.isArray(p.features)
            ? p.features.flatMap((item) => {
                const f = record(item),
                  slug = text(f.slug)
                return slug
                  ? [
                      {
                        slug,
                        title: text(f.title) ?? slug,
                        stage: text(f.currentNodeId),
                        status: text(f.currentNodeStatusLabel)
                      }
                    ]
                  : []
              })
            : []
        })
      }
    )
  }
  const selectedPeople = [...people.values()]
    .flatMap((p) => {
      const rows = contributions.filter((r) => r.personKey === p.key)
      return rows.length
        ? [{ ...p, ystIds: p.ystIds.sort(), summary: summarizeOperationsContributions(rows) }]
        : []
    })
    .sort(
      (a, b) =>
        b.summary.conversationCount - a.summary.conversationCount || a.key.localeCompare(b.key)
    )
  return {
    period,
    room: input.upperOrgLv1,
    dataAsOf,
    periodComplete: Date.parse(period.toExclusive) <= Date.parse(dataAsOf),
    summary: summarizeOperationsContributions(contributions),
    people: selectedPeople,
    contributions,
    projects: projectIds.map(
      (id) =>
        projects.get(id) ?? {
          projectId: id,
          name: id,
          fromLean: null,
          lifecycleStatus: null,
          snapshotAt: null,
          features: []
        }
    ),
    coverage: {
      unidentifiedContributions: contributions.filter((r) => r.personKey === null).length,
      missingProjectSnapshots: projectIds.length - projects.size,
      ambiguousIdentityCount: [...sapByYst.values()].filter((ids) => ids.size > 1).length
    },
    notes: [
      "按北京时间自然周（周一至周日）或自然月统计，结束边界不包含在本期内。",
      "项目与特性按本期执行、代码生成/采纳或知识读取记录圈定，包含现已归档项目；缺少当前快照不丢弃活动记录。",
      "对话为主动触发的主 Agent 轮次；工具、模型调用包含主子 Agent 开销，缺失字段不补零。",
      "代码按生成时间归属周期，Commit/Push 为该批代码截至本次查询的采纳情况；两项采纳率都以全部有效生成行为分母。",
      "个人归属沿用事件上报身份，按 SAP/YST 已知关系归一；不以姓名合并，不代表 Git 提交作者身份。",
      "项目精益关联、归档状态和特性阶段来自当前快照，不代表历史期末状态；执行耗时不是阶段停留天数。",
      "知识调用数为插件 sys 文件成功读取次数，重复读取计次，按读取汇总事件的上报时间归期；未记录读取汇总时留空，不推断为零。",
      "外部知识接口的近30天统计独立列为参考，周报和月报均须标明实际窗口，不当作本周或自然月新增数据；本系统知识读取次数仍按汇总事件时间归期。"
    ]
  }
}
