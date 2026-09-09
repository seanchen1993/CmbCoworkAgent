export const IM_GATEWAY_SCHEMA_VERSION = 1 as const

/**
 * IM channel identifier. V1 only supports Zhaohu; add future channels to this
 * union instead of comparing new string literals throughout the app.
 */
export type ImChannelId = "zhaohu"

export const DEFAULT_IM_CHANNEL_ID: ImChannelId = "zhaohu"

/**
 * Current reply limits are Zhaohu channel capabilities, not universal IM
 * limits. A future multi-channel gateway should select these per channel.
 */
export const IM_REPLY_MAX_SEGMENT_CHARACTERS = 2_800
export const IM_REPLY_MAX_SEGMENTS = 8

/**
 * V1 assumes gateway-normalized one-to-one conversations containing text
 * messages only. Group conversations and richer message types require an
 * explicit contract revision instead of leaking channel payloads into clients.
 */
export interface RemoteImEventV1 {
  schemaVersion: typeof IM_GATEWAY_SCHEMA_VERSION
  eventId: string
  platformMessageId: string
  principalId: string
  conversationKey: string
  conversationSeq: number
  message: { type: "text"; text: string }
  occurredAt: string
  lease: { id: string; expiresAt: string }
  redelivered?: boolean
}

export type RemoteImAckV1 =
  | { type: "received"; eventId: string; leaseId: string }
  | { type: "accepted"; eventId: string; leaseId: string }
  | { type: "waiting_desktop"; eventId: string; leaseId: string }
  | { type: "completed"; eventId: string; leaseId: string }
  | { type: "cancelled"; eventId: string; leaseId: string }
  | {
      type: "failed"
      eventId: string
      leaseId: string
      retryable: boolean
      reasonCode: string
    }
  | { type: "busy"; eventId: string; leaseId: string }

export interface RemoteImReplyV1 {
  schemaVersion: typeof IM_GATEWAY_SCHEMA_VERSION
  deliveryId: string
  eventId?: string
  conversationKey: string
  idempotencyKey: string
  segment: { index: number; count: number }
  message: { type: "text"; content: string }
}

export type GatewayReasonCodeV1 =
  | "AUTH_REQUIRED"
  | "PRINCIPAL_MISMATCH"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "INVALID_PAYLOAD"
  | "COMMAND_ID_REUSE"
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_CONFLICT"
  | "PLATFORM_MESSAGE_UNSUPPORTED"
  | "DESKTOP_OFFLINE"
  | "SESSION_SUPERSEDED"
  | "ROUTE_NOT_FOUND"
  | "EVENT_NOT_FOUND"
  | "EVENT_ORDER_BLOCKED"
  | "EVENT_TERMINAL"
  | "EVENT_OUTCOME_UNKNOWN"
  | "INVALID_EVENT_TRANSITION"
  | "LEASE_NOT_FOUND"
  | "LEASE_EXPIRED"
  | "LEASE_REVOKED"
  | "PERMIT_DENIED"
  | "REPLY_IDEMPOTENCY_CONFLICT"
  | "SEGMENT_INVALID"
  | "OUTBOX_INCOMPLETE"
  | "PLATFORM_RETRYABLE_FAILURE"
  | "PLATFORM_PERMANENT_FAILURE"
  | "PLATFORM_RESULT_UNKNOWN"

export class ImGatewayContractError extends Error {
  readonly code: "SCHEMA_VERSION_UNSUPPORTED" | "INVALID_PAYLOAD"

  constructor(code: "SCHEMA_VERSION_UNSUPPORTED" | "INVALID_PAYLOAD", message: string) {
    super(message)
    this.name = "ImGatewayContractError"
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!(key in value))
      throw new ImGatewayContractError("INVALID_PAYLOAD", `${path}.${key} is required`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ImGatewayContractError("INVALID_PAYLOAD", `${path}.${key} is not allowed`)
    }
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", `${path} must be an object`)
  }
  return value
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImGatewayContractError("INVALID_PAYLOAD", `${path} must be a non-empty string`)
  }
  return value
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", `${path} must be a positive integer`)
  }
  return value as number
}

