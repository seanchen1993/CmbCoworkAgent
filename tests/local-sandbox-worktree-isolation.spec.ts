/** End-to-end runtime behavior for a real linked worktree.
 * Run: npx tsx tests/local-sandbox-worktree-isolation.spec.ts */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import { ApprovalStore } from "../src/main/agent/approval-store.ts"
import { ToolOrchestrator } from "../src/main/agent/tool-orchestrator.ts"
import { SkillLifecycleRegistry } from "../src/main/agent/skill-lifecycle/registry.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"
import {
  assertWorkflowWorktreeGitOperationTarget,
  commitWorkflowWorktree,
  createWorkflowWorktree,
  resolveWorkflowWorktreeIsolationBoundary,
  stageWorkflowWorktree
} from "../src/main/services/git-worktree.ts"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

async function run(): Promise<void> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-shell-repo-")))
  const appDataRoot = realpathSync(mkdtempSync(join(tmpdir(), "cmb-wt-shell-data-")))
  try {
    git(repo, ["init", "--initial-branch=main"])
    git(repo, ["config", "user.name", "Worktree Test"])
    git(repo, ["config", "user.email", "worktree@example.com"])
    git(repo, ["remote", "add", "origin", "https://example.invalid/source.git"])
    writeFileSync(join(repo, "README.md"), "base\n")
    git(repo, ["add", "README.md"])
    git(repo, ["commit", "-m", "base"])
    const hookRelativeOutput = "isolated-hook-cwd.txt"
    const sourceHookDir = join(repo, ".cmbdevclaw", "hooks")
    mkdirSync(sourceHookDir, { recursive: true })
    writeFileSync(join(repo, ".cmbdevclaw", "config.json"), JSON.stringify({ label: "source-config" }))
    mkdirSync(join(repo, ".cmbdevclaw", "workflows"), { recursive: true })
    writeFileSync(join(repo, ".cmbdevclaw", "workflows", "source-run.json"), "source state\n")
    writeFileSync(join(repo, ".cmbdevclaw", "setup-state.json"), "source setup state\n")
    writeFileSync(
      join(sourceHookDir, "check.js"),
      `const fs=require('fs'); const config=require('../config.json'); fs.writeFileSync(${JSON.stringify(hookRelativeOutput)}, JSON.stringify({cwd:process.cwd(),workspace:process.env.WORKSPACE_PATH,project:process.env.CLAUDE_PROJECT_DIR,config:config.label}))\n`
    )

    const info = await createWorkflowWorktree({
      workspacePath: repo,
      runId: "wf_shell_boundary",
      label: "agent",
      appDataRoot
    })
    const boundary = await resolveWorkflowWorktreeIsolationBoundary(info, appDataRoot)
    // Workspace hook support is materialized because `.cmbdevclaw` is normally
    // ignored by Git. Relative hook commands still run from the private checkout.
    assert.ok(existsSync(join(info.workspaceDirectory, ".cmbdevclaw", "config.json")))
    assert.ok(
      !existsSync(join(info.workspaceDirectory, ".cmbdevclaw", "workflows", "source-run.json")),
      "a worktree must not inherit source workflow state"
    )
    assert.ok(
      !existsSync(join(info.workspaceDirectory, ".cmbdevclaw", "setup-state.json")),
      "a worktree must not inherit the source setup marker"
    )
    const skillSource = join(appDataRoot, "enabled-skills")
    const skillRoot = join(skillSource, "demo")
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: demo\n---\n")
    git(skillRoot, ["init", "--initial-branch=main"])
    git(skillRoot, ["config", "user.name", "Skill Test"])
    git(skillRoot, ["config", "user.email", "skill@example.com"])
    git(skillRoot, ["add", "SKILL.md"])
    git(skillRoot, ["commit", "-m", "skill fixture"])
    const workspaceHook: HookConfig = {
      id: "isolated-workspace-hook",
      enabled: true,
      type: "command",
      event: "PreToolUse",
      matcher: "execute",
      command: "node .cmbdevclaw/hooks/check.js",
      hookSourceType: "workspace",
      hookSourceRoot: repo,
      hookSourcePath: join(repo, ".cmbdevclaw", "hooks", "isolated.json")
    }
    const sandboxRunId = "workflow-worktree-hook-e2e"
    const sandbox = new LocalSandbox({
      rootDir: info.workspaceDirectory,
      worktreeIsolation: boundary,
      skillLifecycleRegistry: new SkillLifecycleRegistry([skillSource]),
      hooks: [workspaceHook],
      runId: sandboxRunId,
      windowsSandbox: "none",
      timeout: 30_000,
      env: { ...process.env } as NodeJS.ProcessEnv
    })
    sandbox.setOrchestrator(
      new ToolOrchestrator(
        new ApprovalStore(),
        (command, mode, cwd) => sandbox.executeRaw(command, mode, undefined, undefined, { cwd }),
        async () => ({ type: "reject", tool_call_id: "unexpected" }),
        true,
        false,
        false,
        async (operation, message, cwd) => {
          try {
            await assertWorkflowWorktreeGitOperationTarget(boundary, cwd)
            const output =
              operation === "stage"
                ? await stageWorkflowWorktree(boundary)
                : await commitWorkflowWorktree(boundary, message ?? "")
            return { output, exitCode: 0, truncated: false }
          } catch (error) {
            return {
              output: error instanceof Error ? error.message : String(error),
              exitCode: 1,
              truncated: false
            }
          }
        }
      )
    )

    // The Git boundary is canonicalized. A caller that reached the same
    // checkout through a symlinked root must still get the canonical worktree
    // cwd rather than a false "outside" rejection.
    const worktreeAlias = join(appDataRoot, "worktree-alias")
    symlinkSync(info.workspaceDirectory, worktreeAlias, "dir")
    const aliasSandbox = new LocalSandbox({
      rootDir: worktreeAlias,
      worktreeIsolation: boundary,
      windowsSandbox: "none",
      timeout: 30_000,
      env: { ...process.env } as NodeJS.ProcessEnv
    })
    const aliasCwd = await aliasSandbox.execute("pwd", worktreeAlias)
    assert.equal(aliasCwd.exitCode, 0, aliasCwd.output)
    assert.equal(realpathSync(aliasCwd.output.trim()), realpathSync(info.workspaceDirectory))

    const localWrite = await sandbox.execute("printf 'local\\n' > local.txt")
    assert.equal(localWrite.exitCode, 0, localWrite.output)
    assert.ok(existsSync(join(info.workspaceDirectory, "local.txt")))
    assert.ok(
      existsSync(join(info.workspaceDirectory, hookRelativeOutput)),
      "workspace hook must run from the isolated checkout"
    )
    assert.ok(!existsSync(join(repo, hookRelativeOutput)), "workspace hook must not write source")
    const hookContext = JSON.parse(
      readFileSync(join(info.workspaceDirectory, hookRelativeOutput), "utf8")
    ) as { cwd: string; workspace: string; project: string; config: string }
    assert.equal(realpathSync(hookContext.cwd), realpathSync(info.workspaceDirectory))
    assert.equal(realpathSync(hookContext.workspace), realpathSync(info.workspaceDirectory))
    assert.equal(realpathSync(hookContext.project), realpathSync(info.workspaceDirectory))
    assert.equal(hookContext.config, "source-config", "workspace hook support must be copied")
    const sourceUserName = git(repo, ["config", "--get", "user.name"])
    const sourceRemote = git(repo, ["remote", "get-url", "origin"])
    const configMutation = await sandbox.execute("git config user.name isolated-evil")
    assert.notEqual(configMutation.exitCode, 0, "isolated worktree must not change shared Git config")
    assert.match(configMutation.output, /shared Git configuration/i)
    assert.equal(git(repo, ["config", "--get", "user.name"]), sourceUserName)
    const remoteMutation = await sandbox.execute(
      "git remote set-url origin https://example.invalid/isolated.git"
    )
    assert.notEqual(remoteMutation.exitCode, 0, "isolated worktree must not change shared remotes")
    assert.match(remoteMutation.output, /shared Git remotes/i)
    assert.equal(git(repo, ["remote", "get-url", "origin"]), sourceRemote)
    // Keep the workspace hook enabled but replace the first fixture so the
    // remaining checks exercise ordinary worktree behavior.
    writeFileSync(
      join(info.workspaceDirectory, ".cmbdevclaw", "hooks", "check.js"),
      "process.exit(0)\n"
    )

    const skillForeground = await sandbox.execute(
      `node -e ${JSON.stringify("console.log(process.cwd())")}`,
      skillRoot
    )
    assert.equal(skillForeground.exitCode, 0, skillForeground.output)
    assert.equal(realpathSync(skillForeground.output.trim()), realpathSync(skillRoot))
    const skillGitStatus = await sandbox.execute("git -C . status --short", skillRoot)
    assert.equal(
      skillGitStatus.exitCode,
      0,
      `enabled skill cwd must keep normal read-only git -C usage: ${skillGitStatus.output}`
    )

    const nestedRepo = join(info.workspaceDirectory, "nested-repo")
    mkdirSync(nestedRepo, { recursive: true })
    git(nestedRepo, ["init", "--initial-branch=main"])
    git(nestedRepo, ["config", "user.name", "Nested Test"])
    git(nestedRepo, ["config", "user.email", "nested@example.com"])
    writeFileSync(join(nestedRepo, "nested.txt"), "nested\n")
    git(nestedRepo, ["add", "nested.txt"])
    git(nestedRepo, ["commit", "-m", "nested base"])
    const outerHeadBeforeNestedCommit = git(info.directory, ["rev-parse", "HEAD"])
    const nestedCommit = await sandbox.execute("git commit -m nested", nestedRepo)
    assert.notEqual(nestedCommit.exitCode, 0, "nested repository commit must be rejected")
    assert.match(nestedCommit.output, /nested repository/i)
    assert.equal(
      git(info.directory, ["rev-parse", "HEAD"]),
      outerHeadBeforeNestedCommit,
      "nested commit must not advance the outer workflow branch"
    )
    const fileWrite = await sandbox.write("file-tool-local.txt", "before\n")
    assert.ok(!fileWrite.error, `isolated file write should work: ${fileWrite.error ?? ""}`)
    const fileEdit = await sandbox.edit("file-tool-local.txt", "before", "after")
    assert.ok(!fileEdit.error, `isolated file edit should work: ${fileEdit.error ?? ""}`)
    assert.equal(
      readFileSync(join(info.workspaceDirectory, "file-tool-local.txt"), "utf8"),
      "after\n"
    )
    const nestedWrite = await sandbox.write("new/deep/file-tool-created.txt", "nested\n")
    assert.ok(!nestedWrite.error, `nested file write should work: ${nestedWrite.error ?? ""}`)
    assert.equal(
      readFileSync(join(info.workspaceDirectory, "new", "deep", "file-tool-created.txt"), "utf8"),
      "nested\n"
    )

    symlinkSync(repo, join(info.workspaceDirectory, "source-link"), "dir")
    const linkedWrite = await sandbox.write("source-link/file-tool-escaped.txt", "escaped\n")
    assert.ok(linkedWrite.error, "file tool must reject a symlink-parent escape")
    assert.ok(!existsSync(join(repo, "file-tool-escaped.txt")))

    const uploads = await sandbox.uploadFiles([
      ["upload/deep/allowed.bin", new TextEncoder().encode("allowed\n")],
      ["source-link/upload-escaped.bin", new TextEncoder().encode("escaped\n")]
    ])
    assert.ok(!uploads[0].error, "nested upload inside the assigned workspace must work")
    assert.ok(uploads[1].error, "a batch upload must reject a symlink-parent escape")
    assert.equal(
      readFileSync(join(info.workspaceDirectory, "upload", "deep", "allowed.bin"), "utf8"),
      "allowed\n"
    )
    assert.ok(!existsSync(join(repo, "upload-escaped.bin")))

    const backgroundStage = await sandbox.executeBackground("git add -A")
    assert.match(backgroundStage, /must run in the foreground/i)
    assert.doesNotMatch(backgroundStage, /background task started/i)
    const chainedBackgroundStage = await sandbox.executeBackground("cd . && git add -A")
    assert.match(chainedBackgroundStage, /must run in the foreground/i)
    assert.doesNotMatch(chainedBackgroundStage, /background task started/i)
    assert.doesNotMatch(
      git(info.directory, ["diff", "--cached", "--name-only"]),
      /(?:^|\n)local\.txt(?:\n|$)/,
      "rejected background staging must not mutate the index"
    )
    const commit = await sandbox.execute("git commit -m isolated")
    assert.equal(commit.exitCode, 0, `normal assigned-branch commit must work: ${commit.output}`)
    assert.equal(git(info.directory, ["branch", "--show-current"]), info.branch)
    const push = await sandbox.execute("git push origin HEAD")
    assert.notEqual(push.exitCode, 0, "transient workflow branches must not be pushed")

    // Claude Code exposes a force-sync hook path for lifecycle-sensitive
    // contexts. Worktree agents use the same small rule: a configured async
    // workspace hook finishes before its tool call can settle and cleanup starts.
    const asyncMarker = join(info.workspaceDirectory, "async-hook-finished.txt")
    workspaceHook.async = true
    workspaceHook.command = `node -e ${JSON.stringify(
      `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(asyncMarker)},'done'),100)`
    )}`
    const triggerAsyncHook = await sandbox.execute("true")
    assert.equal(triggerAsyncHook.exitCode, 0, triggerAsyncHook.output)
    assert.equal(readFileSync(asyncMarker, "utf8"), "done")
    const redirected = await sandbox.executeRaw(`git -C ${JSON.stringify(repo)} status`, "none")
    assert.notEqual(redirected.exitCode, 0)
    assert.match(redirected.output, /worktree isolation blocks git -C/i)

    const exportedRedirect = await sandbox.executeRaw(
      `export GIT_DIR=${JSON.stringify(join(repo, ".git"))} GIT_WORK_TREE=${JSON.stringify(repo)} && git status`,
      "none"
    )
    assert.notEqual(exportedRedirect.exitCode, 0)
    assert.match(exportedRedirect.output, /worktree isolation blocks Git environment redirection/i)

    const symlinkCwdEscape = await sandbox.executeRaw("cd source-link && pwd", "none")
    assert.notEqual(symlinkCwdEscape.exitCode, 0)
    assert.match(symlinkCwdEscape.output, /outside the assigned workspace/i)

    const gitPointerWrite = await sandbox.write(join(info.directory, ".git"), "corrupt\n")
    assert.match(
      gitPointerWrite.error ?? "",
      /access denied/i,
      "file tools must explicitly protect the linked-worktree .git pointer"
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(appDataRoot, { recursive: true, force: true })
  }
  console.log("PASS local-sandbox-worktree-isolation")
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
