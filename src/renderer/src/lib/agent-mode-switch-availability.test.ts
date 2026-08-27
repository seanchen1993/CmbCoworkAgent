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
        historyMessageTotal: 0,
        residentMessageCount: 0
      })
    ).toBe(false)
  })

  it("rejects a virtualized empty resident window when durable messages exist", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: false,
        historyMessageTotal: 12,
        residentMessageCount: 0
      })
    ).toBe(false)
  })

  it("allows switching only for a loaded, durably empty thread", () => {
    expect(
      canChangeThreadAgentMode({
        historyLoading: false,
        historyMessageTotal: 0,
        residentMessageCount: 0
      })
    ).toBe(true)
  })
})
