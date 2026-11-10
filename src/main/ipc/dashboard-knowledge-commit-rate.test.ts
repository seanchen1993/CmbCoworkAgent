import { afterEach, describe, expect, it, vi } from "vitest"
import {
  computeKnowledgeCommitRate,
  formatKnowledgeApiTime,
  mockKnowledgeCommitRate,
  parseKnowledgeCommitRate,
  parseRoomOrgIdMap,
  requestKnowledgeCommitRate,
  resolveKnowledgeCommitRateScope
} from "./dashboard-knowledge-commit-rate"
import { isDashboardRequestCancelled } from "../services/dashboard-request-coordinator"

const UNCLASSIFIED = "__unclassified__"

describe("接口时间格式", () => {
  it("把 UTC 的 ISO 串换成本地时区的 yyyy-MM-dd HH:mm:ss", () => {
    // 用本地时间构造，断言与运行机器的时区无关。
    expect(formatKnowledgeApiTime(new Date(2026, 7, 1, 0, 0, 0).toISOString())).toBe(
      "2026-08-01 00:00:00"
    )
    expect(formatKnowledgeApiTime(new Date(2026, 8, 30, 23, 59, 59, 999).toISOString())).toBe(
      "2026-09-30 23:59:59"
    )
  })

  it("无效时间直接报错，不拼出一个错误的区间", () => {
    expect(() => formatKnowledgeApiTime("not-a-date")).toThrow()
  })
})

describe("室编号映射", () => {
  it("解析「室名称: 室编号」的 JSON 对象，编号写成数字也接受", () => {
    const map = parseRoomOrgIdMap('{"零售信息应用开发一室":"990067","商旅业务开发室(杭州)":992257}')
    expect(map.get("零售信息应用开发一室")).toBe("990067")
    expect(map.get("商旅业务开发室(杭州)")).toBe("992257")
    expect(map.size).toBe(2)
  })

  it("没配置时是空映射", () => {
    expect(parseRoomOrgIdMap(undefined).size).toBe(0)
    expect(parseRoomOrgIdMap("  ").size).toBe(0)
  })

  it("配置写错直接报错，不当成「该室没配置」放过", () => {
    expect(() => parseRoomOrgIdMap("{零售信息应用开发一室:990067}")).toThrow(/不是合法的 JSON/)
    expect(() => parseRoomOrgIdMap('["990067"]')).toThrow(/JSON 对象/)
    expect(() => parseRoomOrgIdMap('{"零售信息应用开发一室":""}')).toThrow(/室编号为空/)
  })
})

describe("按范围和映射取数", () => {
  const roomOrgIds = (): Map<string, string> =>
    parseRoomOrgIdMap('{"零售信息应用开发一室":"990067","商旅业务开发室(杭州)":"992257"}')

  it("单个室按映射换成编号再查", async () => {
    const requestRate = vi.fn().mockResolvedValue(0.3)
    await expect(
      computeKnowledgeCommitRate(
        { kind: "room", roomName: "零售信息应用开发一室" },
        roomOrgIds,
        requestRate
      )
    ).resolves.toEqual({ rate: 0.3 })
    expect(requestRate).toHaveBeenCalledWith("990067")
  })

  it("全角括号的室名称也能对上半角配置的映射", async () => {
    const requestRate = vi.fn().mockResolvedValue(0.3)
    await computeKnowledgeCommitRate(
      { kind: "room", roomName: "商旅业务开发室（杭州）" },
      roomOrgIds,
      requestRate
    )
    expect(requestRate).toHaveBeenCalledWith("992257")
  })

  it("映射里没有的室不调接口", async () => {
    const requestRate = vi.fn()
    await expect(
      computeKnowledgeCommitRate({ kind: "room", roomName: "别的室" }, roomOrgIds, requestRate)
    ).resolves.toEqual({ rate: null, unavailableReason: "roomNotMapped" })
    expect(requestRate).not.toHaveBeenCalled()
  })

  it("全部室不带编号，也不读映射，映射写错不影响全部室", async () => {
    const requestRate = vi.fn().mockResolvedValue(0.2127)
    const brokenMap = vi.fn(() => parseRoomOrgIdMap("not json"))
    await expect(
      computeKnowledgeCommitRate({ kind: "allRooms" }, brokenMap, requestRate)
    ).resolves.toEqual({ rate: 0.2127 })
    expect(requestRate).toHaveBeenCalledWith(undefined)
    expect(brokenMap).not.toHaveBeenCalled()
  })

  it("给不出数的范围直接返回原因，不调接口", async () => {
    const requestRate = vi.fn()
    await expect(
      computeKnowledgeCommitRate(
        { kind: "unavailable", reason: "multipleRooms" },
        roomOrgIds,
        requestRate
      )
    ).resolves.toEqual({ rate: null, unavailableReason: "multipleRooms" })
    expect(requestRate).not.toHaveBeenCalled()
  })
})

