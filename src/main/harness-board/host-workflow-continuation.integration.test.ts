// Original manager/engine/persistence/notification owner; deterministic child model only.
// This is not the separate actual Host + IPC + model acceptance test.
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))
vi.mock("../services/subagent-session-capture", () => ({
  withSubagentSessionCapture: (_context: unknown, _label: string, work: () => Promise<unknown>) =>
    work(),
  subagentSessionCallbacks: () => []
}))
vi.mock("../services/adoption-tracker", () => ({ setAdoptionContext: vi.fn() }))
import { workflowRunManager } from "../agent/workflow/run-manager"
import { loadWorkflowRun, sha256Hex } from "../agent/workflow/run-store"
import { validateWorkflowScript } from "../agent/workflow/script"
import { WorkflowWorktreeLedger } from "../agent/workflow/worktree-lease"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { createHostWorkflowContinuation } from "./host-workflow-continuation"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup(outcome: "completed" | "error" = "completed", isolated = false,
  checks?: { source?(root: string): void; notification?(): void }) {
  const root = mkdtempSync(join(tmpdir(), "host-workflow-result-"))
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  if (isolated) {
    git("init", "--initial-branch=main")
    git("config", "user.name", "Workflow continuation test")
    git("config", "user.email", "workflow@example.test")
    writeFileSync(join(root, ".gitignore"), "data/\n.devclaw/\n.cmbcoworkagent/\n")
    git("add", ".gitignore")
    git("commit", "-m", "Initialize original workspace")
  }
  const prior = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  const threadId = randomUUID()
  let live = true
  const guard = () => {
    if (!live) throw Error("ACTUAL_OWNER_REVOKED")
  }
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      executionMode: "workflow",
      threadId,
      incarnationKey: "original-incarnation",
      projectId: "supplier-project",
      operationId: randomUUID(),
      stageId: "implementation",
      workspace: root,
      packageDigest: "a".repeat(64),
      inputFingerprint: "b".repeat(64),
      plugin: {
        id: "original-installation",
        name: "supplier-example",
        version: "1.0.0",
        path: root,
        description: "",
        author: "",
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    },
    guard,
    guard
  )
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cleaned = Promise.withResolvers<void>()
  const closeChild = Promise.withResolvers<void>()
  let runtimeCreated = false
  cleanup.push(async () => {
    release.resolve()
    closeChild.resolve()
    await workflowRunManager.cancelAndWait(threadId)
    if (prior === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = prior
    rmSync(root, { recursive: true, force: true })
  })
  const owner = createHostWorkflowContinuation({
    token,
    workspace: root,
    threadId,
    assertCurrent: () => { guard(); checks?.source?.(root) },
    ...(checks?.notification ? { assertNotificationCurrent() {
      guard()
      checks.notification!()
    } } : {})
  })
  const script =
    'export const meta={name:"supplier",description:"result handoff"}; const result = await agent("inspect"' +
    (isolated ? ',{isolation:"worktree"});' : ");") +
    (outcome === "error" ? 'throw Error("TEST_EXECUTION_FAILED")' : "return result")
  const runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  await workflowRunManager.prepareLaunch(root, threadId)
  const launch = withRuntimePluginSource(token, () =>
    workflowRunManager.launch({
      workspacePath: root,
      threadId,
      runId,
      script,
      scriptSha256: sha256Hex(script),
      parsed: validateWorkflowScript(script),
      notificationOwner: "managed",
      subagentDeps: {
        parentThreadId: threadId,
        isRetryableApiError: () => false,
        cleanupThread: async () => {
          // The original subagent purges a reused child before runtime creation.
          // Hold only the physical cleanup following the actual runtime.
          if (!runtimeCreated) return
          cleaned.resolve()
          await closeChild.promise
        },
        createRuntime: async () => {
          runtimeCreated = true
          return {
            stream: async () =>
              (async function* () {
                started.resolve()
                await release.promise
                yield ["values", { messages: [new AIMessage("actual deterministic child reply")] }]
              })()
          }
        }
      }
    })
  )
  owner.onDetachedResultAvailable({ kind: "workflow", threadId, runId })
  await launch.whenInitialPersisted
  await started.promise
  return {
    root,
    threadId,
    token,
    owner,
    runId,
    release,
    cleaned,
    closeChild,
    git,
    revoke: () => {
      live = false
    }
  }
}

