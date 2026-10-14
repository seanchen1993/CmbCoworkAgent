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
const artifacts = mkdtempSync(join(root, "output/mods-audio-platform-probe-"))
const isolated = mkdtempSync(join(tmpdir(), "cmb-audio-platform-probe-"))
const platformResult = join(artifacts, "platform.json")
const controllerPath = join(root, "resources/bin/win32/background-job-controller.exe")
const probePath = join(root, "tests/support/mods-audio-platform-probe.cjs")
const env = {}
const allowed = /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i
for (const [key, value] of Object.entries(process.env))
  if (value && allowed.test(key)) env[key.toUpperCase()] = value
for (const [key, folder] of Object.entries({
  HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
  CMB_COWORK_AGENT_HOME: "data", TEMP: "temp", TMP: "temp"
})) {
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
const evidence = {
  kind: "actual-electron-audio-platform",
  complete: false,
  sdkImplemented: false,
  hardwareAudibilityVerified: false,
  deadlineMs: 90_000,
  autoplayOverride: false,
  cleanup: [],
  platform: null
}
let child
let completion
let deadlineTimer
let timedOut = false
let controllerStarted = false
let stdoutTail = ""
let stderrBytes = 0

function failureMetadata(phase, error) {
  return {
    phase,
    name: error instanceof Error ? error.name : "NON_ERROR",
    undefined: error === undefined,
    code: error && typeof error === "object" && typeof error.code === "string" &&
      /^[A-Z_0-9]{1,80}$/.test(error.code) ? error.code : null
  }
}

async function attempt(phase, operation) {
  try {
    await operation()
    evidence.cleanup.push({ phase, ok: true })
  } catch (error) {
    failures.push(error)
    evidence.cleanup.push({ ...failureMetadata(phase, error), ok: false })
  }
}

async function bounded(promise, milliseconds, code) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

try {
  assert.equal(process.platform, "win32", "This probe requires the existing Windows Job controller")
  const electronPath = require("electron")
  for (const path of [electronPath, controllerPath, probePath]) assert(existsSync(path))
  // The existing controller owns a kill-on-close Job and watches this exact host process.
  child = spawn(controllerPath, [
    electronPath, "argv", String(process.pid), probePath,
    "--audio-probe-root=" + isolated,
    "--audio-probe-result=" + platformResult,
    "--user-data-dir=" + userData
  ], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  completion = new Promise((done, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => done({ code, signal }))
  })
  child.stdout.on("data", chunk => {
    stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-4096)
    controllerStarted ||= stdoutTail.includes("MODS_PROCESS_STARTED_V1\n")
  })
  child.stderr.on("data", chunk => { stderrBytes += chunk.length })
  deadlineTimer = setTimeout(() => {
    timedOut = true
    // Only this controller is killed; closing its Job reaps its actual Electron descendants.
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }, 90_000)
  const exit = await bounded(completion, 100_000, "AUDIO_CONTROLLER_DRAIN_TIMEOUT")
  evidence.exit = exit
  assert.equal(timedOut, false, "The parent-owned 90-second deadline expired")
  assert.equal(controllerStarted, true, "The actual Electron child did not start")
  assert.equal(exit.code, 0, "The platform probe or owned Job cleanup failed")
  evidence.platform = JSON.parse(readFileSync(platformResult, "utf8"))
  assert.equal(evidence.platform.complete, true, "At least one real platform phase failed")
  assert.equal(evidence.platform.httpAttempts, 0)
  assert.equal(evidence.platform.windowDestroyed, true)
} catch (error) {
  failures.push(error)
  evidence.failure = failureMetadata("probe", error)
} finally {
  clearTimeout(deadlineTimer)
  await attempt("owned-job-stop", async () => {
    if (child && child.exitCode === null && child.signalCode === null)
      assert.equal(child.kill(), true, "The owned controller stop was not delivered")
  })
  await attempt("owned-job-reaped", async () => {
    if (completion) evidence.exit = await bounded(completion, 15_000, "AUDIO_JOB_REAP_TIMEOUT")
  })
  await attempt("platform-result-read", async () => {
    if (!evidence.platform && existsSync(platformResult))
      evidence.platform = JSON.parse(readFileSync(platformResult, "utf8"))
  })
  evidence.controllerStarted = controllerStarted
  evidence.timedOut = timedOut
  evidence.stderrBytes = stderrBytes
  evidence.elapsedMs = performance.now() - started
  evidence.complete = failures.length === 0 && evidence.platform?.complete === true
  evidence.failures = failures.map((error, index) => failureMetadata("failure-" + index, error))
  await attempt("evidence-write", async () => {
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(evidence, null, 2) + "\n")
  })
  evidence.complete &&= failures.length === 0
}

console.log(JSON.stringify({
  complete: evidence.complete,
  sdkImplemented: false,
  artifacts,
  elapsedMs: evidence.elapsedMs,
  platformComplete: evidence.platform?.complete ?? false,
  httpAttempts: evidence.platform?.httpAttempts ?? null,
  cleanupFailures: evidence.cleanup.filter(row => !row.ok).length
}))
if (failures.length === 1) throw failures[0]
if (failures.length > 1) throw new AggregateError(failures, "Audio platform probe failed", {
  cause: failures[0]
})
