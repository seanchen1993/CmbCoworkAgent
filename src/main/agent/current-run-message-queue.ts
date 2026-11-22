// ── Current-run message queue (in-flight steering) ────────────────────────────
//
// Messages the user "steers" into a RUNNING agent turn. This is distinct from the
// renderer's draft queue (thread-context `queuedMessages`), which auto-sends AFTER
// the run ends. A steered message is injected into the CURRENT run's model loop by
// `createCurrentRunMessageQueueMiddleware`:
//   • beforeModel — drained before the next model call (typical case: injected
//     while a tool is running, arrives on the following model turn);
//   • afterModel  — when the model produced a FINAL, tool-call-free reply we inject
//     the steered message and `jumpTo: "model"` so it is answered instead of the
//     turn ending. (Verified against langchain@1.2.x graph wiring: afterModel runs
//     in reverse middleware order; a middleware's own `canJumpTo: ["model"]` routes
//     `jumpTo` to the model node via the sequence router regardless of position,
//     and appending a HumanMessage makes `messages.at(-1)` non-AI, bypassing the
//     "AI reply with no tool calls → exit" short-circuit in the final router.)
//
// Keyed by the runtime's OWN `thread_id` and guarded by a physical run token. The
// token prevents an aborted graph that outlives replacement timeout from draining
// its successor's queue; derived worker/subagent thread ids provide the second
// isolation boundary for background runtimes.
//
// This module has NO electron dependency so it can be unit-tested directly. The
// renderer notification (which uses BrowserWindow) is injected by runtime.ts via
// `setCurrentRunInjectionNotifier`.

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { getConfig } from "@langchain/langgraph"
import { createMiddleware } from "langchain"
import { randomUUID } from "crypto"
import type { SkillUseBlockMetadata } from "../../shared/skill-use-block"
import type { Message } from "../types"
import { captureNativeMessage } from "./native-message-capture"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import {
  hasInvalidFunctionConversationTranscriptStamp,
  readFunctionConversationTranscriptStamp,
  sameFunctionConversationTranscriptStamp,
  type FunctionConversationTranscriptStamp
} from "../../shared/mods/v2/conversation-transcript"
import { BOT_PREPARED_USER_REQUEST_KEY } from "./agent-run-service"
import {
  getCheckpointTranscriptMessageIdentity,
  isInternalNotificationMessage,
  isWorkflowPlumbingTranscriptContent
} from "../../shared/checkpoint-transcript"
import { isSerializedSummarizationMessage } from "../../shared/context-compaction-messages"
import {
  hasScopedGraphTranscriptBoundary,
  NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY
} from "../../shared/graph-transcript-boundary"
import { GOAL_GATE_PARENT_BOUNDARY_METADATA_KEY } from "./goals/internal-prompt"
import {
  advanceCompletedMessageContentRoute,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  getMessageProviderTupleFromMetadata,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  normalizeAppendedMessageIds,
  normalizeCompleteSnapshotMessageIds
} from "../../shared/message-role-collision"

export interface CurrentRunQueuedMessage {
  id: string
  content: string
  displayContent?: string
  /** Host-resolved composer selection; never inferred from a Bot's routing text. */
  trustedExplicitSkill?: SkillUseBlockMetadata
  /** Only a local user composer may select via a raw trailing marker. */
  allowTrustedTransportSkillMarker?: boolean
  /** Set only after the Bot's trusted submit preparation. Empty means omit the request anchor. */
  botPreparedUserRequest?: string
  /** Trusted Bot-only data, never a user instruction or permission grant. */
  peerFeedback?: { senderBotId: string; sourceTaskId: string; targetTaskId: string }
  /** Optional Bot work authority for admission and foreground command handoff. */
  botCanDispatch?: () => boolean
  /** Trusted host receipt, called synchronously before durable transcript/model injection.
   * False withdraws a cancelled inbox message. Throws fail the turn before model side effects. */
  beforeInject?: () => boolean
  /** Trusted host callbacks; never accepted from renderer input. */
  onInjected?: () => void
  onDiscarded?: () => void
}

/** Final assistant reply immediately preceding an afterModel steer. The outer
 * stream consumer may not have received it when afterModel runs. */
export interface CurrentRunCompletedAssistantMessage {
  id: string
  content: Message["content"]
  /** The provider id emitted by the outer stream, if one was supplied. */
  sourceId?: string
}

export interface CurrentRunCompletedAssistantIdentity {
  sourceId?: string
  providerSourceId?: string
  providerOccurrence?: number
}

export interface CurrentRunInjectionAnchor {
  id: string
  role: Message["role"]
  providerSourceId?: string
  providerOccurrence?: number
}

interface CurrentRunCompletedAssistantRoute {
  runToken: string
  rawSourceId: string
  stableId: string
  providerSourceId: string
  providerOccurrence: number
  content: Message["content"]
  observedContent?: Message["content"]
}

export interface CurrentRunCompletedAssistantRouteIdentity {
  stableId: string
  providerSourceId: string
  providerOccurrence: number
  /** Cumulative content observed for this delayed completed-message route. */
  content: Message["content"]
}

const completedAssistantRoutes = new Map<string, CurrentRunCompletedAssistantRoute>()

export function registerCurrentRunCompletedAssistantRoute(
  threadId: string,
  runToken: string,
  route: Omit<CurrentRunCompletedAssistantRoute, "runToken">
): void {
  if (!threadId || !runToken || !isCurrentRunMessageQueueOwner(threadId, runToken)) return
  const rawSourceId = route.rawSourceId.trim()
  const stableId = route.stableId.trim()
  const providerSourceId =
    typeof route.providerSourceId === "string" ? route.providerSourceId.trim() : ""
  if (
    !rawSourceId ||
    !stableId ||
    rawSourceId === stableId ||
    !providerSourceId ||
    !Number.isInteger(route.providerOccurrence) ||
    route.providerOccurrence < 1
  ) {
    return
  }
  completedAssistantRoutes.set(threadId, {
    ...route,
    runToken,
    rawSourceId,
    stableId,
    providerSourceId
  })
}

