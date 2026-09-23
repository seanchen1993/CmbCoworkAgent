import { IngressCostProfile } from "./mods-ingress-cost-profile"
import assert from "node:assert/strict"
import { app } from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { LocalSandbox } from "../../src/main/agent/local-sandbox"
import {
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../src/main/agent/thread-run-lease"
import { ModsManager, setModsManager, type ModThreadBinding } from "../../src/main/mods/manager"
import { withModToolCall } from "../../src/main/mods/adapters"
import { DEFAULT_MOD_POLICY } from "../../src/main/mods/policy"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { withFunctionExecution } from "../../src/main/mods/v2/execution-context"
import { summarizeSamples } from "./mods-v2-performance"
import {
  qualifiesIngressMatrix,
  summarizeIngressPair,
  type IngressPerformanceOptions
} from "./mods-v2-ingress-performance"

const output = resolve(process.argv[2])
const options: IngressPerformanceOptions = JSON.parse(
  readFileSync(join(output, "options.json"), "utf8")
)
const costs = options.profile ? new IngressCostProfile() : undefined
costs?.pause()
const workspace = join(output, "project")
mkdirSync(workspace)
app.setPath("userData", join(output, "electron-profile"))
app.commandLine.appendSwitch("disable-gpu")
const active = new Set<FunctionRuntimeClient>()
const ownedPids = new Set<number>()
let manager: ModsManager | undefined
let functions: FunctionModsManager | undefined
let globalEnabled = true
let pluginCount = 8
let discoveries = 0
let runtimeStarts = 0
let events = 0
let completedRounds = 0
let releaseBinding = () => {}
let releaseAuthority = () => {}
let backend: LocalSandbox
let binding: ModThreadBinding
let controller = new AbortController()
const threadId = "ingress-performance"
const turnId = "ingress-turn"
const leaseId = "ingress-lease"
const emptyDelegates = new Set<string>()
const filePath = join(workspace, "sample.txt")
const content = "production LocalSandbox ingress fixture\n"
const started = Date.now()
const matrix: Array<Record<string, unknown>> = []
const disabled: Array<Record<string, unknown>> = []
const report: Record<string, unknown> = {
  status: "running",
  options,
  startedAt: new Date().toISOString(),
  electronPid: process.pid,
  versions: process.versions,
  matrix,
  disabled,
  scope:
    "Real ModsManager, withModToolCall, FunctionModsManager/FunctionSession, utilityProcess QuickJS, native LocalSandbox.read, classic hook ingress, permissions, SQLite audit and production publication. Isolated Electron main fixture without renderer/IPC/model.",
  fixtureDifferences: [
    "Function host callbacks are assembled as production IPC does, but thread scope uses an owned fixture thread/lease rather than the application database.",
    "Plugin discovery uses eight real temporary plugin roots selected by the fixture, not the application's installed-plugin settings.",
    "Output policy is off for all profiles; production publication still executes its configured off path.",
    "Each pass-through plugin adds a counted hop and distinct bit in the tool input; this small instrumentation is included in timing and proves the guest was executed."
  ],
  missingGates: [
    "8 plugins / 4 renderer panels input latency",
    "model streaming TTFT/throughput",
    "whole-app idle CPU",
    "two-hour application soak",
    "renderer-to-main IPC latency"
  ],
  thresholds: { disabledP95DeltaPercent: 5, singlePluginP95Ms: 15 },
  workloadComplete: false,
  qualified: false
}
function save(): void {
  writeFileSync(
    join(output, "progress.json"),
    JSON.stringify(
      {
        ...report,
        completedRounds,
        events,
        elapsedMs: Date.now() - started,
        active: [...active].map((client) => client.stats)
      },
      null,
      2
    )
  )
}
function checkStop(): void {
  if (existsSync(join(output, "STOP"))) throw Error("INGRESS_STOP_REQUESTED")
}
function detach(): void {
  controller.abort()
  releaseBinding()
  releaseAuthority()
  releaseBinding = () => {}
  releaseAuthority = () => {}
}
function attach(): void {
  controller = new AbortController()
  const authority = manager!.createRuntimeAuthority({
    workspace,
    threadId,
    turnId,
    signal: controller.signal
  })
  releaseAuthority = authority.release
  binding = {
    workspace,
    threadId,
    turnId,
    signal: controller.signal,
    runtimeAuthority: authority.authority
  }
  backend = new LocalSandbox({
    rootDir: workspace,
    runId: threadId,
    hookTurnId: turnId,
    windowsSandbox: "none",
    timeout: 30000,
    abortSignal: controller.signal,
    modRuntimeAuthority: authority.authority,
    onModBinding: (release) => {
      releaseBinding = release
    }
  })
}
async function settled(): Promise<void> {
  // Heartbeats provide counters asynchronously. This delay is outside timing samples.
  await new Promise((resolve) => setTimeout(resolve, 300))
  for (const client of active) {
    assert.equal(client.stats.pending, 0)
    assert.equal(client.stats.calls, 0)
    assert.equal(client.stats.frames, 0)
    assert.equal(client.stats.replies, 0)
  }
}
async function profile(
  count: number,
  mode: "enabled" | "project-off" | "global-off"
): Promise<void> {
  checkStop()
  detach()
  functions!.invalidate(manager!.workspaceKey(workspace))
  assert.equal(active.size, 0)
  const deadline = Date.now() + 5000
  while (app.getAppMetrics().some((metric) => ownedPids.has(metric.pid))) {
    checkStop()
    if (Date.now() >= deadline) throw Error("Owned prior utility process failed to terminate")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  pluginCount = count
  globalEnabled = true
  manager!.configure(workspace, mode !== "project-off", false)
  globalEnabled = mode !== "global-off"
  setModsManager(manager)
  attach()
}
async function event(expectedPlugins: number, absent = false): Promise<number> {
  checkStop()
  setModsManager(absent ? undefined : manager)
  let hops = -1
  let mask = -1
  const request = {
    toolCall: {
      id: `read-${events}`,
      name: "read_file",
      args: { file_path: filePath, perf_hops: 0, perf_mask: 0 }
    }
  }
  const start = performance.now()
  const result = await withModToolCall(binding, request, emptyDelegates, async (value) => {
    hops = Number(value.toolCall.args.perf_hops)
    mask = Number(value.toolCall.args.perf_mask)
    const read = () => backend.read(String(value.toolCall.args.file_path))
    return costs ? costs.measureAsync("native.dispatch", read) : read()
  })
  const elapsedMs = performance.now() - start
  // Verification is outside the timed region; bypass/fail-open samples cannot silently pass.
  assert.equal(typeof result, "string")
  assert(String(result).includes(content.trim()), String(result))
  assert.equal(hops, expectedPlugins)
  assert.equal(mask, (1 << expectedPlugins) - 1)
  events++
  return elapsedMs
}
async function runMatrix(): Promise<void> {
  for (let round = 0; round < options.rounds; round++) {
    for (const count of round % 2 ? [8, 1, 0] : [0, 1, 8]) {
      await profile(count, "enabled")
      const coldMs = await event(count)
      for (let i = 0; i < options.warmups; i++) await event(count)
      costs?.reset()
      const values: number[] = []
      for (let i = 0; i < options.samples; i++) values.push(await event(count))
      costs?.pause()
      const storeCosts = costs?.snapshot()
      await settled()
      const audit = manager!.store.audit(manager!.workspaceKey(workspace), 1)[0]
      assert.equal(
        audit?.toolId,
        "host:read_file",
        "Real native dispatch must leave its audit receipt"
      )
      assert.equal(audit.identity?.threadId, threadId)
      assert.equal(audit.status, "succeeded")
      const summary = summarizeSamples(values)
      const row = {
        round,
        plugins: count,
        coldMs,
        ...(storeCosts ? { storeCosts } : {}),
        ...summary,
        auditReceipt: { callId: audit.callId, toolId: audit.toolId, status: audit.status },
        withinSinglePluginBudget: count === 1 ? summary.p95Ms <= 15 : null
      }
      matrix.push(row)
      writeFileSync(
        join(output, `samples-round-${round}-plugins-${count}.json`),
        JSON.stringify(values)
      )
      console.log(JSON.stringify(row))
      save()
    }
    for (const mode of ["project-off", "global-off"] as const) {
      await profile(8, mode)
      const scansBefore = discoveries,
        startsBefore = runtimeStarts
      const arms = { baseline: [] as number[], disabled: [] as number[] }
      for (let i = 0; i < options.warmups + options.samples; i++) {
        for (const arm of i % 2
          ? (["disabled", "baseline"] as const)
          : (["baseline", "disabled"] as const)) {
          const value = await event(0, arm === "baseline")
          if (i >= options.warmups) arms[arm].push(value)
        }
      }
      setModsManager(manager)
      assert.equal(discoveries, scansBefore, "Disabled ingress must not discover function plugins")
      assert.equal(
        runtimeStarts,
        startsBefore,
        "Disabled ingress must not launch a function runtime"
      )
      assert.equal(active.size, 0)
      const row = {
        round,
        mode,
        ...summarizeIngressPair(arms.baseline, arms.disabled),
        pluginDiscoveries: discoveries - scansBefore,
        runtimeStarts: runtimeStarts - startsBefore,
        comparison:
          "Interleaved same LocalSandbox/read_file path, manager absent versus configured disabled, identical backend instance, profile and native hooks."
      }
      disabled.push(row)
      writeFileSync(join(output, `samples-round-${round}-${mode}.json`), JSON.stringify(arms))
      console.log(JSON.stringify(row))
      save()
    }
    completedRounds++
    save()
  }
}

void app.whenReady().then(async () => {
  try {
    writeFileSync(filePath, content)
    const sources = Array.from({ length: 8 }, (_, index) => {
      const name = `ingress-plugin-${index}`,
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
        `export function register(on) { on("tool.call", async ($, e, next) => next({...e, perf_hops:e.perf_hops+1, perf_mask:e.perf_mask | ${1 << index}})) }\n`
      )
      return { id: name, name, path, enabled: true }
    })
    manager = new ModsManager(
      join(output, "control.sqlite"),
      () => sources.slice(0, pluginCount),
      async () => {
        throw Error("Read benchmark must not request write confirmation")
      },
      () => {},
      join(output, "mod-host.cjs"),
      DEFAULT_MOD_POLICY,
      () => globalEnabled
    )
    if (costs) {
      const store = manager.store
      const claim = store.claim.bind(store)
      store.claim = (...args: Parameters<typeof claim>) =>
        costs.measure("claim", () => claim(...args))
      const settle = store.settle.bind(store)
      store.settle = (...args: Parameters<typeof settle>) =>
        costs.measure("settle", () => settle(...args))
      const getGrant = store.getGrant.bind(store)
      store.getGrant = (...args: Parameters<typeof getGrant>) =>
        costs.measure("getGrant", () => getGrant(...args))
      const getSetting = store.getSetting.bind(store)
      store.getSetting = (...args: Parameters<typeof getSetting>) =>
        costs.measure("getSetting", () => getSetting(...args))
      const assertGrant = store.assertGrant.bind(store)
      store.assertGrant = (...args: Parameters<typeof assertGrant>) =>
        costs.measure("assertGrant", () => assertGrant(...args))
      const publication = store.publication.bind(store)
      store.publication = (...args: Parameters<typeof publication>) =>
        costs.measure("publication", () => publication(...args))
      const bindFinalInput = store.bindFinalInput.bind(store)
      store.bindFinalInput = (...args: Parameters<typeof bindFinalInput>) =>
        costs.measure("bindFinalInput", () => bindFinalInput(...args))
    }
    setModsManager(manager)
    manager.configure(workspace, true, false)
    const canonical = manager.workspaceKey(workspace)
    functions = new FunctionModsManager(
      manager.store,
      {
        plugins: () => {
          discoveries++
          return sources.slice(0, pluginCount)
        },
        enabled: (project) => manager!.isEnabled(project),
        publish: (project, value, signal) => manager!.publish(project, value, undefined, signal),
        changed: () => {},
        assertThread: (project, thread) => {
          assert.equal(manager!.workspaceKey(project), canonical)
          assert.equal(thread, threadId)
          controller.signal.throwIfAborted()
          binding.runtimeAuthority!.assertLive()
        }
      },
      () => {
        const client = new FunctionRuntimeClient(join(output, "function-mod-host.cjs"))
        active.add(client)
        runtimeStarts++
        return {
          load: async (code, settings) => {
            const guest = await client.load(code, settings)
            if (costs) {
              const invoke = guest.invoke.bind(guest)
              guest.invoke = (...args: Parameters<typeof invoke>) =>
                costs.measureAsync("guest.invoke", () => invoke(...args))
            }
            if (client.stats.pid) ownedPids.add(client.stats.pid)
            return guest
          },
          stop: () => {
            client.stop()
            active.delete(client)
          }
        }
      }
    )
    manager.attachFunctions({
      toolCall: (scope, input, core) =>
        withFunctionExecution(
          {
            runtimeAuthority: scope.runtimeAuthority,
            workspace: scope.workspace,
            threadId: scope.threadId,
            agentId: scope.agentId,
            turnId: scope.turnId,
            userInitiated: false,
            leased: true,
            immediate: false
          },
          () => functions!.interceptTool(scope.workspace, scope.threadId, input, scope.signal, core)
        ),
      hasToolCheck: (project, thread) => functions!.hasToolCheck(project, thread),
      toolCheck: (scope, input, core, origin) =>
        functions!.interceptToolCheck(
          scope.workspace,
          scope.threadId,
          input,
          scope.signal,
          core,
          origin
        ),
      classicEvent: (...args) => functions!.classicEvent(...args),
      invalidate: (project) => functions!.invalidate(project),
      invalidateAll: () => functions!.invalidateAll(),
      closeThread: (thread) => functions!.closeThread(thread),
      close: () => functions!.close()
    })
    assert.equal(
      claimLocalThreadRunLease({ threadId, owner: "desktop", runId: leaseId }).acquired,
      true
    )
    attach()
    for (const status of await functions.status(canonical)) {
      assert(status.digest, JSON.stringify(status))
      await functions.approve(canonical, status.pluginId, status.digest)
    }
    await runMatrix()
    report.workloadComplete = true
    report.qualified = qualifiesIngressMatrix(
      options,
      completedRounds,
      matrix.map((row) => Number(row.plugins)),
      disabled.map((row) => String(row.mode))
    )
    report.budgetsPassed =
      matrix.every((row) => row.withinSinglePluginBudget !== false) &&
      disabled.every((row) => row.withinBudget === true)
    report.qualificationStatus = options.profile
      ? "diagnostic-instrumented"
      : report.qualified
        ? report.budgetsPassed
          ? "passed"
          : "failed-budget"
        : "smoke-or-insufficient-samples"
    report.status = "completed"
    if (report.qualified && !report.budgetsPassed) process.exitCode = 2
  } catch (error) {
    report.status = "failed"
    report.error = error instanceof Error ? error.stack : String(error)
    console.error(error)
    process.exitCode = 1
  } finally {
    detach()
    releaseLocalThreadRunLease(threadId, "desktop", leaseId)
    manager?.close()
    for (const client of active) client.stop()
    active.clear()
    setModsManager(undefined)
    save()
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        {
          ...report,
          completedRounds,
          events,
          elapsedMs: Date.now() - started,
          activeCount: active.size,
          discoveries,
          runtimeStarts
        },
        null,
        2
      )
    )
    app.exit(Number(process.exitCode ?? 0))
  }
})
