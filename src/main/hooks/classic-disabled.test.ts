import { beforeEach, expect, it, vi } from "vitest"
import type { HookConfig, HookResult } from "./types"

const state = vi.hoisted(() => ({ present: true, enabled: false }))
const bridge = vi.hoisted(() => vi.fn())
const execute = vi.hoisted(() => vi.fn())
vi.mock("../mods/manager", () => ({
  getModsManager: () =>
    state.present ? { isEnabled: () => state.enabled, classicEvent: bridge } : undefined
}))
vi.mock("./http-runner", () => ({ executeHttpHook: execute }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))

import { clearOnceStateForSession, runHooks } from "./runner"

const context = { workspacePath: "/project", sessionId: "disabled-classic", toolName: "read_file" }
const success: HookResult = { exitCode: 0, stdout: "", stderr: "", blocked: false }
const hook: HookConfig = {
  id: "native-policy",
  event: "PreToolUse",
  type: "http",
  url: "http://127.0.0.1/policy",
  enabled: true,
  createdAt: "",
  updatedAt: ""
}

beforeEach(() => {
  state.present = true
  state.enabled = false
  bridge
    .mockReset()
    .mockImplementation((_workspace, _thread, _event, input, signal, core) => core(input, signal))
  execute.mockReset().mockResolvedValue(success)
  clearOnceStateForSession(context.sessionId)
})

it("keeps native hook results and callbacks identical when Mods is disabled or absent", async () => {
  execute.mockResolvedValue({
    ...success,
    stdout: JSON.stringify({
      systemMessage: "Native policy notice",
      hookSpecificOutput: { permissionDecision: "allow", updatedInput: { file_path: "safe.txt" } }
    })
  })
  const absentCallback = vi.fn()
  state.present = false
  const absent = await runHooks([hook], "PreToolUse", context, absentCallback)
  state.present = true
  const disabledCallback = vi.fn()
  const disabled = await runHooks([hook], "PreToolUse", context, disabledCallback)
  expect(disabled).toEqual(absent)
  expect(disabledCallback).toHaveBeenCalledTimes(1)
  expect(absentCallback).toHaveBeenCalledTimes(1)
  // Each actual invocation has its own elapsed time; compare all semantic fields.
  const normalize = (calls: unknown[][]) =>
    calls.map(([event, config, result]) => [
      event,
      config,
      { ...(result as HookResult), durationMs: 0 }
    ])
  expect(normalize(disabledCallback.mock.calls)).toEqual(normalize(absentCallback.mock.calls))
  expect(execute).toHaveBeenCalledTimes(2)
  expect(bridge).not.toHaveBeenCalled()
})

it("does not project guest input when disabled and observes the next enable immediately", async () => {
  const args = vi.fn(() => ({ file_path: "native.txt" }))
  const input = {
    ...context,
    get toolArgs() {
      return args()
    }
  }
  expect(await runHooks([], "PreToolUse", input)).toBeNull()
  expect(args).not.toHaveBeenCalled()
  expect(bridge).not.toHaveBeenCalled()
  state.enabled = true
  bridge.mockResolvedValue({ deny: "enabled guest gate" })
  expect(await runHooks([], "PreToolUse", input)).toMatchObject({
    blocked: true,
    reason: "enabled guest gate"
  })
  expect(bridge).toHaveBeenCalledTimes(1)
})

it.each(["cancel", "session replacement"])(
  "rejects a disabled native result after %s",
  async (mode) => {
    const controller = new AbortController()
    let finish!: (value: HookResult) => void
    execute.mockReturnValue(
      new Promise<HookResult>((resolve) => {
        finish = resolve
      })
    )
    const pending = runHooks([hook], "PreToolUse", { ...context, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
    if (mode === "cancel") controller.abort(new Error("cancel disabled hook"))
    else clearOnceStateForSession(context.sessionId)
    finish(success)
    await rejected
    expect(bridge).not.toHaveBeenCalled()
  }
)

it("does not execute a native hook when already cancelled", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancel before hook"))
  await expect(
    runHooks([hook], "PreToolUse", {
      ...context,
      signal: controller.signal
    })
  ).rejects.toThrow("cancel before hook")
  expect(execute).not.toHaveBeenCalled()
})
