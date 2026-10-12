import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, it } from "vitest"
import { createDeepAgent, clearToolConcurrencyLocksForThread } from "./deep-agent-core"
import {
  clearTurnCompletionGateState,
  describeTurnCompletionFailure,
  readCheckpointedTurnCompletionReport
} from "./turn-completion-integrity"
import { clearActionStationarityTurn } from "./action-stationarity"

const id = "checkpointed-bot-completion"
afterEach(() => {
  clearTurnCompletionGateState(id, id)
  clearToolConcurrencyLocksForThread(id)
  clearActionStationarityTurn(id, id)
})

class ScriptedModel extends BaseChatModel {
  calls = 0
  constructor(private readonly script: Array<AIMessage | Error>) {
    super({})
  }
  _llmType() {
    return "graph-fixture"
  }
  bindTools() {
    return this
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++
    const value = this.script.shift()
    if (!value) throw new Error("Unexpected extra model call")
    if (value instanceof Error) throw value
    return { generations: [{ text: String(value.content), message: value }] }
  }
}

const truncated = () =>
  new AIMessage({
    content: "未输出完整",
    response_metadata: { finish_reason: "length", model_name: "graph-fixture" }
  })

function graph(model: ScriptedModel, saver: MemorySaver) {
  return createDeepAgent({
    model,
    checkpointer: saver,
    mainFilesystemEnabled: false,
    mainSubagentsEnabled: false,
    includeGeneralPurposeSubagent: false,
    turnCompletionOwnerToken: id,
    turnCompletionCheckpointed: true,
    actionStationarityTurnId: id,
    toolConcurrencyQueueId: id
  })
}

it("keeps completion budgets and the failed verdict through graph recreation and an END resume", async () => {
  const saver = new MemorySaver()
  const config = { configurable: { thread_id: id } }
  const first = new ScriptedModel([truncated(), new Error("simulated process loss")])
  await expect(
    graph(first, saver).invoke({ messages: [new HumanMessage("完成任务")] }, config)
  ).rejects.toThrow("simulated process loss")
  clearTurnCompletionGateState(id, id)
  const second = new ScriptedModel([truncated(), truncated()])
  const result = await graph(second, saver).invoke(null, config)
  expect(second.calls).toBe(2)
  const report = readCheckpointedTurnCompletionReport(result, id)
  expect(report).toMatchObject({ retriesUsed: 2, unresolved: { defect: "length_truncated" } })
  expect(describeTurnCompletionFailure(report!)).toContain("未完成")
  clearTurnCompletionGateState(id, id)
  const resumed = new ScriptedModel([])
  const settled = await graph(resumed, saver).invoke(null, config)
  expect(resumed.calls).toBe(0)
  expect(readCheckpointedTurnCompletionReport(settled, id)).toEqual(report)
})

it("does not reuse a previous logical turn's completion verdict", async () => {
  const result = await graph(
    new ScriptedModel([
      new AIMessage({
        content: "任务完成",
        response_metadata: { finish_reason: "stop" }
      })
    ]),
    new MemorySaver()
  ).invoke({ messages: [new HumanMessage("完成任务")] }, { configurable: { thread_id: id } })
  expect(readCheckpointedTurnCompletionReport(result, id)?.unresolved).toBeNull()
  expect(readCheckpointedTurnCompletionReport(result, "another-run")).toBeNull()
})

it("fails closed when a graph requests a host capability without its service", () => {
  const model = new ScriptedModel([])
  expect(() => createDeepAgent({ model, threadId: "desktop-only-thread" })).toThrow(
    "requires a host service"
  )
  expect(() => createDeepAgent({ model, modRuntimeAuthority: { agentId: "main" } })).toThrow(
    "requires a host service"
  )
})
