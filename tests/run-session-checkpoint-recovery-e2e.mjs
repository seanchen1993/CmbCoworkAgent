import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, open, readFile, rm, unlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const npmExecPath = process.env.npm_execpath
const require = createRequire(import.meta.url)
const electronBinary = require("electron")
const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs")
const profileKey = basename(projectRoot).replace(/[^a-zA-Z0-9._-]/g, "-")
const runLockDirectory = join(tmpdir(), "cmb-session-recovery-e2e-os-profile", profileKey)
const runLockPath = join(runLockDirectory, ".session-recovery-e2e-run.lock")
const execFileAsync = promisify(execFile)

if (!npmExecPath) {
  throw new Error("npm_execpath is unavailable; run this through npm run test:session-recovery:e2e")
}

let activeChild
let receivedSignal
let signalTerminationPromise
let signalTerminationError

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    if (error?.code === "EPERM") return true
    throw error
  }
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve()
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit)
      rejectWait(new Error(`Timed out waiting ${timeoutMs}ms for child PID ${child.pid} to exit`))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolveWait()
    }
    child.once("exit", onExit)
    if (childHasExited(child)) {
      child.off("exit", onExit)
      clearTimeout(timeout)
      resolveWait()
    }
  })
}

async function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

async function terminateChildTree(child) {
  if (!child || childHasExited(child)) return
  const pid = child.pid
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("Cannot terminate E2E child process tree without a valid PID")
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000
      })
    } catch (error) {
      if (!childHasExited(child) && pidIsAlive(pid)) throw error
    }
  } else {
    const gracefulSignal = receivedSignal === "SIGHUP" ? "SIGHUP" : "SIGTERM"
    await signalProcessGroup(pid, gracefulSignal)
    try {
      await waitForChildExit(child, 5_000)
      return
    } catch {
      // Playwright launches Electron in a second detached process group. Its second
      // signal force-closes that group; only then may the wrapper itself be killed.
      await signalProcessGroup(pid, gracefulSignal)
    }
    try {
      await waitForChildExit(child, 10_000)
      return
    } catch {
      await signalProcessGroup(pid, "SIGKILL")
    }
  }

  if (!childHasExited(child)) await waitForChildExit(child, 5_000)
}

function throwIfInterrupted() {
  if (receivedSignal) {
    throw new Error(`Session recovery E2E interrupted by ${receivedSignal}`)
  }
}

function handleSignal(signal) {
  if (receivedSignal) return
  receivedSignal = signal
  const child = activeChild
  signalTerminationPromise = child
    ? terminateChildTree(child).catch((error) => {
        signalTerminationError = error
      })
    : Promise.resolve()
}

const handledSignals =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"]
const signalHandlers = new Map(handledSignals.map((signal) => [signal, () => handleSignal(signal)]))

function installSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}

function runCommand(command, args, env, label) {
  throwIfInterrupted()
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
      windowsHide: true
    })
    activeChild = child
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      if (activeChild === child) activeChild = undefined
      if (error) rejectRun(error)
      else resolveRun()
    }
    child.once("error", (error) => settle(error))
    child.once("exit", (code, signal) => {
      if (receivedSignal) {
        settle(new Error(`${label} interrupted by ${receivedSignal}`))
      } else if (code === 0) {
        settle()
      } else {
        settle(new Error(`${label} failed: code=${code}, signal=${signal}`))
      }
    })
  })
}

function runNpm(args, env) {
  return runCommand(process.execPath, [npmExecPath, ...args], env, `npm ${args.join(" ")}`)
}

function collectViteKeysFromSource(directory, keys) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectViteKeysFromSource(path, keys)
      continue
    }
    if (!entry.isFile() || ![".js", ".mjs", ".ts", ".tsx"].includes(extname(entry.name))) continue
    const source = readFileSync(path, "utf8")
    for (const match of source.matchAll(/\bVITE_[A-Z0-9_]+\b/g)) keys.add(match[0])
  }
}

