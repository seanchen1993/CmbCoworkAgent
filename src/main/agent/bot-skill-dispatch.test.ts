import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { createAgent, createMiddleware, tool } from "langchain"
import { z } from "zod"
import { describe, it, expect, vi } from "vitest"
import type { BotTask } from "../../shared/bots/contracts"
import { canSteerBotTask } from "../bots/continuation"
import { formatSkillUseBlock } from "./skill-lifecycle/marker"
import { selectedMainBotSkill, botSkillDispatchInput, createBotSkillDispatchMiddleware } from "./bot-skill-dispatch"
import { createBotDispatchFeedbackMiddleware } from "./bot-dispatch-feedback"

class Model extends BaseChatModel {
  choices: unknown[] = []
  names: string[][] = []
  constructor(private script: AIMessage[]) { super({}) }
  _llmType() { return "skill-route-test" }
  bindTools(tools: any[], options?: any): this {
    this.choices.push(options?.tool_choice)
    this.names.push(tools.map(t => t.name))
    return this
  }
  async _generate(_messages: BaseMessage[]) {
    const message = this.script.shift()
    if (!message) throw new Error("Unexpected model call")
    return { generations: [{ message, text: String(message.content) }] }
  }
}
const block = formatSkillUseBlock({ name: "prd", path: "/skills/prd/SKILL.md" })
const main = (message = "写 PRD\n" + block) => ({ botId: "bot", threadId: "main", state: "running", origin: { kind: "user" }, message } as BotTask)
const accepted = (dispatch: "create" | "follow_up" = "create") => JSON.stringify({ kind: "bot-work-receipt", operation: "bot_skill_dispatch",
  receipt: { work: { id: "work", botId: "bot", threadId: "worker" },
    task: { id: "task", workId: "work", botId: "bot", threadId: "worker", state: "queued",
      origin: { kind: "work", dispatch } } } })

describe("main Bot explicit skill dispatch", () => {
  it("selects only local main inputs, hides executor instructions, and queues the main dispatch boundary", () => {
    const source = main(), selection = selectedMainBotSkill(source)!
    expect(selection.name).toBe("prd")
    expect(botSkillDispatchInput(source.message, selection)).not.toContain("请先使用 read_file")
    expect(source.message).toContain(block)
    const structured = { ...source, message: "整理访谈要点", origin: { kind: "user" as const, explicitSkill: { name: selection.name, path: selection.path } } }
    expect(selectedMainBotSkill(structured)).toEqual({ name: selection.name, path: selection.path, block: "" })
    expect(botSkillDispatchInput(structured.message, selectedMainBotSkill(structured)!)).toContain(structured.message)
    expect(selectedMainBotSkill(main("帮我使用 prd 技能"))).toBeUndefined()
    expect(selectedMainBotSkill({ ...source, workId: "work" })).toBeUndefined()
    expect(selectedMainBotSkill({ ...source, origin: { kind: "introduction" } })).toBeUndefined()
    expect(selectedMainBotSkill({ ...source, mockSource: { transport: "im" } as any })).toBeUndefined()
    expect(canSteerBotTask(main("旧请求"), source)).toBe(false)
    expect(canSteerBotTask(source, main("补充"))).toBe(false)
    expect(canSteerBotTask({ ...source, workId: "work" }, { ...main("补充"), workId: "work" })).toBe(true)
    expect(canSteerBotTask(main("旧请求"), main("补充"))).toBe(true)
  })
  it.each([
    { success: true, dispatch: "create" as const, args: { title: "PRD" }, reply: "已新建任务，我会按所选技能处理，结果发回这里。" },
    { success: true, dispatch: "follow_up" as const, args: { workId: "work" }, reply: "我会在原任务中继续处理，结果发回这里。" },
    { success: true, dispatch: "follow_up" as const, args: { workQuery: "原 PRD" }, reply: "我会在原任务中继续处理，结果发回这里。" },
    { success: false, dispatch: "create" as const, args: { title: "PRD" }, reply: "目录不存在，请提供有效目录。" }
  ])("acknowledges only accepted $dispatch without another model call (success=$success, args=$args)", async ({ success, dispatch, args, reply }) => {
    const model = new Model([
      new AIMessage({ content: "已经开始了（不可作为回执）", tool_calls: [{ id: "dispatch", name: "bot_skill_dispatch", args }] }),
      ...(!success ? [new AIMessage("目录不存在，请提供有效目录。")] : [])
    ])
    const feedback = vi.fn()
    const agent = createAgent({ model, tools: [tool(async () => success ? accepted(dispatch) : "目录不存在",
      { name: "bot_skill_dispatch", description: "Dispatch", schema: z.object({ title: z.string().optional(), workId: z.string().optional(), workQuery: z.string().optional() }) })],
      middleware: [createBotSkillDispatchMiddleware(), createBotDispatchFeedbackMiddleware(feedback)] })
    const result = await agent.invoke({ messages: [new HumanMessage({ id: "request", content: "写 PRD" })] })
    expect(model.choices[0]).toEqual({ type: "function", function: { name: "bot_skill_dispatch" } })
    expect(model.choices).toHaveLength(success ? 1 : 2)
    expect(result.messages.at(-1)?.content).toBe(reply)
    expect(result.messages.filter(message => AIMessage.isInstance(message) && String(message.content).trim())).toHaveLength(1)
    if (!success) expect(model.choices[1]).toBe("none")
  })
  it.each([true, false])("gates provider-ignored tool choices before hooks, without changing ordinary runtime: %s", async enabled => {
    const write = vi.fn(async () => "written"), hook = vi.fn()
    const model = new Model([new AIMessage({ content: "", tool_calls: [{ id: "write", name: "write_file", args: {} }] }), new AIMessage("结果")])
    const agent = createAgent({ model, tools: [tool(write, { name: "write_file", description: "Write", schema: z.object({}) })],
      middleware: [...(enabled ? [createBotSkillDispatchMiddleware()] : []),
        createMiddleware({ name: "observeHook", wrapToolCall: (req, handler) => { hook(); return handler(req) } })] as const })
    const pending = agent.invoke({ messages: [new HumanMessage("输入")] })
    if (enabled) await expect(pending).rejects.toThrow("未返回有效的交办")
    else await pending
    expect(write).toHaveBeenCalledTimes(enabled ? 0 : 1)
    expect(hook).toHaveBeenCalledTimes(enabled ? 0 : 1)
    if (!enabled) expect(model.names[0]).toEqual(model.names[1])
  })
})
