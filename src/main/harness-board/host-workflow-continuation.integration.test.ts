// Original manager/engine/persistence/notification owner; deterministic child model only.
// This is not the separate actual Host + IPC + model acceptance test.
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
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
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { createHostWorkflowContinuation } from "./host-workflow-continuation"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "host-workflow-result-"))
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
    assertCurrent: guard
  })
  const script =
    'export const meta={name:"supplier",description:"result handoff"}; return await agent("inspect")'
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
    revoke: () => {
      live = false
    }
  }
}

it("waits the original physical tail, claims exactly its managed notice, then verifies persisted delivery", async () => {
  const f = await setup()
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

it("cannot count a successful callback without the original notification delivery acknowledgement", async () => {
  const f = await setup()
  f.release.resolve()
  f.closeChild.resolve()
  await expect(f.owner.consume(async () => {})).rejects.toThrow("NOT_CONSUMED")
  expect(loadWorkflowRun(f.root, f.threadId, f.runId)?.notificationDelivered).not.toBe(true)
})

it("does not run a result model after the original authority changes during physical cleanup", async () => {
  const f = await setup()
  const consume = vi.fn(async () => {})
  const completion = f.owner.consume(consume)
  const rejected = expect(completion).rejects.toThrow("ACTUAL_OWNER_REVOKED")
  f.release.resolve()
  await f.cleaned.promise
  f.revoke()
  f.closeChild.resolve()
  await rejected
  expect(consume).not.toHaveBeenCalled()
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
