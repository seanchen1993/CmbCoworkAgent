import { describe, expect, it } from "vitest"
import {
  TRACE_BUDGET_PLACEHOLDER,
  emptyOrgValueClauses,
  isMissingOrgValue,
  readOrgText
} from "./dashboard-org-fields"

/**
 * 采集占位串在组织维度上必须和「空」同义。
 *
 * 这组用例钉的是一条一致性要求：判空的地方只要漏掉占位串，同一批文档就会在两个口径里
 * 都站错队——「未归类」筛选把它们漏掉，而「非空」过滤又放它们进排行，两边加起来比总数
 * 还多。所以读侧和查询侧用的是同一个判据。
 */

describe("组织字段的判空", () => {
  it("空、纯空白、字段缺失都算没有值", () => {
    expect(isMissingOrgValue("")).toBe(true)
    expect(isMissingOrgValue("   ")).toBe(true)
    expect(isMissingOrgValue(undefined)).toBe(true)
    expect(isMissingOrgValue(null)).toBe(true)
    // 非字符串（ES 里理论上不该出现）也按没有值处理，不把 NaN/对象抛给上层。
    expect(isMissingOrgValue(123)).toBe(true)
  })

  it("采集占位串算没有值", () => {
    // 2026-08-27 ~ 09-02 的构建把它写进了 upperOrgLv* 和 orgName。
    expect(isMissingOrgValue(TRACE_BUDGET_PLACEHOLDER)).toBe(true)
    expect(isMissingOrgValue(`  ${TRACE_BUDGET_PLACEHOLDER}  `)).toBe(true)
  })

  it("真实室名照常算有值", () => {
    expect(isMissingOrgValue("集中经营服务开发三室(成都)")).toBe(false)
    // 只是包含占位串的文本不等于占位串本身，不能误伤。
    expect(isMissingOrgValue(`前缀${TRACE_BUDGET_PLACEHOLDER}`)).toBe(false)
  })
})

describe("组织字段的读取", () => {
  it("占位串读成 undefined，由上层落到「未归类」", () => {
    expect(readOrgText(TRACE_BUDGET_PLACEHOLDER)).toBeUndefined()
    expect(readOrgText("")).toBeUndefined()
    expect(readOrgText(undefined)).toBeUndefined()
  })

  it("真实值去掉首尾空白后原样返回", () => {
    expect(readOrgText("  零售信息应用开发二室(成都)  ")).toBe("零售信息应用开发二室(成都)")
  })
})

describe("查询侧的判空子句", () => {
  it("空串和占位串一起列出，两者缺一不可", () => {
    expect(emptyOrgValueClauses("upperOrgLv1")).toEqual([
      { term: { upperOrgLv1: "" } },
      { term: { upperOrgLv1: TRACE_BUDGET_PLACEHOLDER } }
    ])
  })

  it("字段名由调用方给，LV0 和 LV1 共用同一判据", () => {
    expect(emptyOrgValueClauses("upperOrgLv0")).toEqual([
      { term: { upperOrgLv0: "" } },
      { term: { upperOrgLv0: TRACE_BUDGET_PLACEHOLDER } }
    ])
  })

  it("读侧和查询侧认的是同一个占位串", () => {
    // 两边各写一份字面量的话，改一处漏一处就会出现「下拉里没有、但筛出来是空」的怪状态。
    const [, placeholderClause] = emptyOrgValueClauses("upperOrgLv1")
    const value = (placeholderClause as { term: Record<string, string> }).term.upperOrgLv1
    expect(isMissingOrgValue(value)).toBe(true)
  })
})
