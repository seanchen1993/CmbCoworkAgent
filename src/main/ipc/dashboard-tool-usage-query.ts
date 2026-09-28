/** Retry only a missing/conflicting nested mapping during a rolling upgrade. */
export async function queryWithToolUsageMappingFallback<T>(
  execute: (body: Record<string, unknown>) => Promise<T>,
  body: Record<string, unknown>
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
    if (!/toolUsage/.test(message) || !/nested.*(path|type)|not.*nested/i.test(message)) throw error
    const aggs = { ...(body.aggs as Record<string, unknown>) }
    delete aggs.tool_usage_complete
    return execute({ ...body, aggs })
  }
}
