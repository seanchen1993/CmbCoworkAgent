import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  applySchedulerAssistantSnapshot,
  mergeSchedulerReasoning
} from "./scheduler-assistant-snapshot"
import { createManagedTransportAgentRunDelivery } from "../../../main/agent/managed-transport-delivery"
import { createStreamDataSerializer } from "../../../main/ipc/stream-data-serialization"
import type { SchedulerRendererEvent } from "../../../main/agent/stream-converter"
import type { Message } from "../types"

const tracker = () => ({
  currentMsgId: null as string | null,
  accumulatedContent: "",
  accumulatedReasoning: ""
})
const row = (id: string, role: Message["role"], content: string): Message => ({
  id,
  role,
  content,
  created_at: new Date()
})

describe("managed scheduler assistant snapshots", () => {
  it("keeps late completed snapshots on the same provider occurrence after a steer", () => {
    const state = tracker()
    const completed = {
      ...row("stable-first", "assistant", "finished"),
      provider_source_id: "reused",
      provider_occurrence: 1,
      reasoning: "retained",
      tool_calls: [{ id: "call", name: "echo", args: {} }]
    }
    const messages = [completed, row("steer", "user", "continue")]
    const events: SchedulerRendererEvent[] = []
    const delivery = createManagedTransportAgentRunDelivery({
      mirror: (_, event) => events.push(event), broadcast: () => {}
    })
    const serialize = createStreamDataSerializer()
    for (const [kind, id, occurrence] of [
      ["AIMessage", "stable-first", 1],
      ["AIMessageChunk", "reused", 2]
    ] as const) {
      const packet = serialize("messages", [{ id: [kind], kwargs: {
        id, content: "finished", additional_kwargs: {
          cmb_internal_provider_source_id: "reused", cmb_internal_provider_occurrence: occurrence
        }
      } }, {}])
      delivery.send("agent:stream:thread", { type: "stream", mode: "messages", data: packet.data })
    }
    const snapshot = events.find(e => e.type === "custom" && e.data.type === "coordinator_ai_snapshot_message")!
    assertCustom(snapshot)
    const next = applySchedulerAssistantSnapshot(state, messages, snapshot.data.assistantMessage)!
    expect(next).toMatchObject(completed)
    const delta = events.find(e => e.type === "message-delta")
    expect(delta).toMatchObject({ provider_source_id: "reused", provider_occurrence: 2 })
    const second = applySchedulerAssistantSnapshot(state, messages, {
      id: "reused", type: "ai", content: "finished", provider_source_id: "reused", provider_occurrence: 2
    })!
    expect(second.id).not.toBe(completed.id)
    expect(second.provider_occurrence).toBe(2)
  })
  it("preserves repeated explicit reasoning deltas through real managed delivery", () => {
    const state = tracker()
    let messages: Message[] = []
    const delivery = createManagedTransportAgentRunDelivery({
      broadcast: () => {},
      mirror: (_, event) => {
        if (event.type === "custom" && event.data.type === "coordinator_ai_snapshot_message") {
          messages = [
            applySchedulerAssistantSnapshot(state, messages, event.data.assistantMessage)!
          ]
        } else if (event.type === "message-delta") {
          state.accumulatedContent += event.content
          if (event.reasoning !== undefined) {
            state.accumulatedReasoning = mergeSchedulerReasoning(
              state.accumulatedReasoning,
              event.reasoning,
              event.reasoningMode
            )
          }
          messages = [
            {
              ...row(event.id, "assistant", state.accumulatedContent),
              reasoning: state.accumulatedReasoning
            }
          ]
        }
      }
    })
    const serialize = createStreamDataSerializer()
    const frames: Array<[string, Record<string, unknown>, string]> = [
      ["AIMessage", { content: "body", additional_kwargs: { reasoning_content: "r" } }, "r"],
      ["AIMessageChunk", { content: "", additional_kwargs: { reasoning_content: "r" } }, "rr"],
      ["AIMessageChunk", { content: "", additional_kwargs: { reasoning_content: "r" } }, "rrr"],
      ["AIMessage", { additional_kwargs: { reasoning_content: "fixed" } }, "fixed"],
      ["AIMessageChunk", { content: " tail" }, "fixed"],
      ["AIMessage", { additional_kwargs: { reasoning_content: "" } }, ""],
      ["AIMessageChunk", { content: "", additional_kwargs: { reasoning_content: "r" } }, "r"]
    ]
    for (const [kind, kwargs, expected] of frames) {
      const packet = serialize("messages", [{ id: [kind], kwargs: { id: "a", ...kwargs } }, {}])
      delivery.send("agent:stream:thread:coordinator-internal", {
        type: "stream",
        mode: "messages",
        data: packet.data
      })
      expect(state.accumulatedReasoning).toBe(expected)
    }
    expect(messages[0].content).toBe("body tail")
    expect(mergeSchedulerReasoning("r", "rr")).toBe("rr")
    expect(mergeSchedulerReasoning("r", "r")).toBe("r")
    const source = readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8")
    expect(source).toMatch(
      /mergeSchedulerReasoning\(\s*tracker.accumulatedReasoning,\s*reasoning,\s*event.reasoningMode\s*\)/
    )
  })
  it("continues the actual coordinator-internal delivery from corrected text", () => {
    const events: SchedulerRendererEvent[] = []
    const delivery = createManagedTransportAgentRunDelivery({
      mirror: (_, event) => events.push(event),
      broadcast: () => {}
    })
    const serialize = createStreamDataSerializer()
    for (const [kind, content] of [
      ["AIMessageChunk", "draft"],
      ["AIMessage", "fixed"],
      ["AIMessageChunk", " tail"]
    ]) {
      const packet = serialize("messages", [{ id: [kind], kwargs: { id: "a", content } }, {}])
      delivery.send("agent:stream:thread:coordinator-internal", {
        type: "stream",
        mode: "messages",
        data: packet.data
      })
    }
    const state = tracker()
    let messages: Message[] = []
    for (const event of events) {
      if (event.type === "message-delta") {
        if (state.currentMsgId !== event.id) state.accumulatedContent = ""
        state.currentMsgId = event.id
        state.accumulatedContent += event.content
        messages = [row(event.id, "assistant", state.accumulatedContent)]
      } else if (event.type === "custom" && event.data.type === "coordinator_ai_snapshot_message") {
        messages = [applySchedulerAssistantSnapshot(state, messages, event.data.assistantMessage)!]
      }
    }
    expect(messages[0].content).toBe("fixed tail")
    const source = readFileSync(new URL("./thread-context.tsx", import.meta.url), "utf8")
    const branch = source.slice(source.indexOf("const processSchedulerEvent ="))
    expect(branch).toMatch(
      /applySchedulerAssistantSnapshot\(\s*tracker,\s*state.messages,\s*data.assistantMessage\s*\)/
    )
  })

  it("starts from a snapshot and only replaces fields explicitly present", () => {
    const state = tracker()
    const first = applySchedulerAssistantSnapshot(state, [], {
      id: "a",
      content: "body",
      reasoning: "think"
    })!
    const second = applySchedulerAssistantSnapshot(state, [first], { id: "a", reasoning: "" })!
    expect(second).toMatchObject({ content: "body", reasoning: "" })
    expect(state).toMatchObject({ accumulatedContent: "body", accumulatedReasoning: "" })
    const other = tracker()
    expect(other.accumulatedContent).toBe("")
    expect(
      applySchedulerAssistantSnapshot(state, [second], { id: "a", type: "tool", content: "bad" })
    ).toBeUndefined()
    expect(state.accumulatedContent).toBe("body")
  })

  it("keeps tool rows and their arguments across role collisions and assistant cycles", () => {
    const tool = { ...row("same", "tool", "result"), tool_call_id: "call" }
    const state = tracker()
    const first = applySchedulerAssistantSnapshot(state, [tool], { id: "same", content: "body" })!
    expect(first.id).not.toBe(tool.id)
    const assistant = {
      ...row("a", "assistant", "old"),
      tool_calls: [{ id: "call", name: "echo", args: { value: "kept" } }]
    }
    const rewritten = applySchedulerAssistantSnapshot(state, [assistant], {
      id: "a",
      content: "new"
    })!
    expect(rewritten.tool_calls).toEqual(assistant.tool_calls)
    const next = applySchedulerAssistantSnapshot(state, [assistant, tool], {
      id: "a",
      reasoning: "next"
    })!
    expect(next.id).not.toBe(assistant.id)
    expect(next.content).toBe("")
    expect(next.tool_calls).toBeUndefined()
    expect(tool.content).toBe("result")
  })
})

function assertCustom(event: SchedulerRendererEvent): asserts event is Extract<SchedulerRendererEvent, { type: "custom" }> {
  expect(event.type).toBe("custom")
}