export function routeCurrentRunCompletedAssistantMessage(
  threadId: string,
  message: Pick<Message, "id" | "role" | "content">,
  runToken?: string
): CurrentRunCompletedAssistantRouteIdentity | undefined {
  const route = completedAssistantRoutes.get(threadId)
  if (!route || message.role !== "assistant") return undefined
  // Production stream persistence always supplies the physical run token. An
  // obsolete run must neither consume nor mutate the replacement run's route.
  if (
    runToken &&
    (route.runToken !== runToken || !isCurrentRunMessageQueueOwner(threadId, runToken))
  ) {
    return undefined
  }
  const messageId = message.id.trim()
  const isCompletedId = messageId === route.rawSourceId || messageId === route.stableId
  if (!isCompletedId) {
    completedAssistantRoutes.delete(threadId)
    return undefined
  }
  const contentRoute = advanceCompletedMessageContentRoute(
    route.content,
    route.observedContent,
    message.content
  )
  if (!contentRoute.matched || contentRoute.complete) {
    completedAssistantRoutes.delete(threadId)
  } else {
    route.observedContent = contentRoute.observedContent as Message["content"]
  }
  return contentRoute.matched
    ? {
        stableId: route.stableId,
        providerSourceId: route.providerSourceId,
        providerOccurrence: route.providerOccurrence,
        content: (contentRoute.observedContent ?? message.content) as Message["content"]
      }
    : undefined
}

export function resolveCurrentRunCompletedAssistantIdentity(
  baselineMessages: readonly Message[],
  completedMessage: CurrentRunCompletedAssistantMessage
): CurrentRunCompletedAssistantIdentity {
  const rawSourceId = completedMessage.sourceId?.trim()
  if (!rawSourceId || rawSourceId === completedMessage.id) return {}

  const durableCompletedMessage = baselineMessages.find(
    (message) => message.id.trim() === completedMessage.id.trim() && message.role === "assistant"
  )
  if (durableCompletedMessage) {
    return {
      sourceId: durableCompletedMessage.id,
      providerSourceId:
        durableCompletedMessage.provider_source_id?.trim() || rawSourceId,
      providerOccurrence: getMessageProviderOccurrence(durableCompletedMessage) ?? 1
    }
  }

  const [normalizedSource] = normalizeAppendedMessageIds(
    baselineMessages,
    [
      {
        id: rawSourceId,
        role: "assistant",
        content: completedMessage.content
      }
    ],
    { splitAssistantAfterTool: true }
  )
  if (!normalizedSource) return {}

  return {
    sourceId: normalizedSource.id,
    providerSourceId: getMessageProviderSourceId(normalizedSource),
    providerOccurrence: getMessageProviderOccurrence(normalizedSource) ?? 1
  }
}

/** Resolve a graph-state predecessor to its durable render id. Graph messages
 * may still carry a reused raw provider id after DB role/occurrence collision
 * normalization, so an exact id lookup alone is not a safe ordering anchor. */
export function resolveCurrentRunInjectionAnchorId(
  baselineMessages: readonly Message[],
  anchor: CurrentRunInjectionAnchor
): string | undefined {
  const anchorId = anchor.id.trim()
  const providerSourceId = anchor.providerSourceId?.trim() || anchorId
  if (!anchorId || !providerSourceId) return undefined

  const candidates = baselineMessages.filter(
    (message) =>
      message.role === anchor.role && getMessageProviderSourceId(message) === providerSourceId
  )
  if (anchor.providerOccurrence !== undefined) {
    return candidates.find(
      (message) => getMessageProviderOccurrence(message) === anchor.providerOccurrence
    )?.id
  }
  // Graph state is ordered and this anchor is its tail predecessor. When a raw
  // provider id was reused without explicit occurrence metadata, the last
  // durable same-role occurrence is the only safe implicit match.
  if (candidates.length > 0) return candidates.at(-1)?.id
  return baselineMessages.find(
    (message) => message.role === anchor.role && message.id.trim() === anchorId
  )?.id
}

function currentRunInjectionAnchorForMessage(value: unknown): CurrentRunInjectionAnchor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const message = value as Record<string, unknown>
  const id = typeof message.id === "string" ? message.id.trim() : ""
  if (!id) return undefined
  const getType = message._getType
  let rawType: unknown
  if (typeof getType === "function") {
    try {
      rawType = getType.call(value)
    } catch {
      return undefined
    }
  }
  const role: Message["role"] | undefined =
    rawType === "human"
      ? "user"
      : rawType === "ai"
        ? "assistant"
        : rawType === "tool"
          ? "tool"
          : rawType === "system"
            ? "system"
            : undefined
  if (!role) return undefined

  const additionalKwargs =
    message.additional_kwargs &&
    typeof message.additional_kwargs === "object" &&
    !Array.isArray(message.additional_kwargs)
      ? (message.additional_kwargs as Record<string, unknown>)
      : undefined
  const rawProviderSourceId = additionalKwargs?.[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]
  const providerSourceId =
    typeof rawProviderSourceId === "string" && rawProviderSourceId.trim()
      ? rawProviderSourceId.trim()
      : undefined
  const rawProviderOccurrence = additionalKwargs?.[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]
  const providerOccurrence =
    typeof rawProviderOccurrence === "number" &&
    Number.isInteger(rawProviderOccurrence) &&
    rawProviderOccurrence > 0
      ? rawProviderOccurrence
      : undefined
  return {
    id,
    role,
    ...(providerSourceId ? { providerSourceId } : {}),
    ...(providerOccurrence !== undefined ? { providerOccurrence } : {})
  }
}

function currentRunInjectionAnchorForTail(
  messages: readonly unknown[],
  index: number
): CurrentRunInjectionAnchor | undefined {
  // Internal cues exist in graph state but are deliberately absent from the visible
  // durable transcript. Anchor to the preceding real message, or the empty history.
  while (index >= 0 && isInternalNotificationMessage(messages[index])) index--
  return index >= 0 ? currentRunInjectionAnchorForMessage(messages[index]) : undefined
}

const currentRunMessageQueues = new Map<string, CurrentRunQueuedMessage[]>()
const currentRunMessageQueueOwners = new Map<string, string>()
const currentRunMessageQueueOwnerIdentities = new Map<string, object>()
const queueOwnerMapGet = Map.prototype.get
const completedAssistantMessagesByRun = new Map<string, CurrentRunCompletedAssistantMessage>()

