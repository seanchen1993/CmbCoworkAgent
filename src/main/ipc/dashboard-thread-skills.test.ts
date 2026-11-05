import { describe, expect, it, vi } from "vitest"
import { fetchThreadSkillUsage } from "./dashboard-thread-skills"
import { summarizeThreadSkills } from "../../shared/dashboard-thread-skills"

type Json = Record<string, unknown>
const record = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {})
const filters = [{ term: { rootThreadId: "root" } }, { term: { upperOrgLv1: "room" } }]
function bucket(skill: string, thread: string | null, extra: Json = {}) {
  return {
    key: { skill, thread },
    doc_count: 2,
    source: {
      hits: {
        hits: [
          {
            _source: {
              traceId: `trace-${thread}`,
              threadId: thread,
              traceKind: "subagent",
              subagentKind: "coordinator_worker",
              ...extra
            }
          }
        ]
      }
    }
  }
}
const response = (buckets: unknown[], after_key?: Json) => ({
  aggregations: { skills: { buckets, ...(after_key ? { after_key } : {}) } }
})

describe("opened thread Skill aggregation", () => {
  it("queries existing indexed fields with permissions and no raw content", async () => {
    const query = vi.fn<(body: Json) => Promise<ReturnType<typeof response>>>(async () =>
      response([bucket("code-v1", "child")])
    )
    const usage = await fetchThreadSkillUsage(filters, query)
    expect(usage).toEqual([
      {
        skill: "code-v1",
        sources: [
          { threadId: "child", traceId: "trace-child", label: "Team Worker", isSubagent: true }
        ]
      }
    ])
    expect(query).toHaveBeenCalledTimes(1)
    const body = record(query.mock.calls[0]?.[0])
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(record(record(body.query).bool).filter).toEqual([
      ...filters,
      { exists: { field: "usedSkills" } }
    ])
    expect(JSON.stringify(body)).not.toContain("_raw")
    const composite = record(record(record(body.aggs).skills).composite)
    expect(composite.size).toBe(200)
    expect(composite.sources).toEqual([
      { skill: { terms: { field: "usedSkills" } } },
      { thread: { terms: { field: "threadId", missing_bucket: true } } }
    ])
  })

  it("collects more than 200 skill/thread pairs with stable cursors and concurrency one", async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      bucket("skill", `child-${String(i).padStart(4, "0")}`)
    )
    let active = 0,
      peak = 0
    const query = vi.fn(async (body: Json) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      const composite = record(record(record(body.aggs).skills).composite)
      const after = record(composite.after)
      const offset =
        typeof after.thread === "string"
          ? rows.findIndex((row) => row.key.thread === after.thread) + 1
          : 0
      const page = rows.slice(offset, offset + Number(composite.size))
      active -= 1
      return response(page, offset + page.length < rows.length ? page.at(-1)?.key : undefined)
    })
    const usage = await fetchThreadSkillUsage(filters, query)
    expect(usage[0].sources).toHaveLength(501)
    expect(usage[0].sources.at(-1)?.threadId).toBe("child-0500")
    expect(query).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
    for (const [body] of query.mock.calls)
      expect(record(record(body.query).bool).filter).toContainEqual(filters[1])
  })

  it("does not count a repeated read on one thread as another source", async () => {
    const usage = await fetchThreadSkillUsage(filters, async () =>
      response([bucket("skill", "child"), bucket("skill", "child"), bucket("skill-v2", "other")])
    )
    expect(usage).toHaveLength(2)
    expect(usage[0].sources).toHaveLength(1)
  })

  it("fails explicitly on a repeated or empty cursor page", async () => {
    const key = { skill: "skill", thread: "child" }
    await expect(
      fetchThreadSkillUsage(filters, async () => response([bucket("skill", "child")], key))
    ).rejects.toThrow("分页未完整返回")
    await expect(fetchThreadSkillUsage(filters, async () => response([], key))).rejects.toThrow(
      "分页未完整返回"
    )
  })

  it.each([
    { timed_out: true },
    { _shards: { failed: 1 } },
    { aggregations: {} },
    response([{ key: { skill: "skill", thread: "child" } }])
  ])("does not present a partial aggregation as an empty summary", async (result) => {
    await expect(fetchThreadSkillUsage(filters, async () => result)).rejects.toThrow()
  })

  it("handles historical traces and missing thread ids without inventing a source id", async () => {
    const usage = await fetchThreadSkillUsage(filters, async () =>
      response([bucket("old", null, { traceKind: undefined, subagentKind: undefined })])
    )
    expect(usage[0].sources[0]).toMatchObject({
      threadId: null,
      label: "主 Agent",
      isSubagent: false
    })
  })

  it.each([
    ["coordinator", "Team 子 Agent"],
    ["workflow", "Workflow 子 Agent"]
  ])(
    "supports existing indexed metadata without detailed worker labels: %s",
    async (executionMode, label) => {
      const usage = await fetchThreadSkillUsage(filters, async () =>
        response([bucket("skill", "child", { subagentKind: undefined, executionMode })])
      )
      expect(usage[0].sources[0]).toMatchObject({ label, isSubagent: true })
    }
  )
})

it("builds the same App-only summary for mocks without mutating actual Trace usage", () => {
  const traces = [
    { traceId: "root", threadId: "root", usedSkills: [] },
    { traceId: "a", threadId: "child", usedSkills: ["skill"], subagentKind: "coordinator_worker" },
    { traceId: "b", threadId: "child", usedSkills: ["skill"], subagentKind: "coordinator_worker" }
  ]
  expect(summarizeThreadSkills(traces)).toHaveLength(1)
  expect(summarizeThreadSkills(traces)[0].sources).toHaveLength(1)
  expect(traces[0].usedSkills).toEqual([])
})
