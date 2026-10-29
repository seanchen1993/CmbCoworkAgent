import { describe, expect, it, vi } from "vitest"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { createStreamDataSerializer } from "./stream-data-serialization"
import { persistedMessageFromStreamPayload } from "./stream-transcript-payload"
import { selectStreamTranscriptValueSnapshots } from "./stream-transcript-values"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"

const message = (type: string, id: string, fields: Record<string, unknown> = {}) => ({
  id: ["langchain_core", "messages", type],
  kwargs: { id, ...fields }
})

describe("current-turn values transcript snapshots", () => {
  it("resolves a repeated-ID tail from complete roles while querying only its changed identity", () => {
    const complete = Array.from({ length: 100 }, (_, index) => [
      message("AIMessage", "same", { content: `cycle ${index}` }),
      message("ToolMessage", `t${index}`, { content: "result", tool_call_id: `c${index}` })
    ]).flat()
    const tail = message("AIMessage", "same", { content: "final" })
    complete.push(tail)
    const loadBaselineMessages = vi.fn<(selectors: readonly unknown[]) => []>(() => [])
    const tuples = selectStreamTranscriptValueSnapshots({ messages: [tail] }, "tail", {
      completeMessages: complete,
      loadBaselineMessages
    })
    expect(tuples).toHaveLength(1)
    expect(persistedMessageFromStreamPayload(tuples[0])).toMatchObject({
      content: "final",
      provider_source_id: "same",
      provider_occurrence: 101
    })
    expect(loadBaselineMessages.mock.calls).toHaveLength(2)
    expect(loadBaselineMessages.mock.calls.every((call) => call[0].length === 1)).toBe(true)
  })

  it.each(["full", "append", "tail"] as const)("excludes earlier turns in %s frames", (kind) => {
    const snapshots = selectStreamTranscriptValueSnapshots(
      {
        messages: [
          message("AIMessage", "old", { content: "history" }),
          message("HumanMessage", "user", { content: "new turn" }),
          message("ToolMessage", "tool", { content: "result", tool_call_id: "call" }),
          message("SystemMessage", "system", { content: "system" }),
          message("AIMessage", "final", { content: "answer" })
        ]
      },
      kind
    )
    expect(snapshots.map((tuple) => persistedMessageFromStreamPayload(tuple)?.id)).toEqual([
      "tool",
      "final"
    ])
  })

  it("accepts a values-only final without a user while preserving source fields", () => {
    const source = message("AIMessage", "final", {
      content: "answer",
      additional_kwargs: {
        [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: "provider",
        [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: 2
      }
    })
    Object.freeze(source.kwargs)
    Object.freeze(source)
    const payload = Object.freeze({ messages: Object.freeze([source]) })
    const [tuple] = selectStreamTranscriptValueSnapshots(payload, "full")
    expect(tuple[0]).toEqual(source)
    expect(tuple[0]).not.toBe(source)
    expect(tuple[0].kwargs).not.toBe(source.kwargs)
    expect(tuple[0].kwargs).not.toHaveProperty("tool_calls")
    expect(tuple[0].kwargs).not.toHaveProperty("reasoning")
    expect(persistedMessageFromStreamPayload(tuple)).toMatchObject({
      content: "answer",
      streamContentMode: "snapshot",
      provider_source_id: "provider",
      provider_occurrence: 2
    })
  })

  it.each([
    undefined,
    null,
    {},
    { todos: [] },
    { messages: null },
    { messages: [] },
    { messages: [null, undefined, {}, message("AIMessage", "metadata")] }
  ])("does not construct a clear from missing or malformed values: %j", (payload) => {
    expect(selectStreamTranscriptValueSnapshots(payload)).toEqual([])
  })

  it("keeps independent empty fields and tools-only assistant updates", () => {
    const snapshots = selectStreamTranscriptValueSnapshots(
      {
        messages: [
          message("AIMessage", "clear-content", { content: "" }),
          message("AIMessage", "clear-reasoning", { additional_kwargs: { reasoning_content: "" } }),
          message("AIMessage", "tools", { tool_calls: [{ id: "call", name: "echo", args: {} }] })
        ]
      },
      "tail"
    )
    expect(snapshots).toHaveLength(3)
    expect(persistedMessageFromStreamPayload(snapshots[0])).toMatchObject({
      content: "",
      streamContentMode: "snapshot"
    })
    expect(persistedMessageFromStreamPayload(snapshots[0])).not.toHaveProperty("reasoning")
    expect(snapshots[1][0].kwargs).not.toHaveProperty("content")
    expect(persistedMessageFromStreamPayload(snapshots[1])).toMatchObject({
      reasoning: "",
      reasoning_mode: "snapshot",
      streamContentMode: "delta"
    })
    expect(persistedMessageFromStreamPayload(snapshots[2])).toMatchObject({
      streamContentMode: "delta",
      tool_calls: [{ id: "call", name: "echo", args: {} }]
    })
  })

  it("accepts real serializer full, append and tail envelopes without mutating them", () => {
    const serialize = createStreamDataSerializer()
    const user = new HumanMessage({ id: "u", content: "question" })
    const ai = new AIMessage({ id: "a", content: "draft" })
    const frames = [
      serialize("values", { messages: [user] }),
      serialize("values", { messages: [user, ai] }),
      serialize("values", { messages: [user, new AIMessage({ id: "a", content: "draft tail" })] }),
      serialize("values", { messages: [user, new AIMessage({ id: "a", content: "" })] })
    ]
    expect(frames.map((frame) => frame.valuesSnapshotKind)).toEqual([
      "full",
      "append",
      "tail",
      "full"
    ])
    for (const frame of frames) {
      const before = JSON.stringify(frame.data)
      const tuples = selectStreamTranscriptValueSnapshots(frame.data, frame.valuesSnapshotKind)
      expect(JSON.stringify(frame.data)).toBe(before)
      if (tuples.length)
        expect(persistedMessageFromStreamPayload(tuples[0])?.streamContentMode).toBe("snapshot")
    }
    expect(
      selectStreamTranscriptValueSnapshots(frames[3].data, frames[3].valuesSnapshotKind).map(
        (tuple) => persistedMessageFromStreamPayload(tuple)?.content
      )
    ).toEqual([""])
  })
})
