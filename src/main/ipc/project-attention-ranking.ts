import {
  vibecodingAdoptedShare,
  type ProjectAttentionSortKey
} from "../../shared/project-attention"
import {
  mainAgentConversationAggs,
  readMainAgentConversations,
  stageBucketCodeFilterClause,
  stageBucketAggKey,
  projectModeMainAgentConversationFilter
} from "./dashboard-stage-buckets"
import { normalizeCodeStatsFromContainer } from "./dashboard-code-stats"
import { mapAwardBatches } from "./dashboard-awards-skill"
import { ProjectModePageCache } from "./project-mode-page-cache"

type JsonRecord = Record<string, unknown>
type Query = (index: string, body: JsonRecord) => Promise<unknown>
export const PROJECT_ATTENTION_ID_PAGE_SIZE = 1000
export const PROJECT_ATTENTION_METRIC_BATCH_SIZE = 200
export type ProjectMetricSortKey = ProjectAttentionSortKey | "conversationCount" | "generatedLines"

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function completeAggregation(value: unknown, name: string): JsonRecord {
  const raw = record(value)
  if (raw.timed_out || Number(record(raw._shards).failed) > 0) {
    throw new Error("项目排序统计未完整返回，请重试")
  }
  const agg = record(record(raw.aggregations)[name])
  if (!Array.isArray(agg.buckets) || Number(agg.sum_other_doc_count) > 0) {
    throw new Error("项目排序统计缺失或被截断，请重试")
  }
  return agg
}

export interface ProjectAttentionRankingScope {
  snapshotFilters: JsonRecord[]
  traceFilters: JsonRecord[]
  codeGenFilters: JsonRecord[]
  codeAdoptFilters: JsonRecord[]
  codeAggs: JsonRecord
  eventIndex: string
  traceIndex: string
}

/** Enumerate only snapshot IDs, with stable cursors and no top-N truncation. */
async function matchingProjectIds(
  scope: ProjectAttentionRankingScope,
  query: Query
): Promise<string[]> {
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let after: JsonRecord | undefined
  for (;;) {
    const page = completeAggregation(
      await query(scope.eventIndex, {
        size: 0,
        track_total_hits: false,
        query: { bool: { filter: scope.snapshotFilters } },
        aggs: {
          projects: {
            composite: {
              size: PROJECT_ATTENTION_ID_PAGE_SIZE,
              sources: [{ project: { terms: { field: "properties.projectId" } } }],
              ...(after ? { after } : {})
            }
          }
        }
      }),
      "projects"
    )
    const buckets = page.buckets as unknown[]
    for (const bucket of buckets) {
      const id = record(record(bucket).key).project
      if (typeof id !== "string" || !id || ids.has(id)) {
        throw new Error("项目排序分页出现无效或重复项目，请重试")
      }
      ids.add(id)
    }
    const next = record(page.after_key)
    if (buckets.length === 0 || Object.keys(next).length === 0) break
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("项目排序分页游标未前进，请重试")
    cursors.add(cursor)
    after = next
  }
  return [...ids]
}

