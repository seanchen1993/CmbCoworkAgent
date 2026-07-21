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
  context?: { completedAssistantMessage?: CurrentRunCompletedAssistantMessage }
) => void | Promise<void>

let notifyInjected: CurrentRunInjectionNotifier = () => {}

export function setCurrentRunInjectionNotifier(notifier: CurrentRunInjectionNotifier): void {
  notifyInjected = notifier
}

/** Assign queue ownership to one physical foreground run. Resume/interrupt call
 * this before aborting the old controller, so a timed-out old graph can no
 * longer drain or clear messages transferred to the continuation. */
export function setCurrentRunMessageQueueOwner(threadId: string, runToken: string): void {
  if (!threadId || !runToken) return
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
    return
  }
  currentRunMessageQueues.delete(threadId)
  currentRunMessageQueueOwners.delete(threadId)
  injectedMessageIds.delete(threadId)
  withdrawnMessageIds.delete(threadId)
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
  context?: { completedAssistantMessage?: CurrentRunCompletedAssistantMessage }
): Promise<{ messages: HumanMessage[] } | undefined> {
  const queued = drainCurrentRunMessageQueue(threadId, runToken).filter((message) =>
    message.content.trim()
  )
  if (queued.length === 0) return undefined

  // The notifier durably persists these user turns before acknowledging them to
  // the renderer. If persistence fails, restore the queue and let the graph fail
  // this hook instead of losing the only durable copy of the user's instruction.
  try {
    await notifyInjected(threadId, queued, context)
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
    )
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
    beforeModel: async (_state, runtime) => {
      const threadId =
        typeof runtime.configurable?.thread_id === "string"
          ? runtime.configurable.thread_id
          : undefined
      if (!threadId || !ownerRunToken) return undefined

      const injection = await drainCurrentRunMessagesForInjection(
        threadId,
        ownerRunToken,
        "beforeModel"
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

        const injection = await drainCurrentRunMessagesForInjection(
          threadId,
          ownerRunToken,
          "afterModel",
          { completedAssistantMessage }
        )
        // The preceding reply is persisted with a fresh id so providers that
        // reuse AI message ids cannot overwrite it with the guided reply. Keep
        // LangGraph state on that same id before the next values snapshot is
        // emitted; otherwise the renderer sees the provider id and the durable
        // id as two separate assistant messages after a reload.
        if (
          injection &&
          completedAssistantMessage &&
          lastMessage.id !== completedAssistantMessage.id
        ) {
          lastMessage.id = completedAssistantMessage.id
        }
        return injection ? { messages: injection.messages, jumpTo: "model" as const } : undefined
      }
    }
  })
}