function readEnvFileSources() {
  return readdirSync(projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(".env"))
    .map((entry) => readFileSync(join(projectRoot, entry.name), "utf8"))
}

function collectEnvFileViteKeys(envFileSources, keys) {
  for (const source of envFileSources) {
    for (const match of source.matchAll(/^\s*(?:export\s+)?(VITE_[A-Z0-9_]+)\s*=/gm)) {
      keys.add(match[1])
    }
  }
}

function collectConfiguredHttpValues(envFileSources, key) {
  const values = new Set()
  const processValue = process.env[key]?.trim()
  if (/^https?:\/\//i.test(processValue ?? "")) values.add(processValue)
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+?)\\s*$`, "gm")
  for (const source of envFileSources) {
    for (const match of source.matchAll(assignment)) {
      let value = match[1].trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      if (/^https?:\/\//i.test(value)) values.add(value)
    }
  }
  return values
}

function directoryContainsLiteral(directory, literal) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (directoryContainsLiteral(path, literal)) return true
      continue
    }
    if (entry.isFile() && [".html", ".js"].includes(extname(entry.name))) {
      if (readFileSync(path, "utf8").includes(literal)) return true
    }
  }
  return false
}

const envFileSources = readEnvFileSources()
const disabledViteKeys = new Set(Object.keys(process.env).filter((key) => key.startsWith("VITE_")))
collectViteKeysFromSource(join(projectRoot, "src"), disabledViteKeys)
collectEnvFileViteKeys(envFileSources, disabledViteKeys)
// Keep security-sensitive URLs explicit even when a partial checkout omits the referencing source file.
for (const key of [
  "VITE_API_BASE_URL",
  "VITE_API_TRACE_BASE_URL",
  "VITE_LOGIN_INFO_ENDPOINT",
  "VITE_MMJ_CDN_URL",
  "VITE_OPEN_ASSISTANT_HUB_GATEWAY_URL",
  "VITE_RENDER_URL",
  "VITE_TASK_CARDS_ENDPOINT",
  "VITE_TRACE_EVOLVER_ENDPOINT",
  "VITE_UNIFIED_IM_GATEWAY_WS_URL",
  "VITE_UPDATE_SERVER_URL"
]) {
  disabledViteKeys.add(key)
}
const configuredMmjCdnUrls = collectConfiguredHttpValues(envFileSources, "VITE_MMJ_CDN_URL")
const safeBuildEnv = { ...process.env }
for (const key of disabledViteKeys) safeBuildEnv[key] = ""
Object.assign(safeBuildEnv, {
  ELECTRON_RENDERER_URL: "",
  VITE_TASK_CARDS_MOCK: "1",
  VITE_TRACE_EVOLVER_MOCK: "true",
  CMB_TASK_CARDS_ENDPOINT: "",
  CMB_TASK_CARDS_MOCK: "1"
})

const runLockToken = randomUUID()
const runLockContents = `${JSON.stringify({
  version: 1,
  pid: process.pid,
  token: runLockToken,
  projectRoot
})}\n`

function describeExistingLock(contents) {
  try {
    const parsed = JSON.parse(contents)
    const pid = Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : "unknown"
    return `owner PID ${pid}`
  } catch {
    return "unknown owner"
  }
}

async function acquireRunLock() {
  await mkdir(runLockDirectory, { recursive: true })
  let handle
  try {
    handle = await open(runLockPath, "wx+")
    await handle.writeFile(runLockContents, "utf8")
    await handle.sync()
    return handle
  } catch (error) {
    const acquisitionErrors = [error]
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        acquisitionErrors.push(closeError)
      }
      try {
        await unlink(runLockPath)
      } catch (unlinkError) {
        acquisitionErrors.push(unlinkError)
      }
    }
    if (error?.code === "EEXIST") {
      const existing = await readFile(runLockPath, "utf8").catch(() => "")
      throw new Error(
        `Session recovery E2E lock exists (${describeExistingLock(existing)}). ` +
          `Refusing unsafe stale-lock removal; verify no test-owned process remains, then remove: ${runLockPath}`
      )
    }
    if (acquisitionErrors.length > 1) {
      throw new AggregateError(acquisitionErrors, "E2E lock acquisition and rollback failed")
    }
    throw error
  }
}

async function releaseRunLock(runLock) {
  const errors = []
  let ownershipMatches = false
  try {
    ownershipMatches = (await readFile(runLockPath, "utf8")) === runLockContents
    if (!ownershipMatches) {
      throw new Error("E2E run lock ownership changed; refusing to unlink another runner's lock")
    }
  } catch (error) {
    errors.push(error)
  }
  try {
    await runLock.close()
  } catch (error) {
    errors.push(error)
  }
  if (ownershipMatches) {
    try {
      ownershipMatches = (await readFile(runLockPath, "utf8")) === runLockContents
      if (!ownershipMatches) {
        throw new Error("E2E run lock changed after close; refusing unsafe unlink")
      }
      await unlink(runLockPath)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Failed to release E2E run lock")
}

let runLock
let runError
let specTestRoot
const cleanupErrors = []
try {
  runLock = await acquireRunLock()
  installSignalHandlers()

  await runNpm(["run", "build"], safeBuildEnv)
  throwIfInterrupted()

  const builtMainPath = join(projectRoot, "out", "main", "index.js")
  const builtMain = readFileSync(builtMainPath, "utf8")
  for (const forbiddenRegistration of [
    "CloudTraceReporter registered",
    "HttpEventReporter registered"
  ]) {
    if (builtMain.includes(forbiddenRegistration)) {
      throw new Error(
        `Unsafe E2E build contains remote reporter registration: ${forbiddenRegistration}`
      )
    }
  }
  const builtRendererDirectory = join(projectRoot, "out", "renderer")
  for (const configuredUrl of configuredMmjCdnUrls) {
    if (directoryContainsLiteral(builtRendererDirectory, configuredUrl)) {
      throw new Error("Unsafe E2E build contains the configured VITE_MMJ_CDN_URL")
    }
  }

  specTestRoot = await mkdtemp(join(tmpdir(), "cmb-session-recovery-e2e-"))
  await runCommand(
    electronBinary,
    [tsxCli, "tests/session-checkpoint-recovery-e2e.spec.ts"],
    {
      ...safeBuildEnv,
      CMB_SESSION_RECOVERY_E2E_SAFE_BUILD: "1",
      CMB_SESSION_RECOVERY_E2E_RUN_LOCK: runLockPath,
      CMB_SESSION_RECOVERY_E2E_TEST_ROOT: specTestRoot,
      ELECTRON_RUN_AS_NODE: "1"
    },
    "Electron-bundled Node session recovery E2E"
  )
  throwIfInterrupted()
} catch (error) {
  runError = error
} finally {
  if (signalTerminationPromise) await signalTerminationPromise
  if (signalTerminationError) cleanupErrors.push(signalTerminationError)
  if (activeChild && !childHasExited(activeChild)) {
    try {
      await terminateChildTree(activeChild)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (specTestRoot) {
    const resolvedTestRoot = resolve(specTestRoot)
    const resolvedTempPrefix = `${resolve(tmpdir())}${sep}`
    if (
      !resolvedTestRoot.startsWith(resolvedTempPrefix) ||
      !basename(resolvedTestRoot).startsWith("cmb-session-recovery-e2e-")
    ) {
      cleanupErrors.push(new Error(`Refusing unsafe E2E test-root cleanup: ${resolvedTestRoot}`))
    } else {
      try {
        await rm(resolvedTestRoot, {
          recursive: true,
          force: true,
          maxRetries: process.platform === "win32" ? 10 : 2,
          retryDelay: 250
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (runLock) {
    try {
      await releaseRunLock(runLock)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  removeSignalHandlers()
}

if (runError && cleanupErrors.length > 0) {
  throw new AggregateError([runError, ...cleanupErrors], "E2E run and cleanup both failed")
}
if (runError) throw runError
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "E2E cleanup failed")
