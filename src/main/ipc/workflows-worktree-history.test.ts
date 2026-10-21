import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerWorkflowHandlers } from "./workflows"
import { getWorkflowRunsDir, loadWorkflowRunAsync } from "../agent/workflow/run-store"
import {
  persistWorkflowWorktreeRecord,
  listWorkflowWorktreeRecords,
  getWorkflowWorktreeRecordScanLimitsForTest,
  setLegacyWorktreeAppDataRootForTest
} from "../services/git-worktree"
import type { PersistedWorkflowRun, WorkflowWorktreeRecord } from "../agent/workflow/types"
import { WorkflowWorktreeLedger } from "../agent/workflow/worktree-lease"

const state = vi.hoisted(() => ({ workspace: "", active: null as string | null }))
vi.mock("electron", () => ({ ipcMain: {} }))
vi.mock("../db", () => ({
  getThreadCore: () => ({ metadata: JSON.stringify({ workspacePath: state.workspace }) })
}))
vi.mock("../agent/pending-notification-scheduler", () => ({ pendingNotificationScheduler: {} }))
vi.mock("../harness-board/auto-mode-controller", () => ({ handleAutoModeAgentCancelled: vi.fn() }))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: {
    activeRunId: () => state.active,
    getFlushFailedRun: () => undefined,
    listFlushFailedRuns: () => [],
    waitForRunLifecycle: async () => undefined,
    withWorkspaceIntegrationLease: async (
      _workspace: string,
      _owner: string,
      action: () => Promise<unknown>
    ) => action(),
    broadcastWorktreeRecord: vi.fn()
  }
}))

const threadId = "worktree-history-thread"
const runId = "wf_historyworktree"
let root: string
let dataRoot: string
let legacyRoot: string
let runPath: string
let previousHome: string | undefined
const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
const invoke = async (channel: string, payload = {}): Promise<unknown> =>
  handlers.get(channel)!({} as IpcMainInvokeEvent, { threadId, runId, ...payload })

beforeEach(() => {
  previousHome = process.env.CMB_COWORK_AGENT_HOME
  root = mkdtempSync(join(tmpdir(), "workflow-worktree-history-"))
  dataRoot = join(root, "data")
  legacyRoot = join(root, "legacy-data")
  process.env.CMB_COWORK_AGENT_HOME = dataRoot
  setLegacyWorktreeAppDataRootForTest(legacyRoot)
  state.workspace = join(root, "workspace")
  state.active = null
  mkdirSync(state.workspace)
  const directory = getWorkflowRunsDir(state.workspace, threadId)
  mkdirSync(directory, { recursive: true })
  runPath = join(directory, `${runId}.json`)
  handlers.clear()
  registerWorkflowHandlers({
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    }
  } as IpcMain)
})

