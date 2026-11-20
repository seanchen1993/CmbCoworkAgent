import { mkdtempSync, mkdirSync, rmSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createWorkflowRunStore,
  getWorkflowRunsDir,
  loadWorkflowRunForResumeAsync,
  persistAgentToolStream,
  readAgentToolStream,
  resetWorkflowRunIndexCacheForTest
} from "../agent/workflow/run-store"
import type { PersistedWorkflowRun } from "../agent/workflow/types"
import { registerWorkflowHandlers } from "./workflows"

const state = vi.hoisted(() => ({ workspacePath: "", activeRunId: null as string | null }))
vi.mock("electron", () => ({ ipcMain: {} }))
vi.mock("../db", () => ({
  getThreadCore: () => ({ metadata: JSON.stringify({ workspacePath: state.workspacePath }) })
}))
vi.mock("../agent/pending-notification-scheduler", () => ({ pendingNotificationScheduler: {} }))
vi.mock("../harness-board/auto-mode-controller", () => ({ handleAutoModeAgentCancelled: vi.fn() }))
vi.mock("../services/git-worktree", () => ({ identifyRepository: async () => null }))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    activeRunId: () => state.activeRunId,
    getFlushFailedRun: () => undefined,
    listFlushFailedRuns: () => []
  }
}))

const threadId = "workflow-history-thread"
const runId = "wf_history01"
const toolStreamKey = "completed_c0"
const messages = [{ type: "ai", content: "Earlier agent completed successfully" }]

describe.each([undefined, "desktop", "managed"] as const)(
  "workflow IPC persisted reads (notification owner: %s)",
  (notificationOwner) => {
    let root: string
    let previousHome: string | undefined
    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    const invoke = async (channel: string, payload = {}): Promise<unknown> =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, { threadId, runId, ...payload })

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "workflow-ipc-history-"))
      state.workspacePath = join(root, "worktree")
      mkdirSync(state.workspacePath)
      previousHome = process.env.CMB_COWORK_AGENT_HOME
      process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
      state.activeRunId = runId
      handlers.clear()
      registerWorkflowHandlers({
        handle: (channel, listener) => {
          handlers.set(channel, listener)
        }
      } as IpcMain)
    })

    afterEach(() => {
      if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
      else process.env.CMB_COWORK_AGENT_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    })

    async function persistRun(scriptKiB: number): Promise<void> {
      const initial: PersistedWorkflowRun = {
        version: 1,
        runId,
        threadId,
        workflowName: "Persisted history",
        // Both sizes are valid scripts. Only the larger one uses the Worker reader.
        script: `export const meta = { name: "History", description: "Regression" };\n/*${"x".repeat(scriptKiB * 1024)}*/`,
        scriptSha256: "history-regression",
        status: state.activeRunId ? "running" : "completed",
        phases: [],
        currentPhase: null,
        agents: [
          {
            index: 0,
            label: "Earlier agent",
            phase: null,
            status: "completed",
            outputTokens: 5,
            toolStreamKey,
            startedAt: "2026-10-14T00:00:00.000Z"
          },
          {
            index: 1,
            label: "Later agent",
            phase: null,
            status: state.activeRunId ? "running" : "completed",
            outputTokens: 0,
            startedAt: "2026-10-14T00:00:01.000Z"
          }
        ],
        logs: [],
        journal: [],
        stats: {
          agentsTotal: 2,
          agentsCached: 0,
          agentsFailed: 0,
          outputTokens: 5,
          durationMs: 1000
        },
        startedAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:02.000Z",
        notificationDelivered: true,
        notificationOwner
      }
      const store = createWorkflowRunStore({
        workspacePath: state.workspacePath,
        threadId,
        initial
      })
      expect(await store.whenInitialPersisted).toBe(true)
      expect(await store.flush()).toBe(true)
      persistAgentToolStream(state.workspacePath, threadId, runId, toolStreamKey, { messages })
      // Drain the sidecar write before cleanup, even when the IPC regression fails.
      expect(
        await readAgentToolStream(state.workspacePath, threadId, runId, toolStreamKey)
      ).toMatchObject(messages)
    }

    it.each([200, 300])("loads earlier agents while a %i KiB run is active", async (scriptKiB) => {
      await persistRun(scriptKiB)
      await expect(
        invoke("workflow:get-agent-toolstream", { agentIndex: 0 })
      ).resolves.toMatchObject(messages)
      await expect(invoke("workflow:get-run")).resolves.toMatchObject({
        runId,
        status: "running",
        ...(notificationOwner ? { notificationOwner } : {})
      })
    })

    it.each([200, 300])(
      "restores a completed %i KiB run in history after restart",
      async (scriptKiB) => {
        state.activeRunId = null
        await persistRun(scriptKiB)
        // Simulate cold discovery with a stale summary/index, requiring a real run read.
        const runPath = join(getWorkflowRunsDir(state.workspacePath, threadId), `${runId}.json`)
        const newer = new Date(Date.now() + 2000)
        utimesSync(runPath, newer, newer)
        resetWorkflowRunIndexCacheForTest(state.workspacePath, threadId)
        await expect(invoke("workflow:list-runs")).resolves.toMatchObject({
          runs: [{ runId, status: "completed" }],
          nextCursor: null
        })
        await expect(invoke("workflow:hydrate")).resolves.toMatchObject({
          latestRun: {
            runId,
            status: "completed",
            ...(notificationOwner ? { notificationOwner } : {})
          },
          activeRunId: null
        })
        await expect(
          loadWorkflowRunForResumeAsync(state.workspacePath, threadId, runId)
        ).resolves.toMatchObject({ runId, ...(notificationOwner ? { notificationOwner } : {}) })
      }
    )
  }
)
