import { PROJECT_METRIC_TEAM, type ProjectMetricProjectItem } from "../../shared/project-metrics"
import type {
  PersonalEfficiencyCodeRow,
  PersonalEfficiencyData,
  PersonalEfficiencyFilters,
  PersonalEfficiencyPerson
} from "../../shared/personal-efficiency"
import { emptyPersonalEfficiencyValues } from "../../shared/personal-efficiency"
import {
  projectCompleteMonths,
  projectMonthlyPeriodLabel
} from "../../shared/project-metric-calendar"
import {
  fetchPersonalEfficiencyProjectContext,
  makeMockProjectMetricProjects,
  type ProjectMetricDependencies
} from "./dashboard-project-metrics"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"
import { normalizeCodeStatsFromContainer } from "./dashboard-code-stats"

type Row = Record<string, unknown>
const record = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {}
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const count = (v: unknown): number | null => {
  if (
    v === null ||
    v === undefined ||
    typeof v === "boolean" ||
    (typeof v === "string" && !v.trim())
  )
    return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 人员和月度数据均完整分页；不能用 terms 的前 N 人作为排名全集。 */
async function composite(
  deps: Pick<ProjectMetricDependencies, "query">,
  index: string,
  filters: Row[],
  sources: Row[],
  aggs: Row
): Promise<Row[]> {
  const result: Row[] = []
  const cursors = new Set<string>()
  let after: Row | undefined
  for (;;) {
    const body = {
      size: 0,
      query: { bool: { filter: filters } },
      aggs: {
        people: {
          composite: { size: 500, sources, ...(after ? { after } : {}) },
          aggs
        }
      }
    }
    console.log(
      `[Dashboard][PersonalEfficiency][ES]\nindex: ${index}\ndsl: ${JSON.stringify(body)}`
    )
    const raw = await deps.query(index, body)
    assertProjectModeResultComplete(raw)
    const page = record(record(record(raw).aggregations).people)
    if (!Array.isArray(page.buckets)) throw new Error("个人指标数据未完整返回")
    result.push(...page.buckets.map(record))
    if (!page.buckets.length || !page.after_key) return result
    after = record(page.after_key)
    const cursor = JSON.stringify(after)
    if (!Object.keys(after).length || cursors.has(cursor)) throw new Error("个人指标分页游标无效")
    cursors.add(cursor)
  }
}

function source(bucket: Row): Row {
  const hits = record(record(bucket.latest).hits).hits
  return record(record(Array.isArray(hits) ? hits[0] : undefined)._source)
}

export async function fetchPersonalEfficiencyCode(
  query: ProjectMetricDependencies["query"],
  eventIndex: string,
  filters: Row[],
  perBucketAggs: Row
): Promise<PersonalEfficiencyCodeRow[]> {
  const buckets = await composite(
    { query },
    eventIndex,
    filters,
    [
      { sapId: { terms: { field: "sapId" } } },
      { project: { terms: { field: "properties.harnessProjectId" } } },
      { room: { terms: { field: "upperOrgLv1", missing_bucket: true } } }
    ],
    {
      ...perBucketAggs,
      latest: {
        top_hits: { size: 1, sort: [{ eventTime: "desc" }], _source: { includes: ["userName"] } }
      }
    }
  )
  return buckets.map((bucket) => {
    const key = record(bucket.key)
    if (!text(key.sapId) || !text(key.project) || !bucket.code_adopt_pushed)
      throw new Error("个人代码统计缺少人员、项目或采纳数据")
    const stats = normalizeCodeStatsFromContainer(bucket)
    return {
      sapId: text(key.sapId),
      userName: text(source(bucket).userName),
      harnessProjectId: text(key.project),
      prjCode: "",
      roomName: text(key.room),
      pushedAdoptedLines: stats.pushedAdoptedLines,
      pushedEffectiveGeneratedLines: stats.pushedEffectiveGeneratedLines
    }
  })
}

async function monthlyRecords(
  filters: PersonalEfficiencyFilters,
  deps: ProjectMetricDependencies
): Promise<Row[]> {
  const months = projectCompleteMonths(filters.range)
  if (!months.length) return []
  const rooms = selectedRooms(filters, deps)
  const buckets = await composite(
    deps,
    deps.monthlyIndex ?? "devclaw_gitee_push_info",
    [
      { term: { orgLevel: "user" } },
      { term: { teamName: PROJECT_METRIC_TEAM } },
      { terms: { timeRange: months } },
      ...(rooms === null
        ? []
        : [rooms.length ? { terms: { roomName: rooms } } : { match_none: {} }])
    ],
    [{ sapId: { terms: { field: "sapId" } } }, { month: { terms: { field: "timeRange" } } }],
    {
      latest: {
        top_hits: {
          size: 1,
          _source: {
            includes: [
              "sapId",
              "timeRange",
              "devagentIdePushedLines",
              "devagentCliPushedLines",
              "totalPushedLines"
            ]
          }
        }
      }
    }
  )
  if (buckets.some((bucket) => bucket.doc_count !== 1))
    throw new Error("同一人员同月存在重复入库记录")
  return aggregatePersonalMonthlyRecords(months, buckets.map(source))
}

/** 每个渠道独立检查所有月份；缺少任一月份或该渠道字段时，累计值不可用。 */
export function aggregatePersonalMonthlyRecords(months: string[], records: Row[]): Row[] {
  const expected = new Set(months)
  const byPerson = new Map<string, Map<string, Row>>()
  for (const row of records) {
    const sapId = text(row.sapId)
    const month = text(row.timeRange)
    if (!sapId || !expected.has(month)) throw new Error("个人月度记录人员或月份无效")
    const person = byPerson.get(sapId) ?? new Map<string, Row>()
    if (person.has(month)) throw new Error("同一人员同月存在重复入库记录")
    person.set(month, row)
    byPerson.set(sapId, person)
  }
  return [...byPerson].map(([sapId, person]) => {
    const sum = (field: string): number | null =>
      months.length && months.every((month) => count(person.get(month)?.[field]) !== null)
        ? months.reduce((total, month) => total + count(person.get(month)?.[field])!, 0)
        : null
    return {
      sapId,
      devagentIdePushedLines: sum("devagentIdePushedLines"),
      devagentCliPushedLines: sum("devagentCliPushedLines"),
      totalPushedLines: sum("totalPushedLines")
    }
  })
}

function selectedRooms(
  filters: PersonalEfficiencyFilters,
  deps: ProjectMetricDependencies
): string[] | null {
  const requested = filters.upperOrgLv1 ?? []
  return deps.allowedRoomNames === null
    ? requested.length
      ? requested
      : null
    : requested.length
      ? requested.filter((room) => deps.allowedRoomNames!.includes(room))
      : deps.allowedRoomNames
}

/** 项目字段按完整项目累计；只有特性数在个人范围内按编号去重。 */
export function assemblePersonalEfficiency(
  projects: ProjectMetricProjectItem[],
  code: PersonalEfficiencyCodeRow[] | null,
  monthly: Row[],
  month: string | null
): { people: PersonalEfficiencyPerson[]; missingPmCount: number } {
  const people = new Map<string, PersonalEfficiencyPerson>()
  const ensure = (sapId: string, userName: string): PersonalEfficiencyPerson => {
    let person = people.get(sapId)
    if (!person) {
      person = {
        sapId,
        userName: userName || sapId,
        rooms: [],
        values: emptyPersonalEfficiencyValues(),
        projectCount: 0,
        durationProjectCount: 0,
        densityBugCount: 0,
        densityFunctionPoints: 0,
        pushedAdoptedLines: code === null ? null : 0,
        pushedEffectiveGeneratedLines: code === null ? null : 0,
        projects: [],
        code: []
      }
      people.set(sapId, person)
    }
    return person
  }
  let missingPmCount = 0
  for (const project of projects) {
    const match = /^(.*?)\/([^/]+)$/.exec(project.pm?.trim() ?? "")
    if (!match || !match[1].trim() || !match[2].trim()) {
      missingPmCount++
      continue
    }
    const person = ensure(match[2].trim(), match[1].trim())
    person.projects.push(project)
    person.rooms.push(project.roomName)
  }
  for (const row of code ?? []) {
    const person = ensure(row.sapId, row.userName)
    person.code.push(row)
    person.rooms.push(row.roomName)
    person.pushedAdoptedLines! += row.pushedAdoptedLines
    person.pushedEffectiveGeneratedLines! += row.pushedEffectiveGeneratedLines
  }
  const monthByPerson = new Map<string, Row>()
  for (const row of monthly) {
    const sapId = text(row.sapId)
    if (!sapId || monthByPerson.has(sapId)) throw new Error("个人月度记录人员缺失或重复")
    monthByPerson.set(sapId, row)
  }
  for (const person of people.values()) {
    person.rooms = [...new Set(person.rooms.filter(Boolean))].sort()
    const p = person.projects
    const v = person.values
    person.projectCount = p.length
    if (p.length) {
      v.featureCount = new Set(p.flatMap((project) => project.featureCodes)).size
      const sum = (key: "notAdjustFuns" | "bugNum" | "kenanIssueCount"): number | null =>
        p.every((project) => project[key] !== null)
          ? p.reduce((n, project) => n + project[key]!, 0)
          : null
      v.functionPoints = sum("notAdjustFuns")
      v.bugCount = sum("bugNum")
      v.issueCount = sum("kenanIssueCount")
      const valid = p.filter((project) => project.approvalDevelopmentDays !== null)
      person.durationProjectCount = valid.length
      v.approvalDevelopmentDays = valid.length
        ? valid.reduce((n, project) => n + project.approvalDevelopmentDays!, 0) / valid.length
        : null
      const density = p.filter(
        (project) =>
          project.bugNum !== null && project.notAdjustFuns !== null && project.notAdjustFuns > 0
      )
      person.densityBugCount = density.reduce((n, project) => n + project.bugNum!, 0)
      person.densityFunctionPoints = density.reduce((n, project) => n + project.notAdjustFuns!, 0)
      v.defectDensity =
        person.densityFunctionPoints > 0
          ? (person.densityBugCount * 100) / person.densityFunctionPoints
          : null
    }
    v.adoptionRate =
      person.pushedEffectiveGeneratedLines !== null && person.pushedEffectiveGeneratedLines > 0
        ? (person.pushedAdoptedLines! * 100) / person.pushedEffectiveGeneratedLines
        : null
    if (month) {
      const row = monthByPerson.get(person.sapId)
      v.idePushedLines = count(row?.devagentIdePushedLines)
      v.cliPushedLines = count(row?.devagentCliPushedLines)
      v.totalPushedLines = count(row?.totalPushedLines)
      v.devclawPushedLines = person.pushedAdoptedLines
      v.aiPushedLines =
        v.idePushedLines !== null && v.cliPushedLines !== null && v.devclawPushedLines !== null
          ? v.idePushedLines + v.cliPushedLines + v.devclawPushedLines
          : null
      const rate = (lines: number | null): number | null =>
        v.totalPushedLines !== null && v.totalPushedLines > 0 && lines !== null
          ? (lines * 100) / v.totalPushedLines
          : null
      v.aiPushRate = rate(v.aiPushedLines)
      v.idePushRate = rate(v.idePushedLines)
      v.cliPushRate = rate(v.cliPushedLines)
      v.devclawPushRate = rate(v.devclawPushedLines)
    }
  }
  return {
    people: [...people.values()].sort((a, b) => a.sapId.localeCompare(b.sapId)),
    missingPmCount
  }
}

export async function fetchPersonalEfficiency(
  filters: PersonalEfficiencyFilters,
  deps: ProjectMetricDependencies,
  codeQuery: (ids: string[], rooms: string[] | null) => Promise<PersonalEfficiencyCodeRow[]>,
  detailSapId?: string,
  includeAllProjectNames = false
): Promise<PersonalEfficiencyData> {
  const context = await fetchPersonalEfficiencyProjectContext(
    filters,
    deps,
    detailSapId,
    includeAllProjectNames
  )
  const rooms = selectedRooms(filters, deps)
  const [codes, monthly] = await Promise.allSettled([
    codeQuery([...new Set(context.bindings.map((p) => p.harnessProjectId))], rooms),
    detailSapId ? Promise.resolve([]) : monthlyRecords(filters, deps)
  ])
  const warnings = [...context.warnings]
  if (codes.status === "rejected") warnings.push(`个人代码数据不可用：${errorText(codes.reason)}`)
  if (monthly.status === "rejected")
    warnings.push(`个人月度数据不可用：${errorText(monthly.reason)}`)
  const bindings = new Map(context.bindings.map((p) => [p.harnessProjectId, p.prjCode]))
  const month = projectMonthlyPeriodLabel(projectCompleteMonths(filters.range)) || null
  const result = assemblePersonalEfficiency(
    context.projects,
    codes.status === "fulfilled"
      ? codes.value.map((row) => ({
          ...row,
          prjCode: bindings.get(row.harnessProjectId) ?? row.harnessProjectId
        }))
      : null,
    monthly.status === "fulfilled" ? monthly.value : [],
    month
  )
  if (result.missingPmCount)
    warnings.push(`${result.missingPmCount} 个项目的 PM 姓名或 sapId 缺失，未计入个人项目指标`)
  return { people: result.people, month, warnings }
}

/** 沿用研发效能开发环境样例，不写入任何事实数据。 */
export function makeMockPersonalEfficiency(
  filters: PersonalEfficiencyFilters
): PersonalEfficiencyData {
  const projects = makeMockProjectMetricProjects(filters, { exportAll: true }).items.map(
    (project, index) => ({
      ...project,
      pm: `${index % 2 ? "李四" : "张三"}/${index % 2 ? "80000002" : "80000001"}`
    })
  )
  const code = projects.map((project, index) => ({
    sapId: index % 2 ? "80000002" : "80000001",
    userName: index % 2 ? "李四" : "张三",
    harnessProjectId: `h-${project.prjCode}`,
    prjCode: project.prjCode,
    roomName: project.roomName,
    pushedAdoptedLines: 120 + index * 30,
    pushedEffectiveGeneratedLines: 200 + index * 50
  }))
  const months = projectCompleteMonths(filters.range)
  const month = projectMonthlyPeriodLabel(months) || null
  const monthly = aggregatePersonalMonthlyRecords(
    months,
    months.flatMap((timeRange) =>
      ["80000001", "80000002"].map((sapId) => ({
        sapId,
        timeRange,
        devagentIdePushedLines: 1000,
        devagentCliPushedLines: 300,
        totalPushedLines: 5000
      }))
    )
  )
  return {
    people: assemblePersonalEfficiency(projects, code, monthly, month).people,
    month,
    warnings: []
  }
}
