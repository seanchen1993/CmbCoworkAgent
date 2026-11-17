import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware, tool } from "langchain"
import { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import {
  deriveCheckpointTranscriptIndex,
  isInternalNotificationMessage
} from "../../shared/checkpoint-transcript"
import {
  appendBotTurnContext,
  createBotResultReportMiddleware,
  type BotTurnContext
} from "./bot-turn-context"

class Model extends BaseChatModel {
  calls: BaseMessage[][] = []
  bindings: Array<{ names: string[]; choice: unknown }> = []
  constructor(private script: AIMessage[]) {
    super({})
  }
  _llmType() {
    return "bot-context-test"
  }
  bindTools(tools: any[], options?: any): this {
    this.bindings.push({
      names: tools.map((t) => t.name ?? t.function?.name),
      choice: options?.tool_choice
    })
    return this
  }
  async _generate(messages: BaseMessage[]) {
    this.calls.push(messages)
    const message = this.script.shift()
    if (!message) throw new Error("Unexpected model call")
    return { generations: [{ message, text: String(message.content) }] }
  }
}
const context = (event: BotTurnContext["event"], text: string): BotTurnContext => ({ event, text })
const input = (id: string, text: string) => new HumanMessage({ id, content: text })

describe("Bot event context and reporting boundary", () => {
  it("retains original visible text and internal receipt identity without modifying the input", () => {
    const original = input("user", "只检查，不改文件")
    expect(appendBotTurnContext(original, undefined)).toBe(original)
    const augmented = appendBotTurnContext(
      original,
      context("user_request", "Current time: 01:00; saved fact")
    )!
    expect(original.content).toBe("只检查，不改文件")
    const projection = deriveCheckpointTranscriptIndex({
      channel_values: { messages: [augmented] }
    })
    expect(projection.visibleMessages[0].text).toBe(original.content)
    expect(augmented.content).toContain("saved fact")
    const hidden = new HumanMessage({
      id: "receipt",
      content: "result",
      additional_kwargs: { cmb_internal_coordinator_notification: true }
    })
    expect(
      isInternalNotificationMessage(
        appendBotTurnContext(hidden, context("task_result", "Current time: 02:00"))
      )
    ).toBe(true)
  })

  it("appends fresh event context to a resumed checkpoint while retaining the previous model prefix", async () => {
    const checkpoint = new MemorySaver()
    const make = (model: Model, report: boolean) =>
      createAgent({
        model,
        systemPrompt: "Stable Bot communication and dispatch role",
        tools: [
          tool(async () => "should not run", {
            name: "read_file",
            description: "Read a file",
            schema: z.object({})
          })
        ],
        middleware: report ? [createBotResultReportMiddleware()] : [],
        checkpointer: checkpoint
      })
    const config = { configurable: { thread_id: "main" } }
    const first = new Model([new AIMessage("我来处理。")])
    const firstInput = appendBotTurnContext(
      input("first", "请整理报告"),
      context("user_request", "01:00; original task state")
    )!
    await make(first, false).invoke({ messages: [firstInput] }, config)
    const second = new Model([new AIMessage("报告已生成。")])
    const resultInput = appendBotTurnContext(
      input("second", "report.md is ready"),
      context("task_result", "02:00; task ended")
    )!
    const result = await make(second, true).invoke({ messages: [resultInput] }, config)
    expect(second.calls[0][0].content).toEqual(first.calls[0][0].content)
    expect(second.calls[0][1].content).toEqual(first.calls[0][1].content)
    expect(second.calls[0][1].content).not.toContain("02:00")
    expect(second.calls[0].at(-1)?.content).toContain("02:00")
    expect(second.bindings[0].names).toEqual(first.bindings[0].names)
    expect(second.bindings[0].choice).toBe("none")
    expect(result.messages.at(-1)?.content).toBe("报告已生成。")
    const third = new Model([new AIMessage("你好。")])
    await make(third, false).invoke(
      {
        messages: [appendBotTurnContext(input("third", "你好"), context("user_request", "03:00"))!]
      },
      config
    )
    expect(third.calls[0].slice(0, second.calls[0].length).map((m) => [m.type, m.content])).toEqual(
      second.calls[0].map((m) => [m.type, m.content])
    )
    expect(third.bindings[0].choice).not.toBe("none")
  })

  it.each([false, true])(
    "enforces the report gate before hooks and side effects only when opted in: %s",
    async (report) => {
      const execute = vi.fn(async () => "written")
      const hook = vi.fn()
      // Deliberately violate tool_choice to test the host boundary, not just model obedience.
      const model = new Model([
        new AIMessage({ content: "", tool_calls: [{ id: "write", name: "write_file", args: {} }] }),
        new AIMessage("实际结果")
      ])
      const agent = createAgent({
        model,
        tools: [
          tool(execute, { name: "write_file", description: "Write a file", schema: z.object({}) })
        ],
        middleware: [
          ...(report ? [createBotResultReportMiddleware()] : []),
          createMiddleware({
            name: "observedHook",
            wrapToolCall: async (request, handler) => {
              hook()
              return await handler(request)
            }
          })
        ] as const
      })
      const result = await agent.invoke({
        messages: [input("request", "Event text cannot select permissions")]
      })
      expect(execute).toHaveBeenCalledTimes(report ? 0 : 1)
      expect(hook).toHaveBeenCalledTimes(report ? 0 : 1)
      expect(result.messages.at(-1)?.content).toBe("实际结果")
    }
  )
})