describe("查询范围", () => {
  const admin = { admin: true, ownRoom: "本室", unclassifiedRoom: UNCLASSIFIED }
  const member = { admin: false, ownRoom: "本室", unclassifiedRoom: UNCLASSIFIED }

  it("管理员不选室即全部室，选一个室就查那个室", () => {
    expect(resolveKnowledgeCommitRateScope({ ...admin, requestedRooms: [] })).toEqual({
      kind: "allRooms"
    })
    expect(resolveKnowledgeCommitRateScope({ ...admin, requestedRooms: ["别的室"] })).toEqual({
      kind: "room",
      roomName: "别的室"
    })
  })

  it("多选室和「未归类」给不出数", () => {
    expect(resolveKnowledgeCommitRateScope({ ...admin, requestedRooms: ["甲室", "乙室"] })).toEqual(
      {
        kind: "unavailable",
        reason: "multipleRooms"
      }
    )
    expect(resolveKnowledgeCommitRateScope({ ...admin, requestedRooms: [UNCLASSIFIED] })).toEqual({
      kind: "unavailable",
      reason: "unclassified"
    })
  })

  it("非管理员永远只查本室，不会落到全部室", () => {
    expect(resolveKnowledgeCommitRateScope({ ...member, requestedRooms: [] })).toEqual({
      kind: "room",
      roomName: "本室"
    })
    expect(
      resolveKnowledgeCommitRateScope({ ...member, requestedRooms: ["本室", "别的室"] })
    ).toEqual({
      kind: "room",
      roomName: "本室"
    })
    expect(resolveKnowledgeCommitRateScope({ ...member, requestedRooms: ["别的室"] })).toEqual({
      kind: "unavailable",
      reason: "noAccess"
    })
    expect(resolveKnowledgeCommitRateScope({ ...member, ownRoom: "", requestedRooms: [] })).toEqual(
      { kind: "unavailable", reason: "noAccess" }
    )
  })
})

describe("接口返回值解析", () => {
  it("返回的是百分数，换成 0–1 的比例", () => {
    expect(parseKnowledgeCommitRate("21.27")).toBeCloseTo(0.2127, 6)
    expect(parseKnowledgeCommitRate(" 21.27\n")).toBeCloseTo(0.2127, 6)
    expect(parseKnowledgeCommitRate("0")).toBe(0)
  })

  it("空响应视为没有数据，非数值报错", () => {
    expect(parseKnowledgeCommitRate("")).toBeNull()
    expect(parseKnowledgeCommitRate("null")).toBeNull()
    expect(() => parseKnowledgeCommitRate("<html>error</html>")).toThrow(/非数值/)
  })
})

describe("请求接口", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const range = { startTime: "2026-08-01 00:00:00", endTime: "2026-09-30 00:00:00" }

  it("全部室不传 orgId，选了室才带上", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("21.27", { status: 200 }))
      .mockResolvedValueOnce(new Response("30", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(requestKnowledgeCommitRate("http://kb.test/rate", range)).resolves.toBeCloseTo(
      0.2127,
      6
    )
    await expect(
      requestKnowledgeCommitRate("http://kb.test/rate", { ...range, orgId: "991175" })
    ).resolves.toBeCloseTo(0.3, 6)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://kb.test/rate")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body)).toEqual(range)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ orgId: "991175", ...range })
  })

  it("非 2xx 报出状态码", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })))
    await expect(requestKnowledgeCommitRate("http://kb.test/rate", range)).rejects.toThrow(
      /HTTP 500/
    )
  })

  it("被新请求顶掉时按取消处理，不当成错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
      })
    )
    const controller = new AbortController()
    const pending = requestKnowledgeCommitRate("http://kb.test/rate", range, controller.signal)
    controller.abort()
    const error = await pending.catch((reason: unknown) => reason)
    expect(isDashboardRequestCancelled(error)).toBe(true)
  })
})

describe("开发环境的假值", () => {
  it("全部室固定，单个室按编号给稳定且各室不同的数", () => {
    expect(mockKnowledgeCommitRate(undefined)).toBe(0.2127)
    const first = mockKnowledgeCommitRate("992391")
    expect(first).toBe(mockKnowledgeCommitRate("992391"))
    expect(first).not.toBe(mockKnowledgeCommitRate("992257"))
    for (const orgId of ["992391", "990067", "abc"]) {
      expect(mockKnowledgeCommitRate(orgId)).toBeGreaterThanOrEqual(0.1)
      expect(mockKnowledgeCommitRate(orgId)).toBeLessThan(0.7)
    }
  })
})
