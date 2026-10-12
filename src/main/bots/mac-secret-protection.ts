import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { botShellEnvironment } from "./shell-contract"
import type { BotSecretProtection } from "./secret-vault"
import {
  BOT_MAC_SECRET_HELPER_FLAG,
  BOT_SECRET_CIPHER_LIMIT,
  BOT_SECRET_PLAIN_LIMIT,
  decodeSecretBytes,
  type BotSecretOperation
} from "./mac-secret-protocol"

/** Uses the installed app's Keychain identity while the desktop is closed. */
export class MacBotSecretProtection implements BotSecretProtection {
  readonly kind = "macos-keychain" as const
  private closed = false
  private pending = new Set<() => void>()

  constructor(
    private readonly executable = process.execPath,
    private readonly appRoot = join(__dirname, "../..")
  ) {}

  protect(bytes: Buffer): Promise<Buffer> {
    return this.run(bytes, "protect")
  }
  unprotect(bytes: Buffer): Promise<Buffer> {
    return this.run(bytes, "unprotect")
  }

  private run(bytes: Buffer, operation: BotSecretOperation): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error("凭据服务正在关闭"))
    if (this.pending.size) return Promise.reject(new Error("凭据服务繁忙，请稍后重试"))
    const inputLimit = operation === "protect" ? BOT_SECRET_PLAIN_LIMIT : BOT_SECRET_CIPHER_LIMIT
    const outputLimit = operation === "protect" ? BOT_SECRET_CIPHER_LIMIT : BOT_SECRET_PLAIN_LIMIT
    if (!bytes.length || bytes.length > inputLimit)
      return Promise.reject(new Error("凭据内容超过限额"))
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(this.executable, [this.appRoot, BOT_MAC_SECRET_HELPER_FLAG], {
          // Deliberately exclude ELECTRON_RUN_AS_NODE, Node injection and credentials.
          env: botShellEnvironment(process.env),
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          windowsHide: true
        })
      } catch {
        reject(new Error("macOS 凭据保护进程无法启动"))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const finish = (error?: Error, result?: Buffer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(cancel)
        // Killing this disposable process also bounds a synchronous Keychain prompt.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdio[3]?.destroy()
        for (const chunk of chunks) chunk.fill(0)
        if (error) reject(error)
        else resolve(result!)
      }
      const cancel = () => finish(new Error("凭据服务正在关闭"))
      const timer = setTimeout(
        () => finish(new Error("macOS 凭据保护超时，请检查钥匙串授权后重试")),
        25_000
      )
      this.pending.add(cancel)
      child.on("error", () => finish(new Error("macOS 凭据保护进程无法启动")))
      child.stdin!.on("error", () => finish(new Error("macOS 凭据保护连接已关闭")))
      child.stdout!.on("error", () => finish(new Error("macOS 凭据保护连接已关闭")))
      child.stdio[3]!.on("error", () => finish(new Error("macOS 凭据保护连接已关闭")))
      child.stderr!.on("error", () => {})
      child.stderr!.resume() // Native errors may contain private input. Never forward them.
      child.stdout!.on("data", (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > Math.ceil(outputLimit / 3) * 4) finish(new Error("macOS 凭据保护返回无效内容"))
        else chunks.push(chunk)
      })
      child.once("close", (code) => {
        if (settled) return
        if (code !== 0) {
          finish(new Error("macOS 凭据保护失败，请检查钥匙串授权后重试"))
          return
        }
        const frame = Buffer.concat(chunks)
        try {
          finish(undefined, decodeSecretBytes(frame.toString("utf8"), outputLimit))
        } catch {
          finish(new Error("macOS 凭据保护返回无效内容"))
        } finally {
          frame.fill(0)
        }
      })
      child.stdin!.end(JSON.stringify({ version: 1, operation, data: bytes.toString("base64") }))
    })
  }

  close(): void {
    this.closed = true
    for (const cancel of this.pending) cancel()
  }
}
