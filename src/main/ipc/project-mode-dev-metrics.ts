import { isHarnessDevStageNodeName } from "../../shared/harness-stage-bucket"

type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}

/** Used only when the compact page aggregates overflow their historic feature/node limits. */
export async function fetchCompleteProjectDevMetrics(
  ids: string[],
  filters: JsonRecord[],
  execute: (body: JsonRecord) => Promise<unknown>
): Promise<Map<string, { conversations: number; features: number }>> {
  const counts = new Map(ids.map((id) => [id, 0]))
  const features = new Map(ids.map((id) => [id, new Set<string>()]))
  const cursors = new Set<string>()
  let after: JsonRecord | undefined
  for (;;) {
    const raw = record(
      await execute({
        size: 0,
        track_total_hits: false,
        query: { bool: { filter: [...filters, { terms: { harnessProjectId: ids } }] } },
        aggs: {
          dev_metrics: {
            composite: {
              size: 1000,
              sources: [
                { project: { terms: { field: "harnessProjectId" } } },
                { feature: { terms: { field: "harnessFeatureSlug", missing_bucket: true } } },
                { node: { terms: { field: "harnessNodeName", missing_bucket: true } } }
              ],
              ...(after ? { after } : {})
            }
          }
        }
      })
    )
    const page = record(record(raw.aggregations).dev_metrics)
    if (raw.timed_out || Number(record(raw._shards).failed) > 0 || !Array.isArray(page.buckets)) {
      throw new Error("项目研发轮次统计未完整返回，请重试")
    }
    for (const item of page.buckets) {
      const bucket = record(item)
      const key = record(bucket.key)
      const id = String(key.project ?? "")
      if (!counts.has(id)) throw new Error("项目研发统计返回了范围外的项目")
      if (!isHarnessDevStageNodeName(typeof key.node === "string" ? key.node : undefined)) continue
      const count = Number(bucket.doc_count)
      if (!Number.isFinite(count) || count < 0) throw new Error("项目研发统计计数无效")
      counts.set(id, counts.get(id)! + count)
      if (typeof key.feature === "string" && key.feature.trim())
        features.get(id)!.add(key.feature.trim())
    }
    const next = record(page.after_key)
    if (page.buckets.length === 0 || Object.keys(next).length === 0) break
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("项目研发统计分页未前进，请重试")
    cursors.add(cursor)
    after = next
  }
  return new Map(
    ids.map((id) => [id, { conversations: counts.get(id)!, features: features.get(id)!.size }])
  )
}
