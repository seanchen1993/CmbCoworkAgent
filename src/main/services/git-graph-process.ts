import { execFile, spawn } from "node:child_process"

type GitProcessTreeOptions = {
  cwd?: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  input?: string
  timeout: number
  maxBuffer: number
  operation: string
  terminationGraceMs?: number
  consume?: (chunk: Buffer) => void
}

const windowsProcessOptions = { windowsHide: true, timeout: 3000 } as const

function readWindowsGitChildren(pid: number): Promise<string[]> {
  // Git for Windows can launch the actual Git from a git.exe wrapper.
  const script = [
    `$children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${pid}' -ErrorAction Stop)`,
    "if ($children.Count -eq 1 -and $children[0].Name -eq 'git.exe') {",
    "  $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $children[0].ProcessId) -ErrorAction Stop)",
    "}",
    "$children.ProcessId"
  ].join("\n")
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      windowsProcessOptions,
      (error, output) => resolve(error ? [] : output.split(/\s+/).filter((id) => /^[1-9]\d*$/.test(id)))
    )
  })
}

function killWindowsProcessTrees(pids: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/T", "/F", ...pids.flatMap((pid) => ["/PID", pid])],
      windowsProcessOptions,
      (error) => resolve(!error)
    )
  })
}

// Git can start transports, smudge filters and hooks. Stop descendants before
// releasing a cancelled read or allowing another write after a timeout.
export function runGitProcessTree(args: string[], options: GitProcessTreeOptions): Promise<string> {
  const { cwd, env, signal, timeout, maxBuffer, operation } = options
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32"
    const child = spawn("git", args, { cwd, env, detached: !windows, windowsHide: true })
    const windowsGitClosed = windows ? Promise.withResolvers<void>() : undefined
    let failure: Error | undefined
    let termination: Promise<void> | undefined

    function closePipes(): void {
      // A subprocess in a separate session can keep inherited pipes open.
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }

    function isChildRunning(): boolean {
      return child.exitCode === null && child.signalCode === null
    }

    async function stopWindows(pid: number, gitClosed: Promise<void>): Promise<void> {
      const grace = options.terminationGraceMs
      if (grace !== undefined) {
      const descendants = await readWindowsGitChildren(pid)
        if (isChildRunning() && descendants.length) {
          // Let Git handle the child failure and release its own locks.
          await killWindowsProcessTrees(descendants)
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              gitClosed,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, grace)
              })
            ])
          } finally {
            clearTimeout(timer)
          }
        }
      }
      if (isChildRunning() && !(await killWindowsProcessTrees([String(pid)]))) {
        child.kill("SIGKILL")
      }
      closePipes()
    }

    function stop(reason: Error): void {
      if (failure) return
      failure = reason
      if (windowsGitClosed && child.pid && isChildRunning()) {
        termination = stopWindows(child.pid, windowsGitClosed.promise)
        return
      }
      if (!windows && child.pid) {
        const pid = child.pid
        const signalGroup = (signal: NodeJS.Signals): void => {
          try {
            process.kill(-pid, signal)
          } catch {
            child.kill(signal)
          }
        }
        if (options.terminationGraceMs !== undefined) {
          // Git handles SIGTERM and removes its own lockfiles. Keep the write
          // reserved until filters and hooks that ignore it are terminated too.
          signalGroup("SIGTERM")
          termination = new Promise((resolve) => {
            setTimeout(() => {
              signalGroup("SIGKILL")
              closePipes()
              resolve()
            }, options.terminationGraceMs)
          })
          return
        }
        signalGroup("SIGKILL")
      }
      closePipes()
    }

    function capture(stream: NodeJS.ReadableStream, consume?: (chunk: Buffer) => void): Buffer[] {
      const buffers: Buffer[] = []
      let bytes = 0
      stream.on("data", (chunk: Buffer) => {
        if (failure) return
        if (consume) {
          try {
            consume(chunk)
          } catch (error) {
            stop(error instanceof Error ? error : new Error(String(error)))
          }
          return
        }
        bytes += chunk.length
        if (bytes > maxBuffer) stop(new Error(`${operation}输出超过大小限制`))
        else buffers.push(chunk)
      })
      return buffers
    }

    const stdout = capture(child.stdout, options.consume)
    const stderr = capture(child.stderr)
    const abort = () => stop(signal!.reason)
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => stop(new Error(`${operation}超时`)), timeout)
    timer.unref()
    child.on("error", (error) => {
      failure ??= error
    })
    child.once("close", async (code, exitSignal) => {
      windowsGitClosed?.resolve()
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (termination) await termination
      if (failure) return reject(failure)
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"))
      const message = Buffer.concat(stderr).toString("utf8")
      reject(
        Object.assign(new Error(message.trim() || `${operation}失败`), {
          code,
          signal: exitSignal,
          stderr: message
        })
      )
    })
    // Git can exit early before consuming its complete list of tips.
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
  })
}
