import { marketApi, type MarketItem } from "../api/market"
import { getDefaultRange } from "../components/dashboard/use-dashboard"

export type SkillSortMode = "default" | "calls_desc" | "calls_asc" | "users_desc" | "users_asc"

export const SCENE_CATEGORY_OPTIONS = [
  "治理类场景/架构红线",
  "治理类场景/应用安全",
  "治理类场景/云应用架构转型治理",
  "研发类场景/应用类研发",
  "研发类场景/数据类型研发",
  "通用场景"
] as const

export const DEFAULT_SCENE_CATEGORY = SCENE_CATEGORY_OPTIONS[0]

/**
 * 单个 Skill 的统计指标。
 * calls: 调用次数
 * users: 使用用户数（去重后）
 */
export interface SkillUsageSummaryMetric {
  calls: number
  users: number
}

interface SkillUsageBucket {
  key?: string
  doc_count?: number
  unique_users?: { value?: number }
}

interface SkillUsageDashboardData {
  aggregations?: {
    by_skill?: {
      buckets?: SkillUsageBucket[]
    }
  }
}

export interface SkillWithUsage extends MarketItem {
  calls: number
  users: number
}

export interface GetAllSkillsResult {
  success: boolean
  data?: SkillWithUsage[]
  summary?: Record<string, SkillUsageSummaryMetric>
  error?: string
}

/**
 * 统一 Skill 名称 key，解决“同一技能不同上报格式”导致无法聚合的问题。
 *
 * 典型场景：
 * - 上报里可能是 `$skill-name`（带前缀）
 * - 也可能是 `skill-name-v1.2.3`（带版本）
 *
 * 该函数会：
 * 1) 去掉首位 `$`
 * 2) 去掉尾部版本号（如 `-v1.2.3` / `-1.2.3-beta`）
 * 3) 转小写，便于做稳定键匹配
 *
 * @param rawName 原始 skill 名称
 * @returns 归一化后的 skill key（空值返回空字符串）
 */
export function normalizeSkillMetricKey(rawName?: string): string {
  const base = String(rawName || "").trim().replace(/^\$/, "")
  if (!base) return ""
  // Trace 中 usedSkills 可能是 `${name}-${version}`，统一还原成 skill name。
  return base.replace(/-v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i, "").trim().toLowerCase()
}

/**
 * 按 skill 名从汇总表中读取指标（内部自动做名称归一化）。
 *
 * @param summary skill 指标汇总表（key 为归一化名称）
 * @param rawName 原始 skill 名称
 * @returns 命中返回指标对象，未命中返回 null
 */
export function getSkillMetricByName(
  summary: Record<string, SkillUsageSummaryMetric>,
  rawName?: string
): SkillUsageSummaryMetric | null {
  const key = normalizeSkillMetricKey(rawName)
  if (!key) return null
  return summary[key] ?? null
}

/**
 * 将 dashboard `by_skill` buckets 聚合为可直接查询的 summary map。
 *
 * 规则说明：
 * - 调用次数（calls）：同一 skill 的不同版本桶做累加
 * - 用户数（users）：同一 skill 的不同版本桶取最大值
 *   说明：不同版本桶的 unique users 直接相加会放大，这里用 max 作为保守口径
 *
 * @param buckets ES 聚合桶数组
 * @returns key 为归一化 skill 名称的指标表
 */
export function buildSkillUsageSummaryFromBuckets(
  buckets: SkillUsageBucket[]
): Record<string, SkillUsageSummaryMetric> {
  const nextMap: Record<string, SkillUsageSummaryMetric> = {}
  for (const bucket of buckets) {
    const key = normalizeSkillMetricKey(bucket.key)
    if (!key) continue
    const current = nextMap[key] ?? { calls: 0, users: 0 }
    nextMap[key] = {
      // 调用次数累加不同版本桶
      calls: current.calls + (bucket.doc_count ?? 0),
      // 用户数取最大值，避免不同版本桶相加放大
      users: Math.max(current.users, bucket.unique_users?.value ?? 0)
    }
  }
  return nextMap
}

