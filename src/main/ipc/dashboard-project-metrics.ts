import type {
  ProjectMetricFilters,
  ProjectMetricListOptions,
  ProjectMetricProjectItem,
  ProjectMetricProjectsData,
  ProjectMetricSummaryData,
  ProjectMetricSummaryGroup
} from "../../shared/project-metrics"

type EsQuery = (
  index: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<unknown>

interface ProjectMetricDependencies {
  query: EsQuery
  eventIndex: string
  traceIndex: string
  factIndex: string
}

interface LeanSnapshotProject {
  harnessProjectId: string
  prjCode: string
  adapterName: string
}

interface LeanSnapshotState {
  projects: LeanSnapshotProject[]
  harnessProjectIdsByPrjCode: Map<string, string[]>
  pluginsByPrjCode: Map<string, string[]>
  prjCodes: string[]
  pluginOptions: string[]
  truncated: boolean
}

interface FactProject {
  prjCode: string
  prjName: string
  phaseStatus: string
  roomName: string
  groupName: string
  bugNum: number | null
  notAdjustFuns: number | null
  createDate: string | null
  firstStStartDate: string | null
  firstOnlineDate: string | null
  approvedDate: string | null
}

interface EsHit {
  _source?: Record<string, unknown>
}

interface EsResponse {
  hits?: {
    total?: number | { value?: number }
    hits?: EsHit[]
  }
  aggregations?: Record<string, unknown>
}

const HARNESS_PROJECT_SNAPSHOT_EVENT = "harness.project.snapshot"
const PROJECT_METRIC_JOIN_KEY_LIMIT = 10_000
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000
const DAY_MS = 86_400_000
const FACT_SOURCE_INCLUDES = [
  "prjCode",
  "prjName",
  "phaseStatus",
  "roomName",
  "groupName",
  "bugNum",
  "notAdjustFuns",
  "createDate",
  "firstStStartDate",
  "firstOnlineDate",
  "approvedDate"
]

let snapshotCache: { expiresAt: number; value: LeanSnapshotState } | null = null

async function queryProjectMetricEs(
  deps: ProjectMetricDependencies,
  queryName: string,
  index: string,
  body: Record<string, unknown>
): Promise<unknown> {
  console.log(
    `[Dashboard][ProjectMetrics][ES] ${queryName}\nindex: ${index}\ndsl: ${JSON.stringify(body, null, 2)}`
  )
  return deps.query(index, body)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNullableString(value: unknown): string | null {
  const normalized = asString(value)
  return normalized || null
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = asNumber(value, Number.NaN)
  return Number.isFinite(parsed) ? parsed : null
}

function getTotalHits(raw: EsResponse, fallback: number): number {
  const total = raw.hits?.total
  if (typeof total === "number") return total
  return asNumber(asRecord(total).value, fallback)
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right, "zh-CN")
  )
}

function matchNoneOrTerms(field: string, values: string[]): Record<string, unknown> {
  return values.length > 0 ? { terms: { [field]: values } } : { match_none: {} }
}

function notTerms(field: string, values: string[]): Record<string, unknown> {
  return values.length > 0
    ? { bool: { must_not: [{ terms: { [field]: values } }] } }
    : { match_all: {} }
}

function shanghaiDateParts(value: string): { year: number; month: number; day: number } {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error("项目度量日期范围无效")
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { year: read("year"), month: read("month"), day: read("day") }
}

