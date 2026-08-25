import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import {
  ImGatewayContractError,
  assertRemoteImEventV1,
  type RemoteImAckV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"
import type { BuiltinRobotConnectionState, BuiltinRobotRouteStatus } from "../../types"
import type {
  ImExecutionPermitResult,
  ImGatewayClientPort,
  ImReplySubmissionResult
} from "./gateway-client"
import { isImGatewayUrlAllowed } from "./gateway-url"
import type { ImEventRecord } from "./event-store"

const CONNECT_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 15_000
const RECONNECT_MAX_MS = 60_000
const MAX_FRAME_BYTES = 64 * 1024
const AUTHENTICATION_REFRESH_SKEW_MS = 5 * 60_000
const MAX_TIMER_DELAY_MS = 2_147_000_000
const DEFAULT_ROUTE_SYNC_EXTENSION = "sync-default-route-v1"
const PERMANENT_REPLY_REASON_CODES = new Set([
  "PRINCIPAL_MISMATCH",
  "INVALID_PAYLOAD",
  "ROUTE_NOT_FOUND",
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
  lastHandshakeStatus: number | null
  lastCloseCode: number | null
  lastCloseReason: string | null
  lastTransportError: string | null
  reconnectAttempt: number
  routes: BuiltinRobotRouteStatus[]
}

export interface ImGatewayWsClientOptions {
  url: () => string | null
  token: () => string | null
  appVersion: string
  capabilities?: string[]
  onRemoteEvent: (event: RemoteImEventV1) => void | Promise<void>
  onLeaseRevoked?: (payload: Record<string, unknown>) => void | Promise<void>
  onAuthenticationRequired?: (rejectedToken: string) => boolean | Promise<boolean>
  onRoutesSynchronized?: (
    routes: readonly BuiltinRobotRouteStatus[],
    principalId: string,
    defaultConversationKey: string | null
  ) => void | Promise<void>
  isProactiveRouteConfirmed?: (conversationKey: string, principalId: string) => boolean
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

function diagnosticText(value: string, limit = 240): string | null {
  const text = value.trim()
  if (!text) return null
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>")
    .slice(0, limit)
}

function diagnosticCloseReason(value: Buffer): string | null {
  return diagnosticText(value.toString("utf8"), 160)
}

function jwtExpiresAtMs(token: string): number | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    const payload = record(JSON.parse(Buffer.from(padded, "base64").toString("utf8")))
    const expiresAtSeconds = payload?.exp
    if (typeof expiresAtSeconds !== "number" || !Number.isFinite(expiresAtSeconds)) return null
    const expiresAtMs = expiresAtSeconds * 1_000
    return Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null
  } catch {
    return null
  }
}

export class ImGatewayWsClient implements ImGatewayClientPort {
  private socket: WebSocket | null = null
  private stopped = true
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private authenticationRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private connectionGeneration = 0
  private connectionToken: string | null = null
  private reconnectBlocked = false
  private authenticationRefreshInFlight = false
  private authenticationRefreshAttempted = false
  private helloCommandId: string | null = null
  private syncCommandId: string | null = null
  private readonly permitCommands = new Map<string, PendingCommand<ImExecutionPermitResult>>()
  private readonly permitCommandByEvent = new Map<string, string>()
  private readonly replyCommands = new Map<string, PendingCommand<ImReplySubmissionResult>>()
  private readonly replyCommandByIdempotencyKey = new Map<string, string>()
  private readonly now: () => number
  private status: ImGatewayWsStatus = {
    connectionState: "offline",
    authenticationFailed: false,
    sessionId: null,
    principalId: null,
    lastConnectedAt: null,
    lastError: null,
    lastHandshakeStatus: null,
    lastCloseCode: null,
    lastCloseReason: null,
    lastTransportError: null,
    reconnectAttempt: 0,
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
    this.connectionToken = null
    this.authenticationRefreshInFlight = false
    this.authenticationRefreshAttempted = false
    this.helloCommandId = null
    this.syncCommandId = null
    this.clearTimers()
    this.rejectPending(
      new ImGatewayCommandError("统一机器人连接已断开", { reasonCode: "DESKTOP_OFFLINE" })
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
    this.reconnectBlocked = false
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
    const principalId = this.status.principalId
    if (
      !reply.eventId &&
      (!this.isAuthenticated() ||
        !principalId ||
        this.options.isProactiveRouteConfirmed?.(reply.conversationKey, principalId) === false)
    ) {
      return Promise.reject(
        new ImGatewayCommandError("统一机器人正在同步会话路由", {
          reasonCode: "ROUTE_SYNC_PENDING"
        })
      )
    }
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
        resolve({ status: "denied", reasonCode: "DESKTOP_OFFLINE" })
      }, COMMAND_TIMEOUT_MS)
      this.permitCommands.set(commandId, { resolve, reject, timer })
      this.permitCommandByEvent.set(event.eventId, commandId)
      try {
        this.sendCommand(
          type,
          {
            eventId: event.eventId,
            lastLeaseId: event.leaseId
          },
          commandId
        )
      } catch {
        clearTimeout(timer)
        this.permitCommands.delete(commandId)
        this.permitCommandByEvent.delete(event.eventId)
        resolve({ status: "denied", reasonCode: "DESKTOP_OFFLINE" })
      }
    })
  }

  private connect(): void {
    if (this.stopped || this.reconnectBlocked) return
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
        lastError: !token ? "未登录，无法连接统一机器人。" : "统一机器人网关地址未配置。"
      })
      return
    }
    if (!isImGatewayUrlAllowed(url)) {
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
      lastHandshakeStatus: null,
      lastTransportError: null,
      sessionId: null,
      principalId: null,
      routes: []
    })
    const tokenExpiresAt = jwtExpiresAtMs(token)
    if (
      tokenExpiresAt !== null &&
      tokenExpiresAt <= this.now() + AUTHENTICATION_REFRESH_SKEW_MS
    ) {
      console.info("[IM Gateway] token-refresh:preflight", {
        expiresAt: new Date(tokenExpiresAt).toISOString(),
        expired: tokenExpiresAt <= this.now()
      })
      this.beginAuthenticationRefresh(token, generation, null, "preflight")
      return
    }
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
    this.connectionToken = token
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
      this.updateStatus({ lastHandshakeStatus: 101 })
      this.helloCommandId = this.sendEnvelope("HELLO", {
        appVersion: this.options.appVersion,
        capabilities: this.options.capabilities ?? ["inbox", "feature", "scheduler", "hitl"],
        protocolExtensions: [DEFAULT_ROUTE_SYNC_EXTENSION]
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
    socket.on("error", (error) => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      if (this.status.authenticationFailed || this.authenticationRefreshInFlight) return
      this.updateStatus({
        lastError: "统一机器人连接异常。",
        lastTransportError: diagnosticText(error.message)
      })
    })
    socket.on("unexpected-response", (_request, response) => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      this.updateStatus({ lastHandshakeStatus: response.statusCode })
      if (response.statusCode === 401) {
        this.handleAuthenticationRequired()
        return
      }
      const authenticationFailed = response.statusCode === 403
      this.updateStatus({
        connectionState: "error",
        authenticationFailed,
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: authenticationFailed
          ? "登录失效，请重新登录。"
          : `统一机器人网关拒绝连接（${response.statusCode}）。`
      })
      socket.terminate()
    })
    socket.on("close", (code, reason) => {
      if (this.connectionGeneration !== generation || this.socket !== socket) return
      this.socket = null
      this.connectionToken = null
      this.helloCommandId = null
      this.syncCommandId = null
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = undefined
      this.stopHeartbeat()
      this.stopAuthenticationRefreshTimer()
      this.updateStatus({
        lastCloseCode: code,
        lastCloseReason: diagnosticCloseReason(reason)
      })
      this.rejectPending(
        new ImGatewayCommandError("统一机器人连接已中断", { reasonCode: "DESKTOP_OFFLINE" })
      )
      if (this.stopped) return
      if (this.authenticationRefreshInFlight) return
      if (this.reconnectBlocked) {
        this.updateStatus({
          connectionState: "error",
          sessionId: null,
          principalId: null,
          routes: []
        })
        return
      }
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
        this.authenticationRefreshInFlight = false
        this.authenticationRefreshAttempted = false
        this.updateStatus({
          // The session is authenticated, but durable replies must not drain
          // until SYNC_STATE has reconciled the gateway's authoritative route.
          connectionState: "connecting",
          authenticationFailed: false,
          sessionId,
          principalId,
          lastConnectedAt: new Date(this.now()).toISOString(),
          lastError: null,
          reconnectAttempt: 0
        })
        this.startHeartbeat(heartbeatIntervalSeconds)
        this.scheduleAuthenticationRefresh()
        this.syncCommandId = this.sendEnvelope("SYNC_REQUEST", {})
        return
      }
      case "REMOTE_EVENT": {
        if (!messageId) throw new ImGatewayProtocolError("REMOTE_EVENT missing messageId")
        assertOnlyKeys(payload, ["event"], "REMOTE_EVENT payload")
        const event = record(payload.event) as unknown
        assertRemoteImEventV1(event)
        if (!this.status.principalId || event.principalId !== this.status.principalId) {
          throw new ImGatewayProtocolError("REMOTE_EVENT principal does not match WELCOME")
        }
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
      case "SYNC_STATE":
        if (!commandId || commandId !== this.syncCommandId) {
          throw new ImGatewayProtocolError("SYNC_STATE correlation does not match")
        }
        this.syncCommandId = null
        await this.updateRoutes(payload)
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

  private async updateRoutes(payload: Record<string, unknown>): Promise<void> {
    assertOnlyKeys(payload, ["routes", "defaultConversationKey"], "SYNC_STATE payload")
    const routes = Array.isArray(payload.routes) ? payload.routes : []
    if (!Array.isArray(payload.routes)) {
      throw new ImGatewayProtocolError("SYNC_STATE routes are missing")
    }
    const defaultConversationKey =
      payload.defaultConversationKey === undefined
        ? null
        : nonEmptyString(payload.defaultConversationKey)
    if (payload.defaultConversationKey !== undefined && !defaultConversationKey) {
      throw new ImGatewayProtocolError("SYNC_STATE default conversation is invalid")
    }
    const normalized: BuiltinRobotRouteStatus[] = []
    for (const value of routes) {
      const route = record(value)
      const conversationKey = nonEmptyString(route?.conversationKey)
      const principalId = nonEmptyString(route?.principalId)
      if (!route || !principalId || !conversationKey) {
        throw new ImGatewayProtocolError("SYNC_STATE route is invalid")
      }
      assertOnlyKeys(route, ["principalId", "conversationKey", "state"], "SYNC_STATE route")
      const stateValue = String(route.state ?? "active").toLowerCase()
      if (stateValue !== "active" && stateValue !== "suspended" && stateValue !== "revoked") {
        throw new ImGatewayProtocolError("SYNC_STATE route state is invalid")
      }
      const state = stateValue
      if (!this.status.principalId || principalId !== this.status.principalId) {
        throw new ImGatewayProtocolError("SYNC_STATE route principal does not match WELCOME")
      }
      normalized.push({
        principalId,
        conversationKey,
        state
      })
    }
    const principalId = this.status.principalId
    if (!principalId) {
      throw new ImGatewayProtocolError("SYNC_STATE arrived before WELCOME")
    }
    if (
      defaultConversationKey &&
      !normalized.some(
        (route) =>
          route.principalId === principalId &&
          route.conversationKey === defaultConversationKey &&
          route.state === "active"
      )
    ) {
      throw new ImGatewayProtocolError("SYNC_STATE default conversation is not an active route")
    }
    await this.options.onRoutesSynchronized?.(
      normalized.map((route) => ({ ...route })),
      principalId,
      defaultConversationKey
    )
    this.updateStatus({ connectionState: "online", routes: normalized })
  }

  private resolveError(payload: Record<string, unknown>, commandId: string | null): void {
    assertOnlyKeys(
      payload,
      ["reasonCode", "message", "eventId", "idempotencyKey", "conversationKey"],
      "ERROR payload"
    )
    const reasonCode = nonEmptyString(payload.reasonCode)
    if (!reasonCode) throw new ImGatewayProtocolError("ERROR payload is missing reasonCode")
    if (reasonCode === "AUTH_REQUIRED") {
      this.handleAuthenticationRequired()
      return
    }
    if (reasonCode === "SESSION_SUPERSEDED") {
      this.reconnectBlocked = true
      this.rejectPending(new ImGatewayCommandError("当前用户已有新的桌面连接", { reasonCode }))
      this.updateStatus({
        connectionState: "error",
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: "当前用户已由新的桌面连接接替；如需重新连接，请手动点击重连。"
      })
      this.socket?.close(4001, "session superseded")
      return
    }
    if (reasonCode === "ROBOT_OPEN_ID_NOT_CONFIGURED") {
      this.reconnectBlocked = true
      this.rejectPending(new ImGatewayCommandError("网关尚未配置统一机器人 OpenID", { reasonCode }))
      this.helloCommandId = null
      this.syncCommandId = null
      this.updateStatus({
        connectionState: "error",
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: "统一机器人网关尚未配置机器人 OpenID；配置完成后请手动重连。"
      })
      this.socket?.close(4002, "robot OpenID is not configured")
      return
    }
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
    if (!this.status.sessionId || !this.status.principalId) {
      throw new ImGatewayCommandError("统一机器人当前未连接")
    }
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
    if (this.stopped || this.reconnectBlocked || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, 1_000 * 2 ** Math.min(this.reconnectAttempt, 6))
    this.reconnectAttempt += 1
    this.updateStatus({ reconnectAttempt: this.reconnectAttempt })
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

  private handleAuthenticationRequired(): void {
    const generation = this.connectionGeneration
    const socket = this.socket
    const rejectedToken = this.connectionToken
    if (this.stopped || !socket || !rejectedToken) return

    this.beginAuthenticationRefresh(rejectedToken, generation, socket, "gateway")
  }

  private beginAuthenticationRefresh(
    rejectedToken: string,
    generation: number,
    socket: WebSocket | null,
    trigger: "preflight" | "gateway" | "proactive"
  ): void {
    if (this.stopped || this.connectionGeneration !== generation) return

    this.rejectPending(new ImGatewayCommandError("登录已过期", { reasonCode: "AUTH_REQUIRED" }))
    if (!this.options.onAuthenticationRequired || this.authenticationRefreshAttempted) {
      this.authenticationRefreshInFlight = false
      this.updateStatus({
        connectionState: "error",
        authenticationFailed: true,
        sessionId: null,
        principalId: null,
        routes: [],
        lastError: "登录失效，请重新登录。"
      })
      if (socket) socket.terminate()
      return
    }

    console.info("[IM Gateway] token-refresh:started", { trigger })
    this.authenticationRefreshAttempted = true
    this.authenticationRefreshInFlight = true
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    this.stopHeartbeat()
    this.stopAuthenticationRefreshTimer()
    this.updateStatus({
      connectionState: "connecting",
      authenticationFailed: false,
      sessionId: null,
      principalId: null,
      routes: [],
      lastError: "登录已过期，正在刷新…"
    })
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(4003, "authentication required")
    } else if (socket) {
      socket.terminate()
    }

    void Promise.resolve()
      .then(() => this.options.onAuthenticationRequired?.(rejectedToken) ?? false)
      .then((refreshed) => {
        if (this.stopped || this.connectionGeneration !== generation) return
        this.authenticationRefreshInFlight = false
        if (!refreshed) {
          console.warn("[IM Gateway] token-refresh:failed", { trigger })
          this.updateStatus({
            connectionState: "error",
            authenticationFailed: true,
            sessionId: null,
            principalId: null,
            routes: [],
            lastError: "登录刷新失败，请重新登录。"
          })
          return
        }
        console.info("[IM Gateway] token-refresh:succeeded", { trigger })
        this.connect()
      })
      .catch((error) => {
        if (this.stopped || this.connectionGeneration !== generation) return
        this.authenticationRefreshInFlight = false
        console.warn("[IM Gateway] token-refresh:error", {
          trigger,
          message: error instanceof Error ? diagnosticText(error.message) : "unknown"
        })
        this.updateStatus({
          connectionState: "error",
          authenticationFailed: true,
          sessionId: null,
          principalId: null,
          routes: [],
          lastError: "登录刷新失败，请重新登录。"
        })
      })
  }

  private scheduleAuthenticationRefresh(): void {
    this.stopAuthenticationRefreshTimer()
    const token = this.connectionToken
    if (!token) return
    const expiresAt = jwtExpiresAtMs(token)
    if (expiresAt === null) return
    const remaining = expiresAt - this.now() - AUTHENTICATION_REFRESH_SKEW_MS
    const delay = Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS))
    this.authenticationRefreshTimer = setTimeout(() => {
      this.authenticationRefreshTimer = undefined
      if (this.stopped || this.connectionToken !== token) return
      if (expiresAt > this.now() + AUTHENTICATION_REFRESH_SKEW_MS) {
        this.scheduleAuthenticationRefresh()
        return
      }
      const socket = this.socket
      if (!socket) return
      console.info("[IM Gateway] token-refresh:proactive", {
        expiresAt: new Date(expiresAt).toISOString()
      })
      this.beginAuthenticationRefresh(
        token,
        this.connectionGeneration,
        socket,
        "proactive"
      )
    }, delay)
  }

  private stopAuthenticationRefreshTimer(): void {
    if (this.authenticationRefreshTimer) clearTimeout(this.authenticationRefreshTimer)
    this.authenticationRefreshTimer = undefined
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
    this.stopAuthenticationRefreshTimer()
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.permitCommands.values(), ...this.replyCommands.values()]) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.permitCommands.clear()
    this.permitCommandByEvent.clear()
    this.replyCommands.clear()
    this.replyCommandByIdempotencyKey.clear()
  }
}
