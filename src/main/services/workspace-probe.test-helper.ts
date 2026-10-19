import { buildSync } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { Worker, type WorkerOptions } from "node:worker_threads"

let directory: string | undefined
/** Real Node worker executing the production source, replacing only Vite's build-time loader. */
export function createWorkspaceProbeTestWorker(options: WorkerOptions, startupDelayMs = 0): Worker {
  if (!directory) {
    directory = mkdtempSync(join(tmpdir(), "cmb-workspace-probe-test-"))
    buildSync({
      entryPoints: [resolve("src/main/services/workspace-probe-worker.ts")],
      outfile: join(directory, "worker.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs"
    })
  }
  const entry = join(directory, "worker.cjs")
  return startupDelayMs
    ? new Worker(
        `const until=performance.now()+${startupDelayMs};while(performance.now()<until){};require(${JSON.stringify(entry)})`,
        { ...options, eval: true }
      )
    : new Worker(entry, options)
}

export function removeWorkspaceProbeTestWorker(): void {
  if (!directory) return
  if (
    dirname(directory) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("cmb-workspace-probe-test-")
  )
    throw Error("Unexpected worker test directory")
  rmSync(directory, { recursive: true, force: true })
  directory = undefined
}
