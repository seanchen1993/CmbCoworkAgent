import { app } from "electron"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFileSync } from "node:fs"
import {
  availableParallelism,
  constants,
  cpus,
  getPriority,
  platform,
  release,
  setPriority,
  totalmem
} from "node:os"
import { dirname, join } from "node:path"
import { monitorEventLoopDelay, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import type { Worker } from "node:worker_threads"
import createWorker from "../../src/main/thread-search/thread-search-worker?nodeWorker"
import type { SearchCommand, SearchReply } from "../../src/main/thread-search/protocol"
import { installThreadSearchSchema } from "../../src/main/thread-search/schema"
import { sqliteRecoveryFamilyKey } from "../../src/main/db/sqlite-recovery-family"

import {
  PROBE_PROJECT_ID,
  projectProbeCases,
  projectProbeMarker,
  projectProbeMetadata,
  projectProbeTitle,
  seedProbeProjects
} from "./project-thread-search-fixture"

type StartCommand = Extract<SearchCommand, { type: "start" }>
type LoopPhase = {
  phase: string
  scope?: StartCommand["request"]["scope"]
  case?: string
  iteration?: number
}

const mixedProjects = process.env.CMB_THREAD_SEARCH_PROBE_PROJECTS === "1"
const SEED = 1729
const TITLE_QUERY = "latest-title-unique"
const NEW_QUERY = "recent-message-unique"
const OLD_QUERY = "oldest-message-unique"
const NO_QUERY = "absent-string-unique"

function seedFixture(file: string, threadCount: number): number {
  const database = new DatabaseSync(file)
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER,
        metadata TEXT, title TEXT, status TEXT
      );
      CREATE INDEX idx_threads_updated_at ON threads(updated_at);
      CREATE TABLE thread_messages (
        thread_id TEXT, message_id TEXT, role TEXT, content_json TEXT,
        tool_calls_json TEXT, created_at INTEGER, ordinal INTEGER, reasoning TEXT,
        goal_id TEXT, active_window_id TEXT, provider_source_id TEXT, provider_occurrence INTEGER,
        PRIMARY KEY (thread_id, message_id)
      );
      CREATE INDEX idx_thread_messages_thread_order
        ON thread_messages(thread_id, ordinal, created_at);
      CREATE TABLE thread_message_fragment_states (
        thread_id TEXT, message_id TEXT, total_chars INTEGER, PRIMARY KEY(thread_id, message_id)
      );
      CREATE TABLE thread_goal_events (
        event_id INTEGER PRIMARY KEY, thread_id TEXT, goal_id TEXT, active_window_id TEXT,
        message TEXT, created_at INTEGER, transcript_message_id TEXT
      );
      CREATE INDEX idx_thread_goal_events_thread_id ON thread_goal_events(thread_id);
      CREATE TABLE legacy_checkpoint_transcript_migrations (
        thread_id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, status TEXT NOT NULL, source_key TEXT,
        search_projection_state TEXT
      );
      CREATE TABLE thread_message_fragments (
        fragment_id INTEGER PRIMARY KEY, thread_id TEXT, message_id TEXT, content_text TEXT
      );
      CREATE INDEX idx_thread_message_fragments_message
        ON thread_message_fragments(thread_id, message_id, fragment_id);
    `)
    installThreadSearchSchema({ run: (sql) => database.exec(sql) }, (table, column) =>
      database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column))
    database.exec("BEGIN")
    const insertThread = database.prepare("INSERT INTO threads(thread_id, created_at, updated_at, metadata, title) VALUES (?, ?, ?, ?, ?)")
    const migrated = database.prepare(
      "INSERT INTO legacy_checkpoint_transcript_migrations VALUES (?, 'original', 'complete', NULL, 'complete')"
    )
    const insertMessage = database.prepare(
      `INSERT INTO thread_messages(thread_id, message_id, role, content_json, tool_calls_json, created_at, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const insertFragment = database.prepare(
      "INSERT INTO thread_message_fragments(thread_id, message_id, content_text) VALUES (?, ?, ?)"
    )
    const insertState = database.prepare(
      "INSERT INTO thread_message_fragment_states VALUES (?, ?, ?)"
    )
    const paragraph =
      "The build records the resulting state so the next run can resume from the saved checkpoint. "
    const markdown =
      "# Review notes\n\n**Result** [reference](docs/details.md?view=1&mode=docs)\n\n" +
      "```sh\nnpm run lint && npm test\n```\n\n"
    const tool = JSON.stringify([{ name: "read_file", args: { file_path: "notes.txt" } }])
    let bytes = 0
    let state = SEED
    for (let thread = 0; thread < threadCount; thread += 1) {
      const id = String(thread)
      const isNewest = thread === threadCount - 1
      const title = mixedProjects ? projectProbeTitle(thread)
        : isNewest ? TITLE_QUERY : `Conversation ${thread}`
      const metadata = JSON.stringify({
        workspacePath: thread % 3 === 0 ? null : "C:/fixture",
        source: thread % 3 === 1 ? "inbox" : "manual",
        ...(mixedProjects && projectProbeMetadata(thread, threadCount, true))
      })
      insertThread.run(id, thread, thread, metadata, title)
      migrated.run(id)
      for (let ordinal = 0; ordinal < 10; ordinal += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        const role = ordinal % 3 === 0 ? "user" : "assistant"
        const prefix = role === "assistant" ? markdown : ""
        const marker =
          mixedProjects ? projectProbeMarker(thread, ordinal) :
          thread === 0 && ordinal === 0 ? OLD_QUERY : isNewest && ordinal === 9 ? NEW_QUERY : ""
        const text = prefix + paragraph.repeat(28) + `\nRecord ${state}. ${marker}`
        const fragmented = ordinal === 8 || marker.length > 0
        const split = marker ? text.length - 5 : Math.floor(text.length / 2)
        const stored = fragmented ? text.slice(0, split) : text
        const tail = fragmented ? text.slice(split) : ""
        const content = ordinal === 5 ? [{ type: "text", text: stored }] : stored
        insertMessage.run(
          id,
          String(ordinal),
          role,
          JSON.stringify(content),
          ordinal === 5 ? tool : null,
          ordinal,
          ordinal
        )
        if (tail) {
          insertFragment.run(id, String(ordinal), tail)
          insertState.run(id, String(ordinal), tail.length)
        }
        bytes += Buffer.byteLength(text)
      }
    }
    // The disposable bulk seed needs only one copy of the database on disk.
    // All measured reads and concurrent writes run against WAL afterward.
    database.exec("COMMIT")
    assert.equal(database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode, "wal")
    return bytes
  } finally {
    database.close()
  }
}

