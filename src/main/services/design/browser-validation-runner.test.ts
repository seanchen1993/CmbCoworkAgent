import { afterEach, expect, it, vi } from "vitest"
import {
  runBoundedDesignValidation,
  validateDesignBrowserWithRetry,
  isDesignValidationRepairable
} from "./browser-validation-runner"
import type {
  DesignBrowserValidationResult,
  DesignBrowserValidationIssue
} from "./browser-validation-feedback"

afterEach(() => vi.useRealTimers())
const never = () => new Promise<void>(() => undefined)

it.each(["load", "inspect"] as const)(
  "bounds a stalled %s phase and closes the browser",
  async (phase) => {
    vi.useFakeTimers()
    const close = vi.fn(),
      issues: DesignBrowserValidationIssue[] = []
    const result = runBoundedDesignValidation({
      load: phase === "load" ? never : async () => undefined,
      inspect: phase === "inspect" ? never : async () => undefined,
      close,
      issues,
      signal: new AbortController().signal,
      timeoutMs: 20
    })
    await vi.advanceTimersByTimeAsync(21)
    expect((await result).issues[0]).toMatchObject({ type: "timeout" })
    expect((await result).issues[0].message).toContain(phase === "load" ? "加载页面" : "检查页面")
    expect(close).toHaveBeenCalledOnce()
  }
)

it("cancels a pending JS probe and closes its browser immediately", async () => {
  const controller = new AbortController(),
    close = vi.fn()
  const result = runBoundedDesignValidation({
    load: async () => undefined,
    inspect: never,
    close,
    issues: [],
    signal: controller.signal
  })
  await Promise.resolve()
  const rejection = expect(result).rejects.toThrow()
  controller.abort()
  await rejection
  expect(close).toHaveBeenCalledOnce()
})

it("does not start probes if a timed-out load resolves after its browser has closed", async () => {
  vi.useFakeTimers()
  let finishLoad!: () => void
  const inspect = vi.fn(async () => undefined)
  const result = runBoundedDesignValidation({
    load: () =>
      new Promise<void>((resolve) => {
        finishLoad = resolve
      }),
    inspect,
    close: vi.fn(),
    issues: [],
    signal: new AbortController().signal,
    timeoutMs: 20
  })
  await vi.advanceTimersByTimeAsync(21)
  await result
  finishLoad()
  await Promise.resolve()
  expect(inspect).not.toHaveBeenCalled()
})

it("rechecks an environment failure once and does not route it to model repair", async () => {
  const failure: DesignBrowserValidationResult = {
    ok: false,
    issues: [{ type: "load", message: "network unavailable" }]
  }
  const validate = vi.fn(async () => failure),
    onRetry = vi.fn()
  const result = await validateDesignBrowserWithRetry(
    validate,
    new AbortController().signal,
    onRetry
  )
  expect(validate).toHaveBeenCalledTimes(2)
  expect(onRetry).toHaveBeenCalledOnce()
  expect(isDesignValidationRepairable(result)).toBe(false)
})

it("accepts a successful environment recheck and skips retries for concrete code failures", async () => {
  const success = { ok: true, issues: [] }
  const validate = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, issues: [{ type: "crash", message: "renderer gone" }] })
    .mockResolvedValueOnce(success)
  expect(await validateDesignBrowserWithRetry(validate, new AbortController().signal)).toBe(success)
  for (const type of ["console", "structure", "style", "interaction"] as const) {
    const code = { ok: false, issues: [{ type, message: "known code failure" }] }
    const check = vi.fn(async () => code)
    expect(await validateDesignBrowserWithRetry(check, new AbortController().signal)).toBe(code)
    expect(check).toHaveBeenCalledOnce()
    expect(isDesignValidationRepairable(code)).toBe(true)
  }
})

it("does not reopen a browser after cancellation", async () => {
  const controller = new AbortController()
  const validate = vi.fn(async () => {
    controller.abort()
    return { ok: false, issues: [{ type: "timeout" as const, message: "timed out" }] }
  })
  await expect(validateDesignBrowserWithRetry(validate, controller.signal)).rejects.toThrow("取消")
  expect(validate).toHaveBeenCalledOnce()
})
