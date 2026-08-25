import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import { validateWorkflowScript } from "./script"
import { workflowRunManager } from "./run-manager"
import { generateWorkflowRunId, loadWorkflowRun, sha256Hex } from "./run-store"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "wf-no-shared-fallback-")))
  git(repo, ["init", "--initial-branch=main"])
  git(repo, ["config", "user.name", "Test User"])
  git(repo, ["config", "user.email", "test@example.com"])
  writeFileSync(join(repo, "README.md"), "base\n")
  git(repo, ["add", "README.md"])
  git(repo, ["commit", "-m", "base"])
  return repo
}

describe("isolated worktree provisioning failure", () => {
  let repo: string
  let threadId: string
  let runId: string

  beforeEach(() => {
    repo = makeRepo()
    threadId = `thread-no-shared-fallback-${Date.now()}`
    runId = generateWorkflowRunId()
  })

  afterEach(async () => {
    if (workflowRunManager.isActive(threadId)) {
      workflowRunManager.cancel(threadId, runId)
      await workflowRunManager.waitForRunLifecycle(threadId, runId)
    }
    rmSync(repo, { recursive: true, force: true })
  })

  test("never starts the subagent in the shared workspace", async () => {
    const escapedMarker = join(repo, "SHARED-WORKSPACE-FALLBACK.txt")
    const script = `export const meta = { name: "no-shared-fallback", description: "d" }
const result = await agent("create SHARED-WORKSPACE-FALLBACK.txt", { isolation: "worktree" })
return result === null ? "PROVISIONING_BLOCKED" : "UNEXPECTED_AGENT_RESULT"`
    let runtimeStarts = 0

    // Detached source checkouts cannot supply the managed source branch. This
    // provisioning failure must return null, never retry in the shared checkout.
    git(repo, ["checkout", "--detach"])

    const launch = workflowRunManager.launch({
      threadId,
      workspacePath: repo,
      runId,
      parsed: validateWorkflowScript(script),
      script,
      scriptSha256: sha256Hex(script),
      subagentDeps: {
        parentThreadId: threadId,
        createRuntime: async (options) => {
          runtimeStarts += 1
          // Make a shared-workspace fallback observable even if a future
          // regression still turns the runtime error into agent() === null.
          if (!options.worktreeIsolation) writeFileSync(escapedMarker, "escaped\n")
          throw new Error("the subagent runtime must not start when provisioning fails")
        },
        cleanupThread: async () => undefined,
        isRetryableApiError: () => false
      }
    })

    expect(await launch.whenInitialPersisted).toBe(true)
    await workflowRunManager.waitForRunLifecycle(threadId, runId)

    const persisted = loadWorkflowRun(repo, threadId, runId)
    expect(persisted?.status).toBe("completed")
    expect(persisted?.result).toBe("PROVISIONING_BLOCKED")
    expect(persisted?.agents[0]?.error).toContain("attached to a branch")
    expect(runtimeStarts).toBe(0)
    expect(existsSync(escapedMarker)).toBe(false)
    expect(
      git(repo, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
    ).toHaveLength(1)
  })
})
