import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
mkdirSync(join(root, "output"), { recursive: true })
const artifacts = mkdtempSync(join(root, "output/mods-audio-backend-e2e-"))
const isolated = mkdtempSync(join(tmpdir(), "cmb-audio-backend-e2e-"))
const nativeResult = join(artifacts, "backend.json")
const controllerPath = join(root, "resources/bin/win32/background-job-controller.exe")
const probePath = join(root, "tests/support/mods-audio-backend-e2e.cjs")
const bundle = join(isolated, "audio-backend.cjs")
const env = {}
const allowed = /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i
for (const [key, value] of Object.entries(process.env))
  if (value && allowed.test(key)) env[key.toUpperCase()] = value
for (const [key, folder] of Object.entries({ HOME: "home", USERPROFILE: "home",
  APPDATA: "appdata", LOCALAPPDATA: "localappdata", CMB_COWORK_AGENT_HOME: "data",
  TEMP: "temp", TMP: "temp" })) {
  env[key] = join(isolated, folder)
  mkdirSync(env[key], { recursive: true })
}
const userData = join(isolated, "electron")
mkdirSync(userData)
mkdirSync(join(isolated, "logs"))
env.CMB_MODS_E2E = "0"
env.ELECTRON_NO_ATTACH_CONSOLE = "1"
const started = performance.now()
const failures = []
const evidence = { kind: "actual-production-audio-backend", complete: false,
  sdkImplemented: false, hardwareAudibilityVerified: false, autoplayOverride: false,
  deadlineMs: 90_000, cleanup: [], backend: null }
let child
let completion
let timer
let timedOut = false
let controllerStarted = false
let tail = ""
let stderrBytes = 0
function metadata(phase, error) {
  return { phase, name: error instanceof Error ? error.name : "NON_ERROR", undefined: error === undefined,
    code: error && typeof error === "object" && typeof error.code === "string" &&
      /^[A-Z_0-9]{1,80}$/.test(error.code) ? error.code : null }
}
async function attempt(phase, run) {
  try { await run(); evidence.cleanup.push({ phase, ok: true }) }
  catch (error) { failures.push(error); evidence.cleanup.push({ ...metadata(phase, error), ok: false }) }
}
async function bounded(actual, ms, code) {
  let timeout
  try {
    return await Promise.race([actual, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Object.assign(Error(code), { code })), ms)
    })])
  } finally { clearTimeout(timeout) }
}
try {
  assert.equal(process.platform, "win32")
  const electron = require("electron")
  for (const path of [electron, controllerPath, probePath]) assert(existsSync(path))
  // Build only the two production leaves and their shared error contract into this temp directory.
  const built = await require("esbuild").build({
    entryPoints: [join(root, "src/main/mods/v2/audio-backend.ts")], outfile: bundle,
    bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"],
    metafile: true, logLevel: "silent"
  })
  const inputs = Object.keys(built.metafile.inputs).map(path => path.replaceAll("\\", "/"))
  assert(inputs.some(path => path.endsWith("/audio-backend.ts")))
  assert(inputs.some(path => path.endsWith("/audio-renderer.ts")))
  assert(inputs.every(path => !/\/main\/(?:ipc|db)\/|\/mods\/v2\/(?:session|manager)\.ts$|\/storage\.ts$/.test(path)))
  evidence.productionLeafInputs = inputs
  child = spawn(controllerPath, [electron, "argv", String(process.pid), probePath,
    "--audio-backend-root=" + isolated, "--audio-backend-result=" + nativeResult,
    "--audio-backend-bundle=" + bundle, "--user-data-dir=" + userData],
  { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  completion = new Promise((done, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => done({ code, signal }))
  })
  child.stdout.on("data", chunk => {
    tail = (tail + chunk.toString("utf8")).slice(-4096)
    controllerStarted ||= tail.includes("MODS_PROCESS_STARTED_V1\n")
  })
  child.stderr.on("data", chunk => { stderrBytes += chunk.length })
  timer = setTimeout(() => {
    timedOut = true
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }, 90_000)
  evidence.exit = await bounded(completion, 100_000, "AUDIO_BACKEND_JOB_TIMEOUT")
  assert.equal(timedOut, false)
  assert.equal(controllerStarted, true)
  assert.equal(evidence.exit.code, 0)
  evidence.backend = JSON.parse(readFileSync(nativeResult, "utf8"))
  assert.equal(evidence.backend.complete, true)
  assert.equal(evidence.backend.httpAttempts, 0)
  assert.equal(evidence.backend.windowsRemaining, 0)
} catch (error) { failures.push(error); evidence.failure = metadata("body", error) }
finally {
  clearTimeout(timer)
  await attempt("owned-job-stop", async () => {
    if (child && child.exitCode === null && child.signalCode === null) assert.equal(child.kill(), true)
  })
  await attempt("owned-job-reaped", async () => {
    if (completion) evidence.exit = await bounded(completion, 15_000, "AUDIO_BACKEND_JOB_REAP_TIMEOUT")
  })
  await attempt("backend-result-read", async () => {
    if (!evidence.backend && existsSync(nativeResult)) evidence.backend = JSON.parse(readFileSync(nativeResult, "utf8"))
  })
  evidence.timedOut = timedOut
  evidence.controllerStarted = controllerStarted
  evidence.stderrBytes = stderrBytes
  evidence.elapsedMs = performance.now() - started
  evidence.complete = failures.length === 0 && evidence.backend?.complete === true
  evidence.failures = failures.map((error, index) => metadata("failure-" + index, error))
  await attempt("evidence-write", async () => {
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(evidence, null, 2) + "\n")
  })
  evidence.complete &&= failures.length === 0
}
console.log(JSON.stringify({ complete: evidence.complete, artifacts,
  elapsedMs: evidence.elapsedMs, sdkImplemented: false, httpAttempts: evidence.backend?.httpAttempts ?? null,
  cleanupFailures: evidence.cleanup.filter(row => !row.ok).length }))
if (failures.length === 1) throw failures[0]
if (failures.length) throw new AggregateError(failures, "Audio backend experiment failed", { cause: failures[0] })
