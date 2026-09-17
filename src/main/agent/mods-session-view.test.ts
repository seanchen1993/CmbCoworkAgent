import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { expect, it, vi } from "vitest"
import type { ModsManager } from "../mods/manager"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { createFunctionSessionViewMiddleware } from "./mods-session-view"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware
} from "./turn-completion-integrity"

class ScriptedModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = []
  constructor(private readonly script: AIMessage[]) {
    super({})
  }
  _llmType() {
    return "mods-session-script"
  }
  bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const message = this.script.shift()
    if (!message) throw Error("Unexpected model call")
    return { generations: [{ text: String(message.content), message }] }
  }
}

it("observes real model/tool/final graph states and preserves completion recovery routing", async () => {
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({
    workspace: "/root",
    threadId: "thread",
    turnId: "turn"
  })
  let current: readonly unknown[] = []
  const manager = {
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn((_authority, messages: readonly unknown[]) => {
      current = messages
    })
  }
  const model = new ScriptedModel([
    new AIMessage({ content: "", response_metadata: { finish_reason: "stop" } }),
    new AIMessage({
      content: "reading",
      tool_calls: [{ id: "call", name: "inspect", args: {}, type: "tool_call" }]
    }),
    new AIMessage({ content: "finished", response_metadata: { finish_reason: "stop" } })
  ])
  const inspect = tool(
    async () => {
      expect((current.at(-1) as AIMessage).tool_calls?.[0]?.id).toBe("call")
      return "tool result"
    },
    { name: "inspect", description: "Inspect", schema: z.object({}) }
  )
  try {
    const agent = createAgent({
      model,
      tools: [inspect],
      middleware: [
        createTurnCompletionGateMiddleware({ ownerRunToken: "turn" }),
        createFunctionSessionViewMiddleware(
          manager as unknown as ModsManager,
          authority,
          "actual-model"
        )
      ]
    })
    const result = await agent.invoke(
      { messages: [new HumanMessage("inspect")] },
      { configurable: { thread_id: "thread" } }
    )
    expect(model.calls).toHaveLength(3)
    expect(current).toEqual(result.messages)
    expect((current.at(-1) as AIMessage).content).toBe("finished")
    expect(current.some((message) => (message as BaseMessage).getType() === "tool")).toBe(true)
    expect(manager.bindFunctionSession).toHaveBeenCalledWith(authority, "actual-model")
  } finally {
    authorities.close()
    clearTurnCompletionGateState("thread", "turn")
  }
})
