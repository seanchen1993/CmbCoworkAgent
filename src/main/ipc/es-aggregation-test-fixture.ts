// Independent acceptance harness: execute the generated filters and aggregations
// against documents, rather than returning fixtures keyed to implementation calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The test DSL deliberately accepts heterogeneous ES documents and aggregations.
export type Doc = Record<string, any>
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const field = (doc: Doc, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v as Doc | null)?.[k], doc)
export function matches(doc: Doc, query: Doc): boolean {
  if (query.match_all) return true
  if (query.term || query.terms) {
    const [key, wanted] = Object.entries(query.term ?? query.terms)[0]
    return list(field(doc, key)).some((v) => list(wanted).includes(v))
  }
  if (query.exists) return list(field(doc, query.exists.field)).some((v) => v != null)
  if (query.range) {
    const [key, limits] = Object.entries(query.range)[0] as [string, Doc]
    const number = (v: unknown) =>
      typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN
    const n = number(field(doc, key))
    return (
      Number.isFinite(n) &&
      Object.entries(limits).every(([op, v]) =>
        op === "gte"
          ? n >= number(v)
          : op === "lte"
            ? n <= number(v)
            : op === "gt"
              ? n > number(v)
              : op === "lt"
                ? n < number(v)
                : false
      )
    )
  }
  if (query.bool) {
    const b = query.bool
    const required = b.minimum_should_match ?? (b.should && !b.filter && !b.must ? 1 : 0)
    return (
      list(b.filter).every((q) => matches(doc, q as Doc)) &&
      list(b.must).every((q) => matches(doc, q as Doc)) &&
      list(b.must_not).every((q) => !matches(doc, q as Doc)) &&
      list(b.should).filter((q) => matches(doc, q as Doc)).length >= required
    )
  }
  throw new Error(`Unsupported or costly query in acceptance harness: ${JSON.stringify(query)}`)
}
export function aggregate(docs: Doc[], definitions: Doc): Doc {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, raw]) => {
      const agg = raw as Doc
      if (agg.filter) {
        const selected = docs.filter((doc) => matches(doc, agg.filter))
        return [name, { doc_count: selected.length, ...aggregate(selected, agg.aggs ?? {}) }]
      }
      if (agg.top_hits)
        return [
          name,
          { hits: { hits: docs.slice(0, agg.top_hits.size).map((doc) => ({ _source: doc })) } }
        ]
      if (agg.composite) {
        const c = agg.composite
        const sources = c.sources.map((s: Doc) => {
          const [key, config] = Object.entries(s)[0] as [string, Doc]
          return { key, ...config.terms }
        })
        const groups = new Map<string, { key: Doc; docs: Doc[] }>()
        for (const doc of docs) {
          const key: Doc = {}
          let valid = true
          for (const s of sources) {
            const v = field(doc, s.field)
            if (v == null && !s.missing_bucket) {
              valid = false
              break
            }
            key[s.key] = v ?? null
          }
          if (!valid) continue
          const signature = JSON.stringify(key)
          const group = groups.get(signature) ?? { key, docs: [] }
          group.docs.push(doc)
          groups.set(signature, group)
        }
        const compare = (a: Doc, b: Doc) => {
          for (const s of sources) {
            if (a[s.key] === b[s.key]) continue
            return a[s.key] == null
              ? -1
              : b[s.key] == null
                ? 1
                : String(a[s.key]).localeCompare(String(b[s.key]))
          }
          return 0
        }
        if (c.after)
          if (Object.keys(c.after).length !== sources.length)
            throw new Error(
              `[after] has ${Object.keys(c.after).length} value(s) but [sources] has ${sources.length}`
            )
        const page = [...groups.values()]
          .sort((a, b) => compare(a.key, b.key))
          .filter((g) => !c.after || compare(g.key, c.after) > 0)
          .slice(0, c.size)
        return [
          name,
          {
            buckets: page.map((g) => ({
              key: g.key,
              doc_count: g.docs.length,
              ...aggregate(g.docs, agg.aggs ?? {})
            })),
            ...(page.length ? { after_key: page.at(-1)!.key } : {})
          }
        ]
      }
      if (agg.cardinality)
        return [
          name,
          { value: new Set(docs.flatMap((d) => list(field(d, agg.cardinality.field)))).size }
        ]
      const operation = ["stats", "sum", "min", "max", "value_count"].find((k) => agg[k])
      if (operation) {
        const key = agg[operation].field
        const values = docs
          .flatMap((d) => list(field(d, key)))
          .filter((v) => v != null)
          .map((v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN))
          .filter(Number.isFinite)
        const sum = values.reduce((a, b) => a + b, 0)
        if (operation === "stats")
          return [
            name,
            { count: values.length, sum, min: Math.min(...values), max: Math.max(...values) }
          ]
        const result =
          operation === "sum"
            ? sum
            : operation === "value_count"
              ? values.length
              : !values.length
                ? null
                : operation === "min"
                  ? Math.min(...values)
                  : Math.max(...values)
        return [name, { value: result }]
      }
      throw new Error(`Unsupported aggregation: ${JSON.stringify(agg)}`)
    })
  )
}
