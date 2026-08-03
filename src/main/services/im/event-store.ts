import {
  assertRemoteImEventV1,
  assertRemoteImReplyV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../../../shared/im-gateway-contract"
import { flushStrict, getDb, saveToDisk } from "../../db"
import type { ImTargetSnapshot } from "./conversation-state"
import { ImConversationStateError } from "./conversation-state"
import type { ImPersistenceDependencies } from "./persistence"
import { readAll, readOne, withImTransaction } from "./persistence"

export type ImEventState =
  | "received"
  | "queued"
  | "executing"
  | "waiting_desktop"
  | "completed"
  | "cancelled"
  | "failed"
  | "rejected"
  | "outcome_unknown"

export type ImPermitState = "unacquired" | "acquired" | "revoked"
export type ImReplyOutboxState = "pending" | "sending" | "sent" | "unknown" | "failed"

export interface ImEventRecord {
  eventId: string
  platformMessageId: string
  conversationKey: string
  conversationSeq: number
  principalId: string
  leaseId: string
  leaseExpiresAt: number
  permitState: ImPermitState
  permitExpiresAt: number | null
  messageText: string
  occurredAt: number
  targetSnapshot: ImTargetSnapshot | null
  state: ImEventState
  runId: string | null
  retryOfEventId: string | null
  resultText: string | null
  reasonCode: string | null
  retryable: boolean | null
  createdAt: number
  updatedAt: number
  acceptedAt: number | null
  executionStartedAt: number | null
  finishedAt: number | null
}

export interface ImReplyOutboxRecord {
  outboxId: string
  deliveryId: string
  eventId: string | null
  conversationKey: string
  idempotencyKey: string
  segmentIndex: number
  segmentCount: number
  content: string
  state: ImReplyOutboxState
  platformReplyId: string | null
  attemptCount: number
  nextAttemptAt: number | null
  reasonCode: string | null
  createdAt: number
  updatedAt: number
}

interface ImEventRow {
  event_id: string
  platform_message_id: string
  conversation_key: string
  conversation_seq: number
  principal_id: string
  lease_id: string
  lease_expires_at: number
  permit_state: ImPermitState
  permit_expires_at: number | null
  message_text: string
  occurred_at: number
  target_snapshot_json: string | null
  state: ImEventState
  run_id: string | null
  retry_of_event_id: string | null
  result_text: string | null
  reason_code: string | null
  retryable: number | null
  created_at: number
  updated_at: number
  accepted_at: number | null
  execution_started_at: number | null
  finished_at: number | null
}

interface ImReplyOutboxRow {
  outbox_id: string
  delivery_id: string
  event_id: string | null
  conversation_key: string
  idempotency_key: string
  segment_index: number
  segment_count: number
  content: string
  state: ImReplyOutboxState
  platform_reply_id: string | null
  attempt_count: number
  next_attempt_at: number | null
  reason_code: string | null
  created_at: number
  updated_at: number
}

interface ImConversationRouteRow {
  conversation_key: string
  principal_id: string
  state: "active" | "suspended" | "revoked"
}

const TERMINAL_EVENT_STATES = new Set<ImEventState>([
  "completed",
  "cancelled",
  "failed",
  "rejected",
  "outcome_unknown"
])

const EVENT_TRANSITIONS: Record<ImEventState, ReadonlySet<ImEventState>> = {
  received: new Set(["queued", "completed", "rejected"]),
  queued: new Set(["executing", "cancelled", "failed", "rejected"]),
  executing: new Set(["waiting_desktop", "completed", "cancelled", "failed", "outcome_unknown"]),
  waiting_desktop: new Set(["executing", "cancelled", "failed", "outcome_unknown"]),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
  rejected: new Set(),
  outcome_unknown: new Set()
}

export class ImEventStoreError extends Error {
  constructor(
    readonly code:
      | "EVENT_NOT_FOUND"
      | "EVENT_IDENTITY_CONFLICT"
      | "INVALID_EVENT_TRANSITION"
      | "EVENT_TERMINAL"
      | "TARGET_SNAPSHOT_REQUIRED"
      | "LEASE_MISMATCH"
      | "LEASE_EXPIRED"
      | "PERMIT_REQUIRED"
      | "PERMIT_REVOKED"
      | "REPLY_IDEMPOTENCY_CONFLICT"
      | "OUTBOX_INCOMPLETE",
    message: string
  ) {
    super(message)
    this.name = "ImEventStoreError"
  }
}

function parseTargetSnapshot(value: string | null): ImTargetSnapshot | null {
  if (!value) return null
  try {
    return JSON.parse(value) as ImTargetSnapshot
  } catch {
    throw new ImEventStoreError("EVENT_IDENTITY_CONFLICT", "Stored target snapshot is invalid")
  }
}

function hydrateEvent(row: ImEventRow): ImEventRecord {
  return {
    eventId: row.event_id,
    platformMessageId: row.platform_message_id,
    conversationKey: row.conversation_key,
    conversationSeq: Number(row.conversation_seq),
    principalId: row.principal_id,
    leaseId: row.lease_id,
    leaseExpiresAt: Number(row.lease_expires_at),
    permitState: row.permit_state,
    permitExpiresAt: row.permit_expires_at === null ? null : Number(row.permit_expires_at),
    messageText: row.message_text,
    occurredAt: Number(row.occurred_at),
    targetSnapshot: parseTargetSnapshot(row.target_snapshot_json),
    state: row.state,
    runId: row.run_id ?? null,
    retryOfEventId: row.retry_of_event_id ?? null,
    resultText: row.result_text ?? null,
    reasonCode: row.reason_code ?? null,
    retryable: row.retryable === null ? null : Number(row.retryable) !== 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
    executionStartedAt: row.execution_started_at === null ? null : Number(row.execution_started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at)
  }
}

function hydrateOutbox(row: ImReplyOutboxRow): ImReplyOutboxRecord {
  return {
    outboxId: row.outbox_id,
    deliveryId: row.delivery_id,
    eventId: row.event_id ?? null,
    conversationKey: row.conversation_key,
    idempotencyKey: row.idempotency_key,
    segmentIndex: Number(row.segment_index),
    segmentCount: Number(row.segment_count),
    content: row.content,
    state: row.state,
    platformReplyId: row.platform_reply_id ?? null,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    reasonCode: row.reason_code ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function sameRemoteEvent(row: ImEventRow, event: RemoteImEventV1): boolean {
  return (
    row.event_id === event.eventId &&
    row.platform_message_id === event.platformMessageId &&
    row.conversation_key === event.conversationKey &&
    Number(row.conversation_seq) === event.conversationSeq &&
    row.principal_id === event.principalId &&
    row.message_text === event.message.text &&
    Number(row.occurred_at) === Date.parse(event.occurredAt)
  )
}

function samePersistedReply(row: ImReplyOutboxRow, reply: RemoteImReplyV1): boolean {
  return (
    row.delivery_id === reply.deliveryId &&
    row.event_id === (reply.eventId ?? null) &&
    row.conversation_key === reply.conversationKey &&
    row.idempotency_key === reply.idempotencyKey &&
    Number(row.segment_index) === reply.segment.index &&
    Number(row.segment_count) === reply.segment.count &&
    row.content === reply.message.content
  )
}

function normalizeReplies(
  event: ImEventRecord,
  replies: readonly RemoteImReplyV1[]
): RemoteImReplyV1[] {
  if (replies.length === 0) {
    throw new ImEventStoreError("OUTBOX_INCOMPLETE", "At least one reply segment is required")
  }
  for (const reply of replies) assertRemoteImReplyV1(reply)
  const ordered = [...replies].sort((left, right) => left.segment.index - right.segment.index)
  const first = ordered[0]
  const count = first.segment.count
  if (ordered.length !== count) {
    throw new ImEventStoreError("OUTBOX_INCOMPLETE", "Reply segment count is incomplete")
  }
  const keys = new Set<string>()
  for (const [index, reply] of ordered.entries()) {
    if (
      reply.segment.index !== index ||
      reply.segment.count !== count ||
      reply.deliveryId !== first.deliveryId ||
      reply.eventId !== event.eventId ||
      reply.conversationKey !== event.conversationKey
    ) {
      throw new ImEventStoreError(
        "OUTBOX_INCOMPLETE",
        "Reply segments do not form one event delivery"
      )
    }
    if (keys.has(reply.idempotencyKey)) {
      throw new ImEventStoreError(
        "REPLY_IDEMPOTENCY_CONFLICT",
        "Reply segment idempotency keys must be unique"
      )
    }
    keys.add(reply.idempotencyKey)
  }
  return ordered
}

function normalizeProactiveReplies(replies: readonly RemoteImReplyV1[]): RemoteImReplyV1[] {
  if (replies.length === 0) {
    throw new ImEventStoreError("OUTBOX_INCOMPLETE", "At least one reply segment is required")
  }
  for (const reply of replies) assertRemoteImReplyV1(reply)
  const ordered = [...replies].sort((left, right) => left.segment.index - right.segment.index)
  const first = ordered[0]
  const keys = new Set<string>()
  for (const [index, reply] of ordered.entries()) {
    if (
      reply.eventId !== undefined ||
      reply.segment.index !== index ||
      reply.segment.count !== ordered.length ||
      reply.deliveryId !== first.deliveryId ||
      reply.conversationKey !== first.conversationKey
    ) {
      throw new ImEventStoreError(
        "OUTBOX_INCOMPLETE",
        "Proactive reply segments do not form one delivery"
      )
    }
    if (keys.has(reply.idempotencyKey)) {
      throw new ImEventStoreError(
        "REPLY_IDEMPOTENCY_CONFLICT",
        "Reply segment idempotency keys must be unique"
      )
    }
    keys.add(reply.idempotencyKey)
  }
  return ordered
}

export class ImEventStore {
  constructor(private readonly dependencies: ImPersistenceDependencies) {}

  getEvent(eventId: string): ImEventRecord | null {
    const row = readOne<ImEventRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_events WHERE event_id = ?",
      [eventId]
    )
    return row ? hydrateEvent(row) : null
  }

  listConversationEvents(conversationKey: string): ImEventRecord[] {
    return readAll<ImEventRow>(
      this.dependencies.getDatabase(),
      "SELECT * FROM im_events WHERE conversation_key = ? ORDER BY conversation_seq ASC",
      [conversationKey]
    ).map(hydrateEvent)
  }

  getNextQueuedEvent(conversationKey: string): ImEventRecord | null {
    const row = readOne<ImEventRow>(
      this.dependencies.getDatabase(),
      `SELECT * FROM im_events
       WHERE conversation_key = ? AND state = 'queued'
       ORDER BY conversation_seq ASC LIMIT 1`,
      [conversationKey]
    )
    return row ? hydrateEvent(row) : null
  }

  listQueuedConversationKeys(): string[] {
    return readAll<{ conversation_key: string }>(
      this.dependencies.getDatabase(),
      `SELECT conversation_key, MIN(conversation_seq) AS first_seq
       FROM im_events WHERE state = 'queued'
       GROUP BY conversation_key ORDER BY first_seq ASC, conversation_key ASC`
    ).map((row) => row.conversation_key)
  }

  async receiveEvent(
    event: RemoteImEventV1,
    targetSnapshot: ImTargetSnapshot | null,
    options: { retryOfEventId?: string } = {}
  ): Promise<{ duplicate: boolean; event: ImEventRecord }> {
    assertRemoteImEventV1(event)
    const database = this.dependencies.getDatabase()
    const identityRows = readAll<ImEventRow>(
      database,
      `SELECT * FROM im_events
       WHERE event_id = ? OR platform_message_id = ?
          OR (conversation_key = ? AND conversation_seq = ?)`,
      [event.eventId, event.platformMessageId, event.conversationKey, event.conversationSeq]
    )
    if (identityRows.length > 0) {
      const existing = identityRows[0]
      const everyIdentityMatches = identityRows.every((row) => row.event_id === existing.event_id)
      if (!everyIdentityMatches || !sameRemoteEvent(existing, event)) {
        throw new ImEventStoreError(
          "EVENT_IDENTITY_CONFLICT",
          "Event id, platform message id, or conversation sequence was reused"
        )
      }
      if (
        existing.permit_state === "unacquired" &&
        (existing.state === "received" || existing.state === "queued") &&
        (existing.lease_id !== event.lease.id ||
          Number(existing.lease_expires_at) !== Date.parse(event.lease.expiresAt))
      ) {
        const replacementExpiry = Date.parse(event.lease.expiresAt)
        if (replacementExpiry <= this.dependencies.now()) {
          throw new ImEventStoreError("LEASE_EXPIRED", "Redelivered event lease is expired")
        }
        database.run(
          `UPDATE im_events
           SET lease_id = ?, lease_expires_at = ?, updated_at = ?
           WHERE event_id = ? AND permit_state = 'unacquired'
             AND state IN ('received', 'queued')`,
          [event.lease.id, replacementExpiry, this.dependencies.now(), event.eventId]
        )
        this.dependencies.markDirty()
      }
      await this.dependencies.flushStrict()
      return { duplicate: true, event: this.requireEvent(event.eventId) }
    }
    if (!targetSnapshot) {
      throw new ImEventStoreError(
        "TARGET_SNAPSHOT_REQUIRED",
        "A new ordinary event requires an immutable target snapshot"
      )
    }

    const route = readOne<ImConversationRouteRow>(
      database,
      "SELECT conversation_key, principal_id, state FROM im_conversations WHERE conversation_key = ?",
      [event.conversationKey]
    )
    if (!route) {
      throw new ImConversationStateError("CONVERSATION_NOT_FOUND", "Conversation is unknown")
    }
    if (route.principal_id !== event.principalId) {
      throw new ImConversationStateError("PRINCIPAL_MISMATCH", "Conversation principal differs")
    }
    if (route.state === "revoked") {
      throw new ImConversationStateError("CONVERSATION_REVOKED", "Conversation is revoked")
    }

    const target = readOne<{ conversation_key: string; state: string }>(
      database,
      "SELECT conversation_key, state FROM im_targets WHERE target_id = ?",
      [targetSnapshot.targetId]
    )
    if (!target || target.conversation_key !== event.conversationKey || target.state !== "active") {
      throw new ImConversationStateError("TARGET_NOT_ACTIVE", "Target snapshot is unavailable")
    }

    const occurredAt = Date.parse(event.occurredAt)
    const leaseExpiresAt = Date.parse(event.lease.expiresAt)
    const now = this.dependencies.now()
    withImTransaction(database, () => {
      database.run(
        `INSERT INTO im_events (
           event_id, platform_message_id, conversation_key, conversation_seq, principal_id,
           lease_id, lease_expires_at, permit_state, permit_expires_at,
           message_text, occurred_at, target_snapshot_json, state, run_id, retry_of_event_id,
           result_text, reason_code, retryable, created_at, updated_at, accepted_at,
           execution_started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unacquired', NULL, ?, ?, ?, 'received', NULL, ?,
                   NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
        [
          event.eventId,
          event.platformMessageId,
          event.conversationKey,
          event.conversationSeq,
          event.principalId,
          event.lease.id,
          leaseExpiresAt,
          event.message.text,
          occurredAt,
          JSON.stringify(targetSnapshot),
          options.retryOfEventId ?? null,
          now,
          now
        ]
      )
      database.run(
        `UPDATE im_conversations
         SET last_received_seq = MAX(last_received_seq, ?), updated_at = ?
         WHERE conversation_key = ?`,
        [event.conversationSeq, now, event.conversationKey]
      )
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    const inserted = this.getEvent(event.eventId)
    if (!inserted) throw new ImEventStoreError("EVENT_NOT_FOUND", "Inserted event is unavailable")
    return { duplicate: false, event: inserted }
  }

  async queueEvent(eventId: string): Promise<ImEventRecord> {
    const event = this.requireEvent(eventId)
    if (event.state === "queued") {
      await this.dependencies.flushStrict()
      return event
    }
    return this.transitionEvent(eventId, "queued", { acceptedAt: this.dependencies.now() })
  }

  async recordExecutionPermit(input: {
    eventId: string
    leaseId: string
    previousLeaseId?: string
    expiresAt: string | number
  }): Promise<ImEventRecord> {
    const event = this.requireEvent(input.eventId)
    if (event.state !== "queued") {
      throw new ImEventStoreError(
        "INVALID_EVENT_TRANSITION",
        "Only a queued event can acquire a permit"
      )
    }
    const previousLeaseId = input.previousLeaseId ?? input.leaseId
    if (event.leaseId !== previousLeaseId) {
      throw new ImEventStoreError("LEASE_MISMATCH", "Permit replaces an unexpected lease")
    }
    const expiresAt =
      typeof input.expiresAt === "number" ? input.expiresAt : Date.parse(input.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) {
      throw new ImEventStoreError("LEASE_EXPIRED", "Execution permit is already expired")
    }
    const database = this.dependencies.getDatabase()
    database.run(
      `UPDATE im_events
       SET lease_id = ?, lease_expires_at = ?, permit_state = 'acquired',
           permit_expires_at = ?, updated_at = ?
       WHERE event_id = ? AND state = 'queued' AND lease_id = ?
         AND EXISTS (
           SELECT 1 FROM im_conversations conversation
           WHERE conversation.conversation_key = im_events.conversation_key
             AND conversation.principal_id = im_events.principal_id
             AND conversation.state = 'active'
         )`,
      [input.leaseId, expiresAt, expiresAt, this.dependencies.now(), input.eventId, previousLeaseId]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImEventStoreError("LEASE_MISMATCH", "Execution permit no longer matches event")
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.requireEvent(input.eventId)
  }

  async renewExecutionPermit(input: {
    eventId: string
    leaseId: string
    expiresAt: string | number
  }): Promise<ImEventRecord> {
    const expiresAt =
      typeof input.expiresAt === "number" ? input.expiresAt : Date.parse(input.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) {
      throw new ImEventStoreError("LEASE_EXPIRED", "Renewed execution permit is expired")
    }
    const database = this.dependencies.getDatabase()
    database.run(
      `UPDATE im_events
       SET lease_expires_at = ?, permit_expires_at = ?, updated_at = ?
       WHERE event_id = ? AND lease_id = ? AND permit_state = 'acquired'
         AND state IN ('queued', 'executing', 'waiting_desktop')`,
      [expiresAt, expiresAt, this.dependencies.now(), input.eventId, input.leaseId]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImEventStoreError("LEASE_MISMATCH", "Execution permit cannot be renewed")
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.requireEvent(input.eventId)
  }

  async beginExecution(eventId: string, runId: string): Promise<ImEventRecord> {
    const event = this.requireEvent(eventId)
    if (event.state === "executing" && event.runId === runId) {
      await this.dependencies.flushStrict()
      return event
    }
    if (event.state !== "queued") {
      throw new ImEventStoreError("INVALID_EVENT_TRANSITION", "Only a queued event can execute")
    }
    if (event.permitState === "revoked") {
      throw new ImEventStoreError("PERMIT_REVOKED", "Execution permit is revoked")
    }
    if (
      event.permitState !== "acquired" ||
      event.permitExpiresAt === null ||
      event.permitExpiresAt <= this.dependencies.now()
    ) {
      throw new ImEventStoreError("PERMIT_REQUIRED", "A current execution permit is required")
    }
    const currentRoute = readOne<ImConversationRouteRow>(
      this.dependencies.getDatabase(),
      "SELECT conversation_key, principal_id, state FROM im_conversations WHERE conversation_key = ?",
      [event.conversationKey]
    )
    if (
      !currentRoute ||
      currentRoute.state !== "active" ||
      currentRoute.principal_id !== event.principalId
    ) {
      throw new ImEventStoreError("LEASE_MISMATCH", "Event conversation ownership changed")
    }
    return this.transitionEvent(eventId, "executing", {
      runId,
      executionStartedAt: this.dependencies.now()
    })
  }

  async markWaitingDesktop(eventId: string): Promise<ImEventRecord> {
    return this.transitionEvent(eventId, "waiting_desktop")
  }

  async resumeFromDesktop(eventId: string): Promise<ImEventRecord> {
    const event = this.requireEvent(eventId)
    if (
      event.permitState !== "acquired" ||
      event.permitExpiresAt === null ||
      event.permitExpiresAt <= this.dependencies.now()
    ) {
      throw new ImEventStoreError("PERMIT_REQUIRED", "A renewed execution permit is required")
    }
    return this.transitionEvent(eventId, "executing")
  }

  async completeEvent(
    eventId: string,
    replies: readonly RemoteImReplyV1[],
    resultText: string
  ): Promise<ImEventRecord> {
    return this.finalizeEventWithReplies({
      eventId,
      state: "completed",
      replies,
      resultText,
      retryable: false
    })
  }

  async finalizeEventWithReplies(input: {
    eventId: string
    state: "completed" | "cancelled" | "failed" | "rejected" | "outcome_unknown"
    replies: readonly RemoteImReplyV1[]
    resultText: string
    reasonCode?: string
    retryable: boolean
  }): Promise<ImEventRecord> {
    const { eventId } = input
    const event = this.requireEvent(eventId)
    const normalizedReplies = normalizeReplies(event, input.replies)
    const database = this.dependencies.getDatabase()
    const persisted = readAll<ImReplyOutboxRow>(
      database,
      "SELECT * FROM im_reply_outbox WHERE event_id = ? ORDER BY segment_index ASC",
      [eventId]
    )
    if (event.state === input.state) {
      if (
        persisted.length !== normalizedReplies.length ||
        persisted.some((row, index) => !samePersistedReply(row, normalizedReplies[index]))
      ) {
        throw new ImEventStoreError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Terminal event reply differs from its durable outbox"
        )
      }
      await this.dependencies.flushStrict()
      return event
    }
    this.assertTransition(event.state, input.state)
    if (persisted.length > 0) {
      throw new ImEventStoreError(
        "REPLY_IDEMPOTENCY_CONFLICT",
        "Event already has a different partial outbox"
      )
    }

    const now = this.dependencies.now()
    withImTransaction(database, () => {
      for (const reply of normalizedReplies) {
        database.run(
          `INSERT INTO im_reply_outbox (
             outbox_id, delivery_id, event_id, conversation_key,
             idempotency_key, segment_index, segment_count, content, state,
             platform_reply_id, attempt_count, next_attempt_at, reason_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?, ?)`,
          [
            `${reply.deliveryId}:${reply.segment.index}`,
            reply.deliveryId,
            eventId,
            reply.conversationKey,
            reply.idempotencyKey,
            reply.segment.index,
            reply.segment.count,
            reply.message.content,
            now,
            now,
            now
          ]
        )
      }
      database.run(
        `UPDATE im_events
         SET state = ?, result_text = ?, reason_code = ?, retryable = ?,
             permit_state = 'revoked', updated_at = ?, finished_at = ?
         WHERE event_id = ? AND state = ?`,
        [
          input.state,
          input.resultText,
          input.reasonCode?.trim() || null,
          input.retryable ? 1 : 0,
          now,
          now,
          eventId,
          event.state
        ]
      )
      if (database.getRowsModified() !== 1) {
        throw new ImEventStoreError(
          "INVALID_EVENT_TRANSITION",
          "Event changed while its outbox was being committed"
        )
      }
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.requireEvent(eventId)
  }

  async enqueueProactiveReplies(
    replies: readonly RemoteImReplyV1[]
  ): Promise<ImReplyOutboxRecord[]> {
    const normalized = normalizeProactiveReplies(replies)
    const database = this.dependencies.getDatabase()
    const deliveryId = normalized[0].deliveryId
    const persisted = readAll<ImReplyOutboxRow>(
      database,
      "SELECT * FROM im_reply_outbox WHERE delivery_id = ? ORDER BY segment_index ASC",
      [deliveryId]
    )
    if (persisted.length > 0) {
      if (
        persisted.length !== normalized.length ||
        persisted.some((row, index) => !samePersistedReply(row, normalized[index]))
      ) {
        throw new ImEventStoreError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Proactive delivery differs from its durable outbox"
        )
      }
      await this.dependencies.flushStrict()
      return persisted.map(hydrateOutbox)
    }

    const now = this.dependencies.now()
    withImTransaction(database, () => {
      for (const reply of normalized) {
        database.run(
          `INSERT INTO im_reply_outbox (
             outbox_id, delivery_id, event_id, conversation_key,
             idempotency_key, segment_index, segment_count, content, state,
             platform_reply_id, attempt_count, next_attempt_at, reason_code, created_at, updated_at
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL, ?, ?)`,
          [
            `${reply.deliveryId}:${reply.segment.index}`,
            reply.deliveryId,
            reply.conversationKey,
            reply.idempotencyKey,
            reply.segment.index,
            reply.segment.count,
            reply.message.content,
            now,
            now,
            now
          ]
        )
      }
    })
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return readAll<ImReplyOutboxRow>(
      database,
      "SELECT * FROM im_reply_outbox WHERE delivery_id = ? ORDER BY segment_index ASC",
      [deliveryId]
    ).map(hydrateOutbox)
  }

  async cancelEvent(eventId: string, reasonCode: string): Promise<ImEventRecord> {
    return this.transitionEvent(eventId, "cancelled", {
      reasonCode,
      retryable: false,
      finishedAt: this.dependencies.now(),
      revokePermit: true
    })
  }

  async failEvent(eventId: string, reasonCode: string, retryable: boolean): Promise<ImEventRecord> {
    return this.transitionEvent(eventId, "failed", {
      reasonCode,
      retryable,
      finishedAt: this.dependencies.now(),
      revokePermit: true
    })
  }

  async rejectEvent(eventId: string, reasonCode: string): Promise<ImEventRecord> {
    return this.transitionEvent(eventId, "rejected", {
      reasonCode,
      retryable: false,
      finishedAt: this.dependencies.now(),
      revokePermit: true
    })
  }

  async handlePermitRevoked(eventId: string, reasonCode = "LEASE_REVOKED"): Promise<ImEventRecord> {
    const event = this.requireEvent(eventId)
    if (TERMINAL_EVENT_STATES.has(event.state)) {
      await this.dependencies.flushStrict()
      return event
    }
    if (event.state === "executing" || event.state === "waiting_desktop") {
      return this.transitionEvent(eventId, "outcome_unknown", {
        reasonCode,
        retryable: true,
        finishedAt: this.dependencies.now(),
        revokePermit: true
      })
    }
    return this.cancelEvent(eventId, reasonCode)
  }

  async recoverInterruptedEvents(): Promise<string[]> {
    const database = this.dependencies.getDatabase()
    const interrupted = readAll<{ event_id: string }>(
      database,
      "SELECT event_id FROM im_events WHERE state IN ('executing', 'waiting_desktop') ORDER BY created_at ASC"
    ).map((row) => row.event_id)
    if (interrupted.length === 0) {
      await this.dependencies.flushStrict()
      return []
    }
    const now = this.dependencies.now()
    database.run(
      `UPDATE im_events
       SET state = 'outcome_unknown', permit_state = 'revoked',
           reason_code = 'PROCESS_RESTARTED_DURING_EXECUTION', retryable = 1,
           updated_at = ?, finished_at = ?
       WHERE state IN ('executing', 'waiting_desktop')`,
      [now, now]
    )
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return interrupted
  }

  async recoverInterruptedOutbox(): Promise<string[]> {
    const database = this.dependencies.getDatabase()
    const interrupted = readAll<{ outbox_id: string }>(
      database,
      "SELECT outbox_id FROM im_reply_outbox WHERE state = 'sending' ORDER BY created_at ASC, segment_index ASC"
    ).map((row) => row.outbox_id)
    if (interrupted.length === 0) {
      await this.dependencies.flushStrict()
      return []
    }
    const now = this.dependencies.now()
    database.run(
      `UPDATE im_reply_outbox
       SET state = 'pending', next_attempt_at = ?,
           reason_code = 'CLIENT_RESTART_RETRY', updated_at = ?
       WHERE state = 'sending'`,
      [now, now]
    )
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return interrupted
  }

  listOutbox(state?: ImReplyOutboxState): ImReplyOutboxRecord[] {
    const rows = state
      ? readAll<ImReplyOutboxRow>(
          this.dependencies.getDatabase(),
          "SELECT * FROM im_reply_outbox WHERE state = ? ORDER BY created_at ASC, segment_index ASC",
          [state]
        )
      : readAll<ImReplyOutboxRow>(
          this.dependencies.getDatabase(),
          "SELECT * FROM im_reply_outbox ORDER BY created_at ASC, segment_index ASC"
        )
    return rows.map(hydrateOutbox)
  }

  async markOutboxSending(outboxId: string): Promise<ImReplyOutboxRecord> {
    return this.updateOutbox(outboxId, ["pending", "sending"], "sending", {
      incrementAttempt: true
    })
  }

  async markOutboxSent(outboxId: string, platformReplyId: string): Promise<ImReplyOutboxRecord> {
    return this.updateOutbox(outboxId, ["sending", "sent"], "sent", { platformReplyId })
  }

  async markOutboxUnknown(outboxId: string, reasonCode: string): Promise<ImReplyOutboxRecord> {
    return this.updateOutbox(outboxId, ["sending", "unknown"], "unknown", { reasonCode })
  }

  async markOutboxFailed(outboxId: string, reasonCode: string): Promise<ImReplyOutboxRecord> {
    return this.updateOutbox(outboxId, ["pending", "sending", "failed"], "failed", {
      reasonCode
    })
  }

  async rescheduleOutbox(
    outboxId: string,
    nextAttemptAt: number,
    reasonCode: string
  ): Promise<ImReplyOutboxRecord> {
    return this.updateOutbox(outboxId, ["sending", "pending"], "pending", {
      nextAttemptAt,
      reasonCode
    })
  }

  getStatusSummary(): { eventCounts: Record<string, number>; pendingOutboxCount: number } {
    const eventCounts: Record<string, number> = {}
    for (const row of readAll<{ state: string; count: number }>(
      this.dependencies.getDatabase(),
      "SELECT state, COUNT(*) AS count FROM im_events GROUP BY state"
    )) {
      eventCounts[row.state] = Number(row.count)
    }
    const pending = readOne<{ count: number }>(
      this.dependencies.getDatabase(),
      "SELECT COUNT(*) AS count FROM im_reply_outbox WHERE state IN ('pending', 'sending', 'unknown')"
    )
    return { eventCounts, pendingOutboxCount: Number(pending?.count ?? 0) }
  }

  async cleanupExpiredTerminalData(retentionMs = 7 * 24 * 60 * 60 * 1_000): Promise<{
    deletedEvents: number
    deletedOutboxSegments: number
  }> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) {
      throw new Error("IM retention must be at least one minute")
    }
    const database = this.dependencies.getDatabase()
    const cutoff = this.dependencies.now() - retentionMs
    const eligibleEventIds = readAll<{ event_id: string }>(
      database,
      `SELECT event.event_id
       FROM im_events event
       WHERE event.state IN ('completed', 'cancelled', 'failed', 'rejected', 'outcome_unknown')
         AND event.finished_at IS NOT NULL AND event.finished_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM im_reply_outbox outbox
           WHERE outbox.event_id = event.event_id
             AND outbox.state IN ('pending', 'sending', 'unknown')
         )`,
      [cutoff]
    ).map((row) => row.event_id)
    let deletedEvents = 0
    let deletedOutboxSegments = 0
    withImTransaction(database, () => {
      if (eligibleEventIds.length > 0) {
        const placeholders = eligibleEventIds.map(() => "?").join(",")
        database.run(
          `DELETE FROM im_reply_outbox WHERE event_id IN (${placeholders})`,
          eligibleEventIds
        )
        deletedOutboxSegments += database.getRowsModified()
        database.run(`DELETE FROM im_events WHERE event_id IN (${placeholders})`, eligibleEventIds)
        deletedEvents += database.getRowsModified()
      }
      database.run(
        `DELETE FROM im_reply_outbox
         WHERE event_id IS NULL AND updated_at < ? AND state IN ('sent', 'failed')`,
        [cutoff]
      )
      deletedOutboxSegments += database.getRowsModified()
    })
    if (deletedEvents > 0 || deletedOutboxSegments > 0) this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return { deletedEvents, deletedOutboxSegments }
  }

  private requireEvent(eventId: string): ImEventRecord {
    const event = this.getEvent(eventId)
    if (!event) throw new ImEventStoreError("EVENT_NOT_FOUND", "Event is unknown")
    return event
  }

  private assertTransition(from: ImEventState, to: ImEventState): void {
    if (!EVENT_TRANSITIONS[from].has(to)) {
      throw new ImEventStoreError(
        TERMINAL_EVENT_STATES.has(from) ? "EVENT_TERMINAL" : "INVALID_EVENT_TRANSITION",
        `Event cannot transition from ${from} to ${to}`
      )
    }
  }

  private async transitionEvent(
    eventId: string,
    state: ImEventState,
    options: {
      runId?: string
      reasonCode?: string
      retryable?: boolean
      acceptedAt?: number
      executionStartedAt?: number
      finishedAt?: number
      revokePermit?: boolean
    } = {}
  ): Promise<ImEventRecord> {
    const event = this.requireEvent(eventId)
    if (event.state === state) {
      await this.dependencies.flushStrict()
      return event
    }
    this.assertTransition(event.state, state)
    const database = this.dependencies.getDatabase()
    database.run(
      `UPDATE im_events
       SET state = ?, run_id = COALESCE(?, run_id), reason_code = ?, retryable = ?,
           accepted_at = COALESCE(?, accepted_at),
           execution_started_at = COALESCE(?, execution_started_at),
           finished_at = COALESCE(?, finished_at),
           permit_state = CASE WHEN ? = 1 THEN 'revoked' ELSE permit_state END,
           updated_at = ?
       WHERE event_id = ? AND state = ?`,
      [
        state,
        options.runId ?? null,
        options.reasonCode ?? null,
        options.retryable === undefined ? null : options.retryable ? 1 : 0,
        options.acceptedAt ?? null,
        options.executionStartedAt ?? null,
        options.finishedAt ?? null,
        options.revokePermit ? 1 : 0,
        this.dependencies.now(),
        eventId,
        event.state
      ]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImEventStoreError(
        "INVALID_EVENT_TRANSITION",
        "Event changed before its transition committed"
      )
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    return this.requireEvent(eventId)
  }

  private async updateOutbox(
    outboxId: string,
    allowedStates: ImReplyOutboxState[],
    nextState: ImReplyOutboxState,
    options: {
      incrementAttempt?: boolean
      platformReplyId?: string
      nextAttemptAt?: number
      reasonCode?: string
    }
  ): Promise<ImReplyOutboxRecord> {
    const database = this.dependencies.getDatabase()
    const existing = readOne<ImReplyOutboxRow>(
      database,
      "SELECT * FROM im_reply_outbox WHERE outbox_id = ?",
      [outboxId]
    )
    if (!existing) throw new ImEventStoreError("EVENT_NOT_FOUND", "Outbox segment is unknown")
    if (existing.state === nextState && nextState !== "sending") {
      if (
        nextState === "sent" &&
        options.platformReplyId &&
        existing.platform_reply_id !== options.platformReplyId
      ) {
        throw new ImEventStoreError(
          "REPLY_IDEMPOTENCY_CONFLICT",
          "Sent outbox segment has another platform reply id"
        )
      }
      await this.dependencies.flushStrict()
      return hydrateOutbox(existing)
    }
    if (!allowedStates.includes(existing.state)) {
      throw new ImEventStoreError(
        "INVALID_EVENT_TRANSITION",
        `Outbox cannot transition from ${existing.state} to ${nextState}`
      )
    }
    database.run(
      `UPDATE im_reply_outbox
       SET state = ?,
           attempt_count = attempt_count + ?,
           platform_reply_id = COALESCE(?, platform_reply_id),
           next_attempt_at = ?, reason_code = ?, updated_at = ?
       WHERE outbox_id = ? AND state = ?`,
      [
        nextState,
        options.incrementAttempt ? 1 : 0,
        options.platformReplyId ?? null,
        options.nextAttemptAt ?? null,
        options.reasonCode ?? null,
        this.dependencies.now(),
        outboxId,
        existing.state
      ]
    )
    if (database.getRowsModified() !== 1) {
      throw new ImEventStoreError("INVALID_EVENT_TRANSITION", "Outbox segment changed")
    }
    this.dependencies.markDirty()
    await this.dependencies.flushStrict()
    const updated = readOne<ImReplyOutboxRow>(
      database,
      "SELECT * FROM im_reply_outbox WHERE outbox_id = ?",
      [outboxId]
    )
    if (!updated) throw new ImEventStoreError("EVENT_NOT_FOUND", "Outbox segment disappeared")
    return hydrateOutbox(updated)
  }
}

export const imEventStore = new ImEventStore({
  getDatabase: getDb,
  markDirty: saveToDisk,
  flushStrict,
  now: Date.now
})

export function isTerminalImEventState(state: ImEventState): boolean {
  return TERMINAL_EVENT_STATES.has(state)
}
