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

    const result = await orchestrator.execute("git push --force", "C:/ai/CmbCoworkAgent", "none")

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

    const result = await orchestrator.execute("git push --force", "C:/ai/CmbCoworkAgent", "none")

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

  it("fails closed for commit scope options the task-card dialog cannot reproduce", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      false
    )

    const result = await orchestrator.execute(
      'git commit --pathspec-from-file=files.txt -m "test"',
      process.cwd(),
      "none"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("无法安全复现")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("rejects a bare commit instead of restaging unstaged hunks from indexed files", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      false,
      false,
      process.cwd()
    )

    const result = await orchestrator.execute('git commit -m "test"', process.cwd(), "none")

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("必须指定明确文件路径")
    expect(result.output).toContain("暂存区/未暂存片段语义")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("projects explicit paths from a nested Git cwd to the repository operation target", async () => {
    const workspace = process.cwd()
    const nestedCwd = path.join(workspace, "src", "main")
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "reject",
      tool_call_id: "test"
    } satisfies ApprovalDecision)
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      false,
      false,
      workspace
    )

    await orchestrator.execute(
      'git commit -m "test" -- agent/tool-orchestrator.ts',
      nestedCwd,
      "none"
    )

    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      operation: "git_commit",
      suggestedCommitFilePaths: ["src/main/agent/tool-orchestrator.ts"],
      suggestedCommitFileBasePath: path.resolve(workspace),
      suggestedGitWorktreePath: path.resolve(workspace),
      suggestedCommitFileSelectionSource: "pathspec"
    })
    expect(rawExecute).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== "win32")(
    "projects MSYS absolute pathspecs from Git Bash on Windows",
    async () => {
      const workspace = process.cwd()
      const msysWorkspace = `/${workspace[0].toLowerCase()}${workspace
        .slice(2)
        .replace(/\\/g, "/")}`
      const rawExecute = vi.fn<RawExecuteFn>()
      const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
        type: "reject",
        tool_call_id: "test"
      } satisfies ApprovalDecision)
      const orchestrator = new ToolOrchestrator(
        new ApprovalStore(),
        rawExecute,
        requestApproval,
        false,
        false,
        workspace
      )

      await orchestrator.execute(
        `git commit -m "test" -- '${msysWorkspace}/src/main/agent/tool-orchestrator.ts'`,
        workspace,
        "none",
        "posix"
      )

      expect(requestApproval.mock.calls[0][0]).toMatchObject({
        operation: "git_commit",
        suggestedCommitFilePaths: ["src/main/agent/tool-orchestrator.ts"]
      })
      expect(rawExecute).not.toHaveBeenCalled()
    }
  )

  it("never raw-executes a Git alias that can hide a commit in YOLO mode", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )

    const result = await orchestrator.execute(
      "git -c alias.ci='!git add -f .env && git commit -m bypass' ci",
      process.cwd(),
      "none"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Git aliases")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("uses the actual POSIX shell syntax before the YOLO raw-execute shortcut", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )

    const result = await orchestrator.execute(
      String.raw`echo \" & git commit -m x -- package.json & echo \"`,
      process.cwd(),
      "none",
      "posix"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("串联执行")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("never raw-executes a WSL-wrapped commit in YOLO mode", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )

    const result = await orchestrator.execute(
      "wsl git commit -m x -- package.json",
      process.cwd(),
      "none",
      "posix"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("wrapped git commit")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it("rechecks Git routing when an approved retry changes shell syntax", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "approve",
      tool_call_id: "retry"
    } satisfies ApprovalDecision)
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      true
    )
    const command = String.raw`echo \" ; git commit -m x -- package.json ; echo \"`

    const result = await orchestrator.maybeRetryOutsideSandbox(
      command,
      process.cwd(),
      "unelevated",
      { output: "Permission denied", exitCode: 1, truncated: false },
      "posix"
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("串联执行")
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(rawExecute).not.toHaveBeenCalled()
  })
})
