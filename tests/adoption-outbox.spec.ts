/**
 * Durable code-adoption telemetry delivery tests.
 *
 * Run:
 *   npx tsx tests/adoption-outbox.spec.ts
 */

import { execFile } from "child_process"
import { createHash } from "crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import initSqlJs from "sql.js"
import { promisify } from "util"
import type {
  CoworkEvent,
  EventReportResult,
  IEventReporter
} from "../src/main/services/event-reporter.ts"

type AdoptionTrackerModule = typeof import("../src/main/services/adoption-tracker.ts")
type AdoptionIndexModule = typeof import("../src/main/services/adoption-index.ts")
type EventReporterModule = typeof import("../src/main/services/event-reporter.ts")

let testDataRoot = ""
let captureStagedSnapshotsForCommit!: AdoptionTrackerModule["captureStagedSnapshotsForCommit"]
let flushAdoptionCommitJobs!: AdoptionTrackerModule["flushAdoptionCommitJobs"]
let flushAdoptionEventOutbox!: AdoptionTrackerModule["flushAdoptionEventOutbox"]
let getCommitMeasurementStatus!: AdoptionTrackerModule["getCommitMeasurementStatus"]
let initializeAdoptionTracker!: AdoptionTrackerModule["initializeAdoptionTracker"]
let measureForCommit!: AdoptionTrackerModule["measureForCommit"]
let recordGen!: AdoptionTrackerModule["recordGen"]
let setAdoptionContext!: AdoptionTrackerModule["setAdoptionContext"]
let shutdownAdoptionTracker!: AdoptionTrackerModule["shutdownAdoptionTracker"]
let waitForAdoptionRecordGenIdleForTest!: AdoptionTrackerModule["waitForAdoptionRecordGenIdleForTest"]
let cleanupAdoptionDeliveryRecords!: AdoptionIndexModule["cleanupAdoptionDeliveryRecords"]
let closeAdoptionIndex!: AdoptionIndexModule["closeAdoptionIndex"]
let enqueueCommitJob!: AdoptionIndexModule["enqueueCommitJob"]
let enqueueEventOutbox!: AdoptionIndexModule["enqueueEventOutbox"]
let findPendingGensForFile!: AdoptionIndexModule["findPendingGensForFile"]
let flushAdoptionIndex!: AdoptionIndexModule["flushAdoptionIndex"]
let getAdoptLineDetails!: AdoptionIndexModule["getAdoptLineDetails"]
let getCommitJob!: AdoptionIndexModule["getCommitJob"]
let getGenRowByEventId!: AdoptionIndexModule["getGenRowByEventId"]
let getOutboxEvent!: AdoptionIndexModule["getOutboxEvent"]
let markOutboxFailed!: AdoptionIndexModule["markOutboxFailed"]
let buildEvent!: EventReporterModule["buildEvent"]
let NoopEventReporter!: EventReporterModule["NoopEventReporter"]
let setEventReporter!: EventReporterModule["setEventReporter"]

const execFileAsync = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

class AdoptionReporter implements IEventReporter {
  readonly adoptionCalls: CoworkEvent[] = []
  readonly generationCalls: CoworkEvent[] = []
  readonly testGenerationCalls: CoworkEvent[] = []
  failAdoption = false
  failGeneration = false
  failTestGeneration = false
  onGenerationReport?: (event: CoworkEvent) => Promise<void>

