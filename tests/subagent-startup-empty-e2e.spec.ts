/** Frozen production package, public IPC and observed Workers; no existing browser profile. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import { attemptModsE2eCleanup, runModsE2eWithFailures } from "./support/mods-e2e-failures"
import {
  installSnapshotWorkerTrace,
  type SnapshotTraceGlobal,
  type SnapshotTraceSummary
} from "./support/stream-snapshot-worker-trace"
import {
  installSubagentStartupReadHold,
  type StartupReadHoldGlobal,
  type StartupReadHoldSummary
} from "./support/subagent-startup-read-hold"

interface FixtureRead {
  state: "pending" | "fulfilled" | "rejected"
  value?: Record<string, unknown>
  error?: string
  promise: Promise<void>
}

interface FixtureWindow {
  api: {
    threads: {
      create(options: {
        title: string
        workspacePath: string
        agentMode: "normal"
      }): Promise<{ thread_id: string }>
      persistSubagentTranscripts(
        threadId: string,
        transcripts: Record<string, unknown>
      ): Promise<Record<string, unknown>>
      getSubagentTranscripts(
        threadId: string,
        options?: { requestScope?: "foreground-hydration" }
      ): Promise<Record<string, unknown>>
    }
  }
  subagentStartupFixtureReads?: Record<string, FixtureRead>
}

interface ReadObservation {
  name: string
  startupBefore: number
  startupAfter: number
  startupDelta: number
  value: Record<string, unknown>
  verified: boolean
}

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR?.trim(), "A real production package is required")
const artifacts = resolve(
  process.env.CMB_SUBAGENT_STARTUP_E2E_ARTIFACTS ??
    process.env.CMB_MODS_CORE_E2E_ARTIFACTS ??
    join(root, "output", `subagent-startup-empty-e2e-${Date.now()}`)
)
assert(!existsSync(artifacts), "Use a fresh acceptance directory")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const traceFile = join(artifacts, "worker-lifecycle.ndjson")
writeFileSync(
  traceFile,
  JSON.stringify({
    event: "runner-start",
    runnerPid: process.pid,
    scope: "Workers after observer attach through detach; held reads are not performance evidence"
  }) + "\n",
  { flag: "wx" }
)
const observations: ReadObservation[] = []
const zeroChecks: ReadObservation[] = []
const checks: string[] = []
const pageErrors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let packageIdentity: Record<string, unknown> | undefined
let traceSummary: SnapshotTraceSummary | undefined
let holdSummary: StartupReadHoldSummary | undefined
let readStates: Record<string, unknown> = {}
let queryErrorControl: Record<string, unknown> | undefined
let controlsComplete = false
let pendingSettled = false
let appClosed = false

const pass = (name: string): void => {
  checks.push(name)
  console.log("PASS " + name)
}

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((done) => setTimeout(done, 50))
  }
  throw Error("Timeout: " + label)
}

function startupCount(): number {
  return readFileSync(traceFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      return JSON.parse(line) as { event?: string; name?: string }
    })
    .filter((entry) => {
      return entry.event === "worker-created" && entry.name === "subagent-transcript-startup"
    }).length
}

async function startRead(name: string, threadId: string, foreground = false): Promise<void> {
  assert(page)
  await page.evaluate(
    ({ name, threadId, foreground }) => {
      const fixture = window as unknown as FixtureWindow
      const reads = (fixture.subagentStartupFixtureReads ??= {})
      if (reads[name] || Object.keys(reads).length >= 16) throw Error("FIXTURE_READ_LIMIT")
      const read: FixtureRead = { state: "pending", promise: Promise.resolve() }
      reads[name] = read
      read.promise = fixture.api.threads
        .getSubagentTranscripts(
          threadId,
          foreground ? { requestScope: "foreground-hydration" } : undefined
        )
        .then(
          (value) => {
            read.value = value
            read.state = "fulfilled"
          },
          (reason) => {
            read.error = String(reason).slice(0, 1_000)
            read.state = "rejected"
          }
        )
    },
    { name, threadId, foreground }
  )
}

async function readState(name: string) {
  assert(page)
  return page.evaluate((name) => {
    const read = (window as unknown as FixtureWindow).subagentStartupFixtureReads?.[name]
    return read ? { state: read.state, value: read.value, error: read.error } : undefined
  }, name)
}

async function finishRead(name: string): Promise<Record<string, unknown>> {
  await until(async () => (await readState(name))?.state !== "pending", name + " settles")
  const read = await readState(name)
  assert(read && read.state === "fulfilled", read?.error ?? name + " did not fulfill")
  assert(read.value)
  return read.value
}

async function observeRead(name: string, threadId: string, foreground = false) {
  const startupBefore = startupCount()
  await startRead(name, threadId, foreground)
  const value = await finishRead(name)
  const startupAfter = startupCount()
  const observation = {
    name,
    startupBefore,
    startupAfter,
    startupDelta: startupAfter - startupBefore,
    value,
    verified: false
  }
  observations.push(observation)
  return observation
}

async function persist(threadId: string, bucket: string, marker: string): Promise<void> {
  assert(page)
  await page.evaluate(
    ({ threadId, bucket, marker }) => {
      return (window as unknown as FixtureWindow).api.threads.persistSubagentTranscripts(threadId, {
        [bucket]: [
          { id: "subagent-prompt-" + bucket, role: "user", content: marker + "_PROMPT" },
          {
            id: "subagent-final-" + bucket,
            role: "assistant",
            content: marker + "_RESULT",
            status: "completed"
          }
        ]
      })
    },
    { threadId, bucket, marker }
  )
}

function verifyContent(observation: ReadObservation, bucket: string, marker: string): void {
  assert.equal(observation.startupDelta, 1, observation.name + " observes its real startup Worker")
  assert(Array.isArray(observation.value[bucket]), observation.name + " retains its bucket")
  const encoded = JSON.stringify(observation.value[bucket])
  assert(encoded.includes(marker + "_PROMPT"), observation.name + " retains the prompt")
  assert(encoded.includes(marker + "_RESULT"), observation.name + " retains the result")
  observation.verified = true
  pass(observation.name)
}

/** Serialized into main; the DDL is restricted to the new fixture's private database. */
function setMissingBucketTable(
  _electron: unknown,
  options: {
    privateRoot: string
    dataRoot: string
    workspace: string
    threadId: string
    action: "hide" | "restore"
  }
): void {
  const fs = process.getBuiltinModule("fs")
  const path = process.getBuiltinModule("path")
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
  if (process.env.CMB_COWORK_AGENT_HOME !== options.dataRoot) {
    throw Error("QUERY_ERROR_FIXTURE_DATA_ROOT_CHANGED")
  }
  const filename = path.resolve(options.dataRoot, "cmbcoworkagent.sqlite")
  if (!fs.existsSync(filename)) throw Error("QUERY_ERROR_FIXTURE_DATABASE_MISSING")
  const realFilename = fs.realpathSync(filename)
  const relative = path.relative(fs.realpathSync(options.privateRoot), realFilename)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Error("QUERY_ERROR_FIXTURE_DATABASE_NOT_PRIVATE")
  }
  const database = new sqlite.DatabaseSync(realFilename, { timeout: 1_000 })
  try {
    const row = database
      .prepare("SELECT title, metadata FROM threads WHERE thread_id = ?")
      .get(options.threadId)
    if (
      !row ||
      row.title !== "STARTUP_EMPTY_FIXTURE_b" ||
      typeof row.metadata !== "string" ||
      JSON.parse(row.metadata).workspacePath !== options.workspace
    ) {
      throw Error("QUERY_ERROR_FIXTURE_THREAD_OWNERSHIP_INVALID")
    }
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    const original = Boolean(table.get("thread_subagent_buckets"))
    const hidden = Boolean(table.get("startup_empty_fixture_hidden_buckets"))
    if (options.action === "hide") {
      if (!original || hidden) throw Error("QUERY_ERROR_FIXTURE_TABLE_STATE_INVALID")
      database.exec(
        "ALTER TABLE thread_subagent_buckets RENAME TO startup_empty_fixture_hidden_buckets"
      )
    } else if (!original && hidden) {
      database.exec(
        "ALTER TABLE startup_empty_fixture_hidden_buckets RENAME TO thread_subagent_buckets"
      )
    } else if (!original || hidden) {
      throw Error("QUERY_ERROR_FIXTURE_RESTORE_STATE_INVALID")
    }
  } finally {
    database.close()
  }
}

