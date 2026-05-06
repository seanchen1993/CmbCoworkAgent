/**
 * Unit tests for async coordinator worker lifecycle.
 *
 * Run:
 *   npx -y tsx tests/coordinator-worker-manager.spec.ts
 */

import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  CoordinatorWorkerManager,
  MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY,
  MAX_COORDINATOR_WORKERS_IN_MEMORY,
  deleteCoordinatorWorkerArtifacts,
  type CoordinatorWorkerRunResult,
  type CoordinatorWorkerRunInput
} from "../src/main/agent/coordinator-worker-manager.ts"
import { usesCaseInsensitiveCoordinatorPathMatching } from "../src/main/agent/coordinator-worker-paths.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 2000
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

function workerResultPath(workspace: string, threadId: string, workerId: string): string {
  return join(
    workspace,
    ".cmbdevclaw",
    "coordinator",
    threadId,
    "reports",
    "workers",
    `${workerId}.json`
  )
}

function workerStatePath(workspace: string, threadId: string, workerId: string): string {
  return join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers", `${workerId}.json`)
}

async function testStartAndComplete(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let capturedInput: CoordinatorWorkerRunInput | null = null
    const updates: string[] = []

    const started = manager.startWorker({
      parentThreadId: "thread-123",
      workspacePath: workspace,
      role: "implementer",
      description: "Implement docs",
      prompt: "Write docs",
      runner: async (input) => {
        capturedInput = input
        input.onProgress({ type: "tool_call", toolName: "read_file" })
        return run.promise
      },
      onUpdate: (event) => {
        updates.push(`${event.worker.status}:${event.worker.last_tool_name ?? ""}`)
      }
    })

    assert(started.status === "running", "new worker should start as running")
    assert(started.worker_thread_id.startsWith("thread-123__worker__"), "worker thread id")
    await waitFor(() => capturedInput !== null, "runner start")
    assert(
      capturedInput?.workerThreadId === started.worker_thread_id,
      "runner receives worker thread id"
    )

    const statePath = join(
      workspace,
      ".cmbdevclaw",
      "coordinator",
      "thread-123",
      "workers",
      `${started.worker_id}.json`
    )
    await waitFor(async () => {
      try {
        return (await readJson(statePath)).status === "running"
      } catch {
        return false
      }
    }, "running state persistence")

    run.resolve({
      summary: "docs written",
      reportPath: `reports/workers/${started.worker_id}.handoff.json`,
      rawText: "raw worker handoff"
    })
    await manager.waitForWorkers("thread-123", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const completed = manager.readWorkers("thread-123", started.worker_id)[0]
    assert(completed.summary === "docs written", "completed worker should expose summary")
    assert(completed.tool_call_count === 1, "completed worker should expose tool count")
    assert(completed.last_tool_name === "read_file", "completed worker should expose last tool")
    assert(
      completed.report_path === `reports/workers/${started.worker_id}.handoff.json`,
      "completed worker should expose report path"
    )
    assert(
      completed.result_path ===
        `.cmbdevclaw/coordinator/thread-123/reports/workers/${started.worker_id}.json`,
      "completed worker should expose result path"
    )
    assert(
      updates.some((update) => update === "running:read_file") &&
        updates.some((update) => update === "completed:read_file"),
      "worker update callback should receive progress and completion"
    )

    const persisted = await readJson(statePath)
    assert(persisted.status === "completed", "worker completion should be persisted")
    assert(
      persisted.report_path === `reports/workers/${started.worker_id}.handoff.json`,
      "worker report path should be persisted"
    )

    const resultPath = workerResultPath(workspace, "thread-123", started.worker_id)
    const result = await readJson(resultPath)
    assert(result.raw_text === "raw worker handoff", "worker result file should include raw text")
    assert(result.result_path === completed.result_path, "worker result file should include path")
    const readResult = await manager.readWorkerResult("thread-123", started.worker_id, {
      maxChars: 1_000
    })
    assert(
      readResult.result_text?.includes("raw worker handoff"),
      "readWorkerResult should expose bounded result text"
    )
    assert(readResult.result_truncated === false, "short worker result should not be truncated")

    assert(
      manager.hasNotifications("thread-123"),
      "hasNotifications should be true after terminal notification is queued"
    )
    const notifications = manager.drainNotifications("thread-123")
    assert(notifications.length === 1, "completed worker should enqueue one notification")
    assert(
      notifications[0].includes("<task-notification>") &&
        notifications[0].includes(`<task-id>${started.worker_id}</task-id>`) &&
        notifications[0].includes("<output-file>") &&
        notifications[0].includes("<result-path>"),
      "notification should include task id and output file path"
    )
    assert(manager.drainNotifications("thread-123").length === 0, "notifications should drain once")
    assert(
      !manager.hasNotifications("thread-123"),
      "hasNotifications should be false after draining notifications"
    )

    const afterNoopCancel = await manager.cancelWorker(
      "thread-123",
      started.worker_id,
      "too late"
    )
    assert(afterNoopCancel.status === "completed", "cancel should not mutate completed workers")
  })
}

async function testWaitForWorkersHonorsAbortSignal(): Promise<void> {
  await withTempDir("coordinator-worker-manager-abort-wait", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const pending = deferred<CoordinatorWorkerRunResult>()
    const started = await manager.startWorkerAndPersist({
      parentThreadId: "thread-abort-wait",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      description: "Long worker",
      prompt: "keep running",
      runner: () => pending.promise
    })

    const controller = new AbortController()
    const startedAt = Date.now()
    setTimeout(() => controller.abort(), 20)
    const workers = await manager.waitForWorkers("thread-abort-wait", {
      workerId: started.worker_id,
      timeoutMs: 10_000,
      pollIntervalMs: 5_000,
      signal: controller.signal
    })
    const elapsedMs = Date.now() - startedAt

    assert(workers[0]?.status === "running", "aborted wait should return current worker state")
    assert(elapsedMs < 1000, "waitForWorkers should stop promptly when aborted")

    await manager.cancelWorker("thread-abort-wait", started.worker_id, "test cleanup")
    await manager.waitForTerminalPersistence("thread-abort-wait", [started.worker_id])
  })
}

