import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "cmb-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import {
  getWorkflowManagerCacheDiagnosticsForTest,
  prepareWorkflowWorkspaceKeyForTest,
  setBeforeWorkflowWorkspaceKeyResolutionForTest,
  workflowRunManager
} from "./run-manager"

afterEach(() => {
  setBeforeWorkflowWorkspaceKeyResolutionForTest()
})

describe("workflow manager cache bounds", () => {
  test("bounds canonical workspace identities across long-lived switching", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workspace-key-cache-"))
    const { workspaceKeyMaxEntries } = getWorkflowManagerCacheDiagnosticsForTest()
    try {
      for (let index = 0; index < workspaceKeyMaxEntries + 8; index += 1) {
        await prepareWorkflowWorkspaceKeyForTest(join(root, `workspace-${index}`))
      }
      const diagnostics = getWorkflowManagerCacheDiagnosticsForTest()
      expect(diagnostics.workspaceKeyEntries).toBeLessThanOrEqual(
        diagnostics.workspaceKeyMaxEntries
      )
      expect(diagnostics.workspaceKeyInFlight).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("hard-bounds distinct in-flight workspace canonicalizations", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workspace-key-admission-"))
    const before = getWorkflowManagerCacheDiagnosticsForTest()
    let entered = 0
    let notifyFull!: () => void
    const full = new Promise<void>((resolveFull) => {
      notifyFull = resolveFull
    })
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    setBeforeWorkflowWorkspaceKeyResolutionForTest(async (path) => {
      if (!path.includes("admission-workspace-")) return
      entered += 1
      if (entered === before.workspaceKeyMaxInFlight) notifyFull()
      await gate
    })
    const admitted = Array.from({ length: before.workspaceKeyMaxInFlight }, (_, index) =>
      prepareWorkflowWorkspaceKeyForTest(join(root, `admission-workspace-${index}`))
    )
    try {
      await full
      await expect(
        prepareWorkflowWorkspaceKeyForTest(join(root, "admission-workspace-overflow"))
      ).rejects.toThrow("workflow workspace resolver is busy")
      const busy = getWorkflowManagerCacheDiagnosticsForTest()
      expect(busy.workspaceKeyInFlight).toBeLessThanOrEqual(busy.workspaceKeyMaxInFlight)
      expect(busy.workspaceKeyAdmissionRejected).toBeGreaterThan(
        before.workspaceKeyAdmissionRejected
      )
    } finally {
      release()
      await Promise.allSettled(admitted)
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("coalesces duplicate workspace canonicalizations into one admission slot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmb-workspace-key-single-flight-"))
    const path = join(root, "single-flight-workspace")
    let entered = 0
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    setBeforeWorkflowWorkspaceKeyResolutionForTest(async (candidate) => {
      if (candidate !== path) return
      entered += 1
      await gate
    })
    const requests = Array.from({ length: 20 }, () =>
      prepareWorkflowWorkspaceKeyForTest(path)
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(entered).toBe(1)
    release()
    const resolved = await Promise.all(requests)
    expect(new Set(resolved).size).toBe(1)
    await rm(root, { recursive: true, force: true })
  })

  test("bounds repeated thread-transition requests while preserving FIFO", async () => {
    const threadId = "thread-transition-admission"
    const before = getWorkflowManagerCacheDiagnosticsForTest()
    const order: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate
    })
    const admitted = Array.from({ length: before.threadTransitionsMaxPerThread }, (_, index) =>
      workflowRunManager.withThreadTransitionLease(threadId, async () => {
        order.push(index)
        if (index === 0) await firstGate
      })
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(
      workflowRunManager.withThreadTransitionLease(threadId, async () => undefined)
    ).rejects.toThrow("workflow thread transition queue is busy")
    releaseFirst()
    await Promise.all(admitted)

    expect(order).toEqual(
      Array.from({ length: before.threadTransitionsMaxPerThread }, (_, index) => index)
    )
    const after = getWorkflowManagerCacheDiagnosticsForTest()
    expect(after.threadTransitionsPending).toBe(0)
    expect(after.threadTransitionAdmissionRejected).toBeGreaterThan(
      before.threadTransitionAdmissionRejected
    )
  })

  test("forgets exhausted persisted-run retry state on thread deletion", () => {
    const threadId = "thread-renotify-forget"
    const runId = "wf_renotifyforget"
    expect(workflowRunManager.renotify(threadId, runId)).toBe(true)
    expect(workflowRunManager.renotify(threadId, runId)).toBe(true)
    expect(workflowRunManager.renotify(threadId, runId)).toBe(true)
    expect(workflowRunManager.renotify(threadId, runId)).toBe(false)
    expect(workflowRunManager.isRenotifyExhausted(runId)).toBe(true)

    workflowRunManager.forgetThread(threadId)

    expect(workflowRunManager.isRenotifyExhausted(runId)).toBe(false)
  })

  test("bounds exhausted notification retry records with LRU eviction", () => {
    const before = getWorkflowManagerCacheDiagnosticsForTest()
    const created: Array<{ threadId: string; runId: string }> = []
    for (let index = 0; index < before.renotifyMaxEntries + 8; index += 1) {
      const threadId = `thread-renotify-bound-${index}`
      const runId = `wf_retry${index.toString().padStart(8, "0")}`
      created.push({ threadId, runId })
      for (let attempt = 0; attempt < 4; attempt += 1) {
        workflowRunManager.renotify(threadId, runId)
      }
    }
    expect(getWorkflowManagerCacheDiagnosticsForTest().renotifyEntries).toBeLessThanOrEqual(
      before.renotifyMaxEntries
    )
    for (const { threadId } of created) workflowRunManager.forgetThread(threadId)
  })
})
