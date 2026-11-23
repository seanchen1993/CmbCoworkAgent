export const MARKET_SKILL_LIST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MARKET_SKILL_LIST_MAX_ITEMS = 4096
export const MARKET_SKILL_CATALOG_CHANGED = "skills:marketCatalogChanged"

export interface MarketSkillCatalogPage {
  items: unknown[]
  total: number
}
