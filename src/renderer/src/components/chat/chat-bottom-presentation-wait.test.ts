import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatBottomPresentationWait } from "./chat-bottom-presentation-wait"

afterEach(() => vi.useRealTimers())

describe("bottom presentation waiting", () => {
  it("does not spend geometry frames or renew its deadline on content progress", () => {
    vi.useFakeTimers()
    const wait = new ChatBottomPresentationWait()
    const expired = vi.fn()
    wait.park("thread:1:initial", expired)
    for (let event = 0; event < 9; event++) {
      vi.advanceTimersByTime(500)
      wait.park("thread:1:initial", expired)
    }
    expect(expired).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(500)
    expect(expired).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels the deadline instead of firing a stale intent after clear", () => {
    vi.useFakeTimers()
    const wait = new ChatBottomPresentationWait()
    const expired = vi.fn()
    wait.park("initial", expired)
    vi.advanceTimersByTime(1000)
    wait.clear()
    vi.advanceTimersByTime(5000)
    expect(expired).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never lets a superseded generation expire the current intent", () => {
    vi.useFakeTimers()
    const wait = new ChatBottomPresentationWait()
    const oldIntent = vi.fn(), currentIntent = vi.fn()
    wait.park("thread:1:initial", oldIntent)
    vi.advanceTimersByTime(3000)
    wait.park("thread:2:return", currentIntent)
    vi.advanceTimersByTime(2000)
    expect(oldIntent).not.toHaveBeenCalled()
    expect(currentIntent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3000)
    expect(currentIntent).toHaveBeenCalledOnce()
  })
})
