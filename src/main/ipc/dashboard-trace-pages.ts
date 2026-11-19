type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}

/** Read full trace documents in chronological order, shrinking oversized ES responses in place. */
export async function* readDashboardTracePages(input: {
  filters: JsonRecord[]
  sourceIncludes: string[]
  query: (body: JsonRecord) => Promise<unknown>
  isResponseTooLarge: (error: unknown) => boolean
}): AsyncGenerator<JsonRecord[]> {
  const cursors = new Set<string>()
  let size = 10
  let after: unknown[] | undefined
  for (;;) {
    let raw: JsonRecord
    try {
      raw = record(
        await input.query({
          size,
          track_total_hits: false,
          query: { bool: { filter: input.filters } },
          sort: [{ startedAt: { order: "asc", missing: "_last" } }, { traceId: { order: "asc" } }],
          ...(after ? { search_after: after } : {}),
          _source: { includes: input.sourceIncludes }
        })
      )
    } catch (error) {
      if (!input.isResponseTooLarge(error) || size === 1) throw error
      size = Math.max(1, Math.floor(size / 2))
      continue
    }
    const hits = record(raw.hits).hits
    if (raw.timed_out || Number(record(raw._shards).failed) > 0 || !Array.isArray(hits)) {
      throw new Error("完整会话未加载成功，请重试")
    }
    yield hits.map(record)
    if (hits.length < size) break
    const next = record(hits.at(-1)).sort
    if (!Array.isArray(next) || next.length !== 2) {
      throw new Error("会话分页游标缺失，无法确认完整会话，请重试")
    }
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("会话分页游标未前进，请重试")
    cursors.add(cursor)
    after = next
  }
}
