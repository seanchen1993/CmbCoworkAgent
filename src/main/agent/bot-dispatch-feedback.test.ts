import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { createAgent, tool } from "langchain"
import { z } from "zod"
import { describe, it, expect, vi } from "vitest"
import {
  acceptedBotDispatch,
  hasOutstandingBotRequest,
  botDispatchFeedback,
  createBotDispatchFeedbackMiddleware
} from "./bot-dispatch-feedback"
import { createTurnCompletionGateMiddleware } from "./turn-completion-integrity"
import { createOpeningReplyReminderMiddleware } from "./opening-reply-reminder"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../../shared/checkpoint-transcript"
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
      acknowledgement: "我来处理这件事，结果发回这里。",
      hadOpening: false
    })
  })
  it.each(["我来核对订单异常，查好回你。", "我将核查订单异常并给出修复建议。", "I'll check the order errors and send you the findings."])("uses the Bot's phrasing after acceptance: %s", text => {
    const handoff = dispatch("Let me run the pipeline.")
    handoff.tool_calls![0].args.confirmation = { kind: "new", text }
    expect(botDispatchFeedback([user(), handoff, result()])?.acknowledgement).toBe(text)
  })
  it.each([
    { kind: "continue", text: "接着修改原任务。" },
    { kind: "new", text: "我用 finishTurn 结束本轮。" },
    { kind: "new", text: "报告已经生成。" },
    { kind: "new", text: "先检查。再检查。" }
  ])("falls back without losing the accepted work for an invalid confirmation", confirmation => {
    const handoff = dispatch()
    handoff.tool_calls![0].args.confirmation = confirmation
    expect(botDispatchFeedback([user(), handoff, result()])?.acknowledgement).toBe("我来处理这件事，结果发回这里。")
  })
  it("combines a verified finding and the Bot's confirmation in one message", () => {
    const handoff = dispatch()
    handoff.tool_calls![0].args.finding = "有 3 行重复。"
    handoff.tool_calls![0].args.confirmation = { kind: "new", text: "我来核对其余数据。" }
    const read = new AIMessage({ content: "", tool_calls: [{ id: "read", name: "read_file", args: {} }] })
    const evidence = new ToolMessage({ name: "read_file", tool_call_id: "read", content: "3 duplicates" })
    expect(botDispatchFeedback([user(), read, evidence, handoff, result()])).toMatchObject({
      hadOpening: false, followup: "有 3 行重复。 我来核对其余数据。"
    })
  })
  it("preserves later findings for delivery without repeating the opening", () => {
    const handoff = dispatch("Let me check. 我用 finishTurn 结束本轮。")
    handoff.tool_calls![0].args.finding = "输入有 24 行，其中 3 行重复。"
    const history = [
      user(),
      new AIMessage({ content: "我先核对输入。", tool_calls: [{ id: "read", name: "read_file", args: {} }] }),
      new ToolMessage({ name: "read_file", tool_call_id: "read", content: "24 rows; 3 duplicates" }),
      handoff,
      result()
    ]
    expect(botDispatchFeedback(history)).toEqual({
      requestMessageId: "request",
      hadOpening: true,
      acknowledgement: "我来看看。",
      followup: "输入有 24 行，其中 3 行重复。"
    })
  })
  it("closes a verified default handoff after a gate retry and never publishes tool narration", () => {
    const handoff = dispatch("前台预算已到。\nLet me run the pipeline.\nfinishTurn: true")
    handoff.tool_calls![0].args = { finding: "我用 finishTurn 结束本轮。" }
    const recovered = new HumanMessage(TURN_COMPLETION_GATE_MARKER_PREFIX + "missing_delivery]] retry")
    const feedback = botDispatchFeedback([user(), recovered, handoff, result()])
    expect(feedback).toMatchObject({ requestMessageId: "request", hadOpening: false })
    expect(feedback).not.toHaveProperty("followup")
    expect(feedback?.acknowledgement).not.toMatch(/预算|pipeline|finishTurn/i)
    handoff.tool_calls![0].args = { finding: "未经检查的结论。" }
    expect(botDispatchFeedback([user(), handoff, result()])).not.toHaveProperty("followup")
  })
  it("does not infer completion from historical receipts, a new steer, an unfinished plan or mixed batch", () => {
    expect(
      botDispatchFeedback([user(), dispatch(), result(), new HumanMessage("补充要求")])
    ).toBeUndefined()
    expect(botDispatchFeedback([dispatch(), result()])).toBeUndefined()
    expect(botDispatchFeedback([user(), dispatch("", false), result()])).toBeUndefined()
    const separateRequest = dispatch()
    separateRequest.tool_calls![0].args.remainingRequest = "顺便告诉我刚才的提醒设在几点"
    expect(botDispatchFeedback([new HumanMessage({ id: "request", content: "核对数据，顺便告诉我刚才的提醒设在几点" }), separateRequest, result()])).toBeUndefined()
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
  it("distinguishes an actual additional instruction from the assigned result's return address", () => {
    const source = "请开任务分析日志，直接在这里回复。另请计算：19 加 23 是多少？"
    expect(hasOutstandingBotRequest({ remainingRequest: "用户还要求把结论直接在本对话中回复。" }, source)).toBe(false)
    expect(hasOutstandingBotRequest({ remainingRequest: "直接在这里回复。" }, source)).toBe(false)
    expect(hasOutstandingBotRequest({ remainingRequest: "19 加 23 是多少？" }, source)).toBe(true)
    expect(hasOutstandingBotRequest({ remainingRequest: "reply here" }, "Check these records and reply here")).toBe(false)
    expect(hasOutstandingBotRequest({ finishTurn: false }, source)).toBe(true)
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
          createBotDispatchFeedbackMiddleware(feedback),
          createOpeningReplyReminderMiddleware()
        ]
      })
      const output = await agent.invoke(
        { messages: [user()] },
        { configurable: { thread_id: `feedback-${opening}` } }
      )
      expect(model.calls).toBe(1)
      expect(feedback.mock.calls.at(-1)?.[0].hadOpening).toBe(false)
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