afterEach(() => {
  setLegacyWorktreeAppDataRootForTest()
  if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function worktree(): WorkflowWorktreeRecord {
  return {
    id: "history-worktree",
    runId,
    threadId,
    branch: "cmbcowork/wf/history",
    directory: join(root, "checkout"),
    workspaceDirectory: join(root, "checkout"),
    sourceRoot: state.workspace,
    sourceRelativePath: ".",
    sourceBranch: "main",
    gitRoot: state.workspace,
    commonDir: join(root, "repository.git"),
    baseCommit: "a".repeat(40),
    dirty: false,
    status: "ready",
    updatedAt: "2026-10-21T00:00:00.000Z"
  }
}

function writeRun(worktrees: unknown[] = [], status: "running" | "completed" = "completed"): void {
  const run: PersistedWorkflowRun = {
    version: 1,
    runId,
    threadId,
    workflowName: "Worktree history",
    script: "return 'saved result'",
    scriptSha256: "history",
    status,
    phases: [],
    currentPhase: null,
    agents: [],
    logs: ["saved execution log"],
    result: { text: "saved result" },
    worktrees: worktrees as WorkflowWorktreeRecord[],
    journal: [],
    stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 1 },
    startedAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:01.000Z",
    notificationDelivered: true
  }
  writeFileSync(runPath, JSON.stringify(run))
}

describe("workflow history with real worktree metadata", () => {
  it.each(["merge driver diagnostics\n", "合并诊断😀\n"])(
    "keeps failed-merge metadata readable with large real merge-driver diagnostics (%j)",
    async (diagnostic) => {
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync("git", ["-C", cwd, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }).trim()
      git(state.workspace, "init", "--initial-branch=main")
      git(state.workspace, "config", "user.name", "Workflow Regression")
      git(state.workspace, "config", "user.email", "workflow@example.invalid")
      git(state.workspace, "config", "core.autocrlf", "false")
      const driver = join(root, "merge-driver.cjs")
      writeFileSync(
        driver,
        `process.stderr.write(${JSON.stringify(diagnostic)}.repeat(20000)+"diagnostic end");process.exitCode=1`
      )
      const quote = (value: string): string =>
        `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
      git(
        state.workspace,
        "config",
        "merge.pressure.driver",
        `${quote(process.execPath)} ${quote(driver)}`
      )
      writeFileSync(join(state.workspace, ".gitattributes"), "*.txt merge=pressure\n")
      writeFileSync(join(state.workspace, "conflict.txt"), "base\n")
      git(state.workspace, "add", ".")
      git(state.workspace, "commit", "-m", "base")
      let record: WorkflowWorktreeRecord | undefined
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: state.workspace,
        runId,
        threadId,
        onRecordChange: (next) => {
          record = next
        }
      })
      const info = await ledger.acquire("merge-diagnostics")
      writeFileSync(join(info.directory, "conflict.txt"), "deliverable\n")
      git(info.directory, "add", ".")
      git(info.directory, "commit", "-m", "deliverable")
      await ledger.settle(info, { succeeded: true })
      expect(record?.status).toBe("ready")
      writeRun([record])
      writeFileSync(join(state.workspace, "conflict.txt"), "source\n")
      git(state.workspace, "add", ".")
      git(state.workspace, "commit", "-m", "source")
      const sourceHead = git(state.workspace, "rev-parse", "HEAD")
      const deliverableHead = git(info.directory, "rev-parse", "HEAD")
      await expect(
        invoke("workflow:worktree-action", { worktreeId: info.name, action: "merge" })
      ).rejects.toMatchObject({
        code: "merge-conflict",
        message: expect.stringContaining("diagnostic truncated")
      })
      const [manifest] = await listWorkflowWorktreeRecords(info.commonDir)
      expect(manifest).toMatchObject({
        ...record,
        status: "recoverable",
        updatedAt: expect.any(String),
        error: expect.stringContaining("diagnostic truncated")
      })
      expect(manifest.error!.length).toBeLessThanOrEqual(8 * 1024)
      expect(manifest.error).toContain("diagnostic end")
      expect(manifest.error).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      )
      const recordsDir = join(
        dataRoot,
        "worktrees",
        readdirSync(join(dataRoot, "worktrees"))[0],
        ".records"
      )
      const manifestBytes = readFileSync(join(recordsDir, readdirSync(recordsDir)[0]))
      expect(manifestBytes.byteLength).toBeLessThan(
        getWorkflowWorktreeRecordScanLimitsForTest().maxRecordBytes
      )
      const detail = await invoke("workflow:get-run")
      expect(detail).toMatchObject({
        runId,
        result: { text: "saved result" },
        worktrees: [{ id: info.name, status: "recoverable", commonDir: info.commonDir }]
      })
      expect(detail).not.toHaveProperty("worktreeReadError")
      expect(git(state.workspace, "rev-parse", "HEAD")).toBe(sourceHead)
      expect(git(info.directory, "rev-parse", "HEAD")).toBe(deliverableHead)
    },
    60_000
  )

  it.each([false, true])("opens healthy completed runs (worktree: %s)", async (withWorktree) => {
    writeRun(withWorktree ? [worktree()] : [])
    await expect(invoke("workflow:get-run")).resolves.toMatchObject({
      runId,
      status: "completed",
      worktrees: withWorktree ? [worktree()] : []
    })
    expect(await invoke("workflow:get-run")).not.toHaveProperty("worktreeReadError")
  })

  it.each(["workflow:get-run", "workflow:hydrate"])(
    "%s preserves readable history when a legacy worktree lacks commonDir",
    async (channel) => {
      const record = { ...worktree(), commonDir: undefined }
      writeRun([record])
      const before = readFileSync(runPath)
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      await expect(invoke("workflow:list-runs")).resolves.toMatchObject({
        runs: [{ runId, status: "completed" }]
      })
      await expect(loadWorkflowRunAsync(state.workspace, threadId, runId)).resolves.toMatchObject({
        runId
      })
      const response = await invoke(channel)
      const run =
        channel === "workflow:hydrate" ? (response as { latestRun: unknown }).latestRun : response
      expect(run).toMatchObject({
        runId,
        status: "completed",
        logs: ["saved execution log"],
        result: { text: "saved result" },
        script: "return 'saved result'",
        worktreeReadError: expect.stringContaining("只读")
      })
      expect(warning).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ threadId, runId })
      )
      expect(readFileSync(runPath)).toEqual(before)
    }
  )

  it("retains ownership conflicts while serving details, then clears the warning on retry", async () => {
    const record = worktree()
    await persistWorkflowWorktreeRecord(record, dataRoot)
    await persistWorkflowWorktreeRecord(
      { ...record, directory: join(root, "other-checkout") },
      legacyRoot
    )
    writeRun([record])
    const before = readFileSync(runPath)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(invoke("workflow:get-run")).resolves.toHaveProperty("worktreeReadError")
    await expect(invoke("workflow:hydrate")).resolves.toMatchObject({
      latestRun: { runId, worktreeReadError: expect.any(String) },
      hasPendingNotification: false
    })
    await expect(
      invoke("workflow:worktree-action", { worktreeId: record.id, action: "discard" })
    ).rejects.toThrow()
    expect(readFileSync(runPath)).toEqual(before)
    // Resolve the deliberately corrupted fixture externally. Application writes
    // now refuse to overwrite another owner's proof, and reads never repair it.
    const legacyRecordsDir = join(
      legacyRoot,
      "worktrees",
      readdirSync(join(legacyRoot, "worktrees"))[0],
      ".records"
    )
    writeFileSync(join(legacyRecordsDir, readdirSync(legacyRecordsDir)[0]), JSON.stringify(record))
    expect(await invoke("workflow:get-run")).not.toHaveProperty("worktreeReadError")
    expect(readFileSync(runPath)).toEqual(before)
  })

  it.each(["workflow:get-run", "workflow:hydrate"])(
    "%s also isolates worktree failures after large-record worker parsing",
    async (channel) => {
      writeRun([{ ...worktree(), commonDir: undefined }])
      const persisted = JSON.parse(readFileSync(runPath, "utf8")) as PersistedWorkflowRun
      persisted.script += `\n//${"x".repeat(300 * 1024)}`
      writeFileSync(runPath, JSON.stringify(persisted))
      const before = readFileSync(runPath)
      vi.spyOn(console, "warn").mockImplementation(() => undefined)
      const response = await invoke(channel)
      const run =
        channel === "workflow:hydrate" ? (response as { latestRun: unknown }).latestRun : response
      expect(run).toMatchObject({
        runId,
        result: { text: "saved result" },
        worktreeReadError: expect.any(String),
        journal: []
      })
      expect(readFileSync(runPath)).toEqual(before)
    }
  )

  it("does not reconcile an actively running worktree", async () => {
    state.active = runId
    writeRun([{ id: "incomplete-worktree", status: "running" }], "running")
    await expect(invoke("workflow:get-run")).resolves.toMatchObject({ runId, status: "running" })
    expect(await invoke("workflow:get-run")).not.toHaveProperty("worktreeReadError")
  })

  it("still returns null for a genuinely missing run", async () => {
    await expect(invoke("workflow:get-run")).resolves.toBeNull()
  })
})
