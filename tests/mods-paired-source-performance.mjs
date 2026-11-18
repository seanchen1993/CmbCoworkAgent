/** An opt-in, same-source driver for two independent checked-out programs and dependency trees. */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { cpus, platform, release, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const baselineCommit = "020de58949428d9d6c4075f44eaff1c9428f108c"
const marker = "MODS_PAIRED_SAMPLE "
const contentHash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

const child = String.raw`
const Module = require("node:module")
const { join } = require("node:path")
const [dependencyRoot] = process.argv.slice(1)
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const filename = join(dependencyRoot, "mods-paired-probe-in-memory.cjs")
  const fixture = new Module(filename)
  fixture.filename = filename
  fixture.paths = [join(dependencyRoot, "node_modules")]
  fixture._compile(input, filename)
})`

function fixtureSource(source) {
  const local = (file) => JSON.stringify(join(source, file).replaceAll("\\", "/"))
  return `
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { createFilesystemMiddleware } from "deepagents"
import { LocalSandbox } from ${local("src/main/agent/local-sandbox.ts")}
import { patchRuntimeReadFileTool } from ${local("src/main/agent/read-file-tool.ts")}
import { closeDatabase, createThread, getThreadMessagesPage, initializeDatabase,
  upsertThreadMessages } from ${local("src/main/db/index.ts")}

async function run() {
  const appHome = process.env.CMB_COWORK_AGENT_HOME
  assert(appHome && process.env.MODS_PAIRED_PLAN)
  const workspace = join(appHome, "workspace")
  await mkdir(workspace)
  const file = join(workspace, "source.txt")
  const lines = Array.from({ length: 4096 }, (_, i) => "line-" + i + " 内容 sample")
  await writeFile(file, lines.join("\\n"), "utf8")

  const sandbox = new LocalSandbox({ rootDir: workspace, windowsSandbox: "none" })
  const middleware = createFilesystemMiddleware({ backend: sandbox })
  patchRuntimeReadFileTool({ middleware, filesystemBackend: sandbox })
  const tool = middleware.tools?.find((item) => item.name === "read_file")
  assert(tool?.invoke)

  const thread = "synthetic-history"
  await initializeDatabase()
  try {
    createThread(thread, { workspacePath: workspace })
    const messages = Array.from({ length: 2048 }, (_, i) => ({
      id: "message-" + i,
      role: i % 2 ? "assistant" : "user",
      content: "正文 sample " + i + " " + "x".repeat(256),
      created_at: new Date(1760000000000 + i)
    }))
    for (let index = 0; index < messages.length; index += 64)
      upsertThreadMessages(thread, messages.slice(index, index + 64))

    function page(target) {
      const result = getThreadMessagesPage(thread, {
        limit: 128,
        ...(target ? { targetMessageId: "message-1024" } : {})
      })
      assert.equal(result.total, messages.length)
      assert.equal(result.messages.length, 128)
      assert(result.messages.some((item) => item.id === (target ? "message-1024" : "message-2047")))
      return [result.beforeOrdinal, result.beforeMessageId, result.hasMore,
        result.messages.map(({ id, role, content }) => [id, role, content])]
    }

    const workloads = {
      readFile: async () => {
        const output = String(await tool.invoke({ file_path: file, offset: 1536, limit: 128 }))
        assert(output.includes("line-1536 内容 sample") && output.includes("line-1663 内容 sample"))
        return output
      },
      sandboxExecute: async () => {
        const reply = await sandbox.execute("echo paired-probe", workspace)
        assert.equal(reply.exitCode, 0)
        assert.equal(reply.output.trim(), "paired-probe")
        return reply.output.trim()
      },
      historyTail: () => page(false),
      historyTarget: () => page(true)
    }

    const plan = JSON.parse(process.env.MODS_PAIRED_PLAN)
    const samples = {}
    for (const [name, work] of Object.entries(workloads)) {
      const { warmup, count } = name === "sandboxExecute" ? plan.shell : plan.inProcess
      for (let i = 0; i < warmup; i++) await work()
      const times = []
      let digest
      const memoryBefore = process.memoryUsage()
      for (let i = 0; i < count; i++) {
        const start = performance.now()
        const result = await work()
        times.push(performance.now() - start)
        const current = createHash("sha256").update(JSON.stringify(result)).digest("hex")
        assert(!digest || digest === current)
        digest = current
      }
      samples[name] = { times, digest, memoryBefore, memoryAfter: process.memoryUsage() }
    }
    console.log(${JSON.stringify(marker)} + JSON.stringify(samples))
  } finally {
    await closeDatabase()
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
`
}

async function prepare(label, source, dependencies) {
  const lock = await readFile(join(source, "package-lock.json"))
  const installed = await readFile(join(dependencies, "node_modules", ".package-lock.json"))
  const expected = JSON.parse(lock).packages
  const actual = JSON.parse(installed).packages
  for (const [name, entry] of Object.entries(expected)) {
    if (!name) continue
    if (entry.optional && !actual[name]) continue
    assert.equal(actual[name]?.version, entry.version, `${label}: ${name} version`)
    if (entry.integrity)
      assert.equal(actual[name].integrity, entry.integrity, `${label}: ${name} integrity`)
  }
  const head = git(source, ["rev-parse", "HEAD"])
  const diffBytes = execFileSync("git", ["-c", "core.safecrlf=false", "diff", "HEAD", "--", "src"],
    { cwd: source, maxBuffer: 16 * 1024 * 1024 })
  if (label === "baseline") {
    assert.equal(head, baselineCommit)
    assert.equal(diffBytes.length, 0, "baseline source must match the committed revision")
    assert.equal(git(source, ["ls-files", "--others", "--exclude-standard", "--", "src"]), "")
  }
  const require = createRequire(join(dependencies, "package.json"))
  const result = await require("esbuild").build({
    stdin: { contents: fixtureSource(source), sourcefile: "mods-paired-source-performance.ts",
      resolveDir: source },
    bundle: true,
    target: "node22",
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    define: {
      "import.meta.env": "{}",
      "import.meta.url": JSON.stringify(pathToFileURL(
        join(dependencies, "mods-paired-probe-in-memory.cjs")).href)
    },
    logLevel: "error",
    plugins: [{
      name: "node-only-fixture",
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ namespace: "fixture", path: "electron" }))
        build.onResolve({ filter: /\?nodeWorker$/ }, () => ({ namespace: "fixture", path: "worker" }))
        build.onLoad({ filter: /^electron$/, namespace: "fixture" }, () => ({ loader: "js", contents: `
          const home = () => process.env.CMB_COWORK_AGENT_HOME
          export const app = { isPackaged: false, getPath: home, getName: () => "paired-source-probe",
            getVersion: () => "0.0.0", getAppPath: home, on: () => app, once: () => app }
          export const BrowserWindow = { getAllWindows: () => [] }
          export const safeStorage = { isEncryptionAvailable: () => false }
          export const utilityProcess = {}, dialog = {}, ipcMain = {}, screen = {}, shell = {}
          export const nativeTheme = {}, systemPreferences = {}, clipboard = {}, Notification = {}
          export const powerMonitor = { on: () => powerMonitor, getSystemIdleTime: () => 0 }
          export const webContents = { fromId: () => undefined }
        ` }))
        build.onLoad({ filter: /^worker$/, namespace: "fixture" }, () => ({ loader: "js", contents: `
          export default function worker() { throw new Error("Bundle worker unavailable in source probe") }
        ` }))
      }
    }]
  })
  const bundle = result.outputFiles[0].text
  return { bundle, provenance: { label, source, dependencies, head, diffSha256: contentHash(diffBytes),
    lockSha256: contentHash(lock), installedLockSha256: contentHash(installed),
    bundleSha256: contentHash(bundle) } }
}

