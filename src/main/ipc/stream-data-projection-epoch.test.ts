import { AIMessage, AIMessageChunk } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { createStreamDataSerializer } from "./stream-data-serialization"
import { StreamAssistantText } from "./stream-assistant-text"
import { readStreamTranscriptReasoning } from "./stream-transcript-flush"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY as contentMode,
  STREAM_MESSAGE_REASONING_MODE_KEY as reasoningMode,
  STREAM_TOOL_CALL_ARGS_MODE_KEY as argsMode
} from "../../shared/stream-message-wire-mode"

function cumulativeTuple(text: string): [Record<string, unknown>, Record<string, unknown>] {
  return [
    {
      id: ["AIMessageChunk"],
      kwargs: {
        id: "a",
        content: text,
        additional_kwargs: { reasoning_content: text },
        tool_call_chunks: [{ id: "call", index: 0, args: text }]
      }
    },
    {}
  ]
}

type WireTuple = [
  {
    kwargs: {
      content: string
      additional_kwargs: { reasoning_content: string }
      tool_call_chunks: Array<{ args: string; [argsMode]: string }>
    }
  },
  Record<string, unknown>
]

describe("message projection after values snapshots", () => {
  it.each(["AIMessage", "AIMessageChunk"])(
    "preserves first explicit empty snapshots from %s",
    (className) => {
      const serialize = createStreamDataSerializer({
        messageChunkModes: {
          content: "snapshot",
          reasoning: "snapshot",
          tool_args: "snapshot"
        }
      })
      const source = cumulativeTuple("")
      source[0].id = [className]
      const tuple = serialize("messages", source).data as WireTuple
      const [message, metadata] = tuple
      expect(metadata[contentMode]).toBe("snapshot")
      expect(metadata[reasoningMode]).toBe("snapshot")
      expect(message.kwargs.tool_call_chunks[0][argsMode]).toBe("snapshot")
      expect(readStreamTranscriptReasoning(tuple, "delta")).toEqual({
        reasoning: "",
        reasoning_mode: "snapshot"
      })
    }
  )

  it("does not synthesize missing fields in complete messages or clear on default empty deltas", () => {
    const serialize = createStreamDataSerializer()
    const missing = serialize("messages", [
      { id: ["AIMessage"], kwargs: { id: "a", additional_kwargs: {} } },
      {}
    ]).data as WireTuple
    expect(missing[1][contentMode]).toBeUndefined()
    expect(missing[1][reasoningMode]).toBeUndefined()
    expect(readStreamTranscriptReasoning(missing, "snapshot")).toEqual({})
    const emptyDelta = serialize("messages", [new AIMessageChunk({ id: "a", content: "" }), {}])
      .data as WireTuple
    expect(emptyDelta[1][contentMode]).toBeUndefined()
    expect(readStreamTranscriptReasoning(emptyDelta, "delta")).toEqual({})
  })

  it.each([false, true])(
    "rebases complete messages after values, with intervening delta=%s",
    (withDelta) => {
      const serialize = createStreamDataSerializer()
      const text = new StreamAssistantText()
      text.processMessage(
        serialize("messages", [new AIMessageChunk({ id: "a", content: "draft" }), {}]).data
      )
      const values = serialize("values", {
        messages: [new AIMessage({ id: "a", content: "draft final" })]
      })
      text.applySnapshot((values.data as { messages: unknown[] }).messages[0])
      if (withDelta) {
        const delta = serialize("messages", [
          new AIMessageChunk({ id: "a", content: " final" }),
          {}
        ]).data
        expect((delta as WireTuple)[1][contentMode]).toBe("delta")
        text.processMessage(delta)
      }
      const full = serialize("messages", [
        new AIMessage({ id: "a", content: "draft final final!" }),
        {}
      ]).data
      expect((full as WireTuple)[1][contentMode]).toBe("snapshot")
      text.processMessage(full)
      expect(text.text).toBe("draft final final!")
    }
  )

  it("invalidates all three cumulative field baselines without changing input", () => {
    const serialize = createStreamDataSerializer({
      messageChunkModes: {
        content: "snapshot",
        reasoning: "snapshot",
        tool_args: "snapshot"
      }
    })
    serialize("messages", cumulativeTuple("old"))
    serialize("values", { messages: [new AIMessage({ id: "a", content: "old extended" })] })
    const source = cumulativeTuple("old extended!")
    const before = JSON.stringify(source)
    const [message, metadata] = serialize("messages", source).data as WireTuple
    expect(JSON.stringify(source)).toBe(before)
    expect(metadata[contentMode]).toBe("snapshot")
    expect(metadata[reasoningMode]).toBe("snapshot")
    expect(message.kwargs.tool_call_chunks[0][argsMode]).toBe("snapshot")
    expect(message.kwargs.content).toBe("old extended!")
    expect(message.kwargs.additional_kwargs.reasoning_content).toBe("old extended!")
    expect(message.kwargs.tool_call_chunks[0].args).toBe("old extended!")
    const [next, nextMetadata] = serialize("messages", cumulativeTuple("old extended!!"))
      .data as WireTuple
    expect(nextMetadata[contentMode]).toBe("delta")
    expect(nextMetadata[reasoningMode]).toBe("delta")
    expect(next.kwargs.tool_call_chunks[0][argsMode]).toBe("delta")
    expect(next.kwargs.content).toBe("!")
  })

  it("keeps absent fields stale when only content establishes a new snapshot baseline", () => {
    const serialize = createStreamDataSerializer({
      messageChunkModes: {
        content: "snapshot",
        reasoning: "snapshot",
        tool_args: "snapshot"
      }
    })
    serialize("messages", cumulativeTuple("old"))
    serialize("values", { messages: [] })
    serialize("messages", [new AIMessageChunk({ id: "a", content: "old!" }), {}])
    const [message, metadata] = serialize("messages", cumulativeTuple("old!!")).data as WireTuple
    expect(metadata[contentMode]).toBe("delta")
    expect(message.kwargs.content).toBe("!")
    expect(metadata[reasoningMode]).toBe("snapshot")
    expect(message.kwargs.additional_kwargs.reasoning_content).toBe("old!!")
    expect(message.kwargs.tool_call_chunks[0][argsMode]).toBe("snapshot")
  })

  it("does not invalidate projection for metadata-only or failed values serialization", () => {
    const serialize = createStreamDataSerializer({ messageChunkModes: { content: "snapshot" } })
    serialize("messages", cumulativeTuple("old"))
    serialize("values", { phase: "metadata-only" })
    expect(() => serialize("values", { messages: [], bad: 1n })).toThrow()
    const [message, metadata] = serialize("messages", cumulativeTuple("old!")).data as WireTuple
    expect(metadata[contentMode]).toBe("delta")
    expect(message.kwargs.content).toBe("!")
  })

  it("sends a full first snapshot for a message scope first seen after values", () => {
    const serialize = createStreamDataSerializer()
    serialize("values", { messages: [new AIMessage({ id: "a", content: "old" })] })
    serialize("messages", [
      new AIMessageChunk({ id: "a", content: "old" }),
      { checkpoint_ns: "node" }
    ])
    const [message, metadata] = serialize("messages", [
      new AIMessage({ id: "a", content: "old!" }),
      { checkpoint_ns: "node" }
    ]).data as WireTuple
    expect(metadata[contentMode]).toBe("snapshot")
    expect(message.kwargs.content).toBe("old!")
  })
})
