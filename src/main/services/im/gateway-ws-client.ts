import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import {
  ImGatewayContractError,
  assertRemoteImEventV1,
  type RemoteImAckV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"
import type {
  BuiltinRobotConnectionState,
  BuiltinRobotRouteStatus,
  BuiltinRobotTakeoverRequest,
  BuiltinRobotTakeoverResult
} from "../../types"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "./gateway-client"
import type { ImEventRecord } from "./event-store"

const CONNECT_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 15_000
const RECONNECT_MAX_MS = 60_000
const MAX_FRAME_BYTES = 64 * 1024
const PERMANENT_REPLY_REASON_CODES = new Set([
  "PRINCIPAL_MISMATCH",
  "INVALID_PAYLOAD",
  "ROUTE_NOT_FOUND",
  "ROUTE_EPOCH_CONFLICT",
  "ROUTE_OWNED_BY_OTHER_DEVICE",
  "DEVICE_REVOKED",
  "REPLY_IDEMPOTENCY_CONFLICT",
  "SEGMENT_INVALID",
  "OUTBOX_INCOMPLETE",
  "PLATFORM_PERMANENT_FAILURE"
])

interface GatewayEnvelope {
  schemaVersion: 1
  type: string
  messageId?: string
  commandId?: string
  sentAt: string
  payload: Record<string, unknown>
}

export interface ImGatewayWsStatus {
  connectionState: BuiltinRobotConnectionState
  authenticationFailed: boolean
  sessionId: string | null
  principalId: string | null
  lastConnectedAt: string | null
  lastError: string | null
  routes: BuiltinRobotRouteStatus[]
}

export interface ImGatewayWsClientOptions {
  url: () => string | null
  token: () => string | null
  deviceId: string
  deviceName: string
  appVersion: string
  capabilities?: string[]
  onRemoteEvent: (event: RemoteImEventV1) => void | Promise<void>
  onLeaseRevoked?: (payload: Record<string, unknown>) => void | Promise<void>
  onStatusChange?: (status: ImGatewayWsStatus) => void
  now?: () => number
}

interface PendingCommand<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ImGatewayCommandError extends Error {
  reasonCode?: string
  resultUnknown?: boolean
  permanent?: boolean

  constructor(
    message: string,
    options: { reasonCode?: string; resultUnknown?: boolean; permanent?: boolean } = {}
  ) {
    super(message)
    this.name = "ImGatewayCommandError"
    Object.assign(this, options)
  }
}

class ImGatewayProtocolError extends Error {}
class ImGatewaySessionError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ImGatewayProtocolError(`${label} has unknown fields`)
  }
}

function gatewayUrlAllowed(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === "wss:") return true
    return (
      parsed.protocol === "ws:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]")
    )
  } catch {
    return false
  }
}

export class ImGatewayWsClient implements ImGatewayClientPort {
  private socket: WebSocket | null = null
  private stopped = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private connectionGeneration = 0
  private helloCommandId: string | null = null
  private syncCommandId: string | null = null
  private readonly permitCommands = new Map<string, PendingCommand<ImExecutionPermitResult>>()
  private readonly permitCommandByEvent = new Map<string, string>()
  private readonly replyCommands = new Map<string, PendingCommand<ImReplySubmissionResult>>()
  private readonly replyCommandByIdempotencyKey = new Map<string, string>()
  private readonly takeoverCommands = new Map<string, PendingCommand<BuiltinRobotTakeoverResult>>()
  private readonly takeoverCommandByConversation = new Map<string, string>()
  private readonly now: () => number
  private status: ImGatewayWsStatus = {
    connectionState: "offline",
    authenticationFailed: false,
    sessionId: null,
    principalId: null,
    lastConnectedAt: null,
    lastError: null,
    routes: []
  }

  constructor(private readonly options: ImGatewayWsClientOptions) {
    this.now = options.now ?? Date.now
  }

