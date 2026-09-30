import { describe, expect, it, vi } from "vitest"
import {
  buildAwardSkillMatchFilter,
  countAwardDistinctSkills,
  fetchAllAwardCompositeBuckets,
  groupAwardSkillCandidates,
  mapAwardBatches,
  readCompleteAwardAggregation
} from "./dashboard-awards-skill"

const body = {
  size: 0,
  query: { term: { upperOrgLv1: "room" } },
  aggs: {
    users: {
      composite: { size: 100, sources: [{ user: { terms: { field: "ystId" } } }] },
      aggs: { calls: { sum: { field: "totalToolCalls" } } }
    }
  }
}

describe("award skill candidates", () => {
  it("queries all candidates, including skills past the old 300 limit, with bounded concurrency", async () => {
    const candidates = groupAwardSkillCandidates(
      Array.from({ length: 751 }, (_, i) => `skill-item${i}`)
    )
    expect(candidates).toHaveLength(751)
    let running = 0
    let peak = 0
    const results = await mapAwardBatches(candidates, 100, async (batch) => {
      running += 1
      peak = Math.max(peak, running)
      await Promise.resolve()
      running -= 1
      expect(batch.length).toBeLessThanOrEqual(100)
      return batch.map((item) => item.key)
    })
    expect(results.flat()).toEqual(candidates.map((item) => item.key))
    expect(peak).toBe(2)
  })

  it("groups versions, casing, package names and dollar prefixes consistently with the renderer", () => {
    const names = [
      "$Code-Review-v1.zip",
      "code-review-v1.2",
      "code-review-2.3.4-beta.tgz",
      "code-review-v3.2.1.0.md",
      "code-review",
      "",
      "  "
    ]
    const candidates = groupAwardSkillCandidates(names)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].key).toBe("code-review")
  })

  it("matches versions without including unrelated skills sharing the prefix", () => {
    const [candidate] = groupAwardSkillCandidates(["code.review-v3"])
    const filter = buildAwardSkillMatchFilter(candidate, ["usedSkills", "usedSkills.keyword"]) as {
      bool: { should: Array<Record<string, Record<string, string>>> }
    }
    // Lucene regex queries match the entire term; evaluate these simple expressions likewise.
    const matches = (name: string): boolean =>
      filter.bool.should.some((clause) =>
        clause.term
          ? Object.values(clause.term).includes(name)
          : Object.values(clause.regexp).some((pattern) =>
              new RegExp(`^(?:${pattern})$`).test(name)
            )
      )
    for (const name of [
      "code.review",
      "code.review-v1",
      "code.review-V2.3",
      "code.review-1.2.3",
      "code.review-v3.1.2-beta"
    ])
      expect(matches(name), name).toBe(true)
    for (const name of [
      "code.review-helper",
      "code.review-vendor",
      "codeXreview-v1",
      "code.review-helper-v1"
    ])
      expect(matches(name), name).toBe(false)
  })

  it("does not return partial results when a later batch fails", async () => {
    await expect(
      mapAwardBatches([1, 2, 3], 1, async ([value]) => {
        if (value === 3) throw new Error("ES unavailable")
        return value
      })
    ).rejects.toThrow("ES unavailable")
  })

  it("rejects an invalid batch size", async () => {
    await expect(mapAwardBatches([1], 0, async () => 1)).rejects.toThrow("batch size")
  })
})

describe("complete award pagination", () => {
  it("follows ES after_key across all pages and preserves scope and subaggregations", async () => {
    const input = structuredClone(body)
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        aggregations: {
          users: {
            buckets: [{ key: { user: "u1" }, doc_count: 7 }],
            after_key: { user: "cursor-is-not-the-last-bucket" }
          }
        }
      })
      .mockResolvedValueOnce({
        aggregations: { users: { buckets: [{ key: { user: "u2" }, doc_count: 3 }] } }
      })
    const buckets = await fetchAllAwardCompositeBuckets(body, "users", execute)
    expect(buckets.map((bucket) => bucket.key)).toEqual([{ user: "u1" }, { user: "u2" }])
    expect(execute.mock.calls[1][0]).toEqual({
      ...body,
      aggs: {
        users: {
          ...body.aggs.users,
          composite: {
            ...body.aggs.users.composite,
            after: { user: "cursor-is-not-the-last-bucket" }
          }
        }
      }
    })
    expect(body).toEqual(input)
  })

  it("rejects a repeated cursor instead of displaying an incomplete ranking", async () => {
    const execute = vi.fn().mockResolvedValue({
      aggregations: { users: { buckets: [{ key: { user: "u" } }], after_key: { user: "u" } } }
    })
    await expect(fetchAllAwardCompositeBuckets(body, "users", execute)).rejects.toThrow(
      "分页未前进"
    )
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, {}])(
    "rejects incomplete responses: %j",
    async (response) => {
      const execute = vi.fn().mockResolvedValue(response)
      await expect(fetchAllAwardCompositeBuckets(body, "users", execute)).rejects.toThrow(
        "评奖查询"
      )
    }
  )

  it("accepts a complete empty aggregation", async () => {
    await expect(
      fetchAllAwardCompositeBuckets(body, "users", async () => ({
        aggregations: { users: { buckets: [] } }
      }))
    ).resolves.toEqual([])
  })

  it("also rejects partial named-filter aggregations", () => {
    expect(() =>
      readCompleteAwardAggregation(
        { timed_out: true, aggregations: { by_skill: { buckets: {} } } },
        "by_skill"
      )
    ).toThrow("未完整")
  })
})

it("counts different versions only once per user or team", () => {
  const counts = countAwardDistinctSkills(
    [
      { key: { user: "u1", skill: "skill-v1.0" } },
      { key: { user: "u1", skill: "$SKILL-2.0.0" } },
      { key: { user: "u1", skill: "another-v3" } },
      { key: { user: "u2", skill: "skill-v2.0" } },
      { key: { user: "u2", skill: "" } }
    ],
    (key) => String(key.user)
  )
  expect(Object.fromEntries(counts)).toEqual({ u1: 2, u2: 1 })
})
