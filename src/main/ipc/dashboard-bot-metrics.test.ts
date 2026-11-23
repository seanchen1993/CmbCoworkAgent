import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import {
  addBotActiveUserActivityCounts,
  buildBotActiveUserActivityQuery,
  buildBotActiveUsersQuery,
  buildBotMetricsQuery,
  makeMockBotActiveUsers,
  makeMockBotOverview,
  parseBotActiveUsers,
  parseBotMetrics
} from "./dashboard-bot-metrics"
import { BOT_CHANNELS, BOT_EVENTS, BOT_RUN_KINDS } from "../../shared/bots/telemetry"

function response() {
  const filters = (keys: string[]) => ({
    buckets: Object.fromEntries(keys.map((k) => [k, { doc_count: 0 }]))
  })
  return {
    timed_out: false,
    _shards: { failed: 0 },
    aggregations: {
      observed: { value: 12_000_000 },
      created: { doc_count: 90_000 },
      started: {
        doc_count: 4_000_000,
        bots: { value: 100_000 },
        owners: { doc_count: 4_000_000, distinct: { value: 50_000 } },
        channels: filters(Object.keys(BOT_CHANNELS)),
        kinds: filters(Object.keys(BOT_RUN_KINDS))
      },
      completed: { doc_count: 3_000_000 },
      failed: { doc_count: 1_000_000 },
      cancelled: { doc_count: 20 },
      superseded: { doc_count: 10 },
      duration: { doc_count: 4_000_000, ms: { value: 65000 as number | null } },
      works_created: { doc_count: 100 },
      works_completed: { doc_count: 120 },
      works_reopened: { doc_count: 40 },
      connected: { doc_count: 50 },
      revoked: { doc_count: 4 },
      attachments_sent: { doc_count: 12_345_678 }
    }
  }
}

function activityResponse(
  counts: Record<string, { groupBindings: number; assignedWorks?: number }>
) {
  return {
    aggregations: {
      users: {
        buckets: Object.fromEntries(
          Object.entries(counts).map(([sapId, { groupBindings, assignedWorks }]) => [
            sapId,
            {
              group_bindings: { doc_count: groupBindings },
              assigned_works: { doc_count: assignedWorks }
            }
          ])
        )
      }
    }
  }
}

