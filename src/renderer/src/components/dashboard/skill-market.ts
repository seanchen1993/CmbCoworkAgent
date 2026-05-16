import type { MarketItem } from "../../api/market"

/**
 * 将 Dashboard 上报的 Skill 名称和应用市场返回的 Skill 标识统一成同一种比较 key。
 *
 * 背景：
 * - Dashboard 的 usedSkills 里可能带 `$` 前缀，例如 `$code-review`
 * - trace 采集时可能会把版本拼到名称后面，例如 `code-review-v1.0.0`
 * - 应用市场的 filename 可能是压缩包名，例如 `code-review.zip`
 *
 * 为了判断“Dashboard 里的某个 Skill 是否存在于应用市场”，这些表现形式需要先归一化：
 * 1. 去掉首位 `$`
 * 2. 去掉常见压缩包后缀
 * 3. 去掉末尾版本号
 * 4. 转小写，避免大小写导致误判
 */
export function normalizeMarketSkillKey(value?: string): string {
  const base = String(value || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\.(zip|tar\.gz|tgz)$/i, "")

  if (!base) return ""

  return base
    .replace(/-v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/i, "")
    .trim()
    .toLowerCase()
}

/**
 * 构建只用于“是否存在”判断的市场 Skill key 集合。
 *
 * Overview 面板渲染列表时只需要知道某个 Skill 是否命中市场，
 * 用 Set 查询最轻量，也能避免把完整 MarketItem 传到只负责展示 tag 的组件里。
 *
 * 同时写入 item.name 和 item.filename 两类候选，是因为市场接口里的 name 与实际 zip 文件名
 * 在历史数据中不一定完全一致；两者任意一个匹配 Dashboard Skill，都认为该 Skill 存在于市场。
 */
export function buildMarketSkillKeySet(items: MarketItem[]): Set<string> {
  const keys = new Set<string>()
  for (const item of items) {
    const candidates = [item.name, item.filename]
    for (const candidate of candidates) {
      const key = normalizeMarketSkillKey(candidate)
      if (key) keys.add(key)
    }
  }
  return keys
}

/**
 * 构建用于“取市场详情”的 Skill Map。
 *
 * 导出 Excel 时除了判断是否存在，还要读取中文名称、上传人、精品/认证等字段，
 * 因此需要从归一化 key 反查完整的 MarketItem。
 *
 * 如果 name 和 filename 归一化后碰巧命中同一个 key，保留第一次写入的市场项。
 * 这样可以保持接口返回顺序的优先级，避免后面的 filename 候选覆盖 name 的精确命中。
 */
export function buildMarketSkillMap(items: MarketItem[]): Map<string, MarketItem> {
  const itemMap = new Map<string, MarketItem>()
  for (const item of items) {
    const candidates = [item.name, item.filename]
    for (const candidate of candidates) {
      const key = normalizeMarketSkillKey(candidate)
      if (key && !itemMap.has(key)) itemMap.set(key, item)
    }
  }
  return itemMap
}

/**
 * 判断 Dashboard Skill 是否存在于应用市场。
 *
 * 入参 skillName 通常来自 Dashboard 聚合结果，可能带版本号；
 * marketSkillKeys 则来自 buildMarketSkillKeySet，双方都走同一套归一化逻辑后再比较。
 */
export function hasMarketSkill(marketSkillKeys: Set<string>, skillName: string): boolean {
  const key = normalizeMarketSkillKey(skillName)
  return Boolean(key && marketSkillKeys.has(key))
}

/**
 * 获取 Dashboard Skill 对应的应用市场条目。
 *
 * 用于导出 Excel 的扩展字段：
 * - Skill 中文名称：MarketItem.chinese_name
 * - 上传用户：MarketItem.user_id，并可结合 dashboard.userProfiles 补齐
 * - 精品标识：MarketItem.featured
 * - 认证标识：MarketItem.tag
 *
 * 未命中时返回 null，调用方据此决定导出空值或“否”。
 */
export function getMarketSkillItem(
  marketSkillMap: Map<string, MarketItem>,
  skillName: string
): MarketItem | null {
  const key = normalizeMarketSkillKey(skillName)
  if (!key) return null
  return marketSkillMap.get(key) ?? null
}
