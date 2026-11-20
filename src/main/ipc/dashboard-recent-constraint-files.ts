import type {
  KnowledgeReadDetails,
  KnowledgeReadFile,
  KnowledgeRecentConstraintFiles
} from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"
import { indexedKeywordField } from "./dashboard-es-indexed-fields"

type JsonRecord = Record<string, unknown>
export const RECENT_CONSTRAINT_FILES_PAGE_SIZE = 500
const DAY_MS = 24 * 60 * 60 * 1000

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

export interface RecentConstraintFields {
  file: string
  pluginId?: string
  pluginName?: string
  adapterName?: string
  lastReadAt?: string
  lastReadAtAggregation?: string
}

/** Use indexed keywords only; never enable text fielddata or use a per-document script. */
export function resolveRecentConstraintFields(caps: unknown): RecentConstraintFields {
  const raw = record(caps)
  if (!raw.fields || typeof raw.fields !== "object" || Array.isArray(raw.fields)) {
    throw new Error("无法确认约束文件的索引字段类型")
  }
  const fields = record(raw.fields)
  const noUnavailableIndices = (value: unknown): boolean =>
    value == null || (Array.isArray(value) && value.length === 0)
  const keyword = (name: string): string | undefined => indexedKeywordField(fields, name)
  const file = keyword("properties.constraintFiles")
  // An entirely new index may have no read events/field yet. Unmapped keyword
  // sources return no file keys; the missing-files probe prevents false zeroes.
  if (
    !file &&
    (fields["properties.constraintFiles"] || fields["properties.constraintFiles.keyword"])
  ) {
    throw new Error("约束文件字段不支持去重统计，请检查现有索引类型")
  }
  const readTypes = Object.values(record(fields["properties.lastReadAt"])).map(record)
  const lastReadAt =
    readTypes.length &&
    readTypes.every(
      (type) =>
        ["date", "date_nanos"].includes(String(type.type)) &&
        type.searchable === true &&
        noUnavailableIndices(type.non_searchable_indices)
    )
      ? "properties.lastReadAt"
      : undefined
  return {
    file: file ?? "properties.constraintFiles",
    pluginId: keyword("properties.pluginId"),
    pluginName: keyword("properties.pluginName"),
    adapterName: keyword("properties.harnessAdapterName"),
    lastReadAt,
    ...(readTypes.length &&
    readTypes.every(
      (type) =>
        ["date", "date_nanos"].includes(String(type.type)) &&
        type.aggregatable === true &&
        noUnavailableIndices(type.non_aggregatable_indices)
    )
      ? { lastReadAtAggregation: "properties.lastReadAt" }
      : {})
  }
}

/** Numeric/date doc values only. Missing or legacy keyword timestamps use eventTime. */
export function buildRecentReadTimeAggs(fields: RecentConstraintFields): JsonRecord {
  const field = fields.lastReadAtAggregation
  if (!field) return { latest_read: { max: { field: "eventTime" } } }
  return {
    latest_read: { max: { field } },
    fallback_read: {
      filter: { bool: { must_not: [{ exists: { field } }] } },
      aggs: { latest_read: { max: { field: "eventTime" } } }
    }
  }
}

export function latestReadTime(...values: (string | undefined)[]): string | undefined {
  const times = values.map((value) => (value ? Date.parse(value) : NaN)).filter(Number.isFinite)
  if (!times.length) return undefined
  return new Date(Math.max(...times)).toISOString()
}

export function readRecentReadTime(bucket: unknown): string | undefined {
  const data = record(bucket)
  const values = [
    record(data.latest_read).value,
    record(record(data.fallback_read).latest_read).value
  ]
  const times = values.flatMap((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return []
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? [date.toISOString()] : []
  })
  return latestReadTime(...times)
}

export function buildRecentConstraintFileQuery(
  fields: RecentConstraintFields,
  orgFilters: JsonRecord[],
  now: Date,
  after?: JsonRecord
): JsonRecord {
  const window = {
    gte: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    lte: now.toISOString()
  }
  const time = fields.lastReadAt
    ? {
        bool: {
          should: [
            { range: { [fields.lastReadAt]: window } },
            {
              bool: {
                must_not: [{ exists: { field: fields.lastReadAt } }],
                filter: [{ range: { eventTime: window } }]
              }
            }
          ],
          minimum_should_match: 1
        }
      }
    : { range: { eventTime: window } }
  const sources: JsonRecord[] = []
  for (const [key, field] of [
    ["pluginId", fields.pluginId],
    ["pluginName", fields.pluginName],
    ["adapterName", fields.adapterName]
  ]) {
    if (field) sources.push({ [key!]: { terms: { field, missing_bucket: true } } })
  }
  sources.push({ file: { terms: { field: fields.file, missing_bucket: true } } })
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { term: { eventName: "harness.system_constraint.read_summary" } },
          { exists: { field: "properties.harnessProjectId" } },
          { range: { "properties.successfulReadCount": { gt: 0 } } },
          time,
          ...orgFilters
        ]
      }
    },
    aggs: {
      files: {
        composite: {
          size: RECENT_CONSTRAINT_FILES_PAGE_SIZE,
          sources,
          ...(after ? { after } : {})
        },
        aggs: buildRecentReadTimeAggs(fields)
      },
      ...(!after
        ? { truncated_files: { filter: { term: { "properties.filesTruncated": true } } } }
        : {})
    }
  }
}

