import { describe, expect, it } from "vitest"
import type { IPCEvent, StreamEvent } from "../../../types"
import { ElectronIPCTransport, transformSerializedValuesMessages,
  type SerializedMessageChunk } from "./electron-transport"

function tool(stampOverrides: Record<string, unknown> = {}): SerializedMessageChunk {
  return { id: ["langchain_core", "messages", "ToolMessage"], kwargs: {
    id: "actual-uuid", content: "public tool result", tool_call_id: "actual-call",
    name: "ActualTool", status: "error", is_error: false,
    additional_kwargs: { function_row: { conversationId: "conversation", branchId: "branch",
      uuid: "actual-uuid", sequence: 1, messageType: "user", door: "tool-result",
      origin: { kind: "tool", tool: "ActualTool" }, ...stampOverrides } }
  } }
}

function live(message: SerializedMessageChunk): Record<string, unknown> {
  const transport = new ElectronIPCTransport() as unknown as {
    convertToSDKEvents(event: IPCEvent, threadId: string): StreamEvent[]
  }
  const events = transport.convertToSDKEvents({ type: "stream", mode: "messages",
    data: [message, { langgraph_node: "tools" }] }, "presentation-test")
  const event = events.find(item => item.event === "messages")
  if (!event || !Array.isArray(event.data) || !event.data[0])
    throw Error("ACTUAL_TOOL_EVENT_REQUIRED")
  return event.data[0] as Record<string, unknown>
}

describe("actual renderer tool presentation routes", () => {
  it("preserves Tool System provenance in real live and values conversion", () => {
    const message: SerializedMessageChunk = { id: ["langchain_core", "messages", "SystemMessage"],
      kwargs: { id: "actual-system", content: "Goal 已暂停 /goal resume", additional_kwargs: {
        function_row: { conversationId: "conversation", branchId: "branch", uuid: "actual-system",
          sequence: 3, messageType: "system", door: "tool-message",
          origin: { kind: "tool", tool: "actual_original_tool" } }
      } } }
    expect(live(message)).toMatchObject({ id: "actual-system", type: "system",
      content: "Goal 已暂停 /goal resume", function_row: { messageType: "system",
        door: "tool-message", origin: { kind: "tool", tool: "actual_original_tool" } } })
    expect(transformSerializedValuesMessages([message])).toMatchObject([
      { id: "actual-system", type: "system", function_row: { uuid: "actual-system" } }
    ])
  })
  it("keeps explicit false through both live messages and durable values", () => {
    const message = tool()
    const shown = live(message)
    expect(shown).toMatchObject({ id: "actual-uuid", type: "tool", is_error: false,
      status: "error", tool_call_id: "actual-call", function_row: { uuid: "actual-uuid" } })
    expect(transformSerializedValuesMessages([message])).toMatchObject([
      { id: "actual-uuid", type: "tool", is_error: false, status: "error",
        tool_call_id: "actual-call", function_row: { uuid: "actual-uuid" } }
    ])
  })

  it.each([{ uuid: "other" }, { messageType: "assistant" }, { door: "response" },
    { sequence: 0 }])("retains execution error display for invalid tool provenance %j", stamp => {
    const message = tool(stamp)
    expect(live(message).is_error).toBe(true)
    expect(transformSerializedValuesMessages([message])[0].is_error).toBe(true)
  })

  it("preserves the original unmarked and damaged-marker rules", () => {
    const message = tool()
    if (!message.kwargs) throw Error("ACTUAL_TOOL_KWARGS_REQUIRED")
    message.kwargs.additional_kwargs = {}
    expect(live(message).is_error).toBe(true)
    expect(transformSerializedValuesMessages([message])[0].is_error).toBe(true)
    const damaged = tool()
    Object.assign(damaged.kwargs!.additional_kwargs!, { function_row_invalid: false })
    expect(live(damaged).is_error).toBe(true)
    message.kwargs.status = "success"
    message.kwargs.is_error = undefined
    expect(live(message)).not.toHaveProperty("is_error")
    expect(transformSerializedValuesMessages([message])[0]).not.toHaveProperty("is_error")
  })
})
