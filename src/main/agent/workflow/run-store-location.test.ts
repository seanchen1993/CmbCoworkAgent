import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "fs"
import { syncBuiltinESMExports } from "module"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  deleteWorkflowRunsForThread,
  countUnresolvedWorkflowWorktrees,
  countUnresolvedWorkflowWorktreesAsync,
  clearAllAgentToolStreams,
  createWorkflowRunStore,
  findUndeliveredTerminalRun,
  findUndeliveredTerminalRunAsync,
  getLegacyWorkflowRunsDir,
  getManagedWorkflowRunsDir,
  getWorkflowStorageCacheDiagnosticsForTest,
  getWorkflowRunLargeParseDiagnosticsForTest,
  getWorkflowRunsDir,
  hasUndeliveredWorkflowRunAsync,
  isWorkflowRunDirDisposed,
  listWorkflowRunsPage,
  loadWorkflowRunAsync,
  loadWorkflowRunForResumeAsync,
  markWorkflowRunInterrupted,
  markWorkflowRunNotified,
  pruneWorkflowRuns,
  parseLargeWorkflowRunJsonForTest,
  readWorkflowDirectoryEntriesBoundedForTest,
  resetWorkflowRunIndexCacheForTest,
  resolveWorkflowOutputFileAsync,
  reviveWorkflowThread,
  setBeforeLargeWorkflowRunParseForTest,
  setBeforeWorkflowRunDirSweepForTest,
  setBeforeWorkflowRunIndexPublishForTest,
  setBeforeWorkflowRunIndexReadForTest,
  setBeforeWorkflowRunPointReadForTest,
  setBeforeWorkflowPruneMutationForTest,
  setBeforeWorkflowJournalReadForTest,
  updateWorkflowWorktreeRecord,
  workflowResultFilePath
} from "./run-store"
import type { PersistedWorkflowRun, WorkflowWorktreeRecord } from "./types"

