import { randomUUID, timingSafeEqual } from "crypto"
import { existsSync, rmSync } from "fs"
import { createServer, type Server, type Socket } from "net"
import {
  CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
  CMB_CHROME_EXTENSION_ORIGIN,
  MAX_EXTENSION_COOKIE_BATCH_BYTES,
  MAX_EXTENSION_IMPORT_BYTES,
  MAX_EXTENSION_IMPORT_COOKIES,
  type BrowserCookieBridgeErrorCode,
  type CmbChromeCookie,
  type CmbChromeExtensionReadyMessage,
  type CmbExportCookiesRequestMessage,
  type CmbNativeHostHelloMessage
} from "../../../shared/browser-cookie-bridge"
import { BUILTIN_BROWSER_LOG_PREFIX } from "../../../shared/browser-types"
import {
  getBrowserCookieBridgePipePath,
  getBrowserCookieBridgeSecret
} from "./browser-cookie-bridge-paths"
import { encodeNativeMessage, NativeMessageDecoder } from "./native-messaging-framing"

const DEFAULT_EXPORT_TIMEOUT_MS = 60_000
const BROWSER_COOKIE_BRIDGE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserCookieBridge]`

interface BridgeClient {
  authenticated: boolean
  decoder: NativeMessageDecoder
  ready?: CmbChromeExtensionReadyMessage
  socket: Socket
}

interface PendingExport {
  bytes: number
  client: BridgeClient
  cookies: CmbChromeCookie[]
  expectedTotal?: number
  nextChunkIndex: number
  reject: (error: Error) => void
  requestId: string
  resolve: (result: { cookies: CmbChromeCookie[]; skippedCookies: number }) => void
  skipped?: number
  started: boolean
  timer: NodeJS.Timeout
}

export class BrowserCookieBridgeError extends Error {
  constructor(
    readonly code: BrowserCookieBridgeErrorCode,
    message: string
  ) {
    super(message)
    this.name = "BrowserCookieBridgeError"
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringsEqualSecurely(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{16,64}$/i.test(value)
}

export class BrowserCookieBridgeServer {
  private readonly clients = new Set<BridgeClient>()
  private pending: PendingExport | null = null
  private server: Server | null = null
  private startPromise: Promise<void> | null = null

  constructor(
    private readonly pipePath = getBrowserCookieBridgePipePath(),
    private readonly secret = getBrowserCookieBridgeSecret()
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<void>((resolve, reject) => {
      if (process.platform !== "win32" && existsSync(this.pipePath)) {
        rmSync(this.pipePath, { force: true })
      }
      const server = createServer((socket) => this.accept(socket))
      this.server = server
      server.once("error", (error) => {
        if (this.server === server) this.server = null
        reject(error)
      })
      server.listen(this.pipePath, () => {
        console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Server listening on ${this.pipePath}`)
        server.removeAllListeners("error")
        server.on("error", (error) => {
          console.warn(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Server error: ${error.message}`)
        })
        resolve()
      })
    }).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  stop(): void {
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Stopping server, ${this.clients.size} client(s) connected`)
    this.failPending(
      new BrowserCookieBridgeError("extension_not_connected", "Chrome 扩展连接已关闭")
    )
    for (const client of this.clients) client.socket.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = null
    if (process.platform !== "win32" && existsSync(this.pipePath)) {
      rmSync(this.pipePath, { force: true })
    }
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Server stopped`)
  }

  get connected(): boolean {
    return Array.from(this.clients).some(
      (client) => client.authenticated && client.ready && !client.socket.destroyed
    )
  }

  get profileInstanceId(): string | undefined {
    return Array.from(this.clients).find((client) => client.ready)?.ready?.profileInstanceId
  }

  async exportCookies(timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS): Promise<{
    cookies: CmbChromeCookie[]
    skippedCookies: number
  }> {
    await this.start()
    if (this.pending) {
      throw new BrowserCookieBridgeError("import_in_progress", "已有 Chrome Cookie 导入正在进行")
    }
    const client = Array.from(this.clients).find(
      (candidate) => candidate.authenticated && candidate.ready && !candidate.socket.destroyed
    )
    if (!client) {
      throw new BrowserCookieBridgeError(
        "extension_not_connected",
        "CmbCoworkAgent Chrome 扩展尚未连接，请安装或启用扩展后重试"
      )
    }

    const requestId = randomUUID()
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Cookie export started, requestId=${requestId}`)
    return new Promise<{ cookies: CmbChromeCookie[]; skippedCookies: number }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.requestId !== requestId) return
          try {
            this.write(client, { requestId, type: "cancel-cookie-export" })
          } catch (error) {
            console.warn(
              `${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Failed to send export cancellation: ${error instanceof Error ? error.message : String(error)}`
            )
          }
          this.failPending(
            new BrowserCookieBridgeError("import_timeout", "Chrome Cookie 导出超时，请重试")
          )
        }, timeoutMs)
        this.pending = {
          bytes: 0,
          client,
          cookies: [],
          nextChunkIndex: 0,
          reject,
          requestId,
          resolve,
          started: false,
          timer
        }
        const request: CmbExportCookiesRequestMessage = {
          protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
          requestId,
          type: "export-cookies"
        }
        try {
          this.write(client, request)
        } catch (error) {
          this.failPending(error instanceof Error ? error : new Error(String(error)))
        }
      }
    )
  }

  private accept(socket: Socket): void {
    const client: BridgeClient = {
      authenticated: false,
      decoder: new NativeMessageDecoder(),
      socket
    }
    this.clients.add(client)
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Client connected, total=${this.clients.size}`)
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of client.decoder.push(chunk)) this.handleMessage(client, message)
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
        console.warn(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Message error from client: ${errorMsg}`)
        try {
          socket.end(
            encodeNativeMessage({
              connected: false,
              error: errorMsg,
              protocolVersion: CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION,
              type: "host-status"
            })
          )
        } catch {
          socket.destroy()
        }
        if (this.pending?.client === client) {
          this.failPending(
            new BrowserCookieBridgeError(
              "protocol_error",
              error instanceof Error ? error.message : String(error)
            )
          )
        }
      }
    })
    socket.once("close", () => {
      this.clients.delete(client)
      console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Client disconnected, remaining=${this.clients.size}`)
      if (this.pending?.client === client) {
        this.failPending(
          new BrowserCookieBridgeError("extension_not_connected", "Chrome 扩展在导入过程中断开")
        )
      }
    })
    socket.once("error", (error) => {
      console.warn(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Client socket error: ${error.message}`)
    })
  }

  private handleMessage(client: BridgeClient, value: unknown): void {
    const message = recordValue(value)
    if (!client.authenticated) {
      this.authenticate(client, message)
      return
    }

    switch (message.type) {
      case "extension-ready":
        this.handleReady(client, message)
        return
      case "cookie-export-begin":
        this.handleBegin(client, message)
        return
      case "cookie-export-chunk":
        this.handleChunk(client, message)
        return
      case "cookie-export-complete":
        this.handleComplete(client, message)
        return
      case "cookie-export-error":
        this.handleExportError(client, message)
        return
      default:
        throw new Error(`Unsupported cookie bridge message: ${String(message.type)}`)
    }
  }

  private authenticate(client: BridgeClient, message: Record<string, unknown>): void {
    if (message.type !== "native-host-hello") throw new Error("Native host hello is required")
    const hello = message as unknown as CmbNativeHostHelloMessage
    if (
      hello.origin !== CMB_CHROME_EXTENSION_ORIGIN ||
      hello.protocolVersion !== CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION ||
      typeof hello.secret !== "string" ||
      !stringsEqualSecurely(hello.secret, this.secret)
    ) {
      console.warn(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Client authentication failed`)
      throw new Error("Native host authentication failed")
    }
    client.authenticated = true
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Client authenticated`)
  }

  private handleReady(client: BridgeClient, message: Record<string, unknown>): void {
    if (
      message.protocolVersion !== CMB_CHROME_COOKIE_BRIDGE_PROTOCOL_VERSION ||
      typeof message.profileInstanceId !== "string" ||
      message.profileInstanceId.length > 128 ||
      typeof message.extensionVersion !== "string" ||
      message.extensionVersion.length > 64
    ) {
      throw new Error("Extension ready message is invalid")
    }
    client.ready = message as unknown as CmbChromeExtensionReadyMessage
    console.log(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Extension ready, version=${client.ready.extensionVersion}`)
  }

  private handleBegin(client: BridgeClient, message: Record<string, unknown>): void {
    const pending = this.requirePending(client, message.requestId)
    if (pending.started) throw new Error("Cookie export has already started")
    const total = message.total
    const skipped = message.skipped
    if (
      !Number.isInteger(total) ||
      (total as number) < 0 ||
      (total as number) > MAX_EXTENSION_IMPORT_COOKIES ||
      !Number.isSafeInteger(skipped) ||
      (skipped as number) < 0 ||
      (skipped as number) > 1_000_000
    ) {
      throw new Error("Cookie export total is invalid")
    }
    pending.started = true
    pending.expectedTotal = total as number
    pending.skipped = skipped as number
  }

  private handleChunk(client: BridgeClient, message: Record<string, unknown>): void {
    const pending = this.requirePending(client, message.requestId)
    if (!pending.started) throw new Error("Cookie export did not begin")
    if (message.index !== pending.nextChunkIndex || !Array.isArray(message.cookies)) {
      throw new Error("Cookie export chunk ordering is invalid")
    }
    const chunkBytes = Buffer.byteLength(JSON.stringify(message.cookies), "utf8")
    if (chunkBytes > MAX_EXTENSION_COOKIE_BATCH_BYTES) {
      throw new Error("Cookie export chunk exceeds the allowed size")
    }
    pending.bytes += chunkBytes
    pending.cookies.push(...(message.cookies as CmbChromeCookie[]))
    pending.nextChunkIndex += 1
    if (
      pending.bytes > MAX_EXTENSION_IMPORT_BYTES ||
      pending.cookies.length > MAX_EXTENSION_IMPORT_COOKIES ||
      (pending.expectedTotal !== undefined && pending.cookies.length > pending.expectedTotal)
    ) {
      throw new Error("Cookie export exceeds the allowed size")
    }
  }

  private handleComplete(client: BridgeClient, message: Record<string, unknown>): void {
    const pending = this.requirePending(client, message.requestId)
    if (
      !pending.started ||
      message.total !== pending.expectedTotal ||
      message.skipped !== pending.skipped ||
      pending.cookies.length !== pending.expectedTotal
    ) {
      throw new Error("Cookie export count does not match")
    }
    clearTimeout(pending.timer)
    this.pending = null
    console.log(
      `${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Cookie export complete, total=${pending.expectedTotal}, skipped=${pending.skipped}`
    )
    pending.resolve({ cookies: pending.cookies, skippedCookies: pending.skipped ?? 0 })
  }

  private handleExportError(client: BridgeClient, message: Record<string, unknown>): void {
    const pending = this.pending
    if (!pending || pending.client !== client) return
    if (message.requestId !== undefined && message.requestId !== pending.requestId) return
    const rawCode = typeof message.code === "string" ? message.code : "export_failed"
    const code: BrowserCookieBridgeErrorCode =
      rawCode === "permission_required" ? "permission_required" : "export_failed"
    const errorMessage =
      typeof message.message === "string" && message.message.length <= 1_000
        ? message.message
        : "Chrome Cookie 导出失败"
    console.warn(
      `${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Extension reported export error: code=${rawCode}, message=${errorMessage}`
    )
    this.failPending(new BrowserCookieBridgeError(code, errorMessage))
  }

  private requirePending(client: BridgeClient, requestId: unknown): PendingExport {
    if (!validRequestId(requestId) || !this.pending || this.pending.requestId !== requestId) {
      throw new Error("Cookie export request id is invalid")
    }
    if (this.pending.client !== client) throw new Error("Cookie export came from another profile")
    return this.pending
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (!pending) return
    console.warn(`${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} Cookie export failed: ${error.message}`)
    clearTimeout(pending.timer)
    this.pending = null
    pending.reject(error)
  }

  private write(client: BridgeClient, message: unknown): void {
    if (client.socket.destroyed) {
      throw new BrowserCookieBridgeError("extension_not_connected", "Chrome 扩展连接已关闭")
    }
    client.socket.write(encodeNativeMessage(message))
  }
}
