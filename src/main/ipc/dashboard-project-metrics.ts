import {
  PROJECT_METRIC_TEAM,
  type ProjectMetricFilters,
  type ProjectMetricListOptions,
  type ProjectMetricProjectItem,
  type ProjectMetricProjectsData,
  type ProjectMetricSummaryData,
  type ProjectMetricTrendData,
  type ProjectMetricTrendFilters,
  type ProjectMetricOverviewData,
  type ProjectMetricMonthlyCode,
  type ProjectMetricIndicatorExportData,
  type ProjectMetricCodeOverview,
  type ProjectMetricPeriodCode
} from "../../shared/project-metrics"
import {
  formatProjectDate,
  projectCompleteMonths,
  projectMonthlyPeriodLabel,
  projectRangeBounds,
  projectWorkingDays,
  PROJECT_CALENDAR_NOTE
} from "../../shared/project-metric-calendar"
import { fetchTestProjectIds } from "./project-mode-test-projects"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"
import { readOrgText } from "./dashboard-org-fields"
import {
  advancedProjectReason,
  projectCandidateReason,
  projectMetricSampleReasons,
  PROJECT_METRIC_SAMPLE_KEYS
} from "../../shared/project-metric-samples"
import { projectInPeriod, projectMetricGroups } from "./dashboard-project-metric-calculations"
import {
  PROJECT_METRIC_MOCK_ROOMS,
  PROJECT_METRIC_MOCK_PROJECTS,
  PROJECT_METRIC_MOCK_FEATURES,
  PROJECT_METRIC_MOCK_TELEMETRY,
  PROJECT_METRIC_MOCK_CODE,
  projectMetricMockMonthlyRecords
} from "./project-metric-mock-data"

type RecordValue = Record<string, unknown>
type Query = (
  index: string,
  body: RecordValue,
  options?: { timeoutMs?: number }
) => Promise<unknown>
export interface ProjectMetricDependencies {
  query: Query
  eventIndex: string
  traceIndex: string
  factIndex: string
  featureIndex?: string
  monthlyIndex?: string
  /** null 表示管理员不限室；空数组表示无可访问室。 */
  allowedRoomNames: string[] | null
  validateFactFields?: () => Promise<void>
  codeEvidence?: (
    range: ProjectMetricFilters["range"],
    harnessIds: string[]
  ) => Promise<ProjectMetricPeriodCode[]>
  codeStats?: (
    range: ProjectMetricFilters["range"],
    rooms: string[] | null,
    harnessIds: string[]
  ) => Promise<ProjectMetricCodeOverview>
}
interface SnapshotProject {
  harnessProjectId: string
  prjCode: string
  adapterName: string
}
interface Snapshot {
  projects: SnapshotProject[]
  byCode: Map<string, SnapshotProject[]>
  pluginOptions: string[]
}
interface Hit {
  _source?: RecordValue
  sort?: unknown[]
}
interface Response {
  hits?: { hits?: Hit[]; total?: number | { value: number; relation?: string } }
  aggregations?: RecordValue
}
const PAGE_SIZE = 500
const TERMS_BATCH_SIZE = 1000
const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000
const snapshotCache = new WeakMap<
  Query,
  Map<string, { expiresAt: number; projects: SnapshotProject[] }>
>()
const FACT_FIELDS = [
  "pm",
  "prjCode",
  "prjName",
  "teamName",
  "phaseStatus",
  "roomName",
  "groupName",
  "bugNum",
  "kenanIssueCount",
  "kenanIssueCategoryCount",
  "notAdjustFuns",
  "createDate",
  "firstStStartDate",
  "firstStEndDate",
  "firstUatStartDate",
  "firstOnlineDate",
  "approvedDate",
  "featureCodes",
  "devWorkHours",
  "syncBatchNo",
  "syncedAt"
]
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
function number(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim()) ||
    typeof value === "boolean"
  )
    return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(string).filter(Boolean))].sort() : []
}
function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += TERMS_BATCH_SIZE)
    result.push(values.slice(i, i + TERMS_BATCH_SIZE))
  return result
}
function terms(field: string, values: string[]): RecordValue {
  return values.length
    ? {
        bool: {
          should: chunks(values).map((batch) => ({ terms: { [field]: batch } })),
          minimum_should_match: 1
        }
      }
    : { match_none: {} }
}
function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
async function query(
  deps: ProjectMetricDependencies,
  name: string,
  index: string,
  body: RecordValue
): Promise<Response> {
  console.log(
    `[Dashboard][ProjectMetrics][ES] ${name}\nindex: ${index}\ndsl: ${JSON.stringify(body)}`
  )
  const raw = (await deps.query(index, body)) as Response
  assertProjectModeResultComplete(raw)
  return raw
}
/** 项目编号是事实文档的唯一业务主键；完整分页，不受 ES from/size 窗口限制。 */
async function facts(
  deps: ProjectMetricDependencies,
  filters: RecordValue[],
  fields = FACT_FIELDS,
  index = deps.factIndex,
  key = "prjCode"
): Promise<RecordValue[]> {
  const result: RecordValue[] = []
  let after: unknown[] | undefined
  const cursors = new Set<string>()
  let total: number | undefined
  for (;;) {
    const raw = await query(deps, "事实完整分页", index, {
      size: PAGE_SIZE,
      track_total_hits: true,
      query: { bool: { filter: filters } },
      sort: [{ [key]: "asc" }],
      _source: { includes: fields },
      ...(after ? { search_after: after } : {})
    })
    const page = raw.hits?.hits
    if (!Array.isArray(page)) throw new Error("项目事实未完整返回，请重试")
    const count = raw.hits?.total
    const countValue = typeof count === "number" ? count : count?.value
    if (
      countValue === undefined ||
      !Number.isSafeInteger(countValue) ||
      countValue < 0 ||
      (typeof count === "object" && count.relation === "gte")
    )
      throw new Error("项目事实缺少精确总数，请重试")
    if (total !== undefined && total !== countValue)
      throw new Error("项目事实正在同步，分页总数发生变化，请稍后重试")
    total = countValue
    for (const hit of page) result.push(record(hit._source))
    if (total !== undefined && result.length === total) break
    if (page.length < PAGE_SIZE) {
      if (total !== undefined && result.length !== total)
        throw new Error("项目事实分页不完整，请重试")
      break
    }
    const last = page[page.length - 1]
    after = last.sort
    if (!after?.length) throw new Error("项目事实分页缺少游标，请重试")
    const cursor = JSON.stringify(after)
    if (cursors.has(cursor)) throw new Error("项目事实分页游标重复，请重试")
    cursors.add(cursor)
  }
  return result
}

