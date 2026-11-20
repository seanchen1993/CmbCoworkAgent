import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createWorkflowWorktree,
  discardWorkflowWorktree,
  finalizeWorkflowWorktreeRecord,
  listWorkflowWorktreeRecords,
  mergeWorkflowWorktree,
  persistWorkflowWorktreeRecord,
  setLegacyWorktreeAppDataRootForTest
} from "./git-worktree"
import { WorkflowWorktreeLedger } from "../agent/workflow/worktree-lease"
import {
  createWorkflowRunStore,
  loadWorkflowRunAsync,
  updateWorkflowWorktreeRecord
} from "../agent/workflow/run-store"
import type { PersistedWorkflowRun, WorkflowWorktreeRecord } from "../agent/workflow/types"

const nameGeneration = vi.hoisted(() => ({ suffixes: [] as string[] }))
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>()
  return {
    ...actual,
    randomBytes: (size: number) =>
      size === 4 && nameGeneration.suffixes.length
        ? Buffer.from(nameGeneration.suffixes.shift()!, "hex")
        : actual.randomBytes(size)
  }
})

let root: string
let data: string
let repo: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.CMB_COWORK_AGENT_HOME
  root = mkdtempSync(join(tmpdir(), "wf-meta-"))
  data = join(root, "data")
  repo = join(root, "项目 with spaces")
  process.env.CMB_COWORK_AGENT_HOME = data
  setLegacyWorktreeAppDataRootForTest(join(root, "legacy"))
})

