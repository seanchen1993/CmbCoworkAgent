import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../../shared/checkpoint-transcript"
import { HOOK_AGENT_OWNER_METADATA_KEY } from "../hooks/execution-context"
import {
  createOpeningReplyReminderMiddleware,
  OPENING_REPLY_REMINDER
} from "./opening-reply-reminder"

class ScriptedModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = []
  constructor(private readonly script: AIMessage[]) {
    super({})
  }
  _llmType(): string {
    return "opening-reply-test"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const message = this.script.shift()
    if (!message) throw new Error("Unexpected extra model call")
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }]
    }
  }
  bindTools(): this {
    return this
  }
}

function call(id: string, content: AIMessage["content"] = ""): AIMessage {
  return new AIMessage({
    content,
    tool_calls: [{ id, name: "read_file", args: {} }]
  })
}
const receipt = (id: string) => new ToolMessage({ content: "file contents", tool_call_id: id })
const hasReminder = (messages: BaseMessage[]) =>
  messages.some(
    (m) => m.type === "system" && JSON.stringify(m.content).includes(OPENING_REPLY_REMINDER)
  )

async function run(
  history: BaseMessage[],
  script = [new AIMessage("实际结果")],
  configurable: Record<string, unknown> = {}
) {
  const model = new ScriptedModel(script)
  const read = vi.fn(async () => "file contents")
  const agent = createAgent({
    model,
    systemPrompt: "Existing system instructions",
    tools: [tool(read, { name: "read_file", description: "Read a file", schema: z.object({}) })],
    middleware: [createOpeningReplyReminderMiddleware()]
  })
  const result = await agent.invoke({ messages: history }, { configurable })
  return { model, read, messages: result.messages as BaseMessage[] }
}

describe("Bot main-turn opening reply reminder", () => {
  it("nudges after two silent tool calls, continues after an update, and never persists the cue", async () => {
    const { model, read, messages } = await run(
      [new HumanMessage("检查三份文件")],
      [
        call("one"),
        call("two"),
        call("three", "已检查前两份，继续核对第三份。"),
        new AIMessage("三份文件均已核对。")
      ]
    )
    expect(model.calls.map(hasReminder)).toEqual([false, false, true, false])
    expect(read).toHaveBeenCalledTimes(3)
    expect(messages.at(-1)?.content).toBe("三份文件均已核对。")
    expect(messages.filter((m) => m.type === "human")).toHaveLength(1)
    expect(messages.some((m) => JSON.stringify(m.content).includes(OPENING_REPLY_REMINDER))).toBe(
      false
    )
    expect(JSON.stringify(model.calls[2][0].content)).toContain("Existing system instructions")
  })

  it("accepts a visible first reply alongside tools without extra acknowledgements", async () => {
    const { model } = await run(
      [new HumanMessage("检查文件")],
      [call("one", "我先检查文件。"), call("two"), call("three"), new AIMessage("结果")]
    )
    expect(model.calls.map(hasReminder)).toEqual([false, false, false, false])
  })

  it("lets a simple answer finish immediately", async () => {
    const { model, read } = await run([new HumanMessage("你好")])
    expect(model.calls).toHaveLength(1)
    expect(hasReminder(model.calls[0])).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  const silent = [call("one"), receipt("one"), call("two"), receipt("two")]
  it.each<[string, BaseMessage[], boolean]>([
    [
      "old replies do not acknowledge a new user turn",
      [new HumanMessage("之前"), new AIMessage("已回复"), new HumanMessage("新任务"), ...silent],
      true
    ],
    [
      "a new user steer resets silent tool counting",
      [new HumanMessage("任务"), ...silent, new HumanMessage("只看第一份")],
      false
    ],
    [
      "internal recovery is not a new user turn",
      [
        new HumanMessage("任务"),
        ...silent,
        new HumanMessage(TURN_COMPLETION_GATE_MARKER_PREFIX + "test]] continue")
      ],
      true
    ],
    ["missing user boundary cannot borrow old tools", silent, false],
    [
      "one silent call needs no reminder yet",
      [new HumanMessage("任务"), call("one"), receipt("one")],
      false
    ],
    [
      "thinking blocks are not visible text",
      [
        new HumanMessage("任务"),
        call("one", [{ type: "reasoning", reasoning: "internal" }]),
        receipt("one"),
        call("two"),
        receipt("two")
      ],
      true
    ],
    [
      "inline thinking is not visible text",
      [
        new HumanMessage("任务"),
        call("one", "<think>internal</think>"),
        receipt("one"),
        call("two"),
        receipt("two")
      ],
      true
    ],
    [
      "visible text after inline thinking counts",
      [
        new HumanMessage("任务"),
        call("one", "<think>internal</think>我先检查。"),
        receipt("one"),
        call("two"),
        receipt("two")
      ],
      false
    ]
  ])("%s", async (_label, history, expected) => {
    const { model } = await run(history)
    expect(hasReminder(model.calls[0])).toBe(expected)
  })

  it("does not nudge a subagent even if accidentally installed there", async () => {
    const { model } = await run([new HumanMessage("任务"), ...silent], undefined, {
      [HOOK_AGENT_OWNER_METADATA_KEY]: "child-call"
    })
    expect(hasReminder(model.calls[0])).toBe(false)
  })
})
