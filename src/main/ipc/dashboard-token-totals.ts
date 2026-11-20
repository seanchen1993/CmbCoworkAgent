/**
 * Token 总量的取值口径：`totalTokens` 的 sum 聚合返回 0 时，分不出是"真的没用
 * token"还是"这个字段根本取不到"。
 *
 * ES 的 sum 聚合在没有任何文档带该字段时返回 `{"value": 0.0}`，是个合法的有限数。
 * 于是调用方原本写的
 *
 *   asNumber(aggs.total_tokens.value, totalInputTokens + totalOutputTokens)
 *
 * 里那个兜底永远走不到 —— asNumber 只在"不是有限数"时才回退，而 0 是有限数。
 * 作者的意图（取不到就用 输入+输出 凑）在代码里读得出来，但不可达。
 *
 * 判据是一个不变量：单条 trace 的 totalTokens 是 `usage.totalTokens ?? input + output`
 * 边收边累加出来的（trace/collector.ts），所以只要 输入+输出 > 0，totalTokens 就
 * 不可能是 0。一旦观察到"总量 0 而输入输出非 0"，唯一的解释就是总量字段没取到。
 *
 * 诚实边界：只有"全窗口一条都没有"能被识别。若索引里只有部分文档带 totalTokens，
 * sum 会返回一个偏小但非 0 的值，单看聚合结果无从判断，这里也不会去纠正。
 */
export function resolveTokenTotal(totalSum: unknown, inputSum: number, outputSum: number): number {
  const total = typeof totalSum === "number" && Number.isFinite(totalSum) ? totalSum : 0
  if (total > 0) return total
  return inputSum + outputSum
}
