import { tmpdir } from "os"
import path from "path"
import { describe, expect, it, vi } from "vitest"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator, type RawExecuteFn, type RequestApprovalFn } from "./tool-orchestrator"
import type { ApprovalDecision } from "../types"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => undefined }
}))

describe("ToolOrchestrator YOLO git behavior", () => {
  it("runs git merge without an approval prompt in YOLO mode", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "merge ok",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )

    const result = await orchestrator.execute(
      "git -C /c/ai/CmbCoworkAgent merge codex/git-panel-lazy-diff",
      "C:/ai/CmbCoworkAgent",
      "none"
    )

    expect(result.output).toBe("merge ok")
    expect(rawExecute).toHaveBeenCalledTimes(1)
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("runs force push without an approval prompt in YOLO mode", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "force push ok",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )

    const result = await orchestrator.execute(
      "git push --force",
      "C:/ai/CmbCoworkAgent",
      "none"
    )

    expect(result.output).toBe("force push ok")
    expect(rawExecute).toHaveBeenCalledTimes(1)
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("keeps force push behind approval outside YOLO mode", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "should not run",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "reject",
      tool_call_id: "test"
    } satisfies ApprovalDecision)
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      false
    )

    const result = await orchestrator.execute(
      "git push --force",
      "C:/ai/CmbCoworkAgent",
      "none"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Command rejected")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it("reports push-specific cwd validation errors for routed git push commands", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "should not run",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      false
    )
    const cwd = process.cwd()
    const missingGitCwd = path.join(cwd, ".missing-git-push-cwd-for-test")

    const result = await orchestrator.execute(`git -C "${missingGitCwd}" push`, cwd, "none")

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("`git push` 的工作目录不存在")
    expect(result.output).not.toContain("git commit")
    expect(result.output).not.toContain("任务卡片")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("never offers an unsandboxed retry for an isolated worktree runtime", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true,
      false,
      false
    )
    const denied = {
      output: "operation not permitted by sandbox",
      exitCode: 1,
      truncated: false
    }

    const result = await orchestrator.maybeRetryOutsideSandbox(
      "touch escaped.txt",
      process.cwd(),
      "unelevated",
      denied
    )

    expect(result).toBe(denied)
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("executes isolated worktree commits in place and blocks pushes", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "committed",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>()
    const isolatedGitMutation = vi.fn().mockResolvedValue({
      output: "broker committed",
      exitCode: 0,
      truncated: false
    })
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true,
      false,
      false,
      isolatedGitMutation
    )

    const committed = await orchestrator.execute("git commit -m isolated", process.cwd(), "none")
    const pushed = await orchestrator.execute("git push origin HEAD", process.cwd(), "none")

    expect(committed.output).toBe("broker committed")
    expect(isolatedGitMutation).toHaveBeenCalledWith("commit", "isolated", process.cwd())
    expect(requestApproval).not.toHaveBeenCalled()
    expect(pushed.exitCode).toBe(1)
    expect(pushed.output).toContain("direct push")
    expect(rawExecute).not.toHaveBeenCalled()

    for (const command of [
      "git commit --amend -m rewritten",
      "git commit --fixup HEAD -m rewritten",
      "git commit -m partial -- src/a.ts",
      "git commit -m chained && git status",
      "git add src/a.ts",
      "cd subdir && git add -A",
      "git -C nested-repo commit -m nested",
      "git -C nested-repo add -A"
    ]) {
      const rejected = await orchestrator.execute(command, process.cwd(), "none")
      expect(rejected.exitCode, command).toBe(1)
      expect(rejected.output, command).toContain("Command forbidden")
    }
    expect(isolatedGitMutation).toHaveBeenCalledTimes(1)
  })
})
