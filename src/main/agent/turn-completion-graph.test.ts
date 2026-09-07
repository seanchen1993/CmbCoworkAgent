import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { BaseMessage } from "@langchain/core/messages"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { createAgent, createMiddleware } from "langchain"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  readTurnCompletionGateReport
} from "./turn-completion-integrity"

/**
 * The unit tests next door prove the gate ASKS for another model turn. This one
 * proves the graph actually GIVES it one, against the real `createAgent` wiring.
 *
 * That is not a formality. LangChain's afterModel router short-circuits on
 *
 *   if (AIMessage.isInstance(last) && !last.tool_calls?.length) return exitNode
 *
 * BEFORE it reads `jumpTo` (see ReactAgent#createAfterModelRouter), so a
 * middleware that returns `jumpTo: "model"` without appending a non-AI message
 * is silently ignored and the turn ends anyway. Pin the behaviour here so an
 * upstream change to that router fails loudly instead of quietly restoring the
 * "read_file was the last thing I saw, then ✅ 任务完成" bug.
 */

const THREAD = "graph-thread"
const RUN = "graph-run"

class ScriptedChatModel extends BaseChatModel {
  /** Every response the graph asked for, in order. */
  readonly calls: BaseMessage[][] = []

  constructor(private readonly script: AIMessage[]) {
    super({})
  }

  _llmType(): string {
    return "scripted"
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages)
    const message = this.script.shift()
    if (!message) throw new Error("ScriptedChatModel ran out of scripted responses")
    return {
      generations: [{ text: typeof message.content === "string" ? message.content : "", message }]
    }
  }

  // createAgent binds tools to the model; the script already encodes the calls.
  bindTools(): this {
    return this
  }
}

function scriptedAi(
  content: string,
  metadata: Record<string, unknown> = {},
  toolCalls: AIMessage["tool_calls"] = []
): AIMessage {
  return new AIMessage({
    content,
    response_metadata: { model_name: "scripted-model", ...metadata },
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
  })
}

const readFile = tool(async () => "export const answer = 42\n", {
  name: "read_file",
  description: "Read a file",
  schema: z.object({ file_path: z.string() })
})

/**
 * LangChain runs afterModel hooks in REVERSE middleware order and wires only
 * the LAST-executed node (`afterModelNodes[0]`, i.e. the FIRST middleware in
 * the array) to the router carrying the "AI reply with no tool calls → exit"
 * short-circuit; earlier-in-array neighbours make the gate an intermediate
 * sequence node instead, which routes `jumpTo` on its own. Both positions must
 * work, so tests can put a bystander afterModel middleware ahead of the gate.
 */
const bystanderAfterModel = createMiddleware({
  name: "bystander",
  afterModel: async () => undefined
})

async function runGraph(
  script: AIMessage[],
  options: { withBystander?: boolean } = {}
): Promise<{ model: ScriptedChatModel; final: string }> {
  const model = new ScriptedChatModel(script)
  const agent = createAgent({
    model,
    tools: [readFile],
    middleware: [
      ...(options.withBystander ? [bystanderAfterModel] : []),
      createTurnCompletionGateMiddleware({ ownerRunToken: RUN })
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as Parameters<typeof createAgent>[0]) as any

  const result = await agent.invoke(
    { messages: [new HumanMessage("看下 a.ts 里定义了什么")] },
    { configurable: { thread_id: THREAD } }
  )
  const messages = result.messages as BaseMessage[]
  const last = messages.at(-1)
  return {
    model,
    final: last && typeof last.content === "string" ? last.content : ""
  }
}

afterEach(() => {
  clearTurnCompletionGateState(THREAD, RUN)
})

describe("turn completion gate inside the real agent graph", () => {
  it("does not end the turn on an empty reply after a tool result", async () => {
    // The exact reported sequence: read_file runs, the model answers with
    // nothing, and the UI's last visible item was the tool call.
    const { model, final } = await runGraph([
      scriptedAi("", { finish_reason: "tool_calls" }, [
        { name: "read_file", args: { file_path: "a.ts" }, id: "call_1" }
      ]),
      scriptedAi("", { finish_reason: "stop" }),
      scriptedAi("a.ts 导出了一个常量 answer，值为 42。", { finish_reason: "stop" })
    ])

    // 3 model calls: the tool call, the empty reply, and the recovered answer.
    // Without the gate this would be 2 and the turn would have ended empty.
    expect(model.calls).toHaveLength(3)
    expect(final).toContain("answer")

    // The recovery prompt was handed to the model as a real conversational turn.
    const recoveredPrompt = model.calls[2].at(-1)
    expect(HumanMessage.isInstance(recoveredPrompt)).toBe(true)
    expect(String(recoveredPrompt?.content)).toContain("CMB_TURN_COMPLETION_GATE_V1")

    expect(readTurnCompletionGateReport(THREAD, RUN)?.unresolved).toBeNull()
  })

  it("gives up after the retry budget and leaves the defect on record", async () => {
    const { model } = await runGraph([
      scriptedAi("", { finish_reason: "stop" }),
      scriptedAi("", { finish_reason: "stop" }),
      scriptedAi("", { finish_reason: "stop" })
    ])

    // 1 original + 2 retries, then the graph is allowed to end.
    expect(model.calls).toHaveLength(3)
    const report = readTurnCompletionGateReport(THREAD, RUN)!
    expect(report.retriesUsed).toBe(2)
    expect(report.unresolved?.defect).toBe("empty_response")
  })

  it("still recovers when another afterModel middleware sits ahead of it", async () => {
    // Gate as an INTERMEDIATE afterModel node (the sequence-router path), which
    // is what the real runtime middleware array produces.
    const { model, final } = await runGraph(
      [
        scriptedAi("", { finish_reason: "stop" }),
        scriptedAi("a.ts 导出了 answer = 42。", { finish_reason: "stop" })
      ],
      { withBystander: true }
    )
    expect(model.calls).toHaveLength(2)
    expect(final).toContain("answer")
  })

  it("leaves a healthy turn at exactly one model call", async () => {
    const { model, final } = await runGraph([
      scriptedAi("你好，有什么可以帮你？", { finish_reason: "stop" })
    ])
    expect(model.calls).toHaveLength(1)
    expect(final).toContain("你好")
    expect(readTurnCompletionGateReport(THREAD, RUN)?.unresolved).toBeNull()
  })
})
