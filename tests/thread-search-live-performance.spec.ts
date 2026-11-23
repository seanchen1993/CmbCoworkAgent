/** Real Electron search and normal chat performance. Build before running with tsx. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright"
import { sqliteRecoveryFamilyKey } from "../src/main/db/sqlite-recovery-family"

import type { ThreadSearchStartRequest } from "../src/shared/thread-search-types"
import {
  PROBE_PROJECT_ID,
  projectProbeCases,
  projectProbeMarker,
  projectProbeMetadata,
  projectProbeTitle,
  seedProbeProjects
} from "./support/project-thread-search-fixture"
import { installProjectSearchHarnessAdapter } from "./support/project-search-harness-adapter"

const unknownFeaturePressure = process.env.CMB_THREAD_SEARCH_PROBE_UNKNOWN_FEATURES === "1"
const mixedProjects = unknownFeaturePressure || process.env.CMB_THREAD_SEARCH_PROBE_PROJECTS === "1"
const coldIpc = process.env.CMB_THREAD_SEARCH_PROBE_IPC_COLD === "1"
const persistedEvidence = process.env.CMB_THREAD_SEARCH_PROBE_PERSISTED_EVIDENCE === "1"
const coldCase = process.env.CMB_THREAD_SEARCH_PROBE_IPC_CASE
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const rounds = Number(process.env.CMB_THREAD_SEARCH_PROBE_ROUNDS ?? 30)
const threadCount = unknownFeaturePressure ? 2048 : Number(process.env.CMB_THREAD_SEARCH_PROBE_THREADS ?? 10000)
const artifactRoot = process.env.CMB_THREAD_SEARCH_PROBE_ARTIFACT_ROOT || tmpdir()
mkdirSync(artifactRoot, { recursive: true })
const artifactDir = mkdtempSync(join(artifactRoot, "cmb-thread-search-live-"))
const dataRoot = join(artifactDir, "data")
const checkpointDirectory = join(dataRoot, "threads")
const workspace = join(artifactDir, "workspace")
const payload = "Search performance uses a scheduled stream of ordinary chat content. ".repeat(39)
const absent = "absent-text-live-perf"
const oldest = "oldest-text-live-perf"
const newest = "recent-text-live-perf"
const title = "recent-title-live-perf"
const fixtureWorkspace = join(artifactDir, "historical-workspace")
const excludedHistory = {
  projectId: "project-catalog-noise-0",
  threadId: "known-excluded-feature-history",
  slug: "excluded-history-slug",
  title: "known-excluded-history-perf"
}

function seedPersistedEvidence(projectIds: string[]): number {
  // Use the on-disk format here so Electron must load and validate it on each cold launch.
  const slugsByProject = new Map(projectIds.map((id) => [id, ["feature-evidence-" + "x".repeat(355)]]))
  for (let index = 0; index < threadCount; index += 1) {
    const feature = projectProbeMetadata(index, threadCount, true).harnessFeature
    if (feature) slugsByProject.get(feature.projectId)!.push(feature.slug)
  }
  const contents = JSON.stringify(Array.from(slugsByProject, ([id, slugs]) =>
    [createHash("sha256").update(id).digest("hex"), slugs]
  ))
  const bytes = Buffer.byteLength(contents)
  assert(bytes >= 850_000 && bytes <= 1024 * 1024, "Persisted evidence must exercise near-capacity load")
  writeFileSync(join(dataRoot, "thread-search-feature-evidence.json"), contents)
  return bytes
}

async function main() {
  assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 30)
  assert(Number.isSafeInteger(threadCount) && threadCount >= 12 && threadCount <= 10000)
  assert(!persistedEvidence || (mixedProjects && coldIpc && !unknownFeaturePressure),
    "Persisted evidence requires mixed-project cold IPC")
  mkdirSync(checkpointDirectory, { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(dataRoot, "userinfo-models.json"), JSON.stringify({
    sapId: "localhost-fixture", userName: "Local fixture"
  }))

  const registry = mixedProjects
    ? seedProbeProjects(dataRoot, fixtureWorkspace, 2048, PROBE_PROJECT_ID)
    : undefined
  let offlineAdapterLog: string | undefined
  if (unknownFeaturePressure) {
    const path = join(dataRoot, "harness-board-projects.json")
    const catalog = JSON.parse(readFileSync(path, "utf8")) as {
      projects: Array<{ projectId: string; projectDir?: string }>
    }
    for (const project of catalog.projects) {
      project.projectDir = project.projectId === "project-catalog-noise-0"
        ? "offline-fixture" : "missing-offline-fixture"
    }
    mkdirSync(join(fixtureWorkspace, "offline-fixture"), { recursive: true })
    const stored = JSON.stringify(catalog)
    assert(Buffer.byteLength(stored) <= 4 * 1024 * 1024)
    writeFileSync(path, stored)
    if (registry) registry.bytes = Buffer.byteLength(stored)
    offlineAdapterLog = installProjectSearchHarnessAdapter(dataRoot, "not-authorized")
    writeFileSync(join(dirname(offlineAdapterLog), "inspect.cjs"), [
      'const fs = require("node:fs")',
      'fs.appendFileSync(' + JSON.stringify(offlineAdapterLog) + ', "offline\\n")',
      'process.stderr.write("Offline fixture adapter")',
      'process.exitCode = 13'
    ].join("\n"))
  }
  const projectIds = registry ? [...registry.projects.keys()] : []
  const persistedEvidenceBytes = persistedEvidence ? seedPersistedEvidence(projectIds) : undefined
  const projectRows = mixedProjects
    ? Array.from({ length: threadCount }, (_, index) => ({
      metadata: unknownFeaturePressure
        ? { harnessFeature: { projectId: projectIds[index], slug: "unknown-feature-" + index } }
        : projectProbeMetadata(index, threadCount, true),
      title: projectProbeTitle(index),
      first: projectProbeMarker(index, 0),
      last: projectProbeMarker(index, 9)
    }))
    : undefined
  const cases: Array<{
    key: string
    query: string
    expectedIndex: number | null
    expectedCandidates: number
    expectedOffline?: "featureSession" | "projectSession"
    scope?: ThreadSearchStartRequest["scope"]
    hot: number
    cold?: number
    verifyScan: boolean
  }> = unknownFeaturePressure ? [] : mixedProjects ? projectProbeCases(threadCount, true).map((test) => ({
    ...test,
    key: [test.scope.kind, test.scope.kind === "project" ? test.scope.projectId : "", test.label]
      .filter(Boolean).join(":"),
    expectedCandidates: test.expectedCandidates +
      (test.scope.kind === "all" || test.scope.kind === "ordinary" ? 1 : 0),
    expectedOffline: test.expectedIndex !== null &&
      projectProbeMetadata(test.expectedIndex, threadCount, true).harnessFeature ? "featureSession"
      : test.expectedIndex === 1 ? "projectSession"
      : undefined,
    verifyScan: test.label === "oldest" || test.label === "noMatch"
  })) : [
    { key: title, query: title, expectedIndex: threadCount - 1, expectedCandidates: threadCount,
      hot: 1000, verifyScan: false },
    { key: newest, query: newest, expectedIndex: threadCount - 1, expectedCandidates: threadCount,
      hot: 1000, verifyScan: false },
    { key: oldest, query: oldest, expectedIndex: 0, expectedCandidates: threadCount,
      hot: 10000, verifyScan: true },
    { key: absent, query: absent, expectedIndex: null, expectedCandidates: threadCount,
      hot: 10000, verifyScan: true }
  ]

  let chunks = 0
  let finishStream: (() => void) | undefined
  const streamingStarted = Promise.withResolvers<void>()
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let text = ""
      for await (const chunk of request) text += chunk
      assert.match(text, /THREAD_SEARCH_LIVE_PERF/)
      assert.equal(JSON.parse(text).stream, true)
      assert(!finishStream, "Only one normal turn should reach the model")
      response.writeHead(200, { "content-type": "text/event-stream" })
      const write = (delta: unknown, finishReason: string | null) =>
        response.write(`data: ${JSON.stringify({
          id: "local-perf-run", object: "chat.completion.chunk", model: "local",
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        })}\n\n`)
      write({ role: "assistant", content: "THREAD_SEARCH_LIVE_ANSWER " }, null)
      const timer = setInterval(() => {
        chunks += 1
        write({ content: "进度。 " }, null)
      }, 150)
      response.on("close", () => clearInterval(timer))
      finishStream = () => {
        clearInterval(timer)
        write({}, "stop")
        response.end("data: [DONE]\n\n")
      }
      streamingStarted.resolve()
    } catch (error) {
      errors.push(String(error))
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as { port: number }

  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value && /^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)
  )) as Record<string, string>
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    env[key] = join(artifactDir, key)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: dataRoot,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })

  const launch = () => _electron.launch({
    executablePath: process.platform === "win32"
      ? join(root, "tests/support/electron-launcher.cmd") : binary,
    args: [join(root, "out/main/index.js"), "--user-data-dir=" + join(artifactDir, "electron")],
    cwd: root, env, timeout: 60000
  })
  const configureApp = async (instance: ElectronApplication, logPath: string) => {
    instance.process().stdout?.on("data", (data) => appendFileSync(logPath, data))
    instance.process().stderr?.on("data", (data) => appendFileSync(logPath, data))
    const processPriority = await instance.evaluate((_electron, aboveNormal) => {
      const os = process.getBuiltinModule("node:os") as typeof import("node:os")
      if (aboveNormal) os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
      return os.getPriority(process.pid)
    }, process.env.CMB_THREAD_SEARCH_PROBE_PRIORITY === "above-normal")
    await instance.context().route(/^https?:/, (route) => route.abort())
    return processPriority
  }
  let app: ElectronApplication | undefined
  try {
    app = await launch()
    const processPriority = await configureApp(app, join(artifactDir, "electron.log"))
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.threads))
    await page.evaluate("globalThis.__name = (value) => value")
    await page.evaluate(async ({ baseUrl, workspace }) => {
      await window.api.models.setCustomConfig({
        id: "live-search-perf", name: "Local model fixture", baseUrl, model: "local",
        apiKey: "local-only", maxTokens: 64000, maxOutputTokens: 4096
      })
      await window.api.models.setDefault("custom:live-search-perf")
      await window.api.routing.setMode("pinned")
      const thread = await window.api.threads.create({
        title: "Normal streaming chat", workspacePath: workspace,
        model: "custom:live-search-perf", agentMode: "normal"
      })
      ;(globalThis as { liveThreadId?: string }).liveThreadId = thread.thread_id
    }, { baseUrl: `http://127.0.0.1:${port}/v1`, workspace })
    await app.evaluate((_electron, options) => {
      const { databasePath, threadCount, payload, oldest, newest, title, template, checkpointDirectory,
        fixtureWorkspace, projectRows, excludedHistory } = options
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs")
      const path = process.getBuiltinModule("node:path") as typeof import("node:path")
      const db = new sqlite.DatabaseSync(databasePath, { timeout: 4000 })
      const example = new sqlite.DatabaseSync(template)
      example.exec(`
        PRAGMA page_size = 1024;
        CREATE TABLE checkpoints (thread_id TEXT, checkpoint_id TEXT, checkpoint TEXT)
      `)
      example.close()
      const checkpointBytes = fs.readFileSync(template)
      try {
        const thread = db.prepare(`INSERT INTO threads (thread_id, created_at, updated_at, title, metadata)
          VALUES (?, ?, ?, ?, ?)`)
        const insert = db.prepare(`INSERT INTO thread_messages
          (thread_id, message_id, role, content_json, ordinal, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
        const migration = db.prepare(`INSERT INTO legacy_checkpoint_transcript_migrations
          (thread_id, checkpoint_id, status, next_index, total_messages, updated_at, search_projection_state)
          VALUES (?, 'fixture-checkpoint', 'complete', 10, 10, 1, 'complete')`)
        for (let sequence = 0; sequence < threadCount; sequence += 1) {
          if (sequence % 250 === 0) db.exec("BEGIN")
          const id = `perf-${sequence}`
          const last = sequence === threadCount - 1
          const projectRow = projectRows?.[sequence]
          thread.run(id, sequence, sequence, projectRow?.title ?? (last ? title : "Fixture " + sequence),
            JSON.stringify({ workspacePath: fixtureWorkspace, ...projectRow?.metadata }))
          migration.run(id)
          for (let ordinal = 0; ordinal < 10; ordinal += 1) {
            const marker = projectRow
              ? (ordinal === 0 ? projectRow.first : ordinal === 9 ? projectRow.last : "")
              : ordinal === 0 && sequence === 0 ? oldest : last && ordinal === 9 ? newest : ""
            insert.run(id, String(ordinal), ordinal % 3 ? "assistant" : "user",
              JSON.stringify(`${payload} ${marker}`), ordinal, ordinal)
          }
          fs.writeFileSync(path.join(checkpointDirectory, `${id}.sqlite`), checkpointBytes)
          if ((sequence + 1) % 250 === 0 || sequence + 1 === threadCount) db.exec("COMMIT")
          if ((sequence + 1) % 1000 === 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        }
        if (excludedHistory) {
          const { projectId, slug, threadId, title } = excludedHistory
          thread.run(threadId, threadCount, threadCount, title,
            JSON.stringify({ workspacePath: fixtureWorkspace, harnessFeature: { projectId, slug } }))
        }
      } finally {
        db.close()
      }
    }, {
      databasePath: join(dataRoot, "cmbcoworkagent.sqlite"),
      template: join(artifactDir, "checkpoint-template.sqlite"),
      checkpointDirectory, threadCount, payload, oldest, newest, title, fixtureWorkspace, projectRows,
      excludedHistory: persistedEvidence ? excludedHistory : undefined
    })
    const sourceKeys = Array.from({ length: threadCount }, (_, sequence) => {
      const id = `perf-${sequence}`
      const filename = `${id}.sqlite`
      return [id, sqliteRecoveryFamilyKey(join(checkpointDirectory, filename), new Set([filename]))]
    })
    await app.evaluate((_electron, { databasePath, sourceKeys }) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(databasePath, { timeout: 4000 })
      try {
        db.exec("BEGIN")
        const stamp = db.prepare(`UPDATE legacy_checkpoint_transcript_migrations SET source_key = ?
          WHERE thread_id = ?`)
        for (const [id, key] of sourceKeys) stamp.run(key, id)
        db.exec("COMMIT")
      } finally { db.close() }
    }, { databasePath: join(dataRoot, "cmbcoworkagent.sqlite"), sourceKeys })

    const requests = cases.map((test) => ({
      ...test,
      request: {
        query: test.query,
        ...(test.scope ? { scope: test.scope } : { workspacePath: fixtureWorkspace }),
        limit: 1
      }
    }))
    const measure = (window: Page, selected: typeof requests, iterations: number) =>
      window.evaluate(async ({ rounds, requests }) => {
        const harness = globalThis as { liveProgress?: number }
        const progressBefore = harness.liveProgress ?? 0
        const records: Record<string, { timings: number[]; scanned: number }> = {}
        for (const test of requests) {
          const sample = (records[test.key] = { timings: [], scanned: 0 })
          for (let iteration = 0; iteration < rounds; iteration += 1) {
            const started = performance.now()
            let reply = await globalThis.window.api.threads.searchStart(test.request)
            const sessionId = reply.sessionId
            let pages = 0
            try {
              for (;;) {
                pages += 1
                // The synthetic history is fully certified. The one real streaming
                // thread can still be in its native checkpoint audit.
                const activeChatOnly = progressBefore > 0 &&
                  (test.scope?.kind === "ordinary" || test.scope?.kind === "all") &&
                  reply.coverage.reasons.length === 1 &&
                  reply.coverage.reasons[0] === "legacy-pending" &&
                  reply.coverage.pendingThreads === 1 && !reply.coverage.failedThreads &&
                  !reply.coverage.skippedRows
                if (reply.coverage.reasons.length && !activeChatOnly) {
                  throw new Error(test.key + ": " + JSON.stringify({
                    coverage: reply.coverage, pages, elapsedMs: performance.now() - started,
                    scannedThreads: reply.scannedThreads, status: reply.scanStatus,
                    returnedResults: reply.results.length
                  }))
                }
                const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength
                if (bytes > 128 * 1024) throw new Error("Oversized search page: " + bytes)
                if (reply.results.length || !reply.nextCursor) break
                reply = await globalThis.window.api.threads.searchContinue(reply.nextCursor)
              }
              const actual = reply.results[0]?.threadId ?? null
              const expected = test.expectedIndex === null ? null : "perf-" + test.expectedIndex
              if (actual !== expected) throw new Error(test.key + ": expected " + expected + ", got " + actual)
              if (test.verifyScan && reply.scannedThreads !== test.expectedCandidates) {
                throw new Error(test.key + ": incomplete candidate scan " + reply.scannedThreads)
              }
              const oneLivePending = progressBefore > 0 &&
                  (test.scope?.kind === "ordinary" || test.scope?.kind === "all") &&
                reply.coverage.reasons.join() === "legacy-pending" && reply.coverage.pendingThreads === 1
              if (!reply.nextCursor && reply.coverage.completeness !== "complete" && !oneLivePending) {
                throw new Error(test.key + ": exhaustive search did not complete")
              }
              sample.scanned = reply.scannedThreads
              sample.timings.push(performance.now() - started)
              if (test.expectedOffline) {
                const hit = reply.results[0]
                if (hit?.route.kind !== test.expectedOffline) {
                  throw new Error(test.key + ": wrong route for the offline history hit")
                }
                const summary = await globalThis.window.api.threads.searchSummary(hit)
                if (!summary?.searchReadOnly || !summary.navigationTicketId) {
                  throw new Error(test.key + ": offline history did not yield a read-only ticket")
                }
                await globalThis.window.api.threads.searchCancelNavigation(summary.navigationTicketId)
              }
            } finally {
              await globalThis.window.api.threads.searchCancel(sessionId)
            }
          }
        }
        return { records, progress: (harness.liveProgress ?? 0) - progressBefore }
      }, { rounds: iterations, requests: selected })

    if (coldIpc) {
      assert(mixedProjects, "the IPC cold matrix requires CMB_THREAD_SEARCH_PROBE_PROJECTS=1")
      const filters = coldCase?.split(",")
      if (filters) for (const filter of filters) {
        assert(requests.some((test) => test.key === filter), "Unknown cold IPC case: " + filter)
      }
      const selectedCases = filters ? requests.filter((test) => filters.includes(test.key)) : requests
      await app.close()
      app = undefined
      const coldLog = join(artifactDir, "cold-electron.log")
      const samplesLog = join(artifactDir, "cold-ipc-samples.jsonl")
      for (const test of selectedCases) {
        const timings: number[] = []
        let scanned = 0
        for (let index = 0; index < rounds; index += 1) {
          appendFileSync(coldLog, `\nCold IPC case ${test.key}, sample ${index + 1}\n`)
          try {
            app = await launch()
            const actualPriority = await configureApp(app, coldLog)
            assert.equal(actualPriority, processPriority, "Cold Electron priority drift")
            const coldPage = await app.firstWindow()
            await coldPage.waitForFunction(() => Boolean(window.api?.threads))
            await coldPage.evaluate("globalThis.__name = (value) => value")
            const { records } = await measure(coldPage, [test], 1)
            if (persistedEvidence) {
              await assertPersistedExclusion(coldPage)
            }
            const durationMs = records[test.key].timings[0]
            scanned = records[test.key].scanned
            timings.push(durationMs)
            appendFileSync(samplesLog, JSON.stringify({
              key: test.key, sample: index + 1, actualPriority, durationMs, scanned
            }) + "\n")
          } catch (cause) {
            throw new Error(`${test.key}: cold Electron sample ${index + 1}/${rounds} failed`, { cause })
          } finally {
            await app?.close()
            app = undefined
          }
        }
        const p95 = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]
        const row = { mode: "cold IPC", key: test.key, rounds, expectedCandidates: test.expectedCandidates,
          expectedOffline: test.expectedOffline, scanned, p95, catalogProjects: registry?.projects.size,
          catalogBytes: registry?.bytes, persistedEvidenceBytes }
        appendFileSync(join(artifactDir, "cold-ipc-results.jsonl"), JSON.stringify(row) + "\n")
        console.log(JSON.stringify(row))
        assert(p95 <= test.cold!, test.key + " cold p95=" + p95 + "ms")
      }
      return
    }

    await page.evaluate(() => {
      const harness = globalThis as {
        liveThreadId?: string
        liveProgress?: number
        liveDone?: Promise<void>
      }
      harness.liveProgress = 0
      harness.liveDone = new Promise<void>((resolve, reject) => {
        const cleanup = window.api.agent.invoke(
          harness.liveThreadId!, "THREAD_SEARCH_LIVE_PERF", (event) => {
            if (event.type === "stream") harness.liveProgress! += 1
            if (event.type === "done" || event.type === "error") {
              cleanup()
              if (event.type === "error") reject(new Error(JSON.stringify(event)))
              else resolve()
            }
          }, "custom:live-search-perf", "normal"
        )
      })
      void harness.liveDone.catch(() => {})
    })
    await Promise.race([
      streamingStarted.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Local SSE stream did not start")), 20_000).unref())
    ])
    await page.waitForFunction(() => ((globalThis as { liveProgress?: number }).liveProgress ?? 0) > 1)
    await app.evaluate(() => {
      const { Worker } = process.getBuiltinModule("node:worker_threads") as typeof import("node:worker_threads")
      const audited = new Set<string>()
      Worker.prototype.emit = new Proxy(Worker.prototype.emit, {
        apply(target, receiver, args) {
          const candidate = args[1]?.backfill
          if (args[0] === "message" && typeof candidate?.threadId === "string" &&
              typeof candidate.sourceKey === "string") audited.add(candidate.threadId)
          return Reflect.apply(target, receiver, args)
        }
      })
      ;(globalThis as { searchAuditedThreads?: Set<string> }).searchAuditedThreads = audited
    })

    if (unknownFeaturePressure) {
      assert(!coldIpc)
      assert.equal(registry?.projects.size, 2048)
      assert(offlineAdapterLog)
      await runUnknownFeaturePressure(app, page, offlineAdapterLog, projectIds.at(-1)!, () => {
        assert(finishStream, "Local model must be streaming")
        finishStream()
      })
      return
    }
    await page.evaluate(async (request) => {
      const initial = await window.api.threads.searchStart(request)
      await window.api.threads.searchCancel(initial.sessionId)
    }, requests[0].request)
    await app.evaluate(() => {
      const perf = process.getBuiltinModule("node:perf_hooks") as typeof import("node:perf_hooks")
      const delay = perf.monitorEventLoopDelay({ resolution: 10 })
      const gc = { maxMs: 0 }
      const observer = new perf.PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) gc.maxMs = Math.max(gc.maxMs, entry.duration)
      })
      observer.observe({ entryTypes: ["gc"] })
      delay.enable()
      ;(globalThis as { searchMonitor?: object }).searchMonitor = { delay, observer, gc }
    })
    const samples = await measure(page, requests, rounds)
    const delay = await app.evaluate(() => {
      const { delay, observer, gc } = (globalThis as { searchMonitor?: {
        delay: ReturnType<typeof import("node:perf_hooks")["monitorEventLoopDelay"]>
        observer: import("node:perf_hooks").PerformanceObserver
        gc: { maxMs: number }
      } }).searchMonitor!
      delay.disable()
      observer.disconnect()
      return { p95Ms: delay.percentile(95) / 1e6, maxMs: delay.max / 1e6, gcMaxMs: gc.maxMs }
    })
    await assertLiveAuditOwnership(app, page)
    assert(finishStream, "Local model must be streaming")
    finishStream()
    await waitForPersistedFixtureReply(app, page)
    const saved = await page.evaluate(async () => {
      const { liveThreadId } = globalThis as { liveThreadId: string }
      return JSON.stringify(await window.api.threads.getHistory(liveThreadId))
    })
    assert.match(saved, /THREAD_SEARCH_LIVE_ANSWER/)
    assert(samples.progress > 0 && chunks > 0, "Normal chat streamed during the search samples")
    assert.deepEqual(errors, [])
    const p95 = Object.fromEntries(Object.entries(samples.records).map(([key, { timings }]) => [
      key, [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]
    ]))
    const report = { threadCount, messages: threadCount * 10, rounds, chunks, processPriority,
      chatEventsDuringSearch: samples.progress, p95, mainEventLoop: delay, mixedProjects,
      catalogProjects: registry?.projects.size, catalogBytes: registry?.bytes,
      scopes: cases.map(({ key, scope, expectedCandidates, expectedOffline }) => ({
        key, scope, expectedCandidates, expectedOffline, scanned: samples.records[key].scanned
      })) }
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    for (const test of cases) {
      assert(p95[test.key] <= test.hot, test.key + " p95=" + p95[test.key] + "ms")
    }
    assert(delay.p95Ms <= 50 && delay.maxMs <= 100,
      `Main event loop p95=${delay.p95Ms.toFixed(1)} ms maximum=${delay.maxMs.toFixed(1)} ms`)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

async function waitForPersistedFixtureReply(app: ElectronApplication, page: Page): Promise<void> {
  const threadId = await page.evaluate(() => (globalThis as { liveThreadId?: string }).liveThreadId)
  assert(threadId, "The real chat has a durable identity")
  const deadline = Date.now() + 20_000
  do {
    const complete = await app.evaluate((_electron, input) => {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
      const db = new sqlite.DatabaseSync(input.databasePath, { readOnly: true, timeout: 200 })
      try {
        return Boolean(db.prepare(
          "SELECT 1 FROM threads t JOIN thread_messages m ON m.thread_id = t.thread_id " +
          "WHERE t.thread_id = ? AND t.status = 'idle' AND m.role = 'assistant' " +
          "AND instr(m.content_json, 'THREAD_SEARCH_LIVE_ANSWER 进度。') > 0 LIMIT 1"
        ).get(input.threadId))
      } finally {
        db.close()
      }
    }, { databasePath: join(dataRoot, "cmbcoworkagent.sqlite"), threadId })
    if (complete) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error("Live chat did not settle with its streamed reply persisted")
}

async function assertPersistedExclusion(page: Page): Promise<void> {
  await page.evaluate(async ({ projectId, title }) => {
    let reply = await window.api.threads.searchStart({
      query: title, scope: { kind: "project", projectId }, limit: 1
    })
    const { sessionId } = reply
    try {
      for (;;) {
        if (reply.results.length || reply.coverage.reasons.length) {
          throw new Error("Persisted Feature exclusion was not applied")
        }
        if (!reply.nextCursor) break
        reply = await window.api.threads.searchContinue(reply.nextCursor)
      }
      if (reply.scanStatus !== "complete" || reply.coverage.completeness !== "complete" ||
          reply.scannedThreads !== 0) {
        throw new Error("The known-excluded Feature must not enter the candidate list")
      }
    } finally {
      await window.api.threads.searchCancel(sessionId)
    }
  }, excludedHistory)
}

async function assertLiveAuditOwnership(app: ElectronApplication, page: Page): Promise<void> {
  const liveThreadId = await page.evaluate(() => (globalThis as { liveThreadId?: string }).liveThreadId)
  const audited = await app.evaluate(() =>
    [...((globalThis as { searchAuditedThreads?: Set<string> }).searchAuditedThreads ?? [])]
  )
  assert(liveThreadId, "The real chat has a durable identity")
  assert(audited.every((id) => id === liveThreadId),
    "Only the active ordinary chat can require a search audit: " + audited.join(","))
}

async function runUnknownFeaturePressure(
  app: ElectronApplication,
  chatPage: Page,
  adapterLog: string,
  missingDirectoryProjectId: string,
  finishStream: (() => void) | undefined
): Promise<void> {
  // Neither search window opens the Board. The registered adapter fails when explicitly invoked.
  const secondWindowReady = app.waitForEvent("window", {
    predicate: (window) => window !== chatPage
  })
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false } })
    await window.loadURL("about:blank#project-search-pressure")
  }, join(root, "out/preload/index.js"))
  const secondWindow = await secondWindowReady
  await secondWindow.waitForFunction(() => Boolean(window.api?.threads))

  // Observe detail-request admission without changing IPC or application code.
  // Keep a positive control outside the measured interval so a broken counter cannot pass.
  await app.evaluate(() => {
    const perf = process.getBuiltinModule("node:perf_hooks") as typeof import("node:perf_hooks")
    const delay = perf.monitorEventLoopDelay({ resolution: 10 })
    const counters = { queuedDetails: 0 }
    const originalSet = Map.prototype.set
    Map.prototype.set = new Proxy(originalSet, {
      apply(target, receiver, args) {
        if (args[1] instanceof AbortController && new Error().stack?.includes("beginHarnessDetailRequest")) {
          counters.queuedDetails += 1
        }
        return Reflect.apply(target, receiver, args)
      }
    })
    ;(globalThis as { featurePressure?: object }).featurePressure = {
      counters, delay, originalSet
    }
  })
  try {
    const positiveControl = await secondWindow.evaluate(async (projectId) => {
      try {
        const detail = await window.api.harnessBoard.getProjectDetail(projectId)
        return Boolean(detail.error)
      } catch {
        return true
      }
    }, "project-catalog-noise-0")
    assert(positiveControl, "Explicit adapter lookup must fail")
    const baselineAdapterLog = readFileSync(adapterLog, "utf8")
    assert.equal(baselineAdapterLog, "offline\n",
      "Expected the explicit lookup to launch the same registered offline adapter once")
    await app.evaluate(() => {
      const probe = (globalThis as {
        featurePressure?: {
          counters: { queuedDetails: number }
          delay: ReturnType<typeof import("node:perf_hooks")["monitorEventLoopDelay"]>
        }
      }).featurePressure!
      if (!probe.counters.queuedDetails) throw new Error("Detail-admission counter is not wired")
      probe.counters.queuedDetails = 0
      probe.delay.enable()
    })

    const started = await chatPage.evaluate(() => (globalThis as { liveProgress?: number }).liveProgress ?? 0)
    const startSearch = (page: Page) => page.evaluate(() =>
      window.api.threads.searchStart({
        query: "no-match-project-history-pressure", scope: { kind: "all" }, limit: 1
      })
    )
    const [first, second] = await Promise.all([startSearch(chatPage), startSearch(secondWindow)])
    assert.notEqual(first.sessionId, second.sessionId)
    const assertCoverage = (coverage: typeof first.coverage, complete: boolean) => {
      assert.equal(coverage.failedThreads, 0)
      assert.equal(coverage.skippedRows, 0)
      if (coverage.pendingThreads) {
        assert.equal(coverage.pendingThreads, 1, "only the active ordinary chat may need an audit")
        assert.deepEqual(coverage.reasons, ["legacy-pending"])
        assert.equal(coverage.completeness, "partial")
      } else {
        assert.deepEqual(coverage.reasons, [])
        assert.equal(coverage.completeness, complete ? "complete" : "unknown")
      }
    }
    for (const reply of [first, second]) {
      assert.deepEqual(reply.results, [])
      assertCoverage(reply.coverage, false)
      assert(reply.nextCursor && reply.scanStatus === "running")
    }
    await chatPage.waitForFunction((before) =>
      ((globalThis as { liveProgress?: number }).liveProgress ?? 0) > before, started
    )
    await assert.rejects(
      secondWindow.evaluate((cursor) => window.api.threads.searchContinue(cursor), first.nextCursor!),
      /SEARCH_CURSOR_EXPIRED/
    )
    await secondWindow.evaluate((id) => window.api.threads.searchCancel(id), second.sessionId)
    await assert.rejects(
      secondWindow.evaluate((cursor) => window.api.threads.searchContinue(cursor), second.nextCursor!),
      /SEARCH_CURSOR_EXPIRED/
    )
    let completed = first
    while (completed.nextCursor) {
      completed = await chatPage.evaluate((cursor) => window.api.threads.searchContinue(cursor), completed.nextCursor)
      assert.equal(completed.sessionId, first.sessionId)
      assert.deepEqual(completed.results, [])
      assertCoverage(completed.coverage, completed.scanStatus === "complete")
    }
    assert.equal(completed.scanStatus, "complete")
    assert.equal(completed.scannedThreads, threadCount + 1)
    await chatPage.evaluate((id) => window.api.threads.searchCancel(id), first.sessionId)

    await secondWindow.evaluate(async ({ projectId, query, expected }) => {
      let reply = await window.api.threads.searchStart({
        query, scope: { kind: "project", projectId }, limit: 1
      })
      const { sessionId } = reply
      try {
        while (!reply.results.length && reply.nextCursor) {
          reply = await window.api.threads.searchContinue(reply.nextCursor)
        }
        const hit = reply.results[0]
        if (reply.coverage.reasons.length || hit?.threadId !== expected ||
            hit.route.kind !== "featureSession" || hit.route.projectId !== projectId) {
          throw new Error("Missing verified local Feature history under directory pressure")
        }
        const summary = await window.api.threads.searchSummary(hit)
        if (!summary?.searchReadOnly || !summary.navigationTicketId) {
          throw new Error("Offline Feature history should require a read-only navigation ticket")
        }
        await window.api.threads.searchCancelNavigation(summary.navigationTicketId)
      } finally {
        await window.api.threads.searchCancel(sessionId)
      }
    }, { projectId: missingDirectoryProjectId, query: projectProbeMarker(threadCount - 1, 9),
      expected: "perf-" + (threadCount - 1) })

    const pressure = await app.evaluate(() => {
      const { counters, delay } = (globalThis as {
        featurePressure?: {
          counters: { queuedDetails: number }
          delay: ReturnType<typeof import("node:perf_hooks")["monitorEventLoopDelay"]>
        }
      }).featurePressure!
      delay.disable()
      return { ...counters, mainP95Ms: delay.percentile(95) / 1e6, mainMaxMs: delay.max / 1e6 }
    })
    assert.equal(readFileSync(adapterLog, "utf8"), baselineAdapterLog)
    assert.equal(pressure.queuedDetails, 0)
    await assertLiveAuditOwnership(app, chatPage)
    console.log("Search pressure samples and adapter counters validated")
    assert(finishStream, "Local model must be streaming")
    finishStream()
    await waitForPersistedFixtureReply(app, chatPage)
    const progress = await chatPage.evaluate(() => (globalThis as { liveProgress?: number }).liveProgress ?? 0)
    assert(progress > started, "Normal chat must keep streaming while searching offline history")
    const report = {
      ...pressure, adapterStarts: 0, projects: threadCount, unknownFeatures: threadCount,
      missingProjectDirectories: threadCount - 1,
      independentWindows: 2, scannedThreads: completed.scannedThreads,
      chatEventsDuringSearch: progress - started
    }
    writeFileSync(join(artifactDir, "unknown-feature-pressure.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert(pressure.mainP95Ms <= 50 && pressure.mainMaxMs <= 100,
      "Main thread delay exceeded the interactive budget under unknown Feature pressure")
  } finally {
    await app.evaluate(() => {
      const probe = (globalThis as {
        featurePressure?: {
          originalSet: typeof Map.prototype.set
          delay: ReturnType<typeof import("node:perf_hooks")["monitorEventLoopDelay"]>
        }
      }).featurePressure!
      probe.delay.disable()
      Map.prototype.set = probe.originalSet
    })
    await secondWindow.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => console.log(`Artifacts: ${artifactDir}`))
