import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent } from "langchain"
import { z } from "zod"
import { MemorySaver } from "@langchain/langgraph"
import { readLiveContextUsage } from "./context-usage"
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
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn((_authority, messages: readonly unknown[]) => {
      current = messages
    }),
    updateFunctionSessionRequest: vi.fn()
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
          "actual-model",
          "physical-run",
          32000
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
    expect(manager.bindFunctionSession).toHaveBeenCalledWith(authority, "actual-model", 32000)
    expect(manager.functionTurns.observe).toHaveBeenCalledTimes(3)
    expect(manager.functionTurns.observe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["thread", "physical-run"],
      ["thread", "physical-run"],
      ["thread", "physical-run"]
    ])
    expect(manager.functionTurns.observe.mock.calls.map((call) => call[2].content)).toEqual([
      "",
      "reading",
      "finished"
    ])
    expect(
      manager.functionTurns.observe.mock.calls.every((call) => call[2].getType() === "ai")
    ).toBe(true)
  } finally {
    authorities.close()
    clearTurnCompletionGateState("thread", "turn")
  }
})

it("observes the private compaction boundary through real graph middleware state", async () => {
  const authorities = new ModRuntimeAuthorities()
  const { authority } = authorities.create({
    workspace: "/root",
    threadId: "thread",
    turnId: "turn"
  })
  let observedMessages: readonly unknown[] = []
  let observedState: unknown
  const manager = {
    functionTurns: { observe: vi.fn() },
    bindFunctionSession: vi.fn(),
    updateFunctionSessionMessages: vi.fn(
      (_authority, messages: readonly unknown[], state: unknown) => {
        observedMessages = messages
        observedState = state
      }
    ),
    updateFunctionSessionRequest: vi.fn()
  }
  try {
    const agent = createAgent({
      model: new ScriptedModel([new AIMessage("no provider usage yet")]),
      tools: [],
      middleware: [
        createFunctionSessionViewMiddleware(
          manager as unknown as ModsManager,
          authority,
          "actual",
          "run",
          32000
        )
      ],
      checkpointer: new MemorySaver()
    })
    const config = { configurable: { thread_id: "thread" } }
    await agent.updateState(
      config,
      {
        messages: [
          new AIMessage({
            content: "old",
            usage_metadata: { input_tokens: 900, output_tokens: 1, total_tokens: 901 }
          })
        ],
        _summarizationEvent: {
          cutoffIndex: 0,
          usageStartIndex: 1,
          summaryMessage: new HumanMessage("summary"),
          filePath: null
        }
      },
      "model_request"
    )
    await agent.invoke({ messages: [new HumanMessage("continue")] }, config)
    expect(observedState).toHaveProperty("_summarizationEvent.usageStartIndex", 1)
    expect(
      await readLiveContextUsage(
        observedMessages,
        observedState,
        new AbortController().signal,
        () => {}
      )
    ).toBeUndefined()
  } finally {
    authorities.close()
  }
})
