import {
  BOT_CHANNELS,
  BOT_EVENTS,
  BOT_METRICS_VERSION,
  BOT_RUN_KINDS,
  type BotActiveUsersPage,
  type BotOverviewData
} from "../../shared/bots/telemetry"

type RecordValue = Record<string, any>
const record = (v: unknown): RecordValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : {}
const label = (v: unknown): string => {
  const text = typeof v === "string" ? v.trim() : ""
  return text.toLowerCase() === "unknown" ? "" : text
}
const number = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error("Bot 统计返回数据不完整")
  return v
}
const event = (name: string) => ({ term: { eventName: name } })
const metric = (name: string) => ({ filter: event(name) })
const runKind = (kind: string) => ({ term: { "properties.botRunKind": kind } })
const groupBindingEvent = {
  bool: {
    filter: [event(BOT_EVENTS.connected), { term: { "properties.botChannel": "zhaohu_group" } }]
  }
}
const outcome = (values: string[]) => ({
  filter: {
    bool: { filter: [event(BOT_EVENTS.ended), { terms: { "properties.botOutcome": values } }] }
  }
})
const activeOwner = {
  bool: { filter: [{ exists: { field: "sapId" } }], must_not: [{ term: { sapId: "" } }] }
}
const ACTIVE_USERS_PAGE_SIZE = 40

type BotActiveUsersRosterPage = {
  items: Omit<BotActiveUsersPage["items"][number], "zhaohuGroupBindings" | "assignedWorks">[]
  nextCursor: BotActiveUsersPage["nextCursor"]
}

function botCardinality(precisionThreshold: number) {
  return { cardinality: { field: "properties.botId", precision_threshold: precisionThreshold } }
}

function botMetricsScope(filters: Record<string, unknown>[]) {
  return {
    bool: {
      filter: [{ term: { "properties.botMetricsVersion": BOT_METRICS_VERSION } }, ...filters],
      must_not: [
        { term: { "properties.botChannel": "simulation" } },
        { term: { "properties.botSimulation": 1 } },
        { term: { "properties.botRunKind": "introduction" } }
      ]
    }
  }
}

function completeAggregations(raw: unknown) {
  const root = record(raw)
  if (root.timed_out || (record(root._shards).failed ?? 0) > 0)
    throw new Error("Bot 统计查询未完整完成，请重试")
  const aggs = record(root.aggregations)
  if (!Object.keys(aggs).length) throw new Error("Bot 统计返回数据不完整")
  return aggs
}

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
    query: botMetricsScope([{ terms: { eventName: Object.values(BOT_EVENTS) } }, ...filters]),
    aggs: {
      observed: { value_count: { field: "eventId" } },
      created: metric(BOT_EVENTS.created),
      started: {
        ...metric(BOT_EVENTS.started),
        aggs: {
          bots: botCardinality(40000),
          owners: {
            filter: activeOwner,
            aggs: { distinct: { cardinality: { field: "sapId", precision_threshold: 40000 } } }
          },
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
                  .map((key) => [key, runKind(key)])
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
      revoked: metric(BOT_EVENTS.revoked),
      attachments_sent: metric(BOT_EVENTS.attachmentSent)
    }
  }
}

export function parseBotMetrics(raw: unknown): BotOverviewData {
  const aggs = completeAggregations(raw)
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
    activeOwners: number(record(record(started.owners).distinct).value),
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
    attachmentsSent: count("attachments_sent"),
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

function isSapId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
}

function validateCursor(cursor: string | undefined): void {
  if (cursor !== undefined && !isSapId(cursor)) throw new Error("活跃用户分页游标无效")
}

/** Load a page of start-event accounts with counts and latest activity fields. */
export function buildBotActiveUsersQuery(filters: Record<string, unknown>[], cursor?: string) {
  validateCursor(cursor)
  return {
    size: 0,
    track_total_hits: false,
    query: botMetricsScope([event(BOT_EVENTS.started), activeOwner, ...filters]),
    aggs: {
      users: {
        composite: {
          size: ACTIVE_USERS_PAGE_SIZE,
          sources: [{ sapId: { terms: { field: "sapId" } } }],
          ...(cursor === undefined ? {} : { after: { sapId: cursor } })
        },
        aggs: {
          bots: botCardinality(3000),
          chat_runs: { filter: runKind("chat") },
          latest_user: {
            top_hits: {
              size: 1,
              sort: [{ eventTime: { order: "desc" } }],
              _source: { includes: ["userName", "orgName", "upperOrgLv1", "eventTime"] }
            }
          }
        }
      }
    }
  }
}