function formatShanghaiBoundary(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} 00:00:00`
}

function nextShanghaiDay(parts: { year: number; month: number; day: number }): {
  year: number
  month: number
  day: number
} {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function projectDateRange(range: ProjectMetricFilters["range"]): {
  gte: string
  lt: string
} {
  return {
    gte: formatShanghaiBoundary(shanghaiDateParts(range.from)),
    lt: formatShanghaiBoundary(nextShanghaiDay(shanghaiDateParts(range.to)))
  }
}

function buildFactBaseFilters(filters: ProjectMetricFilters): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [
    { range: { createDate: projectDateRange(filters.range) } }
  ]
  const rooms = uniqueSorted(filters.upperOrgLv1 ?? [])
  const phases = uniqueSorted(filters.phaseStatuses ?? [])
  if (rooms.length > 0) result.push({ terms: { roomName: rooms } })
  if (phases.length > 0) result.push({ terms: { phaseStatus: phases } })

  const minimum = filters.functionPointMin
  const maximum = filters.functionPointMax
  if (minimum !== null && minimum !== undefined) {
    result.push({ range: { notAdjustFuns: { gte: minimum } } })
  }
  if (maximum !== null && maximum !== undefined) {
    result.push({ range: { notAdjustFuns: { lte: maximum } } })
  }
  return result
}

async function fetchLeanSnapshotState(deps: ProjectMetricDependencies): Promise<LeanSnapshotState> {
  if (snapshotCache && snapshotCache.expiresAt > Date.now()) return snapshotCache.value

  const raw = (await queryProjectMetricEs(deps, "精益项目快照", deps.eventIndex, {
    size: PROJECT_METRIC_JOIN_KEY_LIMIT,
    track_total_hits: true,
    query: {
      bool: {
        filter: [
          { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } },
          { term: { "properties.projectFromLean": true } },
          { exists: { field: "properties.projectCode" } }
        ]
      }
    },
    sort: [{ "properties.projectId": { order: "asc" } }],
    _source: {
      includes: ["properties.projectId", "properties.projectCode", "properties.adapterName"]
    }
  })) as EsResponse

  const hits = raw.hits?.hits ?? []
  const projects = hits
    .map((hit): LeanSnapshotProject | null => {
      const properties = asRecord(asRecord(hit._source).properties)
      const harnessProjectId = asString(properties.projectId)
      const prjCode = asString(properties.projectCode)
      if (!harnessProjectId || !prjCode) return null
      return {
        harnessProjectId,
        prjCode,
        adapterName: asString(properties.adapterName)
      }
    })
    .filter((project): project is LeanSnapshotProject => project !== null)

  const harnessProjectIdsByPrjCode = new Map<string, string[]>()
  const pluginsByPrjCode = new Map<string, string[]>()
  for (const project of projects) {
    harnessProjectIdsByPrjCode.set(
      project.prjCode,
      uniqueSorted([
        ...(harnessProjectIdsByPrjCode.get(project.prjCode) ?? []),
        project.harnessProjectId
      ])
    )
    if (project.adapterName) {
      pluginsByPrjCode.set(
        project.prjCode,
        uniqueSorted([...(pluginsByPrjCode.get(project.prjCode) ?? []), project.adapterName])
      )
    }
  }

  const value: LeanSnapshotState = {
    projects,
    harnessProjectIdsByPrjCode,
    pluginsByPrjCode,
    prjCodes: uniqueSorted(projects.map((project) => project.prjCode)),
    pluginOptions: uniqueSorted(projects.map((project) => project.adapterName)),
    truncated: getTotalHits(raw, hits.length) > hits.length
  }
  snapshotCache = { expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS, value }
  return value
}

function selectedDevclawPrjCodes(
  snapshot: LeanSnapshotState,
  adapterName?: string | null
): string[] {
  const normalizedAdapter = asString(adapterName)
  if (!normalizedAdapter) return snapshot.prjCodes
  return uniqueSorted(
    snapshot.projects
      .filter((project) => project.adapterName === normalizedAdapter)
      .map((project) => project.prjCode)
  )
}

function summaryAggs(): Record<string, unknown> {
  return {
    avg_bug_count: { avg: { field: "bugNum" } },
    bug_sample_count: { value_count: { field: "bugNum" } },
    avg_function_points: { avg: { field: "notAdjustFuns" } },
    function_point_sample_count: { value_count: { field: "notAdjustFuns" } },
    defect_density_valid: {
      filter: {
        bool: {
          filter: [{ exists: { field: "bugNum" } }, { range: { notAdjustFuns: { gt: 0 } } }]
        }
      },
      aggs: {
        sum_bug_count: { sum: { field: "bugNum" } },
        sum_function_points: { sum: { field: "notAdjustFuns" } }
      }
    },
    avg_test_lead_seconds: { avg: { field: "testLeadSeconds" } },
    test_lead_sample_count: { value_count: { field: "testLeadSeconds" } },
    avg_delivery_seconds: { avg: { field: "deliverySeconds" } },
    delivery_sample_count: { value_count: { field: "deliverySeconds" } }
  }
}

function runtimeMappings(): Record<string, unknown> {
  return {
    testLeadSeconds: {
      type: "double",
      script: {
        source:
          "if (doc['createDate'].size() != 0 && doc['firstStStartDate'].size() != 0) { long start = doc['createDate'].value.toInstant().toEpochMilli(); long end = doc['firstStStartDate'].value.toInstant().toEpochMilli(); if (end >= start) emit((end - start) / 1000.0); }"
      }
    },
    deliverySeconds: {
      type: "double",
      script: {
        source:
          "if (doc['approvedDate'].size() != 0 && doc['firstOnlineDate'].size() != 0) { long start = doc['approvedDate'].value.toInstant().toEpochMilli(); long end = doc['firstOnlineDate'].value.toInstant().toEpochMilli(); if (end >= start) emit((end - start) / 1000.0); }"
      }
    }
  }
}

function parseFactProject(hit: EsHit): FactProject | null {
  const source = asRecord(hit._source)
  const prjCode = asString(source.prjCode)
  if (!prjCode) return null
  return {
    prjCode,
    prjName: asString(source.prjName),
    phaseStatus: asString(source.phaseStatus),
    roomName: asString(source.roomName),
    groupName: asString(source.groupName),
    bugNum: asNullableNumber(source.bugNum),
    notAdjustFuns: asNullableNumber(source.notAdjustFuns),
    createDate: asNullableString(source.createDate),
    firstStStartDate: asNullableString(source.firstStStartDate),
    firstOnlineDate: asNullableString(source.firstOnlineDate),
    approvedDate: asNullableString(source.approvedDate)
  }
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key])
}

function nullableAggValue(record: Record<string, unknown>, key: string): number | null {
  const value = nestedRecord(record, key).value
  return value === null || value === undefined ? null : asNullableNumber(value)
}

function ratio(numerator: number, denominator: number, multiplier: number): number | null {
  return denominator > 0 ? (numerator * multiplier) / denominator : null
}

function parseSummaryGroup(
  developmentMode: ProjectMetricSummaryGroup["developmentMode"],
  bucket: Record<string, unknown>
): ProjectMetricSummaryGroup {
  const density = nestedRecord(bucket, "defect_density_valid")
  const densityBug = asNumber(nestedRecord(density, "sum_bug_count").value)
  const densityFp = asNumber(nestedRecord(density, "sum_function_points").value)
  const testLeadSeconds = nullableAggValue(bucket, "avg_test_lead_seconds")
  const deliverySeconds = nullableAggValue(bucket, "avg_delivery_seconds")
  return {
    developmentMode,
    projectCount: asNumber(bucket.doc_count),
    avgBugCount: nullableAggValue(bucket, "avg_bug_count"),
    avgFuncPointCount: nullableAggValue(bucket, "avg_function_points"),
    defectDensityPer100Fp: ratio(densityBug, densityFp, 100),
    defectRatePerKloc: null,
    avgTestLeadDays: testLeadSeconds === null ? null : testLeadSeconds / 86_400,
    avgDeliveryDays: deliverySeconds === null ? null : deliverySeconds / 86_400,
    avgInputTokens: developmentMode === "devclaw" ? 0 : null,
    avgOutputTokens: developmentMode === "devclaw" ? 0 : null,
    avgPushedAdoptedLines: developmentMode === "devclaw" ? 0 : null,
    inputTokensPerAdoptedLine: developmentMode === "devclaw" ? 0 : null,
    outputTokensPerAdoptedLine: developmentMode === "devclaw" ? 0 : null,
    samples: {
      bug: asNumber(nestedRecord(bucket, "bug_sample_count").value),
      functionPoint: asNumber(nestedRecord(bucket, "function_point_sample_count").value),
      defectDensity: asNumber(density.doc_count),
      defectRate: 0,
      testLead: asNumber(nestedRecord(bucket, "test_lead_sample_count").value),
      delivery: asNumber(nestedRecord(bucket, "delivery_sample_count").value),
      token: 0,
      codeLines: 0,
      tokensPerLine: 0
    }
  }
}

async function fetchFactSummary(
  deps: ProjectMetricDependencies,
  filters: ProjectMetricFilters,
  allDevclawCodes: string[],
  selectedDevclawCodes: string[]
): Promise<{ devclaw: ProjectMetricSummaryGroup; nonDevclaw: ProjectMetricSummaryGroup }> {
  const raw = (await queryProjectMetricEs(deps, "总体事实聚合", deps.factIndex, {
    size: 0,
    track_total_hits: false,
    runtime_mappings: runtimeMappings(),
    query: { bool: { filter: buildFactBaseFilters(filters) } },
    aggs: {
      by_project_type: {
        filters: {
          filters: {
            devclaw: matchNoneOrTerms("prjCode", selectedDevclawCodes),
            non_devclaw: notTerms("prjCode", allDevclawCodes)
          }
        },
        aggs: summaryAggs()
      }
    }
  })) as EsResponse
  const buckets = nestedRecord(asRecord(raw.aggregations), "by_project_type").buckets
  const byType = asRecord(buckets)
  return {
    devclaw: parseSummaryGroup("devclaw", asRecord(byType.devclaw)),
    nonDevclaw: parseSummaryGroup("non_devclaw", asRecord(byType.non_devclaw))
  }
}

async function fetchSelectedDevclawFacts(
  deps: ProjectMetricDependencies,
  filters: ProjectMetricFilters,
  selectedDevclawCodes: string[]
): Promise<FactProject[]> {
  if (selectedDevclawCodes.length === 0) return []
  const raw = (await queryProjectMetricEs(deps, "DevClaw 项目事实", deps.factIndex, {
    size: PROJECT_METRIC_JOIN_KEY_LIMIT,
    track_total_hits: false,
    query: {
      bool: {
        filter: [...buildFactBaseFilters(filters), { terms: { prjCode: selectedDevclawCodes } }]
      }
    },
    _source: { includes: FACT_SOURCE_INCLUDES }
  })) as EsResponse
  return (raw.hits?.hits ?? [])
    .map(parseFactProject)
    .filter((project): project is FactProject => project !== null)
}

function harnessIdsForProjects(snapshot: LeanSnapshotState, prjCodes: string[]): string[] {
  return uniqueSorted(
    prjCodes.flatMap((prjCode) => snapshot.harnessProjectIdsByPrjCode.get(prjCode) ?? [])
  )
}

async function fetchPushedAdoptedLinesByHarnessProject(
  deps: ProjectMetricDependencies,
  harnessProjectIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (harnessProjectIds.length === 0) return result
  const raw = (await queryProjectMetricEs(deps, "项目已 Push 采纳行数", deps.eventIndex, {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { term: { eventName: "code_adopt" } },
          { exists: { field: "properties.adoptedLineCount" } },
          { exists: { field: "properties.generatedLineCount" } },
          { exists: { field: "properties.effectiveGeneratedLineCount" } },
          { term: { "properties.pushed": true } },
          { terms: { "properties.harnessProjectId": harnessProjectIds } }
        ]
      }
    },
    aggs: {
      by_harness_project: {
        terms: {
          field: "properties.harnessProjectId",
          size: Math.max(1, harnessProjectIds.length)
        },
        aggs: {
          pushed_adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
        }
      }
    }
  })) as EsResponse
  const buckets = nestedRecord(asRecord(raw.aggregations), "by_harness_project").buckets
  if (!Array.isArray(buckets)) return result
  for (const bucket of buckets) {
    const record = asRecord(bucket)
    const id = asString(record.key)
    if (id) result.set(id, asNumber(nestedRecord(record, "pushed_adopted_lines").value))
  }
  return result
}

interface HarnessTokenTotals {
  input: number
  output: number
}

async function fetchTokensByHarnessProject(
  deps: ProjectMetricDependencies,
  harnessProjectIds: string[]
): Promise<Map<string, HarnessTokenTotals>> {
  const result = new Map<string, HarnessTokenTotals>()
  if (harnessProjectIds.length === 0) return result
  const raw = (await queryProjectMetricEs(deps, "项目 Token", deps.traceIndex, {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { exists: { field: "harnessProjectId" } },
          { terms: { harnessProjectId: harnessProjectIds } }
        ]
      }
    },
    aggs: {
      by_harness_project: {
        terms: { field: "harnessProjectId", size: Math.max(1, harnessProjectIds.length) },
        aggs: {
          total_input_tokens: { sum: { field: "totalInputTokens" } },
          total_output_tokens: { sum: { field: "totalOutputTokens" } }
        }
      }
    }
  })) as EsResponse
  const buckets = nestedRecord(asRecord(raw.aggregations), "by_harness_project").buckets
  if (!Array.isArray(buckets)) return result
  for (const bucket of buckets) {
    const record = asRecord(bucket)
    const id = asString(record.key)
    if (!id) continue
    result.set(id, {
      input: asNumber(nestedRecord(record, "total_input_tokens").value),
      output: asNumber(nestedRecord(record, "total_output_tokens").value)
    })
  }
  return result
}

function sumPushedAdoptedLines(
  snapshot: LeanSnapshotState,
  byHarness: Map<string, number>,
  prjCode: string
): number {
  return (snapshot.harnessProjectIdsByPrjCode.get(prjCode) ?? []).reduce(
    (sum, harnessProjectId) => sum + (byHarness.get(harnessProjectId) ?? 0),
    0
  )
}

function sumTokens(
  snapshot: LeanSnapshotState,
  byHarness: Map<string, HarnessTokenTotals>,
  prjCode: string
): HarnessTokenTotals {
  return (snapshot.harnessProjectIdsByPrjCode.get(prjCode) ?? []).reduce(
    (sum, harnessProjectId) => {
      const value = byHarness.get(harnessProjectId)
      return {
        input: sum.input + (value?.input ?? 0),
        output: sum.output + (value?.output ?? 0)
      }
    },
    { input: 0, output: 0 }
  )
}

function millisBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const startMs = Date.parse(start.replace(" ", "T"))
  const endMs = Date.parse(end.replace(" ", "T"))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null
  return endMs - startMs
}

function buildProjectItem(
  fact: FactProject,
  snapshot: LeanSnapshotState,
  pushedAdoptedLinesByHarness: Map<string, number> | null,
  tokensByHarness: Map<string, HarnessTokenTotals> | null
): ProjectMetricProjectItem {
  const devclaw = snapshot.harnessProjectIdsByPrjCode.has(fact.prjCode)
  const pushedAdoptedLines =
    devclaw && pushedAdoptedLinesByHarness
      ? sumPushedAdoptedLines(snapshot, pushedAdoptedLinesByHarness, fact.prjCode)
      : null
  const tokens =
    devclaw && tokensByHarness ? sumTokens(snapshot, tokensByHarness, fact.prjCode) : null
  const testLeadMs = millisBetween(fact.createDate, fact.firstStStartDate)
  const deliveryMs = millisBetween(fact.approvedDate, fact.firstOnlineDate)
  return {
    ...fact,
    developmentMode: devclaw ? "devclaw" : "non_devclaw",
    plugins: devclaw ? (snapshot.pluginsByPrjCode.get(fact.prjCode) ?? []) : [],
    defectDensityPer100Fp:
      fact.bugNum !== null && fact.notAdjustFuns !== null && fact.notAdjustFuns > 0
        ? (fact.bugNum * 100) / fact.notAdjustFuns
        : null,
    pushedAdoptedLines,
    defectRatePerKloc:
      fact.bugNum !== null && pushedAdoptedLines !== null && pushedAdoptedLines > 0
        ? (fact.bugNum * 1000) / pushedAdoptedLines
        : null,
    testLeadDays: testLeadMs === null ? null : testLeadMs / DAY_MS,
    deliveryDays: deliveryMs === null ? null : deliveryMs / DAY_MS,
    totalInputTokens: tokens?.input ?? null,
    totalOutputTokens: tokens?.output ?? null,
    inputTokensPerAdoptedLine:
      tokens && pushedAdoptedLines && pushedAdoptedLines > 0
        ? tokens.input / pushedAdoptedLines
        : null,
    outputTokensPerAdoptedLine:
      tokens && pushedAdoptedLines && pushedAdoptedLines > 0
        ? tokens.output / pushedAdoptedLines
        : null,
    tokensPerAdoptedLine:
      tokens && pushedAdoptedLines && pushedAdoptedLines > 0
        ? (tokens.input + tokens.output) / pushedAdoptedLines
        : null
  }
}

function buildKeywordFilter(keyword?: string): Record<string, unknown> | null {
  const normalized = asString(keyword)
  if (!normalized) return null
  const wildcard = `*${escapeWildcard(normalized)}*`
  return {
    bool: {
      should: [{ wildcard: { prjCode: wildcard } }, { match_phrase: { prjName: normalized } }],
      minimum_should_match: 1
    }
  }
}

function escapeWildcard(value: string): string {
  return value.replace(/[\\*?]/g, "\\$&")
}

function buildDepartmentKeywordFilter(keyword?: string): Record<string, unknown> | null {
  const normalized = asString(keyword)
  if (!normalized) return null
  const wildcard = `*${escapeWildcard(normalized)}*`
  return {
    bool: {
      should: [{ wildcard: { roomName: wildcard } }, { wildcard: { groupName: wildcard } }],
      minimum_should_match: 1
    }
  }
}

function normalizePageSize(value?: number): 20 | 50 | 100 {
  return value === 50 || value === 100 ? value : 20
}

function normalizePage(value: number | undefined, pageSize: number): number {
  const maxPage = Math.max(1, Math.floor(PROJECT_METRIC_JOIN_KEY_LIMIT / pageSize))
  return Math.min(maxPage, Math.max(1, Math.floor(value ?? 1)))
}

function factSort(options: ProjectMetricListOptions): Record<string, unknown>[] {
  const field =
    options.sortBy === "bugNum" || options.sortBy === "notAdjustFuns"
      ? options.sortBy
      : "firstOnlineDate"
  const order = options.sortOrder === "asc" ? "asc" : "desc"
  return [{ [field]: { order, missing: "_last" } }, { prjCode: { order: "asc" } }]
}

function isDerivedMetricSort(
  sortBy: ProjectMetricListOptions["sortBy"]
): sortBy is "pushedAdoptedLines" | "tokensPerAdoptedLine" {
  return sortBy === "pushedAdoptedLines" || sortBy === "tokensPerAdoptedLine"
}

function derivedMetricSortValue(
  item: ProjectMetricProjectItem,
  sortBy: "pushedAdoptedLines" | "tokensPerAdoptedLine"
): number | null {
  return sortBy === "pushedAdoptedLines" ? item.pushedAdoptedLines : item.tokensPerAdoptedLine
}

function sortByDerivedMetric(
  items: ProjectMetricProjectItem[],
  sortBy: "pushedAdoptedLines" | "tokensPerAdoptedLine",
  sortOrder: ProjectMetricListOptions["sortOrder"]
): ProjectMetricProjectItem[] {
  const direction = sortOrder === "asc" ? 1 : -1
  return [...items].sort((left, right) => {
    const leftValue = derivedMetricSortValue(left, sortBy)
    const rightValue = derivedMetricSortValue(right, sortBy)
    if (leftValue === null && rightValue !== null) return 1
    if (leftValue !== null && rightValue === null) return -1
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return (leftValue - rightValue) * direction
    }
    return left.prjCode.localeCompare(right.prjCode)
  })
}

async function enrichProjectFacts(
  facts: FactProject[],
  snapshot: LeanSnapshotState,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricProjectItem[]> {
  const devclawCodes = facts
    .filter((project) => snapshot.harnessProjectIdsByPrjCode.has(project.prjCode))
    .map((project) => project.prjCode)
  const harnessProjectIds = harnessIdsForProjects(snapshot, devclawCodes)
  const [codeResult, tokenResult] = await Promise.allSettled([
    fetchPushedAdoptedLinesByHarnessProject(deps, harnessProjectIds),
    fetchTokensByHarnessProject(deps, harnessProjectIds)
  ])
  return facts.map((fact) =>
    buildProjectItem(
      fact,
      snapshot,
      codeResult.status === "fulfilled" ? codeResult.value : null,
      tokenResult.status === "fulfilled" ? tokenResult.value : null
    )
  )
}

export async function fetchProjectMetricSummary(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricSummaryData> {
  const snapshot = await fetchLeanSnapshotState(deps)
  const selectedCodes = selectedDevclawPrjCodes(snapshot, filters.adapterName)
  const [factSummary, devclawFacts] = await Promise.all([
    fetchFactSummary(deps, filters, snapshot.prjCodes, selectedCodes),
    fetchSelectedDevclawFacts(deps, filters, selectedCodes)
  ])
  const harnessProjectIds = harnessIdsForProjects(
    snapshot,
    devclawFacts.map((project) => project.prjCode)
  )
  const [codeResult, tokenResult] = await Promise.allSettled([
    fetchPushedAdoptedLinesByHarnessProject(deps, harnessProjectIds),
    fetchTokensByHarnessProject(deps, harnessProjectIds)
  ])

  const devclaw = factSummary.devclaw
  const devclawProjectCount = devclawFacts.length
  if (codeResult.status === "fulfilled") {
    let bugTotal = 0
    let defectRateLineTotal = 0
    let defectRateSampleCount = 0
    let allProjectLineTotal = 0
    for (const project of devclawFacts) {
      const pushedAdoptedLines = sumPushedAdoptedLines(snapshot, codeResult.value, project.prjCode)
      allProjectLineTotal += pushedAdoptedLines
      if (project.bugNum === null || pushedAdoptedLines <= 0) continue
      bugTotal += project.bugNum
      defectRateLineTotal += pushedAdoptedLines
      defectRateSampleCount += 1
    }
    devclaw.defectRatePerKloc = ratio(bugTotal, defectRateLineTotal, 1000)
    devclaw.avgPushedAdoptedLines =
      devclawProjectCount > 0 ? allProjectLineTotal / devclawProjectCount : null
    devclaw.samples.defectRate = defectRateSampleCount
    devclaw.samples.codeLines = devclawProjectCount
  } else {
    devclaw.defectRatePerKloc = null
    devclaw.avgPushedAdoptedLines = null
  }

  if (tokenResult.status === "fulfilled") {
    const total = devclawFacts.reduce(
      (sum, project) => {
        const tokens = sumTokens(snapshot, tokenResult.value, project.prjCode)
        return { input: sum.input + tokens.input, output: sum.output + tokens.output }
      },
      { input: 0, output: 0 }
    )
    devclaw.avgInputTokens = devclawProjectCount > 0 ? total.input / devclawProjectCount : null
    devclaw.avgOutputTokens = devclawProjectCount > 0 ? total.output / devclawProjectCount : null
    devclaw.samples.token = devclawProjectCount
  } else {
    devclaw.avgInputTokens = null
    devclaw.avgOutputTokens = null
  }

  if (codeResult.status === "fulfilled" && tokenResult.status === "fulfilled") {
    let lineTotal = 0
    let inputTokenTotal = 0
    let outputTokenTotal = 0
    let sampleCount = 0
    for (const project of devclawFacts) {
      const pushedAdoptedLines = sumPushedAdoptedLines(snapshot, codeResult.value, project.prjCode)
      if (pushedAdoptedLines <= 0) continue
      const tokens = sumTokens(snapshot, tokenResult.value, project.prjCode)
      lineTotal += pushedAdoptedLines
      inputTokenTotal += tokens.input
      outputTokenTotal += tokens.output
      sampleCount += 1
    }
    devclaw.inputTokensPerAdoptedLine = ratio(inputTokenTotal, lineTotal, 1)
    devclaw.outputTokensPerAdoptedLine = ratio(outputTokenTotal, lineTotal, 1)
    devclaw.samples.tokensPerLine = sampleCount
  } else {
    devclaw.inputTokensPerAdoptedLine = null
    devclaw.outputTokensPerAdoptedLine = null
  }

  return {
    groups: [devclaw, factSummary.nonDevclaw],
    pluginOptions: snapshot.pluginOptions,
    truncated: snapshot.truncated
  }
}

export async function fetchProjectMetricProjects(
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricProjectsData> {
  const snapshot = await fetchLeanSnapshotState(deps)
  const selectedCodes = selectedDevclawPrjCodes(snapshot, filters.adapterName)
  const factFilters = buildFactBaseFilters(filters)
  const developmentMode = options.developmentMode ?? "all"
  if (filters.adapterName || developmentMode === "devclaw") {
    factFilters.push(matchNoneOrTerms("prjCode", selectedCodes))
  } else if (developmentMode === "non_devclaw") {
    factFilters.push(notTerms("prjCode", snapshot.prjCodes))
  }
  const keywordFilter = buildKeywordFilter(options.keyword)
  if (keywordFilter) factFilters.push(keywordFilter)
  const departmentKeywordFilter = buildDepartmentKeywordFilter(options.departmentKeyword)
  if (departmentKeywordFilter) factFilters.push(departmentKeywordFilter)

  const pageSize = normalizePageSize(options.pageSize)
  const page = normalizePage(options.page, pageSize)
  const derivedSortBy = isDerivedMetricSort(options.sortBy) ? options.sortBy : null
  const derivedSort = derivedSortBy !== null
  const raw = (await queryProjectMetricEs(
    deps,
    derivedSort ? "项目明细派生指标排序事实集" : "项目明细",
    deps.factIndex,
    {
      ...(derivedSort ? {} : { from: (page - 1) * pageSize }),
      size: derivedSort ? PROJECT_METRIC_JOIN_KEY_LIMIT : pageSize,
      track_total_hits: true,
      query: { bool: { filter: factFilters } },
      sort: derivedSort ? [{ prjCode: { order: "asc" } }] : factSort(options),
      _source: { includes: FACT_SOURCE_INCLUDES }
    }
  )) as EsResponse
  const facts = (raw.hits?.hits ?? [])
    .map(parseFactProject)
    .filter((project): project is FactProject => project !== null)
  const enriched = await enrichProjectFacts(facts, snapshot, deps)
  const ordered = derivedSortBy
    ? sortByDerivedMetric(enriched, derivedSortBy, options.sortOrder)
    : enriched
  const items = derivedSort ? ordered.slice((page - 1) * pageSize, page * pageSize) : ordered
  const actualTotal = getTotalHits(raw, facts.length)

  return {
    items,
    total: derivedSort ? facts.length : actualTotal,
    page,
    pageSize,
    truncated: snapshot.truncated || (derivedSort && actualTotal > facts.length)
  }
}

export function makeMockProjectMetricSummary(
  filters: ProjectMetricFilters
): ProjectMetricSummaryData {
  const pluginSelected = Boolean(asString(filters.adapterName))
  return {
    groups: [
      {
        developmentMode: "devclaw",
        projectCount: pluginSelected ? 18 : 42,
        avgBugCount: 6.4,
        avgFuncPointCount: 112.8,
        defectDensityPer100Fp: 5.67,
        defectRatePerKloc: 1.42,
        avgTestLeadDays: 24.6,
        avgDeliveryDays: 18.2,
        avgInputTokens: 678_571,
        avgOutputTokens: 56_190,
        avgPushedAdoptedLines: 5120,
        inputTokensPerAdoptedLine: 132.53,
        outputTokensPerAdoptedLine: 10.97,
        samples: {
          bug: pluginSelected ? 18 : 42,
          functionPoint: pluginSelected ? 17 : 40,
          defectDensity: pluginSelected ? 17 : 39,
          defectRate: pluginSelected ? 15 : 36,
          testLead: pluginSelected ? 16 : 38,
          delivery: pluginSelected ? 16 : 37,
          token: pluginSelected ? 18 : 42,
          codeLines: pluginSelected ? 18 : 42,
          tokensPerLine: pluginSelected ? 15 : 36
        }
      },
      {
        developmentMode: "non_devclaw",
        projectCount: 136,
        avgBugCount: 8.9,
        avgFuncPointCount: 105.2,
        defectDensityPer100Fp: 8.46,
        defectRatePerKloc: null,
        avgTestLeadDays: 31.4,
        avgDeliveryDays: 22.8,
        avgInputTokens: null,
        avgOutputTokens: null,
        avgPushedAdoptedLines: null,
        inputTokensPerAdoptedLine: null,
        outputTokensPerAdoptedLine: null,
        samples: {
          bug: 136,
          functionPoint: 129,
          defectDensity: 126,
          defectRate: 0,
          testLead: 121,
          delivery: 124,
          token: 0,
          codeLines: 0,
          tokensPerLine: 0
        }
      }
    ],
    pluginOptions: ["AutoBizDevOps", "CmbCowork Compose Delivery"],
    truncated: false
  }
}

const MOCK_PROJECTS: ProjectMetricProjectItem[] = [
  {
    prjCode: "T26HRZ51",
    prjName: "高风险反洗钱尽调消费逻辑改造",
    developmentMode: "devclaw",
    plugins: ["AutoBizDevOps"],
    phaseStatus: "结项完成",
    roomName: "零售基础客群经营开发室(成都)",
    groupName: "经营分析一组",
    bugNum: 6,
    notAdjustFuns: 348.12,
    defectDensityPer100Fp: 1.72,
    pushedAdoptedLines: 6000,
    defectRatePerKloc: 1,
    createDate: "2026-07-06 00:00:00",
    firstStStartDate: "2026-07-27 09:44:49",
    firstOnlineDate: "2026-08-03 00:00:00",
    approvedDate: "2026-07-06 00:00:00",
    testLeadDays: 21.41,
    deliveryDays: 28,
    totalInputTokens: 2_400_000,
    totalOutputTokens: 180_000,
    inputTokensPerAdoptedLine: 400,
    outputTokensPerAdoptedLine: 30,
    tokensPerAdoptedLine: 430
  },
  {
    prjCode: "T26HTL91",
    prjName: "客户经营平台交付优化",
    developmentMode: "devclaw",
    plugins: ["CmbCowork Compose Delivery"],
    phaseStatus: "上线完成",
    roomName: "零售客户经营开发室",
    groupName: "经营分析二组",
    bugNum: 3,
    notAdjustFuns: 126.5,
    defectDensityPer100Fp: 2.37,
    pushedAdoptedLines: 3000,
    defectRatePerKloc: 1,
    createDate: "2026-07-12 00:00:00",
    firstStStartDate: "2026-07-30 10:00:00",
    firstOnlineDate: "2026-08-08 00:00:00",
    approvedDate: "2026-07-15 00:00:00",
    testLeadDays: 18.42,
    deliveryDays: 24,
    totalInputTokens: 1_860_000,
    totalOutputTokens: 142_000,
    inputTokensPerAdoptedLine: 620,
    outputTokensPerAdoptedLine: 47.33,
    tokensPerAdoptedLine: 667.33
  },
  {
    prjCode: "T26NON01",
    prjName: "渠道业务流程改造",
    developmentMode: "non_devclaw",
    plugins: [],
    phaseStatus: "ST完成",
    roomName: "渠道应用研发室",
    groupName: "渠道研发一组",
    bugNum: 9,
    notAdjustFuns: null,
    defectDensityPer100Fp: null,
    pushedAdoptedLines: null,
    defectRatePerKloc: null,
    createDate: "2026-07-18 00:00:00",
    firstStStartDate: "2026-08-02 09:30:00",
    firstOnlineDate: null,
    approvedDate: "2026-07-20 00:00:00",
    testLeadDays: 15.4,
    deliveryDays: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    inputTokensPerAdoptedLine: null,
    outputTokensPerAdoptedLine: null,
    tokensPerAdoptedLine: null
  }
]

export function makeMockProjectMetricProjects(
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions = {}
): ProjectMetricProjectsData {
  const mode = options.developmentMode ?? "all"
  const keyword = asString(options.keyword).toLocaleLowerCase("zh-CN")
  const departmentKeyword = asString(options.departmentKeyword).toLocaleLowerCase("zh-CN")
  const adapterName = asString(filters.adapterName)
  const filtered = MOCK_PROJECTS.filter((item) => mode === "all" || item.developmentMode === mode)
    .filter((item) => !adapterName || item.plugins.includes(adapterName))
    .filter(
      (item) =>
        !keyword ||
        item.prjCode.toLocaleLowerCase("zh-CN").includes(keyword) ||
        item.prjName.toLocaleLowerCase("zh-CN").includes(keyword)
    )
    .filter(
      (item) =>
        !departmentKeyword ||
        item.roomName.toLocaleLowerCase("zh-CN").includes(departmentKeyword) ||
        item.groupName.toLocaleLowerCase("zh-CN").includes(departmentKeyword)
    )
  const sortBy = options.sortBy ?? "firstOnlineDate"
  const direction = options.sortOrder === "asc" ? 1 : -1
  const sorted = [...filtered].sort((left, right) => {
    const read = (item: ProjectMetricProjectItem): number | null => {
      if (sortBy === "firstOnlineDate") {
        const timestamp = item.firstOnlineDate ? Date.parse(item.firstOnlineDate) : Number.NaN
        return Number.isFinite(timestamp) ? timestamp : null
      }
      return item[sortBy]
    }
    const leftValue = read(left)
    const rightValue = read(right)
    if (leftValue === null && rightValue !== null) return 1
    if (leftValue !== null && rightValue === null) return -1
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      return (leftValue - rightValue) * direction
    }
    return left.prjCode.localeCompare(right.prjCode)
  })
  const pageSize = normalizePageSize(options.pageSize)
  const page = normalizePage(options.page, pageSize)
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total: sorted.length,
    page,
    pageSize,
    truncated: false
  }
}
