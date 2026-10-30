import { describe, expect, it, vi } from "vitest"
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { getCurrentTurnAssistantResponse } from "../agent/goals/evaluator"
import { createStreamDataSerializer } from "./stream-data-serialization"
import { createStreamMessageSideEffectBuffer } from "./stream-message-side-effect-buffer"
import { StopHookContextCollector } from "./stop-hook-context"
import {
  getStreamTranscriptValueLocalOccurrence,
  rememberSelectedStreamTranscriptValueSnapshots,
  selectStreamTranscriptValueSnapshots
} from "./stream-transcript-values"

vi.mock("../storage", () => ({ getEnabledPluginSkillSourceMetadata: () => [] }))

describe("Stop context across authoritative stream updates", () => {
  it("uses a cached tail's original local ordinal instead of treating it as the first cycle", () => {
    const collector = new StopHookContextCollector()
    const tool = new ToolMessage({ id: "tool", tool_call_id: "call-1", content: "result" })
    for (const message of [
      new AIMessageChunk({ id: "same", content: "first" }),
      tool,
      new AIMessageChunk({ id: "same", content: "second" })
    ])
      collector.processStreamChunk("messages", [message.toJSON(), {}])
    const last = new AIMessage({
      id: "same",
      content: "",
      tool_calls: [{ id: "call-2", name: "echo", args: {} }]
    }).toJSON()
    const payload = { messages: [last] }
    const tuples = selectStreamTranscriptValueSnapshots(payload, "tail", {
      completeMessages: [
        new HumanMessage({ id: "u", content: "question" }).toJSON(),
        new AIMessage({ id: "same", content: "first" }).toJSON(),
        tool.toJSON(),
        last
      ],
      loadPreviousTurnOccurrences: () => [
        { role: "assistant", provider_source_id: "same", provider_occurrence: 7 }
      ]
    })
    expect(tuples.map(getStreamTranscriptValueLocalOccurrence)).toEqual([2])
    rememberSelectedStreamTranscriptValueSnapshots(payload, tuples)
    collector.processStreamChunk("values", payload)
    expect(collector.snapshot().assistantResponse).toBe("first")
  })

  it("starts current-turn lookup ordinals again after a new user boundary", () => {
    const collector = new StopHookContextCollector()
    collector.processStreamChunk("messages", [
      new HumanMessage({ id: "u1", content: "first" }).toJSON(),
      {}
    ])
    collector.processStreamChunk("messages", [
      new AIMessageChunk({ id: "same", content: "previous" }).toJSON(),
      {}
    ])
    collector.processStreamChunk("messages", [
      new HumanMessage({ id: "u2", content: "second" }).toJSON(),
      {}
    ])
    collector.processStreamChunk("messages", [
      new AIMessageChunk({ id: "same", content: "draft" }).toJSON(),
      {}
    ])
    const payload = {
      messages: [
        new HumanMessage({ id: "u2", content: "second" }).toJSON(),
        new AIMessage({
          id: "same",
          content: "",
          tool_calls: [{ id: "call", name: "echo", args: {} }]
        }).toJSON()
      ]
    }
    rememberSelectedStreamTranscriptValueSnapshots(
      payload,
      selectStreamTranscriptValueSnapshots(payload, "full", {
        loadPreviousTurnOccurrences: () => [
          { role: "assistant", provider_source_id: "same", provider_occurrence: 1 }
        ]
      })
    )
    collector.processStreamChunk("values", payload)
    expect(collector.snapshot().assistantResponse).toBe("previous")
  })

  it("uses current-turn ordinals for globally numbered values occurrences 8 and 9", () => {
    const collector = new StopHookContextCollector()
    const tool = new ToolMessage({ id: "tool", tool_call_id: "call-1", content: "result" })
    for (const message of [
      new AIMessageChunk({ id: "same", content: "old first" }),
      tool,
      new AIMessageChunk({ id: "same", content: "old second" })
    ])
      collector.processStreamChunk("messages", [message.toJSON(), {}])
    const messages = [
      new HumanMessage({ id: "current-user", content: "question" }).toJSON(),
      new AIMessage({
        id: "same",
        content: "corrected first",
        tool_calls: [{ id: "call-1", name: "echo", args: {} }]
      }).toJSON(),
      tool.toJSON(),
      new AIMessage({
        id: "same",
        content: "",
        tool_calls: [{ id: "call-2", name: "echo", args: {} }]
      }).toJSON()
    ]
    const payload = { messages }
    const before = JSON.stringify(payload)
    const tuples = selectStreamTranscriptValueSnapshots(payload, "full", {
      loadPreviousTurnOccurrences: () => [
        { role: "assistant", provider_source_id: "same", provider_occurrence: 7 }
      ]
    })
    expect(tuples.map(getStreamTranscriptValueLocalOccurrence)).toEqual([1, 1, 2])
    rememberSelectedStreamTranscriptValueSnapshots(payload, tuples)
    collector.processStreamChunk("values", payload)
    expect(collector.snapshot().assistantResponse).toBe("corrected first")
    expect(JSON.stringify(payload)).toBe(before)
    collector.processStreamChunk("messages", [
      new AIMessageChunk({ id: "same", content: "fresh" }).toJSON(),
      {}
    ])
    expect(collector.snapshot().assistantResponse).toBe("corrected firstfresh")
  })

  it("corrects earlier reused-ID cycles without restoring a cleared last tool assistant", () => {
    const collector = new StopHookContextCollector()
    const first = new AIMessageChunk({ id: "same", content: "old first" })
    const tool = new ToolMessage({ id: "tool", tool_call_id: "call-1", content: "result" })
    const second = new AIMessageChunk({ id: "same", content: "old second" })
    for (const message of [first, tool, second]) {
      collector.processStreamChunk("messages", [message.toJSON(), {}])
    }
    collector.processStreamChunk("values", {
      messages: [
        new AIMessage({
          id: "same",
          content: "corrected first",
          tool_calls: [{ id: "call-1", name: "echo", args: {} }]
        }).toJSON(),
        tool.toJSON(),
        new AIMessage({
          id: "same",
          content: "",
          tool_calls: [{ id: "call-2", name: "echo", args: {} }]
        }).toJSON()
      ]
    })
    expect(collector.snapshot().assistantResponse).toBe("corrected first")
    collector.processStreamChunk("messages", [
      new AIMessageChunk({ id: "same", content: "fresh" }).toJSON(),
      {}
    ])
    expect(collector.snapshot().assistantResponse).toBe("corrected firstfresh")
  })

  it("replaces a draft before collecting the final Stop response", () => {
    const serialize = createStreamDataSerializer()
    const buffer = createStreamMessageSideEffectBuffer()
    for (const message of [
      new AIMessageChunk({ id: "a", content: "old draft" }),
      new AIMessage({ id: "a", content: "corrected" }),
      new AIMessageChunk({ id: "a", content: " tail" })
    ])
      buffer.push(serialize("messages", [message, {}]).data)
    const collector = new StopHookContextCollector("question")
    for (const payload of buffer.drain()) collector.processStreamChunk("messages", payload)
    expect(collector.snapshot().assistantResponse).toBe("corrected tail")
  })

  it("honors empty final values instead of resurrecting the draft", () => {
    const collector = new StopHookContextCollector()
    const serialize = createStreamDataSerializer()
    collector.processStreamChunk(
      "messages",
      serialize("messages", [new AIMessageChunk({ id: "a", content: "draft" }), {}]).data
    )
    collector.processStreamChunk(
      "values",
      serialize("values", { messages: [new AIMessage({ id: "a", content: "" })] }).data
    )
    expect(collector.snapshot().assistantResponse ?? "").toBe("")
    expect(
      getCurrentTurnAssistantResponse({
        assistantText: "draft",
        currentTurnAssistantStart: 0,
        lastFinalText: ""
      })
    ).toBe("")
  })

  it("keeps tool observations and visible user text while excluding tool results", () => {
    const serialize = createStreamDataSerializer()
    const collector = new StopHookContextCollector()
    const messages = [
      new HumanMessage({
        id: "u",
        content: "augmented",
        additional_kwargs: { cmb_visible_user_message: "visible question" }
      }),
      new AIMessage({
        id: "a",
        content: "",
        tool_calls: [{ id: "call", name: "echo", args: { text: "hi" } }]
      }),
      new ToolMessage({ id: "t", tool_call_id: "call", content: "tool result" }),
      new AIMessageChunk({ id: "final", content: "answer" })
    ]
    for (const message of messages)
      collector.processStreamChunk("messages", serialize("messages", [message, {}]).data)
    collector.processStreamChunk("values", serialize("values", { messages }).data)
    expect(collector.snapshot()).toMatchObject({
      userMessage: "visible question",
      assistantResponse: "answer",
      toolCalls: ["echo"]
    })
  })

  it("continues from corrected values instead of freezing the previous final", () => {
    const collector = new StopHookContextCollector()
    const serialize = createStreamDataSerializer()
    collector.processStreamChunk(
      "messages",
      serialize("messages", [new AIMessageChunk({ id: "a", content: "draft" }), {}]).data
    )
    collector.processStreamChunk(
      "values",
      serialize("values", { messages: [new AIMessage({ id: "a", content: "corrected" })] }).data
    )
    collector.processStreamChunk(
      "messages",
      serialize("messages", [new AIMessageChunk({ id: "a", content: " tail" }), {}]).data
    )
    expect(collector.snapshot().assistantResponse).toBe("corrected tail")
  })

  it("applies tool-bearing values edits before excluding them from final answers", () => {
    const collector = new StopHookContextCollector()
    const serialize = createStreamDataSerializer()
    collector.processStreamChunk(
      "messages",
      serialize("messages", [new AIMessageChunk({ id: "a", content: "draft" }), {}]).data
    )
    collector.processStreamChunk(
      "values",
      serialize("values", {
        messages: [
          new AIMessage({
            id: "a",
            content: "",
            tool_calls: [{ id: "call", name: "echo", args: {} }]
          })
        ]
      }).data
    )
    expect(collector.snapshot().assistantResponse ?? "").toBe("")
    expect(collector.snapshot().toolCalls).toEqual(["echo"])
  })
})
