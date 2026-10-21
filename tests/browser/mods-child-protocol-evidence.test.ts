import { describe, expect, it, vi } from "vitest"
import { waitForChildProbe } from "../support/mods-child-protocol-evidence"

const request = (tool_call_id?: string, content = "[mods-child-worker] inspect") => ({
  messages: [
    { role: "user", content },
    ...(tool_call_id ? [{ role: "tool", content: "actual result", tool_call_id }] : [])
  ]
})

describe("actual child provider phase evidence", () => {
  it("ignores earlier turns and waits for each new real phase without repeating actions", async () => {
    const requests: unknown[] = [request("mods-child-inspect")]
    const stages = [request(), request("mods-child-search"), request("mods-child-inspect")]
    const until = vi.fn(async (read: () => Promise<boolean>) => {
      expect(await read()).toBe(false)
      requests.push(stages.shift())
      expect(await read()).toBe(true)
    })
    await waitForChildProbe(requests, 1, until)
    expect(until).toHaveBeenCalledTimes(3)
    expect(stages).toEqual([])
  })

  it("accepts an actually completed eager or original native probe without inventing discovery", async () => {
    const until = vi.fn(async (read: () => Promise<boolean>) => expect(await read()).toBe(true))
    await waitForChildProbe([request("mods-child-inspect")], 0, until)
    expect(until).toHaveBeenCalledTimes(3)
  })

  it("does not borrow parent history and preserves the original bounded wait failure", async () => {
    const failure = Error("actual first provider step timed out")
    const until = vi.fn(async (read: () => Promise<boolean>) => {
      expect(await read()).toBe(false)
      throw failure
    })
    await expect(waitForChildProbe([
      request("mods-child-inspect", "[mods-child] parent request")
    ], 0, until)).rejects.toBe(failure)
    expect(until).toHaveBeenCalledTimes(1)
  })

  it("requires an actual tool result rather than a matching label on an assistant message", async () => {
    const failure = Error("no actual tool result")
    let stage = 0
    const until = vi.fn(async (read: () => Promise<boolean>) => {
      if (++stage === 1) return expect(await read()).toBe(true)
      expect(await read()).toBe(false)
      throw failure
    })
    await expect(waitForChildProbe([{
      messages: [
        { role: "user", content: "[mods-child-worker] inspect" },
        { role: "assistant", tool_call_id: "mods-child-inspect" }
      ]
    }], 0, until)).rejects.toBe(failure)
    expect(until).toHaveBeenCalledTimes(2)
  })
})