interface CanonicalAssistantCompletion {
  readonly threadId: string
  readonly runToken: string
  readonly owner: object
  readonly message: AIMessage
  readonly stamp: FunctionConversationTranscriptStamp
  readonly digest: string
  readonly completed: CurrentRunCompletedAssistantMessage
  assertCurrent(): void
}

// Only the actual post-Keeper AI instance is handed to afterModel. Neither its data stamp nor
// a copied notifier payload can mint this host-only handoff.
const canonicalAssistantCompletions = new WeakMap<AIMessage, CanonicalAssistantCompletion>()
const canonicalAssistantRecords = new WeakMap<object, CanonicalAssistantCompletion>()

function completionInvalid(): never {
  throw new ModFunctionError("MODS_CONVERSATION_COMPLETION_INVALID")
}

function assertCanonicalCompletion(completion: CanonicalAssistantCompletion): void {
  if (currentRunMessageQueueOwnerIdentities.get(completion.threadId) !== completion.owner ||
    !isCurrentRunMessageQueueOwner(completion.threadId, completion.runToken)) completionInvalid()
  const result: unknown = completion.assertCurrent()
  if (result !== undefined) completionInvalid()
  const digest = captureNativeMessage(completion.message).digest
  const stamp = readFunctionConversationTranscriptStamp(completion.message)
  if (!stamp || hasInvalidFunctionConversationTranscriptStamp(completion.message) ||
    completion.message.id !== completion.completed.id ||
    !sameFunctionConversationTranscriptStamp(stamp, completion.stamp) ||
    digest !== completion.digest ||
    currentRunMessageQueueOwnerIdentities.get(completion.threadId) !== completion.owner ||
    !isCurrentRunMessageQueueOwner(completion.threadId, completion.runToken)) completionInvalid()
}

/** Native factory only, after actual Keeper/DB commit; this does not authenticate a DB row. */
export function registerCurrentRunCanonicalAssistantCompletion(
  threadId: string, runToken: string, message: AIMessage, assertCurrent: () => void
): void {
  const owner = currentRunMessageQueueOwnerIdentities.get(threadId)
  if (!owner || !isCurrentRunMessageQueueOwner(threadId, runToken)) completionInvalid()
  const guarded: unknown = assertCurrent()
  if (guarded !== undefined) completionInvalid()
  const snapshot = captureNativeMessage(message)
  const stamp = readFunctionConversationTranscriptStamp(message)
  if (!owner || !AIMessage.isInstance(message) || !stamp || stamp.messageType !== "assistant" ||
    stamp.uuid !== message.id || hasInvalidFunctionConversationTranscriptStamp(message) ||
    !isCurrentRunMessageQueueOwner(threadId, runToken)) completionInvalid()
  const existing = canonicalAssistantCompletions.get(message)
  if (existing) {
    if (existing.threadId !== threadId || existing.runToken !== runToken ||
      existing.owner !== owner) completionInvalid()
    assertCanonicalCompletion(existing)
    return
  }
  const completed = Object.freeze({ id: stamp.uuid, content: message.content as Message["content"],
    sourceId: stamp.uuid })
  const completion = Object.freeze({ threadId, runToken, owner, message, completed,
    digest: snapshot.digest,
    stamp: Object.freeze({ ...stamp, origin: Object.freeze({ ...stamp.origin }) }), assertCurrent })
  assertCanonicalCompletion(completion)
  canonicalAssistantCompletions.set(message, completion)
  canonicalAssistantRecords.set(completed, completion)
}

/** Only the original private notifier record can retrieve its fixed native completion. */
export function readCurrentRunCanonicalAssistantCompletion(
  completed: CurrentRunCompletedAssistantMessage | undefined, threadId: string, runToken: string
): Readonly<{ message: AIMessage; stamp: FunctionConversationTranscriptStamp;
  assertCurrent(): void }> | undefined {
  if (!completed) return undefined
  const completion = canonicalAssistantRecords.get(completed)
  if (!completion) return undefined
  if (completion.threadId !== threadId || completion.runToken !== runToken) completionInvalid()
  assertCanonicalCompletion(completion)
  return Object.freeze({ message: completion.message, stamp: completion.stamp,
    assertCurrent: () => assertCanonicalCompletion(completion) })
}

function canonicalAssistantMessageForTranscript(
  message: AIMessage, threadId: string, runToken: string
): CurrentRunCompletedAssistantMessage | undefined {
  const completion = canonicalAssistantCompletions.get(message)
  if (completion) {
    if (completion.threadId !== threadId || completion.runToken !== runToken) completionInvalid()
    assertCanonicalCompletion(completion)
    return completion.completed
  }
  // A marked but unproven/reconstructed instance must not enter the legacy renumbering path.
  if (readFunctionConversationTranscriptStamp(message) ||
    hasInvalidFunctionConversationTranscriptStamp(message)) completionInvalid()
  return undefined
}
type ScopedGraphProviderRole = "assistant" | "tool"
type ScopedGraphProviderOccurrences = Map<string, Partial<Record<ScopedGraphProviderRole, number>>>
const scopedGraphOccurrencesByThread = new Map<
  string,
  {
    runToken: string
    boundaries: Map<string, ScopedGraphProviderOccurrences>
    notificationExecutions: Set<string>
  }
>()
const VISIBLE_USER_MESSAGE_KEY = "cmb_visible_user_message"
// A renderer can withdraw a handoff while its async UserPromptSubmit/skill hooks
// are still running, before queueCurrentRunMessage has inserted anything. Keep a
// run-scoped tombstone so late preparation cannot resurrect the deleted id.
const withdrawnMessageIds = new Map<string, Set<string>>()

