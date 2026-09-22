import { beforeEach, describe, expect, it, vi } from "vitest"
import type { HookConfig, HookResult } from "./types"

vi.mock("./http-runner", () => ({ executeHttpHook: vi.fn() }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))

import { executeHttpHook } from "./http-runner"
import {
  clearOnceStateForHook,
  clearOnceStateForSession,
  resetHookOnceStateForTests,
  runHooks
} from "./runner"

function hook(extra: Partial<HookConfig> = {}): HookConfig {
  return {
    id: "once-check",
    event: "PreToolUse",
    type: "http",
    url: "http://127.0.0.1/check",
    once: true,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...extra
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const success: HookResult = { exitCode: 0, stdout: "", stderr: "", blocked: false }
const failure: HookResult = { exitCode: 1, stdout: "", stderr: "retry", blocked: false }
const context = { sessionId: "once-session", toolName: "read_file" }

beforeEach(() => {
  vi.mocked(executeHttpHook).mockReset()
  resetHookOnceStateForTests()
})

describe("classic once hook execution ownership", () => {
  it("shares the pending check and its blocking outcome between concurrent invocations", async () => {
    const pending = deferred<HookResult>()
    vi.mocked(executeHttpHook).mockReturnValue(pending.promise)
    const first = runHooks([hook()], "PreToolUse", context)
    const second = runHooks([hook()], "PreToolUse", context)
    await vi.waitFor(() => expect(executeHttpHook).toHaveBeenCalledTimes(1))
    pending.resolve({ ...success, stdout: '{"decision":"block","reason":"fix defect"}' })
    const results = await Promise.all([first, second])
    expect(results.every((result) => result?.blocked)).toBe(true)
    expect(await runHooks([hook()], "PreToolUse", context)).toBeNull()
  })

  it("consumes an async once hook only after real success and retries a failed run", async () => {
    const pending = deferred<HookResult>()
    vi.mocked(executeHttpHook).mockReturnValueOnce(pending.promise).mockResolvedValue(success)
    const observed = vi.fn()
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    expect(executeHttpHook).toHaveBeenCalledTimes(1)
    pending.resolve(failure)
    await vi.waitFor(() =>
      expect(
        observed.mock.calls.some(
          (call) => call[2].asyncStatus === "completed" && call[2].exitCode === 1
        )
      ).toBe(true)
    )
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    await vi.waitFor(() => expect(executeHttpHook).toHaveBeenCalledTimes(2))
  })

  it("does not let a previous session completion consume a recreated session's once hook", async () => {
    const old = deferred<HookResult>()
    vi.mocked(executeHttpHook).mockReturnValueOnce(old.promise).mockResolvedValue(success)
    const first = runHooks([hook()], "PreToolUse", context)
    clearOnceStateForSession(context.sessionId)
    old.resolve(success)
    await first
    await runHooks([hook()], "PreToolUse", context)
    expect(executeHttpHook).toHaveBeenCalledTimes(2)
  })

  it("does not let a stale async completion clear a recreated session's pending owner", async () => {
    const old = deferred<HookResult>()
    const fresh = deferred<HookResult>()
    const observed = vi.fn()
    vi.mocked(executeHttpHook).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    await vi.waitFor(() => expect(executeHttpHook).toHaveBeenCalledTimes(1))
    clearOnceStateForSession(context.sessionId)
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    await vi.waitFor(() => expect(executeHttpHook).toHaveBeenCalledTimes(2))
    old.resolve(success)
    await vi.waitFor(() =>
      expect(observed.mock.calls.some((call) => call[2].asyncStatus === "completed")).toBe(true)
    )
    await runHooks([hook({ async: true })], "PreToolUse", context, observed)
    expect(executeHttpHook).toHaveBeenCalledTimes(2)
    fresh.resolve(success)
  })

  it("does not let a cleared hook completion consume its replacement", async () => {
    const old = deferred<HookResult>()
    vi.mocked(executeHttpHook).mockReturnValueOnce(old.promise).mockResolvedValue(success)
    const first = runHooks([hook()], "PreToolUse", context)
    await vi.waitFor(() => expect(executeHttpHook).toHaveBeenCalledTimes(1))
    clearOnceStateForHook("once-check")
    old.resolve(success)
    await first
    await runHooks([hook()], "PreToolUse", context)
    expect(executeHttpHook).toHaveBeenCalledTimes(2)
  })

  it("retains different plugin source identities even when hook ids collide", async () => {
    vi.mocked(executeHttpHook).mockResolvedValue(success)
    await Promise.all(
      ["plugin-a", "plugin-b"].map((hookSourceRoot) =>
        runHooks([hook({ hookSourceRoot })], "PreToolUse", context)
      )
    )
    expect(executeHttpHook).toHaveBeenCalledTimes(2)
  })

  it("executes a duplicated once definition only once within one hook chain", async () => {
    vi.mocked(executeHttpHook).mockResolvedValue(success)
    await runHooks([hook(), hook()], "PreToolUse", context)
    expect(executeHttpHook).toHaveBeenCalledTimes(1)
  })
})