/** 不限制周期或当前室，否则跨室关联会误判。分类只返回主进程内部使用。 */
async function snapshot(deps: ProjectMetricDependencies): Promise<Snapshot> {
  const excluded = new Set(await fetchTestProjectIds(deps.eventIndex, [], deps.query))
  let cache = snapshotCache.get(deps.query)
  if (!cache) {
    cache = new Map()
    snapshotCache.set(deps.query, cache)
  }
  const cached = cache.get(deps.eventIndex)
  const useCache = Boolean(cached && cached.expiresAt > Date.now())
  const snapshotProjects: SnapshotProject[] = useCache ? cached!.projects : []
  let after: RecordValue | undefined
  const cursors = new Set<string>()
  for (; !useCache; ) {
    const raw = await query(deps, "精益非测试项目快照", deps.eventIndex, {
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { eventName: "harness.project.snapshot" } },
            { term: { "properties.projectFromLean": true } },
            { exists: { field: "properties.projectCode" } }
          ]
        }
      },
      aggs: {
        projects: {
          composite: {
            size: PAGE_SIZE,
            sources: [{ projectId: { terms: { field: "properties.projectId" } } }],
            ...(after ? { after } : {})
          },
          aggs: {
            snapshot: {
              top_hits: {
                size: 1,
                _source: {
                  includes: [
                    "properties.projectId",
                    "properties.projectCode",
                    "properties.adapterName"
                  ]
                }
              }
            }
          }
        }
      }
    })
    const aggregation = record(raw.aggregations?.projects)
    if (!Array.isArray(aggregation.buckets)) throw new Error("精益项目快照未完整返回，请重试")
    for (const value of aggregation.buckets) {
      const bucket = record(value)
      const hits = record(record(bucket.snapshot).hits).hits
      if (!Array.isArray(hits) || hits.length !== 1) throw new Error("精益项目快照缺少项目事实")
      const p = record(record(record(hits[0])._source).properties)
      const harnessProjectId = string(p.projectId)
      const prjCode = string(p.projectCode)
      if (harnessProjectId && prjCode)
        snapshotProjects.push({ harnessProjectId, prjCode, adapterName: string(p.adapterName) })
    }
    if (!aggregation.buckets.length || !aggregation.after_key) break
    after = record(aggregation.after_key)
    const cursor = JSON.stringify(after)
    if (!string(after.projectId) || cursors.has(cursor)) throw new Error("精益项目快照分页游标无效")
    cursors.add(cursor)
  }
  if (!useCache)
    cache.set(deps.eventIndex, {
      expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
      projects: snapshotProjects
    })
  // 测试标记每次重新读取；缓存只复用项目关联，不缓存测试排除结果。
  const projects = snapshotProjects.filter((p) => !excluded.has(p.harnessProjectId))
  const byCode = new Map<string, SnapshotProject[]>()
  for (const p of projects) byCode.set(p.prjCode, [...(byCode.get(p.prjCode) ?? []), p])
  return { projects, byCode, pluginOptions: strings(projects.map((p) => p.adapterName)) }
}

export async function fetchProjectMetricEligibleHarnessIds(
  deps: ProjectMetricDependencies
): Promise<string[]> {
  return strings((await snapshot(deps)).projects.map((p) => p.harnessProjectId))
}

function validateFilters(filters: ProjectMetricFilters): void {
  projectRangeBounds(filters.range)
  if (
    filters.dateBasis !== undefined &&
    !["created", "developmentCompleted"].includes(filters.dateBasis)
  )
    throw new Error("项目日期口径无效")
  for (const [min, max] of [
    [filters.functionPointMin, filters.functionPointMax],
    [filters.tokenConsumptionMin, filters.tokenConsumptionMax]
  ]) {
    if (
      [min, max].some(
        (v) => v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      ) ||
      (min != null && max != null && min > max)
    )
      throw new Error("项目数值筛选区间无效")
  }
  if (
    filters.upperOrgLv1 !== undefined &&
    (!Array.isArray(filters.upperOrgLv1) || filters.upperOrgLv1.some((v) => typeof v !== "string"))
  )
    throw new Error("室筛选无效")
  if (filters.groupNames?.length) throw new Error("本期不支持组筛选")
}
function roomsFor(filters: ProjectMetricFilters, deps: ProjectMetricDependencies): string[] | null {
  const requested = strings(filters.upperOrgLv1)
  if (deps.allowedRoomNames === null) return requested.length ? requested : null
  const allowed = new Set(deps.allowedRoomNames)
  return requested.length ? requested.filter((room) => allowed.has(room)) : [...allowed]
}
function organizationFilters(rooms: string[] | null): RecordValue[] {
  return [
    { term: { teamName: PROJECT_METRIC_TEAM } },
    { range: { createDate: { gte: "2026-06-01 00:00:00" } } },
    ...(rooms === null ? [] : [terms("roomName", rooms)])
  ]
}
function periodFilter(filters: ProjectMetricFilters, online = false): RecordValue {
  const range = projectRangeBounds(filters.range)
  if (online) return { range: { firstOnlineDate: range } }
  if (filters.dateBasis === "created") return { range: { createDate: range } }
  return {
    bool: {
      should: [
        { range: { firstStStartDate: range } },
        {
          bool: {
            must_not: [{ exists: { field: "firstStStartDate" } }],
            filter: [{ range: { firstUatStartDate: range } }]
          }
        }
      ],
      minimum_should_match: 1
    }
  }
}
function inAdvancedScope(item: ProjectMetricProjectItem, filters: ProjectMetricFilters): boolean {
  return advancedProjectReason(item, filters) === null
}