  async report(event: CoworkEvent): Promise<EventReportResult> {
    const snapshot = JSON.parse(JSON.stringify(event)) as CoworkEvent
    if (event.eventName === "code_gen") {
      this.generationCalls.push(snapshot)
      await this.onGenerationReport?.(snapshot)
      if (this.failGeneration) {
        return { ok: false, retryable: true, error: "simulated generation failure" }
      }
      return { ok: true, status: 200 }
    }
    if (event.eventName === "code_test_gen") {
      this.testGenerationCalls.push(snapshot)
      if (this.failTestGeneration) {
        return { ok: false, retryable: true, error: "simulated test generation failure" }
      }
      return { ok: true, status: 200 }
    }
    if (event.eventName !== "code_adopt") return { ok: true, status: 200 }
    this.adoptionCalls.push(snapshot)
    if (this.failAdoption) {
      return { ok: false, retryable: true, error: "simulated network failure" }
    }
    return { ok: true, status: 200 }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" })
  return stdout.trim()
}

async function withTempRepo<T>(name: string, fn: (repo: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), `${name}-`))
  const repo = await realpath(tempDir)
  try {
    await git(repo, ["init", "-q", "-b", "main"])
    await git(repo, ["config", "user.email", "test@example.com"])
    await git(repo, ["config", "user.name", "Test"])
    await writeFile(join(repo, "README.md"), "init\n")
    await git(repo, ["add", "."])
    await git(repo, ["commit", "-q", "-m", "init"])
    return await fn(repo)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function withIsolatedAdoptionStore<T>(fn: () => Promise<T>): Promise<T> {
  shutdownAdoptionTracker()
  const adoptionDir = join(testDataRoot, "adoption")
  const adoptionIndex = join(testDataRoot, "adoption-index.sqlite")
  await rm(adoptionDir, { recursive: true, force: true })
  await rm(adoptionIndex, { force: true })
  try {
    return await fn()
  } finally {
    await waitForAdoptionRecordGenIdleForTest()
    shutdownAdoptionTracker()
    setEventReporter(new NoopEventReporter())
    await rm(adoptionDir, { recursive: true, force: true })
    await rm(adoptionIndex, { force: true })
  }
}

async function waitForPendingGen(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = findPendingGensForFile(filePath, 0)[0]
    if (row) return row.event_id
    await sleep(20)
  }
  throw new Error(`timed out waiting for code_gen row: ${filePath}`)
}

async function waitForTestGenerationCall(reporter: AdoptionReporter): Promise<CoworkEvent> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const event = reporter.testGenerationCalls[0]
    if (event) return event
    await sleep(20)
  }
  throw new Error("timed out waiting for code_test_gen delivery")
}

async function waitForGenerationCall(reporter: AdoptionReporter, index = 0): Promise<CoworkEvent> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const event = reporter.generationCalls[index]
    if (event) return event
    await sleep(20)
  }
  throw new Error("timed out waiting for code_gen delivery")
}

async function querySnapshotCount(sql: string, params: Array<string | number>): Promise<number> {
  const SQL = await initSqlJs()
  const indexPath = join(testDataRoot, "adoption-index.sqlite")
  const snapshot = new SQL.Database(await readFile(indexPath))
  const stmt = snapshot.prepare(sql)
  stmt.bind(params)
  try {
    return stmt.step() ? Number(stmt.getAsObject().count ?? 0) : 0
  } finally {
    stmt.free()
    snapshot.close()
  }
}

async function generateAndCommit(
  repo: string,
  fileName: string
): Promise<{
  filePath: string
  genEventId: string
  commitSha: string
  commitTimeMs: number
  snapshots: Awaited<ReturnType<typeof captureStagedSnapshotsForCommit>>
}> {
  const filePath = join(repo, fileName)
  const content = `export const durableValue = ${Date.now()}\n`
  recordGen({
    threadId: "adoption-outbox-test",
    workspacePath: repo,
    filePath,
    tool: "write_file",
    generatedContent: content
  })
  const genEventId = await waitForPendingGen(filePath)
  await writeFile(filePath, content)
  await git(repo, ["add", fileName])
  const commitTimeMs = Date.now()
  const snapshots = await captureStagedSnapshotsForCommit(repo)
  await git(repo, ["commit", "-q", "-m", `add ${fileName}`])
  const commitSha = await git(repo, ["rev-parse", "HEAD"])
  return { filePath, genEventId, commitSha, commitTimeMs, snapshots }
}

function commitJobId(repo: string, commitSha: string): string {
  return createHash("sha256")
    .update(`${resolve(repo).replace(/\\/g, "/")}\0${commitSha.toLowerCase()}`)
    .digest("hex")
}

