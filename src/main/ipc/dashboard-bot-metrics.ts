import {
  BOT_CHANNELS,
  BOT_EVENTS,
  BOT_RUN_KINDS,
  type BotOverviewData
} from "../../shared/bots/telemetry"

type RecordValue = Record<string, any>
const record = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {}
const number = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error("Bot 统计返回数据不完整")
  return v
}
const event = (name: string) => ({ term: { eventName: name } })
const metric = (name: string) => ({ filter: event(name) })
const outcome = (values: string[]) => ({
  filter: {
    bool: { filter: [event(BOT_EVENTS.ended), { terms: { "properties.botOutcome": values } }] }
  }
})

/** One size:0 request. No transcript scans, per-user joins, top-N totals or runtime scripts.
 * Access and selected-org filters are supplied by the authenticated dashboard handler. */
export function buildBotMetricsQuery(filters: Record<string, unknown>[]) {
  const ended = {
    completed: outcome(["completed"]),
    failed: outcome(["failed", "interrupted", "outcome_unknown"]),
    cancelled: outcome(["cancelled"]),
    superseded: outcome(["superseded"])
  }
  return {
    size: 0,
    track_total_hits: false,
    query: {
      bool: {
        filter: [
          { terms: { eventName: Object.values(BOT_EVENTS) } },
          { term: { "properties.botMetricsVersion": 1 } },
          ...filters
        ],
        must_not: [
          { term: { "properties.botChannel": "simulation" } },
          { term: { "properties.botSimulation": 1 } },
          { term: { "properties.botRunKind": "introduction" } }
        ]
      }
    },
    aggs: {
      observed: { value_count: { field: "eventId" } },
      created: metric(BOT_EVENTS.created),
      started: {
        ...metric(BOT_EVENTS.started),
        aggs: {
          bots: { cardinality: { field: "properties.botId", precision_threshold: 40000 } },
          owners: { cardinality: { field: "sapId", precision_threshold: 40000 } },
          channels: {
            filters: {
              filters: Object.fromEntries(
                Object.keys(BOT_CHANNELS).map((key) => [
                  key,
                  { term: { "properties.botChannel": key } }
                ])
              )
            }
          },
          kinds: {
            filters: {
              filters: Object.fromEntries(
                Object.keys(BOT_RUN_KINDS)
                  .filter((key) => key !== "introduction")
                  .map((key) => [key, { term: { "properties.botRunKind": key } }])
              )
            }
          }
        }
      },
      ...ended,
      duration: {
        ...outcome(["completed", "failed", "interrupted", "outcome_unknown"]),
        aggs: { ms: { avg: { field: "properties.botDurationMs" } } }
      },
      works_created: metric(BOT_EVENTS.workCreated),
      works_completed: metric(BOT_EVENTS.workCompleted),
      works_reopened: metric(BOT_EVENTS.workReopened),
      connected: metric(BOT_EVENTS.connected),
      revoked: metric(BOT_EVENTS.revoked)
    }
  }
}

export function parseBotMetrics(raw: unknown): BotOverviewData {
  const root = record(raw)
  if (root.timed_out || (record(root._shards).failed ?? 0) > 0)
    throw new Error("Bot 统计查询未完整完成，请重试")
  const aggs = record(root.aggregations)
  if (!Object.keys(aggs).length) throw new Error("Bot 统计返回数据不完整")
  const count = (key: string) => number(record(aggs[key]).doc_count)
  const started = record(aggs.started),
    channels = record(record(started.channels).buckets),
    kinds = record(record(started.kinds).buckets)
  const completed = count("completed"),
    failed = count("failed")
  const duration = record(record(aggs.duration).ms).value
  if (duration !== null) number(duration)
  return {
    source: "es",
    hasData: number(record(aggs.observed).value) > 0,
    activeBots: number(record(started.bots).value),
    activeOwners: number(record(started.owners).value),
    createdBots: count("created"),
    started: count("started"),
    completed,
    failed,
    cancelled: count("cancelled"),
    superseded: count("superseded"),
    successRate: completed + failed > 0 ? completed / (completed + failed) : null,
    avgDurationMs:
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    worksCreated: count("works_created"),
    worksCompleted: count("works_completed"),
    worksReopened: count("works_reopened"),
    connected: count("connected"),
    revoked: count("revoked"),
    channels: Object.keys(BOT_CHANNELS).map((key) => ({
      key: key as keyof typeof BOT_CHANNELS,
      count: number(record(channels[key]).doc_count)
    })),
    runKinds: Object.keys(BOT_RUN_KINDS)
      .filter((key) => key !== "introduction")
      .map((key) => ({
        key: key as keyof typeof BOT_RUN_KINDS,
        count: number(record(kinds[key]).doc_count)
      }))
  }
}

/** Development preview only; never used as a fallback for a production ES error. */
export function makeMockBotOverview(
  range: { from: string; to: string },
  scale = 1
): BotOverviewData {
  const from = Date.parse(range.from),
    to = Date.parse(range.to)
  const day = 86400000,
    duration = to - from
  if (!Number.isFinite(duration) || duration < 0 || duration > 366 * day)
    throw new Error("请选择有效的统计时间范围（最多 366 天）")
  const weight = Number.isFinite(scale) ? Math.max(0, scale) : 1
  const started = Math.round((duration / 3600000) * 18 * weight)
  const completed = Math.round(started * 0.94)
  const failed = Math.round(started * 0.02)
  const cancelled = Math.min(started - completed - failed, Math.round(started * 0.015))
  const days = Math.max(1, duration / day)
  const activeBots = Math.min(started, Math.round(12 * Math.sqrt(days) * weight))
  const worksCreated = Math.round(started * 0.06)
  const distribute = <T extends string>(
    keys: T[],
    shares: number[]
  ): { key: T; count: number }[] => {
    let remaining = started
    return keys.map((key, i) => {
      const count = i === keys.length - 1 ? remaining : Math.floor(started * shares[i])
      remaining -= count
      return { key, count }
    })
  }
  return {
    source: "mock",
    hasData: started > 0,
    activeBots,
    activeOwners: Math.round(activeBots * 0.7),
    createdBots: Math.min(activeBots, Math.round(3 * days * weight)),
    started,
    completed,
    failed,
    cancelled,
    superseded: started - completed - failed - cancelled,
    successRate: completed + failed ? completed / (completed + failed) : null,
    avgDurationMs: started ? 42000 : null,
    worksCreated,
    worksCompleted: Math.round(worksCreated * 0.74),
    worksReopened: Math.round(worksCreated * 0.15),
    connected: Math.round(3 * days * weight),
    revoked: Math.round(days * weight),
    channels: distribute(
      Object.keys(BOT_CHANNELS) as (keyof typeof BOT_CHANNELS)[],
      [0.53, 0.17, 0.18, 0.12]
    ),
    runKinds: distribute(
      ["chat", "work", "schedule", "collaboration", "notification"],
      [0.67, 0.16, 0.07, 0.06, 0.04]
    )
  }
}
