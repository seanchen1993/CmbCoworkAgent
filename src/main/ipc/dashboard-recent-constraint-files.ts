import type { KnowledgeRecentConstraintFiles } from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"

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
  const keyword = (name: string): string | undefined => {
    for (const candidate of [name, `${name}.keyword`]) {
      const types = Object.values(record(fields[candidate])).map(record)
      if (
        types.length &&
        types.every(
          (type) =>
            ["keyword", "constant_keyword"].includes(String(type.type)) &&
            type.aggregatable === true &&
            noUnavailableIndices(type.non_aggregatable_indices)
        )
      )
        return candidate
    }
    return undefined
  }
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
    lastReadAt
  }
}

export function buildRecentConstraintFileQuery(
  fields: RecentConstraintFields,
  orgFilters: JsonRecord[],
  now: Date,
  after?: JsonRecord
): JsonRecord {
  const window = {
    gte: new Date(now.getTime() - 14 * DAY_MS).toISOString(),
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
        }
      },
      ...(!after
        ? { truncated_files: { filter: { term: { "properties.filesTruncated": true } } } }
        : {})
    }
  }
}

/** Exact de-duplication of reported plugin/file keys; only time attribution is approximate. */
export async function fetchRecentConstraintFiles(
  fields: RecentConstraintFields,
  orgFilters: JsonRecord[],
  query: (body: JsonRecord) => Promise<unknown>,
  signal?: AbortSignal,
  now = new Date()
): Promise<KnowledgeRecentConstraintFiles> {
  const files = new Set<string>()
  const aliases = new Map<string, Set<string>>()
  const namedFiles = new Map<string, Set<string>>()
  const cursors = new Set<string>()
  let complete = true
  let after: JsonRecord | undefined
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
      if (!path || (!id && !name)) {
        complete = false
        continue
      }
      if (id) {
        files.add(JSON.stringify(["id", id, path]))
        for (const alias of new Set([text("pluginName"), text("adapterName")].filter(Boolean))) {
          const ids = aliases.get(alias) ?? new Set<string>()
          ids.add(id)
          aliases.set(alias, ids)
        }
      } else {
        const paths = namedFiles.get(name) ?? new Set<string>()
        paths.add(path)
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
    for (const path of paths)
      files.add(JSON.stringify(id ? ["id", id, path] : ["name", name, path]))
  }
  return { fileCount: files.size, complete }
}