function parseFact(source: RecordValue, state: Snapshot): ProjectMetricProjectItem {
  const prjCode = string(source.prjCode)
  const smart = state.byCode.has(prjCode)
  const date = (key: string): string | null => string(source[key]) || null
  const approvedDate = date("approvedDate")
  const createDate = date("createDate")
  const st = date("firstStStartDate")
  const uat = date("firstUatStartDate")
  const fp = number(source.notAdjustFuns)
  const bug = number(source.bugNum)
  const featureCodes = strings(source.featureCodes)
  return {
    prjCode,
    pm: string(source.pm) || null,
    prjName: string(source.prjName),
    teamName: string(source.teamName),
    roomName: string(source.roomName),
    groupName: string(source.groupName),
    phaseStatus: string(source.phaseStatus),
    developmentMode: smart ? "devclaw" : "non_devclaw",
    plugins: strings(state.byCode.get(prjCode)?.map((p) => p.adapterName)),
    bugNum: bug,
    notAdjustFuns: fp,
    kenanIssueCount: number(source.kenanIssueCount),
    kenanIssueCategories: (Array.isArray(source.kenanIssueCategoryCount)
      ? source.kenanIssueCategoryCount
      : []
    )
      .map((v) => {
        const c = record(v)
        return { category: string(c.category), count: number(c.count) ?? 0 }
      })
      .filter((c) => c.category && c.count > 0),
    syncBatchNo: date("syncBatchNo"),
    syncedAt: date("syncedAt"),
    devWorkHours: number(source.devWorkHours),
    featureCodes,
    features: featureCodes.map((featureCode) => ({ featureCode, featureName: null })),
    createDate,
    approvedDate,
    firstStStartDate: st,
    firstStEndDate: date("firstStEndDate"),
    firstUatStartDate: uat,
    firstOnlineDate: date("firstOnlineDate"),
    testLeadDays: projectWorkingDays(createDate, st),
    uatLeadDays: projectWorkingDays(createDate, uat),
    deliveryDays: projectWorkingDays(approvedDate, date("firstOnlineDate")),
    approvalDevelopmentDays: projectWorkingDays(approvedDate, st || uat),
    approvalCreationDays: projectWorkingDays(approvedDate, createDate),
    defectDensityPer100Fp: bug !== null && fp !== null && fp > 0 ? (bug * 100) / fp : null,
    pushedAdoptedLines: smart ? 0 : null,
    totalInputTokens: smart ? 0 : null,
    totalOutputTokens: smart ? 0 : null,
    inputTokensPerAdoptedLine: null,
    outputTokensPerAdoptedLine: null,
    tokensPerAdoptedLine: null
  }
}
async function fillProjectFeatureNames(
  selected: ProjectMetricProjectItem[],
  deps: ProjectMetricDependencies,
  warnings: string[]
): Promise<void> {
  if (selected.some((p) => p.featureCodes.length)) {
    try {
      const names = new Map<string, string>()
      for (const batch of chunks(strings(selected.flatMap((p) => p.featureCodes)))) {
        const raw = await facts(
          deps,
          [{ terms: { featureCode: batch } }],
          ["featureCode", "featureName"],
          deps.featureIndex ?? "devclaw_feature_info",
          "featureCode"
        )
        for (const f of raw) names.set(string(f.featureCode), string(f.featureName))
      }
      for (const p of selected)
        p.features = p.featureCodes.map((featureCode) => ({
          featureCode,
          featureName: names.get(featureCode) || null
        }))
    } catch (error) {
      warnings.push(`特性名称暂不可用：${failure(error)}`)
    }
  }
}

/** 个人看板只读取项目事实，不额外查询项目累计 Token 或累计代码。 */
export async function fetchPersonalEfficiencyProjectContext(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies,
  detailSapId?: string,
  includeAllProjectNames = false
): Promise<{
  projects: ProjectMetricProjectItem[]
  bindings: SnapshotProject[]
  warnings: string[]
}> {
  validateFilters(filters)
  await deps.validateFactFields?.()
  const state = await snapshot(deps)
  const raw = await facts(deps, [
    ...organizationFilters(roomsFor(filters, deps)),
    periodFilter(filters)
  ])
  const parsed = raw.map((source) => parseFact(source, state))
  if (
    new Set(parsed.map((p) => p.prjCode)).size !== parsed.length ||
    parsed.some((p) => !p.prjCode)
  )
    throw new Error("项目事实编号缺失或重复")
  const projects = detailSapId
    ? parsed.filter((project) => project.pm?.split("/")[1]?.trim() === detailSapId)
    : parsed
  const warnings: string[] = []
  if (detailSapId || includeAllProjectNames) await fillProjectFeatureNames(projects, deps, warnings)
  return { projects, bindings: state.projects, warnings }
}