/**
 * 按调用次数/用户数对 skill 列表排序。
 *
 * 默认排序是 `calls_desc`（调用次数从高到低）。
 * 当主排序字段相同时，会用另一个指标作为次排序，再用 name 做最终稳定排序。
 *
 * @param items 待排序的 skill 列表（至少包含 name 字段）
 * @param summary skill 指标汇总表
 * @param sortMode 排序模式
 * @returns 排序后的新数组（不会修改原数组）
 */
export function sortSkillItemsByUsage<T extends { name: string }>(
  items: T[],
  summary: Record<string, SkillUsageSummaryMetric>,
  sortMode: SkillSortMode = "calls_desc"
): T[] {
  if (sortMode === "default") return [...items]

  const list = [...items]
  const compareByName = (a: T, b: T): number => a.name.localeCompare(b.name, "zh-CN")
  const getCalls = (item: T): number => getSkillMetricByName(summary, item.name)?.calls ?? 0
  const getUsers = (item: T): number => getSkillMetricByName(summary, item.name)?.users ?? 0

  list.sort((a, b) => {
    const callsA = getCalls(a)
    const callsB = getCalls(b)
    const usersA = getUsers(a)
    const usersB = getUsers(b)

    switch (sortMode) {
      case "calls_desc":
        return callsB - callsA || usersB - usersA || compareByName(a, b)
      case "calls_asc":
        return callsA - callsB || usersA - usersB || compareByName(a, b)
      case "users_desc":
        return usersB - usersA || callsB - callsA || compareByName(a, b)
      case "users_asc":
        return usersA - usersB || callsA - callsB || compareByName(a, b)
      default:
        return 0
    }
  })

  return list
}

/**
 * 一站式函数：从 dashboard 数据中提取 summary，并返回排序后的列表。
 *
 * 适合在页面层直接使用，避免每个页面都重复写：
 * 1) 解析 buckets
 * 2) 计算 summary
 * 3) 根据 sortMode 排序
 *
 * @param items 待展示 skill 列表
 * @param dashboardData dashboard 查询返回对象（含 aggregations.by_skill.buckets）
 * @param sortMode 排序模式，默认 `calls_desc`
 * @returns { summary, sortedItems }
 */
export function buildSkillUsageData<T extends { name: string }>(
  items: T[],
  dashboardData: SkillUsageDashboardData | undefined,
  sortMode: SkillSortMode = "calls_desc"
): {
  summary: Record<string, SkillUsageSummaryMetric>
  sortedItems: T[]
} {
  const buckets = dashboardData?.aggregations?.by_skill?.buckets ?? []
  const summary = buildSkillUsageSummaryFromBuckets(buckets)
  const sortedItems = sortSkillItemsByUsage(items, summary, sortMode)
  return { summary, sortedItems }
}

/**
 * 一站式获取 Skill 列表（无需传参）：
 * 1) 拉取 marketplace skills
 * 2) 拉取 dashboard skillUsageSummary
 * 3) 结合调用次数/使用用户数
 * 4) 默认按调用次数从高到低排序
 */
export async function getAllSkills(): Promise<GetAllSkillsResult> {
  try {
    const skillsRes = await marketApi.getSkills()
    if (!skillsRes.success || !skillsRes.data) {
      return { success: false, error: skillsRes.error || "获取 skills 失败" }
    }

    let dashboardData: SkillUsageDashboardData | undefined
    if (typeof window.api?.dashboard?.skillUsageSummary === "function") {
      const range = getDefaultRange("month")
      const usageRes = await window.api.dashboard.skillUsageSummary(range, "month")
      if (usageRes.success && usageRes.data) {
        dashboardData = usageRes.data as SkillUsageDashboardData
      }
    }

    const { summary, sortedItems } = buildSkillUsageData(
      skillsRes.data,
      dashboardData,
      "calls_desc"
    )

    const data: SkillWithUsage[] = sortedItems.map((item) => {
      const metric = getSkillMetricByName(summary, item.name) ?? { calls: 0, users: 0 }
      return {
        ...item,
        calls: metric.calls,
        users: metric.users
      }
    })

    return {
      success: true,
      data,
      summary
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取 skills 数据失败"
    }
  }
}
