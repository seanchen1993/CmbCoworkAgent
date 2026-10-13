import { describe, expect, it, vi } from "vitest"
import {
  buildRecentConstraintFileQuery,
  fetchRecentConstraintFiles,
  resolveRecentConstraintFields,
  type RecentConstraintFields
} from "./dashboard-recent-constraint-files"

const fields: RecentConstraintFields = {
  file: "properties.constraintFiles",
  pluginId: "properties.pluginId",
  pluginName: "properties.pluginName",
  adapterName: "properties.harnessAdapterName",
  lastReadAt: "properties.lastReadAt"
}
const now = new Date("2026-10-15T04:00:00.000Z")
const org = { term: { upperOrgLv1: "本室" } }
const response = (
  keys: Record<string, unknown>[],
  after?: Record<string, unknown>,
  truncated = 0
) => ({
  aggregations: {
    files: {
      buckets: keys.map((key) => ({ key, doc_count: 100 })),
      ...(after ? { after_key: after } : {})
    },
    truncated_files: { doc_count: truncated }
  }
})
const capability = (type: string, extra: Record<string, unknown> = {}) => ({
  [type]: { type, searchable: true, aggregatable: true, ...extra }
})

describe("existing constraint-field compatibility", () => {
  it("uses native keywords and date fields without scripts", () => {
    expect(
      resolveRecentConstraintFields({
        fields: {
          "properties.constraintFiles": capability("keyword"),
          "properties.pluginId": capability("keyword"),
          "properties.pluginName": capability("constant_keyword"),
          "properties.lastReadAt": capability("date", { non_searchable_indices: [] })
        }
      })
    ).toEqual({ ...fields, adapterName: undefined })
  })
  it("resolves legacy text keyword subfields and uses event time when lastReadAt is not a date", () => {
    const resolved = resolveRecentConstraintFields({
      fields: {
        "properties.constraintFiles": capability("text", { aggregatable: false }),
        "properties.constraintFiles.keyword": capability("keyword"),
        "properties.pluginId.keyword": capability("keyword"),
        "properties.lastReadAt": capability("keyword")
      }
    })
    expect(resolved.file).toBe("properties.constraintFiles.keyword")
    expect(resolved.pluginId).toBe("properties.pluginId.keyword")
    expect(resolved.lastReadAt).toBeUndefined()
    expect(JSON.stringify(buildRecentConstraintFileQuery(resolved, [], now))).not.toContain(
      "lastReadAt"
    )
  })
  it("handles an empty new index and rejects unusable or malformed field metadata", () => {
    expect(resolveRecentConstraintFields({ fields: {} }).file).toBe("properties.constraintFiles")
    expect(() => resolveRecentConstraintFields({})).toThrow()
    expect(() =>
      resolveRecentConstraintFields({
        fields: {
          "properties.constraintFiles": capability("text", { aggregatable: false })
        }
      })
    ).toThrow("字段不支持")
    expect(
      resolveRecentConstraintFields({
        fields: {
          "properties.constraintFiles": capability("keyword"),
          "properties.lastReadAt": { ...capability("date"), ...capability("keyword") }
        }
      }).lastReadAt
    ).toBeUndefined()
  })
})

describe("recent constraint queries", () => {
  it("fixes a rolling 14-day window, applies permissions before aggregation and falls back only for missing lastReadAt", () => {
    const query = buildRecentConstraintFileQuery(fields, [org], now)
    expect(query).toMatchObject({
      size: 0,
      track_total_hits: false,
      query: {
        bool: {
          filter: [
            { term: { eventName: "harness.system_constraint.read_summary" } },
            { exists: { field: "properties.harnessProjectId" } },
            { range: { "properties.successfulReadCount": { gt: 0 } } },
            {
              bool: {
                should: [
                  {
                    range: {
                      "properties.lastReadAt": {
                        gte: "2026-10-01T04:00:00.000Z",
                        lte: now.toISOString()
                      }
                    }
                  },
                  {
                    bool: {
                      must_not: [{ exists: { field: "properties.lastReadAt" } }],
                      filter: [
                        {
                          range: {
                            eventTime: { gte: "2026-10-01T04:00:00.000Z", lte: now.toISOString() }
                          }
                        }
                      ]
                    }
                  }
                ],
                minimum_should_match: 1
              }
            },
            org
          ]
        }
      }
    })
    const serialized = JSON.stringify(query)
    expect(serialized).not.toContain("_raw")
    expect(serialized).not.toContain("script")
    expect(serialized).not.toContain("distinctFileCount")
    expect(serialized).not.toContain("lifecycleCreatedAt")
  })
  it("keeps all 1,200 distinct files across stable pages, requests only keys and never runs pages concurrently", async () => {
    let active = 0
    let peak = 0
    const calls: Record<string, unknown>[] = []
    const query = vi.fn(async (body: Record<string, unknown>) => {
      active++
      peak = Math.max(peak, active)
      calls.push(body)
      const index = calls.length - 1
      const size = index === 2 ? 200 : 500
      await Promise.resolve()
      active--
      return response(
        Array.from({ length: size }, (_, offset) => ({
          pluginId: "plugin-a",
          file: `sys/${index * 500 + offset}.md`
        })),
        index < 2 ? { pluginId: "plugin-a", file: `sys/page-${index}` } : undefined
      )
    })
    expect(await fetchRecentConstraintFiles(fields, [org], query, undefined, now)).toEqual({
      fileCount: 1200,
      complete: true
    })
    expect(query).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
    for (const body of calls) {
      expect(body.size).toBe(0)
      expect(body._source).toBeUndefined()
      expect(body).toMatchObject({ aggs: { files: { composite: { size: 500 } } } })
    }
  })
})