it.each(["source", "inputs"])(
  "rechecks complete %s bytes after original asynchronous workflow cleanup", async kind => {
    let sourceChecks = 0, ownerChecks = 0
    const file = kind === "source" ? "retained-SKILL.md" : "original-inputs.json"
    const f = await setup("error", false, {
      source(root) {
        const path = join(root, file)
        if (!existsSync(path)) writeFileSync(path, "original bytes")
        sourceChecks++
        if (readFileSync(path, "utf8") !== "original bytes") throw Error("ORIGINAL_SOURCE_BYTES_CHANGED")
      },
      notification: () => { ownerChecks++ }
    })
    const consume = vi.fn(async () => {})
    const pending = f.owner.consume(consume)
    const rejected = expect(pending).rejects.toThrow("ORIGINAL_SOURCE_BYTES_CHANGED")
    f.release.resolve()
    await f.cleaned.promise
    writeFileSync(join(f.root, file), "changed across the original async cleanup")
    f.closeChild.resolve()
    await rejected
    expect(sourceChecks).toBeGreaterThan(1)
    expect(ownerChecks).toBe(0)
    expect(consume).not.toHaveBeenCalled()
    expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).not.toBe(true)
  }
)

it("keeps full checks at handoff while repeated notice owner checks use the original token", async () => {
  let sourceChecks = 0, ownerChecks = 0
  const f = await setup("error", false, {
    source: () => { sourceChecks++ }, notification: () => { ownerChecks++ }
  })
  f.release.resolve()
  f.closeChild.resolve()
  await expect(f.owner.consume(async notice => {
    const before = sourceChecks
    for (let index = 0; index < 10; index++) notice.assertCurrent()
    expect(sourceChecks).toBe(before)
    expect(ownerChecks).toBe(10)
    notice.assertSourceCurrent()
    expect(sourceChecks).toBe(before + 1)
    f.revoke()
    expect(() => notice.assertCurrent()).toThrow("ACTUAL_OWNER_REVOKED")
    notice.assertCurrent()
  })).rejects.toThrow("ACTUAL_OWNER_REVOKED")
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).not.toBe(true)
})

it("waits the original physical tail, claims exactly its managed notice, then verifies persisted delivery", async () => {
  const f = await setup()
  expect(
    await workflowRunManager.claimPendingNotificationAsync(f.root, f.threadId, { owner: "managed" })
  ).toBeNull()
  const consume = vi.fn(
    async (notice: { runId: string; startedAt: string; assertCurrent(): void }) => {
      notice.assertCurrent()
      expect(workflowRunManager.activeRunId(f.threadId)).toBeUndefined()
      expect(
        await workflowRunManager.findPendingNotificationAsync(f.root, f.threadId, {
          owner: "desktop"
        })
      ).toBeNull()
      expect(
        await workflowRunManager.claimPendingNotificationAsync(f.root, f.threadId, {
          owner: "managed",
          expected: { runId: f.runId, startedAt: "wrong-instance" }
        })
      ).toBeNull()
      const pending = await workflowRunManager.claimPendingNotificationAsync(f.root, f.threadId, {
        owner: "managed",
        expected: notice
      })
      expect(pending?.runId).toBe(f.runId)
      expect(pending?.hostExecution).toMatchObject({
        projectId: "supplier-project",
        threadId: f.threadId,
        inputFingerprint: "b".repeat(64)
      })
      expect(
        await workflowRunManager.markNotified(f.root, f.threadId, f.runId, notice.startedAt)
      ).toBe(true)
      workflowRunManager.clearNotificationInFlight(f.runId)
    }
  )
  const completion = f.owner.consume(consume)
  f.release.resolve()
  await f.cleaned.promise
  expect(consume).not.toHaveBeenCalled()
  f.closeChild.resolve()
  await completion
  expect(consume).toHaveBeenCalledOnce()
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).toBe(true)
})

