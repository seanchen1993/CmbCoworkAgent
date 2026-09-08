import { describe, expect, it } from "vitest"
import { formatSkillUseBlock } from "../../../shared/skill-use-block"
import { hasSuspectedTechnicalDetailSupplement } from "./technical-detail-supplement"

const SKILL_BLOCK = formatSkillUseBlock({
  name: "代码审查",
  path: "/Users/demo/.claude/skills/code-review/SKILL.md"
})

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

  it("ignores the skill-use block an explicitly chosen skill appends", () => {
    expect(hasSuspectedTechnicalDetailSupplement(SKILL_BLOCK)).toBe(false)
    expect(
      hasSuspectedTechnicalDetailSupplement(`帮我看下这个页面为什么打不开\n\n${SKILL_BLOCK}`)
    ).toBe(false)
  })

  it("still scores the user's own text when a skill was chosen alongside it", () => {
    expect(
      hasSuspectedTechnicalDetailSupplement(`请调整 get_user_ids 的返回值\n\n${SKILL_BLOCK}`)
    ).toBe(true)
  })

  it("ignores attachment and @file blocks, including the file body they carry", () => {
    expect(
      hasSuspectedTechnicalDetailSupplement(
        '看下这个文件\n\n<attachment filename="report.txt" type="text/plain" size="12">\nexport const handler = () => {}\n</attachment>'
      )
    ).toBe(false)
    expect(
      hasSuspectedTechnicalDetailSupplement(
        '看下这个文件\n\n<attachment filename="PRD.docx" path="C:\\Users\\demo\\PRD.docx" />'
      )
    ).toBe(false)
  })

  it("ignores the built-in browser prefix and the coordinator token", () => {
    expect(hasSuspectedTechnicalDetailSupplement("使用内置浏览器 browser_*工具：打开首页")).toBe(
      false
    )
    expect(hasSuspectedTechnicalDetailSupplement("[coordinator] 帮我排期")).toBe(false)
    expect(hasSuspectedTechnicalDetailSupplement("/goal 把首页打开速度提上去")).toBe(false)
  })

  it("keeps counting an absolute path the user pasted as their first token", () => {
    expect(hasSuspectedTechnicalDetailSupplement("/Users/demo/project/src 这个目录看下")).toBe(true)
  })
})
