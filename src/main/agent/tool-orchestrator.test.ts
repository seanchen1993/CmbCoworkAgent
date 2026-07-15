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
})
