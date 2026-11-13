import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// Each format runs the real SDK in a separate process so an early rejection is observable
// without changing Vitest's own unhandled-rejection policy or the shared installation.
const children = new Set<{ child: ChildProcess; closed: Promise<unknown> }>()
const roots = new Set<string>()
afterEach(async () => {
  for (const work of children) if (work.child.exitCode === null && work.child.signalCode === null)
    work.child.kill()
  await Promise.all([...children].map(work => work.closed))
  children.clear()
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

const program = String.raw`
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
const [root, extension] = process.argv.slice(2)
const require = createRequire(import.meta.url)
const load = path => extension === "cjs" ? require(path) : import(pathToFileURL(path).href)
const { PregelLoop } = await load(join(root, "graph/dist/pregel/loop." + extension))
const { StateGraph, Annotation, START, END, MemorySaver } =
  await load(join(root, "graph/dist/index." + extension))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const unhandled = []
process.on("unhandledRejection", error => { unhandled.push(error) })
const failure = Error("ACTUAL_CHECKPOINT_PUT_REJECTED")
const direct = { _checkpointerChainedPromise: Promise.resolve(), checkpointerPromises: [],
  checkpointer: { put() { throw failure } } }
PregelLoop.prototype._checkpointerPutAfterPrevious.call(direct, {})
assert.equal(direct.checkpointerPromises[0], direct._checkpointerChainedPromise)
await tick()
assert.deepEqual(unhandled, [])
await assert.rejects(direct.checkpointerPromises[0], error => error === failure)
let thenReads = 0
const fulfilled = Object.defineProperty({}, "then", { get() { thenReads++; return undefined } })
const success = { _checkpointerChainedPromise: Promise.resolve(), checkpointerPromises: [],
  checkpointer: { put() { return fulfilled } } }
PregelLoop.prototype._checkpointerPutAfterPrevious.call(success, {})
await tick()
assert.equal(thenReads, 1, "the settlement observer must not re-assimilate the fulfilled object")
assert.equal(await success.checkpointerPromises[0], fulfilled)
assert.equal(success.checkpointerPromises[0], success._checkpointerChainedPromise)
const entered = deferred(), release = deferred(), failed = deferred()
let modelFinally = false, graphSettled = false
class RejectingSaver extends MemorySaver {
  async put(...args) {
    const result = await super.put(...args)
    if (args[2].step === 0) { failed.resolve(); throw failure }
    return result
  }
}
const State = Annotation.Root({ value: Annotation() })
const graph = new StateGraph(State).addNode("held", async () => {
  entered.resolve()
  try { await release.promise; return { value: "actual-model-completed" } }
  finally { modelFinally = true }
}).addEdge(START, "held").addEdge("held", END).compile({ checkpointer: new RejectingSaver() })
const running = graph.invoke({ value: "input" }, {
  configurable: { thread_id: "actual-checkpoint-rejection-" + extension }, durability: "async"
})
const outcome = running.then(value => { graphSettled = true; return { value } },
  error => { graphSettled = true; return { error } })
try {
  await Promise.all([entered.promise, failed.promise])
  await tick()
  assert.equal(modelFinally, false)
  assert.equal(graphSettled, false, "an observed checkpoint rejection must not fake model drain")
  assert.deepEqual(unhandled, [])
} finally { release.resolve() }
const result = await outcome
assert.equal(result.error, failure)
assert.equal(modelFinally, true)
await tick()
assert.deepEqual(unhandled, [])
console.log(JSON.stringify({ extension, actualGraph: true, originalError: true,
  modelFinally, thenReads, unhandled: unhandled.length }))
`

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-checkpoint-rejection-"))
  roots.add(root)
  try {
    await cp(join(repository, "node_modules/@langchain/langgraph"), join(root, "graph"),
      { recursive: true, dereference: true })
    await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction")
    const manifest = JSON.parse(await readFile(join(repository,
      "patches/langgraph-1.2.5-native-stream-origin.manifest.json"), "utf8")) as {
      files: Array<{ path: string; afterSha256: string }>
    }
    const patch = await readFile(join(repository,
      "patches/langgraph-1.2.5-native-stream-origin.patch"), "utf8")
    const { applyNativeTextPatch } = await import("../../../scripts/langchain-native-patch-text.mjs")
    // Recover official preimages directly from the checked full-file patch. No artifact directory
    // or pre-existing generated installation is part of the regression fixture's inputs.
    const originals = new Map<string, Buffer | undefined>()
    const lines = patch.split("\n")
    let offset = 0
    for (const entry of manifest.files) {
      const oldHeader = lines[offset++]
      if (lines[offset++] !== "+++ b/" + entry.path) throw Error("EXACT_PATCH_PATH_REQUIRED")
      const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[offset++])
      if (!hunk) throw Error("FULL_PATCH_REQUIRED")
      const before: string[] = []
      let endsLF = true
      while (offset < lines.length && lines[offset] && !lines[offset].startsWith("--- ")) {
        const row = lines[offset++]
        const noLF = lines[offset] === "\\ No newline at end of file"
        if (noLF) offset++
        if (row.startsWith("-")) { before.push(row.slice(1)); endsLF = !noLF }
      }
      originals.set(entry.path, oldHeader === "--- /dev/null" ? undefined :
        Buffer.from(before.join("\n") + (before.length && endsLF ? "\n" : "")))
    }
    const outputs = applyNativeTextPatch(patch, originals) as Map<string, Buffer>
    for (const entry of manifest.files) {
      const bytes = outputs.get(entry.path)!
      expect(hash(bytes)).toBe(entry.afterSha256)
      await mkdir(dirname(join(root, "graph", entry.path)), { recursive: true })
      await writeFile(join(root, "graph", entry.path), bytes)
    }
    await writeFile(join(root, "observe.mjs"), program)
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe("actual SDK checkpoint chain settlement observation", () => {
  it.each(["js", "cjs"])("observes early %s rejection while preserving the final SDK await", async extension => {
    const root = await fixture()
    const child = spawn(process.execPath, [join(root, "observe.mjs"), root, extension],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let stdout = "", stderr = ""
    child.stdout.on("data", bytes => { stdout += String(bytes) })
    child.stderr.on("data", bytes => { stderr += String(bytes) })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on("close", (code, signal) => { resolve({ code, signal }) })
    })
    const work = { child, closed }
    children.add(work)
    let spawnFailure: Error | undefined
    child.on("error", error => { spawnFailure = error })
    try {
      const result = await closed
      expect(spawnFailure).toBeUndefined()
      expect(result, stderr).toEqual({ code: 0, signal: null })
      expect(JSON.parse(stdout.trim())).toEqual({ extension, actualGraph: true, originalError: true,
        modelFinally: true, thenReads: 1, unhandled: 0 })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
      children.delete(work)
      await rm(root, { recursive: true, force: true })
      roots.delete(root)
    }
  })
})