function seedCompletedCheckpointFiles(file: string, threads: number) {
  const directory = dirname(file)
  const template = join(directory, "checkpoint-template.db")
  const database = new DatabaseSync(template)
  try {
    database.exec(`
      PRAGMA page_size = 1024;
      CREATE TABLE checkpoints (
        thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, type TEXT, checkpoint TEXT,
        PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
      );
      INSERT INTO checkpoints VALUES ('fixture', '', 'later', 'json', '{}');
    `)
  } finally {
    database.close()
  }
  const messages = new DatabaseSync(file)
  try {
    const verify = messages.prepare(`UPDATE legacy_checkpoint_transcript_migrations
      SET source_key = ? WHERE thread_id = ?`)
    messages.exec("BEGIN")
    for (let index = 0; index < threads; index += 1) {
      const filename = `${index}.sqlite`
      const path = join(directory, filename)
      copyFileSync(template, path)
      verify.run(sqliteRecoveryFamilyKey(path, new Set([filename])), String(index))
    }
    messages.exec("COMMIT")
  } finally {
    messages.close()
  }
}

function seedExtremeHistory(file: string) {
  seedFixture(file, 0)
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      BEGIN;
      INSERT INTO threads(thread_id, created_at, updated_at, metadata, title) VALUES ('long-history', 1, 2, '{}', 'Long conversation'),
        ('old-checkpoint', 1, 1, '{}', 'Legacy conversation');
      INSERT INTO legacy_checkpoint_transcript_migrations
        VALUES ('long-history', 'original', 'complete', NULL, 'complete');
    `)
    const message = db.prepare(`
      INSERT INTO thread_messages (thread_id,message_id,role,content_json,created_at,ordinal,goal_id)
      VALUES ('long-history', ?, ?, ?, ?, ?, ?)`)
    for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
      const text = ordinal === 0 ? "oldest in long conversation" :
        "Historical message with ordinary visible text. ".repeat(30)
      message.run(String(ordinal), "assistant", JSON.stringify(text), ordinal, ordinal, null)
    }
    const nearLimit = "admitted-large-row " + "a".repeat(512 * 1024 - 2048)
    message.run("near", "assistant", JSON.stringify(nearLimit), 10000, 10000, null)
    const oversized = "unread-oversized-row " + "b".repeat(512 * 1024 + 2048)
    message.run("oversized", "assistant", JSON.stringify(oversized), 10001, 10001, null)
    message.run("goal-anchor", "user", JSON.stringify(
      "[Starting active goal]\n<untrusted_objective>internal anchor</untrusted_objective>"
    ), 10002, 10002, "goal-fixture")
    db.exec(`
      INSERT INTO thread_goal_events(thread_id,goal_id,message,created_at,transcript_message_id)
      VALUES ('long-history','goal-fixture','__cmb_goal_user_message__:/goal extreme-goal-event',10002,'goal-anchor');
      COMMIT;
    `)
  } finally {
    db.close()
  }
  const checkpoint = new DatabaseSync(join(dirname(file), "old-checkpoint.sqlite"))
  try {
    checkpoint.exec(`
      CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT,
        type TEXT, checkpoint TEXT, PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
      INSERT INTO checkpoints VALUES ('old-checkpoint', '', 'old', 'json',
        '{"id":"old","channel_values":{"messages":[{"type":"human","id":"legacy","content":"legacy-history-marker"}]}}');
    `)
  } finally {
    checkpoint.close()
  }
}

interface ProbeReply {
  hit: string | null
  scanned: number
  cancelled: boolean
  ms: number
  reasons: string[]
  route?: string
}

function queryWorker(
  worker: Worker,
  query: string,
  cancel: boolean | "directory" = false,
  allowedReasons: string[] = [],
  scope?: StartCommand["request"]["scope"],
  catalog?: StartCommand["catalog"],
  started = performance.now()
) {
  const id = randomUUID()
  const cancellation = new SharedArrayBuffer(4)
  return new Promise<ProbeReply>((resolve, reject) => {
    let cancelledAt: number | undefined
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    let cancelScheduled = false
    const requestCancellation = () => {
      cancelledAt = performance.now()
      Atomics.store(new Int32Array(cancellation), 0, 1)
    }
    const timer = setTimeout(() => finish(new Error("Search probe timed out")), 120_000)
    function onMessage(message: { id?: string; reply?: SearchReply }) {
      const reply = message.reply
      if (message.id !== id || !reply) return
      if ("error" in reply) {
        finish(new Error(reply.error))
        return
      }
      try {
        assert(Buffer.byteLength(JSON.stringify(reply)) <= 128 * 1024)
        assert(reply.coverage.reasons.every((reason) => allowedReasons.includes(reason)),
          JSON.stringify(reply.coverage))
      } catch (error) {
        finish(error as Error)
        return
      }
      const hit = reply.results[0]?.threadId ?? null
      if (hit || !reply.nextCursor) {
        finish(null, {
          hit,
          scanned: reply.scannedThreads,
          cancelled: reply.scanStatus === "cancelled",
          ms: performance.now() - (cancelledAt ?? started),
          reasons: reply.coverage.reasons,
          route: reply.results[0]?.route?.kind
        })
        return
      }
      worker.postMessage({ type: "continue", id, cursor: reply.nextCursor } satisfies SearchCommand)
      if (cancel === true && !cancelScheduled) {
        cancelScheduled = true
        if (process.env.CMB_THREAD_SEARCH_PROBE_THREADS === "12") requestCancellation()
        else cancelTimer = setTimeout(requestCancellation, 3)
      }
    }
    function onExit(code: number) {
      finish(new Error(`Search worker exited with code ${code}`))
    }
    function finish(error: Error | null, reply?: ProbeReply) {
      clearTimeout(timer)
      clearTimeout(cancelTimer)
      worker.off("message", onMessage)
      worker.off("error", finish)
      worker.off("exit", onExit)
      if (worker.threadId !== -1) worker.postMessage({ type: "cancel", id } satisfies SearchCommand)
      if (error) reject(error)
      else if (reply) resolve(reply)
    }
    worker.on("message", onMessage)
    worker.once("error", finish)
    worker.once("exit", onExit)
    worker.postMessage({
      type: "start",
      id,
      request: { query, limit: 1, scope },
      catalog,
      cancellation
    } satisfies SearchCommand)
    if (cancel === "directory") {
      if (Number(process.env.CMB_THREAD_SEARCH_PROBE_THREADS) < 1000) requestCancellation()
      else cancelTimer = setTimeout(requestCancellation, 0)
    }
  })
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10
}

async function closeWorker(worker: Worker) {
  if (worker.threadId === -1) return
  const done = once(worker, "exit")
  const deadline = setTimeout(() => void worker.terminate(), 5000)
  try {
    worker.postMessage({ type: "shutdown" } satisfies SearchCommand)
    assert.deepEqual(await done, [0])
  } finally {
    clearTimeout(deadline)
  }
}

function openSearchWorker(file: string) {
  const worker = createWorker({
    name: "thread-search-probe",
    workerData: { databasePath: file, checkpointDirectory: dirname(file) },
    resourceLimits: { maxOldGenerationSizeMb: 256 }
  })
  worker.on("error", (error) => console.error("[ThreadSearchProbe] Worker failed", error))
  return worker
}

async function runExtremeHistory(file: string, rounds: number) {
  seedExtremeHistory(file)
  const worker = openSearchWorker(file)
  const allowed = ["oversized-row", "projection-truncated", "legacy-pending"]
  try {
    for (const test of [
      { query: "oldest in long conversation", hit: "long-history", reasons: allowed.slice(0, 2) },
      { query: "admitted-large-row", hit: "long-history", reasons: allowed.slice(0, 2) },
      { query: "extreme-goal-event", hit: "long-history", reasons: allowed.slice(0, 2) },
      { query: "unread-oversized-row", hit: null, reasons: allowed },
      { query: "legacy-history-marker", hit: null, reasons: allowed }
    ]) {
      const hot: number[] = []
      const cold: number[] = []
      const measure = async (instance: Worker) => {
        const reply = await queryWorker(instance, test.query, false, allowed)
        assert.equal(reply.hit, test.hit)
        for (const reason of test.reasons) assert(reply.reasons.includes(reason), test.query)
        return reply.ms
      }
      for (let iteration = 0; iteration < rounds; iteration += 1) {
        hot.push(await measure(worker))
        const fresh = openSearchWorker(file)
        try {
          cold.push(await measure(fresh))
        } finally {
          await closeWorker(fresh)
        }
      }
      const hotP95 = p95(hot)
      const coldP95 = p95(cold)
      assert(hotP95 <= 10_000 && coldP95 <= 20_000, test.query)
      console.log(JSON.stringify({ fixture: "extreme", case: test.query, rounds, hotP95, coldP95 }))
    }
  } finally {
    await closeWorker(worker)
  }
}

async function main(file: string) {
  const threads = Number(process.env.CMB_THREAD_SEARCH_PROBE_THREADS ?? 10_000)
  const rounds = Number(process.env.CMB_THREAD_SEARCH_PROBE_ROUNDS ?? 30)
  assert(Number.isSafeInteger(threads) && threads > 1 && threads <= 10_000)
  assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 30)
  if (process.env.CMB_THREAD_SEARCH_PROBE_EXTREME === "1") {
    await runExtremeHistory(file, rounds)
    return
  }
  if (mixedProjects) {
    assert(threads >= 6)
    assert.notEqual(process.env.CMB_THREAD_SEARCH_PROBE_WRITES, "1")
  }
  const registry = mixedProjects
    ? seedProbeProjects(dirname(file), dirname(file), 2048, PROBE_PROJECT_ID)
    : undefined
  const catalog: StartCommand["catalog"] = registry && {
    generation: "project-probe-v1",
    projects: registry.projects
  }
  const bytes = seedFixture(file, threads)
  seedCompletedCheckpointFiles(file, threads)
  const concurrentWrites = process.env.CMB_THREAD_SEARCH_PROBE_WRITES === "1"
  const writer = concurrentWrites ? new DatabaseSync(file) : null
  // The writer uses the same SQLite file but a project thread outside the search scope.
  // This exercises concurrent commits while keeping expected search hits deterministic.
  writer?.exec(`
    PRAGMA synchronous = NORMAL;
    INSERT INTO threads(thread_id, created_at, updated_at, metadata, title) VALUES (
      'probe-writer', 0, 0, '{"harnessProjectSession":{"projectId":"probe","kind":"build"}}', NULL
    );
    INSERT INTO thread_messages(thread_id, message_id, role, content_json, created_at, ordinal) VALUES (
      'probe-writer', 'live', 'assistant', '"Initial reply"', 0, 0
    );
  `)
  const update = writer?.prepare(`
    UPDATE thread_messages SET content_json = ?
    WHERE thread_id = 'probe-writer' AND message_id = 'live'`)
  let commits = 0
  let longestWriterCommitMs = 0
  const suffix = "streamed content ".repeat(200)
  const writeTimer = update
    ? setInterval(() => {
        const started = performance.now()
        update.run(JSON.stringify(++commits + suffix))
        longestWriterCommitMs = Math.max(longestWriterCommitMs, performance.now() - started)
      }, 25)
    : undefined
  const performanceFailures: string[] = []
  const delay = monitorEventLoopDelay({ resolution: 10 })
  const diagnoseLoop = process.env.CMB_THREAD_SEARCH_PROBE_DELAY_DIAGNOSTICS === "1"
  const loopMaxIncreases: Array<LoopPhase & { observedAtMs: number; maxNs: number }> = []
  let phase: LoopPhase = { phase: "benchmark-setup" }
  let observedMax = 0
  const markLoopPhase = diagnoseLoop ? (next: LoopPhase) => {
    const maxNs = delay.max
    // Sample the accumulated histogram at phase boundaries without resetting it.
    if (maxNs > observedMax) {
      observedMax = maxNs
      loopMaxIncreases.push({ ...phase, observedAtMs: performance.now(), maxNs })
    }
    phase = next
  } : undefined
  const mainGc = { count: 0, totalMs: 0, maxMs: 0, maxStartedAtMs: 0 }
  const recordGc = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      mainGc.count += 1
      mainGc.totalMs += entry.duration
      if (entry.duration > mainGc.maxMs) {
        mainGc.maxMs = entry.duration
        mainGc.maxStartedAtMs = entry.startTime
      }
    }
  }
  const gcObserver = diagnoseLoop
    ? new PerformanceObserver((list) => recordGc(list.getEntries()))
    : null
  gcObserver?.observe({ entryTypes: ["gc"] })
  delay.enable()
  const baselineRss = process.memoryUsage.rss()
  let peakRss = baselineRss
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss())
  }, 25)
  const startWorker = () => openSearchWorker(file)

  const cases = mixedProjects
    ? projectProbeCases(threads, true).map((test) => ({
      ...test, expected: test.expectedIndex === null ? null : String(test.expectedIndex)
    }))
    : [
    { label: "title", query: TITLE_QUERY, expected: String(threads - 1), hot: 1000, cold: 2000 },
    { label: "recent", query: NEW_QUERY, expected: String(threads - 1), hot: 1000, cold: 2000 },
    { label: "oldest", query: OLD_QUERY, expected: "0", hot: 10_000, cold: 20_000 },
    { label: "noMatch", query: NO_QUERY, expected: null, hot: 10_000, cold: 20_000 },
    { label: "noMatchCommonPhrase", query: "saved build", expected: null, hot: 10_000, cold: 20_000 },
    { label: "noMatchChinese", query: "不存在", expected: null, hot: 10_000, cold: 20_000 }
  ].map((test) => ({ ...test, expectedCandidates: threads, scope: undefined }))
  console.log(
    JSON.stringify({
      threads,
      messages: threads * 10,
      visibleSourceMiB: bytes / 1024 ** 2,
      completedCheckpointFiles: threads,
      rounds,
      concurrentWrites,
      mixedProjects,
      offlineFeatureHistory: mixedProjects,
      catalogProjects: catalog?.projects.size,
      catalogBytes: registry?.bytes,
      seed: SEED,
      cpu: cpus()[0]?.model,
      logicalCpus: availableParallelism(),
      processPriority: getPriority(),
      memoryGiB: totalmem() / 1024 ** 3,
      os: `${platform()} ${release()}`,
      node: process.versions.node,
      electron: process.versions.electron,
      sqlite: process.versions.sqlite
    })
  )

  const warm = startWorker()
  try {
    const firstCase = cases[0]
    markLoopPhase?.({ phase: "warmup", scope: firstCase.scope, case: firstCase.label })
    const warmup = await queryWorker(warm, firstCase.query, false, [], firstCase.scope, catalog)
    assert.equal(warmup.hit, firstCase.expected)
    for (const test of cases) {
      const hot: number[] = []
      const cold: number[] = []
      let scanned = 0
      for (let iteration = 0; iteration < rounds; iteration += 1) {
        markLoopPhase?.({
          phase: "hot-query", scope: test.scope, case: test.label, iteration: iteration + 1
        })
        const hotReply = await queryWorker(warm, test.query, false, [], test.scope, catalog)
        assert.equal(hotReply.hit, test.expected)
        if (mixedProjects && test.expected === String(threads - 2)) {
          assert.equal(hotReply.route, "featureSession")
        }
        hot.push(hotReply.ms)
        scanned = hotReply.scanned
        if (test.label === "oldest" || test.expected === null) {
          assert.equal(scanned, test.expectedCandidates)
        }
        markLoopPhase?.({
          phase: "cold-query", scope: test.scope, case: test.label, iteration: iteration + 1
        })
        const coldStartedAt = performance.now()
        const fresh = startWorker()
        try {
          const coldReply = await queryWorker(
            fresh, test.query, false, [], test.scope, catalog, coldStartedAt
          )
          assert.equal(coldReply.hit, test.expected)
          assert.equal(coldReply.scanned, scanned)
          assert.equal(coldReply.route, hotReply.route)
          cold.push(coldReply.ms)
        } finally {
          markLoopPhase?.({
            phase: "cold-worker-close", scope: test.scope, case: test.label, iteration: iteration + 1
          })
          await closeWorker(fresh)
        }
      }
      markLoopPhase?.({ phase: "case-summary", scope: test.scope, case: test.label })
      const hotP95 = p95(hot)
      const coldP95 = p95(cold)
      if (hotP95 > test.hot) performanceFailures.push(`${test.label} hot ${hotP95} ms`)
      if (coldP95 > test.cold) performanceFailures.push(`${test.label} cold ${coldP95} ms`)
      console.log(
        JSON.stringify({
          scope: test.scope ?? { kind: "ordinary" },
          case: test.label,
          candidates: test.expectedCandidates,
          scanned,
          hotP95,
          coldP95,
          hotWithinTarget: hotP95 <= test.hot,
          coldWithinTarget: coldP95 <= test.cold
        })
      )
    }
    const cancelCase = cases.find(({ scope, label }) =>
      (!mixedProjects || scope?.kind === "all") && label === "noMatch")!
    const cancelled = []
    for (let iteration = 0; iteration < rounds; iteration += 1) {
      markLoopPhase?.({
        phase: "cancel", scope: cancelCase.scope, case: cancelCase.label, iteration: iteration + 1
      })
      const reply = await queryWorker(warm, cancelCase.query, true, [], cancelCase.scope, catalog)
      assert(reply.cancelled)
      cancelled.push(reply.ms)
    }
    const cancelP95 = p95(cancelled)
    if (cancelP95 > 200) performanceFailures.push(`cancel ${cancelP95} ms`)
    console.log(JSON.stringify({ case: "cancel", p95: cancelP95 }))
    if (mixedProjects) {
      const empty = cases.at(-1)!
      const directoryInterrupts = []
      for (let iteration = 0; iteration < rounds; iteration += 1) {
        markLoopPhase?.({
          phase: "directory-cancel", scope: empty.scope, case: empty.label, iteration: iteration + 1
        })
        const reply = await queryWorker(warm, empty.query, "directory", [], empty.scope, catalog)
        assert(reply.cancelled)
        directoryInterrupts.push(reply.ms)
      }
      const directoryCancelP95 = p95(directoryInterrupts)
      if (directoryCancelP95 > 200) {
        performanceFailures.push("directory cancel " + directoryCancelP95 + " ms")
      }
      console.log(JSON.stringify({ case: "directory-cancel", p95: directoryCancelP95 }))
    }
  } finally {
    if (writeTimer) clearInterval(writeTimer)
    clearInterval(rssTimer)
    markLoopPhase?.({ phase: "benchmark-end" })
    delay.disable()
    if (gcObserver) {
      recordGc(gcObserver.takeRecords())
      gcObserver.disconnect()
    }
    writer?.close()
    await closeWorker(warm)
  }
  const mainLoopP95Ns = delay.percentile(95)
  const mainLoopMaxNs = delay.max
  const mainLoopP95 = Math.round(mainLoopP95Ns / 100_000) / 10
  const mainLoopMax = Math.round(mainLoopMaxNs / 100_000) / 10
  const rssGrowthMiB = Math.round((peakRss - baselineRss) / 1024 ** 2)
  if (mainLoopP95 > 50) performanceFailures.push(`main-loop p95 ${mainLoopP95} ms`)
  if (mainLoopMax > 100) performanceFailures.push(`main-loop maximum ${mainLoopMax} ms`)
  if (rssGrowthMiB > 384) performanceFailures.push(`process RSS growth ${rssGrowthMiB} MiB`)
  if (concurrentWrites) assert(commits > 0)
  console.log(JSON.stringify({ mainLoopP95, mainLoopMax, rssGrowthMiB, commits, longestWriterCommitMs }))
  if (diagnoseLoop) {
    console.log(JSON.stringify({ mainLoopP95Ns, mainLoopMaxNs, loopMaxIncreases, mainGc }))
  }
  assert.deepEqual(performanceFailures, [], "Thread search performance thresholds")
}

const fixturePath = process.env.CMB_THREAD_SEARCH_PROBE_DB
assert(fixturePath)
if (process.env.CMB_THREAD_SEARCH_PROBE_PRIORITY === "above-normal") {
  setPriority(constants.priority.PRIORITY_ABOVE_NORMAL)
}
app.setPath("userData", dirname(fixturePath))
app
  .whenReady()
  .then(() => main(fixturePath))
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
