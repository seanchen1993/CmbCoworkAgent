// Compiled only by CMB_MODS_E2E=1. No IPC handler or production test backdoor.
import { LocalSandbox } from "../../src/main/agent/local-sandbox"
import { getModsManager, setModsManager, ModsManager } from "../../src/main/mods/manager"
import { DEFAULT_MOD_POLICY } from "../../src/main/mods/policy"
import {
  claimLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../src/main/agent/thread-run-lease"
import { withModToolCall } from "../../src/main/mods/adapters"
import { ModRuntimeClient } from "../../src/main/mods/runtime-client"
import { ModControlStore } from "../../src/main/mods/control-store"
import { ModEngine, type ModDispatchRequest } from "../../src/main/mods/engine"
import { join } from "node:path"

interface Scope {
  workspace: string
  threadId: string
  turnId: string
}
const backends = new Map<string, LocalSandbox>()
export function setThreadBusy(threadId: string, busy: boolean): void {
  if (busy) {
    if (!claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "mods-e2e-model" }).acquired)
      throw Error("Thread unexpectedly busy")
  } else releaseLocalThreadRunLease(threadId, "desktop", "mods-e2e-model")
}
export async function finishTurn(threadId: string): Promise<void> {
  await getModsManager()!.finishTurn(threadId)
}
export async function managedPolicyProbe(scope: Scope): Promise<unknown> {
  const manager = new ModsManager(
    join(scope.workspace, "managed-policy.sqlite"),
    () => [],
    async () => true,
    () => {},
    join(__dirname, "mod-host.js"),
    {
      ...DEFAULT_MOD_POLICY,
      required: true,
      denyTools: ["host:write_file"],
      redactLiterals: ["corporate-sensitive-fixture"]
    }
  )
  let executions = 0
  let blocked = false
  let required = false
  try {
    try {
      manager.configure(scope.workspace, false, false)
    } catch {
      required = true
    }
    try {
      await manager.dispatch(scope, "host:write_file", {}, async () => ++executions)
    } catch {
      blocked = true
    }
    const result = await manager.dispatch(scope, "host:read_file", {}, async () => ({
      text: "corporate-sensitive-fixture",
      raw: { value: "corporate-sensitive-fixture" },
      metadata: { password: "do-not-publish" }
    }))
    manager.policy.stop()
    const rebuilt = await manager.dispatch(
      scope,
      "host:read_file",
      {},
      async () => "corporate-sensitive-fixture"
    )
    return {
      required,
      blocked,
      executions,
      result,
      rebuilt,
      audit: manager.store.audit(manager.workspaceKey(scope.workspace))
    }
  } finally {
    manager.close()
  }
}
export async function runTool(
  scope: Scope,
  callId: string,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  let backend = backends.get(scope.threadId)
  if (!backend) {
    backend = new LocalSandbox({
      rootDir: scope.workspace,
      runId: scope.threadId,
      hookTurnId: scope.turnId,
      windowsSandbox: "none",
      timeout: 30_000
    })
    backends.set(scope.threadId, backend)
  }
  return withModToolCall(
    scope,
    { toolCall: { id: callId, name, args } },
    new Set(),
    async (request) => {
      const input = request.toolCall.args
      if (name === "write_file")
        return backend!.write(String(input.file_path), String(input.content))
      if (name === "read_file") return backend!.read(String(input.file_path))
      if (name === "execute") return backend!.execute(String(input.command))
      throw new Error("Unknown fixture tool")
    }
  )
}
export async function context(scope: Scope): Promise<string[]> {
  return getModsManager()!.context(scope)
}
export async function benchmark(scope: Scope, iterations = 100): Promise<Record<string, number>> {
  const times: number[] = []
  const startRss = process.memoryUsage().rss
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await getModsManager()!.dispatch(
      scope,
      "host:fixture_read",
      { index: i },
      async () => "benchmark"
    )
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return {
    iterations,
    medianMs: times[Math.floor(iterations * 0.5)],
    p95Ms: times[Math.floor(iterations * 0.95)],
    maxMs: times.at(-1)!,
    rssDeltaBytes: process.memoryUsage().rss - startRss
  }
}
export function stopRuntime(): void {
  const manager = getModsManager() as unknown as { clients: Map<string, ModRuntimeClient> }
  for (const client of manager.clients.values()) client.stop("MODS_TEST_CRASH")
}