// Ids already drained-and-injected into a run's model loop, per thread. This is
// the authoritative guard against re-queueing (and thus re-injecting) a message
// the model has ALREADY seen and responded to: the renderer's local copy of
// "was this already injected" (queuedMessages[].handoffRequestedAt) is cleared
// asynchronously via the injection-notification round trip, so there's a real
// window where the renderer still thinks a message is pending while the main
// process has already drained and injected it. If the user edits+saves in that
// window, saving would otherwise re-call queueCurrentRunMessage with the SAME
// id — and since the graph's messages reducer replaces-by-id, that would
// silently rewrite an already-persisted HumanMessage the model already replied
// to. Tracking injected ids here lets queueCurrentRunMessage refuse the re-queue
// outright, regardless of what the renderer's stale local state believes.
const injectedMessageIds = new Map<string, Set<string>>()

/** True once a message id has been drained into this thread's run — it can no
 * longer be mutated via queueCurrentRunMessage (see injectedMessageIds above). */
export function isCurrentRunMessageAlreadyInjected(threadId: string, messageId: string): boolean {
  return injectedMessageIds.get(threadId)?.has(messageId) ?? false
}

export function isCurrentRunMessageWithdrawn(threadId: string, messageId: string): boolean {
  return withdrawnMessageIds.get(threadId)?.has(messageId) ?? false
}

/** Snapshot injected ids for renderer/main-process reconciliation. */
export function getCurrentRunInjectedMessageIds(threadId: string): string[] {
  return [...(injectedMessageIds.get(threadId) ?? [])]
}

/** Enforce the durable acknowledgement boundary used before renderer cleanup. */
export function assertCurrentRunMessagesDurablyPersisted(
  expectedCount: number,
  persistedCount: number
): void {
  if (persistedCount < expectedCount) {
    throw new Error(
      `Current-run message persistence incomplete: expected ${expectedCount}, persisted ${persistedCount}`
    )
  }
}

/** Sink for "messages were injected" notifications. runtime.ts wires this to the
 * BrowserWindow broadcast; the default no-op keeps this module electron-free and
 * makes it safe to drive from unit tests. */
export type CurrentRunInjectionNotifier = (
  threadId: string,
  messages: CurrentRunQueuedMessage[],
  context?: {
    completedAssistantMessage?: CurrentRunCompletedAssistantMessage
    /** Message that immediately preceded this injected batch in graph state. */
    anchorMessage?: CurrentRunInjectionAnchor
    runToken?: string
  }
) =>
  | void
  | { completedAssistantIdentity?: CurrentRunCompletedAssistantIdentity }
  | Promise<void | { completedAssistantIdentity?: CurrentRunCompletedAssistantIdentity }>

let notifyInjected: CurrentRunInjectionNotifier = () => {}

export function setCurrentRunInjectionNotifier(notifier: CurrentRunInjectionNotifier): void {
  notifyInjected = notifier
}

/** Assign queue ownership to one physical foreground run. Resume/interrupt call
 * this before aborting the old controller, so a timed-out old graph can no
 * longer drain or clear messages transferred to the continuation. */
export function setCurrentRunMessageQueueOwner(threadId: string, runToken: string): void {
  if (!threadId || !runToken) return
  const pendingRoute = completedAssistantRoutes.get(threadId)
  if (pendingRoute && pendingRoute.runToken !== runToken) {
    completedAssistantRoutes.delete(threadId)
  }
  if (currentRunMessageQueueOwners.get(threadId) !== runToken) {
    currentRunMessageQueueOwnerIdentities.set(threadId, Object.freeze({}))
    scopedGraphOccurrencesByThread.delete(threadId)
  }
  currentRunMessageQueueOwners.set(threadId, runToken)
}

function runScopedKey(threadId: string, runToken: string): string {
  return `${threadId}\u0000${runToken}`
}

export function isCurrentRunMessageQueueOwner(threadId: string, runToken: string): boolean {
  return currentRunMessageQueueOwners.get(threadId) === runToken
}

/** Main-only snapshot of this queue owner; equal public tokens cannot revive a retired owner. */
export function captureCurrentRunMessageQueueOwner(threadId: string, runToken: string): () => void {
  const owner = currentRunMessageQueueOwnerIdentities.get(threadId)
  const assertCurrent = () => {
    if (!owner || currentRunMessageQueueOwnerIdentities.get(threadId) !== owner ||
      !isCurrentRunMessageQueueOwner(threadId, runToken)) completionInvalid()
  }
  assertCurrent()
  return assertCurrent
}

/** Data-only revocation for a previously admitted IPC owner; equal tokens cannot survive ABA. */
export function captureCurrentRunMessageQueueOwnerData(threadId: string, runToken: string): () => void {
  const owner: object | undefined =
    Reflect.apply(queueOwnerMapGet, currentRunMessageQueueOwnerIdentities, [threadId])
  const assertDataCurrent = () => {
    if (!owner || Reflect.apply(queueOwnerMapGet, currentRunMessageQueueOwnerIdentities, [threadId]) !== owner ||
      Reflect.apply(queueOwnerMapGet, currentRunMessageQueueOwners, [threadId]) !== runToken)
      completionInvalid()
  }
  assertDataCurrent()
  return assertDataCurrent
}

/** Enqueue (or replace by id) a steered message for the thread's current run.
 * Returns false for invalid, already-injected, or explicitly withdrawn ids. */
export function queueCurrentRunMessage(
  threadId: string,
  message: CurrentRunQueuedMessage,
  runToken: string
): boolean {
  if (!threadId || !message.id || !message.content.trim()) return false
  if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return false
  if (isCurrentRunMessageAlreadyInjected(threadId, message.id)) return false
  if (isCurrentRunMessageWithdrawn(threadId, message.id)) return false
  const existing = currentRunMessageQueues.get(threadId) ?? []
  const existingIndex = existing.findIndex((item) => item.id === message.id)
  const next =
    existingIndex >= 0
      ? existing.map((item, index) => (index === existingIndex ? message : item))
      : [...existing, message]
  currentRunMessageQueues.set(threadId, next)
  return true
}

function notifyQueueSettlement(notify: (() => void) | undefined): void {
  try { notify?.() } catch (error) {
    console.warn("[Runtime] Current-run receipt settlement failed", error)
  }
}

