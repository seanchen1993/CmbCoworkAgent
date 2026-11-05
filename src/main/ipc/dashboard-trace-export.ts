type JsonRecord = Record<string, unknown>

export interface TraceExportRecord {
  traceId: string
  threadId: string
  rootThreadId?: string
  parentThreadId?: string
  rawAvailable?: boolean
  rawPending?: boolean
}

const EXPORT_CHUNK_SIZE = 10
const EXPORT_CONTENT_BYTE_LIMIT = 64 * 1024 * 1024
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** Load only the selected page, in small sequential batches. Never export preview DTOs. */
export async function loadTraceExportDetails<T extends TraceExportRecord>(input: {
  previews: T[]
  viewMode: "thread" | "trace"
  filters: JsonRecord[]
  sourceIncludes: string[]
  query: (body: JsonRecord) => Promise<unknown>
  normalize: (hit: JsonRecord) => T
  isResponseTooLarge: (error: unknown) => boolean
}): Promise<T[]> {
  const requested = new Set(input.previews.map((trace) => text(trace.traceId)).filter(Boolean))
  if (!requested.size || requested.size !== input.previews.length) {
    throw new Error("导出记录标识缺失或重复，请刷新列表后重试")
  }
  const threads = new Set<string>()
  const traceIds: string[] = []
  for (const trace of input.previews) {
    const thread = text(trace.rootThreadId) || text(trace.threadId)
    if (input.viewMode === "thread" && thread && thread !== "unknown-thread") threads.add(thread)
    else traceIds.push(trace.traceId)
  }
  if ((input.viewMode === "thread" ? threads.size + traceIds.length : traceIds.length) > 50) {
    throw new Error("导出范围超过一页，请刷新列表后重试")
  }
  const selection: JsonRecord[] = []
  if (threads.size) {
    for (const field of ["threadId", "rootThreadId", "parentThreadId"])
      selection.push({ terms: { [field]: [...threads] } })
  }
  if (traceIds.length) selection.push({ terms: { traceId: traceIds } })
  const filters = [...input.filters, { bool: { should: selection, minimum_should_match: 1 } }]
  const traces = new Map<string, T>()
  const cursors = new Set<string>()
  let bytes = 0
  let size = EXPORT_CHUNK_SIZE
  let after: unknown[] | undefined
  for (;;) {
    let raw: JsonRecord
    try {
      raw = record(
        await input.query({
          size,
          track_total_hits: false,
          query: { bool: { filter: filters } },
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
      throw new Error("完整会话未加载成功，导出已取消，请重试")
    }
    for (const hit of hits) {
      const trace = input.normalize(record(hit))
      if (!trace.traceId || trace.rawPending || trace.rawAvailable !== true) {
        throw new Error(`会话记录 ${trace.traceId || "未知"} 缺少完整内容，无法导出，请刷新后重试`)
      }
      const inScope =
        requested.has(trace.traceId) ||
        [trace.rootThreadId, trace.threadId, trace.parentThreadId].some(
          (id) => id && threads.has(id)
        )
      if (!inScope) throw new Error("导出查询返回了范围外的会话记录")
      if (traces.has(trace.traceId)) continue
      bytes += Buffer.byteLength(JSON.stringify(trace), "utf8")
      if (bytes > EXPORT_CONTENT_BYTE_LIMIT) {
        throw new Error("本页完整会话内容过大，请缩小导出范围或切换 Trace 视图后重试")
      }
      traces.set(trace.traceId, trace)
    }
    if (hits.length < size) break
    const next = record(hits.at(-1)).sort
    if (!Array.isArray(next) || next.length !== 2) {
      throw new Error("导出分页游标缺失，无法确认完整会话，请重试")
    }
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("导出分页游标未前进，请重试")
    cursors.add(cursor)
    after = next
  }
  if ([...requested].some((id) => !traces.has(id))) {
    throw new Error("部分会话记录已变化或无权读取，请刷新列表后重试")
  }
  if (input.viewMode === "trace") return input.previews.map((trace) => traces.get(trace.traceId)!)
  // Preserve the page's thread order; each thread's content is chronological.
  const order = new Map([...threads].map((id, index) => [id, index]))
  const groupOrder = (trace: T): number => {
    for (const id of [trace.rootThreadId, trace.threadId, trace.parentThreadId]) {
      if (id && order.has(id)) return order.get(id)!
    }
    return order.size
  }
  return [...traces.values()].sort((a, b) => groupOrder(a) - groupOrder(b))
}
