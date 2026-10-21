import { afterEach, describe, expect, it, vi } from "vitest"
import { waitForAsyncEvidence } from "../support/async-evidence"

afterEach(() => vi.useRealTimers())

describe("read-only asynchronous acceptance evidence", () => {
  it("keeps polling resolved false Promises instead of treating the Promise as success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const read = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    let settled = false
    const pending = waitForAsyncEvidence(read, (value) => value === true, "actual true", 500)
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(read).toHaveBeenCalledTimes(2)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it("returns the exact terminal response that satisfied acceptance without reading again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const terminal = { id: "owned-job", state: "succeeded", result: "actual terminal evidence" }
    const read = vi
      .fn()
      .mockResolvedValueOnce({ id: "owned-job", state: "running" })
      .mockResolvedValueOnce(terminal)
      .mockResolvedValue({ id: "other-job", state: "failed" })
    const pending = waitForAsyncEvidence(
      read,
      (value) => value.state === "succeeded",
      "terminal",
      500
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toBe(terminal)
    expect(read).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("propagates read failures without retry and bounds a hanging read by the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const failure = Error("IPC_READ_FAILED")
    const failing = vi.fn().mockRejectedValue(failure)
    await expect(waitForAsyncEvidence(failing, Boolean, "failed read", 500)).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(500)
    expect(failing).toHaveBeenCalledTimes(1)
    const hanging = vi.fn(() => new Promise<never>(() => {}))
    const accept = vi.fn(() => true)
    const timeout = expect(
      waitForAsyncEvidence(hanging, accept, "hanging read", 50)
    ).rejects.toThrow("Timeout: hanging read")
    await vi.advanceTimersByTimeAsync(50)
    await timeout
    expect(hanging).toHaveBeenCalledTimes(1)
    expect(accept).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
