import { fetchAllAwardCompositeBuckets } from "./dashboard-awards-skill"

/** Resolve all associations, rather than silently keeping the 500 most frequent commits. */
export async function fetchProjectModeCommitIds(
  filters: Record<string, unknown>[],
  execute: (body: Record<string, unknown>) => Promise<unknown>
): Promise<string[]> {
  const buckets = await fetchAllAwardCompositeBuckets(
    {
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: filters } },
      aggs: {
        commits: {
          composite: {
            size: 1000,
            sources: [{ sha: { terms: { field: "properties.commitSha" } } }]
          }
        }
      }
    },
    "commits",
    execute
  )
  const ids = new Set<string>()
  for (const bucket of buckets) {
    const sha = (bucket.key as Record<string, unknown> | undefined)?.sha
    if (typeof sha !== "string" || !sha || ids.has(sha)) {
      throw new Error("项目提交关联查询返回了无效或重复记录，请重试")
    }
    ids.add(sha)
  }
  if (ids.size > 65_536) {
    throw new Error("项目关联提交超过 ES 单次查询上限，请按特性查看提交明细")
  }
  return [...ids]
}