async function testTestGenerationUsesSeparateDurableOutbox(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    reporter.failTestGeneration = true
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("test-generation-outbox", async (repo) => {
      const testDir = join(repo, "tests")
      const filePath = join(testDir, "generated.ts")
      const generatedContent = "export const first = 1\n\nexport const second = 2\n"
      await mkdir(testDir, { recursive: true })
      await writeFile(filePath, generatedContent)

      recordGen({
        threadId: "test-generation-outbox",
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent,
        deletedLineCount: 0
      })

      const firstEvent = await waitForTestGenerationCall(reporter)
      assert(firstEvent.eventName === "code_test_gen", "test code should use its own event name")
      assert(
        firstEvent.properties?.lineCount === 2,
        "test generation should count net non-blank lines"
      )
      assert(
        firstEvent.properties?.testMatchRule === "directory",
        "test event should expose its classification rule"
      )
      assert(
        firstEvent.properties?.relativeHint === "generated.ts",
        "test event should keep the same leaf-only path privacy boundary"
      )
      assert(reporter.generationCalls.length === 0, "test code must not emit a standard code_gen")
      assert(reporter.adoptionCalls.length === 0, "test code must not emit a standard code_adopt")
      assert(
        findPendingGensForFile(filePath, 0).length === 0,
        "test code must not enter commit-time gen_events"
      )
      assert(
        getOutboxEvent(firstEvent.eventId)?.status === "retry",
        "failed code_test_gen delivery should remain durable in the outbox"
      )

      markOutboxFailed(firstEvent.eventId, "retry test generation after restart", 0, false)
      assert(flushAdoptionIndex(), "test generation retry state should flush before restart")
      shutdownAdoptionTracker()

      reporter.failTestGeneration = false
      await initializeAdoptionTracker()
      await flushAdoptionEventOutbox()

      assert(reporter.testGenerationCalls.length === 2, "code_test_gen should retry after restart")
      const retriedEvent = reporter.testGenerationCalls[1]
      assert(
        retriedEvent.eventId === firstEvent.eventId,
        "code_test_gen retry must reuse the server idempotency key"
      )
      assert(
        JSON.stringify(retriedEvent) === JSON.stringify(firstEvent),
        "code_test_gen retry must reuse the immutable payload"
      )
      assert(
        getOutboxEvent(firstEvent.eventId)?.status === "delivered",
        "successful code_test_gen retry should complete the outbox row"
      )

      await git(repo, ["add", "tests/generated.ts"])
      const commitTimeMs = Date.now()
      const snapshots = await captureStagedSnapshotsForCommit(repo)
      await git(repo, ["commit", "-q", "-m", "add generated test"])
      const commitSha = await git(repo, ["rev-parse", "HEAD"])
      assert(
        await measureForCommit(snapshots, commitSha, commitTimeMs, repo),
        "test-only commit job should still complete"
      )
      await flushAdoptionEventOutbox()
      assert(
        reporter.adoptionCalls.length === 0,
        "committing separately reported test code must not emit code_adopt"
      )
    })
  })
  console.log("PASS test generation is isolated and retried through the durable outbox")
}

async function testCodeGenRequiresAnIndexedBaseline(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("code-gen-index-gate", async (repo) => {
      const filePath = join(repo, "unindexed.ts")
      const generatedContent = "export const unindexed = true\n"
      await writeFile(filePath, generatedContent)

      // Simulate an index that became unavailable after tracker initialization.
      // The generation may be omitted from cloud telemetry, but it must never be
      // uploaded without a baseline that commit measurement can resolve.
      closeAdoptionIndex()
      recordGen({
        threadId: "code-gen-index-gate",
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent
      })
      await waitForAdoptionRecordGenIdleForTest()

      assert(reporter.generationCalls.length === 0, "unindexed code_gen must be suppressed")
      assert(
        findPendingGensForFile(filePath, 0).length === 0,
        "a closed index should not expose a pending generation"
      )
    })
  })
  console.log("PASS code_gen is suppressed when its measurement baseline cannot be indexed")
}

