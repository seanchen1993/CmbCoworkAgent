import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import path from "node:path"
import { resolveWindowsBackgroundJobControllerPath } from "../agent/windows-background-job-controller-path"
import { HookProcessCleanupError } from "./owned-process-error"
export { HookProcessCleanupError } from "./owned-process-error"

const READY = Buffer.from("MODS_HOOK_STARTED_V1:")
const HEADER_LENGTH = READY.length + 32 + 1
const TAIL = "MODS_HOOK_SETTLED_V1:"
const TAIL_LENGTH = TAIL.length + 32 + 3
const CLEANUP_WAIT_MS = 5000

function windowsExecutable(executable: string, cwd: string, env: Record<string, string>): string {
  // .NET otherwise searches System32 before PATH (not libuv's spawn search order), which can
  // silently turn an explicitly selected Git Bash into the unrelated Windows WSL launcher.
  const pathKey = Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === "PATH")
  const directories = /[\\/]/.test(executable)
    ? [""]
    : [cwd, ...(env[pathKey ?? "PATH"] ?? "").split(";")]
  for (const directory of directories) {
    const base = path.resolve(cwd, directory.replace(/^"|"$/g, ""), executable)
    for (const candidate of path.extname(base) ? [base] : [base + ".com", base + ".exe"]) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* Try next PATH entry. */
      }
    }
  }
  throw new Error(`Hook executable not found: ${executable}`)
}

/** Physical command ownership only; Hook decisions, permissions and receipts stay in runner. */
export function startOwnedHookCommand(input: {
  executable: string
  args: string[]
  windowsShellCommand?: string
  cwd: string
  env: Record<string, string>
  stdin: string
  signal?: AbortSignal
  stdout(chunk: Buffer): void
  stderr(chunk: Buffer): void
}): {
  stop(): void
  completion: Promise<{ code: number | null; error?: Error }>
} {
  input.signal?.throwIfAborted()
  const windows = process.platform === "win32"
  const executable = windows
    ? windowsExecutable(input.executable, input.cwd, input.env)
    : input.executable
  const child = spawn(
    windows ? resolveWindowsBackgroundJobControllerPath() : input.executable,
    windows
      ? [
          executable,
          input.windowsShellCommand === undefined ? "hook-argv" : "argv-cmd",
          String(process.pid),
          ...(input.windowsShellCommand === undefined ? input.args : [input.windowsShellCommand])
        ]
      : input.args,
    { cwd: input.cwd, env: input.env, detached: !windows, windowsHide: true, stdio: "pipe" }
  )
  let ready = !windows
  let prefix = Buffer.alloc(0)
  let nonce: string | undefined
  let tail = Buffer.alloc(0)
  let error: Error | undefined
  let stopped = false
  let closed = false
  let cleanupUnconfirmed = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let rejectCompletion!: (error: Error) => void
  const stop = (): void => {
    if (stopped || closed) return
    stopped = true
    // A retained ChildProcess handle owns the Windows Job; never discover/kill by bare PID.
    if (windows) {
      try {
        child.kill()
      } catch {
        /* The bounded close fence below reports uncertainty. */
      }
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") cleanupUnconfirmed = true
      }
      escalation = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") cleanupUnconfirmed = true
        }
      }, 100)
    }
    cleanupTimer = setTimeout(() => {
      input.signal?.removeEventListener("abort", stop)
      rejectCompletion(new HookProcessCleanupError())
    }, CLEANUP_WAIT_MS)
  }
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve, reject) => {
    rejectCompletion = reject
    child.once("error", (cause) => {
      error = cause
    })
    child.once("exit", () => {
      // A shell can exit while a daemon still holds its pipe writers. Reap that group too.
      if (!windows) stop()
    })
    child.once("close", (code) => {
      closed = true
      if (cleanupTimer) clearTimeout(cleanupTimer)
      input.signal?.removeEventListener("abort", stop)
      const finish = (): void => {
        if (cleanupUnconfirmed) {
          reject(new HookProcessCleanupError())
          return
        }
        if (!ready) error ??= new Error("HOOK_PROCESS_START_UNCONFIRMED")
        if (windows && ready) {
          if (!stopped && !tail.equals(Buffer.from(`${TAIL}${nonce}:0\n`))) {
            reject(new HookProcessCleanupError())
            return
          }
          if (stopped && tail.length) input.stdout(tail)
        }
        resolve({ code, error })
      }
      // Do not cancel Unix escalation just because the launcher closed its own pipes.
      if (escalation) setTimeout(finish, 110)
      else finish()
    })
  })
  child.stdout.on("data", (chunk: Buffer) => {
    if (!ready) {
      prefix = Buffer.concat([prefix, chunk])
      if (prefix.length < HEADER_LENGTH) return
      nonce = prefix.subarray(READY.length, HEADER_LENGTH - 1).toString("ascii")
      if (
        !prefix.subarray(0, READY.length).equals(READY) ||
        !/^[0-9a-f]{32}$/.test(nonce) ||
        prefix[HEADER_LENGTH - 1] !== 10
      ) {
        error = new Error("HOOK_PROCESS_START_UNCONFIRMED")
        stop()
        return
      }
      ready = true
      chunk = prefix.subarray(HEADER_LENGTH)
      prefix = Buffer.alloc(0)
    }
    if (windows) {
      tail = Buffer.concat([tail, chunk])
      if (tail.length > TAIL_LENGTH) {
        input.stdout(tail.subarray(0, tail.length - TAIL_LENGTH))
        tail = Buffer.from(tail.subarray(tail.length - TAIL_LENGTH))
      }
    } else if (chunk.length) input.stdout(chunk)
  })
  child.stderr.on("data", input.stderr)
  child.stdin.on("error", () => {
    /* Commands may deliberately close stdin early. */
  })
  child.stdout.on("error", (cause) => {
    error = cause
    stop()
  })
  child.stderr.on("error", (cause) => {
    error = cause
    stop()
  })
  input.signal?.addEventListener("abort", stop, { once: true })
  child.stdin.end(input.stdin)
  if (input.signal?.aborted) stop()
  return { stop, completion }
}
