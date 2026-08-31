import { describe, expect, it } from "vitest"
import { canChangeThreadAgentMode } from "./agent-mode-switch-availability"

describe("thread agent mode switch availability", () => {
  it("fails closed before thread history state is available", () => {
    expect(canChangeThreadAgentMode(undefined)).toBe(false)
  })

  it("fails closed while durable history is loading", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: true,
        conversationPresence: "empty",
        residentMessageCount: 0
      })
    ).toBe(false)
  })

  it("rejects a virtualized thread with a confirmed conversation", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: false,
        conversationPresence: "nonempty",
        residentMessageCount: 0
      })
    ).toBe(false)
  })

  it("rejects a thread whose conversation presence is not known yet", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: false,
        conversationPresence: "unknown",
        residentMessageCount: 0
      })
    ).toBe(false)
  })

  it("allows switching only for a loaded, durably empty thread", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: false,
        conversationPresence: "empty",
        residentMessageCount: 0
      })
    ).toBe(true)
  })
})
