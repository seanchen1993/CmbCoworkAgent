import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import {
  createSerializedValuesMessageAccumulator,
  createStreamDataSerializer,
  serializeStreamData
} from "./stream-data-serialization"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY,
  STREAM_TOOL_CALL_ARGS_MODE_KEY,
  type StreamMessageWireMode
} from "../../shared/stream-message-wire-mode"
import { createStreamMessageSideEffectBuffer } from "./stream-message-side-effect-buffer"

interface WireMessage {
  kwargs: {
    content: string
    additional_kwargs: { reasoning_content: string }
    tool_call_chunks: Array<{
      args: string
      [STREAM_TOOL_CALL_ARGS_MODE_KEY]: StreamMessageWireMode
    }>
  }
}
type WireTuple = [WireMessage, Record<string, unknown>]
const cumulative = { content: "snapshot", reasoning: "snapshot", tool_args: "snapshot" } as const

function textTuple(content: string, reasoning = content, args = content): unknown[] {
  return [
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: {
        id: "assistant",
        content,
        additional_kwargs: { reasoning_content: reasoning },
        tool_call_chunks: [{ id: "call", index: 0, name: "write_file", args }]
      }
    },
    {}
  ]
}

describe("stream protocol integrity", () => {
  it("honors independent content, reasoning, and per-tool protocols without mutating input", () => {
    const serialize = createStreamDataSerializer({ messageChunkModes: cumulative })
    const contents: string[] = []
    let reasoning = ""
    let args = ""
    const steps = ["one", "one two", "replacement", "replacement tail", "", "fresh"]
    for (const value of steps) {
      const source = textTuple("ha", value, value)
      source[1] = { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "delta" }
      const before = JSON.stringify(source)
      const [message, metadata] = serialize("messages", source).data as WireTuple
      contents.push(message.kwargs.content)
      reasoning =
        metadata[STREAM_MESSAGE_REASONING_MODE_KEY] === "snapshot"
          ? message.kwargs.additional_kwargs.reasoning_content
          : reasoning + message.kwargs.additional_kwargs.reasoning_content
      const toolChunk = message.kwargs.tool_call_chunks[0]
      args =
        toolChunk[STREAM_TOOL_CALL_ARGS_MODE_KEY] === "snapshot"
          ? toolChunk.args
          : args + toolChunk.args
      expect(reasoning).toBe(value)
      expect(args).toBe(value)
      expect(JSON.stringify(source)).toBe(before)
    }
    expect(contents.join("")).toBe("ha".repeat(steps.length))
  })

  it("lets interleaved tools declare different modes inside the same message", () => {
    const serialize = createStreamDataSerializer({ messageChunkModes: { tool_args: "snapshot" } })
    const received = ["", ""]
    for (const [index, part] of ['{"v":"', "ha", "ha", '"}'].entries()) {
      const source = textTuple("") as [{ kwargs: { tool_call_chunks: unknown[] } }, unknown]
      source[0].kwargs.tool_call_chunks = [
        { id: "delta", index: 0, args: part, [STREAM_TOOL_CALL_ARGS_MODE_KEY]: "delta" },
        { id: "snapshot", index: 1, args: JSON.stringify({ step: index }) }
      ]
      const [message] = serialize("messages", source).data as WireTuple
      message.kwargs.tool_call_chunks.forEach((chunk, slot) => {
        received[slot] =
          chunk[STREAM_TOOL_CALL_ARGS_MODE_KEY] === "snapshot"
            ? chunk.args
            : received[slot] + chunk.args
      })
      expect(JSON.parse(received[1])).toEqual({ step: index })
    }
    expect(JSON.parse(received[0])).toEqual({ v: "haha" })
  })

  it("preserves unsampled corrections in content, reasoning and tool arguments", () => {
    const serialize = createStreamDataSerializer({ messageChunkModes: cumulative })
    const first = "a".repeat(400)
    const second = first + "b".repeat(400)
    const corrected = second.slice(0, 100) + "Z" + second.slice(101) + "end"
    const received = ["", "", ""]
    for (const value of [first, second, corrected, corrected + "tail"]) {
      const [message, metadata] = serialize("messages", textTuple(value)).data as WireTuple
      const fields = [
        [message.kwargs.content, metadata[STREAM_MESSAGE_CONTENT_MODE_KEY]],
        [
          message.kwargs.additional_kwargs.reasoning_content,
          metadata[STREAM_MESSAGE_REASONING_MODE_KEY]
        ],
        [
          message.kwargs.tool_call_chunks[0].args,
          message.kwargs.tool_call_chunks[0][STREAM_TOOL_CALL_ARGS_MODE_KEY]
        ]
      ]
      fields.forEach(([text, mode], index) => {
        received[index] = mode === "snapshot" ? String(text) : received[index] + text
      })
      expect(received).toEqual([value, value, value])
    }
  })

  it("delivers repeated initial tokens to the Stop/Goal side-effect input intact", () => {
    const serialize = createStreamDataSerializer()
    const buffer = createStreamMessageSideEffectBuffer()
    for (const content of ["哈", "哈", "，你好"]) {
      buffer.push(serialize("messages", [new AIMessageChunk({ id: "repeat", content }), {}]).data)
    }
    const output = buffer.drain() as Array<[{ kwargs: { content: string } }]>
    expect(output.map(([message]) => message.kwargs.content).join("")).toBe("哈哈，你好")
  })

  it("handles delta, complete message, and explicit snapshot boundaries without sampling", () => {
    const serialize = createStreamDataSerializer()
    let actual = ""
    const frames: Array<[unknown, unknown]> = [
      [new AIMessageChunk({ id: "a", content: "a" }), {}],
      [new AIMessageChunk({ id: "a", content: "ab" }), {}],
      [
        new AIMessageChunk({ id: "a", content: "rewritten" }),
        { [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot" }
      ],
      [new AIMessageChunk({ id: "a", content: "!" }), {}],
      [new AIMessage({ id: "a", content: "rewritten!!" }), {}]
    ]
    const expected = ["a", "aab", "rewritten", "rewritten!", "rewritten!!"]
    frames.forEach((frame, index) => {
      const [message, metadata] = serialize("messages", frame).data as WireTuple
      actual =
        metadata[STREAM_MESSAGE_CONTENT_MODE_KEY] === "snapshot"
          ? message.kwargs.content
          : actual + message.kwargs.content
      expect(actual).toBe(expected[index])
    })
  })

  it("does no prefix comparisons for 10,000 standard delta chunks", () => {
    let comparisons = 0
    let outputCharacters = 0
    const serialize = createStreamDataSerializer({
      onMessageProjection: (observation) => {
        comparisons += observation.comparedCharacters
        outputCharacters += observation.outputCharacters
      }
    })
    const started = performance.now()
    for (let index = 0; index < 10_000; index += 1) serialize("messages", textTuple("repeated"))
    expect(comparisons).toBe(0)
    expect(outputCharacters).toBe(10_000 * 3 * "repeated".length)
    console.log(
      JSON.stringify({
        scenario: "10000 explicit delta frames",
        elapsedMs: performance.now() - started,
        comparisons
      })
    )
  })
})

describe("values snapshot correctness", () => {
  it("matches complete serialization through deterministic edits, reorders, removals and new turns", () => {
    const serialize = createStreamDataSerializer()
    const accumulator = createSerializedValuesMessageAccumulator()
    let messages = [
      new HumanMessage({ id: "initial-user", content: "initial" }),
      ...Array.from(
        { length: 100 },
        (_, index) =>
          new ToolMessage({ id: `tool-${index}`, tool_call_id: `call-${index}`, content: "old" })
      ),
      new AIMessage({ id: "tail", content: "answer" })
    ]
    let seed = 12345
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let step = 0; step < 300; step += 1) {
      const next = step % 2 ? messages.slice() : messages
      const slot = random() % next.length
      switch (step % 6) {
        case 0:
          next[slot] = new ToolMessage({
            id: `update-${step}`,
            tool_call_id: `call-${step}`,
            content: `corrected-${step}`
          })
          break
        case 1:
          next.push(new AIMessage({ id: `a-${step}`, content: "appended" }))
          break
        case 2:
          ;[next[slot], next[next.length - 1]] = [next[next.length - 1], next[slot]]
          break
        case 3:
          if (next.length > 2) next.splice(slot, 1)
          break
        case 4:
          next.push(new HumanMessage({ id: `user-${step}`, content: "continue" }))
          break
        case 5:
          next[next.length - 1] = new AIMessage({ id: `tail-${step}`, content: "new answer" })
          break
      }
      messages = next
      const expected = serializeStreamData("values", { messages })
      const actual = accumulator.update(serialize("values", { messages }))
      expect(actual, `snapshot ${step}`).toEqual({
        messages: (expected.data as { messages: unknown[] }).messages,
        valuesMessageIndexOffset: expected.valuesMessageIndexOffset
      })
    }
  })
})
