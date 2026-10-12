import { botSerializedFailureSchema } from "../../shared/bot-error-diagnostic"
import { createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { BOT_PROTOCOL_VERSION, BotDomainError } from "../../shared/bot-types"
import type { CoworkBotAPI, BotRpcMethod } from "../../shared/bot-api"
import { BOT_RPC_MAX_PENDING, decodeBotFrames, encodeBotFrame } from "./rpc"
import { botUpgradeAllows, type BotIdleRestartResult } from "./host-build"

const MAX_QUEUED_REQUESTS = 32
const MAX_QUEUED_BYTES = 16 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const busy = () => new BotDomainError("host_busy", "Bot 后台繁忙，本次请求尚未发出，请稍后重试")

export interface BotHostDescriptor {
  version: number
  pid: number
  hostId: string
  socketPath: string
  token: string
  buildId?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type QueuedRequest = PendingRequest & { id: string; frame: Buffer }
type Connection = {
  socket: Socket
  ready: Promise<void>
  pending: Map<string, PendingRequest>
  queue: QueuedRequest[]
  queuedBytes: number
  writeBlocked: boolean
}

export class BotTransportClient {
  upgradePending: string | null = null
  private connection?: Connection
  private readonly retiring = new Map<Socket, Promise<void>>()
  constructor(private readonly descriptor: BotHostDescriptor) {}

  /** A private authenticated connection for one bounded desktop file session. */
  openIsolatedConnection(): BotTransportClient {
    const isolated = new BotTransportClient({ ...this.descriptor })
    isolated.upgradePending = this.upgradePending
    return isolated
  }

  async connect(): Promise<void> {
    await this.connected()
  }

  private async connected(): Promise<Connection> {
    if (this.descriptor.version !== BOT_PROTOCOL_VERSION)
      throw new BotDomainError("protocol_version", "Bot 后台版本不兼容")
    if (this.connection?.socket.destroyed) this.disconnect(this.connection)
    let connection = this.connection
    if (!connection) {
      const created: Connection = {
        socket: createConnection(this.descriptor.socketPath),
        ready: Promise.resolve(),
        pending: new Map(),
        queue: [],
        queuedBytes: 0,
        writeBlocked: false
      }
      this.connection = connection = created
      created.ready = this.open(created).catch((error) => {
        this.disconnect(created)
        throw error
      })
    }
    await connection.ready
    if (this.connection !== connection || connection.socket.destroyed)
      throw new BotDomainError("host_disconnected", "Bot 后台连接已断开")
    return connection
  }

  private disconnect(connection: Connection): void {
    const { socket } = connection
    if (!socket.closed && !this.retiring.has(socket)) {
      const closed = new Promise<void>((resolve) => socket.once("close", resolve))
      this.retiring.set(socket, closed)
      void closed.then(() => this.retiring.delete(socket))
    }
    // A retired socket can deliver close/error after its replacement has
    // authenticated. Only its own requests and readiness may be invalidated.
    if (this.connection === connection) this.connection = undefined
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new BotDomainError("host_disconnected", "Bot 后台连接已断开"))
    }
    connection.pending.clear()
    for (const queued of connection.queue) {
      clearTimeout(queued.timer)
      queued.reject(new BotDomainError("host_disconnected", "Bot 后台连接已断开"))
    }
    connection.queue = []
    connection.queuedBytes = 0
    connection.socket.destroy()
  }

  private async open(connection: Connection): Promise<void> {
    const { socket } = connection
    socket.on("error", () => {})
    socket.on("close", () => this.disconnect(connection))
    socket.on("drain", () => {
      connection.writeBlocked = false
      this.drain(connection)
    })
    decodeBotFrames(socket, (value) => {
      const response = value as {
        id?: string
        ok?: boolean
        value?: unknown
        error?: unknown
      }
      const pending =
        typeof response.id === "string" ? connection.pending.get(response.id) : undefined
      if (!pending) {
        this.disconnect(connection)
        return
      }
      connection.pending.delete(response.id!)
      clearTimeout(pending.timer)
      if (response.ok === true) pending.resolve(response.value)
      else {
        const parsed = botSerializedFailureSchema.safeParse(response.error)
        pending.reject(
          parsed.success
            ? new BotDomainError(parsed.data.code, parsed.data.message, parsed.data.diagnostic)
            : new BotDomainError("invalid_error_packet", "Bot 后台错误响应无效，请重新连接")
        )
      }
      this.drain(connection)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error("Bot 后台连接超时"))
      }, 5000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.off("error", fail)
        socket.off("close", closed)
        socket.off("connect", connected)
      }
      const fail = (error: Error) => {
        cleanup()
        reject(error)
      }
      const closed = () => fail(new BotDomainError("host_disconnected", "Bot 后台连接已断开"))
      const connected = () => {
        cleanup()
        resolve()
      }
      socket.once("error", fail)
      socket.once("close", closed)
      socket.once("connect", connected)
    })
    await this.request(connection, { version: BOT_PROTOCOL_VERSION, token: this.descriptor.token })
  }

  private request(connection: Connection, input: Record<string, unknown>): Promise<unknown> {
    const { socket } = connection
    if (this.connection !== connection || socket.destroyed)
      return Promise.reject(new BotDomainError("host_disconnected", "Bot 后台未连接"))
    if (connection.queue.length >= MAX_QUEUED_REQUESTS) return Promise.reject(busy())
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      // Capture input once. Waiting must not change an operation's nonce or body.
      const frame = encodeBotFrame({ id, ...input })
      if (connection.queuedBytes + frame.byteLength > MAX_QUEUED_BYTES) {
        reject(busy())
        return
      }
      const timer = setTimeout(() => {
        const index = connection.queue.findIndex((item) => item.id === id)
        if (index < 0) return
        const [expired] = connection.queue.splice(index, 1)
        connection.queuedBytes -= expired.frame.byteLength
        // No bytes were sent; keep the other in-flight requests connected.
        reject(busy())
      }, REQUEST_TIMEOUT_MS)
      connection.queue.push({ id, frame, resolve, reject, timer })
      connection.queuedBytes += frame.byteLength
      this.drain(connection)
    })
  }

  private drain(connection: Connection): void {
    const { socket } = connection
    while (
      this.connection === connection &&
      !socket.destroyed &&
      !connection.writeBlocked &&
      connection.pending.size < BOT_RPC_MAX_PENDING &&
      connection.queue.length
    ) {
      const { id, frame, resolve, reject, timer: waiting } = connection.queue.shift()!
      connection.queuedBytes -= frame.byteLength
      clearTimeout(waiting)
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(new BotDomainError("host_timeout", "Bot 后台响应超时，请核对操作状态后重试"))
        this.disconnect(connection)
      }, REQUEST_TIMEOUT_MS)
      connection.pending.set(id, { resolve, reject, timer })
      try {
        connection.writeBlocked = !socket.write(frame)
      } catch (error) {
        clearTimeout(timer)
        connection.pending.delete(id)
        reject(error instanceof Error ? error : new Error("Bot 请求发送失败"))
        this.disconnect(connection)
      }
    }
  }

  async call<M extends BotRpcMethod>(
    method: M,
    ...args: Parameters<CoworkBotAPI[M]>
  ): Promise<Awaited<ReturnType<CoworkBotAPI[M]>>> {
    const connection = await this.connected()
    if (this.upgradePending && !botUpgradeAllows(method, args[0]))
      throw new BotDomainError("host_upgrade_pending", this.upgradePending)
    const result = await this.request(connection, {
      method,
      ...(args.length ? { input: args[0] } : {})
    })
    if (method === "status" && this.upgradePending && result && typeof result === "object")
      return {
        ...result,
        error: ("error" in result ? result.error : null) ?? this.upgradePending
      } as Awaited<ReturnType<CoworkBotAPI[M]>>
    // The authenticated, version-matched Host implements this shared API contract.
    return result as Awaited<ReturnType<CoworkBotAPI[M]>>
  }

  async restartIfIdle(expectedHostId: string): Promise<BotIdleRestartResult> {
    const connection = await this.connected()
    const result = await this.request(connection, {
      method: "__restartIfIdle",
      input: { hostId: expectedHostId }
    })
    if (
      !result ||
      typeof result !== "object" ||
      !("accepted" in result) ||
      typeof result.accepted !== "boolean" ||
      !("reason" in result) ||
      (result.reason !== null && typeof result.reason !== "string")
    )
      throw new BotDomainError("invalid_response", "后台返回了无效的版本切换结果")
    return { accepted: result.accepted, reason: result.reason }
  }

  /** Join physical socket closure before releasing a native maintenance barrier. */
  async closeAndWait(): Promise<void> {
    if (this.connection) this.disconnect(this.connection)
    await Promise.all(this.retiring.values())
  }

  close(): void {
    if (this.connection) this.disconnect(this.connection)
  }
}
