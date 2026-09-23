import assert from "node:assert/strict"
import { app } from "electron"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { ModControlStore } from "../../src/main/mods/control-store"
import type { ModObject } from "../../src/shared/mods/types"
import {
  summarizeSamples,
  qualifiesPerformanceRun,
  type PerformanceOptions
} from "./mods-v2-performance"

const output = resolve(process.argv[2])
const options: PerformanceOptions = JSON.parse(readFileSync(join(output, "options.json"), "utf8"))
const workspace = join(output, "project")
mkdirSync(workspace)
app.setPath("userData", join(output, "electron-profile"))
app.commandLine.appendSwitch("disable-gpu")
setFlagsFromString("--expose_gc")
const collect = runInNewContext("gc") as () => void
const active = new Set<FunctionRuntimeClient>()
const ownedPids = new Set<number>()
let manager: FunctionModsManager | undefined
let store: ModControlStore | undefined
let enabled = true
let pluginCount = 8
let discovered = 0
let totalEvents = 0
let reloads = 0
let phase = "setup"
const started = Date.now()
const report: Record<string, unknown> = {
  status: "running",
  options,
  startedAt: new Date().toISOString(),
  electronPid: process.pid,
  versions: process.versions,
  workloadComplete: false,
  qualificationRequested: qualifiesPerformanceRun(options),
  scope:
    "Production FunctionModsManager -> FunctionSession -> utilityProcess QuickJS, real grants/digests and SQLite; host fixture publication passthrough and controlled file core. Not full ModsManager/LocalSandbox/renderer/model/permission I/O.",
  missingGates: [
    "full application disabled tool ingress",
    "8 plugins / 4 rendered panes input latency",
    "model streaming latency/throughput",
    "whole application idle CPU",
    "UI/Client timer and callback resource stress"
  ],
  gc: "Test-only wrapper requests main and utility host GC every 30 seconds; sample includes post-GC heap/RSS; no production source change.",
  thresholds: { singlePluginP95Ms: 15, disabledReadP95DeltaPercent: 5, hostIdleCpuDeltaPoints: 0.5 }
}

function save(): void {
  writeFileSync(
    join(output, "progress.json"),
    JSON.stringify(
      {
        ...report,
        phase,
        elapsedMs: Date.now() - started,
        totalEvents,
        reloads,
        active: [...active].map((client) => client.stats)
      },
      null,
      2
    )
  )
}
function checkStop(): void {
  if (existsSync(join(output, "STOP"))) throw Error("PERFORMANCE_STOP_REQUESTED")
}
async function pause(ms: number): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    checkStop()
    await new Promise((yes) => setTimeout(yes, Math.min(1000, end - Date.now())))
  }
}
function memory(postGc = false): void {
  appendFileSync(
    join(output, "memory.jsonl"),
    JSON.stringify({
      at: Date.now(),
      elapsedMs: Date.now() - started,
      phase,
      totalEvents,
      reloads,
      postGc,
      main: process.memoryUsage(),
      children: [...active].map((client) => client.stats)
    }) + "\n"
  )
}
async function settled(): Promise<void> {
  await pause(300)
  for (const client of active) {
    assert.equal(client.stats.pending, 0)
    assert.equal(client.stats.calls, 0)
    assert.equal(client.stats.frames, 0)
    assert.equal(client.stats.replies, 0)
  }
}
async function retired(): Promise<void> {
  const limit = Date.now() + 5000
  while (
    app
      .getAppMetrics()
      .some(
        (metric) =>
          ownedPids.has(metric.pid) &&
          ![...active].some((client) => client.stats.pid === metric.pid)
      )
  ) {
    if (Date.now() >= limit) throw Error("Owned utility process failed to terminate")
    await pause(50)
  }
}
async function setProfile(count: number, on = true): Promise<void> {
  checkStop()
  enabled = false
  manager!.invalidate(workspace)
  await retired()
  assert.equal(active.size, 0)
  pluginCount = count
  enabled = on
  reloads++
}

const input: ModObject = {
  tool: "read_file",
  tool_use_id: "performance",
  path: join(workspace, "sample.txt"),
  perf_hops: 0
}
async function core(value: ModObject, signal: AbortSignal, file: boolean): Promise<ModObject> {
  signal.throwIfAborted()
  const text = file
    ? await readFile(join(workspace, "sample.txt"), { encoding: "utf8", signal })
    : "noop"
  return { result: text, perf_hops: value.perf_hops }
}
async function event(file = false, bypass = false): Promise<void> {
  checkStop()
  const signal = new AbortController().signal
  const result = bypass
    ? await core(input, signal, file)
    : await manager!.interceptTool(workspace, "performance", input, signal, (value, scoped) =>
        core(value, scoped, file)
      )
  assert.equal(result.result, file ? "performance fixture\n" : "noop")
  assert.equal(
    result.perf_hops,
    bypass || !enabled ? 0 : pluginCount,
    "Every guest must execute; a fail-open hook is not a valid performance sample"
  )
  totalEvents++
}

