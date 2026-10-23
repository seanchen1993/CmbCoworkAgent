import { describe, expect, it, vi } from "vitest"
import {
  buildKnowledgeFileReadersQuery,
  fetchKnowledgeFileReaders,
  mergeKnowledgeReaders,
  normalizeKnowledgeReadFileRef,
  resolveKnowledgeReaderFields
} from "./dashboard-knowledge-readers"

const fields = {
  file: "properties.constraintFiles",
  pluginId: "properties.pluginId",
  pluginName: "properties.pluginName",
  adapterName: "properties.harnessAdapterName",
  lastReadAt: "properties.lastReadAt"
}
const users = {
  sapId: "sapId",
  ystId: "ystId",
  userName: "userName",
  room: "upperOrgLv1",
  group: "upperOrgLv0"
}
const file = {
  pluginId: "p",
  pluginName: "插件P",
  filePath: "sys/project.md",
  pluginAliases: ["插件P", "旧插件名"]
}
const org = { term: { upperOrgLv1: "甲室" } }
const now = new Date("2026-10-15T04:00:00Z")
const response = (keys: Record<string, unknown>[], after?: Record<string, unknown>) => ({
  aggregations: {
    readers: { buckets: keys.map((key) => ({ key })), ...(after ? { after_key: after } : {}) }
  }
})

describe("knowledge reader fields and exact selection", () => {
  it("uses native/legacy keyword fields without enabling fielddata, including missing IDs", () => {
    expect(
      resolveKnowledgeReaderFields({
        fields: {
          sapId: { keyword: { type: "keyword", aggregatable: true } },
          userName: { text: { type: "text", aggregatable: false } },
          "userName.keyword": { keyword: { type: "keyword", aggregatable: true } },
          ystId: {
            keyword: {
              type: "keyword",
              aggregatable: true,
              non_aggregatable_indices: ["bad-index"]
            }
          }
        }
      })
    ).toEqual({ sapId: "sapId", userName: "userName.keyword" })
    expect(() => buildKnowledgeFileReadersQuery(fields, {}, file, [org], now)).toThrow("读取人字段")
  })
  it("keeps time/permission/file/plugin filters in ES and requests aggregate keys only", () => {
    const query = buildKnowledgeFileReadersQuery(fields, users, file, [org], now)
    expect(query).toMatchObject({
      size: 0,
      track_total_hits: false,
      aggs: { readers: { composite: { size: 500, sources: expect.any(Array) } } }
    })
    const serialized = JSON.stringify(query)
    for (const token of [
      "甲室",
      "sys/project.md",
      "harness.system_constraint.read_summary",
      "2026-09-15T04:00:00.000Z",
      '"properties.pluginId":"p"',
      "旧插件名"
    ])
      expect(serialized).toContain(token)
    expect(serialized).not.toMatch(/_source|_raw|top_hits|script|fielddata/)
    expect(query).toMatchObject({
      query: {
        bool: {
          filter: expect.arrayContaining([
            { term: { "properties.constraintFiles": "sys/project.md" } }
          ])
        }
      }
    })
  })
  it("does not join ambiguous plugin aliases or records with a different explicit ID", () => {
    const serialized = JSON.stringify(
      buildKnowledgeFileReadersQuery(fields, users, { ...file, pluginAliases: [] }, [], now)
    )
    expect(serialized).not.toContain("旧插件名")
    expect(serialized).not.toContain("插件P")
    const withAliases = JSON.stringify(buildKnowledgeFileReadersQuery(fields, users, file, [], now))
    expect(withAliases).toContain('"must_not":[{"exists":{"field":"properties.pluginId"}}]')
    expect(withAliases).toContain('"must_not":[{"exists":{"field":"properties.pluginName"}}]')
  })
  it("validates file selection and ignores caller-supplied aliases", () => {
    expect(normalizeKnowledgeReadFileRef({ ...file, pluginAliases: ["untrusted"] })).toEqual({
      pluginId: "p",
      pluginName: "插件P",
      filePath: "sys/project.md"
    })
    expect(() => normalizeKnowledgeReadFileRef({ pluginId: "p" })).toThrow()
    expect(() => normalizeKnowledgeReadFileRef({ filePath: "sys/project.md" })).toThrow()
  })
})

