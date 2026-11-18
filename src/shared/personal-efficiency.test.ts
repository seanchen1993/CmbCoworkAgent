import { describe, expect, it } from "vitest"
import {
  defaultPersonalEfficiencyWeights,
  emptyPersonalEfficiencyValues,
  personalEfficiencyScore
} from "./personal-efficiency"

describe("个人指标直接加权", () => {
  it("按百分数原值计算，负权重扣分，不归一化或除权重和", () => {
    const values = {
      ...emptyPersonalEfficiencyValues(),
      adoptionRate: 80,
      functionPoints: 200,
      bugCount: 3
    }
    const weights = {
      ...defaultPersonalEfficiencyWeights(),
      adoptionRate: 2,
      functionPoints: 1,
      bugCount: -100
    }
    expect(personalEfficiencyScore(values, weights)).toBe(60)
    expect(personalEfficiencyScore({ ...values, adoptionRate: 90 }, weights)).toBe(80)
  })
  it("缺失指标只在非零权重时影响综合排名，真实零可以参与", () => {
    const values = { ...emptyPersonalEfficiencyValues(), adoptionRate: 0 }
    expect(personalEfficiencyScore(values, defaultPersonalEfficiencyWeights())).toBe(0)
    expect(
      personalEfficiencyScore(values, { ...defaultPersonalEfficiencyWeights(), bugCount: -1 })
    ).toBeNull()
  })
  it("允许负权重相抵为零；全部零权重或越界、非有限值不计算", () => {
    const values = { ...emptyPersonalEfficiencyValues(), adoptionRate: 50, bugCount: 50 }
    expect(
      personalEfficiencyScore(values, { ...defaultPersonalEfficiencyWeights(), bugCount: -100 })
    ).toBe(0)
    expect(
      personalEfficiencyScore(values, { ...defaultPersonalEfficiencyWeights(), adoptionRate: 0 })
    ).toBeNull()
    for (const adoptionRate of [-101, 101, NaN, Infinity]) {
      expect(
        personalEfficiencyScore(values, { ...defaultPersonalEfficiencyWeights(), adoptionRate })
      ).toBeNull()
    }
  })
  it("月度缺失时，不产生虚假的月度综合分", () => {
    const weights = { ...defaultPersonalEfficiencyWeights(), adoptionRate: 0, aiPushRate: 1 }
    expect(personalEfficiencyScore(emptyPersonalEfficiencyValues(), weights)).toBeNull()
    expect(
      personalEfficiencyScore({ ...emptyPersonalEfficiencyValues(), aiPushRate: 35 }, weights)
    ).toBe(35)
  })
})