async function matrix(): Promise<void> {
  phase = "matrix"
  const rounds: unknown[] = []
  report.matrix = rounds
  for (let round = 0; round < options.rounds; round++) {
    for (const count of round % 2 ? [8, 1, 0] : [0, 1, 8]) {
      await setProfile(count)
      const cold = performance.now()
      await event()
      const coldMs = performance.now() - cold
      for (let index = 0; index < options.warmups; index++) await event()
      const values: number[] = []
      for (let index = 0; index < options.samples; index++) {
        const before = performance.now()
        await event()
        values.push(performance.now() - before)
      }
      await settled()
      const summary = summarizeSamples(values)
      const row = {
        round,
        plugins: count,
        coldMs,
        ...summary,
        withinSinglePluginBudget: count === 1 ? summary.p95Ms <= 15 : null
      }
      rounds.push(row)
      writeFileSync(
        join(output, `samples-round-${round}-plugins-${count}.json`),
        JSON.stringify(values)
      )
      console.log(JSON.stringify(row))
      memory()
      save()
    }
    await setProfile(8, false)
    const scansBefore = discovered
    const arms = { baseline: [] as number[], disabled: [] as number[] }
    for (let index = 0; index < options.warmups + options.samples; index++) {
      for (const arm of index % 2
        ? (["disabled", "baseline"] as const)
        : (["baseline", "disabled"] as const)) {
        const before = performance.now()
        await event(true, arm === "baseline")
        if (index >= options.warmups) arms[arm].push(performance.now() - before)
      }
    }
    assert.equal(discovered, scansBefore, "Disabled manager must not discover/scan plugins")
    assert.equal(active.size, 0, "Disabled manager must not start a utility process")
    const baseline = summarizeSamples(arms.baseline),
      disabled = summarizeSamples(arms.disabled)
    const delta = 100 * (disabled.p95Ms / baseline.p95Ms - 1)
    const row = {
      round,
      disabledRead: {
        baseline,
        disabled,
        p95DeltaPercent: delta,
        withinHostBudget: delta <= 5,
        pluginDiscoveries: 0,
        runtimeStarts: 0,
        scope:
          "same controlled fs.promises.readFile, direct core versus disabled FunctionModsManager; not full LocalSandbox ingress"
      }
    }
    rounds.push(row)
    writeFileSync(join(output, `samples-round-${round}-disabled.json`), JSON.stringify(arms))
    console.log(JSON.stringify(row))
    save()
  }
}

function childCpu(): number | undefined {
  const pids = new Set([...active].map((client) => client.stats.pid))
  const metrics = app.getAppMetrics().filter((metric) => pids.has(metric.pid))
  if (metrics.length !== pids.size) return undefined
  if (metrics.some((metric) => metric.cpu.cumulativeCPUUsage === undefined)) return undefined
  return metrics.reduce((total, metric) => total + metric.cpu.cumulativeCPUUsage!, 0)
}
async function idle(): Promise<void> {
  phase = "idle"
  const results: Array<{
    plugins: number
    elapsedMs: number
    mainCpuPoints: number
    childCpuPoints: number | null
    combinedCpuPoints: number | null
  }> = []
  report.idle = results
  for (const count of [0, 8]) {
    await setProfile(count, count > 0)
    if (count) await event()
    await settled()
    const cpuBefore = process.cpuUsage(),
      childBefore = childCpu(),
      before = performance.now()
    await pause(options.idleSeconds * 1000)
    const elapsedMs = performance.now() - before,
      cpu = process.cpuUsage(cpuBefore),
      childAfter = childCpu()
    const mainCpuPoints = (cpu.user + cpu.system) / (elapsedMs * 10)
    const childCpuPoints =
      childBefore === undefined || childAfter === undefined
        ? null
        : ((childAfter - childBefore) * 100000) / elapsedMs
    results.push({
      plugins: count,
      elapsedMs,
      mainCpuPoints,
      childCpuPoints,
      combinedCpuPoints: childCpuPoints === null ? null : mainCpuPoints + childCpuPoints
    })
    save()
  }
  report.idleDeltaPoints = results.every((result) => result.combinedCpuPoints !== null)
    ? results[1].combinedCpuPoints! - results[0].combinedCpuPoints!
    : null
}

