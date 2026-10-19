import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "native-child-test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))

import { captureNativeChildWorkflows } from "./native-child-workflows"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import { validateWorkflowScript } from "../../agent/workflow/script"
import { generateWorkflowRunId, loadWorkflowRunAsync, sha256Hex } from "../../agent/workflow/run-store"
import { WorkflowWorktreeLedger } from "../../agent/workflow/worktree-lease"

it.each(["success", "agent-error", "retired-agent-error", "cancel", "cleanup-error"] as const)(
  "keeps the original child lifecycle and real worktree facts for %s",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "flow-child-workflows-")), workspace = join(root, "repo")
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("UNSAFE_TEST_CLEANUP")
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    })
    git("init", "--initial-branch=main")
    git("config", "user.name", "Native Flow Test")
    git("config", "user.email", "flow@example.test")
    writeFileSync(join(workspace, "README.md"), "base\n")
    git("add", "README.md")
    git("commit", "-m", "fixture")
    vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "data"))
    const childId = `flow-child-${Date.now()}`, runId = generateWorkflowRunId()
    let identity = true, started = 0, release!: () => void, ready!: () => void
    let restoreReclaim: (() => void) | undefined
    const gate = new Promise<void>(done => { release = done })
    const allStarted = new Promise<void>(done => { ready = done })
    const assertIdentity = () => { if (!identity) throw Error("CHILD_IDENTITY_CHANGED") }
    const owned = await captureNativeChildWorkflows(
      workspace, childId, assertIdentity, new AbortController().signal
    )
    const script = `export const meta={name:"native-child-owner",description:"Actual worktree lifecycle"};
      return await Promise.all([agent("one",{isolation:"worktree"}),agent("two",{isolation:"worktree"})])`
    try {
      await workflowRunManager.prepareLaunch(workspace, childId)
      const launched = workflowRunManager.launch({
        threadId: childId, workspacePath: workspace, runId, script,
        parsed: validateWorkflowScript(script), scriptSha256: sha256Hex(script),
        subagentDeps: {
          parentThreadId: childId, cleanupThread: async () => {}, isRetryableApiError: () => false,
          createRuntime: async options => ({
            stream: async () => (async function* () {
              expect(options.worktreeIsolation).toBeDefined()
              if (++started === 2) ready()
              await new Promise<void>((done, reject) => {
                const aborted = () => reject(Error("AbortError"))
                options.abortSignal.addEventListener("abort", aborted, { once: true })
                void gate.then(() => {
                  options.abortSignal.removeEventListener("abort", aborted)
                  done()
                })
              })
              if (scenario.endsWith("agent-error")) throw Error("actual child rejected")
              yield ["values", { messages: [new AIMessage("completed actual child")] }]
            })()
          })
        }
      })
      expect(await launched.whenInitialPersisted).toBe(true)
      await allStarted
      const live = await workflowRunManager.observeActiveRun(workspace, childId)
      expect(live?.worktrees).toHaveLength(2)
      expect(live?.worktrees.every(tree => existsSync(join(tree.directory, ".git")))).toBe(true)
      if (scenario === "cleanup-error") {
        const reclaim = vi.spyOn(WorkflowWorktreeLedger.prototype, "reclaimAll")
          .mockRejectedValueOnce(Error("ACTUAL_WORKTREE_CLEANUP_FAILED"))
        restoreReclaim = () => reclaim.mockRestore()
      }
      if (scenario === "retired-agent-error") {
        release()
        await workflowRunManager.waitForRunLifecycle(childId, runId)
      }
      let completed = false
      const pending = owned.settle(scenario === "cancel")
        .then(() => { completed = true; return undefined }, error => error as Error)
      if (scenario !== "cancel" && scenario !== "retired-agent-error") {
        await Promise.resolve()
        expect(completed).toBe(false)
        release()
      }
      const failure = await pending
      const original = await loadWorkflowRunAsync(workspace, childId, runId)
      expect(workflowRunManager.activeRunId(childId)).toBeUndefined()
      if (scenario.endsWith("agent-error")) {
        expect(original?.status).toBe("completed")
        expect(original?.stats.agentsFailed).toBe(2)
        expect(failure?.message).toBe("FLOW_CHILD_WORKFLOW_NOT_SUCCEEDED")
        await owned.settle(true)
        // A later host operation must not claim a previous owner's completed history.
        const next = await captureNativeChildWorkflows(
          workspace, childId, assertIdentity, new AbortController().signal
        )
        await next.settle()
      } else if (scenario === "cleanup-error") {
        expect(failure?.message).toBe("ACTUAL_WORKTREE_CLEANUP_FAILED")
      } else {
        expect(failure).toBeUndefined()
        for (const tree of live!.worktrees) expect(existsSync(tree.directory)).toBe(false)
      }
      identity = false
      await expect(owned.settle()).rejects.toThrow("CHILD_IDENTITY_CHANGED")
    } finally {
      release()
      if (workflowRunManager.activeRunId(childId)) await workflowRunManager.cancelAndWait(childId)
      restoreReclaim?.()
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000
)
