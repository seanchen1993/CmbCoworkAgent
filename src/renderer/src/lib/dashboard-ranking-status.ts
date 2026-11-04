export interface CountedRankingItem {
  count: number
}

export function sumRankingCounts(items: CountedRankingItem[]): number {
  return items.reduce((total, item) => total + item.count, 0)
}

export function formatRankingMatchStatus(
  items: CountedRankingItem[],
  includeTotalCalls = false
): string {
  const matchedItemsLabel = `匹配 ${items.length} 项`
  if (!includeTotalCalls) return matchedItemsLabel
  return `${matchedItemsLabel} · ${Math.round(sumRankingCounts(items)).toLocaleString("zh-CN")} 次调用`
}
