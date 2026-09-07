/**
 * 运营面板「按会话分页」(thread 视图) 的查询构造与响应切片。
 *
 * 拆成两阶段，是因为原来的单阶段写法有两个互相叠加的放大因子，任一个都能把
 * 一页查询顶穿 DASHBOARD_ES_OUTPUT_BYTE_LIMIT（6 MiB）：
 *
 *   1. 每条预览 trace 都回带 `_raw`。`_raw` 是整条 trace 的序列化原文（含全部
 *      模型调用与工具输入输出），单条常在十 KB 量级。一页要「pageSize 个会话 ×
 *      每会话最多 THREAD_LIST_TRACES_PER_THREAD 条」，第 1 页就是几百份原文。
 *   2. terms 无法在 ES 侧按 from/size 切片，所以桶数是 page × pageSize，而代码
 *      只用最后 pageSize 个。第 30 页要 ES 吐出 300 桶 × 50 条完整原文，用掉 10 桶。
 *
 * 阶段 1（keys）只取「当前页是哪些会话」：terms 不挂 top_hits，每桶只有 key、
 * doc_count 和一个 max 值，翻到最深页也只有几十 KB。
 * 阶段 2（preview）只为当页 ≤pageSize 个会话回带预览 trace，且不含 `_raw`。
 *
 * 列表本来就只是预览：卡片头部的工具数 / Token / 成败计数全部来自已索引的摘要
 * 字段，完整对话在用户选中某个会话时由 `dashboard:threadTraces` 单独懒加载
 * （见 TraceHistoryDialog 的 threadTraceCache）。
 *
 * 本模块只有纯函数（ES body 片段进、普通对象出），可以脱离 Electron 与真实集群
 * 单测；访问控制和真正的查询由 IPC 层持有。
 */

/** 会话按最近活跃时间倒序取桶后切片分页；该上限同时约束 terms 桶数与可翻到的
 * 最深页（page * pageSize ≤ 上限）。单用户 / 单技能的会话量有界，300 足够。 */
export const MAX_THREAD_LIST_BUCKETS = 300

/** 每个会话在列表里展开渲染的 trace 数上限。会话内 trace 通常很少；超大会话的
 * 完整还原由「Thread 对话还原」抽屉（fetchThreadTraces）负责，列表无需全量。 */
export const THREAD_LIST_TRACES_PER_THREAD = 50

/** trace 原文字段。预览批次一律剔除它 —— 这一条就是 6 MiB 超限的主因。 */
export const TRACE_RAW_SOURCE_FIELD = "_raw"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value)
}

/** 当前页所需的 terms 桶数（取到第 page 页末尾，封顶 MAX_THREAD_LIST_BUCKETS）。 */
export function threadListBucketsNeeded(page: number, pageSize: number): number {
  return Math.min(page * pageSize, MAX_THREAD_LIST_BUCKETS)
}

/**
 * 预览批次的 `_source` 白名单：完整白名单去掉 `_raw`，补两个数值字段。
 *
 * 没有 `_raw` 时 modelCallCount / userInputRequestCount 只能取自索引字段；索引里
 * 若没有则回落 0，与 normalizeTraceDetail 既有的 fallback 分支口径一致。
 */
export function threadListPreviewSourceIncludes(fullIncludes: readonly string[]): string[] {
  const includes = fullIncludes.filter((field) => field !== TRACE_RAW_SOURCE_FIELD)
  for (const extra of ["modelCallCount", "userInputRequestCount"]) {
    if (!includes.includes(extra)) includes.push(extra)
  }
  return includes
}

/**
 * 阶段 1 的聚合：只定位当前页是哪些会话。
 *
 * 用户页 / 技能页 / 项目页 thread 视图共用，保证三边口径一致。历史数据需要回填
 * rootThreadId=threadId。
 */
export function threadListKeysAgg(bucketsNeeded: number): Record<string, unknown> {
  return {
    total_threads: { cardinality: { field: "rootThreadId" } },
    by_thread: {
      terms: {
        field: "rootThreadId",
        size: bucketsNeeded,
        order: { latest_started_at: "desc" }
      },
      aggs: {
        latest_started_at: { max: { field: "startedAt" } }
      }
    }
  }
}

/** 解析阶段 1 的结果容器，按当前页切出该页的会话 id（顺序即展示顺序）。 */
export function parseThreadListKeys(
  container: Record<string, unknown>,
  page: number,
  pageSize: number
): { threadIds: string[]; totalThreads: number } {
  const totalThreads = Math.min(
    asNumber(asRecord(container.total_threads).value),
    MAX_THREAD_LIST_BUCKETS
  )
  const buckets = asRecord(container.by_thread).buckets
  const fromBucket = (page - 1) * pageSize
  const selected = Array.isArray(buckets) ? buckets.slice(fromBucket, fromBucket + pageSize) : []
  const threadIds = selected
    .map((bucket) => asString(asRecord(bucket).key).trim())
    .filter((threadId) => threadId.length > 0)
  return { threadIds, totalThreads }
}

/**
 * 阶段 2 的查询体：只为当页会话回带预览 trace（升序、每会话最多
 * THREAD_LIST_TRACES_PER_THREAD 条、不含 `_raw`）。
 */
export function buildThreadListPreviewBody(input: {
  threadIds: readonly string[]
  baseFilter: readonly unknown[]
  accessFilter: Record<string, unknown> | null
  sourceIncludes: readonly string[]
}): Record<string, unknown> {
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          ...input.baseFilter,
          { terms: { rootThreadId: [...input.threadIds] } },
          ...(input.accessFilter ? [input.accessFilter] : [])
        ]
      }
    },
    aggs: {
      by_thread: {
        terms: { field: "rootThreadId", size: input.threadIds.length },
        aggs: {
          traces: {
            top_hits: {
              size: THREAD_LIST_TRACES_PER_THREAD,
              sort: [{ startedAt: { order: "asc" } }],
              _source: { includes: [...input.sourceIncludes] }
            }
          }
        }
      }
    }
  }
}

/**
 * 把阶段 2 的桶按阶段 1 给定的会话顺序摊平。
 *
 * 阶段 1 的桶序就是「最近活跃倒序」的展示顺序；阶段 2 的 terms 返回序不保证与
 * 之一致，所以必须按 threadIds 重排，不能直接摊平阶段 2 的桶。
 */
export function orderThreadListPreviewHits(
  container: Record<string, unknown>,
  threadIds: readonly string[]
): unknown[] {
  const buckets = asRecord(container.by_thread).buckets
  const hitsByThread = new Map<string, unknown[]>()
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      const threadId = asString(asRecord(bucket).key).trim()
      if (!threadId) continue
      const hits = asRecord(asRecord(asRecord(bucket).traces).hits).hits
      hitsByThread.set(threadId, Array.isArray(hits) ? hits : [])
    }
  }
  return threadIds.flatMap((threadId) => hitsByThread.get(threadId) ?? [])
}
