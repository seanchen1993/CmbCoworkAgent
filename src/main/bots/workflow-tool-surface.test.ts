import { expect, it, vi } from "vitest"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { ChatResult } from "@langchain/core/outputs"
import { convertToOpenAITool } from "@langchain/core/utils/function_calling"
import { tool } from "@langchain/core/tools"
import { z } from "zod"
import { createDeepAgent } from "../agent/runtime"

// Exercise the real graph and tool middleware; the model and tool side effects
// are controlled. Adapter tests separately cover the policy passed to Runtime.
class ToolSurfaceModel extends BaseChatModel {
  constructor(
    private readonly seen: Array<{ child: boolean; names: string[] }>,
    private readonly names: string[] = []
  ) { super({}) }
  _llmType(): string { return "bot-tool-surface-test" }
  bindTools(tools: Parameters<typeof convertToOpenAITool>[0][]): ToolSurfaceModel {
    return new ToolSurfaceModel(this.seen, tools.map((entry) => convertToOpenAITool(entry).function.name))
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const child = messages.some((entry) => JSON.stringify(entry.content).includes("SURFACE_CHILD"))
    this.seen.push({ child, names: this.names })
    const finished = child || messages.at(-1)?._getType() === "tool"
    const message = finished
      ? new AIMessage({ content: "Verified", response_metadata: { finish_reason: "stop" } })
      : new AIMessage({ content: "", tool_calls: [{
          id: "delegate-once", name: "task", type: "tool_call",
          args: { description: "Inspect the fixture", subagent_type: "worker" }
        }] })
    return { generations: [{ text: String(message.content), message }] }
  }
}

it.each([true, false])("Bot workflow block=%s preserves actual task execution and communication tools", async (blocked) => {
  const seen: Array<{ child: boolean; names: string[] }> = []
  const launch = vi.fn(() => "launched")
  const tools = [
    tool(launch, { name: "workflow", description: "Launch a workflow", schema: z.object({}) }),
    ...["bot_delegate", "bot_send_message", "bot_return_files", "bot_deliver_files"].map((name) =>
      tool(() => "delivered", { name, description: name, schema: z.object({}) })
    )
  ]
  const agent = createDeepAgent({
    model: new ToolSurfaceModel(seen),
    tools,
    systemPrompt: "Delegate inspection once, then report the result.",
    mainBlockedToolNames: blocked ? ["workflow"] : [],
    mainFilesystemEnabled: false,
    mainTodosEnabled: false,
    includeGeneralPurposeSubagent: false,
    subagents: [{ name: "worker", description: "Inspect fixture", systemPrompt: "SURFACE_CHILD", tools: [] }]
  })
  await agent.invoke({ messages: [new HumanMessage("Inspect the fixture")] })
  const parents = seen.filter((entry) => !entry.child)
  expect(parents).toHaveLength(2)
  expect(seen.filter((entry) => entry.child)).toHaveLength(1)
  for (const { names } of parents) {
    expect(names.includes("workflow")).toBe(!blocked)
    expect(names).toEqual(expect.arrayContaining([
      "task", "bot_delegate", "bot_send_message", "bot_return_files", "bot_deliver_files"
    ]))
  }
  expect(launch).not.toHaveBeenCalled()
})
