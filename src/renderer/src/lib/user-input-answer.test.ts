import { describe, expect, it } from "vitest"
import { userInputAnswers } from "./user-input-answer"

const questions = [
  {
    id: "format",
    header: "格式",
    question: "选择格式？",
    options: [
      { label: "简版", description: "核心内容" },
      { label: "完整版", description: "全部内容" }
    ]
  },
  { id: "name", header: "名称", question: "如何命名？", options: [] }
]

describe("original user input response projection", () => {
  it("does not submit missing questions, empty custom answers, or invalid options", () => {
    expect(userInputAnswers(questions, {})).toBeNull()
    expect(userInputAnswers(questions, { format: { type: "option", optionIndex: 0 } })).toBeNull()
    expect(
      userInputAnswers(questions, {
        format: { type: "option", optionIndex: 8 },
        name: { type: "other", text: "合成" }
      })
    ).toBeNull()
    expect(
      userInputAnswers(questions, {
        format: { type: "option", optionIndex: 0 },
        name: { type: "other", text: "" }
      })
    ).toBeNull()
  })

  it("preserves exact option identity, custom text and trimmed supplementary text", () => {
    expect(
      userInputAnswers(questions, {
        format: {
          type: "option",
          optionIndex: 1,
          additionalText: "  保留测试\n和说明  ",
          additionalTextOpen: true
        },
        name: { type: "other", text: "合成名称\n第二行" },
        stale: { type: "other", text: "上一轮草稿" }
      })
    ).toEqual({
      format: {
        type: "option",
        questionId: "format",
        optionIndex: 1,
        label: "完整版",
        description: "全部内容",
        additionalText: "保留测试\n和说明"
      },
      name: { type: "other", questionId: "name", text: "合成名称\n第二行" }
    })
  })

  it("can serialize a directly chosen single option without changing the caller's draft", () => {
    const draft = Object.freeze({
      format: Object.freeze({ type: "option" as const, optionIndex: 0, additionalText: " " })
    })
    expect(userInputAnswers(questions.slice(0, 1), draft)).toEqual({
      format: {
        type: "option",
        questionId: "format",
        optionIndex: 0,
        label: "简版",
        description: "核心内容"
      }
    })
    expect(draft.format.additionalText).toBe(" ")
  })
})