describe("reader identity and department merging", () => {
  it("keeps the latest read time when SAP, YST and historical names join across stages", () => {
    const data = mergeKnowledgeReaders([
      { sapId: "8031", ystId: "123", userName: "张三", lastReadAt: "2026-10-12T20:00:00+08:00" },
      { ystId: "123", userName: "张三", lastReadAt: "2026-10-13T12:00:00Z" },
      { userName: "张三", lastReadAt: "2026-10-14T12:00:00Z" },
      { sapId: "8032", userName: "李四", lastReadAt: "2026-10-15T01:00:00Z" },
      { sapId: "8033", userName: "无时间", lastReadAt: "bad" }
    ])
    expect(data.items.map((row) => [row.sapId, row.lastReadAt])).toEqual([
      ["8032", "2026-10-15T01:00:00.000Z"],
      ["8031", "2026-10-14T12:00:00.000Z"],
      ["8033", undefined]
    ])
  })
  it("deduplicates main/child/stage records and joins SAP, YST-only and unambiguous old names", () => {
    const data = mergeKnowledgeReaders([
      { sapId: "8031", ystId: "123", userName: "张三", room: "甲室", group: "A组" },
      { sapId: "8031", ystId: "123", userName: "张三", room: "甲室", group: "A组" },
      { ystId: "123", userName: "张三", room: "甲室", group: "B组" },
      { userName: "张三", room: "乙室", group: "C组" }
    ])
    expect(data).toEqual({
      items: [
        {
          key: '["sap","8031"]',
          sapId: "8031",
          ystId: "123",
          userName: "张三",
          departments: ["乙室 / C组", "甲室 / A组", "甲室 / B组"].sort(),
          nameOnly: false
        }
      ],
      hasUnknownReaders: false
    })
  })
  it("never merges different same-name accounts or invents an extra person for ambiguous name-only records", () => {
    const data = mergeKnowledgeReaders([
      { sapId: "a", userName: "同名" },
      { sapId: "b", userName: "同名" },
      { userName: "同名" },
      { userName: "仅有姓名", room: "甲室" },
      { userName: "仅有姓名", room: "乙室" },
      { sapId: "unknown", userName: "unknown" },
      { userName: "[trace budget exhausted]" }
    ])
    expect(data.items).toHaveLength(3)
    expect(
      data.items
        .filter((row) => !row.nameOnly)
        .map((row) => row.sapId)
        .sort()
    ).toEqual(["a", "b"])
    expect(data.items.find((row) => row.nameOnly)).toMatchObject({
      userName: "仅有姓名",
      departments: ["乙室", "甲室"].sort()
    })
    expect(data.hasUnknownReaders).toBe(true)
  })
  it("keeps conflicting account aliases separate and accepts absent names/departments", () => {
    const data = mergeKnowledgeReaders([
      { sapId: "a", ystId: "1" },
      { sapId: "b", ystId: "1" },
      { ystId: "1", userName: "待确认" },
      { ystId: "2" }
    ])
    expect(data.items).toHaveLength(3)
    expect(data.hasUnknownReaders).toBe(true)
    expect(data.items.find((row) => row.ystId === "2")).toMatchObject({
      userName: "",
      departments: [],
      nameOnly: false
    })
    expect(mergeKnowledgeReaders([])).toEqual({ items: [], hasUnknownReaders: false })
  })
})

describe("reader aggregation pagination", () => {
  it("returns the latest per-reader timestamp from the existing aggregate response", async () => {
    const query = vi.fn().mockResolvedValue({
      aggregations: {
        readers: {
          buckets: [
            {
              key: { sapId: "8031", userName: "张三" },
              latest_read: { value: Date.parse("2026-10-13T04:00:00Z") },
              fallback_read: { latest_read: { value: Date.parse("2026-10-15T04:00:00Z") } }
            }
          ]
        }
      }
    })
    const data = await fetchKnowledgeFileReaders(
      { ...fields, lastReadAtAggregation: "properties.lastReadAt" },
      users,
      file,
      [org],
      query,
      undefined,
      now
    )
    expect(data.items[0].lastReadAt).toBe("2026-10-15T04:00:00.000Z")
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatchObject({
      size: 0,
      aggs: { readers: { aggs: { latest_read: { max: { field: "properties.lastReadAt" } } } } }
    })
  })
  it("keeps all 1,200 users over sequential 500-key pages with filters on every page", async () => {
    let active = 0
    let peak = 0
    const calls: Record<string, unknown>[] = []
    const query = vi.fn(async (body: Record<string, unknown>) => {
      active++
      peak = Math.max(active, peak)
      const page = calls.length
      calls.push(body)
      await Promise.resolve()
      active--
      return response(
        Array.from({ length: page < 2 ? 500 : 200 }, (_, i) => ({
          sapId: String(page * 500 + i),
          userName: "用户"
        })),
        page < 2 ? { sapId: String(page * 500 + 499) } : undefined
      )
    })
    const data = await fetchKnowledgeFileReaders(fields, users, file, [org], query, undefined, now)
    expect(data.items).toHaveLength(1200)
    expect(peak).toBe(1)
    expect(query).toHaveBeenCalledTimes(3)
    expect(calls[1]).toMatchObject({
      aggs: { readers: { composite: { after: { sapId: "499" } } } }
    })
    expect(
      calls.every((body) => body.size === 0 && JSON.stringify(body.query).includes("甲室"))
    ).toBe(true)
  })
  it.each([
    { timed_out: true },
    { _shards: { failed: 1 } },
    { aggregations: {} },
    { aggregations: { readers: { buckets: [], after_key: "bad" } } }
  ])("rejects partial and malformed responses", async (raw) => {
    await expect(
      fetchKnowledgeFileReaders(fields, users, file, [], vi.fn().mockResolvedValue(raw))
    ).rejects.toThrow()
  })
  it("rejects repeated cursors and cancellation without returning partial readers", async () => {
    const query = vi.fn().mockResolvedValue(response([{ sapId: "a" }], { sapId: "a" }))
    await expect(fetchKnowledgeFileReaders(fields, users, file, [], query)).rejects.toThrow(
      "游标未前进"
    )
    expect(query).toHaveBeenCalledTimes(2)
    const controller = new AbortController()
    controller.abort()
    query.mockClear()
    await expect(
      fetchKnowledgeFileReaders(fields, users, file, [], query, controller.signal)
    ).rejects.toThrow("cancelled")
    expect(query).not.toHaveBeenCalled()
  })
})
