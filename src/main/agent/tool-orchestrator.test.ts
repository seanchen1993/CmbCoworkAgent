import { tmpdir } from "os"
import path from "path"
import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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
  function initRepository(repoPath: string): void {
    mkdirSync(repoPath, { recursive: true })
    const git = (args: string[]): void => {
      execFileSync("git", args, {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t"
        }
      })
    }
    git(["init", "-q"])
    writeFileSync(path.join(repoPath, "file.txt"), "initial\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "initial"])
    writeFileSync(path.join(repoPath, "file.txt"), "changed\n")
  }
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
      () => true
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
      () => true
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
      () => false
    )

    const result = await orchestrator.execute("git push --force", "C:/ai/CmbCoworkAgent", "none")

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Command rejected")
    expect(rawExecute).not.toHaveBeenCalled()
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it("marks ordinary shell approval requests as execute operations", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "reject",
      tool_call_id: "test"
    } satisfies ApprovalDecision)
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => false
    )
    const command = "custom-risky-command --inspect"

    await orchestrator.execute(command, process.cwd(), "none")

    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      operation: "execute",
      command
    })
    expect(rawExecute).not.toHaveBeenCalled()
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
      () => false
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
      () => true,
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

  it("fails closed for commit scope options the task-card dialog cannot reproduce", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => false
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

  it("preserves native isolated Git commands and separately approves push", async () => {
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "native git",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "approve",
      tool_call_id: "isolated-push"
    })
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => true,
      false,
      false
    )

    for (const command of [
      "git add src/a.ts",
      'git add src/a.ts && git commit -m "isolated"',
      "git commit --amend --no-edit",
      "git commit --fixup HEAD"
    ]) {
      const result = await orchestrator.execute(command, process.cwd(), "none")
      expect(result.exitCode, command).toBe(0)
      expect(result.output, command).toBe("native git")
    }

    const pushed = await orchestrator.execute("git push origin HEAD", process.cwd(), "none")
    expect(pushed.exitCode).toBe(0)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(rawExecute).toHaveBeenCalledWith("git push origin HEAD", "none", process.cwd())

    const forcePush = await orchestrator.execute(
      "git push --force origin HEAD",
      process.cwd(),
      "none"
    )
    expect(forcePush.exitCode).toBe(1)
    expect(forcePush.output).toContain("force push")

    for (const command of [
      "bash -lc 'git push origin HEAD'",
      "git -c alias.pub='!git push origin HEAD' pub"
    ]) {
      const indirectPush = await orchestrator.execute(command, process.cwd(), "none")
      expect(indirectPush.exitCode, command).toBe(1)
      expect(indirectPush.output, command).toContain("must be issued directly")
      expect(rawExecute).not.toHaveBeenCalledWith(command, "none", process.cwd())
    }
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it("reads the latest global YOLO state for each operation", async () => {
    let yoloMode = false
    const rawExecute = vi.fn<RawExecuteFn>().mockResolvedValue({
      output: "push ok",
      exitCode: 0,
      truncated: false
    })
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "reject",
      tool_call_id: "force-push"
    })
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => yoloMode
    )

    const rejected = await orchestrator.execute("git push --force", process.cwd(), "none")
    expect(rejected.exitCode).toBe(1)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(rawExecute).not.toHaveBeenCalled()

    yoloMode = true
    const approved = await orchestrator.execute("git push --force", process.cwd(), "none")
    expect(approved.exitCode).toBe(0)
    expect(rawExecute).toHaveBeenCalledTimes(1)

    yoloMode = false
    await orchestrator.execute("git push --force", process.cwd(), "none")
    expect(requestApproval).toHaveBeenCalledTimes(2)
  })

  it("rejects a bare commit instead of restaging unstaged hunks from indexed files", async () => {
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>()
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => false,
      false,
      true,
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
      () => false,
      false,
      true,
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

  it("routes a commit from a multi-repository parent to a target-selection approval", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "agent-multi-repo-"))
    try {
      const repoA = path.join(workspace, "repo-a")
      const repoB = path.join(workspace, "repo-b")
      initRepository(repoA)
      initRepository(repoB)
      const rawExecute = vi.fn<RawExecuteFn>()
      const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
        type: "reject",
        tool_call_id: "test"
      } satisfies ApprovalDecision)
      const orchestrator = new ToolOrchestrator(
        new ApprovalStore(),
        rawExecute,
        requestApproval,
        () => false,
        false,
        true,
        workspace
      )

      await orchestrator.execute('git commit -m "test" -- repo-a/file.txt', workspace, "none")

      expect(requestApproval).toHaveBeenCalledTimes(1)
      expect(requestApproval.mock.calls[0][0]).toMatchObject({
        operation: "git_commit",
        suggestedCommitFilePaths: ["repo-a/file.txt"],
        suggestedCommitFileBasePath: path.resolve(workspace),
        suggestedGitWorktreePath: undefined,
        suggestedGitRepositories: [
          { path: path.resolve(repoA), displayPath: "repo-a" },
          { path: path.resolve(repoB), displayPath: "repo-b" }
        ]
      })
      expect(rawExecute).not.toHaveBeenCalled()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("infers the only repository below a non-Git parent without showing a target selector", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "agent-single-child-repo-"))
    try {
      const repository = path.join(workspace, "repo-a")
      initRepository(repository)
      const rawExecute = vi.fn<RawExecuteFn>()
      const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
        type: "reject",
        tool_call_id: "test"
      } satisfies ApprovalDecision)
      const orchestrator = new ToolOrchestrator(
        new ApprovalStore(),
        rawExecute,
        requestApproval,
        () => false,
        false,
        true,
        workspace
      )

      await orchestrator.execute('git commit -m "test" -- repo-a/file.txt', workspace, "none")

      expect(requestApproval).toHaveBeenCalledTimes(1)
      expect(requestApproval.mock.calls[0][0]).toMatchObject({
        operation: "git_commit",
        suggestedCommitFilePaths: ["file.txt"],
        suggestedCommitFileBasePath: path.resolve(repository),
        suggestedGitWorktreePath: path.resolve(repository),
        suggestedGitRepositories: undefined
      })
      expect(rawExecute).not.toHaveBeenCalled()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("returns the ignored-only auto-dismiss reason to the Agent verbatim", async () => {
    const workspace = process.cwd()
    const message = "Agent 指定的文件均被 Git ignore，未发起提交。"
    const rawExecute = vi.fn<RawExecuteFn>()
    const requestApproval = vi.fn<RequestApprovalFn>().mockResolvedValue({
      type: "approve",
      tool_call_id: "test",
      commitResult: { success: false, error: message }
    } satisfies ApprovalDecision)
    const orchestrator = new ToolOrchestrator(
      new ApprovalStore(),
      rawExecute,
      requestApproval,
      () => false,
      false,
      true,
      workspace
    )

    const result = await orchestrator.execute(
      'git commit -m "test" -- manual-tests/agent-commit-ignore/ignored-secret.log',
      workspace,
      "none"
    )

    expect(result).toMatchObject({ output: message, exitCode: 1 })
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
        () => false,
        false,
        true,
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
      () => true
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
      () => true
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
      () => true
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
      () => true
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
