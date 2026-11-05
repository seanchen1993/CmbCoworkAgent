import { threadSkillSource, type DashboardThreadSkill } from "../../shared/dashboard-thread-skills"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}

/** Only one selected thread. Indexed aggregation, 200 skill/thread pairs per
 * page, one request at a time. No Trace bodies, per-Trace lookups or time limit. */
export async function fetchThreadSkillUsage(
  filters: Json[],
  query: (body: Json) => Promise<unknown>
): Promise<DashboardThreadSkill[]> {
  const skills = new Map<string, Map<string, ReturnType<typeof threadSkillSource>>>()
  const seenCursors = new Set<string>()
  let after: Json | undefined
  for (;;) {
    const raw = await query({
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: [...filters, { exists: { field: "usedSkills" } }] } },
      aggs: {
        skills: {
          composite: {
            size: 200,
            sources: [
              { skill: { terms: { field: "usedSkills" } } },
              { thread: { terms: { field: "threadId", missing_bucket: true } } }
            ],
            ...(after ? { after } : {})
          },
          aggs: {
            source: {
              top_hits: {
                size: 1,
                sort: [{ startedAt: { order: "asc" } }],
                _source: {
                  includes: [
                    "threadId",
                    "traceId",
                    "traceKind",
                    "executionMode",
                    "parentTraceId",
                    "parentThreadId",
                    "subagentKind",
                    "coordinatorWorkerRole",
                    "coordinatorWorkerId",
                    "workflowAgentLabel"
                  ]
                }
              }
            }
          }
        }
      }
    })
    assertProjectModeResultComplete(raw)
    const agg = record(record(record(raw).aggregations).skills)
    if (!Array.isArray(agg.buckets)) throw new Error("会话技能汇总未完整返回")
    for (const value of agg.buckets) {
      const bucket = record(value)
      const key = record(bucket.key)
      if (typeof key.skill !== "string" || !key.skill.trim())
        throw new Error("会话技能汇总缺少技能标识")
      const hits = record(record(bucket.source).hits).hits
      if (!Array.isArray(hits) || hits.length !== 1 || !record(hits[0])._source)
        throw new Error("会话技能汇总缺少读取来源")
      const source = record(record(Array.isArray(hits) ? hits[0] : null)._source)
      const fields = Object.fromEntries(
        Object.entries(source).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
      if (typeof key.thread === "string") fields.threadId = key.thread
      const actor = threadSkillSource(fields)
      let sources = skills.get(key.skill)
      if (!sources) skills.set(key.skill, (sources = new Map()))
      sources.set(actor.threadId ?? "unknown", actor)
    }
    const next = record(agg.after_key)
    if (Object.keys(next).length === 0) break
    const signature = JSON.stringify(next)
    if (seenCursors.has(signature) || agg.buckets.length === 0)
      throw new Error("会话技能汇总分页未完整返回，请重试")
    seenCursors.add(signature)
    after = next
  }
  return Array.from(skills, ([skill, sources]) => ({ skill, sources: [...sources.values()] })).sort(
    (a, b) => a.skill.localeCompare(b.skill)
  )
}
