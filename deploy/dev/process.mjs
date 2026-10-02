import { spawn } from "node:child_process"
import { mkdtemp, chmod, rm, realpath, lstat } from "node:fs/promises"
import { dirname, join } from "node:path"

const ownedDirectories = new Map()
export async function privateTemp() {
  const root = await realpath("/tmp")
  const dir = await mkdtemp(join(root, "dcb-f05-"))
  await chmod(dir, 0o700)
  const stat = await lstat(dir)
  ownedDirectories.set(dir, { ino: stat.ino, dev: stat.dev })
  return dir
}

export async function removePrivateTemp(dir) {
  const owner = ownedDirectories.get(dir)
  if (!owner) throw new Error("Refusing unowned temporary directory")
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.ino !== owner.ino || stat.dev !== owner.dev) throw new Error("Temporary directory ownership changed")
  await rm(dir, { recursive: true, force: true })
  ownedDirectories.delete(dir)
}

// No inherited DB, Maven, Java, model, proxy or credential environment.
// MYSQL_TEST_LOGIN_FILE suppresses .mylogin.cnf even with MySQL 5.7 --no-defaults.
export function isolatedEnv(dir, java) {
  return {
    TMPDIR: dir,
    PATH: [dirname(process.execPath), ...(java ? [dirname(java)] : []), "/usr/bin", "/bin"].join(":"),
    ...(java ? { JAVA_HOME: dirname(dirname(java)) } : {}),
    MYSQL_TEST_LOGIN_FILE: join(dir, "absent-login.cnf"),
    MAVEN_SKIP_RC: "1",
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC"
  }
}

export function ownedProcess(file, args, { cwd, env, maxOutput = 65536 } = {}) {
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 128 || maxOutput > 1048576) throw new Error("Invalid child output bound")
  const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false })
  let output = Buffer.alloc(0), stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false, spawnError, exited = false
  const collect = (chunk, stream) => {
    if (overflow) return
    const available = maxOutput - output.length
    const retained = chunk.subarray(0, available)
    output = Buffer.concat([output, retained])
    if (stream === "stdout") stdout = Buffer.concat([stdout, retained])
    else stderr = Buffer.concat([stderr, retained])
    if (chunk.length > available) {
      overflow = true
      child.kill("SIGKILL")
    }
  }
  child.stdout.on("data", (chunk) => collect(chunk, "stdout"))
  child.stderr.on("data", (chunk) => collect(chunk, "stderr"))
  const done = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error })
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal, output: output.toString("utf8"), stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), spawnError, overflow }) })
  })
  return {
    child, done,
    get exited() { return exited },
    get output() { return output.toString("utf8") },
    async stop() {
      if (!exited) {
        child.kill("SIGTERM")
        const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL") }, 2000)
        try { await done } finally { clearTimeout(timer) }
      }
    }
  }
}

export async function run(file, args, { timeoutMs = 15000, input, signal, stdoutOnly = false, ...options } = {}) {
  if (signal?.aborted) throw new Error("Cancelled")
  const owned = ownedProcess(file, args, options)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; owned.child.kill("SIGKILL") }, timeoutMs)
  const cancel = () => owned.child.kill("SIGKILL")
  signal?.addEventListener("abort", cancel, { once: true })
  owned.child.stdin.on("error", () => {})
  owned.child.stdin.end(input)
  try {
    const result = await owned.done
    if (signal?.aborted || timedOut || result.code !== 0 || result.spawnError || result.overflow) {
      const failureCode = signal?.aborted ? "cancelled" : timedOut ? "timeout" : result.spawnError ? "unavailable" : result.overflow ? "output_limit" : "exit"
      const error = new Error(`Child failed: ${failureCode === "exit" ? `exit ${result.code}` : failureCode}`)
      error.failureCode = failureCode
      error.exitCode = result.code
      throw error
    }
    return (stdoutOnly ? result.stdout : result.output).trim()
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); await owned.stop() }
}