export function buildProjectAttentionMetricQuery(
  scope: ProjectAttentionRankingScope,
  ids: string[],
  key: ProjectMetricSortKey
): { index: string; body: JsonRecord } {
  if (key === "generatedLines") {
    return {
      index: scope.eventIndex,
      body: {
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: [...scope.codeGenFilters, { terms: { "properties.harnessProjectId": ids } }]
          }
        },
        aggs: {
          projects: {
            terms: { field: "properties.harnessProjectId", size: ids.length },
            aggs: { generated_lines: { sum: { field: "properties.lineCount" } } }
          }
        }
      }
    }
  }
  if (key === "vibecodingShare") {
    return {
      index: scope.eventIndex,
      body: {
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: [...scope.codeAdoptFilters, { terms: { "properties.harnessProjectId": ids } }]
          }
        },
        aggs: {
          projects: {
            terms: { field: "properties.harnessProjectId", size: ids.length },
            aggs: Object.fromEntries(
              (["plugin_constrained", "vibecoding"] as const).map((bucket) => [
                stageBucketAggKey(bucket),
                {
                  filter: stageBucketCodeFilterClause(bucket),
                  aggs: { adopted_lines: { sum: { field: "properties.adoptedLineCount" } } }
                }
              ])
            )
          }
        }
      }
    }
  }
  if (key === "inclusiveAdoptionRate") {
    const project = { terms: { "properties.harnessProjectId": ids } }
    // These two existing aggregations preserve the list's adoption formula.
    // Push, commit cardinality, feature breakdowns and raw traces are unnecessary.
    const gen = record(scope.codeAggs.code_gen)
    const measured = record(scope.codeAggs.code_adopt_measured)
    const measuredAggs = record(measured.aggs)
    return {
      index: scope.eventIndex,
      body: {
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: [project],
            should: [
              { bool: { filter: scope.codeGenFilters } },
              { bool: { filter: scope.codeAdoptFilters } }
            ],
            minimum_should_match: 1
          }
        },
        aggs: {
          projects: {
            terms: { field: "properties.harnessProjectId", size: ids.length },
            aggs: {
              code_gen: { ...gen, aggs: { generated_lines: record(gen.aggs).generated_lines } },
              code_adopt_measured: {
                ...measured,
                aggs: {
                  measured_generated_lines: measuredAggs.measured_generated_lines,
                  effective_generated_lines: measuredAggs.effective_generated_lines,
                  adopted_lines: measuredAggs.adopted_lines
                }
              }
            }
          }
        }
      }
    }
  }
  const inner =
    key === "conversationCount"
      ? {}
      : {
          known_details: { filter: { exists: { field: "suspectedTechnicalDetailSupplement" } } },
          suspected_details: { filter: { term: { suspectedTechnicalDetailSupplement: true } } }
        }
  return {
    index: scope.traceIndex,
    body: {
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            ...scope.traceFilters,
            { terms: { harnessProjectId: ids } },
            projectModeMainAgentConversationFilter()
          ]
        }
      },
      aggs: {
        projects: {
          terms: { field: "harnessProjectId", size: ids.length },
          aggs: mainAgentConversationAggs(inner)
        }
      }
    }
  }
}

function metricValue(bucket: JsonRecord, key: ProjectMetricSortKey): number | null {
  if (key === "generatedLines") return Number(record(bucket.generated_lines).value) || 0
  if (key === "inclusiveAdoptionRate") {
    return normalizeCodeStatsFromContainer(bucket).inclusiveAdoptionRate
  }
  if (key === "vibecodingShare") {
    const lines = (key: "plugin_constrained" | "vibecoding") =>
      Number(record(record(bucket[stageBucketAggKey(key)]).adopted_lines).value) || 0
    return vibecodingAdoptedShare(lines("plugin_constrained"), lines("vibecoding"))
  }
  const conversations = readMainAgentConversations(bucket)
  if (key === "conversationCount") return Number(conversations.doc_count) || 0
  if (key === "suspectedTechnicalDetailConversationCount") {
    return Number(record(conversations.known_details).doc_count) > 0
      ? Number(record(conversations.suspected_details).doc_count)
      : null
  }
  return null
}

/** One selected metric, 200 IDs per batch, at most two ES requests in flight. */
export async function fetchProjectAttentionRanking(
  scope: ProjectAttentionRankingScope,
  key: ProjectMetricSortKey,
  query: Query
): Promise<Map<string, number | null>> {
  const ids = await matchingProjectIds(scope, query)
  const empty = key === "conversationCount" || key === "generatedLines" ? 0 : null
  const metrics = new Map<string, number | null>(ids.map((id) => [id, empty]))
  await mapAwardBatches(ids, PROJECT_ATTENTION_METRIC_BATCH_SIZE, async (batch) => {
    const request = buildProjectAttentionMetricQuery(scope, batch, key)
    const result = completeAggregation(await query(request.index, request.body), "projects")
    const allowed = new Set(batch)
    for (const raw of result.buckets as unknown[]) {
      const bucket = record(raw)
      const id = bucket.key
      if (typeof id !== "string" || !allowed.has(id)) {
        throw new Error("项目排序返回了范围外的项目，请重试")
      }
      metrics.set(id, metricValue(bucket, key))
    }
  })
  return metrics
}

/** Completed results only; scoped by permission filters, dates and chosen metric. */
export class ProjectAttentionRankingCache extends ProjectModePageCache<Map<string, number | null>> {
  constructor() {
    super(4)
  }
}
