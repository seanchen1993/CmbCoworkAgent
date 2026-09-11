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

import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { randomUUID } from "crypto"
import type { Message } from "../types"
import {
  advanceCompletedMessageContentRoute,
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY,
  normalizeAppendedMessageIds
} from "../../shared/message-role-collision"

export interface CurrentRunQueuedMessage {
  id: string
  content: string
  displayContent?: string
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

const currentRunMessageQueues = new Map<string, CurrentRunQueuedMessage[]>()
const currentRunMessageQueueOwners = new Map<string, string>()
const completedAssistantMessagesByRun = new Map<string, CurrentRunCompletedAssistantMessage>()
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
  currentRunMessageQueueOwners.set(threadId, runToken)
}

function runScopedKey(threadId: string, runToken: string): string {
  return `${threadId}\u0000${runToken}`
}

export function isCurrentRunMessageQueueOwner(threadId: string, runToken: string): boolean {
  return currentRunMessageQueueOwners.get(threadId) === runToken
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

/** Remove a steered message before it is injected (user deleted/un-steered it). */
export function deleteCurrentRunQueuedMessage(threadId: string, messageId: string): void {
  const withdrawn = withdrawnMessageIds.get(threadId) ?? new Set<string>()
  withdrawn.add(messageId)
  withdrawnMessageIds.set(threadId, withdrawn)
  const existing = currentRunMessageQueues.get(threadId)
  if (!existing) return
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
  currentRunMessageQueues.delete(threadId)
  currentRunMessageQueueOwners.delete(threadId)
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
  const queued = drainCurrentRunMessageQueue(threadId, runToken).filter((message) =>
    message.content.trim()
  )
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
    if (isCurrentRunMessageQueueOwner(threadId, runToken)) {
      const arrivalsDuringNotification = currentRunMessageQueues.get(threadId) ?? []
      currentRunMessageQueues.set(threadId, [...queued, ...arrivalsDuringNotification])
    }
    throw error
  }

  const injected = injectedMessageIds.get(threadId) ?? new Set<string>()
  for (const message of queued) injected.add(message.id)
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
          ...(visibleContent !== message.content
            ? {
                additional_kwargs: {
                  [VISIBLE_USER_MESSAGE_KEY]: visibleContent
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

function completedAssistantMessageForTranscript(
  message: AIMessage
): CurrentRunCompletedAssistantMessage | undefined {
  const sourceId = typeof message.id === "string" && message.id.trim() ? message.id.trim() : undefined
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
  ownerRunToken?: string
): ReturnType<typeof createMiddleware> {
  return createMiddleware({
    name: "currentRunMessageQueue",
    wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      const threadId =
        typeof request.runtime?.configurable?.thread_id === "string"
          ? request.runtime.configurable.thread_id
          : undefined
      if (threadId && ownerRunToken && AIMessage.isInstance(response)) {
        const completed = completedAssistantMessageForTranscript(response)
        if (completed) {
          completedAssistantMessagesByRun.set(runScopedKey(threadId, ownerRunToken), completed)
        }
      }
      return response
    },
    beforeModel: async (state, runtime) => {
      const threadId =
        typeof runtime.configurable?.thread_id === "string"
          ? runtime.configurable.thread_id
          : undefined
      if (!threadId || !ownerRunToken) return undefined

      const messages = Array.isArray(state.messages) ? state.messages : []
      const anchorMessage = currentRunInjectionAnchorForMessage(messages.at(-1))
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
        const completedAssistantMessage =
          completedAssistantMessagesByRun.get(completedKey) ??
          completedAssistantMessageForTranscript(lastMessage)
        completedAssistantMessagesByRun.delete(completedKey)
        const anchorMessage = currentRunInjectionAnchorForMessage(messages.at(-2))

        const injection = await drainCurrentRunMessagesForInjection(
          threadId,
          ownerRunToken,
          "afterModel",
          { completedAssistantMessage, anchorMessage }
        )
        // The preceding reply is persisted with a fresh id so providers that
        // reuse AI message ids cannot overwrite it with the guided reply. Keep
        // LangGraph state on that same id before the next values snapshot is
        // emitted; otherwise the renderer sees the provider id and the durable
        // id as two separate assistant messages after a reload.
        if (injection && completedAssistantMessage) {
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
        return injection ? { messages: injection.messages, jumpTo: "model" as const } : undefined
      }
    }
  })
}
