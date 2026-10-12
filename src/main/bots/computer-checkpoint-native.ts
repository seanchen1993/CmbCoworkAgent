import { Worker } from "node:worker_threads"
import { join, relative } from "node:path"
import {
  computerNativeRequest,
  computerNativeResult,
  computerNativeDataResult,
  computerNativeBindingsResult,
  type ComputerNativeRequest
} from "./computer-checkpoint-native-contract"
import { BOT_COMPUTER_NATIVE_PHASE_MS } from "../../shared/bot-computer-maintenance-progress"
import type { ComputerOwner } from "./computer-checkpoint-ports"

type NativeAction = ComputerNativeRequest extends infer Request
  ? Request extends ComputerNativeRequest
    ? Omit<Request, "directory" | "owner">
    : never
  : never

/** Exactly one SQLite thread shares the owning process lifetime. A SIGKILL
 * cannot release the maintenance lock while an orphaned SQLite process keeps
 * writing. Termination waits briefly; a stuck native call ends the whole owner,
 * preserving its journal rather than releasing the lock over a live writer. */
export class ComputerNativeSQLite {
  private active?: Worker
  constructor(
    private readonly directory: string,
    private readonly owner: ComputerOwner,
    private readonly signal: AbortSignal,
    private readonly fatalAbort: () => never,
    private readonly activity: (active: boolean) => void,
    private readonly entry = join(__dirname, "bot-computer-checkpoint-native.js"),
    private readonly execArgv: string[] = []
  ) {}
  private async invoke(action: NativeAction) {
    if (this.active) throw new Error("电脑数据库处理尚未完成")
    this.signal.throwIfAborted()
    await this.owner.checkCurrent()
    this.owner.assertCurrent()
    const request = computerNativeRequest.parse({
      ...action,
      directory: this.directory,
      owner: this.owner.identity()
    })
    const worker = new Worker(this.entry, {
      workerData: request,
      execArgv: this.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    })
    this.active = worker
    this.activity(true)
    try {
      return await new Promise<ReturnType<typeof computerNativeResult.parse>>((resolve, reject) => {
        let value: ReturnType<typeof computerNativeResult.parse> | undefined,
          failure: Error | undefined,
          settled = false,
          hardExit: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
          failure ??=
            this.signal.reason instanceof Error
              ? this.signal.reason
              : new Error("电脑数据库处理已中止")
          void worker.terminate().catch(() => {})
          hardExit ??= setTimeout(this.fatalAbort, 2000)
        }
        const timeout = setTimeout(() => {
          failure = new Error("电脑数据库处理超过阶段时限")
          stop()
        }, BOT_COMPUTER_NATIVE_PHASE_MS)
        this.signal.addEventListener("abort", stop, { once: true })
        if (this.signal.aborted) stop()
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (hardExit) clearTimeout(hardExit)
          this.signal.removeEventListener("abort", stop)
          if (failure) reject(failure)
          else if (!value) reject(new Error("电脑数据库线程未交付有效结果"))
          else resolve(value)
        }
        worker.on("message", (message: unknown) => {
          if (!message || typeof message !== "object") {
            failure = new Error("电脑数据库响应无效")
            stop()
            return
          }
          if ("result" in message && !value) {
            try {
              value = computerNativeResult.parse(message.result)
            } catch {
              failure = new Error("电脑数据库响应超出约定范围")
              stop()
            }
          } else if ("error" in message && typeof message.error === "string")
            failure = new Error(message.error.slice(0, 4000))
          else {
            failure = new Error("电脑数据库重复响应")
            stop()
          }
        })
        worker.once("error", (error) => {
          failure = error
        })
        worker.once("exit", finish)
      })
    } finally {
      this.active = undefined
      this.activity(false)
    }
  }
  async capture(nonce: string, maxBytes: number) {
    return computerNativeDataResult.parse(await this.invoke({ action: "capture", nonce, maxBytes }))
  }
  async read(database: string) {
    return computerNativeDataResult.parse(
      await this.invoke({
        action: "read",
        database: relative(this.directory, database).replaceAll("\\", "/")
      })
    )
  }
  async fence(stage: string, nonce: string, empty = false) {
    return computerNativeDataResult.parse(
      await this.invoke({ action: "fence", stage, nonce, ...(empty ? { empty: true } : {}) })
    )
  }
  async bindings(database: string) {
    return computerNativeBindingsResult.parse(
      await this.invoke({
        action: "bindings",
        database: relative(this.directory, database).replaceAll("\\", "/")
      })
    )
  }
}
