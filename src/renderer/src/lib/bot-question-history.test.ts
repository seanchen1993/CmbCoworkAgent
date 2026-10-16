import { describe, expect, it } from "vitest"
import { botQuestionHistory } from "./bot-question-history"
import type { ToolCall } from "@/types"

const question = {
  id: "delivery",
  header: "交付",
  question: "需要哪种交付格式？",
  options: [
    { label: "其他", description: "由客户端移除的自由输入项" },
    { label: "报告", description: "交付报告" },
    { label: "源码", description: "交付源文件" }
  ]
}
const tool: ToolCall = {
  id: "question-call",
  name: "request_user_input",
  args: { questions: [question] }
}
const receipt = (status: string, answers: Record<string, unknown> = {}) => ({
  content: JSON.stringify({ status, requestId: "request", answers })
})

describe("Bot settled question history", () => {
  it("uses the submitted label after runtime option filtering, preserving clarification", () => {
    const history = botQuestionHistory(
      tool,
      receipt("submitted", {
        delivery: {
          type: "option",
          questionId: "delivery",
          optionIndex: 1,
          label: "源码",
          description: "交付源文件",
          additionalText: "包括测试\n保留 README"
        }
      })
    )
    expect(history?.questions[0].answer).toEqual({
      text: "源码",
      additionalText: "包括测试\n保留 README"
    })
  })

  it("keeps a custom answer as actual text instead of marking an option", () => {
    const history = botQuestionHistory(
      tool,
      receipt("submitted", {
        delivery: { type: "other", questionId: "delivery", text: "先交源码\n之后补报告" }
      })
    )
    expect(history?.questions[0].answer).toEqual({ text: "先交源码\n之后补报告" })
  })

  it("shows ignored and unanswered automatic resolution without inventing a selection", () => {
    for (const status of ["ignored", "auto_resolved"]) {
      const history = botQuestionHistory(tool, receipt(status))
      expect(history?.status).toBe(status)
      expect(history?.questions[0].answer).toBeUndefined()
      expect(history?.questions[0].question).toBe(question.question)
    }
  })

  it("distinguishes an automatic selection from a user submission", () => {
    const history = botQuestionHistory(
      tool,
      receipt("auto_resolved", {
        delivery: {
          type: "option",
          questionId: "delivery",
          optionIndex: 0,
          label: "报告",
          description: "交付报告"
        }
      })
    )
    expect(history?.status).toBe("auto_resolved")
    expect(history?.questions[0].answer?.text).toBe("报告")
  })

  it("matches each answer to its question, independent of receipt key order", () => {
    const two = { ...tool, args: { questions: [question, { ...question, id: "review" }] } }
    const answer = (id: string, value: string) => ({ type: "other", questionId: id, text: value })
    const history = botQuestionHistory(
      two,
      receipt("submitted", {
        review: answer("review", "明天评审"),
        delivery: answer("delivery", "今天交付")
      })
    )
    expect(history?.questions.map((item) => item.answer?.text)).toEqual(["今天交付", "明天评审"])
    expect(
      botQuestionHistory(two, receipt("submitted", { delivery: answer("review", "错误归属") }))
    ).toBeNull()
  })

  it("retains inspectable tool records for missing, failed, malformed or contradictory receipts", () => {
    for (const result of [
      { content: "not json" },
      { content: receipt("ignored").content, is_error: true },
      receipt("cancelled"),
      receipt("submitted"),
      receipt("ignored", { delivery: { type: "other", questionId: "delivery", text: "不应显示" } }),
      receipt("auto_resolved", { unknown: {} }),
      receipt("submitted", { delivery: { type: "option", questionId: "delivery", optionIndex: 0 } })
    ])
      expect(botQuestionHistory(tool, result)).toBeNull()
    expect(botQuestionHistory({ ...tool, name: "execute" }, receipt("ignored"))).toBeNull()
    expect(
      botQuestionHistory({ ...tool, args: { questions: [question, question] } }, receipt("ignored"))
    ).toBeNull()
  })

  it("accepts the original transport text blocks without mutating the request or receipt", () => {
    const original = JSON.stringify(tool)
    const content = receipt("ignored").content
    const blocks = [
      { type: "text" as const, text: content.slice(0, 20) },
      { type: "text" as const, text: content.slice(20) }
    ]
    expect(botQuestionHistory(tool, { content: blocks })?.status).toBe("ignored")
    expect(JSON.stringify(tool)).toBe(original)
    expect(blocks.map((block) => block.text).join("")).toBe(content)
  })
})
