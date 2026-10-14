import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { Command, isCommand } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { captureFunctionConversationNativeTaskConfig,
  wrapFunctionConversationSharedInvocation, withoutConversationChannel } from
  "./mods-conversation-shared-invocation"

describe("known native shared graph state isolation", () => {
  it("pins actual namespace primitives before awaiting and keeps native function identities", () => {
    const read = () => undefined, scratchpad = {}
    const config = { configurable: { thread_id: "physical", checkpoint_ns: "tools:actual",
      checkpoint_map: { "": "original-parent" }, __pregel_read: read,
      __pregel_scratchpad: scratchpad } }
    const captured = captureFunctionConversationNativeTaskConfig(config)
    config.configurable.thread_id = "later-physical"
    config.configurable.checkpoint_map[""] = "later-parent"
    expect(captured.configurable).toMatchObject({ thread_id: "physical",
      checkpoint_map: { "": "original-parent" } })
    expect(captured.configurable?.__pregel_read).toBe(read)
    expect(captured.configurable?.__pregel_scratchpad).toBe(scratchpad)
    expect(Object.isFrozen(captured.configurable?.checkpoint_map)).toBe(true)
  })

  it("keeps the actual seed and other state without mutating the parent input", async () => {
    const seed = new HumanMessage({ id: "seed", content: "actual task" })
    const input = { messages: [seed], todos: [], ordinaryState: { value: 1 },
      cmbFunctionConversation: { conversationId: "parent", frontier: 9 } }
    const graph = { invoke: vi.fn(async (state: unknown) => state) }
    const wrapped = wrapFunctionConversationSharedInvocation(graph, () => undefined)
    const result = await wrapped.invoke(input)
    expect(graph.invoke).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty("cmbFunctionConversation")
    expect((result as typeof input).messages[0]).toBe(seed)
    expect(result).toMatchObject({ ordinaryState: { value: 1 } })
    expect(input.cmbFunctionConversation.frontier).toBe(9)
  })

  it("keeps routing and actual paired ToolMessage while excluding a child update channel", () => {
    const result = new ToolMessage({ id: "result", content: "actual", tool_call_id: "call" })
    const command = new Command({ update: { messages: [result], ordinary: "same",
      cmbFunctionConversation: { conversationId: "child", frontier: 2 } },
      goto: "next", resume: { value: 1 }, graph: Command.PARENT })
    const safe = withoutConversationChannel(command)
    expect(isCommand(safe)).toBe(true)
    const actual = safe as Command
    expect(actual.graph).toBe(command.graph)
    expect(actual.goto).toEqual(command.goto)
    expect(actual.resume).toEqual(command.resume)
    expect(actual.update).toEqual({ messages: [result], ordinary: "same" })
    expect((actual.update as { messages: unknown[] }).messages[0]).toBe(result)
    expect(command.update).toHaveProperty("cmbFunctionConversation")
  })

  it("leaves commands and resume inputs with no conversation channel unchanged", () => {
    const command = new Command({ resume: "answer", goto: "next" })
    expect(withoutConversationChannel(command)).toBe(command)
    expect(withoutConversationChannel(null)).toBeNull()
    const state = { messages: [], structuredResponse: { value: "answer" } }
    expect(withoutConversationChannel(state)).toBe(state)
  })

  it("filters only a Command's channel pairs and preserves native values and pair order", () => {
    const result = new ToolMessage({ id: "result", content: "actual", tool_call_id: "call" })
    const update: [string, unknown][] = [["messages", [result]],
      ["cmbFunctionConversation", { conversationId: "child", frontier: 1 }], ["ordinary", 1],
      ["cmbFunctionConversation", { conversationId: "child", frontier: 2 }]]
    const command = new Command({ update, goto: "next", graph: Command.PARENT })
    const actual = withoutConversationChannel(command) as Command
    expect(actual.update).toEqual([update[0], update[2]])
    expect((actual.update as [string, unknown][])[0]).toBe(update[0])
    expect(actual.graph).toBe(command.graph)
    expect(actual.goto).toEqual(command.goto)
    expect(command.update).toHaveLength(4)
    const ordinary = new Command({ update: [["messages", [result]]] })
    expect(withoutConversationChannel(ordinary)).toBe(ordinary)
    expect(withoutConversationChannel(update)).toBe(update)
  })
})
