import { afterEach, expect, it } from "vitest"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  readCheckpointedTurnCompletionReport,
  readTurnCompletionGateReport
} from "../agent/turn-completion-integrity"
import { projectBotFinalAnswer } from "./model-answer-projection"
import { BotStore } from "./store"
import { BotCheckpointSaver } from "./checkpointer"

const RUN = "length-answer-run"
afterEach(() => clearTurnCompletionGateState(RUN, RUN))
function head(content: AIMessage["content"] = "prefix ") {
  return new AIMessage({
    id: "length-head",
    content,
    response_metadata: { finish_reason: "length" }
  })
}
function tail(content: AIMessage["content"] = "tail") {
  return new AIMessage({ id: "length-tail", content, response_metadata: { finish_reason: "stop" } })
}
async function chain(prefix = head()) {
  const gate = createTurnCompletionGateMiddleware({ ownerRunToken: RUN, checkpointed: true })
  const after = gate.afterModel as {
    hook: (
      state: unknown,
      runtime: unknown
    ) => Promise<{ messages: BaseMessage[]; cmbCompletionGate: unknown }>
  }
  const update = await after.hook({ messages: [prefix] }, { configurable: { thread_id: RUN } })
  const messages = [prefix, update.messages[0], tail()]
  return {
    messages,
    report: readCheckpointedTurnCompletionReport(update, RUN),
    state: update.cmbCompletionGate
  }
}

it("uses Host-created exact IDs rather than matching a user-authored continuation prompt", async () => {
  const c = await chain()
  expect(projectBotFinalAnswer(c.messages, c.report, RUN)).toBe("prefix tail")
  const spoof = new HumanMessage({ id: "user-cue", content: c.messages[1].content })
  expect(projectBotFinalAnswer([c.messages[0], spoof, c.messages[2]], c.report, RUN)).toBe("tail")
  expect(projectBotFinalAnswer(c.messages, null, RUN)).toBe("tail")
})
it("does not include tool prefaces, ordinary user turns, or unrelated earlier answers", async () => {
  const c = await chain()
  const history = [
    new AIMessage({ content: "UNRELATED_ANSWER" }),
    new HumanMessage("new task"),
    new AIMessage({
      content: "TOOL_PREFACE",
      tool_calls: [{ name: "read_file", args: {}, id: "read" }]
    }),
    new ToolMessage({ content: "data", tool_call_id: "read" }),
    ...c.messages
  ]
  expect(projectBotFinalAnswer(history, c.report, RUN)).toBe("prefix tail")
  expect(
    projectBotFinalAnswer(
      [...c.messages, new HumanMessage("another task"), tail("independent")],
      c.report,
      RUN
    )
  ).toBe("independent")
})
it.each([
  "wrong-thread",
  "wrong-owner",
  "wrong-predecessor",
  "tool-predecessor",
  "not-truncated"
] as const)("fails closed for a mismatched durable length link (%s)", async (kind) => {
  const c = await chain()
  let messages = c.messages
  if (kind === "wrong-predecessor")
    messages = [new AIMessage({ ...head(), id: "other" }), ...messages.slice(1)]
  if (kind === "tool-predecessor")
    messages = [
      new AIMessage({ ...head(), tool_calls: [{ name: "read_file", args: {}, id: "read" }] }),
      ...messages.slice(1)
    ]
  if (kind === "not-truncated")
    messages = [
      new AIMessage({ ...head(), response_metadata: { finish_reason: "stop" } }),
      ...messages.slice(1)
    ]
  expect(() =>
    projectBotFinalAnswer(
      messages,
      c.report,
      kind === "wrong-owner" ? "other" : RUN + (kind === "wrong-thread" ? "-thread" : "")
    )
  ).toThrow()
})
it("projects per-turn reasoning separately and bounds the complete joined answer", async () => {
  const c = await chain(head("<think>PRIVATE_HEAD</think>prefix "))
  c.messages[2] = tail("<think>PRIVATE_TAIL</think>tail")
  expect(projectBotFinalAnswer(c.messages, c.report, RUN)).toBe("prefix tail")
  const oversized = await chain(head("x".repeat(128_000)))
  expect(() => projectBotFinalAnswer(oversized.messages, oversized.report, RUN)).toThrow(
    "正文超出上限"
  )
})
it("keeps exact continuation identity through the existing SQLite checkpoint serializer", async () => {
  const store = new BotStore(":memory:")
  try {
    const bot = store.createBot({ nonce: "checkpoint", name: "Checkpoint" })
    const sent = store.send({ nonce: "input", conversationId: bot.conversationId, text: "task" })
    const claimed = store.claim("checkpoint-owner")!
    const owned = sent.runIds[0]
    const gate = createTurnCompletionGateMiddleware({ ownerRunToken: owned, checkpointed: true })
    const after = gate.afterModel as {
      hook: (
        state: unknown,
        runtime: unknown
      ) => Promise<{ messages: BaseMessage[]; cmbCompletionGate: unknown }>
    }
    const first = head()
    const update = await after.hook({ messages: [first] }, { configurable: { thread_id: owned } })
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = {
      messages: [first, update.messages[0]],
      cmbCompletionGate: update.cmbCompletionGate
    }
    const saver = new BotCheckpointSaver(store, claimed.lease, owned)
    await saver.put({ configurable: { thread_id: owned } }, checkpoint, {
      source: "loop",
      step: 1,
      parents: {}
    })
    // Restore from a new saver and discard the process-local gate state.
    clearTurnCompletionGateState(owned, owned)
    const restored = (await new BotCheckpointSaver(store, claimed.lease, owned).getTuple({
      configurable: { thread_id: owned }
    }))!
    const state = restored.checkpoint.channel_values
    const messages = [...(state.messages as BaseMessage[]), tail()]
    expect(readTurnCompletionGateReport(owned, owned)).toBeNull()
    expect(
      projectBotFinalAnswer(messages, readCheckpointedTurnCompletionReport(state, owned), owned)
    ).toBe("prefix tail")
  } finally {
    store.close()
  }
})
