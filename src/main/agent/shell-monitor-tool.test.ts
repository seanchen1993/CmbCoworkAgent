import { getEventListeners } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { HOOK_AGENT_OWNER_METADATA_KEY, runWithHookAgentId } from "../hooks/execution-context"
import { HookHaltError } from "../hooks/halt"
import { createShellTaskMonitorTools, SHELL_TASK_OWNER_CONFIG_KEY } from "./shell-monitor-tool"
import { ShellTaskMonitor, type ShellTaskSnapshot } from "./shell-task-monitor"

type Backend = Parameters<typeof createShellTaskMonitorTools>[0]

const completed: ShellTaskSnapshot = {
  completed: true,
  output: "finished",
  elapsedSeconds: 2,
  exitCode: 0
}

const running: ShellTaskSnapshot = {
  completed: false,
  elapsedSeconds: 1,
  command: "example",
  partialOutput: "partial",
  partialTruncated: true,
  idleSeconds: 0
}

function createBackend() {
  return {
    getTaskOutput: vi.fn<Backend["getTaskOutput"]>().mockReturnValue(running),
    waitForTaskOutput: vi
      .fn<Backend["waitForTaskOutput"]>()
      .mockResolvedValue({ status: "completed", result: completed }),
    runPreToolUseHookForTool: vi.fn<Backend["runPreToolUseHookForTool"]>().mockResolvedValue(null),
    applyPostToolUseHookToText: vi
      .fn<Backend["applyPostToolUseHookToText"]>()
      .mockImplementation(async (_name, _args, output) => output)
  }
}

describe("shell monitor tools", () => {
  it("shares hooks and results while keeping the compatibility wait default", async () => {
    const backend = createBackend()
    const [monitor, taskOutput] = createShellTaskMonitorTools(backend)
    const input = { task_id: "task" }

    await expect(monitor.invoke(input)).resolves.toBe(
      "finished\n[Command succeeded with exit code 0, elapsed: 2s]"
    )
    await expect(taskOutput.invoke(input)).resolves.toBe(
      "finished\n[Command succeeded with exit code 0, elapsed: 2s]"
    )
    expect(backend.waitForTaskOutput.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([
      undefined,
      30_000
    ])
    expect(backend.runPreToolUseHookForTool.mock.calls).toEqual([
      ["task_output", input],
      ["task_output", input]
    ])
    expect(backend.applyPostToolUseHookToText.mock.calls.map(([name]) => name)).toEqual([
      "task_output",
      "task_output"
    ])
    expect(backend.getTaskOutput).not.toHaveBeenCalled()
  })

  it("preserves snapshot and timeout results and forwards the caller's owner", async () => {
    const backend = createBackend()
    backend.waitForTaskOutput.mockResolvedValue({ status: "timeout", result: running })
    const [monitor, taskOutput] = createShellTaskMonitorTools(backend)
    const snapshot = await monitor.invoke(
      { task_id: "task", block: false },
      { configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "child-a" } }
    )
    const timeout = await runWithHookAgentId("child-b", () =>
      taskOutput.invoke({ task_id: "task", timeout: 0 })
    )

    expect(JSON.parse(snapshot)).toEqual({
      retrieval_status: "not_ready",
      elapsed: 1,
      command: "example",
      partialOutput: "partial",
      partialTruncated: true,
      idleSeconds: 0
    })
    expect(JSON.parse(timeout)).toMatchObject({ retrieval_status: "timeout" })
    expect(backend.getTaskOutput).toHaveBeenCalledExactlyOnceWith("task", "child-a")
    expect(backend.waitForTaskOutput).toHaveBeenCalledExactlyOnceWith("task", {
      ownerId: "child-b",
      timeoutMs: 0,
      signal: undefined
    })
  })

  it("checks hook-updated task IDs through the same owner boundary", async () => {
    const backend = createBackend()
    backend.runPreToolUseHookForTool.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      updatedInput: { task_id: "other-task", ownerId: "other-child", timeout: 9_000_000 }
    })
    backend.waitForTaskOutput.mockResolvedValue({ status: "missing" })
    const [monitor] = createShellTaskMonitorTools(backend)

    await expect(
      monitor.invoke(
        { task_id: "my-task" },
        { configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "my-child" } }
      )
    ).resolves.toBe('Error: No background task found with id "other-task".')
    expect(backend.waitForTaskOutput).toHaveBeenCalledExactlyOnceWith("other-task", {
      ownerId: "my-child",
      timeoutMs: 600_000,
      signal: undefined
    })
  })

  it("prefers the internal child invocation owner over provider tool-call attribution", async () => {
    const backend = createBackend()
    const [monitor] = createShellTaskMonitorTools(backend)

    await runWithHookAgentId("parent", () =>
      monitor.invoke(
        { task_id: "task", block: false },
        {
          configurable: {
            [SHELL_TASK_OWNER_CONFIG_KEY]: { id: "child-invocation" },
            [HOOK_AGENT_OWNER_METADATA_KEY]: "provider-reused-id"
          }
        }
      )
    )
    expect(backend.getTaskOutput).toHaveBeenCalledExactlyOnceWith("task", "child-invocation")
  })

  it("enforces a legacy pre-hook block and propagates a legacy post-hook halt", async () => {
    const backend = createBackend()
    const [monitor] = createShellTaskMonitorTools(backend)
    backend.runPreToolUseHookForTool.mockResolvedValueOnce({
      exitCode: 2,
      stdout: "blocked",
      stderr: "",
      blocked: true
    })
    await expect(monitor.invoke({ task_id: "task" })).resolves.toBe("[Hook blocked] blocked")
    expect(backend.waitForTaskOutput).not.toHaveBeenCalled()

    const halt = new HookHaltError({ hookEvent: "PostToolUse", fallbackReason: "stop" })
    backend.applyPostToolUseHookToText.mockRejectedValueOnce(halt)
    await expect(monitor.invoke({ task_id: "task" })).rejects.toBe(halt)
  })

  it("disposes tool subscriptions when LangChain aborts, leaving other callers active", async () => {
    const backend = createBackend()
    const events = new ShellTaskMonitor()
    const waiting = Promise.withResolvers<void>()
    backend.waitForTaskOutput.mockImplementation(async (_, options) => {
      const result = events.wait(options)
      waiting.resolve()
      if ((await result) === "aborted") return { status: "aborted" }
      return { status: "completed", result: completed }
    })
    const [monitor] = createShellTaskMonitorTools(backend)
    const controller = new AbortController()
    const remaining = events.wait()
    const invocation = monitor.invoke({ task_id: "task" }, { signal: controller.signal })
    const rejected = expect(invocation).rejects.toThrow()
    await waiting.promise
    expect(backend.waitForTaskOutput.mock.calls[0]?.[1]?.signal).toBe(controller.signal)

    controller.abort()
    await rejected
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    expect(backend.applyPostToolUseHookToText).not.toHaveBeenCalled()

    events.publish()
    await expect(remaining).resolves.toBe("completed")
  })
})
