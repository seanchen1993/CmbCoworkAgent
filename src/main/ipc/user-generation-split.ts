import {
  CHAT_PROJECT_EVENT,
  readChatProject,
  type UserGenerationSplit
} from "../../shared/chat-project"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Query = (body: Record<string, unknown>) => Promise<unknown>
type Bucket = {
  key: { id: string | null }
  lines: { value: number }
  harness: { lines: { value: number }; doc_count: number }
  visible: { lines: { value: number } }
}
type Page = { aggregations: { sessions: { buckets: Bucket[]; after_key?: { id: string | null } } } }
type Binding = { generationMode?: string; projectCode?: string; projectFromLean?: boolean }
const pageSize = 256
const lines = { sum: { field: "properties.lineCount" } }
const hasHarness = { exists: { field: "properties.harnessProjectId" } }

async function currentBindings(query: Query, sapId: string, ids: string[]) {
  const bindings = new Map<string, Binding>()
  if (!ids.length) return bindings
  const raw = await query({
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { term: { sapId } },
          { term: { eventName: CHAT_PROJECT_EVENT } },
          { terms: { "properties.rootThreadId": ids } }
        ]
      }
    },
    aggs: {
      sessions: {
        terms: { field: "properties.rootThreadId", size: ids.length },
        aggs: {
          latest: {
            top_hits: {
              size: 1,
              sort: [{ eventTime: "desc" }],
              _source: [
                "properties.generationMode",
                "properties.projectCode",
                "properties.projectFromLean"
              ]
            }
          }
        }
      }
    }
  })
  assertProjectModeResultComplete(raw)
  type Hit = {
    key: string
    latest: { hits: { hits: Array<{ _source: { properties: Binding } }> } }
  }
  const buckets = (raw as { aggregations: { sessions: { buckets: Hit[] } } }).aggregations.sessions
    .buckets
  for (const b of buckets) bindings.set(b.key, b.latest.hits.hits[0]._source.properties)
  return bindings
}

/** Only scan a single user's generation buckets for the selected period. Join at most
 * one page of root IDs at a time, including bindings edited after that period. */
export async function fetchUserGenerationSplit(
  query: Query,
  sapId: string,
  range: { from: string; to: string },
  detailAccess: Record<string, unknown> | null
): Promise<UserGenerationSplit> {
  const result: UserGenerationSplit = { project: 0, unbound: 0, unknown: 0, projects: [] }
  const groups = new Map<string, UserGenerationSplit["projects"][number]>()
  function add(code: string, fromLean: boolean, count: number) {
    if (!count) return
    const key = JSON.stringify([fromLean, code])
    const group = groups.get(key) ?? { code, fromLean, lines: 0 }
    group.lines += count
    groups.set(key, group)
  }
  async function scan(field: "rootThreadId" | "threadId") {
    let after: { id: string | null } | undefined
    let needsFallback = false
    do {
      const filters = [
        { term: { sapId } },
        { term: { eventName: "code_gen" } },
        { range: { eventTime: { gte: range.from, lte: range.to } } }
      ]
      const raw = await query({
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: filters,
            ...(field === "threadId"
              ? { must_not: [{ exists: { field: "properties.rootThreadId" } }] }
              : {})
          }
        },
        aggs: {
          sessions: {
            composite: {
              size: pageSize,
              ...(after ? { after } : {}),
              sources: [{ id: { terms: { field: "properties." + field, missing_bucket: true } } }]
            },
            aggs: {
              lines,
              harness: { filter: hasHarness, aggs: { lines } },
              visible: {
                filter: {
                  bool: { filter: detailAccess ? [detailAccess] : [], must_not: [hasHarness] }
                },
                aggs: { lines }
              }
            }
          }
        }
      })
      assertProjectModeResultComplete(raw)
      const page = (raw as Page).aggregations.sessions
      const ids = page.buckets
        .filter((b) => b.key.id && !b.harness.doc_count && b.lines.value > 0)
        .map((b) => b.key.id!)
      const bindings = await currentBindings(query, sapId, ids)
      for (const b of page.buckets) {
        const id = b.key.id
        if (id === null && field === "rootThreadId") {
          needsFallback = b.lines.value > 0 || needsFallback
          continue
        }
        const count = b.lines.value
        // A known Harness root is project mode even when a child event lacks the field.
        if (id && b.harness.doc_count) {
          result.project += count
          continue
        }
        result.project += b.harness.lines.value
        const rest = count - b.harness.lines.value
        const binding = id ? bindings.get(id) : undefined
        if (binding?.generationMode === "project") result.project += rest
        else if (binding?.generationMode !== "chat") result.unknown += rest
        else if (!binding.projectCode) result.unbound += rest
        else {
          const project = readChatProject({
            code: binding.projectCode,
            fromLean: binding.projectFromLean
          })
          if (!project) {
            result.unknown += rest
            continue
          }
          add(project.code, project.fromLean, b.visible.lines.value)
          add("", project.fromLean, rest - b.visible.lines.value)
        }
      }
      if (!page.buckets.length || !page.after_key || page.buckets.length < pageSize) break
      if (after && page.after_key.id === after.id) throw new Error("生成行数分页未推进")
      after = page.after_key
    } while (after)
    return needsFallback
  }
  if (await scan("rootThreadId")) await scan("threadId")
  result.projects = [...groups.values()].sort(
    (a, b) => b.lines - a.lines || a.code.localeCompare(b.code)
  )
  return result
}