async function cumulative(
  deps: ProjectMetricDependencies,
  ids: string[],
  kind: "code" | "token"
): Promise<Map<string, { input: number; output: number; lines: number }>> {
  const result = new Map<string, { input: number; output: number; lines: number }>()
  for (const batch of chunks(ids)) {
    const code = kind === "code"
    const raw = await query(
      deps,
      code ? "累计已Push采纳行数" : "累计Token",
      code ? deps.eventIndex : deps.traceIndex,
      {
        size: 0,
        query: {
          bool: {
            filter: [
              { terms: { [code ? "properties.harnessProjectId" : "harnessProjectId"]: batch } },
              ...(code
                ? [
                    { term: { eventName: "code_adopt" } },
                    { term: { "properties.pushed": true } },
                    ...[
                      "adoptedLineCount",
                      "generatedLineCount",
                      "effectiveGeneratedLineCount"
                    ].map((f) => ({ exists: { field: `properties.${f}` } }))
                  ]
                : [])
            ]
          }
        },
        aggs: {
          projects: {
            terms: {
              field: code ? "properties.harnessProjectId" : "harnessProjectId",
              size: batch.length
            },
            aggs: code
              ? { lines: { sum: { field: "properties.adoptedLineCount" } } }
              : {
                  input: { sum: { field: "totalInputTokens" } },
                  output: { sum: { field: "totalOutputTokens" } }
                }
          }
        }
      }
    )
    const aggregation = record(raw.aggregations?.projects)
    if (!Array.isArray(aggregation.buckets) || Number(aggregation.sum_other_doc_count ?? 0) > 0)
      throw new Error("项目累计遥测未完整返回")
    for (const value of aggregation.buckets) {
      const b = record(value)
      result.set(string(b.key), {
        input: number(record(b.input).value) ?? 0,
        output: number(record(b.output).value) ?? 0,
        lines: number(record(b.lines).value) ?? 0
      })
    }
  }
  return result
}
interface Context {
  snapshot: Snapshot
  items: ProjectMetricProjectItem[]
  warnings: string[]
}
async function context(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies,
  state?: Snapshot
): Promise<Context> {
  validateFilters(filters)
  await deps.validateFactFields?.()
  const s = state ?? (await snapshot(deps))
  const raw = await facts(deps, [
    ...organizationFilters(roomsFor(filters, deps)),
    {
      bool: {
        should: [periodFilter(filters), periodFilter(filters, true)],
        minimum_should_match: 1
      }
    }
  ])
  const codes = new Set<string>()
  const items = raw.map((p) => {
    const code = string(p.prjCode)
    if (!code || codes.has(code)) throw new Error("项目事实编号缺失或重复")
    codes.add(code)
    return parseFact(p, s)
  })
  const ids = strings(
    items.flatMap((p) => s.byCode.get(p.prjCode)?.map((h) => h.harnessProjectId) ?? [])
  )
  const [code, token] = await Promise.allSettled([
    cumulative(deps, ids, "code"),
    cumulative(deps, ids, "token")
  ])
  const warnings = [PROJECT_CALENDAR_NOTE]
  if (code.status === "rejected") warnings.push(`代码数据不可用：${failure(code.reason)}`)
  if (token.status === "rejected") {
    if (filters.tokenConsumptionMin != null || filters.tokenConsumptionMax != null)
      throw token.reason
    warnings.push(`Token 数据不可用：${failure(token.reason)}`)
  }
  for (const item of items) {
    if (item.developmentMode !== "devclaw") continue
    const harness = s.byCode.get(item.prjCode) ?? []
    item.pushedAdoptedLines =
      code.status === "fulfilled"
        ? harness.reduce((sum, h) => sum + (code.value.get(h.harnessProjectId)?.lines ?? 0), 0)
        : null
    item.totalInputTokens =
      token.status === "fulfilled"
        ? harness.reduce((sum, h) => sum + (token.value.get(h.harnessProjectId)?.input ?? 0), 0)
        : null
    item.totalOutputTokens =
      token.status === "fulfilled"
        ? harness.reduce((sum, h) => sum + (token.value.get(h.harnessProjectId)?.output ?? 0), 0)
        : null
    const lines = item.pushedAdoptedLines
    if (
      lines !== null &&
      lines > 0 &&
      item.totalInputTokens !== null &&
      item.totalOutputTokens !== null
    ) {
      item.inputTokensPerAdoptedLine = item.totalInputTokens / lines
      item.outputTokensPerAdoptedLine = item.totalOutputTokens / lines
      item.tokensPerAdoptedLine = (item.totalInputTokens + item.totalOutputTokens) / lines
    }
  }
  return { snapshot: s, items, warnings }
}
function summarize(ctx: Context, filters: ProjectMetricFilters): ProjectMetricSummaryData {
  return {
    groups: projectMetricGroups(ctx.items, filters),
    pluginOptions: ctx.snapshot.pluginOptions,
    truncated: false,
    warnings: ctx.warnings
  }
}
export async function fetchProjectMetricSummary(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricSummaryData> {
  return summarize(await context(filters, deps), filters)
}
function recentMonths(): Array<{ month: string; range: ProjectMetricFilters["range"] }> {
  const now = formatProjectDate(Date.now()).slice(0, 7)
  return Array.from({ length: 6 }, (_, i) => {
    const date = new Date(Date.UTC(+now.slice(0, 4), +now.slice(5, 7) - 7 + i, 1))
    const month = date.toISOString().slice(0, 7)
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    return { month, range: { from: `${month}-01`, to: `${month}-${last}` } }
  })
}
export async function fetchProjectMetricTrend(
  filters: ProjectMetricTrendFilters,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricTrendData> {
  const months = recentMonths()
  const ctx = await context(
    { ...filters, range: { from: months[0].range.from, to: months[5].range.to } },
    deps
  )
  return {
    months: months.map(({ month, range }) => ({
      month,
      groups: summarize(ctx, { ...filters, range }).groups
    })),
    truncated: false,
    warnings: ctx.warnings
  }
}
export async function fetchProjectMetricProjects(
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricProjectsData> {
  validateMetricSample(options)
  if (
    options.developmentMode === "non_devclaw" &&
    !options.metricSample &&
    (filters.adapterName ||
      filters.tokenConsumptionMin != null ||
      filters.tokenConsumptionMax != null)
  )
    throw new Error("常规项目不支持插件或Token筛选")
  if (options.pageSize !== undefined && ![20, 50, 100].includes(options.pageSize))
    throw new Error("项目页大小无效")
  if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1))
    throw new Error("项目页码无效")
  const sortKeys = [
    "deliveryDays",
    "bugNum",
    "kenanIssueCount",
    "notAdjustFuns",
    "pushedAdoptedLines",
    "tokensPerAdoptedLine"
  ] as const
  if (options.sortBy && !sortKeys.includes(options.sortBy)) throw new Error("项目排序字段无效")
  if (options.sortOrder && !["asc", "desc"].includes(options.sortOrder))
    throw new Error("项目排序方向无效")
  if (
    options.developmentMode &&
    !["all", "devclaw", "non_devclaw"].includes(options.developmentMode)
  )
    throw new Error("项目开发方式无效")
  const ctx = await context(filters, deps)
  const selected = selectProjectMetricProjects(ctx.items, filters, options)
  await fillProjectFeatureNames(selected.items, deps, ctx.warnings)
  return { ...selected, truncated: false, warnings: ctx.warnings }
}
function validateMetricSample(options: ProjectMetricListOptions): void {
  if (
    options.metricSample !== undefined &&
    !PROJECT_METRIC_SAMPLE_KEYS.includes(options.metricSample)
  )
    throw new Error("项目指标样本筛选无效")
}
function selectProjectMetricProjects(
  items: ProjectMetricProjectItem[],
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions
): Pick<ProjectMetricProjectsData, "items" | "total" | "page" | "pageSize"> {
  const keyword = string(options.keyword).toLowerCase()
  const department = string(options.departmentKeyword).toLowerCase()
  const selectedItems = items.filter(
    (p) =>
      (!filters.upperOrgLv1?.length || filters.upperOrgLv1.includes(p.roomName)) &&
      (options.metricSample
        ? projectMetricSampleReasons(p, filters)[options.metricSample] === null
        : projectInPeriod(
            filters.dateBasis === "created"
              ? p.createDate
              : p.firstStStartDate || p.firstUatStartDate,
            filters.range
          ) && inAdvancedScope(p, filters)) &&
      (!options.developmentMode ||
        options.developmentMode === "all" ||
        p.developmentMode === options.developmentMode) &&
      (!keyword || `${p.prjCode} ${p.prjName}`.toLowerCase().includes(keyword)) &&
      (!department || p.roomName.toLowerCase().includes(department))
  )
  const key = options.sortBy ?? "deliveryDays"
  selectedItems.sort((a, b) => {
    const x = a[key],
      y = b[key]
    if (x === null && y !== null) return 1
    if (x !== null && y === null) return -1
    const difference = (x ?? 0) - (y ?? 0)
    return difference
      ? difference * (options.sortOrder === "asc" ? 1 : -1)
      : a.prjCode.localeCompare(b.prjCode)
  })
  const pageSize = options.exportAll ? Math.max(1, selectedItems.length) : (options.pageSize ?? 20)
  const page = options.exportAll ? 1 : (options.page ?? 1)
  const selected = selectedItems.slice((page - 1) * pageSize, page * pageSize)
  return { items: selected, total: selectedItems.length, page, pageSize }
}

async function featureCoverage(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies,
  s: Snapshot
) {
  await deps.validateFactFields?.()
  const raw = await facts(
    deps,
    [...organizationFilters(roomsFor(filters, deps)), periodFilter(filters)],
    ["prjCode", "featureCodes"]
  )
  const candidates = new Set(raw.flatMap((p) => strings(p.featureCodes)))
  const smart = new Set<string>()
  for (const batch of chunks([...candidates])) {
    // 只返回分类结果，不泄露其他室的事实；反查不按组织、周期收窄。
    const associated = await facts(
      deps,
      [
        { range: { createDate: { gte: "2026-06-01 00:00:00" } } },
        { terms: { featureCodes: batch } }
      ],
      ["prjCode", "featureCodes"]
    )
    for (const p of associated)
      if (s.byCode.has(string(p.prjCode)))
        for (const code of strings(p.featureCodes)) if (candidates.has(code)) smart.add(code)
  }
  return {
    total: candidates.size,
    intelligent: smart.size,
    rate: candidates.size ? smart.size / candidates.size : null
  }
}
async function monthlyRecords(
  months: string[],
  deps: ProjectMetricDependencies
): Promise<RecordValue[]> {
  const raw = await query(
    deps,
    "组织月度入库数据",
    deps.monthlyIndex ?? "devclaw_gitee_push_info",
    {
      size: 1000,
      track_total_hits: true,
      query: {
        bool: {
          filter: [
            { term: { teamName: PROJECT_METRIC_TEAM } },
            { terms: { timeRange: months } },
            { terms: { orgLevel: ["team", "room"] } }
          ]
        }
      },
      _source: {
        includes: [
          "orgLevel",
          "teamName",
          "roomName",
          "timeRange",
          "totalPushedLines",
          "devagentIdePushedLines",
          "devagentCloudPushedLines",
          "devagentCliPushedLines",
          "updatedAt",
          "updatedBy"
        ]
      }
    }
  )
  const hits = raw.hits?.hits
  const total = raw.hits?.total
  const count = typeof total === "number" ? total : total?.value
  if (
    !hits ||
    count === undefined ||
    (typeof total === "object" && total.relation === "gte") ||
    count !== hits.length
  )
    throw new Error("月度组织数据未完整返回")
  return hits.map((hit) => record(hit._source))
}

/** 补齐仅出现在既有组织选项来源中的室，不把其他团队或未归类桶带入导出。 */
async function traceRooms(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies
): Promise<string[]> {
  const rooms = new Set<string>()
  const cursors = new Set<string>()
  let after: RecordValue | undefined
  for (;;) {
    const raw = await query(deps, "团队室选项", deps.traceIndex, {
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { upperOrgLv2: PROJECT_METRIC_TEAM } },
            { range: { startedAt: { gte: filters.range.from, lte: filters.range.to } } }
          ]
        }
      },
      aggs: {
        rooms: {
          composite: {
            size: PAGE_SIZE,
            sources: [{ room: { terms: { field: "upperOrgLv1" } } }],
            ...(after ? { after } : {})
          }
        }
      }
    })
    const aggregation = record(raw.aggregations?.rooms)
    if (!Array.isArray(aggregation.buckets)) throw new Error("团队室选项未完整返回")
    for (const value of aggregation.buckets) {
      const room = readOrgText(record(record(value).key).room)
      if (room) rooms.add(room)
    }
    if (!aggregation.buckets.length || !aggregation.after_key) break
    after = record(aggregation.after_key)
    const cursor = JSON.stringify(after)
    if (!string(after.room) || cursors.has(cursor)) throw new Error("团队室选项分页游标无效")
    cursors.add(cursor)
  }
  return [...rooms]
}
function monthlyOverview(
  months: string[],
  raw: RecordValue[],
  rooms: string[] | null,
  code: ProjectMetricCodeOverview | null
): ProjectMetricMonthlyCode {
  const scopes = rooms === null ? [null] : rooms
  const selected = months.flatMap((month) =>
    scopes.map((room) => {
      const records = raw.filter(
        (p) =>
          p.timeRange === month &&
          p.orgLevel === (room === null ? "team" : "room") &&
          (room === null || p.roomName === room)
      )
      if (records.length > 1) throw new Error("同组织同月存在重复填报记录")
      return records[0]
    })
  )
  const sum = (field: string): number | null =>
    selected.length && selected.every((p) => p && number(p[field]) !== null)
      ? selected.reduce((sum, p) => sum + number(p[field])!, 0)
      : null
  const total = sum("totalPushedLines")
  const dates = selected
    .map((p) => string(p?.updatedAt))
    .filter(Boolean)
    .sort()
  const sources: ProjectMetricMonthlyCode["sources"] = [
    ["devagent-ide", sum("devagentIdePushedLines")],
    ["devagent-cloud", sum("devagentCloudPushedLines")],
    ["devagent-cli", sum("devagentCliPushedLines")],
    ["devclaw", code?.pushedAdoptedLines ?? null]
  ].map(([source, lines]) => ({
    source: source as ProjectMetricMonthlyCode["sources"][number]["source"],
    pushedLines: lines as number | null,
    rate: total !== null && total > 0 && lines !== null ? Number(lines) / total : null,
    missing: total === null || lines === null
  }))
  const complete = sources.every((source) => !source.missing)
  const cumulativeLines = complete
    ? sources.reduce((sum, source) => sum + source.pushedLines!, 0)
    : null
  return {
    month: projectMonthlyPeriodLabel(months),
    totalPushedLines: total,
    updatedAt: dates[0] || null,
    cumulative: {
      pushedLines: cumulativeLines,
      rate:
        total !== null && total > 0 && cumulativeLines !== null ? cumulativeLines / total : null,
      missing: !complete
    },
    sources
  }
}

