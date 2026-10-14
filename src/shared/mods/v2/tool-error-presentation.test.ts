import { describe, expect, it } from "vitest"
import { resolveFunctionConversationToolErrorPresentation } from "./tool-error-presentation"

function tool(overrides: Record<string, unknown> = {}, stamp: Record<string, unknown> = {}) {
  return { id: ["langchain_core", "messages", "ToolMessage"], kwargs: {
    id: "actual-uuid", tool_call_id: "actual-call", status: "error", is_error: false,
    additional_kwargs: { function_row: { conversationId: "conversation", branchId: "branch",
      uuid: "actual-uuid", sequence: 1, messageType: "user", door: "tool-result",
      origin: { kind: "tool", tool: "actual-tool" }, ...stamp } }, ...overrides
  } }
}

describe("canonical tool error presentation", () => {
  it("preserves a separate false presentation and its real error execution status", () => {
    const message = tool()
    expect(resolveFunctionConversationToolErrorPresentation(message)).toBe(false)
    expect(message.kwargs.status).toBe("error")
    expect(message.kwargs.tool_call_id).toBe("actual-call")
  })

  it("uses the explicit root value before older additional metadata", () => {
    const message = tool()
    Object.assign(message.kwargs.additional_kwargs, { is_error: true })
    expect(resolveFunctionConversationToolErrorPresentation(message)).toBe(false)
    message.kwargs.is_error = true
    expect(resolveFunctionConversationToolErrorPresentation(message)).toBe(true)
  })

  it("accepts explicit additional presentation for a valid saved tool message", () => {
    const message = tool({ is_error: undefined }, { door: "tool-message" })
    Object.assign(message.kwargs.additional_kwargs, { is_error: false })
    expect(resolveFunctionConversationToolErrorPresentation(message)).toBe(false)
    const hydrated = { ...message.kwargs, function_row: message.kwargs.additional_kwargs.function_row }
    expect(resolveFunctionConversationToolErrorPresentation(hydrated)).toBe(false)
  })

  it.each([
    { uuid: "different" }, { messageType: "assistant" }, { door: "response" },
    { sequence: 0 }, { unknown: true }
  ])("keeps the old error rule for an invalid or mismatched stamp %j", stamp => {
    expect(resolveFunctionConversationToolErrorPresentation(tool({}, stamp))).toBe(true)
  })

  it("keeps damaged and unmarked tools on their original error rule", () => {
    const damaged = tool()
    Object.assign(damaged.kwargs.additional_kwargs, { function_row_invalid: false })
    expect(resolveFunctionConversationToolErrorPresentation(damaged)).toBe(true)
    expect(resolveFunctionConversationToolErrorPresentation({ status: "error", is_error: false }))
      .toBe(true)
    expect(resolveFunctionConversationToolErrorPresentation({ status: "success" })).toBeUndefined()
    expect(resolveFunctionConversationToolErrorPresentation({ is_error: true })).toBe(true)
  })

  it("does not evaluate an accessor as an explicit presentation", () => {
    const message = tool({ is_error: undefined })
    let reads = 0
    Object.defineProperty(message.kwargs, "is_error", { get() { reads++; return false } })
    expect(resolveFunctionConversationToolErrorPresentation(message)).toBe(true)
    expect(reads).toBe(0)
  })
})