async function testCodeGenUsesDurableBatchedOutbox(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    reporter.failGeneration = true
    let durablePairCounts = { baseline: 0, outbox: 0 }
    let durablePairIds = { generation: "", outbox: "" }
    let settleDurablePairCheck!: () => void
    let rejectDurablePairCheck!: (error: unknown) => void
    const durablePairCheck = new Promise<void>((resolvePromise, rejectPromise) => {
      settleDurablePairCheck = resolvePromise
      rejectDurablePairCheck = rejectPromise
    })
    reporter.onGenerationReport = async (event) => {
      try {
        const genEventId = String(event.properties?.eventId ?? "")
        const baselineCount = await querySnapshotCount(
          "SELECT COUNT(*) AS count FROM gen_events WHERE event_id = ?",
          [genEventId]
        )
        const outboxCount = await querySnapshotCount(
          "SELECT COUNT(*) AS count FROM event_outbox WHERE event_id = ?",
          [event.eventId]
        )
        durablePairCounts = { baseline: baselineCount, outbox: outboxCount }
        durablePairIds = { generation: genEventId, outbox: event.eventId }
        settleDurablePairCheck()
      } catch (error) {
        rejectDurablePairCheck(error)
        throw error
      }
    }
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("code-gen-durable-outbox", async (repo) => {
      const filePath = join(repo, "durable-generation.ts")
      const generatedContent = "export const durableGeneration = true\n"
      await writeFile(filePath, generatedContent)

      recordGen({
        threadId: "code-gen-durable-outbox",
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent
      })

      // Normal generations share the existing debounced sql.js save instead of
      // forcing a full database export from every recordGen call.
      await sleep(100)
      assert(reporter.generationCalls.length === 0, "code_gen drain should be batched")

      const firstEvent = await waitForGenerationCall(reporter)
      await durablePairCheck
      await flushAdoptionEventOutbox()
      const genEventId = String(firstEvent.properties?.eventId ?? "")
      assert(genEventId.startsWith("g_"), "code_gen should retain its measurement id")
      assert(
        durablePairCounts.baseline === 1 && durablePairCounts.outbox === 1,
        `reporter must see a disk-durable baseline/outbox pair: ${JSON.stringify({ ...durablePairCounts, ...durablePairIds })}`
      )
      assert(
        getGenRowByEventId(genEventId)?.measured === 0,
        "durable code_gen baseline should remain pending for commit measurement"
      )
      assert(
        getOutboxEvent(firstEvent.eventId)?.status === "retry",
        "failed code_gen delivery should remain retryable"
      )

      markOutboxFailed(firstEvent.eventId, "retry code_gen after restart", 0, false)
      assert(flushAdoptionIndex(), "code_gen retry state should flush before restart")
      shutdownAdoptionTracker()

      reporter.failGeneration = false
      await initializeAdoptionTracker()
      await flushAdoptionEventOutbox()

      assert(reporter.generationCalls.length === 2, "code_gen should retry after restart")
      const retriedEvent = reporter.generationCalls[1]
      assert(
        retriedEvent.eventId === firstEvent.eventId,
        "code_gen retry must reuse the top-level server idempotency key"
      )
      assert(
        JSON.stringify(retriedEvent) === JSON.stringify(firstEvent),
        "code_gen retry must reuse the immutable payload"
      )
      assert(
        getGenRowByEventId(genEventId) !== null,
        "code_gen measurement baseline should survive restart"
      )
      assert(
        getOutboxEvent(firstEvent.eventId)?.status === "delivered",
        "successful code_gen retry should complete the outbox row"
      )
    })
  })
  console.log("PASS code_gen batches persistence and retries the durable envelope")
}

