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
  it("rejects whitespace-only Bot answers while preserving the workbench default", () => {
    const draft = {
      format: { type: "option" as const, optionIndex: 0 },
      name: { type: "other" as const, text: " \t\n　 " }
    }
    expect(userInputAnswers(questions, draft, true)).toBeNull()
    expect(userInputAnswers(questions, draft)?.name).toEqual({
      type: "other",
      questionId: "name",
      text: draft.name.text
    })
  })

  it("normalizes Bot custom text only at submission without changing the draft", () => {
    const draft = Object.freeze({
      name: Object.freeze({ type: "other" as const, text: "  青桐\n第二行　 " })
    })
    expect(userInputAnswers(questions.slice(1), draft, true)?.name).toEqual({
      type: "other",
      questionId: "name",
      text: "青桐\n第二行"
    })
    expect(draft.name.text).toBe("  青桐\n第二行　 ")
  })

  it("does not finish a Bot batch when an earlier custom answer is blank", () => {
    expect(
      userInputAnswers(
        questions,
        {
          format: { type: "other", text: "   " },
          name: { type: "other", text: "有效名称" }
        },
        true
      )
    ).toBeNull()
  })

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