describe("reported file identities", () => {
  it("deduplicates repeated reads across projects, users, stages and agents, while keeping different plugins separate", async () => {
    const query = vi.fn().mockResolvedValue(
      response([
        { pluginId: "a", pluginName: "插件A", file: "sys/project.md" },
        { pluginId: "a", adapterName: "插件A", file: "sys/project.md" },
        { pluginId: "b", pluginName: "插件B", file: "sys/project.md" },
        { pluginId: "a", file: "sys/rules.md" }
      ])
    )
    expect(await fetchRecentConstraintFiles(fields, [], query)).toEqual({
      fileCount: 3,
      complete: true
    })
  })
  it("joins historic name-only records to an unambiguous current plugin ID across pages", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          [
            { pluginName: "插件A", file: "sys/project.md" },
            { adapterName: "插件A", file: "sys/rules.md" }
          ],
          { file: "page-one" }
        )
      )
      .mockResolvedValueOnce(
        response([
          { pluginId: "a", pluginName: "插件A", adapterName: "插件A", file: "sys/project.md" }
        ])
      )
    expect(await fetchRecentConstraintFiles(fields, [], query)).toEqual({
      fileCount: 2,
      complete: true
    })
  })
  it("marks incomplete or ambiguous history as a lower bound instead of inventing a plugin identity", async () => {
    const query = vi
      .fn()
      .mockResolvedValue(
        response([
          { pluginId: "a", pluginName: "同名插件", file: "sys/project.md" },
          { pluginId: "b", pluginName: "同名插件", file: "sys/project.md" },
          { pluginName: "同名插件", file: "sys/legacy.md" },
          { file: "sys/missing-plugin.md" },
          { pluginId: "a", file: null }
        ])
      )
    expect(await fetchRecentConstraintFiles(fields, [], query)).toEqual({
      fileCount: 2,
      complete: false
    })
  })
  it("keeps a true zero distinct from truncated reports", async () => {
    expect(
      await fetchRecentConstraintFiles(fields, [], vi.fn().mockResolvedValue(response([])))
    ).toEqual({ fileCount: 0, complete: true })
    expect(
      await fetchRecentConstraintFiles(
        fields,
        [],
        vi.fn().mockResolvedValue(response([], undefined, 1))
      )
    ).toEqual({ fileCount: 0, complete: false })
  })
})

describe("query completion", () => {
  it.each([{ timed_out: true }, { _shards: { failed: 1 } }, { aggregations: {} }])(
    "rejects incomplete ES results",
    async (raw) => {
      await expect(
        fetchRecentConstraintFiles(fields, [], vi.fn().mockResolvedValue(raw))
      ).rejects.toThrow()
    }
  )
  it("rejects repeated cursors instead of silently returning a partial count", async () => {
    const query = vi
      .fn()
      .mockResolvedValue(response([{ pluginId: "a", file: "sys/a.md" }], { file: "same" }))
    await expect(fetchRecentConstraintFiles(fields, [], query)).rejects.toThrow("游标")
    expect(query).toHaveBeenCalledTimes(2)
  })
  it("does not issue requests after cancellation", async () => {
    const controller = new AbortController()
    controller.abort()
    const query = vi.fn()
    await expect(fetchRecentConstraintFiles(fields, [], query, controller.signal)).rejects.toThrow(
      "cancelled"
    )
    expect(query).not.toHaveBeenCalled()
  })
  it("rejects malformed cursors instead of stopping after the first page", async () => {
    const raw = {
      aggregations: {
        files: {
          buckets: [{ key: { pluginId: "a", file: "sys/a.md" } }],
          after_key: "invalid"
        }
      }
    }
    await expect(
      fetchRecentConstraintFiles(fields, [], vi.fn().mockResolvedValue(raw))
    ).rejects.toThrow("游标无效")
  })
})
