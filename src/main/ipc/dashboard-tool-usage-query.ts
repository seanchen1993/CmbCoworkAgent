import { isNestedMappingError } from "./dashboard-es-nested-mapping"

/** Retry only a missing/conflicting nested mapping during a rolling upgrade. */
export async function queryWithToolUsageMappingFallback<T>(
  execute: (body: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>
): Promise<T> {
  try {
    return await execute(body)
  } catch (error) {
    if (!isNestedMappingError(error, "toolUsage")) throw error
    const aggs = { ...(body.aggs as Record<string, unknown>) }
    delete aggs.tool_usage_complete
    return execute({ ...body, aggs })
  }
}