afterEach(() => {
  nameGeneration.suffixes.length = 0
  setLegacyWorktreeAppDataRootForTest()
  if (previousHome === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

function record(): WorkflowWorktreeRecord {
  return {
    id: "owned-worktree",
    runId: "wf_metadata",
    threadId: "metadata-thread",
    branch: "cmbcowork/wf/metadata/agent",
    directory: join(data, "checkout"),
    workspaceDirectory: join(data, "checkout"),
    sourceRoot: repo,
    sourceRelativePath: "",
    sourceBranch: "main",
    gitRoot: repo,
    commonDir: join(repo, ".git"),
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    dirty: false,
    status: "running",
    updatedAt: "2026-10-21T00:00:00.000Z"
  }
}

function manifestPath(): string {
  const directory = join(data, "worktrees", readdirSync(join(data, "worktrees"))[0], ".records")
  return join(directory, readdirSync(directory)[0])
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

describe("new workflow worktree metadata writes", () => {
  it.each(["configured", "legacy"])(
    "reserves terminal manifest IDs when resuming from the %s root",
    async (scope) => {
      mkdirSync(repo)
      git(repo, "init", "--initial-branch=main")
      git(repo, "config", "user.name", "Workflow Regression")
      git(repo, "config", "user.email", "workflow@example.invalid")
      git(repo, "config", "core.autocrlf", "false")
      writeFileSync(join(repo, "base.txt"), "base\n")
      git(repo, "add", ".")
      git(repo, "commit", "-m", "base")
      const previousRoot = scope === "legacy" ? join(root, "legacy") : data
      let ready: WorkflowWorktreeRecord | undefined
      const ledger = new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId: "wf_metadata",
        threadId: "metadata-thread",
        appDataRoot: previousRoot,
        onRecordChange: (next) => {
          ready = next
        }
      })
      const old = await ledger.acquire("same-agent")
      writeFileSync(join(old.directory, "deliverable.txt"), "deliverable\n")
      git(old.directory, "add", ".")
      git(old.directory, "commit", "-m", "deliverable")
      await ledger.settle(old, { succeeded: true })
      await discardWorkflowWorktree({
        workspacePath: repo,
        record: ready!,
        appDataRoot: previousRoot
      })
      const recordsDir = join(
        previousRoot,
        "worktrees",
        readdirSync(join(previousRoot, "worktrees"))[0],
        ".records"
      )
      const oldManifest = join(recordsDir, readdirSync(recordsDir)[0])
      const before = readFileSync(oldManifest)
      expect(existsSync(old.directory)).toBe(false)
      writeFileSync(join(repo, "next-base.txt"), "source advanced before resume\n")
      git(repo, "add", ".")
      git(repo, "commit", "-m", "advance source")
      // Exercise a possible random-name collision deterministically. Only normal
      // lifecycle APIs created the old ownership record; no manifest is fabricated.
      nameGeneration.suffixes.push(old.name.split("-").at(-1)!, "0123abcd")
      const next = await createWorkflowWorktree({
        workspacePath: repo,
        runId: "wf_metadata",
        threadId: "metadata-thread",
        label: "same-agent",
        persistOwnership: true
      })
      expect(next.name).not.toBe(old.name)
      await expect(listWorkflowWorktreeRecords(old.commonDir)).resolves.toHaveLength(2)
      expect(readFileSync(oldManifest)).toEqual(before)
    },
    60_000
  )

  it.each(["commonDir", "directory", "runId", "threadId", "sourceRoot", "baseCommit"])(
    "rejects a missing %s before creating any files",
    async (field) => {
      const incomplete = { ...record(), [field]: undefined } as unknown as WorkflowWorktreeRecord
      await expect(persistWorkflowWorktreeRecord(incomplete, data)).rejects.toThrow(/invalid/)
      expect(existsSync(data)).toBe(false)
    }
  )

  it.each(["", "   "])("rejects an empty common directory (%j)", async (commonDir) => {
    await expect(persistWorkflowWorktreeRecord({ ...record(), commonDir }, data)).rejects.toThrow(
      /invalid/
    )
    expect(existsSync(data)).toBe(false)
  })

  it("rejects oversized UTF-8 records without replacing readable metadata", async () => {
    const current = record()
    await persistWorkflowWorktreeRecord(current, data)
    const path = manifestPath()
    const before = readFileSync(path)
    await expect(
      persistWorkflowWorktreeRecord({ ...current, error: "诊断".repeat(100000) }, data)
    ).rejects.toThrow(/record-byte limit/)
    expect(readFileSync(path)).toEqual(before)
    await expect(listWorkflowWorktreeRecords(current.commonDir, data)).resolves.toMatchObject([
      { id: current.id }
    ])
  })

  it("serializes competing owners and keeps the original ownership immutable", async () => {
    const first = record()
    const other = {
      ...first,
      directory: join(data, "different-checkout"),
      threadId: "different-thread"
    }
    const results = await Promise.allSettled([
      persistWorkflowWorktreeRecord(first, data),
      persistWorkflowWorktreeRecord(other, data)
    ])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("different worktree ownership")
      })
    })
    expect(JSON.parse(readFileSync(manifestPath(), "utf8"))).toEqual(first)
    await persistWorkflowWorktreeRecord({ ...first, status: "ready" }, data)
    await expect(listWorkflowWorktreeRecords(first.commonDir, data)).resolves.toMatchObject([
      { ...first, status: "ready" }
    ])
  })

  it("captures the write's ownership before an asynchronous caller mutation", async () => {
    const current = record()
    const expected = { ...current }
    const pending = persistWorkflowWorktreeRecord(current, data)
    current.threadId = "later-owner"
    await pending
    expect(JSON.parse(readFileSync(manifestPath(), "utf8"))).toEqual(expected)
  })

  it("does not repair or replace an unreadable existing proof", async () => {
    const current = record()
    await persistWorkflowWorktreeRecord(current, data)
    const path = manifestPath()
    const invalid = "{incomplete existing ownership"
    writeFileSync(path, invalid)
    await expect(
      persistWorkflowWorktreeRecord({ ...current, status: "ready" }, data)
    ).rejects.toThrow()
    expect(readFileSync(path, "utf8")).toBe(invalid)
  })

  it("preserves full ownership through create, settle, resume, merge, discard and async reload", async () => {
    mkdirSync(repo)
    git(repo, "init", "--initial-branch=main")
    git(repo, "config", "user.name", "Workflow Regression")
    git(repo, "config", "user.email", "workflow@example.invalid")
    git(repo, "config", "core.autocrlf", "false")
    writeFileSync(join(repo, "base.txt"), "base\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "base")
    const runId = "wf_metadata"
    const threadId = "metadata-thread"
    const now = new Date().toISOString()
    const initial: PersistedWorkflowRun = {
      version: 1,
      runId,
      threadId,
      workflowName: "metadata lifecycle",
      script: `return null\n//${"x".repeat(300 * 1024)}`,
      scriptSha256: "metadata",
      status: "running",
      phases: [],
      currentPhase: null,
      agents: [],
      worktrees: [],
      logs: [],
      journal: [],
      stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
      startedAt: now,
      updatedAt: now
    }
    let store = createWorkflowRunStore({ workspacePath: repo, threadId, initial })
    await store.whenInitialPersisted
    const ledger = (): WorkflowWorktreeLedger =>
      new WorkflowWorktreeLedger({
        workspacePath: repo,
        runId,
        threadId,
        onRecordChange: (next) =>
          store.update((state) => {
            const others = (state.worktrees ?? []).filter((candidate) => candidate.id !== next.id)
            state.worktrees = [...others, next]
          })
      })
    const first = ledger()
    const firstInfo = await first.acquire("same-agent")
    expect(store.state.worktrees?.[0]).toMatchObject({
      commonDir: firstInfo.commonDir,
      status: "running"
    })
    writeFileSync(join(firstInfo.directory, "first.txt"), "first deliverable\n")
    git(firstInfo.directory, "add", ".")
    git(firstInfo.directory, "commit", "-m", "first")
    await first.settle(firstInfo, { succeeded: true })
    store.update((state) => {
      state.status = "completed"
    })
    await store.flush()
    const saved = await loadWorkflowRunAsync(repo, threadId, runId)
    expect(saved?.worktrees?.[0].commonDir).toBe(firstInfo.commonDir)
    store = createWorkflowRunStore({
      workspacePath: repo,
      threadId,
      initial: { ...saved!, status: "running", resumed: true }
    })
    await store.whenInitialPersisted
    const resumed = ledger()
    const secondInfo = await resumed.acquire("same-agent")
    expect(secondInfo.name).not.toBe(firstInfo.name)
    writeFileSync(join(secondInfo.directory, "second.txt"), "second deliverable\n")
    git(secondInfo.directory, "add", ".")
    git(secondInfo.directory, "commit", "-m", "second")
    await resumed.settle(secondInfo, { succeeded: true })
    store.update((state) => {
      state.status = "completed"
    })
    await store.flush()
    const records = await listWorkflowWorktreeRecords(firstInfo.commonDir)
    expect(records).toHaveLength(2)
    for (const entry of records) {
      expect(entry).toMatchObject({
        runId,
        threadId,
        commonDir: firstInfo.commonDir,
        sourceRoot: firstInfo.sourceRoot,
        baseCommit: firstInfo.baseCommit,
        status: "ready"
      })
    }
    const merged = await mergeWorkflowWorktree({
      workspacePath: repo,
      record: records.find((r) => r.id === firstInfo.name)!
    })
    await updateWorkflowWorktreeRecord(repo, threadId, runId, merged.record)
    expect(await finalizeWorkflowWorktreeRecord(merged.record)).toBe(true)
    const discarded = await discardWorkflowWorktree({
      workspacePath: repo,
      record: records.find((r) => r.id === secondInfo.name)!
    })
    await updateWorkflowWorktreeRecord(repo, threadId, runId, discarded.record)
    expect(await finalizeWorkflowWorktreeRecord(discarded.record)).toBe(true)
    const final = await loadWorkflowRunAsync(repo, threadId, runId)
    expect(final?.worktrees).toHaveLength(2)
    expect(final?.worktrees?.map((r) => r.status).sort()).toEqual(["discarded", "merged"])
    for (const entry of final!.worktrees!) {
      expect(entry).toMatchObject({
        runId,
        threadId,
        commonDir: firstInfo.commonDir,
        sourceRoot: firstInfo.sourceRoot,
        baseCommit: firstInfo.baseCommit
      })
    }
    expect(existsSync(join(repo, "first.txt"))).toBe(true)
    expect(existsSync(join(repo, "second.txt"))).toBe(false)
    await expect(listWorkflowWorktreeRecords(firstInfo.commonDir)).resolves.toEqual([])
  }, 60_000)
})
