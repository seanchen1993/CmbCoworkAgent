import { expect, it } from "vitest"
import { buildMarketSkillMap, normalizeMarketSkillKey } from "../components/dashboard/skill-market"
import type { MarketItem } from "../api/market"

it.each([
  "$Code-Review-v1.zip",
  "code-review-v1.2",
  "code-review-2.3.4-beta.tgz",
  "code-review-v3.2.1.0.md",
  "code-review"
])("joins versioned contribution keys with market details: %s", (name) => {
  const item = { name, filename: name, chinese_name: "代码评审" } as MarketItem
  expect(normalizeMarketSkillKey(name)).toBe("code-review")
  expect(buildMarketSkillMap([item]).get("code-review")).toBe(item)
})
