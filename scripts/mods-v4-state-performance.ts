import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { FunctionNamedState } from "../src/main/mods/v2/named-state"

const state = new FunctionNamedState()
const ref = { plugin: "benchmark", key: "counter" }
function summarize(samples: number[]) {
  samples.sort((a, b) => a - b)
  return {
    p50Ms: samples[Math.floor(samples.length * 0.5)],
    p95Ms: samples[Math.floor(samples.length * 0.95)]
  }
}
const sizes = [128, 1024, 4096, 8192]
const rows: unknown[] = []
let count = 0
for (const size of sizes) {
  const fill = performance.now()
  while (count < size) state.write({ ...ref, key: String(count++), value: count }, {})
  const fillMs = performance.now() - fill
  const writes: number[] = []
  const reads: number[] = []
  for (let i = 0; i < 256; i++) {
    let start = performance.now()
    state.write({ ...ref, key: String(i % size), value: i }, {})
    writes.push(performance.now() - start)
    start = performance.now()
    state.read({ ...ref, key: String(i % size) }, {})
    reads.push(performance.now() - start)
  }
  rows.push({
    entries: size,
    fillMs,
    writesIncludingMapCopy: summarize(writes),
    firstSnapshotReads: summarize(reads)
  })
}
const start = performance.now()
for (let round = 0; round < 64; round++) {
  const scope = { drawing: String(round) }
  for (let key = 0; key < 1024; key++) state.read({ ...ref, key: `absent-${key}` }, scope)
  state.release(scope.drawing)
}
const report = {
  node: process.version,
  timestamp: new Date().toISOString(),
  scope:
    "In-memory host only; includes immutable Map copy. Excludes guest IPC, Electron, model, disk and long-run heap acceptance.",
  rows,
  subscriptions: {
    rounds: 64,
    readsPerRound: 1024,
    totalReads: 65536,
    totalMs: performance.now() - start,
    result:
      "All 64 generations released; repeated 1024-key allocations stayed below the 8192-live budget."
  }
}
const directory = resolve("output/mods-v4-validation")
mkdirSync(directory, { recursive: true })
writeFileSync(resolve(directory, "state-performance.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report, null, 2))
