import { describe, expect, it } from "vitest"
import { botQuestionsSchema, readBotQuestions, validateBotQuestionAnswer } from "./bot-questions"
import { questionsSchema, validateQuestionIds } from "./user-input-schema"

const input = {
  questions: [
    {
      id: "target",
      header: "目标",
      question: "部署到哪里？",
      options: [
        { label: "测试", description: "验证功能" },
        { label: "生产", description: "正式使用" }
      ]
    },
    { id: "branch", header: "分支", question: "使用哪个分支？", options: [] }
  ]
}
const answers = {
  target: {
    type: "option",
    questionId: "target",
    optionIndex: 0,
    label: "伪造选项",
    description: "伪造描述",
    additionalText: "先做验证"
  },
  branch: { type: "other", questionId: "branch", text: " main " }
}
const submit = (value: unknown) =>
  validateBotQuestionAnswer(input, JSON.stringify({ status: "submitted", answers: value }))

describe("shared structured Bot questions", () => {
  it("reuses the Cmb question contract and supports required free-text fields", () => {
    expect(botQuestionsSchema.parse(input)).toEqual(input)
    expect(questionsSchema.safeParse(input).success).toBe(false) // Original desktop tool remains choice-based.
    expect(readBotQuestions(JSON.stringify({ botQuestions: { version: 1, input } }))).toEqual(input)
    expect(readBotQuestions("普通问题")).toBeNull()
    expect(readBotQuestions(JSON.stringify({ botQuestions: { version: 2, input } }))).toBeNull()
    expect(() =>
      questionsSchema
        .superRefine(validateQuestionIds)
        .parse({ questions: [input.questions[0], input.questions[0]] })
    ).toThrow("Duplicate")
  })
  it("binds answers to exact field IDs and obtains option text from the original request", () => {
    expect(JSON.parse(submit(answers))).toEqual({
      status: "submitted",
      answers: {
        target: { ...answers.target, label: "测试", description: "验证功能" },
        branch: { ...answers.branch, text: "main" }
      }
    })
    expect(submit(JSON.parse(submit(answers)).answers)).toBe(submit(answers))
  })
  it("does not fabricate default answers for cancellation", () => {
    expect(
      JSON.parse(validateBotQuestionAnswer(input, '{"status":"cancelled","answers":{}}'))
    ).toEqual({ status: "cancelled", answers: {} })
    expect(() =>
      validateBotQuestionAnswer(input, JSON.stringify({ status: "cancelled", answers }))
    ).toThrow("格式无效")
  })
  it("validates multi-select choices, deduplicates neither silently nor by client-provided labels", () => {
    const multiple = { questions: [{ ...input.questions[0], multiple: true }] }
    expect(botQuestionsSchema.parse(multiple)).toEqual(multiple)
    const validate = (optionIndices: number[]) =>
      validateBotQuestionAnswer(
        multiple,
        JSON.stringify({
          status: "submitted",
          answers: {
            target: {
              type: "multiple",
              questionId: "target",
              optionIndices,
              labels: ["客户端伪造"]
            }
          }
        })
      )
    expect(JSON.parse(validate([1, 0])).answers.target).toEqual({
      type: "multiple",
      questionId: "target",
      optionIndices: [0, 1],
      labels: ["测试", "生产"]
    })
    for (const indices of [[], [0, 0], [3]]) expect(() => validate(indices)).toThrow()
    expect(() =>
      validateBotQuestionAnswer({ questions: [input.questions[0]] }, validate([0]))
    ).toThrow("多选答案")
    expect(() =>
      validateBotQuestionAnswer(
        multiple,
        JSON.stringify({ status: "submitted", answers: { target: answers.target } })
      )
    ).toThrow("多选格式")
  })
  it("rejects missing, unknown, blank or invalid choices without accepting a partial form", () => {
    for (const value of [
      {},
      { target: answers.target },
      { ...answers, surprise: answers.branch },
      { ...answers, target: { ...answers.target, optionIndex: 4 } },
      { ...answers, branch: { ...answers.branch, questionId: "wrong" } },
      { ...answers, branch: { ...answers.branch, text: "  " } },
      { ...answers, branch: { ...answers.branch, text: "x".repeat(2001) } }
    ])
      expect(() => submit(value)).toThrow()
    expect(() => validateBotQuestionAnswer(input, "approve")).toThrow("格式无效")
  })
  it("rejects duplicated/reserved IDs, a lone choice and secret field definitions", () => {
    for (const questions of [
      [input.questions[0], input.questions[0]],
      [{ ...input.questions[0], id: "constructor" }],
      [{ ...input.questions[0], options: [input.questions[0].options[0]] }],
      [{ ...input.questions[0], type: "password" }]
    ])
      expect(() => botQuestionsSchema.parse({ questions })).toThrow()
  })
})
