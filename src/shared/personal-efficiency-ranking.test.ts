import { describe, expect, it } from "vitest"
import {
  defaultPersonalEfficiencyWeights,
  emptyPersonalEfficiencyValues,
  type PersonalEfficiencyPerson
} from "./personal-efficiency"
import { rankPersonalEfficiency } from "./personal-efficiency-ranking"

function person(sapId: string, adoptionRate: number | null): PersonalEfficiencyPerson {
  return {
    sapId,
    userName: sapId,
    rooms: [],
    values: { ...emptyPersonalEfficiencyValues(), adoptionRate },
    projectCount: 0,
    durationProjectCount: 0,
    densityBugCount: 0,
    densityFunctionPoints: 0,
    pushedAdoptedLines: null,
    pushedEffectiveGeneratedLines: null,
    projects: [],
    code: []
  }
}

describe("个人列表与 Excel 共用排名", () => {
  it("同值同名次、后续名次跳号，人员编号稳定排序，缺失始终置后", () => {
    const people = [person("3", null), person("2", 80), person("1", 80), person("4", 0)]
    const result = rankPersonalEfficiency(people, defaultPersonalEfficiencyWeights())
    expect(result.map((row) => [row.person.sapId, row.rank, row.score])).toEqual([
      ["1", 1, 8000],
      ["2", 1, 8000],
      ["4", 3, 0],
      ["3", null, null]
    ])
    expect(people.map((entry) => entry.sapId)).toEqual(["3", "2", "1", "4"])
  })
  it("单列升序仍保留真实零，缺失不参与名次", () => {
    const result = rankPersonalEfficiency(
      [person("1", 80), person("2", 0), person("3", null)],
      defaultPersonalEfficiencyWeights(),
      "adoptionRate",
      "asc"
    )
    expect(result.map((row) => [row.person.sapId, row.rank])).toEqual([
      ["2", 1],
      ["1", 2],
      ["3", null]
    ])
  })
  it("非自然月忽略已保存的月度权重，不因月度值缺失丢失综合分，且不修改保存值", () => {
    const weights = { ...defaultPersonalEfficiencyWeights(), aiPushRate: 50, cliPushedLines: -100 }
    const result = rankPersonalEfficiency(
      [person("1", 80), person("2", 60)],
      weights,
      "score",
      "desc",
      false
    )
    expect(result.map((row) => [row.person.sapId, row.score, row.rank])).toEqual([
      ["1", 8000, 1],
      ["2", 6000, 2]
    ])
    expect(weights.aiPushRate).toBe(50)
    expect(weights.cliPushedLines).toBe(-100)
    expect(rankPersonalEfficiency([person("1", 80)], weights)[0].score).toBeNull()
  })
  it("非自然月原月度排序回退综合分，只有月度权重时不产生排名", () => {
    const weights = { ...defaultPersonalEfficiencyWeights(), aiPushRate: 50 }
    const result = rankPersonalEfficiency(
      [person("2", 60), person("1", 80)],
      weights,
      "aiPushRate",
      "desc",
      false
    )
    expect(result.map((row) => [row.person.sapId, row.rank])).toEqual([
      ["1", 1],
      ["2", 2]
    ])
    expect(
      rankPersonalEfficiency(
        [person("1", 80)],
        { ...weights, adoptionRate: 0 },
        "score",
        "desc",
        false
      )[0].score
    ).toBeNull()
  })
})
