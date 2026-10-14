/** Measures orchestration/serialization overhead only; no model or filesystem scan latency. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { FlowManager } from "../src/main/mods/flows/manager"
import { FlowStore } from "../src/main/mods/flows/store"
import type { FlowDefinition, FlowStep } from "../src/shared/mods/flows/types"

async function main() {
  const rows = new Map<string, string>()
  let writes = 0
  let executions = 0
  const store = new FlowStore({
    getSetting: (key, fallback = "") => rows.get(key) ?? fallback,
    setSetting: (key, value) => {
      writes++
      rows.set(key, value)
    }
  })
  const manager = new FlowManager(store, {
    assertScope() {
      /* Active local benchmark scope. */
    },
    changed() {
      /* No renderer overhead in this CPU benchmark. */
    },
    prepare: async () => ({
      assertLive() {
        /* Captured authority remains live in this benchmark. */
      },
      fingerprint: async () => "stable",
      execute: async (step) => {
        executions++
        return { passed: step.id !== "s63", summary: "test result", source: "agent" }
      },
      finalize: async (_context, confirm) => {
        await confirm()
        return { passed: true, summary: "done", source: "host" }
      },
      dispose: async () => {
        /* No external resources in this benchmark. */
      }
    })
  })
  const steps: FlowStep[] = Array.from({ length: 64 }, (_, index) => ({
    id: `s${index}`,
    name: `Step ${index}`,
    kind: "agent",
    enabled: true,
    prompt: "Noop",
    ...(index === 63 ? { onFailure: { stepId: "s0", maxRetries: 10 } } : {})
  }))
  const definition: FlowDefinition = {
    schemaVersion: 1,
    id: "benchmark",
    name: "Benchmark",
    plugin: "benchmark",
    goal: "Measure bounded host orchestration",
    steps,
    maxExecutions: 256,
    timeoutMs: 60000
  }
  const saveTimes: number[] = []
  for (let revision = 0; revision < 30; revision++) {
    const before = performance.now()
    manager.save("workspace", definition, revision)
    saveTimes.push(performance.now() - before)
  }
  const before = performance.now()
  const started = await manager.start("workspace", "flow-benchmark", definition.id, 30)
  let result = manager.run("workspace", "flow-benchmark", started.id)!
  while (["queued", "running", "waiting"].includes(result.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    result = manager.run("workspace", "flow-benchmark", started.id)!
  }
  const elapsedMs = performance.now() - before
  assert.equal(result.status, "failed")
  assert.match(result.summary!, /最大执行次数/)
  assert.equal(executions, 256)
  assert.equal(result.attempts.length, 256)
  const sorted = saveTimes.sort((a, b) => a - b)
  const report = {
    scope:
      "CPU orchestration + in-memory settings serialization; excludes SQLite I/O, project fingerprints, model/tool latency",
    steps: 64,
    executions,
    saveP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    elapsedMs,
    millisecondsPerExecution: elapsedMs / executions,
    writes,
    retainedBytes: [...rows.values()].reduce((n, text) => n + Buffer.byteLength(text), 0)
  }
  const dir = resolve("output/mods-v3-validation/performance")
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, "engine.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
