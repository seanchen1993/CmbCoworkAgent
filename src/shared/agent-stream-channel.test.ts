import { describe, expect, it } from "vitest"
import {
  classifyAgentStreamDelivery,
  resolveAgentStreamRequestChannel
} from "./agent-stream-channel"

describe("agent stream request channel", () => {
  it("isolates a request from other streams on the same thread", () => {
    expect(resolveAgentStreamRequestChannel("agent:stream:thread-1", "request:1")).toBe(
      "agent:stream:thread-1:request:request%3A1"
    )
  })

  it("keeps legacy callers on the ambient channel", () => {
    expect(resolveAgentStreamRequestChannel("agent:stream:thread-1", undefined)).toBe(
      "agent:stream:thread-1"
    )
    expect(resolveAgentStreamRequestChannel("agent:stream:thread-1", "  ")).toBe(
      "agent:stream:thread-1"
    )
  })

  it.each([
    ["request", "messages", "deliver"],
    ["request", "done", "deliver-and-close"],
    ["request", "error", "deliver-and-close"],
    ["ambient", "custom", "deliver"],
    ["ambient", "done", "ignore"],
    ["ambient", "error", "ignore"]
  ] as const)("routes %s %s events as %s", (source, eventType, expected) => {
    expect(classifyAgentStreamDelivery(source, eventType)).toBe(expected)
  })
})
