import { describe, expect, it } from "vitest"
import {
  botQuestionHistory,
  isMainBotQuestionCall,
  pendingBotQuestionCallId,
  stoppedBotQuestionHistory
} from "./bot-question-history"
import type { Message, ToolCall, UserInputRequest } from "@/types"
import type { BotMessageOrigin } from "../../../shared/bots/contracts"

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

describe("Bot stopped question history", () => {
  const user: Message = { id: "user", role: "user", content: "ask", created_at: new Date() }
  const call: Message = {
    id: "assistant",
    role: "assistant",
    content: "",
    tool_calls: [tool],
    created_at: new Date()
  }
  const origins = (state: BotMessageOrigin["state"]) =>
    new Map<string, BotMessageOrigin>([
      ["user", { id: "task", requestId: "user", origin: { kind: "user" }, state }]
    ])

  it("uses proven cancelled or interrupted ownership without inventing an answer", () => {
    for (const state of ["cancelled", "interrupted"] as const) {
      const history = stoppedBotQuestionHistory([user, call], origins(state)).get(tool.id)
      expect(history).toEqual({
        status: state,
        questions: [{ id: question.id, question: question.question }]
      })
    }
  })

  it("never treats a missing result alone as cancellation, including a paged-away owner", () => {
    for (const state of [
      "queued",
      "running",
      "waiting_user",
      "completed",
      "failed",
      "outcome_unknown"
    ] as const)
      expect(stoppedBotQuestionHistory([user, call], origins(state)).size).toBe(0)
    expect(stoppedBotQuestionHistory([call], origins("cancelled")).size).toBe(0)
    expect(stoppedBotQuestionHistory([user, call], new Map()).size).toBe(0)
  })

  it("preserves actual answered or failed receipts even when the containing task was cancelled", () => {
    for (const result of [receipt("ignored"), { content: "aborted", is_error: true }]) {
      const message: Message = {
        id: "result",
        role: "tool",
        tool_call_id: tool.id,
        name: tool.name,
        created_at: new Date(),
        ...result
      }
      expect(stoppedBotQuestionHistory([user, call, message], origins("cancelled")).size).toBe(0)
    }
  })

  it("keeps the stopped question settled while a later task starts", () => {
    const nextUser = { ...user, id: "next-user" }
    const nextCall = { ...call, id: "next-call", tool_calls: [{ ...tool, id: "next-tool" }] }
    const ownership = origins("cancelled")
    ownership.set(nextUser.id, {
      id: "next-task",
      requestId: nextUser.id,
      origin: { kind: "user" },
      state: "running"
    })
    const view = stoppedBotQuestionHistory([user, call, nextUser, nextCall], ownership)
    expect([...view.keys()]).toEqual([tool.id])
    expect(view.get(tool.id)?.status).toBe("cancelled")
  })

  it("does not label ambiguous IDs, subagent requests or malformed questions", () => {
    const repeated = { ...call, id: "duplicate" }
    expect(stoppedBotQuestionHistory([user, call, repeated], origins("cancelled")).size).toBe(0)
    expect(
      stoppedBotQuestionHistory(
        [user, { ...call, subagent_tool_call_id: "child" }],
        origins("cancelled")
      ).size
    ).toBe(0)
    const malformed = {
      ...call,
      tool_calls: [{ ...tool, args: { questions: [question, question] } }]
    }
    expect(stoppedBotQuestionHistory([user, malformed], origins("cancelled")).size).toBe(0)
  })
})

describe("Bot pending question ownership", () => {
  const request: UserInputRequest = {
    requestId: "pending",
    threadId: "thread",
    createdAt: new Date().toISOString(),
    questions: [{ ...question, options: question.options.slice(1) }]
  }
  const message = (id: string, callId: string): Message => ({
    id,
    role: "assistant",
    content: "",
    created_at: new Date(),
    tool_calls: [{ ...tool, id: callId }]
  })

  it("reserves composer replies for one proven main question, retaining child and ambiguous forms", () => {
    const call = message("main", "question")
    expect(isMainBotQuestionCall([call], "question")).toBe(true)
    expect(isMainBotQuestionCall([call], null)).toBe(false)
    expect(isMainBotQuestionCall([call], "missing")).toBe(false)
    expect(isMainBotQuestionCall([{ ...call, subagent_tool_call_id: "child" }], "question")).toBe(
      false
    )
    expect(isMainBotQuestionCall([call, { ...call, id: "duplicate" }], "question")).toBe(false)
    expect(
      isMainBotQuestionCall(
        [call, { ...call, id: "child", subagent_tool_call_id: "child" }],
        "question"
      )
    ).toBe(false)
  })

  it("matches the latest loaded call despite runtime free-form option filtering", () => {
    expect(
      pendingBotQuestionCallId([message("older", "old"), message("latest", "new")], request)
    ).toBe("new")
  })

  it("keeps unmatched calls and calls without an actual pending request inspectable", () => {
    expect(pendingBotQuestionCallId([message("call", "call")], null)).toBeNull()
    expect(
      pendingBotQuestionCallId([message("call", "call")], {
        ...request,
        questions: [{ ...request.questions[0], id: "other" }]
      })
    ).toBeNull()
  })

  it("does not fall back to an older unanswered call once the latest has a receipt", () => {
    const messages: Message[] = [
      message("older", "old"),
      message("latest", "new"),
      {
        id: "receipt",
        role: "tool",
        tool_call_id: "new",
        name: tool.name,
        content: "cancelled",
        created_at: new Date(),
        is_error: true
      }
    ]
    expect(pendingBotQuestionCallId(messages, request)).toBeNull()
  })
})

describe("Bot settled question history", () => {
  it("retains only the choices actually offered by the original tool for ignored history", () => {
    const history = botQuestionHistory(tool, receipt("ignored"))
    expect(history?.questions[0]).toMatchObject({
      options: question.options.slice(1)
    })
    expect(history?.questions[0].answer).toBeUndefined()
  })

  it("keeps old or invalid option metadata compact without inventing choices", () => {
    for (const options of [
      undefined,
      "unknown",
      [{ label: "Broken", description: 42 }],
      Array(6).fill({ label: "Too many", description: "" })
    ]) {
      const history = botQuestionHistory(
        { ...tool, args: { questions: [{ ...question, options }] } },
        receipt("ignored")
      )
      expect(history?.questions[0]).toEqual({ id: question.id, question: question.question })
    }
  })

  it("reuses the original exact cancellation receipt without treating it as an answer", () => {
    const content = `Tool call ${tool.name} with id ${tool.id} was cancelled - another message came in before it could be completed.`
    expect(botQuestionHistory(tool, { content })).toEqual({
      status: "interrupted",
      questions: [{ id: question.id, question: question.question }]
    })
    expect(botQuestionHistory(tool, { content, is_error: true })?.status).toBe("interrupted")
    expect(botQuestionHistory({ ...tool, id: "other-call" }, { content })).toBeNull()
    expect(
      botQuestionHistory(tool, { content: "User input request was cancelled.", is_error: true })
    ).toBeNull()
  })

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
