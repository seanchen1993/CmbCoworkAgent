import type {
  KnowledgeFileReaders,
  KnowledgeReader,
  KnowledgeReadFile,
  KnowledgeReadFileRef
} from "../../shared/dashboard-knowledge-overview"
import { DashboardRequestCancelledError } from "../services/dashboard-request-coordinator"
import { indexedKeywordField } from "./dashboard-es-indexed-fields"
import {
  buildRecentConstraintFileQuery,
  buildRecentReadTimeAggs,
  latestReadTime,
  readRecentReadTime,
  type RecentConstraintFields
} from "./dashboard-recent-constraint-files"

type JsonRecord = Record<string, unknown>
const READER_FIELDS = {
  sapId: "sapId",
  ystId: "ystId",
  userName: "userName",
  room: "upperOrgLv1",
  group: "upperOrgLv0"
} as const
export type KnowledgeReaderFields = Partial<Record<keyof typeof READER_FIELDS, string>>
export const KNOWLEDGE_READERS_PAGE_SIZE = 500

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function text(value: unknown): string {
  if (typeof value !== "string") return ""
  const valueText = value.trim()
  return ["unknown", "null", "undefined", "[trace budget exhausted]"].includes(
    valueText.toLowerCase()
  )
    ? ""
    : valueText
}

export function resolveKnowledgeReaderFields(caps: unknown): KnowledgeReaderFields {
  const fields = record(record(caps).fields)
  return Object.fromEntries(
    Object.entries(READER_FIELDS).flatMap(([key, name]) => {
      const field = indexedKeywordField(fields, name)
      return field ? [[key, field]] : []
    })
  )
}

export function normalizeKnowledgeReadFileRef(value: unknown): KnowledgeReadFileRef {
  const row = record(value)
  const filePath = typeof row.filePath === "string" ? row.filePath.trim() : ""
  const pluginId = typeof row.pluginId === "string" ? row.pluginId.trim() : ""
  const pluginName = typeof row.pluginName === "string" ? row.pluginName.trim() : ""
  if (!filePath || (!pluginId && !pluginName)) throw new Error("请选择有效的读取文件")
  return { filePath, pluginId, pluginName }
}

function missing(field: string): JsonRecord {
  return {
    bool: {
      should: [{ bool: { must_not: [{ exists: { field } }] } }, { term: { [field]: "" } }],
      minimum_should_match: 1
    }
  }
}

function pluginClause(fields: RecentConstraintFields, file: KnowledgeReadFile): JsonRecord {
  const clauses: JsonRecord[] = []
  if (fields.pluginId && file.pluginId) clauses.push({ term: { [fields.pluginId]: file.pluginId } })
  const names = file.pluginId ? (file.pluginAliases ?? []) : [file.pluginName]
  const legacy: JsonRecord[] = []
  if (fields.pluginName && names.length) legacy.push({ terms: { [fields.pluginName]: names } })
  if (fields.adapterName && names.length)
    legacy.push({
      bool: {
        filter: [
          ...(fields.pluginName ? [missing(fields.pluginName)] : []),
          { terms: { [fields.adapterName]: names } }
        ]
      }
    })
  if (legacy.length)
    clauses.push({
      bool: {
        filter: [
          ...(fields.pluginId ? [missing(fields.pluginId)] : []),
          { bool: { should: legacy, minimum_should_match: 1 } }
        ]
      }
    })
  if (!clauses.length) throw new Error("无法确认读取文件所属插件，请刷新后重试")
  return { bool: { should: clauses, minimum_should_match: 1 } }
}

export function buildKnowledgeFileReadersQuery(
  fields: RecentConstraintFields,
  readerFields: KnowledgeReaderFields,
  file: KnowledgeReadFile,
  orgFilters: JsonRecord[],
  now: Date,
  after?: JsonRecord
): JsonRecord {
  if (!readerFields.sapId && !readerFields.ystId && !readerFields.userName)
    throw new Error("当前索引缺少可查询的读取人字段")
  const base = buildRecentConstraintFileQuery(fields, orgFilters, now)
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [base.query, { term: { [fields.file]: file.filePath } }, pluginClause(fields, file)]
      }
    },
    aggs: {
      readers: {
        composite: {
          size: KNOWLEDGE_READERS_PAGE_SIZE,
          sources: Object.entries(readerFields).map(([name, field]) => ({
            [name]: { terms: { field, missing_bucket: true } }
          })),
          ...(after ? { after } : {})
        },
        aggs: buildRecentReadTimeAggs(fields)
      }
    }
  }
}