/** Exact de-duplication of reported plugin/file keys; only time attribution is approximate. */
export async function fetchRecentConstraintFileDetails(
  fields: RecentConstraintFields,
  orgFilters: JsonRecord[],
  query: (body: JsonRecord) => Promise<unknown>,
  signal?: AbortSignal,
  now = new Date()
): Promise<KnowledgeReadDetails> {
  const files = new Map<string, KnowledgeReadFile>()
  const aliases = new Map<string, Set<string>>()
  const namedFiles = new Map<string, Map<string, string | undefined>>()
  const cursors = new Set<string>()
  let complete = true
  let after: JsonRecord | undefined
  const addFile = (id: string, name: string, path: string, time?: string): void => {
    const key = JSON.stringify(id ? ["id", id, path] : ["name", name, path])
    const existing = files.get(key)
    const lastReadAt = latestReadTime(existing?.lastReadAt, time)
    files.set(key, {
      filePath: path,
      pluginId: id,
      pluginName: existing?.pluginName || name,
      ...(lastReadAt ? { lastReadAt } : {})
    })
  }
  for (;;) {
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    const raw = record(await query(buildRecentConstraintFileQuery(fields, orgFilters, now, after)))
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    if (raw.timed_out || Number(record(raw._shards).failed) > 0) {
      throw new Error("近期约束文件统计未完整返回，请重试")
    }
    const aggs = record(raw.aggregations)
    const page = record(aggs.files)
    if (!Array.isArray(page.buckets)) throw new Error("近期约束文件统计缺少聚合结果")
    if (!after && Number(record(aggs.truncated_files).doc_count) > 0) complete = false
    for (const item of page.buckets) {
      const key = record(record(item).key)
      const text = (name: string): string =>
        typeof key[name] === "string" ? String(key[name]).trim() : ""
      const id = text("pluginId")
      const name = text("pluginName") || text("adapterName")
      const path = text("file")
      const time = readRecentReadTime(item)
      if (!path || (!id && !name)) {
        complete = false
        continue
      }
      if (id) {
        addFile(id, name, path, time)
        for (const alias of new Set([text("pluginName"), text("adapterName")].filter(Boolean))) {
          const ids = aliases.get(alias) ?? new Set<string>()
          ids.add(id)
          aliases.set(alias, ids)
        }
      } else {
        const paths = namedFiles.get(name) ?? new Map<string, string | undefined>()
        paths.set(path, latestReadTime(paths.get(path), time))
        namedFiles.set(name, paths)
      }
    }
    if (
      page.after_key != null &&
      (typeof page.after_key !== "object" || Array.isArray(page.after_key))
    )
      throw new Error("近期约束文件分页游标无效，请重试")
    const next = record(page.after_key)
    if (page.buckets.length === 0 || Object.keys(next).length === 0) break
    const signature = JSON.stringify(next)
    if (cursors.has(signature)) throw new Error("近期约束文件分页游标未前进，请重试")
    cursors.add(signature)
    after = next
  }
  // Old records carrying only a name can join an unambiguous current ID.
  // Ambiguous names cannot prove another distinct file: retain a visible lower bound.
  for (const [name, paths] of namedFiles) {
    const ids = aliases.get(name)
    if (ids && ids.size > 1) {
      complete = false
      continue
    }
    const id = ids?.values().next().value
    for (const [path, time] of paths) addFile(id ?? "", name, path, time)
  }
  const aliasesById = new Map<string, string[]>()
  for (const [name, ids] of aliases) {
    if (ids.size !== 1) continue
    const id = ids.values().next().value!
    const names = aliasesById.get(id) ?? []
    names.push(name)
    aliasesById.set(id, names)
  }
  const items = [...files.values()]
    .map((file) => ({
      ...file,
      pluginAliases: (aliasesById.get(file.pluginId) ?? []).sort()
    }))
    .sort(
      (a, b) =>
        (b.lastReadAt ?? "").localeCompare(a.lastReadAt ?? "") ||
        (a.pluginName || a.pluginId).localeCompare(b.pluginName || b.pluginId) ||
        a.filePath.localeCompare(b.filePath) ||
        a.pluginId.localeCompare(b.pluginId)
    )
  return { fileCount: items.length, complete, items }
}

export async function fetchRecentConstraintFiles(
  fields: RecentConstraintFields,
  orgFilters: JsonRecord[],
  query: (body: JsonRecord) => Promise<unknown>,
  signal?: AbortSignal,
  now = new Date()
): Promise<KnowledgeRecentConstraintFiles> {
  const { fileCount, complete } = await fetchRecentConstraintFileDetails(
    fields,
    orgFilters,
    query,
    signal,
    now
  )
  return { fileCount, complete }
}