async function testStartWorkerAndPersistWritesInitialStateBeforeReturning(): Promise<void> {
  await withTempDir("coordinator-worker-durable-start", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()

    const started = await manager.startWorkerAndPersist({
      parentThreadId: "thread-durable-start",
      workspacePath: workspace,
      role: "implementer",
      description: "Durable worker start",
      prompt: "Start and wait",
      runner: async () => run.promise
    })

    const persisted = await readJson(
      workerStatePath(workspace, "thread-durable-start", started.worker_id)
    )
    assert(persisted.status === "running", "durable start should persist running state")
    assert(
      persisted.worker_id === started.worker_id,
      "durable start should persist the worker id before returning"
    )

    run.resolve({ summary: "durable worker done" })
    await manager.waitForWorkers("thread-durable-start", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testStartWorkerAndPersistRejectsInitialStateFailure(): Promise<void> {
  await withTempDir("coordinator-worker-durable-start-failure", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const badWorkspace = join(workspace, "not-a-directory")
    await writeFile(badWorkspace, "file, not workspace directory", "utf8")
    const originalWarn = console.warn
    let runnerCalled = false
    console.warn = () => {}

    try {
      let rejected = false
      try {
        await manager.startWorkerAndPersist({
          parentThreadId: "thread-durable-start-fail",
          workspacePath: badWorkspace,
          role: "implementer",
          description: "Durable start should reject",
          prompt: "Start should fail",
          runner: async () => {
            runnerCalled = true
            return { summary: "should not run" }
          }
        })
      } catch {
        rejected = true
      }

      assert(rejected, "durable start should reject when initial state cannot persist")
      assert(!runnerCalled, "durable start should not run worker after initial persist failure")
      const [failed] = manager.readWorkers("thread-durable-start-fail")
      assert(failed?.status === "failed", "durable start failure should leave failed worker state")
      assert(
        failed.last_event.includes("Worker result persistence failed"),
        "durable start failure should settle terminal failure details before rejecting"
      )
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testContinueWorkerAndPersistWritesContinuationStateBeforeReturning(): Promise<void> {
  await withTempDir("coordinator-worker-durable-continue", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-durable-continue"
    const secondRun = deferred<CoordinatorWorkerRunResult>()

    const started = await manager.startWorkerAndPersist({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Durable worker continue",
      prompt: "first",
      runner: async () => ({ summary: "done:first" })
    })

    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const [firstNotification] = manager.drainNotifications(threadId)
    assert(firstNotification?.includes("<turn>1</turn>"), "first turn should enqueue notification")

    const continued = await manager.continueWorkerAndPersist({
      parentThreadId: threadId,
      workerId: started.worker_id,
      prompt: "second",
      runner: async () => secondRun.promise
    })

    assert(continued.turns === 2, "continue durable state should increment turns before returning")
    const persisted = await readJson(workerStatePath(workspace, threadId, started.worker_id))
    assert(persisted.status === "running", "durable continue should persist running state")
    assert(
      persisted.turns === 2,
      "durable continue should persist the updated turn before returning"
    )
    assert(
      !("summary" in persisted) || persisted.summary === undefined,
      "durable continue should no longer persist the old terminal summary as the current state"
    )
    await manager.cancelWorker(threadId, started.worker_id, "test durable continue cleanup")
    secondRun.reject(new Error("test durable continue cleanup"))
    await manager.waitForWorkerCleanup(threadId, [started.worker_id], 1_000)
  })
}

async function testRapidProgressDoesNotOverwriteTerminalState(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const started = manager.startWorker({
      parentThreadId: "thread-rapid-progress",
      workspacePath: workspace,
      role: "implementer",
      description: "Rapid progress",
      prompt: "work",
      runner: async (input) => {
        for (let i = 0; i < 50; i += 1) {
          input.onProgress({ type: "tool_call", toolName: `tool_${i}` })
        }
        return { summary: "rapid progress complete" }
      }
    })

    await manager.waitForWorkers("thread-rapid-progress", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const statePath = workerStatePath(workspace, "thread-rapid-progress", started.worker_id)
    const persisted = await readJson(statePath)
    assert(
      persisted.status === "completed",
      "queued progress writes should not overwrite terminal worker state"
    )
    assert(
      persisted.tool_call_count === 50,
      "terminal worker state should preserve rapid progress count"
    )
    assert(
      persisted.last_tool_name === "tool_49",
      "terminal worker state should preserve latest rapid tool"
    )
  })
}

async function testUpdateCallbackErrorsAreNonFatal(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const originalWarn = console.warn
    let runnerCalled = false
    console.warn = () => {}

    try {
      const started = manager.startWorker({
        parentThreadId: "thread-update-error",
        workspacePath: workspace,
        role: "implementer",
        description: "Update callback should not crash worker",
        prompt: "work",
        runner: async (input) => {
          runnerCalled = true
          input.onProgress({ type: "tool_call", toolName: "read_file" })
          return { summary: "still completed" }
        },
        onUpdate: () => {
          throw new Error("renderer already gone")
        }
      })

      await manager.waitForWorkers("thread-update-error", {
        workerId: started.worker_id,
        timeoutMs: 1_000,
        pollIntervalMs: 10
      })
      const completed = manager.readWorkers("thread-update-error", started.worker_id)[0]
      assert(runnerCalled, "worker should still run when update callback throws")
      assert(
        completed.status === "completed",
        "worker should complete despite update callback error"
      )
      assert(completed.tool_call_count === 1, "progress should still be recorded")
      assert(
        manager.drainNotifications("thread-update-error").length === 1,
        "completion notification should still be queued"
      )
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testBindWorkerUpdatesSupportsMultipleListeners(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let firstWindowUpdates = 0
    let secondWindowUpdates = 0
    let runnerStarted = false

    manager.startWorker({
      parentThreadId: "thread-rebind-update",
      workspacePath: workspace,
      role: "implementer",
      description: "Rebind update worker",
      prompt: "work",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "rebind update runner start")
    manager.bindWorkerUpdates(
      "thread-rebind-update",
      () => {
        firstWindowUpdates += 1
      },
      "window:first"
    )
    manager.bindWorkerUpdates(
      "thread-rebind-update",
      () => {
        secondWindowUpdates += 1
      },
      "window:second"
    )
    run.resolve({ summary: "done" })
    await manager.waitForWorkers("thread-rebind-update", {
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    assert(firstWindowUpdates >= 1, "first listener should continue receiving worker updates")
    assert(secondWindowUpdates >= 1, "second listener should receive worker updates after rebinding")
  })
}

async function testWaitForWorkerCleanupDoesNotFalseTimeoutAtBoundary(): Promise<void> {
  const manager = new CoordinatorWorkerManager()
  const originalDateNow = Date.now
  const internals = manager as unknown as {
    readWorkerRecordsAsync: (
      parentThreadId: string,
      workerId?: string
    ) => Promise<
      Array<{
        workerId: string
        currentRun?: Promise<void>
        terminalPersistPromise?: Promise<void>
        statePersistPromise?: Promise<void>
      }>
    >
  }
  const originalReadWorkerRecordsAsync = internals.readWorkerRecordsAsync
  const nowSequence = [0, 5, 5, 5]
  let readCount = 0

  try {
    Date.now = () => (nowSequence.length > 1 ? nowSequence.shift()! : nowSequence[0]!)
    internals.readWorkerRecordsAsync = async () => {
      readCount += 1
      if (readCount === 1) {
        return [
          {
            workerId: "implementer-1-1",
            currentRun: Promise.resolve()
          }
        ]
      }
      return []
    }

    await manager.waitForWorkerCleanup("thread-cleanup-boundary", ["implementer-1-1"], 5)
  } finally {
    Date.now = originalDateNow
    internals.readWorkerRecordsAsync = originalReadWorkerRecordsAsync
  }
}

async function testBlockingWaitForWorkerCompletion(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()

    const started = manager.startWorker({
      parentThreadId: "thread-wait",
      workspacePath: workspace,
      role: "implementer",
      description: "Long task",
      prompt: "wait",
      runner: async () => run.promise
    })

    const timedOut = await manager.waitForWorkers("thread-wait", {
      workerId: started.worker_id,
      timeoutMs: 30,
      pollIntervalMs: 10
    })
    assert(timedOut[0]?.status === "running", "wait should return running worker after timeout")

    run.resolve({ summary: "wait complete" })
    const completed = await manager.waitForWorkers("thread-wait", {
      workerId: started.worker_id,
      timeoutMs: 1000,
      pollIntervalMs: 10
    })
    assert(completed[0]?.status === "completed", "wait should return completed worker")
    assert(completed[0]?.summary === "wait complete", "wait should preserve worker summary")
  })
}

async function testNonBlockingWaitAndUnknownWorkerRead(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let runnerStarted = false

    const started = manager.startWorker({
      parentThreadId: "thread-nonblock",
      workspacePath: workspace,
      role: "implementer",
      description: "Non-blocking task",
      prompt: "wait",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "non-block runner start")
    const before = Date.now()
    const workers = await manager.waitForWorkers("thread-nonblock", {
      block: false,
      timeoutMs: 10_000
    })
    assert(Date.now() - before < 200, "non-blocking wait should return immediately")
    assert(workers[0]?.status === "running", "non-blocking wait should return running worker")
    assert(
      (
        await manager.waitForWorkers("thread-nonblock", {
          workerId: "missing-worker",
          timeoutMs: 10
        })
      ).length === 0,
      "unknown worker wait should return empty list"
    )

    run.resolve({ summary: "done" })
    await manager.waitForWorkers("thread-nonblock", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testPersistenceFailureFailsWorkerSafely(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const badWorkspace = join(workspace, "not-a-directory")
    await writeFile(badWorkspace, "file, not workspace directory", "utf8")
    let runnerCalled = false
    const originalWarn = console.warn
    console.warn = () => {}

    try {
      const started = manager.startWorker({
        parentThreadId: "thread-persist-fail",
        workspacePath: badWorkspace,
        role: "implementer",
        description: "Persistence should fail",
        prompt: "work",
        runner: async () => {
          runnerCalled = true
          return { summary: "should not run" }
        }
      })

      await waitFor(
        () => manager.readWorkers("thread-persist-fail", started.worker_id)[0]?.status === "failed",
        "worker persistence failure"
      )
      const failed = manager.readWorkers("thread-persist-fail", started.worker_id)[0]
      assert(!runnerCalled, "worker runner should not execute if initial state cannot persist")
      assert(failed.error, "persistence failure should expose an error")
      assert(
        failed.last_event.includes("Worker result persistence failed"),
        "persistence failure should be visible in last_event"
      )
      const notifications = manager.drainNotifications("thread-persist-fail")
      assert(notifications.length === 1, "persistence failure should enqueue one notification")
      assert(
        notifications[0].includes("<status>failed</status>"),
        "persistence failure notification should be failed"
      )
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testTerminalResultPersistenceFailurePersistsFailedState(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-terminal-persist-fail"
    const reportsPath = join(workspace, ".cmbdevclaw", "coordinator", threadId, "reports")
    await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId), { recursive: true })
    await writeFile(reportsPath, "file, not reports directory", "utf8")
    const originalWarn = console.warn
    console.warn = () => {}

    try {
      const started = manager.startWorker({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        description: "Terminal persistence should fail",
        prompt: "work",
        runner: async () => ({ summary: "finished but cannot persist result" })
      })

      await waitFor(
        () => manager.readWorkers(threadId, started.worker_id)[0]?.status === "failed",
        "terminal persistence failure"
      )
      const failed = manager.readWorkers(threadId, started.worker_id)[0]
      assert(failed.status === "failed", "terminal result persistence failure should fail worker")
      assert(
        failed.summary?.includes("finished but cannot persist result") &&
          failed.summary.includes("Worker result persistence failed"),
        "terminal persistence failure should preserve worker summary while surfacing persistence failure"
      )
      assert(
        failed.last_event.includes("Worker result persistence failed"),
        "terminal persistence failure should update last_event"
      )
      assert(!failed.result_path, "failed terminal persistence should not expose a result path")

      const persisted = await readJson(workerStatePath(workspace, threadId, started.worker_id))
      assert(
        persisted.status === "failed",
        "terminal persistence failure should be written to worker state file"
      )
      assert(
        typeof persisted.last_event === "string" &&
          persisted.last_event.includes("Worker result persistence failed"),
        "persisted worker state should include terminal persistence failure reason"
      )
      assert(
        typeof persisted.summary === "string" &&
          persisted.summary.includes("finished but cannot persist result") &&
          persisted.summary.includes("Worker result persistence failed"),
        "persisted worker state should keep the original summary alongside the persistence failure"
      )

      const notifications = manager.drainNotifications(threadId)
      assert(
        notifications.length === 1 && notifications[0].includes("<status>failed</status>"),
        "terminal persistence failure should enqueue failed notification"
      )
      assert(
        notifications[0]?.includes("finished but cannot persist result") &&
          notifications[0].includes("Worker result persistence failed"),
        "terminal persistence failure notification should preserve summary context"
      )
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testNotificationEscapesXmlContent(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const started = manager.startWorker({
      parentThreadId: "thread-xml",
      workspacePath: workspace,
      role: "verifier",
      description: "Verify <xml> & quotes",
      prompt: "verify",
      runner: async () => ({
        summary: `checked <tag attr="value"> & it's ok\x01`,
        reportPath: `reports/verifier-"latest".json`
      })
    })

    await manager.waitForWorkers("thread-xml", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const notifications = manager.drainNotifications("thread-xml")
    assert(notifications.length === 1, "xml worker should enqueue one notification")
    assert(
        notifications[0].includes("&lt;tag attr=&quot;value&quot;&gt;") &&
        notifications[0].includes("&amp;") &&
        notifications[0].includes("&apos;s ok") &&
        !notifications[0].includes("\x01") &&
        notifications[0].includes("reports/verifier-&quot;latest&quot;.json"),
      "task notification should escape XML-sensitive content and strip invalid controls"
    )
  })
}

async function testNotificationSummaryTruncatesButResultKeepsFullOutput(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const longSummary = `start-${"x".repeat(900)}-tail`
    const longRawText = `raw-${"y".repeat(900)}-tail`
    const started = manager.startWorker({
      parentThreadId: "thread-long-summary",
      workspacePath: workspace,
      role: "implementer",
      description: "Produce long output",
      prompt: "work",
      runner: async () => ({
        summary: longSummary,
        rawText: longRawText
      })
    })

    await manager.waitForWorkers("thread-long-summary", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const notifications = manager.drainNotifications("thread-long-summary")
    assert(notifications.length === 1, "long worker should enqueue one notification")
    assert(
      notifications[0].includes("...(truncated; read result_path for full output)"),
      "notification should truncate long summaries"
    )
    assert(
      !notifications[0].includes("-tail</summary>"),
      "notification should not include the full long summary tail"
    )

    const result = await readJson(
      workerResultPath(workspace, "thread-long-summary", started.worker_id)
    )
    assert(result.summary === longSummary, "result file should keep the full summary")
    assert(result.raw_text === longRawText, "result file should keep the full raw text")

    const boundedResult = await manager.readWorkerResult(
      "thread-long-summary",
      started.worker_id,
      { maxChars: 1_000 }
    )
    assert(
      (boundedResult.result_chars ?? 0) > 1_000,
      "readWorkerResult should report the original result size"
    )
    assert(
      boundedResult.result_text?.includes("...(truncated)"),
      "readWorkerResult should mark truncated text"
    )
    assert(boundedResult.result_truncated === true, "long worker result should be truncated")
  })
}

async function testWorkerRawTextIsBounded(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const longRawText = `raw-${"z".repeat(220_000)}-tail`
    const started = manager.startWorker({
      parentThreadId: "thread-bounded-raw-text",
      workspacePath: workspace,
      role: "implementer",
      description: "Produce huge raw output",
      prompt: "work",
      runner: async () => ({
        summary: "huge raw output",
        rawText: longRawText
      })
    })

    await manager.waitForWorkers("thread-bounded-raw-text", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const result = await readJson(
      workerResultPath(workspace, "thread-bounded-raw-text", started.worker_id)
    )
    assert(
      typeof result.raw_text === "string" && result.raw_text.length < longRawText.length,
      "worker result should not persist unbounded raw output"
    )
    assert(
      result.raw_text.includes("...(raw worker output truncated)"),
      "worker result should mark truncated raw output"
    )
  })
}

async function testWorkerTranscriptAndTokenUsagePersistence(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const started = manager.startWorker({
      parentThreadId: "thread-transcript",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/app.ts"],
      description: "Persist transcript and usage",
      prompt: "work",
      runner: async (input) => {
        input.onProgress({
          type: "usage",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        })
        return {
          summary: "transcript done",
          rawText: "full raw output",
          transcriptText: [
            JSON.stringify({ type: "user", content: input.prompt }),
            JSON.stringify({ type: "assistant", content: "done" })
          ].join("\n"),
          tokenUsage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }
        }
      }
    })

    await manager.waitForWorkers("thread-transcript", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const completed = manager.readWorkers("thread-transcript", started.worker_id)[0]
    assert(completed.workload === "write", "worker workload should be exposed")
    assert(completed.owned_files.join(",") === "src/app.ts", "owned files should be exposed")
    assert(completed.transcript_path, "completed worker should expose transcript path")
    assert(completed.token_usage?.total_tokens === 19, "completed worker should merge token usage")

    const result = await readJson(
      workerResultPath(workspace, "thread-transcript", started.worker_id)
    )
    assert(
      result.transcript_path === completed.transcript_path,
      "result should persist transcript path"
    )
    assert(
      (result.token_usage as Record<string, unknown>).total_tokens === 19,
      "result should persist token usage"
    )

    const transcript = await readFile(
      join(
        workspace,
        ".cmbdevclaw",
        "coordinator",
        "thread-transcript",
        "reports",
        "workers",
        `${started.worker_id}.transcript.jsonl`
      ),
      "utf8"
    )
    assert(
      transcript.includes("full raw output") === false,
      "transcript should use transcript text"
    )
    assert(transcript.includes('"type":"assistant"'), "transcript file should persist JSONL lines")

    const notifications = manager.drainNotifications("thread-transcript")
    assert(
      notifications[0].includes("<transcript-path>") &&
        notifications[0].includes("<total_tokens>19</total_tokens>"),
      "notification should include transcript path and usage"
    )
  })
}

async function testContinuedWorkerAccumulatesTokenUsage(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const started = manager.startWorker({
      parentThreadId: "thread-continued-usage",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/app.ts"],
      description: "Track multi-turn usage",
      prompt: "first",
      runner: async (input) => {
        input.onProgress({
          type: "usage",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        })
        return {
          summary: `done:${input.prompt}`,
          tokenUsage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }
        }
      }
    })

    await manager.waitForWorkers("thread-continued-usage", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const secondRun = deferred<CoordinatorWorkerRunResult>()
    let secondRunStarted = false
    let secondRunInput: CoordinatorWorkerRunInput | undefined
    await manager.continueWorker({
      parentThreadId: "thread-continued-usage",
      workerId: started.worker_id,
      prompt: "second",
      runner: async (input) => {
        secondRunStarted = true
        secondRunInput = input
        assert(input.prompt === "second", "continued worker should receive the new prompt")
        return secondRun.promise
      }
    })
    await waitFor(() => secondRunStarted, "continued usage runner start")
    assert(
      manager.readWorkers("thread-continued-usage", started.worker_id)[0]?.token_usage === undefined,
      "continued worker should clear visible per-run usage while the new turn is running"
    )
    secondRunInput?.onProgress({
      type: "usage",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    })
    assert(
      manager.readWorkers("thread-continued-usage", started.worker_id)[0]?.token_usage
        ?.total_tokens === 24,
      "continued worker should add current-run usage to previous usage while running"
    )
    secondRunInput?.onProgress({
      type: "usage",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    })
    assert(
      manager.readWorkers("thread-continued-usage", started.worker_id)[0]?.token_usage
        ?.total_tokens === 24,
      "continued worker usage should not jump down when a later progress event has a smaller usage snapshot"
    )
    secondRunInput?.onProgress({
      type: "usage",
      usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 }
    })
    assert(
      manager.readWorkers("thread-continued-usage", started.worker_id)[0]?.token_usage
        ?.total_tokens === 27,
      "continued worker usage should track the current-run high-water usage while running"
    )
    secondRun.resolve({
      summary: "done:second",
      tokenUsage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
    })

    await manager.waitForWorkers("thread-continued-usage", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const completed = manager.readWorkers("thread-continued-usage", started.worker_id)[0]
    assert(completed.summary === "done:second", "continued worker should keep latest summary")
    assert(
      completed.token_usage?.input_tokens === 32 &&
        completed.token_usage.output_tokens === 17 &&
        completed.token_usage.total_tokens === 49,
      "continued worker should accumulate token usage across turns"
    )

    const result = await readJson(
      workerResultPath(workspace, "thread-continued-usage", started.worker_id)
    )
    assert(
      (result.token_usage as Record<string, unknown>).total_tokens === 49,
      "continued worker result should persist cumulative token usage"
    )
  })
}

async function testUsageProgressDoesNotHideLastToolEvent(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    const started = manager.startWorker({
      parentThreadId: "thread-usage-last-event",
      workspacePath: workspace,
      role: "implementer",
      description: "Keep useful last event",
      prompt: "work",
      runner: async (input) => {
        input.onProgress({ type: "tool_call", toolName: "read_file" })
        input.onProgress({
          type: "usage",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
        return run.promise
      }
    })

    await waitFor(
      () =>
        manager.readWorkers("thread-usage-last-event", started.worker_id)[0]?.last_event ===
        "Worker called tool: read_file",
      "usage progress should not hide last tool event"
    )
    run.resolve({ summary: "done" })
    await manager.waitForWorkers("thread-usage-last-event", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testDuplicateUsageProgressDoesNotEmitRepeatedUpdates(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let usageUpdateCount = 0
    const started = manager.startWorker({
      parentThreadId: "thread-duplicate-usage",
      workspacePath: workspace,
      role: "implementer",
      description: "Ignore duplicate usage snapshots",
      prompt: "work",
      onUpdate: (event) => {
        if (event.worker.token_usage?.total_tokens === 2) {
          usageUpdateCount += 1
        }
      },
      runner: async (input) => {
        input.onProgress({
          type: "usage",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
        input.onProgress({
          type: "usage",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        })
        return run.promise
      }
    })

    await waitFor(
      () => usageUpdateCount === 1,
      "duplicate usage snapshots should emit only one visible update"
    )
    run.resolve({
      summary: "done",
      tokenUsage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })
    await manager.waitForWorkers("thread-duplicate-usage", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testProgressUpdatesAreThrottled(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let visibleProgressUpdates = 0
    const started = manager.startWorker({
      parentThreadId: "thread-throttled-progress",
      workspacePath: workspace,
      role: "implementer",
      description: "Throttle progress fanout",
      prompt: "work",
      onUpdate: (event) => {
        if (event.worker.status === "running" && event.worker.tool_call_count > 0) {
          visibleProgressUpdates += 1
        }
      },
      runner: async (input) => {
        for (let i = 0; i < 20; i += 1) {
          input.onProgress({ type: "tool_call", toolName: `tool_${i}` })
        }
        return run.promise
      }
    })

    await waitFor(
      () => visibleProgressUpdates > 0,
      "throttled progress should still become visible"
    )
    assert(
      visibleProgressUpdates <= 2,
      "rapid progress should be coalesced before emitting renderer updates"
    )
    assert(
      manager.readWorkers("thread-throttled-progress", started.worker_id)[0]?.tool_call_count ===
        20,
      "throttling should not drop in-memory progress"
    )

    run.resolve({ summary: "done" })
    await manager.waitForWorkers("thread-throttled-progress", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testStaleProgressFromInterruptedRunIsIgnored(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    let firstRunStarted = false
    const started = manager.startWorker({
      parentThreadId: "thread-stale-progress",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/app.ts"],
      description: "Ignore stale progress",
      prompt: "first",
      runner: async (input) => {
        firstRunStarted = true
        await new Promise<void>((resolve) => {
          input.abortSignal.addEventListener("abort", () => resolve(), { once: true })
        })
        input.onProgress({ type: "tool_call", toolName: "stale_tool" })
        return { summary: "old run should not win" }
      }
    })

    await waitFor(() => firstRunStarted, "first worker run should start before continue")
    await manager.continueWorker({
      parentThreadId: "thread-stale-progress",
      workerId: started.worker_id,
      workload: "write",
      ownedFiles: ["src/app.ts"],
      prompt: "second",
      runner: async (input) => {
        input.onProgress({ type: "tool_call", toolName: "fresh_tool" })
        return { summary: "fresh run completed" }
      }
    })

    await manager.waitForWorkers("thread-stale-progress", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const completed = manager.readWorkers("thread-stale-progress", started.worker_id)[0]
    assert(completed.summary === "fresh run completed", "fresh continuation should win")
    assert(completed.last_tool_name === "fresh_tool", "stale progress should not update tool name")
    assert(completed.tool_call_count === 1, "stale progress should not increment tool count")
  })
}

async function testWorkerWriteSafetyAndReadOnlyParallelism(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    let invalidOwnedFilesRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-owned-files",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["/etc/passwd", "../secret.txt", "nested/../bad.ts"],
        description: "Reject unsafe owned files",
        prompt: "reject unsafe",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      invalidOwnedFilesRejected = String(error).includes("Invalid owned_files path")
    }
    assert(
      invalidOwnedFilesRejected,
      "unsafe owned_files should be rejected instead of becoming whole-workspace write access"
    )

    const normalizedOwnedFilesWorker = manager.startWorker({
      parentThreadId: "thread-owned-files",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["./src/app.ts", "src/app.ts"],
      description: "Normalize owned files",
      prompt: "normalize",
      runner: async () => ({ summary: "normalized" })
    })
    assert(
      normalizedOwnedFilesWorker.owned_files.join(",") === "src/app.ts",
      "owned_files should drop absolute paths and parent-directory traversal"
    )

    const caseVariantOwnedFilesWorker = manager.startWorker({
      parentThreadId: "thread-owned-case-variants",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/Foo.ts", "src/foo.ts"],
      description: "Normalize case variants",
      prompt: "normalize case variants",
      runner: async () => ({ summary: "case variants normalized" })
    })
    const expectedCaseVariantCount = usesCaseInsensitiveCoordinatorPathMatching(workspace) ? 1 : 2
    assert(
      caseVariantOwnedFilesWorker.owned_files.length === expectedCaseVariantCount,
      "owned_files case-variant dedupe should follow the actual workspace filesystem"
    )

    const externalOwnedRoot = await mkdtemp(join(tmpdir(), "coordinator-owned-files-external-"))
    try {
      await mkdir(join(workspace, "src"), { recursive: true })
      await symlink(externalOwnedRoot, join(workspace, "src", "escape"), "dir")
      let symlinkOwnedFilesRejected = false
      try {
        manager.startWorker({
          parentThreadId: "thread-owned-files-symlink",
          workspacePath: workspace,
          role: "implementer",
          workload: "write",
          ownedFiles: ["src/escape"],
          description: "Reject symlinked owned files that escape workspace",
          prompt: "reject symlink escape",
          runner: async () => ({ summary: "bad symlink" })
        })
      } catch (error) {
        symlinkOwnedFilesRejected = String(error).includes("Invalid owned_files path")
      }
      assert(
        symlinkOwnedFilesRejected,
        "owned_files should reject symlinked paths that escape the workspace root"
      )
    } finally {
      await rm(externalOwnedRoot, { recursive: true, force: true })
    }

    await mkdir(join(workspace, "src", "real-dir"), { recursive: true })
    await symlink(join(workspace, "src", "real-dir"), join(workspace, "src", "alias-dir"), "dir")
    const realDirWriter = manager.startWorker({
      parentThreadId: "thread-owned-files-alias-conflict",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/real-dir"],
      description: "Own the real directory",
      prompt: "own real dir",
      runner: async () => deferred<CoordinatorWorkerRunResult>().promise
    })
    let symlinkAliasConflictRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-owned-files-alias-conflict",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src/alias-dir"],
        description: "Alias directory should conflict",
        prompt: "own alias dir",
        runner: async () => ({ summary: "alias conflict should reject" })
      })
    } catch (error) {
      symlinkAliasConflictRejected = String(error).includes(realDirWriter.worker_id)
    }
    assert(
      symlinkAliasConflictRejected,
      "owned_files overlap checks should treat symlink aliases as conflicting file ownership"
    )

    const holdWrite = deferred<CoordinatorWorkerRunResult>()
    const firstWrite = manager.startWorker({
      parentThreadId: "thread-concurrency",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/a.ts"],
      description: "Edit a",
      prompt: "edit a",
      runner: async () => holdWrite.promise
    })

    const readOnly = manager.startWorker({
      parentThreadId: "thread-concurrency",
      workspacePath: workspace,
      role: "verifier",
      workload: "read_only",
      description: "Inspect while writer runs",
      prompt: "inspect",
      runner: async () => ({ summary: "read only done" })
    })
    assert(readOnly.status === "running", "read-only worker should start beside writer")

    let verifyDuringWriteRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "verifier",
        workload: "verify",
        description: "Verify while writer runs",
        prompt: "verify",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      verifyDuringWriteRejected = String(error).includes("Cannot start verify worker yet")
    }
    assert(
      verifyDuringWriteRejected,
      "verify worker should wait for active write workers before running commands"
    )

    let verifierWriteRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-verifier-write",
        workspacePath: workspace,
        role: "verifier",
        workload: "write",
        description: "Verifier should not write",
        prompt: "try to write",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      verifierWriteRejected = String(error).includes("Verifier workers cannot use")
    }
    assert(verifierWriteRejected, "verifier workers should not be allowed write workload")

    let overlapRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src/a.ts"],
        description: "Edit same file",
        prompt: "edit same",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      overlapRejected = String(error).includes("Cannot start write worker yet")
    }
    assert(overlapRejected, "overlapping write workers should be rejected")

    let dotSegmentOverlapRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src/./a.ts"],
        description: "Edit same file with dot segment",
        prompt: "edit same via dot segment",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      dotSegmentOverlapRejected = String(error).includes("Cannot start write worker yet")
    }
    assert(
      dotSegmentOverlapRejected,
      "owned_files should normalize dot segments before write-conflict checks"
    )

    let repeatedSlashOverlapRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src//a.ts"],
        description: "Edit same file with repeated slash",
        prompt: "edit same via repeated slash",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      repeatedSlashOverlapRejected = String(error).includes("Cannot start write worker yet")
    }
    assert(
      repeatedSlashOverlapRejected,
      "owned_files should normalize repeated slashes before write-conflict checks"
    )

    if (usesCaseInsensitiveCoordinatorPathMatching(workspace)) {
      let caseVariantOverlapRejected = false
      try {
        manager.startWorker({
          parentThreadId: "thread-concurrency",
          workspacePath: workspace,
          role: "implementer",
          workload: "write",
          ownedFiles: ["SRC/A.ts"],
          description: "Edit same file with case variant",
          prompt: "edit same via case variant",
          runner: async () => ({ summary: "bad" })
        })
      } catch (error) {
        caseVariantOverlapRejected = String(error).includes("Cannot start write worker yet")
      }
      assert(
        caseVariantOverlapRejected,
        "owned_files should treat case variants as overlapping on case-insensitive filesystems"
      )
    }

    let directoryOverlapRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src"],
        description: "Edit parent directory",
        prompt: "edit src",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      directoryOverlapRejected = true
    }
    assert(
      directoryOverlapRejected,
      "write worker owning a parent directory should conflict with active file writers"
    )

    const disjoint = manager.startWorker({
      parentThreadId: "thread-concurrency",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/b.ts"],
      description: "Edit b",
      prompt: "edit b",
      runner: async () => ({ summary: "disjoint done" })
    })
    assert(disjoint.status === "running", "disjoint write worker should be allowed")

    let unknownScopeRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        description: "Edit unknown files",
        prompt: "edit unknown",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      unknownScopeRejected = true
    }
    assert(
      unknownScopeRejected,
      "write worker without owned_files should conflict with active writers"
    )

    let rootOwnedFileRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-concurrency-root",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["."],
        description: "Edit root",
        prompt: "edit root",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      rootOwnedFileRejected = String(error).includes("Invalid owned_files path")
    }
    assert(rootOwnedFileRejected, "owned_files should reject ambiguous workspace-root paths")

    const holdVerify = deferred<CoordinatorWorkerRunResult>()
    const activeVerifier = manager.startWorker({
      parentThreadId: "thread-verify-gate",
      workspacePath: workspace,
      role: "verifier",
      workload: "verify",
      description: "Verify current workspace",
      prompt: "verify",
      runner: async () => holdVerify.promise
    })
    assert(activeVerifier.status === "running", "verify worker should start when no writer runs")
    let writeDuringVerifyRejected = false
    try {
      manager.startWorker({
        parentThreadId: "thread-verify-gate",
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src/c.ts"],
        description: "Edit during verification",
        prompt: "edit c",
        runner: async () => ({ summary: "bad" })
      })
    } catch (error) {
      writeDuringVerifyRejected = String(error).includes("Cannot start write worker yet")
    }
    assert(
      writeDuringVerifyRejected,
      "write worker should wait for active verifier before changing files"
    )
    holdVerify.resolve({ summary: "verify done" })
    await manager.waitForWorkers("thread-verify-gate", {
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    holdWrite.resolve({ summary: "write a done" })
    await manager.waitForWorkers("thread-concurrency", {
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const workers = manager.readWorkers("thread-concurrency")
    assert(
      workers.filter((worker) => worker.status === "completed").length === 3,
      "allowed parallel workers should all complete"
    )
    assert(
      workers.find((worker) => worker.worker_id === firstWrite.worker_id)?.owned_files[0] ===
        "src/a.ts",
      "owned files should remain attached to writer"
    )
  })
}

async function testNotificationAcknowledgement(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const first = manager.startWorker({
      parentThreadId: "thread-ack",
      workspacePath: workspace,
      role: "implementer",
      description: "First worker",
      prompt: "first",
      runner: async () => ({ summary: "first done" })
    })
    const second = manager.startWorker({
      parentThreadId: "thread-ack",
      workspacePath: workspace,
      role: "verifier",
      workload: "read_only",
      description: "Second worker",
      prompt: "second",
      runner: async () => ({ summary: "second done" })
    })

    await manager.waitForWorkers("thread-ack", {
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const allNotifications = manager.drainNotifications("thread-ack")
    assert(allNotifications.length === 2, "completed workers should enqueue notifications")
    const firstNotification = allNotifications.find((item) =>
      item.includes(`<task-id>${first.worker_id}</task-id>`)
    )
    const secondNotification = allNotifications.find((item) =>
      item.includes(`<task-id>${second.worker_id}</task-id>`)
    )
    if (!firstNotification || !secondNotification) {
      throw new Error("notifications should include both workers")
    }

    manager.restoreNotifications("thread-ack", allNotifications)
    await manager.acknowledgeNotificationMessages("thread-ack", [firstNotification])
    const notifications = manager.drainNotifications("thread-ack")
    assert(notifications.length === 1, "ack should remove only selected worker notification")
    assert(
      notifications[0].includes(`<task-id>${second.worker_id}</task-id>`),
      "ack should keep unacknowledged worker notifications"
    )

    await manager.acknowledgeNotifications("thread-ack", [second.worker_id])
    assert(
      manager.drainNotifications("thread-ack").length === 0,
      "ack should tolerate already-drained notification queues"
    )

    const restoredNotification = notifications[0]
    manager.restoreNotifications("thread-ack", [restoredNotification])
    manager.restoreNotifications("thread-ack", [restoredNotification])
    const restored = manager.drainNotifications("thread-ack")
    assert(restored.length === 1, "restored notifications should not duplicate existing entries")
    assert(
      restored[0] === restoredNotification,
      "restored notification should preserve original content"
    )
  })
}

async function testInMemoryWorkerHistoryIsPruned(): Promise<void> {
  await withTempDir("coordinator-worker-prune", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-prune"
    const workerIds: string[] = []

    for (let index = 0; index < MAX_COORDINATOR_WORKERS_IN_MEMORY + 8; index += 1) {
      const started = await manager.startWorkerAndPersist({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        workload: "read_only",
        description: `Historical worker ${index}`,
        prompt: "read only task",
        runner: async () => ({ summary: `done ${index}` })
      })
      workerIds.push(started.worker_id)
    }

    await manager.waitForTerminalPersistence(threadId, workerIds)
    await manager.acknowledgeNotificationMessages(threadId, manager.drainNotifications(threadId))

    const running = deferred<CoordinatorWorkerRunResult>()
    const runningWorker = await manager.startWorkerAndPersist({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "read_only",
      description: "Running worker",
      prompt: "stay running",
      runner: async () => running.promise
    })

    const workers = manager.readWorkers(threadId)
    assert(
      workers.length === MAX_COORDINATOR_WORKERS_IN_MEMORY,
      "manager should cap in-memory worker history"
    )
    assert(
      workers.some((worker) => worker.worker_id === runningWorker.worker_id),
      "manager should never prune running workers"
    )
    assert(
      workers.every(
        (worker) => worker.status === "running" || worker.notification_acknowledged === true
      ),
      "manager should only prune acknowledged terminal workers"
    )

    const oldWorkerId = workerIds[0]
    const secondPrunedWorkerId = workerIds[1]
    assert(
      !workers.some((worker) => worker.worker_id === oldWorkerId),
      "old acknowledged worker should be pruned from list views"
    )
    assert(
      !workers.some((worker) => worker.worker_id === secondPrunedWorkerId),
      "second old acknowledged worker should also be pruned from list views"
    )
    const oldResult = await manager.readWorkerResult(threadId, oldWorkerId)
    assert(
      oldResult.result_text?.includes("done 0"),
      "pruned worker result should remain readable from disk"
    )
    await rm(workerStatePath(workspace, threadId, secondPrunedWorkerId), { force: true })
    const prunedSnapshotState = await manager.waitForWorkers(threadId, {
      workerId: secondPrunedWorkerId,
      block: false
    })
    assert(
      prunedSnapshotState[0]?.worker_id === secondPrunedWorkerId,
      "non-blocking reads should restore pruned workers from the in-memory snapshot cache"
    )
    const continuedFromSnapshot = await manager.continueWorker({
      parentThreadId: threadId,
      workerId: secondPrunedWorkerId,
      prompt: "continue pruned worker from snapshot",
      runner: async () => ({ summary: "continued via snapshot cache" })
    })
    assert(
      continuedFromSnapshot.status === "running",
      "pruned worker should continue without needing a synchronous state-file reload"
    )
    await manager.waitForTerminalPersistence(threadId, [secondPrunedWorkerId])
    const continued = await manager.continueWorker({
      parentThreadId: threadId,
      workerId: oldWorkerId,
      prompt: "continue old worker",
      runner: async () => ({ summary: "continued old worker" })
    })
    assert(continued.status === "running", "pruned worker should still be continuable by id")
    await manager.waitForTerminalPersistence(threadId, [oldWorkerId])

    running.resolve({ summary: "done running" })
    await manager.waitForTerminalPersistence(threadId, [runningWorker.worker_id])
    await manager.waitForWorkerCleanup(threadId)
  })
}

