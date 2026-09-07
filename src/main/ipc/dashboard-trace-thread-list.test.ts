import { describe, expect, it } from "vitest"
import {
  buildThreadListPreviewBody,
  collectPagedThreadTraces,
  MAX_THREAD_LIST_BUCKETS,
  orderThreadListPreviewHits,
  parseThreadListKeys,
  threadListBucketsNeeded,
  threadListKeysAgg,
  threadListPreviewSourceIncludes,
  THREAD_LIST_TRACES_PER_THREAD,
  TRACE_RAW_SOURCE_FIELD
} from "./dashboard-trace-thread-list"

/**
 * 这些用例钉的是一次线上故障：用户 Trace 分析页首屏直接失败，日志是
 * "Dashboard normalized response exceeds the 6291456 byte limit"，界面上却显示
 * 「请检查网络连接后重试」。
 *
 * 原因是 thread 视图的单阶段聚合把两个放大因子叠在了一起：每条预览 trace 回带
 * `_raw`（整条 trace 原文），且 terms 桶数是 page × pageSize 而只用最后 pageSize 个。
 * 第 1 页就是「10 个会话 × 每会话 50 条 × 完整原文」= 最多 500 份原文。
 */

/** 造一个阶段 1 的聚合结果容器（terms 桶按最近活跃倒序）。 */
function keysContainer(
  threadIds: string[],
  totalThreads = threadIds.length
): Record<string, unknown> {
  return {
    total_threads: { value: totalThreads },
    by_thread: {
      buckets: threadIds.map((key, index) => ({
        key,
        doc_count: index + 1,
        latest_started_at: { value: 1_700_000_000_000 - index }
      }))
    }
  }
}

/** 造一个阶段 2 的聚合结果容器（terms 返回序刻意与入参顺序不同）。 */
function previewContainer(
  hitsByThread: Record<string, string[]>,
  bucketOrder: string[]
): Record<string, unknown> {
  return {
    by_thread: {
      buckets: bucketOrder.map((key) => ({
        key,
        traces: { hits: { hits: (hitsByThread[key] ?? []).map((traceId) => ({ _id: traceId })) } }
      }))
    }
  }
}

/** 递归找出 body 里所有出现的某个 key，用来断言「聚合里根本没有这个东西」。 */
function collectKeys(value: unknown, target: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, target, found)
    return found
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === target) found.push(child)
      collectKeys(child, target, found)
    }
  }
  return found
}

describe("阶段 1：只定位当页会话", () => {
  it("绝不挂 top_hits —— 这是 6 MiB 超限的直接来源", () => {
    const agg = threadListKeysAgg(300)
    expect(collectKeys(agg, "top_hits")).toEqual([])
    expect(JSON.stringify(agg)).not.toContain(TRACE_RAW_SOURCE_FIELD)
  })

  it("保留会话总数与「最近活跃倒序」的桶序", () => {
    const agg = threadListKeysAgg(120) as {
      total_threads: { cardinality: { field: string } }
      by_thread: { terms: { field: string; size: number; order: Record<string, string> } }
    }
    expect(agg.total_threads.cardinality.field).toBe("rootThreadId")
    expect(agg.by_thread.terms).toMatchObject({
      field: "rootThreadId",
      size: 120,
      order: { latest_started_at: "desc" }
    })
  })

  it("桶数取到当页末尾并封顶", () => {
    expect(threadListBucketsNeeded(1, 10)).toBe(10)
    expect(threadListBucketsNeeded(3, 10)).toBe(30)
    expect(threadListBucketsNeeded(1000, 50)).toBe(MAX_THREAD_LIST_BUCKETS)
  })

  it("按页切出会话 id，顺序即展示顺序", () => {
    const container = keysContainer(["t1", "t2", "t3", "t4", "t5"], 42)
    expect(parseThreadListKeys(container, 1, 2)).toEqual({
      threadIds: ["t1", "t2"],
      totalThreads: 42
    })
    expect(parseThreadListKeys(container, 3, 2).threadIds).toEqual(["t5"])
    expect(parseThreadListKeys(container, 9, 2).threadIds).toEqual([])
  })

  it("会话总数受桶上限约束，且忽略空 key", () => {
    expect(parseThreadListKeys(keysContainer(["t1"], 99_999), 1, 10).totalThreads).toBe(
      MAX_THREAD_LIST_BUCKETS
    )
    const withBlank = {
      total_threads: { value: 2 },
      by_thread: { buckets: [{ key: "  " }, { key: "t1" }] }
    }
    expect(parseThreadListKeys(withBlank, 1, 10).threadIds).toEqual(["t1"])
  })

  it("容器缺字段时返回空页而不是抛错", () => {
    expect(parseThreadListKeys({}, 1, 10)).toEqual({ threadIds: [], totalThreads: 0 })
  })
})

