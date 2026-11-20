/** Real Electron search and normal chat performance. Build before running with tsx. */
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication } from "playwright"
import { sqliteRecoveryFamilyKey } from "../src/main/db/sqlite-recovery-family"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const rounds = Number(process.env.CMB_THREAD_SEARCH_PROBE_ROUNDS ?? 30)
const threadCount = Number(process.env.CMB_THREAD_SEARCH_PROBE_THREADS ?? 10000)
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

async function main() {
  assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 30)
  assert(Number.isSafeInteger(threadCount) && threadCount >= 12 && threadCount <= 10000)
  mkdirSync(checkpointDirectory, { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(dataRoot, "userinfo-models.json"), JSON.stringify({
    sapId: "localhost-fixture", userName: "Local fixture"
  }))

  let chunks = 0
  let finishStream: (() => void) | undefined
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

  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath: process.platform === "win32"
        ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(artifactDir, "electron")}`],
      cwd: root, env, timeout: 60000
    })
    const processPriority = await app.evaluate((_electron, aboveNormal) => {
      const os = process.getBuiltinModule("node:os") as typeof import("node:os")
      if (aboveNormal) os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
      return os.getPriority(process.pid)
    }, process.env.CMB_THREAD_SEARCH_PROBE_PRIORITY === "above-normal")
    const log = join(artifactDir, "electron.log")
    app.process().stdout?.on("data", (data) => appendFileSync(log, data))
    app.process().stderr?.on("data", (data) => appendFileSync(log, data))
    await app.context().route(/^https?:/, (route) => route.abort())
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
        fixtureWorkspace } = options
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
          thread.run(id, sequence, sequence, last ? title : `Fixture ${sequence}`,
            JSON.stringify({ workspacePath: fixtureWorkspace }))
          migration.run(id)
          for (let ordinal = 0; ordinal < 10; ordinal += 1) {
            const marker = ordinal === 0 && sequence === 0 ? oldest : last && ordinal === 9 ? newest : ""
            insert.run(id, String(ordinal), ordinal % 3 ? "assistant" : "user",
              JSON.stringify(`${payload} ${marker}`), ordinal, ordinal)
          }
          fs.writeFileSync(path.join(checkpointDirectory, `${id}.sqlite`), checkpointBytes)
          if ((sequence + 1) % 250 === 0 || sequence + 1 === threadCount) db.exec("COMMIT")
          if ((sequence + 1) % 1000 === 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        }
      } finally {
        db.close()
      }
    }, {
      databasePath: join(dataRoot, "cmbcoworkagent.sqlite"),
      template: join(artifactDir, "checkpoint-template.sqlite"),
      checkpointDirectory, threadCount, payload, oldest, newest, title, fixtureWorkspace
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
    await page.waitForFunction(() => ((globalThis as { liveProgress?: number }).liveProgress ?? 0) > 1)
    await page.evaluate(async ({ query, workspacePath }) => {
      const initial = await window.api.threads.searchStart({ query, workspacePath, limit: 1 })
      await window.api.threads.searchCancel(initial.sessionId)
    }, { query: title, workspacePath: fixtureWorkspace })
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
    const samples = await page.evaluate(async ({ rounds, cases, fixtureWorkspace }) => {
      const harness = globalThis as { liveProgress?: number }
      const progressBefore = harness.liveProgress ?? 0
      const records: Record<string, number[]> = {}
      for (const test of cases) {
        const samples = (records[test.query] = [])
        for (let iteration = 0; iteration < rounds; iteration += 1) {
          const started = performance.now()
          let page = await window.api.threads.searchStart({
            query: test.query, workspacePath: fixtureWorkspace, limit: 1
          })
          const sessionId = page.sessionId
          try {
            for (;;) {
              if (page.coverage.reasons.length) throw new Error(JSON.stringify(page.coverage))
              if (page.results.length || !page.nextCursor) break
              page = await window.api.threads.searchContinue(page.nextCursor)
            }
            const actual = page.results[0]?.threadId ?? null
            if (actual !== test.expected) throw new Error(`Expected ${test.expected}, got ${actual}`)
            samples.push(performance.now() - started)
          } finally {
            await window.api.threads.searchCancel(sessionId)
          }
        }
      }
      return { records, progress: (harness.liveProgress ?? 0) - progressBefore }
    }, {
      rounds,
      fixtureWorkspace,
      cases: [
        { query: title, expected: `perf-${threadCount - 1}` },
        { query: newest, expected: `perf-${threadCount - 1}` },
        { query: oldest, expected: "perf-0" },
        { query: absent, expected: null }
      ]
    })
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
    finishStream?.()
    await page.evaluate(() => (globalThis as { liveDone?: Promise<void> }).liveDone)
    const saved = await page.evaluate(async () => {
      const { liveThreadId } = globalThis as { liveThreadId: string }
      return JSON.stringify(await window.api.threads.getHistory(liveThreadId))
    })
    assert.match(saved, /THREAD_SEARCH_LIVE_ANSWER/)
    assert(samples.progress > 0 && chunks > 0, "Normal chat streamed during the search samples")
    assert.deepEqual(errors, [])
    const p95 = Object.fromEntries(Object.entries(samples.records).map(([query, measurements]) => [
      query, [...measurements].sort((a, b) => a - b)[Math.ceil(measurements.length * 0.95) - 1]
    ]))
    const report = { threadCount, messages: threadCount * 10, rounds, chunks, processPriority,
      chatEventsDuringSearch: samples.progress, p95, mainEventLoop: delay }
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert(p95[title] <= 1000 && p95[newest] <= 1000)
    assert(p95[oldest] <= 10000 && p95[absent] <= 10000)
    assert(delay.p95Ms <= 50 && delay.maxMs <= 100,
      `Main event loop p95=${delay.p95Ms.toFixed(1)} ms maximum=${delay.maxMs.toFixed(1)} ms`)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => console.log(`Artifacts: ${artifactDir}`))
