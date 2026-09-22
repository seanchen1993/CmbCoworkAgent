/** Real WAL/FULL SQLite state storage; deliberately excludes renderer, policy and VM latency. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ModControlStore } from "../src/main/mods/control-store"

const label = process.argv[2] ?? "current"
assert.match(label, /^[a-z0-9-]+$/)
const root = mkdtempSync(join(tmpdir(), "mods-state-perf-"))
assert.equal(dirname(resolve(root)), resolve(tmpdir()))
assert.ok(basename(root).startsWith("mods-state-perf-"))
const store = new ModControlStore(join(root, "control.sqlite"))
try {
  for (let i = 0; i < 4; i++) store.functionState.set("plugin", `data${i}`, "x".repeat(768000))
  const samples: number[] = []
  const rss = process.memoryUsage().rss
  for (let i = 0; i < 1050; i++) {
    const start = performance.now()
    store.functionState.set("plugin", "counter", i)
    assert.equal(store.functionState.get("plugin", "counter"), i)
    if (i >= 50) samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const result = {
    label,
    iterations: samples.length,
    storedBytesApprox: 4 * 768000,
    p50Ms: samples[499],
    p95Ms: samples[949],
    maxMs: samples[999],
    rssDeltaBytes: process.memoryUsage().rss - rss,
    scope:
      "disk WAL/FULL transaction plus immediate read; one small key update with approximately 3 MiB already stored"
  }
  const output = resolve("output/mods-v2-validation")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `state-perf-${label}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}
