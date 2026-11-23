/** Synthetic, local performance probes against production Bot code. No model/network calls.
 * Run: node --import tsx tests/bot-performance-review.spec.ts
 * Seeding uses prepared inserts cloned from valid API rows; seed time is excluded.
 * Timings are observations, not machine-specific pass/fail thresholds. */
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { performance } from "node:perf_hooks"
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises"
import { tmpdir, platform, arch, cpus } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { BotStore } from "../src/main/bots/store"
import { LocalBotHost } from "../src/main/bots/host"
import { BotMemoryService } from "../src/main/bots/memory"
import { buildBotMemoryPrompt } from "../src/main/bots/prompt"
import { snapshotBotDeliveryFile } from "../src/main/bots/file-copy"
import { deliverBotImFile } from "../src/main/services/im/bot-file-delivery"
import { BOT_IM_FILE_CHUNK_BYTES } from "../src/shared/bots/im-file"
import type { BotImFileCommand, BotImFileResult } from "../src/shared/bots/im-file"
import { BotTelemetryReporter } from "../src/main/bots/telemetry-reporter"
import { buildBotMetricsQuery } from "../src/main/ipc/dashboard-bot-metrics"

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const round = (n: number) => Math.round(n * 1000) / 1000
const report: any = {
  kind: "local-synthetic-performance",
  model: null,
  network: "simulated RTT only",
  recordedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  cases: []
}
function measure(name: string, operation: () => unknown, repeats = 9) {
  operation()
  const ms: number[] = []
  let result: any
  for (let i = 0; i < repeats; i++) {
    const start = performance.now()
    result = operation()
    ms.push(performance.now() - start)
  }
  const sorted = [...ms].sort((a, b) => a - b)
  return {
    name,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    samplesMs: ms.map(round),
    outputBytes: Buffer.byteLength(JSON.stringify(result) ?? ""),
    result
  }
}
function recorded(item: any) {
  report.cases.push(item)
  console.log("PERF_CASE", JSON.stringify(item))
}
function fixture(path = ":memory:") {
  const native = new DatabaseSync(path)
  if (path !== ":memory:") native.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL")
  const db = new NativeSqliteAdapter(native)
  const store = new BotStore(db)
  const bot = store.create({
    name: "Synthetic owner",
    instructions: "",
    color: "#123456",
    modelRef: null
  })
  return { native, db, store, bot }
}
function cloneWriter(
  native: DatabaseSync,
  table: string,
  seed: Record<string, any>,
  omitted: string[] = []
) {
  const keys = Object.keys(seed).filter((key) => !omitted.includes(key))
  const statement = native.prepare(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`
  )
  return (changes: Record<string, any>) =>
    statement.run(...keys.map((key) => (key in changes ? changes[key] : seed[key])))
}

async function databaseCases(history: number, workCount: number, commands = 0) {
  const f = fixture()
  try {
    const created = f.store.createWork({
      botId: f.bot.id,
      operationId: "seed",
      title: "Work seed",
      goal: "Synthetic review"
    })
    f.store.transition(created.task.id, "running")
    f.store.settle(created.task.id, "completed", null, "Synthetic result")
    const taskRow = f.native.prepare("SELECT * FROM bot_tasks WHERE id=?").get(created.task.id)!
    const workRow = f.native
      .prepare("SELECT * FROM bot_work_items WHERE id=?")
      .get(created.work.id)!
    const activityRow = f.native
      .prepare("SELECT * FROM bot_activity WHERE kind='work' AND id=?")
      .get(created.work.id)!
    const insertTask = cloneWriter(f.native, "bot_tasks", taskRow)
    const insertWork = cloneWriter(f.native, "bot_work_items", workRow, ["ordinal"])
    const insertActivity = cloneWriter(f.native, "bot_activity", activityRow)
    f.native.exec("BEGIN")
    for (let i = 1; i < workCount; i++) {
      insertWork({ id: `w-${i}`, thread_id: `tw-${i}`, title: `Work ${i}` })
      insertTask({
        id: `work-task-${i}`,
        request_id: `work-request-${i}`,
        work_id: `w-${i}`,
        thread_id: `tw-${i}`,
        origin_json: JSON.stringify({ kind: "work", workId: `w-${i}` })
      })
      insertActivity({
        id: `w-${i}`,
        seen_version: Number(activityRow.attention_version),
        version: i + 1
      })
    }
    for (let i = 0; i < history; i++)
      insertTask({
        id: `history-${i}`,
        request_id: `hr-${i}`,
        work_id: null,
        thread_id: f.bot.threadId,
        origin_json: '{"kind":"user"}',
        message: "Synthetic previous conversation"
      })
    for (let i = 0; i < commands; i++) {
      f.native
        .prepare(
          "INSERT INTO bot_commands(id,bot_id,thread_id,source_task_id,command,cwd,started_at,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
        )
        .run(
          `cmd-${i}`,
          f.bot.id,
          f.bot.threadId,
          `history-${i}`,
          "synthetic",
          "/fixture",
          1,
          "accepted",
          1
        )
    }
    f.native.exec("COMMIT")
    const labels = { history, works: workCount, commands }
    const measurements = [
      ["recent_tasks", () => f.store.recentTasks(true)],
      ["work_list", () => f.store.listWorks(f.bot.id, undefined, "", "desktop")],
      ["work_detail", () => f.store.getWork(f.bot.id, created.work.id)],
      ["work_activity", () => f.store.workActivities()],
      ["collaboration_threads", () => f.store.stoppableCollaborationThreads()],
      ["empty_queue_selection", () => f.store.nextQueued([])],
      ["telemetry_due", () => f.store.telemetry.due(Date.now())]
    ] as const
    for (const [name, operation] of measurements) {
      const sampled = measure(name, operation)
      const queries: Array<{ sql: string; bindings: any }> = []
      const original = f.db.prepare.bind(f.db)
      f.db.prepare = ((sql: string, bindings?: any) => {
        queries.push({ sql, bindings })
        return original(sql, bindings)
      }) as typeof f.db.prepare
      operation()
      f.db.prepare = original
      const { result, ...metrics } = sampled
      if (name === "recent_tasks") assert.equal(result.length, Math.min(100, history + workCount))
      if (name === "work_list") assert.equal(result.items.length, Math.min(40, workCount))
      if (name === "telemetry_due") assert.ok(result.length <= 20)
      recorded({
        ...labels,
        ...metrics,
        queryCount: queries.length,
        plans: queries.map(({ sql, bindings }) => ({
          sql,
          plan: f.db.exec(`EXPLAIN QUERY PLAN ${sql}`, bindings)[0]?.values.map((row) => row[3])
        }))
      })
      if (
        name === "work_list" &&
        queries.some((q) => q.sql.includes("(? IS NULL OR w.audience_key=?)"))
      ) {
        // Historical query-only counterfactual; production SQL/schema remain unchanged.
        const query = queries.find((q) => q.sql.includes("w.ordinal<?"))!
        const exactSQL = query.sql.replace("(? IS NULL OR w.audience_key=?)", "w.audience_key=?")
        const exactBindings = [query.bindings[0], ...query.bindings.slice(2)]
        const current = measure("optional_audience_sql", () => f.db.exec(query.sql, query.bindings))
        const exact = measure("exact_audience_sql_counterfactual", () =>
          f.db.exec(exactSQL, exactBindings)
        )
        assert.deepEqual(exact.result, current.result)
        recorded({
          ...labels,
          name: "audience_predicate_counterfactual",
          currentMedianMs: current.medianMs,
          exactMedianMs: exact.medianMs,
          currentSamplesMs: current.samplesMs,
          exactSamplesMs: exact.samplesMs,
          equivalent: true,
          exactPlan: f.db
            .exec(`EXPLAIN QUERY PLAN ${exactSQL}`, exactBindings)[0]
            ?.values.map((row) => row[3])
        })
      }
    }
    // Exhaust the keyset cursor once; retained metadata must not be lost to a cap.
    let cursor: string | undefined
    const ids = new Set<string>(),
      cursors = new Set<string>()
    const start = performance.now()
    do {
      const page = f.store.listWorks(f.bot.id, cursor, "", "desktop")
      for (const work of page.items) {
        assert.ok(!ids.has(work.id))
        ids.add(work.id)
      }
      cursor = page.nextCursor ?? undefined
      if (cursor) {
        assert.ok(!cursors.has(cursor))
        cursors.add(cursor)
      }
    } while (cursor)
    assert.equal(ids.size, workCount)
    recorded({
      ...labels,
      name: "full_keyset_pagination",
      pages: cursors.size + 1,
      items: ids.size,
      elapsedMs: round(performance.now() - start)
    })
    // Whole snapshot uses real production host projections, with execution intentionally disabled.
    const host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null })
    await delay(0)
    const snapshot = measure("host_snapshot", () => host.snapshot())
    recorded({ ...labels, ...snapshot, result: undefined })
    await host.stop()
    // Retention runs synchronously in an idle host pump. Eligible history is >30 days old.
    f.native
      .prepare("UPDATE bot_tasks SET updated_at=? WHERE work_id IS NULL")
      .run(Date.now() - 40 * 86400000)
    const retainedBefore = Number(f.native.prepare("SELECT count(*) n FROM bot_tasks").get()!.n)
    const started = performance.now()
    const timer = delay(0).then(() => performance.now() - started)
    const pruned = f.store.pruneTaskHistory()
    const blockingMs = performance.now() - started
    assert.ok(pruned <= 100)
    assert.equal(
      Number(f.native.prepare("SELECT count(*) n FROM bot_tasks").get()!.n),
      retainedBefore - pruned
    )
    recorded({
      ...labels,
      name: "idle_retention",
      pruned,
      elapsedMs: round(blockingMs),
      timerDelayMs: round(await timer)
    })
  } finally {
    f.db.close()
  }
}

async function concurrencyCase(workCount: number) {
  const f = fixture()
  let active = 0,
    peak = 0,
    acquired = 0,
    released = 0,
    acquiredWork = 0,
    startedWork = 0,
    lastWorkStartedAt = 0,
    timerScheduledAt = 0,
    mainSentAt = 0,
    mainStartedAt = 0,
    mainStartedWith = 0,
    mainArrivedWith = 0,
    steadyMainAt = 0,
    admissionTicks = 0,
    lastTickAt = 0,
    maxAdmissionTickGapMs = 0
  let mainTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const finish = new Map<string, () => void>()
  const errors: unknown[] = []
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 20_000
    while (!condition()) {
      if (performance.now() >= deadline) {
        const state = host as unknown as { scheduled: boolean; admissionExcluded?: Set<string>; faulted: boolean }
        assert.fail("scheduler did not finish the entire workload: " + JSON.stringify({
          workCount, active, startedWork, scheduled: state.scheduled, faulted: state.faulted,
          excludedThreads: state.admissionExcluded?.size ?? 0,
          states: f.native.prepare("SELECT state,work_id IS NOT NULL AS isWork,COUNT(*) AS n FROM bot_tasks GROUP BY state,isWork").all(),
          errors: errors.map(error => String(error))
        }))
      }
      await delay(1)
    }
  }
  const host = new LocalBotHost(
    f.store,
    {
      onAvailable: () => () => {},
      acquire: (_bot, task) => {
        acquired++
        active++
        peak = Math.max(peak, active)
        if (task.workId && ++acquiredWork === 1) {
          // Arrive from the event loop while admission is still in progress, not after it.
          timerScheduledAt = performance.now()
          mainTimer = setTimeout(() => {
            mainArrivedWith = acquiredWork
            mainSentAt = performance.now()
            host.send({ botId: f.bot.id, requestId: "during-admission", message: "hello" })
          }, 0)
        }
        return {
          release() {
            active--
            released++
          },
          async execute(signal) {
            if (task.workId) {
              startedWork++
              lastWorkStartedAt = performance.now()
              await new Promise<void>((resolve) => {
                finish.set(task.id, resolve)
                if (signal.aborted) resolve()
                else signal.addEventListener("abort", () => resolve(), { once: true })
              })
            } else if (task.requestId === "during-admission") {
              mainStartedAt = performance.now()
              mainStartedWith = acquiredWork
            } else if (task.requestId === "steady-ping") steadyMainAt = performance.now()
            return { state: "completed" as const, result: "(pass)" }
          }
        }
      }
    },
    Number.POSITIVE_INFINITY,
    (error) => errors.push(error)
  )
  try {
    const workTasks: string[] = []
    for (let i = 0; i < workCount; i++)
      workTasks.push(f.store.createWork({
        botId: f.bot.id,
        operationId: `job-${i}`,
        title: `Job ${i}`,
        goal: "Synthetic background work"
      }).task.id)
    const started = performance.now()
    lastTickAt = started
    heartbeat = setInterval(() => {
      const now = performance.now()
      if (startedWork < workCount) {
        admissionTicks++
        maxAdmissionTickGapMs = Math.max(maxAdmissionTickGapMs, now - lastTickAt)
      }
      lastTickAt = now
    }, 1)
    host.resume()
    await until(() => startedWork === workCount && mainStartedAt > 0)
    clearInterval(heartbeat)
    const admissionMs = lastWorkStartedAt - started
    const backgroundActive = Number(f.native.prepare("SELECT COUNT(*) AS n FROM bot_tasks WHERE work_id IS NOT NULL AND state='running'").get()!.n)
    const queued = Number(f.native.prepare("SELECT COUNT(*) AS n FROM bot_tasks WHERE work_id IS NOT NULL AND state='queued'").get()!.n)
    assert.equal(backgroundActive, workCount, "every independent task must run; no admission cap")
    assert.equal(queued, 0)
    const mainAt = performance.now()
    host.send({ botId: f.bot.id, requestId: "steady-ping", message: "hello again" })
    await until(() => steadyMainAt > 0)
    // Every task is then allowed to complete, rather than counting queued work as throughput.
    const completionAt = performance.now()
    for (const done of finish.values()) done()
    await until(() => !host.hasActiveRuns() && f.store.nextQueued([]) === null)
    assert.ok(workTasks.every(id => f.store.getTask(id).state === "completed"))
    const completionMs = performance.now() - completionAt
    recorded({
      name: "host_concurrency",
      works: workCount,
      backgroundActive,
      configuredExecutionLimit: null,
      queued,
      completed: workCount,
      peak,
      admissionMs: round(admissionMs),
      mainSchedulingMs: round(steadyMainAt - mainAt),
      duringAdmission: {
        mainArrivedWith,
        mainStartedWith,
        timerArrivalMs: round(mainSentAt - timerScheduledAt),
        mainSchedulingMs: round(mainStartedAt - mainSentAt),
        timerToMainStartMs: round(mainStartedAt - timerScheduledAt),
        eventLoopTicks: admissionTicks,
        maxTickGapMs: round(maxAdmissionTickGapMs)
      },
      completionAndResultDrainMs: round(completionMs),
      model: "fake held leases, then release every work and drain results; no LLM requests"
    })
  } finally {
    clearTimeout(mainTimer)
    clearInterval(heartbeat)
    await host.stop()
    assert.equal(active, 0)
    assert.equal(released, acquired)
    assert.deepEqual(errors, [])
    f.db.close()
  }
}

async function diskCases(root: string) {
  const service = new BotMemoryService(root)
  const memoryDir = join(root, "memories", "memory-fixture")
  await mkdir(memoryDir, { recursive: true })
  for (const [count, repetitions] of [
    [20, 230],
    [200, 230],
    [200, 2600]
  ]) {
    for (let i = 0; i < count; i++)
      await writeFile(
        join(memoryDir, `fact-${i}.md`),
        `---\nname: Fact ${i}\nbot_scope: shared\n---\n${"Synthetic memory. ".repeat(repetitions)}`
      )
    const cold = new BotMemoryService(root)
    const coldAt = performance.now()
    buildBotMemoryPrompt(cold.forPrompt("memory-fixture"))
    const coldPreparationMs = round(performance.now() - coldAt)
    await cold.close()
    const read = measure("memory_prompt_read", () => service.forPrompt("memory-fixture"), 7)
    assert.equal(read.result.length, count)
    assert.equal(read.result[0].scope.kind, "shared")
    const prompt = measure("memory_prompt_build", () => buildBotMemoryPrompt(read.result), 7)
    const preparation = measure(
      "memory_prompt_full_preparation",
      () => buildBotMemoryPrompt(service.forPrompt("memory-fixture")),
      7
    )
    const at = performance.now(),
      timer = delay(0).then(() => performance.now() - at)
    service.forPrompt("memory-fixture")
    recorded({
      ...read,
      result: undefined,
      files: count,
      repetitions,
      totalContentChars: read.result.reduce((n: number, m: any) => n + m.content.length, 0),
      coldPreparationMs,
      promptBytes: prompt.outputBytes,
      promptBuildMs: prompt.medianMs,
      fullPreparationMs: preparation.medianMs,
      timerDelayMs: round(await timer)
    })
  }
  // Actual filesystem stream and SHA-256, including unchanged-byte replay.
  for (const sizeMiB of [1, 32, 100]) {
    const source = join(root, `delivery-${sizeMiB}.bin`),
      file = await open(source, "w")
    const chunk = Buffer.alloc(1024 * 1024, 0x31)
    try {
      for (let i = 0; i < sizeMiB; i++) await file.write(chunk)
    } finally {
      await file.close()
    }
    const before = process.memoryUsage(),
      start = performance.now()
    let maxExternal = before.external,
      maxRSS = before.rss,
      ticks = 0
    const sample = setInterval(() => {
      const m = process.memoryUsage()
      maxExternal = Math.max(maxExternal, m.external)
      maxRSS = Math.max(maxRSS, m.rss)
      ticks++
    }, 5)
    try {
      const snapshot = await snapshotBotDeliveryFile(root, source, new AbortController().signal)
      assert.equal(snapshot.size, sizeMiB * 1024 * 1024)
      const elapsedMs = performance.now() - start,
        replayAt = performance.now()
      const replay = await snapshotBotDeliveryFile(root, source, new AbortController().signal)
      assert.equal(replay.attachmentPath, snapshot.attachmentPath)
      recorded({
        name: "attachment_snapshot",
        sizeMiB,
        elapsedMs: round(elapsedMs),
        replayMs: round(performance.now() - replayAt),
        peakExtraExternalMiB: round((maxExternal - before.external) / 1024 / 1024),
        peakExtraRSSMiB: round((maxRSS - before.rss) / 1024 / 1024),
        eventLoopTicks: ticks
      })
      if (sizeMiB !== 1) continue
      for (const rtt of [0, 10, 40])
        for (const windowed of [false, true]) {
          let pending = 0,
            peak = 0,
            chunks = 0,
            bytes = 0,
            base64Bytes = 0,
            progressCalls = 0
          const hash = createHash("sha256")
          const command = async (request: BotImFileCommand): Promise<BotImFileResult> => {
            if (request.action === "begin")
              return { state: "uploading", uploadId: "fixture", offset: 0 }
            if (request.action === "chunk") {
              const data = Buffer.from(request.data, "base64")
              hash.update(data)
              bytes += data.length
              base64Bytes += request.data.length
              chunks++
              pending++
              peak = Math.max(peak, pending)
              if (rtt) await delay(rtt)
              pending--
              return {
                state: "uploading",
                uploadId: "fixture",
                offset: request.offset + data.length
              }
            }
            return { state: request.action === "finish" ? "accepted" : "aborted" }
          }
          const at = performance.now()
          const result = await deliverBotImFile(
            command,
            "fixture-delivery",
            "fixture-group",
            { filePath: source, name: "fixture.bin", ...snapshot },
            () => {},
            {
              windowed,
              progress() {
                progressCalls++
              }
            }
          )
          assert.equal(result, "accepted")
          assert.equal(bytes, snapshot.size)
          assert.ok(peak <= (windowed ? 4 : 1))
          assert.equal(hash.digest("hex"), createHash("sha256").update(chunk).digest("hex"))
          recorded({
            name: "attachment_transport",
            sizeMiB,
            rttMs: rtt,
            windowed,
            chunks,
            chunkBytes: BOT_IM_FILE_CHUNK_BYTES,
            peakInFlight: peak,
            base64Bytes,
            progressCalls,
            elapsedMs: round(performance.now() - at)
          })
        }
    } finally {
      clearInterval(sample)
    }
  }
}

async function deepWorkCase(root: string, turns: number) {
  const f = fixture(join(root, `work-history-${turns}.sqlite`))
  try {
    const created = f.store.createWork({
      botId: f.bot.id,
      operationId: "deep-work",
      title: "Deep work",
      goal: "Synthetic history"
    })
    f.store.transition(created.task.id, "running")
    f.store.settle(created.task.id, "completed", null, "Done")
    const seed = f.native.prepare("SELECT * FROM bot_tasks WHERE id=?").get(created.task.id)!
    const insert = cloneWriter(f.native, "bot_tasks", seed)
    f.native.exec("BEGIN")
    for (let i = 1; i < turns; i++)
      insert({
        id: `turn-${i}`,
        request_id: `turn-request-${i}`,
        created_at: Number(seed.created_at) + i,
        updated_at: Number(seed.updated_at) + i
      })
    f.native.exec("COMMIT")
    const sample = measure("deep_work_detail", () => f.store.getWork(f.bot.id, created.work.id), 7)
    assert.equal(sample.result.executionState, "completed")
    const at = performance.now(),
      timer = delay(0).then(() => performance.now() - at)
    f.store.getWork(f.bot.id, created.work.id)
    recorded({
      ...sample,
      result: undefined,
      turns,
      storage: "file-backed SQLite WAL NORMAL; warm reads",
      timerDelayMs: round(await timer)
    })
  } finally {
    f.db.close()
  }
}

async function featureCase(root: string, features: number, operations: number) {
  const f = fixture(join(root, `feature-${features}-${operations}.sqlite`))
  let host: LocalBotHost | undefined
  try {
    const scope = { botId: f.bot.id, audience: "desktop" }
    const seed = f.store.features.follow(scope, {
      projectId: "synthetic-project",
      projectName: "Synthetic project",
      slug: "feature-0",
      title: "Feature 0"
    })
    const followRow = f.native.prepare("SELECT * FROM bot_feature_follows WHERE id=?").get(seed.id)!
    const insertFollow = cloneWriter(f.native, "bot_feature_follows", followRow)
    const insertOp = f.native.prepare(
      "INSERT INTO bot_feature_ops(id,follow_id,task_id,action,fingerprint,state) VALUES(?,?,?,?,?,?)"
    )
    f.native.exec("BEGIN")
    for (let i = 0; i < features; i++) {
      const id = i === 0 ? seed.id : `feature-${i}`
      if (i) insertFollow({ id, slug: `feature-${i}`, title: `Feature ${i}` })
      for (let j = 0; j < operations; j++)
        insertOp.run(`op-${i}-${j}`, id, `task-${i}-${j}`, "session", "synthetic", "finished")
    }
    f.native.exec("COMMIT")
    for (const limit of [-1, 20]) {
      const sample = measure(
        "feature_task_list",
        () => f.store.features.taskRows(scope, { limit }),
        7
      )
      assert.equal(sample.result.length, limit < 0 ? features : Math.min(features, limit))
      const queries: Array<{ sql: string; bindings: any }> = []
      const original = f.db.prepare.bind(f.db)
      f.db.prepare = ((sql: string, bindings?: any) => {
        queries.push({ sql, bindings })
        return original(sql, bindings)
      }) as typeof f.db.prepare
      f.store.features.taskRows(scope, { limit })
      f.db.prepare = original
      recorded({
        ...sample,
        result: undefined,
        features,
        operationsPerFeature: operations,
        limit,
        storage: "file-backed SQLite WAL NORMAL; warm reads",
        plans: queries.map((q) =>
          f.db.exec(`EXPLAIN QUERY PLAN ${q.sql}`, q.bindings)[0]?.values.map((row) => row[3])
        )
      })
    }
    host = new LocalBotHost(f.store, { onAvailable: () => () => {}, acquire: () => null })
    await delay(0)
    const api = measure("feature_page_api", () => host!.featureTaskPage(scope), 7)
    assert.equal(api.result.items.length, Math.min(features, 40))
    recorded({ ...api, result: undefined, features, operationsPerFeature: operations, limit: 40 })
    let cursor: string | undefined
    const ids = new Set<string>(),
      cursors = new Set<string>()
    const start = performance.now()
    do {
      const page = host.featureTaskPage(scope, { cursor })
      for (const item of page.items) {
        assert.ok(!ids.has(item.id))
        ids.add(item.id)
      }
      cursor = page.nextCursor ?? undefined
      if (cursor) {
        assert.ok(!cursors.has(cursor))
        cursors.add(cursor)
      }
    } while (cursor)
    assert.equal(ids.size, features)
    recorded({
      name: "feature_full_pagination",
      features,
      pages: cursors.size + 1,
      elapsedMs: round(performance.now() - start)
    })
  } finally {
    await host?.stop()
    f.db.close()
  }
}

async function telemetryCase() {
  const f = fixture()
  let pending = 0,
    peak = 0,
    calls = 0
  try {
    for (let i = 0; i < 99; i++)
      f.store.create({ name: `Telemetry ${i}`, instructions: "", color: "#123456", modelRef: null })
    const reporter = new BotTelemetryReporter(
      f.store.telemetry,
      () =>
        ({
          async report() {
            pending++
            peak = Math.max(peak, pending)
            calls++
            await delay(2)
            pending--
            return { ok: true as const }
          }
        }) as any
    )
    const at = performance.now()
    await Promise.all(Array.from({ length: 100 }, () => reporter.flush()))
    await reporter.close()
    assert.equal(calls, 20)
    assert.equal(peak, 1)
    recorded({
      name: "telemetry_coalescing",
      simultaneousFlushes: 100,
      batchSize: calls,
      peakNetworkCalls: peak,
      elapsedMs: round(performance.now() - at)
    })
    const query = buildBotMetricsQuery([
      { term: { sapId: "fixture-owner" } },
      { range: { eventTime: { gte: "2026-01-01", lte: "2026-12-31" } } }
    ])
    assert.equal(query.size, 0)
    assert.equal(query.track_total_hits, false)
    assert.ok(!JSON.stringify(query).includes("_raw"))
    recorded({
      name: "es_query_shape",
      requestCount: 1,
      returnsDocuments: 0,
      queryBytes: Buffer.byteLength(JSON.stringify(query)),
      fixedAggregationCount: Object.keys(query.aggs).length,
      productionES: false
    })
  } finally {
    f.db.close()
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "bot-performance-review-"))
  try {
    if (process.argv.includes("--scheduling-only")) {
      for (const n of [8, 32, 100, 500]) await concurrencyCase(n)
      report.status = "passed"
      return
    }
    for (const [history, works, commands] of [
      [1000, 40, 0],
      [10000, 400, 0],
      [50000, 2000, 0],
      [10000, 400, 100],
      [50000, 2000, 100]
    ])
      await databaseCases(history, works, commands)
    for (const n of [8, 32, 100, 500]) await concurrencyCase(n)
    for (const n of [100, 10000, 50000]) await deepWorkCase(root, n)
    for (const [count, ops] of [
      [20, 10],
      [200, 50],
      [2000, 50],
      [1, 10000]
    ])
      await featureCase(root, count, ops)
    await diskCases(root)
    await telemetryCase()
    report.status = "passed"
  } catch (error) {
    report.status = "failed"
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await rm(root, { recursive: true, force: true })
    if (process.env.BOT_PERF_REPORT)
      await writeFile(process.env.BOT_PERF_REPORT, JSON.stringify(report, null, 2) + "\n", {
        flag: "wx"
      })
    console.log(
      "PERF_COMPLETE",
      JSON.stringify({ status: report.status, cases: report.cases.length })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