describe("Bot overview ES aggregation", () => {
  it("provides coherent development data for calendar and organization filters", () => {
    for (const range of [
      { from: "2026-11-02T00:00:00+08:00", to: "2026-11-02T16:30:00+08:00" },
      { from: "2026-10-26T00:00:00+08:00", to: "2026-11-01T23:59:59+08:00" },
      { from: "2026-01-01T00:00:00+08:00", to: "2026-12-31T23:59:59+08:00" }
    ]) {
      const data = makeMockBotOverview(range)
      expect(data.source).toBe("mock")
      expect(data.started).toBeGreaterThan(0)
      expect(data.attachmentsSent).toBeGreaterThan(0)
      expect(makeMockBotOverview(range, 0).attachmentsSent).toBe(0)
      expect(data.channels.reduce((sum, row) => sum + row.count, 0)).toBe(data.started)
      expect(data.runKinds.reduce((sum, row) => sum + row.count, 0)).toBe(data.started)
      expect(data.completed + data.failed + data.cancelled + data.superseded).toBe(data.started)
      expect(makeMockBotOverview(range, 0.25).started).toBeLessThan(data.started)
    }
    expect(() => makeMockBotOverview({ from: "bad", to: "bad" })).toThrow("有效")
  })
  it("applies scope before aggregating and returns no traces, raw messages, or top-N totals", () => {
    const scope = [
      { range: { eventTime: { gte: "2026-01-01", lte: "2026-12-31" } } },
      { term: { upperOrgLv1: "allowed" } }
    ]
    const query = buildBotMetricsQuery(scope)
    expect(query.size).toBe(0)
    expect(query.track_total_hits).toBe(false)
    expect(query.query.bool.filter).toEqual(expect.arrayContaining(scope))
    expect(query.query.bool.filter).toContainEqual({ term: { "properties.botMetricsVersion": 1 } })
    expect(query.query.bool.must_not).toContainEqual({
      term: { "properties.botChannel": "simulation" }
    })
    expect(Object.keys(query.aggs.started.aggs.channels.filters.filters)).toHaveLength(4)
    expect(Object.keys(query.aggs.started.aggs.kinds.filters.filters)).toHaveLength(5)
    expect(query.aggs.started.aggs.bots.cardinality.precision_threshold).toBe(40000)
    expect(query.aggs.attachments_sent).toEqual({
      filter: { term: { eventName: BOT_EVENTS.attachmentSent } }
    })
    expect(JSON.stringify(query.aggs)).not.toMatch(
      /"terms":\{"field"|"script"|"top_hits"|"_source"|"_raw"|"date_histogram"/
    )
    expect(query.query.bool.filter).toContainEqual({
      terms: { eventName: Object.values(BOT_EVENTS) }
    })
  })

  it("keeps large aggregate totals, independent completion counts and the ended-event denominator", () => {
    const raw = response()
    raw.aggregations.started.doc_count = 2 // some runs began before this window
    const parsed = parseBotMetrics(raw)
    expect(parsed.activeBots).toBe(100_000)
    expect(parsed.activeOwners).toBe(50_000)
    expect(parsed.completed).toBe(3_000_000)
    expect(parsed.successRate).toBe(0.75)
    expect(parsed.worksCompleted).toBe(120) // not clipped to 100 newly created works
    expect(parsed.avgDurationMs).toBe(65000)
    expect(parsed.failed).toBe(1_000_000)
    expect(parsed.attachmentsSent).toBe(12_345_678)
  })

  it("returns zero for older data without attachment events but rejects a missing aggregation", () => {
    const raw = response()
    raw.aggregations.attachments_sent.doc_count = 0
    expect(parseBotMetrics(raw).attachmentsSent).toBe(0)
    const { attachments_sent: _, ...olderAggregations } = raw.aggregations
    expect(() => parseBotMetrics({ ...raw, aggregations: olderAggregations })).toThrow("不完整")
  })

  it("distinguishes no completed observations from a zero success rate", () => {
    const raw = response()
    raw.aggregations.completed.doc_count = 0
    raw.aggregations.failed.doc_count = 0
    raw.aggregations.duration.ms.value = null
    expect(parseBotMetrics(raw)).toMatchObject({ successRate: null, avgDurationMs: null })
    raw.aggregations.failed.doc_count = 1
    expect(parseBotMetrics(raw).successRate).toBe(0)
    raw.aggregations.observed.value = 0
    expect(parseBotMetrics(raw).hasData).toBe(false)
  })

  it("rejects truncated, shard-failed or malformed results instead of showing false zeros", () => {
    expect(() => parseBotMetrics({})).toThrow("不完整")
    expect(() => parseBotMetrics({ aggregations: { observed: { value: 1 } } })).toThrow("不完整")
    expect(() => parseBotMetrics({ ...response(), timed_out: true })).toThrow("未完整")
    expect(() => parseBotMetrics({ ...response(), _shards: { failed: 1 } })).toThrow("未完整")
    const raw = response()
    raw.aggregations.completed.doc_count = NaN
    expect(() => parseBotMetrics(raw)).toThrow("不完整")
  })
})

describe("Bot active user page", () => {
  const bucket = (
    sapId: string,
    source: { userName?: string; orgName?: string; upperOrgLv1?: string; eventTime?: string } = {},
    runs = 1,
    sortTime?: number,
    activeBots = 1,
    chatRuns = runs
  ) => ({
    key: { sapId },
    doc_count: runs,
    bots: { value: activeBots },
    chat_runs: { doc_count: chatRuns },
    latest_user: { hits: { hits: [{ _source: source, sort: [sortTime] }] } }
  })
  const page = (buckets: ReturnType<typeof bucket>[], afterKey?: string) => ({
    aggregations: {
      users: { buckets, ...(afterKey === undefined ? {} : { after_key: { sapId: afterKey } }) }
    }
  })

  it("uses the same eligible account scope as the overview and bounds every request", () => {
    const scope = [{ term: { upperOrgLv1: "allowed" } }]
    const overview = buildBotMetricsQuery(scope)
    const body = buildBotActiveUsersQuery(scope, "000123")
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(body.query.bool.must_not).toEqual(overview.query.bool.must_not)
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { "properties.botMetricsVersion": 1 } },
        ...scope,
        overview.aggs.started.filter,
        overview.aggs.started.aggs.owners.filter
      ])
    )
    expect(body.aggs.users.composite).toEqual({
      size: 40,
      sources: [{ sapId: { terms: { field: "sapId" } } }],
      after: { sapId: "000123" }
    })
    expect(body.aggs.users.aggs.bots.cardinality).toEqual({
      field: overview.aggs.started.aggs.bots.cardinality.field,
      precision_threshold: 3000
    })
    expect(body.aggs.users.aggs.chat_runs.filter).toEqual({
      term: { "properties.botRunKind": "chat" }
    })
    expect(body.aggs.users.aggs.latest_user.top_hits).toEqual({
      size: 1,
      sort: [{ eventTime: { order: "desc" } }],
      _source: { includes: ["userName", "orgName", "upperOrgLv1", "eventTime"] }
    })
    expect(() => buildBotActiveUsersQuery([], "")).toThrow("游标无效")
  })

  it("keeps all started-run accounts but reads chat-only counts and retains newest metadata", () => {
    expect(
      parseBotActiveUsers(
        page(
          [
            bucket(
              "01",
              {
                userName: " Alice ",
                orgName: " 研发组 ",
                upperOrgLv1: "旧部门",
                eventTime: "2026-04-02T17:00:00+08:00"
              },
              19,
              undefined,
              4,
              9
            ),
            bucket("02", { userName: "unknown", upperOrgLv1: "平台部" }, 8, 0, 0, 0)
          ],
          "03"
        )
      )
    ).toEqual({
      items: [
        {
          sapId: "01",
          userName: "Alice",
          organization: "研发组",
          activeBots: 4,
          chatRuns: 9,
          lastActiveAt: "2026-04-02T09:00:00.000Z"
        },
        {
          sapId: "02",
          organization: "平台部",
          activeBots: 0,
          chatRuns: 0,
          lastActiveAt: "1970-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: "03"
    })
    expect(parseBotActiveUsers(page([bucket("04", { eventTime: "invalid" })]), "03")).toEqual({
      items: [{ sapId: "04", activeBots: 1, chatRuns: 1 }],
      nextCursor: null
    })
    expect(parseBotActiveUsers(page([]), "03")).toEqual({ items: [], nextCursor: null })
  })

  it("rejects partial data, malformed buckets, duplicate accounts, and stalled cursors", () => {
    expect(() => parseBotActiveUsers({ ...page([]), timed_out: true })).toThrow("未完整")
    expect(() => parseBotActiveUsers({ ...page([]), _shards: { failed: 1 } })).toThrow("未完整")
    expect(() => parseBotActiveUsers({ aggregations: { users: {} } })).toThrow("不完整")
    expect(() => parseBotActiveUsers(page([bucket("")]))).toThrow("顺序")
    expect(() => parseBotActiveUsers(page([bucket("01", {}, NaN)]))).toThrow("轮次无效")
    expect(() => parseBotActiveUsers(page([bucket("01", {}, 4, undefined, 1, 5)]))).toThrow(
      "对话处理轮次无效"
    )
    const { chat_runs: _chatRuns, ...missingChatRuns } = bucket("01")
    expect(() =>
      parseBotActiveUsers({ aggregations: { users: { buckets: [missingChatRuns] } } })
    ).toThrow("对话处理轮次无效")
    expect(() => parseBotActiveUsers(page([bucket("01", {}, 4, undefined, -1)]))).toThrow(
      "Bot 数无效"
    )
    const { bots: _, ...incomplete } = bucket("01")
    expect(() =>
      parseBotActiveUsers({ aggregations: { users: { buckets: [incomplete] } } })
    ).toThrow("Bot 数无效")
    expect(() => parseBotActiveUsers(page([bucket("02"), bucket("02")]))).toThrow("顺序")
    expect(() => parseBotActiveUsers(page([bucket("02")], "01"), "01")).toThrow("未前进")
    expect(() => parseBotActiveUsers(page([bucket("02"), bucket("04")], "03"), "01")).toThrow(
      "未前进"
    )
  })

  it("merges group binding and work creation counts without changing order or cursor", () => {
    const users = parseBotActiveUsers(page([bucket("01"), bucket("02")], "03"))
    const valid = activityResponse({
      "02": { groupBindings: 0, assignedWorks: 3 },
      "01": { groupBindings: 4, assignedWorks: 0 }
    })
    expect(addBotActiveUserActivityCounts(users, valid)).toEqual({
      items: [
        { ...users.items[0], zhaohuGroupBindings: 4, assignedWorks: 0 },
        { ...users.items[1], zhaohuGroupBindings: 0, assignedWorks: 3 }
      ],
      nextCursor: "03"
    })
    expect(() => addBotActiveUserActivityCounts(users, { ...valid, timed_out: true })).toThrow(
      "未完整"
    )
    expect(() =>
      addBotActiveUserActivityCounts(users, { ...valid, _shards: { failed: 1 } })
    ).toThrow("未完整")
    const invalidCounts: Parameters<typeof activityResponse>[0][] = [
      {},
      { "02": { groupBindings: -1, assignedWorks: 0 } },
      { "02": { groupBindings: 0.5, assignedWorks: 0 } }
    ]
    for (const counts of invalidCounts) {
      expect(() =>
        addBotActiveUserActivityCounts(
          users,
          activityResponse({ "01": { groupBindings: 4, assignedWorks: 0 }, ...counts })
        )
      ).toThrow("绑定数无效")
    }
    for (const assignedWorks of [undefined, -1, 0.5]) {
      expect(() =>
        addBotActiveUserActivityCounts(
          users,
          activityResponse({
            "01": { groupBindings: 4, assignedWorks: 0 },
            "02": { groupBindings: 0, assignedWorks }
          })
        )
      ).toThrow("交办任务数无效")
    }
  })

  it("paginates the exact number of explicitly synthetic users in development mode", () => {
    const range = { from: "2026-01-01", to: "2026-12-31" }
    const organizations = ["开发二部"]
    const first = makeMockBotActiveUsers(range, 0.5, undefined, organizations)
    const second = makeMockBotActiveUsers(range, 0.5, first.nextCursor!, organizations)
    const all = [...first.items, ...second.items]
    const overview = makeMockBotOverview(range, 0.5)
    expect(first.items).toHaveLength(40)
    expect(second.nextCursor).toBeNull()
    expect(all).toHaveLength(overview.activeOwners)
    expect(all.reduce((sum, user) => sum + user.chatRuns, 0)).toBe(
      overview.runKinds.find(({ key }) => key === "chat")?.count
    )
    expect(all.reduce((sum, user) => sum + user.assignedWorks, 0)).toBe(overview.worksCreated)
    const groupBindings = all.reduce((sum, user) => sum + user.zhaohuGroupBindings, 0)
    expect(groupBindings).toBeGreaterThan(0)
    expect(groupBindings).toBeLessThan(overview.connected)
    expect(all.every(({ activeBots }) => activeBots >= 1 && activeBots <= overview.activeBots)).toBe(
      true
    )
    expect(all.every((user) => user.organization === organizations[0])).toBe(true)
    expect(all.every(({ lastActiveAt }) => {
      const time = Date.parse(lastActiveAt ?? "")
      return time >= Date.parse(range.from) && time <= Date.parse(range.to)
    })).toBe(true)
    expect(second.items[0]).toMatchObject({ sapId: "demo-0041", userName: "示例用户 41" })
  })
})