  getStatus(): ImGatewayWsStatus {
    return { ...this.status, routes: this.status.routes.map((route) => ({ ...route })) }
  }

  isAuthenticated(): boolean {
    return this.status.connectionState === "online" && Boolean(this.status.sessionId)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.connectionGeneration += 1
    this.helloCommandId = null
    this.syncCommandId = null
    this.clearTimers()
    this.rejectPending(
      new ImGatewayCommandError("统一机器人连接已断开", { reasonCode: "DEVICE_OFFLINE" })
    )
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "client disconnect")
    this.updateStatus({
      connectionState: "offline",
      sessionId: null,
      principalId: null,
      routes: []
    })
  }

  reconnect(): void {
    this.stop()
    this.stopped = false
    this.reconnectAttempt = 0
    this.connect()
  }

  async sendAcknowledgement(ack: RemoteImAckV1): Promise<void> {
    this.sendCommand("EVENT_ACK", ack as unknown as Record<string, unknown>)
  }

  acquireExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult> {
    return this.requestPermit("EXECUTION_PERMIT_ACQUIRE", event)
  }

  renewExecutionPermit(event: ImEventRecord): Promise<ImExecutionPermitResult> {
    return this.requestPermit("EXECUTION_PERMIT_RENEW", event)
  }

  submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult> {
    if (this.replyCommandByIdempotencyKey.has(reply.idempotencyKey)) {
      return Promise.reject(
        new ImGatewayCommandError("同一回复正在等待网关确认", {
          reasonCode: "REPLY_IDEMPOTENCY_CONFLICT"
        })
      )
    }
    return new Promise<ImReplySubmissionResult>((resolve, reject) => {
      const commandId = randomUUID()
      const timer = setTimeout(() => {
        this.replyCommands.delete(commandId)
        this.replyCommandByIdempotencyKey.delete(reply.idempotencyKey)
        reject(
          new ImGatewayCommandError("网关回复确认超时", {
            reasonCode: "GATEWAY_REPLY_TIMEOUT"
          })
        )
      }, COMMAND_TIMEOUT_MS)
      this.replyCommands.set(commandId, { resolve, reject, timer })
      this.replyCommandByIdempotencyKey.set(reply.idempotencyKey, commandId)
      try {
        this.sendCommand("REMOTE_REPLY", reply as unknown as Record<string, unknown>, commandId)
      } catch (error) {
        clearTimeout(timer)
        this.replyCommands.delete(commandId)
        this.replyCommandByIdempotencyKey.delete(reply.idempotencyKey)
        reject(error instanceof Error ? error : new Error("无法发送远程回复"))
      }
    })
  }

  requestTakeover(request: BuiltinRobotTakeoverRequest): Promise<BuiltinRobotTakeoverResult> {
    if (this.takeoverCommandByConversation.has(request.conversationKey)) {
      return Promise.reject(new ImGatewayCommandError("该会话已有接管请求正在处理"))
    }
    return new Promise<BuiltinRobotTakeoverResult>((resolve, reject) => {
      const commandId = randomUUID()
      const timer = setTimeout(() => {
        this.takeoverCommands.delete(commandId)
        this.takeoverCommandByConversation.delete(request.conversationKey)
        reject(new ImGatewayCommandError("接管请求超时", { resultUnknown: true }))
      }, COMMAND_TIMEOUT_MS)
      this.takeoverCommands.set(commandId, { resolve, reject, timer })
      this.takeoverCommandByConversation.set(request.conversationKey, commandId)
      try {
        this.sendCommand(
          "ROUTE_TAKEOVER_REQUEST",
          {
            conversationKey: request.conversationKey,
            expectedEpoch: request.expectedDeviceEpoch,
            mode: request.mode === "force" ? "FORCE" : "NORMAL"
          },
          commandId
        )
      } catch (error) {
        clearTimeout(timer)
        this.takeoverCommands.delete(commandId)
        this.takeoverCommandByConversation.delete(request.conversationKey)
        reject(error instanceof Error ? error : new Error("无法发送接管请求"))
      }
    })
  }

  private requestPermit(
    type: "EXECUTION_PERMIT_ACQUIRE" | "EXECUTION_PERMIT_RENEW",
    event: ImEventRecord
  ): Promise<ImExecutionPermitResult> {
    if (this.permitCommandByEvent.has(event.eventId)) {
      return Promise.resolve({ status: "denied", reasonCode: "PERMIT_DENIED" })
    }
    return new Promise<ImExecutionPermitResult>((resolve, reject) => {
      const commandId = randomUUID()
      const timer = setTimeout(() => {
        this.permitCommands.delete(commandId)
        this.permitCommandByEvent.delete(event.eventId)
        resolve({ status: "denied", reasonCode: "DEVICE_OFFLINE" })
      }, COMMAND_TIMEOUT_MS)
      this.permitCommands.set(commandId, { resolve, reject, timer })
      this.permitCommandByEvent.set(event.eventId, commandId)
      try {
        this.sendCommand(
          type,
          {
            eventId: event.eventId,
            lastLeaseId: event.leaseId,
            deviceEpoch: event.deviceEpoch
          },
          commandId
        )
      } catch {
        clearTimeout(timer)
        this.permitCommands.delete(commandId)
        this.permitCommandByEvent.delete(event.eventId)
        resolve({ status: "denied", reasonCode: "DEVICE_OFFLINE" })
      }
    })
  }

  private connect(): void {
    if (this.stopped) return
    const generation = ++this.connectionGeneration
    this.helloCommandId = null
    this.syncCommandId = null
    const url = this.options.url()?.trim()
    const token = this.options.token()?.trim()
    if (!url || !token) {
      this.updateStatus({
        connectionState: "error",
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: !token ? "企业身份尚未完成，无法连接统一机器人。" : "统一机器人网关地址未配置。"
      })
      return
    }
    if (!gatewayUrlAllowed(url)) {
      this.updateStatus({
        connectionState: "error",
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: "统一机器人网关必须使用 WSS（仅本机调试允许 WS）。"
      })
      return
    }
    this.updateStatus({
      connectionState: "connecting",
      authenticationFailed: false,
      lastError: null,
      sessionId: null,
      principalId: null,
      routes: []
    })
    let socket: WebSocket
    try {
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES
      })
    } catch {
      this.failConnection("无法建立统一机器人连接。")
      return
    }
    this.socket = socket
    this.connectTimer = setTimeout(() => {
      if (
        this.connectionGeneration === generation &&
        this.socket === socket &&
        this.status.connectionState !== "online"
      ) {
        socket.terminate()
      }
    }, CONNECT_TIMEOUT_MS)
    socket.on("open", () => {
      if (this.connectionGeneration !== generation || this.socket !== socket) {
        socket.close(1000, "stale connection")
        return
      }
      this.helloCommandId = this.sendEnvelope("HELLO", {
        deviceId: this.options.deviceId,
        deviceName: this.options.deviceName,
        appVersion: this.options.appVersion,
        capabilities: this.options.capabilities ?? ["inbox", "feature", "scheduler", "hitl"]
      })
    })
    socket.on("message", (data) => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      if (Buffer.byteLength(data as Buffer) > MAX_FRAME_BYTES) {
        socket.close(1009, "frame too large")
        return
      }
      this.handleMessage(String(data)).catch((error) => {
        if (this.connectionGeneration !== generation || this.socket !== socket) return
        const invalidPayload =
          error instanceof SyntaxError ||
          error instanceof ImGatewayProtocolError ||
          error instanceof ImGatewayContractError
        socket.close(
          invalidPayload ? 1007 : 1011,
          invalidPayload ? "invalid payload" : "processing failed"
        )
      })
    })
    socket.on("error", () => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      if (this.status.authenticationFailed) return
      this.updateStatus({ lastError: "统一机器人连接异常。" })
    })
    socket.on("unexpected-response", (_request, response) => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      const authenticationFailed = response.statusCode === 401 || response.statusCode === 403
      this.updateStatus({
        connectionState: "error",
        authenticationFailed,
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: authenticationFailed
          ? "企业身份认证失败，请重新登录。"
          : `统一机器人网关拒绝连接（${response.statusCode}）。`
      })
      socket.terminate()
    })
    socket.on("close", () => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      this.socket = null
      this.helloCommandId = null
      this.syncCommandId = null
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = undefined
      this.stopHeartbeat()
      this.rejectPending(
        new ImGatewayCommandError("统一机器人连接已中断", { reasonCode: "DEVICE_OFFLINE" })
      )
      if (this.stopped) return
      if (this.status.authenticationFailed) {
        this.updateStatus({
          connectionState: "error",
          sessionId: null,
          principalId: null,
          routes: []
        })
        return
      }
      this.updateStatus({
        connectionState: "offline",
        sessionId: null,
        principalId: null,
        routes: []
      })
      this.scheduleReconnect()
    })
  }

  private async handleMessage(raw: string): Promise<void> {
    const parsed = record(JSON.parse(raw))
    const payload = record(parsed?.payload)
    const type = nonEmptyString(parsed?.type)
    const commandId = nonEmptyString(parsed?.commandId)
    const messageId = nonEmptyString(parsed?.messageId)
    const sentAt = nonEmptyString(parsed?.sentAt)
    if (
      parsed?.schemaVersion !== 1 ||
      !payload ||
      !type ||
      !sentAt ||
      !Number.isFinite(Date.parse(sentAt))
    ) {
      throw new ImGatewayProtocolError("Invalid gateway envelope")
    }
    assertOnlyKeys(
      parsed,
      ["schemaVersion", "type", "commandId", "messageId", "sentAt", "payload"],
      "Gateway envelope"
    )
    switch (type) {
      case "WELCOME": {
        assertOnlyKeys(
          payload,
          ["sessionId", "principalId", "serverTime", "heartbeatIntervalSeconds"],
          "WELCOME payload"
        )
        if (!commandId || commandId !== this.helloCommandId) {
          throw new ImGatewayProtocolError("WELCOME correlation does not match")
        }
        this.helloCommandId = null
        const sessionId = nonEmptyString(payload.sessionId)
        const principalId = nonEmptyString(payload.principalId)
        const serverTime = nonEmptyString(payload.serverTime)
        const heartbeatIntervalSeconds = positiveInteger(payload.heartbeatIntervalSeconds)
        if (
          !sessionId ||
          !principalId ||
          !serverTime ||
          !Number.isFinite(Date.parse(serverTime)) ||
          !heartbeatIntervalSeconds ||
          heartbeatIntervalSeconds < 5 ||
          heartbeatIntervalSeconds > 300
        ) {
          throw new ImGatewayProtocolError("WELCOME payload is invalid")
        }
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.connectTimer = undefined
        this.reconnectAttempt = 0
        this.updateStatus({
          connectionState: "online",
          authenticationFailed: false,
          sessionId,
          principalId,
          lastConnectedAt: new Date(this.now()).toISOString(),
          lastError: null
        })
        this.startHeartbeat(heartbeatIntervalSeconds)
        this.syncCommandId = this.sendCommand("SYNC_REQUEST", {})
        return
      }
      case "REMOTE_EVENT": {
        if (!messageId) throw new ImGatewayProtocolError("REMOTE_EVENT missing messageId")
        assertOnlyKeys(payload, ["event"], "REMOTE_EVENT payload")
        const event = record(payload.event) as unknown
        assertRemoteImEventV1(event)
        await this.options.onRemoteEvent(event)
        return
      }
      case "PERMIT_RESULT":
        this.resolvePermit(payload, commandId)
        return
      case "REPLY_ACCEPTED":
      case "REPLY_RESULT":
        this.resolveReply(payload, commandId)
        return
      case "TAKEOVER_RESULT":
        this.resolveTakeover(payload, commandId)
        return
      case "SYNC_STATE":
        if (!commandId || commandId !== this.syncCommandId) {
          throw new ImGatewayProtocolError("SYNC_STATE correlation does not match")
        }
        this.syncCommandId = null
        this.updateRoutes(payload)
        return
      case "LEASE_REVOKED":
        if (!messageId) throw new ImGatewayProtocolError("LEASE_REVOKED missing messageId")
        assertOnlyKeys(payload, ["eventId", "reasonCode"], "LEASE_REVOKED payload")
        if (!nonEmptyString(payload.eventId) || !nonEmptyString(payload.reasonCode)) {
          throw new ImGatewayProtocolError("LEASE_REVOKED payload is invalid")
        }
        await this.options.onLeaseRevoked?.(payload)
        return
      case "ERROR":
        this.resolveError(payload, commandId)
        return
      default:
        throw new ImGatewayProtocolError("Gateway message type is unsupported")
    }
  }

  private resolvePermit(payload: Record<string, unknown>, commandId: string | null): void {
    const eventId = nonEmptyString(payload.eventId)
    if (!eventId || !commandId) {
      throw new ImGatewayProtocolError("Permit result is missing correlation fields")
    }
    const pending = this.permitCommands.get(commandId)
    if (!pending) return
    if (this.permitCommandByEvent.get(eventId) !== commandId) {
      throw new ImGatewayProtocolError("Permit result correlation does not match")
    }
    const status = String(payload.status ?? "").toUpperCase()
    if (status !== "GRANTED" && status !== "DENIED") {
      throw new ImGatewayProtocolError("Permit result has an invalid status")
    }
    const leaseId = nonEmptyString(payload.leaseId)
    const expiresAt = nonEmptyString(payload.expiresAt)
    assertOnlyKeys(
      payload,
      status === "GRANTED"
        ? ["eventId", "status", "leaseId", "expiresAt"]
        : ["eventId", "status", "reasonCode"],
      "PERMIT_RESULT payload"
    )
    if (
      status === "GRANTED" &&
      (!leaseId || !expiresAt || !Number.isFinite(Date.parse(expiresAt)))
    ) {
      throw new ImGatewayProtocolError("Granted permit is missing lease fields")
    }
    if (status === "DENIED" && !nonEmptyString(payload.reasonCode)) {
      throw new ImGatewayProtocolError("Denied permit is missing reasonCode")
    }
    clearTimeout(pending.timer)
    this.permitCommands.delete(commandId)
    if (this.permitCommandByEvent.get(eventId) === commandId) {
      this.permitCommandByEvent.delete(eventId)
    }
    pending.resolve(
      status === "GRANTED"
        ? {
            status: "granted",
            leaseId: leaseId!,
            expiresAt: expiresAt!
          }
        : {
            status: "denied",
            reasonCode: nonEmptyString(payload.reasonCode) ?? "PERMIT_DENIED"
          }
    )
  }

  private resolveReply(payload: Record<string, unknown>, commandId: string | null): void {
    const idempotencyKey = nonEmptyString(payload.idempotencyKey)
    if (!commandId || !idempotencyKey) {
      throw new ImGatewayProtocolError("Reply result is missing correlation fields")
    }
    const pending = this.replyCommands.get(commandId)
    if (!pending) return
    if (this.replyCommandByIdempotencyKey.get(idempotencyKey) !== commandId) {
      throw new ImGatewayProtocolError("Reply result correlation does not match")
    }
    const deliveryId = nonEmptyString(payload.deliveryId)
    const segmentIndex = Number.isSafeInteger(payload.segmentIndex)
      ? Number(payload.segmentIndex)
      : -1
    if (!deliveryId || segmentIndex < 0 || segmentIndex > 7) {
      throw new ImGatewayProtocolError("Reply result payload is invalid")
    }
    const state = String(payload.state ?? "").toUpperCase()
    if (state !== "ACCEPTED" && state !== "UNKNOWN" && state !== "PLATFORM_UNKNOWN") {
      throw new ImGatewayProtocolError("Reply result has an invalid state")
    }
    assertOnlyKeys(
      payload,
      state === "ACCEPTED"
        ? ["deliveryId", "idempotencyKey", "segmentIndex", "state", "platformReplyId"]
        : ["deliveryId", "idempotencyKey", "segmentIndex", "state"],
      "REPLY_RESULT payload"
    )
    if (payload.platformReplyId !== undefined && !nonEmptyString(payload.platformReplyId)) {
      throw new ImGatewayProtocolError("Reply result platformReplyId is invalid")
    }
    clearTimeout(pending.timer)
    this.replyCommands.delete(commandId)
    if (this.replyCommandByIdempotencyKey.get(idempotencyKey) === commandId) {
      this.replyCommandByIdempotencyKey.delete(idempotencyKey)
    }
    pending.resolve(
      state === "UNKNOWN" || state === "PLATFORM_UNKNOWN"
        ? { state: "platform_unknown" }
        : {
            state: "accepted",
            platformReplyId: nonEmptyString(payload.platformReplyId) ?? undefined
          }
    )
  }

  private resolveTakeover(payload: Record<string, unknown>, commandId: string | null): void {
    const conversationKey = nonEmptyString(payload.conversationKey)
    if (!conversationKey || !commandId) {
      throw new ImGatewayProtocolError("Takeover result is missing correlation fields")
    }
    const pending = this.takeoverCommands.get(commandId)
    if (!pending) return
    if (this.takeoverCommandByConversation.get(conversationKey) !== commandId) {
      throw new ImGatewayProtocolError("Takeover result correlation does not match")
    }
    const status = String(payload.status ?? "").toUpperCase()
    if (status !== "SUCCESS" && status !== "FAILED") {
      throw new ImGatewayProtocolError("Takeover result has an invalid status")
    }
    const previousDeviceEpoch = positiveInteger(payload.previousDeviceEpoch)
    const deviceEpoch = positiveInteger(payload.deviceEpoch)
    const principalId = nonEmptyString(payload.principalId)
    const success = status === "SUCCESS"
    assertOnlyKeys(
      payload,
      success
        ? ["conversationKey", "principalId", "previousDeviceEpoch", "deviceEpoch", "status"]
        : ["conversationKey", "previousDeviceEpoch", "status", "reasonCode", "message"],
      "TAKEOVER_RESULT payload"
    )
    if (
      !previousDeviceEpoch ||
      (success && (!deviceEpoch || deviceEpoch <= previousDeviceEpoch || !principalId)) ||
      (!success && !nonEmptyString(payload.reasonCode))
    ) {
      throw new ImGatewayProtocolError("Takeover result payload is invalid")
    }
    clearTimeout(pending.timer)
    this.takeoverCommands.delete(commandId)
    if (this.takeoverCommandByConversation.get(conversationKey) === commandId) {
      this.takeoverCommandByConversation.delete(conversationKey)
    }
    const result: BuiltinRobotTakeoverResult = {
      success,
      conversationKey,
      ...(principalId ? { principalId } : {}),
      previousDeviceEpoch,
      ...(deviceEpoch ? { deviceEpoch } : {}),
      ...(nonEmptyString(payload.reasonCode) ? { reasonCode: String(payload.reasonCode) } : {}),
      ...(nonEmptyString(payload.message) ? { message: String(payload.message) } : {})
    }
    if (result.success && result.deviceEpoch) {
      const principalId = result.principalId ?? this.status.principalId
      if (!principalId) {
        throw new ImGatewayProtocolError("Takeover result is missing authenticated principalId")
      }
      const route: BuiltinRobotRouteStatus = {
        principalId,
        conversationKey,
        deviceEpoch: result.deviceEpoch,
        state: "active",
        deviceId: this.options.deviceId,
        deviceName: this.options.deviceName,
        ownedByCurrentDevice: true
      }
      this.updateStatus({
        routes: [
          route,
          ...this.status.routes.filter((item) => item.conversationKey !== conversationKey)
        ]
      })
    }
    pending.resolve(result)
  }

  private updateRoutes(payload: Record<string, unknown>): void {
    assertOnlyKeys(payload, ["routes"], "SYNC_STATE payload")
    const routes = Array.isArray(payload.routes) ? payload.routes : []
    if (!Array.isArray(payload.routes)) {
      throw new ImGatewayProtocolError("SYNC_STATE routes are missing")
    }
    const normalized: BuiltinRobotRouteStatus[] = []
    for (const value of routes) {
      const route = record(value)
      const conversationKey = nonEmptyString(route?.conversationKey)
      const principalId = nonEmptyString(route?.principalId)
      const deviceEpoch = positiveInteger(route?.deviceEpoch)
      const deviceId = nonEmptyString(route?.deviceId)
      if (!route || !principalId || !conversationKey || !deviceEpoch || !deviceId) {
        throw new ImGatewayProtocolError("SYNC_STATE route is invalid")
      }
      assertOnlyKeys(
        route,
        ["principalId", "conversationKey", "deviceEpoch", "state", "deviceId", "deviceName"],
        "SYNC_STATE route"
      )
      const stateValue = String(route.state ?? "active").toLowerCase()
      if (stateValue !== "active" && stateValue !== "suspended" && stateValue !== "revoked") {
        throw new ImGatewayProtocolError("SYNC_STATE route state is invalid")
      }
      const state = stateValue
      if (!this.status.principalId || principalId !== this.status.principalId) {
        throw new ImGatewayProtocolError("SYNC_STATE route principal does not match WELCOME")
      }
      const deviceName =
        route.deviceName === undefined ? undefined : nonEmptyString(route.deviceName)
      if (route.deviceName !== undefined && !deviceName) {
        throw new ImGatewayProtocolError("SYNC_STATE route deviceName is invalid")
      }
      normalized.push({
        principalId,
        conversationKey,
        deviceEpoch,
        state,
        deviceId,
        ...(deviceName ? { deviceName } : {}),
        ownedByCurrentDevice: deviceId === this.options.deviceId
      })
    }
    this.updateStatus({ routes: normalized })
  }

  private resolveError(payload: Record<string, unknown>, commandId: string | null): void {
    assertOnlyKeys(
      payload,
      ["reasonCode", "message", "eventId", "idempotencyKey", "conversationKey", "expectedEpoch"],
      "ERROR payload"
    )
    const reasonCode = nonEmptyString(payload.reasonCode)
    if (!reasonCode) throw new ImGatewayProtocolError("ERROR payload is missing reasonCode")
    const eventId = nonEmptyString(payload.eventId)
    const permitPending = commandId ? this.permitCommands.get(commandId) : undefined
    if (permitPending) {
      if (!eventId || this.permitCommandByEvent.get(eventId) !== commandId) {
        throw new ImGatewayProtocolError("Permit error correlation does not match")
      }
      clearTimeout(permitPending.timer)
      this.permitCommands.delete(commandId)
      this.permitCommandByEvent.delete(eventId)
      permitPending.resolve({ status: "denied", reasonCode })
      return
    }
    const idempotencyKey = nonEmptyString(payload.idempotencyKey)
    const replyPending = commandId ? this.replyCommands.get(commandId) : undefined
    if (replyPending) {
      if (!idempotencyKey || this.replyCommandByIdempotencyKey.get(idempotencyKey) !== commandId) {
        throw new ImGatewayProtocolError("Reply error correlation does not match")
      }
      clearTimeout(replyPending.timer)
      this.replyCommands.delete(commandId)
      this.replyCommandByIdempotencyKey.delete(idempotencyKey)
      replyPending.reject(
        new ImGatewayCommandError("网关拒绝回复", {
          reasonCode,
          resultUnknown: reasonCode === "PLATFORM_RESULT_UNKNOWN",
          permanent: PERMANENT_REPLY_REASON_CODES.has(reasonCode)
        })
      )
      return
    }
    const conversationKey = nonEmptyString(payload.conversationKey)
    const takeoverPending = commandId ? this.takeoverCommands.get(commandId) : undefined
    if (takeoverPending) {
      if (
        !conversationKey ||
        this.takeoverCommandByConversation.get(conversationKey) !== commandId
      ) {
        throw new ImGatewayProtocolError("Takeover error correlation does not match")
      }
      clearTimeout(takeoverPending.timer)
      this.takeoverCommands.delete(commandId)
      this.takeoverCommandByConversation.delete(conversationKey)
      takeoverPending.resolve({
        success: false,
        conversationKey,
        previousDeviceEpoch: positiveInteger(payload.expectedEpoch) ?? 1,
        reasonCode,
        message: nonEmptyString(payload.message) ?? "网关拒绝接管请求"
      })
      return
    }
    if (commandId && (commandId === this.helloCommandId || commandId === this.syncCommandId)) {
      this.helloCommandId = null
      this.syncCommandId = null
      this.updateStatus({ connectionState: "error", lastError: `网关拒绝请求：${reasonCode}` })
      throw new ImGatewaySessionError("Gateway rejected a session command")
    }
    if (commandId) return
    this.updateStatus({ connectionState: "error", lastError: `网关拒绝请求：${reasonCode}` })
    throw new ImGatewaySessionError("Gateway reported an uncorrelated session error")
  }

  private sendCommand(
    type: string,
    payload: Record<string, unknown>,
    commandId = randomUUID()
  ): string {
    if (!this.isAuthenticated()) throw new ImGatewayCommandError("统一机器人当前未连接")
    return this.sendEnvelope(type, payload, commandId)
  }

  private sendEnvelope(
    type: string,
    payload: Record<string, unknown>,
    commandId = randomUUID()
  ): string {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new ImGatewayCommandError("统一机器人当前未连接")
    }
    const envelope: GatewayEnvelope = {
      schemaVersion: 1,
      type,
      commandId,
      sentAt: new Date(this.now()).toISOString(),
      payload
    }
    socket.send(JSON.stringify(envelope))
    return commandId
  }

  private startHeartbeat(intervalSeconds: number): void {
    this.stopHeartbeat()
    const intervalMs = Math.max(5_000, intervalSeconds * 1_000)
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAuthenticated()) return
      try {
        this.sendCommand("HEARTBEAT", {
          deviceId: this.options.deviceId,
          sessionId: this.status.sessionId
        })
      } catch {
        this.socket?.terminate()
      }
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(this.reconnectAttempt, 6))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  private failConnection(message: string): void {
    this.updateStatus({
      connectionState: "error",
      sessionId: null,
      principalId: null,
      routes: [],
      lastError: message
    })
    this.scheduleReconnect()
  }

  private updateStatus(patch: Partial<ImGatewayWsStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.onStatusChange?.(this.getStatus())
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.reconnectTimer = undefined
    this.connectTimer = undefined
    this.stopHeartbeat()
  }

  private rejectPending(error: Error): void {
    for (const pending of [
      ...this.permitCommands.values(),
      ...this.replyCommands.values(),
      ...this.takeoverCommands.values()
    ]) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.permitCommands.clear()
    this.permitCommandByEvent.clear()
    this.replyCommands.clear()
    this.replyCommandByIdempotencyKey.clear()
    this.takeoverCommands.clear()
    this.takeoverCommandByConversation.clear()
  }
}
