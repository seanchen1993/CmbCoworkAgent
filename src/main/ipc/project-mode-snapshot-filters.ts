/**
 * 项目运营概览的快照侧查询条件。
 *
 * 「项目有哪些」这件事只由 harness.project.snapshot 决定，总览聚合、项目列表、导出都从
 * 这里取同一组 filter，所以两个全局开关（仅精益项目 / 仅本期新建）必须收口在这个函数里，
 * 而不是各调用点自己拼——否则某一块忘了加，页面上几块数就会互相对不上。
 *
 * 放在 dashboard.ts 外面是为了能直接测：dashboard.ts 顶层 import 了 electron，测试里拉不动。
 *
 * ── 「仅本期新建」的口径 ────────────────────────────────────────────
 *
 * 口径：项目创建时间（快照 properties.lifecycleCreatedAt）落在当前所选时间范围内。它和
 * 每行的 per-range 指标（对话数、采纳率）数的不是一回事——那些数的是这段时间里发生的事，
 * 这个开关数的是这段时间里诞生的项目。所以「开关打开后列表为空但汇总还有数」不成立：
 * 两边都收口在同一组快照过滤条件上。
 *
 * 关于 ES mapping：devclaw_event 的 mapping 不在本仓库里，写这段代码时内网 ES 不可达，
 * 没能确认 properties.lifecycleCreatedAt 是 date 还是 keyword。range 查询对两者都成立，
 * 但成立的理由不同，所以把 keyword 那个更脆弱的前提写在这里：
 *
 *   date    —— ES 解析两端再比较，天然正确。
 *   keyword —— ES 比的是原始字符串，只有「比较的两端都是等宽 UTC ISO-8601」时字典序才
 *              等于时间序。当前恰好满足：范围两端 range.from / range.to 全部出自
 *              Date.prototype.toISOString()（use-dashboard 的 getDefaultRange /
 *              navigateRange / 自定义范围确认三条路），字段值出自建项目时的
 *              new Date().toISOString()（harness-board/service.ts），都是
 *              YYYY-MM-DDTHH:mm:ss.sssZ。
 *
 * 也就是说，谁把任意一端的时间格式换掉（改成带 +08:00 偏移、改成日期粒度、改成 epoch
 * 毫秒），这里会静默筛错而不是报错。改格式之前先回来看这段。
 *
 * 已知边角：老项目的 lifecycle.createAt 是从磁盘元数据原样读上来的（service.ts 的
 * normalizeProject 只截断长度、不校验格式），存在 "2026-01-01" 这种日期粒度甚至空串的
 * 数据。keyword 下它们会落在同日带时分秒的下界之前而被漏掉，空串则永远不命中。这里不做
 * 兜底：宁可少算，也不要让一条格式不明的记录混进「本期新建」。
 */

/** 项目快照事件名。上报侧在 services/harness-status-reporter.ts。 */
export const HARNESS_PROJECT_SNAPSHOT_EVENT = "harness.project.snapshot"

/** 快照上的项目创建时间字段。过滤和排序引用同一个字段，改名时别漏。 */
export const PROJECT_MODE_CREATED_AT_FIELD = "properties.lifecycleCreatedAt"

/** 快照上的精益项目标记字段。 */
export const PROJECT_MODE_FROM_LEAN_FIELD = "properties.projectFromLean"

export interface ProjectModeCreatedRange {
  from: string
  to: string
}

/** 两个全局开关的取值来源。dashboard.ts 的 OrgFilterOptions 结构上满足它。 */
export interface ProjectModeNarrowingOptions {
  fromLeanOnly?: boolean | null
  createdInRangeOnly?: boolean | null
}

function usableRange(
  range: ProjectModeCreatedRange | null | undefined
): ProjectModeCreatedRange | null {
  if (!range) return null
  const from = typeof range.from === "string" ? range.from : ""
  const to = typeof range.to === "string" ? range.to : ""
  // 缺任意一端就当开关没开。半个区间比全量更难解释，也更容易让人以为筛过了。
  return from && to ? { from, to } : null
}

