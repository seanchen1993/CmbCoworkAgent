import { describe, expect, it } from "vitest"
import type { IPCEvent, StreamEvent } from "../../../types"
import { buildMessageSameRoleDuplicateId } from "../../../shared/message-role-collision"
import { ElectronIPCTransport } from "./electron-transport"

function createTransport() {
  const transport = new ElectronIPCTransport()
  const convert = (event: IPCEvent): StreamEvent[] =>
    (
      transport as unknown as {
        convertToSDKEvents(event: IPCEvent, threadId: string): StreamEvent[]
      }
    ).convertToSDKEvents(event, "discard-test")
  return convert
}

function serialized(type: string, id: string, content = "history") {
  return { id: ["langchain_core", "messages", type], kwargs: { id, content } }
}

function reasoning(id?: string, occurrence?: number): IPCEvent {
  return {
    type: "stream",
    mode: "messages",
    data: [
      {
        id: ["langchain_core", "messages", "AIMessageChunk"],
        kwargs: {
          ...(id ? { id } : {}),
          content: "",
          additional_kwargs: {
            reasoning_content: "thinking",
            ...(occurrence
              ? {
                  cmb_internal_provider_source_id: id,
                  cmb_internal_provider_occurrence: occurrence
                }
              : {})
          }
        }
      },
      { langgraph_node: "agent" }
    ]
  }
}

function messageId(events: StreamEvent[]): string {
  const event = events.find((event) => event.event === "messages")
  expect(event).toBeDefined()
  return (event!.data as [{ id: string }])[0].id
}

function reset(
  convert: ReturnType<typeof createTransport>,
  ids: string[],
  messages: ReturnType<typeof serialized>[] = []
): string[] {
  const events = convert({
    type: "custom",
    data: { type: "stream_retry_reset", discardedMessageIds: ids, messages }
  })
  const event = events.find((event) => event.event === "custom")
  return (event!.data as { discardedMessageIds: string[] }).discardedMessageIds
}

describe("retry discard IDs delivered through the IPC converter", () => {
  it("includes renderer fallback IDs absent from the main-process reset", () => {
    const convert = createTransport()
    const firstId = messageId(convert(reasoning()))
    expect(firstId).toMatch(/^values:/)
    expect(reset(convert, [])).toEqual([firstId])
    expect(messageId(convert(reasoning()))).toBe(firstId)
  })

  for (const useCanonicalId of [false, true]) {
    it(`resolves ${useCanonicalId ? "canonical" : "raw"} IDs without discarding same-name history`, () => {
      const convert = createTransport()
      const history = [serialized("HumanMessage", "shared")]
      convert({
        type: "custom",
        data: {
          type: "current_run_user_injected",
          messages: [{ id: "shared", content: "history" }]
        }
      })
      const liveId = messageId(convert(reasoning("shared")))
      expect(liveId).not.toBe("shared")
      expect(reset(convert, [useCanonicalId ? liveId : "shared"], history)).toEqual([liveId])
    })
  }

  it("discards only the current occurrence when the provider ID is reused", () => {
    const convert = createTransport()
    const history = [
      serialized("AIMessage", "provider"),
      serialized("AIMessage", buildMessageSameRoleDuplicateId("provider", "assistant", 2))
    ]
    reset(convert, [], history)
    const liveId = messageId(convert(reasoning("provider", 3)))
    expect(liveId).toBe(buildMessageSameRoleDuplicateId("provider", "assistant", 3))
    expect(reset(convert, ["provider"], history)).toEqual([liveId])
  })

  it("preserves a checkpointed system message sharing the failed assistant source ID", () => {
    const convert = createTransport()
    const history = [serialized("SystemMessage", "shared")]
    reset(convert, [], history)
    const liveId = messageId(convert(reasoning("shared")))
    expect(liveId).not.toBe("shared")
    expect(reset(convert, ["shared"], history)).toEqual([liveId])
  })

  it("retains a failed assistant ID when same-name system history was never streamed", () => {
    const convert = createTransport()
    const liveId = messageId(convert(reasoning("shared")))
    expect(liveId).toBe("shared")
    expect(reset(convert, [liveId], [serialized("SystemMessage", "shared")])).toEqual([liveId])
  })

  for (const type of ["SystemMessage", "ToolMessage"]) {
    it(`retains a failed ${type} ID when same-name assistant history was never streamed`, () => {
      const convert = createTransport()
      const liveId = messageId(
        convert({
          type: "stream",
          mode: "messages",
          data: [
            {
              ...serialized(type, "shared", "failed output"),
              kwargs: {
                id: "shared",
                content: "failed output",
                ...(type === "ToolMessage" ? { tool_call_id: "call", name: "read_file" } : {})
              }
            },
            { langgraph_node: "agent" }
          ]
        })
      )
      expect(liveId).toBe("shared")
      expect(reset(convert, [liveId], [serialized("AIMessage", "shared")])).toEqual([liveId])
    })
  }

  it("includes both alias identities while preserving earlier provider occurrences", () => {
    const convert = createTransport()
    const history = [serialized("AIMessage", "provider")]
    reset(convert, [], history)
    const liveId = messageId(convert(reasoning("provider", 2)))
    const stableId = "current-run-assistant:retry"
    convert({
      type: "custom",
      data: {
        type: "message_id_alias",
        fromId: liveId,
        toId: stableId,
        role: "assistant",
        currentRunCompleted: true,
        providerSourceId: "provider",
        providerOccurrence: 2
      }
    })
    const discarded = reset(convert, [stableId], history)
    expect(new Set(discarded)).toEqual(new Set([liveId, stableId]))
    expect(discarded).not.toContain("provider")
  })

  for (const resetId of ["live", "canonical"]) {
    it(`expands a values-adopted alias when reset names its ${resetId} identity`, () => {
      const convert = createTransport()
      const liveId = messageId(convert(reasoning("live")))
      const events = convert({
        type: "stream",
        mode: "values",
        data: { messages: [serialized("AIMessage", "canonical", "final answer")] }
      })
      expect(
        events.some(
          (event) =>
            event.event === "custom" &&
            (event.data as { type?: string }).type === "message_id_alias"
        )
      ).toBe(true)
      expect(new Set(reset(convert, [resetId]))).toEqual(new Set([liveId, "canonical"]))
    })
  }
})