async function overview(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies,
  s: Snapshot,
  monthly?: RecordValue[]
): Promise<ProjectMetricOverviewData> {
  const rooms = roomsFor(filters, deps)
  const months = projectCompleteMonths(filters.range)
  const [features, code, records] = await Promise.allSettled([
    featureCoverage(filters, deps, s),
    deps.codeStats
      ? deps.codeStats(filters.range, rooms, strings(s.projects.map((p) => p.harnessProjectId)))
      : Promise.reject(new Error("代码查询未配置")),
    months.length
      ? monthly
        ? Promise.resolve(monthly)
        : monthlyRecords(months, deps)
      : Promise.resolve([])
  ])
  const data: ProjectMetricOverviewData = {
    features: features.status === "fulfilled" ? features.value : null,
    code: code.status === "fulfilled" ? code.value : null,
    monthly: null,
    featureError: features.status === "rejected" ? failure(features.reason) : null,
    codeError: code.status === "rejected" ? failure(code.reason) : null,
    monthlyError: records.status === "rejected" ? failure(records.reason) : null
  }
  if (months.length && records.status === "fulfilled") {
    try {
      data.monthly = monthlyOverview(months, records.value, rooms, data.code)
    } catch (error) {
      data.monthlyError = failure(error)
    }
  }
  return data
}