export async function disabledReadBenchmark(scope: Scope): Promise<unknown> {
  const manager = getModsManager()!
  if (manager.isActive(scope.workspace)) throw new Error("Expected disabled Mods")
  const samples = { baseline: [] as number[], disabled: [] as number[] }
  try {
    // Interleave order to reduce cache, GC and temperature bias on the same real read path.
    for (let index = 0; index < 600; index++) {
      const arms =
        index % 2 ? (["disabled", "baseline"] as const) : (["baseline", "disabled"] as const)
      for (const arm of arms) {
        setModsManager(arm === "baseline" ? undefined : manager)
        const start = performance.now()
        await runTool(scope, `disabled-${index}-${arm}`, "read_file", {
          file_path: join(scope.workspace, "secret.txt")
        })
        if (index >= 100) samples[arm].push(performance.now() - start)
      }
    }
    const result = Object.fromEntries(
      Object.entries(samples).map(([arm, times]) => {
        times.sort((a, b) => a - b)
        return [arm, { iterations: times.length, medianMs: times[250], p95Ms: times[475] }]
      })
    )
    return {
      ...result,
      p95ChangePercent: (result.disabled.p95Ms / result.baseline.p95Ms - 1) * 100,
      comparison: "same production read path, manager absent versus disabled; 100 warmups per arm"
    }
  } finally {
    setModsManager(manager)
    // Refresh the execution binding after the baseline temporarily omitted the manager.
    backends.delete(scope.threadId)
  }
}

export async function noopBenchmark(scope: Scope): Promise<unknown> {
  const store = new ModControlStore(join(scope.workspace, "benchmark.sqlite"))
  const client = new ModRuntimeClient(join(__dirname, "mod-host.js"))
  const engine = new ModEngine(store, client, () => {})
  const coldStart = performance.now()
  try {
    const grant = store.grant(scope.workspace, "benchmark", "controlled-fixture", true)
    await engine.load([
      {
        grant,
        compiled: {
          pluginId: "benchmark",
          digest: grant.digest,
          manifest: {
            apiVersion: "cmb.mods/v1",
            id: "benchmark",
            name: "Benchmark",
            entry: "index.ts",
            activation: "project",
            events: ["tool.call"],
            tools: ["host:fixture_read"],
            permissions: { readTools: [], writeTools: [], context: [], store: false }
          },
          code: 'var __cmbMod={default:{register(on){on.tool({id:"noop",tools:["host:fixture_read"]},async($,e,next)=>{const r=await next({args:e.args});return {kind:"result",receipt:r.receipt,projection:r.projection}})}}}'
        }
      }
    ])
    const coldMs = performance.now() - coldStart
    const times: number[] = []
    let initialRss = 0
    for (let i = 0; i < 1100; i++) {
      const request: ModDispatchRequest = {
        identity: {
          callId: `bench-${Date.now()}-${i}`,
          ...scope,
          agentId: "main",
          origin: "model",
          grantEpoch: grant.epoch
        },
        toolId: "host:fixture_read",
        effect: "read",
        args: { index: i },
        protectedOutput: false
      }
      const start = performance.now()
      await engine.dispatch(request, async () => "ok")
      if (i >= 100) times.push(performance.now() - start)
      if (i === 99) initialRss = client.stats.rssBytes
    }
    times.sort((a, b) => a - b)
    return {
      iterations: times.length,
      coldMs,
      medianMs: times[500],
      p95Ms: times[950],
      maxMs: times.at(-1),
      initialChildRss: initialRss,
      finalChildRss: client.stats.rssBytes,
      pendingRequests: client.stats.pending
    }
  } finally {
    await engine.dispose()
    client.stop()
    store.close()
  }
}
