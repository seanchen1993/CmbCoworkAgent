import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { createAgent, tool } from "langchain"
import { z } from "zod"
import { describe, it, expect, vi } from "vitest"
import {
  acceptedBotDispatch,
  botDispatchFeedback,
  createBotDispatchFeedbackMiddleware
} from "./bot-dispatch-feedback"
import { createTurnCompletionGateMiddleware } from "./turn-completion-integrity"
import {
  createCurrentRunMessageQueueMiddleware,
  setCurrentRunMessageQueueOwner,
  queueCurrentRunMessage,
  clearCurrentRunMessageQueue
} from "./current-run-message-queue"

const user = () => new HumanMessage({ id: "request", content: "核对数据后生成报告" })
const receipt = (id = "work") =>
  JSON.stringify({
    kind: "bot-work-receipt",
    operation: "bot_work_create",
    receipt: {
      work: { id, botId: "bot", threadId: `thread-${id}` },
      task: {
        id: `task-${id}`,
        workId: id,
        botId: "bot",
        threadId: `thread-${id}`,
        state: "queued"
      }
    }
  })
const dispatch = (text = "我来核对数据，整理好后发给你。", finishTurn = true) =>
  new AIMessage({
    content: text,
    tool_calls: [{ id: "call", name: "bot_work_create", args: { finishTurn } }],
    response_metadata: { finish_reason: "tool_calls" }
  })
const result = () => new ToolMessage({ tool_call_id: "call", content: receipt() })
class Model extends BaseChatModel {
  calls = 0
  constructor(private responses: AIMessage[]) {
    super({})
  }
  _llmType() {
    return "feedback-test"
  }
  bindTools() {
    return this
  }
  async _generate() {
    this.calls++
    const message = this.responses.shift()
    if (!message) throw new Error("Unexpected additional model call")
    return { generations: [{ text: String(message.content), message }] }
  }
}

