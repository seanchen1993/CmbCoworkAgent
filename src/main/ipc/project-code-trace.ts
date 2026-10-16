import type {
  ProjectCodeTraceItem,
  ProjectCodeTracePage,
  ProjectCodeTraceRequest
} from "../../shared/project-code-trace"
import {
  stageBucketAggKey,
  stageBucketCodeAggs,
  stageBucketCodeFilterClause
} from "./dashboard-stage-buckets"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Json = Record<string, unknown>
type Query = (body: Json) => Promise<unknown>
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
    : []
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

const ATTRIBUTION_FIELDS = [
  "usedSkills",
  "skillSource",
  "harnessNodeName",
  "harnessNodeStatus",
  "harnessFeatureSlug",
  "harnessAdapterName",
  "harnessAdapterVersion",
  "modelId",
  "modelName",
  "traceKind",
  "subagentKind",
  "coordinatorWorkerRole",
  "workflowAgentLabel",
  "threadId",
  "traceId",
  "rootThreadId",
  "parentThreadId"
]
const ADOPT_FIELDS = [
  ...ATTRIBUTION_FIELDS,
  "eventId",
  "genEventId",
  "generatedLineCount",
  "effectiveGeneratedLineCount",
  "adoptedLineCount",
  "generatedAt",
  "measuredAt",
  "commitSha",
  "pushed",
  "verdict"
]
const GEN_FIELDS = [
  ...ATTRIBUTION_FIELDS,
  "eventId",
  "relativeHint",
  "tool",
  "language",
  "createdAt"
]

function hits(raw: unknown): Json[] {
  assertProjectModeResultComplete(raw)
  const rows = record(record(raw).hits).hits
  if (!Array.isArray(rows)) throw new Error("代码溯源查询缺少明细数据")
  return rows.map(record)
}

function totalHits(raw: unknown): number {
  const total = record(record(raw).hits).total
  if (typeof total === "number") return total
  if (record(total).relation !== "eq") throw new Error("代码溯源数量未完整返回")
  return number(record(total).value)
}

function properties(hit: Json): Json {
  return record(record(hit._source).properties)
}

/** One page: one indexed search, then at most two bounded metadata lookups in parallel.
 * Permission/org/project filters are supplied by the main-process access layer.
 * No trace bodies or local source contents are fetched here. */
