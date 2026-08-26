import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  deleteWorkflowRunsForThread,
  countUnresolvedWorkflowWorktrees,
  getLegacyWorkflowRunsDir,
  getManagedWorkflowRunsDir,
  getWorkflowRunsDir,
  isWorkflowRunDirDisposed,
  reviveWorkflowThread
} from "./run-store"

function writeRun(
  dir: string,
  threadId: string,
  runId = "wf_abc123",
  extra: Record<string, unknown> = {}
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${runId}.json`),
    JSON.stringify({ version: 1, runId, threadId, ...extra }),
    "utf8"
  )
}

describe("workflow run storage location", () => {
  let root: string
  let workspace: string
  let priorAppDataRoot: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cmb-workflow-location-"))
    workspace = join(root, "workspace")
    mkdirSync(workspace, { recursive: true })
    priorAppDataRoot = process.env.CMB_COWORK_AGENT_HOME
    process.env.CMB_COWORK_AGENT_HOME = join(root, "app-data")
  })

  afterEach(() => {
    if (priorAppDataRoot === undefined) delete process.env.CMB_COWORK_AGENT_HOME
    else process.env.CMB_COWORK_AGENT_HOME = priorAppDataRoot
    rmSync(root, { recursive: true, force: true })
  })

  test("new threads use app-managed storage", () => {
    const threadId = "thread-new"
    expect(getWorkflowRunsDir(workspace, threadId)).toBe(
      getManagedWorkflowRunsDir(workspace, threadId)
    )
    expect(getWorkflowRunsDir(workspace, threadId)).not.toBe(
      getLegacyWorkflowRunsDir(workspace, threadId)
    )
  })

  test("user files alone do not pin a thread to legacy storage", () => {
    const threadId = "thread-user-script"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "custom.workflow.js"), "export default {}\n", "utf8")

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(
      getManagedWorkflowRunsDir(workspace, threadId)
    )
    expect(existsSync(join(legacy, "custom.workflow.js"))).toBe(true)
  })

  test("corrupt or foreign JSON does not masquerade as legacy history", () => {
    const threadId = "thread-invalid-legacy"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "wf_bad123.json"), "{not json", "utf8")
    writeFileSync(
      join(legacy, "wf_abc123.json"),
      JSON.stringify({ version: 1, runId: "wf_abc123", threadId: "another-thread" }),
      "utf8"
    )

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(
      getManagedWorkflowRunsDir(workspace, threadId)
    )
  })

  test("a valid pre-upgrade run keeps the entire thread on legacy storage", () => {
    const threadId = "thread-legacy"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(legacy)

    // Once selected, a running thread never changes roots mid-flush.
    writeRun(managed, threadId, "wf_def456")
    expect(getWorkflowRunsDir(workspace, threadId)).toBe(legacy)
    rmSync(legacy, { recursive: true, force: true })
    expect(getWorkflowRunsDir(workspace, threadId)).toBe(legacy)
  })

  test("legacy selection is per thread, not per workspace", () => {
    const legacyThreadId = "thread-old-in-project"
    const newThreadId = "thread-new-in-project"
    writeRun(getLegacyWorkflowRunsDir(workspace, legacyThreadId), legacyThreadId)

    expect(getWorkflowRunsDir(workspace, legacyThreadId)).toBe(
      getLegacyWorkflowRunsDir(workspace, legacyThreadId)
    )
    expect(getWorkflowRunsDir(workspace, newThreadId)).toBe(
      getManagedWorkflowRunsDir(workspace, newThreadId)
    )
  })

  test("managed history is authoritative when both locations already contain runs", () => {
    const threadId = "thread-managed-wins"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)
    writeRun(managed, threadId, "wf_def456")

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(managed)
  })

  test("destructive worktree checks scan both managed and legacy runs", () => {
    const threadId = "thread-check-both"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId, "wf_legacy123", {
      worktrees: [
        {
          status: "ready",
          cleanupPending: false,
          directory: join(root, "retained-worktree")
        }
      ]
    })
    writeRun(managed, threadId, "wf_managed123", { status: "completed", worktrees: [] })

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(managed)
    expect(countUnresolvedWorkflowWorktrees(workspace, threadId)).toBe(1)
  })

  test("thread deletion fences and removes both storage layouts", () => {
    const threadId = "thread-delete-both"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)
    writeRun(managed, threadId, "wf_def456")

    deleteWorkflowRunsForThread(workspace, threadId)

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(managed)).toBe(false)
    expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(true)

    reviveWorkflowThread(threadId)
    expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(false)
    expect(getWorkflowRunsDir(workspace, threadId)).toBe(managed)
  })

  test("thread deletion clears cached selections for every workspace path alias", () => {
    const threadId = "thread-delete-aliases"
    const workspaceAlias = join(root, "workspace-alias")
    symlinkSync(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir")

    getWorkflowRunsDir(workspace, threadId)
    getWorkflowRunsDir(workspaceAlias, threadId)
    deleteWorkflowRunsForThread(workspace, threadId)

    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)
    expect(getWorkflowRunsDir(workspaceAlias, threadId)).toBe(
      getLegacyWorkflowRunsDir(workspaceAlias, threadId)
    )

    reviveWorkflowThread(threadId)
  })
})
