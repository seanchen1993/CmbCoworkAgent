import { describe, expect, it } from "vitest"
import { hasSuspectedTechnicalDetailSupplement } from "./technical-detail-supplement"

describe("hasSuspectedTechnicalDetailSupplement", () => {
  it("matches ten ASCII English letters accumulated across the full input", () => {
    expect(hasSuspectedTechnicalDetailSupplement("请调整 get_user_ids 的返回值")).toBe(true)
    expect(hasSuspectedTechnicalDetailSupplement("a-b_c.d/e fghij")).toBe(true)
  })

  it("does not match fewer than ten ASCII English letters", () => {
    expect(hasSuspectedTechnicalDetailSupplement("请修复 api 的 500 报错 abcd")).toBe(false)
  })

  it("does not count digits, punctuation, Chinese, or full-width Latin letters", () => {
    expect(hasSuspectedTechnicalDetailSupplement("１２３４＿中文ＡＢＣＤＥＦＧＨＩＪ")).toBe(false)
  })
})
