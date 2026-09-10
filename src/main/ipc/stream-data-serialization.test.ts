import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import {
  createStreamDataSerializer,
  createSerializedValuesMessageAccumulator,
  sanitizeStreamDataForRenderer,
  serializeStreamData
} from "./stream-data-serialization"
import {
  STREAM_MESSAGE_CONTENT_MODE_KEY,
  STREAM_MESSAGE_REASONING_MODE_KEY,
  STREAM_TOOL_CALL_ARGS_MODE_KEY
} from "../../shared/stream-message-wire-mode"

describe("stream data serialization", () => {
  it("projects values history before JSON serialization and preserves absolute indexes", () => {
    let historyPrefixVisited = false
    const poisonedHistoryMessage = {
      type: "ai",
      toJSON(): never {
        historyPrefixVisited = true
        throw new Error("historical message must not be serialized")
      }
    }
    Object.defineProperty(poisonedHistoryMessage, "unusedLargePayload", {
      enumerable: true,
      get(): never {
        historyPrefixVisited = true
        throw new Error("historical payload must not be read")
      }
    })

    const currentAssistant = new AIMessage({
      id: "current-assistant",
      content: "current answer",
      additional_kwargs: { retained: true }
    })
    const payload = {
      skillsMetadata: [{ name: "current-skill", path: "C:/skills/current/SKILL.md" }],
      messages: [
        poisonedHistoryMessage,
        new HumanMessage("old prompt"),
        new AIMessage("old answer"),
        new HumanMessage("current prompt"),
        currentAssistant,
        new ToolMessage({
          id: "current-tool",
          content: "tool result",
          tool_call_id: "call-current"
        })
      ]
    }

    const serialized = serializeStreamData("values", payload)

    expect(historyPrefixVisited).toBe(false)
    expect(serialized.valuesMessageIndexOffset).toBe(3)
    expect(serialized.valuesSnapshotKind).toBe("full")
    expect(serialized.data).toMatchObject({
      skillsMetadata: [{ name: "current-skill" }],
      messages: [
        { id: expect.arrayContaining(["HumanMessage"]), kwargs: { content: "current prompt" } },
        {
          id: expect.arrayContaining(["AIMessage"]),
          kwargs: {
            id: "current-assistant",
            content: "current answer",
            additional_kwargs: { retained: true }
          }
        },
        {
          id: expect.arrayContaining(["ToolMessage"]),
          kwargs: { id: "current-tool", content: "tool result", tool_call_id: "call-current" }
        }
      ]
    })

    const rendererData = sanitizeStreamDataForRenderer(
      "values",
      serialized.data,
      serialized.valuesMessageIndexOffset
    ) as { messages: Array<{ kwargs?: { additional_kwargs?: Record<string, unknown> } }> }

    expect(rendererData.messages).toHaveLength(2)
    expect(rendererData.messages[0]?.kwargs?.additional_kwargs).toMatchObject({
      retained: true,
      cmb_worker_snapshot_index: 4
    })
    expect(rendererData.messages[1]?.kwargs?.additional_kwargs).toMatchObject({
      cmb_worker_snapshot_index: 5
    })
    expect(currentAssistant.additional_kwargs).toEqual({ retained: true })
  })

  it("keeps non-values payload serialization unchanged", () => {
    const payload = [new AIMessage("delta"), { langgraph_node: "agent" }]
    const serialized = serializeStreamData("messages", payload)

    expect(serialized.valuesMessageIndexOffset).toBe(0)
    expect(serialized.valuesSnapshotKind).toBe("full")
    expect(serialized.data).toMatchObject([
      { id: expect.arrayContaining(["AIMessage"]), kwargs: { content: "delta" } },
      { langgraph_node: "agent" }
    ])
  })

  it("preserves tool_calls-only AI chunks when there are no argument chunks to project", () => {
    const serializeForRun = createStreamDataSerializer()
    const serialized = serializeForRun("messages", [
      new AIMessageChunk({
        id: "complete-tool-only",
        content: "",
        tool_calls: [
          {
            id: "complete-tool-call",
            name: "read_file",
            args: { file_path: "README.md" },
            type: "tool_call"
          }
        ]
      }),
      { langgraph_node: "agent" }
    ])
    const kwargs = (serialized.data as [{ kwargs: Record<string, unknown> }])[0].kwargs
    expect(kwargs.tool_calls).toEqual([
      expect.objectContaining({
        id: "complete-tool-call",
        name: "read_file",
        args: { file_path: "README.md" }
      })
    ])
  })

  it("serializes immutable append and assistant-tail frames without visiting the stable turn", () => {
    let poisonStableMessages = false
    const message = (
      className: "HumanMessage" | "AIMessage",
      id: string,
      content: string,
      toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
    ) => {
      const value = {
        id: ["langchain_core", "messages", className],
        type: className === "HumanMessage" ? "human" : "ai",
        kwargs: {
          id,
          content,
          additional_kwargs: {},
          ...(toolCalls ? { tool_calls: toolCalls } : {})
        },
        toJSON(): unknown {
          if (poisonStableMessages && (id === "turn-user" || id.startsWith("stable-"))) {
            throw new Error(`stable message ${id} was serialized`)
          }
          return { id: value.id, type: value.type, kwargs: value.kwargs }
        }
      }
      return value
    }

    const stableTurn = [message("HumanMessage", "turn-user", "prompt")]
    for (let index = 0; index < 10_000; index += 1) {
      stableTurn.push(message("AIMessage", `stable-${index}`, `answer-${index}`))
    }
    const serializeForRun = createStreamDataSerializer()
    const initial = serializeForRun("values", { messages: stableTurn, todos: [] })
    expect(initial.valuesSnapshotKind).toBe("full")

    poisonStableMessages = true
    const appendedTail = message("AIMessage", "live-tail", "a")
    const appended = serializeForRun("values", {
      messages: [...stableTurn, appendedTail],
      todos: []
    })
    expect(appended.valuesSnapshotKind).toBe("append")
    expect(appended.valuesMessageIndexOffset).toBe(stableTurn.length)
    expect((appended.data as { messages: unknown[] }).messages).toHaveLength(1)

    const grownTail = message("AIMessage", "live-tail", "answer complete")
    const tail = serializeForRun("values", {
      messages: [...stableTurn, grownTail],
      todos: []
    })
    expect(tail.valuesSnapshotKind).toBe("tail")
    expect(tail.valuesMessageIndexOffset).toBe(stableTurn.length)
    expect((tail.data as { messages: unknown[] }).messages).toHaveLength(1)

    poisonStableMessages = false
    const taskAppend = serializeForRun("values", {
      messages: [
        ...stableTurn,
        grownTail,
        message("AIMessage", "task-call", "", [
          { id: "task-1", name: "task", args: { description: "inspect" } }
        ])
      ]
    })
    expect(taskAppend.valuesSnapshotKind).toBe("append")
    expect(taskAppend.valuesMessageIndexOffset).toBe(stableTurn.length + 1)
    expect((taskAppend.data as { messages: unknown[] }).messages).toHaveLength(1)
  })

  it("falls back when assistant tail identity or content is not monotonic", () => {
    const serializeForRun = createStreamDataSerializer()
    const user = new HumanMessage({ id: "user", content: "prompt" })
    serializeForRun("values", {
      messages: [user, new AIMessage({ id: "assistant", content: "long answer" })]
    })

    const replacement = serializeForRun("values", {
      messages: [user, new AIMessage({ id: "assistant", content: "rewritten" })]
    })
    expect(replacement.valuesSnapshotKind).toBe("full")

    const newIdentity = serializeForRun("values", {
      messages: [user, new AIMessage({ id: "different", content: "rewritten plus" })]
    })
    expect(newIdentity.valuesSnapshotKind).toBe("full")
  })

  it("reconstructs one mutable complete turn from full, append, and tail payloads", () => {
    const accumulator = createSerializedValuesMessageAccumulator()
    const first = { id: "user" }
    const second = { id: "assistant", content: "a" }
    const initial = accumulator.update({
      data: { messages: [first, second] },
      valuesMessageIndexOffset: 100,
      valuesSnapshotKind: "full"
    })
    const retainedArray = initial.messages

    const appended = accumulator.update({
      data: { messages: [{ id: "tool" }] },
      valuesMessageIndexOffset: 102,
      valuesSnapshotKind: "append"
    })
    expect(appended.messages).toBe(retainedArray)
    expect(appended.messages.map((message) => (message as { id: string }).id)).toEqual([
      "user",
      "assistant",
      "tool"
    ])

    const tail = accumulator.update({
      data: { messages: [{ id: "tool", content: "complete" }] },
      valuesMessageIndexOffset: 102,
      valuesSnapshotKind: "tail"
    })
    expect(tail.messages).toBe(retainedArray)
    expect(tail.messages[2]).toEqual({ id: "tool", content: "complete" })
    expect(tail.valuesMessageIndexOffset).toBe(100)
  })

  it("projects 1,000 cumulative provider frames with linear wire and comparison work", () => {
    let comparedCharacters = 0
    const serializeForRun = createStreamDataSerializer({
      onMessageProjection: (observation) => {
        comparedCharacters += observation.comparedCharacters
      }
    })
    const contentDeltas: string[] = []
    const reasoningDeltas: string[] = []
    const toolArgDeltas: string[] = []
    let cumulativeContent = ""
    let cumulativeReasoning = ""
    let cumulativeToolArgs = ""
    let wireCharacters = 0

    for (let frame = 0; frame < 1_000; frame += 1) {
      cumulativeContent += "c".repeat(120)
      cumulativeReasoning += "r".repeat(120)
      cumulativeToolArgs += frame === 0 ? `{"payload":"${"t".repeat(108)}` : "t".repeat(120)
      if (frame === 999) cumulativeToolArgs += '"}'

      const serialized = serializeForRun("messages", [
        new AIMessageChunk({
          id: "cumulative-main",
          content: cumulativeContent,
          additional_kwargs: { reasoning_content: cumulativeReasoning },
          tool_call_chunks: [
            {
              ...(frame === 0 ? { id: "write-call", name: "write_file" } : {}),
              index: 0,
              args: cumulativeToolArgs,
              type: "tool_call_chunk"
            }
          ]
        }),
        { langgraph_node: "agent" }
      ])
      wireCharacters += JSON.stringify(serialized.data).length
      const [message, metadata] = serialized.data as [
        {
          kwargs: {
            content: string
            additional_kwargs: { reasoning_content: string }
            tool_call_chunks: Array<Record<string, unknown> & { args: string }>
          }
        },
        Record<string, unknown>
      ]
      contentDeltas.push(message.kwargs.content)
      reasoningDeltas.push(message.kwargs.additional_kwargs.reasoning_content)
      toolArgDeltas.push(message.kwargs.tool_call_chunks[0].args)
      expect(message.kwargs).not.toHaveProperty("tool_calls")
      expect(message.kwargs).not.toHaveProperty("invalid_tool_calls")
      expect(metadata[STREAM_MESSAGE_CONTENT_MODE_KEY]).toBe("delta")
      expect(metadata[STREAM_MESSAGE_REASONING_MODE_KEY]).toBe("delta")
      expect(message.kwargs.tool_call_chunks[0][STREAM_TOOL_CALL_ARGS_MODE_KEY]).toBe("delta")
    }

    expect(contentDeltas.join("")).toBe(cumulativeContent)
    expect(reasoningDeltas.join("")).toBe(cumulativeReasoning)
    expect(toolArgDeltas.join("")).toBe(cumulativeToolArgs)
    const finalCharacters =
      cumulativeContent.length + cumulativeReasoning.length + cumulativeToolArgs.length
    expect(wireCharacters).toBeLessThan(finalCharacters * 8)
    expect(comparedCharacters).toBeLessThan(finalCharacters * 2)
  })

  it("preserves delta repeats and falls back to snapshots on cumulative rewrites", () => {
    const serializeForRun = createStreamDataSerializer()
    const frame = (content: string) =>
      serializeForRun("messages", [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "rewrite-main", content, additional_kwargs: {} }
        },
        { langgraph_node: "agent" }
      ]).data as [
        { kwargs: { content: string } },
        Record<string, unknown>
      ]

    expect(frame("prefix-")[0].kwargs.content).toBe("prefix-")
    expect(frame("prefix-growing")[0].kwargs.content).toBe("growing")
    const duplicate = frame("prefix-growing")
    expect(duplicate[0].kwargs.content).toBe("")
    expect(duplicate[1][STREAM_MESSAGE_CONTENT_MODE_KEY]).toBe("delta")

    const rewrite = frame("rewritten-output")
    expect(rewrite[0].kwargs.content).toBe("rewritten-output")
    expect(rewrite[1][STREAM_MESSAGE_CONTENT_MODE_KEY]).toBe("snapshot")
    const continued = frame("rewritten-output-tail")
    expect(continued[0].kwargs.content).toBe("-tail")
    expect(continued[1][STREAM_MESSAGE_CONTENT_MODE_KEY]).toBe("delta")

    const deltaSerializer = createStreamDataSerializer()
    const deltaParts = ["ha", "!", "ha", "ha"]
    const projected = deltaParts.map((content) => {
      const serialized = deltaSerializer("messages", [
        {
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { id: "delta-main", content, additional_kwargs: {} }
        },
        { langgraph_node: "agent" }
      ])
      return (serialized.data as [{ kwargs: { content: string } }])[0].kwargs.content
    })
    expect(projected.join("")).toBe(deltaParts.join(""))
  })
})
