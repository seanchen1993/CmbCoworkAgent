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
  type ProjectMetricCodeOverview
} from "../../shared/project-metrics"
import {
  formatProjectDate,
  projectNaturalMonth,
  projectRangeBounds,
  projectWorkingDays,
  PROJECT_CALENDAR_NOTE
} from "../../shared/project-metric-calendar"
import { fetchTestProjectIds } from "./project-mode-test-projects"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"
import { readOrgText } from "./dashboard-org-fields"
import { projectInPeriod, projectMetricGroups } from "./dashboard-project-metric-calculations"

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
  "devWorkHours"
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
  if (filters.phaseStatuses?.length && !filters.phaseStatuses.includes(item.phaseStatus))
    return false
  if (
    filters.functionPointMin != null &&
    (item.notAdjustFuns === null || item.notAdjustFuns < filters.functionPointMin)
  )
    return false
  if (
    filters.functionPointMax != null &&
    (item.notAdjustFuns === null || item.notAdjustFuns > filters.functionPointMax)
  )
    return false
  if (item.developmentMode === "non_devclaw") return true
  if (filters.adapterName && !item.plugins.includes(filters.adapterName)) return false
  const tokens =
    item.totalInputTokens !== null && item.totalOutputTokens !== null
      ? item.totalInputTokens + item.totalOutputTokens
      : null
  if (
    filters.tokenConsumptionMin != null &&
    (tokens === null || tokens < filters.tokenConsumptionMin)
  )
    return false
  if (
    filters.tokenConsumptionMax != null &&
    (tokens === null || tokens > filters.tokenConsumptionMax)
  )
    return false
  return true
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
    groups: projectMetricGroups(
      ctx.items.filter((p) => inAdvancedScope(p, filters)),
      filters
    ),
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
  if (
    options.developmentMode === "non_devclaw" &&
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
  const keyword = string(options.keyword).toLowerCase()
  const department = string(options.departmentKeyword).toLowerCase()
  const items = ctx.items.filter(
    (p) =>
      projectInPeriod(
        filters.dateBasis === "created" ? p.createDate : p.firstStStartDate || p.firstUatStartDate,
        filters.range
      ) &&
      inAdvancedScope(p, filters) &&
      (!options.developmentMode ||
        options.developmentMode === "all" ||
        p.developmentMode === options.developmentMode) &&
      (!keyword || `${p.prjCode} ${p.prjName}`.toLowerCase().includes(keyword)) &&
      (!department || p.roomName.toLowerCase().includes(department))
  )
  const key = options.sortBy ?? "deliveryDays"
  items.sort((a, b) => {
    const x = a[key],
      y = b[key]
    if (x === null && y !== null) return 1
    if (x !== null && y === null) return -1
    const difference = (x ?? 0) - (y ?? 0)
    return difference
      ? difference * (options.sortOrder === "asc" ? 1 : -1)
      : a.prjCode.localeCompare(b.prjCode)
  })
  const pageSize = options.exportAll ? Math.max(1, items.length) : (options.pageSize ?? 20)
  const page = options.exportAll ? 1 : (options.page ?? 1)
  const selected = items.slice((page - 1) * pageSize, page * pageSize)
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
      ctx.warnings.push(`特性名称暂不可用：${failure(error)}`)
    }
  }
  return {
    items: selected,
    total: items.length,
    page,
    pageSize,
    truncated: false,
    warnings: ctx.warnings
  }
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
  month: string,
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
            { term: { timeRange: month } },
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
          "updatedAt"
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
  month: string,
  raw: RecordValue[],
  rooms: string[] | null,
  code: ProjectMetricCodeOverview | null
): ProjectMetricMonthlyCode {
  const scopes = rooms === null ? [null] : rooms
  const selected = scopes.map((room) => {
    const records = raw.filter(
      (p) =>
        p.orgLevel === (room === null ? "team" : "room") && (room === null || p.roomName === room)
    )
    if (records.length > 1) throw new Error("同组织同月存在重复填报记录")
    return records[0]
  })
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
    month,
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
  const month = projectNaturalMonth(filters.range)
  const [features, code, records] = await Promise.allSettled([
    featureCoverage(filters, deps, s),
    deps.codeStats
      ? deps.codeStats(filters.range, rooms, strings(s.projects.map((p) => p.harnessProjectId)))
      : Promise.reject(new Error("代码查询未配置")),
    month ? (monthly ? Promise.resolve(monthly) : monthlyRecords(month, deps)) : Promise.resolve([])
  ])
  const data: ProjectMetricOverviewData = {
    features: features.status === "fulfilled" ? features.value : null,
    code: code.status === "fulfilled" ? code.value : null,
    monthly: null,
    featureError: features.status === "rejected" ? failure(features.reason) : null,
    codeError: code.status === "rejected" ? failure(code.reason) : null,
    monthlyError: records.status === "rejected" ? failure(records.reason) : null
  }
  if (month && records.status === "fulfilled") {
    try {
      data.monthly = monthlyOverview(month, records.value, rooms, data.code)
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
  const teamFilters = { ...filters, upperOrgLv1: [] }
  const ctx = await context(teamFilters, deps)
  const month = projectNaturalMonth(filters.range)
  const monthly = month ? await monthlyRecords(month, deps) : []
  const [roomFacts, options] = await Promise.all([
    facts(deps, organizationFilters(null), ["prjCode", "roomName"]),
    traceRooms(filters, deps)
  ])
  const rooms = strings([
    ...options,
    ...roomFacts.map((p) => p.roomName),
    ...monthly.filter((p) => p.orgLevel === "room").map((p) => p.roomName)
  ])
  const teamOverview = await overview(teamFilters, deps, ctx.snapshot, monthly)
  const check = (o: ProjectMetricOverviewData): void => {
    if (o.featureError || o.codeError || o.monthlyError)
      throw new Error(o.featureError || o.codeError || o.monthlyError || "导出数据查询失败")
  }
  check(teamOverview)
  // 有限、顺序查询每个室，分类及累计遥测已在团队上下文中一次取齐。
  const results: ProjectMetricIndicatorExportData["rooms"] = []
  for (const roomName of rooms) {
    const roomFilters = { ...filters, upperOrgLv1: [roomName] }
    const o = await overview(roomFilters, deps, ctx.snapshot, monthly)
    check(o)
    results.push({
      roomName,
      summary: summarize(
        { ...ctx, items: ctx.items.filter((p) => p.roomName === roomName) },
        roomFilters
      ),
      overview: o
    })
  }
  if (ctx.warnings.some((w) => w.includes("不可用")))
    throw new Error("项目累计代码或Token查询失败，请重试后导出")
  return {
    team: { summary: summarize(ctx, teamFilters), overview: teamOverview },
    rooms: results,
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
  const s: Snapshot = { projects: [], byCode: new Map(), pluginOptions: ["CMBDevClaw"] }
  s.byCode.set("T26MCB21", [
    { harnessProjectId: "mock-harness", prjCode: "T26MCB21", adapterName: "CMBDevClaw" }
  ])
  return [
    parseFact(
      {
        prjCode: "T26MCB21",
        prjName: "项目度量示例",
        teamName: PROJECT_METRIC_TEAM,
        roomName: "零售信息应用开发二室(杭州)",
        featureCodes: ["BU135598-F16114", "BU135598-F16127", "BU135598-F16128", "BU135598-F16198"],
        devWorkHours: 217,
        notAdjustFuns: 214.72,
        approvedDate: "2026-10-09 17:29:27",
        createDate: "2026-10-12 00:00:00",
        firstStStartDate: "2026-10-19 09:15:47",
        firstUatStartDate: "2026-10-14 11:33:19",
        firstOnlineDate: "2026-10-14 00:00:00",
        bugNum: 2,
        kenanIssueCount: 0
      },
      s
    )
  ]
}
export function makeMockProjectMetricSummary(
  filters: ProjectMetricFilters
): ProjectMetricSummaryData {
  const items = mockItems().filter(
    (p) => !filters.upperOrgLv1?.length || filters.upperOrgLv1.includes(p.roomName)
  )
  return {
    groups: projectMetricGroups(
      items.filter((p) => inAdvancedScope(p, filters)),
      filters
    ),
    pluginOptions: ["CMBDevClaw"],
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
export function makeMockProjectMetricProjects(
  filters: ProjectMetricFilters,
  options: ProjectMetricListOptions = {}
): ProjectMetricProjectsData {
  const items = mockItems().filter(
    (p) =>
      (!filters.upperOrgLv1?.length || filters.upperOrgLv1.includes(p.roomName)) &&
      projectInPeriod(
        filters.dateBasis === "created" ? p.createDate : p.firstStStartDate || p.firstUatStartDate,
        filters.range
      ) &&
      inAdvancedScope(p, filters) &&
      (!options.developmentMode ||
        options.developmentMode === "all" ||
        p.developmentMode === options.developmentMode)
  )
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: options.pageSize ?? 20,
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
export function makeMockProjectMetricTrend(
  filters: ProjectMetricTrendFilters
): ProjectMetricTrendData {
  return {
    months: recentMonths().map(({ month, range }) => ({
      month,
      groups: makeMockProjectMetricSummary({ ...filters, range }).groups
    })),
    truncated: false,
    warnings: [PROJECT_CALENDAR_NOTE]
  }
}
export function makeMockProjectMetricOverview(
  filters: ProjectMetricFilters
): ProjectMetricOverviewData {
  const items = makeMockProjectMetricProjects(filters).items
  const codes = new Set(items.flatMap((p) => p.featureCodes))
  const code = {
    pushedAdoptedLines: 1800,
    pushedEffectiveGeneratedLines: 2400,
    pushedAdoptionRate: 0.75
  }
  const month = projectNaturalMonth(filters.range)
  const row = {
    orgLevel: "team",
    teamName: PROJECT_METRIC_TEAM,
    totalPushedLines: 1055649,
    devagentIdePushedLines: 211403,
    devagentCloudPushedLines: 5497,
    devagentCliPushedLines: 6256,
    updatedAt: "2026-11-16 15:54:05"
  }
  return {
    features: { total: codes.size, intelligent: codes.size, rate: codes.size ? 1 : null },
    code,
    monthly: month ? monthlyOverview(month, [row], null, code) : null,
    featureError: null,
    codeError: null,
    monthlyError: null
  }
}
export function makeMockProjectMetricIndicatorExport(
  filters: ProjectMetricFilters
): ProjectMetricIndicatorExportData {
  const team = {
    summary: makeMockProjectMetricSummary({ ...filters, upperOrgLv1: [] }),
    overview: makeMockProjectMetricOverview({ ...filters, upperOrgLv1: [] })
  }
  return {
    team,
    rooms: [{ roomName: "零售信息应用开发二室(杭州)", ...team }],
    exportedAt: formatProjectDate(Date.now())
  }
}