export async function fetchProjectCodeTracePage(
  input: ProjectCodeTraceRequest,
  accessFilters: Json[],
  query: Query
): Promise<ProjectCodeTracePage> {
  const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : ""
  if (!projectId || !["plugin_constrained", "vibecoding", "unattributed"].includes(input.bucket)) {
    throw new Error("无效的项目或代码分类")
  }
  const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize) || 20)))
  const projectFilters = [...accessFilters, { term: { "properties.harnessProjectId": projectId } }]
  const scope = JSON.stringify([projectId, input.bucket, accessFilters, pageSize])
  const cursor = input.cursor
  if (
    cursor &&
    (cursor.scope !== scope ||
      !Array.isArray(cursor.after) ||
      cursor.after.length !== 3 ||
      !cursor.after.every(
        (v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v))
      ) ||
      typeof cursor.after[0] !== "number" ||
      typeof cursor.after[2] !== "string" ||
      !Number.isFinite(Date.parse(cursor.asOf)) ||
      Date.parse(cursor.asOf) > Date.now())
  )
    throw new Error("代码溯源分页已失效，请重新打开")
  const asOf = cursor?.asOf ?? new Date().toISOString()
  const filters: Json[] = [
    ...projectFilters,
    { term: { eventName: "code_adopt" } },
    ...["adoptedLineCount", "generatedLineCount", "effectiveGeneratedLineCount"].map((field) => ({
      exists: { field: `properties.${field}` }
    })),
    { range: { "properties.adoptedLineCount": { gt: 0 } } },
    { range: { eventTime: { lte: asOf } } }
  ]
  const raw = await query({
    size: pageSize + 1,
    track_total_hits: !cursor,
    query: { bool: { filter: filters } },
    post_filter: stageBucketCodeFilterClause(input.bucket),
    sort: [
      { "properties.adoptedLineCount": { order: "desc", unmapped_type: "long" } },
      { eventTime: { order: "desc" } },
      { eventId: { order: "asc" } }
    ],
    ...(cursor ? { search_after: cursor.after } : {}),
    _source: { includes: ["eventId", "userName", ...ADOPT_FIELDS.map((f) => `properties.${f}`)] },
    ...(!cursor
      ? {
          aggs: stageBucketCodeAggs({
            adopted_lines: { sum: { field: "properties.adoptedLineCount" } }
          })
        }
      : {})
  })
  const allHits = hits(raw)
  const rows = allHits.slice(0, pageSize)
  const hasNext = allHits.length > pageSize
  const lastSort = rows.at(-1)?.sort
  if (
    hasNext &&
    (!Array.isArray(lastSort) ||
      lastSort.length !== 3 ||
      JSON.stringify(lastSort) === JSON.stringify(cursor?.after))
  ) {
    throw new Error("代码溯源分页游标未前进，请重新打开")
  }
  const genIds = [
    ...new Set(
      rows.map((row) => text(properties(row).genEventId)).filter((id): id is string => Boolean(id))
    )
  ]
  const shas = [
    ...new Set(
      rows.map((row) => text(properties(row).commitSha)).filter((id): id is string => Boolean(id))
    )
  ]
  const [genRaw, commitRaw] = await Promise.all([
    genIds.length
      ? query({
          size: genIds.length,
          track_total_hits: true,
          query: {
            bool: {
              filter: [
                ...projectFilters,
                { term: { eventName: "code_gen" } },
                { terms: { "properties.eventId": genIds } }
              ]
            }
          },
          _source: { includes: ["userName", ...GEN_FIELDS.map((f) => `properties.${f}`)] }
        })
      : null,
    shas.length
      ? query({
          size: shas.length,
          track_total_hits: false,
          query: {
            bool: {
              filter: [
                ...accessFilters,
                { term: { eventName: "git.commit.created" } },
                { terms: { "properties.commitSha": shas } }
              ]
            }
          },
          // Collapse avoids one commit occupying several slots after a Push update.
          collapse: { field: "properties.commitSha" },
          sort: [{ eventTime: { order: "desc" } }],
          _source: {
            includes: [
              "properties.commitSha",
              "properties.commitUrl",
              "properties.repositoryName",
              "properties.repositoryFullName",
              "properties.branch"
            ]
          }
        })
      : null
  ])
  const gens = new Map<string, Json>()
  if (genRaw) {
    if (totalHits(genRaw) > genIds.length) throw new Error("产码记录重复，无法完整关联溯源")
    for (const row of hits(genRaw)) {
      const id = text(properties(row).eventId)
      if (!id || !genIds.includes(id) || gens.has(id)) throw new Error("产码溯源关联返回异常")
      gens.set(id, row)
    }
  }
  const commits = new Map<string, Json>()
  if (commitRaw)
    for (const row of hits(commitRaw)) {
      const props = properties(row)
      const sha = text(props.commitSha)
      if (sha && shas.includes(sha)) commits.set(sha, props)
    }
  const items = rows.map((row): ProjectCodeTraceItem => {
    const adopt = properties(row)
    const genId = text(adopt.genEventId)
    const genHit = genId ? gens.get(genId) : undefined
    const gen = genHit ? properties(genHit) : undefined
    const sha = text(adopt.commitSha)
    const commit = sha ? commits.get(sha) : undefined
    // Classification uses the immutable attribution carried onto code_adopt,
    // exactly like the list's sums. Never repair historic buckets from today's trace.
    const attr = (field: string) => text(adopt[field]) ?? text(gen?.[field])
    const usedSkills = strings(adopt.usedSkills)
    return {
      eventId: text(record(row._source).eventId) ?? text(adopt.eventId) ?? String(row._id ?? ""),
      genEventId: genId,
      file: text(gen?.relativeHint),
      tool: text(gen?.tool),
      language: text(gen?.language),
      generatedLines: number(adopt.generatedLineCount),
      effectiveLines: number(adopt.effectiveGeneratedLineCount),
      adoptedLines: number(adopt.adoptedLineCount),
      usedSkills,
      skillSource: strings(adopt.skillSource),
      nodeName: text(adopt.harnessNodeName),
      nodeStatus: text(adopt.harnessNodeStatus),
      featureSlug: attr("harnessFeatureSlug"),
      pluginName: attr("harnessAdapterName"),
      pluginVersion: attr("harnessAdapterVersion"),
      model: attr("modelName") ?? attr("modelId"),
      userName: text(record(genHit?._source).userName) ?? text(record(row._source).userName),
      agentKind: attr("subagentKind") ?? (attr("traceKind") === "root" ? "root" : null),
      agentLabel: attr("workflowAgentLabel") ?? attr("coordinatorWorkerRole"),
      threadId: attr("threadId"),
      traceId: attr("traceId"),
      rootThreadId: attr("rootThreadId"),
      parentThreadId: attr("parentThreadId"),
      generatedAt: text(adopt.generatedAt) ?? text(gen?.createdAt),
      measuredAt: text(adopt.measuredAt),
      commitSha: sha,
      commitUrl: text(commit?.commitUrl),
      repository: text(commit?.repositoryFullName) ?? text(commit?.repositoryName),
      branch: text(commit?.branch),
      pushed: adopt.pushed === true,
      verdict: text(adopt.verdict),
      generationAvailable: Boolean(gen),
      generationAttribution: gen
        ? {
            nodeName: text(gen.harnessNodeName),
            nodeStatus: text(gen.harnessNodeStatus),
            usedSkills: strings(gen.usedSkills)
          }
        : null,
      attributionMismatch: Boolean(
        gen &&
        (text(gen.harnessNodeName) !== text(adopt.harnessNodeName) ||
          text(gen.harnessNodeStatus) !== text(adopt.harnessNodeStatus) ||
          JSON.stringify([...strings(gen.usedSkills)].sort()) !==
            JSON.stringify([...usedSkills].sort()))
      )
    }
  })
  let summary: ProjectCodeTracePage["summary"]
  if (!cursor) {
    const aggs = record(record(raw).aggregations)
    const lines = (bucket: typeof input.bucket): number => {
      const metric = record(record(aggs[stageBucketAggKey(bucket)]).adopted_lines)
      if (typeof metric.value !== "number") throw new Error("代码溯源汇总未完整返回")
      return number(metric.value)
    }
    summary = {
      harnessLines: lines("plugin_constrained"),
      vibeLines: lines("vibecoding"),
      unattributedLines: lines("unattributed")
    }
  }
  return {
    items,
    ...(!cursor ? { total: totalHits(raw), summary } : {}),
    nextCursor: hasNext ? { after: lastSort as Array<string | number>, asOf, scope } : null
  }
}
