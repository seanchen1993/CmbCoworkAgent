import { performance } from "node:perf_hooks"
import { setImmediate as immediate } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nativeConversationFairness } from "./native-conversation-fairness"

afterEach(() => { vi.restoreAllMocks() })

describe("native conversation phase fairness", () => {
  it("keeps fast ordinary phases in the current event-loop turn", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0)
    let serviced = false
    const current = vi.fn()
    const yieldPhase = nativeConversationFairness(new AbortController().signal, current)
    const pending = immediate().then(() => { serviced = true })
    try {
      await yieldPhase()
      await yieldPhase()
      expect(serviced).toBe(false)
      expect(current).not.toHaveBeenCalled()
    } finally { await pending }
  })

  it("forces a phase boundary even when its elapsed budget is zero", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0)
    let serviced = false
    const current = vi.fn()
    const yieldPhase = nativeConversationFairness(undefined, current)
    const pending = immediate().then(() => { serviced = true })
    try {
      await yieldPhase(true)
      expect(serviced).toBe(true)
      expect(current).toHaveBeenCalledTimes(2)
    } finally { await pending }
  })
})