async function testPrunedSnapshotCacheIsBounded(): Promise<void> {
  await withTempDir("coordinator-worker-pruned-snapshots", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-pruned-snapshot-cap"
    const workerIds: string[] = []

    for (let index = 0; index < MAX_COORDINATOR_WORKERS_IN_MEMORY + 25; index += 1) {
      const started = await manager.startWorkerAndPersist({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        workload: "read_only",
        description: `Historical worker ${index}`,
        prompt: "read only task",
        runner: async () => ({ summary: `done ${index}` })
      })
      workerIds.push(started.worker_id)
    }

    await manager.waitForTerminalPersistence(threadId, workerIds)
    await manager.acknowledgeNotificationMessages(threadId, manager.drainNotifications(threadId))

    const internals = manager as unknown as {
      workersByParent: Map<string, Map<string, unknown>>
      prunedSnapshotsByParent: Map<string, Map<string, unknown>>
    }
    const snapshotCount =
      internals.prunedSnapshotsByParent.get(threadId)?.size ?? 0

    assert(
      snapshotCount <= MAX_COORDINATOR_PRUNED_SNAPSHOTS_IN_MEMORY,
      "pruned snapshot cache should stay bounded per thread"
    )

    for (const workerId of workerIds.slice(0, 25)) {
      await manager.readWorkerResult(threadId, workerId)
    }

    const recordsSize = internals.workersByParent.get(threadId)?.size ?? 0
    assert(
      recordsSize === MAX_COORDINATOR_WORKERS_IN_MEMORY,
      "reading historical worker results should not repopulate the full pruned history into the primary in-memory map"
    )

    const oldestPrunedWorkerId = workerIds[0]
    const newestPrunedWorkerId = workerIds[24]
    await rm(workerStatePath(workspace, threadId, oldestPrunedWorkerId), { force: true })
    await rm(workerStatePath(workspace, threadId, newestPrunedWorkerId), { force: true })

    const oldestPrunedState = await manager.waitForWorkers(threadId, {
      workerId: oldestPrunedWorkerId,
      block: false
    })
    const newestPrunedState = await manager.waitForWorkers(threadId, {
      workerId: newestPrunedWorkerId,
      block: false
    })

    assert(
      oldestPrunedState.length === 0,
      "oldest pruned workers should fall out of the bounded snapshot cache first"
    )
    assert(
      newestPrunedState[0]?.worker_id === newestPrunedWorkerId,
      "most recently pruned workers should remain recoverable from the bounded snapshot cache"
    )
  })
}