async function testCodeGenUsesMutationTimeHarnessStage(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("code-gen-harness-stage", async (repo) => {
      const threadId = "code-gen-harness-stage"
      const filePath = join(repo, "stage.ts")
      const generatedContent = "export const stage = true\n"
      await writeFile(filePath, generatedContent)
      setAdoptionContext(threadId, {
        harnessProjectId: "project-1",
        harnessFeatureSlug: "feature-1",
        harnessNodeName: "Dev-旧节点",
        harnessNodeStatus: "进行中"
      })

      recordGen({
        threadId,
        workspacePath: repo,
        filePath,
        tool: "write_file",
        generatedContent,
        harnessStage: {
          nodeName: "Test-新节点",
          nodeStatus: "已完成"
        }
      })

      const event = await waitForGenerationCall(reporter)
      assert(
        event.properties?.harnessNodeName === "Test-新节点" &&
          event.properties?.harnessNodeStatus === "已完成",
        "code_gen should use the stage snapshot captured at mutation time"
      )
      assert(
        event.properties?.harnessProjectId === "project-1" &&
          event.properties?.harnessFeatureSlug === "feature-1",
        "mutation-time stage override should preserve the remaining Harness context"
      )

      const row = getGenRowByEventId(String(event.properties?.eventId ?? ""))
      assert(
        row?.harness_node_name === "Test-新节点" && row.harness_node_status === "已完成",
        "the persisted baseline should carry the same stage into code_adopt"
      )
    })
  })
  console.log("PASS code_gen uses the mutation-time Harness stage snapshot")
}

async function testOversizeEditReportsNetGeneratedLines(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    reporter.failGeneration = true
    reporter.failAdoption = true
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("oversize-net-generation", async (repo) => {
      const filePath = join(repo, "large.ts")
      const oldString = Array.from(
        { length: 20_001 },
        (_, index) => `const v${index} = ${index}`
      ).join("\n")
      const newString = `${oldString}\nexport const onlyNewLine = true`
      await writeFile(filePath, newString)

      recordGen({
        threadId: "oversize-net-generation",
        workspacePath: repo,
        filePath,
        tool: "edit_file",
        generatedContent: newString,
        oldString,
        occurrences: 1
      })

      const genEvent = await waitForGenerationCall(reporter)
      assert(
        genEvent.properties?.lineCount === 1,
        "oversize code_gen should report one net-new line"
      )
      assert(
        genEvent.properties?.deletedLineCount === 0 &&
          genEvent.properties?.netNewRatio === 1 &&
          genEvent.properties?.newRatio === undefined &&
          genEvent.properties?.changeKind === "new",
        "oversize append should preserve the new-only classification"
      )
      await flushAdoptionEventOutbox()
      const adoptEvent = reporter.adoptionCalls.find(
        (event) => event.properties?.genEventId === genEvent.properties?.eventId
      )
      assert(adoptEvent !== undefined, "oversize code_gen/code_adopt should be delivered together")
      assert(
        getOutboxEvent(genEvent.eventId)?.status === "retry" &&
          getOutboxEvent(adoptEvent.eventId)?.status === "retry",
        "both oversize envelopes should remain durable after upload failures"
      )
      assert(
        adoptEvent?.properties?.verdict === "skipped_large",
        "oversize edit should stay terminal"
      )
      assert(
        adoptEvent?.properties?.generatedLineCount === 1 &&
          adoptEvent.properties?.effectiveGeneratedLineCount === 1,
        "oversize terminal event should use the same net-new denominator"
      )
      assert(
        adoptEvent?.properties?.netNewRatio === 1 &&
          adoptEvent.properties?.newRatio === undefined &&
          adoptEvent.properties?.changeKind === "new",
        "oversize terminal event should carry the same change classification"
      )
      assert(
        findPendingGensForFile(filePath, 0).length === 0,
        "oversize edit should continue skipping the measurement index"
      )
    })
  })
  console.log("PASS oversize edit telemetry uses net-new generated lines")
}