describe("阶段 2：只为当页会话回带预览", () => {
  const fullIncludes = ["_raw", "traceId", "startedAt", "outcome", "totalToolCalls"]

  it("预览白名单剔除 _raw，补齐无 _raw 时才需要的计数字段", () => {
    const includes = threadListPreviewSourceIncludes(fullIncludes)
    expect(includes).not.toContain(TRACE_RAW_SOURCE_FIELD)
    expect(includes).toContain("traceId")
    expect(includes).toContain("modelCallCount")
    expect(includes).toContain("userInputRequestCount")
  })

  it("不改动传入的白名单，且不重复追加计数字段", () => {
    const input = [...fullIncludes, "modelCallCount"]
    const includes = threadListPreviewSourceIncludes(input)
    expect(input).toEqual([...fullIncludes, "modelCallCount"])
    expect(includes.filter((field) => field === "modelCallCount")).toHaveLength(1)
  })

  it("查询体只覆盖当页会话，且 terms 桶数正好等于会话数", () => {
    const body = buildThreadListPreviewBody({
      threadIds: ["t1", "t2"],
      baseFilter: [{ term: { sapId: "80383331" } }],
      accessFilter: { terms: { upperOrgLv1: ["研发中心"] } },
      sourceIncludes: threadListPreviewSourceIncludes(fullIncludes)
    }) as Record<string, unknown>

    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter
    expect(filter).toContainEqual({ term: { sapId: "80383331" } })
    expect(filter).toContainEqual({ terms: { rootThreadId: ["t1", "t2"] } })
    expect(filter).toContainEqual({ terms: { upperOrgLv1: ["研发中心"] } })

    const aggs = body.aggs as {
      by_thread: {
        terms: { size: number }
        aggs: { traces: { top_hits: { size: number; _source: { includes: string[] } } } }
      }
    }
    expect(aggs.by_thread.terms.size).toBe(2)
    expect(aggs.by_thread.aggs.traces.top_hits.size).toBe(THREAD_LIST_TRACES_PER_THREAD)
    // 回归护栏：预览批次一旦重新带上 _raw，这一页就会再次顶穿 6 MiB。
    expect(aggs.by_thread.aggs.traces.top_hits._source.includes).not.toContain(
      TRACE_RAW_SOURCE_FIELD
    )
  })

  it("没有数据权限过滤时不塞空 filter", () => {
    const body = buildThreadListPreviewBody({
      threadIds: ["t1"],
      baseFilter: [{ term: { sapId: "x" } }],
      accessFilter: null,
      sourceIncludes: ["traceId"]
    }) as { query: { bool: { filter: unknown[] } } }
    expect(body.query.bool.filter).toHaveLength(2)
  })

  it("命中按阶段 1 的会话顺序重排，而不是照抄 terms 返回序", () => {
    const container = previewContainer({ t1: ["a1", "a2"], t2: ["b1"], t3: ["c1"] }, [
      "t3",
      "t1",
      "t2"
    ])
    const ordered = orderThreadListPreviewHits(container, ["t1", "t2", "t3"])
    expect(ordered.map((hit) => (hit as { _id: string })._id)).toEqual(["a1", "a2", "b1", "c1"])
  })

  it("阶段 2 缺桶的会话被跳过，不影响其余会话", () => {
    const container = previewContainer({ t1: ["a1"] }, ["t1"])
    const ordered = orderThreadListPreviewHits(container, ["t0", "t1", "t2"])
    expect(ordered.map((hit) => (hit as { _id: string })._id)).toEqual(["a1"])
    expect(orderThreadListPreviewHits({}, ["t1"])).toEqual([])
  })
})

