/**
 * 组织字段「没有值」的判定，含 trace 采集 bug 留下的占位串。
 *
 * 2026-08-27 的 `a00b2833f` 把身份和组织字段一起放进了 trace 的采集预算。预算耗尽时
 * `boundTelemetryValue` 返回占位串 `[trace budget exhausted]`，于是长会话的
 * upperOrgLv0..3 和 orgName 在 ES 里被写成了这个字符串。`22f603ceb`（09-02）已经把这
 * 些字段改回 clampText、不再走共享预算，但已经落库的文档改不了。
 *
 * 看板读到它会当成一个真实存在的室：顶部室筛选的下拉里多出一项，组织分布和团队标杆的
 * 排行里各占一格，还能被选中来筛数据。
 *
 * 占位串的含义是「这个值丢了」，和字段为空是同一件事，所以读侧按空处理，归到「未归类」。
 * 历史文档不会自己消失，这个兜底是常驻的，不是等数据清理完就能删的过渡代码。
 *
 * 边界：只管组织维度。同一批文档的 userName / sapId 也可能是这个占位串，那个得单独
 * 处理，用户维度没有「未归类」这个去处，把名字抹空只会换成一个无名用户，不会更好。
 */
export const TRACE_BUDGET_PLACEHOLDER = "[trace budget exhausted]"

/** 组织字段是否「没有值」：非字符串、空白，或采集 bug 留下的占位串。 */
export function isMissingOrgValue(value: unknown): boolean {
  if (typeof value !== "string") return true
  const text = value.trim()
  return text.length === 0 || text === TRACE_BUDGET_PLACEHOLDER
}

/** 读一个组织字段，没有值时返回 undefined，由调用方按「未归类」处理。 */
export function readOrgText(value: unknown): string | undefined {
  return isMissingOrgValue(value) ? undefined : (value as string).trim()
}

/**
 * 「这个组织字段有值但等价于空」的 ES term 子句；字段缺失由 `exists` 单独判。
 *
 * 占位串必须和空串一起出现在每一处判空的地方。只补一边的话，同一批文档会在两个口径里
 * 都站错队：「未归类」筛选漏掉它们，而「非空」过滤又放它们进排行。
 */
export function emptyOrgValueClauses(field: string): Record<string, unknown>[] {
  return [{ term: { [field]: "" } }, { term: { [field]: TRACE_BUDGET_PLACEHOLDER } }]
}
