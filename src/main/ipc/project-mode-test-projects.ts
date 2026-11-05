import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Query = (index: string, body: Record<string, unknown>) => Promise<unknown>
type Filter = Record<string, unknown>
export const TEST_PROJECT_PAGE_SIZE = 500
const TERMS_BATCH_SIZE = 10_000

interface Scope {
  eventIndex: string
  traceIndex: string
  projectIds: string[]
  cacheKey: string
}

const context = new AsyncLocalStorage<Scope>()

/** Explicit entry points only; platform/knowledge/efficiency queries keep actual usage. */
export function excludesTestProjects(channel: string, args: readonly unknown[]): boolean {
  if (
    channel.startsWith("dashboard:projectMode") ||
    channel === "dashboard:projectCodeTrace" ||
    channel === "dashboard:pluginAggregate"
  ) {
    return true
  }
  const optionIndex: Record<string, number> = {
    "dashboard:userDetail": 2,
    "dashboard:uncommittedRanking": 1,
    "dashboard:uncommittedDetail": 2,
    "dashboard:nonGitAdoptionReports": 1,
    "dashboard:threadTraces": 1,
    "dashboard:exportUserTraces": 0,
    "dashboard:skillDetail": 2,
    "dashboard:exportSkillTraces": 0
  }
  const index = optionIndex[channel]
  if (index === undefined) return false
  const options = args[index] as { projectMode?: boolean; scope?: string } | undefined
  return options?.projectMode === true || options?.scope === "project"
}

/** Narrow the ID lookup too, when a detail/room scope is known at the entry point. */
export function testProjectLookupScope(
  channel: string,
  args: readonly unknown[]
): { projectId?: string; upperOrgLv1?: string | string[] } {
  const scope: { projectId?: string; upperOrgLv1?: string | string[] } = {}
  const singleProjectChannels = new Set([
    "dashboard:projectModeTraces",
    "dashboard:projectModeFeatureNodes",
    "dashboard:projectModeStageAnalysis",
    "dashboard:projectModeFeatureCommits",
    "dashboard:projectModeProjectCommits"
  ])
  if (singleProjectChannels.has(channel) && typeof args[0] === "string") {
    scope.projectId = args[0].trim() || undefined
  }
  for (const arg of args) {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue
    const value = arg as Record<string, unknown>
    if (typeof value.projectId === "string" && value.projectId.trim()) {
      scope.projectId = value.projectId.trim()
    }
    // orgLv1List is the global filter; upperOrgLv1 may additionally be a free-text
    // department search in uncommitted/non-Git dialogs, so prefer the exact list.
    const departmentSearch =
      channel === "dashboard:nonGitAdoptionReports" ||
      channel === "dashboard:projectModeFeatureCommits" ||
      channel === "dashboard:projectModeProjectCommits"
    const rooms = value.orgLv1List ?? (departmentSearch ? undefined : value.upperOrgLv1)
    if (typeof rooms === "string") scope.upperOrgLv1 = rooms
    else if (Array.isArray(rooms) && rooms.every((room) => typeof room === "string")) {
      scope.upperOrgLv1 = rooms
    }
  }
  return scope
}

/** No time/Lean/new-project filter: a current test flag also excludes historical telemetry. */
export async function fetchTestProjectIds(
  eventIndex: string,
  accessFilters: Filter[],
  query: Query
): Promise<string[]> {
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let after: { projectId: string } | undefined
  for (;;) {
    const raw = (await query(eventIndex, {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            { term: { eventName: "harness.project.snapshot" } },
            { term: { "properties.isTestProject": true } },
            ...accessFilters
          ]
        }
      },
      aggs: {
        projects: {
          composite: {
            size: TEST_PROJECT_PAGE_SIZE,
            sources: [{ projectId: { terms: { field: "properties.projectId" } } }],
            ...(after ? { after } : {})
          }
        }
      }
    })) as {
      aggregations?: {
        projects?: {
          buckets?: { key?: { projectId?: string } }[]
          after_key?: { projectId?: string }
        }
      }
    }
    assertProjectModeResultComplete(raw)
    const page = raw.aggregations?.projects
    if (!Array.isArray(page?.buckets)) throw new Error("测试项目范围未完整返回，请重试")
    for (const bucket of page.buckets) {
      const id = bucket.key?.projectId
      if (typeof id !== "string" || !id) throw new Error("测试项目范围包含无效项目 ID")
      ids.add(id)
    }
    if (page.buckets.length === 0 || !page.after_key) break
    const cursor = page.after_key.projectId
    if (Object.keys(page.after_key).length !== 1 || typeof cursor !== "string" || !cursor) {
      throw new Error("测试项目分页游标无效，请重试")
    }
    if (cursors.has(cursor)) throw new Error("测试项目分页游标重复，请重试")
    cursors.add(cursor)
    after = { projectId: cursor }
  }
  return [...ids].sort()
}

/** One small, paginated ID lookup per IPC request, reused by every batch/drilldown query. */
export async function withProjectModeTestExclusion<T>(
  options: { eventIndex: string; traceIndex: string; accessFilters: Filter[]; query: Query },
  operation: () => Promise<T>
): Promise<T> {
  const projectIds = await fetchTestProjectIds(
    options.eventIndex,
    options.accessFilters,
    options.query
  )
  const cacheKey = createHash("sha256").update(JSON.stringify(projectIds)).digest("hex")
  return context.run(
    { eventIndex: options.eventIndex, traceIndex: options.traceIndex, projectIds, cacheKey },
    operation
  )
}

/** Include current flags in page/ranking cache keys, including when a flag is reversed. */
export function projectModeTestScopeCacheKey(): string {
  return context.getStore()?.cacheKey ?? ""
}

/** Applied before aggregations; legacy documents with no flag/snapshot remain included. */
export function excludeTestProjectsFromQuery(
  index: string,
  body: Record<string, unknown>
): Record<string, unknown> {
  const scope = context.getStore()
  if (!scope || (index !== scope.eventIndex && index !== scope.traceIndex)) return body
  const fields =
    index === scope.traceIndex
      ? ["harnessProjectId"]
      : ["properties.harnessProjectId", "properties.projectId"]
  const mustNot: Filter[] =
    index === scope.eventIndex ? [{ term: { "properties.isTestProject": true } }] : []
  for (let start = 0; start < scope.projectIds.length; start += TERMS_BATCH_SIZE) {
    const ids = scope.projectIds.slice(start, start + TERMS_BATCH_SIZE)
    for (const field of fields) mustNot.push({ terms: { [field]: ids } })
  }
  if (mustNot.length === 0) return body
  return {
    ...body,
    query: { bool: { filter: body.query ? [body.query] : [], must_not: mustNot } }
  }
}