async function testActiveRestoreSkipsAcknowledgedTerminalHistory(): Promise<void> {
  await withTempDir("coordinator-worker-prune", async (workspace) => {
    const threadId = "thread-active-restore-prune"
    const firstManager = new CoordinatorWorkerManager()
    const workerIds: string[] = []

    for (let index = 0; index < MAX_COORDINATOR_WORKERS_IN_MEMORY + 8; index += 1) {
      const started = await firstManager.startWorkerAndPersist({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        workload: "read_only",
        description: `Historical worker ${index}`,
        prompt: "read only task",
        runner: async () => ({ summary: `done ${index}` })
      })
      workerIds.push(started.worker_id)
    }

    await firstManager.waitForTerminalPersistence(threadId, workerIds)
    await firstManager.acknowledgeNotificationMessages(
      threadId,
      firstManager.drainNotifications(threadId)
    )

    const secondManager = new CoordinatorWorkerManager()
    const activeRestore = await secondManager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace,
      mode: "active"
    })
    assert(
      activeRestore.length === 0,
      "active restore should skip acknowledged terminal worker history"
    )

    const fullRestore = await secondManager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace
    })
    assert(
      fullRestore.length === MAX_COORDINATOR_WORKERS_IN_MEMORY,
      "full restore should keep existing historical read semantics capped in memory"
    )
    const oldResult = await secondManager.readWorkerResult(threadId, workerIds[0])
    assert(
      oldResult.result_text?.includes("done 0"),
      "active restore should not prevent explicit historical result reads"
    )
  })
}

async function testActiveRestoreDoesNotParseAcknowledgedTerminalHistory(): Promise<void> {
  await withTempDir("coordinator-worker-prune", async (workspace) => {
    const threadId = "thread-active-restore-scan"
    const workerId = "implementer-history"
    await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers"), {
      recursive: true
    })
    await writeFile(
      workerStatePath(workspace, threadId, workerId),
      `{
  "worker_id": "${workerId}",
  "worker_thread_id": "${threadId}__worker__${workerId}",
  "parent_thread_id": "${threadId}",
  "role": "implementer",
  "description": "Large historical worker",
  "status": "completed",
  "turns": 1,
  "created_at": "2026-04-29T00:00:00.000Z",
  "updated_at": "2026-04-29T00:01:00.000Z",
  "last_event": "Worker completed.",
  "notification_acknowledged": true,
  "large_payload": "${"x".repeat(20_000)}"
`,
      "utf8"
    )

    const manager = new CoordinatorWorkerManager()
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]): void => {
      warnings.push(args)
    }
    try {
      const activeRestore = await manager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath: workspace,
        mode: "active"
      })
      assert(
        activeRestore.length === 0,
        "active restore should skip acknowledged terminal files before full JSON parse"
      )
      assert(warnings.length === 0, "active restore should not parse or warn on skipped history")

      await manager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath: workspace
      })
      assert(warnings.length > 0, "full restore should still parse and warn on invalid JSON")
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testPersistedWorkerStateKeepsActiveRestoreKeysFirst(): Promise<void> {
  await withTempDir("coordinator-worker-state-order", async (workspace) => {
    const threadId = "thread-active-restore-key-order"
    const manager = new CoordinatorWorkerManager()
    const longDescription = "Detailed historical worker with lots of planning context. ".repeat(400)
    const ownedFiles = Array.from({ length: 250 }, (_, index) => `src/modules/file-${index}.ts`)

    const started = await manager.startWorkerAndPersist({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles,
      description: longDescription,
      prompt: "write scoped files",
      runner: async () => ({ summary: "done" })
    })

    await manager.waitForTerminalPersistence(threadId, [started.worker_id])
    await manager.acknowledgeNotificationMessages(threadId, manager.drainNotifications(threadId))

    const state = await readFile(workerStatePath(workspace, threadId, started.worker_id), "utf8")
    const statusIndex = state.indexOf('"status"')
    const acknowledgedIndex = state.indexOf('"notification_acknowledged"')
    const ownedFilesIndex = state.indexOf('"owned_files"')
    const descriptionIndex = state.indexOf('"description"')

    assert(statusIndex >= 0 && statusIndex < 256, "status should be near the start of state JSON")
    assert(
      acknowledgedIndex >= 0 && acknowledgedIndex < 512,
      "notification acknowledgement should be near the start of state JSON"
    )
    assert(
      statusIndex < ownedFilesIndex && statusIndex < descriptionIndex,
      "active-restore status key should not be pushed behind large worker fields"
    )
    assert(
      acknowledgedIndex < ownedFilesIndex && acknowledgedIndex < descriptionIndex,
      "active-restore acknowledgement key should not be pushed behind large worker fields"
    )
  })
}

async function testRestoreReplaysUnacknowledgedTerminalNotification(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const threadId = "thread-pending-notification"
    const firstManager = new CoordinatorWorkerManager()
    const started = firstManager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Pending terminal notification",
      prompt: "work",
      runner: async () => ({ summary: "completed before restart" })
    })

    await firstManager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const originalNotification = firstManager.drainNotifications(threadId)
    assert(originalNotification.length === 1, "completed worker should queue a notification")
    const pendingState = await readJson(workerStatePath(workspace, threadId, started.worker_id))
    assert(
      pendingState.notification_acknowledged === false,
      "terminal state should persist pending notification acknowledgement"
    )

    const secondManager = new CoordinatorWorkerManager()
    await secondManager.restoreWorkersForThread({ parentThreadId: threadId, workspacePath: workspace })
    const restoredNotification = secondManager.drainNotifications(threadId)
    assert(
      restoredNotification.length === 1 &&
        restoredNotification[0].includes(`<task-id>${started.worker_id}</task-id>`),
      "restore should replay unacknowledged terminal notifications"
    )

    await secondManager.acknowledgeNotifications(threadId, [started.worker_id])
    await waitFor(async () => {
      const acknowledgedState = await readJson(workerStatePath(workspace, threadId, started.worker_id))
      return acknowledgedState.notification_acknowledged === true
    }, "notification acknowledgement persistence")

    const thirdManager = new CoordinatorWorkerManager()
    await thirdManager.restoreWorkersForThread({ parentThreadId: threadId, workspacePath: workspace })
    assert(
      thirdManager.drainNotifications(threadId).length === 0,
      "restore should not replay acknowledged terminal notifications"
    )
  })
}

async function testRestoreSkipsStaleNotificationAfterContinue(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const continuation = deferred<CoordinatorWorkerRunResult>()

    const started = manager.startWorker({
      parentThreadId: "thread-stale-notification",
      workspacePath: workspace,
      role: "implementer",
      description: "Worker with stale notification",
      prompt: "first",
      runner: async () => ({ summary: "first completed" })
    })

    await manager.waitForWorkers("thread-stale-notification", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const [oldNotification] = manager.drainNotifications("thread-stale-notification")
    assert(oldNotification, "completed worker should create an initial notification")

    await manager.continueWorker({
      parentThreadId: "thread-stale-notification",
      workerId: started.worker_id,
      prompt: "continue same worker",
      runner: async () => continuation.promise
    })
    await waitFor(
      () =>
        manager.readWorkers("thread-stale-notification", started.worker_id)[0]?.status ===
        "running",
      "continued worker running"
    )

    manager.restoreNotifications("thread-stale-notification", [oldNotification])
    assert(
      manager.drainNotifications("thread-stale-notification").length === 0,
      "old completed notification should not be restored after the worker was continued"
    )

    continuation.resolve({ summary: "second completed" })
    await manager.waitForWorkers("thread-stale-notification", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testRestoreSkipsOldNotificationAfterFastContinueCompletion(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-fast-continue-notification"

    const started = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Worker that completes twice",
      prompt: "first",
      runner: async () => ({ summary: "first completed" })
    })

    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const [oldNotification] = manager.drainNotifications(threadId)
    assert(oldNotification, "first completion should create a notification")
    assert(oldNotification.includes("<turn>1</turn>"), "first notification should identify turn 1")

    await manager.continueWorker({
      parentThreadId: threadId,
      workerId: started.worker_id,
      prompt: "second",
      runner: async () => ({ summary: "second completed" })
    })
    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    manager.restoreNotifications(threadId, [oldNotification])
    const notifications = manager.drainNotifications(threadId)
    assert(notifications.length === 1, "fast continue should keep only the fresh notification")
    assert(
      notifications[0].includes("<turn>2</turn>") &&
        notifications[0].includes("<summary>second completed</summary>") &&
        !notifications[0].includes("<summary>first completed</summary>"),
      "old turn-1 notification should not be restored after turn 2 completed"
    )
  })
}

async function testAcknowledgeOldTurnDoesNotRemoveFreshNotification(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-ack-turn"

    const started = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Worker with multiple turns",
      prompt: "first",
      runner: async () => ({ summary: "first completed" })
    })

    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const [oldNotification] = manager.drainNotifications(threadId)
    assert(oldNotification?.includes("<turn>1</turn>"), "first turn should queue turn-1 notification")

    await manager.continueWorker({
      parentThreadId: threadId,
      workerId: started.worker_id,
      prompt: "second",
      runner: async () => ({ summary: "second completed" })
    })
    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(manager.hasNotifications(threadId), "second turn should queue a fresh notification")

    await manager.acknowledgeNotificationMessages(threadId, [oldNotification])
    const remaining = manager.drainNotifications(threadId)
    assert(remaining.length === 1, "acknowledging turn 1 should not remove turn 2")
    assert(
      remaining[0].includes("<turn>2</turn>") &&
        remaining[0].includes("<summary>second completed</summary>"),
      "fresh turn-2 notification should remain queued"
    )
    assert(
      manager.readWorkers(threadId, started.worker_id)[0]?.notification_acknowledged === false,
      "fresh turn should not be marked acknowledged by an old notification"
    )
  })
}

