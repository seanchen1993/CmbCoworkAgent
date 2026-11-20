import { describe, expect, it } from "vitest"
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages"
import { createStreamDataSerializer } from "./stream-data-serialization"
import { persistedMessageFromStreamPayload } from "./stream-transcript-payload"
import { resolveStreamTranscriptFlush } from "./stream-transcript-flush"

describe("transcript payload field presence", () => {
  it("keeps an explicit content clear through serialization, parsing and flush", () => {
    const serialize = createStreamDataSerializer()
    const queued = [
      new AIMessageChunk({ id: "a", content: "draft" }),
      new AIMessage({ id: "a", content: "" }),
      new AIMessageChunk({ id: "a", content: "fresh" })
    ].map(
      (message) => persistedMessageFromStreamPayload(serialize("messages", [message, {}]).data)!
    )
    expect(queued.every(Boolean)).toBe(true)
    expect(queued[1]).toMatchObject({ content: "", streamContentMode: "snapshot" })
    expect(
      resolveStreamTranscriptFlush({ queuedMessages: queued, loadBaselineMessages: () => [] })
        .messages
    ).toMatchObject([{ content: "fresh", content_mode: "snapshot" }])
  })

  it("does not grant content replacement authority to a reasoning-only message", () => {
    const serialize = createStreamDataSerializer()
    const payload = serialize("messages", [
      {
        id: ["AIMessage"],
        kwargs: {
          id: "a",
          additional_kwargs: { reasoning_content: "" }
        }
      },
      {}
    ]).data
    const parsed = persistedMessageFromStreamPayload(payload)
    expect(parsed).toMatchObject({
      content: "",
      streamContentMode: "delta",
      reasoning: "",
      reasoning_mode: "snapshot"
    })
  })

  it("drops missing fields and empty delta metadata without creating a clear", () => {
    const serialize = createStreamDataSerializer()
    expect(
      persistedMessageFromStreamPayload(
        serialize("messages", [{ id: ["AIMessage"], kwargs: { id: "a" } }, {}]).data
      )
    ).toBeNull()
    expect(
      persistedMessageFromStreamPayload(
        serialize("messages", [
          new AIMessageChunk({
            id: "a",
            content: "",
            usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          }),
          {}
        ]).data
      )
    ).toBeNull()
  })

  it("retains empty tool results and snapshot tool-argument semantics without content", () => {
    const serialize = createStreamDataSerializer()
    expect(
      persistedMessageFromStreamPayload(
        serialize("messages", [new ToolMessage({ id: "t", tool_call_id: "call", content: "" }), {}])
          .data
      )
    ).toMatchObject({ role: "tool", tool_call_id: "call", content: "" })
    expect(
      persistedMessageFromStreamPayload([
        {
          id: ["AIMessage"],
          kwargs: {
            id: "a",
            tool_call_chunks: [{ id: "call", name: "echo", index: 0, args: "{}" }]
          }
        },
        {}
      ])
    ).toMatchObject({
      streamContentMode: "delta",
      streamToolCallChunks: [{ contentMode: "snapshot" }]
    })
  })
})
