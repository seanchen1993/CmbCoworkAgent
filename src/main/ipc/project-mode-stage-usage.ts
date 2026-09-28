import {
  buildProjectModeRunCostAggs,
  parseProjectModeRunCost,
  type ProjectModeRunCost
} from "./project-mode-run-cost-metrics"

export const completeStageUsageFilter = {
  bool: {
    filter: [{ term: { stageUsageSchemaVersion: 1 } }, { term: { stageUsageComplete: true } }]
  }
}

export function legacyStageCostAgg(): Record<string, unknown> {
  return {
    filter: { bool: { must_not: [completeStageUsageFilter] } },
    aggs: buildProjectModeRunCostAggs()
  }
}

export function stageUsageAgg(unattributed: string, limit: number): Record<string, unknown> {
  return {
    filter: completeStageUsageFilter,
    aggs: {
      usage: {
        nested: { path: "stageUsage" },
        aggs: {
          token_usage_reported_calls: { sum: { field: "stageUsage.tokenUsageReportedCalls" } },
          model_calls: { sum: { field: "stageUsage.modelCalls" } },
          by_node: {
            terms: {
              field: "stageUsage.nodeName",
              missing: unattributed,
              size: Math.max(1, limit)
            },
            aggs: {
              ...Object.fromEntries(
                [
                  "toolCalls",
                  "modelCalls",
                  "inputTokens",
                  "outputTokens",
                  "totalTokens",
                  "userInputRequests"
                ].map((field) => [field, { sum: { field: `stageUsage.${field}` } }])
              ),
              traces: { reverse_nested: {} }
            }
          }
        }
      }
    }
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

export function readStageUsage(container: Record<string, unknown>): {
  costs: Map<string, ProjectModeRunCost>
  callStartTraceCount: number
  turnStartTraceCount: number
  tokenUsageReportedCalls: number
  modelCalls: number
  truncated: boolean
} {
  const scope = record(container.stage_usage)
  const usage = record(scope.usage)
  const nodes = record(usage.by_node)
  const costs = new Map<string, ProjectModeRunCost>()
  if (Array.isArray(nodes.buckets))
    for (const value of nodes.buckets) {
      const bucket = record(value)
      if (typeof bucket.key !== "string") continue
      const metrics = Object.fromEntries(
        [
          "toolCalls",
          "modelCalls",
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "userInputRequests"
        ].map((field) => [field, count(record(bucket[field]).value)])
      )
      const traceDocs = count(record(bucket.traces).doc_count)
      costs.set(bucket.key, {
        ...metrics,
        traceDocs,
        userInputRequestDocs: traceDocs
      } as ProjectModeRunCost)
    }
  return {
    costs,
    callStartTraceCount: count(scope.doc_count),
    turnStartTraceCount: Math.max(
      0,
      count(record(container.run_cost_trace_docs).value) - count(scope.doc_count)
    ),
    tokenUsageReportedCalls: count(record(usage.token_usage_reported_calls).value),
    modelCalls: count(record(usage.model_calls).value),
    truncated:
      count(nodes.sum_other_doc_count) > 0 ||
      count(record(container.by_node).sum_other_doc_count) > 0
  }
}

export function readLegacyStageCost(bucket: Record<string, unknown>): ProjectModeRunCost {
  return parseProjectModeRunCost(bucket.legacy_cost ?? bucket)
}

export function addStageCosts(a: ProjectModeRunCost, b: ProjectModeRunCost): ProjectModeRunCost {
  return {
    toolCalls: a.toolCalls + b.toolCalls,
    modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    userInputRequests: a.userInputRequests + b.userInputRequests,
    traceDocs: (a.traceDocs ?? 0) + (b.traceDocs ?? 0),
    userInputRequestDocs: a.userInputRequestDocs + b.userInputRequestDocs
  }
}

/** Only a missing/conflicting stageUsage mapping triggers the legacy query. */
export async function queryWithStageUsageMappingFallback<T>(
  execute: (body: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>,
  legacyAggs: Record<string, unknown>
): Promise<T> {
  try {
    return await execute(body)
  } catch (error) {
    const messages: string[] = []
    let current = error
    for (let i = 0; i < 6 && current instanceof Error; i++) {
      messages.push(current.message)
      current = current.cause
    }
    const message = messages.join(" ")
    if (!/stageUsage/.test(message) || !/nested.*(path|type)|not.*nested/i.test(message))
      throw error
    return execute({ ...body, aggs: legacyAggs })
  }
}
