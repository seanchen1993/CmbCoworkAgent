import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { createAgent } from "langchain"
import { describe, expect, it } from "vitest"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../../shared/checkpoint-transcript"
import type { BotTask } from "../../shared/bots/contracts"
import { createBotIntroductionDeliveryCheck } from "./introduction-delivery"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  readTurnCompletionGateReport
} from "../agent/turn-completion-integrity"

const task: BotTask = {
  id: "intro-task",
  botId: "a",
  threadId: "thread-a",
  requestId: "introduction:a",
  message: "开始聊天",
  state: "running",
  error: null,
  origin: { kind: "introduction" },
  createdAt: 1,
  updatedAt: 1
}
const begin = new HumanMessage({ id: task.requestId, content: task.message })
const greeting = new AIMessage("你好！随时可以开始。有什么可以帮你的吗？")
const args = {
  questions: [
    {
      id: "help_kind",
      header: "开始",
      question: "你希望我先帮你做哪类事情？",
      options: ["编程", "研究", "文档"].map((label) => ({ label }))
    }
  ]
}
function call(input: Record<string, unknown> = args, id = "choice-call") {
  return new AIMessage({
    content: "",
    tool_calls: [{ name: "request_user_input", args: input, id, type: "tool_call" }]
  })
}
function receipt(status = "submitted", id = "choice-call") {
  return new ToolMessage({
    content: JSON.stringify({ status, requestId: "actual-request", answers: {} }),
    tool_call_id: id,
    name: "request_user_input"
  })
}
const check = createBotIntroductionDeliveryCheck(task, () => true)

describe("Bot introduction choice delivery", () => {
  it("rejects the actual greeting-only response instead of accepting a completed introduction", () => {
    expect(check([begin, greeting])).toContain("request_user_input")
    expect(check([begin, greeting])).toContain("Do not repeat your greeting")
  })

  it.each(["submitted", "ignored"])(
    "accepts a genuine current choice with a %s receipt",
    (status) => {
      expect(
        check([begin, greeting, call(), receipt(status), new AIMessage("好的。")])
      ).toBeUndefined()
    }
  )

  it.each([3, 4, 5])("accepts %i real choices", (count) => {
    const input = {
      questions: [
        {
          ...args.questions[0],
          options: Array.from({ length: count }, (_, i) => ({ label: `能力 ${i + 1}` }))
        }
      ]
    }
    expect(check([begin, call(input), receipt()])).toBeUndefined()
  })

  it("does not accept same-name calls, mismatched results or another introduction's history", () => {
    const variants: BaseMessage[][] = [
      [begin, call(), greeting],
      [begin, receipt(), greeting],
      [begin, call(), receipt("submitted", "foreign-call")],
      [call(), receipt(), begin, greeting],
      [new HumanMessage({ id: "old-intro", content: task.message }), call(), receipt(), greeting]
    ]
    for (const messages of variants) expect(check(messages)).toContain("request_user_input")
  })

  it.each(["auto_resolved", "cancelled", "rejected"])(
    "does not treat %s as an actual user choice",
    (status) => {
      expect(check([begin, call(), receipt(status)])).toContain("request_user_input")
    }
  )

  it("rejects an error or malformed ToolMessage", () => {
    expect(
      check([
        begin,
        call(),
        new ToolMessage({
          content: receipt().content,
          tool_call_id: "choice-call",
          status: "error"
        })
      ])
    ).toContain("request_user_input")
    expect(
      check([
        begin,
        call(),
        new ToolMessage({ content: "not a receipt", tool_call_id: "choice-call" })
      ])
    ).toContain("request_user_input")
  })

  it.each([0, 1, 2, 6])("rejects %i options", (count) => {
    const input = {
      questions: [
        {
          ...args.questions[0],
          options: Array.from({ length: count }, (_, i) => ({ label: `选项 ${i}` }))
        }
      ]
    }
    expect(check([begin, call(input), receipt()])).toContain("request_user_input")
  })

  it("uses the real tool's freeform filtering and rejects auto-resolution", () => {
    const input = {
      questions: [
        { ...args.questions[0], options: [{ label: "编程" }, { label: "研究" }, { label: "其他" }] }
      ]
    }
    expect(check([begin, call(input), receipt()])).toContain("request_user_input")
    expect(check([begin, call({ ...args, autoResolutionMs: 30_000 }), receipt()])).toContain(
      "request_user_input"
    )
    expect(
      check([begin, call({ questions: [...args.questions, ...args.questions] }), receipt()])
    ).toContain("request_user_input")
  })

  it("rejects malformed args and a reused call ID with different invalid arguments", () => {
    for (const input of [null, [], "not arguments"])
      expect(
        check([begin, call(input as unknown as Record<string, unknown>), receipt()])
      ).toContain("request_user_input")
    expect(check([begin, call(), call({ questions: [] }), receipt()])).toContain(
      "request_user_input"
    )
  })

  it("keeps checking across bounded completion cues but yields to a real user message", () => {
    expect(
      check([
        begin,
        greeting,
        new HumanMessage(`${TURN_COMPLETION_GATE_MARKER_PREFIX} missing_delivery`),
        greeting
      ])
    ).toContain("request_user_input")
    expect(
      check([
        begin,
        greeting,
        new HumanMessage({ id: "real-user", content: "直接帮我做事" }),
        greeting
      ])
    ).toBeUndefined()
  })

  it("stops enforcing when its live introduction is no longer eligible", () => {
    expect(createBotIntroductionDeliveryCheck(task, () => false)([begin, greeting])).toBeUndefined()
    expect(
      createBotIntroductionDeliveryCheck(
        { ...task, origin: { kind: "user" } },
        () => true
      )([begin, greeting])
    ).toBeUndefined()
  })

  it("does not turn an empty real-user answer into success when setup has yielded", () => {
    const liveUser = new HumanMessage({ id: "real-user", content: "执行当前任务" })
    for (const final of [
      new AIMessage(""),
      new AIMessage({ content: "", additional_kwargs: { reasoning_content: "pending" } })
    ]) {
      expect(
        createBotIntroductionDeliveryCheck(task, () => false)([begin, liveUser, final])
      ).toContain("current user request")
      expect(check([begin, call(), receipt(), liveUser, final])).toContain("current user request")
    }
  })

  it("uses only the original two completion retries when the model keeps omitting the choice", async () => {
    class GreetingOnlyModel extends BaseChatModel {
      calls = 0
      _llmType() {
        return "introduction-choice-regression"
      }
      bindTools() {
        return this
      }
      async _generate(): Promise<ChatResult> {
        this.calls += 1
        const message = new AIMessage({
          content: greeting.content,
          response_metadata: { finish_reason: "stop" }
        })
        return { generations: [{ text: String(message.content), message }] }
      }
    }
    const model = new GreetingOnlyModel({})
    const runId = "intro-choice-run"
    const agent = createAgent({
      model,
      tools: [],
      middleware: [
        createTurnCompletionGateMiddleware({ ownerRunToken: runId, checkFinalDelivery: check })
      ]
    })
    try {
      await agent.invoke({ messages: [begin] }, { configurable: { thread_id: task.threadId } })
      expect(model.calls).toBe(3)
      expect(readTurnCompletionGateReport(task.threadId, runId)).toMatchObject({
        retriesUsed: 2,
        unresolved: { defect: "missing_delivery" }
      })
    } finally {
      clearTurnCompletionGateState(task.threadId, runId)
    }
  })
})