describe("翻页不再放大数据量", () => {
  it("深翻页只增加阶段 1 的桶数，阶段 2 始终只查当页会话", () => {
    // 改造前：第 30 页要 ES 返回 300 桶 × 50 条完整 trace 原文，代码只用 10 桶。
    const page = 30
    const pageSize = 10
    const buckets = threadListBucketsNeeded(page, pageSize)
    expect(buckets).toBe(300)

    const keys = parseThreadListKeys(
      keysContainer(Array.from({ length: buckets }, (_, i) => `t${i}`)),
      page,
      pageSize
    )
    expect(keys.threadIds).toHaveLength(pageSize)

    const body = buildThreadListPreviewBody({
      threadIds: keys.threadIds,
      baseFilter: [],
      accessFilter: null,
      sourceIncludes: ["traceId"]
    }) as { aggs: { by_thread: { terms: { size: number } } } }
    // 阶段 2 的规模只跟 pageSize 有关，与页码无关。
    expect(body.aggs.by_thread.terms.size).toBe(pageSize)
  })
})

describe("完整会话分批拉取", () => {
  /** 记录每一批的 from/size，并按需返回命中。 */
  function pager(total: number): {
    calls: Array<{ from: number; size: number }>
    fetchPage: (from: number, size: number) => Promise<Array<{ id: string }>>
  } {
    const calls: Array<{ from: number; size: number }> = []
    return {
      calls,
      fetchPage: async (from, size) => {
        calls.push({ from, size })
        return Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({
          id: `t${from + i}`
        }))
      }
    }
  }

  const collect = (
    total: number,
    maxTraces = 200,
    chunkSize = 25
  ): ReturnType<typeof pager> & { run: () => Promise<Array<{ id: string }>> } => {
    const p = pager(total)
    return {
      ...p,
      run: () =>
        collectPagedThreadTraces({
          maxTraces,
          chunkSize,
          fetchPage: p.fetchPage,
          normalize: (hit: { id: string }) => hit,
          dedupeKey: (trace) => trace.id
        })
    }
  }

  it("把单次响应压到 chunkSize，而不是一次要 200 条完整 raw", async () => {
    const p = collect(200)
    const traces = await p.run()
    expect(traces).toHaveLength(200)
    expect(p.calls.every((call) => call.size === 25)).toBe(true)
    expect(p.calls).toHaveLength(8)
  })

  it("取到不足一批即停，不多发空查询", async () => {
    const p = collect(30)
    expect(await p.run()).toHaveLength(30)
    expect(p.calls).toEqual([
      { from: 0, size: 25 },
      { from: 25, size: 25 }
    ])
  })

  it("会话为空时只发一次请求", async () => {
    const p = collect(0)
    expect(await p.run()).toEqual([])
    expect(p.calls).toHaveLength(1)
  })

  it("最后一批不越过 maxTraces", async () => {
    const p = collect(1000, 60, 25)
    expect(await p.run()).toHaveLength(60)
    expect(p.calls).toEqual([
      { from: 0, size: 25 },
      { from: 25, size: 25 },
      { from: 50, size: 10 }
    ])
  })

  it("批与批之间窗口平移造成的重复会被去重吸收", async () => {
    // from/size 分页的已知边界：批间若有新数据落库，边界处会重复。
    const calls: number[] = []
    const traces = await collectPagedThreadTraces({
      maxTraces: 10,
      chunkSize: 5,
      fetchPage: async (from) => {
        calls.push(from)
        return from === 0
          ? [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]
          : [{ id: "e" }, { id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }]
      },
      normalize: (hit: { id: string }) => hit,
      dedupeKey: (trace) => trace.id
    })
    expect(traces.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"])
    expect(calls).toEqual([0, 5])
  })

  it("拉取失败向上抛出，不会静默返回半份结果", async () => {
    // 第一批必须取满，否则 hits.length < size 会提前收工、根本走不到第二批。
    await expect(
      collectPagedThreadTraces({
        maxTraces: 50,
        chunkSize: 25,
        fetchPage: async (from) => {
          if (from > 0) throw new Error("本次查询返回的数据量过大")
          return Array.from({ length: 25 }, (_, i) => ({ id: `t${i}` }))
        },
        normalize: (hit: { id: string }) => hit,
        dedupeKey: (trace) => trace.id
      })
    ).rejects.toThrow("数据量过大")
  })
})
