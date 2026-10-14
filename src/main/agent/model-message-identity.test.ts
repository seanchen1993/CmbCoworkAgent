import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage
} from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { Command, MemorySaver, messagesStateReducer } from "@langchain/langgraph"
import { createAgent, createMiddleware, toolStrategy } from "langchain"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY as occurrenceKey,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY as sourceKey
} from "../../shared/message-role-collision"
import {
  createModelMessageIdentityMiddleware,
  normalizeModelMessageIdentity
} from "./model-message-identity"

class RepeatingProvider extends BaseChatModel {
  readonly requests: BaseMessage[][] = []
  readonly issued: AIMessage[] = []
  constructor(private readonly respond: (index: number) => AIMessage) {
    super({})
  }
  _llmType(): string {
    return "identity-regression-provider"
  }
  bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push([...messages])
    const message = this.respond(this.requests.length - 1)
    this.issued.push(message)
    return { generations: [{ message, text: String(message.content) }] }
  }
}

describe("completed ordinary model message identity", () => {
  it("preserves every tool cycle in the real LangGraph reducer", () => {
    let history: BaseMessage[] = [new HumanMessage({ id: "user", content: "read twice" })]
    for (let index = 1; index <= 3; index++) {
      const response = new AIMessage({
        id: "provider-reused",
        content: `reply ${index}`,
        tool_calls: index < 3 ? [{ id: `call-${index}`, name: "read", args: { index } }] : []
      })
      normalizeModelMessageIdentity(response, history)
      history = messagesStateReducer(history, [response])
      if (index < 3)
        history = messagesStateReducer(history, [
          new ToolMessage({
            id: `tool-${index}`,
            content: `evidence ${index}`,
            tool_call_id: `call-${index}`
          })
        ])
    }
    expect(history.map((message) => message.content)).toEqual([
      "read twice",
      "reply 1",
      "evidence 1",
      "reply 2",
      "evidence 2",
      "reply 3"
    ])
    expect(new Set(history.map((message) => message.id)).size).toBe(6)
    expect(
      history
        .filter(AIMessage.isInstance)
        .map((message) => message.additional_kwargs[occurrenceKey])
    ).toEqual([1, 2, 3])
  })

  it("keeps unique and idless results unchanged and isolates separate histories", () => {
    const unique = new AIMessage({ id: " unique ", content: "same" })
    normalizeModelMessageIdentity(unique, [])
    expect(unique.id).toBe(" unique ")
    const idless = new AIMessage("same")
    normalizeModelMessageIdentity(idless, [])
    expect(idless.id).toBeUndefined()
    expect(idless.additional_kwargs).toEqual({})
    const independent = new AIMessage({ id: " unique ", content: "same" })
    normalizeModelMessageIdentity(independent, [])
    expect(independent.id).toBe(unique.id)
    const repeated = new AIMessage({ id: " unique ", content: "same" })
    normalizeModelMessageIdentity(repeated, [unique])
    expect(repeated.id).not.toBe(unique.id)
    expect(repeated.additional_kwargs[occurrenceKey]).toBe(2)
    const stable = JSON.stringify(repeated.toJSON())
    normalizeModelMessageIdentity(repeated, [unique])
    expect(JSON.stringify(repeated.toJSON())).toBe(stable)
  })

  it("uses retained occurrence after a truncated prefix and avoids every occupied role", () => {
    const previous = new AIMessage({
      id: "retained",
      content: "previous",
      additional_kwargs: { [sourceKey]: "raw", [occurrenceKey]: 97 }
    })
    const occupied = new HumanMessage({
      id: buildMessageSameRoleDuplicateId("raw", "assistant", 98),
      content: "user"
    })
    const alias = new ToolMessage({
      id: buildMessageRoleCollisionId("raw", "assistant", 98),
      content: "tool",
      tool_call_id: "actual-call"
    })
    const response = new AIMessage({ id: "raw", content: "next" })
    normalizeModelMessageIdentity(response, [previous, occupied, alias])
    expect(response.additional_kwargs[occurrenceKey]).toBe(98)
    expect(response.id).toBe(buildMessageRoleCollisionId("raw", "assistant", 99))
    expect(previous.id).toBe("retained")
    const crossRole = new AIMessage({ id: "user-id", content: "assistant" })
    normalizeModelMessageIdentity(crossRole, [
      new HumanMessage({
        id: "user-id",
        content: "user"
      })
    ])
    expect(crossRole.id).toBe(buildMessageRoleCollisionId("user-id", "assistant"))
  })

  it("preserves the original chunk, tool details, reasoning, usage and serialized fields", () => {
    const response = new AIMessageChunk({
      id: "raw",
      content: [{ type: "text", text: "text" }],
      name: "provider",
      additional_kwargs: { reasoning_content: "reasoning", custom: { v: 1 } },
      response_metadata: { finish_reason: "tool_calls" },
      usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      tool_call_chunks: [{ index: 0, id: "call", name: "read", args: "{}" }],
      invalid_tool_calls: [{ id: "invalid", name: "read", args: "bad", error: "invalid" }]
    })
    const refs = [
      response.content,
      response.tool_calls,
      response.tool_call_chunks,
      response.invalid_tool_calls,
      response.response_metadata,
      response.usage_metadata
    ]
    normalizeModelMessageIdentity(response, [new AIMessage({ id: "raw", content: "old" })])
    expect(response).toBeInstanceOf(AIMessageChunk)
    expect([
      response.content,
      response.tool_calls,
      response.tool_call_chunks,
      response.invalid_tool_calls,
      response.response_metadata,
      response.usage_metadata
    ]).toEqual(refs)
    refs.forEach((value, index) =>
      expect(
        [
          response.content,
          response.tool_calls,
          response.tool_call_chunks,
          response.invalid_tool_calls,
          response.response_metadata,
          response.usage_metadata
        ][index]
      ).toBe(value)
    )
    expect(response.additional_kwargs.reasoning_content).toBe("reasoning")
    const serialized = response.toJSON() as { kwargs: Record<string, unknown> }
    expect(serialized.kwargs.id).toBe(response.id)
    expect(serialized.kwargs.additional_kwargs).toEqual(response.additional_kwargs)
    expect(response.lc_kwargs.additional_kwargs).toBe(response.additional_kwargs)
  })

  it("normalizes structured batches in order without replacing Command references", () => {
    const first = new AIMessage({ id: "raw", content: "first" })
    const middle = new ToolMessage({
      id: buildMessageSameRoleDuplicateId("raw", "assistant", 2),
      content: "result",
      tool_call_id: "call"
    })
    const second = new AIMessage({ id: "raw", content: "second" })
    const container = { structuredResponse: { value: "ok" }, messages: [first, middle, second] }
    normalizeModelMessageIdentity(container, [])
    expect(container.messages[0]).toBe(first)
    expect(container.messages[2]).toBe(second)
    expect(new Set(container.messages.map((message) => message.id)).size).toBe(3)
    const third = new AIMessage({ id: "raw", content: "third" })
    const command = new Command({ update: { messages: [third, third] } })
    normalizeModelMessageIdentity(command, container.messages)
    expect((command.update as { messages: AIMessage[] }).messages[0]).toBe(third)
    expect(third.additional_kwargs[occurrenceKey]).toBe(3)
    expect(third.lc_kwargs.id).toBe(third.id)
  })

  it("refuses to mutate a history object or overflow an occurrence", () => {
    const previous = new AIMessage({ id: "raw", content: "old" })
    expect(() => normalizeModelMessageIdentity(previous, [previous])).toThrow(
      "MODEL_RESPONSE_REUSES_HISTORY_OBJECT"
    )
    expect(previous.additional_kwargs).toEqual({})
    const high = new AIMessage({
      id: "retained",
      content: "old",
      additional_kwargs: { [sourceKey]: "raw", [occurrenceKey]: Number.MAX_SAFE_INTEGER }
    })
    expect(() =>
      normalizeModelMessageIdentity(new AIMessage({ id: "raw", content: "new" }), [high])
    ).toThrow("MODEL_RESPONSE_OCCURRENCE_INVALID")
    const almostHigh = new AIMessage({
      id: "retained",
      content: "old",
      additional_kwargs: { [sourceKey]: "raw", [occurrenceKey]: Number.MAX_SAFE_INTEGER - 1 }
    })
    const aliases = [
      buildMessageSameRoleDuplicateId("raw", "assistant", Number.MAX_SAFE_INTEGER),
      buildMessageRoleCollisionId("raw", "assistant", Number.MAX_SAFE_INTEGER)
    ].map((id) => new HumanMessage({ id, content: "occupied" }))
    expect(() =>
      normalizeModelMessageIdentity(new AIMessage({ id: "raw", content: "new" }), [
        almostHigh,
        ...aliases
      ])
    ).toThrow("MODEL_RESPONSE_OCCURRENCE_INVALID")
    normalizeModelMessageIdentity({ opaque: "result" }, [previous])
    expect(previous.id).toBe("raw")
  })

  it("keeps actual tool calls and later turns in a checkpointed createAgent graph", async () => {
    const provider = new RepeatingProvider(
      (index) =>
        new AIMessage({
          id: "raw",
          content: `reply ${index + 1}`,
          tool_calls: index < 2 ? [{ id: `call-${index + 1}`, name: "read", args: { index } }] : []
        })
    )
    const read = tool(({ index }) => `evidence ${index + 1}`, {
      name: "read",
      description: "read",
      schema: z.object({ index: z.number() })
    })
    const graph = createAgent({
      model: provider,
      tools: [read],
      checkpointer: new MemorySaver(),
      middleware: [createModelMessageIdentityMiddleware()]
    })
    const config = { configurable: { thread_id: "ordinary-identity" } }
    const result = await graph.invoke({ messages: [new HumanMessage("read twice")] }, config)
    expect(result.messages.map((message) => message.content)).toEqual([
      "read twice",
      "reply 1",
      "evidence 1",
      "reply 2",
      "evidence 2",
      "reply 3"
    ])
    expect(provider.requests[2].filter(AIMessage.isInstance)).toHaveLength(2)
    expect(provider.requests[2].filter(ToolMessage.isInstance)).toHaveLength(2)
    const continued = await graph.invoke({ messages: [new HumanMessage("continue")] }, config)
    expect(continued.messages).toHaveLength(8)
    expect(provider.requests[3]).toHaveLength(7)
    expect(
      continued.messages
        .filter(AIMessage.isInstance)
        .map((message) => message.additional_kwargs[occurrenceKey])
    ).toEqual([1, 2, 3, 4])
  })

  it("checks complete state even when an outer middleware filters model input", async () => {
    const provider = new RepeatingProvider(() => new AIMessage({ id: "raw", content: "answer" }))
    const filter = createMiddleware({
      name: "short-model-input",
      wrapModelCall: (req, handler) =>
        handler({ ...req, messages: req.messages.filter(HumanMessage.isInstance).slice(-1) })
    })
    const graph = createAgent({
      model: provider,
      middleware: [filter, createModelMessageIdentityMiddleware()]
    })
    const result = await graph.invoke({
      messages: [
        new HumanMessage("old request"),
        new AIMessage({ id: "raw", content: "old answer" }),
        new HumanMessage("new request")
      ]
    })
    expect(provider.requests[0]).toHaveLength(1)
    expect(result.messages.map((message) => message.content)).toEqual([
      "old request",
      "old answer",
      "new request",
      "answer"
    ])
    expect(result.messages.at(-1)?.additional_kwargs[occurrenceKey]).toBe(2)
  })

  it("preserves real structured-output retry Commands and their paired tool results", async () => {
    const provider = new RepeatingProvider(
      (index) =>
        new AIMessage({
          id: "raw",
          content: "",
          tool_calls: [
            {
              id: `extract-${index}`,
              name: "extract",
              args: {
                count: index === 0 ? "invalid" : 7
              }
            }
          ]
        })
    )
    const observed: unknown[] = []
    const observe = createMiddleware({
      name: "outer-observer",
      wrapModelCall: async (req, handler) => {
        const response = await handler(req)
        observed.push(response)
        return response
      }
    })
    const graph = createAgent({
      model: provider,
      responseFormat: toolStrategy({
        type: "object",
        title: "extract",
        properties: { count: { type: "number" } },
        required: ["count"],
        additionalProperties: false
      }),
      middleware: [observe, createModelMessageIdentityMiddleware()]
    })
    const result = await graph.invoke({ messages: [new HumanMessage("extract count")] })
    expect(result.structuredResponse).toEqual({ count: 7 })
    expect(provider.requests).toHaveLength(2)
    expect(observed[0]).toBe(provider.issued[0])
    expect(provider.requests[1].filter(AIMessage.isInstance).map((message) => message.id)).toEqual([
      provider.issued[0].id
    ])
    expect(
      result.messages.filter(ToolMessage.isInstance).map((message) => message.tool_call_id)
    ).toEqual(["extract-0", "extract-1"])
    expect(
      result.messages
        .filter(AIMessage.isInstance)
        .slice(0, 2)
        .map((message) => message.additional_kwargs[occurrenceKey])
    ).toEqual([1, 2])
    expect(new Set(result.messages.map((message) => message.id)).size).toBe(result.messages.length)
  })
})