function addAlias(aliases: Map<string, Set<string>>, name: string, id: string): void {
  if (!name || !id) return
  const values = aliases.get(name) ?? new Set<string>()
  values.add(id)
  aliases.set(name, values)
}

/** Prefer account IDs, join old names only when unambiguous, and never merge distinct same-name users. */
export function mergeKnowledgeReaders(keys: JsonRecord[]): KnowledgeFileReaders {
  const rows = keys.map((key) => ({
    sapId: text(key.sapId),
    ystId: text(key.ystId),
    userName: text(key.userName),
    room: text(key.room),
    group: text(key.group),
    lastReadAt: text(key.lastReadAt)
  }))
  const ystToSap = new Map<string, Set<string>>()
  for (const row of rows) addAlias(ystToSap, row.ystId, row.sapId)
  const people = new Map<string, KnowledgeReader>()
  const names = new Map<string, Set<string>>()
  let hasUnknownReaders = false
  const merge = (key: string, row: (typeof rows)[number], nameOnly: boolean): void => {
    const existing = people.get(key)
    const department = [row.room, row.group].filter(Boolean).join(" / ")
    const lastReadAt = latestReadTime(existing?.lastReadAt, row.lastReadAt)
    people.set(key, {
      key,
      nameOnly,
      userName: existing?.userName || row.userName,
      sapId: existing?.sapId || row.sapId,
      ystId: existing?.ystId || row.ystId,
      ...(lastReadAt ? { lastReadAt } : {}),
      departments: [
        ...new Set([...(existing?.departments ?? []), ...(department ? [department] : [])])
      ].sort()
    })
  }
  for (const row of rows) {
    if (!row.sapId && !row.ystId) continue
    const candidates = ystToSap.get(row.ystId)
    if (!row.sapId && candidates && candidates.size > 1) {
      hasUnknownReaders = true
      continue
    }
    const sapId = row.sapId || candidates?.values().next().value || ""
    const key = JSON.stringify(sapId ? ["sap", sapId] : ["yst", row.ystId])
    merge(key, { ...row, sapId }, false)
    addAlias(names, row.userName, key)
  }
  for (const row of rows) {
    if (row.sapId || row.ystId) continue
    const candidates = names.get(row.userName)
    if (!row.userName || (candidates && candidates.size > 1)) {
      hasUnknownReaders = true
      continue
    }
    const key = candidates?.values().next().value || JSON.stringify(["name", row.userName])
    merge(key, row, !candidates?.size)
  }
  return {
    items: [...people.values()].sort(
      (a, b) =>
        (b.lastReadAt ?? "").localeCompare(a.lastReadAt ?? "") ||
        (a.userName || a.sapId || a.ystId).localeCompare(b.userName || b.sapId || b.ystId) ||
        a.key.localeCompare(b.key)
    ),
    hasUnknownReaders
  }
}

export async function fetchKnowledgeFileReaders(
  fields: RecentConstraintFields,
  readerFields: KnowledgeReaderFields,
  file: KnowledgeReadFile,
  orgFilters: JsonRecord[],
  query: (body: JsonRecord) => Promise<unknown>,
  signal?: AbortSignal,
  now = new Date()
): Promise<KnowledgeFileReaders> {
  const keys: JsonRecord[] = []
  const cursors = new Set<string>()
  let after: JsonRecord | undefined
  for (;;) {
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    const raw = record(
      await query(
        buildKnowledgeFileReadersQuery(fields, readerFields, file, orgFilters, now, after)
      )
    )
    if (signal?.aborted) throw new DashboardRequestCancelledError()
    if (raw.timed_out || Number(record(raw._shards).failed) > 0)
      throw new Error("读取人查询未完整返回，请重试")
    const page = record(record(raw.aggregations).readers)
    if (!Array.isArray(page.buckets)) throw new Error("读取人查询缺少聚合结果")
    for (const bucket of page.buckets)
      keys.push({
        ...record(record(bucket).key),
        lastReadAt: readRecentReadTime(bucket)
      })
    if (
      page.after_key != null &&
      (typeof page.after_key !== "object" || Array.isArray(page.after_key))
    )
      throw new Error("读取人分页游标无效，请重试")
    const next = record(page.after_key)
    if (!page.buckets.length || !Object.keys(next).length) break
    const signature = JSON.stringify(next)
    if (cursors.has(signature)) throw new Error("读取人分页游标未前进，请重试")
    cursors.add(signature)
    after = next
  }
  return mergeKnowledgeReaders(keys)
}
