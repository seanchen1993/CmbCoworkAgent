/**
 * Durable code-adoption delivery tests.
 *
 * Run:
 *   npx tsx tests/adoption-outbox.spec.ts
 */

import { execFile } from "child_process"
import { createHash } from "crypto"
import { existsSync } from "fs"
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "fs/promises"
import { homedir, tmpdir } from "os"
import { join, resolve } from "path"
import { promisify } from "util"
import {
  captureStagedSnapshotsForCommit,
  flushAdoptionCommitJobs,
  flushAdoptionEventOutbox,
  getCommitMeasurementStatus,
  initializeAdoptionTracker,
  measureForCommit,
  recordGen,
  shutdownAdoptionTracker
} from "../src/main/services/adoption-tracker.ts"
import {
  cleanupAdoptionDeliveryRecords,
  enqueueCommitJob,
  enqueueEventOutbox,
  findPendingGensForFile,
  flushAdoptionIndex,
  getCommitJob,
  getGenRowByEventId,
  getOutboxEvent,
  markOutboxFailed
} from "../src/main/services/adoption-index.ts"
import {
  buildEvent,
  NoopEventReporter,
  setEventReporter,
  type CoworkEvent,
  type EventReportResult,
  type IEventReporter
} from "../src/main/services/event-reporter.ts"

const execFileAsync = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

class AdoptionReporter implements IEventReporter {
  readonly adoptionCalls: CoworkEvent[] = []
  failAdoption = false

  async report(event: CoworkEvent): Promise<EventReportResult> {
    if (event.eventName !== "code_adopt") return { ok: true, status: 200 }
    this.adoptionCalls.push(JSON.parse(JSON.stringify(event)) as CoworkEvent)
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

async function moveIfExists(from: string, to: string): Promise<boolean> {
  if (!existsSync(from)) return false
  await rm(to, { recursive: true, force: true })
  await rename(from, to)
  return true
}

async function restorePath(path: string, backup: string, existed: boolean): Promise<void> {
  await rm(path, { recursive: true, force: true })
  if (existed) await rename(backup, path)
}

async function withIsolatedAdoptionStore<T>(fn: () => Promise<T>): Promise<T> {
  shutdownAdoptionTracker()
  const root = join(homedir(), ".cmbcoworkagent")
  await mkdir(root, { recursive: true })
  const backupRoot = await mkdtemp(join(tmpdir(), "adoption-outbox-backup-"))
  const adoptionDir = join(root, "adoption")
  const adoptionIndex = join(root, "adoption-index.sqlite")
  const adoptionDirBackup = join(backupRoot, "adoption")
  const adoptionIndexBackup = join(backupRoot, "adoption-index.sqlite")
  const hadAdoptionDir = await moveIfExists(adoptionDir, adoptionDirBackup)
  const hadAdoptionIndex = await moveIfExists(adoptionIndex, adoptionIndexBackup)
  try {
    return await fn()
  } finally {
    shutdownAdoptionTracker()
    setEventReporter(new NoopEventReporter())
    await restorePath(adoptionDir, adoptionDirBackup, hadAdoptionDir)
    await restorePath(adoptionIndex, adoptionIndexBackup, hadAdoptionIndex)
    await rm(backupRoot, { recursive: true, force: true })
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
        (await getCommitMeasurementStatus(repo, committed.commitSha)) === "completed",
        "commit job should complete only after measurement and outbox persistence"
      )
      assert(
        firstEvent.properties?.genEventId === committed.genEventId,
        "outbox event should reference the measured generation"
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
    assert(
      reporter.adoptionCalls.length === 10,
      "events older than one day must not be uploaded"
    )
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
  await testStableOutboxRetryAcrossRestart()
  await testCommitJobRecoveryFromRepoAndSha()
  await testOutboxAttemptAndRetentionLimits()
}

main().catch((error) => {
  console.error("FAIL adoption outbox tests", error)
  process.exitCode = 1
})