async function soak(): Promise<void> {
  phase = "soak"
  const before = performance.now()
  const interval = (options.soakSeconds * 1000) / options.soakEvents
  const cycle = options.smoke ? 5 : 250
  let events = 0
  const counts = [1, 8, 0, 8]
  const summary = {
    events,
    elapsedMs: 0,
    reloads: 0,
    requestedSeconds: options.soakSeconds,
    requestedEvents: options.soakEvents
  }
  report.soak = summary
  const reloadStart = reloads
  while (performance.now() - before < options.soakSeconds * 1000 || events < options.soakEvents) {
    if (events % cycle === 0) {
      const count = counts[Math.floor(events / cycle) % counts.length]
      await setProfile(count, count > 0)
    }
    await event(events % 4 === 0)
    events++
    Object.assign(summary, {
      events,
      elapsedMs: performance.now() - before,
      reloads: reloads - reloadStart
    })
    if (events % cycle === 0) {
      await settled()
      memory()
      save()
    }
    await pause(
      Math.max(0, before + Math.min(events, options.soakEvents) * interval - performance.now())
    )
  }
  await settled()
  Object.assign(summary, { elapsedMs: performance.now() - before })
  save()
}

void app.whenReady().then(async () => {
  let observer: ReturnType<typeof setInterval> | undefined
  try {
    writeFileSync(join(workspace, "sample.txt"), "performance fixture\n")
    const sources = Array.from({ length: 8 }, (_, index) => {
      const name = `perf-plugin-${index}`,
        path = join(output, "plugins", name)
      mkdirSync(join(path, ".claude-plugin"), { recursive: true })
      mkdirSync(join(path, "hooks"))
      writeFileSync(
        join(path, ".claude-plugin/plugin.json"),
        JSON.stringify({ name, version: "1.0.0" })
      )
      writeFileSync(join(path, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
      writeFileSync(
        join(path, "hooks/register.ts"),
        'export function register(on) { on("tool.call", async ($, e, next) => next({...e, perf_hops:e.perf_hops+1})) }\n'
      )
      return { id: name, name, path, enabled: true }
    })
    store = new ModControlStore(join(output, "control.sqlite"))
    manager = new FunctionModsManager(
      store,
      {
        plugins: () => {
          discovered++
          return sources.slice(0, pluginCount)
        },
        enabled: () => enabled,
        publish: async (_workspace, value, signal) => {
          signal.throwIfAborted()
          return value
        },
        changed: () => {},
        assertThread: (project, thread) => {
          assert.equal(project, workspace)
          assert.equal(thread, "performance")
        }
      },
      () => {
        const client = new FunctionRuntimeClient(join(output, "function-mod-host.cjs"))
        active.add(client)
        return {
          async load(code, settings) {
            const guest = await client.load(code, settings)
            if (client.stats.pid) ownedPids.add(client.stats.pid)
            return guest
          },
          stop() {
            if (client.stats.pid) ownedPids.add(client.stats.pid)
            client.stop()
            active.delete(client)
          }
        }
      }
    )
    for (const status of await manager.status(workspace)) {
      assert.ok(status.digest, JSON.stringify(status))
      await manager.approve(workspace, status.pluginId, status.digest)
    }
    await retired()
    memory()
    let observations = 0
    observer = setInterval(() => {
      const postGc = ++observations % 3 === 0
      if (postGc) collect()
      memory(postGc)
      save()
    }, 10000)
    if (["all", "matrix"].includes(options.phase)) await matrix()
    if (["all", "idle"].includes(options.phase)) await idle()
    if (["all", "soak"].includes(options.phase)) await soak()
    await setProfile(0, false)
    report.status = "completed"
    report.workloadComplete = true
  } catch (error) {
    report.status = "failed"
    report.error = error instanceof Error ? error.stack : String(error)
    console.error(error)
    process.exitCode = 1
  } finally {
    clearInterval(observer)
    manager?.close()
    for (const client of active) client.stop()
    active.clear()
    store?.close()
    phase = "finished"
    memory()
    save()
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        {
          ...report,
          totalEvents,
          reloads,
          elapsedMs: Date.now() - started,
          activeCount: active.size
        },
        null,
        2
      )
    )
    app.exit(Number(process.exitCode ?? 0))
  }
})