async function testStableOutboxRetryAcrossRestart(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    reporter.failAdoption = true
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("adoption-outbox-retry", async (repo) => {
      const committed = await generateAndCommit(repo, "durable.ts")
      const completed = await measureForCommit(
        committed.snapshots,
        committed.commitSha,
        committed.commitTimeMs,
        repo
      )
      assert(completed, "commit measurement should become durable before returning")
      await flushAdoptionEventOutbox()

      assert(reporter.adoptionCalls.length === 1, "first delivery attempt should fail once")
      const firstEvent = reporter.adoptionCalls[0]
      const firstRow = getOutboxEvent(firstEvent.eventId)
      assert(firstRow?.status === "retry", "failed delivery should remain in retry state")
      assert(
        getGenRowByEventId(committed.genEventId)?.measured === 1,
        "gen row should be measured in the same durable transaction"
      )
      assert(
        getGenRowByEventId(committed.genEventId)?.generated_lines_blob == null,
        "durable measurement should clear the temporary generated-source payload"
      )
      assert(
        getAdoptLineDetails(committed.commitSha, committed.genEventId) !== null,
        "durable measurement should persist local line details in the same transaction"
      )
      assert(
        (await getCommitMeasurementStatus(repo, committed.commitSha)) === "completed",
        "commit job should complete only after measurement and outbox persistence"
      )
      assert(
        firstEvent.properties?.genEventId === committed.genEventId,
        "outbox event should reference the measured generation"
      )
      assert(
        firstEvent.properties?.netNewRatio === 1 && firstEvent.properties?.newRatio === undefined,
        "measured adoption should use only the explicitly-double ratio field"
      )

      // Make the failed row immediately due, then restart before retrying. This
      // verifies the serialized envelope—not a rebuilt event—survives SQLite.
      markOutboxFailed(firstEvent.eventId, "retry after restart", 0, false)
      assert(flushAdoptionIndex(), "retry state should flush before restart")
      shutdownAdoptionTracker()

      reporter.failAdoption = false
      await initializeAdoptionTracker()
      await flushAdoptionEventOutbox()

      assert(reporter.adoptionCalls.length === 2, "persisted event should retry after restart")
      const retriedEvent = reporter.adoptionCalls[1]
      assert(
        retriedEvent.eventId === firstEvent.eventId,
        "retry must reuse the exact top-level server idempotency key"
      )
      assert(
        JSON.stringify(retriedEvent) === JSON.stringify(firstEvent),
        "retry must reuse the complete immutable event payload"
      )
      assert(
        getOutboxEvent(firstEvent.eventId)?.status === "delivered",
        "successful retry should mark the outbox row delivered"
      )
    })
  })
  console.log("PASS adoption outbox retries the same eventId across restart")
}

async function testCommitJobRecoveryFromRepoAndSha(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    setEventReporter(reporter)
    await initializeAdoptionTracker()

    await withTempRepo("adoption-commit-job", async (repo) => {
      const committed = await generateAndCommit(repo, "recovered.ts")
      const jobId = commitJobId(repo, committed.commitSha)
      const queued = enqueueCommitJob({
        jobId,
        repoPath: repo,
        commitSha: committed.commitSha,
        commitTimeMs: committed.commitTimeMs,
        createdAt: Date.now()
      })
      assert(queued?.status === "pending", "commit job should be durable before measurement starts")
      shutdownAdoptionTracker()

      // No staged snapshots are retained. The restarted worker must reconstruct
      // them from repo_path + commit_sha and then close the job transactionally.
      await initializeAdoptionTracker()
      await flushAdoptionCommitJobs()
      await flushAdoptionEventOutbox()

      assert(getCommitJob(jobId)?.status === "completed", "recovered commit job should complete")
      assert(
        getGenRowByEventId(committed.genEventId)?.measured === 1,
        "recovered job should measure the original generation"
      )
      assert(
        reporter.adoptionCalls.some(
          (event) => event.properties?.genEventId === committed.genEventId
        ),
        "recovered job should persist and deliver its code_adopt event"
      )
    })
  })
  console.log("PASS commit job recovers snapshots from repo path and SHA")
}