export function parseBotActiveUsers(raw: unknown, cursor?: string): BotActiveUsersRosterPage {
  const users = record(completeAggregations(raw).users)
  if (!Array.isArray(users.buckets) || users.buckets.length > ACTIVE_USERS_PAGE_SIZE)
    throw new Error("活跃用户列表返回数据不完整")
  let previous = cursor
  const advances = (next: string, prior?: string) =>
    prior === undefined || Buffer.compare(Buffer.from(next), Buffer.from(prior)) > 0
  const items = users.buckets.map((rawBucket) => {
    const bucket = record(rawBucket)
    const sapId = record(bucket.key).sapId
    if (!isSapId(sapId) || !advances(sapId, previous)) throw new Error("活跃用户列表返回顺序无效")
    previous = sapId
    const started = bucket.doc_count
    if (!Number.isSafeInteger(started) || started <= 0) throw new Error("活跃用户处理轮次无效")
    const chatRuns = record(bucket.chat_runs).doc_count
    if (!Number.isSafeInteger(chatRuns) || chatRuns < 0 || chatRuns > started)
      throw new Error("活跃用户对话处理轮次无效")
    const activeBots = record(bucket.bots).value
    if (!Number.isSafeInteger(activeBots) || activeBots < 0)
      throw new Error("活跃用户 Bot 数无效")
    const hits = record(record(bucket.latest_user).hits).hits
    const latest = record(Array.isArray(hits) ? hits[0] : undefined)
    const source = record(latest._source)
    const userName = label(source.userName)
    const organization = label(source.orgName) || label(source.upperOrgLv1)
    const eventTime = typeof source.eventTime === "string" ? Date.parse(source.eventTime) : NaN
    const sortTime = Array.isArray(latest.sort) ? latest.sort[0] : undefined
    const lastActive = new Date(
      Number.isFinite(eventTime) ? eventTime : typeof sortTime === "number" ? sortTime : NaN
    )
    return {
      sapId,
      ...(userName ? { userName } : {}),
      ...(organization ? { organization } : {}),
      activeBots,
      chatRuns,
      ...(Number.isFinite(lastActive.getTime()) ? { lastActiveAt: lastActive.toISOString() } : {})
    }
  })
  if (users.after_key == null) return { items, nextCursor: null }
  const nextCursor = record(users.after_key).sapId
  if (
    !isSapId(nextCursor) ||
    !items.length ||
    !advances(nextCursor, cursor) ||
    (nextCursor !== previous && !advances(nextCursor, previous))
  )
    throw new Error("活跃用户分页游标未前进")
  return { items, nextCursor }
}

/** Fetch this page's work creations and group bindings under the same scope as the overview. */
export function buildBotActiveUserActivityQuery(
  filters: Record<string, unknown>[],
  sapIds: string[]
) {
  return {
    size: 0,
    track_total_hits: false,
    query: botMetricsScope([
      {
        bool: {
          should: [event(BOT_EVENTS.workCreated), groupBindingEvent],
          minimum_should_match: 1
        }
      },
      { terms: { sapId: sapIds } },
      ...filters
    ]),
    aggs: {
      users: {
        filters: {
          filters: Object.fromEntries(sapIds.map((id) => [id, { term: { sapId: id } }]))
        },
        aggs: {
          assigned_works: metric(BOT_EVENTS.workCreated),
          group_bindings: { filter: groupBindingEvent }
        }
      }
    }
  }
}

export function addBotActiveUserActivityCounts(
  page: BotActiveUsersRosterPage,
  raw: unknown
): BotActiveUsersPage {
  const buckets = record(record(completeAggregations(raw).users).buckets)
  return {
    ...page,
    items: page.items.map((item) => {
      const bucket = record(buckets[item.sapId])
      const zhaohuGroupBindings = record(bucket.group_bindings).doc_count
      if (!Number.isSafeInteger(zhaohuGroupBindings) || zhaohuGroupBindings < 0)
        throw new Error("招乎群聊绑定数无效")
      const assignedWorks = record(bucket.assigned_works).doc_count
      if (!Number.isSafeInteger(assignedWorks) || assignedWorks < 0)
        throw new Error("交办任务数无效")
      return { ...item, zhaohuGroupBindings, assignedWorks }
    })
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
    attachmentsSent: Math.round(started * 0.24),
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

export function makeMockBotActiveUsers(
  range: { from: string; to: string },
  scale: number,
  cursor?: string,
  organizations: readonly string[] = []
): BotActiveUsersPage {
  validateCursor(cursor)
  const { activeOwners: total, started, activeBots, connected, worksCreated, runKinds } =
    makeMockBotOverview(range, scale)
  const chatRuns = runKinds.find(({ key }) => key === "chat")?.count ?? 0
  const groupBindings = Math.round(connected * 0.65)
  const sapId = (n: number) => `demo-${String(n).padStart(4, "0")}`
  const offset = cursor === undefined ? 0 : Number(cursor.slice(5))
  if (
    cursor !== undefined &&
    (!Number.isInteger(offset) || offset < 1 || offset > total || sapId(offset) !== cursor)
  )
    throw new Error("活跃用户分页游标无效")
  const end = Math.min(total, offset + ACTIVE_USERS_PAGE_SIZE)
  const rangeEnd = Date.parse(range.to)
  const recentWindow = Math.min(rangeEnd - Date.parse(range.from), 24 * 3600000)
  return {
    items: Array.from({ length: end - offset }, (_, i) => {
      const index = offset + i
      const share = (count: number) => Math.floor(count / total) + (index < count % total ? 1 : 0)
      return {
        sapId: sapId(index + 1),
        userName: `示例用户 ${index + 1}`,
        organization: organizations.length ? organizations[index % organizations.length] : "示例组织",
        activeBots: Math.min(share(started), activeBots, 1 + (index % 4)),
        zhaohuGroupBindings: share(groupBindings),
        assignedWorks: share(worksCreated),
        chatRuns: share(chatRuns),
        lastActiveAt: new Date(rangeEnd - (recentWindow * (index + 1)) / (total + 1)).toISOString()
      }
    }),
    nextCursor: end < total ? sapId(end) : null
  }
}