async function testAcknowledgeUnknownNotificationDoesNotDropQueuedEntry(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-ack-unknown"
    void workspace

    const orphanNotification =
      "<task-notification><task-id>missing-worker</task-id><turn>1</turn><status>completed</status></task-notification>"

    manager.restoreNotifications(threadId, [orphanNotification])
    await manager.acknowledgeNotificationMessages(threadId, [orphanNotification])
    const remainingNotifications = manager.drainNotifications(threadId)
    assert(
      remainingNotifications.length === 1 && remainingNotifications[0] === orphanNotification,
      "acknowledging a notification without a restorable terminal record should not drop the queued notification"
    )
  })
}

async function testContinueReusesWorkerThread(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const seenThreads: string[] = []

    const started = manager.startWorker({
      parentThreadId: "thread-abc",
      workspacePath: workspace,
      role: "implementer",
      description: "Implement feature",
      prompt: "first",
      runner: async (input) => {
        seenThreads.push(input.workerThreadId)
        return { summary: `turn:${input.prompt}` }
      }
    })

    await manager.waitForWorkers("thread-abc", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const firstCompleted = manager.readWorkers("thread-abc", started.worker_id)[0]
    assert(firstCompleted.result_path, "first completed turn should have result path")

    const continued = await manager.continueWorker({
      parentThreadId: "thread-abc",
      workerId: started.worker_id,
      prompt: "second",
      runner: async (input) => {
        seenThreads.push(input.workerThreadId)
        return { summary: `turn:${input.prompt}` }
      }
    })

    assert(
      continued.worker_thread_id === started.worker_thread_id,
      "continue should reuse worker thread"
    )
    assert(continued.summary === undefined, "continue should clear stale summary while running")
    assert(continued.report_path === undefined, "continue should clear stale report path")
    assert(continued.result_path === undefined, "continue should clear stale result path")
    assert(
      continued.last_tool_name === undefined,
      "continue should clear stale last tool while running"
    )
    await manager.waitForWorkers("thread-abc", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(
      manager.readWorkers("thread-abc", started.worker_id)[0]?.turns === 2,
      "second turn should persist turn count"
    )
    assert(seenThreads.length === 2, "runner should be invoked twice")
    assert(seenThreads[0] === seenThreads[1], "worker thread should be stable across turns")
    const secondNotifications = manager.drainNotifications("thread-abc")
    assert(
      secondNotifications.length === 1 &&
        secondNotifications[0].includes("<summary>turn:second</summary>") &&
        !secondNotifications[0].includes("<summary>turn:first</summary>"),
      "continue completion should replace stale notification with a fresh one"
    )
  })
}

async function testRestoreCompletedWorkerAndContinue(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-restore-completed"
    const workerId = "implementer-1000-1"
    const workerThreadId = `${threadId}__worker__${workerId}`
    await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers"), {
      recursive: true
    })
    await writeFile(
      workerStatePath(workspace, threadId, workerId),
      JSON.stringify(
        {
          worker_id: workerId,
          worker_thread_id: workerThreadId,
          parent_thread_id: threadId,
          role: "implementer",
          description: "Restored completed worker",
          status: "completed",
          turns: 1,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:01:00.000Z",
          last_started_at: "2026-04-29T00:00:00.000Z",
          last_activity_at: "2026-04-29T00:01:00.000Z",
          finished_at: "2026-04-29T00:01:00.000Z",
          summary: "already done",
          result_path: `.cmbdevclaw/coordinator/${threadId}/reports/workers/${workerId}.json`,
          tool_call_count: 3,
          last_tool_name: "write_file",
          last_event: "Worker completed."
        },
        null,
        2
      ),
      "utf8"
    )

    const restored = await manager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace
    })
    assert(restored.length === 1, "restore should load completed worker state")
    assert(restored[0].status === "completed", "completed worker should stay completed")
    assert(
      restored[0].worker_thread_id === workerThreadId,
      "restore should preserve worker thread id"
    )
    assert(
      manager.drainNotifications(threadId).length === 0,
      "restoring old completed workers should not replay stale notifications"
    )

    const continued = await manager.continueWorker({
      parentThreadId: threadId,
      workerId,
      prompt: "continue after restart",
      runner: async (input) => ({ summary: input.workerThreadId })
    })
    assert(
      continued.worker_thread_id === workerThreadId,
      "restored worker continue should reuse checkpoint thread"
    )
    await manager.waitForWorkers(threadId, {
      workerId,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(
      manager.readWorkers(threadId, workerId)[0]?.summary === workerThreadId,
      "continued restored worker should receive restored worker thread id"
    )
  })
}

async function testRestoreRunningWorkerAsRecoverableStaleFailure(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-restore-running"
    const workerId = "verifier-1000-1"
    const workerThreadId = `${threadId}__worker__${workerId}`
    const updates: string[] = []
    await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers"), {
      recursive: true
    })
    await writeFile(
      workerStatePath(workspace, threadId, workerId),
      JSON.stringify(
        {
          worker_id: workerId,
          worker_thread_id: workerThreadId,
          parent_thread_id: threadId,
          role: "verifier",
          description: "Restored running worker",
          status: "running",
          turns: 1,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:01:00.000Z",
          last_started_at: "2026-04-29T00:00:00.000Z",
          last_activity_at: "2026-04-29T00:01:00.000Z",
          tool_call_count: 2,
          last_tool_name: "read_file",
          last_event: "Worker called tool: read_file"
        },
        null,
        2
      ),
      "utf8"
    )

    const restored = await manager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace,
      onUpdate: (event) =>
        updates.push(
          `${event.worker.status}:${event.notification ? "n" : ""}:${manager.readWorkers(threadId).length}`
        )
    })
    assert(restored.length === 1, "restore should load stale running worker")
    assert(restored[0].status === "failed", "stale running worker should become failed")
    assert(
      restored[0].error?.includes("CmbCowork restarted"),
      "stale worker should explain restart interruption"
    )
    assert(
      updates.includes("failed:n:1"),
      "stale restore should emit a completion notification after worker is visible to readers"
    )
    const persisted = await readJson(workerStatePath(workspace, threadId, workerId))
    assert(persisted.status === "failed", "stale restored worker should be persisted as failed")
    assert(
      typeof persisted.result_path === "string" && persisted.result_path.length > 0,
      "stale restored worker should persist a terminal result path"
    )

    const result = await manager.readWorkerResult(threadId, workerId)
    assert(result.worker.status === "failed", "stale restored worker result should be readable")
    assert(
      result.result_text.includes("CmbCowork restarted"),
      "stale restored worker result should include the restart interruption reason"
    )

    const notifications = manager.drainNotifications(threadId)
    assert(
      notifications.length === 1 &&
        notifications[0].includes("<status>failed</status>") &&
        notifications[0].includes(workerId),
      "stale restore notification should identify failed worker"
    )

    const continued = await manager.continueWorker({
      parentThreadId: threadId,
      workerId,
      prompt: "resume after restart",
      runner: async (input) => ({ summary: input.workerThreadId })
    })
    assert(
      continued.worker_thread_id === workerThreadId,
      "stale restored worker should be continuable on same thread"
    )
    await manager.waitForWorkers(threadId, {
      workerId,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testRestoreSkipsInvalidWorkerStateFiles(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-restore-invalid"
    const workersDir = join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers")
    await mkdir(workersDir, { recursive: true })
    await writeFile(join(workersDir, "bad-json.json"), "{", "utf8")
    await writeFile(
      join(workersDir, "implementer-1000-1.json"),
      JSON.stringify({
        worker_id: "implementer-1000-1",
        worker_thread_id: "other-thread__worker__implementer-1000-1",
        parent_thread_id: "other-thread",
        role: "implementer",
        description: "Wrong parent",
        status: "completed",
        turns: 1,
        created_at: "2026-04-29T00:00:00.000Z",
        updated_at: "2026-04-29T00:01:00.000Z",
        last_event: "Worker completed.",
        tool_call_count: 0
      }),
      "utf8"
    )
    const originalWarn = console.warn
    console.warn = () => {}

    try {
      const restored = await manager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath: workspace
      })
      assert(restored.length === 0, "invalid restore files should be skipped safely")
    } finally {
      console.warn = originalWarn
    }
  })
}

async function testRestoreMissingDirectoryIsNoop(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const restored = await manager.restoreWorkersForThread({
      parentThreadId: "thread-no-workers-dir",
      workspacePath: workspace
    })
    assert(restored.length === 0, "missing workers directory should restore as empty state")
    assert(
      manager.readWorkers("thread-no-workers-dir").length === 0,
      "missing workers directory should not create phantom worker records"
    )
  })
}

async function testRestoreDoesNotClobberActiveWorker(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let runnerStarted = false

    const started = manager.startWorker({
      parentThreadId: "thread-active-restore",
      workspacePath: workspace,
      role: "implementer",
      description: "Active worker",
      prompt: "work",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "active restore runner start")
    await writeFile(
      workerStatePath(workspace, "thread-active-restore", started.worker_id),
      JSON.stringify(
        {
          worker_id: started.worker_id,
          worker_thread_id: started.worker_thread_id,
          parent_thread_id: "thread-active-restore",
          role: "implementer",
          description: "Stale disk state should not win",
          status: "completed",
          turns: 99,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:01:00.000Z",
          finished_at: "2026-04-29T00:01:00.000Z",
          summary: "stale disk summary",
          tool_call_count: 99,
          last_event: "Worker completed."
        },
        null,
        2
      ),
      "utf8"
    )

    const restored = await manager.restoreWorkersForThread({
      parentThreadId: "thread-active-restore",
      workspacePath: workspace
    })
    assert(restored.length === 1, "restore should keep the active worker visible")
    assert(restored[0].status === "running", "restore should not replace an active run")
    assert(restored[0].turns === 1, "restore should not clobber active worker turns")
    assert(!restored[0].summary, "restore should not apply stale disk summary to active worker")

    run.resolve({ summary: "live run completed" })
    await manager.waitForWorkers("thread-active-restore", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(
      manager.readWorkers("thread-active-restore", started.worker_id)[0]?.summary ===
        "live run completed",
      "active worker should still complete with live result after restore scan"
    )
  })
}

async function testRestoreDoesNotClobberExistingTerminalWorker(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-terminal-restore"

    const started = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Completed worker",
      prompt: "work",
      runner: async () => ({ summary: "live completed" })
    })
    await manager.waitForWorkers(threadId, {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    await writeFile(
      workerStatePath(workspace, threadId, started.worker_id),
      JSON.stringify(
        {
          worker_id: started.worker_id,
          worker_thread_id: started.worker_thread_id,
          parent_thread_id: threadId,
          role: "implementer",
          description: "Stale running disk state",
          status: "running",
          turns: 99,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:01:00.000Z",
          tool_call_count: 99,
          last_event: "stale disk"
        },
        null,
        2
      ),
      "utf8"
    )

    const restored = await manager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace
    })
    assert(restored.length === 1, "restore should keep the existing terminal worker visible")
    assert(restored[0].status === "completed", "restore should not replace completed memory state")
    assert(restored[0].turns === 1, "restore should not apply stale disk turn count")
    assert(restored[0].summary === "live completed", "restore should preserve live summary")
  })
}

async function testRestoreRunningWorkerOnlyNotifiesOnce(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-restore-once"
    const workerId = "implementer-1000-1"
    await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers"), {
      recursive: true
    })
    await writeFile(
      workerStatePath(workspace, threadId, workerId),
      JSON.stringify(
        {
          worker_id: workerId,
          worker_thread_id: `${threadId}__worker__${workerId}`,
          parent_thread_id: threadId,
          role: "implementer",
          description: "Interrupted worker",
          status: "running",
          turns: 1,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:01:00.000Z",
          last_started_at: "2026-04-29T00:00:00.000Z",
          last_activity_at: "2026-04-29T00:01:00.000Z",
          tool_call_count: 1,
          last_event: "Worker called a tool."
        },
        null,
        2
      ),
      "utf8"
    )

    await manager.restoreWorkersForThread({ parentThreadId: threadId, workspacePath: workspace })
    assert(
      manager.drainNotifications(threadId).length === 1,
      "first stale restore should notify coordinator once"
    )
    await manager.restoreWorkersForThread({ parentThreadId: threadId, workspacePath: workspace })
    assert(
      manager.drainNotifications(threadId).length === 0,
      "repeated restore should not replay already-stale notification"
    )
  })
}

async function testDeleteCoordinatorWorkerArtifacts(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const threadId = "thread-delete-artifacts"
    const targetDir = join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers")
    const unrelatedDir = join(workspace, ".cmbdevclaw", "coordinator", "thread-keep", "workers")
    await mkdir(targetDir, { recursive: true })
    await mkdir(unrelatedDir, { recursive: true })
    await writeFile(join(targetDir, "implementer-1.json"), "worker", "utf8")
    await writeFile(join(unrelatedDir, "implementer-2.json"), "worker", "utf8")

    await deleteCoordinatorWorkerArtifacts(threadId, workspace)

    let deleted = false
    try {
      await access(targetDir)
    } catch {
      deleted = true
    }
    assert(deleted, "coordinator artifacts for deleted thread should be removed")
    await access(unrelatedDir)
  })
}