// Exercise the actual IPC fetcher without booting Electron, following the existing
// dashboard fetcher harness. Dependencies represent authenticated access and ES IO.
const source = readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8")
const begin = source.indexOf("async function fetchBotOverview(")
const end = source.indexOf("async function fetchModelStats(", begin)
const compiled = ts.transpileModule(source.slice(begin, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
function fixture(allowed = true) {
  const query = vi.fn(async (): Promise<unknown> => response())
  const deps = {
    addBotActiveUserActivityCounts,
    buildBotActiveUserActivityQuery,
    buildBotActiveUsersQuery,
    buildBotMetricsQuery,
    parseBotActiveUsers,
    parseBotMetrics,
    esQuery: query,
    getEsIndex: () => "devclaw_event",
    requireDashboardAccess: () => {
      if (!allowed) throw new Error("请先登录")
      return { upperOrgLv1: "own-room" }
    },
    timeRangeFilter: (field: string, range: { from: string; to: string }) => ({
      range: { [field]: { gte: range.from, lte: range.to } }
    }),
    appendOptionalFilter: (filters: unknown[], filter: unknown) => {
      if (filter) filters.push(filter)
    },
    buildTraceAccessFilter: (access: { upperOrgLv1: string }) => ({
      term: { upperOrgLv1: access.upperOrgLv1 }
    }),
    normalizeUpperOrgLv1List: (value: string[]) => value ?? [],
    buildUpperOrgLv1ListFilter: (value: string[]) =>
      value.length ? { terms: { upperOrgLv1: value } } : null
  }
  const { fetch, fetchUsers } = new Function(
    ...Object.keys(deps),
    compiled + "\nreturn { fetch: fetchBotOverview, fetchUsers: fetchBotActiveUsers }"
  )(...Object.values(deps))
  return { fetch, fetchUsers, query }
}

describe("Bot overview fetch boundary", () => {
  it("uses one bounded request for a full year and intersects permissions with selected organization", async () => {
    const f = fixture()
    await f.fetch({ from: "2026-01-01", to: "2026-12-31" }, "custom", {
      upperOrgLv1: ["different-room"]
    })
    expect(f.query).toHaveBeenCalledTimes(1)
    const [index, body, options] = f.query.mock.calls[0] as unknown as [
      string,
      ReturnType<typeof buildBotMetricsQuery>,
      unknown
    ]
    expect(index).toBe("devclaw_event")
    expect(body.query.bool.filter).toContainEqual({ term: { upperOrgLv1: "own-room" } })
    expect(body.query.bool.filter).toContainEqual({ terms: { upperOrgLv1: ["different-room"] } })
    expect(JSON.stringify(body.aggs)).not.toContain("date_histogram")
    expect(options).toEqual({ outputByteLimit: 256 * 1024 })
  })

  it("rejects unauthenticated or invalid-range requests before ES and propagates failures", async () => {
    const denied = fixture(false)
    await expect(denied.fetch({ from: "2026-01-01", to: "2026-01-02" }, "day")).rejects.toThrow(
      "登录"
    )
    expect(denied.query).not.toHaveBeenCalled()
    const f = fixture()
    for (const range of [
      null,
      { from: "bad", to: "bad" },
      { from: "2026-01-01", to: "2025-01-01" },
      { from: "2024-01-01", to: "2026-01-01" }
    ])
      await expect(f.fetch(range, "day")).rejects.toThrow("有效")
    expect(f.query).not.toHaveBeenCalled()
    f.query.mockRejectedValueOnce(new Error("ES offline"))
    await expect(f.fetch({ from: "2026-01-01", to: "2026-01-02" }, "day")).rejects.toThrow(
      "ES offline"
    )
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("guards user details before querying and intersects organization with the viewer's scope", async () => {
    const range = { from: "2026-01-01", to: "2026-01-02" }
    const denied = fixture(false)
    await expect(denied.fetchUsers(range, "day", {}, "123")).rejects.toThrow("登录")
    expect(denied.query).not.toHaveBeenCalled()
    const f = fixture()
    await expect(f.fetchUsers(range, "day", {}, {})).rejects.toThrow("游标无效")
    expect(f.query).not.toHaveBeenCalled()
    f.query.mockResolvedValueOnce({ aggregations: { users: { buckets: [] } } })
    await expect(
      f.fetchUsers(range, "day", { upperOrgLv1: ["other-room"] }, "123")
    ).resolves.toEqual({
      items: [],
      nextCursor: null
    })
    expect(f.query).toHaveBeenCalledOnce()
    expect(f.query).toHaveBeenCalledWith(
      "devclaw_event",
      buildBotActiveUsersQuery(
        [
          { range: { eventTime: { gte: range.from, lte: range.to } } },
          { term: { upperOrgLv1: "own-room" } },
          { terms: { upperOrgLv1: ["other-room"] } }
        ],
        "123"
      ),
      { outputByteLimit: 64 * 1024 }
    )
  })

  it("requests one scoped aggregation for group bindings and work creations for these accounts", async () => {
    const f = fixture()
    const range = { from: "2026-01-01", to: "2026-01-02" }
    const sapIds = Array.from({ length: 40 }, (_, i) => String(i + 101).padStart(4, "0"))
    const nextCursor = sapIds.at(-1)!
    f.query
      .mockResolvedValueOnce({
        aggregations: {
          users: {
            buckets: sapIds.map((sapId, i) => ({
              key: { sapId },
              doc_count: 1,
              bots: { value: 1 },
              chat_runs: { doc_count: i % 2 }
            })),
            after_key: { sapId: nextCursor }
          }
        }
      })
      .mockResolvedValueOnce(
        activityResponse(
          Object.fromEntries(
            sapIds.map((sapId, i) => [sapId, { groupBindings: i * 2, assignedWorks: i * 3 }])
          )
        )
      )
    const result = await f.fetchUsers(range, "day", { upperOrgLv1: ["requested-room"] }, "0100")
    expect(f.query).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      items: sapIds.map((sapId, i) => ({
        sapId,
        activeBots: 1,
        chatRuns: i % 2,
        zhaohuGroupBindings: i * 2,
        assignedWorks: i * 3
      })),
      nextCursor
    })
    const [index, body, options] = f.query.mock.calls[1] as unknown as [
      string,
      ReturnType<typeof buildBotActiveUserActivityQuery>,
      unknown
    ]
    const overview = buildBotMetricsQuery([])
    expect(index).toBe("devclaw_event")
    expect(options).toEqual({ outputByteLimit: 64 * 1024 })
    expect(body.size).toBe(0)
    expect(body.track_total_hits).toBe(false)
    expect(body.query.bool.must_not).toEqual(overview.query.bool.must_not)
    const groupBindingEvent = {
      bool: {
        filter: [
          overview.aggs.connected.filter,
          { term: { "properties.botChannel": "zhaohu_group" } }
        ]
      }
    }
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { "properties.botMetricsVersion": 1 } },
        {
          bool: {
            should: [overview.aggs.works_created.filter, groupBindingEvent],
            minimum_should_match: 1
          }
        },
        { terms: { sapId: sapIds } },
        { range: { eventTime: { gte: range.from, lte: range.to } } },
        { term: { upperOrgLv1: "own-room" } },
        { terms: { upperOrgLv1: ["requested-room"] } }
      ])
    )
    expect(body.aggs.users.filters.filters).toEqual(
      Object.fromEntries(sapIds.map((sapId) => [sapId, { term: { sapId } }]))
    )
    expect(body.aggs.users.aggs).toEqual({
      assigned_works: overview.aggs.works_created,
      group_bindings: { filter: groupBindingEvent }
    })
  })
})
