import { describe, expect, it, vi } from "vitest"
import { assertThreadDeletionWorkspace, isThreadDeletionBusy } from "./thread-deletion-busy"

function idleRuntime() {
  return {
    hasActiveRun: vi.fn(() => false),
    isAborting: vi.fn(() => false),
    waitForSettlement: vi.fn(async () => "settled"),
    hasExternalRun: vi.fn(() => false),
    hasWorkflowRun: vi.fn(() => false),
    hasWorkerRun: vi.fn(() => false)
  }
}

describe("deletion runtime guard", () => {
  it.each([undefined, null, "", "  ", 123])(
    "rejects unknown workspace %s before destructive teardown",
    (path) => {
      for (const mode of ["workflow", "coordinator"] as const) {
        expect(() => assertThreadDeletionWorkspace(mode, path)).toThrow("缺少工作区路径")
      }
      expect(() => assertThreadDeletionWorkspace("normal", path)).not.toThrow()
    }
  )

  it.each(["normal", "workflow", "coordinator"] as const)(
    "allows %s with a known workspace to reach the durable worktree guard",
    (mode) => {
      expect(() => assertThreadDeletionWorkspace(mode, "C:/project")).not.toThrow()
    }
  )
  it("allows idle tasks without loading historical results or requiring a workspace", async () => {
    const runtime = idleRuntime()
    await expect(isThreadDeletionBusy("idle", runtime)).resolves.toBe(false)
    expect(runtime.waitForSettlement).not.toHaveBeenCalled()
    expect(runtime.hasWorkerRun).toHaveBeenCalledWith("idle")
  })

  it.each(["hasActiveRun", "hasExternalRun", "hasWorkflowRun", "hasWorkerRun"] as const)(
    "protects a live owner: %s",
    async (owner) => {
      const runtime = idleRuntime()
      runtime[owner].mockReturnValue(true)
      await expect(isThreadDeletionBusy("live", runtime)).resolves.toBe(true)
    }
  )

  it("rechecks all owners after an abort settles", async () => {
    const runtime = idleRuntime()
    runtime.hasActiveRun.mockReturnValueOnce(true)
    runtime.isAborting.mockReturnValue(true)
    await expect(isThreadDeletionBusy("stopped", runtime)).resolves.toBe(false)
    runtime.hasActiveRun.mockReturnValueOnce(true)
    runtime.hasWorkerRun.mockReturnValue(true)
    await expect(isThreadDeletionBusy("worker", runtime)).resolves.toBe(true)
  })

  it("keeps timed-out or replaced runs protected", async () => {
    const runtime = idleRuntime()
    runtime.hasActiveRun.mockReturnValue(true)
    runtime.isAborting.mockReturnValue(true)
    runtime.waitForSettlement.mockResolvedValue("timed_out")
    await expect(isThreadDeletionBusy("timeout", runtime)).resolves.toBe(true)
    runtime.waitForSettlement.mockResolvedValue("settled")
    await expect(isThreadDeletionBusy("replacement", runtime)).resolves.toBe(true)
  })
})