async function testRestoreTerminalStatesKeepContinueSemantics(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-restore-terminal"
    const workersDir = join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers")
    await mkdir(workersDir, { recursive: true })

    const failedWorkerId = "implementer-1000-1"
    const cancelledWorkerId = "verifier-1000-2"
    const base = {
      parent_thread_id: threadId,
      turns: 1,
      created_at: "2026-04-29T00:00:00.000Z",
      updated_at: "2026-04-29T00:01:00.000Z",
      finished_at: "2026-04-29T00:01:00.000Z",
      tool_call_count: 0
    }
    await writeFile(
      workerStatePath(workspace, threadId, failedWorkerId),
      JSON.stringify(
        {
          ...base,
          worker_id: failedWorkerId,
          worker_thread_id: `${threadId}__worker__${failedWorkerId}`,
          role: "implementer",
          description: "Failed worker",
          status: "failed",
          error: "previous failure",
          last_event: "Worker failed."
        },
        null,
        2
      ),
      "utf8"
    )
    await writeFile(
      workerStatePath(workspace, threadId, cancelledWorkerId),
      JSON.stringify(
        {
          ...base,
          worker_id: cancelledWorkerId,
          worker_thread_id: `${threadId}__worker__${cancelledWorkerId}`,
          role: "verifier",
          description: "Cancelled worker",
          status: "cancelled",
          error: "user cancelled",
          last_event: "user cancelled"
        },
        null,
        2
      ),
      "utf8"
    )

    const restored = await manager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace
    })
    assert(restored.length === 2, "restore should load failed and cancelled workers")
    assert(
      manager.drainNotifications(threadId).length === 0,
      "restored terminal workers should not replay old notifications"
    )

    const continued = await manager.continueWorker({
      parentThreadId: threadId,
      workerId: failedWorkerId,
      prompt: "retry failed worker",
      runner: async (input) => ({ summary: input.workerThreadId })
    })
    assert(continued.turns === 2, "restored failed worker should be continuable")
    await manager.waitForWorkers(threadId, {
      workerId: failedWorkerId,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    let rejectedCancelledContinue = false
    try {
      await manager.continueWorker({
        parentThreadId: threadId,
        workerId: cancelledWorkerId,
        prompt: "retry cancelled worker",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedCancelledContinue = true
    }
    assert(rejectedCancelledContinue, "restored cancelled worker should not be continuable")
  })
}

async function testSelectedSkillPersistsWithWorkerHistory(): Promise<void> {
  await withTempDir("coordinator-worker-selected-skill", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const selectedSkill = {
      skillName: "release-notes",
      skillPath: `${workspace}/skills/release-notes/SKILL.md`,
      description: "Generate release notes."
    }

    const started = manager.startWorker({
      parentThreadId: "thread-selected-skill",
      workspacePath: workspace,
      role: "implementer",
      description: "Draft release notes",
      prompt: "Do the work",
      selectedSkill,
      runner: async () => ({
        summary: "done",
        rawText: "worker output"
      })
    })

    await manager.waitForWorkers("thread-selected-skill", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const restoredManager = new CoordinatorWorkerManager()
    await restoredManager.restoreWorkersForThread({
      parentThreadId: "thread-selected-skill",
      workspacePath: workspace,
      mode: "active"
    })

    const restoredSkill = await restoredManager.getWorkerSelectedSkill(
      "thread-selected-skill",
      started.worker_id
    )
    assert(restoredSkill?.skillName === "release-notes", "restored worker should keep selected skill")
    assert(
      restoredSkill?.skillPath === selectedSkill.skillPath,
      "restored worker should keep selected skill path"
    )
  })
}

async function testStartWorkerAvoidsRestoredIdCollisions(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-id-collision"
    const originalDateNow = Date.now
    Date.now = () => 4242

    try {
      const restoredWorkerId = "implementer-4242-1"
      await mkdir(join(workspace, ".cmbdevclaw", "coordinator", threadId, "workers"), {
        recursive: true
      })
      await writeFile(
        workerStatePath(workspace, threadId, restoredWorkerId),
        JSON.stringify(
          {
            worker_id: restoredWorkerId,
            worker_thread_id: `${threadId}__worker__${restoredWorkerId}`,
            parent_thread_id: threadId,
            role: "implementer",
            description: "Existing restored worker",
            status: "completed",
            turns: 1,
            created_at: "2026-04-29T00:00:00.000Z",
            updated_at: "2026-04-29T00:01:00.000Z",
            finished_at: "2026-04-29T00:01:00.000Z",
            summary: "restored",
            tool_call_count: 0,
            last_event: "Worker completed."
          },
          null,
          2
        ),
        "utf8"
      )

      await manager.restoreWorkersForThread({ parentThreadId: threadId, workspacePath: workspace })
      const started = manager.startWorker({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        description: "New worker after restore",
        prompt: "work",
        runner: async () => ({ summary: "new worker complete" })
      })
      assert(
        started.worker_id !== restoredWorkerId,
        "new worker id should not overwrite a restored worker"
      )
      assert(
        started.worker_id === "implementer-4242-2",
        "new worker should advance sequence when restored id collides"
      )
      assert(
        manager.readWorkers(threadId).length === 2,
        "both restored and new worker should exist"
      )
      await manager.waitForWorkers(threadId, {
        workerId: started.worker_id,
        timeoutMs: 1_000,
        pollIntervalMs: 10
      })
    } finally {
      Date.now = originalDateNow
    }
  })
}

async function testForgetThreadCancelsAndClearsState(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let abortSeen = false
    let runnerStarted = false

    manager.startWorker({
      parentThreadId: "thread-forget",
      workspacePath: workspace,
      role: "implementer",
      description: "Forgettable worker",
      prompt: "work",
      runner: async (input) => {
        runnerStarted = true
        input.abortSignal.addEventListener("abort", () => {
          abortSeen = true
        })
        return run.promise
      }
    })
    manager.restoreNotifications("thread-forget", ["<task-notification>old</task-notification>"])

    await waitFor(() => runnerStarted, "forget runner start")
    manager.forgetThread("thread-forget")
    await waitFor(() => abortSeen, "forget abort")
    assert(manager.readWorkers("thread-forget").length === 0, "forget should remove workers")
    assert(
      manager.drainNotifications("thread-forget").length === 0,
      "forget should clear queued notifications"
    )
  })
}

async function testCancelRunningWorkers(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<{ summary: string }>()
    let abortSeen = false
    let runnerStarted = false
    let capturedInput: CoordinatorWorkerRunInput | null = null

    const started = manager.startWorker({
      parentThreadId: "thread-cancel",
      workspacePath: workspace,
      role: "verifier",
      description: "Verify feature",
      prompt: "verify",
      runner: async (input) => {
        capturedInput = input
        runnerStarted = true
        input.abortSignal.addEventListener("abort", () => {
          abortSeen = true
        })
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "runner start")
    const cancelled = manager.cancelWorkersForThread("thread-cancel", "test cancel")
    assert(cancelled[0].status === "cancelled", "cancel should mark worker cancelled")
    await waitFor(() => abortSeen, "abort signal")
    assert(
      manager.readWorkers("thread-cancel", started.worker_id)[0].status === "cancelled",
      "read state should show cancelled"
    )
    assert(
      manager.readWorkers("thread-cancel", started.worker_id)[0].notification_acknowledged === false,
      "cancel should immediately expose an unresolved notification state before terminal persistence finishes"
    )
    capturedInput?.onProgress({ type: "tool_call", toolName: "late_tool" })
    assert(
      manager.readWorkers("thread-cancel", started.worker_id)[0].tool_call_count === 0,
      "late progress after cancellation should be ignored"
    )
    run.resolve({ summary: "late" })
    await waitFor(
      () => manager.readWorkers("thread-cancel", started.worker_id)[0]?.error === "test cancel",
      "late cancelled final state"
    )
    assert(
      manager.readWorkers("thread-cancel", started.worker_id)[0].status === "cancelled",
      "late runner result should not flip cancelled worker to completed"
    )
    await waitFor(
      () => Boolean(manager.readWorkers("thread-cancel", started.worker_id)[0]?.result_path),
      "cancelled worker result path"
    )
    await manager.waitForTerminalPersistence("thread-cancel", [started.worker_id])
    await manager.waitForWorkers("thread-cancel", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const cancelledResult = await readJson(
      workerResultPath(workspace, "thread-cancel", started.worker_id)
    )
    assert(cancelledResult.status === "cancelled", "cancelled worker result should be persisted")
    assert(
      cancelledResult.error === "test cancel",
      "late runner return should not overwrite original cancel reason"
    )
    const notifications = manager.drainNotifications("thread-cancel")
    assert(notifications.length === 1, "cancelled worker should enqueue one notification")
    assert(
      notifications[0].includes("<status>killed</status>") &&
        notifications[0].includes("test cancel"),
      "cancelled notification should include killed status and original cancel reason"
    )
  })
}

async function testCancelledWriterBlocksConflictingWorkUntilCleanup(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-cancel-concurrency"
    const run = deferred<CoordinatorWorkerRunResult>()
    let runnerStarted = false

    const first = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/a.ts"],
      description: "First writer",
      prompt: "write first",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "first writer runner start")
    await manager.cancelWorker(threadId, first.worker_id, "stop first writer")

    let blocked = false
    try {
      manager.startWorker({
        parentThreadId: threadId,
        workspacePath: workspace,
        role: "implementer",
        workload: "write",
        ownedFiles: ["src/a.ts"],
        description: "Second writer",
        prompt: "write second",
        runner: async () => ({ summary: "second writer" })
      })
    } catch (error) {
      blocked =
        error instanceof Error &&
        error.message.includes("Cannot start write worker yet")
    }
    assert(
      blocked,
      "cancelled writer should keep owned_files mutex until the old runner exits"
    )

    run.resolve({ summary: "late first result" })
    await manager.waitForWorkerCleanup(threadId, [first.worker_id], 1_000)

    const second = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      ownedFiles: ["src/a.ts"],
      description: "Second writer after cleanup",
      prompt: "write second after cleanup",
      runner: async () => ({ summary: "second writer" })
    })
    await manager.waitForWorkers(threadId, {
      workerId: second.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const completed = manager.readWorkers(threadId, second.worker_id)[0]
    assert(completed.status === "completed", "second writer should start after cleanup")
  })
}

async function testCancelAllOnlyAcknowledgesActuallyCancelledWorkers(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const threadId = "thread-cancel-keeps-completed"
    const running = deferred<CoordinatorWorkerRunResult>()
    let runningStarted = false

    const completed = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "implementer",
      description: "Completed worker",
      prompt: "done",
      runner: async () => ({ summary: "completed result" })
    })
    await manager.waitForWorkers(threadId, {
      workerId: completed.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const active = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "verifier",
      description: "Running worker",
      prompt: "run",
      runner: async () => {
        runningStarted = true
        return running.promise
      }
    })
    await waitFor(() => runningStarted, "running worker start")

    const cancelled = manager.cancelWorkersForThread(threadId, "stop running only")
    assert(cancelled.length === 1, "cancel all should return only workers changed to cancelled")
    assert(
      cancelled[0].worker_id === active.worker_id && cancelled[0].status === "cancelled",
      "cancel all should not include already completed workers"
    )

    await manager.waitForTerminalPersistence(
      threadId,
      cancelled.map((worker) => worker.worker_id)
    )
    await manager.acknowledgeNotifications(
      threadId,
      cancelled.map((worker) => worker.worker_id)
    )
    const notifications = manager.drainNotifications(threadId)
    assert(
      notifications.length === 1 &&
        notifications[0].includes(`<task-id>${completed.worker_id}</task-id>`) &&
        !notifications[0].includes(`<task-id>${active.worker_id}</task-id>`),
      "acknowledging cancelled workers should preserve completed worker notifications"
    )

    running.resolve({ summary: "late verifier result" })
  })
}

async function testCancelledWorkerSuppressAutoRunPersistsAcrossRestore(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const threadId = "thread-cancel-suppress"
    const manager = new CoordinatorWorkerManager()
    const running = deferred<CoordinatorWorkerRunResult>()
    let started = false

    const active = manager.startWorker({
      parentThreadId: threadId,
      workspacePath: workspace,
      role: "verifier",
      description: "Cancelable verifier",
      prompt: "verify",
      runner: async () => {
        started = true
        return running.promise
      }
    })
    await waitFor(() => started, "cancel suppress worker start")

    const cancelled = manager.cancelWorkersForThread(
      threadId,
      "User cancelled coordinator workers.",
      { suppressNotificationAutoRun: true }
    )
    assert(cancelled.length === 1, "cancel should return the cancelled worker snapshot")

    await manager.waitForTerminalPersistence(threadId, [active.worker_id])

    const persisted = await readJson(workerStatePath(workspace, threadId, active.worker_id))
    assert(
      persisted.suppress_notification_auto_run === true,
      "cancel suppression should be persisted with the worker state"
    )

    const restored = new CoordinatorWorkerManager()
    await restored.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath: workspace,
      mode: "active"
    })
    const restoredWorker = restored.readWorkers(threadId, active.worker_id)[0]
    assert(
      restoredWorker?.suppress_notification_auto_run === true,
      "restore should preserve cancel suppression on the worker snapshot"
    )
    assert(
      restored.hasNotifications(threadId),
      "restored cancelled worker should still keep its pending notification until ack"
    )
    assert(
      !restored.hasAutoRunnableNotifications(threadId),
      "restored cancelled worker should not be treated as auto-runnable coordinator notification work"
    )

    running.resolve({ summary: "late verifier result" })
  })
}

async function testWaitForWorkerCleanupWaitsForCurrentRun(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let runnerStarted = false
    let cleanupDone = false

    const started = manager.startWorker({
      parentThreadId: "thread-cleanup-wait",
      workspacePath: workspace,
      role: "implementer",
      description: "Cleanup wait worker",
      prompt: "work",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "cleanup wait runner start")
    const cancelled = manager.cancelWorkersForThread("thread-cleanup-wait", "delete thread")
    assert(cancelled.length === 1, "cleanup wait should cancel the running worker")

    const cleanupWait = manager
      .waitForWorkerCleanup(
        "thread-cleanup-wait",
        cancelled.map((worker) => worker.worker_id),
        1_000
      )
      .then(() => {
        cleanupDone = true
      })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert(!cleanupDone, "cleanup wait should wait for the current runner promise")

    run.resolve({ summary: "late result" })
    await cleanupWait
    assert(cleanupDone, "cleanup wait should finish after the current runner settles")
    assert(
      manager.readWorkers("thread-cleanup-wait", started.worker_id)[0]?.status === "cancelled",
      "cleanup wait should not change cancelled status"
    )
  })
}

async function testWaitForWorkerCleanupTimeoutThrows(): Promise<void> {
  await withTempDir("coordinator-worker-cleanup-timeout", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<CoordinatorWorkerRunResult>()
    let runnerStarted = false

    const started = manager.startWorker({
      parentThreadId: "thread-cleanup-timeout",
      workspacePath: workspace,
      role: "implementer",
      description: "Cleanup timeout worker",
      prompt: "work",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "cleanup timeout runner start")
    manager.cancelWorkersForThread("thread-cleanup-timeout", "delete thread")

    let timeoutError: Error | undefined
    try {
      await manager.waitForWorkerCleanup("thread-cleanup-timeout", [started.worker_id], 10)
    } catch (error) {
      timeoutError = error as Error
    }
    assert(timeoutError instanceof Error, "cleanup timeout should reject with an error")
    assert(
      timeoutError?.message.includes("Timed out waiting for coordinator worker cleanup"),
      "cleanup timeout error should explain that worker cleanup did not finish"
    )

    run.resolve({ summary: "late result" })
    await manager.waitForWorkerCleanup("thread-cleanup-timeout", [started.worker_id], 1_000)
  })
}