function requireIsoInstant(value: unknown, path: string): string {
  const instant = requireNonEmptyString(value, path)
  if (!Number.isFinite(Date.parse(instant))) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", `${path} must be an ISO-8601 instant`)
  }
  return instant
}

function assertSchemaVersion(value: unknown): asserts value is typeof IM_GATEWAY_SCHEMA_VERSION {
  if (value !== IM_GATEWAY_SCHEMA_VERSION) {
    throw new ImGatewayContractError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `schemaVersion must be ${IM_GATEWAY_SCHEMA_VERSION}`
    )
  }
}

export function assertRemoteImEventV1(value: unknown): asserts value is RemoteImEventV1 {
  const event = requireRecord(value, "event")
  assertExactKeys(
    event,
    [
      "schemaVersion",
      "eventId",
      "platformMessageId",
      "principalId",
      "conversationKey",
      "conversationSeq",
      "message",
      "occurredAt",
      "lease"
    ],
    ["redelivered"],
    "event"
  )
  assertSchemaVersion(event.schemaVersion)
  requireNonEmptyString(event.eventId, "event.eventId")
  requireNonEmptyString(event.platformMessageId, "event.platformMessageId")
  requireNonEmptyString(event.principalId, "event.principalId")
  requireNonEmptyString(event.conversationKey, "event.conversationKey")
  requirePositiveInteger(event.conversationSeq, "event.conversationSeq")
  requireIsoInstant(event.occurredAt, "event.occurredAt")
  if (event.redelivered !== undefined && typeof event.redelivered !== "boolean") {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "event.redelivered must be boolean")
  }

  const message = requireRecord(event.message, "event.message")
  assertExactKeys(message, ["type", "text"], [], "event.message")
  if (message.type !== "text") {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "event.message.type must be text")
  }
  requireNonEmptyString(message.text, "event.message.text")

  const lease = requireRecord(event.lease, "event.lease")
  assertExactKeys(lease, ["id", "expiresAt"], [], "event.lease")
  requireNonEmptyString(lease.id, "event.lease.id")
  requireIsoInstant(lease.expiresAt, "event.lease.expiresAt")
}

const ACK_TYPES = new Set<RemoteImAckV1["type"]>([
  "received",
  "accepted",
  "waiting_desktop",
  "completed",
  "cancelled",
  "failed",
  "busy"
])

export function assertRemoteImAckV1(value: unknown): asserts value is RemoteImAckV1 {
  const ack = requireRecord(value, "ack")
  const type = ack.type
  if (typeof type !== "string" || !ACK_TYPES.has(type as RemoteImAckV1["type"])) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "ack.type is not supported")
  }
  const failed = type === "failed"
  assertExactKeys(
    ack,
    failed
      ? ["type", "eventId", "leaseId", "retryable", "reasonCode"]
      : ["type", "eventId", "leaseId"],
    [],
    "ack"
  )
  requireNonEmptyString(ack.eventId, "ack.eventId")
  requireNonEmptyString(ack.leaseId, "ack.leaseId")
  if (failed) {
    if (typeof ack.retryable !== "boolean") {
      throw new ImGatewayContractError("INVALID_PAYLOAD", "ack.retryable must be boolean")
    }
    requireNonEmptyString(ack.reasonCode, "ack.reasonCode")
  }
}

export function unicodeCharacterLength(value: string): number {
  return Array.from(value).length
}

