type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}

/** Failure-only metadata: no filter values, credentials, cursor values or Trace contents. */
export function describeDashboardEsQuery(body: JsonRecord): {
  composite: Array<{
    aggregation: string
    sources: string[]
    afterKeys: string[]
    nullKeys: string[]
  }>
} {
  const composite: Array<{
    aggregation: string
    sources: string[]
    afterKeys: string[]
    nullKeys: string[]
  }> = []
  const visit = (aggs: unknown, path: string, depth: number): void => {
    if (depth > 8 || composite.length >= 32) return
    for (const [name, value] of Object.entries(record(aggs))) {
      if (composite.length >= 32) break
      const agg = record(value)
      const current = path ? `${path}.${name}` : name
      const spec = record(agg.composite)
      if (Array.isArray(spec.sources)) {
        const after = record(spec.after)
        composite.push({
          aggregation: current,
          sources: spec.sources.flatMap((source) => Object.keys(record(source))),
          afterKeys: Object.keys(after),
          nullKeys: Object.keys(after).filter((key) => after[key] === null)
        })
      }
      visit(agg.aggs ?? agg.aggregations, current, depth + 1)
    }
  }
  visit(body.aggs ?? body.aggregations, "", 0)
  return { composite }
}
