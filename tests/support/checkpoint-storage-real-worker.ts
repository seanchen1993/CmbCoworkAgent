import { beforeAll, afterAll, vi } from "vitest"
import { build } from "esbuild"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import type { WorkerOptions, Worker } from "node:worker_threads"
import { modsSourceNodeWorkers } from "./mods-source-node-workers"

const fixture = vi.hoisted(() => ({
  entry: "", compiledMs: 0, digest: "", exited: 0,
  holdAfterAck: false,
  controls: [] as { worker: Worker; acknowledged: boolean }[],
  entered: [] as { threadId: number; defaultCodec: boolean; heapMiB: number | undefined }[]
}))

// Preserve the production admission, source checks and actual ACK/exit waiter. Only replace
// the source-development TS loader with the same freshly compiled real worker entry.
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>()
  return { ...actual, Worker: class extends actual.Worker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      const storage = typeof filename === "string" && options?.eval === true &&
        options.name === "checkpoint-storage-maintenance" &&
        filename.includes("checkpoint-storage-worker.ts")
      if (storage && !fixture.entry) throw Error("CHECKPOINT_STORAGE_WORKER_FIXTURE_NOT_COMPILED")
      const holding = storage && fixture.holdAfterAck
      super(storage ? holding
        ? `require(${JSON.stringify(fixture.entry)});setInterval(()=>{},1000)` : fixture.entry : filename,
      storage ? { ...options, eval: holding } : options)
      if (storage) {
        const control = { worker: this as Worker, acknowledged: false }
        fixture.controls.push(control)
        this.on("message", message => { if (message?.ok === true) control.acknowledged = true })
        fixture.entered.push({ threadId: this.threadId, defaultCodec: options!.workerData.defaultCodec,
          heapMiB: options!.resourceLimits?.maxOldGenerationSizeMb })
        this.once("exit", () => { fixture.exited++ })
      }
    }
  } }
})

export function setupRealCheckpointStorageWorkerFixture() {
  let directory: string
  beforeAll(async () => {
    // Resolve the async Vitest module mock before concurrent factory imports race it.
    await import("node:worker_threads")
    const started = performance.now(), repository = resolve(".")
    directory = mkdtempSync(join(tmpdir(), "checkpoint-compiled-worker-"))
    const workers = modsSourceNodeWorkers(repository)
    const options = { bundle: true, platform: "node" as const, target: "node22",
      format: "cjs" as const, packages: "external" as const, logLevel: "silent" as const,
      // Resolve production external packages from the same installed workspace dependencies.
      banner: { js: `require=require("node:module").createRequire(${JSON.stringify(join(repository, "package.json"))})` },
      plugins: [workers.plugin], metafile: true }
    await build({ ...options, stdin: {
      contents: 'export {default} from "./src/main/checkpointer/checkpoint-storage-worker?nodeWorker"',
      loader: "ts", resolveDir: repository }, outfile: join(directory, "factory.cjs") })
    const digest = createHash("sha256")
    for (const [source, name] of workers.entries) {
      const output = join(directory, name)
      const built = await build({ ...options, entryPoints: [source], outfile: output })
      for (const input of Object.keys(built.metafile!.inputs).sort())
        digest.update(input).update(readFileSync(resolve(repository, input)))
      if (source === resolve(repository, "src/main/checkpointer/checkpoint-storage-worker.ts"))
        fixture.entry = output
    }
    if (!fixture.entry) throw Error("REAL_CHECKPOINT_WORKER_ENTRY_MISSING")
    fixture.compiledMs = performance.now() - started
    fixture.digest = digest.digest("hex")
    console.info("[CheckpointWorkerFixture] Prepared source bundle", {
      compiledMs: fixture.compiledMs, sourceDigest: fixture.digest, entry: fixture.entry
    })
  })
  afterAll(() => {
    console.info("[CheckpointWorkerFixture] Physical worker evidence", {
      entered: fixture.entered, exited: fixture.exited, sourceDigest: fixture.digest
    })
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
  return fixture
}
