import { afterEach, expect, it, vi } from "vitest"
import { modCallContext, type ModCallContext } from "../mods/context"
import { FunctionDispatchDeadline } from "../mods/v2/dispatch-deadline"
import { FUNCTION_TRUSTED_WAIT_LIMIT_MS } from "../mods/v2/trusted-function-wait"
import { withNativeApprovalWait } from "./native-approval-wait"

afterEach(() => vi.useRealTimers())

function dialog(signal: AbortSignal) {
  let answer!: (value: string) => void
  const removed = vi.fn()
  const promise = new Promise<string>((resolve) => { answer = resolve })
  const abort = () => { removed(); answer("cancelled") }
  signal.addEventListener("abort", abort, { once: true })
  return { answer, removed, promise: promise.finally(() => signal.removeEventListener("abort", abort)) }
}

function operation(signal: AbortSignal, threadId = "thread"): ModCallContext {
  return {
    identity: { workspace: "/workspace", threadId, turnId: "turn", agentId: "main",
      callId: "call", modId: "function:test", grantEpoch: 1, origin: "model" },
    signal, toolId: "host:write_file", routeClaimed: false, protectedOutput: false, readOnly: false
  }
}

it("keeps a native approval alive beyond 120 seconds and resumes the same operation", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "hrtime"] })
  const deadline = new FunctionDispatchDeadline(120000, undefined, undefined, true)
  let pending!: ReturnType<typeof dialog>
  try {
    const run = deadline.run(() => deadline.wait(withNativeApprovalWait("thread", undefined,
      signal => { pending = dialog(signal); return pending.promise })))
    await vi.advanceTimersByTimeAsync(180000)
    expect(deadline.signal.aborted).toBe(false)
    expect(pending.removed).not.toHaveBeenCalled()
    pending.answer("approved")
    expect(await run).toBe("approved")
    // Only human waiting is credited: active execution is still bounded.
    await vi.advanceTimersByTimeAsync(120000)
    expect(deadline.signal.aborted).toBe(true)
  } finally { deadline.close() }
})

it("clears the dialog on local operation cancellation while the enclosing turn remains live", async () => {
  const turn = new AbortController(), local = new AbortController()
  let pending!: ReturnType<typeof dialog>
  const run = modCallContext.run(operation(local.signal), () =>
    withNativeApprovalWait("thread", turn.signal,
      signal => { pending = dialog(signal); return pending.promise }))
  local.abort(Error("operation cancelled"))
  await expect(run).rejects.toThrow("operation cancelled")
  expect(turn.signal.aborted).toBe(false)
  expect(pending.removed).toHaveBeenCalledOnce()
  pending.answer("approved")
  await expect(run).rejects.toThrow("operation cancelled")
})

it("does not borrow a different thread's operation signal", async () => {
  const other = new AbortController()
  other.abort()
  await expect(modCallContext.run(operation(other.signal, "other"), () =>
    withNativeApprovalWait("thread", undefined, async signal => {
      expect(signal.aborted).toBe(false)
      return "approved"
    }))).resolves.toBe("approved")
})

it("removes the dialog when the trusted human-wait allowance expires", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "hrtime"] })
  const deadline = new FunctionDispatchDeadline(120000, undefined, undefined, true)
  let pending!: ReturnType<typeof dialog>
  try {
    const run = deadline.run(() => deadline.wait(withNativeApprovalWait("thread", undefined,
      signal => { pending = dialog(signal); return pending.promise })))
    const rejected = expect(run).rejects.toThrow("MODS_TRUSTED_WAIT_EXPIRED")
    await vi.advanceTimersByTimeAsync(FUNCTION_TRUSTED_WAIT_LIMIT_MS)
    await rejected
    expect(pending.removed).toHaveBeenCalledOnce()
    pending.answer("approved")
  } finally { deadline.close() }
})

it("preserves inherited hard deadlines and removes their approval dialogs", async () => {
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout", "hrtime"] })
  const deadline = new FunctionDispatchDeadline(100)
  let pending!: ReturnType<typeof dialog>
  try {
    const run = modCallContext.run(operation(deadline.signal), () => deadline.run(() =>
      deadline.wait(withNativeApprovalWait("thread", undefined,
        signal => { pending = dialog(signal); return pending.promise }))))
    const rejected = expect(run).rejects.toThrow("总等待期限")
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(pending.removed).toHaveBeenCalledOnce()
  } finally { deadline.close() }
})