/** Remove a steered message before it is injected (user deleted/un-steered it). */
export function deleteCurrentRunQueuedMessage(threadId: string, messageId: string): void {
  const withdrawn = withdrawnMessageIds.get(threadId) ?? new Set<string>()
  withdrawn.add(messageId)
  withdrawnMessageIds.set(threadId, withdrawn)
  const existing = currentRunMessageQueues.get(threadId)
  if (!existing) return
  for (const message of existing) {
    if (message.id === messageId) notifyQueueSettlement(message.onDiscarded)
  }
  const next = existing.filter((message) => message.id !== messageId)
  if (next.length > 0) currentRunMessageQueues.set(threadId, next)
  else currentRunMessageQueues.delete(threadId)
}

/** Drop the whole steer queue for a thread (called when its run ends/cancels). */
export function clearCurrentRunMessageQueue(threadId: string, runToken?: string): void {
  if (runToken && !isCurrentRunMessageQueueOwner(threadId, runToken)) {
    completedAssistantMessagesByRun.delete(runScopedKey(threadId, runToken))
    if (completedAssistantRoutes.get(threadId)?.runToken === runToken) {
      completedAssistantRoutes.delete(threadId)
    }
    return
  }
  const pending = currentRunMessageQueues.get(threadId) ?? []
  currentRunMessageQueues.delete(threadId)
  for (const message of pending) notifyQueueSettlement(message.onDiscarded)
  currentRunMessageQueueOwners.delete(threadId)
  currentRunMessageQueueOwnerIdentities.delete(threadId)
  scopedGraphOccurrencesByThread.delete(threadId)
  injectedMessageIds.delete(threadId)
  withdrawnMessageIds.delete(threadId)
  completedAssistantRoutes.delete(threadId)
  if (runToken) {
    completedAssistantMessagesByRun.delete(runScopedKey(threadId, runToken))
  } else {
    const prefix = `${threadId}\u0000`
    for (const key of completedAssistantMessagesByRun.keys()) {
      if (key.startsWith(prefix)) completedAssistantMessagesByRun.delete(key)
    }
  }
}

/** Inspection helper for tests. Returns a copy; never the live array. */
export function peekCurrentRunMessageQueue(threadId: string): CurrentRunQueuedMessage[] {
  return [...(currentRunMessageQueues.get(threadId) ?? [])]
}

function drainCurrentRunMessageQueue(
  threadId: string,
  runToken: string
): CurrentRunQueuedMessage[] {
  if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return []
  const queued = currentRunMessageQueues.get(threadId) ?? []
  currentRunMessageQueues.delete(threadId)
  return queued
}

async function drainCurrentRunMessagesForInjection(
  threadId: string,
  runToken: string,
  phase: "beforeModel" | "afterModel",
  context?: {
    completedAssistantMessage?: CurrentRunCompletedAssistantMessage
    anchorMessage?: CurrentRunInjectionAnchor
  }
): Promise<
  | {
      messages: HumanMessage[]
      completedAssistantIdentity?: CurrentRunCompletedAssistantIdentity
    }
  | undefined
> {
  const owner = currentRunMessageQueueOwnerIdentities.get(threadId)
  const restoreOrDiscard = (messages: CurrentRunQueuedMessage[]) => {
    if (owner && currentRunMessageQueueOwnerIdentities.get(threadId) === owner &&
        isCurrentRunMessageQueueOwner(threadId, runToken)) {
      const arrivals = currentRunMessageQueues.get(threadId) ?? []
      currentRunMessageQueues.set(threadId, [...messages, ...arrivals])
    } else {
      for (const message of messages) notifyQueueSettlement(message.onDiscarded)
    }
  }
  const pending = drainCurrentRunMessageQueue(threadId, runToken)
  const queued: CurrentRunQueuedMessage[] = []
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index]
    try {
      const accepted = Boolean(message.content.trim()) && (message.beforeInject?.() ?? true)
      if (accepted) queued.push(message)
      else notifyQueueSettlement(message.onDiscarded)
    } catch (error) {
      restoreOrDiscard([...queued, ...pending.slice(index)])
      throw error
    }
  }
  if (queued.length === 0) return undefined

  // The notifier durably persists these user turns before acknowledging them to
  // the renderer. If persistence fails, restore the queue and let the graph fail
  // this hook instead of losing the only durable copy of the user's instruction.
  let acknowledgement:
    | void
    | { completedAssistantIdentity?: CurrentRunCompletedAssistantIdentity }
  try {
    acknowledgement = await notifyInjected(threadId, queued, { ...context, runToken })
  } catch (error) {
    // The run can be replaced while durable persistence is in flight. Never
    // restore an old owner's messages into the replacement run's shared queue.
    restoreOrDiscard(queued)
    throw error
  }

  if (!owner || currentRunMessageQueueOwnerIdentities.get(threadId) !== owner ||
    !isCurrentRunMessageQueueOwner(threadId, runToken)) {
    for (const message of queued) notifyQueueSettlement(message.onDiscarded)
    const error = new Error("Current-run injection owner changed during persistence")
    error.name = "AbortError"
    throw error
  }

  const injected = injectedMessageIds.get(threadId) ?? new Set<string>()
  for (const message of queued) {
    injected.add(message.id)
    notifyQueueSettlement(message.onInjected)
  }
  injectedMessageIds.set(threadId, injected)
  console.log(
    `[Runtime] Injected ${queued.length} queued current-run message(s) in ${phase} for thread ${threadId}`
  )

  return {
    messages: queued.map(
      (message) => {
        const visibleContent = message.displayContent || message.content
        return new HumanMessage({
          id: message.id,
          content: message.content,
          ...(message.peerFeedback
            ? {
                additional_kwargs: {
                  // The historical marker is shared by workflow/internal Human inputs.
                  // Reuse its history, StopHook and compaction authority protections.
                  cmb_internal_coordinator_notification: true,
                  cmb_internal_bot_feedback: true,
                  cmb_peer_feedback_source: message.peerFeedback
                }
              }
            : visibleContent !== message.content || message.botPreparedUserRequest !== undefined
              ? {
                additional_kwargs: {
                  ...(visibleContent !== message.content ? { [VISIBLE_USER_MESSAGE_KEY]: visibleContent } : {}),
                  ...(message.botPreparedUserRequest !== undefined
                    ? { [BOT_PREPARED_USER_REQUEST_KEY]: message.botPreparedUserRequest } : {})
                }
              }
              : {})
        })
      }
    ),
    ...(acknowledgement?.completedAssistantIdentity
      ? { completedAssistantIdentity: acknowledgement.completedAssistantIdentity }
      : {})
  }
}