export async function fetchProjectMetricOverview(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricOverviewData> {
  validateFilters(filters)
  return overview(filters, deps, await snapshot(deps))
}
export async function fetchProjectMetricIndicatorExport(
  filters: ProjectMetricFilters,
  deps: ProjectMetricDependencies
): Promise<ProjectMetricIndicatorExportData> {
  if (deps.allowedRoomNames !== null) throw new Error("导出团队及各室指标需要全团队读取权限")
  if (!deps.codeEvidence) throw new Error("周期代码项目依据查询未配置")
  const teamFilters = { ...filters, upperOrgLv1: [] }
  const ctx = await context(teamFilters, deps)
  if (ctx.warnings.some((w) => w.includes("不可用")))
    throw new Error("项目累计代码或Token查询失败，请重试后导出")
  const months = projectCompleteMonths(filters.range)
  const results = await Promise.allSettled([
    months.length ? monthlyRecords(months, deps) : Promise.resolve([]),
    facts(deps, organizationFilters(null), ["prjCode", "roomName"]),
    traceRooms(filters, deps),
    deps.codeEvidence(filters.range, strings(ctx.snapshot.projects.map((p) => p.harnessProjectId)))
  ] as const)
  for (const result of results) if (result.status === "rejected") throw result.reason
  const monthly = (results[0] as PromiseFulfilledResult<RecordValue[]>).value
  const roomFacts = (results[1] as PromiseFulfilledResult<RecordValue[]>).value
  const options = (results[2] as PromiseFulfilledResult<string[]>).value
  const periodCode = (results[3] as PromiseFulfilledResult<ProjectMetricPeriodCode[]>).value
  const projects = new Map(
    ctx.items.map((project) => [
      project.prjCode,
      {
        project,
        factAvailable: true,
        eligibleBindingCount: ctx.snapshot.byCode.get(project.prjCode)?.length ?? 0
      }
    ])
  )
  const fullRelationFeatures = strings(ctx.items.flatMap((p) => p.featureCodes))
  const addReference = (raw: RecordValue): void => {
    const code = string(raw.prjCode)
    if (!code) throw new Error("项目依据缺少企业项目编号")
    if (projects.has(code)) return
    const project = parseFact(raw, ctx.snapshot)
    project.pushedAdoptedLines = null
    project.totalInputTokens = null
    project.totalOutputTokens = null
    projects.set(code, {
      project,
      factAvailable: true,
      eligibleBindingCount: ctx.snapshot.byCode.get(code)?.length ?? 0
    })
  }
  for (const batch of chunks(fullRelationFeatures)) {
    const associated = await facts(deps, [
      { range: { createDate: { gte: "2026-06-01 00:00:00" } } },
      { terms: { featureCodes: batch } }
    ])
    for (const raw of associated) addReference(raw)
  }
  const byHarness = new Map(ctx.snapshot.projects.map((p) => [p.harnessProjectId, p.prjCode]))
  const codeByProject = new Map<
    string,
    {
      roomName: string
      prjCode: string
      pushedAdoptedLines: number
      pushedEffectiveGeneratedLines: number
    }
  >()
  for (const code of periodCode) {
    const prjCode = byHarness.get(code.harnessProjectId)
    if (!prjCode) throw new Error("周期代码依据存在无有效精益关联的项目")
    if (
      ![code.pushedAdoptedLines, code.pushedEffectiveGeneratedLines].every(
        (value) => Number.isFinite(value) && value >= 0
      )
    )
      throw new Error("周期代码项目依据行数无效")
    const key = JSON.stringify([code.roomName, prjCode])
    const entry = codeByProject.get(key) ?? {
      roomName: code.roomName,
      prjCode,
      pushedAdoptedLines: 0,
      pushedEffectiveGeneratedLines: 0
    }
    entry.pushedAdoptedLines += code.pushedAdoptedLines
    entry.pushedEffectiveGeneratedLines += code.pushedEffectiveGeneratedLines
    codeByProject.set(key, entry)
  }
  const missing = strings([...codeByProject.values()].map((c) => c.prjCode)).filter(
    (code) => !projects.has(code)
  )
  for (const batch of chunks(missing)) {
    for (const raw of await facts(deps, [
      { terms: { prjCode: batch } },
      { range: { createDate: { gte: "2026-06-01 00:00:00" } } }
    ]))
      addReference(raw)
  }
  for (const code of missing)
    if (!projects.has(code))
      projects.set(code, {
        project: {
          ...parseFact({ prjCode: code }, ctx.snapshot),
          pushedAdoptedLines: null,
          totalInputTokens: null,
          totalOutputTokens: null
        },
        factAvailable: false,
        eligibleBindingCount: ctx.snapshot.byCode.get(code)?.length ?? 0
      })
  const featureRecords = new Map<string, RecordValue>()
  const featureProjects = new Map<string, string[]>()
  for (const { project } of projects.values())
    for (const featureCode of project.featureCodes) {
      const codes = featureProjects.get(featureCode) ?? []
      codes.push(project.prjCode)
      featureProjects.set(featureCode, codes)
    }
  const completeRelations = new Set(fullRelationFeatures)
  const featureCodes = strings(
    [...projects.values()].flatMap(({ project }) => project.featureCodes)
  )
  for (const batch of chunks(featureCodes)) {
    for (const raw of await facts(
      deps,
      [{ terms: { featureCode: batch } }],
      ["featureCode", "featureName", "approvedDate", "syncBatchNo", "syncedAt"],
      deps.featureIndex ?? "devclaw_feature_info",
      "featureCode"
    ))
      featureRecords.set(string(raw.featureCode), raw)
  }
  const projectList = [...projects.values()].sort((a, b) =>
    a.project.prjCode.localeCompare(b.project.prjCode)
  )
  for (const { project } of projectList)
    project.features = project.featureCodes.map((featureCode) => ({
      featureCode,
      featureName: string(featureRecords.get(featureCode)?.featureName) || null
    }))
  const evidence: ProjectMetricIndicatorExportData["evidence"] = {
    projects: projectList,
    features: featureCodes.map((featureCode) => {
      const raw = featureRecords.get(featureCode)
      return {
        featureCode,
        featureName: string(raw?.featureName) || null,
        approvedDate: string(raw?.approvedDate) || null,
        syncedAt: string(raw?.syncedAt) || null,
        syncBatchNo: string(raw?.syncBatchNo) || null,
        classificationComplete: completeRelations.has(featureCode),
        projectCodes: (featureProjects.get(featureCode) ?? []).sort()
      }
    }),
    code: [...codeByProject.values()]
      .sort((a, b) => a.roomName.localeCompare(b.roomName) || a.prjCode.localeCompare(b.prjCode))
      .map((code) => ({
        ...code,
        prjName: projects.get(code.prjCode)?.project.prjName || null,
        projectRoomName: projects.get(code.prjCode)?.project.roomName || null
      })),
    monthly: monthly.map((raw) => ({
      orgLevel: raw.orgLevel as "team" | "room",
      teamName: string(raw.teamName),
      roomName: string(raw.roomName) || null,
      month: string(raw.timeRange),
      totalPushedLines: number(raw.totalPushedLines),
      devagentIdePushedLines: number(raw.devagentIdePushedLines),
      devagentCloudPushedLines: number(raw.devagentCloudPushedLines),
      devagentCliPushedLines: number(raw.devagentCliPushedLines),
      updatedAt: string(raw.updatedAt) || null,
      updatedBy: string(raw.updatedBy) || null
    }))
  }
  const rooms = strings([
    ...options,
    ...roomFacts.map((p) => p.roomName),
    ...monthly.filter((p) => p.orgLevel === "room").map((p) => p.roomName),
    ...evidence.code.map((p) => readOrgText(p.roomName))
  ])
  const completeContext = {
    ...ctx,
    items: projectList.filter((p) => p.factAvailable).map((p) => p.project)
  }
  const forScope = (roomName: string | null): ProjectMetricIndicatorExportData["team"] => {
    const scopeFilters = { ...teamFilters, upperOrgLv1: roomName === null ? [] : [roomName] }
    const candidates = new Set(
      completeContext.items
        .filter((p) => !projectCandidateReason(p, scopeFilters))
        .flatMap((p) => p.featureCodes)
    )
    const intelligent = evidence.features.filter(
      (feature) =>
        candidates.has(feature.featureCode) &&
        feature.projectCodes.some(
          (code) => projects.get(code)?.project.developmentMode === "devclaw"
        )
    ).length
    const lines = evidence.code.filter((p) => roomName === null || p.roomName === roomName)
    const pushedAdoptedLines = lines.reduce((sum, p) => sum + p.pushedAdoptedLines, 0)
    const pushedEffectiveGeneratedLines = lines.reduce(
      (sum, p) => sum + p.pushedEffectiveGeneratedLines,
      0
    )
    const code = {
      pushedAdoptedLines,
      pushedEffectiveGeneratedLines,
      pushedAdoptionRate:
        pushedEffectiveGeneratedLines > 0
          ? pushedAdoptedLines / pushedEffectiveGeneratedLines
          : null
    }
    return {
      summary: summarize(completeContext, scopeFilters),
      overview: {
        features: {
          total: candidates.size,
          intelligent,
          rate: candidates.size ? intelligent / candidates.size : null
        },
        code,
        monthly: months.length
          ? monthlyOverview(months, monthly, roomName === null ? null : [roomName], code)
          : null,
        featureError: null,
        codeError: null,
        monthlyError: null
      }
    }
  }
  return {
    team: forScope(null),
    rooms: rooms.map((roomName) => ({ roomName, ...forScope(roomName) })),
    evidence,
    exportedAt: formatProjectDate(Date.now())
  }
}

// 保留现有接口；研发效能页面不再请求组数据。
export async function fetchProjectMetricGroupOptions(
  filters: Pick<ProjectMetricFilters, "range" | "upperOrgLv1">,
  deps: ProjectMetricDependencies
): Promise<string[]> {
  validateFilters(filters)
  if (!filters.upperOrgLv1?.length) return []
  const raw = await facts(
    deps,
    [...organizationFilters(roomsFor(filters, deps)), periodFilter(filters)],
    ["prjCode", "groupName"]
  )
  return strings(raw.map((p) => p.groupName))
}
export function makeMockProjectMetricGroupOptions(): string[] {
  return []
}
function mockItems(): ProjectMetricProjectItem[] {
  const snapshot: Snapshot = { projects: [], byCode: new Map(), pluginOptions: ["CMBDevClaw"] }
  for (const row of PROJECT_METRIC_MOCK_TELEMETRY)
    snapshot.byCode.set(row.prjCode, [
      { harnessProjectId: `mock-${row.prjCode}`, prjCode: row.prjCode, adapterName: "CMBDevClaw" }
    ])
  return PROJECT_METRIC_MOCK_PROJECTS.map((fact) => {
    const project = parseFact(fact, snapshot)
    project.features = project.featureCodes.map((featureCode) => ({
      featureCode,
      featureName: PROJECT_METRIC_MOCK_FEATURES.find(
        (feature) => feature.featureCode === featureCode
      )!.featureName
    }))
    const telemetry = PROJECT_METRIC_MOCK_TELEMETRY.find((row) => row.prjCode === project.prjCode)
    if (telemetry) {
      project.totalInputTokens = telemetry.input
      project.totalOutputTokens = telemetry.output
      project.pushedAdoptedLines = telemetry.lines
      project.inputTokensPerAdoptedLine = telemetry.input / telemetry.lines
      project.outputTokensPerAdoptedLine = telemetry.output / telemetry.lines
      project.tokensPerAdoptedLine = (telemetry.input + telemetry.output) / telemetry.lines
    }
    return project
  })
}
function mockSummary(
  items: ProjectMetricProjectItem[],
  filters: ProjectMetricFilters
): ProjectMetricSummaryData {
  return {
    groups: projectMetricGroups(items, filters),
    pluginOptions: ["CMBDevClaw"],
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
function mockCodeEvidence(
  range: ProjectMetricFilters["range"]
): ProjectMetricIndicatorExportData["evidence"]["code"] {
  return PROJECT_METRIC_MOCK_CODE.filter((event) => projectInPeriod(event.generatedAt, range)).map(
    (event) => {
      const project = PROJECT_METRIC_MOCK_PROJECTS.find((item) => item.prjCode === event.prjCode)!
      return {
        roomName: PROJECT_METRIC_MOCK_ROOMS[event.room],
        prjCode: event.prjCode,
        prjName: project.prjName,
        projectRoomName: project.roomName,
        pushedAdoptedLines: event.adopted,
        pushedEffectiveGeneratedLines: event.effective
      }
    }
  )
}
function mockOverview(
  filters: ProjectMetricFilters,
  items: ProjectMetricProjectItem[],
  codeEvidence: ProjectMetricIndicatorExportData["evidence"]["code"],
  monthlyRecords: ReturnType<typeof projectMetricMockMonthlyRecords>
): ProjectMetricOverviewData {
  const candidates = new Set(
    items
      .filter((project) => !projectCandidateReason(project, filters))
      .flatMap((project) => project.featureCodes)
  )
  const intelligent = new Set(
    items
      .filter((project) => project.developmentMode === "devclaw")
      .flatMap((project) => project.featureCodes)
  )
  const intelligentCount = [...candidates].filter((code) => intelligent.has(code)).length
  const selectedCode = codeEvidence.filter(
    (row) => !filters.upperOrgLv1?.length || filters.upperOrgLv1.includes(row.roomName)
  )
  const pushedAdoptedLines = selectedCode.reduce((sum, row) => sum + row.pushedAdoptedLines, 0)
  const pushedEffectiveGeneratedLines = selectedCode.reduce(
    (sum, row) => sum + row.pushedEffectiveGeneratedLines,
    0
  )
  const code = {
    pushedAdoptedLines,
    pushedEffectiveGeneratedLines,
    pushedAdoptionRate: pushedEffectiveGeneratedLines
      ? pushedAdoptedLines / pushedEffectiveGeneratedLines
      : null
  }
  const months = projectCompleteMonths(filters.range)
  return {
    features: {
      total: candidates.size,
      intelligent: intelligentCount,
      rate: candidates.size ? intelligentCount / candidates.size : null
    },
    code,
    monthly: months.length
      ? monthlyOverview(
          months,
          monthlyRecords,
          filters.upperOrgLv1?.length ? filters.upperOrgLv1 : null,
          code
        )
      : null,
    featureError: null,
    codeError: null,
    monthlyError: null
  }
}
export function makeMockProjectMetricSummary(
  filters: ProjectMetricFilters
): ProjectMetricSummaryData {
  return mockSummary(mockItems(), filters)
}
export function makeMockProjectMetricProjects(
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions = {}
): ProjectMetricProjectsData {
  validateMetricSample(options)
  return {
    ...selectProjectMetricProjects(mockItems(), filters, options),
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
export function makeMockProjectMetricTrend(
  filters: ProjectMetricTrendFilters
): ProjectMetricTrendData {
  const items = mockItems()
  return {
    months: recentMonths().map(({ month, range }) => ({
      month,
      groups: mockSummary(items, { ...filters, range }).groups
    })),
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
export function makeMockProjectMetricOverview(
  filters: ProjectMetricFilters
): ProjectMetricOverviewData {
  return mockOverview(
    filters,
    mockItems(),
    mockCodeEvidence(filters.range),
    projectMetricMockMonthlyRecords(projectCompleteMonths(filters.range))
  )
}
export function makeMockProjectMetricIndicatorExport(
  filters: ProjectMetricFilters
): ProjectMetricIndicatorExportData {
  const projects = mockItems()
  const code = mockCodeEvidence(filters.range)
  const records = projectMetricMockMonthlyRecords(projectCompleteMonths(filters.range))
  const forScope = (rooms: string[]) => {
    const scope = { ...filters, upperOrgLv1: rooms }
    return {
      summary: mockSummary(projects, scope),
      overview: mockOverview(scope, projects, code, records)
    }
  }
  return {
    team: forScope([]),
    rooms: PROJECT_METRIC_MOCK_ROOMS.map((roomName) => ({ roomName, ...forScope([roomName]) })),
    evidence: {
      projects: projects.map((project) => ({
        project,
        factAvailable: true,
        eligibleBindingCount: project.developmentMode === "devclaw" ? 1 : 0
      })),
      features: PROJECT_METRIC_MOCK_FEATURES.map((feature) => ({
        ...feature,
        syncedAt: "2026-11-16 16:46:28",
        syncBatchNo: "mock-20261116",
        projectCodes: projects
          .filter((project) => project.featureCodes.includes(feature.featureCode))
          .map((project) => project.prjCode),
        classificationComplete: true
      })),
      code,
      monthly: records.map((row) => ({ ...row, month: row.timeRange }))
    },
    exportedAt: formatProjectDate(Date.now())
  }
}