async function testOutboxAttemptAndRetentionLimits(): Promise<void> {
  await withIsolatedAdoptionStore(async () => {
    const reporter = new AdoptionReporter()
    reporter.failAdoption = true
    setEventReporter(reporter)
    await initializeAdoptionTracker()
    await flushAdoptionEventOutbox()

    const event = buildEvent("code_adopt", "code_adoption", {
      eventId: "a_attempt_limit_test",
      genEventId: "g_attempt_limit_test"
    })
    assert(
      enqueueEventOutbox({
        eventId: event.eventId,
        eventName: event.eventName,
        payloadJson: JSON.stringify(event),
        createdAt: Date.now()
      }),
      "attempt-limit event should enter the outbox"
    )

    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) markOutboxFailed(event.eventId, "make retry due", 0, false)
      await flushAdoptionEventOutbox()
    }

    const exhausted = getOutboxEvent(event.eventId)
    assert(exhausted?.attempts === 10, "outbox should make at most ten upload attempts")
    assert(exhausted.status === "dead_letter", "the tenth failure should stop further retries")
    assert(reporter.adoptionCalls.length === 10, "reporter should be called exactly ten times")
    await flushAdoptionEventOutbox()
    assert(reporter.adoptionCalls.length === 10, "dead-letter event must not be retried again")

    const retryExpiredEvent = buildEvent("code_adopt", "code_adoption", {
      eventId: "a_retry_window_test",
      genEventId: "g_retry_window_test"
    })
    assert(
      enqueueEventOutbox({
        eventId: retryExpiredEvent.eventId,
        eventName: retryExpiredEvent.eventName,
        payloadJson: JSON.stringify(retryExpiredEvent),
        createdAt: Date.now() - 25 * 60 * 60 * 1000
      }),
      "retry-window event should enter the outbox"
    )
    await flushAdoptionEventOutbox()
    assert(reporter.adoptionCalls.length === 10, "events older than one day must not be uploaded")
    assert(
      getOutboxEvent(retryExpiredEvent.eventId)?.status === "dead_letter",
      "expired retry window should move the event to dead letter"
    )

    const expiredEvent = buildEvent("code_adopt", "code_adoption", {
      eventId: "a_retention_test",
      genEventId: "g_retention_test"
    })
    const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000
    assert(
      enqueueEventOutbox({
        eventId: expiredEvent.eventId,
        eventName: expiredEvent.eventName,
        payloadJson: JSON.stringify(expiredEvent),
        createdAt: fifteenDaysAgo
      }),
      "retention event should enter the outbox"
    )
    cleanupAdoptionDeliveryRecords(Date.now() - 14 * 24 * 60 * 60 * 1000)
    assert(
      getOutboxEvent(expiredEvent.eventId) === null,
      "all outbox states should expire fourteen days after creation"
    )
  })
  console.log(
    "PASS outbox stops after ten attempts, stops uploading after one day, and expires after fourteen days"
  )
}

async function main(): Promise<void> {
  await testTestGenerationUsesSeparateDurableOutbox()
  await testCodeGenRequiresAnIndexedBaseline()
  await testCodeGenUsesDurableBatchedOutbox()
  await testCodeGenUsesMutationTimeHarnessStage()
  await testOversizeEditReportsNetGeneratedLines()
  await testStableOutboxRetryAcrossRestart()
  await testCommitJobRecoveryFromRepoAndSha()
  await testOutboxAttemptAndRetentionLimits()
}

async function run(): Promise<void> {
  testDataRoot = await mkdtemp(join(tmpdir(), "adoption-outbox-data-"))
  process.env.CMB_COWORK_AGENT_HOME = testDataRoot
  try {
    const adoptionTracker = await import("../src/main/services/adoption-tracker.ts")
    const adoptionIndex = await import("../src/main/services/adoption-index.ts")
    const eventReporter = await import("../src/main/services/event-reporter.ts")
    ;({
      captureStagedSnapshotsForCommit,
      flushAdoptionCommitJobs,
      flushAdoptionEventOutbox,
      getCommitMeasurementStatus,
      initializeAdoptionTracker,
      measureForCommit,
      recordGen,
      setAdoptionContext,
      shutdownAdoptionTracker,
      waitForAdoptionRecordGenIdleForTest
    } = adoptionTracker)
    ;({
      cleanupAdoptionDeliveryRecords,
      closeAdoptionIndex,
      enqueueCommitJob,
      enqueueEventOutbox,
      findPendingGensForFile,
      flushAdoptionIndex,
      getAdoptLineDetails,
      getCommitJob,
      getGenRowByEventId,
      getOutboxEvent,
      markOutboxFailed
    } = adoptionIndex)
    ;({ buildEvent, NoopEventReporter, setEventReporter } = eventReporter)
    await main()
  } finally {
    await waitForAdoptionRecordGenIdleForTest?.()
    shutdownAdoptionTracker?.()
    await rm(testDataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

run().catch((error) => {
  console.error("FAIL adoption outbox tests", error)
  process.exitCode = 1
})