function graphAssistantProviderSourceId(message: AIMessage): string | undefined {
  const providerSourceId = message.additional_kwargs[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]
  if (typeof providerSourceId === "string" && providerSourceId.trim()) {
    return providerSourceId.trim()
  }
  const id = message.id?.trim()
  return id ? getMessageProviderSourceId({ id, role: "assistant" }) : undefined
}

function completedAssistantMessageForTranscript(
  message: AIMessage
): CurrentRunCompletedAssistantMessage | undefined {
  const sourceId = graphAssistantProviderSourceId(message)
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? {
          // The afterModel response must have its own durable identity. Some
          // OpenAI-compatible providers omit or reuse AIMessage ids across
          // consecutive calls, which otherwise lets the guided reply overwrite
          // the preceding reply in thread_messages.
          id: `current-run-assistant:${randomUUID()}`,
          content: message.content,
          ...(sourceId ? { sourceId } : {})
        }
      : undefined
  }
  return Array.isArray(message.content) && message.content.length > 0
      ? {
        id: `current-run-assistant:${randomUUID()}`,
        content: message.content as Message["content"],
        ...(sourceId ? { sourceId } : {})
      }
    : undefined
}

type GraphProviderOccurrenceLoader = (
  threadId: string,
  boundaryId: string,
  providerSourceId: string
) => number | undefined

function collectPreviousScopedGraphProviderOccurrences(
  messages: readonly BaseMessage[],
  end: number
): ScopedGraphProviderOccurrences {
  const candidates: Array<ReturnType<typeof getCheckpointTranscriptMessageIdentity>> = []
  for (let index = 0; index < end; index += 1) {
    const message = messages[index]
    if (isSerializedSummarizationMessage(message) || isInternalNotificationMessage(message)) {
      continue
    }
    const role = AIMessage.isInstance(message)
      ? "assistant"
      : ToolMessage.isInstance(message)
        ? "tool"
        : HumanMessage.isInstance(message)
          ? "user"
          : SystemMessage.isInstance(message)
            ? "system"
            : undefined
    if (!role) continue
    const metadata = message.additional_kwargs
    const visibleUserMessage = metadata[VISIBLE_USER_MESSAGE_KEY]
    if (
      role === "user" &&
      hasScopedGraphTranscriptBoundary(metadata) &&
      !(typeof visibleUserMessage === "string" && visibleUserMessage.trim())
    ) {
      continue
    }
    const content =
      role === "user" && typeof visibleUserMessage === "string" && visibleUserMessage.length > 0
        ? visibleUserMessage
        : message.content
    if (isWorkflowPlumbingTranscriptContent(content)) continue
    candidates.push(
      getCheckpointTranscriptMessageIdentity(
        message.id?.trim() || `checkpoint-${index}`,
        role,
        metadata,
        ToolMessage.isInstance(message) ? message.tool_call_id : undefined
      )
    )
  }

  const occurrences: ScopedGraphProviderOccurrences = new Map()
  for (const message of normalizeCompleteSnapshotMessageIds([], candidates)) {
    const { role } = message
    if (role !== "assistant" && role !== "tool") continue
    const sourceId = getMessageProviderSourceId(message)
    const occurrence = getMessageProviderOccurrence(message) ?? 1
    const source = occurrences.get(sourceId) ?? {}
    source[role] = Math.max(source[role] ?? 0, occurrence)
    occurrences.set(sourceId, source)
  }
  return occurrences
}

function rememberScopedGraphProviderOccurrences(
  threadId: string,
  runToken: string,
  messages: readonly BaseMessage[]
): boolean {
  if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return false
  const boundaryIndex = messages.findLastIndex(HumanMessage.isInstance)
  const boundary = messages[boundaryIndex]
  if (
    !boundary?.id ||
    !hasScopedGraphTranscriptBoundary(boundary.additional_kwargs)
  ) {
    return false
  }

  if (!isCurrentRunMessageQueueOwner(threadId, runToken)) return false
  let scope = scopedGraphOccurrencesByThread.get(threadId)
  if (!scope) {
    scope = { runToken, boundaries: new Map(), notificationExecutions: new Set() }
    scopedGraphOccurrencesByThread.set(threadId, scope)
  }
  const parentId = boundary.additional_kwargs[GOAL_GATE_PARENT_BOUNDARY_METADATA_KEY]
  const remember = (id: string, end: number): void => {
    if (scope.boundaries.has(id)) return
    scope.boundaries.set(id, collectPreviousScopedGraphProviderOccurrences(messages, end))
  }
  if (typeof parentId === "string" && !scope.boundaries.has(parentId)) {
    const parentIndex = messages.findIndex(
      (message, index) =>
        index < boundaryIndex &&
        message.id === parentId &&
        HumanMessage.isInstance(message) &&
        hasScopedGraphTranscriptBoundary(message.additional_kwargs)
    )
    if (parentIndex >= 0) remember(parentId, parentIndex)
  }
  remember(boundary.id, boundaryIndex)
  return true
}

function getScopedGraphProviderOccurrences(
  threadId: string,
  runToken: string,
  boundaryId: string
): ScopedGraphProviderOccurrences | undefined {
  const scope = scopedGraphOccurrencesByThread.get(threadId)
  return scope?.runToken === runToken ? scope.boundaries.get(boundaryId) : undefined
}

interface PreviousGraphProviderOccurrence {
  provider_source_id: string
  role: Message["role"]
  provider_occurrence: number
}

