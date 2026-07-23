import assert from "node:assert/strict"
import { WebSocketServer, type WebSocket } from "ws"
import type { RemoteImEventV1 } from "../src/shared/im-gateway-contract"
import { ImGatewayWsClient } from "../src/main/services/im/gateway-ws-client"
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
  const insecureRemoteClient = new ImGatewayWsClient({
    url: () => "ws://10.0.0.8/ws",
    token: () => "token",
    deviceId: "device-insecure",
    deviceName: "Insecure",
    appVersion: "test",
    onRemoteEvent: () => undefined
  })
  insecureRemoteClient.start()
  assert.equal(insecureRemoteClient.getStatus().connectionState, "error")
  assert(insecureRemoteClient.getStatus().lastError?.includes("必须使用 WSS"))
  insecureRemoteClient.stop()

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
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
  server.on("connection", (connected, request) => {
    socket = connected
    authorization = String(request.headers.authorization ?? "")
    connected.on("message", (raw) => {
      const envelope = JSON.parse(String(raw)) as Envelope
      receivedTypes.push(envelope.type)
      if (envelope.type === "HELLO") {
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "WELCOME",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              sessionId: "session-1",
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
                  conversationKey: "conversation-remote",
                  deviceEpoch: 3,
                  state: "active",
                  deviceId: "other-device",
                  deviceName: "Other"
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
      } else if (envelope.type === "ROUTE_TAKEOVER_REQUEST") {
        connected.send(
          JSON.stringify({
            schemaVersion: 1,
            type: "TAKEOVER_RESULT",
            commandId: envelope.commandId,
            sentAt: new Date().toISOString(),
            payload: {
              conversationKey: envelope.payload.conversationKey,
              principalId: "opaque-principal",
              previousDeviceEpoch: envelope.payload.expectedEpoch,
              deviceEpoch: 4,
              status: "SUCCESS"
            }
          })
        )
      }
    })
  })

  const client = new ImGatewayWsClient({
    url: () => `ws://127.0.0.1:${address.port}/ws`,
    token: () => "identity-token-do-not-log",
    deviceId: "device-current",
    deviceName: "Current",
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
  assert(receivedTypes.includes("HELLO"))
  await waitFor(() => client.getStatus().routes.length === 1, "route sync")
  assert.equal(client.getStatus().routes[0].ownedByCurrentDevice, false)

  const event: RemoteImEventV1 = {
    schemaVersion: 1,
    eventId: "event-ws-1",
    platformMessageId: "platform-ws-1",
    principalId: "opaque-principal",
    conversationKey: "conversation-remote",
    conversationSeq: 1,
    deviceEpoch: 3,
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
    deviceEpoch: event.deviceEpoch,
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
    expectedDeviceEpoch: event.deviceEpoch,
    idempotencyKey: "delivery-ws-1:reply:0",
    segment: { index: 0, count: 1 },
    message: { type: "text", content: "done" }
  })
  assert.equal(reply.platformReplyId, "platform-reply-1")

  const takeover = await client.requestTakeover({
    conversationKey: event.conversationKey,
    expectedDeviceEpoch: 3,
    mode: "normal"
  })
  assert.equal(takeover.success, true)
  assert.equal(takeover.principalId, "opaque-principal")
  assert.equal(client.getStatus().routes[0].ownedByCurrentDevice, true)

  socket!.send(
    JSON.stringify({
      schemaVersion: 1,
      type: "LEASE_REVOKED",
      messageId: "push-lease-revoked-1",
      sentAt: new Date().toISOString(),
      payload: { eventId: event.eventId, reasonCode: "ROUTE_TAKEOVER" }
    })
  )
  await waitFor(() => revokedEventIds.length === 1, "lease revocation")

  mismatchNextPermit = true
  await assert.rejects(
    client.acquireExecutionPermit({ ...persistedEvent, eventId: "event-ws-mismatched-result" }),
    /连接已中断/
  )

  client.stop()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log("im-gateway-ws-client.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
