import { describe, expect, it, vi } from "vitest"
import { buildUserProfileIdFilter, fetchUserProfileDirectory } from "./dashboard-user-profile-query"

type JsonRecord = Record<string, unknown>
const record = (value: unknown): JsonRecord => value as JsonRecord
function request(body: JsonRecord) {
  const filter = record(record(body.query).bool).filter as JsonRecord[]
  const clauses = record(filter[0].bool).should as JsonRecord[]
  return {
    ids: record(clauses[0].terms).sapId as string[],
    embedded: clauses.some((clause) => clause.wildcard),
    composite: record(record(record(body.aggs).by_sap).composite)
  }
}

describe("bounded user profile queries", () => {
  it("uses only two exact terms clauses even for 500 users", () => {
    const ids = Array.from({ length: 500 }, (_, i) => String(80300000 + i))
    const filter = buildUserProfileIdFilter(ids) as { bool: { should: unknown[] } }
    expect(filter.bool.should).toHaveLength(2)
    expect(filter.bool.should[0]).toEqual({ terms: { sapId: ids } })
    expect(filter.bool.should[1]).toEqual({ terms: { "sapId.keyword": ids } })
  })

  it("preserves exact IDs, historic embedded IDs and literal wildcard characters", () => {
    expect(buildUserProfileIdFilter(["80300001", "a*?\\b"], true)).toEqual({
      bool: {
        should: [
          { terms: { sapId: ["80300001", "a*?\\b"] } },
          { terms: { "sapId.keyword": ["80300001", "a*?\\b"] } },
          { wildcard: { sapId: "*80300001*" } },
          { wildcard: { "sapId.keyword": "*80300001*" } },
          { wildcard: { sapId: "*a\\*\\?\\\\b*" } },
          { wildcard: { "sapId.keyword": "*a\\*\\?\\\\b*" } }
        ],
        minimum_should_match: 1
      }
    })
    expect(buildUserProfileIdFilter([])).toEqual({ match_none: {} })
  })

  it.each([500, 601])(
    "looks up all %i known users in batches with at most two requests active",
    async (count) => {
      let active = 0,
        peak = 0
      const execute = vi.fn(async (body: JsonRecord) => {
        active++
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        active--
        const { ids, embedded, composite } = request(body)
        expect(ids.length).toBeLessThanOrEqual(100)
        expect(embedded).toBe(false)
        expect(composite.size).toBe(100)
        expect(body.size).toBe(0)
        expect(body.track_total_hits).toBe(false)
        expect(JSON.stringify(body)).not.toContain('"_raw"')
        if (composite.after) return { items: [], afterKey: null }
        return {
          items: ids.map((sapId) => ({ sapId, userName: `user-${sapId}` })),
          afterKey: ids.length === 100 ? { sapId: ids.at(-1) } : null
        }
      })
      const ids = Array.from({ length: count }, (_, i) => String(80300000 + i))
      const result = await fetchUserProfileDirectory(ids, execute)
      expect(result.items).toHaveLength(count)
      expect(execute).toHaveBeenCalledTimes(Math.floor(count / 100) * 2 + (count % 100 ? 1 : 0))
      expect(peak).toBe(2)
    }
  )

  it("skips wildcard work for resolved aliases and normalizes marketplace identity strings", async () => {
    const execute = vi.fn(async (body: JsonRecord) => {
      expect(request(body).ids).toEqual(["80300001", "300001"])
      return { items: [{ sapId: "80300001", userName: "张三" }] }
    })
    await fetchUserProfileDirectory(["80300001/张三/部门", "80300001", "300001"], execute)
    expect(execute).toHaveBeenCalledTimes(1)
    await fetchUserProfileDirectory([], execute)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("keeps all-legacy requests bounded to 20 IDs per wildcard batch", async () => {
    let active = 0,
      peak = 0
    const execute = vi.fn(async (body: JsonRecord) => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active--
      const { ids, embedded } = request(body)
      expect(ids.length).toBeLessThanOrEqual(embedded ? 20 : 100)
      return { items: embedded ? ids.map((id) => ({ sapId: `姓名${id}/部门` })) : [] }
    })
    const result = await fetchUserProfileDirectory(
      Array.from({ length: 500 }, (_, i) => String(80300000 + i)),
      execute
    )
    expect(result.items).toHaveLength(500)
    expect(execute).toHaveBeenCalledTimes(30)
    expect(peak).toBe(2)
  })

  it("paginates every legacy profile, retaining the server cursor rather than the last bucket", async () => {
    const execute = vi.fn(async (body: JsonRecord) => {
      const { embedded, composite } = request(body)
      if (!embedded) return { items: [] }
      if (!composite.after)
        return { items: [{ sapId: "first-u1" }], afterKey: { sapId: "server-u1" } }
      expect(composite.after).toEqual({ sapId: "server-u1" })
      return { items: [{ sapId: "last-u1" }] }
    })
    const result = await fetchUserProfileDirectory(["u1"], execute)
    expect(result.items.map((item) => item.sapId)).toEqual(["first-u1", "last-u1"])
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("rejects repeated or malformed cursors and propagates failed batches", async () => {
    const repeat = vi.fn().mockResolvedValue({ items: [{ sapId: "u" }], afterKey: { sapId: "u" } })
    await expect(fetchUserProfileDirectory(["u"], repeat)).rejects.toThrow("未前进")
    await expect(
      fetchUserProfileDirectory(
        ["u"],
        vi.fn().mockResolvedValue({ items: [{ sapId: "u" }], afterKey: { invalid: "x" } })
      )
    ).rejects.toThrow("游标无效")
    await expect(
      fetchUserProfileDirectory(["u"], vi.fn().mockRejectedValue(new Error("timeout")))
    ).rejects.toThrow("timeout")
  })
})