/** The checkpoint can know an older provider identity before SQLite's legacy worker imports it. */
export function mergeCurrentRunGraphProviderOccurrences(
  threadId: string,
  runToken: string,
  boundaryId: string,
  sourceIds: readonly string[],
  durable: readonly PreviousGraphProviderOccurrence[] | undefined
): readonly PreviousGraphProviderOccurrence[] | undefined {
  if (durable === undefined) return undefined
  const graph = getScopedGraphProviderOccurrences(threadId, runToken, boundaryId)
  if (!graph?.size) return durable

  const keyFor = (sourceId: string, role: Message["role"]): string =>
    JSON.stringify([sourceId, role])
  const occurrences = new Map(
    durable.map((entry) => [keyFor(entry.provider_source_id, entry.role), entry])
  )
  for (const sourceId of sourceIds) {
    const previous = graph.get(sourceId)
    if (!previous) continue
    for (const role of ["assistant", "tool"] as const) {
      const occurrence = previous[role]
      if (occurrence === undefined) continue
      const key = keyFor(sourceId, role)
      if ((occurrences.get(key)?.provider_occurrence ?? 0) < occurrence) {
        occurrences.set(key, { provider_source_id: sourceId, role, provider_occurrence: occurrence })
      }
    }
  }
  return [...occurrences.values()]
}

interface NotificationAssistantIdentity {
  stableId: string
  providerSourceId: string
  providerOccurrence: number
}

/** The graph model node and its token callbacks share the same execution namespace. */
export function getCurrentRunNotificationAssistantIdentity(
  threadId: string,
  runToken: string,
  namespace: unknown
): NotificationAssistantIdentity | undefined {
  const scope = scopedGraphOccurrencesByThread.get(threadId)
  if (
    typeof namespace !== "string" ||
    scope?.runToken !== runToken ||
    !scope.notificationExecutions.has(namespace)
  ) {
    return undefined
  }
  const stableId = "cmb-notification-assistant:" + namespace
  return { stableId, providerSourceId: stableId, providerOccurrence: 1 }
}

function registerNotificationModelExecution(
  threadId: string,
  runToken: string,
  messages: readonly BaseMessage[]
): NotificationAssistantIdentity | undefined {
  const latestUser = messages.findLast(HumanMessage.isInstance)
  if (latestUser?.additional_kwargs[NOTIFICATION_TRANSCRIPT_BOUNDARY_METADATA_KEY] !== true) {
    return undefined
  }
  const namespace = getConfig()?.metadata?.langgraph_checkpoint_ns
  const scope = scopedGraphOccurrencesByThread.get(threadId)
  if (typeof namespace !== "string" || !namespace || scope?.runToken !== runToken) {
    return undefined
  }
  scope.notificationExecutions.add(namespace)
  return getCurrentRunNotificationAssistantIdentity(threadId, runToken, namespace)
}