/**
 * 拼到快照查询 filter 数组里的那一条。开关关闭（或范围缺失）时返回空数组，调用方直接
 * 展开即可，不需要在外面再写一次三元。
 */
export function buildProjectModeCreatedAtRangeFilters(
  createdInRangeOnly: boolean,
  range: ProjectModeCreatedRange | null | undefined
): Record<string, unknown>[] {
  if (!createdInRangeOnly) return []
  const usable = usableRange(range)
  if (!usable) return []
  // 两端都是闭区间，和 timeRangeFilter 对 eventTime 的口径保持一致。
  return [{ range: { [PROJECT_MODE_CREATED_AT_FIELD]: { gte: usable.from, lte: usable.to } } }]
}

/**
 * DEV mock 用的同口径判断。真实路径靠上面那条 ES 条件筛，mock 没有 ES，必须自己筛一遍，
 * 否则本地打开开关看不出任何变化。
 *
 * 这里用时间戳比较而不是字符串比较：mock 要表达的是「这个口径应该筛出什么」，不该把
 * ES keyword 下才需要的字典序前提也复制一份。缺失 / 解析不出来的创建时间一律不命中，
 * 对齐 ES 上 range 查询不匹配缺字段文档的行为。
 */
export function matchesProjectModeCreatedAtRange(
  lifecycleCreatedAt: string | null | undefined,
  createdInRangeOnly: boolean,
  range: ProjectModeCreatedRange | null | undefined
): boolean {
  if (!createdInRangeOnly) return true
  const usable = usableRange(range)
  if (!usable) return true
  if (typeof lifecycleCreatedAt !== "string" || !lifecycleCreatedAt) return false
  const createdAt = Date.parse(lifecycleCreatedAt)
  if (!Number.isFinite(createdAt)) return false
  const from = Date.parse(usable.from)
  const to = Date.parse(usable.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true
  return createdAt >= from && createdAt <= to
}

/**
 * 快照索引的 filter 组：快照事件 + 可选的 LV1 组织（快照顶层带 upperOrgLv1）+ 两个全局开关。
 *
 * 两个开关筛的都是快照自己的当前状态字段，随每轮 upsert 自愈，不需要回填历史事件。
 * createdRange 只在「仅本期新建」打开时才用得上，其余调用传 null。
 */
export function projectModeSnapshotFilters(
  orgFilterClause: Record<string, unknown> | null,
  fromLeanOnly = false,
  createdInRangeOnly = false,
  createdRange: ProjectModeCreatedRange | null = null
): Record<string, unknown>[] {
  return [
    { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } },
    ...(orgFilterClause ? [orgFilterClause] : []),
    // 「仅精益项目」：绑定了企业（精益）项目的项目。
    ...(fromLeanOnly ? [{ term: { [PROJECT_MODE_FROM_LEAN_FIELD]: true } }] : []),
    // 「仅本期新建」：和上面那条互相独立，可叠加。
    ...buildProjectModeCreatedAtRangeFilters(createdInRangeOnly, createdRange)
  ]
}

/**
 * 两个开关是否有任意一个打开。
 *
 * 决定要不要先解析项目 id 集：projectFromLean / lifecycleCreatedAt 只存在于快照上，
 * trace / code 事件里没有，所以遥测汇总只能靠 id 集圈定。
 */
export function projectModeNarrowingEnabled(
  opts: ProjectModeNarrowingOptions | undefined
): boolean {
  return opts?.fromLeanOnly === true || opts?.createdInRangeOnly === true
}

/**
 * 从 opts 取 projectModeSnapshotFilters 的后三个参数，供调用点展开。
 *
 * 收口成一个函数是因为调用点有六处：任何一处少传一个开关，那一块数就会和页面上其它块
 * 对不上，而且查询照样跑得通、不会报错。
 */
export function projectModeSnapshotFilterArgs(
  opts: ProjectModeNarrowingOptions | undefined,
  range: ProjectModeCreatedRange | null
): [boolean, boolean, ProjectModeCreatedRange | null] {
  return [opts?.fromLeanOnly === true, opts?.createdInRangeOnly === true, range]
}