it("reports the original engine throw only after physical cleanup and keeps its failed result", async () => {
  const f = await setup("error", true)
  const releaseSource = vi.fn(async () => {})
  expect(workflowRunManager.deferOwnedRuntimeWorkflowSettlement(f.token, releaseSource)).toEqual({
    deferred: true
  })
  const consume = vi.fn(
    async (notice: { runId: string; startedAt: string; assertCurrent(): void }) => {
      notice.assertCurrent()
      expect(workflowRunManager.activeRunId(f.threadId)).toBeUndefined()
      const pending = await workflowRunManager.claimPendingNotificationAsync(f.root, f.threadId, {
        owner: "managed",
        expected: notice
      })
      expect(pending).toMatchObject({
        runId: f.runId,
        status: "error",
        error: expect.stringContaining("TEST_EXECUTION_FAILED"),
        notificationOwner: "managed",
        hostExecution: { threadId: f.threadId, projectId: "supplier-project" }
      })
      expect(pending?.result).toBeUndefined()
      expect(
        await workflowRunManager.claimPendingNotificationAsync(f.root, f.threadId, {
          owner: "managed",
          expected: notice
        })
      ).toBeNull()
      expect(
        await workflowRunManager.markNotified(f.root, f.threadId, f.runId, notice.startedAt)
      ).toBe(true)
      workflowRunManager.clearNotificationInFlight(f.runId)
    }
  )
  const completion = f.owner.consume(consume)
  f.release.resolve()
  await f.cleaned.promise
  expect(consume).not.toHaveBeenCalled()
  expect(releaseSource).not.toHaveBeenCalled()
  expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2)
  f.closeChild.resolve()
  await completion
  await f.owner.consume(consume)
  expect(consume).toHaveBeenCalledOnce()
  expect(releaseSource).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1)
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)).toMatchObject({
    status: "error",
    error: expect.stringContaining("TEST_EXECUTION_FAILED"),
    notificationDelivered: true
  })
})

it.each(["completed", "error"] as const)(
  "cannot count a %s callback without the original notification delivery acknowledgement",
  async (outcome) => {
    const f = await setup(outcome)
    f.release.resolve()
    f.closeChild.resolve()
    await expect(f.owner.consume(async () => {})).rejects.toThrow("NOT_CONSUMED")
    expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).not.toBe(true)
  }
)

it.each(["completed", "error"] as const)(
  "does not run a %s result model after the original authority changes during physical cleanup",
  async (outcome) => {
    const f = await setup(outcome)
    const consume = vi.fn(async () => {})
    const completion = f.owner.consume(consume)
    const rejected = expect(completion).rejects.toThrow("ACTUAL_OWNER_REVOKED")
    f.release.resolve()
    await f.cleaned.promise
    f.revoke()
    f.closeChild.resolve()
    await rejected
    expect(consume).not.toHaveBeenCalled()
  }
)

it("does not accept a cancelled original workflow as a known engine failure", async () => {
  const f = await setup()
  const consume = vi.fn(async () => {})
  const completion = f.owner.consume(consume)
  const rejected = expect(completion).rejects.toThrow("HOST_WORKFLOW_SETTLEMENT_UNCONFIRMED")
  workflowRunManager.cancel(f.threadId, f.runId, false)
  f.release.resolve()
  f.closeChild.resolve()
  await rejected
  expect(consume).not.toHaveBeenCalled()
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.status).toBe("aborted")
})

it("rejects an engine error whose original physical reclamation fails", async () => {
  const f = await setup("error")
  // Fault injection at the original physical owner, never a synthesized run/receipt.
  const reclaim = vi
    .spyOn(WorkflowWorktreeLedger.prototype, "reclaimAll")
    .mockRejectedValueOnce(Error("ORIGINAL_PHYSICAL_RECLAIM_FAILED"))
  const consume = vi.fn(async () => {})
  try {
    const completion = f.owner.consume(consume)
    const rejected = expect(completion).rejects.toThrow("ORIGINAL_PHYSICAL_RECLAIM_FAILED")
    f.release.resolve()
    f.closeChild.resolve()
    await rejected
    expect(consume).not.toHaveBeenCalled()
    expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.status).toBe("error")
    expect(
      workflowRunManager.deferOwnedRuntimeWorkflowSettlement(f.token, async () => {})
    ).toMatchObject({
      deferred: false,
      failure: expect.any(Error)
    })
  } finally {
    reclaim.mockRestore()
  }
})

