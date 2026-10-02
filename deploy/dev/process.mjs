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
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC"
  }
}

export function ownedProcess(file, args, { cwd, env, maxOutput = 65536 } = {}) {
  const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false })
  let output = "", overflow = false, spawnError, exited = false
  const collect = (chunk) => {
    output += chunk.toString()
    if (Buffer.byteLength(output) > maxOutput) {
      overflow = true
      output = output.slice(0, maxOutput)
      child.kill("SIGKILL")
    }
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", collect)
  const done = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = error })
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal, output, spawnError, overflow }) })
  })
  return {
    child, done,
    get exited() { return exited },
    get output() { return output },
    async stop() {
      if (!exited) {
        child.kill("SIGTERM")
        const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL") }, 2000)
        try { await done } finally { clearTimeout(timer) }
      }
    }
  }
}

export async function run(file, args, { timeoutMs = 15000, input, signal, ...options } = {}) {
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
    if (signal?.aborted || timedOut || result.code !== 0 || result.spawnError || result.overflow)
      throw new Error(`Child failed: ${timedOut ? "timeout" : result.spawnError ? "unavailable" : result.overflow ? "output limit" : `exit ${result.code}`}`)
    return result.output.trim()
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); await owned.stop() }
}
