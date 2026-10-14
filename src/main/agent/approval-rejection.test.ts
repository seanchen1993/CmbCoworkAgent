import { expect, it, vi } from "vitest"
import { notifyExplicitToolRejection } from "./approval-rejection"

it.each(["parent cancellation", "child stream failure"])(
  "does not turn %s cleanup into an explicit rejection of the parent Flow",
  (message) => {
    const parent = new AbortController()
    const child = new AbortController()
    const cause = Error(message)
    child.abort(cause)
    const reject = vi.fn(() => parent.abort(Error("FLOW_TOOL_REJECTED")))
    notifyExplicitToolRejection({ type: "reject", tool_call_id: "pending" }, child.signal, reject)
    expect(reject).not.toHaveBeenCalled()
    expect(parent.signal.aborted).toBe(false)
    expect(child.signal.reason).toBe(cause)
  }
)

it("still stops the live Flow immediately after a real user rejection", () => {
  const parent = new AbortController()
  const child = new AbortController()
  const signal = AbortSignal.any([parent.signal, child.signal])
  const cause = Error("FLOW_TOOL_REJECTED")
  const reject = vi.fn(() => parent.abort(cause))
  expect(() =>
    notifyExplicitToolRejection({ type: "reject", tool_call_id: "pending" }, signal, reject)
  ).toThrow(cause)
  expect(reject).toHaveBeenCalledWith("approval-rejected")
  expect(parent.signal.reason).toBe(cause)
})

it.each(["approve", "approve_session", "approve_permanent"] as const)(
  "does not reject an accepted decision: %s",
  (type) => {
    const reject = vi.fn()
    notifyExplicitToolRejection({ type, tool_call_id: "pending" }, undefined, reject)
    expect(reject).not.toHaveBeenCalled()
  }
)
