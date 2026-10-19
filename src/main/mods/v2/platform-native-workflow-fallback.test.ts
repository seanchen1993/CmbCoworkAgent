import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "fallback-test", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: {
    handle() {
      /* No IPC registration is needed by this native-service fixture. */
    },
    on() {
      /* No IPC listener is needed by this native-service fixture. */
    }
  }
}))

import { nativePlatformProviders } from "./platform-native-providers"
import { workflowRunManager } from "../../agent/workflow/run-manager"
import {
  createWorkflowRunStore,
  generateWorkflowRunId,
  runFilePath
} from "../../agent/workflow/run-store"
import type { PersistedWorkflowRun } from "../../agent/workflow/types"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

let root: string, workspace: string
const threadId = "native-fallback-thread"
const originalManager = workflowRunManager as unknown as {
  captureFlushFailedRun(
    request: { runId: string; threadId: string; workspacePath: string },
    snapshot: { run: PersistedWorkflowRun; journalSource: "inline"; reservedBytes: number }
  ): void
}
const record = (runId: string, status: "running" | "completed"): PersistedWorkflowRun => ({
  version: 1,
  runId,
  threadId,
  workflowName: "fallback",
  script: "x",
  scriptSha256: "s",
  status,
  phases: [],
  currentPhase: null,
  agents: [],
  logs: [],
  journal: [],
  stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
  startedAt: "2026-10-17T09:00:00.000Z",
  updatedAt: "2026-10-17T09:01:00.000Z"
})
const context = (path = workspace): NativePlatformCallContext => ({
  workspace: path,
  threadId,
  incarnation: "test",
  generation: "test",
  caller: { provider: "reader", name: "reader", digest: "reader", generation: "test" },
  signal: new AbortController().signal,
  assertCurrent() {
    /* The original manager scope is the boundary under test. */
  },
  publish() {
    /* Direct provider reads do not consume subscription events. */
  },
  invoke: async () => {
    throw Error("not used")
  }
})
const capture = (run: PersistedWorkflowRun) =>
  originalManager.captureFlushFailedRun(
    { runId: run.runId, threadId, workspacePath: workspace },
    { run, journalSource: "inline", reservedBytes: 1024 }
  )

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-workflow-fallback-"))
  workspace = mkdtempSync(join(tmpdir(), "native-workflow-source-"))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
})
afterEach(() => {
  workflowRunManager.forgetThread(threadId)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

it("reads the original terminal fallback instead of its stale running disk copy", async () => {
  const runId = generateWorkflowRunId()
  const store = createWorkflowRunStore({
    workspacePath: workspace,
    threadId,
    initial: record(runId, "running")
  })
  expect(await store.flush()).toBe(true)
  capture(record(runId, "completed"))
  const provider = nativePlatformProviders(async () => false)[0]
  expect(await provider.read!(context())).toMatchObject({
    activeRunId: null,
    run: { status: "completed" }
  })
  expect(await provider.act(context(), "inspect", { runId })).toMatchObject({
    run: { status: "completed" }
  })
})

it("includes memory-only terminal results but refuses another workspace", async () => {
  const runId = generateWorkflowRunId()
  capture(record(runId, "completed"))
  const provider = nativePlatformProviders(async () => false)[0]
  expect(await provider.read!(context())).toMatchObject({ run: { runId, status: "completed" } })
  expect(await provider.read!(context(root))).toMatchObject({ run: null })
  expect(await provider.act(context(root), "inspect", { runId })).toMatchObject({ found: false })
})

it("marks an inactive persisted running record unconfirmed", async () => {
  const runId = generateWorkflowRunId()
  const store = createWorkflowRunStore({
    workspacePath: workspace,
    threadId,
    initial: record(runId, "running")
  })
  expect(await store.flush()).toBe(true)
  expect(await nativePlatformProviders(async () => false)[0].read!(context())).toMatchObject({
    status: "unknown",
    reason: "WORKFLOW_TERMINAL_STATE_UNCONFIRMED",
    activeRunId: null
  })
})

it("reports a selected unavailable latest run instead of ready with no result", async () => {
  const runId = generateWorkflowRunId()
  const store = createWorkflowRunStore({
    workspacePath: workspace,
    threadId,
    initial: record(runId, "completed")
  })
  expect(await store.flush()).toBe(true)
  const provider = nativePlatformProviders(async () => false)[0]
  expect(await provider.read!(context())).toMatchObject({ run: { runId } })
  const path = runFilePath(workspace, threadId, runId)
  rmSync(path, { force: true })
  rmSync(`${path}.bak`, { force: true })
  await expect(provider.read!(context())).rejects.toThrow("WORKFLOW_OBSERVATION_UNAVAILABLE")
})