export function assertRemoteImReplyV1(value: unknown): asserts value is RemoteImReplyV1 {
  const reply = requireRecord(value, "reply")
  assertExactKeys(
    reply,
    ["schemaVersion", "deliveryId", "conversationKey", "idempotencyKey", "segment", "message"],
    ["eventId"],
    "reply"
  )
  assertSchemaVersion(reply.schemaVersion)
  requireNonEmptyString(reply.deliveryId, "reply.deliveryId")
  requireNonEmptyString(reply.conversationKey, "reply.conversationKey")
  requireNonEmptyString(reply.idempotencyKey, "reply.idempotencyKey")
  if (reply.eventId !== undefined) requireNonEmptyString(reply.eventId, "reply.eventId")

  const segment = requireRecord(reply.segment, "reply.segment")
  assertExactKeys(segment, ["index", "count"], [], "reply.segment")
  if (!Number.isSafeInteger(segment.index) || (segment.index as number) < 0) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "reply.segment.index must be 0-based")
  }
  const count = requirePositiveInteger(segment.count, "reply.segment.count")
  if (count > IM_REPLY_MAX_SEGMENTS || (segment.index as number) >= count) {
    throw new ImGatewayContractError(
      "INVALID_PAYLOAD",
      `reply.segment must address one of at most ${IM_REPLY_MAX_SEGMENTS} segments`
    )
  }

  const message = requireRecord(reply.message, "reply.message")
  assertExactKeys(message, ["type", "content"], [], "reply.message")
  if (message.type !== "text") {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "reply.message.type must be text")
  }
  const content = requireNonEmptyString(message.content, "reply.message.content")
  if (unicodeCharacterLength(content) > IM_REPLY_MAX_SEGMENT_CHARACTERS) {
    throw new ImGatewayContractError(
      "INVALID_PAYLOAD",
      `reply.message.content exceeds ${IM_REPLY_MAX_SEGMENT_CHARACTERS} Unicode characters`
    )
  }
}

/**
 * Zhaohu custom-card interaction (V1).
 *
 * A card is an *enhancement* over the text + short-code channel, never a
 * replacement: an approval or question is always published as text first, and
 * a card that fails to render or send leaves that text as the working answer
 * path. Nothing here may become the only way to answer a gate.
 *
 * The card body is the platform's own component array. The gateway forwards it
 * verbatim, so the desktop owns every rendering decision and a new component
 * never needs a gateway release.
 */
export const IM_CARD_MAX_CONTENT_CHARACTERS = 15_000
export const IM_CARD_MAX_COMPONENTS = 30

/** Interaction kinds the desktop can express as a card. */
export type ImCardInteractionKind = "approval" | "user_input"

export interface RemoteImCardSendV1 {
  schemaVersion: typeof IM_GATEWAY_SCHEMA_VERSION
  interactionId: string
  conversationKey: string
  idempotencyKey: string
  /**
   * Bearer capability echoed back by the platform on every click. It is the
   * only thing tying a click to its request, so it must be unguessable — never
   * derived from a thread id, a request id or a counter.
   */
  tag: string
  kind: ImCardInteractionKind
  content: ReadonlyArray<Record<string, unknown>>
}

export interface RemoteImCardUpdateV1 {
  schemaVersion: typeof IM_GATEWAY_SCHEMA_VERSION
  interactionId: string
  /**
   * Monotonic per interaction. update-custom-card has no idempotency header and
   * no ordering guarantee, so a late update carrying a lower version must be
   * dropped rather than allowed to overwrite the newer terminal state.
   */
  cardVersion: number
  content: ReadonlyArray<Record<string, unknown>>
}

export interface RemoteImCardReceiptV1 {
  schemaVersion: typeof IM_GATEWAY_SCHEMA_VERSION
  receiptId: string
  /** Absent when the click carried a tag the gateway could not resolve. */
  interactionId?: string
  tag: string
  principalId: string
  conversationKey: string
  /** Empty for a plain operate button; populated by an interactive form. */
  feedback: ReadonlyArray<{ key: string; value: string }>
  occurredAt: string
}