async function measure(variant, home, plan) {
  await mkdir(home)
  return new Promise((fulfill, reject) => {
    const processChild = spawn(process.execPath, ["-e", child, variant.provenance.dependencies], {
      cwd: home,
      env: { ...process.env, NODE_PATH: "", CMB_COWORK_AGENT_HOME: home,
        MODS_PAIRED_PLAN: JSON.stringify(plan) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    let output = "", errors = ""
    processChild.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
    processChild.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk })
    const timeout = setTimeout(() => processChild.kill(), 90_000)
    processChild.on("error", reject)
    processChild.stdin.on("error", reject)
    processChild.on("close", (code) => {
      clearTimeout(timeout)
      const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker))
      if (code !== 0 || !line) reject(new Error(`${variant.provenance.label}: exit ${code}\n${output}\n${errors}`))
      else fulfill(JSON.parse(line.slice(marker.length)))
    })
    processChild.stdin.end(variant.bundle)
  })
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const stats = (values) => ({ n: values.length, p50: percentile(values, 0.5),
  p95: percentile(values, 0.95), max: Math.max(...values) })
const ratioRange = (ratios) => ({ median: percentile(ratios, 0.5),
  min: Math.min(...ratios), max: Math.max(...ratios) })
const cpuTime = () => cpus().reduce(({ idle, total }, entry) => ({
  idle: idle + entry.times.idle,
  total: total + Object.values(entry.times).reduce((sum, time) => sum + time, 0)
}), { idle: 0, total: 0 })

