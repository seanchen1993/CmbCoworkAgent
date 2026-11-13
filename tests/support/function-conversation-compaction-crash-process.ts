import { build } from "esbuild"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { modsSourceNodeWorkers } from "./mods-source-node-workers"

export async function createCompactionCrashProcessFixture() {
  const directory = mkdtempSync(join(tmpdir(), "actual-compaction-crash-process-"))
  const repository = resolve("."), started = performance.now()
  const workers = modsSourceNodeWorkers(repository), digest = createHash("sha256")
  const options = { bundle: true, platform: "node" as const, target: "node22",
    format: "cjs" as const, packages: "external" as const, logLevel: "silent" as const,
    banner: { js: `require=require("node:module").createRequire(${JSON.stringify(join(repository, "package.json"))})` },
    plugins: [workers.plugin], metafile: true }
  const entry = join(directory, "actual-process.cjs")
  const built = await build({ ...options,
    entryPoints: [resolve("tests/support/function-conversation-compaction-crash-worker.ts")],
    outfile: entry })
  const hashInputs = (inputs: readonly string[]) => {
    for (const input of inputs.slice().sort()) {
      digest.update(input)
      if (existsSync(resolve(repository, input)))
        digest.update(readFileSync(resolve(repository, input)))
    }
  }
  hashInputs(Object.keys(built.metafile!.inputs))
  for (const [source, name] of [...workers.entries].sort(([a], [b]) => a.localeCompare(b))) {
    const worker = await build({ ...options, entryPoints: [source], outfile: join(directory, name) })
    hashInputs(Object.keys(worker.metafile!.inputs))
  }
  console.info("[ActualCompactionCrashProcess] Prepared source", {
    compiledMs: performance.now() - started, sourceDigest: digest.digest("hex") })
  let sequence = 0
  return {
    async run(input: Record<string, unknown>, signal?: AbortSignal) {
      const manifest = join(directory, `input-${++sequence}.json`)
      const result = join(directory, `result-${sequence}.json`)
      writeFileSync(manifest, JSON.stringify({ ...input, result }))
      const child = spawn(process.execPath, [entry, manifest], { windowsHide: true,
        signal, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", chunk => { output += String(chunk) })
      child.stderr.on("data", chunk => { output += String(chunk) })
      let spawnError: Error | undefined
      const exit = await new Promise<number | null>((done) => {
        child.once("error", error => { spawnError = error })
        child.once("close", done)
      })
      if (spawnError) throw spawnError
      return { exit, output, read: () => JSON.parse(readFileSync(result, "utf8")) }
    },
    close() { rmSync(directory, { recursive: true, force: true }) }
  }
}