async function testFailureAndContinueGuards(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const running = deferred<{ summary: string }>()
    let runnerStarted = false

    const started = manager.startWorker({
      parentThreadId: "thread-guards",
      workspacePath: workspace,
      role: "implementer",
      description: "Implement guarded feature",
      prompt: "first",
      runner: async () => {
        runnerStarted = true
        return running.promise
      }
    })

    await waitFor(() => runnerStarted, "guard runner start")
    running.reject(new Error("implementation failed"))
    await waitFor(
      () => Boolean(manager.readWorkers("thread-guards", started.worker_id)[0]?.result_path),
      "worker failure"
    )
    const failed = manager.readWorkers("thread-guards", started.worker_id)[0]
    assert(failed.status === "failed", "failed worker should keep failed status")
    assert(failed.error === "implementation failed", "failed worker should preserve error")
    const failedResult = await readJson(
      workerResultPath(workspace, "thread-guards", started.worker_id)
    )
    assert(failedResult.status === "failed", "failed worker result should be persisted")
    assert(
      failedResult.error === "implementation failed",
      "failed worker result should persist error"
    )
    const failedNotifications = manager.drainNotifications("thread-guards")
    assert(failedNotifications.length === 1, "failed worker should enqueue one notification")
    assert(
      failedNotifications[0].includes("<status>failed</status>") &&
        failedNotifications[0].includes("<summary>implementation failed</summary>"),
      "failed notification should include status and error summary"
    )

    const continued = await manager.continueWorker({
      parentThreadId: "thread-guards",
      workerId: started.worker_id,
      prompt: "retry after failure",
      runner: async () => ({ summary: "fixed" })
    })
    assert(continued.turns === 2, "failed worker should be continuable")
    await manager.waitForWorkers("thread-guards", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testContinueInterruptsRunningWorker(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const firstAborted = deferred<void>()
    const prompts: string[] = []

    const started = manager.startWorker({
      parentThreadId: "thread-interrupt",
      workspacePath: workspace,
      role: "implementer",
      description: "Interrupt and update worker",
      prompt: "first",
      runner: async (input) => {
        prompts.push(input.prompt)
        if (input.prompt === "first") {
          input.abortSignal.addEventListener("abort", () => firstAborted.resolve(), {
            once: true
          })
          await new Promise((_resolve, reject) => {
            input.abortSignal.addEventListener("abort", () => reject(input.abortSignal.reason), {
              once: true
            })
          })
        }
        input.onProgress({ type: "tool_call", toolName: "edit_file" })
        return { summary: `completed:${input.prompt}` }
      }
    })

    await waitFor(() => prompts.includes("first"), "first interruptible run start")
    const continued = await manager.continueWorker({
      parentThreadId: "thread-interrupt",
      workerId: started.worker_id,
      prompt: "second",
      runner: async (input) => {
        prompts.push(input.prompt)
        input.onProgress({ type: "tool_call", toolName: "write_file" })
        return { summary: `completed:${input.prompt}` }
      }
    })

    assert(
      continued.worker_thread_id === started.worker_thread_id,
      "interrupted continue should reuse worker thread"
    )
    assert(continued.status === "running", "interrupted continue should remain running")
    await firstAborted.promise
    await waitFor(() => prompts.includes("second"), "second run after interrupt")
    await manager.waitForWorkers("thread-interrupt", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    const completed = manager.readWorkers("thread-interrupt", started.worker_id)[0]
    assert(completed.status === "completed", "interrupted worker should complete latest run")
    assert(completed.turns === 2, "interrupted worker should count the follow-up turn")
    assert(completed.summary === "completed:second", "latest run should win")
    assert(completed.last_tool_name === "write_file", "latest run progress should win")

    const notifications = manager.drainNotifications("thread-interrupt")
    assert(notifications.length === 1, "interrupted worker should enqueue only latest result")
    assert(
      notifications[0].includes("completed:second") &&
        !notifications[0].includes("<status>killed</status>"),
      "interrupted worker notification should not leak cancelled old run"
    )
  })
}

async function testRapidContinueOnlyLaunchesLatestRestart(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const firstAborted = deferred<void>()
    const releaseFirstRun = deferred<void>()
    const prompts: string[] = []

    const started = manager.startWorker({
      parentThreadId: "thread-rapid-continue",
      workspacePath: workspace,
      role: "implementer",
      description: "Rapid continue worker",
      prompt: "first",
      runner: async (input) => {
        prompts.push(input.prompt)
        if (input.prompt === "first") {
          input.abortSignal.addEventListener("abort", () => firstAborted.resolve(), {
            once: true
          })
          await releaseFirstRun.promise
          throw input.abortSignal.reason
        }
        return { summary: `completed:${input.prompt}` }
      }
    })

    await waitFor(() => prompts.includes("first"), "first rapid-continue run start")
    await manager.continueWorker({
      parentThreadId: "thread-rapid-continue",
      workerId: started.worker_id,
      prompt: "second",
      runner: async (input) => {
        prompts.push(input.prompt)
        return { summary: `completed:${input.prompt}` }
      }
    })
    await firstAborted.promise
    await manager.continueWorker({
      parentThreadId: "thread-rapid-continue",
      workerId: started.worker_id,
      prompt: "third",
      runner: async (input) => {
        prompts.push(input.prompt)
        return { summary: `completed:${input.prompt}` }
      }
    })

    releaseFirstRun.resolve()
    await waitFor(() => prompts.includes("third"), "latest rapid continue restart")
    await manager.waitForWorkers("thread-rapid-continue", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    const completed = manager.readWorkers("thread-rapid-continue", started.worker_id)[0]
    assert(completed.summary === "completed:third", "latest rapid continue run should win")
    assert(!prompts.includes("second"), "stale restart should not launch the superseded prompt")
  })
}

async function testCancelDuringInterruptedRestartPreventsNewRun(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const firstAborted = deferred<void>()
    const releaseOldRun = deferred<void>()
    const prompts: string[] = []

    const started = manager.startWorker({
      parentThreadId: "thread-interrupt-cancel",
      workspacePath: workspace,
      role: "implementer",
      description: "Cancel while interrupted worker is restarting",
      prompt: "first",
      runner: async (input) => {
        prompts.push(input.prompt)
        if (input.prompt === "first") {
          input.abortSignal.addEventListener("abort", () => firstAborted.resolve(), {
            once: true
          })
          await releaseOldRun.promise
          throw input.abortSignal.reason
        }
        return { summary: "should not run" }
      }
    })

    await waitFor(() => prompts.includes("first"), "first delayed run start")
    await manager.continueWorker({
      parentThreadId: "thread-interrupt-cancel",
      workerId: started.worker_id,
      prompt: "second",
      runner: async (input) => {
        prompts.push(input.prompt)
        return { summary: "bad" }
      }
    })
    await firstAborted.promise
    await manager.cancelWorker(
      "thread-interrupt-cancel",
      started.worker_id,
      "cancel pending update"
    )
    releaseOldRun.resolve()

    await manager.waitForWorkers("thread-interrupt-cancel", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const cancelled = manager.readWorkers("thread-interrupt-cancel", started.worker_id)[0]
    assert(cancelled.status === "cancelled", "cancel during restart should win")
    assert(!prompts.includes("second"), "cancel during restart should not launch the new run")
    const cleanupStartedAt = Date.now()
    await manager.waitForWorkerCleanup("thread-interrupt-cancel", [started.worker_id], 500)
    assert(
      Date.now() - cleanupStartedAt < 250,
      "cancel during restart should clear the pending restart promise without waiting for cleanup timeout"
    )
    const notifications = manager.drainNotifications("thread-interrupt-cancel")
    assert(
      notifications.length === 1 && notifications[0].includes("<status>killed</status>"),
      "cancel during restart should enqueue one killed notification"
    )
  })
}