function writeRun(
  dir: string,
  threadId: string,
  runId = "wf_abc123",
  extra: Record<string, unknown> = {}
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${runId}.json`),
    JSON.stringify({
      version: 1,
      runId,
      threadId,
      workflowName: runId,
      script: "export default async () => null",
      scriptSha256: runId,
      status: "completed",
      phases: [],
      currentPhase: null,
      agents: [],
      worktrees: [],
      logs: [],
      journal: [],
      stats: {
        agentsTotal: 0,
        agentsCached: 0,
        agentsFailed: 0,
        outputTokens: 0,
        durationMs: 1
      },
      startedAt: `2026-01-01T00:00:${runId.slice(-2)}.000Z`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      notificationDelivered: true,
      ...extra
    }),
    "utf8"
  )
}

function makeWorktree(
  root: string,
  threadId: string,
  runId: string,
  id: string,
  status: WorkflowWorktreeRecord["status"] = "ready"
): WorkflowWorktreeRecord {
  const directory = join(root, id)
  return {
    id,
    runId,
    threadId,
    branch: `codex/${id}`,
    directory,
    workspaceDirectory: directory,
    sourceRoot: root,
    sourceRelativePath: ".",
    sourceBranch: "main",
    gitRoot: root,
    commonDir: join(root, ".git"),
    baseCommit: "a".repeat(40),
    dirty: false,
    status,
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
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
    setBeforeLargeWorkflowRunParseForTest()
    setBeforeWorkflowRunIndexPublishForTest()
    setBeforeWorkflowRunIndexReadForTest()
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

  test("legacy history stays readable while all new writes converge on managed storage", async () => {
    const threadId = "thread-legacy"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)

    expect(getWorkflowRunsDir(workspace, threadId)).toBe(managed)
    expect((await loadWorkflowRunAsync(workspace, threadId, "wf_abc123"))?.runId).toBe(
      "wf_abc123"
    )
    writeRun(managed, threadId, "wf_def456")
    expect((await listWorkflowRunsPage(workspace, threadId)).runs.map((run) => run.runId)).toEqual([
      "wf_def456",
      "wf_abc123"
    ])
  })

  test("storage selection never scans or pins a thread to the workspace legacy directory", () => {
    const legacyThreadId = "thread-old-in-project"
    const newThreadId = "thread-new-in-project"
    writeRun(getLegacyWorkflowRunsDir(workspace, legacyThreadId), legacyThreadId)

    expect(getWorkflowRunsDir(workspace, legacyThreadId)).toBe(
      getManagedWorkflowRunsDir(workspace, legacyThreadId)
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

  test("a corrupt managed duplicate falls back to the valid legacy run", async () => {
    const threadId = "thread-managed-corrupt"
    const runId = "wf_fallback123"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId, runId, { workflowName: "legacy fallback" })
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, `${runId}.json`), "{not-json", "utf8")

    const page = await listWorkflowRunsPage(workspace, threadId)
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0]).toMatchObject({ runId, workflowName: "legacy fallback" })
  })

  test("cold index keeps a valid legacy source when a managed duplicate is corrupt", async () => {
    const threadId = "thread-index-source"
    const runId = "wf_indexsource1"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId, runId, { workflowName: "legacy survives restart" })
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, `${runId}.json`), "{broken", "utf8")
    const indexPath = join(managed, "runs.index")
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            runId,
            startedAt: "2026-01-01T00:00:01.000Z",
            status: "completed",
            notificationDelivered: true,
            sourceAuthority: "workspace-legacy"
          }
        ],
        pendingNotificationRunIds: []
      }),
      "utf8"
    )
    utimesSync(indexPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"))

    await expect(listWorkflowRunsPage(workspace, threadId)).resolves.toMatchObject({
      runs: [{ runId, workflowName: "legacy survives restart" }]
    })
    expect(JSON.parse(readFileSync(indexPath, "utf8")).entries[0].sourceAuthority).toBe(
      "workspace-legacy"
    )

    resetWorkflowRunIndexCacheForTest(workspace, threadId)
    await expect(listWorkflowRunsPage(workspace, threadId)).resolves.toMatchObject({
      runs: [{ runId, workflowName: "legacy survives restart" }]
    })
  })

  test("async resume falls through corrupt journals only within the same incarnation", async () => {
    const threadId = "thread-resume-roots"
    const runId = "wf_resumeroot1"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const startedAt = "2026-03-01T00:00:00.000Z"
    const journal = [{ callHash: "same-incarnation" }]
    const managedWorktree = makeWorktree(root, threadId, runId, "resume-managed")
    const legacyWorktree = makeWorktree(root, threadId, runId, "resume-legacy")
    writeRun(managed, threadId, runId, {
      workflowName: "managed authority",
      startedAt,
      scriptSha256: "same-script",
      agents: [{ index: 0 }],
      worktrees: [managedWorktree]
    })
    writeFileSync(join(managed, `${runId}.journal`), "{broken", "utf8")
    writeRun(legacy, threadId, runId, {
      workflowName: "legacy body",
      startedAt,
      scriptSha256: "same-script",
      agents: [{ index: 0 }],
      worktrees: [legacyWorktree]
    })
    writeFileSync(join(legacy, `${runId}.journal`), JSON.stringify(journal), "utf8")

    const resumed = await loadWorkflowRunForResumeAsync(workspace, threadId, runId)
    expect(resumed).toMatchObject({ workflowName: "managed authority", journal })
    expect(resumed?.worktrees?.map((record) => record.id)).toEqual([
      "resume-managed",
      "resume-legacy"
    ])

    writeRun(legacy, threadId, runId, {
      startedAt,
      scriptSha256: "different-script",
      agents: [{ index: 0 }]
    })
    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toBeNull()

    writeRun(legacy, threadId, runId, {
      startedAt: "2026-03-01T00:00:01.000Z",
      scriptSha256: "same-script",
      agents: [{ index: 0 }]
    })
    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toBeNull()
  })

  test("async resume accepts a backup-only compatible fallback journal", async () => {
    const threadId = "thread-resume-backup"
    const runId = "wf_resumebak01"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const startedAt = "2026-03-02T00:00:00.000Z"
    writeRun(managed, threadId, runId, {
      startedAt,
      scriptSha256: "same-script",
      agents: [{ index: 0 }]
    })
    writeRun(legacy, threadId, runId, {
      startedAt,
      scriptSha256: "same-script",
      agents: [{ index: 0 }]
    })
    renameSync(join(legacy, `${runId}.json`), join(legacy, `${runId}.json.bak`))
    writeFileSync(
      join(legacy, `${runId}.journal`),
      JSON.stringify([{ callHash: "backup-journal" }]),
      "utf8"
    )

    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toMatchObject({
      journal: [{ callHash: "backup-journal" }]
    })
  })

  test("async resume rejects a replaced journal path after opening a stable capability", async () => {
    const threadId = "thread-journal-replaced"
    const runId = "wf_journalreplace1"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const journalPath = join(managed, `${runId}.journal`)
    writeRun(managed, threadId, runId, { agents: [{ index: 0 }] })
    writeFileSync(journalPath, JSON.stringify([{ callHash: "authorized" }]), "utf8")
    const displaced = `${journalPath}.displaced`
    setBeforeWorkflowJournalReadForTest((path) => {
      if (path !== journalPath) return
      renameSync(path, displaced)
      writeFileSync(path, JSON.stringify([{ callHash: "replacement" }]), "utf8")
    })
    try {
      await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toBeNull()
    } finally {
      setBeforeWorkflowJournalReadForTest()
    }
  })

  test.runIf(process.platform !== "win32")(
    "async resume rejects a journal symlink that resolves outside its run directory",
    async () => {
      const threadId = "thread-journal-outside"
      const runId = "wf_journaloutside1"
      const managed = getManagedWorkflowRunsDir(workspace, threadId)
      const outside = join(root, "outside.journal")
      writeRun(managed, threadId, runId, { agents: [{ index: 0 }] })
      writeFileSync(outside, JSON.stringify([{ callHash: "outside" }]), "utf8")
      symlinkSync(outside, join(managed, `${runId}.journal`), "file")

      await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toBeNull()
    }
  )

  test("async resume incrementally parses a large journal and yields between entries", async () => {
    const threadId = "thread-resume-large-journal"
    const runId = "wf_resumelarge01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const journal = Array.from({ length: 96 }, (_, index) => ({
      callHash: `large-journal-${index}`,
      result: "x".repeat(32 * 1024)
    }))
    writeRun(managed, threadId, runId, {
      agents: [{ index: 0 }]
    })
    writeFileSync(join(managed, `${runId}.journal`), JSON.stringify(journal), "utf8")

    const originalParse = JSON.parse
    let relevantParseCalls = 0
    let parsedAfterYield = 0
    let maxParsedChars = 0
    let yielded = false
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      const [text] = args
      if (text.includes("large-journal-")) {
        relevantParseCalls += 1
        maxParsedChars = Math.max(maxParsedChars, text.length)
        if (relevantParseCalls === 1) {
          setImmediate(() => {
            yielded = true
          })
        } else if (yielded) {
          parsedAfterYield += 1
        }
      }
      return originalParse(...args)
    }) as typeof JSON.parse
    try {
      const resumed = await loadWorkflowRunForResumeAsync(workspace, threadId, runId)
      expect(resumed?.journal).toHaveLength(journal.length)
      expect(resumed?.journal.at(-1)).toMatchObject({ callHash: "large-journal-95" })
      expect(relevantParseCalls).toBe(journal.length)
      expect(maxParsedChars).toBeLessThanOrEqual(1024 * 1024)
      expect(parsedAfterYield).toBeGreaterThan(0)
    } finally {
      JSON.parse = originalParse
    }
  })

  test("async resume rejects excessive tiny journal entries before materializing an unbounded array", async () => {
    const threadId = "thread-resume-entry-cap"
    const runId = "wf_entrycap001"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, { agents: [{ index: 0 }] })
    writeFileSync(
      join(managed, `${runId}.journal`),
      `[${Array.from({ length: 40_001 }, () => "{}").join(",")}]`,
      "utf8"
    )

    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toBeNull()
  })

  test("large legacy run JSON is parsed outside the main thread", async () => {
    const threadId = "thread-large-legacy-run"
    const runId = "wf_largelegacy01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const journal = Array.from({ length: 12 }, (_, index) => ({
      callHash: `legacy-worker-marker-${index}`,
      result: "x".repeat(32 * 1024)
    }))
    writeRun(managed, threadId, runId, { journal })

    const originalParse = JSON.parse
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      // Per-field / per-entry JSON is deliberately reconstructed on main from
      // bounded transferable chunks. What must never return is the old whole
      // multi-megabyte run JSON parse.
      if (args[0].length > 2 * 1024 * 1024 && args[0].includes("legacy-worker-marker-")) {
        throw new Error("large legacy run JSON reached the main thread")
      }
      return originalParse(...args)
    }) as typeof JSON.parse
    try {
      const loaded = await loadWorkflowRunAsync(workspace, threadId, runId)
      // History/hydrate/get-run never retain a legacy inline journal in main.
      expect(loaded?.journal).toEqual([])
      const resumed = await loadWorkflowRunForResumeAsync(workspace, threadId, runId)
      expect(resumed?.journal).toHaveLength(journal.length)
      expect(resumed?.journal.at(-1)).toMatchObject({
        callHash: "legacy-worker-marker-11"
      })
    } finally {
      JSON.parse = originalParse
    }
  })

  test("concurrent consumers single-flight one bounded large-run Worker", async () => {
    const threadId = "thread-large-single-flight"
    const runId = "wf_largeflight01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, {
      journal: [{ callHash: "single-flight", result: "x".repeat(384 * 1024) }]
    })
    const before = getWorkflowRunLargeParseDiagnosticsForTest()

    const [first, second] = await Promise.all([
      loadWorkflowRunAsync(workspace, threadId, runId),
      loadWorkflowRunAsync(workspace, threadId, runId)
    ])
    const after = getWorkflowRunLargeParseDiagnosticsForTest()

    expect(first?.runId).toBe(runId)
    expect(second?.runId).toBe(runId)
    expect(after.workersStarted - before.workersStarted).toBe(1)
    expect(after.peak).toBeLessThanOrEqual(1)
  })

  test("ordinary reads skip a >32 MiB inline journal while resume restores bounded batches", async () => {
    const threadId = "thread-large-inline-journal"
    const runId = "wf_largeinline01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const journal = Array.from({ length: 136 }, (_, index) => ({
      index,
      hash: `inline-large-${index}`,
      result: "x".repeat(256 * 1024)
    }))
    writeRun(managed, threadId, runId, { journal })

    const beforeOrdinary = getWorkflowRunLargeParseDiagnosticsForTest()
    const ordinary = await loadWorkflowRunAsync(workspace, threadId, runId)
    const afterOrdinary = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(ordinary?.journal).toEqual([])
    expect(afterOrdinary.journalBatches - beforeOrdinary.journalBatches).toBe(0)

    const beforeResume = getWorkflowRunLargeParseDiagnosticsForTest()
    const resumed = await loadWorkflowRunForResumeAsync(workspace, threadId, runId)
    const afterResume = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(resumed?.journal).toHaveLength(journal.length)
    expect(resumed?.journal.at(-1)).toMatchObject({ hash: "inline-large-135" })
    expect(afterResume.journalBatches - beforeResume.journalBatches).toBe(journal.length)
    expect(afterResume.peakJournalBatchBytes).toBeLessThanOrEqual(
      afterResume.maxMessageBytes
    )
  }, 30_000)

  test("a 31 MiB projection reaches main only through bounded transferable chunks", async () => {
    const threadId = "thread-large-streamed-projection"
    const runId = "wf_largestream01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const agents = Array.from({ length: 140 }, (_, index) => ({
      index,
      payload: "x".repeat(220 * 1024)
    }))
    writeRun(managed, threadId, runId, { agents })
    const before = getWorkflowRunLargeParseDiagnosticsForTest()
    const gaps: number[] = []
    let previousTick = performance.now()
    const ticker = setInterval(() => {
      const now = performance.now()
      gaps.push(now - previousTick)
      previousTick = now
    }, 2)
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
      const loaded = await loadWorkflowRunAsync(workspace, threadId, runId)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
      expect(loaded?.agents).toHaveLength(agents.length)
    } finally {
      clearInterval(ticker)
    }
    const after = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(after.messages - before.messages).toBeGreaterThan(100)
    expect(after.peakMessageBytes).toBeLessThanOrEqual(after.maxMessageBytes)
    expect(Math.max(...gaps)).toBeLessThan(250)
  }, 30_000)

  test("a near-1 MiB journal entry is chunked and keeps the main ticker responsive", async () => {
    const threadId = "thread-large-streamed-journal"
    const runId = "wf_largejournal01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, {
      journal: [{ index: 0, hash: "near-limit", result: "y".repeat(950 * 1024) }]
    })
    const before = getWorkflowRunLargeParseDiagnosticsForTest()
    const gaps: number[] = []
    let previousTick = performance.now()
    const ticker = setInterval(() => {
      const now = performance.now()
      gaps.push(now - previousTick)
      previousTick = now
    }, 2)
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
      const loaded = await loadWorkflowRunForResumeAsync(workspace, threadId, runId)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
      expect(loaded?.journal[0]?.result).toHaveLength(950 * 1024)
    } finally {
      clearInterval(ticker)
    }
    const after = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(after.messages - before.messages).toBeGreaterThanOrEqual(4)
    expect(after.peakMessageBytes).toBeLessThanOrEqual(after.maxMessageBytes)
    expect(Math.max(...gaps)).toBeLessThan(250)
  }, 20_000)

  test("large-run parse admission rejects beyond its bounded waiter queue", async () => {
    const threadId = "thread-large-admission"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const runIds = Array.from({ length: 10 }, (_, index) => `wf_admission${index}`)
    for (const runId of runIds) {
      writeRun(managed, threadId, runId, {
        journal: [{ index: 0, hash: runId, result: "z".repeat(384 * 1024) }]
      })
    }
    let releaseFirst!: () => void
    const hold = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise
    })
    setBeforeLargeWorkflowRunParseForTest(async () => hold)
    const before = getWorkflowRunLargeParseDiagnosticsForTest()
    const reads = runIds.map((runId) => loadWorkflowRunAsync(workspace, threadId, runId))
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const diagnostics = getWorkflowRunLargeParseDiagnosticsForTest()
      if (diagnostics.rejectedWaiters > before.rejectedWaiters) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    }
    const pressured = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(pressured.waiters).toBe(pressured.maxWaiters)
    expect(pressured.rejectedWaiters - before.rejectedWaiters).toBeGreaterThanOrEqual(1)
    releaseFirst()
    await Promise.all(reads)
    expect(getWorkflowRunLargeParseDiagnosticsForTest().waiters).toBe(0)
  }, 20_000)

  test("large-run Worker rejects a known non-journal projection above 32 MiB", async () => {
    const threadId = "thread-large-known-projection"
    const runId = "wf_largeknown01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const agents = Array.from({ length: 160 }, (_, index) => ({
      index,
      payload: "x".repeat(220 * 1024)
    }))
    writeRun(managed, threadId, runId, { agents })

    await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toBeNull()
  }, 30_000)

  test("store initialization does not stringify a large resume snapshot on main", async () => {
    const threadId = "thread-large-store-initial"
    const runId = "wf_largestore01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId)
    const initial = JSON.parse(
      readFileSync(join(managed, `${runId}.json`), "utf8")
    ) as PersistedWorkflowRun
    initial.status = "running"
    initial.journal = Array.from({ length: 8 }, (_, index) => ({
      index,
      hash: `store-clone-${index}`,
      result: "x".repeat(512 * 1024)
    }))
    const originalStringify = JSON.stringify
    JSON.stringify = ((
      value: unknown,
      replacer?: Parameters<typeof JSON.stringify>[1],
      space?: Parameters<typeof JSON.stringify>[2]
    ) => {
      if (value === initial) throw new Error("initial snapshot was stringified on main")
      return originalStringify(value, replacer as never, space)
    }) as typeof JSON.stringify

    try {
      const store = createWorkflowRunStore({ workspacePath: workspace, threadId, initial })
      await expect(store.whenInitialPersisted).resolves.toBe(true)
      store.appendJournal({ index: 8, hash: "store-clone-new", result: "new" })
      await expect(store.flush()).resolves.toBe(true)
      expect(initial.journal).toHaveLength(8)
    } finally {
      JSON.stringify = originalStringify
    }
  }, 20_000)

  test("flush-failure capture compacts a durable journal and retains an unpersisted one without deep cloning", async () => {
    const threadId = "thread-flush-capture"
    const runId = "wf_flushcapture01"
    const initial = JSON.parse(
      JSON.stringify({
        version: 1,
        runId,
        threadId,
        workflowName: "capture",
        script: "export const meta = {}",
        scriptSha256: "capture",
        status: "running",
        phases: [],
        currentPhase: null,
        agents: [],
        logs: [],
        journal: [{ index: 0, hash: "durable", result: "d".repeat(950 * 1024) }],
        stats: {
          agentsTotal: 1,
          agentsCached: 0,
          agentsFailed: 0,
          outputTokens: 0,
          durationMs: 0
        },
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    ) as PersistedWorkflowRun
    const store = createWorkflowRunStore({ workspacePath: workspace, threadId, initial })
    expect(await store.whenInitialPersisted).toBe(true)
    const compact = store.captureFlushFailureSnapshot()
    expect(compact.journalSource).toBe("sidecar")
    expect(compact.run.journal).toEqual([])

    const marker = "unpersisted-marker-" + "u".repeat(950 * 1024)
    const journalTempPath = join(getWorkflowRunsDir(workspace, threadId), `${runId}.journal.tmp`)
    mkdirSync(journalTempPath)
    store.appendJournal({ index: 1, hash: "unpersisted", result: marker })
    expect(await store.flush()).toBe(false)
    const originalStringify = JSON.stringify
    JSON.stringify = ((
      value: unknown,
      replacer?: Parameters<typeof JSON.stringify>[1],
      space?: Parameters<typeof JSON.stringify>[2]
    ) => {
      if (value === store.state || value === marker) {
        throw new Error("flush fallback attempted a deep JSON clone on main")
      }
      return originalStringify(value, replacer as never, space)
    }) as typeof JSON.stringify
    try {
      const retained = store.captureFlushFailureSnapshot()
      expect(retained.journalSource).toBe("memory")
      expect(retained.run.journal.at(-1)?.result).toBe(marker)
      expect(retained.reservedBytes).toBeGreaterThan(compact.reservedBytes)
    } finally {
      JSON.stringify = originalStringify
    }
  }, 20_000)

  test("large-run Worker rejects a 100 MiB unknown field instead of cloning it to main", async () => {
    const threadId = "thread-large-projection"
    const runId = "wf_largeproject01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId)
    const runPath = join(managed, `${runId}.json`)
    const base = readFileSync(runPath, "utf8")
    writeFileSync(runPath, `${base.slice(0, -1)},"pressure":"`, "utf8")
    const oneMiB = "x".repeat(1024 * 1024)
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(runPath, oneMiB, { encoding: "utf8", flag: "a" })
    }
    writeFileSync(runPath, '"}', { encoding: "utf8", flag: "a" })
    const before = getWorkflowRunLargeParseDiagnosticsForTest()

    await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toBeNull()
    const after = getWorkflowRunLargeParseDiagnosticsForTest()
    expect(after.workersStarted - before.workersStarted).toBe(1)
    expect(after.peak).toBeLessThanOrEqual(1)
  }, 20_000)

  test("large-run Worker heap exhaustion rejects without terminating the main isolate", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        runId: "wf_workerheap01",
        threadId: "thread-worker-heap",
        journal: [],
        pressure: Array.from({ length: 350_000 }, (_, index) => `value-${index}`)
      })
    )

    await expect(
      parseLargeWorkflowRunJsonForTest(payload, {
        maxOldGenerationSizeMb: 8,
        maxYoungGenerationSizeMb: 2,
        stackSizeMb: 2
      })
    ).rejects.toThrow(/memory|heap|exited/i)
  })

  test("async notification output validates the exact loaded incarnation without parsing result", async () => {
    const threadId = "thread-output-incarnation"
    const runId = "wf_outputinc01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, {
      startedAt: "2026-03-03T00:00:00.000Z",
      resultSidecarStatus: "available",
      result: "preview"
    })
    const resultPath = workflowResultFilePath(workspace, threadId, runId)
    writeFileSync(resultPath, JSON.stringify({ value: "complete" }), "utf8")
    const loaded = await loadWorkflowRunAsync(workspace, threadId, runId)
    expect(loaded).not.toBeNull()

    const originalParse = JSON.parse
    JSON.parse = (): never => {
      throw new Error("notification resolver must not parse result/run JSON")
    }
    try {
      await expect(resolveWorkflowOutputFileAsync(loaded!)).resolves.toBe(resultPath)
    } finally {
      JSON.parse = originalParse
    }

    writeRun(managed, threadId, runId, {
      startedAt: "2026-03-03T00:00:01.000Z",
      resultSidecarStatus: "available",
      result: "new preview"
    })
    await expect(resolveWorkflowOutputFileAsync(loaded!)).resolves.toBeUndefined()
  })

  test("backup-only runs participate in history and pending-notification discovery", async () => {
    const threadId = "thread-backup-only"
    const runId = "wf_backup123"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId, runId, {
      notificationDelivered: false,
      startedAt: "2026-02-01T00:00:00.000Z"
    })
    renameSync(join(legacy, `${runId}.json`), join(legacy, `${runId}.json.bak`))

    const page = await listWorkflowRunsPage(workspace, threadId)
    expect(page.runs.map((run) => run.runId)).toContain(runId)
    await expect(hasUndeliveredWorkflowRunAsync(workspace, threadId)).resolves.toBe(true)
    expect((await loadWorkflowRunAsync(workspace, threadId, runId))?.runId).toBe(runId)
    await expect(markWorkflowRunNotified(workspace, threadId, runId)).resolves.toBe(true)
    await expect(hasUndeliveredWorkflowRunAsync(workspace, threadId)).resolves.toBe(false)
    expect(existsSync(join(legacy, `${runId}.json`))).toBe(true)
  })

  test("metadata mutations externalize a legacy inline journal before clearing it", async () => {
    const threadId = "thread-inline-mutation"
    const runId = "wf_inlinemut01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const worktree = makeWorktree(root, threadId, runId, "inline-worktree")
    const journal = [
      { index: 0, hash: "inline-mutation-0", result: "first" },
      { index: 1, hash: "inline-mutation-1", result: "second" }
    ]
    writeRun(managed, threadId, runId, {
      journal,
      worktrees: [worktree],
      notificationDelivered: false
    })

    await updateWorkflowWorktreeRecord(workspace, threadId, runId, {
      ...worktree,
      status: "merged",
      updatedAt: "2026-02-02T00:00:00.000Z"
    })
    await expect(markWorkflowRunNotified(workspace, threadId, runId)).resolves.toBe(true)

    const raw = JSON.parse(readFileSync(join(managed, `${runId}.json`), "utf8"))
    expect(raw.journal).toEqual([])
    expect(raw.worktrees[0].status).toBe("merged")
    expect(raw.notificationDelivered).toBe(true)
    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toMatchObject({
      journal
    })

    // A damaged primary must not resurrect the pre-action backup.
    writeFileSync(join(managed, `${runId}.json`), "{damaged", "utf8")
    await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toMatchObject({
      notificationDelivered: true,
      worktrees: [expect.objectContaining({ status: "merged" })]
    })
    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toMatchObject({
      journal
    })
  })

  test("inline-journal sidecar failure leaves the legacy run file unchanged", async () => {
    const threadId = "thread-inline-mutation-fail"
    const runId = "wf_inlinemutfail"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const worktree = makeWorktree(root, threadId, runId, "inline-fail-worktree")
    writeRun(managed, threadId, runId, {
      journal: [{ index: 0, hash: "inline-fail", result: "preserve" }],
      worktrees: [worktree]
    })
    const runPath = join(managed, `${runId}.json`)
    const before = readFileSync(runPath, "utf8")
    // A directory at the sidecar destination makes the journal-first rename fail.
    mkdirSync(join(managed, `${runId}.journal`), { recursive: true })

    await expect(
      updateWorkflowWorktreeRecord(workspace, threadId, runId, {
        ...worktree,
        status: "merged",
        updatedAt: "2026-02-02T00:00:00.000Z"
      })
    ).rejects.toThrow()
    expect(readFileSync(runPath, "utf8")).toBe(before)
  })

  test("interrupted backup remains monotonic and retains the replay journal", async () => {
    const threadId = "thread-interrupted-backup"
    const runId = "wf_interruptbak1"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const journal = [{ index: 0, hash: "interrupted-journal", result: "cached" }]
    writeRun(managed, threadId, runId, {
      status: "running",
      notificationDelivered: false,
      journal,
      agents: [
        {
          index: 0,
          label: "running-agent",
          phase: null,
          status: "running",
          outputTokens: 0,
          startedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      stats: {
        agentsTotal: 1,
        agentsCached: 0,
        agentsFailed: 0,
        outputTokens: 0,
        durationMs: 0
      }
    })

    await expect(markWorkflowRunInterrupted(workspace, threadId, runId)).resolves.toMatchObject({
      status: "aborted",
      notificationDelivered: true
    })
    writeFileSync(join(managed, `${runId}.json`), "{damaged", "utf8")
    await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toMatchObject({
      status: "aborted",
      notificationDelivered: true,
      agents: [expect.objectContaining({ status: "error" })]
    })
    await expect(loadWorkflowRunForResumeAsync(workspace, threadId, runId)).resolves.toMatchObject({
      journal
    })
  })

  test("backup publication failure does not roll back a successful notification ack", async () => {
    const threadId = "thread-notification-backup-fail"
    const runId = "wf_notifybakfail"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, { notificationDelivered: false })
    const runPath = join(managed, `${runId}.json`)
    mkdirSync(`${runPath}.bak`, { recursive: true })

    await expect(markWorkflowRunNotified(workspace, threadId, runId)).resolves.toBe(true)
    expect(JSON.parse(readFileSync(runPath, "utf8")).notificationDelivered).toBe(true)
  })

  test("synchronous compatibility scan parses lazily after stat ordering", () => {
    const threadId = "thread-sync-lazy"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    const pendingRunId = "wf_pending900"
    const oldPaths = new Set<string>()
    for (let index = 0; index < 24; index += 1) {
      const runId = `wf_old${index.toString().padStart(6, "0")}`
      writeRun(dir, threadId, runId)
      const path = join(dir, `${runId}.json`)
      oldPaths.add(resolve(path).toLowerCase())
      utimesSync(path, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"))
    }
    writeRun(dir, threadId, pendingRunId, {
      notificationDelivered: false,
      startedAt: "2030-01-01T00:00:00.000Z"
    })
    const pendingPath = join(dir, `${pendingRunId}.json`)
    utimesSync(pendingPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"))

    const mutableFs = fs as unknown as Record<string, unknown>
    const originalRead = mutableFs.readFileSync as (...args: unknown[]) => unknown
    let oldReads = 0
    let pendingReads = 0
    mutableFs.readFileSync = (...args: unknown[]): unknown => {
      const normalized = resolve(String(args[0])).toLowerCase()
      if (oldPaths.has(normalized)) oldReads += 1
      if (normalized === resolve(pendingPath).toLowerCase()) pendingReads += 1
      return originalRead(...args)
    }
    syncBuiltinESMExports()
    try {
      expect(findUndeliveredTerminalRun(workspace, threadId)?.runId).toBe(pendingRunId)
      expect(pendingReads).toBeGreaterThan(0)
      expect(oldReads).toBe(0)
    } finally {
      mutableFs.readFileSync = originalRead
      syncBuiltinESMExports()
    }
  })

  test("async pending lookup point-reads the compact pending set, not delivered history", async () => {
    const threadId = "thread-async-pending-index"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    const pendingRunId = "wf_pending901"
    const entries: Array<Record<string, unknown>> = []
    const oldPaths = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      const runId = `wf_done${index.toString().padStart(6, "0")}`
      const startedAt = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString()
      writeRun(dir, threadId, runId, { startedAt })
      const path = join(dir, `${runId}.json`)
      oldPaths.add(resolve(path).toLowerCase())
      utimesSync(path, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"))
      entries.push({
        runId,
        startedAt,
        status: "completed",
        notificationDelivered: true
      })
    }
    writeRun(dir, threadId, pendingRunId, {
      notificationDelivered: false,
      startedAt: "2026-01-01T00:00:00.000Z"
    })
    const pendingPath = join(dir, `${pendingRunId}.json`)
    utimesSync(pendingPath, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"))
    entries.push({
      runId: pendingRunId,
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      notificationDelivered: false
    })
    const indexPath = join(dir, "runs.index")
    writeFileSync(
      indexPath,
      JSON.stringify({ version: 1, entries, pendingNotificationRunIds: [pendingRunId] }),
      "utf8"
    )
    utimesSync(indexPath, new Date("2030-01-01T00:00:00.000Z"), new Date("2030-01-01T00:00:00.000Z"))

    let oldReads = 0
    let pendingReads = 0
    setBeforeWorkflowRunPointReadForTest((path) => {
      const normalized = resolve(path).toLowerCase()
      if (oldPaths.has(normalized)) oldReads += 1
      if (normalized === resolve(pendingPath).toLowerCase()) pendingReads += 1
    })
    try {
      await expect(findUndeliveredTerminalRunAsync(workspace, threadId)).resolves.toMatchObject({
        runId: pendingRunId
      })
      expect(pendingReads).toBeGreaterThan(0)
      expect(oldReads).toBe(0)
    } finally {
      setBeforeWorkflowRunPointReadForTest()
    }
  })

  test("async prune never uses synchronous filesystem primitives", async () => {
    const threadId = "thread-prune-async-only"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    const oldRunId = "wf_pruneold1"
    const newRunId = "wf_prunenew1"
    writeRun(dir, threadId, oldRunId)
    writeRun(dir, threadId, newRunId)
    utimesSync(
      join(dir, `${oldRunId}.json`),
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2020-01-01T00:00:00.000Z")
    )
    utimesSync(
      join(dir, `${newRunId}.json`),
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2025-01-01T00:00:00.000Z")
    )

    const mutableFs = fs as unknown as Record<string, unknown>
    const names = [
      "existsSync",
      "readFileSync",
      "readdirSync",
      "realpathSync",
      "statSync",
      "unlinkSync"
    ] as const
    const originals = new Map(names.map((name) => [name, mutableFs[name]]))
    for (const name of names) {
      mutableFs[name] = (): never => {
        throw new Error(`synchronous filesystem call during prune: ${name}`)
      }
    }
    syncBuiltinESMExports()
    try {
      await pruneWorkflowRuns(workspace, threadId, 1)
    } finally {
      for (const [name, original] of originals) mutableFs[name] = original
      syncBuiltinESMExports()
    }
    expect(existsSync(join(dir, `${oldRunId}.json`))).toBe(false)
    expect(existsSync(join(dir, `${newRunId}.json`))).toBe(true)
  })

  test("async prune cannot delete a resumed same-id running incarnation", async () => {
    const threadId = "thread-prune-resume-race"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    const runId = "wf_prunerace1"
    writeRun(dir, threadId, runId, {
      startedAt: "2025-01-01T00:00:00.000Z",
      notificationDelivered: true
    })
    const target = join(dir, `${runId}.json`)
    const replacement = {
      ...(JSON.parse(readFileSync(target, "utf8")) as PersistedWorkflowRun),
      status: "running" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: undefined,
      notificationDelivered: false
    }

    let releaseCapturedRead!: () => void
    const capturedReadGate = new Promise<void>((resolveGate) => {
      releaseCapturedRead = resolveGate
    })
    let notifyCaptured!: () => void
    const captured = new Promise<void>((resolveCaptured) => {
      notifyCaptured = resolveCaptured
    })
    setBeforeWorkflowPruneMutationForTest(async (run) => {
      if (run.runId === runId) {
        notifyCaptured()
        await capturedReadGate
      }
    })
    try {
      const prune = pruneWorkflowRuns(workspace, threadId, 0)
      await captured
      const replacementStore = createWorkflowRunStore({
        workspacePath: workspace,
        threadId,
        initial: replacement
      })
      releaseCapturedRead()
      await Promise.all([prune, replacementStore.whenInitialPersisted])
      expect((await loadWorkflowRunAsync(workspace, threadId, runId))?.startedAt).toBe(
        replacement.startedAt
      )
      expect(existsSync(target)).toBe(true)
    } finally {
      setBeforeWorkflowPruneMutationForTest()
      releaseCapturedRead()
    }
  })

  test("edit-and-resume stream cleanup sweeps managed and legacy settled files", async () => {
    const threadId = "thread-clear-stream-roots"
    const runId = "wf_clearroots1"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    mkdirSync(managed, { recursive: true })
    mkdirSync(legacy, { recursive: true })
    const managedStream = join(managed, `${runId}.managed_c0.toolstream`)
    const legacyStream = join(legacy, `${runId}.legacy_c0.toolstream`)
    const legacyTemp = `${legacyStream}.tmp`
    writeFileSync(managedStream, "{}", "utf8")
    writeFileSync(legacyStream, "{}", "utf8")
    writeFileSync(legacyTemp, "{}", "utf8")

    await clearAllAgentToolStreams(workspace, threadId, runId)

    expect(existsSync(managedStream)).toBe(false)
    expect(existsSync(legacyStream)).toBe(false)
    expect(existsSync(legacyTemp)).toBe(false)
  })

  test("details merge split worktrees and actions update every owning copy", async () => {
    const threadId = "thread-split-action"
    const runId = "wf_split123"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    const legacyWorktree = makeWorktree(root, threadId, runId, "legacy-worktree")
    const managedWorktree = makeWorktree(root, threadId, runId, "managed-worktree")
    writeRun(legacy, threadId, runId, { worktrees: [legacyWorktree] })
    writeRun(managed, threadId, runId, { worktrees: [managedWorktree] })

    expect((await loadWorkflowRunAsync(workspace, threadId, runId))?.worktrees?.map((w) => w.id)).toEqual([
      "managed-worktree",
      "legacy-worktree"
    ])

    const mergedLegacyWorktree = {
      ...legacyWorktree,
      status: "merged" as const,
      updatedAt: "2026-01-02T00:00:00.000Z"
    }
    await updateWorkflowWorktreeRecord(workspace, threadId, runId, mergedLegacyWorktree)

    const legacyOnDisk = JSON.parse(readFileSync(join(legacy, `${runId}.json`), "utf8"))
    expect(legacyOnDisk.worktrees[0].status).toBe("merged")
    expect(
      JSON.parse(readFileSync(join(managed, `${runId}.json`), "utf8")).worktrees[0].status
    ).toBe("ready")
  })

  test("destructive worktree checks scan both managed and legacy runs", async () => {
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
    await expect(countUnresolvedWorkflowWorktreesAsync(workspace, threadId)).resolves.toBe(1)
  })

  test("thread deletion fences and removes both storage layouts", async () => {
    const threadId = "thread-delete-both"
    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)
    writeRun(managed, threadId, "wf_def456")

    await deleteWorkflowRunsForThread(workspace, threadId)

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(managed)).toBe(false)
    expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(true)

    reviveWorkflowThread(threadId)
    expect(isWorkflowRunDirDisposed(workspace, threadId)).toBe(false)
    expect(getWorkflowRunsDir(workspace, threadId)).toBe(managed)
  })

  test("thread deletion drains an in-flight index publication before sweeping", async () => {
    const threadId = "thread-delete-index-race"
    const runId = "wf_deleteindex1"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(dir, threadId, runId, { notificationDelivered: false })
    let notifyPublish!: () => void
    const publishing = new Promise<void>((resolvePublish) => {
      notifyPublish = resolvePublish
    })
    let releasePublish!: () => void
    const publishGate = new Promise<void>((resolveGate) => {
      releasePublish = resolveGate
    })
    setBeforeWorkflowRunIndexPublishForTest(async (indexPath) => {
      if (!indexPath.includes(threadId)) return
      notifyPublish()
      await publishGate
    })

    const acknowledging = markWorkflowRunNotified(workspace, threadId, runId)
    await publishing
    let deletionDone = false
    const deleting = deleteWorkflowRunsForThread(workspace, threadId).then(() => {
      deletionDone = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(deletionDone).toBe(false)

    releasePublish()
    await Promise.all([acknowledging, deleting])
    expect(existsSync(dir)).toBe(false)
  })

  test("falls through a structurally corrupt primary to its valid backup", async () => {
    const threadId = "thread-shape-backup"
    const runId = "wf_shapeback01"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(dir, threadId, runId, { workflowName: "valid backup" })
    const primary = join(dir, `${runId}.json`)
    renameSync(primary, `${primary}.bak`)
    writeFileSync(
      primary,
      JSON.stringify({ version: 1, runId, threadId, workflowName: "poisoned primary" }),
      "utf8"
    )

    await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toMatchObject({
      workflowName: "valid backup",
      agents: [],
      logs: []
    })
  })

  test("bounds and yields while enumerating a polluted workflow directory", async () => {
    const dir = join(root, "polluted-workflow-directory")
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < 513; index += 1) {
      writeFileSync(join(dir, `junk-${index}.tmp`), "", "utf8")
    }
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await expect(readWorkflowDirectoryEntriesBoundedForTest(dir, 512)).rejects.toThrow(
        "workflow directory exceeds 512 entries"
      )
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  }, 20_000)

  test("hard-bounds concurrent cold workflow index caches", async () => {
    const before = getWorkflowStorageCacheDiagnosticsForTest()
    let entered = 0
    let notifyFull!: () => void
    const full = new Promise<void>((resolveFull) => {
      notifyFull = resolveFull
    })
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    setBeforeWorkflowRunIndexReadForTest(async (indexPath) => {
      if (!indexPath.includes("thread-index-admission-")) return
      entered += 1
      if (entered === before.indexMaxEntries) notifyFull()
      await gate
    })
    const admitted = Array.from({ length: before.indexMaxEntries }, (_, index) =>
      listWorkflowRunsPage(workspace, `thread-index-admission-${index}`)
    )
    try {
      await full
      await expect(
        listWorkflowRunsPage(workspace, "thread-index-admission-overflow")
      ).rejects.toThrow("workflow run index cache is busy")
      const busy = getWorkflowStorageCacheDiagnosticsForTest()
      expect(busy.indexEntries).toBeLessThanOrEqual(busy.indexMaxEntries)
      expect(busy.indexAdmissionRejected).toBeGreaterThan(before.indexAdmissionRejected)
    } finally {
      release()
      await Promise.allSettled(admitted)
      setBeforeWorkflowRunIndexReadForTest()
    }
  }, 20_000)

  test("bounds retained workflow summaries by entry and byte budgets", async () => {
    const threadId = "thread-summary-cache-bound"
    const dir = getManagedWorkflowRunsDir(workspace, threadId)
    for (let index = 0; index < 150; index += 1) {
      const runId = `wf_summary${index.toString().padStart(4, "0")}`
      writeRun(dir, threadId, runId, { description: "x".repeat(16 * 1024) })
    }
    const first = await listWorkflowRunsPage(workspace, threadId, { limit: 100 })
    await listWorkflowRunsPage(workspace, threadId, {
      cursor: first.nextCursor,
      limit: 100
    })
    const diagnostics = getWorkflowStorageCacheDiagnosticsForTest()
    expect(diagnostics.summaryEntries).toBeLessThanOrEqual(
      diagnostics.indexEntries * diagnostics.summaryMaxEntriesPerIndex
    )
    expect(diagnostics.summaryBytes).toBeLessThanOrEqual(
      diagnostics.indexEntries * diagnostics.summaryMaxBytesPerIndex
    )
  }, 20_000)

  test("bounds candidate and heavy index caches across many thread switches", async () => {
    const before = getWorkflowStorageCacheDiagnosticsForTest()
    for (let index = 0; index < before.candidateMaxEntries + 8; index += 1) {
      await listWorkflowRunsPage(workspace, `thread-cache-bound-${index}`)
    }
    const after = getWorkflowStorageCacheDiagnosticsForTest()
    expect(after.candidateEntries).toBeLessThanOrEqual(after.candidateMaxEntries)
    expect(after.indexEntries).toBeLessThanOrEqual(after.indexMaxEntries)
    expect(after.candidateInFlight).toBe(0)
    expect(after.indexMutationsInFlight).toBe(0)
  }, 30_000)

  test("a revived incarnation waits for an in-flight async tombstone sweep", async () => {
    const threadId = "thread-delete-revive-race"
    const runId = "wf_reviverace01"
    const managed = getManagedWorkflowRunsDir(workspace, threadId)
    writeRun(managed, threadId, runId, {
      startedAt: "2026-04-01T00:00:00.000Z",
      status: "completed"
    })
    let releaseSweep!: () => void
    const sweepGate = new Promise<void>((resolveGate) => {
      releaseSweep = resolveGate
    })
    let enteredSweep!: () => void
    const sweepEntered = new Promise<void>((resolveEntered) => {
      enteredSweep = resolveEntered
    })
    setBeforeWorkflowRunDirSweepForTest(async (dir) => {
      if (dir !== managed) return
      enteredSweep()
      await sweepGate
    })

    try {
      const deleting = deleteWorkflowRunsForThread(workspace, threadId)
      await sweepEntered
      reviveWorkflowThread(threadId)

      const now = "2026-04-01T00:00:01.000Z"
      const replacement = createWorkflowRunStore({
        workspacePath: workspace,
        threadId,
        initial: {
          version: 1,
          runId,
          threadId,
          workflowName: "revived",
          script: "return null",
          scriptSha256: "revived-script",
          status: "running",
          phases: [],
          currentPhase: null,
          agents: [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 0
          },
          startedAt: now,
          updatedAt: now
        }
      })
      let replacementSettled = false
      void replacement.whenInitialPersisted.then(() => {
        replacementSettled = true
      })
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
      expect(replacementSettled).toBe(false)

      releaseSweep()
      await deleting
      await expect(replacement.whenInitialPersisted).resolves.toBe(true)
      await expect(loadWorkflowRunAsync(workspace, threadId, runId)).resolves.toMatchObject({
        startedAt: now,
        workflowName: "revived"
      })
    } finally {
      setBeforeWorkflowRunDirSweepForTest()
      releaseSweep()
    }
  })

  test("thread deletion removes compatibility data for every workspace path alias", async () => {
    const threadId = "thread-delete-aliases"
    const workspaceAlias = join(root, "workspace-alias")
    symlinkSync(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir")

    getWorkflowRunsDir(workspace, threadId)
    getWorkflowRunsDir(workspaceAlias, threadId)
    await deleteWorkflowRunsForThread(workspace, threadId)

    const legacy = getLegacyWorkflowRunsDir(workspace, threadId)
    writeRun(legacy, threadId)
    expect(getWorkflowRunsDir(workspaceAlias, threadId)).toBe(
      getManagedWorkflowRunsDir(workspaceAlias, threadId)
    )

    reviveWorkflowThread(threadId)
  })
})