it("rejects an engine error whose original source finalizer fails", async () => {
  const f = await setup("error")
  workflowRunManager.deferOwnedRuntimeWorkflowSettlement(f.token, async () => {
    throw Error("ORIGINAL_SOURCE_FINALIZER_FAILED")
  })
  const consume = vi.fn(async () => {})
  const completion = f.owner.consume(consume)
  const rejected = expect(completion).rejects.toThrow("WORKFLOW_SOURCE_CLEANUP_UNCONFIRMED")
  f.release.resolve()
  f.closeChild.resolve()
  await rejected
  expect(consume).not.toHaveBeenCalled()
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).not.toBe(true)
})

it("does not accept a same-project replacement opaque token as the original workflow owner", async () => {
  const f = await setup()
  const other = issueRuntimePluginSourceToken({
    mode: "host",
    executionMode: "workflow",
    threadId: f.threadId,
    incarnationKey: "original-incarnation",
    projectId: "supplier-project",
    operationId: "another-operation",
    stageId: "implementation",
    workspace: f.root,
    packageDigest: "a".repeat(64),
    inputFingerprint: "b".repeat(64),
    plugin: {
      id: "original-installation",
      name: "supplier-example",
      version: "1.0.0",
      path: f.root,
      description: "",
      author: "",
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      createdAt: "",
      updatedAt: ""
    }
  })
  expect(() => workflowRunManager.captureHostRun(other, f.threadId, f.runId)).toThrow(
    "HOST_WORKFLOW_OWNER_CHANGED"
  )
})

it("settles a synchronous original-source rebind failure without executing or stranding its owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-source-rebind-"))
  const prior = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  const threadId = randomUUID()
  const runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const foreground = new AsyncLocalStorage<boolean>()
  const guard = () => {
    if (!foreground.getStore()) throw Error("ORIGINAL_SOURCE_REBIND_REFUSED")
  }
  const token = issueRuntimePluginSourceToken(
    {
      mode: "host",
      executionMode: "workflow",
      threadId,
      incarnationKey: "original-incarnation",
      projectId: "original-project",
      operationId: randomUUID(),
      stageId: "code",
      workspace: root,
      packageDigest: "a".repeat(64),
      inputFingerprint: "b".repeat(64),
      plugin: {
        id: "original-installation",
        name: "original",
        version: "1",
        path: root,
        description: "",
        author: "",
        enabled: true,
        skillCount: 1,
        mcpServerCount: 0,
        createdAt: "",
        updatedAt: ""
      }
    },
    guard,
    guard
  )
  const createRuntime = vi.fn(async () => {
    throw Error("MUST_NOT_EXECUTE_CHILD")
  })
  const finalized = vi.fn(async () => {})
  const reclaim = vi.spyOn(WorkflowWorktreeLedger.prototype, "reclaimAll")
  cleanup.push(async () => {
    await workflowRunManager.cancelAndWait(threadId)
    reclaim.mockRestore()
    if (prior === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = prior
    rmSync(root, { recursive: true, force: true })
  })
  const script =
    'export const meta={name:"source rebind",description:"original lifetime"}; return await agent("must not run")'
  await workflowRunManager.prepareLaunch(root, threadId)
  const launch = foreground.run(true, () =>
    withRuntimePluginSource(token, () =>
      workflowRunManager.launch({
        threadId,
        workspacePath: root,
        runId,
        script,
        scriptSha256: sha256Hex(script),
        parsed: validateWorkflowScript(script),
        notificationOwner: "managed",
        subagentDeps: {
          parentThreadId: threadId,
          isRetryableApiError: () => false,
          cleanupThread: async () => {},
          createRuntime
        }
      })
    )
  )
  expect(workflowRunManager.deferOwnedRuntimeWorkflowSettlement(token, finalized)).toEqual({
    deferred: true
  })
  await launch.whenInitialPersisted
  await workflowRunManager.waitForRunLifecycle(threadId, runId)
  expect(createRuntime).not.toHaveBeenCalled()
  expect(reclaim).toHaveBeenCalledOnce()
  expect(finalized).toHaveBeenCalledOnce()
  expect(workflowRunManager.activeRunId(threadId)).toBeUndefined()
  expect(loadWorkflowRun(root, threadId, runId)).toMatchObject({
    status: "error",
    error: "ORIGINAL_SOURCE_REBIND_REFUSED",
    agents: [],
    hostExecution: { projectId: "original-project", operationId: expect.any(String) }
  })
  expect(loadWorkflowRun(root, threadId, runId)?.result).toBeUndefined()
})
