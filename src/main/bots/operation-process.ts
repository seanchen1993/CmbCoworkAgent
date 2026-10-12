import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { botShellEnvironment } from "./shell-contract"

export interface BotOperationLauncher {
  entry: string
  executable?: string
  execArgv?: string[]
  /** Host-owned runtime paths for a disposable OS-sandboxed worker. */
  environment?: Pick<
    NodeJS.ProcessEnv,
    "TMPDIR" | "TMP" | "TEMP" | "HOME" | "CMB_BOT_COMMAND_SCRATCH"
  >
}

/** A disposable Cmb executor owns each process tree. Parent IPC loss cancels it
 * even when the Bot Host is killed before its shutdown handlers can run. */
export class BotOperationProcess {
  constructor(
    private readonly launcher: BotOperationLauncher,
    private readonly label: string
  ) {}

  async execute<T>(
    request: unknown,
    timeoutMs: number,
    parse: (value: unknown) => T,
    signal: AbortSignal,
    progress?: (value: unknown) => void
  ): Promise<T> {
    signal.throwIfAborted()
    if (!existsSync(this.launcher.entry))
      throw new Error(`${this.label}构建产物缺失，请重新构建应用`)
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.launcher.executable ?? process.execPath,
        [...(this.launcher.execArgv ?? []), this.launcher.entry],
        {
          env: {
            ...botShellEnvironment(process.env),
            ...this.launcher.environment,
            ELECTRON_RUN_AS_NODE: "1"
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true
        }
      )
      let result: { value: T } | undefined, failure: Error | undefined
      let settled = false
      let stopTimer: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        if (child.connected) child.send({ cancel: true }, () => {})
        stopTimer ??= setTimeout(() => {
          child.kill("SIGKILL")
        }, 8000)
      }
      const timeout = setTimeout(() => {
        failure = new Error(`${this.label}超时，结果需人工核对`)
        stop()
      }, timeoutMs + 15_000)
      signal.addEventListener("abort", stop, { once: true })
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (stopTimer) clearTimeout(stopTimer)
        signal.removeEventListener("abort", stop)
        if (signal.aborted) reject(signal.reason ?? new Error("命令已取消，需核对已产生的效果"))
        else if (failure) reject(failure)
        else if (!result) reject(new Error(`${this.label}断开，结果需人工核对`))
        else resolve(result.value)
      }
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return
        if ("progress" in message) {
          try {
            if (result) throw new Error("progress after completion")
            progress?.(message.progress)
          } catch {
            failure = new Error(`${this.label}返回了无效进度`)
            stop()
          }
        } else if ("result" in message) {
          try {
            if (result !== undefined) throw new Error("duplicate result")
            result = { value: parse(message.result) }
          } catch {
            failure = new Error(`${this.label}返回了无效结果`)
            stop()
          }
        } else if ("error" in message) {
          failure = new Error(String(message.error).slice(0, 4000))
        }
      })
      child.once("error", (error) => {
        failure = error
        finish()
      })
      child.once("exit", finish)
      child.once("spawn", () => {
        if (signal.aborted) {
          stop()
          return
        }
        child.send(request as object, (error) => {
          if (error) {
            failure = error
            stop()
          }
        })
      })
    })
  }
}