function assignScopedGraphAssistantIdentity(
  threadId: string,
  runToken: string,
  messages: readonly BaseMessage[],
  response: AIMessage,
  loadPreviousOccurrence?: GraphProviderOccurrenceLoader
): void {
  const boundaryIndex = messages.findLastIndex(HumanMessage.isInstance)
  const boundary = messages[boundaryIndex]
  if (!boundary?.id || !hasScopedGraphTranscriptBoundary(boundary.additional_kwargs)) return
  const sourceId = graphAssistantProviderSourceId(response)
  if (!sourceId) return

  let occurrence = loadPreviousOccurrence?.(threadId, boundary.id, sourceId)
  let scopeIndex = boundaryIndex
  let scopeId = boundary.id
  const parentBoundaryId = boundary.additional_kwargs[GOAL_GATE_PARENT_BOUNDARY_METADATA_KEY]
  if (occurrence === undefined && typeof parentBoundaryId === "string") {
    // The graph may start the repair model before the IPC values consumer
    // records the new boundary. Its trusted parent already has durable order.
    const parentIndex = messages.findIndex(
      (message, index) =>
        index < boundaryIndex &&
        message.id === parentBoundaryId &&
        HumanMessage.isInstance(message) &&
        hasScopedGraphTranscriptBoundary(message.additional_kwargs)
    )
    if (parentIndex >= 0) {
      occurrence = loadPreviousOccurrence?.(threadId, parentBoundaryId, sourceId)
      scopeIndex = parentIndex
      scopeId = parentBoundaryId
    }
  }
  if (occurrence !== undefined) {
    const graph = getScopedGraphProviderOccurrences(threadId, runToken, scopeId)
    occurrence = Math.max(occurrence, graph?.get(sourceId)?.assistant ?? 0)
    for (const message of messages.slice(scopeIndex + 1)) {
      if (!AIMessage.isInstance(message) || graphAssistantProviderSourceId(message) !== sourceId)
        continue
      const declared = getMessageProviderTupleFromMetadata(message.additional_kwargs)
      occurrence = Math.max(occurrence + 1, declared?.provider_occurrence ?? 0)
    }
  }

  response.additional_kwargs = {
    ...response.additional_kwargs,
    [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: sourceId,
    ...(occurrence !== undefined && {
      [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: occurrence + 1
    })
  }
  // The graph reducer would otherwise replace an earlier assistant when the
  // provider reuses its ID. The tuple keeps this graph slot tied to its SQLite row.
  if (messages.some((message) => message.id === response.id)) response.id = randomUUID()
}

/** Middleware that injects steered messages into the running model loop. Wired
 * into runtime.ts's single `createDeepAgent` middleware array (before
 * summarization, so injected turns are seen by context management, and before
 * HITL, so a steered message never races an approval interrupt) — every leaf run
 * (foreground thread, coordinator worker, workflow subagent, heartbeat,
 * scheduler, chatx) goes through that SAME array, so this middleware IS present
 * in all of them; there is no separate "subagent stack" it's excluded from.
 * Isolation comes from the runtime's OWN thread_id plus the middleware closure's
 * physical run token: coordinator workers (`workerThreadId`) and workflow subagents
 * (`<parent>__wf_<run>_a<i>`) always run under an id string-derived to differ
 * from any foreground thread_id, heartbeat uses the reserved constant
 * `"heartbeat"`, and scheduler mints a fresh uuid per run — so a message steered
 * into a foreground run can never be drained by a differently-keyed background
 * run, even though they all share this exact middleware. */
export function createCurrentRunMessageQueueMiddleware(
  ownerRunToken?: string,
  onModelRequestState?: (active: boolean) => void,
  loadGraphProviderOccurrence?: GraphProviderOccurrenceLoader,
  prepareScopedProviderHistory?: (
    threadId: string, scopedTurn: boolean, signal: AbortSignal | undefined
  ) => Promise<void> | undefined
): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "currentRunMessageQueue",
    wrapModelCall: async (request, handler) => {
      const threadId =
        typeof request.runtime?.configurable?.thread_id === "string"
          ? request.runtime.configurable.thread_id
          : undefined
      const messages = request.state?.messages ?? request.messages ?? []
      // Record before the handler can emit the first raw delta.
      if (threadId && ownerRunToken && isCurrentRunMessageQueueOwner(threadId, ownerRunToken)) {
        const scopedTurn = rememberScopedGraphProviderOccurrences(threadId, ownerRunToken, messages)
        const preparation = prepareScopedProviderHistory?.(threadId, scopedTurn, request.runtime?.signal)
        if (preparation) {
          await preparation
          request.runtime?.signal?.throwIfAborted()
          if (!isCurrentRunMessageQueueOwner(threadId, ownerRunToken)) {
            throw new DOMException("Superseded turn", "AbortError")
          }
        }
      }
      onModelRequestState?.(true)
      try {
        const notificationIdentity =
          threadId && ownerRunToken
            ? registerNotificationModelExecution(threadId, ownerRunToken, messages)
            : undefined
        const response = await handler(request)
        if (threadId && ownerRunToken && AIMessage.isInstance(response)) {
          if (notificationIdentity || canonicalAssistantCompletions.has(response)) {
            const canonical = canonicalAssistantMessageForTranscript(response, threadId, ownerRunToken)
            if (canonical) {
              completedAssistantMessagesByRun.set(runScopedKey(threadId, ownerRunToken), canonical)
              return response
            }
          }
          if (notificationIdentity) {
            response.id = notificationIdentity.stableId
            response.additional_kwargs = {
              ...response.additional_kwargs,
              [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: notificationIdentity.providerSourceId,
              [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: notificationIdentity.providerOccurrence
            }
          } else {
            assignScopedGraphAssistantIdentity(
              threadId,
              ownerRunToken,
              messages,
              response,
              loadGraphProviderOccurrence
            )
          }
          const completed = completedAssistantMessageForTranscript(response)
          if (completed) {
            completedAssistantMessagesByRun.set(runScopedKey(threadId, ownerRunToken), completed)
          }
        }
        return response
      } finally {
        onModelRequestState?.(false)
      }
    },
    beforeModel: async (state, runtime) => {
      const threadId =
        typeof runtime.configurable?.thread_id === "string"
          ? runtime.configurable.thread_id
          : undefined
      if (!threadId || !ownerRunToken) return undefined

      const messages = Array.isArray(state.messages) ? state.messages : []
      const anchorMessage = currentRunInjectionAnchorForTail(messages, messages.length - 1)
      const injection = await drainCurrentRunMessagesForInjection(
        threadId,
        ownerRunToken,
        "beforeModel",
        { anchorMessage }
      )
      return injection ? { messages: injection.messages } : undefined
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state, runtime) => {
        const threadId =
          typeof runtime.configurable?.thread_id === "string"
            ? runtime.configurable.thread_id
            : undefined
        if (!threadId || !ownerRunToken) return undefined

        // Only inject when the model produced a FINAL reply (no tool calls). If it
        // requested tools, let them run — the steered message is drained on the
        // next beforeModel instead. This also means a HITL approval interrupt
        // (which fires on tool_calls, earlier in the reverse afterModel order)
        // preempts injection entirely.
        const messages = Array.isArray(state.messages) ? state.messages : []
        const lastMessage = messages.at(-1)
        if (!AIMessage.isInstance(lastMessage)) return undefined
        const completedKey = runScopedKey(threadId, ownerRunToken)
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
          completedAssistantMessagesByRun.delete(completedKey)
          return undefined
        }
        if (!isCurrentRunMessageQueueOwner(threadId, ownerRunToken) ||
          !currentRunMessageQueues.get(threadId)?.length) {
          completedAssistantMessagesByRun.delete(completedKey)
          return undefined
        }
        const canonicalCompletion = canonicalAssistantMessageForTranscript(
          lastMessage, threadId, ownerRunToken)
        const completedAssistantMessage = canonicalCompletion ??
          completedAssistantMessagesByRun.get(completedKey) ??
          completedAssistantMessageForTranscript(lastMessage)
        completedAssistantMessagesByRun.delete(completedKey)
        const anchorMessage = currentRunInjectionAnchorForTail(messages, messages.length - 2)

        const injection = await drainCurrentRunMessagesForInjection(
          threadId,
          ownerRunToken,
          "afterModel",
          { completedAssistantMessage, anchorMessage }
        )
        if (injection && canonicalCompletion)
          readCurrentRunCanonicalAssistantCompletion(canonicalCompletion, threadId, ownerRunToken)
        // The preceding reply is persisted with a fresh id so providers that
        // reuse AI message ids cannot overwrite it with the guided reply. Keep
        // LangGraph state on that same id before the next values snapshot is
        // emitted; otherwise the renderer sees the provider id and the durable
        // id as two separate assistant messages after a reload.
        if (injection && completedAssistantMessage && !canonicalCompletion) {
          if (lastMessage.id !== completedAssistantMessage.id) {
            lastMessage.id = completedAssistantMessage.id
          }
          const completedIdentity = injection.completedAssistantIdentity
          if (completedIdentity?.providerSourceId && completedIdentity.providerOccurrence) {
            lastMessage.additional_kwargs = {
              ...lastMessage.additional_kwargs,
              [MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY]: completedIdentity.providerSourceId,
              [MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY]: completedIdentity.providerOccurrence
            }
          }
        }
        if (!injection) return undefined
        // Persist a new object for the renamed reply. The checkpoint saver uses
        // immutable message-prefix reuse; mutating its previous object alone
        // keeps the old provider ID on disk and duplicates the reply on reload.
        const completedSnapshot = completedAssistantMessage
          ? new AIMessage({ ...lastMessage, content: lastMessage.content, id: lastMessage.id })
          : undefined
        return {
          messages: completedSnapshot ? [completedSnapshot, ...injection.messages] : injection.messages,
          jumpTo: "model" as const
        }
      }
    }
  })
}
