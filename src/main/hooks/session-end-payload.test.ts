import { expect, it, vi } from "vitest"
import type { HookConfig } from "./types"

const execute = vi.hoisted(() => vi.fn())
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => false }) }))
vi.mock("./http-runner", () => ({ executeHttpHook: execute }))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: false }),
  getUserInfo: () => undefined
}))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
import { runHooks } from "./runner"

it.each(["clear", "logout", undefined] as const)(
  "preserves the actual SessionEnd reason %s in the original script/HTTP input",
  async (reason) => {
    execute.mockClear()
    execute.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
    const hook: HookConfig = {
      id: "original-exit",
      event: "SessionEnd",
      type: "http",
      url: "http://unused.invalid",
      enabled: true,
      createdAt: "",
      updatedAt: ""
    }
    await runHooks([hook], "SessionEnd", {
      sessionId: "real-thread",
      workspacePath: "/workspace",
      sessionEndReason: reason
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(execute.mock.calls[0][1]))).toMatchObject({
      hook_event_name: "SessionEnd",
      session_id: "real-thread",
      reason: reason ?? "other"
    })
  }
)

it("does not add an ending reason to adjacent original hook inputs", async () => {
  execute.mockClear()
  execute.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  await runHooks(
    [
      {
        id: "original-stop",
        event: "Stop",
        type: "http",
        url: "http://unused.invalid",
        enabled: true,
        createdAt: "",
        updatedAt: ""
      }
    ],
    "Stop",
    { sessionId: "other-thread", sessionEndReason: "clear" }
  )
  expect(execute).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(execute.mock.calls[0][1]))).not.toHaveProperty("reason")
})
