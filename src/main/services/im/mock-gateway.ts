import { randomUUID } from "node:crypto"
import {
  assertRemoteImAckV1,
  assertRemoteImReplyV1,
  type GatewayReasonCodeV1,
  type RemoteImAckV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"

interface MockDevice {
  deviceId: string
  principalId: string
  connected: boolean
  preferred: boolean
  lastSeenOrder: number
}

interface MockRoute {
  conversationKey: string
  principalId: string
  deviceId: string
  deviceEpoch: number
}

interface MockLease {
  id: string
  eventId: string
  deviceId: string
  deviceEpoch: number
  expiresAt: number
  permitAcquired: boolean
  revoked: boolean
}

interface StoredMockEvent {
  event: RemoteImEventV1
  deviceId: string
  lease: MockLease
  lastAck?: RemoteImAckV1
}

interface StoredMockReply {
  reply: RemoteImReplyV1
  state: "accepted" | "platform_unknown"
  platformReplyId?: string
}

interface WaitingMockEvent {
  input: MockInboundText
  eventId: string
  conversationSeq: number
}

export interface MockInboundText {
  platformMessageId: string
  principalId: string
  conversationKey: string
  text: string
  occurredAt?: string
}

export interface MockPermitResult {
  status: "granted" | "denied"
  eventId: string
  leaseId?: string
  expiresAt?: string
  reasonCode?: GatewayReasonCodeV1
}

export class MockGatewayError extends Error {
  constructor(
    readonly reasonCode: GatewayReasonCodeV1,
    message: string
  ) {
    super(message)
    this.name = "MockGatewayError"
  }
}

export class MockGatewaySendTimeout extends Error {
  constructor(readonly persisted: boolean) {
    super(
      persisted ? "Mock reply timed out after durable accept" : "Mock reply timed out before accept"
    )
    this.name = "MockGatewaySendTimeout"
  }
}

type MockReplyFault = "timeout_before_persist" | "timeout_after_persist" | "platform_unknown"

export class MockImGateway {
  private readonly devices = new Map<string, MockDevice>()
  private readonly routes = new Map<string, MockRoute>()
  private readonly sequenceByConversation = new Map<string, number>()
  private readonly deliveryCursorByConversation = new Map<string, number>()
  private readonly firstDeliveredEventIds = new Set<string>()
  private readonly events = new Map<string, StoredMockEvent>()
  private readonly eventIdByPlatformMessage = new Map<string, string>()
  private readonly pendingDeliveryByDevice = new Map<string, RemoteImEventV1[]>()
  private readonly waitingByConversation = new Map<string, WaitingMockEvent[]>()
  private readonly repliesByIdempotencyKey = new Map<string, StoredMockReply>()
  private readonly now: () => number
  private order = 0
  private nextReplyFault: MockReplyFault | null = null

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  connectDevice(input: { deviceId: string; principalId: string; preferred?: boolean }): void {
    this.order += 1
    this.devices.set(input.deviceId, {
      deviceId: input.deviceId,
      principalId: input.principalId,
      connected: true,
      preferred: input.preferred === true,
      lastSeenOrder: this.order
    })
    for (const [conversationKey, waiting] of this.waitingByConversation) {
      if (waiting[0]?.input.principalId === input.principalId) {
        this.routeWaitingConversation(conversationKey)
      }
    }
  }

  disconnectDevice(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (device) device.connected = false
  }

  reconnectDevice(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (!device) throw new MockGatewayError("DEVICE_REVOKED", "Mock device is unknown")
    this.order += 1
    device.connected = true
    device.lastSeenOrder = this.order
  }

  getRoute(conversationKey: string): Readonly<MockRoute> | null {
    const route = this.routes.get(conversationKey)
    return route ? { ...route } : null
  }

  ingestText(input: MockInboundText): {
    status: "deliverable" | "waiting_device" | "duplicate"
    event?: RemoteImEventV1
  } {
    const duplicateEventId = this.eventIdByPlatformMessage.get(input.platformMessageId)
    if (duplicateEventId) {
      const stored = this.events.get(duplicateEventId)
      return { status: "duplicate", event: stored ? this.copyEvent(stored.event) : undefined }
    }

    const conversationSeq = (this.sequenceByConversation.get(input.conversationKey) ?? 0) + 1
    this.sequenceByConversation.set(input.conversationKey, conversationSeq)
    const eventId = randomUUID()
    this.eventIdByPlatformMessage.set(input.platformMessageId, eventId)
    const route = this.routes.get(input.conversationKey) ?? this.createRoute(input)
    if (!route) {
      const waiting = this.waitingByConversation.get(input.conversationKey) ?? []
      waiting.push({ input: { ...input }, eventId, conversationSeq })
      this.waitingByConversation.set(input.conversationKey, waiting)
      return { status: "waiting_device" }
    }

    const event = this.createEvent(input, eventId, conversationSeq, route)
    return { status: "deliverable", event: this.copyEvent(event) }
  }

  takeDeliveries(deviceId: string, order: "fifo" | "reverse" = "fifo"): RemoteImEventV1[] {
    const pending = this.pendingDeliveryByDevice.get(deviceId) ?? []
    this.pendingDeliveryByDevice.set(deviceId, [])
    const deliveries = order === "reverse" ? [...pending].reverse() : pending
    return deliveries.map((event) => this.copyEvent(event))
  }

  redeliver(eventId: string, options: { replaceUnacquiredLease?: boolean } = {}): RemoteImEventV1 {
    const stored = this.requireEvent(eventId)
    if (options.replaceUnacquiredLease !== false && !stored.lease.permitAcquired) {
      stored.lease.revoked = true
      stored.lease = this.createLease(eventId, stored.deviceId, stored.event.deviceEpoch)
      stored.event.lease = {
        id: stored.lease.id,
        expiresAt: new Date(stored.lease.expiresAt).toISOString()
      }
    }
    stored.event.redelivered = true
    this.enqueueDelivery(stored.deviceId, stored.event)
    return this.copyEvent(stored.event)
  }

  acknowledge(deviceId: string, deviceEpoch: number, ack: RemoteImAckV1): void {
    assertRemoteImAckV1(ack)
    const stored = this.requireEvent(ack.eventId)
    this.assertCurrentRoute(stored.event.conversationKey, deviceId, deviceEpoch)
    if (stored.lease.id !== ack.leaseId || stored.lease.revoked) {
      throw new MockGatewayError("LEASE_REVOKED", "ACK lease is no longer active")
    }
    stored.lastAck = { ...ack }
    if (ack.type === "received") {
      const cursor = this.deliveryCursorByConversation.get(stored.event.conversationKey) ?? 0
      if (stored.event.conversationSeq === cursor + 1) {
        this.deliveryCursorByConversation.set(
          stored.event.conversationKey,
          stored.event.conversationSeq
        )
        this.enqueueNextFirstDelivery(stored.event.conversationKey)
      }
    }
  }

  acquirePermit(input: {
    eventId: string
    deviceId: string
    deviceEpoch: number
    leaseId: string
  }): MockPermitResult {
    const stored = this.requireEvent(input.eventId)
    try {
      this.assertCurrentRoute(stored.event.conversationKey, input.deviceId, input.deviceEpoch)
    } catch (error) {
      if (error instanceof MockGatewayError) {
        return { status: "denied", eventId: input.eventId, reasonCode: error.reasonCode }
      }
      throw error
    }
    const device = this.devices.get(input.deviceId)
    if (!device?.connected) {
      return { status: "denied", eventId: input.eventId, reasonCode: "DEVICE_OFFLINE" }
    }
    if (stored.lease.id !== input.leaseId || stored.lease.revoked) {
      return { status: "denied", eventId: input.eventId, reasonCode: "LEASE_REVOKED" }
    }
    if (stored.lease.expiresAt <= this.now()) {
      return { status: "denied", eventId: input.eventId, reasonCode: "LEASE_EXPIRED" }
    }
    stored.lease.permitAcquired = true
    stored.lease.expiresAt = this.now() + 90_000
    stored.event.lease.expiresAt = new Date(stored.lease.expiresAt).toISOString()
    return {
      status: "granted",
      eventId: input.eventId,
      leaseId: stored.lease.id,
      expiresAt: stored.event.lease.expiresAt
    }
  }

  renewPermit(input: {
    eventId: string
    deviceId: string
    deviceEpoch: number
    leaseId: string
  }): MockPermitResult {
    const stored = this.requireEvent(input.eventId)
    const route = this.routes.get(stored.event.conversationKey)
    if (
      !route ||
      route.deviceId !== input.deviceId ||
      route.deviceEpoch !== input.deviceEpoch ||
      stored.lease.id !== input.leaseId ||
      stored.lease.revoked ||
      !stored.lease.permitAcquired
    ) {
      return { status: "denied", eventId: input.eventId, reasonCode: "LEASE_REVOKED" }
    }
    if (!this.devices.get(input.deviceId)?.connected) {
      return { status: "denied", eventId: input.eventId, reasonCode: "DEVICE_OFFLINE" }
    }
    stored.lease.expiresAt = this.now() + 90_000
    stored.event.lease.expiresAt = new Date(stored.lease.expiresAt).toISOString()
    return {
      status: "granted",
      eventId: input.eventId,
      leaseId: stored.lease.id,
      expiresAt: stored.event.lease.expiresAt
    }
  }

  revokeLease(eventId: string): void {
    this.requireEvent(eventId).lease.revoked = true
  }

  takeover(input: {
    conversationKey: string
    expectedEpoch: number
    newDeviceId: string
  }): MockRoute {
    const route = this.routes.get(input.conversationKey)
    if (!route) throw new MockGatewayError("ROUTE_NOT_FOUND", "Mock route is unknown")
    if (route.deviceEpoch !== input.expectedEpoch) {
      throw new MockGatewayError("ROUTE_EPOCH_CONFLICT", "Mock route epoch changed")
    }
    const nextDevice = this.devices.get(input.newDeviceId)
    if (!nextDevice?.connected || nextDevice.principalId !== route.principalId) {
      throw new MockGatewayError("DEVICE_OFFLINE", "Takeover device is unavailable")
    }
    for (const stored of this.events.values()) {
      if (
        stored.event.conversationKey === input.conversationKey &&
        stored.event.deviceEpoch === route.deviceEpoch
      ) {
        stored.lease.revoked = true
      }
    }
    route.deviceId = input.newDeviceId
    route.deviceEpoch += 1
    return { ...route }
  }

  setNextReplyFault(fault: MockReplyFault | null): void {
    this.nextReplyFault = fault
  }

  submitReply(
    deviceId: string,
    reply: RemoteImReplyV1
  ): {
    state: "accepted" | "platform_unknown"
    duplicate: boolean
    platformReplyId?: string
  } {
    assertRemoteImReplyV1(reply)
    this.assertCurrentRoute(reply.conversationKey, deviceId, reply.expectedDeviceEpoch)
    if (reply.eventId) {
      const event = this.requireEvent(reply.eventId).event
      if (
        event.conversationKey !== reply.conversationKey ||
        event.deviceEpoch !== reply.expectedDeviceEpoch
      ) {
        throw new MockGatewayError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Reply event identity differs from its route"
        )
      }
    }
    for (const storedReply of this.repliesByIdempotencyKey.values()) {
      if (
        storedReply.reply.deliveryId === reply.deliveryId &&
        storedReply.reply.segment.index === reply.segment.index &&
        storedReply.reply.idempotencyKey !== reply.idempotencyKey
      ) {
        throw new MockGatewayError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Delivery segment was submitted with another idempotency key"
        )
      }
      if (
        storedReply.reply.deliveryId === reply.deliveryId &&
        (storedReply.reply.segment.count !== reply.segment.count ||
          storedReply.reply.conversationKey !== reply.conversationKey ||
          storedReply.reply.expectedDeviceEpoch !== reply.expectedDeviceEpoch ||
          storedReply.reply.eventId !== reply.eventId)
      ) {
        throw new MockGatewayError(
          "OUTBOX_INCOMPLETE",
          "Delivery segments do not share one immutable envelope"
        )
      }
    }
    const existing = this.repliesByIdempotencyKey.get(reply.idempotencyKey)
    if (existing) {
      if (JSON.stringify(existing.reply) !== JSON.stringify(reply)) {
        throw new MockGatewayError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Idempotency key was reused with another payload"
        )
      }
      return {
        state: existing.state,
        duplicate: true,
        platformReplyId: existing.platformReplyId
      }
    }

    const fault = this.nextReplyFault
    this.nextReplyFault = null
    if (fault === "timeout_before_persist") throw new MockGatewaySendTimeout(false)

    const stored: StoredMockReply =
      fault === "platform_unknown"
        ? { reply: structuredClone(reply), state: "platform_unknown" }
        : {
            reply: structuredClone(reply),
            state: "accepted",
            platformReplyId: `platform-${randomUUID()}`
          }
    this.repliesByIdempotencyKey.set(reply.idempotencyKey, stored)
    if (fault === "timeout_after_persist") throw new MockGatewaySendTimeout(true)
    return {
      state: stored.state,
      duplicate: false,
      platformReplyId: stored.platformReplyId
    }
  }

  private createRoute(
    input: Pick<MockInboundText, "conversationKey" | "principalId">
  ): MockRoute | null {
    const candidates = [...this.devices.values()]
      .filter((device) => device.connected && device.principalId === input.principalId)
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          right.lastSeenOrder - left.lastSeenOrder ||
          left.deviceId.localeCompare(right.deviceId)
      )
    const selected = candidates[0]
    if (!selected) return null
    const route: MockRoute = {
      conversationKey: input.conversationKey,
      principalId: input.principalId,
      deviceId: selected.deviceId,
      deviceEpoch: 1
    }
    this.routes.set(input.conversationKey, route)
    return route
  }

  private routeWaitingConversation(conversationKey: string): void {
    const waiting = this.waitingByConversation.get(conversationKey)
    if (!waiting || waiting.length === 0) return
    const route = this.createRoute(waiting[0].input)
    if (!route) return
    for (const pending of waiting) {
      this.createEvent(pending.input, pending.eventId, pending.conversationSeq, route)
    }
    this.waitingByConversation.delete(conversationKey)
  }

  private createEvent(
    input: MockInboundText,
    eventId: string,
    conversationSeq: number,
    route: MockRoute
  ): RemoteImEventV1 {
    const lease = this.createLease(eventId, route.deviceId, route.deviceEpoch)
    const event: RemoteImEventV1 = {
      schemaVersion: 1,
      eventId,
      platformMessageId: input.platformMessageId,
      principalId: input.principalId,
      conversationKey: input.conversationKey,
      conversationSeq,
      deviceEpoch: route.deviceEpoch,
      message: { type: "text", text: input.text },
      occurredAt: input.occurredAt ?? new Date(this.now()).toISOString(),
      lease: { id: lease.id, expiresAt: new Date(lease.expiresAt).toISOString() }
    }
    this.events.set(eventId, { event, deviceId: route.deviceId, lease })
    this.enqueueNextFirstDelivery(route.conversationKey)
    return event
  }

  private enqueueNextFirstDelivery(conversationKey: string): void {
    const cursor = this.deliveryCursorByConversation.get(conversationKey) ?? 0
    const next = [...this.events.values()].find(
      (stored) =>
        stored.event.conversationKey === conversationKey &&
        stored.event.conversationSeq === cursor + 1
    )
    if (!next || this.firstDeliveredEventIds.has(next.event.eventId)) return
    this.firstDeliveredEventIds.add(next.event.eventId)
    this.enqueueDelivery(next.deviceId, next.event)
  }

  private createLease(eventId: string, deviceId: string, deviceEpoch: number): MockLease {
    return {
      id: randomUUID(),
      eventId,
      deviceId,
      deviceEpoch,
      expiresAt: this.now() + 90_000,
      permitAcquired: false,
      revoked: false
    }
  }

  private enqueueDelivery(deviceId: string, event: RemoteImEventV1): void {
    const pending = this.pendingDeliveryByDevice.get(deviceId) ?? []
    pending.push(this.copyEvent(event))
    this.pendingDeliveryByDevice.set(deviceId, pending)
  }

  private assertCurrentRoute(conversationKey: string, deviceId: string, deviceEpoch: number): void {
    const route = this.routes.get(conversationKey)
    if (!route) throw new MockGatewayError("ROUTE_NOT_FOUND", "Mock route is unknown")
    if (route.deviceEpoch !== deviceEpoch) {
      throw new MockGatewayError("ROUTE_EPOCH_CONFLICT", "Mock route epoch changed")
    }
    if (route.deviceId !== deviceId) {
      throw new MockGatewayError(
        "ROUTE_OWNED_BY_OTHER_DEVICE",
        "Mock route belongs to another device"
      )
    }
  }

  private requireEvent(eventId: string): StoredMockEvent {
    const stored = this.events.get(eventId)
    if (!stored) throw new MockGatewayError("EVENT_NOT_FOUND", "Mock event is unknown")
    return stored
  }

  private copyEvent(event: RemoteImEventV1): RemoteImEventV1 {
    return structuredClone(event)
  }
}