async function main() {
  const [baselineDir, baselineDeps, modsDir, modsDeps, ...flags] = process.argv.slice(2)
  assert(baselineDir && baselineDeps && modsDir && modsDeps,
    "Usage: node tests/mods-paired-source-performance.mjs <baseline-source> <baseline-deps> <mods-source> <mods-deps> [--smoke]")
  assert.equal(process.versions.node.split(".")[0], "22", "Run both branches on Node 22")
  const [baselineSource, baselineDependencies, modsSource, modsDependencies] = await Promise.all(
    [baselineDir, baselineDeps, modsDir, modsDeps].map((path) => realpath(resolve(path)))
  )
  assert.notEqual(await realpath(join(baselineDependencies, "node_modules")),
    await realpath(join(modsDependencies, "node_modules")), "dependencies must be physically independent")
  const variants = {
    baseline: await prepare("baseline", baselineSource, baselineDependencies),
    mods: await prepare("mods", modsSource, modsDependencies)
  }
  const smoke = flags.includes("--smoke")
  const pairs = smoke ? 1 : 8
  const plan = {
    inProcess: { count: smoke ? 1 : 120, warmup: smoke ? 1 : 12 },
    shell: { count: smoke ? 1 : 20, warmup: smoke ? 1 : 3 }
  }
  const scratchParent = await realpath(tmpdir())
  const rounds = []
  for (let pair = 0; pair < pairs; pair++) {
    const scratch = await mkdtemp(join(scratchParent, "cmb-mods-pair-"))
    const order = pair % 2 ? ["mods", "baseline"] : ["baseline", "mods"]
    try {
      const record = { pair, order, hostCpuBusyPercent: {} }
      for (const label of order) {
        const before = cpuTime()
        record[label] = await measure(variants[label], join(scratch, label), plan)
        const after = cpuTime()
        record.hostCpuBusyPercent[label] = 100 * (1 - (after.idle - before.idle) / (after.total - before.total))
      }
      for (const [name, sample] of Object.entries(record.baseline))
        assert.equal(record.mods[name].digest, sample.digest, `${name}: business output differs`)
      rounds.push(record)
    } finally {
      assert.equal(dirname(await realpath(scratch)), scratchParent)
      await rm(scratch, { recursive: true, force: true })
    }
  }
  const summary = Object.fromEntries(Object.keys(rounds[0].baseline).map((name) => {
    const times = (label) => rounds.flatMap((round) => round[label][name].times)
    const perPair = rounds.map((round) => {
      const baseline = stats(round.baseline[name].times)
      const mods = stats(round.mods[name].times)
      return { pair: round.pair, order: round.order, hostCpuBusyPercent: round.hostCpuBusyPercent, baseline, mods,
        p50Ratio: mods.p50 / baseline.p50, p95Ratio: mods.p95 / baseline.p95 }
    })
    return [name, { baseline: stats(times("baseline")), mods: stats(times("mods")),
      pairedRoundMedianDeltaMs: percentile(perPair.map((round) => round.mods.p50 - round.baseline.p50), 0.5),
      pairedP50Ratio: ratioRange(perPair.map((round) => round.p50Ratio)),
      pairedP95Ratio: ratioRange(perPair.map((round) => round.p95Ratio)), perPair }]
  }))
  console.log(JSON.stringify({ node: process.version, os: platform(), release: release(), cpu: cpus()[0]?.model,
    baseline: variants.baseline.provenance, mods: variants.mods.provenance,
    smoke, pairs, plan, summary, rounds }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