async function run(failures: unknown[]): Promise<void> {
  const watchdog = setTimeout(() => {
    failures.push(Error("SUBAGENT_STARTUP_E2E_DEADLINE"))
    void app?.close().catch((reason) => failures.push(reason))
  }, 180_000)
  watchdog.unref()
  try {
    app = await launch(45_000)
    await app.context().route(/^https?:/, (route) => route.abort())
    page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (reason) => pageErrors.push(reason.message))
    await page.addInitScript("window.__name = value => value")
    await app.evaluate("globalThis.__name = value => value\nvoid 0")
    await page.waitForFunction(() => Boolean((window as unknown as FixtureWindow).api?.threads))
    await page.evaluate("window.__name = value => value\nvoid 0")
    packageIdentity = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      executable: process.execPath,
      asar: app.getAppPath(),
      pid: process.pid,
      privateHome: process.env.HOME,
      dataRoot: process.env.CMB_COWORK_AGENT_HOME,
      userData: app.getPath("userData")
    }))
    assert.equal(packageIdentity.privateHome, env.HOME)
    assert.equal(packageIdentity.dataRoot, env.CMB_COWORK_AGENT_HOME)
    await app.evaluate(installSnapshotWorkerTrace, traceFile)
    const fixtures = await page.evaluate(
      async ({ workspace }) => {
        const api = (window as unknown as FixtureWindow).api
        const ids: Record<string, string> = {}
        for (const name of ["blank", "modern", "zero", "legacy", "a", "b", "c"]) {
          const thread = await api.threads.create({
            title: "STARTUP_EMPTY_FIXTURE_" + name,
            workspacePath: workspace,
            agentMode: "normal"
          })
          if (!thread.thread_id) throw Error("FIXTURE_THREAD_CREATE_FAILED")
          ids[name] = thread.thread_id
        }
        return ids
      },
      { workspace }
    )
    writeFileSync(join(artifacts, "fixture-threads.json"), JSON.stringify(fixtures, null, 2) + "\n")
    for (const name of ["blank", "blank-repeat"]) {
      const observation = await observeRead(name, fixtures.blank)
      assert.deepEqual(observation.value, {})
      zeroChecks.push(observation)
    }
    await persist(fixtures.modern, "modern-worker", "MODERN_STARTUP")
    verifyContent(await observeRead("modern", fixtures.modern), "modern-worker", "MODERN_STARTUP")
    await app.evaluate(
      (_electron, { privateRoot, dataRoot, workspace, fixtures }) => {
        const fs = process.getBuiltinModule("fs")
        const path = process.getBuiltinModule("path")
        const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
        const privatePath = fs.realpathSync(privateRoot)
        if (process.env.CMB_COWORK_AGENT_HOME !== dataRoot) throw Error("FIXTURE_DATA_ROOT_CHANGED")
        const filename = path.resolve(dataRoot, "cmbcoworkagent.sqlite")
        if (!fs.existsSync(filename)) throw Error("FIXTURE_DATABASE_MISSING")
        const realFilename = fs.realpathSync(filename)
        const relative = path.relative(privatePath, realFilename)
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw Error("FIXTURE_DATABASE_NOT_PRIVATE")
        }
        const database = new sqlite.DatabaseSync(realFilename, { timeout: 1_000 })
        try {
          database.exec("BEGIN IMMEDIATE")
          const lookup = database.prepare("SELECT title, metadata FROM threads WHERE thread_id = ?")
          for (const name of ["zero", "legacy"] as const) {
            const row = lookup.get(fixtures[name])
            if (
              !row ||
              row.title !== "STARTUP_EMPTY_FIXTURE_" + name ||
              typeof row.metadata !== "string" ||
              JSON.parse(row.metadata).workspacePath !== workspace
            ) {
              throw Error("FIXTURE_THREAD_OWNERSHIP_INVALID")
            }
          }
          database
            .prepare(
              "INSERT INTO thread_subagent_buckets " +
                "(thread_id, subagent_id, message_count, next_ordinal, updated_at) VALUES (?, ?, 0, 0, ?)"
            )
            .run(fixtures.zero, "zero-worker", Date.now())
          const legacy = {
            subagentTranscripts: {
              "legacy-worker": [
                { id: "subagent-prompt-legacy", role: "user", content: "LEGACY_STARTUP_PROMPT" },
                {
                  id: "subagent-final-legacy",
                  role: "assistant",
                  status: "completed",
                  content: "LEGACY_STARTUP_RESULT"
                }
              ]
            }
          }
          const inserted = database
            .prepare("UPDATE threads SET thread_values = ? WHERE thread_id = ?")
            .run(JSON.stringify(legacy), fixtures.legacy)
          if (inserted.changes !== 1) throw Error("FIXTURE_LEGACY_SEED_FAILED")
          database.exec("COMMIT")
        } catch (reason) {
          try {
            database.exec("ROLLBACK")
          } catch {
            // Preserve the original fixture failure when BEGIN itself was rejected.
          }
          throw reason
        } finally {
          database.close()
        }
      },
      { privateRoot: isolated, dataRoot: env.CMB_COWORK_AGENT_HOME, workspace, fixtures }
    )
    const zeroBucket = await observeRead("zero-message-bucket", fixtures.zero)
    assert.equal(zeroBucket.startupDelta, 1)
    assert.deepEqual(zeroBucket.value, { "zero-worker": [] })
    zeroBucket.verified = true
    pass(zeroBucket.name)
    verifyContent(
      await observeRead("legacy-migration", fixtures.legacy),
      "legacy-worker",
      "LEGACY_STARTUP"
    )
    await persist(fixtures.blank, "after-empty-worker", "AFTER_EMPTY_STARTUP")
    verifyContent(
      await observeRead("persist-after-empty", fixtures.blank),
      "after-empty-worker",
      "AFTER_EMPTY_STARTUP"
    )
    await persist(fixtures.a, "foreground-worker", "FOREGROUND_STARTUP")
    await persist(fixtures.c, "background-worker", "BACKGROUND_STARTUP")
    const warmed = await observeRead("empty-scope-prewarm", fixtures.b, true)
    assert.deepEqual(warmed.value, {})
    zeroChecks.push(warmed)
    await app.evaluate(installSubagentStartupReadHold, {
      threadIds: [fixtures.a, fixtures.c] satisfies [string, string],
      privateRoot: isolated,
      timeoutMs: 30_000
    })
    const holdSnapshot = async () => {
      assert(app)
      return app.evaluate(() => {
        return (globalThis as unknown as StartupReadHoldGlobal).subagentStartupReadHold?.snapshot()
      })
    }
    await startRead("scope-a", fixtures.a, true)
    await until(
      async () => (await holdSnapshot())?.states[fixtures.a].held === true,
      "foreground A read is actually held"
    )
    assert.equal((await readState("scope-a"))?.state, "pending")
    await startRead("scope-c", fixtures.c)
    await until(
      async () => (await holdSnapshot())?.states[fixtures.c].held === true,
      "background C occupies the second startup slot"
    )
    const beforeEmpty = await holdSnapshot()
    assert(beforeEmpty && !beforeEmpty.observationFailed)
    assert.equal(beforeEmpty.remainingReferences, 2)
    assert.notEqual(
      beforeEmpty.states[fixtures.a].workerId,
      beforeEmpty.states[fixtures.c].workerId
    )
    assert.equal((await readState("scope-c"))?.state, "pending")
    const emptyScope = await observeRead("empty-foreground-scope", fixtures.b, true)
    assert.deepEqual(emptyScope.value, {})
    zeroChecks.push(emptyScope)
    assert.deepEqual(await finishRead("scope-a"), {})
    assert.equal((await readState("scope-c"))?.state, "pending")
    const afterEmpty = await holdSnapshot()
    assert(afterEmpty && !afterEmpty.observationFailed)
    assert.equal(afterEmpty.states[fixtures.a].exited, true)
    assert.equal(afterEmpty.states[fixtures.c].held, true)
    assert.equal(afterEmpty.states[fixtures.c].exited, false)
    assert.equal(
      await app.evaluate((_electron, id) => {
        return (globalThis as unknown as StartupReadHoldGlobal).subagentStartupReadHold?.release(id)
      }, fixtures.c),
      true
    )
    const background = await finishRead("scope-c")
    assert(JSON.stringify(background).includes("BACKGROUND_STARTUP_PROMPT"))
    assert(JSON.stringify(background).includes("BACKGROUND_STARTUP_RESULT"))
    pass("Empty foreground cancels held A without cancelling held background C")
    try {
      assert.equal(
        await page.evaluate(() => {
          const reads = (window as unknown as FixtureWindow).subagentStartupFixtureReads ?? {}
          return Object.values(reads).filter((read) => read.state === "pending").length
        }),
        0,
        "All fixture reads settle before the private SQL negative control"
      )
      const queryOptions = {
        privateRoot: isolated,
        dataRoot: env.CMB_COWORK_AGENT_HOME,
        workspace,
        threadId: fixtures.b
      }
      queryErrorControl = { tableRestored: false }
      try {
        await app.evaluate(setMissingBucketTable, { ...queryOptions, action: "hide" as const })
        await page.evaluate((threadId) => {
          const fixture = window as unknown as FixtureWindow
          const reads = (fixture.subagentStartupFixtureReads ??= {})
          const name = "missing-bucket-table"
          if (reads[name] || Object.keys(reads).length >= 16) throw Error("FIXTURE_READ_LIMIT")
          const read: FixtureRead = { state: "pending", promise: Promise.resolve() }
          reads[name] = read
          read.promise = fixture.api.threads
            .getSubagentTranscripts(threadId, { requestScope: "foreground-hydration" })
            .then(
              () => {
                read.state = "fulfilled"
              },
              (reason) => {
                const missingTable = /no such table:\s*(?:main\.)?thread_subagent_buckets\b/i
                read.error = missingTable.test(String(reason))
                  ? "MISSING_BUCKET_TABLE"
                  : "UNEXPECTED_IPC_FAILURE"
                read.state = "rejected"
              }
            )
        }, fixtures.b)
        await until(
          async () => (await readState("missing-bucket-table"))?.state !== "pending",
          "missing-table IPC read rejects"
        )
        const failedRead = await readState("missing-bucket-table")
        queryErrorControl.state = failedRead?.state
        queryErrorControl.error = failedRead?.error
        assert.equal(failedRead?.state, "rejected", "A missing bucket table must not return {}")
        assert.equal(
          failedRead?.error,
          "MISSING_BUCKET_TABLE",
          "IPC preserves the missing-table error"
        )
        pass("Private bucket query failure rejects through real IPC")
      } finally {
        await app.evaluate(setMissingBucketTable, { ...queryOptions, action: "restore" as const })
        queryErrorControl.tableRestored = true
      }
    } catch (reason) {
      failures.push(reason)
    }
    controlsComplete = true
    // Keep all positive controls and actual RED counts before asserting the optimization.
    for (const observation of zeroChecks) {
      try {
        assert.equal(observation.startupDelta, 0, observation.name + " creates no startup Worker")
        observation.verified = true
        pass(observation.name + " creates no startup Worker")
      } catch (reason) {
        failures.push(reason)
      }
    }
    assert.deepEqual(pageErrors, [])
  } catch (reason) {
    failures.push(reason)
  } finally {
    if (app) {
      await attemptModsE2eCleanup(failures, async () => {
        holdSummary = await app!.evaluate(() => {
          return (globalThis as unknown as StartupReadHoldGlobal).subagentStartupReadHold?.close()
        })
        if (controlsComplete) {
          assert(holdSummary, "The real Worker hold observer must be present")
        }
        if (holdSummary) {
          assert.equal(holdSummary.observationFailed, false)
          assert.equal(holdSummary.dropped, 0)
          assert.equal(holdSummary.remainingReferences, 0)
          assert.equal(holdSummary.detached, true)
        }
      })
      if (page) {
        await attemptModsE2eCleanup(failures, async () => {
          await until(async () => {
            readStates = await page!.evaluate(() => {
              const reads = (window as unknown as FixtureWindow).subagentStartupFixtureReads ?? {}
              return Object.fromEntries(
                Object.entries(reads).map(([name, read]) => [
                  name,
                  {
                    state: read.state,
                    value: read.value,
                    error: read.error
                  }
                ])
              )
            })
            return Object.values(readStates).every((read) => {
              return (read as { state: string }).state !== "pending"
            })
          }, "all fixture IPC reads settle during cleanup")
          await page!.evaluate(async () => {
            const reads = (window as unknown as FixtureWindow).subagentStartupFixtureReads ?? {}
            await Promise.allSettled(Object.values(reads).map((read) => read.promise))
          })
          pendingSettled = true
        })
      }
      await attemptModsE2eCleanup(failures, async () => {
        traceSummary = await app!.evaluate(() => {
          return (globalThis as unknown as SnapshotTraceGlobal).snapshotWorkerTrace?.close()
        })
        assert(traceSummary, "The real diagnostics observer must be present")
        assert.equal(traceSummary.observationFailed, false)
        assert.equal(traceSummary.dropped, 0)
        assert.equal(traceSummary.detached, true)
        assert.equal(traceSummary.remainingReferences, 0)
      })
      appClosed = await attemptModsE2eCleanup(failures, () => app!.close())
    }
    clearTimeout(watchdog)
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          passed: controlsComplete && pendingSettled && appClosed && failures.length === 0,
          controlsComplete,
          packageIdentity,
          privateRoot: isolated,
          observations,
          checks,
          pageErrors,
          traceSummary,
          holdSummary,
          queryErrorControl,
          readStates,
          cleanup: { pendingSettled, appClosed },
          failures: failures.map((reason) =>
            reason instanceof Error ? reason.message : String(reason)
          ),
          limitation: "The two held reads establish cancellation ordering, not ordinary-path timing"
        },
        null,
        2
      ) + "\n"
    )
  }
}

runModsE2eWithFailures(run).catch((reason) => {
  console.error(reason)
  process.exitCode = 1
})
