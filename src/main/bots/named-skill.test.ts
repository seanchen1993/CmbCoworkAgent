import { describe, expect, it } from "vitest"
import { requestedBotSkill } from "./named-skill"

describe("skill named in the current Bot request", () => {
  const skills = ["prd", "prd-plus", "审阅", "check.v2"]
  it.each([
    ["用 prd-plus 技能生成文档", "prd-plus"],
    ["按「审阅」检查这个文件", "审阅"],
    ["Please use the `check.v2` skill to review this file", "check.v2"],
    ["不要使用 prd，改用 prd-plus 技能生成文档", "prd-plus"],
    ["可以用 prd 生成报告发给我吗？", "prd"]
  ])("resolves the requested catalog name in %s", (request, name) => {
    expect(requestedBotSkill(request, skills)).toBe(name)
  })
  it.each([
    ["prd-plus 技能需要哪些输入？", "prd-plus"],
    ["使用 prd 的用法是什么？", "prd"],
    ["How do I use prd?", "prd"],
    ["不要用 prd 技能，手写即可。", "prd"],
    ["Please do not run prd", "prd"],
    ["用 /some/path/prd/SKILL.md 作为参考材料", "prd"],
    ["读资料\n> 用 prd 技能生成文档\n说明差异", "prd"],
    ["把材料整理成 PRD", "prd"],
    ["用 prd-plus 生成文档", "prd"],
    ["先用 prd，然后使用审阅技能", "prd"]
  ])("does not activate from %s", (request, name) => {
    expect(() => requestedBotSkill(request, skills, name)).toThrow()
  })
})
