import { spawn } from "node:child_process"
import { join } from "node:path"
import { botShellEnvironment } from "./shell-contract"
import { withDesktopBotMaintenance } from "./desktop-client"
import { BotDomainError } from "../../shared/bot-types"
import {
  botComputerMaintenancePublicProgress,
  BOT_COMPUTER_FILE_IDLE_MS,
  type BotComputerMaintenancePublicProgress
} from "../../shared/bot-computer-maintenance-progress"
import { ComputerMaintenanceFrames } from "./computer-maintenance-protocol"
import { ComputerMaintenanceSupervision } from "./computer-maintenance-supervision"
import { spawnOwnedMaintenanceProcess } from "./owned-maintenance-process"

let computerProgress: BotComputerMaintenancePublicProgress | null = null
export const desktopComputerMaintenanceProgress = () =>
  computerProgress ? { ...computerProgress } : null

/** The existing backup worker protocol, shared by offline maintenance owners. */
export function runDesktopMaintenanceWorker<T extends { action: string }>(
  entry:
    | "bot-backup"
    | "bot-browser-maintenance"
    | "bot-workspace-maintenance"
    | "bot-computer-checkpoint",
  directory: string,
  input: {
    action: string
    nonce?: string
    checkpoint?: { id: string; sha256: string }
    recovery?: { id: string; sha256: string }
  },
  decode: (value: unknown) => T
): Promise<T> {
  return withDesktopBotMaintenance(
    () =>
      new Promise<T>((resolve, reject) => {
        const isComputer = entry === "bot-computer-checkpoint"
        const owned = isComputer
          ? spawnOwnedMaintenanceProcess(join(__dirname, entry + ".js"), directory)
          : undefined
        const child =
          owned?.child ??
          spawn(process.execPath, [join(__dirname, entry + ".js"), "--data-dir", directory], {
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...botShellEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" }
          })
        const chunks: Buffer[] = []
        let maintenancePid = owned?.maintenancePid ?? (!isComputer ? child.pid : undefined)
        const supervision = new ComputerMaintenanceSupervision()
        const started = performance.now()
        let size = 0,
          failure: Error | undefined
        let receivedProgress = false
        const terminate = () => {
          try {
            if (owned) {
              owned.terminate()
              return
            }
            if (child.pid && process.platform !== "win32") {
              try {
                process.kill(-child.pid, "SIGKILL")
              } catch {
                child.kill("SIGKILL")
              }
            } else child.kill("SIGKILL")
          } catch {
            failure ??= new Error("维护进程尚未退出，后台仍保持停止状态")
          }
        }
        const frames = new ComputerMaintenanceFrames(
          (value) => {
            const nonce = input.nonce ?? input.checkpoint?.id ?? input.recovery?.id
            if (
              value.owner.pid !== maintenancePid ||
              value.operation !== input.action ||
              value.nonce !== nonce
            )
              throw new Error("电脑维护进度不属于当前操作")
            if (supervision.accept(value)) {
              receivedProgress = true
              computerProgress = botComputerMaintenancePublicProgress.strip().parse(value)
            }
          },
          process.platform === "win32"
            ? (pid) => {
                if (maintenancePid !== undefined) throw new Error("电脑维护返回了重复的进程归属")
                maintenancePid = pid
              }
            : undefined
        )
        const timer = setInterval(() => {
          const timedOut = isComputer
            ? receivedProgress
              ? !supervision.alive()
              : performance.now() - started >= BOT_COMPUTER_FILE_IDLE_MS
            : performance.now() - started >= 5 * 60_000
          if (timedOut) {
            failure ??= new Error("本机维护超时；重启后台后将继续校验未完成的恢复")
            terminate()
          }
        }, 1000)
        timer.unref()
        child.once("error", (error) => {
          failure ??= error
          terminate()
        })
        child.stdin.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error
        })
        child.stdout.on("data", (bytes: Buffer) => {
          if (failure) return
          if (isComputer) {
            try {
              frames.push(bytes)
            } catch (error) {
              failure = error instanceof Error ? error : new Error("电脑维护响应无效")
              terminate()
            }
            return
          }
          size += bytes.length
          if (size > 256 * 1024) {
            failure = new Error("维护服务响应过大")
            terminate()
          } else chunks.push(bytes)
        })
        // Diagnostics stay out of renderer errors: they may contain local paths.
        child.stderr.resume()
        child.once("close", (code) => {
          clearInterval(timer)
          computerProgress = null
          // A failed leader can leave Git/pack descendants whose pipes differ
          // from this worker's streams. Drain the owned group/Job before desktop
          // admission permits a replacement Host, including successful exits.
          if (owned) terminate()
          if (failure) {
            reject(failure)
            return
          }
          try {
            if (isComputer) {
              const frame = frames.finish()
              if (!frame.ok)
                throw new BotDomainError(frame.error.code, frame.error.message, {
                  code: frame.error.code
                })
              if (code !== 0) throw new Error("电脑维护意外退出，操作未确认完成")
              const result = decode(frame.result)
              if (result.action !== input.action) throw new Error("维护服务返回了不匹配的操作结果")
              resolve(result)
              return
            }
            const value = JSON.parse(Buffer.concat(chunks).toString()) as {
              ok?: boolean
              result?: unknown
              error?: string
            }
            if (value?.ok !== true || code !== 0)
              throw new Error(
                typeof value?.error === "string" ? value.error : "维护服务意外退出，操作未确认完成"
              )
            const result = decode(value.result)
            if (result.action !== input.action) throw new Error("维护服务返回了不匹配的操作结果")
            resolve(result)
          } catch (error) {
            reject(error)
          }
        })
        child.stdin.end(JSON.stringify(input))
      })
  )
}
