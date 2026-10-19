/** Isolated local filesystem benchmark; no provider, hooks or business code executes. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { RetainedPackageSnapshots } from "../src/main/harness-board/project-runtime/package-snapshots"

async function main() {
  const output = resolve("output/project-composition-fixtures")
  mkdirSync(output, { recursive: true })
  const root = mkdtempSync(join(output, "snapshot-performance-"))
  const sources = [0, 1].map((index) => {
    const source = join(root, `plugin-${index}`)
    mkdirSync(source)
    writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: `fixture-${index}` }))
    for (let file = 0; file < 100; file++)
      writeFileSync(join(source, `resource-${file}.txt`), "x".repeat(4096))
    return source
  })
  const measure = async (work: () => Promise<void>) => {
    const gaps: number[] = []
    let last = performance.now()
    const start = last
    const timer = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }, 5)
    try {
      await work()
      const durationMs = performance.now() - start
      await new Promise((done) => setTimeout(done, 15))
      return { durationMs, maxEventLoopGapMs: Math.max(...gaps), heartbeatSamples: gaps.length }
    } finally {
      clearInterval(timer)
    }
  }
  const snapshots = new RetainedPackageSnapshots(join(root, "retained"))
  const guards: Array<() => void> = []
  const cold = await measure(async () => {
    for (const source of sources) {
      const snapshot = await snapshots.captureAsync(source)
      guards.push(await snapshots.captureGuardAsync(snapshot.digest))
    }
  })
  const warm = await measure(async () => {
    for (const source of sources) {
      const snapshot = await snapshots.captureAsync(source)
      await snapshots.captureGuardAsync(snapshot.digest)
    }
  })
  const boundaryStart = performance.now()
  for (let turn = 0; turn < 20; turn++) for (const guard of guards) guard()
  const twentyBoundariesMs = performance.now() - boundaryStart
  const evidence = {
    packages: 2,
    resourceFilesPerPackage: 100,
    resourceBytes: 819200,
    cold,
    warm,
    twentyBoundariesMs,
    note: "Local fixture timing; not a real AutoBiz package or UI performance claim."
  }
  writeFileSync(join(root, "report.json"), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ root, ...evidence }, null, 2))
  assert(
    cold.heartbeatSamples > 2 && warm.heartbeatSamples > 2,
    "Admission must yield to the main loop"
  )
  assert(
    cold.maxEventLoopGapMs < 200 && warm.maxEventLoopGapMs < 200,
    "Package preparation must not block the main loop for 200ms"
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
