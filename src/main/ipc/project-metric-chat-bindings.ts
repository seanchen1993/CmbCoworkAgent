import { CHAT_PROJECT_EVENT } from "../../shared/chat-project"
import { SharedDashboardCache } from "./project-metric-fact-cache"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Row = Record<string, unknown>
type Query = (index: string, body: Row) => Promise<unknown>
export type ChatRoot = { sapId: string; rootThreadId: string }
export type ProjectMetricChatBinding = ChatRoot & { prjCode: string }

const PAGE_SIZE = 500
const CACHE_TTL_MS = 5 * 60 * 1000
const TERMS_BATCH_SIZE = 1000
/**
 * Each should branch in `projectMetricChatRootFilter` contributes 3 Lucene clauses
 * (1 inner bool + 1 term + 1 terms). Bounding batches to 200 branches keeps every
 * ES query <= 600 clauses, safely under ES's default `max_clause_count` of 1024.
 */
export const CHAT_ROOT_MAX_SHOULD_CLAUSES = 200

const cache = new WeakMap<Query, SharedDashboardCache<ProjectMetricChatBinding[]>>()

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {}
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

export function projectMetricChatRootKey(sapId: string, rootThreadId: string): string {
  return JSON.stringify([sapId, rootThreadId])
}

export function projectMetricChatRootSources(rootField: string): Row[] {
  return [
    { sapId: { terms: { field: "sapId" } } },
    { rootThreadId: { terms: { field: rootField } } }
  ]
}

/**
 * Split chat roots into disjoint batches so each batch's `projectMetricChatRootFilter`
 * generates at most `maxClauses` `should` branches (and optionally at most `maxItems`
 * roots for single-page composite aggregations).
 */
export function chunkProjectMetricChatRoots<T extends ChatRoot>(
  roots: readonly T[],
  maxClauses = CHAT_ROOT_MAX_SHOULD_CLAUSES,
  maxItems = Infinity
): T[][] {
  if (!roots.length) return []
  const byOwner = new Map<string, T[]>()
  for (const root of roots) {
    const list = byOwner.get(root.sapId) ?? []
    list.push(root)
    byOwner.set(root.sapId, list)
  }
  const batches: T[][] = []
  let current: T[] = []
  let currentClauses = 0
  const maxSlice = Math.min(TERMS_BATCH_SIZE, maxItems)
  for (const ownerRoots of byOwner.values()) {
    for (let i = 0; i < ownerRoots.length; i += maxSlice) {
      const slice = ownerRoots.slice(i, i + maxSlice)
      if (
        current.length &&
        (currentClauses + 1 > maxClauses || current.length + slice.length > maxItems)
      ) {
        batches.push(current)
        current = []
        currentClauses = 0
      }
      current.push(...slice)
      currentClauses++
    }
  }
  if (current.length) batches.push(current)
  return batches
}

export function projectMetricChatRootFilter(roots: readonly ChatRoot[], rootField: string): Row {
  const byOwner = new Map<string, string[]>()
  for (const { sapId, rootThreadId } of roots) {
    const ids = byOwner.get(sapId) ?? []
    ids.push(rootThreadId)
    byOwner.set(sapId, ids)
  }
  const should: Row[] = []
  for (const [sapId, ids] of byOwner) {
    for (let i = 0; i < ids.length; i += TERMS_BATCH_SIZE) {
      should.push({
        bool: {
          filter: [
            { term: { sapId } },
            { terms: { [rootField]: ids.slice(i, i + TERMS_BATCH_SIZE) } }
          ]
        }
      })
    }
  }
  return should.length ? { bool: { should, minimum_should_match: 1 } } : { match_none: {} }
}

async function readBindings(query: Query, index: string): Promise<ProjectMetricChatBinding[]> {
  const bindings: ProjectMetricChatBinding[] = []
  const rootField = "properties.rootThreadId"
  const eventFilter = { term: { eventName: CHAT_PROJECT_EVENT } }
  const sources = projectMetricChatRootSources(rootField)
  const cursors = new Set<string>()
  let after: Row | undefined

  async function page(filters: Row[], composite: Row, aggs?: Row, mustNot?: Row[]) {
    const raw = await query(index, {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [eventFilter, ...filters],
          ...(mustNot?.length ? { must_not: mustNot } : {})
        }
      },
      aggs: { sessions: { composite: { sources, ...composite }, ...(aggs ? { aggs } : {}) } }
    })
    assertProjectModeResultComplete(raw)
    const sessions = record(record(record(raw).aggregations).sessions)
    if (!Array.isArray(sessions.buckets)) throw new Error("对话项目绑定查询未完整返回")
    return { buckets: sessions.buckets, after: sessions.after_key }
  }

  for (;;) {
    // 普通空白会话也会上报绑定事件。先找曾经有效绑定的会话，再读取其最新状态。
    const candidates = await page(
      [
        { term: { "properties.generationMode": "chat" } },
        { term: { "properties.projectFromLean": true } },
        { exists: { field: "properties.projectCode" } }
      ],
      { size: PAGE_SIZE, ...(after ? { after } : {}) },
      undefined,
      [{ term: { sapId: "" } }, { term: { [rootField]: "" } }]
    )
    const roots: ChatRoot[] = []
    for (const bucket of candidates.buckets) {
      const key = record(record(bucket).key)
      const sapId = text(key.sapId)
      const rootThreadId = text(key.rootThreadId)
      if (!sapId || !rootThreadId) continue
      roots.push({ sapId, rootThreadId })
    }
    if (!candidates.buckets.length) return bindings
    if (roots.length) {
      const latestPages = await Promise.all(
        chunkProjectMetricChatRoots(roots).map(async (chunk) => {
          const latest = await page(
            [projectMetricChatRootFilter(chunk, rootField)],
            { size: chunk.length },
            {
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
          )
          if (latest.buckets.length !== chunk.length) throw new Error("对话项目最新绑定未完整返回")
          return latest.buckets
        })
      )
      for (const bucketList of latestPages) {
        for (const value of bucketList) {
          const row = record(value)
          const key = record(row.key)
          const hits = record(record(row.latest).hits).hits
          if (!Array.isArray(hits) || hits.length !== 1) throw new Error("对话项目缺少最新绑定")
          const properties = record(record(record(hits[0])._source).properties)
          const prjCode = text(properties.projectCode)
          if (properties.generationMode === "chat" && properties.projectFromLean === true && prjCode)
            bindings.push({
              prjCode,
              sapId: text(key.sapId),
              rootThreadId: text(key.rootThreadId)
            })
        }
      }
    }
    if (!candidates.after || candidates.buckets.length < PAGE_SIZE) return bindings
    after = record(candidates.after)
    const cursor = JSON.stringify(after)
    if (!text(after.sapId) || !text(after.rootThreadId) || cursors.has(cursor))
      throw new Error("对话项目绑定分页游标无效")
    cursors.add(cursor)
  }
}

export function fetchProjectMetricChatBindings(
  query: Query,
  eventIndex: string,
  refreshKey?: number
): Promise<ProjectMetricChatBinding[]> {
  let shared = cache.get(query)
  if (!shared) {
    shared = new SharedDashboardCache<ProjectMetricChatBinding[]>({
      maxEntries: 4,
      maxEntryBytes: 16 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      ttlMs: CACHE_TTL_MS,
      measureBytes: (rows) => rows.length * 160 + 64
    })
    cache.set(query, shared)
  }
  const key = JSON.stringify([eventIndex, refreshKey ?? 0])
  return shared.read(key, () => readBindings(query, eventIndex))
}
