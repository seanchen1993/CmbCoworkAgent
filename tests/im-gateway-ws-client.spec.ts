import assert from "node:assert/strict"
import { WebSocketServer, type WebSocket } from "ws"
import type { RemoteImEventV1 } from "../src/shared/im-gateway-contract"
import { ImGatewayWsClient } from "../src/main/services/im/gateway-ws-client"
import {
  isImGatewayUrlAllowed,
  normalizeImGatewayUrlOverride
} from "../src/main/services/im/gateway-url"
import type { ImEventRecord } from "../src/main/services/im/event-store"

interface Envelope {
  schemaVersion: number
  type: string
  commandId?: string
  payload: Record<string, unknown>
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function main(): Promise<void> {
  assert.equal(
    normalizeImGatewayUrlOverride("  wss://gateway.example.com/ws/desktop  "),
    "wss://gateway.example.com/ws/desktop"
  )
  assert.equal(normalizeImGatewayUrlOverride(null), null)
  assert.equal(isImGatewayUrlAllowed("ws://localhost:8080/ws/desktop"), true)
  assert.equal(isImGatewayUrlAllowed("ws://10.0.0.8/ws/desktop"), false)
  assert.equal(isImGatewayUrlAllowed("wss://user:secret@gateway.example.com/ws/desktop"), false)
  assert.throws(() => normalizeImGatewayUrlOverride("https://gateway.example.com/ws/desktop"))
  assert.throws(() => normalizeImGatewayUrlOverride("wss://gateway.example.com/ws#token"))

  const insecureRemoteClient = new ImGatewayWsClient({
    url: () => "ws://10.0.0.8/ws",
    token: () => "token",
    appVersion: "test",
    onRemoteEvent: () => undefined
  })
  insecureRemoteClient.start()
  assert.equal(insecureRemoteClient.getStatus().connectionState, "error")
  assert(insecureRemoteClient.getStatus().lastError?.includes("必须使用 WSS"))
  insecureRemoteClient.stop()

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (info, done) => {
      const token = String(info.req.headers.authorization ?? "")
      if (token.startsWith("Bearer expired-token")) {
        done(false, 401, "Unauthorized")
        return
      }
      done(true)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve)
    server.once("error", reject)
  })
  const address = server.address()
  assert(address && typeof address === "object")

  let socket: WebSocket | null = null
  let authorization = ""
  const receivedTypes: string[] = []
  const remoteEvents: RemoteImEventV1[] = []
  const revokedEventIds: string[] = []
  let mismatchNextPermit = false
  let missingRobotHelloCount = 0
  server.on("connection", (connected, request) => {
    socket = connected
    const connectionAuthorization = String(request.headers.authorization ?? "")
    authorization = connectionAuthorization
    connected.on("message", (raw) => {
      const envelope = JSON.parse(String(raw)) as Envelope
      receivedTypes.push(envelope.type)
      if (envelope.type === "HELLO") {
        if (connectionAuthorization === "Bearer missing-robot-token") {
          missingRobotHelloCount += 1
          connected.send(
            JSON.stringify({
              schemaVersion: 1,
              type: "ERROR",
              commandId: envelope.commandId,
              sentAt: new Date().toISOString(),
              payload: { reasonCode: "ROBOT_OPEN_ID_NOT_CONFIGURED" }
            })
          )
          connected.close(1008, "robot OpenID is not configured")
          return
        }
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "WELCOME",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              sessionId: "session-1",
              principalId: "opaque-principal",
              serverTime: new Date().toISOString(),
              heartbeatIntervalSeconds: 60
            }
          })
        )
      } else if (envelope.type === "SYNC_REQUEST") {
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "SYNC_STATE",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              routes: [
                {
                  principalId: "opaque-principal",
                  conversationKey: "conversation-remote",
                  state: "active"
                }
              ]
            }
          })
        )
      } else if (envelope.type === "EXECUTION_PERMIT_ACQUIRE") {
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "PERMIT_RESULT",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              eventId: mismatchNextPermit ? "wrong-event-id" : envelope.payload.eventId,
              status: "GRANTED",
              leaseId: "renewed-lease",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          })
        )
      } else if (envelope.type === "REMOTE_REPLY") {
        const segment = envelope.payload.segment as Record<string, unknown>
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "REPLY_ACCEPTED",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              deliveryId: envelope.payload.deliveryId,
              idempotencyKey: envelope.payload.idempotencyKey,
              segmentIndex: segment.index,
              state: "ACCEPTED",
              platformReplyId: "platform-reply-1"
            }
          })
        )
      }
    })
  })

  const client = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}/ws`,
    token: () => "identity-token-do-not-log",
    appVersion: "test",
    onRemoteEvent: (event) => {
      remoteEvents.push(event)
    },
    onLeaseRevoked: (payload) => {
      if (typeof payload.eventId === "string") revokedEventIds.push(payload.eventId)
    }
  })
  client.start()
  await waitFor(() => client.isAuthenticated(), "authenticated WSS")
  assert.equal(authorization, "Bearer identity-token-do-not-log")
  assert.equal(client.getStatus().lastHandshakeStatus, 101)
  assert(receivedTypes.includes("HELLO"))
  await waitFor(() => client.getStatus().routes.length === 1, "route sync")
  assert.equal(client.getStatus().principalId, "opaque-principal")
  assert.equal(client.getStatus().routes[0].principalId, "opaque-principal")
  assert.equal(client.getStatus().routes[0].state, "active")

  const event: RemoteImEventV1 = {
    schemaVersion: 1,
    eventId: "event-ws-1",
    platformMessageId: "platform-ws-1",
    principalId: "opaque-principal",
    conversationKey: "conversation-remote",
    conversationSeq: 1,
    message: { type: "text", text: "hello" },
    occurredAt: new Date().toISOString(),
    lease: { id: "lease-original", expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
  socket!.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "REMOTE_EVENT",
      messageId: "push-event-ws-1",
      sentAt: new Date().toISOString(),
      payload: { event }
    })
  )
  await waitFor(() => remoteEvents.length === 1, "remote event")

  const persistedEvent: ImEventRecord = {
    eventId: event.eventId,
    platformMessageId: event.platformMessageId,
    conversationKey: event.conversationKey,
    conversationSeq: event.conversationSeq,
    principalId: event.principalId,
    leaseId: event.lease.id,
    leaseExpiresAt: Date.parse(event.lease.expiresAt),
    permitState: "unacquired",
    permitExpiresAt: null,
    messageText: event.message.text,
    occurredAt: Date.parse(event.occurredAt),
    targetSnapshot: null,
    state: "queued",
    runId: null,
    retryOfEventId: null,
    resultText: null,
    reasonCode: null,
    retryable: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acceptedAt: Date.now(),
    executionStartedAt: null,
    finishedAt: null
  }
  const permit = await client.acquireExecutionPermit(persistedEvent)
  assert.equal(permit.status, "granted")
  assert.equal(permit.leaseId, "renewed-lease")

  const reply = await client.submitReply({
    schemaVersion: 1,
    deliveryId: "delivery-ws-1",
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    idempotencyKey: "delivery-ws-1:reply:0",
    segment: { index: 0, count: 1 },
    message: { type: "text", content: "done" }
  })
  assert.equal(reply.platformReplyId, "platform-reply-1")

  socket!.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "LEASE_REVOKED",
      messageId: "push-lease-revoked-1",
      sentAt: new Date().toISOString(),
      payload: { eventId: event.eventId, reasonCode: "LEASE_REVOKED" }
    })
  )
  await waitFor(() => revokedEventIds.length === 1, "lease revocation")

  mismatchNextPermit = true
  await assert.rejects(
    client.acquireExecutionPermit({ ...persistedEvent, eventId: "event-ws-mismatched-result" }),
    /连接已中断/
  )

  await waitFor(() => client.isAuthenticated(), "automatic reconnect after transport failure")
  const helloCountBeforeSupersede = receivedTypes.filter((type) => type === "HELLO").length
  socket!.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "ERROR",
      sentAt: new Date().toISOString(),
      payload: { reasonCode: "SESSION_SUPERSEDED" }
    })
  )
  await waitFor(
    () =>
      client.getStatus().connectionState === "error" &&
      client.getStatus().lastError?.includes("新的桌面连接") === true,
    "superseded session fence"
  )
  await waitFor(() => client.getStatus().lastCloseCode === 4001, "superseded close diagnostics")
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(
    receivedTypes.filter((type) => type === "HELLO").length,
    helloCountBeforeSupersede,
    "superseded desktop must not reconnect automatically"
  )

  client.stop()

  let refreshingToken = "expired-token"
  let authenticationRefreshCount = 0
  const refreshingClient = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}/ws`,
    token: () => refreshingToken,
    appVersion: "test",
    onAuthenticationRequired: async () => {
      authenticationRefreshCount += 1
      refreshingToken = `refreshed-token-${authenticationRefreshCount}`
      return true
    },
    onRemoteEvent: () => undefined
  })
  refreshingClient.start()
  await waitFor(() => refreshingClient.isAuthenticated(), "authentication refresh after 401")
  assert.equal(authenticationRefreshCount, 1)
  assert.equal(authorization, "Bearer refreshed-token-1")

  socket!.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "ERROR",
      sentAt: new Date().toISOString(),
      payload: { reasonCode: "AUTH_REQUIRED" }
    })
  )
  await waitFor(() => authenticationRefreshCount === 2, "AUTH_REQUIRED refresh callback")
  await waitFor(
    () => refreshingClient.isAuthenticated() && authorization === "Bearer refreshed-token-2",
    "authentication refresh after session expiry"
  )
  refreshingClient.stop()

  let failedRefreshCount = 0
  const unrecoverableClient = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}/ws`,
    token: () => "expired-token-still-invalid",
    appVersion: "test",
    onAuthenticationRequired: async () => {
      failedRefreshCount += 1
      return true
    },
    onRemoteEvent: () => undefined
  })
  unrecoverableClient.start()
  await waitFor(
    () => unrecoverableClient.getStatus().authenticationFailed,
    "single authentication refresh retry"
  )
  assert.equal(failedRefreshCount, 1, "an invalid refreshed token must not cause a refresh loop")
  assert.equal(unrecoverableClient.getStatus().lastHandshakeStatus, 401)
  unrecoverableClient.stop()

  const missingRobotClient = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}/ws`,
    token: () => "missing-robot-token",
    appVersion: "test",
    onRemoteEvent: () => undefined
  })
  missingRobotClient.start()
  await waitFor(
    () => missingRobotClient.getStatus().lastError?.includes("机器人 OpenID") === true,
    "missing robot OpenID diagnostic"
  )
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(missingRobotHelloCount, 1, "gateway configuration errors must not reconnect-loop")
  missingRobotClient.stop()

  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log("im-gateway-ws-client.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