async function testCancelledWorkersCannotContinue(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<{ summary: string }>()
    let runnerStarted = false

    const started = manager.startWorker({
      parentThreadId: "thread-cancelled",
      workspacePath: workspace,
      role: "implementer",
      description: "Implement cancellable feature",
      prompt: "first",
      runner: async () => {
        runnerStarted = true
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "runner start")
    await manager.cancelWorker("thread-cancelled", started.worker_id, "no longer needed")
    assert(
      manager.readWorkers("thread-cancelled", started.worker_id)[0].status === "cancelled",
      "cancelWorker should cancel one worker"
    )

    let rejectedCancelledContinue = false
    try {
      await manager.continueWorker({
        parentThreadId: "thread-cancelled",
        workerId: started.worker_id,
        prompt: "should reject",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedCancelledContinue = true
    }
    assert(rejectedCancelledContinue, "continue should reject cancelled worker")
    run.resolve({ summary: "late" })
    await waitFor(
      () =>
        manager.readWorkers("thread-cancelled", started.worker_id)[0]?.error === "no longer needed",
      "cancelled continue guard late final state"
    )
    await manager.waitForWorkers("thread-cancelled", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testVerifyWorkloadRequiresVerifierRole(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()

    let rejectedImplementerVerifyStart = false
    try {
      manager.startWorker({
        parentThreadId: "thread-verify-role-start",
        workspacePath: workspace,
        role: "implementer",
        workload: "verify",
        description: "Should reject implementer verify",
        prompt: "verify without verifier role",
        runner: async () => ({ summary: "should not run" })
      })
    } catch (error) {
      rejectedImplementerVerifyStart =
        error instanceof Error && error.message.includes('Only verifier workers can use workload="verify"')
    }
    assert(
      rejectedImplementerVerifyStart,
      'startWorker should reject workload="verify" for non-verifier roles'
    )

    const started = manager.startWorker({
      parentThreadId: "thread-verify-role-continue",
      workspacePath: workspace,
      role: "implementer",
      workload: "write",
      description: "Implement feature",
      prompt: "implement",
      runner: async () => ({ summary: "done" })
    })
    await manager.waitForWorkers("thread-verify-role-continue", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    let rejectedImplementerVerifyContinue = false
    try {
      await manager.continueWorker({
        parentThreadId: "thread-verify-role-continue",
        workerId: started.worker_id,
        workload: "verify",
        prompt: "self-verify",
        runner: async () => ({ summary: "should not run" })
      })
    } catch (error) {
      rejectedImplementerVerifyContinue =
        error instanceof Error && error.message.includes('Only verifier workers can use workload="verify"')
    }
    assert(
      rejectedImplementerVerifyContinue,
      'continueWorker should reject workload="verify" for implementer workers'
    )
  })
}

async function testAlreadyAbortedParentSignal(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const parentAbort = new AbortController()
    parentAbort.abort(new DOMException("already aborted", "AbortError"))
    let runnerCalled = false

    const started = manager.startWorker({
      parentThreadId: "thread-pre-abort",
      workspacePath: workspace,
      role: "verifier",
      description: "Verifier should see abort",
      prompt: "verify",
      parentSignal: parentAbort.signal,
      runner: async () => {
        runnerCalled = true
        return { summary: "should become cancelled" }
      }
    })

    await waitFor(
      () => manager.readWorkers("thread-pre-abort", started.worker_id)[0]?.status === "cancelled",
      "already aborted final state"
    )
    await manager.waitForWorkers("thread-pre-abort", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(!runnerCalled, "already aborted parent should not start runner")
    assert(
      manager.readWorkers("thread-pre-abort", started.worker_id)[0]?.error === "already aborted",
      "already aborted worker should preserve parent abort reason"
    )
  })
}

async function testSingleCancelAndParentAbort(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const firstRun = deferred<{ summary: string }>()
    const secondRun = deferred<{ summary: string }>()
    const parentAbort = new AbortController()
    let firstStarted = false
    let secondAbortSeen = false
    let secondStarted = false

    const first = manager.startWorker({
      parentThreadId: "thread-multi",
      workspacePath: workspace,
      role: "implementer",
      description: "First worker",
      prompt: "first",
      runner: async () => {
        firstStarted = true
        return firstRun.promise
      }
    })

    const second = manager.startWorker({
      parentThreadId: "thread-multi",
      workspacePath: workspace,
      role: "verifier",
      workload: "read_only",
      description: "Second worker",
      prompt: "second",
      parentSignal: parentAbort.signal,
      runner: async (input) => {
        secondStarted = true
        input.abortSignal.addEventListener("abort", () => {
          secondAbortSeen = true
        })
        return secondRun.promise
      }
    })

    await waitFor(() => firstStarted && secondStarted, "both workers")
    await manager.cancelWorker("thread-multi", first.worker_id, "cancel first only")
    assert(
      manager.readWorkers("thread-multi", first.worker_id)[0].status === "cancelled",
      "single cancel should cancel requested worker"
    )
    assert(
      manager.readWorkers("thread-multi", second.worker_id)[0].status === "running",
      "single cancel should not cancel sibling worker"
    )

    parentAbort.abort(new DOMException("parent aborted", "AbortError"))
    await waitFor(() => secondAbortSeen, "parent abort propagation")
    await waitFor(
      () =>
        manager.readWorkers("thread-multi", second.worker_id)[0]?.status === "cancelled" &&
        manager.readWorkers("thread-multi", second.worker_id)[0]?.error === "parent aborted" &&
        Boolean(manager.readWorkers("thread-multi", second.worker_id)[0]?.result_path),
      "parent abort immediate terminal state"
    )
    assert(
      manager.readWorkers("thread-multi", second.worker_id)[0].status === "cancelled",
      "parent abort should immediately mark worker cancelled"
    )
    secondRun.resolve({ summary: "late second" })
    await manager.waitForWorkers("thread-multi", {
      workerId: second.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(
      manager.readWorkers("thread-multi", second.worker_id)[0]?.status === "cancelled",
      "parent-aborted worker should remain cancelled"
    )
    firstRun.resolve({ summary: "late first" })
    await waitFor(
      () => Boolean(manager.readWorkers("thread-multi", first.worker_id)[0]?.result_path),
      "single-cancelled worker final state"
    )
    await manager.waitForWorkers("thread-multi", {
      workerId: first.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
  })
}

async function testImmediateCancelBeforeRunnerStarts(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    let runnerCalled = false

    const started = manager.startWorker({
      parentThreadId: "thread-immediate-cancel",
      workspacePath: workspace,
      role: "implementer",
      description: "Cancel before first runner turn",
      prompt: "work",
      runner: async () => {
        runnerCalled = true
        return { summary: "should not run" }
      }
    })

    const cancelled = await manager.cancelWorker(
      "thread-immediate-cancel",
      started.worker_id,
      "cancel before runner starts"
    )
    assert(cancelled.status === "cancelled", "immediate cancel should mark worker cancelled")

    await manager.waitForWorkers("thread-immediate-cancel", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })
    assert(!runnerCalled, "immediate cancel should skip runner before the first turn")

    const finalState = manager.readWorkers("thread-immediate-cancel", started.worker_id)[0]
    assert(finalState.status === "cancelled", "immediately cancelled worker should stay cancelled")
    assert(
      finalState.error === "cancel before runner starts",
      "immediate cancel should preserve cancel reason"
    )
    assert(
      Boolean(finalState.result_path),
      "immediately cancelled worker should still persist a terminal result"
    )
    const persisted = await readJson(
      workerStatePath(workspace, "thread-immediate-cancel", started.worker_id)
    )
    assert(
      persisted.status === "cancelled",
      "initial running persist should not overwrite immediate cancel state"
    )

    const notifications = manager.drainNotifications("thread-immediate-cancel")
    assert(notifications.length === 1, "immediate cancel should enqueue one notification")
    assert(
      notifications[0].includes("<status>killed</status>") &&
        notifications[0].includes("cancel before runner starts"),
      "immediate cancel notification should include killed status and reason"
    )
  })
}

async function testInvalidIdsAndUnknownReads(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    assert(
      manager.readWorkers("thread-safe", "missing-worker").length === 0,
      "unknown worker reads should return empty list"
    )

    let rejectedBadParentId = false
    try {
      manager.startWorker({
        parentThreadId: "../bad",
        workspacePath: workspace,
        role: "implementer",
        description: "Bad parent",
        prompt: "bad",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedBadParentId = true
    }
    assert(rejectedBadParentId, "unsafe parent thread ids should be rejected")

    let rejectedReservedParentDelimiter = false
    try {
      manager.startWorker({
        parentThreadId: "thread__worker__unsafe",
        workspacePath: workspace,
        role: "implementer",
        description: "Bad reserved delimiter",
        prompt: "bad",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedReservedParentDelimiter = true
    }
    assert(
      rejectedReservedParentDelimiter,
      "parent thread ids containing the reserved worker delimiter should be rejected"
    )

    let rejectedEmptyWorkspace = false
    try {
      manager.startWorker({
        parentThreadId: "thread-safe",
        workspacePath: "   ",
        role: "implementer",
        description: "Bad workspace",
        prompt: "bad",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedEmptyWorkspace = true
    }
    assert(rejectedEmptyWorkspace, "empty worker workspace paths should be rejected")

    let rejectedEmptyDescription = false
    try {
      manager.startWorker({
        parentThreadId: "thread-safe",
        workspacePath: workspace,
        role: "implementer",
        description: "   ",
        prompt: "work",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedEmptyDescription = true
    }
    assert(rejectedEmptyDescription, "empty worker descriptions should be rejected")

    let rejectedEmptyPrompt = false
    try {
      manager.startWorker({
        parentThreadId: "thread-safe",
        workspacePath: workspace,
        role: "implementer",
        description: "Valid description",
        prompt: "   ",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedEmptyPrompt = true
    }
    assert(rejectedEmptyPrompt, "empty worker prompts should be rejected")

    let rejectedWindowsAbsoluteOwnedFile = false
    try {
      manager.startWorker({
        parentThreadId: "thread-safe",
        workspacePath: workspace,
        role: "implementer",
        ownedFiles: ["C:/outside/file.ts"],
        description: "Bad owned file",
        prompt: "bad",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedWindowsAbsoluteOwnedFile = true
    }
    assert(rejectedWindowsAbsoluteOwnedFile, "windows absolute owned_files should be rejected")

    let rejectedBadRole = false
    try {
      manager.startWorker({
        parentThreadId: "thread-safe",
        workspacePath: workspace,
        role: "general-purpose" as never,
        description: "Bad role",
        prompt: "bad",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedBadRole = true
    }
    assert(rejectedBadRole, "unsupported worker roles should be rejected at runtime")

    let rejectedBadReadParentId = false
    try {
      manager.readWorkers("../bad")
    } catch {
      rejectedBadReadParentId = true
    }
    assert(rejectedBadReadParentId, "unsafe parent ids should be rejected when reading")

    const started = manager.startWorker({
      parentThreadId: "thread-safe",
      workspacePath: workspace,
      role: "implementer",
      description: "Valid worker",
      prompt: "first",
      runner: async () => ({ summary: "done" })
    })
    await manager.waitForWorkers("thread-safe", {
      workerId: started.worker_id,
      timeoutMs: 1_000,
      pollIntervalMs: 10
    })

    let rejectedEmptyContinuePrompt = false
    try {
      await manager.continueWorker({
        parentThreadId: "thread-safe",
        workerId: started.worker_id,
        prompt: "   ",
        runner: async () => ({ summary: "bad" })
      })
    } catch {
      rejectedEmptyContinuePrompt = true
    }
    assert(rejectedEmptyContinuePrompt, "empty continue prompts should be rejected")

    let rejectedUnknownCancel = false
    try {
      await manager.cancelWorker("thread-safe", "missing-worker", "missing")
    } catch {
      rejectedUnknownCancel = true
    }
    assert(rejectedUnknownCancel, "unknown worker cancel should throw")

    let rejectedBadWorkerId = false
    try {
      await manager.cancelWorker("thread-safe", "../bad", "bad")
    } catch {
      rejectedBadWorkerId = true
    }
    assert(rejectedBadWorkerId, "unsafe worker ids should be rejected")
  })
}

async function testClearCancelsAndForgetsWorkers(): Promise<void> {
  await withTempDir("coordinator-worker-manager", async (workspace) => {
    const manager = new CoordinatorWorkerManager()
    const run = deferred<{ summary: string }>()
    let runnerStarted = false
    let abortSeen = false

    manager.startWorker({
      parentThreadId: "thread-clear",
      workspacePath: workspace,
      role: "implementer",
      description: "Clearable worker",
      prompt: "work",
      runner: async (input) => {
        runnerStarted = true
        input.abortSignal.addEventListener("abort", () => {
          abortSeen = true
        })
        return run.promise
      }
    })

    await waitFor(() => runnerStarted, "clear runner start")
    manager.clear()
    await waitFor(() => abortSeen, "clear abort")
    assert(manager.readWorkers("thread-clear").length === 0, "clear should forget workers")
  })
}

async function run(): Promise<void> {
  await testStartAndComplete()
  console.log("PASS coordinator worker start/complete")
  await testWaitForWorkersHonorsAbortSignal()
  console.log("PASS coordinator worker wait abort")
  await testStartWorkerAndPersistWritesInitialStateBeforeReturning()
  console.log("PASS coordinator worker durable start")
  await testStartWorkerAndPersistRejectsInitialStateFailure()
  console.log("PASS coordinator worker durable start failure")
  await testContinueWorkerAndPersistWritesContinuationStateBeforeReturning()
  console.log("PASS coordinator worker durable continue")
  await testRapidProgressDoesNotOverwriteTerminalState()
  console.log("PASS coordinator worker rapid progress persistence")
  await testUpdateCallbackErrorsAreNonFatal()
  console.log("PASS coordinator worker update callback guard")
  await testBindWorkerUpdatesSupportsMultipleListeners()
  console.log("PASS coordinator worker update callback multi-listener")
  await testBlockingWaitForWorkerCompletion()
  console.log("PASS coordinator worker blocking wait")
  await testNonBlockingWaitAndUnknownWorkerRead()
  console.log("PASS coordinator worker non-blocking wait")
  await testPersistenceFailureFailsWorkerSafely()
  console.log("PASS coordinator worker persistence failure")
  await testTerminalResultPersistenceFailurePersistsFailedState()
  console.log("PASS coordinator worker terminal persistence failure")
  await testNotificationEscapesXmlContent()
  console.log("PASS coordinator worker XML-safe notification")
  await testNotificationSummaryTruncatesButResultKeepsFullOutput()
  console.log("PASS coordinator worker notification truncation")
  await testWorkerRawTextIsBounded()
  console.log("PASS coordinator worker raw text bound")
  await testWorkerTranscriptAndTokenUsagePersistence()
  console.log("PASS coordinator worker transcript and usage persistence")
  await testContinuedWorkerAccumulatesTokenUsage()
  console.log("PASS coordinator worker continued token usage")
  await testUsageProgressDoesNotHideLastToolEvent()
  console.log("PASS coordinator worker usage preserves last event")
  await testDuplicateUsageProgressDoesNotEmitRepeatedUpdates()
  console.log("PASS coordinator worker duplicate usage suppression")
  await testProgressUpdatesAreThrottled()
  console.log("PASS coordinator worker progress throttling")
  await testStaleProgressFromInterruptedRunIsIgnored()
  console.log("PASS coordinator worker stale progress guard")
  await testWorkerWriteSafetyAndReadOnlyParallelism()
  console.log("PASS coordinator worker write safety and read-only parallelism")
  await testNotificationAcknowledgement()
  console.log("PASS coordinator worker notification acknowledgement")
  await testInMemoryWorkerHistoryIsPruned()
  console.log("PASS coordinator worker in-memory history pruning")
  await testPrunedSnapshotCacheIsBounded()
  console.log("PASS coordinator worker pruned snapshot cache bound")
  await testActiveRestoreSkipsAcknowledgedTerminalHistory()
  console.log("PASS coordinator worker active restore pruning")
  await testActiveRestoreDoesNotParseAcknowledgedTerminalHistory()
  console.log("PASS coordinator worker active restore prefix scan")
  await testPersistedWorkerStateKeepsActiveRestoreKeysFirst()
  console.log("PASS coordinator worker persisted state key order")
  await testRestoreReplaysUnacknowledgedTerminalNotification()
  console.log("PASS coordinator worker pending notification restore")
  await testRestoreSkipsStaleNotificationAfterContinue()
  console.log("PASS coordinator worker stale notification restore guard")
  await testRestoreSkipsOldNotificationAfterFastContinueCompletion()
  console.log("PASS coordinator worker fast continue stale notification guard")
  await testAcknowledgeOldTurnDoesNotRemoveFreshNotification()
  console.log("PASS coordinator worker old-turn ack preserves fresh notification")
  await testAcknowledgeUnknownNotificationDoesNotDropQueuedEntry()
  console.log("PASS coordinator worker unknown notification ack preserves queue")
  await testContinueReusesWorkerThread()
  console.log("PASS coordinator worker continue context")
  await testContinueInterruptsRunningWorker()
  console.log("PASS coordinator worker running continue interrupt")
  await testRapidContinueOnlyLaunchesLatestRestart()
  console.log("PASS coordinator worker rapid continue restart guard")
  await testCancelDuringInterruptedRestartPreventsNewRun()
  console.log("PASS coordinator worker cancel during interrupted restart")
  await testRestoreCompletedWorkerAndContinue()
  console.log("PASS coordinator worker restore completed")
  await testRestoreRunningWorkerAsRecoverableStaleFailure()
  console.log("PASS coordinator worker restore stale running")
  await testRestoreSkipsInvalidWorkerStateFiles()
  console.log("PASS coordinator worker restore invalid files")
  await testRestoreMissingDirectoryIsNoop()
  console.log("PASS coordinator worker restore missing directory")
  await testRestoreDoesNotClobberActiveWorker()
  console.log("PASS coordinator worker restore active guard")
  await testRestoreDoesNotClobberExistingTerminalWorker()
  console.log("PASS coordinator worker restore terminal in-memory guard")
  await testRestoreRunningWorkerOnlyNotifiesOnce()
  console.log("PASS coordinator worker restore idempotent stale notification")
  await testDeleteCoordinatorWorkerArtifacts()
  console.log("PASS coordinator worker artifact cleanup")
  await testRestoreTerminalStatesKeepContinueSemantics()
  console.log("PASS coordinator worker restore terminal semantics")
  await testSelectedSkillPersistsWithWorkerHistory()
  console.log("PASS coordinator worker selected skill persistence")
  await testStartWorkerAvoidsRestoredIdCollisions()
  console.log("PASS coordinator worker restored id collision guard")
  await testForgetThreadCancelsAndClearsState()
  console.log("PASS coordinator worker forget thread")
  await testCancelRunningWorkers()
  console.log("PASS coordinator worker cancellation")
  await testCancelledWriterBlocksConflictingWorkUntilCleanup()
  console.log("PASS coordinator worker cancelled writer mutex")
  await testCancelAllOnlyAcknowledgesActuallyCancelledWorkers()
  console.log("PASS coordinator worker cancel all preserves completed notifications")
  await testCancelledWorkerSuppressAutoRunPersistsAcrossRestore()
  console.log("PASS coordinator worker cancelled auto-run suppression restore")
  await testWaitForWorkerCleanupWaitsForCurrentRun()
  console.log("PASS coordinator worker cleanup wait")
  await testWaitForWorkerCleanupDoesNotFalseTimeoutAtBoundary()
  console.log("PASS coordinator worker cleanup boundary guard")
  await testWaitForWorkerCleanupTimeoutThrows()
  console.log("PASS coordinator worker cleanup timeout")
  await testFailureAndContinueGuards()
  console.log("PASS coordinator worker failure and continue guards")
  await testCancelledWorkersCannotContinue()
  console.log("PASS coordinator worker cancelled continue guard")
  await testVerifyWorkloadRequiresVerifierRole()
  console.log("PASS coordinator worker verify workload role guard")
  await testAlreadyAbortedParentSignal()
  console.log("PASS coordinator worker already aborted parent signal")
  await testSingleCancelAndParentAbort()
  console.log("PASS coordinator worker single cancel and parent abort")
  await testImmediateCancelBeforeRunnerStarts()
  console.log("PASS coordinator worker immediate cancel")
  await testInvalidIdsAndUnknownReads()
  console.log("PASS coordinator worker id validation")
  await testClearCancelsAndForgetsWorkers()
  console.log("PASS coordinator worker clear")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
