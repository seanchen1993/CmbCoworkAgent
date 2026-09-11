import { randomUUID } from "node:crypto"
import {
  assertRemoteImAckV1,
  assertRemoteImReplyV1,
  type GatewayReasonCodeV1,
  type RemoteImAckV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"

export interface MockDesktopSession {
  sessionId: string
  principalId: string
  connectionGeneration: number
  connected: boolean
  superseded: boolean
}

interface MockConversation {
  conversationKey: string
  principalId: string
}

interface MockLease {
  id: string
  eventId: string
  sessionId: string
  connectionGeneration: number
  expiresAt: number
  permitAcquired: boolean
  revoked: boolean
}

interface StoredMockEvent {
  event: RemoteImEventV1
  principalId: string
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

/**
 * Contract harness for the frozen one-principal/one-active-desktop model.
 * Connection generations fence stale sockets, while conversations, grants and
 * outbox identities remain stable across ordinary reconnects.
 */
export class MockImGateway {
  private readonly sessions = new Map<string, MockDesktopSession>()
  private readonly activeSessionByPrincipal = new Map<string, string>()
  private readonly generationByPrincipal = new Map<string, number>()
  private readonly conversations = new Map<string, MockConversation>()
  private readonly sequenceByConversation = new Map<string, number>()
  private readonly deliveryCursorByConversation = new Map<string, number>()
  private readonly firstDeliveredEventIds = new Set<string>()
  private readonly events = new Map<string, StoredMockEvent>()
  private readonly eventIdByPlatformMessage = new Map<string, string>()
  private readonly pendingDeliveryBySession = new Map<string, RemoteImEventV1[]>()
  private readonly waitingByConversation = new Map<string, WaitingMockEvent[]>()
  private readonly repliesByIdempotencyKey = new Map<string, StoredMockReply>()
  private readonly now: () => number
  private nextReplyFault: MockReplyFault | null = null

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  connectSession(input: { principalId: string; sessionId?: string }): {
    session: Readonly<MockDesktopSession>
    supersededSessionId: string | null
  } {
    const principalId = input.principalId.trim()
    if (!principalId) throw new MockGatewayError("IDENTITY_NOT_FOUND", "principalId is required")
    const sessionId = input.sessionId?.trim() || randomUUID()
    const previousSessionId = this.activeSessionByPrincipal.get(principalId) ?? null
    const previous = previousSessionId ? this.sessions.get(previousSessionId) : undefined
    if (previous && previous.sessionId !== sessionId) {
      previous.connected = false
      previous.superseded = true
    }
    const connectionGeneration = (this.generationByPrincipal.get(principalId) ?? 0) + 1
    this.generationByPrincipal.set(principalId, connectionGeneration)
    const session: MockDesktopSession = {
      sessionId,
      principalId,
      connectionGeneration,
      connected: true,
      superseded: false
    }
    this.sessions.set(sessionId, session)
    this.activeSessionByPrincipal.set(principalId, sessionId)
    this.redeliverUnpermittedEvents(principalId, session)
    for (const [conversationKey, waiting] of this.waitingByConversation) {
      if (waiting[0]?.input.principalId === principalId)
        this.routeWaitingConversation(conversationKey)
    }
    return {
      session: { ...session },
      supersededSessionId: previous && previous.sessionId !== sessionId ? previous.sessionId : null
    }
  }

  disconnectSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.connected = false
    if (this.activeSessionByPrincipal.get(session.principalId) === sessionId) {
      this.activeSessionByPrincipal.delete(session.principalId)
    }
  }

  getActiveSession(principalId: string): Readonly<MockDesktopSession> | null {
    const sessionId = this.activeSessionByPrincipal.get(principalId)
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    return session?.connected && !session.superseded ? { ...session } : null
  }

  getConversation(conversationKey: string): Readonly<MockConversation> | null {
    const conversation = this.conversations.get(conversationKey)
    return conversation ? { ...conversation } : null
  }

  ingestText(input: MockInboundText): {
    status: "deliverable" | "waiting_session" | "duplicate"
    event?: RemoteImEventV1
  } {
    const duplicateEventId = this.eventIdByPlatformMessage.get(input.platformMessageId)
    if (duplicateEventId) {
      const stored = this.events.get(duplicateEventId)
      return { status: "duplicate", event: stored ? this.copyEvent(stored.event) : undefined }
    }

    const existingConversation = this.conversations.get(input.conversationKey)
    if (existingConversation && existingConversation.principalId !== input.principalId) {
      throw new MockGatewayError("PRINCIPAL_MISMATCH", "Conversation belongs to another principal")
    }
    const conversationSeq = (this.sequenceByConversation.get(input.conversationKey) ?? 0) + 1
    this.sequenceByConversation.set(input.conversationKey, conversationSeq)
    const eventId = randomUUID()
    this.eventIdByPlatformMessage.set(input.platformMessageId, eventId)
    const session = this.activeSession(input.principalId)
    if (!session) {
      const waiting = this.waitingByConversation.get(input.conversationKey) ?? []
      waiting.push({ input: { ...input }, eventId, conversationSeq })
      this.waitingByConversation.set(input.conversationKey, waiting)
      return { status: "waiting_session" }
    }
    this.ensureConversation(input.conversationKey, input.principalId)
    const event = this.createEvent(input, eventId, conversationSeq, session)
    return { status: "deliverable", event: this.copyEvent(event) }
  }

  takeDeliveries(sessionId: string, order: "fifo" | "reverse" = "fifo"): RemoteImEventV1[] {
    this.assertActiveSession(sessionId)
    const pending = this.pendingDeliveryBySession.get(sessionId) ?? []
    this.pendingDeliveryBySession.set(sessionId, [])
    const deliveries = order === "reverse" ? [...pending].reverse() : pending
    return deliveries.map((event) => this.copyEvent(event))
  }

  redeliver(eventId: string): RemoteImEventV1 {
    const stored = this.requireEvent(eventId)
    if (stored.lease.permitAcquired) {
      throw new MockGatewayError(
        "EVENT_OUTCOME_UNKNOWN",
        "A permitted event cannot be automatically re-executed"
      )
    }
    const session = this.activeSession(stored.principalId)
    if (!session) throw new MockGatewayError("DESKTOP_OFFLINE", "Desktop session is offline")
    this.replaceLease(stored, session)
    stored.event.redelivered = true
    this.enqueueDelivery(session.sessionId, stored.event)
    return this.copyEvent(stored.event)
  }

  acknowledge(sessionId: string, ack: RemoteImAckV1): void {
    assertRemoteImAckV1(ack)
    const stored = this.requireEvent(ack.eventId)
    this.assertLeaseSession(stored, sessionId)
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

  acquirePermit(input: { eventId: string; sessionId: string; leaseId: string }): MockPermitResult {
    const stored = this.requireEvent(input.eventId)
    try {
      this.assertLeaseSession(stored, input.sessionId)
    } catch (error) {
      if (error instanceof MockGatewayError) {
        return { status: "denied", eventId: input.eventId, reasonCode: error.reasonCode }
      }
      throw error
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

  renewPermit(input: { eventId: string; sessionId: string; leaseId: string }): MockPermitResult {
    const stored = this.requireEvent(input.eventId)
    try {
      this.assertLeaseSession(stored, input.sessionId)
    } catch (error) {
      if (error instanceof MockGatewayError) {
        return { status: "denied", eventId: input.eventId, reasonCode: error.reasonCode }
      }
      throw error
    }
    if (stored.lease.id !== input.leaseId || stored.lease.revoked || !stored.lease.permitAcquired) {
      return { status: "denied", eventId: input.eventId, reasonCode: "LEASE_REVOKED" }
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

  setNextReplyFault(fault: MockReplyFault | null): void {
    this.nextReplyFault = fault
  }

  submitReply(
    sessionId: string,
    reply: RemoteImReplyV1
  ): {
    state: "accepted" | "platform_unknown"
    duplicate: boolean
    platformReplyId?: string
  } {
    assertRemoteImReplyV1(reply)
    const session = this.assertActiveSession(sessionId)
    const conversation = this.conversations.get(reply.conversationKey)
    if (!conversation) throw new MockGatewayError("ROUTE_NOT_FOUND", "Conversation is unknown")
    if (conversation.principalId !== session.principalId) {
      throw new MockGatewayError("PRINCIPAL_MISMATCH", "Conversation belongs to another principal")
    }
    if (reply.eventId) {
      const event = this.requireEvent(reply.eventId).event
      if (event.conversationKey !== reply.conversationKey) {
        throw new MockGatewayError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Reply event identity differs from its conversation"
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

  private routeWaitingConversation(conversationKey: string): void {
    const waiting = this.waitingByConversation.get(conversationKey)
    if (!waiting?.length) return
    const session = this.activeSession(waiting[0].input.principalId)
    if (!session) return
    this.ensureConversation(conversationKey, waiting[0].input.principalId)
    for (const pending of waiting) {
      this.createEvent(pending.input, pending.eventId, pending.conversationSeq, session)
    }
    this.waitingByConversation.delete(conversationKey)
  }

  private createEvent(
    input: MockInboundText,
    eventId: string,
    conversationSeq: number,
    session: MockDesktopSession
  ): RemoteImEventV1 {
    const lease = this.createLease(eventId, session)
    const event: RemoteImEventV1 = {
      schemaVersion: 1,
      eventId,
      platformMessageId: input.platformMessageId,
      principalId: input.principalId,
      conversationKey: input.conversationKey,
      conversationSeq,
      message: { type: "text", text: input.text },
      occurredAt: input.occurredAt ?? new Date(this.now()).toISOString(),
      lease: { id: lease.id, expiresAt: new Date(lease.expiresAt).toISOString() }
    }
    this.events.set(eventId, { event, principalId: input.principalId, lease })
    this.enqueueNextFirstDelivery(input.conversationKey)
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
    const session = this.activeSession(next.principalId)
    if (!session) return
    if (next.lease.sessionId !== session.sessionId) this.replaceLease(next, session)
    this.firstDeliveredEventIds.add(next.event.eventId)
    this.enqueueDelivery(session.sessionId, next.event)
  }

  private redeliverUnpermittedEvents(principalId: string, session: MockDesktopSession): void {
    for (const stored of this.events.values()) {
      if (
        stored.principalId !== principalId ||
        stored.lease.permitAcquired ||
        stored.lease.sessionId === session.sessionId
      ) {
        continue
      }
      this.replaceLease(stored, session)
      stored.event.redelivered = true
      this.enqueueDelivery(session.sessionId, stored.event)
    }
  }

  private replaceLease(stored: StoredMockEvent, session: MockDesktopSession): void {
    stored.lease.revoked = true
    stored.lease = this.createLease(stored.event.eventId, session)
    stored.event.lease = {
      id: stored.lease.id,
      expiresAt: new Date(stored.lease.expiresAt).toISOString()
    }
  }

  private createLease(eventId: string, session: MockDesktopSession): MockLease {
    return {
      id: randomUUID(),
      eventId,
      sessionId: session.sessionId,
      connectionGeneration: session.connectionGeneration,
      expiresAt: this.now() + 90_000,
      permitAcquired: false,
      revoked: false
    }
  }

  private enqueueDelivery(sessionId: string, event: RemoteImEventV1): void {
    const pending = this.pendingDeliveryBySession.get(sessionId) ?? []
    pending.push(this.copyEvent(event))
    this.pendingDeliveryBySession.set(sessionId, pending)
  }

  private ensureConversation(conversationKey: string, principalId: string): void {
    const existing = this.conversations.get(conversationKey)
    if (existing && existing.principalId !== principalId) {
      throw new MockGatewayError("PRINCIPAL_MISMATCH", "Conversation owner changed")
    }
    if (!existing) this.conversations.set(conversationKey, { conversationKey, principalId })
  }

  private activeSession(principalId: string): MockDesktopSession | null {
    const sessionId = this.activeSessionByPrincipal.get(principalId)
    const session = sessionId ? this.sessions.get(sessionId) : undefined
    return session?.connected && !session.superseded ? session : null
  }

  private assertActiveSession(sessionId: string): MockDesktopSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new MockGatewayError("DESKTOP_OFFLINE", "Desktop session is offline")
    }
    const activeSessionId = this.activeSessionByPrincipal.get(session.principalId)
    if (session.superseded || (activeSessionId && activeSessionId !== session.sessionId)) {
      throw new MockGatewayError("SESSION_SUPERSEDED", "Desktop session was superseded")
    }
    if (!session.connected || !activeSessionId) {
      throw new MockGatewayError("DESKTOP_OFFLINE", "Desktop session is offline")
    }
    return session
  }

  private assertLeaseSession(stored: StoredMockEvent, sessionId: string): void {
    const session = this.assertActiveSession(sessionId)
    if (stored.principalId !== session.principalId) {
      throw new MockGatewayError("PRINCIPAL_MISMATCH", "Event belongs to another principal")
    }
    if (
      stored.lease.sessionId !== session.sessionId ||
      stored.lease.connectionGeneration !== session.connectionGeneration
    ) {
      throw new MockGatewayError("LEASE_REVOKED", "Lease belongs to a stale connection")
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
