import { describe, expect, it } from "vitest"
import { canChangeThreadWorkspace } from "./workspace-switch-availability"

describe("workspace switch availability", () => {
  it("fails closed before a thread state exists", () => {
    expect(canChangeThreadWorkspace(undefined)).toBe(false)
  })

  it("fails closed while durable history is loading even if resident messages are empty", () => {
    expect(
      canChangeThreadWorkspace({ historyLoading: true, historyMessageTotal: 0, messages: [] })
    ).toBe(false)
  })

  it("fails closed when virtualization released every resident message", () => {
    expect(
      canChangeThreadWorkspace({ historyLoading: false, historyMessageTotal: 250, messages: [] })
    ).toBe(false)
  })

  it("opens only after an empty thread has completed history loading", () => {
    expect(
      canChangeThreadWorkspace({ historyLoading: false, historyMessageTotal: 0, messages: [] })
    ).toBe(true)
    expect(
      canChangeThreadWorkspace({ historyLoading: false, historyMessageTotal: 1, messages: [{}] })
    ).toBe(false)
  })
})
