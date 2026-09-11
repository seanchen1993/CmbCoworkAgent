import { describe, expect, it } from "vitest"
import {
  createStreamMessageSideEffectBuffer,
  getPremergedStreamSideEffectReasoning
} from "./stream-message-side-effect-buffer"
import {
  isTraceReasoningTruncated,
  mergeStreamingReasoning,
  truncateReasoningForTrace
} from "../../shared/model-reasoning"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY
} from "../../shared/stream-message-wire-mode"

function aiChunk(
  content: string,
  options: {
    id?: string
    reasoning?: string
    toolCalls?: unknown[]
    metadata?: Record<string, unknown>
  } = {}
): unknown[] {
  return [
    {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: {
        id: options.id ?? "assistant-1",
        content,
        ...(options.reasoning === undefined ? {} : { reasoning_content: options.reasoning }),
        ...(options.toolCalls === undefined ? {} : { tool_calls: options.toolCalls }),
        additional_kwargs: {}
      }
    },
    { langgraph_node: "model", ...options.metadata }
  ]
}

describe("stream message side-effect buffer", () => {
  it("appends repeated reasoning tokens when their protocol is explicitly delta", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    for (const reasoning of ["ha", "ha", "haha"]) {
      buffer.push(
        aiChunk("", {
          reasoning,
          metadata: { [STREAM_MESSAGE_REASONING_MODE_KEY]: "delta" }
        })
      )
    }
    const [payload] = buffer.drain()
    expect(getPremergedStreamSideEffectReasoning(payload)).toBe("hahahaha")
  })

  it("clears explicit reasoning snapshots and continues from the empty prediction", () => {
    const buffer = createStreamMessageSideEffectBuffer({ getReasoningSeed: () => "committed" })
    buffer.push(aiChunk("", { reasoning: "old" }))
    buffer.push(
      aiChunk("", {
        reasoning: "",
        metadata: { [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot" }
      })
    )
    buffer.push(aiChunk("", { reasoning: "fresh" }))
    const drained = buffer.drain()
    expect(getPremergedStreamSideEffectReasoning(drained[1])).toBe("")
    expect(getPremergedStreamSideEffectReasoning(drained[2])).toBe("fresh")
  })

  it("preserves reasoning when a snapshot tag has no reasoning field", () => {
    const buffer = createStreamMessageSideEffectBuffer({ getReasoningSeed: () => "committed" })
    const complete = aiChunk("", {
      metadata: { [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot" }
    })
    ;(complete[0] as { id: string[] }).id = ["langchain_core", "messages", "AIMessage"]
    buffer.push(complete)
    buffer.push(aiChunk("", { reasoning: "-tail" }))
    const drained = buffer.drain()
    expect(getPremergedStreamSideEffectReasoning(drained[0])).toBeUndefined()
    expect(getPremergedStreamSideEffectReasoning(drained[1])).toBe("committed-tail")
  })

  it("attaches exact reasoning to unmerged snapshot and tool lifecycle payloads", () => {
    const buffer = createStreamMessageSideEffectBuffer({ getReasoningSeed: () => "committed" })
    const rewrite = aiChunk("replacement", {
      reasoning: "revised",
      metadata: {
        [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot",
        [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot"
      }
    })
    const tool = aiChunk("", {
      reasoning: "",
      metadata: { [STREAM_MESSAGE_REASONING_MODE_KEY]: "snapshot" },
      toolCalls: [{ id: "call-1", name: "read_file", args: {} }]
    })
    buffer.push(rewrite)
    buffer.push(tool)
    const drained = buffer.drain()
    expect(drained).toEqual([rewrite, tool])
    expect(drained[0]).toBe(rewrite)
    expect(drained[1]).toBe(tool)
    expect(getPremergedStreamSideEffectReasoning(drained[0])).toBe("revised")
    expect(getPremergedStreamSideEffectReasoning(drained[1])).toBe("")
  })

  it("collapses a very long ordinary token stream into one terminal item", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    for (let index = 0; index < 100_000; index += 1) buffer.push(aiChunk("x"))

    expect(buffer.pendingItemCount).toBe(1)
    expect(buffer.retainedFragmentCount).toBeLessThanOrEqual(400)
    const payloads = buffer.drain()
    expect(payloads).toHaveLength(1)
    expect(((payloads[0] as unknown[])[0] as { kwargs: { content: string } }).kwargs.content).toBe(
      "x".repeat(100_000)
    )
    expect(buffer.pendingItemCount).toBe(0)
    expect(buffer.retainedFragmentCount).toBe(0)
  })

  it("folds reasoning from the committed seed with the original sequential semantics", () => {
    const seed = "reasoning-prefix"
    const chunks = ["-delta", "reasoning-prefix-delta", "-tail"]
    let expected = seed
    for (const chunk of chunks) {
      expected = isTraceReasoningTruncated(expected)
        ? expected
        : truncateReasoningForTrace(mergeStreamingReasoning(expected, chunk), 2_000)
    }

    const buffer = createStreamMessageSideEffectBuffer({
      getReasoningSeed: () => seed,
      reasoningLimit: 2_000
    })
    for (const chunk of chunks) buffer.push(aiChunk("", { reasoning: chunk }))
    const [payload] = buffer.drain()

    expect(getPremergedStreamSideEffectReasoning(payload)).toBe(expected)
  })

  it("keeps structural and identity boundaries in FIFO order", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    const first = aiChunk("a")
    const tool = aiChunk("", {
      toolCalls: [{ id: "call-1", name: "task", args: { description: "work" } }]
    })
    const second = aiChunk("b", { id: "assistant-2" })

    buffer.push(first)
    buffer.push(tool)
    buffer.push(second)

    expect(buffer.pendingItemCount).toBe(3)
    const drained = buffer.drain()
    expect(drained[1]).toBe(tool)
    expect(
      drained.map((payload) => ((payload as unknown[])[0] as { kwargs: { id: string } }).kwargs.id)
    ).toEqual(["assistant-1", "assistant-1", "assistant-2"])
  })

  it("collapses streamed tool argument fragments until the final tool boundary", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    for (let index = 0; index < 100_000; index += 1) {
      const payload = aiChunk("")
      ;(payload[0] as { kwargs: Record<string, unknown> }).kwargs.tool_call_chunks = [
        { index: 0, args: "x" }
      ]
      buffer.push(payload)
    }
    const finalToolCall = aiChunk("", {
      toolCalls: [{ id: "call-1", name: "write_file", args: { content: "done" } }]
    })
    buffer.push(finalToolCall)

    expect(buffer.pendingItemCount).toBe(2)
    const drained = buffer.drain()
    expect(drained).toHaveLength(2)
    expect(drained[1]).toBe(finalToolCall)
  })

  it("collapses plain serialized text blocks without accepting structural content", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    for (let index = 0; index < 10_000; index += 1) {
      const payload = aiChunk("")
      ;(payload[0] as { kwargs: Record<string, unknown> }).kwargs.content = [
        { type: "text", text: "x" }
      ]
      buffer.push(payload)
    }
    const structural = aiChunk("")
    ;(structural[0] as { kwargs: Record<string, unknown> }).kwargs.content = [
      { type: "tool_use", id: "call-1" }
    ]
    buffer.push(structural)

    expect(buffer.pendingItemCount).toBe(2)
    const drained = buffer.drain()
    expect(((drained[0] as unknown[])[0] as { kwargs: { content: string } }).kwargs.content).toBe(
      "x".repeat(10_000)
    )
    expect(drained[1]).toBe(structural)
  })

  it("keeps reasoning prediction exact across an unmerged structural boundary", () => {
    const seed = "seed"
    const buffer = createStreamMessageSideEffectBuffer({ getReasoningSeed: () => seed })
    buffer.push(aiChunk("", { reasoning: "-a" }))
    buffer.push(
      aiChunk("", {
        reasoning: "-b",
        toolCalls: [{ id: "call-1", name: "read_file", args: { path: "a.ts" } }]
      })
    )
    buffer.push(aiChunk("", { reasoning: "-c", metadata: { phase: "after-tool" } }))

    let expected = seed
    for (const reasoning of ["-a", "-b", "-c"]) {
      expected = truncateReasoningForTrace(mergeStreamingReasoning(expected, reasoning), 2_000)
    }
    const drained = buffer.drain()
    expect(drained).toHaveLength(3)
    expect(getPremergedStreamSideEffectReasoning(drained[2])).toBe(expected)
  })

  it("discards an uncommitted attempt without materializing it", () => {
    const buffer = createStreamMessageSideEffectBuffer()
    buffer.push(aiChunk("discarded"))
    buffer.clear()
    expect(buffer.pendingItemCount).toBe(0)
    expect(buffer.drain()).toEqual([])
  })
})