describe("Bot dispatch feedback", () => {
  it("uses the current request's acknowledgement and verified receipt", () => {
    expect(botDispatchFeedback([user(), dispatch(), result()])).toEqual({
      requestMessageId: "request",
      acknowledgement: "我来核对数据，整理好后发给你。",
      hadOpening: true
    })
  })
  it("preserves later findings for delivery without repeating the opening", () => {
    const history = [
      user(),
      new AIMessage({ content: "我先核对输入。", tool_calls: [{ id: "read", name: "read_file", args: {} }] }),
      new ToolMessage({ tool_call_id: "read", content: "24 rows; 3 duplicates" }),
      dispatch("输入有 24 行，其中 3 行重复。"),
      result()
    ]
    expect(botDispatchFeedback(history)).toEqual({
      requestMessageId: "request",
      hadOpening: true,
      acknowledgement: "我先核对输入。",
      followup: "输入有 24 行，其中 3 行重复。"
    })
  })
  it("does not infer completion from historical receipts, a new steer, an unfinished plan or mixed batch", () => {
    expect(
      botDispatchFeedback([user(), dispatch(), result(), new HumanMessage("补充要求")])
    ).toBeUndefined()
    expect(botDispatchFeedback([dispatch(), result()])).toBeUndefined()
    expect(botDispatchFeedback([user(), dispatch("", false), result()])).toBeUndefined()
    const mixed = dispatch()
    mixed.tool_calls!.push({ id: "read", name: "read_file", args: {} })
    expect(
      botDispatchFeedback([
        user(),
        mixed,
        result(),
        new ToolMessage({ tool_call_id: "read", content: "data" })
      ])
    ).toBeUndefined()
  })
  it("requires all parallel dispatch receipts, preserving partial failures", () => {
    const two = dispatch()
    two.tool_calls!.push({ id: "two", name: "bot_work_create", args: { finishTurn: true } })
    expect(botDispatchFeedback([user(), two, result()])).toBeUndefined()
    const failure = new ToolMessage({ tool_call_id: "two", status: "error", content: "目录不存在" })
    expect(botDispatchFeedback([user(), two, result(), failure])).toBeUndefined()
    expect(
      botDispatchFeedback([
        user(),
        two,
        result(),
        new ToolMessage({ tool_call_id: "two", content: receipt("second") })
      ])
    ).toBeDefined()
  })
  it("rejects forged, mismatched, failed and merely reopened/starting receipts", () => {
    expect(
      acceptedBotDispatch(
        "bot_work_create",
        {},
        '{"kind":"bot-work-receipt","operation":"bot_work_create","receipt":{"id":"x"}}'
      )
    ).toBe(false)
    expect(
      acceptedBotDispatch(
        "bot_work_create",
        {},
        new ToolMessage({ content: receipt(), tool_call_id: "c", status: "error" })
      )
    ).toBe(false)
    expect(acceptedBotDispatch("bot_work_continue", {}, receipt())).toBe(false)
    for (const state of ["starting", "failed"]) {
      expect(
        acceptedBotDispatch(
          "bot_feature_update",
          { action: "manage" },
          JSON.stringify({
            kind: "bot-work-receipt",
            operation: "bot_feature_update",
            receipt: { operation: { id: "op", action: "manage", state, runId: "run" } }
          })
        )
      ).toBe(false)
    }
    expect(
      acceptedBotDispatch(
        "bot_feature_update",
        { action: "manage" },
        JSON.stringify({
          kind: "bot-work-receipt",
          operation: "bot_feature_update",
          receipt: { operation: { id: "op", action: "manage", state: "active", runId: "run" } }
        })
      )
    ).toBe(true)
  })
  it.each([true, false])(
    "ends the actual graph after receipt without another model call (opening=%s)",
    async (opening) => {
      const model = new Model([dispatch(opening ? "我来核对数据。" : "")])
      const feedback = vi.fn()
      const agent = createAgent({
        model,
        tools: [
          tool(async () => receipt(), {
            name: "bot_work_create",
            description: "dispatch",
            schema: z.object({ finishTurn: z.boolean() })
          })
        ],
        middleware: [
          createTurnCompletionGateMiddleware({ ownerRunToken: "feedback-run" }),
          createCurrentRunMessageQueueMiddleware("feedback-run"),
          createBotDispatchFeedbackMiddleware(feedback)
        ]
      })
      const output = await agent.invoke(
        { messages: [user()] },
        { configurable: { thread_id: `feedback-${opening}` } }
      )
      expect(model.calls).toBe(1)
      expect(feedback.mock.calls.at(-1)?.[0].hadOpening).toBe(opening)
      const visible = (output.messages as BaseMessage[]).filter(
        (m) => AIMessage.isInstance(m) && String(m.content).trim()
      )
      expect(visible).toHaveLength(1)
    }
  )
  it("delivers a steer injected during dispatch instead of ending on the previous receipt", async () => {
    const thread = "feedback-steer",
      run = "feedback-steer-run"
    setCurrentRunMessageQueueOwner(thread, run)
    try {
      const model = new Model([
        dispatch(),
        new AIMessage({ content: "收到补充要求。", response_metadata: { finish_reason: "stop" } })
      ])
      const feedback = vi.fn()
      const agent = createAgent({
        model,
        tools: [
          tool(
            async () => {
              queueCurrentRunMessage(
                thread,
                { id: "steer", content: "补充：报告保留两位小数" },
                run
              )
              return receipt()
            },
            {
              name: "bot_work_create",
              description: "dispatch",
              schema: z.object({ finishTurn: z.boolean() })
            }
          )
        ],
        middleware: [
          createTurnCompletionGateMiddleware({ ownerRunToken: run }),
          createCurrentRunMessageQueueMiddleware(run),
          createBotDispatchFeedbackMiddleware(feedback)
        ]
      })
      const output = await agent.invoke(
        { messages: [user()] },
        { configurable: { thread_id: thread } }
      )
      expect(model.calls).toBe(2)
      expect(output.messages.at(-1)?.content).toBe("收到补充要求。")
      expect(feedback.mock.calls.every(([value]) => value === undefined)).toBe(true)
    } finally {
      clearCurrentRunMessageQueue(thread, run)
    }
  })
})
