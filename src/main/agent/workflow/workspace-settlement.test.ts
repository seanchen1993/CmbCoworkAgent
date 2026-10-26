import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertWorkspaceWorkflowRunsSettled,
  getLegacyWorkflowRunsDir,
  getManagedWorkflowRunsDir,
  loadWorkflowRunAsync
} from "./run-store"
import type { PersistedWorkflowRun } from "./types"

let root: string
let previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-settlement-"))
  previous = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = join(root, "app-data")
})
afterEach(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  rmSync(root, { recursive: true, force: true })
})

function writeRun(workspace: string, status: PersistedWorkflowRun["status"], legacy = false) {
  mkdirSync(workspace, { recursive: true })
  const directory = (legacy ? getLegacyWorkflowRunsDir : getManagedWorkflowRunsDir)(
    workspace,
    "thread"
  )
  mkdirSync(directory, { recursive: true })
  const run: PersistedWorkflowRun = {
    version: 1,
    runId: "wf_abc123",
    threadId: "thread",
    workflowName: "workflow",
    script: "return null",
    scriptSha256: "digest",
    status,
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
  const path = join(directory, `${run.runId}.json`)
  writeFileSync(path, JSON.stringify(run))
  return { path, run }
}

describe("cold workspace settlement", () => {
  it.each([false, true])("rejects an unsettled descendant (legacy=%s)", async (legacy) => {
    const workspace = join(root, "workspace")
    writeRun(join(workspace, "child"), "error", legacy)
    await expect(
      assertWorkspaceWorkflowRunsSettled(workspace, [join(workspace, "child")])
    ).rejects.toThrow("UNCONFIRMED")
  })

  it.each([false, true])("rejects an unsettled ancestor (legacy=%s)", async (legacy) => {
    const workspace = join(root, "workspace")
    writeRun(workspace, "aborted", legacy)
    const child = join(workspace, "child")
    mkdirSync(child)
    await expect(assertWorkspaceWorkflowRunsSettled(child)).rejects.toThrow("UNCONFIRMED")
  })

  it("does not block unrelated workspace histories", async () => {
    const workspace = join(root, "selected")
    mkdirSync(workspace)
    writeRun(join(root, "unrelated"), "error")
    await expect(assertWorkspaceWorkflowRunsSettled(workspace)).resolves.toBeDefined()
  })

  it("ignores unrelated new buckets but rejects a new overlapping owner", async () => {
    const workspace = join(root, "selected")
    mkdirSync(workspace)
    const guard = await assertWorkspaceWorkflowRunsSettled(workspace)
    writeRun(join(root, "unrelated"), "error")
    expect(() => guard.assertCurrent()).not.toThrow()
    writeRun(join(workspace, "child"), "error")
    expect(() => guard.assertCurrent()).toThrow("RESOURCES_CHANGED")
  })

  it("reports incomplete discovery when the registered workspace budget is exceeded", async () => {
    await expect(assertWorkspaceWorkflowRunsSettled(root, Array(4097).fill(root))).rejects.toThrow(
      "SCAN_INCOMPLETE"
    )
  })

  it("retains conservative separator collision and truncated bucket matches", async () => {
    const workspace = join(root, "a-b")
    mkdirSync(workspace)
    writeRun(join(root, "a", "b", "child"), "error")
    await expect(assertWorkspaceWorkflowRunsSettled(workspace)).rejects.toThrow("UNCONFIRMED")
    const long = join(root, "p".repeat(100), "q".repeat(100))
    writeRun(join(long, "child"), "error")
    await expect(assertWorkspaceWorkflowRunsSettled(long)).rejects.toThrow("UNCONFIRMED")
  })

  it("rechecks original file and directory identities after scanning", async () => {
    const workspace = join(root, "workspace")
    const { path, run } = writeRun(join(workspace, "child"), "completed")
    const guard = await assertWorkspaceWorkflowRunsSettled(workspace)
    guard.assertCurrent()
    writeFileSync(path, JSON.stringify({ ...run, status: "error" }))
    expect(() => guard.assertCurrent()).toThrow("RESOURCES_CHANGED")
  })

  it("reads a large native parent run through the real worker parser", async () => {
    const workspace = join(root, "workspace")
    const { path, run } = writeRun(workspace, "completed")
    const nativeParent = {
      threadId: "thread",
      incarnation: "incarnation",
      provider: "mods",
      digest: "digest"
    }
    writeFileSync(
      path,
      JSON.stringify({
        ...run,
        nativeParent,
        logs: Array.from({ length: 100 }, () => "x".repeat(7000))
      })
    )
    expect(readFileSync(path).length).toBeGreaterThan(512 * 1024)
    expect((await loadWorkflowRunAsync(workspace, "thread", run.runId))?.nativeParent).toEqual(
      nativeParent
    )
  })
})
