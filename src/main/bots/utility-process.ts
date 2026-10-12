import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { botShellEnvironment } from "./shell-contract"

export interface BotUtilityLauncher {
  entry: string
  executable?: string
  execArgv?: string[]
}

/** Shared disposable-process transport for bounded parsing/catalog work. Not renderer-accessible. */
export class BotUtilityProcess {
  private active = 0
  constructor(
    private readonly launcher: BotUtilityLauncher,
    private readonly label: string,
    private readonly timeoutMs = 15_000,
    private readonly workerError?: (message: string, code: unknown) => Error
  ) {}
  async invoke<T>(input: unknown, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= 4) throw new Error(`${this.label}繁忙，请等待当前读取完成后再试`)
    if (!existsSync(this.launcher.entry))
      throw new Error(`${this.label}构建产物缺失，请重新构建应用`)
    this.active++
    try {
      return await new Promise<T>((resolve, reject) => {
        const child = spawn(
          this.launcher.executable ?? process.execPath,
          ["--max-old-space-size=256", ...(this.launcher.execArgv ?? []), this.launcher.entry],
          {
            env: { ...botShellEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            serialization: "advanced",
            windowsHide: true
          }
        )
        let result: T | undefined, failure: Error | undefined
        let settled = false
        const stop = () => child.kill("SIGKILL")
        const timeout = setTimeout(() => {
          failure = new Error(`${this.label}超时，请检查输入后重试`)
          stop()
        }, this.timeoutMs)
        signal.addEventListener("abort", stop, { once: true })
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          signal.removeEventListener("abort", stop)
          if (signal.aborted) reject(signal.reason ?? new Error(`${this.label}已取消`))
          else if (failure) reject(failure)
          else if (!result)
            reject(new Error(`${this.label}进程异常退出，输入可能损坏或超出内存限额`))
          else resolve(result)
        }
        child.once("error", (error) => {
          failure = error
          finish()
        })
        child.once("exit", finish)
        child.on("message", (message: unknown) => {
          if (message && typeof message === "object" && "result" in message && !result) {
            try {
              result = parse(message.result)
              return
            } catch {
              /* Invalid worker output is rejected below. */
            }
          } else if (
            message &&
            typeof message === "object" &&
            "error" in message &&
            typeof message.error === "string"
          ) {
            failure =
              this.workerError?.(
                message.error.slice(0, 4000),
                "code" in message ? message.code : undefined
              ) ?? new Error(message.error.slice(0, 4000))
            return
          }
          failure = new Error(`${this.label}返回无效结果`)
          stop()
        })
        child.once("spawn", () => {
          if (signal.aborted) {
            stop()
            return
          }
          child.send(input as object, (error) => {
            if (error) {
              failure = error
              stop()
            }
          })
        })
      })
    } finally {
      this.active--
    }
  }
}