function requireComponentArray(
  value: unknown,
  path: string
): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", `${path} must be a non-empty array`)
  }
  if (value.length > IM_CARD_MAX_COMPONENTS) {
    throw new ImGatewayContractError(
      "INVALID_PAYLOAD",
      `${path} exceeds ${IM_CARD_MAX_COMPONENTS} components`
    )
  }
  const components = value.map((component, index) => requireRecord(component, `${path}[${index}]`))
  for (const [index, component] of components.entries()) {
    requireNonEmptyString(component.type, `${path}[${index}].type`)
  }
  if (unicodeCharacterLength(JSON.stringify(components)) > IM_CARD_MAX_CONTENT_CHARACTERS) {
    throw new ImGatewayContractError(
      "INVALID_PAYLOAD",
      `${path} exceeds ${IM_CARD_MAX_CONTENT_CHARACTERS} Unicode characters`
    )
  }
  return components
}

const CARD_INTERACTION_KINDS = new Set<ImCardInteractionKind>(["approval", "user_input"])

export function assertRemoteImCardSendV1(value: unknown): asserts value is RemoteImCardSendV1 {
  const card = requireRecord(value, "card")
  assertExactKeys(
    card,
    [
      "schemaVersion",
      "interactionId",
      "conversationKey",
      "idempotencyKey",
      "tag",
      "kind",
      "content"
    ],
    [],
    "card"
  )
  assertSchemaVersion(card.schemaVersion)
  requireNonEmptyString(card.interactionId, "card.interactionId")
  requireNonEmptyString(card.conversationKey, "card.conversationKey")
  requireNonEmptyString(card.idempotencyKey, "card.idempotencyKey")
  const tag = requireNonEmptyString(card.tag, "card.tag")
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(tag)) {
    throw new ImGatewayContractError(
      "INVALID_PAYLOAD",
      "card.tag must be 16-128 url-safe characters"
    )
  }
  if (
    typeof card.kind !== "string" ||
    !CARD_INTERACTION_KINDS.has(card.kind as ImCardInteractionKind)
  ) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "card.kind is not supported")
  }
  requireComponentArray(card.content, "card.content")
}

export function assertRemoteImCardUpdateV1(value: unknown): asserts value is RemoteImCardUpdateV1 {
  const card = requireRecord(value, "card")
  assertExactKeys(card, ["schemaVersion", "interactionId", "cardVersion", "content"], [], "card")
  assertSchemaVersion(card.schemaVersion)
  requireNonEmptyString(card.interactionId, "card.interactionId")
  requirePositiveInteger(card.cardVersion, "card.cardVersion")
  requireComponentArray(card.content, "card.content")
}

export function assertRemoteImCardReceiptV1(
  value: unknown
): asserts value is RemoteImCardReceiptV1 {
  const receipt = requireRecord(value, "receipt")
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "receiptId",
      "tag",
      "principalId",
      "conversationKey",
      "feedback",
      "occurredAt"
    ],
    ["interactionId"],
    "receipt"
  )
  assertSchemaVersion(receipt.schemaVersion)
  requireNonEmptyString(receipt.receiptId, "receipt.receiptId")
  requireNonEmptyString(receipt.tag, "receipt.tag")
  requireNonEmptyString(receipt.principalId, "receipt.principalId")
  requireNonEmptyString(receipt.conversationKey, "receipt.conversationKey")
  requireIsoInstant(receipt.occurredAt, "receipt.occurredAt")
  if (receipt.interactionId !== undefined) {
    requireNonEmptyString(receipt.interactionId, "receipt.interactionId")
  }
  if (!Array.isArray(receipt.feedback)) {
    throw new ImGatewayContractError("INVALID_PAYLOAD", "receipt.feedback must be an array")
  }
  for (const [index, entry] of receipt.feedback.entries()) {
    const field = requireRecord(entry, `receipt.feedback[${index}]`)
    assertExactKeys(field, ["key", "value"], [], `receipt.feedback[${index}]`)
    requireNonEmptyString(field.key, `receipt.feedback[${index}].key`)
    if (typeof field.value !== "string") {
      throw new ImGatewayContractError(
        "INVALID_PAYLOAD",
        `receipt.feedback[${index}].value must be a string`
      )
    }
  }
}
