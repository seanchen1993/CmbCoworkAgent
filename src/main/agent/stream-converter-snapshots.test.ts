import { describe, expect, it } from "vitest"
import { StreamConverter } from "./stream-converter"
import { createStreamDataSerializer } from "../ipc/stream-data-serialization"
import {
  projectSchedulerSubagentMessage,
  applyPersistedSubagentTranscriptRefs,
  upsertTranscriptMessages,
  serializeSubagentTranscripts
} from "../../renderer/src/lib/subagent-transcripts"
import type { Message } from "../../renderer/src/types"

describe("scheduled subagent snapshots", () => {
  it("preserves hydrated and pending content when only reasoning changes", () => {
    for (const pending of [false, true]) {
      const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
      const initial: Message = pending
        ? projectSchedulerSubagentMessage(tracker, { id: "a", content: "keep", contentMode: "snapshot" })
        : { id: "a", role: "assistant", content: "keep", created_at: new Date() }
      const update = projectSchedulerSubagentMessage(tracker, { id: "a", content: "", reasoning: "new", reasoningMode: "snapshot" })
      expect(update.content_stream_delta).toBeUndefined()
      const current = upsertTranscriptMessages([initial], [update])
      expect(current[0].content).toBe("keep")
      const stored = (serializeSubagentTranscripts({ task: current }).task as Array<Record<string, unknown>>)[0]
      expect(stored).toMatchObject({ content: "keep", reasoning: "new" })
    }
  })
  it("preserves pending reasoning when a content-only replacement omits reasoning", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const initial = projectSchedulerSubagentMessage(tracker, { id: "a", content: "old", reasoning: "keep", contentMode: "snapshot", reasoningMode: "snapshot" })
    const replacement = projectSchedulerSubagentMessage(tracker, { id: "a", content: "new", contentMode: "snapshot" })
    const current = upsertTranscriptMessages([initial], [replacement])
    const stored = (serializeSubagentTranscripts({ task: current }).task as Array<Record<string, unknown>>)[0]
    expect(stored).toMatchObject({ content: "new", reasoning: "keep" })
  })
  it("keeps a replacement through FIFO retry coalescing and resumes suffix writes after its ack", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const old = projectSchedulerSubagentMessage(tracker, {
      id: "a",
      content: "base tail",
      contentMode: "snapshot"
    })
    const snapshot = projectSchedulerSubagentMessage(tracker, {
      id: "a",
      content: "base",
      contentMode: "snapshot"
    })
    // The production single-flight failure path merges failed rows first, then
    // the newer pending rows; it never queues an old delta after this replacement.
    const retry = upsertTranscriptMessages([old], [snapshot], { completeSnapshot: true })
    const serialized = (
      serializeSubagentTranscripts({ task: retry }).task as Array<Record<string, unknown>>
    )[0]
    expect(serialized).toMatchObject({ content: "base", subagent_text_snapshots: ["content"] })
    const acknowledged = applyPersistedSubagentTranscriptRefs(
      { task: retry },
      { task: retry },
      {
        task: [
          {
            id: "a",
            content_ref: { v: 1, kind: "content", sha256: "c".repeat(64), bytes: 6 },
            content_full_length: 4
          }
        ]
      }
    )
    expect(acknowledged.task[0].content_stream_snapshot).toBeUndefined()
    const continued = upsertTranscriptMessages(acknowledged.task, [
      projectSchedulerSubagentMessage(tracker, { id: "a", content: "new", contentMode: "delta" })
    ])
    const delta = (
      serializeSubagentTranscripts({ task: continued }).task as Array<Record<string, unknown>>
    )[0]
    expect(delta).not.toHaveProperty("subagent_text_snapshots")
    expect(delta).toMatchObject({
      subagent_text_deltas: { content: { baseLength: 4, targetLength: 7, delta: "new" } }
    })
    expect(continued[0].content).toBe("basenew")
  })
  it("continues interior tool arguments across a replacement without duplicating the call", () => {
    const converter = new StreamConverter("tool-snapshot-run")
    converter.processChunk("messages", [
      {
        id: ["AIMessage"],
        kwargs: {
          id: "main",
          content: "",
          tool_calls: [
            {
              id: "task",
              name: "task",
              args: { subagent_type: "general-purpose", description: "work" }
            }
          ]
        }
      },
      {}
    ])
    const serialize = createStreamDataSerializer()
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    let messages: Message[] = []
    const frames = [
      {
        kind: "AIMessageChunk",
        content: "draft",
        tool_call_chunks: [{ id: "echo-call", name: "echo", index: 0, args: '{"value":"' }]
      },
      { kind: "AIMessage", content: "corrected" },
      { kind: "AIMessageChunk", content: " tail", tool_call_chunks: [{ index: 0, args: 'haha"}' }] }
    ]
    for (const { kind, ...kwargs } of frames) {
      const packet = serialize("messages", [
        { id: [kind], kwargs: { ...kwargs, id: "inner" } },
        { checkpoint_ns: "agent:tools:task", cmb_subagent_owner_tool_call_id: "task" }
      ])
      for (const event of converter.processChunk("messages", packet.data)) {
        if (event.type !== "message-delta") continue
        expect(event.subagentId).toBeTruthy()
        messages = upsertTranscriptMessages(messages, [
          projectSchedulerSubagentMessage(tracker, {
            ...event,
            toolCalls: event.toolCalls as Message["tool_calls"]
          })
        ])
      }
    }
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      content: "corrected tail",
      tool_calls: [{ id: "echo-call", name: "echo", args: { value: "haha" } }]
    })
    expect(messages[0].tool_calls).toHaveLength(1)
  })
  it("invalidates stale sidecar acknowledgements after an equal-length rewrite", () => {
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    const initial = projectSchedulerSubagentMessage(tracker, {
      id: "a",
      content: "old",
      reasoning: "old",
      contentMode: "snapshot",
      reasoningMode: "snapshot"
    })
    const replacement = projectSchedulerSubagentMessage(tracker, {
      id: "a",
      content: "new",
      reasoning: "new",
      contentMode: "snapshot",
      reasoningMode: "snapshot"
    })
    const current = upsertTranscriptMessages([initial], [replacement])
    const attached = applyPersistedSubagentTranscriptRefs(
      { task: current },
      { task: [initial] },
      {
        task: [
          {
            id: "a",
            content_ref: { v: 1, kind: "content", sha256: "a".repeat(64), bytes: 5 },
            content_full_length: 3,
            reasoning_ref: { v: 1, kind: "reasoning", sha256: "b".repeat(64), bytes: 5 },
            reasoning_full_length: 3
          }
        ]
      }
    )
    expect(attached.task[0].content_ref).toBeUndefined()
    expect(attached.task[0].reasoning_ref).toBeUndefined()
    const serialized = (
      serializeSubagentTranscripts(attached).task as Array<Record<string, unknown>>
    )[0]
    expect(serialized).toMatchObject({
      content: "new",
      reasoning: "new",
      subagent_text_snapshots: ["content", "reasoning"]
    })
  })
  it("routes explicit interior snapshots instead of dropping their text", () => {
    const converter = new StreamConverter("snapshot-run")
    converter.processChunk("messages", [
      {
        id: ["AIMessage"],
        kwargs: {
          id: "main",
          content: "",
          tool_calls: [
            {
              id: "task",
              name: "task",
              args: { subagent_type: "general-purpose", description: "work" }
            }
          ]
        }
      },
      {}
    ])
    const serialize = createStreamDataSerializer()
    const packet = serialize("messages", [
      {
        id: ["AIMessage"],
        kwargs: { id: "inner", content: "first", additional_kwargs: { reasoning_content: "think" } }
      },
      { checkpoint_ns: "agent:tools:task", cmb_subagent_owner_tool_call_id: "task" }
    ])
    const toolEvents = converter.processChunk("messages", [
      {
        id: ["ToolMessage"],
        kwargs: {
          id: "inner-result",
          tool_call_id: "read-call",
          name: "read_file",
          content: "done"
        }
      },
      { checkpoint_ns: "agent:tools:task", cmb_subagent_owner_tool_call_id: "task" }
    ])
    expect(toolEvents).toContainEqual(
      expect.objectContaining({ type: "tool-message", subagentId: expect.any(String) })
    )
    const events = converter.processChunk("messages", packet.data)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message-delta",
        content: "first",
        reasoning: "think",
        contentMode: "snapshot",
        reasoningMode: "snapshot",
        subagentId: expect.any(String)
      })
    )
    expect(
      events.some(
        (event) => event.type === "custom" && event.data.type === "coordinator_ai_snapshot_message"
      )
    ).toBe(false)
  })

  it("replaces and clears scheduler transcript fields, then continues deltas without main leakage", () => {
    const converter = new StreamConverter("route-run")
    converter.processChunk("messages", [
      {
        id: ["AIMessage"],
        kwargs: {
          id: "main",
          content: "",
          tool_calls: [
            {
              id: "task",
              name: "task",
              args: { subagent_type: "general-purpose", description: "work" }
            }
          ]
        }
      },
      {}
    ])
    const serialize = createStreamDataSerializer()
    const tracker: Parameters<typeof projectSchedulerSubagentMessage>[0] = { currentMsgId: null }
    let messages: Message[] = []
    const frames = [
      ["AIMessage", "draft", "think", "draft", "think"],
      ["AIMessageChunk", "ha", "r", "draftha", "thinkr"],
      ["AIMessageChunk", "ha", "r", "drafthaha", "thinkrr"],
      ["AIMessage", "fixed", "f", "fixed", "f"],
      ["AIMessage", "", "", "", ""],
      ["AIMessageChunk", "new", "x", "new", "x"]
    ]
    for (const [kind, content, reasoning, expectedContent, expectedReasoning] of frames) {
      const packet = serialize("messages", [
        {
          id: [kind],
          kwargs: { id: "inner", content, additional_kwargs: { reasoning_content: reasoning } }
        },
        { checkpoint_ns: "agent:tools:task", cmb_subagent_owner_tool_call_id: "task" }
      ])
      const events = converter.processChunk("messages", packet.data)
      for (const event of events) {
        if (event.type !== "message-delta") continue
        expect(event.subagentId).toBeTruthy()
        messages = upsertTranscriptMessages(messages, [
          projectSchedulerSubagentMessage(tracker, {
            ...event,
            toolCalls: event.toolCalls as Message["tool_calls"]
          })
        ])
      }
      expect(messages[0]).toMatchObject({ content: expectedContent, reasoning: expectedReasoning })
      const stored = (
        serializeSubagentTranscripts({ task: messages }).task as Array<Record<string, unknown>>
      )[0]
      expect(stored).toMatchObject({ content: expectedContent, reasoning: expectedReasoning })
      expect(stored).not.toHaveProperty("content_stream_snapshot")
      expect(stored).not.toHaveProperty("reasoning_stream_snapshot")
      expect(
        events.some(
          (event) =>
            event.type === "custom" && event.data.type === "coordinator_ai_snapshot_message"
        )
      ).toBe(false)
    }
  })
})
