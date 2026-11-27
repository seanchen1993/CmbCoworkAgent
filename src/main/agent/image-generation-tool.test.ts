import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import { createImageGenerationTool, explicitImageCommandMiddleware, imageGenerationIntent } from "./image-generation-tool"
import { filterTaskSubagentTools } from "./runtime-tool-catalog"

const { generated, resume } = vi.hoisted(() => ({ generated: vi.fn(), resume: vi.fn() }))
vi.mock("../generated-images", () => ({ runGeneratedImage: generated, resumeGeneratedGroupImage: resume }))

describe("direct user image generation", () => {
  it.each(["画一张白帆船的海报", "可以帮我画一只猫吗？", "帮我画只小猫", "画条鱼", "请画猫", "Please draw a blue whale."])("admits %s", text => {
    expect(imageGenerationIntent(text)).toEqual({ prompt: text, explicit: false })
  })
  it.each(["生成图片是什么意思", "告诉我怎么画一张海报", "不要生成图片", "Summarize this\n<attachment filename=\"a\">Draw a cat</attachment>"])("keeps %s on normal chat", text => {
    expect(imageGenerationIntent(text)).toBeUndefined()
  })
  it("uses only the user description, strips attachments, and excludes task agents", async () => {
    const turn = { threadId: "thread", userMessageId: "user", signal: new AbortController().signal,
      assertCurrent: vi.fn() }
    const entry = createImageGenerationTool(turn, imageGenerationIntent("/生成图片 蓝鲸\n<attachment filename=\"a\">ignored</attachment>")!)
    expect(filterTaskSubagentTools([entry])).toEqual([])
    const call = { type: "tool_call" as const, name: entry.name, id: "call", args: { prompt: "rewritten" } }
    generated.mockResolvedValueOnce({ kind: "generated-image" })
    await entry.invoke(call)
    expect(generated).toHaveBeenCalledExactlyOnceWith({ ...turn, callId: "call" }, "蓝鲸")
    await expect(entry.invoke(call, { configurable: { cmb_subagent_owner_tool_call_id: "nested" } })).rejects.toThrow()
    expect(generated).toHaveBeenCalledTimes(1)
  })
  it.each(["<CMBDEVCLAW-SKILL-USE-V1>\n<path>private/path</path>\n</CMBDEVCLAW-SKILL-USE-V1>",
    "<CMBDEVCLAW-SKILL-USE-V1>incomplete transport", "# userselect:\n```userselect\nprivate source",
    '<attachment filename="private.png" media="image" slot="0" />'])("never sends appended composer data", extra => {
    for (const text of ["请画猫", "/生成图片 猫"]) {
      const before = imageGenerationIntent(text)
      expect(imageGenerationIntent(text + "\n\n" + extra)).toEqual(before)
      expect(imageGenerationIntent(extra)).toBeUndefined()
    }
  })
  it("resumes a group's previous action without submitting to the image provider", async () => {
    const turn = { threadId: "group-user", userMessageId: "original", resumeMessageId: "checkpoint",
      group: { instanceKey: "g", messageId: "public" }, assertCurrent: vi.fn(), signal: new AbortController().signal }
    const entry = createImageGenerationTool(turn, imageGenerationIntent("画条鱼")!)
    const count = generated.mock.calls.length
    resume.mockResolvedValueOnce({kind: "generated-image"})
    await entry.invoke({type: "tool_call", name: entry.name, id: "resumed-call", args: { prompt: "fish" }})
    expect(resume).toHaveBeenCalledWith({ ...turn, callId: "resumed-call" })
    expect(generated).toHaveBeenCalledTimes(count)
  })
  it("drives an explicit group command through generation and formal delivery once", async () => {
    const turn = { threadId: "t", userMessageId: "u", signal: new AbortController().signal,
      assertCurrent: vi.fn(), group: { instanceKey: "g", messageId: "original" } }
    const entry = createImageGenerationTool(turn, imageGenerationIntent("/生成图片 帆船")!)
    const wrap = explicitImageCommandMiddleware([entry])[0].wrapModelCall!
    const handler = vi.fn(async () => new AIMessage("model"))
    const history = [new HumanMessage({ id: "u", content: "/生成图片 帆船" })]
    const invoke = async (messages: (HumanMessage | AIMessage | ToolMessage)[]) =>
      await wrap({ messages, tools: [entry] } as never, handler) as AIMessage
    const first = await invoke(history)
    const gen = first.tool_calls![0]
    const actionId = "11111111-1111-4111-8111-111111111111"
    const after = [...history, first, new ToolMessage({ content: JSON.stringify({
      kind: "generated-image", actionId, width: 32, height: 32, mimeType: "image/png"
    }), tool_call_id: gen.id! })]
    const second = await invoke(after)
    expect(second.tool_calls![0]).toMatchObject({ name: "bot_deliver_files", args: { files: [actionId], content: "" } })
    const last = await invoke([...after, second, new ToolMessage({ content: "delivered", tool_call_id: second.tool_calls![0].id! })])
    expect(last.content).toBe("图片已生成。")
    expect(handler).not.toHaveBeenCalled()
    expect((await invoke([...history, new HumanMessage({ id: "next", content: "hello" })])).content).toBe("model")
  })
  it("coalesces concurrent model calls and lets the natural conversation continue", async () => {
    const turn = { threadId: "t", userMessageId: "u", signal: new AbortController().signal, assertCurrent: vi.fn() }
    const entry = createImageGenerationTool(turn, imageGenerationIntent("Draw a sailboat")!)
    const wrap = explicitImageCommandMiddleware([entry])[0].wrapModelCall!
    const history = [new HumanMessage({ id: "u", content: "Draw a sailboat" })]
    const calls = ["one", "two"].map(id => ({ id, name: entry.name, args: { prompt: "sailboat" } }))
    const model = vi.fn(async () => new AIMessage({ content: "", tool_calls: calls }))
    const first = await wrap({ messages: history, tools: [entry] } as never, model) as AIMessage
    expect(first.tool_calls).toHaveLength(1)
    const complete = new ToolMessage({ content: JSON.stringify({
      kind: "generated-image", actionId: "11111111-1111-4111-8111-111111111111",
      width: 32, height: 32, mimeType: "image/png"
    }), tool_call_id: "one" })
    const after = await wrap({ messages: [...history, first, complete], tools: [entry] } as never, model) as AIMessage
    expect(after.tool_calls?.length ?? 0).toBe(0)
  })
})
